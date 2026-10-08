// ──────────────────────────────────────────────
// Wire capture: what the CLI really sends to Anthropic (diagnostics)
// ──────────────────────────────────────────────
//
// The proxy only sees the request it hands the CLI. The CLI then adds its
// own parts — the billing header, <system-reminder> blocks, cache breakpoints
// and their TTL — and only Anthropic's reply says what was read from the
// cache and whether the account is over its limits. A cache problem on a
// user's machine could not be seen from here (2026-10 「缓存 0%」).
//
// With capture on (always, unless CLAUDE_SUBSCRIPTION_DIAG_CAPTURE=0), the CLI subprocess gets
// ANTHROPIC_BASE_URL pointing at a loopback forwarder in this process. It
// forwards every byte unchanged (credentials included, never stored) and
// keeps the last requests IN MEMORY: the request body, the rate-limit
// headers and the usage of the reply. Nothing is written to disk; the panel
// reads it through diag-report.js, so a report already has the data when
// someone needs it. Skipped when the environment
// routes through a proxy the forwarder cannot speak (see tapSkipReason), and
// a forwarder that fails to start just means this turn is not recorded.

import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';

// 审: 内存里最多留最近 30 次抓包。
const MAX_EXCHANGES = 30;
// 审: 响应只留开头 64KB（含 message_start 的缓存用量）。
const HEAD_BYTES = 64 * 1024; // message_start (with the cache usage) is at the top
// 审: 响应只留结尾 16KB（含 message_delta 的输出用量）。
const TAIL_BYTES = 16 * 1024; // message_delta (output tokens) at the end

// 审: 抓到的请求记录，仅内存。
const exchanges = []; // { id, at, path, status, ms, request (parsed body), betas, ratelimit, usage, error }
// 审: 本地转发服务实例，首次使用时启动。
let server = null;
// 审: 启动中的 Promise，防止并发请求重复启动。
let starting = null;
// 审: 抓包记录自增编号。
let nextId = 1;

// 审: DEV_BASE_URL 让开发时把请求转到别的上游，保留给排查。
function upstreamBase() {
    return new URL(process.env.CLAUDE_SUBSCRIPTION_DEV_BASE_URL || 'https://api.anthropic.com');
}

// 审: 环境里可能出现的代理变量名。
const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'];

// 审: 环境里有非 http 代理时必须跳过抓包，否则会绕过用户的代理（chat.js、测试使用）。
/**
 * Why the CLI must NOT go through the forwarder, or null when it may. The forwarder only knows how to
 * reach Anthropic directly or through an http:// CONNECT proxy; with a socks5:// (or https://, or
 * scheme-less) proxy in the environment it would bypass the proxy the CLI is meant to use, and on a
 * network that needs it every chat would fail. Then capture is skipped and the CLI talks to Anthropic itself.
 */
export function tapSkipReason(env = process.env) {
    for (const k of PROXY_VARS) {
        const v = String(env[k] ?? '').trim();
        if (!v) continue;
        let protocol = '';
        try { protocol = new URL(v).protocol; } catch { /* not a URL */ }
        if (protocol !== 'http:') return `${k} 是 ${protocol ? protocol.replace(/:$/, '') : '无法识别的'}代理，诊断转发口只支持 http 代理`;
    }
    return null;
}

// 审: 取环境里的 http 代理，转发时用 CONNECT 走它。
/** An http:// proxy from the environment (HTTPS_PROXY & co.), if any: the CLI would have used it. */
function envProxy() {
    for (const k of PROXY_VARS) {
        const v = process.env[k];
        if (!v) continue;
        try {
            const u = new URL(v);
            if (u.protocol === 'http:') return u;
        } catch { /* not a URL */ }
    }
    return null;
}

// 审: 向上游发 HTTPS 请求，有 http 代理就先 CONNECT。
/** HTTPS request to the upstream, through an http:// CONNECT proxy when one is set. */
function openUpstream(target, options, onResponse, onError) {
    const proxy = target.protocol === 'https:' ? envProxy() : null;
    const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
    if (!proxy) {
        const fn = target.protocol === 'https:' ? httpsRequest : httpRequest;
        const req = fn({ host: target.hostname, port, ...options }, onResponse);
        req.on('error', onError);
        return Promise.resolve(req);
    }
    return new Promise((resolve) => {
        const auth = proxy.username ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` } : {};
        const connectReq = httpRequest({ host: proxy.hostname, port: Number(proxy.port) || 80, method: 'CONNECT', path: `${target.hostname}:${port}`, headers: { Host: `${target.hostname}:${port}`, ...auth } });
        connectReq.on('connect', (res, socket) => {
            if (res.statusCode !== 200) {
                socket.destroy();
                onError(new Error(`代理 CONNECT 失败：HTTP ${res.statusCode}`));
                return resolve(null);
            }
            const tls = tlsConnect({ socket, servername: target.hostname });
            const req = httpsRequest({ host: target.hostname, port, ...options, createConnection: () => tls }, onResponse);
            req.on('error', onError);
            resolve(req);
        });
        connectReq.on('error', (e) => { onError(e); resolve(null); });
        connectReq.end();
    });
}

// 审: 从响应文本（流式或非流式）里取 usage（测试使用）。
/** Usage from a reply: message_start (stream) or the top-level usage (non-stream). */
export function usageOf(text) {
    try {
        const u = JSON.parse(text).usage;
        if (u) return u;
    } catch { /* streamed */ }
    let usage = null;
    for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
            const ev = JSON.parse(line.slice(5));
            if (ev.type === 'message_start' && ev.message?.usage) usage = { ...ev.message.usage };
            else if (ev.type === 'message_delta' && ev.usage) usage = { ...(usage ?? {}), ...ev.usage };
        } catch { /* a line cut by the head/tail window */ }
    }
    return usage;
}

// 审: 取某前缀的响应头（额度头）。
function pickHeaders(headers, prefix) {
    const out = {};
    for (const [k, v] of Object.entries(headers ?? {})) if (k.startsWith(prefix)) out[k] = v;
    return out;
}

// 审: 记一条抓包，超出上限删最旧。
function record(entry) {
    exchanges.push(entry);
    while (exchanges.length > MAX_EXCHANGES) exchanges.shift();
}

// 审: 转发处理：原样转发给上游，同时对 /v1/messages 记录请求体、额度头和 usage。
function handle(req, res) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
        const raw = Buffer.concat(chunks); // bytes as sent: never re-encoded (a split CJK char would break)
        const started = Date.now();
        const isMessages = req.method === 'POST' && /^\/v1\/messages(\?|$)/.test(req.url);
        let entry = null;
        if (isMessages) {
            let body = null;
            try { body = JSON.parse(raw.toString('utf8')); } catch { /* keep null */ }
            entry = { id: nextId++, at: started, path: req.url, status: null, ms: null, request: body, betas: req.headers['anthropic-beta'] ?? null, ratelimit: {}, usage: null, error: null };
            record(entry);
        }
        const target = upstreamBase();
        const headers = { ...req.headers, host: target.host };
        delete headers['content-length'];
        headers['content-length'] = String(raw.length);
        // Plain bytes back so the usage can be read; the CLI accepts identity.
        if (isMessages) headers['accept-encoding'] = 'identity';
        const basePath = target.pathname.replace(/\/$/, '');
        const up = await openUpstream(target, { method: req.method, path: `${basePath}${req.url}`, headers }, (upRes) => {
            res.writeHead(upRes.statusCode, upRes.headers);
            if (!entry) return void upRes.pipe(res);
            entry.status = upRes.statusCode;
            entry.ratelimit = pickHeaders(upRes.headers, 'anthropic-ratelimit-');
            entry.requestId = upRes.headers['request-id'] ?? null;
            let head = Buffer.alloc(0);
            let tail = Buffer.alloc(0);
            upRes.on('data', (c) => {
                res.write(c);
                if (head.length < HEAD_BYTES) head = Buffer.concat([head, c]).subarray(0, HEAD_BYTES);
                tail = Buffer.concat([tail, c]);
                if (tail.length > TAIL_BYTES) tail = tail.subarray(tail.length - TAIL_BYTES);
            });
            upRes.on('end', () => {
                res.end();
                entry.ms = Date.now() - started;
                const text = head.toString('utf8') + '\n' + tail.toString('utf8');
                entry.usage = usageOf(text);
                if (entry.status >= 400) entry.error = head.toString('utf8').slice(0, 500);
            });
        }, (err) => {
            if (entry) entry.error = `转发失败：${err.message}`;
            if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `CCST 诊断转发失败：${err.message}` } }));
        });
        if (up) up.end(raw);
    });
}

// 审: 返回本地转发地址，首次调用时启动（chat.js 给子进程设 ANTHROPIC_BASE_URL）。
/** Loopback base URL of the forwarder (started on first use). */
export async function tapBaseUrl() {
    if (server?.listening) return `http://127.0.0.1:${server.address().port}`;
    starting ??= new Promise((resolve, reject) => {
        const s = createServer(handle);
        s.on('error', reject);
        s.listen(0, '127.0.0.1', () => { server = s; s.unref(); resolve(); });
    }).finally(() => { starting = null; });
    await starting;
    return `http://127.0.0.1:${server.address().port}`;
}

// 审: 取抓包记录副本，供诊断报告用。
/** Captured exchanges, oldest first (copies of the records). */
export function capturedExchanges() {
    return exchanges.slice();
}
