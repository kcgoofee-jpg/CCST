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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { extractVolatileBlocks } from './lore-tail.js';
import { contentToText } from '../core/system-prompt.js';
import { DATA_DIR } from '../paths.js';
import { cacheWriteMultiplier } from '../../shared/backends.js';

const MAX_CHATS = 6;
// Below this the static part isn't worth a cache breakpoint (Opus 5.5's
// minimum cacheable prompt is 512 tokens; ~1500 CJK characters is safely above).
const MIN_STATIC_CHARS = 1500;
// How many recent turns decide the split point (see diagnoseCache).
const SPLIT_WINDOW = 3;
const previous = new Map(); // chatKey → { system, history: string[], splitAt: number|null, cuts: (number|null)[], changes: {tag: count} }
const undo = new WeakMap(); // diagnosis → the chat's state before it (discardDiag)
// Blocks that look like world info count as volatile after one change; any
// other tag after two (a one-off preset toggle shouldn't move a block for good).
const LORE_TAG = /world|lore|世界|设定集|worldinfo/i;
// The wrappers presets put around SillyTavern's activated world info.
const WORLD_INFO_WRAPPERS = ['Lore', 'lore', 'world_info', 'worldInfo', 'WorldInfo', 'world_info_before', 'world_info_after'];
const MAX_VOLATILE_SHARE = 0.6; // world info can be ~40% of a long preset (measured 38k of 96k); a preset's all-enclosing wrapper is ~90%+

/** The outermost enclosing tag at `offset` whose whole block is small
 *  enough to move (not the preset's all-enclosing wrapper). */
function movableTag(text, offset) {
    for (const t of openTags(text, offset)) {
        const close = text.indexOf(`</${t.name}>`, offset);
        if (close < 0) continue;
        if (close - t.at <= MAX_VOLATILE_SHARE * text.length) return t.name;
    }
    return null;
}

/** Tag names that changed often enough in this chat to be moved to the turn. */
function volatileTags(changes) {
    return Object.entries(changes ?? {})
        .filter(([name, n]) => n >= (LORE_TAG.test(name) ? 1 : 2))
        .map(([name]) => name)
        .slice(0, 3);
}

const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);

// What was learned per chat survives a proxy restart: which tags keep
// changing and where the system prompt is split — tag names, counts and an
// offset keyed by the chat's hash, no chat text. Without it every restart
// cost one full re-write of the conversation while the proxy re-learned
// (measured: 171k tokens on 母畜庄园).
const MAX_REMEMBERED = 30;
function memoryFile() {
    if (process.env.CLAUDE_SUBSCRIPTION_CACHE_MEMORY_FILE) return process.env.CLAUDE_SUBSCRIPTION_CACHE_MEMORY_FILE;
    if (process.env.NODE_TEST_CONTEXT) return null; // unit tests never touch the real file
    return join(DATA_DIR, 'cache-memory.json');
}
let remembered = null; // chatKey → { changes, splitAt, at }
function loadMemory() {
    if (remembered) return remembered;
    remembered = new Map();
    const f = memoryFile();
    try {
        if (f && f !== 'off' && existsSync(f)) {
            for (const [k, v] of Object.entries(JSON.parse(readFileSync(f, 'utf8')))) remembered.set(k, v);
        }
    } catch { /* unreadable: start fresh */ }
    return remembered;
}
function remember(key, changes, splitAt) {
    const mem = loadMemory();
    const tags = Object.fromEntries(Object.entries(changes ?? {}).filter(([name]) => /^[\w\u4e00-\u9fff:.-]{1,40}$/.test(name)));
    mem.delete(key);
    mem.set(key, { changes: tags, splitAt: Number.isFinite(splitAt) ? splitAt : null, at: Date.now() });
    while (mem.size > MAX_REMEMBERED) mem.delete(mem.keys().next().value);
    const f = memoryFile();
    if (!f || f === 'off') return;
    try {
        mkdirSync(dirname(f), { recursive: true });
        // Whole-file write then rename: a proxy killed mid-write would leave
        // half a JSON here, and loadMemory reads it at startup as "unreadable,
        // start fresh" — every chat loses its learned split point.
        const tmp = `${f}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(Object.fromEntries(mem)));
        renameSync(tmp, f);
    } catch { /* best effort */ }
}

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

function firstDiff(a, b) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    return i === n && a.length === b.length ? -1 : i;
}

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

export const HEADING_LABEL = '某个标题段落';
export const LORE_HEADING_LABEL = '世界书标题段落';

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

/**
 * @param {string} systemText  the system prompt as sent to Claude
 * @param {Array} history      non-system messages (history + current turn)
 * @param {{ moveVolatile?: boolean }} [opts]  the volatile blocks are moved out
 *        of the system prompt before sending (lore tail): place the split in
 *        the prompt as sent, not as received
 * @returns {object|null} diagnosis, or null on the first turn of a chat
 */
export function diagnoseCache(systemText, history, { moveVolatile = false, chatKey = null } = {}) {
    const system = systemText ?? '';
    const texts = history.map((m) => `${m.role}:${contentToText(m.content)}`);
    // The panel's chat id when it sent one: the opening of the first user
    // message changes while injections are merged onto it.
    const key = chatKey ? `p${chatKey}`.slice(0, 13) : chatKeyOf(texts);
    const prev = previous.get(key);
    const learned = prev ? null : loadMemory().get(key);

    const diffAt = prev ? firstDiff(prev.system, system) : -1;
    // Switching presets replaces most of the prompt. That turn misses anyway;
    // remembering its early cut would pin the split there for SPLIT_WINDOW
    // turns and rewrite the unchanged middle each time (measured: 50k chars ×
    // 3 turns after 通用 → 庄园). Start the split history over instead.
    const rewrite = diffAt >= 0 && isRewrite(prev.system, system);

    // Split point for the system prompt: the start of the enclosing tag (or
    // line) where it changed, taken as the EARLIEST such point over the last
    // SPLIT_WINDOW turns. Parts that change every turn keep the split in
    // place (so the static part stays byte-identical and hits the cache); a
    // one-off early edit — the user flipping a preset toggle — only pulls the
    // split forward for a few turns instead of pinning it there for good.
    const changes = { ...(prev?.changes ?? learned?.changes ?? {}) };
    // A chat we know nothing about yet: SillyTavern's world info wrappers
    // change with the keywords of almost every turn, so treat them as
    // volatile from the first turn instead of learning it from a miss.
    // (Measured on 母畜庄园: learning <Lore> then <world_info> cost two full
    // re-writes of ~250k tokens each, for every new chat.)
    if (!prev && !learned && moveVolatile) {
        for (const tag of WORLD_INFO_WRAPPERS) {
            if (system.includes(`<${tag}>`) && system.includes(`</${tag}>`)) changes[tag] = changes[tag] ?? 1;
        }
    }
    if (diffAt >= 0 && !rewrite) {
        const tag = movableTag(system, diffAt);
        if (tag) changes[tag] = (changes[tag] ?? 0) + 1;
    }
    // With the volatile blocks moved out, the prompt that is sent has a fixed
    // placeholder where they were: a change inside them is no reason to split,
    // and offsets must be those of the prompt as sent. (Measured: split points
    // taken from the received prompt drifted when a persona edit shifted the
    // world info by 30 characters, and each drift re-wrote 210k tokens.)
    const moved = moveVolatile ? volatileTags(changes) : [];
    const asSent = (text) => (moved.length ? extractVolatileBlocks(text, moved).system : text);
    const sentSystem = asSent(system);
    const sentDiffAt = !prev ? -1 : moved.length ? firstDiff(asSent(prev.system), sentSystem) : diffAt;
    const recent = rewrite ? [] : (prev?.cuts ?? []).slice(-(SPLIT_WINDOW - 1));
    if (rewrite) {
        // no cut: the new prompt's own changes decide the split from the next turn
    } else if (sentDiffAt >= 0) {
        // Snap to the start of the innermost enclosing tag: a keyword-triggered
        // section (<world_info>) reorders from turn to turn, so the first
        // differing byte wanders around inside it and a line-based split
        // would creep earlier each turn — each move costing a full miss.
        const tags = openTags(sentSystem, sentDiffAt);
        const tagStart = tags.length ? tags[tags.length - 1].at : sentDiffAt;
        recent.push(sentSystem.lastIndexOf('\n', tagStart - 1) + 1);
    } else if (prev) {
        recent.push(null); // unchanged turn: no new constraint
    }
    const cutPoints = recent.filter((c) => c !== null);
    let splitAt = cutPoints.length ? Math.min(...cutPoints) : rewrite ? null : (prev?.splitAt ?? learned?.splitAt ?? null);
    if (splitAt !== null && (splitAt < MIN_STATIC_CHARS || splitAt > sentSystem.length)) splitAt = null;

    const state = { system, history: texts, splitAt, cuts: recent, changes };
    previous.delete(key);
    previous.set(key, state);
    while (previous.size > MAX_CHATS) previous.delete(previous.keys().next().value);
    remember(key, changes, splitAt);

    // First turn since the proxy started: nothing to compare with, but what
    // was learned about this chat before the restart still applies.
    if (!prev) {
        const first = { chat: key, firstTurn: true, systemChars: system.length, splitAt: learned ? splitAt : null, volatileTags: learned || moved.length ? volatileTags(changes) : [], ...(learned ? { remembered: true } : {}) };
        undo.set(first, { key, prev, learned, state });
        return first;
    }

    // History that existed last turn (minus the previous current message,
    // which is normally replaced by the reply + new input) should be stable.
    const comparable = Math.max(0, prev.history.length - 1);
    let historyDiffAt = -1;
    for (let i = 0; i < comparable && i < texts.length; i++) {
        if (prev.history[i] !== texts[i]) { historyDiffAt = i; break; }
    }
    // Reroll / swipe: the same conversation sent again (the discarded reply
    // is not part of it). Reads back almost everything, so it says nothing
    // about what a new turn costs — reports keep it apart.
    const reroll = texts.length === prev.history.length && texts.every((t, i) => t === prev.history[i]);
    // A reply that differs from the one sent last turn: the player picked
    // another swipe (or edited the reply). Everything after it is re-written.
    const replyChanged = historyDiffAt >= 0 && texts[historyDiffAt]?.startsWith('assistant:');
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
        ...(rewrite ? { rewrite: true } : {}),
        splitAt,
        volatileTags: volatileTags(changes),
    };
    undo.set(diag, { key, prev, learned, state });
    return diag;
}

/** The request failed: nothing reached the cache, so the next one (a resend) is compared with the
 *  last request that went through, not with this one — else a resend reads as a reroll. */
export function discardDiag(diag) {
    const u = diag && undo.get(diag);
    if (!u) return;
    undo.delete(diag);
    if (previous.get(u.key) !== u.state) return; // a newer request of this chat came in meanwhile
    previous.delete(u.key);
    if (u.prev) previous.set(u.key, u.prev);
    const back = u.prev ?? u.learned;
    if (back) remember(u.key, back.changes, back.splitAt);
}

/** One human-readable line for the proxy log. */
export function describeDiag(d) {
    if (!d) return null;
    if (d.firstTurn && d.remembered) return `缓存诊断：代理重启后这个聊天的第一轮，沿用之前学到的${d.volatileTags.length ? `（每轮变化的 ${d.volatileTags.map((t) => `<${t}>`).join('、')}）` : ''}，下一轮开始对比`;
    if (d.firstTurn) return `缓存诊断：本聊天第一轮（系统提示词 ${d.systemChars.toLocaleString()} 字）${d.volatileTags?.length ? `，世界书 ${d.volatileTags.map((t) => `<${t}>`).join('、')} 一开始就移到消息里` : ''}，下一轮开始对比`;
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
            : `聊天记录从第 ${d.historyDiffAt + 1} / ${d.historyLen} 条开始与上一轮不同（正则改写旧楼层、删改消息会造成）`);
    }
    return `缓存诊断：${parts.join('；')}`;
}

const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/**
 * One request's cost in "equivalent input tokens" at Anthropic's list-price
 * ratios (same for every current Claude model): cache read 0.1×, cache
 * write by TTL (shared/backends.js cacheWriteMultiplier), output 5×. Subscription
 * quota accounting is not public; this is for comparing turns, presets and settings.
 */
export function equivalentTokens(e) {
    const p = costParts(e);
    return Math.round(p.write + p.output + p.read + p.input);
}

/** equivalentTokens split by what it paid for (the panel's 「花在」). Output includes thinking. */
export function costParts(e) {
    return {
        write: Math.round(cacheWriteMultiplier(e.cacheTtl) * (e.cacheCreationTokens ?? 0)),
        output: 5 * (e.outputTokens ?? 0),
        read: Math.round(0.1 * (e.cacheReadTokens ?? 0)),
        input: e.inputTokens ?? 0,
    };
}

/**
 * The turn replay (turn-capture.js) stopped matching what the CLI sends: same chat,
 * same model, nothing changed in the prompt — yet the cache read did not grow past
 * what the previous turn wrote, so the whole history was re-written again.
 * `entry` / `prevEntry` are usage-stats records; the first turn of a chat (or after a
 * proxy restart) never counts.
 */
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

/**
 * Plain-Chinese explanation of one recorded request's cache outcome, for the
 * panel. `entry` / `prevEntry` are usage-stats records (prevEntry: the
 * request before it, if any).
 * @returns {{ read: number, wrote: number, hitPct: number, headline: string, reasons: string[] } | null}
 */
export function explainCache(entry, prevEntry = null) {
    if (!entry?.ok) return null;
    const read = entry.cacheReadTokens ?? 0;
    const wrote = entry.cacheCreationTokens ?? 0;
    const total = read + wrote + (entry.inputTokens ?? 0);
    const hitPct = total ? Math.round((read / total) * 100) : 0;
    const d = entry.cacheDiag;
    const reasons = [];
    if (!d || d.firstTurn) {
        reasons.push('本聊天的第一轮（或代理刚重启）：整段写入缓存，下一轮起才能读取。');
    } else {
        if (d.systemChanged && d.loreMoved?.length) {
            reasons.push(`${d.loreMoved.map((t) => `<${t}>`).join('、')} 每轮随剧情变化，已自动移到本轮消息开头：系统提示词和之前的聊天记录照常读缓存，只重写最近一轮。`);
        } else if (d.systemChanged) {
            const where = `第 ${d.systemDiffAt.toLocaleString()} 字${d.systemDiffLabel ? `（${d.systemDiffLabel} 内）` : ''}`;
            reasons.push(`系统提示词在${where}变了，这一轮整段重写（Claude Code 把系统提示词作为一整块缓存，改一个字就整段读不到）。常见原因：改了预设开关或角色卡、世界书按关键词触发、随机宏或每轮变化的变量。一次性的改动，下一轮起恢复。`);
            if (d.systemDiffLabel === '<world_info>' || /world|世界/.test(d.systemDiffLabel ?? '')) {
                reasons.push('世界书按关键词触发，每轮载入的条目不同，它后面的整段聊天记录都要重写。把这张卡的世界书条目改成常驻，聊天记录就能每轮读缓存（实测每轮写入从约 2.8 万降到约 3 千 token）。');
            }
        }
        if (d.historyDiffAt !== null && d.historyDiffAt !== undefined) {
            reasons.push(d.replyChanged
                ? `第 ${d.historyDiffAt + 1} 条回复和上一轮发的不同：切换了回复分支（swipe）或编辑了这条回复，从这里往后重写一次，属正常现象。${entry.st?.mut?.length ? `你没切换也没编辑的话，可能是预设或角色卡里的脚本改了它（这一轮启用着：${entry.st.mut.join('、')}）。` : ''}`
                : `聊天记录从第 ${d.historyDiffAt + 1} / ${d.historyLen} 条起和上一轮不同，之后全部重写。常见原因：预设正则按楼层改写旧消息（如「5 楼外只发摘要」）；「深度注入保持原位」打开时，深度注入每轮往后挪一格；或删改了消息。`);
        }
        // Nothing changed in SillyTavern yet the system prompt did: maybe a script of the preset / card (Izumi's 悬浮窗).
        const suspects = scriptSuspects(entry, prevEntry);
        if (suspects) {
            reasons.unshift(`酒馆里的设置没变，提示词却变了：可能是预设或角色卡里的脚本 / 正则在发送时改写了内容（这一轮启用着：${suspects.join('、')}）。刚改过角色卡、用户设定或作者注释的话，就是那次改动。`);
        }
        if (d.tailRewritten) {
            reasons.push(`预设放在聊天记录后面的条目变了（开关或编辑）：之前 ${d.tailRewritten} 轮里带的旧版本已换成新版本，聊天记录重写这一次，下一轮恢复。`);
        }
        if (prevEntry?.ok && prevEntry.effort !== undefined && entry.effort !== undefined && prevEntry.effort !== entry.effort) {
            reasons.push('思考深度和上一轮不同：系统提示词的缓存保留，聊天记录部分要重写一次。');
        }
        if (prevEntry && prevEntry.model !== entry.model) {
            reasons.push('模型和上一轮不同：缓存按模型分开，换模型要重新写入。');
        }
        // Self-check for the turn replay (turn-capture.js): same chat, nothing
        // changed, yet the read did not grow past last turn's prompt — the
        // history is being re-written again. Most likely a CLI update changed
        // how it attaches its per-turn reminders.
        const expired = prevEntry?.ok ? cacheExpired(entry, prevEntry) : null;
        if (expired) {
            reasons.push(expired.ttl === '5m'
                ? `距上一轮开始已过 ${expired.gapMin} 分钟，上一轮的缓存只按 5 分钟写入（订阅额度用超、开始扣额外用量时 Claude Code 会这样做），已经过期，这一轮整段重写。5.2.1 起代理固定要求 1 小时；更新后仍看到这条，检查环境变量 CLAUDE_CODE_PROMPT_CACHE_TTL / FORCE_PROMPT_CACHING_5M。`
                : `距上一轮开始已过 ${expired.gapMin} 分钟，超过了 1 小时的缓存有效期，这一轮整段重写，属正常现象。`);
        } else if (entry.cacheTtl === '5m') {
            reasons.push('这一轮的缓存只按 5 分钟写入（多半是订阅额度用超、在扣额外用量）：下一轮若在 5 分钟后才发（长回复加阅读时间通常会超过），就读不到了。5.2.1 起代理固定要求 1 小时；仍看到这条请检查环境变量 CLAUDE_CODE_PROMPT_CACHE_TTL / FORCE_PROMPT_CACHING_5M。');
        }
        if (cacheAnomaly(entry, prevEntry)) {
            reasons.push('异常：系统提示词和聊天记录都没变、也没过缓存有效期，聊天记录却没读到缓存，代理的「逐轮还原」可能失效了（连着两轮会自动重置一次）。持续出现的话，在 CCST 文件夹运行 node scripts/wire-diagnosis.mjs，把输出发给维护者。刚重启过代理的第一轮除外。');
        }
        if (d.reroll) {
            reasons.unshift('这是重roll：聊天记录和上一次请求一样，几乎全部读缓存。它不代表正常新一轮的开销，统计里的命中率不算它。');
        }
        if (!reasons.length) {
            reasons.push(read > 0
                ? '系统提示词和聊天记录都和上一轮一致，只写入了新增的内容。'
                : '内容和上一轮一致却没读到缓存。');
        }
    }
    const equiv = equivalentTokens(entry);
    const noCache = equivalentTokens({ inputTokens: total, outputTokens: entry.outputTokens });
    reasons.push(`「花在」按 API 价格比例折算成等效输入 token：读缓存 0.1 倍、写缓存 ${entry.cacheTtl === '5m' ? '1.25' : '2'} 倍、输出（含思考）5 倍；完全不用缓存约 ${k(noCache)}。订阅额度怎么扣官方未公开，适合前后对比。`);
    return { read, wrote, hitPct, equiv, cost: costParts(entry), firstTurn: !d || !!d.firstTurn, headline: `读取缓存 ${k(read)} · 重新写入 ${k(wrote)} · 命中 ${hitPct}% · 约 ${k(equiv)} 等效`, reasons };
}

/** Test seam. */
export function __resetCacheDiag() {
    previous.clear();
    remembered = null;
}
