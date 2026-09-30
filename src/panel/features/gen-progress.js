// ──────────────────────────────────────────────
// The reply being written, shown in the panel's status bar (core/store.js `gen`; drawn by shell.js)
// ──────────────────────────────────────────────

import { connectionInfo } from '../core/connection.js';
import { generating } from '../core/st.js';
import { store } from '../core/store.js';

// Only for chat replies going to a Claude connection (not background requests or other connections).
// thinking → writing → done (a few seconds: length, time, cache) → back to the normal bar.
let genActive = false;
let doneTimer = null;
let genWatch = null;
let tick = null;

const gen = () => store.get().gen;
const setGen = (patch) => store.set({ gen: { ...gen(), ...patch } });
const idle = () => { clearInterval(tick); tick = null; store.set({ gen: { kind: 'idle' } }); };

// Started on GENERATION_AFTER_COMMANDS: GENERATION_STARTED also fires when
// a slash command in the input box takes over and nothing is generated.
export function genStart(type, _opts, dryRun) {
    const link = connectionInfo();
    if (dryRun || type === 'quiet' || type === 'impersonate' || !(link.connected || link.direct)) return;
    genActive = true;
    clearTimeout(doneTimer);
    store.set({ gen: { kind: 'thinking', startedAt: Date.now(), chars: 0, cache: null, seconds: null } });
    // Re-draw once a second so the seconds count up.
    clearInterval(tick);
    tick = setInterval(() => { if (genActive) setGen({}); }, 1000);
    // Safety net: an ending ST didn't announce (an error path) must not leave the bar counting.
    clearInterval(genWatch);
    let idleChecks = 0;
    genWatch = setInterval(() => {
        if (!genActive) { clearInterval(genWatch); return; }
        idleChecks = generating() ? 0 : idleChecks + 1;
        if (idleChecks >= 2 || Date.now() - (gen().startedAt ?? 0) > 30 * 60 * 1000) genStopped();
    }, 5000);
}
let tokenAt = 0;
export function genToken(text) {
    // Fires per token with the whole text so far (empty while the model is still thinking).
    if (!genActive || Date.now() - tokenAt < 200) return;
    tokenAt = Date.now();
    const chars = String(text ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, '').length;
    if (chars) setGen({ kind: 'writing', chars });
}
export function genEnd() {
    if (!genActive) return;
    clearInterval(genWatch);
    genActive = false;
    const chat = SillyTavern.getContext().chat ?? [];
    const last = chat[chat.length - 1];
    if (!last || last.is_user || last.is_system) { idle(); return; }
    const chars = String(last.mes ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, '').length;
    const startedAt = gen().startedAt;
    genDone({ chars, seconds: startedAt ? Math.round((Date.now() - startedAt) / 1000) : null });
}
export function genStopped() {
    if (!genActive) return;
    clearInterval(genWatch);
    genActive = false;
    idle();
}
/** The finished line (~6 s). The cache figure arrives a moment later from the proxy and extends it. */
export function genDone(patch) {
    if (genActive) return;
    const wasDone = gen().kind === 'done';
    if (!wasDone && patch.chars == null) return; // stats for a turn we didn't watch
    clearInterval(tick);
    tick = null;
    store.set({ gen: { ...gen(), ...patch, kind: 'done' } });
    clearTimeout(doneTimer);
    doneTimer = setTimeout(idle, wasDone ? 4000 : 6000);
}
