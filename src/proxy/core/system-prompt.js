// ──────────────────────────────────────────────
// System prompt assembly — roleplay-first
// ──────────────────────────────────────────────
//
// The single most consequential option for roleplay quality. The SDK's
// behavior matrix (verified against @anthropic-ai/claude-agent-sdk 0.2.141):
//
//   • systemPrompt OMITTED          → CLI default = the FULL ~28KB Claude Code
//                                     coding system prompt. Never acceptable
//                                     for RP — "no option" is not neutral.
//   • systemPrompt: '<string>'      → REPLACES the coding preamble entirely.
//                                     Pure client prompt (character card,
//                                     persona, world info). The RP path.
//   • systemPrompt: ''              → explicitly empty system prompt.
//
// Only the custom form is used: SillyTavern's system prompt replaces the
// coding preamble entirely (6.1 dropped the opt-in "identity mode" that kept it).

// 审: 把酒馆的系统提示词包成 SDK 的 custom systemPrompt（替换掉默认的 28KB 编程提示词），chat.js 每次请求都用。
/**
 * @param {string|undefined} clientSystemPrompt joined system-message text from the request
 * @returns {{ type: 'custom', prompt: string, snapshot: false }}
 */
export function buildSystemPrompt(clientSystemPrompt) {
    // snapshot: false. By default the CLI records the system prompt in the
    // session transcript on the first request and REUSES that record on every
    // resume — rolled out per account (SDK 0.3.x docs). Our transcripts replay
    // attachments captured in earlier turns and the pinned context, so the CLI
    // sent an earlier turn's — or another chat's — system prompt instead of
    // the one SillyTavern just sent: wrong preset, and a prefix that changed
    // every turn (cache 0%, 2026-10).
    // An empty string keeps the prompt explicitly empty rather than falling
    // back to the CLI default.
    return { type: 'custom', prompt: clientSystemPrompt ?? '', snapshot: false };
}

// 审: 取出并拼接所有 system 消息的文本；chat 用来作系统提示词，last-request 也用。
/** Extract and join system-role messages from an OpenAI messages array. */
export function extractSystemText(messages) {
    const parts = [];
    for (const m of messages) {
        if (m?.role !== 'system') continue;
        const text = contentToText(m.content);
        if (text) parts.push(text);
    }
    return parts.length ? parts.join('\n\n') : undefined;
}

// 审: 把 OpenAI content（字符串或分段数组）压成纯文本，丢掉图片等；system-placement / cache-diag 也用，transcript.js 复用它。
/** Flatten OpenAI content (string or multi-part array) to plain text. */
export function contentToText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
            .map((p) => p.text)
            .join('\n');
    }
    return '';
}
