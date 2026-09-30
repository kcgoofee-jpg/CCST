// ──────────────────────────────────────────────
// 省电显示 (quiet render)
// ──────────────────────────────────────────────

import { quietOn } from '../core/settings.js';

// CSS only reaches the old floors in this document. Endless animations
// elsewhere (floating widgets, beautifiers inside same-origin frames)
// are told to finish their current loop instead; the latest floor and
// anything that looks like a loading indicator keep looping.
const quieted = new Set();
const QUIET_KEEP = /spin|load|typing|generat|progress/i;
/** Forget quieted animations whose element left the page (old floors after a chat switch). */
export function pruneQuieted() {
    for (const a of quieted) if (!a.effect?.target?.isConnected) quieted.delete(a);
}
export function quietSweep() {
    pruneQuieted();
    if (!quietOn() || document.hidden) return;
    const docs = [document];
    for (const fr of document.querySelectorAll('iframe')) {
        try { if (fr.contentDocument && !fr.closest('#chat .last_mes')) docs.push(fr.contentDocument); } catch { /* cross-origin */ }
    }
    for (const doc of docs) {
        for (const a of doc.getAnimations?.() ?? []) {
            const t = a.effect?.target;
            if (a.playState !== 'running' || a.effect?.getTiming?.().iterations !== Infinity || !t) continue;
            if (doc === document && (t.closest?.('#chat .last_mes, #send_form, .claude-max, .cm-island') || !t.closest?.('body'))) continue;
            if (QUIET_KEEP.test(`${a.animationName ?? ''} ${t.className?.baseVal ?? t.className ?? ''}`)) continue;
            const done = Math.floor((a.currentTime ?? 0) / (a.effect.getTiming().duration || 1)) + 1;
            a.effect.updateTiming({ iterations: done });
            quieted.add(a);
        }
    }
}
export function applyQuietRender() {
    const on = quietOn();
    document.body.classList.toggle('cm-quiet', on);
    if (on) return quietSweep();
    for (const a of quieted) {
        try { a.effect.updateTiming({ iterations: Infinity }); a.play(); } catch { /* element gone */ }
    }
    quieted.clear();
}
