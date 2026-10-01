// ──────────────────────────────────────────────
// Which chat-completion requests are the chat's own reply, and which are background calls (another
// extension's tag writer / summary through generateRaw, generateQuietPrompt, or a plain Generate()).
// Only the reply may become 「上一轮」 / the status bar's 完成 line; the rest go out as purpose: quiet,
// so the proxy files them as background. Pure state machine, no ST objects.
//
// ST fires GENERATION_AFTER_COMMANDS (type, opts, dryRun) when the user's own generation starts and
// GENERATION_ENDED / GENERATION_STOPPED when it finishes. A user generation sends ONE chat request;
// anything else that shows up meanwhile (or with no generation running) is somebody else's.
// ──────────────────────────────────────────────

const MAIN_TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue', 'impersonate', 'appendFinal']);

const state = { tracking: false, active: false, claimed: false };

export function genStarted(type, opts, dryRun) {
    state.tracking = true;
    if (dryRun || type === 'quiet' || opts?.quiet_prompt) return;
    state.active = true;
    state.claimed = false;
}

export function genFinished() {
    state.active = false;
    state.claimed = false;
}

/** True when this request must be filed as a background call. Call once per request (it claims the reply). */
export function isBackgroundRequest(data) {
    const type = String(data?.type ?? '');
    if (type === 'quiet') return true;
    // Unknown / missing type (generateRaw and friends) is not a chat turn.
    if (!MAIN_TYPES.has(type)) return true;
    // Events not wired (older ST): the type alone has to do.
    if (!state.tracking) return false;
    if (!state.active || state.claimed) return true;
    state.claimed = true;
    return false;
}

/** Test seam. */
export function __resetBackgroundForTesting() {
    state.tracking = false; state.active = false; state.claimed = false;
}
