// ──────────────────────────────────────────────
// Request guards and CORS (shared by the standalone listener)
// ──────────────────────────────────────────────
//
// Host / Origin / LAN-key checks and the CORS headers. routes.js picks which
// of these each endpoint gets; listener.js installs the global ones.

import { timingSafeEqual } from 'node:crypto';

// Reflect only loopback origins — a wildcard would let ANY web page the user
// visits read subscription/billing data off these unauthenticated GETs.
// TauriTavern's WebView serves the UI from tauri://localhost (macOS/Linux)
// or http(s)://tauri.localhost (Windows/Android).
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const TAURI_ORIGIN = /^(tauri:\/\/localhost|https?:\/\/tauri\.localhost)$/i;

export function isAllowedOrigin(origin) {
    return !!origin && (LOOPBACK_ORIGIN.test(origin) || TAURI_ORIGIN.test(origin));
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

export function guardRemote(req, res, next) {
    if (isLoopbackAddress(req.socket?.remoteAddress) || req.method === 'OPTIONS') return next();
    // Let the panel read why it was turned away (otherwise the browser hides
    // the response and it can only say "can't reach the proxy").
    if (isAllowedOrigin(req.headers.origin)) {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
        res.setHeader('Vary', 'Origin');
    }
    const expected = process.env.CLAUDE_SUBSCRIPTION_LAN_KEY;
    if (!expected) {
        return res.status(403).json({ error: { message: '这个代理只给它所在的电脑用，没有开放给其他设备（手机、另一台电脑）。要从别的设备用，先在代理所在的电脑上打开局域网访问（Mac：「酒馆工具」里切到「手机模式」），再回来点「重新连接」。' } });
    }
    if (keyMatches(presentedKey(req), expected)) return next();
    res.status(401).json({ error: { message: '访问密码不对：代理开放给其他设备使用时需要密码。在 CCST 面板「其他 → 手机连接」里填代理那边显示的访问密码（Mac：「酒馆工具 → 其他 → 手机 → 手机模式」），再点「一键连接」。' } });
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
