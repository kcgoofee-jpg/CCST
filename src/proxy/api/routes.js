// ──────────────────────────────────────────────
// The route table: every endpoint the proxy exposes, once
// ──────────────────────────────────────────────
//
// Two mounts serve the same handlers:
//   standalone  the separate listener (default 127.0.0.1:8901), paths under /v1
//               (plus /status); CORS for loopback / TauriTavern origins, and
//               the listener's global guards (Host, LAN key) in front.
//   plugin      SillyTavern's own router at /api/plugins/claude-subscription;
//               SillyTavern supplies CSRF and same-origin, so no CORS here.
//               Only the endpoints the panel reads same-origin are mounted.
//
// Entry fields
//   standalone / plugin  path on that mount (omit = not served there)
//   method               'get' | 'post'
//   handler              the request handler
//   async                wrap in asyncRoute (rejections → the error handler)
//   cors                 standalone only: 'get' (GET, OPTIONS) | 'full' (GET, POST, OPTIONS);
//                        also answers the OPTIONS preflight for the path
//   origin               standalone only: refuse browser Origins outside the allow-list
//                        (POST endpoints; chat is called server-side and sends none)

import { handleChatCompletions, rejectEmbeddings } from '../core/chat.js';
import { listModelsHandler } from '../core/models.js';
import { handleStatus } from './status.js';
import { handleQuota } from '../features/oauth.js';
import { handleStats } from '../features/usage-stats.js';
import { handleBackendGet, handleBackendPost } from '../features/backend-config.js';
import { handleDebugLast } from '../features/debug-dump.js';
import { handleCancelReply, handleKeptReply } from '../features/reply-keeper.js';
import { countInFlight, handleControlAction, handleControlLog, handleControlStatus, handleDiagRequest, handleDiagResult } from '../platform/control.js';
import { asyncRoute, allowCors, allowCorsGet, guardPostOrigin } from './guards.js';

export const ROUTES = [
    { method: 'get', standalone: '/status', plugin: '/status', handler: handleStatus, async: true, cors: 'get' },
    { method: 'get', standalone: '/v1/models', handler: listModelsHandler, cors: 'get' },
    { method: 'get', standalone: '/v1/usage/quota', plugin: '/quota', handler: handleQuota, async: true, cors: 'get' },
    { method: 'get', standalone: '/v1/usage/stats', plugin: '/stats', handler: handleStats, cors: 'get' },
    { method: 'get', standalone: '/v1/debug/last', plugin: '/debug', handler: handleDebugLast, cors: 'get' },
    // countInFlight also catches the handler's rejections.
    { method: 'post', standalone: '/v1/chat/completions', handler: countInFlight(handleChatCompletions), origin: true },
    // Kept replies (features/reply-keeper.js): fetch one back, or cancel (the panel's Stop).
    { method: 'get', standalone: '/v1/replies/:slot', plugin: '/reply/:slot', handler: handleKeptReply, cors: 'get' },
    { method: 'post', standalone: '/v1/replies/:slot/cancel', plugin: '/reply/:slot/cancel', handler: handleCancelReply, cors: 'full', origin: true },
    // Phone → Mac remote control (launcher actions only; see platform/control.js).
    { method: 'get', standalone: '/v1/control/status', handler: handleControlStatus, async: true, cors: 'full' },
    { method: 'get', standalone: '/v1/control/log', handler: handleControlLog, async: true, cors: 'full' },
    { method: 'get', standalone: '/v1/control/diag-request', handler: handleDiagRequest, cors: 'full' },
    { method: 'post', standalone: '/v1/control/diag-request', handler: handleDiagRequest, cors: 'full', origin: true },
    { method: 'get', standalone: '/v1/control/diag', handler: handleDiagResult, cors: 'full' },
    { method: 'post', standalone: '/v1/control/diag', handler: handleDiagResult, cors: 'full', origin: true },
    { method: 'post', standalone: '/v1/control/action', handler: handleControlAction, async: true, cors: 'full', origin: true },
    // Backend choice (features/backend-config.js): secrets go in, never come back out.
    // Remote callers need the access key like everything else (guardRemote).
    { method: 'get', standalone: '/v1/backend', plugin: '/backend', handler: handleBackendGet, cors: 'full' },
    { method: 'post', standalone: '/v1/backend', plugin: '/backend', handler: handleBackendPost, cors: 'full', origin: true },
    { method: 'post', standalone: '/v1/embeddings', handler: rejectEmbeddings, origin: true },
];

/** Paths one mount serves, as "METHOD path" strings (for tests / docs). */
export function routeKeys(mount) {
    return ROUTES.filter((r) => r[mount]).map((r) => `${r.method.toUpperCase()} ${r[mount]}`);
}

/** Register the table on an express app / router. mount = 'standalone' | 'plugin'. */
export function registerRoutes(router, mount) {
    const standalone = mount === 'standalone';
    const preflight = new Map();
    for (const r of ROUTES) {
        const path = r[mount];
        if (!path) continue;
        const chain = [];
        if (standalone && r.cors) chain.push(r.cors === 'full' ? allowCors : allowCorsGet);
        if (standalone && r.origin) chain.push(guardPostOrigin);
        chain.push(r.async ? asyncRoute(r.handler) : r.handler);
        router[r.method](path, ...chain);
        if (standalone && r.cors && !preflight.has(path)) preflight.set(path, r.cors === 'full' ? allowCors : allowCorsGet);
    }
    for (const [path, cors] of preflight) router.options(path, cors, (_req, res) => res.sendStatus(204));
}
