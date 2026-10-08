// ──────────────────────────────────────────────
// Tab 状态: last-turn cache, the latest reply's reliable checks, quota, usage, diagnostics.
// Draws what core/live.js put in the store (quota, stats).
// ──────────────────────────────────────────────

import { store } from '../core/store.js';
import { normalizeEndpoint } from '../core/capabilities.js';
import { fetchProxy, proxyErrorText } from '../core/proxy.js';
import { el, note, iconButton, group, collapsible, stateLine, button } from '../core/dom.js';
import { notify } from '../core/notify.js';
import { refreshAll, refreshQuota, refreshStats } from '../core/live.js';
import { getSettings } from '../core/settings.js';
import { promptMutators } from '../core/inject.js';

// 审: 代理自检结果 → 面板提醒文案（纯函数，测试直接调）；没了 SDK 过旧/地址不对/双份 CCST 都无人提醒。
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

// 审: 最新回复里带了正文思考标签却没进推理框时，提示用户去填「推理→自动解析」。
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

// 审: 把 statusAdvisories 的结果画进状态页顶部的提醒框。
function renderAdvice(status) {
    const box = document.getElementById('claude_max_advice');
    if (!box) return;
    const lines = statusAdvisories(status, getSettings().endpoint);
    box.replaceChildren(...lines.map((l) => note(l.tone, l.text)));
    box.hidden = !lines.length;
}

// 审: 状态页自己的 store 订阅（额度、统计、更新时间、提醒）；boot.js 调用。
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
// 审: 额度第一次读到之前显示的占位行（建 DOM 与 idle 阶段共用）。
/** What the quota shows until the first answer. */
function idleQuotaLine() {
    // Asked for on opening (live.js refreshAll); the group's own refresh icon forces it.
    return stateLine('empty', '读取中…');
}

// 审: 额度窗口类型 → 中文名；类型来自代理 oauth.js，未知的原样显示。
const WINDOW_LABELS = {
    five_hour: '5 小时',
    seven_day: '7 天',
    seven_day_opus: '7 天 · Opus',
    seven_day_sonnet: '7 天 · Sonnet',
    seven_day_fable: '7 天 · Fable',
    seven_day_oauth_apps: '7 天 · 外部',
};

// 审: 把额度重置时间格式化成「HH:MM 重置」或「月/日 HH:MM 重置」。
function formatReset(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay ? `${time} 重置` : `${d.getMonth() + 1}/${d.getDate()} ${time} 重置`;
}

// 审: 各窗口时长（毫秒），用量节奏要拿它算；没列出的类型按 7 天算。
/** The 5h / 7d windows: label + reset time on the left, percent on the right, the bar under them. */
const WINDOW_MS = { five_hour: 5 * 3600_000 };
const SEVEN_DAYS = 7 * 24 * 3600_000;

/**
 * How fast a window is being used up: the used share projected linearly to the reset.
 * warning when it would end at 90% or more, critical when it would run out first; nothing
 * under 10% used or too early in the window (a projection that early is noise). claude-hud's usage pace, plus the early-window guard.
 * @returns {{ level: 'normal'|'warning'|'critical', endPct: number, runOutMs: number|null } | null}
 */
// 审: 用量节奏：按已用比例线性外推到重置时刻，判断会不会提前用完（tests 引用，状态栏的 ▲ 也靠它）。
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

// 审: 把毫秒格式化成「N 分钟/N 天/N 小时 M 分」，只给「照这速度…后用完」用。
const fmtDur = (ms) => {
    const m = Math.max(1, Math.round(ms / 60000));
    if (m < 60) return `${m} 分钟`;
    const h = Math.floor(m / 60);
    return h >= 24 ? `${Math.round(h / 24)} 天` : `${h} 小时${m % 60 ? ` ${m % 60} 分` : ''}`;
};

// 审: 画额度区（加载中/出错/限流倒计时/各窗口进度条/超额用量）。
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

// 审: 用量表与卡片共用的小格式化器：token 数、秒数、百分比、时间点。
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
// 审: 今天/7 天并排的用量表；两列相同时合并成一列。
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

// 审: 额度三部分（写回复/写缓存/读缓存）的中文名与顺序。
const QUOTA_LABELS = { output: '写回复', write: '写缓存', read: '读缓存' };

/** The proxy's subscription-weighted parts (cache-diag.js quotaParts) as shares, biggest first; parts under 1% dropped. */
// 审: 把订阅加权额度拆成份额，最大的在前、不足 1% 的丢掉（tests 引用）。
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
// 审: 带标题的分段条 + 图例，「这轮发出的内容」和「额度花在」共用。
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
// 审: 输出速度（token/秒，不含首字等待）；太短返回 null（tests 引用）。
export function outputSpeed(e) {
    const ms = (e?.durationMs ?? 0) - (e?.ttftMs ?? 0);
    if (!e?.outputTokens || ms < 500) return null;
    return Math.round(e.outputTokens / (ms / 1000));
}

// Models with a 1M context of their own (no [1m] suffix needed).
// 审: 自带 1M 上下文的模型（名字里没有 [1m]），算上下文占用时按 1M 计。
const NATIVE_1M = /sonnet-5[-.]5/i;

/** How full the model's context window was: everything sent (input + cache read + write) against
 *  1M for a 1M-context model, else 200k. Colours at 70% / 85% (claude-hud's thresholds). */
// 审: 上一轮上下文占用百分比与警戒级别（tests 引用）。
export function contextUse(e) {
    const tokens = (e?.inputTokens ?? 0) + (e?.cacheReadTokens ?? 0) + (e?.cacheCreationTokens ?? 0);
    if (!tokens) return null;
    const size = /1m/i.test(String(e.model ?? '')) || NATIVE_1M.test(String(e.model ?? '')) ? 1_000_000 : 200_000;
    const pct = Math.min(100, Math.round((tokens / size) * 100));
    return { tokens, size, pct, level: pct >= 85 ? 'critical' : pct >= 70 ? 'warning' : '' };
}

/** The last turn: one word for the cache, one line why, what was sent, what it cost; the rest in 详情. */
// 审: 「上一轮」卡片：缓存状态一个词、原因一行、发出内容与额度去向、详情折叠。
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
// 审: 画「上一轮」卡与用量表（加载/出错/空/正常，含后台请求行和最近一天内的失败）。
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
// 审: 建状态页各分区的空壳（提醒、正文思考、上一轮、回复问题、额度、用量、反馈），之后由订阅填内容；shell.js 调用。
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

// 审: 诊断报告里「酒馆这边」那段（浏览器才知道的事实），逐项尽力而为、失败就跳过。
/** SillyTavern-side facts for the report (each one best-effort). */
async function clientSection(ctx = SillyTavern.getContext()) {
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

// 审: 请求代理文本接口，非 2xx 抛错（导出日志用）。
async function proxyText(path, direct) {
    const r = await fetchProxy(path, direct);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r;
}

// 审: 「反馈」分区：唯一的「导出日志」按钮（报告 + 原始数据一个文件）。
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
