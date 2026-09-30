// ──────────────────────────────────────────────
// Tab 状态: last-turn cache, quota, usage, world-info cache tool.
// Draws what core/live.js put in the store (quota, stats).
// ──────────────────────────────────────────────

import { store } from '../core/store.js';
import { libs } from '../core/libs.js';
import { IS_TAURI } from '../core/capabilities.js';
import { connectionInfo, shortModel } from '../core/connection.js';
import { proxyErrorText } from '../core/proxy.js';
import { el, note, iconButton, section } from '../core/dom.js';
import { notify } from '../core/notify.js';
import { refreshStatsPage } from '../core/live.js';

export function init() {
    store.subscribe('quota', ({ quota }) => renderQuota(quota));
    store.subscribe('stats', ({ stats }) => renderStats(stats));
    store.subscribe('statsAt', ({ statsAt }) => {
        const stamp = document.getElementById('claude_max_stats_time');
        if (stamp) stamp.textContent = `更新于 ${new Date(statsAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
    });
    store.subscribe('pulse', () => renderCacheCard());
}

// ── Quota meter ──

const WINDOW_LABELS = {
    five_hour: '5 小时窗口',
    seven_day: '7 天 · 全部模型',
    seven_day_opus: '7 天 · Opus',
    seven_day_sonnet: '7 天 · Sonnet',
    seven_day_fable: '7 天 · Fable',
    seven_day_oauth_apps: '7 天 · 第三方应用',
};

function formatReset(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay ? `${time} 重置` : `${d.getMonth() + 1}/${d.getDate()} ${time} 重置`;
}

/** The 5h / 7d windows: one line each — label · bar · percent · reset time. */
function renderQuota(quota) {
    const box = document.getElementById('claude_max_quota');
    if (!box) return;
    if (quota.phase === 'loading') { box.classList.add('cm-loading'); return; }
    box.classList.remove('cm-loading');
    if (quota.phase === 'error') {
        box.replaceChildren(el('small', 'cm-hint', proxyErrorText('额度', quota.error)));
        return;
    }
    if (quota.phase !== 'ok') return;
    const data = quota.data;
    box.replaceChildren();
    // API-type backends bill per token: no 5h / 7d windows to show.
    const quotaSec = document.getElementById('claude_max_quota_sec');
    if (quotaSec) quotaSec.hidden = !!data.notSubscription;
    box.hidden = !!data.notSubscription;
    if (data.notSubscription) return;
    if (!data.windows?.length) {
        box.append(el('small', 'cm-hint', '暂无额度数据'));
        return;
    }
    // One line per window: label · bar · percent · reset time.
    for (const w of data.windows) {
        const pct = w.utilization !== null ? Math.round(w.utilization * 100) : null;
        const row = el('div', 'cm-qline');
        const bar = el('div', 'cm-quota-bar');
        const fill = el('div', 'cm-quota-fill');
        fill.style.width = `${Math.min(100, pct ?? 0)}%`;
        if ((pct ?? 0) >= 90) fill.classList.add('critical');
        else if ((pct ?? 0) >= 70) fill.classList.add('warning');
        bar.append(fill);
        const reset = formatReset(w.resetsAt);
        row.title = reset;
        row.append(
            el('span', 'cm-qline-label', WINDOW_LABELS[w.type] ?? w.type),
            bar,
            el('b', 'cm-qline-pct', pct !== null ? `${pct}%` : '–'),
            el('small', 'cm-hint cm-qline-reset', reset.replace(' 重置', '')),
        );
        box.append(row);
    }
    if (data.extraUsage?.isEnabled) {
        box.append(el('small', 'cm-hint',
            `额外用量：${data.extraUsage.usedCredits} / ${data.extraUsage.monthlyLimit} ${data.extraUsage.currency}`));
    }
}

// ── Usage stats ──

const fmtK = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0));
const fmtSec = (ms) => (ms == null ? '–' : ms >= 60000 ? `${Math.floor(ms / 60000)}分${Math.round((ms % 60000) / 1000)}秒` : `${(ms / 1000).toFixed(1)}秒`);
const fmtPct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
const fmtWhen = (ts) => {
    const d = new Date(ts);
    const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    return d.toDateString() === new Date().toDateString() ? `今天 ${time}` : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
};

/** Today and the last 7 days side by side (one column when they are the same). */
function usageTable(today, week) {
    const cols = today.requests === week.requests ? [['今天 · 近 7 天', today]] : [['今天', today], ['近 7 天', week]];
    const table = el('table', 'cm-usage');
    const head = el('tr');
    head.append(el('th'), ...cols.map(([t]) => el('th', null, t)));
    table.append(head);
    const rows = [
        ['请求', (a) => (a.failed ? `${a.requests}（失败 ${a.failed}）` : String(a.requests))],
        ['输出', (a) => `${fmtK(a.outputTokens)} token`],
        ['平均耗时', (a) => fmtSec(a.avgDurationMs)],
        ['首字等待', (a) => fmtSec(a.avgTtftMs)],
        ['缓存命中', (a) => fmtPct(a.cacheHitRate) + (a.rerolls ? `（不含重roll ${a.rerolls} 次）` : '')],
    ];
    for (const [label, fn] of rows) {
        const tr = el('tr');
        tr.append(el('td', 'cm-hint', label), ...cols.map(([, a]) => el('td', null, a.requests ? fn(a) : '–')));
        table.append(tr);
    }
    return table;
}

/** 近 7 天按后端：次数、token，API 类后端加估算花费。Only shown once
 *  something other than the subscription was used. */
function backendUsageLine(backends, pricesAsOf) {
    const list = Object.entries(backends ?? {});
    if (!list.length || (list.length === 1 && list[0][0] === 'subscription')) return null;
    const parts = list.map(([, b]) => `${b.label} ${b.requests} 次 · 输出 ${fmtK(b.outputTokens)}${b.costUsd != null ? ` · 约 $${b.costUsd.toFixed(2)}` : ''}`);
    const hasCost = list.some(([, b]) => b.costUsd != null);
    return el('small', 'cm-hint', `按后端（近 7 天）：${parts.join('；')}${hasCost ? `。花费为估算：token 数 × Anthropic 官方价（${pricesAsOf ?? ''}），以账单为准。` : ''}`);
}

/** The last turn: cache headline, why, where the first-token wait went. */
function lastTurnCard(data) {
    const c = data.lastCache;
    const last = data.lastRequest;
    const card = note(c.hitPct >= 50 ? 'ok' : 'warn', `缓存 · ${c.headline}`);
    if (last) {
        card.append(el('small', 'cm-hint',
            `${shortModel(last.model)} · 用时 ${fmtSec(last.durationMs)} · 输出 ${fmtK(last.outputTokens)} token`));
    }
    if (last?.finish === 'content_filter') {
        card.append(el('small', 'cm-hint cm-warn', '被安全机制中途截断，结尾缺内容（变量、状态栏可能报错）。重新生成，或回退一楼换个说法。'));
    } else if (last?.finish === 'length') {
        card.append(el('small', 'cm-hint cm-warn', '写到最大长度被截断：调高酒馆的「最大回复长度」。'));
    }
    // The first reason is the conclusion; everything else is detail.
    const [first, ...rest] = c.reasons;
    if (first) card.append(el('small', 'cm-hint cm-cache-reason', first));
    const ph = last?.phases;
    const sec = (v) => (v / 1000).toFixed(1);
    if (rest.length || (ph?.init && ph.firstDelta)) {
        const more = el('details', 'cm-mini');
        more.append(el('summary', null, '详情'));
        for (const r of rest) more.append(el('small', 'cm-hint cm-cache-reason', r));
        if (ph?.init && ph.firstDelta) {
            more.append(el('small', 'cm-hint', `首字 ${sec(ph.firstDelta)} 秒：代理和 CLI 启动 ${sec(ph.init)} 秒（本机）；模型读完提示词开始回复 ${sec((ph.apiStart ?? ph.firstDelta) - ph.init)} 秒，开始写 ${sec(ph.firstDelta - (ph.apiStart ?? ph.firstDelta))} 秒（Anthropic 那边）。`));
        }
        card.append(more);
    }
    return card;
}

/** The last turn's card and the 7-day table. */
function renderStats(stats) {
    const box = document.getElementById('claude_max_stats');
    if (!box) return;
    if (stats.phase === 'loading') { box.classList.add('cm-loading'); return; }
    box.classList.remove('cm-loading');
    if (stats.phase === 'error') {
        box.replaceChildren(el('small', 'cm-hint', proxyErrorText('用量统计', stats.error)));
        return;
    }
    if (stats.phase !== 'ok') return;
    const data = stats.data;
    const lastBox = document.getElementById('claude_max_lastturn');
    lastBox?.replaceChildren(data.lastCache ? lastTurnCard(data) : el('small', 'cm-hint', '还没有对话。'));
    box.replaceChildren();
    if (!data.week?.requests) {
        box.append(el('small', 'cm-hint', '还没有记录（只记耗时和 token，不记内容）。'));
    } else {
        box.append(usageTable(data.today, data.week));
        const byBackend = backendUsageLine(data.week.backends, data.pricesAsOf);
        if (byBackend) box.append(byBackend);
    }
    const bg = data.background;
    if (bg?.week?.requests) {
        box.append(el('small', 'cm-hint', `后台请求（不计入上表）：今天 ${bg.today.requests} 次，近 7 天 ${bg.week.requests} 次、输出 ${fmtK(bg.week.outputTokens)} token${bg.week.failed ? `、失败 ${bg.week.failed} 次` : ''}。`));
    }
    // Only surface a failure from the last day; older ones are noise.
    if (data.lastError && Date.now() - data.lastError.at < 24 * 3600 * 1000) {
        const err = note('error', `最近失败 · ${fmtWhen(data.lastError.at)} · ${shortModel(data.lastError.model)}${data.lastError.background ? ' · 后台' : ''}`);
        err.append(el('small', null, data.lastError.message));
        const more = el('details', 'cm-mini');
        more.append(el('summary', null, '怎么办 · 原始错误'),
            el('small', 'cm-hint', data.lastError.hint),
            el('small', 'cm-hint cm-raw', data.lastError.raw));
        err.append(more);
        box.append(err);
    }
}

/** Tab 状态: last-turn cache, quota, usage, world-info cache tool. */
export function buildStatusTab(pane) {
    const stamp = el('small', 'cm-hint');
    stamp.id = 'claude_max_stats_time';
    const tools = el('div', 'cm-section-tools');
    tools.append(stamp, iconButton('fa-rotate', '刷新', refreshStatsPage));
    pane.append(section('上一轮', tools));
    const lastBox = el('div', 'cm-stats');
    lastBox.id = 'claude_max_lastturn';
    pane.append(lastBox);

    pane.append(section('缓存'));
    const cacheBox = el('div', 'cm-field');
    cacheBox.id = 'claude_max_cache';
    pane.append(cacheBox);

    const quotaHead = section('订阅额度');
    quotaHead.id = 'claude_max_quota_sec';
    pane.append(quotaHead);
    const quotaBox = el('div', 'cm-quota');
    quotaBox.id = 'claude_max_quota';
    quotaBox.append(el('small', 'cm-hint', '加载中…'));
    pane.append(quotaBox);

    pane.append(section('用量'));
    const statsBox = el('div', 'cm-stats');
    statsBox.id = 'claude_max_stats';
    statsBox.append(el('small', 'cm-hint', '加载中…'));
    pane.append(statsBox);

    pane.append(section('世界书缓存'));
    const loreBox = el('div', 'cm-field');
    loreBox.id = 'claude_max_lore';
    pane.append(loreBox);
}

/** 状态 → 缓存: how this source caches. Direct sources: SillyTavern's own settings, which
 *  live in its config.yaml (read at start-up) — shown with a copy button, not applied. */
export function renderCacheCard() {
    const box = document.getElementById('claude_max_cache');
    if (!box) return;
    const { connected, direct, kind, where } = connectionInfo();
    if (connected) {
        box.replaceChildren(el('small', 'cm-hint', '走本机代理：缓存由代理排布，命中情况看上面「上一轮」。'));
        return;
    }
    if (!direct) {
        box.replaceChildren(el('small', 'cm-hint', '酒馆现在没在用 Claude。'));
        return;
    }
    if (!libs.sources) {
        box.replaceChildren(el('small', 'cm-hint', '没加载（扩展文件不完整），重装扩展即可。'));
        return;
    }
    const advice = libs.sources.cacheAdvice(kind);
    const card = note(advice.tone, `${where} · 酒馆自带缓存`);
    for (const line of advice.lines) card.append(el('small', 'cm-hint', line));
    if (advice.yaml) {
        card.append(el('pre', 'cm-log', advice.yaml));
        const copy = el('div', 'menu_button', '复制这段');
        copy.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(advice.yaml);
                notify('ok', '已复制', '粘到酒馆目录的 config.yaml（替换原来的 claude: 段里对应几行），再重启酒馆。', { ms: 8000 });
            } catch {
                notify('warn', '复制不了', '手动照着上面改 config.yaml。');
            }
        });
        const row = el('div', 'cm-btn-row');
        row.append(copy);
        card.append(row);
        if (IS_TAURI) card.append(el('small', 'cm-hint', 'TauriTavern 不是酒馆的 Node 服务器，config.yaml 这几项它认不认要看 TauriTavern 自己。'));
    }
    card.append(el('small', 'cm-hint', '上一轮命中没有：酒馆不把缓存用量传给页面，面板看不到；到 Anthropic / OpenRouter 后台的用量记录里看。'));
    box.replaceChildren(card);
}
