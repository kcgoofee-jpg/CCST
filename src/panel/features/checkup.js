// ──────────────────────────────────────────────
// The reliable checks of the latest reply (shared/chat-check.js): refusal / cut off at the length
// limit / empty → the 「最新回复」 card in 状态.
// ──────────────────────────────────────────────

import { libs } from '../core/libs.js';
import { store } from '../core/store.js';
import { note } from '../core/dom.js';

// 审: 订阅整页刷新和用量更新，随之重读「最新回复」检查；boot 对每个功能调 init。
export function init() {
    // A full refresh (drawer opened, 重新检测) and fresh usage stats (after a reply) re-read the latest reply.
    store.subscribe('pulse', () => renderLatestFlags());
    store.subscribe('stats', () => renderLatestFlags());
}

// 审: 最新回复的问题标记（拒答/截断/空回复）：聊天正文 + 代理记录的上一次请求；共享库没加载则无。
/** The flags of the latest reply: chat text + the proxy's record of this chat's last request. */
function currentFlags() {
    if (!libs.chatCheck?.replyFlags) return [];
    const chat = SillyTavern.getContext().chat ?? [];
    const replies = chat.length < 2 ? null : libs.chatCheck.latestReplies(chat);
    if (!replies) return [];
    const stats = store.get().stats;
    return libs.chatCheck.replyFlags(replies.last.mes ?? '', stats?.phase === 'ok' ? stats.data?.lastRequest : null);
}

// 审: 画状态页「最新回复」卡：每个问题一行，没有问题就隐藏整张卡；boot/turn-notice 也会调用。
/** 状态 → 最新回复: one line per problem; the card is hidden when there is none. */
export function renderLatestFlags() {
    const sec = document.getElementById('claude_max_latest_sec');
    const box = document.getElementById('claude_max_latest');
    if (!sec || !box) return;
    const flags = currentFlags();
    sec.hidden = !flags.length;
    box.replaceChildren(...flags.map((f) => note('warn', f.text)));
}
