// ──────────────────────────────────────────────
// The reliable checks of the latest reply (shared/chat-check.js): refusal / cut off at the length
// limit / empty → the 「最新回复」 card in 状态.
// ──────────────────────────────────────────────

import { libs } from '../core/libs.js';
import { store } from '../core/store.js';
import { note } from '../core/dom.js';

export function init() {
    // A full refresh (drawer opened, 重新检测) and fresh usage stats (after a reply) re-read the latest reply.
    store.subscribe('pulse', () => renderLatestFlags());
    store.subscribe('stats', () => renderLatestFlags());
}

/** The flags of the latest reply: chat text + the proxy's record of this chat's last request. */
export function currentFlags() {
    if (!libs.chatCheck?.replyFlags) return [];
    const chat = SillyTavern.getContext().chat ?? [];
    const replies = chat.length < 2 ? null : libs.chatCheck.latestReplies(chat);
    if (!replies) return [];
    const stats = store.get().stats;
    return libs.chatCheck.replyFlags(replies.last.mes ?? '', stats?.phase === 'ok' ? stats.data?.lastRequest : null);
}

/** 状态 → 最新回复: one line per problem; the card is hidden when there is none. */
export function renderLatestFlags() {
    const sec = document.getElementById('claude_max_latest_sec');
    const box = document.getElementById('claude_max_latest');
    if (!sec || !box) return;
    const flags = currentFlags();
    sec.hidden = !flags.length;
    box.replaceChildren(...flags.map((f) => note('warn', f.text)));
}
