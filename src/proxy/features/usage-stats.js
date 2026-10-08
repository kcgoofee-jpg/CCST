// ──────────────────────────────────────────────
// Per-request usage log + aggregates
// ──────────────────────────────────────────────
//
// Every chat request appends ONE metadata line to data/usage.jsonl, or
// CLAUDE_SUBSCRIPTION_STATS_FILE (model, timing, token counts, outcome and the
// cache diagnosis — offsets, hashes and tag names, never message or prompt
// text; see cache-diag.js nearestLabel) and prints a
// one-line summary to the console. /v1/usage/stats aggregates today and the
// last 7 days for the CCST panel: request count, tokens, average
// latency, prompt-cache hit rate, and the most recent failure.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { explainError } from './errors-zh.js';
import { apiValueUsd, cacheAnomaly, cacheState, costParts, explainCache, quotaParts } from './cache-diag.js';
import { resetReplayState } from './turn-capture.js';
import { SDK_VERSION } from './sdk-version.js';
import { DATA_DIR } from '../paths.js';
import { PRICES_AS_OF } from '../../shared/backends.js';

// 审: 控制台日志统一前缀（多个文件各自重复定义了一份，跨分区未合并）。
const PLUGIN_TAG = '[claude-subscription]';
// 审: 用量日志超过 5MB 就滚动成 .old，防止无限增长。
const MAX_FILE_BYTES = 5 * 1024 * 1024;
// 审: 统计窗口 7 天，内存和聚合都按它裁剪。
const WINDOW_MS = 7 * 24 * 3600 * 1000;

// 审: 用量日志路径，环境变量 CLAUDE_SUBSCRIPTION_STATS_FILE 可改（测试使用）。
function statsFilePath() {
    if (process.env.CLAUDE_SUBSCRIPTION_STATS_FILE) return process.env.CLAUDE_SUBSCRIPTION_STATS_FILE;
    return join(DATA_DIR, 'usage.jsonl');
}

// 审: 内存里最近 7 天的记录，首次使用时从文件读入。
let entries = null; // last 7 days, oldest first

// 审: 惰性读取日志，跳过坏行和过期行。
function load() {
    if (entries) return entries;
    entries = [];
    const path = statsFilePath();
    if (!existsSync(path)) return entries;
    const cutoff = Date.now() - WINDOW_MS;
    try {
        for (const line of readFileSync(path, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try {
                const e = JSON.parse(line);
                if (e.at >= cutoff) entries.push(e);
            } catch { /* skip corrupt line */ }
        }
    } catch (err) {
        console.warn(`${PLUGIN_TAG} could not read usage stats:`, err instanceof Error ? err.message : err);
    }
    return entries;
}

// 审: 追加一行到日志，必要时先滚动；失败只警告不影响请求。
function persist(entry) {
    const path = statsFilePath();
    try {
        mkdirSync(dirname(path), { recursive: true });
        if (existsSync(path) && statSync(path).size > MAX_FILE_BYTES) {
            renameSync(path, `${path}.old`);
        }
        appendFileSync(path, JSON.stringify(entry) + '\n');
    } catch (err) {
        console.warn(`${PLUGIN_TAG} could not write usage stats:`, err instanceof Error ? err.message : err);
    }
}

// 审: 把消息角色序列压成 S34 A1 U1 这样的元数据，不含任何内容；chat.js 使用。
/** Role layout of the incoming messages, run-length encoded — e.g.
 *  "S34 A1 S2 U1 A1 U1" (S=system, U=user, A=assistant). Metadata only. */
export function promptShape(messages) {
    const runs = [];
    for (const m of messages ?? []) {
        const r = { system: 'S', user: 'U', assistant: 'A', tool: 'T' }[m?.role] ?? '?';
        const last = runs[runs.length - 1];
        if (last && last[0] === r) last[1] += 1;
        else runs.push([r, 1]);
    }
    const parts = runs.map(([r, n]) => `${r}${n}`);
    return parts.length > 16 ? `${parts.slice(0, 8).join(' ')} … ${parts.slice(-6).join(' ')}` : parts.join(' ');
}

// 审: 数字缩写成 k。
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
// 审: 毫秒转秒。
const sec = (ms) => `${(ms / 1000).toFixed(1)}s`;

// 审: 每个请求结束后在控制台打一行摘要。
/** Console line, e.g.
 *  ✓ claude-opus-4-6[1m] · resume · 248.1s（首字 3.2s）· 输入 1.2k + 缓存读 45k + 缓存写 2k · 输出 9.8k
 *  （不记思考字数：Opus 4.6 / 5.x 返回的思考是摘要，字数不代表实际思考量。） */
function formatLogLine(e) {
    const head = e.ok ? '✓' : '✗';
    const via = e.backend && e.backend !== 'subscription' ? ` @${e.backend}` : '';
    const parts = [`${head} ${e.model}${via}`, e.path ?? '-', `${sec(e.durationMs)}${e.ttftMs != null ? `（首字 ${sec(e.ttftMs)}）` : ''}`];
    if (e.ok) {
        parts.push(`输入 ${k(e.inputTokens)} + 缓存读 ${k(e.cacheReadTokens)} + 缓存写 ${k(e.cacheCreationTokens)}`);
        parts.push(`输出 ${k(e.outputTokens)}`);
        if (e.finish && e.finish !== 'stop') parts.push(e.finish);
    } else {
        parts.push(`${e.errorCode}：${e.errorRaw}`);
    }
    return `${PLUGIN_TAG} ${parts.join(' · ')}`;
}

// 审: chat.js 每次请求结束记一条：写内存、写文件、打日志，并检测缓存异常。
/**
 * @param {{ model: string, path?: string, stream: boolean, startedAt: number,
 *   firstTokenAt?: number|null, usage?: object|null, textChars: number,
 *   finish?: string, clientClosed?: boolean,
 *   error?: string|null }} r
 */
export function recordRequest(r) {
    const now = Date.now();
    const u = r.usage ?? {};
    const failure = r.error ? explainError(r.error) : null;
    const entry = {
        at: now,
        // Lines written before 3.3 have no backend: they were the subscription
        // (or a header API key, which the log could not tell apart).
        backend: r.backend ?? 'subscription',
        model: r.model,
        effort: r.effort ?? null,
        placement: r.placement ?? null,
        auxiliary: r.auxiliary === true,
        ...(r.chatKey ? { chatKey: r.chatKey } : {}),
        ...(r.purpose && r.purpose !== 'chat' ? { purpose: r.purpose } : {}),
        // ms from request start: CLI ready (init), API response started, first content delta
        phases: r.timing?.initAt ? {
            init: r.timing.initAt - r.startedAt,
            apiStart: r.timing.messageStartAt ? r.timing.messageStartAt - r.startedAt : null,
            firstDelta: r.timing.firstDeltaAt ? r.timing.firstDeltaAt - r.startedAt : null,
        } : null,
        path: r.path ?? null,
        stream: !!r.stream,
        ok: !failure,
        durationMs: now - r.startedAt,
        ttftMs: r.firstTokenAt ? r.firstTokenAt - r.startedAt : null,
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
        // Which TTL the CLI actually asked for: a 5-minute write is gone before the
        // next turn of a long reply (cache-diag.js cacheExpired).
        cacheTtl: writtenTtl(u),
        textChars: r.textChars ?? 0,
        finish: r.clientClosed ? 'client_closed' : (r.finish ?? null),
        shape: r.shape ?? null,
        cacheDiag: r.cacheDiag ?? null,
        // SillyTavern's setup for this request (preset, post-processing, entries) — panel inject.js.
        ...(r.st ? { st: r.st } : {}),
        // no-1m: asked for 1M context, served the base model; refusal /
        // fallback:<model>: the reply was cut by a safety stop (and redone
        // by another model)
        ...(r.notices?.length ? { notices: r.notices } : {}),
    };
    if (failure) {
        entry.errorCode = failure.code;
        entry.errorRaw = failure.raw.slice(0, 500);
    }
    const all = load();
    if (!failure) noteCacheAnomaly(entry, all.length ? all[all.length - 1] : null);
    all.push(entry);
    // The window is otherwise only trimmed when the panel is opened, so a
    // proxy that runs for weeks without one holds every entry in memory.
    const cutoff = now - WINDOW_MS;
    while (all.length && all[0].at < cutoff) all.shift();
    persist(entry);
    console.log(formatLogLine(entry));
    return entry;
}

// 审: 从 API 的 cache_creation 拆分判断实际写入的是 1h 还是 5m（测试使用）。
/** '1h' / '5m' from the API's cache_creation split; null when nothing was written. */
export function writtenTtl(u) {
    const c = u?.cache_creation;
    if (!c || typeof c !== 'object') return null;
    if ((c.ephemeral_1h_input_tokens ?? 0) > 0) return '1h';
    if ((c.ephemeral_5m_input_tokens ?? 0) > 0) return '5m';
    return null;
}

// 审: 连续几次异常才自动重置回放状态。
const ANOMALY_RESET_AFTER = 2;
// 审: 连续异常次数。
let anomalyStreak = 0;

// 审: 连续两轮「内容没变却没读到缓存」就重置回放状态并给面板提示（#26）。
/** Two turns in a row of 「nothing changed, yet the history was re-written」 is the replay
 *  broken rather than the preset changing: reset it once and tell the panel (issue #26). */
function noteCacheAnomaly(entry, prevEntry) {
    if (!cacheAnomaly(entry, prevEntry)) {
        anomalyStreak = 0;
        return;
    }
    anomalyStreak += 1;
    if (anomalyStreak < ANOMALY_RESET_AFTER) return;
    anomalyStreak = 0;
    resetReplayState(`连续两轮内容没变却没读到缓存（SDK ${SDK_VERSION}），已自动重置逐轮还原状态，本轮缓存会全量重写一次`);
    entry.notices = [...(entry.notices ?? []), 'replay-reset'];
}

// 审: 找出失败后同一聊天的重发请求，它们不算重抽。
/** Requests that follow a failed request of the same chat: a resend, the turn itself — not a reroll even
 *  where the record says so (until 6.0.2 the resend was compared with the failed request). No chat key,
 *  no chat to tell. */
function resentAfterFailure(list) {
    const out = new Set();
    const lastOk = new Map(); // chatKey → whether its latest request went through
    for (const e of list) {
        if (!e.chatKey) continue;
        if (e.ok && lastOk.get(e.chatKey) === false) out.add(e);
        lastOk.set(e.chatKey, !!e.ok);
    }
    return out;
}

// 审: 是否算重抽（重发不算）。
const isReroll = (e, resent) => !!e?.cacheDiag?.reroll && !resent.has(e);

// 审: 把一批记录汇总成面板用的总量、命中率、额度占比、费用等。
function aggregate(list, resent = resentAfterFailure(list)) {
    const ok = list.filter((e) => e.ok);
    const sum = (key, from = ok) => from.reduce((n, e) => n + (e[key] ?? 0), 0);
    const input = sum('inputTokens');
    const cacheRead = sum('cacheReadTokens');
    const cacheWrite = sum('cacheCreationTokens');
    // The hit rate describes new turns: rerolls read back everything and
    // would flatter it.
    const fresh = ok.filter((e) => !isReroll(e, resent));
    const freshRead = sum('cacheReadTokens', fresh);
    const promptTotal = sum('inputTokens', fresh) + freshRead + sum('cacheCreationTokens', fresh);
    // Share of new turns whose cache was healthy (first turns, rerolls and expired caches don't count).
    const prevOf = new Map();
    let healthy = 0, judged = 0;
    for (const e of ok) {
        const key = e.chatKey ?? e.cacheDiag?.chat;
        const { state } = cacheState(e.cacheDiag ? { ...e, cacheDiag: { ...e.cacheDiag, reroll: isReroll(e, resent) } } : e, key ? prevOf.get(key) : null);
        if (key) prevOf.set(key, e);
        if (state === 'ok' || state === 'part' || state === 'full') { judged++; if (state === 'ok') healthy++; }
    }
    const timed = ok.filter((e) => e.durationMs > 0);
    const ttft = ok.filter((e) => e.ttftMs != null);
    const models = {};
    for (const e of ok) models[e.model] = (models[e.model] ?? 0) + 1;
    return {
        requests: list.length,
        succeeded: ok.length,
        failed: list.length - ok.length,
        inputTokens: input,
        outputTokens: sum('outputTokens'),
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheWrite,
        cacheHitRate: promptTotal > 0 ? freshRead / promptTotal : null,
        cacheOkRate: judged ? healthy / judged : null,
        // Subscription-weighted parts (cache-diag QUOTA_WEIGHT), for 「花在」.
        quota: ok.reduce((c, e) => { const p = quotaParts(e); for (const key in c) c[key] += p[key]; return c; }, { output: 0, write: 0, read: 0 }),
        // Where the equivalent cost went (rerolls included: they cost too).
        cost: ok.reduce((c, e) => { const p = costParts(e); for (const key in c) c[key] += p[key]; return c; }, { write: 0, output: 0, read: 0, input: 0 }),
        // The same requests at API list prices (like a status line's Today $ / Week $); models without a price row are left out.
        apiUsd: ok.reduce((n, e) => n + (apiValueUsd(e) ?? 0), 0),
        rerolls: ok.length - fresh.length,
        avgDurationMs: timed.length ? Math.round(timed.reduce((n, e) => n + e.durationMs, 0) / timed.length) : null,
        avgTtftMs: ttft.length ? Math.round(ttft.reduce((n, e) => n + e.ttftMs, 0) / ttft.length) : null,
        models,
    };
}

// 审: 今日/7 天/后台/最近一次的统计，面板状态页使用（handleStats、测试）。
/** `chat` (a chat key, or any other string for "no such chat") limits the last-turn card to that chat's
 *  requests; today / week totals stay global. Entries from before chat keys existed belong to no chat. */
export function summarizeStats(now = Date.now(), { chat = null } = {}) {
    const all = load();
    const cutoff = now - WINDOW_MS;
    while (all.length && all[0].at < cutoff) all.shift();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    // Replies in the conversation vs background calls from other extensions
    // (image tags, summaries): the cards and averages describe the former.
    const main = all.filter((e) => !e.auxiliary);
    const bg = all.filter((e) => e.auxiliary);
    const today = main.filter((e) => e.at >= startOfDay.getTime());
    const lastFailure = [...all].reverse().find((e) => !e.ok) ?? null;
    const mine = chat ? main.filter((e) => e.chatKey === chat) : main;
    const lastRequest = mine.length ? mine[mine.length - 1] : null;
    let lastError = null;
    if (lastFailure) {
        const ex = explainError(lastFailure.errorRaw);
        lastError = { at: lastFailure.at, model: lastFailure.model, code: lastFailure.errorCode, message: ex.message, hint: ex.hint, raw: lastFailure.errorRaw, background: !!lastFailure.auxiliary };
    }
    // Compared with the previous request that went through (a failed one wrote nothing).
    const prevRequest = mine.slice(0, -1).reverse().find((e) => e.ok) ?? null;
    // The card and the totals agree on what a reroll is.
    const resent = resentAfterFailure(all);
    const shown = lastRequest?.cacheDiag?.reroll && !isReroll(lastRequest, resent)
        ? { ...lastRequest, cacheDiag: { ...lastRequest.cacheDiag, reroll: false } } : lastRequest;
    const lastCache = explainCache(shown, prevRequest);
    const bgToday = bg.filter((e) => e.at >= startOfDay.getTime());
    const background = { today: aggregate(bgToday, resent), week: aggregate(bg, resent) };
    return { today: aggregate(today, resent), week: aggregate(main, resent), background, lastRequest, lastCache, lastError, pricesAsOf: PRICES_AS_OF };
}

// 审: 最近 n 条原始记录，给诊断报告（diag-report.js）。
/** The last `n` usage records, oldest first (the diagnostics report). */
export function recentEntries(n = 20) {
    const all = load();
    return all.slice(-n);
}

// 审: 路由 GET /stats 的处理器（routes.js 注册），按可选的 chat 参数限定最近一次。
export function handleStats(req, res) {
    const chat = typeof req.query?.chat === 'string' && /^[0-9a-zA-Z_-]{1,40}$/.test(req.query.chat) ? req.query.chat : null;
    res.json({ ok: true, ...summarizeStats(Date.now(), { chat }) });
}

// 审: 测试接缝，清内存记录和异常计数。
/** Test seam. */
export function __resetStatsForTesting() {
    entries = null;
    anomalyStreak = 0;
}
