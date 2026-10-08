// ──────────────────────────────────────────────
// Prompt-cache diagnostics: what changed since the previous turn?
// ──────────────────────────────────────────────
//
// Claude's prompt cache is a prefix match: system prompt first, then the
// messages. If anything in the system prompt differs from the previous turn
// (a keyword-triggered world-info entry, a {{random}} macro, a summary that
// is rewritten every turn), the WHOLE request is re-written to the cache and
// nothing is read back — slower first token, more quota.
//
// For each conversation we keep the previous turn's system prompt and
// history IN MEMORY ONLY (a handful of recent chats, never written to disk)
// and report where the new request first diverges. The report carries
// offsets and the nearest enclosing tag name — structure from the preset or
// card. A heading is not quoted (it is prompt text, and the report goes to
// usage.jsonl, the log and the panel): it is only named as a kind.

import { createHash } from 'node:crypto';

import { contentToText } from '../core/system-prompt.js';
import { cacheWriteMultiplier, priceFor } from '../../shared/backends.js';

// 审: 最多同时记住 6 个聊天的上一轮，防止内存无限增长。
const MAX_CHATS = 6;
// 审: 每个聊天上一轮的系统提示词+历史（仅内存），diagnoseCache 靠它和新请求对比。
const previous = new Map(); // chatKey → { system, history: string[] }
// 审: 每个诊断对象对应"它之前的聊天状态"，请求失败时 discardDiag 据此回滚。
const undo = new WeakMap(); // diagnosis → the chat's state before it (discardDiag)
// 审: 判断标题是否像世界书（只当作一种类别报告，不引用原文）。
// Heading text that looks like world info (only ever named as a kind, never quoted).
const LORE_TAG = /world|lore|世界|设定集|worldinfo/i;

// 审: 短哈希，给聊天开头做 key，报告里不带任何正文。
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);

// 审: 没有面板传来的 chatKey 时，用聊天开头算出聊天标识，把各轮归到同一个聊天。
/** Same chat across turns: the opening of the conversation — everything up
 *  to and including the first user message — doesn't change. (The first two
 *  messages alone are not enough: a preset's fake assistant acknowledgement
 *  plus a card's greeting are identical in every chat with that card.) */
function chatKeyOf(history) {
    // Only the first paragraph of the first user message: depth injections
    // are merged onto its end (after a blank line) while it is still recent,
    // and drop off a turn later.
    const firstUser = history.findIndex((t) => t.startsWith('user:'));
    const opening = firstUser >= 0
        ? [...history.slice(0, firstUser), history[firstUser].split('\n\n')[0].slice(0, 200)]
        : history.slice(0, 2);
    return hash(opening.join('\u0000'));
}

// 审: 两个字符串第一处不同的位置，完全相同返回 -1。
function firstDiff(a, b) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    return i === n && a.length === b.length ? -1 : i;
}

// 审: 区分"换了预设"和"小改"，决定报告写整段重写还是局部变化。
/** Most of the prompt replaced (another preset, not an edit): over 30% of
 *  the new prompt's text is in lines the old prompt did not have. A toggled
 *  entry or a world-info change adds a few lines; a different preset adds
 *  whole sections. */
const REWRITE_SHARE = 0.3;
function isRewrite(a, b) {
    const old = new Set(a.split('\n'));
    let fresh = 0;
    for (const line of b.split('\n')) if (!old.has(line)) fresh += line.length + 1;
    return fresh > REWRITE_SHARE * b.length;
}

// 审: 识别"旧回复被预设正则改短"，没了它会把这种每轮必发生的变化误判成 swipe。
/** `b` is `a` cut down: one stretch of it cut out (oneCutOut), or clearly
 *  shorter with every line of it already in `a` (only its <摘要> part kept, a
 *  status bar stripped). A swipe or a rewritten reply has lines of its own. */
const CUT_DOWN_SHARE = 0.8;
function isCutDown(a, b) {
    if (!b.trim() || b.length >= a.length) return false;
    if (oneCutOut(a, b)) return true;
    if (b.length > CUT_DOWN_SHARE * a.length) return false;
    const flat = (s) => s.replace(/\s+/g, '');
    const old = flat(a);
    return b.split('\n').every((line) => old.includes(flat(line)));
}

// 审: isCutDown 的子判断：b 只是 a 去掉中间一段或只留一段。
/** `b` is `a` with one stretch taken out (果实「3楼外伏笔不发送」drops the seeds: part of an older
 *  reply, about 12% of it) or with only one stretch kept (「5楼外只发送摘要」keeps the end from
 *  <meow_FM>): what `b` has is a start and an end of `a`, nothing of its own. */
const MIN_CUT_CHARS = 20;
function oneCutOut(a, b) {
    if (a.length - b.length < MIN_CUT_CHARS) return false;
    if (b.trim().length >= MIN_CUT_CHARS && a.includes(b)) return true;
    let p = 0;
    while (p < b.length && a.charCodeAt(p) === b.charCodeAt(p)) p++;
    let s = 0;
    while (s < b.length - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
    return p + s === b.length && Math.min(p, s) > 0;
}

// 审: 栈出 offset 之前还没闭合的 XML 标签，用来给差异位置起名（只报标签名，不报正文）。
function openTags(text, offset) {
    const base = Math.max(0, offset - 60000);
    const before = text.slice(base, offset);
    const stack = [];
    const tagRe = /<(\/?)([A-Za-z_一-鿿][\w一-鿿:-]{0,40})(?:\s[^<>]*)?>/g;
    let m;
    while ((m = tagRe.exec(before))) {
        const [, close, name] = m;
        if (close) {
            const idx = stack.findLastIndex((t) => t.name === name);
            if (idx >= 0) stack.length = idx;
        } else if (!m[0].endsWith('/>')) {
            stack.push({ name, at: base + m.index });
        }
    }
    return stack;
}

// 审: 差异落在 Markdown 标题段时的通用称呼（不引用标题原文）；只在本文件内用，测试靠字面量比对。
const HEADING_LABEL = '某个标题段落';
// 审: 同上，标题像世界书时的称呼。
const LORE_HEADING_LABEL = '世界书标题段落';

// 审: 给差异位置起名：优先最内层标签，其次标题类别；usage-stats / 测试用到所以保留 export。
/** Innermost unclosed tag before `offset` as `<name>`; otherwise, if a
 *  heading line precedes it, a generic label (whether the heading looks like
 *  world info — never its text). */
export function nearestLabel(text, offset) {
    const stack = openTags(text, offset);
    if (stack.length) return `<${stack[stack.length - 1].name}>`;
    const before = text.slice(Math.max(0, offset - 60000), offset);
    const headings = [...before.matchAll(/(?:^|\n)[ \t]*((?:#{1,4}[ \t]*|【)[^\n]{1,24})/g)];
    if (!headings.length) return null;
    return LORE_TAG.test(headings[headings.length - 1][1]) ? LORE_HEADING_LABEL : HEADING_LABEL;
}

// 审: 缓存诊断主入口：每次聊天请求对比上一轮，找出系统提示词/历史从哪里开始变，chat.js 调用。
/**
 * @param {string} systemText  the system prompt as sent to Claude
 * @param {Array} history      non-system messages (history + current turn)
 * @param {{ chatKey?: string|null }} [opts]
 * @returns {object} diagnosis (firstTurn: true when there is nothing to compare with yet)
 */
export function diagnoseCache(systemText, history, { chatKey = null } = {}) {
    const system = systemText ?? '';
    const texts = history.map((m) => `${m.role}:${contentToText(m.content)}`);
    // The panel's chat id when it sent one: the opening of the first user
    // message changes while injections are merged onto it.
    const key = chatKey ? `p${chatKey}`.slice(0, 13) : chatKeyOf(texts);
    const prev = previous.get(key);

    const diffAt = prev ? firstDiff(prev.system, system) : -1;
    // Switching presets replaces most of the prompt: said apart from an edit.
    const rewrite = diffAt >= 0 && isRewrite(prev.system, system);

    const state = { system, history: texts };
    previous.delete(key);
    previous.set(key, state);
    while (previous.size > MAX_CHATS) previous.delete(previous.keys().next().value);

    if (!prev) {
        const first = { chat: key, firstTurn: true, systemChars: system.length };
        undo.set(first, { key, prev, state });
        return first;
    }

    // History that existed last turn (minus the previous current message,
    // which is normally replaced by the reply + new input) should be stable.
    // With a trailing assistant prefill (果实) that message is followed by the prefill, which also
    // changes every turn: compare up to the previous turn's last player message.
    const prevLastUser = prev.history.findLastIndex((t) => t.startsWith('user:'));
    const comparable = prevLastUser >= 0 ? prevLastUser : Math.max(0, prev.history.length - 1);
    let historyDiffAt = -1;
    for (let i = 0; i < comparable && i < texts.length; i++) {
        if (prev.history[i] !== texts[i]) { historyDiffAt = i; break; }
    }
    // Reroll / swipe: the same conversation sent again (the discarded reply
    // is not part of it). Reads back almost everything, so it says nothing
    // about what a new turn costs — reports keep it apart.
    const reroll = texts.length === prev.history.length && texts.every((t, i) => t === prev.history[i]);
    // An older reply cut down to part of itself: a preset's prompt-only regex
    // that keeps only the last N replies in full (灰烬之桥「保留4层正文」sends
    // older ones as just their <摘要>). Happens every turn as replies age —
    // not a swipe. Everything after it is re-written all the same.
    const summaryReplaced = historyDiffAt >= 0 && prev.history[historyDiffAt]?.startsWith('assistant:')
        && texts[historyDiffAt]?.startsWith('assistant:')
        && texts.findLastIndex((t) => t.startsWith('assistant:')) > historyDiffAt
        && isCutDown(prev.history[historyDiffAt].slice(10), texts[historyDiffAt].slice(10));
    // A reply that differs from the one sent last turn: the player picked
    // another swipe (or edited the reply). Everything after it is re-written.
    const replyChanged = !summaryReplaced && historyDiffAt >= 0 && texts[historyDiffAt]?.startsWith('assistant:');
    // How deep that reply sits (SillyTavern's regex depth: the newest player message is 0), to tell
    // which depth regex reached it.
    const cutDepth = summaryReplaced ? texts.findLastIndex((t) => t.startsWith('user:')) - historyDiffAt : null;
    const diag = {
        chat: key, // hash of the chat's opening two messages — groups turns per chat in reports, carries no text
        firstTurn: false,
        systemChars: system.length,
        systemChanged: diffAt >= 0,
        systemDiffAt: diffAt >= 0 ? diffAt : null,
        systemDiffLabel: diffAt >= 0 ? nearestLabel(system, diffAt) : null,
        historyDiffAt: historyDiffAt >= 0 ? historyDiffAt : null,
        historyLen: texts.length,
        ...(reroll ? { reroll: true } : {}),
        ...(replyChanged ? { replyChanged: true } : {}),
        ...(summaryReplaced ? { summaryReplaced: true, cutDepth } : {}),
        ...(rewrite ? { rewrite: true } : {}),
    };
    undo.set(diag, { key, prev, state });
    return diag;
}

// 审: 请求失败后回滚本轮记录，让重发不被误判成 reroll（chat.js 调用）。
/** The request failed: nothing reached the cache, so the next one (a resend) is compared with the
 *  last request that went through, not with this one — else a resend reads as a reroll. */
export function discardDiag(diag) {
    const u = diag && undo.get(diag);
    if (!u) return;
    undo.delete(diag);
    if (previous.get(u.key) !== u.state) return; // a newer request of this chat came in meanwhile
    previous.delete(u.key);
    if (u.prev) previous.set(u.key, u.prev);
}

// 审: 把诊断对象写成一行中文日志（chat.js 调用）。
/** One human-readable line for the proxy log. */
export function describeDiag(d) {
    if (!d) return null;
    if (d.firstTurn) return `缓存诊断：本聊天第一轮（系统提示词 ${d.systemChars.toLocaleString()} 字），下一轮开始对比`;
    const parts = [];
    if (d.reroll) parts.push('重roll（和上一次请求的聊天记录相同，不代表新一轮的开销）');
    if (d.rewrite) parts.push('系统提示词大部分换了（多半是换了预设）：这一轮整段重写');
    if (d.systemChanged) {
        parts.push(`系统提示词与上一轮不同，从第 ${d.systemDiffAt.toLocaleString()} / ${d.systemChars.toLocaleString()} 字开始` +
            (d.systemDiffLabel ? `（位于 ${d.systemDiffLabel} 内）` : '') + ' → 这一轮整段缓存失效');
    } else {
        parts.push('系统提示词与上一轮相同');
    }
    if (d.historyDiffAt !== null) {
        parts.push(d.replyChanged
            ? `第 ${d.historyDiffAt + 1} / ${d.historyLen} 条（一条回复）和上一轮发的不同：切换了回复分支（swipe）或编辑了回复，从这里往后重写`
            : d.summaryReplaced
                ? `第 ${d.historyDiffAt + 1} / ${d.historyLen} 条（深度 ${d.cutDepth} 的旧回复）被预设正则改短了，从这里往后重写`
                : `聊天记录从第 ${d.historyDiffAt + 1} / ${d.historyLen} 条开始与上一轮不同（正则改写旧楼层、删改消息会造成）`);
    }
    return `缓存诊断：${parts.join('；')}`;
}

// 审: token 数缩写成 1.2k，给 explainCache 的 headline 用。
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

// 审: 一次请求按 API 官方价比折成"等价输入 token"，按花在哪部分拆开（面板「花在」、usage-stats、apiValueUsd 用）。
/** A request's cost in "equivalent input tokens" (list-price ratios), split by what it paid for (the panel's 「花在」), using the model's own price row
 *  where there is one (Opus 5.5 reads at 0.05×, Fable 5.1 at 0.025×); otherwise read 0.1×, output 5×.
 *  Output includes thinking. */
export function costParts(e) {
    const p = priceFor(e.model);
    const readX = p ? p.cacheRead / p.input : 0.1;
    const outX = p ? p.output / p.input : 5;
    return {
        write: Math.round(cacheWriteMultiplier(e.cacheTtl) * (e.cacheCreationTokens ?? 0)),
        output: Math.round(outX * (e.outputTokens ?? 0)),
        read: Math.round(readX * (e.cacheReadTokens ?? 0)),
        input: e.inputTokens ?? 0,
    };
}

// 审: 折成 API 标价的美元数（usage-stats 用），没有价格行返回 null。
/** What the request would cost at API list prices (USD), like a status line's session cost; null without a price row. */
export function apiValueUsd(e) {
    const p = priceFor(e.model);
    if (!p) return null;
    const c = costParts(e);
    return ((c.write + c.output + c.read + c.input) * p.input) / 1e6;
}

// 审: 两种缓存 TTL 的毫秒数，cacheExpired 判断过期用。
const TTL_MS = { '5m': 5 * 60_000, '1h': 60 * 60_000 };

/**
 * Minutes between the starts of two requests, when the previous turn's cache had
 * already expired by then (its write TTL — 5 min or 1 h — is in usage-stats
 * cacheTtl; unknown counts as 1 h). The cache is refreshed when a request starts,
 * not when its reply ends: a 4-minute reply plus reading it outlasts 5 minutes.
 * @returns {{ gapMin: number, ttl: string } | null}
 */
export function cacheExpired(entry, prevEntry) {
    const start = (e) => (Number.isFinite(e?.at) ? e.at - (e.durationMs ?? 0) : NaN);
    const gap = start(entry) - start(prevEntry);
    const ttl = prevEntry?.cacheTtl === '5m' ? '5m' : '1h';
    if (!(gap > TTL_MS[ttl])) return null;
    return { gapMin: Math.round(gap / 60_000), ttl };
}

// 审: 重放与 CLI 实际发送不一致的异常检测（usage-stats 调用）；没了它"内容没变却没读到"的提示就失效。
/**
 * The turn replay (turn-capture.js) stopped matching what the CLI sends: same chat,
 * same model, nothing changed in the prompt — yet the cache read did not grow past
 * what the previous turn wrote, so the whole history was re-written again.
 * `entry` / `prevEntry` are usage-stats records; the first turn of a chat (or after a
 * proxy restart) never counts.
 */
export function cacheAnomaly(entry, prevEntry) {
    if (!entry?.ok || !prevEntry?.ok) return false;
    if (cacheExpired(entry, prevEntry)) return false; // expired, not broken
    const d = entry.cacheDiag;
    if (!d || d.firstTurn || !prevEntry.cacheDiag?.chat || prevEntry.cacheDiag.chat !== d.chat) return false;
    if (d.systemChanged) return false;
    if (d.historyDiffAt !== null && d.historyDiffAt !== undefined) return false;
    if (entry.model !== prevEntry.model) return false;
    return (entry.cacheReadTokens ?? 0) < (prevEntry.cacheReadTokens ?? 0) + 0.5 * (prevEntry.cacheCreationTokens ?? 0);
}

// 审: 设置没动系统提示词却变了时，指出可疑脚本（状态卡片与诊断报告共用）。
/**
 * The system prompt changed while SillyTavern's setup (preset, entries, post-processing, triggered
 * world info) stayed the same and the panel saw scripts / regexes running that rewrite prompts:
 * those scripts, as suspects. Null when something else explains the change (lore moved, post-history
 * entries, another preset, an edited message), when nothing such runs, or when the world info list
 * can't be trusted (old SillyTavern without WORLD_INFO_ACTIVATED). The status card and the report share it.
 */
export function scriptSuspects(entry, prevEntry) {
    const d = entry?.cacheDiag;
    const a = prevEntry?.st;
    const b = entry?.st;
    if (!d || d.firstTurn || d.reroll || d.rewrite || d.loreMoved?.length || d.tailRewritten || !d.systemChanged) return null;
    if (d.historyDiffAt !== null && d.historyDiffAt !== undefined) return null;
    if (!a || !b || !Array.isArray(b.mut) || !b.mut.length || a.wiOff || b.wiOff) return null;
    const chat = (e) => e.chatKey ?? e.cacheDiag?.chat;
    if (!chat(entry) || chat(entry) !== chat(prevEntry)) return null;
    const same = a.preset === b.preset && a.order === b.order && a.pp === b.pp && JSON.stringify(a.wi ?? []) === JSON.stringify(b.wi ?? []);
    return same ? b.mut : null;
}

// Subscription weights measured on 2026-10-08 (Opus 4.6, 1 h cache, one run): output ≈ 4× a cache
// write, a read ≈ 1/36 of a write. Only for comparing the parts of one turn, never turned into money.
// 审: 订阅额度权重常量，仅 quotaParts 与 usage-stats 使用。
export const QUOTA_WEIGHT = { output: 4, write: 1, read: 1 / 36 };

// 审: 把一轮的订阅额度拆成 输出/写/读 三份（面板「花在」用）。
/** What a turn spent of the subscription, by part (input not cached counts as a write). */
export function quotaParts(e) {
    return {
        output: QUOTA_WEIGHT.output * (e?.outputTokens ?? 0),
        write: QUOTA_WEIGHT.write * ((e?.cacheCreationTokens ?? 0) + (e?.inputTokens ?? 0)),
        read: QUOTA_WEIGHT.read * (e?.cacheReadTokens ?? 0),
    };
}

// 审: 判定本轮缓存状态 ok/part/full/first/expired/reroll（usage-stats 与 explainCache 用）。
/**
 * Was the cache healthy this turn: how much of what the previous turn sent was read back.
 * The plain hit rate (read ÷ everything sent) drops with every long reply even when the cache
 * works, so it is not the verdict.
 * @returns {{ state: 'ok'|'part'|'full'|'first'|'expired'|'reroll', reusePct: number|null }}
 */
export function cacheState(entry, prevEntry = null) {
    const d = entry?.cacheDiag;
    if (!d || d.firstTurn) return { state: 'first', reusePct: null };
    if (d.reroll) return { state: 'reroll', reusePct: null };
    if (prevEntry?.ok && cacheExpired(entry, prevEntry)) return { state: 'expired', reusePct: 0 };
    const read = entry.cacheReadTokens ?? 0;
    const prevTotal = prevEntry?.ok ? (prevEntry.cacheReadTokens ?? 0) + (prevEntry.cacheCreationTokens ?? 0) + (prevEntry.inputTokens ?? 0) : 0;
    const base = prevTotal || read + (entry.cacheCreationTokens ?? 0) + (entry.inputTokens ?? 0);
    const reusePct = base ? Math.min(100, Math.round((read / base) * 100)) : 0;
    return { state: reusePct >= 95 ? 'ok' : reusePct >= 30 ? 'part' : 'full', reusePct };
}

// 审: 找出把某条旧回复改短的深度正则名，只被 explainCache 用；测试直接引用所以保留 export。
/** The depth regex (the panel's [name, minDepth] list) that reached a reply at `depth`: the deepest
 *  minDepth not below it — the one it just crossed. Named short: its 「[2]」-style number if the name
 *  has one, else the start of the name. Null when none fits. */
export function depthRegexAt(list, depth) {
    if (!Array.isArray(list) || !Number.isFinite(depth)) return null;
    let best = null;
    for (const r of list) {
        if (!Array.isArray(r) || typeof r[0] !== 'string' || !Number.isFinite(r[1]) || r[1] > depth) continue;
        if (!best || r[1] > best[1]) best = r;
    }
    if (!best) return null;
    return best[0].match(/\[[^\]\s]{1,4}\]/)?.[0] ?? `「${best[0].slice(0, 6)}」`;
}

// 审: cacheState 状态码对应的面板标题。
const STATE_TITLE = { ok: '缓存正常', part: '部分重写', full: '整段重写', first: '第一轮', expired: '缓存过期', reroll: '重新生成' };

// 审: 面板展示用的缓存说明（usage-stats 调用）；reasons[0] 是一句话原因。
/**
 * The last turn's cache in plain words, for the panel. `entry` / `prevEntry` are usage-stats
 * records (prevEntry: the request before it, if any). `reasons[0]` is the one-line why.
 */
export function explainCache(entry, prevEntry = null) {
    if (!entry?.ok) return null;
    const read = entry.cacheReadTokens ?? 0;
    const wrote = entry.cacheCreationTokens ?? 0;
    const total = read + wrote + (entry.inputTokens ?? 0);
    const hitPct = total ? Math.round((read / total) * 100) : 0;
    const { state, reusePct } = cacheState(entry, prevEntry);
    const d = entry.cacheDiag;
    const reasons = [];
    if (state === 'first') {
        reasons.push('先存进缓存，下一轮开始命中');
    } else {
        const suspects = scriptSuspects(entry, prevEntry);
        if (d.reroll) reasons.push(read >= wrote ? '全部命中，不算进统计' : '重新生成，但没命中');
        if (suspects) reasons.push(`你没改设置却变了，可能是脚本：${suspects.join('、')}`);
        // Another preset: its regexes no longer touch the old replies the same way either — the
        // whole request is new, nothing more to say about the history.
        const switched = !!prevEntry?.st?.preset && !!entry.st?.preset && prevEntry.st.preset !== entry.st.preset;
        if (d.systemChanged && switched) {
            reasons.push('换了预设，整段重写');
        } else if (d.systemChanged && d.loreMoved?.length) {
            reasons.push('新触发了世界书，这轮多写一次');
        } else if (d.systemChanged) {
            reasons.push(d.rewrite ? '换了预设，整段重写' : `设定在 ${d.systemDiffLabel ?? `第 ${d.systemDiffAt.toLocaleString()} 字`} 变了，这轮多写一次`);
            if (d.systemDiffLabel === '<world_info>' || /world|世界/.test(d.systemDiffLabel ?? '')) reasons.push('触发的世界书变了；开「世界书后移」可免');
        }
        if (d.historyDiffAt !== null && d.historyDiffAt !== undefined && !(d.systemChanged && switched)) {
            const floor = d.historyDiffAt + 1;
            const rx = d.summaryReplaced ? depthRegexAt(entry.st?.rx, d.cutDepth) : null;
            if (rx) reasons.push(`第 ${floor} 楼被正则${rx}改短，每轮重写 ${wrote >= 1000 ? `${Math.round(wrote / 1000)}k` : wrote}`);
            else if (d.summaryReplaced) reasons.push(`第 ${floor} 楼被预设正则改短了`);
            else if (d.replyChanged) reasons.push(entry.st?.mut?.length ? `第 ${floor} 楼变了：换了回复，或脚本改的` : `第 ${floor} 楼换了回复，从这楼起重写`);
            else reasons.push(`第 ${floor} 楼起变了：多半是正则改旧楼`);
        }
        if (d.tailRewritten) reasons.push('预设末尾的条目开关或改过，这轮多写一次');
        if (prevEntry?.ok && prevEntry.effort !== undefined && entry.effort !== undefined && prevEntry.effort !== entry.effort) reasons.push('推理强度变了，这轮多写一次');
        if (prevEntry && prevEntry.model !== entry.model) reasons.push('换了模型，整段重写');
        const expired = prevEntry?.ok ? cacheExpired(entry, prevEntry) : null;
        if (expired) reasons.push(expired.ttl === '5m' ? '只存了 5 分钟，已过期' : `隔了 ${expired.gapMin} 分钟，超过 1 小时`);
        else if (entry.cacheTtl === '5m') reasons.push('缓存只给 5 分钟：可能在用超额');
        if (cacheAnomaly(entry, prevEntry)) reasons.push('内容没变却没读到，请导出诊断');
        if (!reasons.length) reasons.push(read > 0 ? '该命中的都命中了' : '内容没变却没命中，请导出诊断');
    }
    const q = quotaParts(entry);
    return {
        read, wrote, hitPct, reusePct, state, title: STATE_TITLE[state],
        quota: q, cost: costParts(entry), usd: apiValueUsd(entry),
        firstTurn: state === 'first',
        headline: `读取缓存 ${k(read)} · 重新写入 ${k(wrote)} · 复用 ${reusePct ?? '–'}%`,
        reasons,
    };
}

// 审: 测试接缝，清空各聊天的上一轮记录。
/** Test seam. */
export function __resetCacheDiag() {
    previous.clear();
}
