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
// With capture on (panel → 状态 → 诊断, per request), the CLI subprocess gets
// ANTHROPIC_BASE_URL pointing at a loopback forwarder in this process. It
// forwards every byte unchanged (credentials included, never stored) and
// keeps the last requests IN MEMORY: the request body, the rate-limit
// headers and the usage of the reply. Nothing is written to disk; the panel
// reads it through diag-report.js. On by default in the panel (so a report
// already has the data when someone needs it); skipped when the environment
// routes through a proxy the forwarder cannot speak (see tapSkipReason), and
// a forwarder that fails to start just means this turn is not recorded.

import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';

const MAX_EXCHANGES = 30;
const HEAD_BYTES = 64 * 1024; // message_start (with the cache usage) is at the top
const TAIL_BYTES = 16 * 1024; // message_delta (output tokens) at the end

const exchanges = []; // { id, at, path, status, ms, request (parsed body), betas, ratelimit, usage, error }
let server = null;
let starting = null;
let nextId = 1;

function upstreamBase() {
    return new URL(process.env.CLAUDE_SUBSCRIPTION_DEV_BASE_URL || 'https://api.anthropic.com');
}

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'];

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

function pickHeaders(headers, prefix) {
    const out = {};
    for (const [k, v] of Object.entries(headers ?? {})) if (k.startsWith(prefix)) out[k] = v;
    return out;
}

function record(entry) {
    exchanges.push(entry);
    while (exchanges.length > MAX_EXCHANGES) exchanges.shift();
}

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

/** Captured exchanges, oldest first (copies of the records). */
export function capturedExchanges() {
    return exchanges.slice();
}

/** Test seam. */
export async function __resetWireTap() {
    exchanges.length = 0;
    nextId = 1;
    if (server) await new Promise((r) => server.close(r));
    server = null;
}
