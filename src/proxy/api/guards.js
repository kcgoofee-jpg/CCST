// ──────────────────────────────────────────────
// Request guards and CORS (shared by the standalone listener)
// ──────────────────────────────────────────────
//
// Host / Origin / LAN-key checks and the CORS headers. routes.js picks which
// of these each endpoint gets; listener.js installs the global ones.

import { timingSafeEqual } from 'node:crypto';
import { envValue } from '../env-value.js';

// Reflect only loopback origins — a wildcard would let ANY web page the user
// visits read subscription/billing data off these unauthenticated GETs.
// TauriTavern's WebView serves the UI from tauri://localhost (macOS/Linux)
// or http(s)://tauri.localhost (Windows/Android).
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const TAURI_ORIGIN = /^(tauri:\/\/localhost|https?:\/\/tauri\.localhost)$/i;

// Browser pages served from your own domain (SillyTavern behind an HTTPS
// reverse proxy) are listed by exact origin in CLAUDE_SUBSCRIPTION_ALLOWED_ORIGINS.
export function isAllowedOrigin(origin, extra = process.env.CLAUDE_SUBSCRIPTION_ALLOWED_ORIGINS) {
    if (!origin) return false;
    if (LOOPBACK_ORIGIN.test(origin) || TAURI_ORIGIN.test(origin)) return true;
    const want = String(origin).toLowerCase();
    return String(extra ?? '').split(',').map((o) => o.trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean).includes(want);
}

// DNS rebinding guard: a web page on evil.example can point its own name at
// 127.0.0.1 and then talk to this unauthenticated proxy as "same origin" —
// spending the subscription or reading /v1/debug/last. Browsers always send
// the name they looked up as Host, so only accept loopback names, the bind
// host itself, IP literals when bound to every interface (LAN use), and
// whatever CLAUDE_SUBSCRIPTION_ALLOWED_HOSTS lists.
const LOOPBACK_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|tauri\.localhost)$/i;
const IP_LITERAL = /^(\d+\.\d+\.\d+\.\d+|\[[0-9a-f:.]+\])$/i;

export function isAllowedHost(hostHeader, bindHost, extra = process.env.CLAUDE_SUBSCRIPTION_ALLOWED_HOSTS) {
    if (!hostHeader) return true; // HTTP/1.0 clients; a browser always sends Host
    const name = String(hostHeader).replace(/:\d+$/, '').toLowerCase();
    if (LOOPBACK_HOST.test(name)) return true;
    const bind = String(bindHost ?? '').toLowerCase();
    if (name === bind || `[${bind}]` === name) return true;
    if ((bind === '0.0.0.0' || bind === '::') && IP_LITERAL.test(name)) return true;
    return String(extra ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean).includes(name);
}

export function guardHost(bindHost) {
    return (req, res, next) => {
        if (isAllowedHost(req.headers.host, bindHost)) return next();
        res.status(403).json({ error: { message: `代理不接受用「${req.headers.host}」这个地址访问。只有本机地址和已允许的地址能用；确实要用这个地址的话，把它加到环境变量 CLAUDE_SUBSCRIPTION_ALLOWED_HOSTS 里。` } });
    };
}

// Chat is called server-side by SillyTavern / TauriTavern (no Origin header).
// A browser page from another origin always sends one — refuse it.
export function guardPostOrigin(req, res, next) {
    const origin = req.headers.origin;
    if (!origin || isAllowedOrigin(origin)) return next();
    res.status(403).json({ error: { message: `代理拒绝了来自其他网站（${origin}）的请求：只有酒馆页面可以用这个代理。` } });
}

// LAN use (a phone's TauriTavern talking to the proxy on a Mac): requests
// from another machine must carry the access key set in
// CLAUDE_SUBSCRIPTION_LAN_KEY, as `Authorization: Bearer <key>` (the API key
// field of the Custom endpoint) or `X-Claude-Max-Key`. Without a key set,
// other machines are refused outright — binding 0.0.0.0 alone never opens
// the subscription to the network. This machine (loopback) needs no key.
const LOOPBACK_ADDR = /^(127\.|::1$|::ffff:127\.)/;

export function isLoopbackAddress(addr) {
    return LOOPBACK_ADDR.test(String(addr ?? ''));
}

export function keyMatches(given, expected) {
    if (!given || !expected) return false;
    const a = Buffer.from(String(given)); const b = Buffer.from(String(expected));
    return a.length === b.length && timingSafeEqual(a, b);
}

/** The access key a request carries: X-Claude-Max-Key, else the Bearer
 *  token. An empty or blank header does not hide a valid Bearer key. */
export function presentedKey(req) {
    const header = String(req.headers?.['x-claude-max-key'] ?? '').trim();
    const auth = String(req.headers?.authorization ?? '').match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    return header || auth || null;
}

// A reverse proxy on the same machine connects from 127.0.0.1, but adds one of
// these headers (Caddy, nginx, Cloudflare all do): such a request is really
// remote and needs the key. Direct local callers (SillyTavern's plugin, the
// panel on localhost) don't send them. CLAUDE_SUBSCRIPTION_REQUIRE_KEY=1
// demands the key from everyone.
const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip'];

export function isLocalCaller(req, env = process.env) {
    if (/^(1|true|yes|on)$/i.test(String(env.CLAUDE_SUBSCRIPTION_REQUIRE_KEY ?? '').trim())) return false;
    if (!isLoopbackAddress(req.socket?.remoteAddress)) return false;
    return !PROXY_HEADERS.some((h) => req.headers?.[h] !== undefined);
}

// 连接码在 # 后面，浏览器不会发给代理；页面自己从地址栏读出来显示，代理这边不碰密码。
export const CONNECT_PAGE = `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CCST 手机连接码</title><style>
body{margin:0;padding:24px 20px;font:20px/1.6 system-ui,sans-serif;background:#fff;color:#111}
h1{font-size:28px;margin:0 0 16px}ol{padding-left:1.4em}li{margin:10px 0}
#code{width:100%;box-sizing:border-box;font:16px/1.4 monospace;padding:12px;border:2px solid #888;border-radius:10px;word-break:break-all}
button{width:100%;margin:16px 0;padding:18px;font-size:22px;border:0;border-radius:12px;background:#2563eb;color:#fff}
#msg{text-align:center;font-weight:bold}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}#code{background:#222;color:#eee}}
</style><h1>CCST 手机连接码</h1><div id="ok" hidden>
<textarea id="code" rows="3" readonly></textarea><button id="copy">复制连接码</button><p id="msg"></p>
<ol><li>点上面的「复制连接码」</li><li>打开 TauriTavern → 扩展 → CCST</li><li>粘贴到输入框，点「连接」</li></ol></div>
<p id="none" hidden>这个地址是 Claude 代理，不是网页。请用手机相机扫电脑上「酒馆工具」首页的二维码。</p>
<script>
var c=location.hash.indexOf('#k=')===0?location.href:'';
if(c){document.getElementById('ok').hidden=false;var t=document.getElementById('code');t.value=c;
document.getElementById('copy').onclick=function(){var m=document.getElementById('msg');
function done(){m.textContent='已复制，去 TauriTavern 粘贴';}
t.select();if(navigator.clipboard){navigator.clipboard.writeText(c).then(done,function(){document.execCommand('copy');done();});}else{document.execCommand('copy');done();}};}
else document.getElementById('none').hidden=false;
</script></html>`;

export function guardRemote(req, res, next) {
    if (isLocalCaller(req) || req.method === 'OPTIONS') return next();
    // Let the panel read why it was turned away (otherwise the browser hides
    // the response and it can only say "can't reach the proxy").
    if (isAllowedOrigin(req.headers.origin)) {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
        res.setHeader('Vary', 'Origin');
    }
    const expected = envValue(process.env.CLAUDE_SUBSCRIPTION_LAN_KEY);
    // 手机相机扫了酒馆工具的二维码、在浏览器里打开：给一张能看懂的页面，不给 JSON
    if (req.method === 'GET' && /text\/html/.test(String(req.headers.accept ?? ''))) return res.status(200).type('html').send(CONNECT_PAGE);
    if (!expected) {
        return res.status(403).json({ error: { message: '这个代理只给它所在的电脑用，没有开放给其他设备（手机、另一台电脑）。要从手机用，先在电脑的「酒馆工具」里切到手机模式，再把首页的手机连接码粘贴到 CCST 卡片，点「连接」。' } });
    }
    if (keyMatches(presentedKey(req), expected)) return next();
    res.status(401).json({ error: { message: '访问密码不对：代理开放给其他设备使用时需要密码。把电脑上「酒馆工具」首页的手机连接码整串粘贴到 CCST 卡片，点「连接」。' } });
}

/** Async route handler → rejections go to the error handler (express 4 does
 *  not catch them; on Node ≥ 15 an unhandled rejection ends the process). */
export function asyncRoute(fn) {
    return (req, res, next) => {
        Promise.resolve().then(() => fn(req, res, next)).catch(next);
    };
}

// Last in the chain: a JSON error instead of express's HTML page, and never a crash.
export function handleRouteError(err, req, res, _next) {
    const status = Number(err?.status ?? err?.statusCode);
    const code = Number.isInteger(status) && status >= 400 && status < 600 ? status : 500;
    if (code >= 500) console.error(`[claude-subscription] ${req.method} ${req.path} 出错：`, err instanceof Error ? err.message : err);
    if (res.headersSent) return res.end();
    res.status(code).json({ error: { message: err instanceof Error ? err.message : String(err), type: code >= 500 ? 'server_error' : 'invalid_request_error' } });
}

// Same as allowCorsGet, plus POST for the control actions.
export function allowCors(req, res, next) {
    allowCorsGet(req, res, () => {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        next();
    });
}

export function allowCorsGet(req, res, next) {
    const origin = req.headers.origin;
    if (isAllowedOrigin(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Claude-Max-Key');
    next();
}
