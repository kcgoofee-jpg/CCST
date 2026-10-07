// ──────────────────────────────────────────────
// The last chat request as it went to the CLI (panel 设置 → 查看发给模型的内容)
// ──────────────────────────────────────────────
//
// The system prompt and the message history after placement, lore moving
// and folding: what the model actually reads. Kept in memory only (one
// request, replaced by the next); the wire capture (wire-tap.js) has the
// CLI's own request on top for the diagnostics export.

import { extractSystemText } from '../core/system-prompt.js';

let last = null;
let lastEntries = null; // dry runs only: the transcript the CLI would resume from (tests diff two turns)

export function noteLastRequest({ model, placed, cacheDiag }) {
    last = {
        at: new Date().toISOString(),
        model,
        cacheDiag: cacheDiag ?? null,
        system: extractSystemText(placed) ?? '',
        messages: placed.filter((m) => m?.role !== 'system'),
    };
}

/** GET handler for the panel's viewer. */
export function handleDebugLast(_req, res) {
    if (!last) return res.status(404).json({ ok: false, error: '代理启动后还没有聊天请求：聊一轮再看。' });
    res.json({ ok: true, at: last.at, model: last.model, cacheDiag: last.cacheDiag, systemMarked: last.system, messages: last.messages });
}

export function noteLastEntries(entries) {
    lastEntries = entries.map((e) => ({ type: e.type, message: e.message, attachment: e.attachment, isMeta: e.isMeta }));
}

/** Test seam: the transcript of the last dry run. */
export function __lastEntries() {
    return lastEntries;
}
