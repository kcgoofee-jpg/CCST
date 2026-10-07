// ──────────────────────────────────────────────
// Tab 状态: last-turn cache, the latest reply's reliable checks, quota, usage, the world-info cache
// tool (only when it has something to do), diagnostics.
// Draws what core/live.js put in the store (quota, stats).
// ──────────────────────────────────────────────

import { store } from '../core/store.js';
import { libs } from '../core/libs.js';
import { normalizeEndpoint } from '../core/capabilities.js';
import { shortModel } from '../core/connection.js';
import { fetchProxy, proxyErrorText } from '../core/proxy.js';
import { el, note, iconButton, group, collapsible, stateLine, button, toggleRow } from '../core/dom.js';
import { notify } from '../core/notify.js';
import { copyText } from '../core/external.js';
import { refreshAll, refreshQuota, refreshStats } from '../core/live.js';
import { getSettings, saveSettingsDebounced } from '../core/settings.js';
import { promptMutators } from '../core/inject.js';

/** What /status's self-checks say needs telling (#30, #36). Pure: the status
 *  block from the store plus the endpoint the panel is set to. */
export function statusAdvisories(status, endpoint) {
    const out = [];
    if (!status || status.phase !== 'online') return out;
    if (status.compat && status.compat.ok === false) {
        out.push({ tone: 'error', text: `当前 SDK 版本与代理不兼容（没有 ${status.compat.missing?.join('、') || '要用的功能'}），对话能连通但缓存和逐轮还原多半不对。请在 CCST 文件夹里运行 npm install @anthropic-ai/claude-agent-sdk@文档指定的版本 --save-exact，然后重启代理。` });
    }
    if (typeof status.foldStreak === 'number' && status.foldStreak > 3) {
        out.push({ tone: 'warn', text: `连续 ${status.foldStreak} 轮没能逐轮还原，整段折叠发送：每轮都在重写缓存，慢和耗额度都偏高。通常跟着上面一条 SDK 问题一起出现。` });
    }
    // 走酒馆同源路由时，答复的可能是端口上另一个代理实例（#36）。
    const actual = status.via === 'plugin' ? status.endpoint : null;
    if (actual && endpoint && normalizeEndpoint(actual) !== normalizeEndpoint(endpoint)) {
        out.push({ tone: 'warn', text: `代理实际地址与面板设置不一致：设置里是 ${endpoint}，应答的这个代理在 ${actual}。请把面板端点改成实际地址，或确认 8901 上没有另一个代理。` });
    }
    const own = status.sharedBy;
    if (own && status.root && own.root !== status.root && own.version !== status.version) {
        out.push({ tone: 'warn', text: `在聊天的是另一份 CCST v${status.version}（${status.root}），不是这个酒馆装的 v${own.version}。关掉它（另一个酒馆，或旧的单独代理），再重启这个酒馆。` });
    }
    return out;
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
    store.subscribe('status', ({ status }) => renderAdvice(status));
    store.subscribe('statsAt', ({ statsAt }) => {
        const stamp = document.getElementById('claude_max_stats_time');
        if (stamp) stamp.textContent = `更新于 ${new Date(statsAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
    });
}

// ── Quota meter ──
/** What the quota shows until the first answer. */
function idleQuotaLine() {
    // Asked for on opening (live.js refreshAll); the group's own refresh icon forces it.
    return stateLine('empty', '读取中…');
}

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

/** The 5h / 7d windows: label + reset time on the left, percent on the right, the bar under them. */
function renderQuota(quota) {
    const box = document.getElementById('claude_max_quota');
    if (!box) return;
    if (quota.phase === 'loading') {
        if (!box.childElementCount) box.replaceChildren(stateLine('loading', '正在读取额度…'));
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
            hint.textContent = `额度暂时查不到：Anthropic 限流了，${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')} 后自动再试`;
            if (!hint.isConnected && timer) { clearInterval(timer); timer = null; }
        };
        let timer = setInterval(tick, 1000);
        tick();
        box.append(line);
        return;
    }
    if (!data.windows?.length) {
        box.append(stateLine('empty', '暂无额度数据。'));
        return;
    }
    for (const w of data.windows) {
        const pct = w.utilization !== null ? Math.round(w.utilization * 100) : null;
        const row = el('div', 'cm-qline');
        const bar = el('div', 'cm-quota-bar');
        const fill = el('div', 'cm-quota-fill');
        fill.style.width = `${Math.min(100, pct ?? 0)}%`;
        if ((pct ?? 0) >= 90) fill.classList.add('critical');
        else if ((pct ?? 0) >= 70) fill.classList.add('warning');
        bar.append(fill);
        const label = el('span', 'cm-qline-label', WINDOW_LABELS[w.type] ?? w.type);
        const reset = formatReset(w.resetsAt);
        if (reset) label.append(' ', el('small', 'cm-hint', reset));
        row.append(label, el('b', 'cm-qline-pct', pct !== null ? `${pct}%` : '–'), bar);
        box.append(row);
    }
    if (data.stale && data.fetchedAt) {
        const mins = Math.max(1, Math.round((Date.now() - data.fetchedAt) / 60000));
        box.append(el('small', 'cm-hint', `（${mins} 分钟前的数据）`));
    }
    if (data.extraUsage?.isEnabled) {
        box.append(el('small', 'cm-hint', `额外用量：${data.extraUsage.usedCredits} / ${data.extraUsage.monthlyLimit} ${data.extraUsage.currency}`));
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
    const cols = today.requests === week.requests ? [['今天 · 近 7 天', today]] : [['今天', today], ['近 7 天', week]];
    const table = el('table', 'cm-usage');
    const head = el('tr');
    head.append(el('th'), ...cols.map(([t]) => el('th', null, t)));
    table.append(head);
    const rows = [
        ['请求', (a) => String(a.requests)],
        ...(cols.some(([, a]) => a.failed) ? [['失败', (a) => String(a.failed ?? 0)]] : []),
        ['输出 token', (a) => fmtK(a.outputTokens)],
        ['平均耗时', (a) => fmtSec(a.avgDurationMs)],
        ['首字等待', (a) => fmtSec(a.avgTtftMs)],
        ['缓存命中', (a) => fmtPct(a.cacheHitRate)],
        ['花在', (a) => costShares(a.cost).slice(0, 2).map((p) => `${p.label.replace('缓存', '')}${p.pct}%`).join(' ') || '–'],
    ];
    for (const [label, fn] of rows) {
        const tr = el('tr');
        tr.append(el('td', 'cm-hint', label), ...cols.map(([, a]) => el('td', null, a.requests ? fn(a) : '–')));
        table.append(tr);
    }
    return table;
}

/** The cache result in plain words (the proxy's headline has the numbers; this says what they mean). */
function cacheVerdict(hitPct, firstTurn = false) {
    // 第一轮本来就读不到缓存：不是出错，用中性提示，别用黄色警告
    if (firstTurn) return { tone: 'info', text: '本聊天第一轮：整段写入缓存，下一轮起读取' };
    if (hitPct >= 80) return { tone: 'ok', text: `缓存命中 ${hitPct}%，大部分读了缓存` };
    if (hitPct >= 50) return { tone: 'ok', text: `缓存命中 ${hitPct}%，大半读了缓存` };
    return { tone: 'warn', text: `缓存命中 ${hitPct}%，大部分重写了，通常偏慢、偏耗额度` };
}

const COST_LABELS = { write: '写缓存', output: '输出', read: '读缓存', input: '未缓存输入' };

/** The proxy's cost parts (cache-diag.js costParts, equivalent input tokens) as shares, biggest first; parts under 1% dropped. */
export function costShares(cost) {
    if (!cost) return [];
    const total = Object.values(cost).reduce((n, v) => n + (v || 0), 0);
    if (!total) return [];
    return Object.keys(COST_LABELS)
        .map((key) => ({ key, label: COST_LABELS[key], pct: Math.round((100 * (cost[key] || 0)) / total) }))
        .filter((p) => p.pct >= 1)
        .sort((x, y) => y.pct - x.pct);
}

/** One bar plus 「约 21.9k 等效 · 写缓存 39% · 输出 61%」. */
function costLine(cost) {
    const shares = costShares(cost);
    if (!shares.length) return null;
    const total = Object.values(cost).reduce((n, v) => n + (v || 0), 0);
    const box = el('div', 'cm-cost');
    const bar = el('div', 'cm-cost-bar');
    for (const p of shares) {
        const seg = el('span', `cm-cost-${p.key}`);
        seg.style.width = `${p.pct}%`;
        bar.append(seg);
    }
    const text = el('small', 'cm-hint', `花在 · 约 ${fmtK(total)} 等效：${shares.map((p) => `${p.label} ${p.pct}%`).join(' · ')}`);
    box.append(bar, text);
    return box;
}

/** The last turn: cache in plain words first, then time / output (the model is in the header), then why. */
function lastTurnCard(data) {
    const c = data.lastCache;
    const last = data.lastRequest;
    const v = cacheVerdict(c.hitPct, c.firstTurn);
    const card = note(v.tone, v.text);
    if (last) {
        card.append(el('small', 'cm-hint', `用时 ${fmtSec(last.durationMs)} · 输出 ${fmtK(last.outputTokens)} token`));
        const cost = costLine(c.cost);
        if (cost) card.append(cost);
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
    const lastBox = document.getElementById('claude_max_lastturn');
    if (stats.phase === 'loading') {
        if (!box.childElementCount) box.replaceChildren(stateLine('loading', '正在读取用量…'));
        if (lastBox && !lastBox.childElementCount) lastBox.replaceChildren(stateLine('loading', '正在读取…'));
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
        : stateLine('empty', data.lastRequest ? '这个聊天上一轮没有成功，原因看「用量」里的最近失败。' : '这个聊天还没有回复'));
    box.replaceChildren();
    const sum = document.getElementById('claude_max_usage_sum');
    if (sum) sum.textContent = data.week?.requests ? `近 7 天 ${data.week.requests} 次请求` : '近 7 天还没有请求';
    if (!data.week?.requests) {
        box.append(stateLine('empty', '还没有记录（只记耗时和 token，不记内容）。'));
    } else {
        box.append(usageTable(data.today, data.week));
        const rr = data.today.rerolls || data.week.rerolls;
        if (rr) box.append(el('small', 'cm-hint', `缓存命中不含重 roll 的请求（近 7 天 ${data.week.rerolls ?? 0} 次）。`));
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

/** Tab 状态: last turn first, then the latest reply's problems, quota, usage, world-info cache, diagnostics. */
export function buildStatusTab(pane) {
    // 代理自检结果（SDK 兼容性、逐轮还原、实际地址）；没有问题时不显示。
    const adviceBox = el('div', 'cm-stats');
    adviceBox.id = 'claude_max_advice';
    adviceBox.hidden = true;
    pane.append(adviceBox);

    const stamp = el('small', 'cm-hint');
    stamp.id = 'claude_max_stats_time';
    const tools = el('div', 'cm-section-tools');
    tools.append(stamp, iconButton('fa-rotate', '重新检测并刷新', refreshAll));
    const last = group('上一轮', { tools });
    const lastBox = el('div', 'cm-stats');
    lastBox.id = 'claude_max_lastturn';
    lastBox.append(stateLine('empty', '这个聊天还没有回复'));
    last.body.append(lastBox);
    pane.append(last.root);

    // 最新回复: only the reliable checks (refusal / cut off / empty), one line each; hidden when none.
    const latest = group('最新回复', { id: 'claude_max_latest_sec' });
    latest.root.hidden = true;
    const latestBox = el('div', 'cm-stats');
    latestBox.id = 'claude_max_latest';
    latest.body.append(latestBox);
    pane.append(latest.root);

    const quota = group('额度', {
        id: 'claude_max_quota_sec',
        tools: iconButton('fa-rotate', '刷新额度', () => refreshQuota({ force: true })),
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
    statsBox.append(stateLine('loading', '正在读取用量…'));
    usage.body.append(statsBox);
    pane.append(usage.root);

    // Hidden until features/lore-cache.js finds keyword entries (or a backup to restore).
    const lore = group('世界书缓存', { id: 'claude_max_lore_sec' });
    lore.root.hidden = true;
    const loreBox = el('div', 'cm-field');
    loreBox.id = 'claude_max_lore';
    lore.body.append(loreBox);
    pane.append(lore.root);

    pane.append(buildDiagGroup());
}

// ── 诊断：一键复制给维护者的报告 ──
// The proxy's half (diag-report.js: versions, usage records, proxy log, and — with capture on —
// the shape of what the CLI really sent) plus what only the browser knows: SillyTavern's
// version, the connection's prompt post-processing, the preset, the extensions that can
// change the prompt. No chat text in the copied report.

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
        const { accessKey, leakWords, presetRecoRecord, checkupMuted, ...rest } = getSettings();
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
    const g = group('诊断');
    const settings = getSettings();
    const copy = button('复制诊断报告', async () => {
        copy.disabled = true;
        try {
            const proxyPart = await proxyText('/diag/report', '/v1/diag/report').then((r) => r.text());
            const text = `# CCST 诊断报告 ${new Date().toLocaleString()}\n\n${await clientSection()}\n\n${proxyPart}\n`;
            if (await copyText(text)) {
                notify('ok', '已复制诊断报告', '直接粘贴发给维护者即可（不含聊天内容）。', { ms: 8000 });
            } else {
                showFallback(text);
            }
        } catch (err) {
            notify('warn', '没拿到诊断报告', proxyErrorText('诊断报告', err) ?? String(err?.message ?? err));
        } finally {
            copy.disabled = false;
        }
    }, { icon: 'fa-copy', primary: true });
    copy.title = '缓存或回复不对时发给维护者；不含聊天内容';
    const full = button('下载完整请求', async () => {
        try {
            const data = await proxyText('/diag/full', '/v1/diag/full').then((r) => r.json());
            data.client = await clientSection();
            const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
            const a = el('a');
            a.href = URL.createObjectURL(blob);
            a.download = `ccst-diag-${Date.now()}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        } catch (err) {
            notify('warn', '没拿到完整请求', proxyErrorText('完整请求', err) ?? String(err?.message ?? err));
        }
    }, { icon: 'fa-download', text: true });
    full.title = '含角色卡、预设和聊天原文：只在维护者要时发，别公开贴';
    const row = el('div', 'cm-btn-row');
    row.append(copy, full);
    g.body.append(row);
    g.body.append(toggleRow({
        id: 'claudeMaxDiagCapture',
        title: '记录原始请求',
        tip: '报告里多出每轮实际发给 Claude 的请求结构和缓存读写；只存在代理内存里',
        checked: !!settings.diagCapture,
        onChange: (on) => { getSettings().diagCapture = on; saveSettingsDebounced(); },
    }));
    const fallback = el('textarea', 'text_pole');
    fallback.id = 'claude_max_diag_fallback';
    fallback.rows = 8;
    fallback.hidden = true;
    g.body.append(fallback);
    function showFallback(text) {
        fallback.value = text;
        fallback.hidden = false;
        fallback.select();
        notify('warn', '没能自动复制', '报告已放在下面的框里，全选复制即可。');
    }
    return g.root;
}
