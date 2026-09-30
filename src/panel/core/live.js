// ──────────────────────────────────────────────
// Live data: the one place that asks the proxy for its status, quota, usage stats and backend, on the
// schedule the panel always had (drawer opened, tab entered, after a reply, the 20 s heartbeat), and
// puts the answers into the store. Tabs subscribe to the store and draw; nothing here touches the DOM
// except to check that the panel is built (a fetch for a panel that isn't there is skipped).
// ──────────────────────────────────────────────

import { store } from './store.js';
import { getSettings } from './settings.js';
import { normalizeEndpoint } from './capabilities.js';
import { fetchProxy, timeoutSignal } from './proxy.js';
import { IS_TAURI } from './capabilities.js';
import { connectionInfo } from './connection.js';
import { notify, ui, flushIsland, clearNotice } from './notify.js';
import { F } from './registry.js';

// ── Version: panel and proxy update through different channels ──
// (SillyTavern's extension manager or 手机同步 for the panel; git pull / ZIP + a restart for the proxy),
// so they drift apart. Same major.minor = compatible; otherwise say which side is behind and how to update it.

let panelVersion = null;
fetch(new URL('../../../manifest.json', import.meta.url).href)
    .then((r) => r.json()).then((m) => { panelVersion = m.version ?? null; }).catch(() => { /* copy without a manifest */ });
const majorMinor = (v) => String(v ?? '').split('.').slice(0, 2).map(Number);
let warnedVersions = null;

export function versionMismatch(proxyVersion, panelV = panelVersion) {
    if (!panelV || !proxyVersion) return null;
    const [pa, pb] = majorMinor(panelV);
    const [xa, xb] = majorMinor(proxyVersion);
    if (pa === xa && pb === xb) return null;
    const proxyOlder = xa < pa || (xa === pa && xb < pb);
    return proxyOlder
        ? `代理 v${proxyVersion} 旧于面板 v${panelV}：「酒馆工具」里重启代理（ZIP 要先换新版）。`
        : `面板 v${panelV} 旧于代理 v${proxyVersion}：在酒馆「扩展」里更新 CCST（手机用「手机同步」）。`;
}

const glancePatch = (partial) => store.merge('glance', partial);

// ── Proxy status ──

export async function refreshStatus() {
    if (!document.getElementById('claude_max_status_title') || !document.getElementById('claude_max_status_sub')) return;
    store.set({ status: { phase: 'pending' } });
    try {
        const res = await fetchProxy('/status', '/status');
        const data = await res.json().catch(() => ({}));
        if (res.status === 401 || res.status === 403) {
            // Reached the proxy, which turned us away (access key / LAN not on)
            store.set({ proxyState: 'offline', status: { phase: 'denied', code: res.status, message: data.error?.message ?? `HTTP ${res.status}` } });
            return;
        }
        if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
        const cred = data.credential ?? {};
        ui.island?.set({ online: true });
        if (!cred.present) {
            store.set({ proxyState: 'warning', proxyOnline: true, status: { phase: 'nologin' } });
            return;
        }
        const mismatch = versionMismatch(data.version);
        if (mismatch) {
            const key = `${panelVersion}|${data.version}`;
            if (warnedVersions !== key) {
                warnedVersions = key;
                notify('warn', '面板和代理版本不一致', mismatch, { ms: 15000 });
            }
        }
        store.set({
            // A mismatch keeps the status card on screen until the versions match.
            proxyState: mismatch ? 'warning' : 'online', proxyOnline: true,
            status: { phase: 'online', version: data.version, cred, mismatch },
        });
    } catch {
        ui.island?.set({ online: false });
        const where = normalizeEndpoint(getSettings().endpoint);
        store.set({
            proxyState: 'offline', proxyOnline: false,
            status: { phase: 'offline', where, remote: !/\/\/(127\.0\.0\.1|localhost)[:/]/.test(where) },
        });
    }
}

// ── Heartbeat: notice a dropped proxy (Mac asleep, Wi-Fi switched) and its return ──

export const HEARTBEAT_MS = 20000;
let heartbeatDown = false;

export async function heartbeat() {
    if (!getSettings().enabled || document.hidden) return;
    flushIsland();
    let up = false;
    let status = 0;
    try {
        const res = await fetchProxy('/status', '/status');
        up = res.ok;
        status = res.status;
    } catch { /* down */ }
    if (up) F.perf.diagIfAsked();
    F.quiet.quietSweep();
    if (up !== store.get().proxyOnline) { store.set({ proxyOnline: up }); ui.island?.set({ online: up }); }
    // Only worth a notice when SillyTavern is actually using this proxy.
    const { connected } = connectionInfo();
    if (!up && heartbeatDown && !connected) {
        heartbeatDown = false;
        clearNotice('proxy');
    } else if (!up && !heartbeatDown && connected) {
        heartbeatDown = true;
        if (status === 401) {
            notify('bad', '访问密码不对', '在 CCST「其他 → 手机连接」里改好，再点「重新连接」。', { ms: 0, replace: 'proxy' });
        } else if (status === 403) {
            notify('bad', '代理拒绝连接', '那台电脑没开「手机模式」：在「酒馆工具」里打开。', { ms: 0, replace: 'proxy' });
        } else {
            notify('bad', '连不上代理，重试中', '手机连 Mac：确认 Mac 没睡、同一个 Wi-Fi。', { ms: 0, replace: 'proxy' });
        }
        refreshStatus();
    } else if (up && heartbeatDown) {
        heartbeatDown = false;
        notify('ok', '代理已恢复', '可以继续发消息了', { ms: 3000, replace: 'proxy' });
        setTimeout(() => F.keeper.recoverKeptReply(), 500);
        refreshStatus();
    }
}

export function startHeartbeat() {
    return setInterval(heartbeat, HEARTBEAT_MS);
}

// ── Quota meter ──

export const QUOTA_MIN_GAP_MS = 60000;
let quotaAskedAt = 0;      // last time this panel actually asked the proxy
let quotaNotBefore = 0;    // upstream rate limit: no ask before this
let quotaInFlight = false;
let quotaTimer = null;

/** Ask for the quota — at most once per 60 s per panel, however often the tab / drawer / heartbeat
 *  path calls this (Anthropic rate-limits the endpoint). `force` skips the gap for the one case where
 *  the answer really changed (backend switched); it still respects an upstream rate limit. */
export async function refreshQuota({ force = false } = {}) {
    if (!document.getElementById('claude_max_quota') || quotaInFlight) return;
    const now = Date.now();
    if (now < quotaNotBefore) return;
    if (!force && quotaAskedAt && now - quotaAskedAt < QUOTA_MIN_GAP_MS) return;
    quotaAskedAt = now;
    quotaInFlight = true;
    if (store.get().quota.phase !== 'ok') store.set({ quota: { phase: 'loading' } }); // keep numbers on screen while re-asking
    try {
        const res = await fetchProxy('/quota', '/v1/usage/quota');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        // API-type backends bill per token: no 5h / 7d windows to show.
        if (data.notSubscription) {
            glancePatch({ quota: null });
        } else {
            const five = data.windows?.find((w) => w.type === 'five_hour');
            glancePatch({ quota: five?.utilization != null ? Math.round(five.utilization * 100) : null });
        }
        clearTimeout(quotaTimer);
        quotaNotBefore = 0;
        if (data.retryAt) {
            // The proxy is backing off: don't ask again before it says, then try once by ourselves.
            quotaNotBefore = data.retryAt;
            quotaTimer = setTimeout(() => refreshQuota({ force: true }), Math.max(1000, data.retryAt - Date.now() + 1000));
        }
        store.set({ quota: { phase: 'ok', data } });
    } catch (err) {
        store.set({ quota: { phase: 'error', error: err } });
    } finally {
        quotaInFlight = false;
    }
}

// ── Usage stats ──

export async function refreshStats() {
    if (!document.getElementById('claude_max_stats')) return;
    store.set({ stats: { phase: 'loading' } });
    try {
        const res = await fetchProxy('/stats', '/v1/usage/stats');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        glancePatch({ cache: data.lastCache?.hitPct ?? null });
        store.set({ stats: { phase: 'ok', data } });
    } catch (err) {
        store.set({ stats: { phase: 'error', error: err } });
    }
}

export async function refreshStatsPage() {
    await Promise.all([refreshQuota(), refreshStats()]);
    store.set({ statsAt: Date.now() });
}

// ── 代理后端 ──

export async function refreshBackend() {
    if (!document.getElementById('claude_max_backend')) return;
    // Keep the form on screen while re-reading it after a save; only a first read shows 「正在读取」.
    if (store.get().backend.phase !== 'ok') store.set({ backend: { phase: 'loading' } });
    try {
        const res = await fetchProxy('/backend', '/v1/backend');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        store.set({ backend: { phase: 'ok', view: await res.json() } });
    } catch (err) {
        store.set({ backend: { phase: 'error', error: err } });
    }
}

// ── Full refresh (drawer opened, 重新检测) ──
// Local renders (connect note, cache card, lore box, check-up, card check) listen to `pulse`;
// the fetches start here.

export function refreshAll() {
    store.set({ pulse: store.get().pulse + 1 });
    refreshStatus();
    refreshStatsPage();
}
