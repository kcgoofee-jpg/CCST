// ──────────────────────────────────────────────
// Where mid-conversation system messages go
// ──────────────────────────────────────────────
//
// SillyTavern sends depth-injected prompts (preset entries "at depth N",
// world info at depth, Author's Note) as role:system messages INSIDE the
// chat history. Hoisting all of them into the top-level system prompt
// (the old behavior) has two costs:
//   • the preset author placed them near the end on purpose — a style
//     reminder two messages from the end works much better than the same
//     text buried at the top;
//   • whenever one of them changes (a keyword-triggered lore entry comes or
//     goes), the system prompt changes and Claude's prompt cache misses for
//     the ENTIRE conversation.
//
// 'inline': every system message BEFORE the first real user message is part
// of the preset/card block and goes to the system prompt (so the whole
// block is cached); assistant messages inside that block (fake
// acknowledgements many presets use, the greeting) stay in history order.
// System messages after the first user message are depth injections: they
// become user text, merged into the neighboring user turn so roles still
// alternate — the same thing SillyTavern's own Claude converter does. Those
// deeper than the last reply are moved up to the current turn (see below).

import { contentToText } from '../core/system-prompt.js';
import { REPEAT_NOTE } from './lore-tail.js';

// 审: 把内容统一成 content-part 数组（合并 user 消息时用）。
function asParts(content) {
    if (Array.isArray(content)) return content;
    const text = typeof content === 'string' ? content : '';
    return text ? [{ type: 'text', text }] : [];
}

// 审: 合并相邻 user 消息的内容，保持角色交替；字符串用空行连接。
function mergeContent(a, b) {
    if (typeof a === 'string' && typeof b === 'string') {
        if (!a) return b;
        if (!b) return a;
        return `${a}\n\n${b}`;
    }
    return [...asParts(a), ...asParts(b)];
}

// 审: 按面板给的首尾标记把历史前后的非 system 条目改成系统文本，避免预设里的 user/assistant 条目被当成每轮注入（chat.js 使用）。
/**
 * Where the chat history starts and ends, from the panel's marks (the opening
 * text of the first and last chat messages). Without them the first user
 * message was taken for the start of the chat; presets that put user- or
 * assistant-role entries before the history (Kemini's 「雪融雪降」, Izumi's
 * 「指南」) then had the whole card and world book treated as per-turn
 * injections, re-written every turn (measured 2026-10-07: 木屋求生 × Kemini,
 * 0% from turn 2). Entries before the history become system text (the preset
 * block); entries after the last chat message — the preset's post-history
 * part, an assistant-role 「明白了」 among them — become system text after
 * the player's message, so they go with it instead of turning the reply into
 * a prefill. A continue keeps its trailing assistant message as the prefill.
 * @param {Array<{role: string, content: any}>} messages
 * @param {{ start?: string[], end?: string[] }} hist
 * @param {string|null} genType  SillyTavern's generation type ('continue', …)
 * @returns {Array} the same array when nothing applies
 */
export function applyHistoryBounds(messages, hist, genType = null) {
    const start = hist?.start ?? [];
    const end = hist?.end ?? [];
    if (!start.length) return messages;
    // 审: 取消息纯文本。
    const text = (m) => contentToText(m?.content);
    // 审: 去掉所有空白再比较（卡片开场白换行符会变）。
    // Whitespace-blind: a card's greeting is stored with \r\n and sent with \n.
    const flat = (s) => String(s).replace(/\s+/g, '');
    // 审: 消息文本是否包含任一标记。
    const has = (m, list) => { const t = flat(text(m)); return list.some((s) => flat(s) && t.includes(flat(s))); };
    // 审: 短的最后一条消息（如「继续」）要整条精确匹配。
    // A short last message (「继续」) is matched as the whole message — markup a
    // prompt regex wraps it in aside — never as part of one (an old turn has it too).
    const exact = (hist?.exact ?? []).map(flat).filter(Boolean);
    // 审: 整条匹配判定，忽略提示词正则包的标签。
    const whole = (m) => m?.role === 'user' && exact.includes(flat(text(m).replace(/<\/?[^<>\n]{1,60}>/g, '')));
    const first = messages.findIndex((m) => m?.role !== 'system' && has(m, start));
    if (first < 0) return messages;
    let last = end.length || exact.length ? messages.findLastIndex((m) => m?.role !== 'system' && (has(m, end) || whole(m))) : -1;
    if (last < first || genType === 'continue') last = -1;
    // 审: 把越界的消息转成 system 文本。
    const asSystem = (m) => (m?.role === 'system' ? m : { role: 'system', content: text(m) });
    let changed = false;
    const out = messages.map((m, i) => {
        const outside = i < first || (last >= 0 && i > last);
        if (!outside || m?.role === 'system' || !text(m).trim()) return m;
        changed = true;
        return asSystem(m);
    });
    return changed ? out : messages;
}

// 审: 把深度注入的 system 消息折进相邻 user 轮并前移到本轮，保持历史字节不变以命中缓存（chat.js 使用，inline 模式）。
/**
 * @param {Array<{role: string, content: any}>} messages OpenAI messages
 * @param {{ late?: string[] }} [opts] opening text of the prompts SillyTavern
 *   injected into the chat this request (panel). While the chat is shorter
 *   than their depth ST puts them above every message — in the preamble —
 *   and a turn later they move down into the chat: the system prompt would
 *   change for the first few turns of every chat and nothing would be read
 *   from the cache (measured: 0% on 军训14天 turns 1-3, elite_daily at depth
 *   3). Known injections always go with the current turn instead. ST joins
 *   the injections of one depth into one message, so its text starts with
 *   one of them.
 * @returns {Array} new array: leading system block, then history with
 *   later system messages folded into user turns
 */
export function inlineLateSystemMessages(messages, { late = [], seen = null, onRepeat = null } = {}) {
    // 审: 是否面板登记过的「晚到」注入（以其开头文本识别）。
    const isLate = (m) => m?.role === 'system' && late.length > 0 && late.some((s) => contentToText(m.content).trimStart().startsWith(s));
    const firstUser = messages.findIndex((m) => m?.role === 'user' && contentToText(m.content).trim());
    const lead = firstUser < 0 ? messages.length : firstUser;
    const preamble = messages.slice(0, lead);
    const head = preamble.filter((m) => m?.role === 'system' && !isLate(m));
    // 审: 跟随本轮的注入集合，只有它们才会被「已见过」替换成一行提示。
    const moved = new WeakSet(); // injections that go with the current turn (see `seen` below)
    const early = preamble.filter((m) => (m?.role !== 'system' && contentToText(m.content).trim()) || isLate(m));
    for (const m of early) if (m?.role === 'system') moved.add(m);
    const rest = [...early, ...messages.slice(lead)];
    if (head.length === preamble.length && !rest.some((m) => m?.role === 'system')) return messages;

    // System messages after the final assistant turn (continue / prefill)
    // must not become the "current user message" — that would drop the
    // prefill. Move them in front of that assistant turn instead.
    const lastNonSystem = rest.findLastIndex((m) => m?.role !== 'system');
    const ordered = rest.slice();
    if (lastNonSystem >= 0 && rest[lastNonSystem].role === 'assistant' && lastNonSystem < rest.length - 1) {
        const trailingSystem = ordered.splice(lastNonSystem + 1);
        ordered.splice(lastNonSystem, 0, ...trailingSystem);
    }

    // A deeper injection (depth ≥ 3: before an earlier assistant reply) would
    // be merged into an OLD user turn — and next turn it has moved on, so that
    // old turn's text changes and the prompt cache misses from there to the
    // end, every turn (measured on 母畜庄园: MVU's depth-4 format rules).
    // Put those next to the current turn instead: still near the end, and
    // the history before it stays byte-identical.
    const lastUser = ordered.findLastIndex((m) => m?.role === 'user');
    const lastReply = lastUser > 0 ? ordered.slice(0, lastUser).findLastIndex((m) => m?.role === 'assistant') : -1;
    if (lastReply > 0) {
        const deep = [];
        for (let i = lastReply - 1; i >= 0; i--) {
            if (ordered[i]?.role === 'system') deep.unshift(...ordered.splice(i, 1));
        }
        if (deep.length) {
            for (const m of deep) moved.add(m);
            // Right after the last reply: deeper ones stay ahead of shallower ones.
            const u = ordered.findLastIndex((m) => m?.role === 'user');
            const r = ordered.slice(0, u).findLastIndex((m) => m?.role === 'assistant');
            ordered.splice(r + 1, 0, ...deep);
        }
    }

    // An injection that goes with the current turn every turn is repeated in
    // every turn's message (earlier turns are re-sent as they went out): a
    // 17k-character world info block at depth 3 cost ~17k tokens of cache
    // writes per turn and grew the history by as much (衡 × 军训14天,
    // 2026-10-07). When `seen` says the exact text was already given in an
    // earlier turn, a one-line note stands in for it.
    const out = [];
    // 审: 逐条转换：system → user（重复的换成提示），相邻 user 合并。
    for (const m of ordered) {
        const text = m?.role === 'system' ? contentToText(m.content) : '';
        const repeat = m?.role === 'system' && moved.has(m) && typeof seen === 'function' && seen(text);
        if (repeat) onRepeat?.(text);
        const converted = m?.role === 'system'
            ? { role: 'user', content: repeat ? REPEAT_NOTE : text }
            : m;
        // 审(存疑): converted 是 system 不可能成立（system 都转 user 了），应为死分支；仅在 messages 含 null 时删掉会改变抛错行为，故未动。
        if (converted.role === 'system') continue;
        const prev = out[out.length - 1];
        if (prev && prev.role === 'user' && converted.role === 'user') {
            out[out.length - 1] = { ...prev, content: mergeContent(prev.content, converted.content) };
        } else {
            out.push(converted);
        }
    }
    return [...head, ...out];
}

