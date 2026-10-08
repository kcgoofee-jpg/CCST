// ──────────────────────────────────────────────
// Tab 状态: last-turn cache, the latest reply's reliable checks, quota, usage, diagnostics.
// Draws what core/live.js put in the store (quota, stats).
// ──────────────────────────────────────────────

import { store } from '../core/store.js';
import { libs } from '../core/libs.js';
import { normalizeEndpoint } from '../core/capabilities.js';
import { shortModel } from '../core/connection.js';
import { fetchProxy, proxyErrorText } from '../core/proxy.js';
import { el, note, iconButton, group, collapsible, stateLine, button } from '../core/dom.js';
import { notify } from '../core/notify.js';
import { refreshAll, refreshQuota, refreshStats } from '../core/live.js';
import { getSettings } from '../core/settings.js';
import { promptMutators } from '../core/inject.js';

/** What /status's self-checks say needs telling (#30, #36). Pure: the status
 *  block from the store plus the endpoint the panel is set to. */
export function statusAdvisories(status, endpoint) {
    const out = [];
    if (!status || status.phase !== 'online') return out;
    if (status.compat && status.compat.ok === false) {
        out.push({ tone: 'error', text: `组件过旧：缓存会失效，照文档重装 SDK（缺 ${status.compat.missing?.join('、') || '功能'}）` });
    }
    if (typeof status.foldStreak === 'number' && status.foldStreak > 3) {
        out.push({ tone: 'warn', text: `${status.foldStreak} 轮重写：多半是上一条的原因` });
    }
    // 走酒馆同源路由时，答复的可能是端口上另一个代理实例（#36）。
    const actual = status.via === 'plugin' ? status.endpoint : null;
    if (actual && endpoint && normalizeEndpoint(actual) !== normalizeEndpoint(endpoint)) {
        out.push({ tone: 'warn', text: `地址不对：设置是 ${endpoint}，实际是 ${actual}` });
    }
    const own = status.sharedBy;
    if (own && status.root && own.root !== status.root && own.version !== status.version) {
        out.push({ tone: 'warn', text: `有两份 CCST：关掉另一份（v${status.version}，${status.root}），重启酒馆` });
    }
    return out;
}

// Presets that make the model write its chain of thought INTO the reply
// (<thinking>…</thinking>) leave the native reasoning box empty, and ST's
// auto-parse only catches it when its prefix/suffix match those tags.
function checkInlineCot() {
    const tip = document.getElementById('claude_max_cot_tip');
    if (!tip) return;
    const chat = SillyTavern.getContext().chat ?? [];
    const last = [...chat].reverse().find((m) => !m.is_user && !m.is_system);
    const match = last?.mes?.match(/<(thinking|think|cot|analysis)\b[^>]*>/i);
    if (!match || last.extra?.reasoning) {
        tip.hidden = true;
        return;
    }
    const tag = match[1];
    tip.hidden = false;
    tip.replaceChildren(
        el('div', 'cm-note-title', '正文思考'),
        el('small', 'cm-hint', `「推理→自动解析」填 <${tag}>`),
    );
}

function renderAdvice(status) {
    const box = document.getElementById('claude_max_advice');
    if (!box) return;
    const lines = statusAdvisories(status, getSettings().endpoint);
    box.replaceChildren(...lines.map((l) => note(l.tone, l.text)));
    box.hidden = !lines.length;
}

export function init() {
    store.subscribe('quota', ({ quota }) => renderQuota(quota));
    store.subscribe('stats', ({ stats }) => renderStats(stats));
    // Every finished stats read (ok or not) is a moment to look at the latest reply for a written-out chain of thought.
    store.subscribe('stats', ({ stats }) => { if (stats.phase === 'ok' || stats.phase === 'error') checkInlineCot(); });
    store.subscribe('status', ({ status }) => renderAdvice(status));
    store.subscribe('statsAt', ({ statsAt }) => {
        const stamp = document.getElementById('claude_max_stats_time');
        if (stamp) stamp.textContent = `${new Date(statsAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })} 更新`;
    });
}

// ── Quota meter ──
/** What the quota shows until the first answer. */
function idleQuotaLine() {
    // Asked for on opening (live.js refreshAll); the group's own refresh icon forces it.
    return stateLine('empty', '读取中…');
}

const WINDOW_LABELS = {
    five_hour: '5 小时',
    seven_day: '7 天',
    seven_day_opus: '7 天 · Opus',
    seven_day_sonnet: '7 天 · Sonnet',
    seven_day_fable: '7 天 · Fable',
    seven_day_oauth_apps: '7 天 · 外部',
};

function formatReset(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay ? `${time} 重置` : `${d.getMonth() + 1}/${d.getDate()} ${time} 重置`;
}

/** The 5h / 7d windows: label + reset time on the left, percent on the right, the bar under them. */
const WINDOW_MS = { five_hour: 5 * 3600_000 };
const SEVEN_DAYS = 7 * 24 * 3600_000;

/**
 * How fast a window is being used up: the used share projected linearly to the reset.
 * warning when it would end at 90% or more, critical when it would run out first; nothing
 * under 10% used or too early in the window (a projection that early is noise). claude-hud's usage pace, plus the early-window guard.
 * @returns {{ level: 'normal'|'warning'|'critical', endPct: number, runOutMs: number|null } | null}
 */
export function usagePace(pct, resetsAt, windowMs, now = Date.now()) {
    if (pct == null || !resetsAt) return null;
    const left = resetsAt - now;
    if (!(left > 0) || left >= windowMs) return null;
    const elapsed = windowMs - left;
    // Too early to project: under 10% used, or under 15% of the window gone with less than half used
    // (7 days: 14% in the first 8 hours would read as 「两天后用完」).
    if (pct < 10 || (elapsed < 0.15 * windowMs && pct < 50)) return { level: 'normal', endPct: pct, runOutMs: null };
    const endPct = Math.round(pct * (windowMs / elapsed));
    const runOutMs = endPct > 100 ? Math.round(((100 - pct) / pct) * elapsed) : null;
    return { level: endPct > 100 ? 'critical' : endPct >= 90 ? 'warning' : 'normal', endPct, runOutMs };
}

const fmtDur = (ms) => {
    const m = Math.max(1, Math.round(ms / 60000));
    if (m < 60) return `${m} 分钟`;
    const h = Math.floor(m / 60);
    return h >= 24 ? `${Math.round(h / 24)} 天` : `${h} 小时${m % 60 ? ` ${m % 60} 分` : ''}`;
};

function renderQuota(quota) {
    const box = document.getElementById('claude_max_quota');
    if (!box) return;
    if (quota.phase === 'loading') {
        if (!box.childElementCount) box.replaceChildren(stateLine('loading', '读取中…'));
        box.classList.add('cm-loading');
        return;
    }
    box.classList.remove('cm-loading');
    if (quota.phase === 'idle') {
        // Not asked yet (the quota is read after each reply or by 刷新, never on opening).
        box.replaceChildren(idleQuotaLine());
        return;
    }
    if (quota.phase === 'error') {
        box.replaceChildren(stateLine('error', proxyErrorText('额度', quota.error), () => refreshQuota({ force: true })));
        return;
    }
    if (quota.phase !== 'ok') return;
    const data = quota.data;
    box.replaceChildren();
    if (data.unavailable === 'rate_limited') {
        // Nothing cached yet and Anthropic is limiting: count down to the automatic retry.
        const line = stateLine('empty', '');
        const hint = line.querySelector('small');
        const tick = () => {
            const left = Math.max(0, Math.ceil((data.retryAt - Date.now()) / 1000));
            hint.textContent = `暂时查不到，${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')} 后重试`;
            if (!hint.isConnected && timer) { clearInterval(timer); timer = null; }
        };
        let timer = setInterval(tick, 1000);
        tick();
        box.append(line);
        return;
    }
    if (!data.windows?.length) {
        box.append(stateLine('empty', '没有数据'));
        return;
    }
    for (const w of data.windows) {
        const pct = w.utilization !== null ? Math.round(w.utilization * 100) : null;
        const row = el('div', 'cm-qline');
        const bar = el('div', 'cm-quota-bar');
        const fill = el('div', 'cm-quota-fill');
        fill.style.width = `${Math.min(100, pct ?? 0)}%`;
        // Colour: the worse of how much is used and how fast it is going.
        const pace = usagePace(pct, w.resetsAt, WINDOW_MS[w.type] ?? SEVEN_DAYS);
        const level = (pct ?? 0) >= 90 || pace?.level === 'critical' ? 'critical' : (pct ?? 0) >= 75 || pace?.level === 'warning' ? 'warning' : '';
        if (level) fill.classList.add(level);
        bar.append(fill);
        const label = el('span', 'cm-qline-label', WINDOW_LABELS[w.type] ?? w.type);
        const reset = formatReset(w.resetsAt);
        if (reset) label.append(' ', el('small', 'cm-hint', reset));
        row.append(label, el('b', 'cm-qline-pct', pct !== null ? `${pct}%` : '–'), bar);
        box.append(row);
        if (pace?.level === 'critical' && pace.runOutMs != null) {
            box.append(el('small', 'cm-pace critical', `照这速度 ${fmtDur(pace.runOutMs)}后用完`));
        } else if (pace?.level === 'warning') {
            box.append(el('small', 'cm-pace warning', `照这速度会用到 ${pace.endPct}%`));
        }
    }
    if (data.stale && data.fetchedAt) {
        const mins = Math.max(1, Math.round((Date.now() - data.fetchedAt) / 60000));
        box.append(el('small', 'cm-hint', `${mins} 分钟前`));
    }
    if (data.extraUsage?.isEnabled) {
        box.append(el('small', 'cm-hint', `超额用量 ${data.extraUsage.usedCredits} / ${data.extraUsage.monthlyLimit} ${data.extraUsage.currency}`));
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

/** Today and the last 7 days side by side (one column when they are the same). Units live in the row
 *  labels so no cell needs more than a number: it reads at 375px without wrapping. */
function usageTable(today, week) {
    const cols = today.requests === week.requests ? [['今天 · 7 天', today]] : [['今天', today], ['7 天', week]];
    const table = el('table', 'cm-usage');
    const head = el('tr');
    head.append(el('th'), ...cols.map(([t]) => el('th', null, t)));
    table.append(head);
    const rows = [
        ['次数', (a) => String(a.requests)],
        ...(cols.some(([, a]) => a.failed) ? [['失败', (a) => String(a.failed ?? 0)]] : []),
        ['写回复', (a) => fmtK(a.outputTokens)],
        ['平均用时', (a) => fmtSec(a.avgDurationMs)],
        ['等首字', (a) => fmtSec(a.avgTtftMs)],
        ['缓存正常', (a) => fmtPct(a.cacheOkRate)],
        ['花在', (a) => quotaShares(a.quota).slice(0, 2).map((p) => `${p.label}${p.pct}%`).join(' ') || '–'],
    ];
    for (const [label, fn] of rows) {
        const tr = el('tr');
        tr.append(el('td', 'cm-hint', label), ...cols.map(([, a]) => el('td', null, a.requests ? fn(a) : '–')));
        table.append(tr);
    }
    return table;
}

const QUOTA_LABELS = { output: '写回复', write: '写缓存', read: '读缓存' };

/** The proxy's subscription-weighted parts (cache-diag.js quotaParts) as shares, biggest first; parts under 1% dropped. */
export function quotaShares(quota) {
    if (!quota) return [];
    const total = Object.values(quota).reduce((n, v) => n + (v || 0), 0);
    if (!total) return [];
    return Object.keys(QUOTA_LABELS)
        .map((key) => ({ key, label: QUOTA_LABELS[key], pct: Math.round((100 * (quota[key] || 0)) / total) }))
        .filter((p) => p.pct >= 1)
        .sort((x, y) => y.pct - x.pct);
}

/** A labelled bar: title and a value on top, coloured parts, a legend under it. parts: [key, share 0..1, legend text]. */
function meter(title, value, parts) {
    const box = el('div', 'cm-meter');
    const top = el('div', 'cm-meter-top');
    top.append(el('span', null, title), el('span', null, value));
    const bar = el('div', 'cm-meter-bar');
    const legend = el('div', 'cm-meter-legend');
    for (const [key, share, text] of parts) {
        if (share > 0) {
            const seg = el('span', `cm-seg-${key}`);
            seg.style.width = `${Math.max(2, share * 100)}%`;
            bar.append(seg);
        }
        const item = el('span');
        item.append(el('i', `cm-seg-${key}`), text);
        legend.append(item);
    }
    box.append(top, bar, legend);
    return box;
}

/** Output tokens per second while writing (after the first token), like claude-hud's speed; null when too short to mean anything. */
export function outputSpeed(e) {
    const ms = (e?.durationMs ?? 0) - (e?.ttftMs ?? 0);
    if (!e?.outputTokens || ms < 500) return null;
    return Math.round(e.outputTokens / (ms / 1000));
}

// Models with a 1M context of their own (no [1m] suffix needed).
const NATIVE_1M = /sonnet-5[-.]5/i;

/** How full the model's context window was: everything sent (input + cache read + write) against
 *  1M for a 1M-context model, else 200k. Colours at 70% / 85% (claude-hud's thresholds). */
export function contextUse(e) {
    const tokens = (e?.inputTokens ?? 0) + (e?.cacheReadTokens ?? 0) + (e?.cacheCreationTokens ?? 0);
    if (!tokens) return null;
    const size = /1m/i.test(String(e.model ?? '')) || NATIVE_1M.test(String(e.model ?? '')) ? 1_000_000 : 200_000;
    const pct = Math.min(100, Math.round((tokens / size) * 100));
    return { tokens, size, pct, level: pct >= 85 ? 'critical' : pct >= 70 ? 'warning' : '' };
}

/** The last turn: one word for the cache, one line why, what was sent, what it cost; the rest in 详情. */
function lastTurnCard(data) {
    const c = data.lastCache;
    const last = data.lastRequest;
    const card = el('div', 'cm-cache');
    card.dataset.state = c.state;
    const head = el('div', 'cm-cache-head');
    head.append(el('span', 'cm-cache-dot'), el('b', null, c.title));
    if (last?.durationMs) head.append(el('span', 'cm-cache-meta', fmtSec(last.durationMs)));
    card.append(head, el('small', 'cm-cache-sub', c.reasons[0] ?? ''));
    const fresh = c.wrote + (last?.inputTokens ?? 0);
    const sent = c.read + fresh;
    if (sent) {
        card.append(meter('这轮发出的内容', fmtK(sent), [
            ['read', c.read / sent, `读缓存 ${fmtK(c.read)}`],
            ['write', fresh / sent, `新写入 ${fmtK(fresh)}`],
        ]));
    }
    const shares = quotaShares(c.quota);
    if (shares.length) {
        const pct = Object.fromEntries(shares.map((p) => [p.key, p.pct]));
        card.append(meter('额度花在', `大头：${shares[0].label}`, ['output', 'write', 'read'].map((key) => [key, (pct[key] ?? 0) / 100, `${QUOTA_LABELS[key]} ${pct[key] ?? 0}%`])));
        if (shares[0].key === 'output') card.append(el('small', 'cm-cache-tip', '思维链和正文越长越费'));
    }
    const more = el('details', 'cm-mini');
    more.append(el('summary', null, '详情'));
    if (last) {
        const speed = outputSpeed(last);
        more.append(el('small', 'cm-hint', `用时 ${fmtSec(last.durationMs)}${speed ? ` · 每秒 ${speed}` : ''}`));
        const ctx = contextUse(last);
        if (ctx) more.append(el('small', `cm-hint cm-ctx ${ctx.level}`, `上下文 ${ctx.pct}%（${fmtK(ctx.tokens)} / ${fmtK(ctx.size)}）${ctx.level === 'critical' ? '：快满了，早期内容会丢' : ''}`));
        const ph = last.phases;
        const sec = (v) => (v / 1000).toFixed(1);
        if (ph?.init && ph.firstDelta) more.append(el('small', 'cm-hint', `等首字 ${sec(ph.firstDelta)} 秒：本机 ${sec(ph.init)}，Claude ${sec(ph.firstDelta - ph.init)}`));
    }
    for (const r of c.reasons.slice(1)) more.append(el('small', 'cm-hint', r));
    card.append(more);
    // Critical context goes on the card itself, not only in 详情.
    const ctx = last && contextUse(last);
    if (ctx?.level === 'critical') card.append(el('small', 'cm-hint cm-ctx critical', `上下文 ${ctx.pct}%：快满了，早期内容会丢`));
    return card;
}

/** The last turn's card and the 7-day table. */
function renderStats(stats) {
    const box = document.getElementById('claude_max_stats');
    if (!box) return;
    const lastBox = document.getElementById('claude_max_lastturn');
    if (stats.phase === 'loading') {
        if (!box.childElementCount) box.replaceChildren(stateLine('loading', '读取中…'));
        if (lastBox && !lastBox.childElementCount) lastBox.replaceChildren(stateLine('loading', '读取中…'));
        box.classList.add('cm-loading');
        return;
    }
    box.classList.remove('cm-loading');
    if (stats.phase === 'error') {
        const msg = proxyErrorText('用量统计', stats.error);
        box.replaceChildren(stateLine('error', msg, refreshStats));
        lastBox?.replaceChildren(stateLine('error', msg, refreshStats));
        return;
    }
    if (stats.phase !== 'ok') return;
    const data = stats.data;
    lastBox?.replaceChildren(data.lastCache ? lastTurnCard(data)
        : stateLine('empty', data.lastRequest ? '上一轮失败，原因在「用量」' : '还没有回复'));
    box.replaceChildren();
    const sum = document.getElementById('claude_max_usage_sum');
    if (sum) sum.textContent = data.week?.requests ? `7 天 ${data.week.requests} 次` : '7 天没用过';
    if (!data.week?.requests) {
        box.append(stateLine('empty', '还没有记录，不记聊天内容'));
    } else {
        box.append(usageTable(data.today, data.week));
        const rr = data.today.rerolls || data.week.rerolls;
        if (rr) box.append(el('small', 'cm-hint', `不含重新生成的 ${data.week.rerolls ?? 0} 次`));
    }
    const bg = data.background;
    if (bg?.week?.requests) {
        box.append(el('small', 'cm-hint', `后台：今天 ${bg.today.requests} 次，7 天 ${bg.week.requests} 次${bg.week.failed ? `，失败 ${bg.week.failed} 次` : ''}`));
    }
    // Only surface a failure from the last day; older ones are noise.
    if (data.lastError && Date.now() - data.lastError.at < 24 * 3600 * 1000) {
        const err = note('error', `上次失败 · ${fmtWhen(data.lastError.at)}${data.lastError.background ? ' · 后台' : ''}`);
        err.append(el('small', null, data.lastError.message));
        const more = el('details', 'cm-mini');
        more.append(el('summary', null, '怎么办'),
            el('small', 'cm-hint', data.lastError.hint),
            el('small', 'cm-hint cm-raw', data.lastError.raw));
        err.append(more);
        box.append(err);
    }
}

/** Tab 状态: last turn first, then the latest reply's problems, quota, usage, diagnostics. */
export function buildStatusTab(pane) {
    // 代理自检结果（SDK 兼容性、逐轮还原、实际地址）；没有问题时不显示。
    const adviceBox = el('div', 'cm-stats');
    adviceBox.id = 'claude_max_advice';
    adviceBox.hidden = true;
    pane.append(adviceBox);
    const cotTip = note('warn');
    cotTip.id = 'claude_max_cot_tip';
    cotTip.hidden = true;
    pane.append(cotTip);

    const stamp = el('small', 'cm-hint');
    stamp.id = 'claude_max_stats_time';
    const tools = el('div', 'cm-section-tools');
    tools.append(stamp, iconButton('fa-rotate', '刷新', refreshAll));
    const last = group('上一轮', { tools });
    const lastBox = el('div', 'cm-stats');
    lastBox.id = 'claude_max_lastturn';
    lastBox.append(stateLine('empty', '还没有回复'));
    last.body.append(lastBox);
    pane.append(last.root);

    // 最新回复: only the reliable checks (refusal / cut off / empty), one line each; hidden when none.
    const latest = group('回复问题', { id: 'claude_max_latest_sec' });
    latest.root.hidden = true;
    const latestBox = el('div', 'cm-stats');
    latestBox.id = 'claude_max_latest';
    latest.body.append(latestBox);
    pane.append(latest.root);

    const quota = group('额度', {
        id: 'claude_max_quota_sec',
        tools: iconButton('fa-rotate', '刷新', () => refreshQuota({ force: true })),
    });
    const quotaBox = el('div', 'cm-quota');
    quotaBox.id = 'claude_max_quota';
    quotaBox.append(idleQuotaLine());
    quota.body.append(quotaBox);
    pane.append(quota.root);

    // Folded by default: the table is long. The folded header carries the one number most people look for.
    const usage = collapsible('用量', '近 7 天', { id: 'claude_max_usage' });
    usage.root.querySelector('.cm-fold-desc').id = 'claude_max_usage_sum';
    const statsBox = el('div', 'cm-stats');
    statsBox.id = 'claude_max_stats';
    statsBox.append(stateLine('loading', '读取中…'));
    usage.body.append(statsBox);
    pane.append(usage.root);

    pane.append(buildDiagGroup());
}

// ── 诊断：导出给维护者的文件 ──
// The proxy's half (diag-report.js: versions, usage records, proxy log, what the CLI really sent)
// plus what only the browser knows: SillyTavern's version, the connection's prompt post-processing,
// the preset, the extensions that can change the prompt. The raw data holds chat text.

/** SillyTavern-side facts for the report (each one best-effort). */
export async function clientSection(ctx = SillyTavern.getContext()) {
    const lines = ['## 酒馆这边'];
    const safe = async (label, fn) => {
        try { const v = await fn(); if (v !== undefined && v !== null && v !== '') lines.push(`${label}：${v}`); } catch { /* skip */ }
    };
    await safe('酒馆版本', async () => {
        const r = await fetch('/version');
        const v = await r.json();
        return [v.pkgVersion, v.gitBranch, v.gitRevision].filter(Boolean).join(' ');
    });
    const cs = ctx.chatCompletionSettings ?? {};
    await safe('来源', () => cs.chat_completion_source);
    await safe('地址', () => { try { const u = new URL(cs.custom_url); return `${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}${u.pathname}`; } catch { return cs.custom_url ? '(无法解析)' : ''; } });
    await safe('模型', () => cs.custom_model || cs.claude_model || cs.openrouter_model);
    await safe('预设', () => cs.preset_settings_openai);
    await safe('提示词后处理', () => cs.custom_prompt_post_processing || '无');
    await safe('上下文 / 最大回复', () => `${cs.openai_max_context} / ${cs.openai_max_tokens}`);
    await safe('流式 / 显示思维 / 推理强度', () => `${cs.stream_openai} / ${cs.show_thoughts} / ${cs.reasoning_effort ?? '-'}`);
    await safe('附加请求体（不含 CCST 那段）', () => {
        const extra = String(cs.custom_include_body ?? '').replace(/^claude_subscription:[\s\S]*?(?=^\S|\s*$(?![\s\S]))/m, '').trim();
        return extra ? `${extra.length} 字` : '无';
    });
    await safe('聊天楼层数', () => ctx.chat?.length);
    await safe('角色卡', () => ctx.characters?.[ctx.characterId]?.name);
    // Scripts / depth regexes that can rewrite the prompt by themselves (Izumi's 悬浮窗 …).
    await safe('会在发送时改提示词的脚本 / 正则', () => promptMutators(ctx).join('、') || '无');
    await safe('扩展', async () => {
        const r = await fetch('/api/extensions/discover', { method: 'POST', headers: ctx.getRequestHeaders?.() ?? {} });
        const list = await r.json();
        const disabled = new Set(ctx.extensionSettings?.disabledExtensions ?? []);
        return list.filter((e) => e.type !== 'system').map((e) => `${e.name.replace(/^third-party\//, '')}${disabled.has(e.name) ? '(停用)' : ''}`).join(', ');
    });
    await safe('面板设置', () => {
        const { presetRecoRecord, ...rest } = getSettings();
        return JSON.stringify(rest);
    });
    return lines.join('\n');
}

async function proxyText(path, direct) {
    const r = await fetchProxy(path, direct);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r;
}

function buildDiagGroup() {
    const g = group('反馈');
    // One file with everything: the readable report first, then the raw data (captured requests, last full
    // request). Users send the file instead of pasting a wall of text into a chat box.
    const save = button('导出日志', async () => {
        save.disabled = true;
        try {
            const [report, full] = await Promise.all([
                proxyText('/diag/report', '/v1/diag/report').then((r) => r.text()),
                proxyText('/diag/full', '/v1/diag/full').then((r) => r.json()),
            ]);
            const stamp = new Date();
            const text = `# CCST 诊断报告 ${stamp.toLocaleString()}\n\n${await clientSection()}\n\n${report}\n\n## 原始数据\n\n${JSON.stringify({ ...full, report: undefined }, null, 1)}\n`;
            const a = el('a');
            a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
            a.download = `ccst-诊断-${stamp.getMonth() + 1}${String(stamp.getDate()).padStart(2, '0')}-${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}.txt`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 10000);
            notify('ok', '已下载', '含聊天原文，别公开发', { ms: 10000 });
        } catch (err) {
            notify('warn', '导出失败', proxyErrorText('日志', err) ?? String(err?.message ?? err));
        } finally {
            save.disabled = false;
        }
    }, { icon: 'fa-download', primary: true });
    save.title = '出问题时私发给作者';
    g.body.append(save);
    return g.root;
}
