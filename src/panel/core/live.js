// ──────────────────────────────────────────────
// Live data: the one place that asks the proxy for its status, quota and usage stats, on the
// schedule the panel always had (drawer opened, tab entered, after a reply, the 20 s heartbeat), and
// puts the answers into the store. Tabs subscribe to the store and draw; nothing here touches the DOM
// except to check that the panel is built (a fetch for a panel that isn't there is skipped).
// ──────────────────────────────────────────────

import { store } from './store.js';
import { getSettings } from './settings.js';
import { fetchProxy, timeoutSignal } from './proxy.js';
import { connectionInfo } from './connection.js';
import { notify, clearNotice } from './notify.js';
import { F } from './registry.js';
import { chatKeyOf } from './chat-key.js';
import { quotaGate } from './quota-gate.js';
import { usagePace } from '../tabs/status.js';

// ── Version: panel and proxy update through different channels ──
// (SillyTavern's extension manager for the panel; git pull / ZIP + a restart for the proxy),
// so they drift apart. Same major.minor = compatible; otherwise say which side is behind and how to update it.

// 审: 面板自己的版本号，启动时读 manifest.json；读不到（副本缺 manifest）则为 null，版本比对随之跳过。
let panelVersion = null;
fetch(new URL('../../../manifest.json', import.meta.url).href)
    .then((r) => r.json()).then((m) => { panelVersion = m.version ?? null; }).catch(() => { /* copy without a manifest */ });
// 审: 取主次版本号（同主次版本视为兼容）。
const majorMinor = (v) => String(v ?? '').split('.').slice(0, 2).map(Number);
// 审: 同一对版本只弹一次「版本不配」，避免每次刷新都弹。
let warnedVersions = null;

// 审: 哪一边旧（proxy / panel / null=一致）；shell 的版本不配卡片用。
/** 哪一边旧：'proxy' | 'panel' | null（主次版本相同算一致）。 */
export function mismatchSide(proxyVersion, panelV = panelVersion) {
    if (!panelV || !proxyVersion) return null;
    const [pa, pb] = majorMinor(panelV);
    const [xa, xb] = majorMinor(proxyVersion);
    if (pa === xa && pb === xb) return null;
    return xa < pa || (xa === pa && xb < pb) ? 'proxy' : 'panel';
}

// 审: 版本不配时的一句话说明（卡片上的具体步骤在 connect-help.js）。
/** 一句话的情况 + 影响；具体步骤在面板卡片里（connect-help.js 的 mismatchHelp）。 */
function versionMismatch(proxyVersion, panelV = panelVersion) {
    const side = mismatchSide(proxyVersion, panelV);
    if (!side) return null;
    return side === 'proxy'
        ? `CCST 服务 v${proxyVersion} 比面板 v${panelV} 旧，请更新`
        : `面板 v${panelV} 比服务 v${proxyVersion} 旧，请更新`;
}

// 审: 更新顶栏概览数字（额度、缓存）的快捷方式。
const glancePatch = (partial) => store.merge('glance', partial);

// ── Proxy status ──

// 审: 向代理问 /status 并写入 store：在线/未登录/被拒/离线，附带版本、运行方式、健康提示；面板没建好则跳过。
export async function refreshStatus() {
    if (!document.getElementById('claude_max_status_title') || !document.getElementById('claude_max_status_sub')) return;
    store.set({ status: { phase: 'pending' } });
    try {
        const res = await fetchProxy('/status', '/status');
        const data = await res.json().catch(() => ({}));
        if (res.status === 401 || res.status === 403) {
            // Reached the proxy, which turned us away (another device: the proxy is for its own computer)
            store.set({ proxyState: 'offline', status: { phase: 'denied', message: data.error?.message ?? `HTTP ${res.status}` } });
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
        store.set({ proxyState: 'offline', proxyOnline: false, status: { phase: 'offline' } });
    }
}

// ── Heartbeat: notice a dropped proxy and its return ──

// 审: 心跳间隔 20 秒。
const HEARTBEAT_MS = 20000;
// 审: 已经为「代理断了」弹过提示，恢复时才弹「已恢复」。
let heartbeatDown = false;

// 审(存疑): 首行 getSettings().enabled 自 6.1 起恒为 undefined（'enabled' 在 REMOVED_KEYS 里每次被删、defaultSettings 也没有），函数永远在首行返回，整个心跳（断线/恢复提示）实际从未生效；属 6.1 精简遗留 bug，修它会让心跳复活（行为变化），故未动，请主人定夺。
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

// 审: 启动心跳定时器（boot 调用）；因上一条存疑，目前每 20 秒空转。
export function startHeartbeat() {
    return setInterval(heartbeat, HEARTBEAT_MS);
}

// ── Quota meter ──

// 审: 额度请求的节流状态：上次请求时间、上游限流的禁问时间、是否在途、退避后的自动重试计时器。
let quotaAskedAt = 0;      // last time this panel actually asked the proxy
let quotaNotBefore = 0;    // upstream rate limit: no ask before this
let quotaInFlight = false;
let quotaTimer = null;

// 审: 读额度并更新顶栏与额度卡；每个面板至多 60 秒问一次（Anthropic 会限流），force 仅用于用户点刷新。
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

// 审: 读「本聊天上一轮」用量并写入 store，同时更新顶栏缓存数字。
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

// 审: 整页刷新用的用量读取：读完无论成败都更新「更新于」时间（refreshStats 只在成功时更新）。
// The quota is NOT fetched when the panel opens (Anthropic rate-limits it, and a fresh install has
// nothing to show): it is asked for after each reply and by the 刷新 button.
async function refreshStatsPage() {
    await refreshStats();
    store.set({ statsAt: Date.now() });
}

// ── Full refresh (drawer opened, 重新检测) ──
// Local renders (connect note, cache card, check-up) listen to `pulse`;
// the fetches start here.

// 审: 最新版本号的来源：GitHub main 的 package.json（一键安装装的就是它）。
// 最新版本：GitHub 上 main 的 package.json（一键安装装的就是它），6 小时查一次，记在本机
const LATEST_URL = 'https://raw.githubusercontent.com/kcgoofee-jpg/CCST/main/package.json';
// 审: 最新版本号在本机 localStorage 的缓存键，6 小时内不重复查。
const LATEST_KEY = 'claude_max_latest';
// 审: 查 GitHub 上的最新版本并写入 store（更新卡片用）；读缓存优先，连不上静默。
async function checkLatest(now = Date.now()) {
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

// 审: 整页刷新（开抽屉、点重新检测）：脉冲 + 状态 + 用量 + 额度 + 最新版本；boot/shell/状态页共用。
export function refreshAll() {
    store.set({ pulse: store.get().pulse + 1 });
    refreshStatus();
    refreshStatsPage();
    // The quota too (quota-gate keeps the 60 s gap): a 「点刷新」 placeholder was all 状态 showed before.
    refreshQuota();
    checkLatest();
}
