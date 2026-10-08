// ──────────────────────────────────────────────
// The route table: every endpoint the proxy exposes, once
// ──────────────────────────────────────────────
//
// Two mounts serve the same handlers:
//   standalone  the separate listener (default 127.0.0.1:8901), paths under /v1
//               (plus /status); CORS for loopback / TauriTavern origins, and
//               the listener's global guards (Host, this machine only) in front.
//   plugin      SillyTavern's own router at /api/plugins/claude-subscription;
//               SillyTavern supplies CSRF and same-origin, so no CORS here.
//               Only the endpoints the panel reads same-origin are mounted.
//
// Entry fields
//   standalone / plugin  path on that mount (omit = not served there)
//   method               'get' | 'post'
//   handler              the request handler
//   async                wrap in asyncRoute (rejections → the error handler)
//   cors                 standalone only: 'get' (GET, OPTIONS) | 'get-trusted'
//                        (GET, OPTIONS, but only the TauriTavern WebView and the
//                        listed origins may read it cross-origin) | 'full'
//                        (GET, POST, OPTIONS); also answers the OPTIONS preflight
//   origin               standalone only: POST endpoints. No Origin (SillyTavern's
//                        server-side forward) and the TauriTavern / listed origins
//                        pass; any other browser origin, a page on this machine
//                        included, is refused (guards.js)

import { handleChatCompletions, rejectEmbeddings } from '../core/chat.js';
import { listModelsHandler } from '../core/models.js';
import { handleStatus } from './status.js';
import { handleQuota } from '../features/oauth.js';
import { handleStats } from '../features/usage-stats.js';
import { handleDebugLast } from '../features/last-request.js';
import { handleDiagFull, handleDiagReport } from '../features/diag-report.js';
import { handleCancelReply, handleKeptReply } from '../features/reply-keeper.js';
import { countInFlight } from '../platform/control.js';
import { forwardToShared, sharingWith } from './shared-proxy.js';
import { asyncRoute, allowCors, allowCorsGet, allowCorsGetTrusted, guardPostOrigin } from './guards.js';

// 审: 全部端点的唯一路由表（standalone 和 plugin 两个挂载共用处理函数），少一行就少一个接口。
export const ROUTES = [
    { method: 'get', standalone: '/status', plugin: '/status', handler: handleStatus, async: true, cors: 'get' },
    { method: 'get', standalone: '/v1/models', handler: listModelsHandler, cors: 'get' },
    { method: 'get', standalone: '/v1/usage/quota', plugin: '/quota', handler: handleQuota, async: true, cors: 'get' },
    { method: 'get', standalone: '/v1/usage/stats', plugin: '/stats', handler: handleStats, cors: 'get' },
    { method: 'get', standalone: '/v1/debug/last', plugin: '/debug', handler: handleDebugLast, cors: 'get-trusted' },
    // Diagnostics report (features/diag-report.js): text without chat content; full adds captured bodies.
    { method: 'get', standalone: '/v1/diag/report', plugin: '/diag/report', handler: handleDiagReport, cors: 'get-trusted' },
    { method: 'get', standalone: '/v1/diag/full', plugin: '/diag/full', handler: handleDiagFull, cors: 'get-trusted' },
    // countInFlight also catches the handler's rejections.
    { method: 'post', standalone: '/v1/chat/completions', handler: countInFlight(handleChatCompletions), origin: true },
    // Kept replies (features/reply-keeper.js): fetch one back, or cancel (the panel's Stop).
    { method: 'get', standalone: '/v1/replies/:slot', plugin: '/reply/:slot', handler: handleKeptReply, cors: 'get' },
    { method: 'post', standalone: '/v1/replies/:slot/cancel', plugin: '/reply/:slot/cancel', handler: handleCancelReply, cors: 'full', origin: true },
    { method: 'post', standalone: '/v1/embeddings', handler: rejectEmbeddings, origin: true },
];

// 审: 某个挂载提供的「METHOD 路径」列表，仅测试 / 文档用。
/** Paths one mount serves, as "METHOD path" strings (for tests / docs). */
export function routeKeys(mount) {
    return ROUTES.filter((r) => r[mount]).map((r) => `${r.method.toUpperCase()} ${r[mount]}`);
}

// 审: cors 字段取值 → 对应的 CORS 中间件。
const CORS = { get: allowCorsGet, 'get-trusted': allowCorsGetTrusted, full: allowCors };

// 审: 把路由表注册到 express app / router（含 CORS 预检、来源守卫、共用代理时转发）；listener 和 plugin 用。
/** Register the table on an express app / router. mount = 'standalone' | 'plugin'. */
export function registerRoutes(router, mount) {
    const standalone = mount === 'standalone';
    const preflight = new Map();
    for (const r of ROUTES) {
        const path = r[mount];
        if (!path) continue;
        const chain = [];
        if (standalone && r.cors) chain.push(CORS[r.cors]);
        if (standalone && r.origin) chain.push(guardPostOrigin);
        // 和另一个酒馆共用代理时，面板要的数据在那边（shared-proxy.js）
        if (!standalone && r.standalone) chain.push((req, res, next) => (sharingWith() ? forwardToShared(req, res, r.standalone).catch(next) : next()));
        chain.push(r.async ? asyncRoute(r.handler) : r.handler);
        router[r.method](path, ...chain);
        if (standalone && r.cors && !preflight.has(path)) preflight.set(path, CORS[r.cors]);
    }
    for (const [path, cors] of preflight) router.options(path, cors, (_req, res) => res.sendStatus(204));
}
