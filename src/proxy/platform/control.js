// ──────────────────────────────────────────────
// Replies being written right now (the chat route counts them)
// ──────────────────────────────────────────────
//
// The panel reads the count to say which replies still run on the
// old backend after a switch.

let inFlight = 0;

/** Wrap the chat handler: count replies being generated until the handler
 *  itself is done — NOT until the response closes: a client that went away
 *  drops the connection while the reply keeps being written and kept
 *  (reply-keeper.js). A rejected handler goes to express's error handler
 *  instead of crashing. */
export function countInFlight(handler) {
    return async (req, res, next) => {
        inFlight++;
        try {
            await handler(req, res, next);
        } catch (err) {
            next?.(err);
        } finally {
            inFlight--;
        }
    };
}

export function busyCount() {
    return inFlight;
}

/** Test seam. */
export function __setInFlight(n) {
    inFlight = n;
}
