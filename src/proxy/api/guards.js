// ──────────────────────────────────────────────
// Request guards and CORS (shared by the standalone listener)
// ──────────────────────────────────────────────
//
// Host / Origin / this-machine-only checks and the CORS headers. routes.js picks which
// of these each endpoint gets; listener.js installs the global ones.

// Reflect only loopback origins — a wildcard would let ANY web page the user
// visits read subscription/billing data off these unauthenticated GETs.
// TauriTavern's WebView serves the UI from tauri://localhost (macOS/Linux)
// or http(s)://tauri.localhost (Windows/Android).
// (One GET is stricter still: the chat-text dump, see allowCorsGetTrusted.)
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const TAURI_ORIGIN = /^(tauri:\/\/localhost|https?:\/\/tauri\.localhost)$/i;

// Browser pages served from your own domain (SillyTavern behind an HTTPS
// reverse proxy) are listed by exact origin in CLAUDE_SUBSCRIPTION_ALLOWED_ORIGINS.
function inAllowList(origin, extra) {
    const want = String(origin).toLowerCase();
    return String(extra ?? '').split(',').map((o) => o.trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean).includes(want);
}

export function isAllowedOrigin(origin, extra = process.env.CLAUDE_SUBSCRIPTION_ALLOWED_ORIGINS) {
    if (!origin) return false;
    if (LOOPBACK_ORIGIN.test(origin) || TAURI_ORIGIN.test(origin)) return true;
    return inAllowList(origin, extra);
}

// Endpoints that SPEND the subscription or change how it bills (POST chat,
// POST backend) are not for just any page on this
// machine: a dev server on http://localhost:5173, or any local web app the
// user happens to open, is a browser page that can drive them. Only the
// TauriTavern WebView and origins the user listed are trusted here.
// SillyTavern's server-side forward sends no Origin at all and is unaffected.
export function isTrustedPostOrigin(origin, extra = process.env.CLAUDE_SUBSCRIPTION_ALLOWED_ORIGINS) {
    if (!origin) return false;
    return TAURI_ORIGIN.test(origin) || inAllowList(origin, extra);
}

// DNS rebinding guard: a web page on evil.example can point its own name at
// 127.0.0.1 and then talk to this unauthenticated proxy as "same origin" —
// spending the subscription or reading /v1/debug/last. Browsers always send
// the name they looked up as Host, so only accept loopback names, the bind
// host itself, and whatever CLAUDE_SUBSCRIPTION_ALLOWED_HOSTS lists.
const LOOPBACK_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|tauri\.localhost)$/i;

export function isAllowedHost(hostHeader, bindHost, extra = process.env.CLAUDE_SUBSCRIPTION_ALLOWED_HOSTS) {
    if (!hostHeader) return true; // HTTP/1.0 clients; a browser always sends Host
    const name = String(hostHeader).replace(/:\d+$/, '').toLowerCase();
    if (LOOPBACK_HOST.test(name)) return true;
    const bind = String(bindHost ?? '').toLowerCase();
    if (name === bind || `[${bind}]` === name) return true;
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
    if (!origin || isTrustedPostOrigin(origin)) return next();
    if (LOOPBACK_ORIGIN.test(origin)) {
        // A page on this machine could be any local web app (a dev server, …): it does not get to spend the subscription.
        res.status(403).json({ error: { message: `代理不接受来自本机网页（${origin}）的写入请求：这类请求会花你的订阅。酒馆自己的聊天请求不受影响；确实要让这个页面用的话，把它加进 CLAUDE_SUBSCRIPTION_ALLOWED_ORIGINS。` } });
        return;
    }
    res.status(403).json({ error: { message: `代理拒绝了来自其他网站（${origin}）的请求：只有酒馆页面可以用这个代理。` } });
}

// The proxy is for the computer it runs on: requests from another machine are
// refused (6.1 dropped LAN access and its access key).
const LOOPBACK_ADDR = /^(127\.|::1$|::ffff:127\.)/;

export function isLoopbackAddress(addr) {
    return LOOPBACK_ADDR.test(String(addr ?? ''));
}

// A reverse proxy on the same machine connects from 127.0.0.1, but adds one of
// these headers (Caddy, nginx, Cloudflare all do): such a request is really
// remote. Direct local callers (SillyTavern's plugin, the panel on localhost)
// don't send them.
const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip'];

export function isLocalCaller(req) {
    if (!isLoopbackAddress(req.socket?.remoteAddress)) return false;
    return !PROXY_HEADERS.some((h) => req.headers?.[h] !== undefined);
}

export function guardRemote(req, res, next) {
    if (isLocalCaller(req) || req.method === 'OPTIONS') return next();
    // Let the panel read why it was turned away (otherwise the browser hides
    // the response and it can only say "can't reach the proxy").
    if (isAllowedOrigin(req.headers.origin)) {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
        res.setHeader('Vary', 'Origin');
    }
    res.status(403).json({ error: { message: '这个代理只给它所在的电脑用，不接受其他设备（手机、另一台电脑）的请求。' } });
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

// Same as allowCorsGet, plus POST.
export function allowCors(req, res, next) {
    allowCorsGet(req, res, () => {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        next();
    });
}

const corsGetWith = (trusted) => (req, res, next) => {
    const origin = req.headers.origin;
    if (trusted(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    next();
};

export const allowCorsGet = corsGetWith(isAllowedOrigin);

// /v1/debug/last is a dump of whole chats, so a page on this machine gets no
// read access by being on this machine: only the TauriTavern WebView and the
// listed origins see it cross-origin. SillyTavern's panel reads it same-origin
// through the plugin route (fetchProxy falls back there).
export const allowCorsGetTrusted = corsGetWith(isTrustedPostOrigin);
