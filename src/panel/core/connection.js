// ──────────────────────────────────────────────
// Where SillyTavern sends chat requests, and the model names the panel shows.
// The logic is in capabilities.js (pure); this reads SillyTavern's live settings.
// ──────────────────────────────────────────────

import { resolveConnection } from './capabilities.js';
import { getSettings } from './settings.js';
import { libs } from './libs.js';

/** `where` / `billing`: 走哪 · 按什么计费, for the status bar. */
export function connectionInfo() {
    const ctx = SillyTavern.getContext();
    return resolveConnection({ mainApi: ctx.mainApi, oai: ctx.chatCompletionSettings ?? {}, settings: getSettings(), sources: libs.sources });
}

const MODEL_SHORT = [
    [/fable-5-1/, 'Fable 5.1'], [/fable-5/, 'Fable 5'], [/opus-5-5/, 'Opus 5.5'], [/opus-5/, 'Opus 5'],
    [/sonnet-5-5/, 'Sonnet 5.5'], [/sonnet-5/, 'Sonnet 5'], [/opus-4-(\d)/, 'Opus 4.$1'], [/sonnet-4-(\d)/, 'Sonnet 4.$1'], [/haiku-4-5/, 'Haiku 4.5'],
];

export function shortModel(id) {
    const s = libs.sources?.canonicalModel(id) ?? String(id ?? '');
    for (const [re, label] of MODEL_SHORT) {
        const m = s.match(re);
        if (m) return label.replace('$1', m[1] ?? '') + (/\[1m\]|-1m/i.test(String(id ?? '')) ? ' 1M' : '');
    }
    return String(id ?? '');
}

export const modelBase = (id) => String(id ?? '').replace(/\[1m\]$/i, '');
/** The canonical id (claude-opus-4-6) behind any source's name: what MODEL_PICKS and byModel use. */
export const modelKey = (id) => libs.sources?.canonicalModel(id) ?? modelBase(id);
