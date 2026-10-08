// ──────────────────────────────────────────────
// 本机开了几个酒馆：端口上只有一个代理，后启动的酒馆共用它
// ──────────────────────────────────────────────
//
// 聊天本来就直接发到 8901，走的是那个代理；但面板读的是自己酒馆的插件路由，
// 共用期间这些路由要转给那个代理，状态 / 诊断才对得上。那个代理关掉后，这边接管端口。

import { ROOT } from '../paths.js';
import { getPluginVersion } from './status.js';

// 审: 共用期间多久检查一次对方还在不在。
const CHECK_MS = 10_000;

// 审: 共用状态，null = 没在共用。
let shared = null; // { base, timer } while another proxy owns the port

// 审: 正在共用时返回对方地址，否则 null；routes.js 判断要不要转发。
export function sharingWith() {
    return shared ? shared.base : null;
}

/** 开始共用 host:port 上的代理；alive() 说它还在不在，takeOver() 试着自己监听（成功返回 true）。 */
export function startSharing({ port, host, alive, takeOver, checkMs = CHECK_MS }) {
    stopSharing();
    const base = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
    const timer = setInterval(async () => {
        if (await alive()) return;
        try {
            if (await takeOver()) {
                stopSharing();
                console.log(`[claude-subscription] 共用的代理已关闭，这个酒馆接管了 ${base}/v1`);
            }
        } catch { /* 端口还没放开，下次再试 */ }
    }, checkMs);
    timer.unref?.();
    shared = { base, timer };
}

// 审: 结束共用（接管成功 / 插件退出 / 重新开始共用时）。
export function stopSharing() {
    if (shared) clearInterval(shared.timer);
    shared = null;
}

/** 把插件路由的请求转给共用的代理（standalonePath 是那边的路径，可带 :参数）。 */
export async function forwardToShared(req, res, standalonePath, fetchImpl = fetch) {
    const path = standalonePath.replace(/:(\w+)/g, (_, k) => encodeURIComponent(req.params?.[k] ?? ''));
    const query = String(req.originalUrl ?? '').split('?')[1];
    const upstream = await fetchImpl(`${shared.base}${path}${query ? `?${query}` : ''}`, {
        method: req.method,
        headers: req.method === 'GET' ? {} : { 'content-type': 'application/json' },
        body: req.method === 'GET' ? undefined : JSON.stringify(req.body ?? {}),
        signal: AbortSignal.timeout(30_000),
    });
    const type = upstream.headers.get('content-type') ?? '';
    if (standalonePath === '/status' && type.includes('json')) {
        const body = await upstream.json();
        // 面板拿它核对：在聊天的代理是不是这个酒馆装的这一份
        return res.status(upstream.status).json({ ...body, sharedBy: { root: ROOT, version: getPluginVersion() } });
    }
    res.status(upstream.status);
    if (type) res.type(type);
    return res.send(Buffer.from(await upstream.arrayBuffer()));
}
