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

export const TAIL_NOTE = '（以上是本轮按剧情触发的设定资料，来自系统设定，不是用户的发言。）';

function prefixContent(content, prefix) {
    if (typeof content === 'string') return `${prefix}\n\n${content}`;
    if (Array.isArray(content)) return [{ type: 'text', text: prefix }, ...content];
    return prefix;
}

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

export const REPEAT_NOTE = '（这段与之前某轮随发言给出的内容完全相同，不再重复，以那里为准。）';
const MIN_REPEAT_CHARS = 200;

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
const injected = new Map();
const MAX_INJECTED = 200;

/** Remember how a history message was sent with lore on it. */
export function rememberInjected(raw, sent, context = '') {
    if (typeof raw !== 'string' || typeof sent !== 'string') return;
    const key = turnKey(raw, context);
    injected.delete(key);
    injected.set(key, sent);
    while (injected.size > MAX_INJECTED) injected.delete(injected.keys().next().value);
}

/** The text a history message was sent with, if lore was put on it. */
export function injectedTextFor(raw, context = '') {
    return typeof raw === 'string' ? injected.get(turnKey(raw, context)) ?? null : null;
}

/**
 * Lift keyword-triggered world info out of the system prompt by its exact
 * text (the panel sends the text of each triggered entry placed before /
 * after the character). Many presets put world info in the system prompt
 * without a wrapping tag, so the tag-based learning above never finds it,
 * and each change of the triggered set re-wrote the whole conversation.
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
export const TRIGGERED_TAG = 'triggered_lore';

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
const MIN_TAIL_CHARS = 200;
const STABLE_TURNS = 2;
const MAX_TAIL_CHATS = 12;
const MAX_TAIL_VERSIONS = 8;
const tails = new Map(); // chat → { text, turns, order, old: earlier versions }

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

/** Test seam. */
export function __resetInjected() {
    injected.clear();
    tails.clear();
}

/**
 * Drop lore lines the model was given in one of the last LORE_WINDOW player
 * messages (those turns are replayed as sent, so their lore is still close
 * by). Lore given longer ago is sent again. Very short lines (separators,
 * bare headings) are kept so an entry doesn't lose its frame.
 * @param {{tag: string, text: string}[]} blocks
 * @param {string[]} earlierTexts  earlier user messages as sent, oldest first
 */
// A line that is only markup (`</money_scale>]`) says nothing on its own.
const hasWords = (l) => l.replace(/<\/?[^<>\n]{1,60}>/g, '').replace(/[\s[\]{}()（）【】"'“”,.，。:：;；|*#>-]/g, '').length >= 4;

export const LORE_WINDOW = 10;

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
