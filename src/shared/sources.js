// ──────────────────────────────────────────────
// Claude model names: the canonical Anthropic id behind any spelling, and which
// models always think. Pure functions; shared by the panel and the tests.
// ──────────────────────────────────────────────

/**
 * Models that always think (the 「不思考」 choice does nothing on them): Fable / Mythos, Opus 5.5 and newer,
 * Sonnet 5.5 and newer. Opus 4.7 / 4.8 / 5 accept thinking off (measured live). Mirrors the proxy catalog (src/proxy/core/models.js adaptiveOnly). False for non-Claude ids.
 */
export function isAdaptiveOnly(id) {
    const c = canonicalModel(id);
    if (!c) return false;
    if (/^claude-opus-(?:4-[78]|5)$/.test(c)) return false;
    return /fable|mythos/.test(c)
        || /^claude-opus-(?:4-(?:[7-9]|\d{2,})|[5-9]|\d{2,})(?:-|$)/.test(c)
        || /^claude-sonnet-(?:5-(?:[5-9]|\d{2,})|[6-9]|\d{2,})(?:-|$)/.test(c);
}

/**
 * The Anthropic API id behind any source's name: anthropic/claude-opus-4.6:thinking → claude-opus-4-6.
 * Drops vendor prefixes, [1m], :variants, -thinking, dates and -latest. Null when not a Claude id.
 */
export function canonicalModel(id) {
    const s = String(id ?? '').trim().toLowerCase();
    const m = s.match(/claude[-_.].*$/);
    if (!m) return null;
    let c = m[0]
        .replace(/\[1m\]$/, '')
        .replace(/:.*$/, '')
        .replace(/_/g, '-')
        .replace(/-v\d+$/, '')
        .replace(/-(thinking|latest)$/, '')
        .replace(/-\d{8}$/, '');
    c = c.replace(/(\d)\.(\d)/g, '$1-$2');
    return c;
}
