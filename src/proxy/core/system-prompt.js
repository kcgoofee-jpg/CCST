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
//   • { type:'preset', preset:'claude_code', append } → coding preamble kept,
//                                     client text appended after. Fixes model
//                                     self-identification (without the preset
//                                     every model answers "Sonnet" when asked
//                                     what it is — empirical finding from v1)
//                                     at the cost of coding framing bleeding
//                                     into the roleplay. Exposed as the
//                                     opt-in "identity mode".
//
// In Meridian's terms: "Client Prompt" (the connecting app's system prompt —
// for SillyTavern that's the character card) is hardcoded ON here; "Claude
// Code Prompt" is OFF unless identityMode is set.

/**
 * @param {string|undefined} clientSystemPrompt joined system-message text from the request
 * @param {boolean} identityMode
 * @returns {{ type: 'custom', prompt: string | string[], snapshot: false } | { type: 'preset', preset: 'claude_code', append?: string, snapshot: false }}
 */
export function buildSystemPrompt(clientSystemPrompt, identityMode, splitAt = null, boundary = null) {
    // snapshot: false everywhere. By default (and for a bare string / string[])
    // the CLI records the system prompt in the session transcript on the first
    // request and REUSES that record on every resume — rolled out per account
    // (SDK 0.3.x docs). Our transcripts replay attachments captured in earlier
    // turns and the pinned context, so the CLI sent an earlier turn's — or
    // another chat's — system prompt instead of the one SillyTavern just sent:
    // wrong preset, and a prefix that changed every turn (cache 0%, 2026-10).
    if (identityMode) {
        return clientSystemPrompt
            ? { type: 'preset', preset: 'claude_code', append: clientSystemPrompt, snapshot: false }
            : { type: 'preset', preset: 'claude_code', snapshot: false };
    }
    const text = clientSystemPrompt ?? '';
    // Static prefix + boundary + per-turn suffix: the static part gets its own
    // cache breakpoint, so a change further down (world info) no longer
    // throws away the whole system prompt. The boundary is its own element of
    // the prompt array.
    if (boundary && splitAt && splitAt > 0 && splitAt < text.length) {
        return { type: 'custom', prompt: [text.slice(0, splitAt), boundary, text.slice(splitAt)], snapshot: false };
    }
    // A custom prompt replaces the coding preamble; empty string keeps it
    // explicitly empty rather than falling back to the CLI default.
    return { type: 'custom', prompt: text, snapshot: false };
}

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
