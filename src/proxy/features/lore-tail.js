// ──────────────────────────────────────────────
// Keyword-triggered world info → the current turn (README「世界书移到本轮消息」)
// ──────────────────────────────────────────────
//
// Keyword-triggered world info changes the system prompt almost every turn,
// and Claude's cache is a prefix: one changed byte in the system prompt and
// the whole chat history after it is written to the cache again (measured:
// ~110k tokens per turn on a long chat, 42 of 150 turns in one day).
//
// Which entries fired is SillyTavern's decision, never ours: the panel sends
// the text of this turn's keyword-triggered entries placed before / after
// the character (constant entries are never sent, so they never move). Here
// those texts leave the system prompt and go to the top of the player's
// message, marked as setting material. The system prompt and every earlier
// turn are then byte-identical to last turn and read back from the cache.
// An entry already given in one of the last LORE_WINDOW player messages is
// not repeated; one given longer ago is sent again in full, so an entry that
// keeps firing stays near the current turn.

import { swapVersions, turnKey } from './turn-capture.js';

// 审: 注入世界书块末尾的说明句，告诉模型这不是用户发言；仅测试另外引用 export。
export const TAIL_NOTE = '（以上是本轮按剧情触发的设定资料，来自系统设定，不是用户的发言。）';

// 审: 在消息内容（字符串或块数组）最前面加一段文字。
function prefixContent(content, prefix) {
    if (typeof content === 'string') return `${prefix}\n\n${content}`;
    if (Array.isArray(content)) return [{ type: 'text', text: prefix }, ...content];
    return prefix;
}

// 审: 决定世界书放在哪条 user 消息上（连续 user 末段的第一条），chat.js 与本文件用。
/**
 * Which user message the lore goes on: the first of the trailing run of user
 * messages. A card's depth-0 user-role world info (MVU update rules, …) is
 * appended after the player's message and is gone from next turn's history;
 * lore put there would have to be sent in full every turn. The player's
 * message stays, so its lore stays in the cached history and only new lines
 * are added next turn.
 * @param {Array<{role: string}>} history non-system messages
 */
export function loreTarget(history) {
    let idx = history.findLastIndex((m) => m?.role === 'user');
    while (idx > 0 && history[idx - 1]?.role === 'user') idx--;
    return idx;
}

// 审: 把提出的世界书块放到玩家最新消息顶部（chat.js 用）。
/**
 * Put the extracted blocks at the top of the player's latest message
 * (see loreTarget; before a trailing assistant prefill, if any).
 * @param {Array<{role: string, content: any}>} history non-system messages
 */
export function injectBlocks(history, blocks) {
    if (!blocks.length) return history;
    const idx = loreTarget(history);
    if (idx < 0) return history;
    const prefix = `${blocks.map((b) => `<${b.tag}>\n${b.text}\n</${b.tag}>`).join('\n\n')}\n${TAIL_NOTE}`;
    const out = history.slice();
    out[idx] = { ...out[idx], content: prefixContent(out[idx].content, prefix) };
    return out;
}

// 审: 重复段落的一行替代说明，system-placement.js 也引用。
export const REPEAT_NOTE = '（这段与之前某轮随发言给出的内容完全相同，不再重复，以那里为准。）';
// 审: 短于此长度的段落不做"重复折叠"，避免误折。
const MIN_REPEAT_CHARS = 200;

// 审: 把卡片深度 0 的 user 注入折进玩家消息，避免缓存断点落在下轮消失的消息上（chat.js 用）。
/**
 * Fold a card's depth-0 user-role injections (the messages after the
 * player's) into the player's message. The CLI's message-level cache point
 * sits on the last message; while that is an injection that is gone next
 * turn, no earlier cache entry ever matches and the whole chat history is
 * written again every turn (measured: ~39k tokens per turn on 母畜庄园).
 * Folded, the player's message is last, is replayed as sent next turn, and
 * the history stays cached. An injection section ('---'-separated) already
 * given verbatim in an earlier turn is replaced by a one-line note, so fixed
 * rules are not repeated every turn; changing ones (variable state) are kept.
 * @param {Array<{role: string, content: any}>} history non-system messages
 * @param {string[]} earlierTexts earlier player messages as sent
 * @returns {{ history: Array, folded: number, repeated: number }}
 */
export function foldTrailingInjections(history, earlierTexts = []) {
    const target = loreTarget(history);
    const last = history.findLastIndex((m) => m?.role === 'user');
    if (target < 0 || target === last) return { history, folded: 0, repeated: 0 };
    const run = history.slice(target, last + 1);
    if (run.some((m) => typeof m.content !== 'string')) return { history, folded: 0, repeated: 0 };
    const seen = earlierTexts.join('\n');
    let repeated = 0;
    const extra = run.slice(1).map((m) => m.content.split(/\n(?=---\s*\n)/).map((part) => {
        const t = part.trim();
        if (t.length >= MIN_REPEAT_CHARS && seen.includes(t)) { repeated++; return REPEAT_NOTE; }
        return part;
    }).join('\n'));
    const out = history.slice(0, target);
    out.push({ ...history[target], content: [history[target].content, ...extra].join('\n\n') });
    out.push(...history.slice(last + 1));
    return { history: out, folded: run.length - 1, repeated };
}

// Messages the lore was put on that are not the SDK's current turn (the
// player's message when an injection follows it): next turn ST sends them
// back without the lore, so they are re-sent the way they went out. In memory
// only, like turn captures; after a restart one turn is written again. Keyed
// like turn captures — text plus the reply it answers (turn-capture.js
// replyBefore) — so a repeated 「继续」 or the same line in another chat never
// gets this message's lore.
// 审: 带世界书发出的消息原文→实际发送文本（仅内存），下轮按原样重放。
const injected = new Map();
// 审: injected 最多留 200 条。
const MAX_INJECTED = 200;

// 审: 记下某条历史消息带世界书发出的样子（chat.js 用）。
/** Remember how a history message was sent with lore on it. */
export function rememberInjected(raw, sent, context = '') {
    if (typeof raw !== 'string' || typeof sent !== 'string') return;
    const key = turnKey(raw, context);
    injected.delete(key);
    injected.set(key, sent);
    while (injected.size > MAX_INJECTED) injected.delete(injected.keys().next().value);
}

// 审: 取某条历史消息当时实际发出的文本（chat.js 用）。
/** The text a history message was sent with, if lore was put on it. */
export function injectedTextFor(raw, context = '') {
    return typeof raw === 'string' ? injected.get(turnKey(raw, context)) ?? null : null;
}

// 审: 按条目原文把关键词世界书从系统提示词里剪出来（chat.js、panel/settings 用）。
/**
 * Lift keyword-triggered world info out of the system prompt by its exact
 * text (the panel sends the text of each triggered entry placed before /
 * after the character). Many presets put world info in the system prompt
 * without a wrapping tag, so each change of the triggered set re-wrote the whole conversation.
 * @param {string} system
 * @param {string[]} texts
 * @returns {{ system: string, text: string }}  text: what was lifted ('' if none)
 */
export function cutExactLore(system, texts, wiFormat = '') {
    let out = system ?? '';
    const found = [];
    for (const t of texts ?? []) {
        if (typeof t !== 'string' || t.length < 20) continue;
        // SillyTavern joins entries with one newline: take the entry with one
        // of its joins, so the rest reads as if it had never fired.
        const piece = out.includes(`${t}\n`) ? `${t}\n` : out.includes(`\n${t}`) ? `\n${t}` : t;
        const i = out.indexOf(piece);
        if (i < 0) continue;
        out = cutAt(out, i, piece.length);
        found.push(t);
    }
    if (!found.length) return { system: system ?? '', text: '' };
    // SillyTavern wraps the entries in its world-info format (「[Details of the fictional world the RP
    // is set in:\n{0}]」). With every entry moved the wrapper is left empty, where a turn with nothing
    // triggered has no wrapper at all (measured: 52 characters that made every such turn miss).
    const [pre, post] = String(wiFormat ?? '').split('{0}');
    if (post !== undefined && (pre.trim() || post.trim())) {
        for (const empty of new Set([pre + post, pre.replace(/\n+$/, '') + post, pre + post.replace(/^\n+/, ''), pre.replace(/\n+$/, '') + post.replace(/^\n+/, '')])) {
            if (!empty.trim() || (system ?? '').includes(empty)) continue;
            for (let i = out.indexOf(empty); i >= 0; i = out.indexOf(empty)) out = cutAt(out, i, empty.length);
        }
    }
    return { system: out, text: found.join('\n\n') };
}

// 审: 从 text 剪掉一段，并清理残留的空行，使提示词和没触发的轮完全一致。
/** Remove `len` characters at `i`. When the piece was a whole system message (joined to its
 *  neighbours by a blank line), drop that join too, so the prompt reads as on a turn where nothing
 *  fired (measured: one stray newline made every such turn miss the whole cache). */
function cutAt(text, i, len) {
    const before = text.slice(0, i);
    let after = text.slice(i + len);
    const lead = before.length - before.replace(/\n+$/, '').length;
    const trail = after.length - after.replace(/^\n+/, '').length;
    if (lead + trail > 2) after = after.slice(Math.min(trail, lead + trail - 2));
    return before + after;
}

// 审: 世界书块的标签名，chat.js 构造块时用。
export const TRIGGERED_TAG = 'triggered_lore';

// 审: 把所有已记住消息里旧版本的文字换成新版本（chat.js 用）。
/** Replace `from` (one text or several versions) with `to` in every remembered message (see rewriteCaptured). */
export function rewriteInjected(from, to) {
    let n = 0;
    for (const [key, sent] of injected) {
        const now = swapVersions(sent, from, to);
        if (now !== sent) { injected.set(key, now); n++; }
    }
    return n;
}

// The preset's post-history entries (the system messages after the player's
// message) are merged into the player's message, and earlier turns are sent
// again as they went out — so the cache keeps working. When the user changes
// those entries (switches one off, edits it), every earlier turn would keep
// the old version for good (seen live: an output-format entry switched off
// still steered every reply; 灰烬之桥: the old and the new tail, with
// conflicting rules, in one request). A changed tail is a settings change when
// the preset's entries changed (the panel's order fingerprint), or — without
// a fingerprint — when the old tail had been the same for a few turns (per-turn
// content changes every turn). Then every earlier version this chat had is
// replaced with the new one, so the model never sees two versions of the
// preset's rules. That turn re-writes the history once; an edited entry before
// the history re-writes it anyway.
// 审: 短于此的尾部不记入替换列表。
const MIN_TAIL_CHARS = 200;
// 审: 旧尾部连续相同这么多轮才算"设置没变"，之后再变就判为用户改了设置。
const STABLE_TURNS = 2;
// 审: 最多跟踪 12 个聊天的尾部。
const MAX_TAIL_CHATS = 12;
// 审: 每个聊天最多留 8 个旧版本。
const MAX_TAIL_VERSIONS = 8;
// 审: 每个聊天的后置条目记录。
const tails = new Map(); // chat → { text, turns, order, old: earlier versions }

// 审: 记录本轮的后置条目，发现是设置改动就返回要替换的旧版本（chat.js 用）。
/**
 * @param {string|null} chat  chat key (cache-diag)
 * @param {string|null} tail  this turn's post-history text as merged
 * @param {{ order?: string|null, reroll?: boolean }} [opts]  order: the panel's
 *   fingerprint of the preset's entries; reroll: the same turn sent again (a
 *   continue's nudge is no settings change) — nothing is learned from it
 * @returns {{ from: string[], to: string } | null}  replace these versions, if the tail was changed
 */
export function noteTail(chat, tail, { order = null, reroll = false, preset = null } = {}) {
    if (!chat || typeof tail !== 'string' || reroll) return null;
    const rec = tails.get(chat);
    if (rec && rec.text === tail) {
        rec.turns++;
        if (order) rec.order = order;
        if (preset) rec.preset = preset;
        return null;
    }
    const edited = !!order && !!rec?.order && order !== rec.order;
    // Same entries, and the new tail is only the end of the old one: the end of
    // the chat history was not found (a short 「继续」), not a settings change.
    if (rec && order && order === rec.order && rec.text.endsWith(tail)) return null;
    const old = rec ? [...rec.old.filter((t) => t !== tail), rec.text].slice(-MAX_TAIL_VERSIONS) : [];
    tails.delete(chat);
    while (tails.size >= MAX_TAIL_CHATS) tails.delete(tails.keys().next().value);
    const from = old.filter((t) => t.length >= MIN_TAIL_CHARS);
    if (!rec || !from.length || (!edited && rec.turns < STABLE_TURNS)) {
        tails.set(chat, { text: tail, turns: 1, order, preset, old });
        return null;
    }
    // Replaced from here on: start the list over.
    tails.set(chat, { text: tail, turns: 1, order, preset, old: [] });
    return { from, to: tail };
}

// 审: 聊天换了预设时，返回旧预设留在历史里的尾部版本，好一起摘掉（chat.js 用）。
/**
 * The chat moved to another preset: the post-history versions noted under the old one, to take out
 * of earlier turns. SillyTavern never sends an old preset's entries again, but those turns went out
 * with them and are replayed as sent — after a switch from 灰烬之桥 to 果实 its 3.1 万字 of rules
 * stayed in the history, re-written with it every turn. Only on a turn whose system prompt changed
 * too (the whole request is re-written then anyway). Null when there is nothing to take out.
 * @returns {string[] | null}
 */
export function tailsOfOldPreset(chat, preset) {
    if (!chat || !preset) return null;
    const rec = tails.get(chat);
    if (!rec?.preset || rec.preset === preset) return null;
    tails.delete(chat);
    const from = [...rec.old, rec.text].filter((t) => t.length >= MIN_TAIL_CHARS);
    return from.length ? from : null;
}

// 审: 测试接缝，清空世界书与尾部记录。
/** Test seam. */
export function __resetInjected() {
    injected.clear();
    tails.clear();
}

// 审: 判断一行是否有实际文字（纯标记行如 `</money_scale>]` 没有）。
// A line that is only markup (`</money_scale>]`) says nothing on its own.
const hasWords = (l) => l.replace(/<\/?[^<>\n]{1,60}>/g, '').replace(/[\s[\]{}()（）【】"'“”,.，。:：;；|*#>-]/g, '').length >= 4;

// 审: 最近多少条玩家消息内给过的世界书行不再重复发；chat.js 与测试引用。
export const LORE_WINDOW = 10;

// 审: 去掉最近 LORE_WINDOW 条玩家消息里已给过的世界书行，只留新内容（chat.js 用）。
/**
 * Drop lore lines the model was given in one of the last LORE_WINDOW player
 * messages (those turns are replayed as sent, so their lore is still close
 * by). Lore given longer ago is sent again. Very short lines (separators,
 * bare headings) are kept so an entry doesn't lose its frame.
 * @param {{tag: string, text: string}[]} blocks
 * @param {string[]} earlierTexts  earlier user messages as sent, oldest first
 */
export function newLoreOnly(blocks, earlierTexts) {
    const seen = new Set();
    for (const t of earlierTexts.slice(-LORE_WINDOW)) for (const line of String(t).split('\n')) {
        const k = line.trim();
        if (k.length >= 4) seen.add(k);
    }
    const out = [];
    for (const b of blocks) {
        const lines = b.text.split('\n').filter((l) => l.trim().length < 4 || !seen.has(l.trim()));
        // Only closing tags left over (a block that shrank): nothing new to give.
        if (lines.some((l) => l.trim().length >= 4 && hasWords(l))) out.push({ tag: b.tag, text: lines.join('\n').trim() });
    }
    return out;
}
