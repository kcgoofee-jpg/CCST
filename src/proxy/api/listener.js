// ──────────────────────────────────────────────
// Standalone HTTP listener (separate from SillyTavern's Express app)
// ──────────────────────────────────────────────
//
// SillyTavern wraps its entire Express app in CSRF protection
// (server-main.js — csrfSync mounted before plugins load). When SillyTavern's
// chat-completions backend issues a server-side outbound fetch to whatever
// URL the user put in "Custom Endpoint", that loopback request has no CSRF
// token and gets a 403 Forbidden — even if the URL points at one of our own
// /api/plugins routes. The clean fix is a separate port outside SillyTavern's
// middleware stack.
//
// Routes (api/routes.js) carry CORS for loopback / TauriTavern origins only, so the companion
// UI extension (running on the SillyTavern browser origin) can read /status,
// /v1/usage/quota etc. directly. The listener binds 127.0.0.1 by default.
// POST /v1/chat/completions comes from SillyTavern's server (no Origin); requests
// from another machine are refused (guardRemote).

import express from 'express';

import { guardHost, guardRemote, handleRouteError } from './guards.js';
import { registerRoutes } from './routes.js';

// 审: 当前在听的 HTTP 服务器，null = 没在听；防重复启动、localEndpoint 和停止都读它。
let serverInstance = null;

// 审: 视为本机的监听地址，localEndpoint 判断用。
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

// 审: 这个进程在本机上实际可访问的地址，/status 的 endpoint 字段让面板核对设置里的端点。
/** Where this process can be reached from the machine it runs on: the port the
 *  listener actually got, on a loopback address. Null when it is bound to one
 *  specific non-loopback interface (nothing to promise) or is not listening. */
export function localEndpoint() {
    const addr = serverInstance?.address?.();
    if (!addr || typeof addr !== 'object') return null;
    if (addr.address === '0.0.0.0' || addr.address === '::') return `http://127.0.0.1:${addr.port}/v1`;
    return LOOPBACK.has(addr.address) ? `http://${addr.address}:${addr.port}/v1` : null;
}

// 审: 启动独立监听（酒馆 CSRF 之外的端口），插件和单独运行都用；已在听则复用。
export function startStandaloneListener({ port, host }) {
    if (serverInstance) return Promise.resolve(serverInstance);

    const app = express();
    app.disable('x-powered-by');
    app.use(guardHost(host));
    app.use(guardRemote);
    app.use(express.json({ limit: '100mb' }));

    registerRoutes(app, 'standalone');
    app.use(handleRouteError);

    return new Promise((resolve, reject) => {
        const server = app.listen(port, host, () => {
            serverInstance = server;
            // 审(存疑): 6.1 去掉局域网访问后，仍可通过 CLAUDE_SUBSCRIPTION_HOST 绑 0.0.0.0；这条警告只是说明「绑了也只服务本机」，删环境变量支持属于行为变化，没动。
            if (host === '0.0.0.0' || host === '::') {
                console.warn('[claude-subscription] listening on every network interface, but requests from other machines are refused: the proxy is for this computer only.');
            }
            console.log(
                `[claude-subscription] standalone listener: http://${host}:${port}/v1 ` +
                '(the companion UI extension configures SillyTavern automatically)',
            );
            resolve(server);
        });

        server.on('error', (err) => {
            // EADDRINUSE is reported by the caller — the plugin may reuse a
            // standalone proxy already listening there.
            if (!err || err.code !== 'EADDRINUSE') {
                console.error('[claude-subscription] listener error:', err);
            }
            reject(err);
        });
    });
}

// 审: 端口被占时的提示文案；server.js 和 plugin.js 用。
export function portInUseMessage(port) {
    return `[claude-subscription] port ${port} is already in use. Set ` +
        'CLAUDE_SUBSCRIPTION_PORT to a free port and restart — then update ' +
        '"Endpoint (advanced)" in the CCST panel to match.';
}

// 审: 探测 host:port 上是不是我们自己的代理（用 /status 的 plugin 字段）；启动前判断共用 / 退出。
/** Is the process on host:port our own proxy? (standalone `npm start`) */
export async function probeExistingProxy({ port, host }) {
    try {
        const res = await fetch(`http://${host.includes(':') ? `[${host}]` : host}:${port}/status`, { signal: AbortSignal.timeout(3000) });
        const body = await res.json();
        return body?.plugin === 'claude-subscription';
    } catch {
        return false;
    }
}

// 审: 关闭监听并立刻断开 keep-alive 连接，退出和插件 exit 用。
export function stopStandaloneListener() {
    if (!serverInstance) return Promise.resolve();
    const server = serverInstance;
    serverInstance = null;
    return new Promise((resolve) => {
        server.close(() => resolve());
        // Keep-alive sockets from the panel or TauriTavern would otherwise hold
        // close() until they time out (#33).
        server.closeIdleConnections?.();
    });
}
