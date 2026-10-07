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
import { cacheAnomaly, explainCache } from './cache-diag.js';
import { resetReplayState } from './turn-capture.js';
import { SDK_VERSION } from './sdk-version.js';
import { DATA_DIR } from '../paths.js';
import { estimateCostUsd, BACKEND_LABELS, PRICES_AS_OF } from '../../shared/backends.js';

const PLUGIN_TAG = '[claude-subscription]';
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const WINDOW_MS = 7 * 24 * 3600 * 1000;

export function statsFilePath() {
    if (process.env.CLAUDE_SUBSCRIPTION_STATS_FILE) return process.env.CLAUDE_SUBSCRIPTION_STATS_FILE;
    return join(DATA_DIR, 'usage.jsonl');
}

let entries = null; // last 7 days, oldest first

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

const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
const sec = (ms) => `${(ms / 1000).toFixed(1)}s`;

/** Console line, e.g.
 *  ✓ claude-opus-4-6[1m] · resume · 248.1s（首字 3.2s）· 输入 1.2k + 缓存读 45k + 缓存写 2k · 输出 9.8k
 *  （不记思考字数：Opus 4.6 / 5.x 返回的思考是摘要，字数不代表实际思考量。） */
export function formatLogLine(e) {
    const head = e.ok ? '✓' : '✗';
    const via = e.backend && e.backend !== 'subscription' ? ` @${e.backend}` : '';
    const parts = [`${head} ${e.model}${via}`, e.path ?? '-', `${sec(e.durationMs)}${e.ttftMs != null ? `（首字 ${sec(e.ttftMs)}）` : ''}`];
    if (e.ok) {
        parts.push(`输入 ${k(e.inputTokens)} + 缓存读 ${k(e.cacheReadTokens)} + 缓存写 ${k(e.cacheCreationTokens)}`);
        parts.push(`输出 ${k(e.outputTokens)}`);
        if (e.finish && e.finish !== 'stop') parts.push(e.finish);
        if (e.costUsd != null) parts.push(`约 $${e.costUsd.toFixed(4)}`);
    } else {
        parts.push(`${e.errorCode}：${e.errorRaw}`);
    }
    return `${PLUGIN_TAG} ${parts.join(' · ')}`;
}

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
    // Estimated, from token counts × list prices (shared/backends.js); null on
    // the subscription or for a model without a price row.
    const cost = estimateCostUsd(entry, entry.backend, { cacheTtl: r.cacheTtl });
    if (cost != null) entry.costUsd = cost;
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

/** '1h' / '5m' from the API's cache_creation split; null when nothing was written. */
export function writtenTtl(u) {
    const c = u?.cache_creation;
    if (!c || typeof c !== 'object') return null;
    if ((c.ephemeral_1h_input_tokens ?? 0) > 0) return '1h';
    if ((c.ephemeral_5m_input_tokens ?? 0) > 0) return '5m';
    return null;
}

const ANOMALY_RESET_AFTER = 2;
let anomalyStreak = 0;

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

function aggregate(list) {
    const ok = list.filter((e) => e.ok);
    const sum = (key, from = ok) => from.reduce((n, e) => n + (e[key] ?? 0), 0);
    const input = sum('inputTokens');
    const cacheRead = sum('cacheReadTokens');
    const cacheWrite = sum('cacheCreationTokens');
    // The hit rate describes new turns: rerolls read back everything and
    // would flatter it.
    // A resend right after a failed request is the turn itself, not a reroll.
    const failedBefore = new Set();
    for (let i = 1; i < list.length; i++) if (!list[i - 1].ok && list[i - 1].chatKey === list[i].chatKey) failedBefore.add(list[i]);
    const fresh = ok.filter((e) => !e.cacheDiag?.reroll || failedBefore.has(e));
    const freshRead = sum('cacheReadTokens', fresh);
    const promptTotal = sum('inputTokens', fresh) + freshRead + sum('cacheCreationTokens', fresh);
    const timed = ok.filter((e) => e.durationMs > 0);
    const ttft = ok.filter((e) => e.ttftMs != null);
    const models = {};
    for (const e of ok) models[e.model] = (models[e.model] ?? 0) + 1;
    // Per backend: requests, tokens and the estimated cost (API-type backends).
    const backends = {};
    for (const e of list) {
        const id = e.backend ?? 'subscription';
        const b = backends[id] ??= { label: BACKEND_LABELS[id] ?? id, requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null };
        b.requests += 1;
        b.inputTokens += e.inputTokens ?? 0;
        b.outputTokens += e.outputTokens ?? 0;
        b.cacheReadTokens += e.cacheReadTokens ?? 0;
        b.cacheCreationTokens += e.cacheCreationTokens ?? 0;
        if (e.costUsd != null) b.costUsd = Math.round(((b.costUsd ?? 0) + e.costUsd) * 1e6) / 1e6;
    }
    return {
        requests: list.length,
        succeeded: ok.length,
        failed: list.length - ok.length,
        inputTokens: input,
        outputTokens: sum('outputTokens'),
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheWrite,
        cacheHitRate: promptTotal > 0 ? freshRead / promptTotal : null,
        rerolls: ok.length - fresh.length,
        avgDurationMs: timed.length ? Math.round(timed.reduce((n, e) => n + e.durationMs, 0) / timed.length) : null,
        avgTtftMs: ttft.length ? Math.round(ttft.reduce((n, e) => n + e.ttftMs, 0) / ttft.length) : null,
        models,
        backends,
    };
}

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
    const lastCache = explainCache(lastRequest, prevRequest);
    const bgToday = bg.filter((e) => e.at >= startOfDay.getTime());
    const background = { today: aggregate(bgToday), week: aggregate(bg) };
    return { today: aggregate(today), week: aggregate(main), background, lastRequest, lastCache, lastError, pricesAsOf: PRICES_AS_OF };
}

/** The last `n` usage records, oldest first (the diagnostics report). */
export function recentEntries(n = 20) {
    const all = load();
    return all.slice(-n);
}

export function handleStats(req, res) {
    const chat = typeof req.query?.chat === 'string' && /^[0-9a-zA-Z_-]{1,40}$/.test(req.query.chat) ? req.query.chat : null;
    res.json({ ok: true, ...summarizeStats(Date.now(), { chat }) });
}

/** Test seam. */
export function __resetStatsForTesting() {
    entries = null;
    anomalyStreak = 0;
}
