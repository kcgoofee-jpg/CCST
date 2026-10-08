// ──────────────────────────────────────────────
// The last chat request as it went to the CLI (panel 设置 → 查看发给模型的内容)
// ──────────────────────────────────────────────
//
// The system prompt and the message history after placement, lore moving
// and folding: what the model actually reads. Kept in memory only (one
// request, replaced by the next); the wire capture (wire-tap.js) has the
// CLI's own request on top for the diagnostics export.

import { extractSystemText } from '../core/system-prompt.js';

// 审: 最近一次聊天请求（发给 CLI 的样子），面板「查看发给模型的内容」读它；只留一条。
let last = null;
// 审: 仅 dry-run 时记录的 JSONL 记录，给测试对比两轮差异。
let lastEntries = null; // dry runs only: the transcript the CLI would resume from (tests diff two turns)

// 审: chat.js 每次请求后记录发给模型的内容，供面板查看。
export function noteLastRequest({ model, placed, cacheDiag }) {
    last = {
        at: new Date().toISOString(),
        model,
        cacheDiag: cacheDiag ?? null,
        system: extractSystemText(placed) ?? '',
        messages: placed.filter((m) => m?.role !== 'system'),
    };
}

// 审: 面板查看器的 GET 处理函数（routes.js 注册）。
/** GET handler for the panel's viewer. */
export function handleDebugLast(_req, res) {
    if (!last) return res.status(404).json({ ok: false, error: '代理启动后还没有聊天请求：聊一轮再看。' });
    res.json({ ok: true, at: last.at, model: last.model, cacheDiag: last.cacheDiag, systemMarked: last.system, messages: last.messages });
}

// 审: chat.js dry-run 时记下转录，配合 __lastEntries 给测试用。
export function noteLastEntries(entries) {
    lastEntries = entries.map((e) => ({ type: e.type, message: e.message, attachment: e.attachment, isMeta: e.isMeta }));
}

/** Test seam: the transcript of the last dry run. */
export function __lastEntries() {
    return lastEntries;
}
