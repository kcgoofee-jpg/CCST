// ──────────────────────────────────────────────
// Live data: the one place that asks the proxy for its status, quota and usage stats, on the
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
import { notify, clearNotice } from './notify.js';
import { F } from './registry.js';
import { chatKeyOf } from './chat-key.js';
import { quotaGate, QUOTA_MIN_GAP_MS } from './quota-gate.js';
import { usagePace } from '../tabs/status.js';

// ── Version: panel and proxy update through different channels ──
// (SillyTavern's extension manager for the panel; git pull / ZIP + a restart for the proxy),
// so they drift apart. Same major.minor = compatible; otherwise say which side is behind and how to update it.

let panelVersion = null;
fetch(new URL('../../../manifest.json', import.meta.url).href)
    .then((r) => r.json()).then((m) => { panelVersion = m.version ?? null; }).catch(() => { /* copy without a manifest */ });
const majorMinor = (v) => String(v ?? '').split('.').slice(0, 2).map(Number);
let warnedVersions = null;

/** 哪一边旧：'proxy' | 'panel' | null（主次版本相同算一致）。 */
export function mismatchSide(proxyVersion, panelV = panelVersion) {
    if (!panelV || !proxyVersion) return null;
    const [pa, pb] = majorMinor(panelV);
    const [xa, xb] = majorMinor(proxyVersion);
    if (pa === xa && pb === xb) return null;
    return xa < pa || (xa === pa && xb < pb) ? 'proxy' : 'panel';
}

/** 一句话的情况 + 影响；具体步骤在面板卡片里（connect-help.js 的 mismatchHelp）。 */
export function versionMismatch(proxyVersion, panelV = panelVersion) {
    const side = mismatchSide(proxyVersion, panelV);
    if (!side) return null;
    return side === 'proxy'
        ? `CCST 服务 v${proxyVersion} 比面板 v${panelV} 旧，请更新`
        : `面板 v${panelV} 比服务 v${proxyVersion} 旧，请更新`;
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
            // Reached the proxy, which turned us away (another device: the proxy is for its own computer)
            store.set({ proxyState: 'offline', status: { phase: 'denied', code: res.status, message: data.error?.message ?? `HTTP ${res.status}` } });
            return;
        }
        if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
        const cred = data.credential ?? {};
        if (!cred.present) {
            store.set({ proxyState: 'warning', proxyOnline: true, status: { phase: 'nologin' } });
            return;
        }
        const mismatch = versionMismatch(data.version);
        if (mismatch) {
            const key = `${panelVersion}|${data.version}`;
            if (warnedVersions !== key) {
                warnedVersions = key;
                notify('warn', '版本不配', '更新后重启酒馆', { ms: 15000 });
            }
        }
        store.set({
            // A mismatch keeps the status card on screen until the versions match.
            proxyState: mismatch ? 'warning' : 'online', proxyOnline: true,
            status: {
                phase: 'online', version: data.version, cred, mismatch, mismatchSide: mismatchSide(data.version), panelVersion, runtime: data.runtime ?? null,
                // 代理自己的健康提示（#30、#36）：SDK 兼容性、连续降级轮数、实际监听地址；
                // via 是这次答复从哪来的——走酒馆同源路由时它可能不是面板设置的那个代理。
                compat: data.compat ?? null, foldStreak: data.foldStreak ?? null, endpoint: data.endpoint ?? null,
                // 和另一个酒馆共用代理时：在聊天的那份装在哪、什么版本（sharedBy 是这个酒馆自己装的）
                root: data.root ?? null, sharedBy: data.sharedBy ?? null,
                via: String(res.url ?? '').includes('/api/plugins/claude-subscription') ? 'plugin' : 'direct',
            },
        });
    } catch {
        const where = normalizeEndpoint(getSettings().endpoint);
        store.set({
            proxyState: 'offline', proxyOnline: false,
            status: { phase: 'offline', where, remote: !/\/\/(127\.0\.0\.1|localhost)[:/]/.test(where) },
        });
    }
}

// ── Heartbeat: notice a dropped proxy and its return ──

export const HEARTBEAT_MS = 20000;
let heartbeatDown = false;

export async function heartbeat() {
    if (!getSettings().enabled || document.hidden) return;
    let up = false;
    let status = 0;
    try {
        const res = await fetchProxy('/status', '/status');
        up = res.ok;
        status = res.status;
    } catch { /* down */ }
    if (up !== store.get().proxyOnline) { store.set({ proxyOnline: up }); }
    // Only worth a notice when SillyTavern is actually using this proxy.
    const { connected } = connectionInfo();
    if (!up && heartbeatDown && !connected) {
        heartbeatDown = false;
        clearNotice('proxy');
    } else if (!up && !heartbeatDown && connected) {
        heartbeatDown = true;
        if (status === 401 || status === 403) {
            notify('bad', '本机专用', '只给装它的那台电脑用', { ms: 0, replace: 'proxy' });
        } else {
            notify('bad', '重连中', '看看那台电脑是否开着', { ms: 0, replace: 'proxy' });
        }
        refreshStatus();
    } else if (up && heartbeatDown) {
        heartbeatDown = false;
        notify('ok', '已恢复', '可以继续发了', { ms: 3000, replace: 'proxy' });
        setTimeout(() => F.keeper.recoverKeptReply(), 500);
        refreshStatus();
    }
}

export function startHeartbeat() {
    return setInterval(heartbeat, HEARTBEAT_MS);
}

// ── Quota meter ──

export { QUOTA_MIN_GAP_MS };
let quotaAskedAt = 0;      // last time this panel actually asked the proxy
let quotaNotBefore = 0;    // upstream rate limit: no ask before this
let quotaInFlight = false;
let quotaTimer = null;

/** Ask for the quota — at most once per 60 s per panel, however often the tab / drawer / heartbeat
 *  path calls this (Anthropic rate-limits the endpoint). `force` skips the gap for the one case where
 *  the user asked (刷新); it still respects an upstream rate limit. */
export async function refreshQuota({ force = false } = {}) {
    if (!document.getElementById('claude_max_quota')) return;
    const now = Date.now();
    const gate = quotaGate({ now, phase: store.get().quota.phase, force, inFlight: quotaInFlight, askedAt: quotaAskedAt, notBefore: quotaNotBefore });
    if (!gate.ask) {
        // Not asking (too soon / backing off): never leave a 「正在读取」 placeholder behind.
        if (gate.phase && store.get().quota.phase !== gate.phase) store.set({ quota: { ...store.get().quota, phase: gate.phase } });
        return;
    }
    quotaAskedAt = now;
    quotaInFlight = true;
    if (store.get().quota.phase !== 'ok') store.set({ quota: { phase: 'loading' } }); // keep numbers on screen while re-asking
    try {
        const res = await fetchProxy('/quota', '/v1/usage/quota');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const five = data.windows?.find((w) => w.type === 'five_hour');
        const q5 = five?.utilization != null ? Math.round(five.utilization * 100) : null;
        glancePatch({ quota: q5, quotaPace: usagePace(q5, five?.resetsAt, 5 * 3600_000)?.level ?? null });
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
        // This chat's last turn only (a hash of the chat file name; 'none' = no chat open, matches nothing).
        const chat = encodeURIComponent(chatKeyOf(SillyTavern.getContext()) ?? 'none');
        const res = await fetchProxy(`/stats?chat=${chat}`, `/v1/usage/stats?chat=${chat}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        glancePatch({ cache: data.lastCache?.reusePct ?? data.lastCache?.hitPct ?? null });
        store.set({ stats: { phase: 'ok', data } });
        store.set({ statsAt: Date.now() }); // 回复后自动刷新也要更新「更新于」时间
    } catch (err) {
        store.set({ stats: { phase: 'error', error: err } });
    }
}

// The quota is NOT fetched when the panel opens (Anthropic rate-limits it, and a fresh install has
// nothing to show): it is asked for after each reply and by the 刷新 button.
export async function refreshStatsPage() {
    await refreshStats();
    store.set({ statsAt: Date.now() });
}

// ── Full refresh (drawer opened, 重新检测) ──
// Local renders (connect note, cache card, check-up) listen to `pulse`;
// the fetches start here.

// 最新版本：GitHub 上 main 的 package.json（一键安装装的就是它），6 小时查一次，记在本机
const LATEST_URL = 'https://raw.githubusercontent.com/kcgoofee-jpg/CCST/main/package.json';
const LATEST_KEY = 'claude_max_latest';
export async function checkLatest(now = Date.now()) {
    try {
        const saved = JSON.parse(localStorage.getItem(LATEST_KEY) ?? 'null');
        if (saved?.version && now - saved.at < 6 * 3600_000) { store.set({ latestVersion: saved.version }); return; }
    } catch { /* 读不了就重新查 */ }
    try {
        const pkg = await fetch(LATEST_URL, { cache: 'no-store', signal: timeoutSignal(8000) }).then((r) => r.json());
        if (typeof pkg?.version !== 'string') return;
        try { localStorage.setItem(LATEST_KEY, JSON.stringify({ version: pkg.version, at: now })); } catch { /* 无痕模式 */ }
        store.set({ latestVersion: pkg.version });
    } catch { /* 连不上 GitHub：不提示 */ }
}

export function refreshAll() {
    store.set({ pulse: store.get().pulse + 1 });
    refreshStatus();
    refreshStatsPage();
    // The quota too (quota-gate keeps the 60 s gap): a 「点刷新」 placeholder was all 状态 showed before.
    refreshQuota();
    checkLatest();
}
