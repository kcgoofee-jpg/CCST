// ──────────────────────────────────────────────
// Proxy backends: names, API list prices
// ──────────────────────────────────────────────
//
// Pure functions shared by the proxy (env / usage stats) and the panel
// (labels). Only the subscription is left; the prices value a turn at API
// rates (cache-diag.js 「按 API 价」).

export const BACKENDS = ['subscription'];

export const BACKEND_LABELS = {
    subscription: '订阅',
};

// ── Cost estimate ──
// USD per million tokens, Anthropic first-party list prices as of
// 2026-06-24 (Anthropic model/pricing table, cached in the claude-api
// reference). Cache writes: 5-minute 1.25× input, 1-hour 2× input; cache
// reads 0.1× input unless the price list says otherwise (Opus 5.5 $0.20,
// Fable 5.1 $0.25). The panel labels every figure 估算 (estimate), never an
// invoice.
export const PRICES_AS_OF = '2026-06-24';
const PRICES = {
    'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
    'claude-fable-5': { input: 10, output: 50 },
    'claude-mythos-5-1': { input: 10, output: 50 },
    'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
    'claude-opus-5': { input: 5, output: 25 },
    'claude-opus-4-8': { input: 5, output: 25 },
    'claude-opus-4-7': { input: 5, output: 25 },
    'claude-opus-4-6': { input: 5, output: 25 },
    'claude-opus-4-5': { input: 5, output: 25 },
    'claude-sonnet-5-5': { input: 2, output: 10 }, // CLI model catalog 2026-09 (0.3.285): pricing tier_2_10
    'claude-sonnet-5': { input: 2, output: 10 },
    'claude-sonnet-4-6': { input: 3, output: 15 },
    'claude-sonnet-4-5': { input: 3, output: 15 },
    'claude-haiku-4-5': { input: 1, output: 5 },
};

/** Price row for a model id (first-party, with or without [1m]); null if unknown. */
export function priceFor(model) {
    const id = String(model ?? '').toLowerCase().replace(/\[1m\]$/, '').replace(/\./g, '-');
    const p = PRICES[id];
    if (!p) return null;
    return { input: p.input, output: p.output, cacheRead: p.cacheRead ?? p.input * 0.1 };
}

/** Cache-write price as a multiple of input: 1.25× for 5 minutes, 2× for 1 hour. Unknown (nothing
 *  written, older records) counts as 1 hour, the TTL CCST asks for. */
export function cacheWriteMultiplier(ttl) {
    return ttl === '5m' ? 1.25 : 2;
}
