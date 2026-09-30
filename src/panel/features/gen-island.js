// ──────────────────────────────────────────────
// 灵动岛 follows the reply being generated
// ──────────────────────────────────────────────

import { connectionInfo } from '../core/connection.js';
import { generating } from '../core/st.js';
import { ui } from '../core/notify.js';

// ── 灵动岛: follow the reply being generated ──
// Only for chat replies going to this proxy (not background requests or
// other connections). done → shows length, time and cache, then shrinks
// back to the dot.
let genActive = false;
let doneTimer = null;
let genWatch = null;
// Started on GENERATION_AFTER_COMMANDS: GENERATION_STARTED also fires when
// a slash command in the input box takes over and nothing is generated.
export function islandGenStart(type, _opts, dryRun) {
    const link = connectionInfo();
    if (!ui.island || dryRun || type === 'quiet' || type === 'impersonate' || !(link.connected || link.direct)) return;
    genActive = true;
    clearTimeout(doneTimer);
    ui.island.set({ kind: 'thinking', startedAt: Date.now(), chars: 0, cache: null, seconds: null });
    // Safety net: an ending ST didn't announce (an error path) must not leave the pill spinning.
    clearInterval(genWatch);
    let idleChecks = 0;
    genWatch = setInterval(() => {
        if (!genActive) { clearInterval(genWatch); return; }
        idleChecks = generating() ? 0 : idleChecks + 1;
        if (idleChecks >= 2 || Date.now() - (ui.island.state.startedAt ?? 0) > 30 * 60 * 1000) islandStopped();
    }, 5000);
}
let tokenAt = 0;
export function islandToken(text) {
    // Fires per token with the whole text so far (empty while the model is still thinking).
    if (!genActive || Date.now() - tokenAt < 200) return;
    tokenAt = Date.now();
    const chars = String(text ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, '').length;
    if (chars) ui.island.set({ kind: 'writing', chars });
}
export function islandGenEnd() {
    if (!genActive) return;
    clearInterval(genWatch);
    genActive = false;
    const chat = SillyTavern.getContext().chat ?? [];
    const last = chat[chat.length - 1];
    if (!last || last.is_user || last.is_system) { ui.island.set({ kind: 'idle' }); return; }
    const chars = last && !last.is_user ? String(last.mes ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, '').length : 0;
    const startedAt = ui.island.state.startedAt;
    islandDone({ chars, seconds: startedAt ? Math.round((Date.now() - startedAt) / 1000) : null });
}
export function islandStopped() {
    if (!genActive) return;
    clearInterval(genWatch);
    genActive = false;
    ui.island.set({ kind: 'idle' });
}
export function islandDone(patch) {
    if (!ui.island || genActive) return;
    const wasDone = ui.island.state.kind === 'done';
    if (!wasDone && patch.chars == null) return; // stats for a turn we didn't watch
    ui.island.set({ ...patch, kind: 'done' });
    clearTimeout(doneTimer);
    doneTimer = setTimeout(() => ui.island.set({ kind: 'idle' }), wasDone ? 2500 : 4000);
}
