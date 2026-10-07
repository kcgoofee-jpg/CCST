// ──────────────────────────────────────────────
// Per-request settings extraction
// ──────────────────────────────────────────────
//
// The companion UI extension injects a `claude_subscription` object into the
// request body via SillyTavern's `custom_include_body` channel — the only
// per-request path that survives ST's backend unconditionally (its native
// reasoning_effort field is dropped for non-OpenAI model IDs at
// src/endpoints/backends/chat-completions.js:2507-2513, and its "Maximum"
// dropdown value is downgraded to "high" client-side before that).
//
// Direct API users (curl, other frontends) can send the same object, or the
// standard OpenAI `reasoning_effort` field, or nothing at all.

export const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const VALID_THINKING = ['off', 'adaptive', 'on'];

/** Gate effort to the SDK's closed vocabulary; anything else → undefined
 *  (model default) instead of erroring the whole request. Case-sensitive on
 *  purpose — the SDK wants lowercase. */
export function normalizeEffort(value) {
    return VALID_EFFORTS.includes(value) ? value : undefined;
}

const short = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);

/** The panel's per-request fingerprint, kept to known fields of bounded size. */
function stFingerprint(fp) {
    if (!fp || typeof fp !== 'object' || Array.isArray(fp)) return null;
    return {
        preset: short(fp.preset, 80),
        pp: short(fp.pp, 24),
        order: short(fp.order, 16),
        wi: Array.isArray(fp.wi) ? fp.wi.filter((s) => typeof s === 'string').map((s) => s.slice(0, 40)).slice(0, 80) : [],
    };
}

/**
 * @param {object} body OpenAI chat completions request body
 * @returns {{
 *   effort: string|undefined,
 *   thinking: 'off'|'adaptive'|'on',
 *   thinkingBudget: number|undefined,
 *   showReasoning: boolean,
 *   identityMode: boolean,
 *   useResume: boolean,
 *   systemPlacement: 'inline'|'hoist',
 *   auxiliary: boolean,
 *   maxTokens: number|undefined,
 *   stops: string[],
 * }}
 */
export function extractSettings(body) {
    const fromPanel = !!(body.claude_subscription && typeof body.claude_subscription === 'object');
    const ns = fromPanel ? body.claude_subscription : {};
    // No panel settings and no effort field: an auxiliary caller (a preset
    // helper's "API" mode such as 嘤嘤札记, another extension's summary call)
    // rather than the main chat. Those want a quick answer — thinking first
    // just adds seconds — so they default to thinking OFF. Adaptive-only
    // models still think (they cannot turn it off).
    // CLAUDE_SUBSCRIPTION_AUX_THINKING=adaptive restores the old default.
    // SillyTavern marks background calls (generateRaw / quiet prompts: image-tag
    // writers like 柏宝绘, summaries, other extensions) as type 'quiet'; the panel
    // forwards that as purpose: quiet. They are auxiliary too.
    const purpose = ns.purpose === 'quiet' ? 'quiet' : 'chat';
    const auxiliary = purpose === 'quiet' || (!fromPanel && body.reasoning_effort === undefined && body.reasoning?.effort === undefined);

    const effort = normalizeEffort(ns.effort)
        ?? normalizeEffort(body.reasoning_effort)
        ?? normalizeEffort(body.reasoning?.effort);

    // Default adaptive: the model decides when to think (and adaptive-only
    // families always think regardless).
    const auxDefault = VALID_THINKING.includes(process.env.CLAUDE_SUBSCRIPTION_AUX_THINKING) ? process.env.CLAUDE_SUBSCRIPTION_AUX_THINKING : 'off';
    const thinking = VALID_THINKING.includes(ns.thinking) ? ns.thinking : (auxiliary ? auxDefault : 'adaptive');

    const thinkingBudget = Number.isFinite(ns.thinking_budget) && ns.thinking_budget > 0
        ? Math.floor(ns.thinking_budget)
        : undefined;

    const maxTokens = Number.isFinite(body.max_tokens) && body.max_tokens > 0
        ? Math.floor(body.max_tokens)
        : (Number.isFinite(body.max_completion_tokens) && body.max_completion_tokens > 0
            ? Math.floor(body.max_completion_tokens)
            : undefined);

    let stops = [];
    if (Array.isArray(body.stop)) stops = body.stop.filter((s) => typeof s === 'string' && s.length > 0);
    else if (typeof body.stop === 'string' && body.stop.length > 0) stops = [body.stop];
    // Anthropic caps stop sequences at 4 upstream; we enforce client-side
    // anyway, but keep the list sane.
    stops = stops.slice(0, 16);

    return {
        effort,
        thinking,
        thinkingBudget,
        showReasoning: ns.show_reasoning !== false, // default ON — ST renders reasoning_content natively
        identityMode: ns.identity_mode === true,     // claude_code preset + append (self-ID fix, coding framing)
        useResume: ns.use_resume !== false,          // synthetic-session resume (fold fallback when off/failed)
        // Depth-injected system messages stay in place as user turns (like
        // SillyTavern's own Claude converter) unless explicitly hoisted.
        systemPlacement: ns.system_placement === 'hoist' ? 'hoist' : 'inline',
        // Dev tool: save the last full request (system prompt + messages) locally.
        debugDump: ns.debug_dump === true,
        // Diagnostics: send the CLI through the wire capture (features/wire-tap.js).
        diagCapture: ns.diag_capture === true,
        // Hash of the open chat: the usage log files each request under it (per-chat last turn).
        chatKey: typeof ns.chat_key === 'string' && /^[0-9a-f]{8,40}$/.test(ns.chat_key) ? ns.chat_key : null,
        // Slot the finished reply is kept under (features/reply-keeper.js): a hash of chat + player message.
        replySlot: typeof ns.reply_slot === 'string' && /^[0-9a-f]{8,40}$/.test(ns.reply_slot) ? ns.reply_slot : null,
        // Dev only: build everything (placement, lore tail, transcript) and dump it, but never call Claude.
        dryRun: ns.dry_run === true && ns.debug_dump === true,
        // A system-prompt block that changes every turn (keyword world info)
        // moves to the current message so the history stays cached (lore-tail.js).
        loreTail: ns.lore_tail !== undefined ? ns.lore_tail !== false : !/^(0|false|off|no)$/i.test(process.env.CLAUDE_SUBSCRIPTION_LORE_TAIL ?? ''),
        foldTail: ns.fold_tail !== undefined ? ns.fold_tail !== false : !/^(0|false|off|no)$/i.test(process.env.CLAUDE_SUBSCRIPTION_FOLD_TAIL ?? ''),
        // Opening text of each prompt SillyTavern injects INTO the chat this
        // request (depth world info, the preset's in-chat entries, Author's
        // Note — panel inject.js). Early in a chat ST puts them above every
        // message, where they would pass for part of the system prompt.
        lateSnippets: Array.isArray(ns.late)
            ? ns.late.filter((s) => typeof s === 'string' && s.trim().length >= 8).map((s) => s.trim()).slice(0, 64)
            : [],
        // What SillyTavern had set up for this request (preset, post-processing,
        // entry order / toggles, triggered world info): only for the diagnostic report.
        stFingerprint: stFingerprint(ns.st_fp),
        auxiliary,
        purpose: fromPanel ? purpose : (auxiliary ? 'aux' : 'chat'),
        maxTokens,
        stops,
    };
}
