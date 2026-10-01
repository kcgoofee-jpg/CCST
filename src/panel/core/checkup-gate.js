// ──────────────────────────────────────────────
// 体检 must not run while a reply is streaming: the half-written message trips checks (length,
// missing status block...) and the tab badge flashed a number that vanished when the reply finished.
// A request made meanwhile is remembered and runs once, after the generation ended. Pure: the
// caller injects how to tell "generating" and what to run.
// ──────────────────────────────────────────────

export function makeCheckupGate({ isGenerating, run }) {
    let pending = null;
    return {
        /** Run now, or remember (merged: a toast request wins) until flush(). Returns whether it ran. */
        request(opts = {}) {
            if (isGenerating()) {
                pending = { ...(pending ?? {}), ...opts, toast: !!(pending?.toast || opts.toast) };
                return false;
            }
            pending = null;
            run(opts);
            return true;
        },
        /** Call when a generation ended / was stopped. */
        flush() {
            if (!pending || isGenerating()) return false;
            const opts = pending;
            pending = null;
            run(opts);
            return true;
        },
        hasPending: () => pending !== null,
    };
}
