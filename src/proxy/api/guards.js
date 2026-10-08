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
// 审: 本机网页来源（localhost / 127.0.0.1 / ::1）的匹配；只允许读，不允许写。
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
// 审: TauriTavern WebView 的来源，唯一被信任可以写的浏览器来源（另有用户列出的）。
const TAURI_ORIGIN = /^(tauri:\/\/localhost|https?:\/\/tauri\.localhost)$/i;

// Browser pages served from your own domain (SillyTavern behind an HTTPS
// reverse proxy) are listed by exact origin in CLAUDE_SUBSCRIPTION_ALLOWED_ORIGINS.
// 审: 来源是否在 CLAUDE_SUBSCRIPTION_ALLOWED_ORIGINS 列表里。
// 审(存疑): 这个环境变量原本给「酒馆放在 HTTPS 反代后面」用，6.1 起带转发头的请求会被 guardRemote 拒；仍在使用指南和 CHANGELOG 里，所以没动。
function inAllowList(origin, extra) {
    const want = String(origin).toLowerCase();
    return String(extra ?? '').split(',').map((o) => o.trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean).includes(want);
}

// 审: 这个来源能不能跨域读（本机 / Tauri / 用户列的）；allowCorsGet 和 guardRemote 用。
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
// 审: 这个来源能不能跨域写 / 读聊天原文（只有 Tauri 和用户列的，本机网页不行）。
export function isTrustedPostOrigin(origin, extra = process.env.CLAUDE_SUBSCRIPTION_ALLOWED_ORIGINS) {
    if (!origin) return false;
    return TAURI_ORIGIN.test(origin) || inAllowList(origin, extra);
}

// DNS rebinding guard: a web page on evil.example can point its own name at
// 127.0.0.1 and then talk to this unauthenticated proxy as "same origin" —
// spending the subscription or reading /v1/debug/last. Browsers always send
// the name they looked up as Host, so only accept loopback names, the bind
// host itself, and whatever CLAUDE_SUBSCRIPTION_ALLOWED_HOSTS lists.
// 审: 允许的本机 Host 头名字（DNS 重绑定防护用）。
const LOOPBACK_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|tauri\.localhost)$/i;

// 审: Host 头是不是本机名 / 监听地址 / CLAUDE_SUBSCRIPTION_ALLOWED_HOSTS 里的；防 DNS 重绑定。
export function isAllowedHost(hostHeader, bindHost, extra = process.env.CLAUDE_SUBSCRIPTION_ALLOWED_HOSTS) {
    if (!hostHeader) return true; // HTTP/1.0 clients; a browser always sends Host
    const name = String(hostHeader).replace(/:\d+$/, '').toLowerCase();
    if (LOOPBACK_HOST.test(name)) return true;
    const bind = String(bindHost ?? '').toLowerCase();
    if (name === bind || `[${bind}]` === name) return true;
    return String(extra ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean).includes(name);
}

// 审: 中间件：Host 不合法就 403（listener 全局安装）。
export function guardHost(bindHost) {
    return (req, res, next) => {
        if (isAllowedHost(req.headers.host, bindHost)) return next();
        res.status(403).json({ error: { message: `代理不接受用「${req.headers.host}」这个地址访问。只有本机地址和已允许的地址能用；确实要用这个地址的话，把它加到环境变量 CLAUDE_SUBSCRIPTION_ALLOWED_HOSTS 里。` } });
    };
}

// Chat is called server-side by SillyTavern / TauriTavern (no Origin header).
// A browser page from another origin always sends one — refuse it.
// 审: 中间件：写入类端点拒绝浏览器网页发来的请求（酒馆服务器转发没有 Origin，放行）；routes.js 的 origin 路由用。
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
// 审: 回环地址的匹配。
const LOOPBACK_ADDR = /^(127\.|::1$|::ffff:127\.)/;

// 审: 对端地址是不是本机；isLocalCaller 用，测试直接用。
export function isLoopbackAddress(addr) {
    return LOOPBACK_ADDR.test(String(addr ?? ''));
}

// A reverse proxy on the same machine connects from 127.0.0.1, but adds one of
// these headers (Caddy, nginx, Cloudflare all do): such a request is really
// remote. Direct local callers (SillyTavern's plugin, the panel on localhost)
// don't send them.
// 审: 反向代理会加的转发头；带了就说明其实是远程请求。
const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip'];

// 审: 请求是不是真从本机直连来的（回环地址且没有转发头）；guardRemote 用，测试直接用。
export function isLocalCaller(req) {
    if (!isLoopbackAddress(req.socket?.remoteAddress)) return false;
    return !PROXY_HEADERS.some((h) => req.headers?.[h] !== undefined);
}

// 审: 中间件：只服务本机，其他设备 403（6.1 去掉局域网访问后的唯一访问控制）；listener 全局安装。
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

// 审: 把 async 处理函数的拒绝交给错误处理（express 4 不接，Node 会崩）；routes.js 用。
/** Async route handler → rejections go to the error handler (express 4 does
 *  not catch them; on Node ≥ 15 an unhandled rejection ends the process). */
export function asyncRoute(fn) {
    return (req, res, next) => {
        Promise.resolve().then(() => fn(req, res, next)).catch(next);
    };
}

// Last in the chain: a JSON error instead of express's HTML page, and never a crash.
// 审: 兜底错误处理：返回 JSON 错误而不是 HTML，也不崩；listener 链末尾安装。
export function handleRouteError(err, req, res, _next) {
    const status = Number(err?.status ?? err?.statusCode);
    const code = Number.isInteger(status) && status >= 400 && status < 600 ? status : 500;
    if (code >= 500) console.error(`[claude-subscription] ${req.method} ${req.path} 出错：`, err instanceof Error ? err.message : err);
    if (res.headersSent) return res.end();
    res.status(code).json({ error: { message: err instanceof Error ? err.message : String(err), type: code >= 500 ? 'server_error' : 'invalid_request_error' } });
}

// Same as allowCorsGet, plus POST.
// 审: 带 POST 的 CORS（只有 cancel 回复用）；routes.js 的 cors:'full'。
export function allowCors(req, res, next) {
    allowCorsGet(req, res, () => {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        next();
    });
}

// 审: 按「谁可信」生成只读 CORS 中间件，避免两份重复实现。
const corsGetWith = (trusted) => (req, res, next) => {
    const origin = req.headers.origin;
    if (trusted(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    // 审(存疑): Authorization 是访问密钥（6.1 已去掉）时代留下的，现在没有人发；去掉会改变预检响应，所以没动。
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    next();
};

// 审: 普通只读 CORS（本机 / Tauri / 用户列的来源可读）。
export const allowCorsGet = corsGetWith(isAllowedOrigin);

// /v1/debug/last is a dump of whole chats, so a page on this machine gets no
// read access by being on this machine: only the TauriTavern WebView and the
// listed origins see it cross-origin. SillyTavern's panel reads it same-origin
// through the plugin route (fetchProxy falls back there).
// 审: 收紧的只读 CORS（聊天原文那条只给 Tauri / 用户列的来源）。
export const allowCorsGetTrusted = corsGetWith(isTrustedPostOrigin);
