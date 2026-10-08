// ──────────────────────────────────────────────
// Talking to the proxy: its own address first, SillyTavern's same-origin plugin route as the fallback.
// ──────────────────────────────────────────────

import { getSettings } from './settings.js';
import { IS_TAURI, proxyBaseOf, proxyDirectOnly } from './capabilities.js';

// 审: 带超时的 AbortSignal，老 WebView 没有 AbortSignal.timeout 时手工实现。
/** AbortSignal.timeout is missing in older WebViews. */
export function timeoutSignal(ms) {
    if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
}

// 审: 访问代理路由的唯一入口：先直连代理，失败再回落酒馆同源插件路由（仅默认端点且非 TauriTavern）。
/** Call a proxy route: the proxy directly first, then (default endpoint
 *  only, not TauriTavern) ST's same-origin plugin route, which works when
 *  the ST UI is opened from another device. */
export async function fetchProxy(pluginPath, directPath, { method = 'GET', body } = {}) {
    // The proxy itself first: it is the source of truth (the ST plugin
    // route can be an older copy until SillyTavern restarts). On another
    // device 127.0.0.1 is unreachable, so that fails fast and the
    // same-origin plugin route takes over.
    // The plugin route speaks for the proxy on the default port only: with
    // another endpoint (another machine, another port) falling back to it
    // would report a different proxy as healthy while this one is down.
    const settings = getSettings();
    const directOnly = proxyDirectOnly({ tauri: IS_TAURI, endpoint: settings.endpoint });
    try {
        const headers = {};
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const direct = await fetch(`${proxyBaseOf(settings.endpoint)}${directPath}`, { method, signal: timeoutSignal(directOnly ? 12000 : 1500), headers, body: body !== undefined ? JSON.stringify(body) : undefined });
        if (direct.ok || directOnly) return direct;
    } catch (err) {
        if (directOnly) throw err;
    }
    const headers = method === 'GET' ? {} : { ...(SillyTavern.getContext().getRequestHeaders?.() ?? {}) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(`/api/plugins/claude-subscription${pluginPath}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: timeoutSignal(12000) });
}

// 审(存疑): 参数 what 没被使用（调用方 tabs/status.js 在别的分区，未改签名）；没连上代理时给人话而不是 HTTP 码。
/** 没装 / 没连本代理时（酒馆里没有插件路由 → 404，或连不上）说人话，别只给 HTTP 码。 */
export function proxyErrorText(what, err) {
    const msg = String(err instanceof Error ? err.message : err);
    if (/404|Failed to fetch|NetworkError|ECONNREFUSED/i.test(msg)) return '连上 CCST 才能看';
    return `暂时看不了（${msg}）`;
}
