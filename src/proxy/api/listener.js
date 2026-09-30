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
// POST /v1/chat/completions comes from SillyTavern's server (no Origin), or —
// in LAN mode — straight from a phone's TauriTavern, which must present the
// access key (guardRemote).

import express from 'express';

import { guardHost, guardRemote, handleRouteError } from './guards.js';
import { registerRoutes } from './routes.js';

let serverInstance = null;

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
            if (host === '0.0.0.0' || host === '::') {
                console.warn(process.env.CLAUDE_SUBSCRIPTION_LAN_KEY
                    ? '[claude-subscription] 局域网访问已开启：其他设备要带访问密码才能用（手机 TauriTavern 在 CCST 面板「其他 → 手机连接」里填）。'
                    : '[claude-subscription] listening on every network interface, but no CLAUDE_SUBSCRIPTION_LAN_KEY is set: requests from other machines are refused.');
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

export function portInUseMessage(port) {
    return `[claude-subscription] port ${port} is already in use. Set ` +
        'CLAUDE_SUBSCRIPTION_PORT to a free port and restart — then update ' +
        '"Endpoint (advanced)" in the CCST panel to match.';
}

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

export function stopStandaloneListener() {
    if (!serverInstance) return Promise.resolve();
    return new Promise((resolve) => {
        serverInstance.close(() => {
            serverInstance = null;
            resolve();
        });
    });
}
