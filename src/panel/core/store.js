// ──────────────────────────────────────────────
// A small state store. The panel's live data (proxy status, quota, stats,
// the at-a-glance numbers) lives here; core/live.js is the one place
// that fetches it, and tabs subscribe to the keys they draw. Subscribers
// always look their DOM up by id when they run, so a rebuilt panel needs no
// re-subscribing.
// ──────────────────────────────────────────────

/**
 * @param {Record<string, any>} initial
 */
export function createStore(initial = {}) {
    let state = { ...initial };
    /** @type {Set<{ keys: Set<string> | null, fn: Function }>} */
    const subs = new Set();

    return {
        get: () => state,

        /** Merge `patch` and tell the subscribers of any key in it (every key named counts as changed). */
        set(patch) {
            const changed = Object.keys(patch);
            if (!changed.length) return;
            state = { ...state, ...patch };
            for (const sub of [...subs]) {
                if (sub.keys && !changed.some((k) => sub.keys.has(k))) continue;
                try {
                    sub.fn(state, changed);
                } catch (err) {
                    // One broken render must not stop the others.
                    console.error('[claude-max] store subscriber failed', err);
                }
            }
        },

        /** Merge into one object-valued key: `merge('glance', { quota: 5 })`. */
        merge(key, partial) {
            this.set({ [key]: { ...(state[key] ?? {}), ...partial } });
        },

        /**
         * `keys`: a key, an array of keys, or '*' for everything. Returns the unsubscribe function.
         * `fn(state, changedKeys)`.
         */
        subscribe(keys, fn) {
            const sub = { keys: keys === '*' ? null : new Set([].concat(keys)), fn };
            subs.add(sub);
            return () => subs.delete(sub);
        },
    };
}

/** The panel's store. `proxyState` / `proxyOnline` describe the proxy; `status`, `quota`, `stats`
 *  carry {phase: 'pending' | 'loading' | 'ok' | 'error' …} plus the data; `pulse` bumps on a full refresh. */
export const store = createStore({
    proxyState: null,      // null | 'online' | 'warning' | 'offline'
    proxyOnline: null,     // null | true | false (heartbeat + status)
    status: { phase: 'idle' },
    quota: { phase: 'idle' },
    stats: { phase: 'idle' },
    statsAt: 0,
    glance: { quota: null, cache: null },
    gen: { kind: 'idle' }, // the reply being written: idle | thinking | writing | done (features/gen-progress.js)
    pulse: 0,
});
