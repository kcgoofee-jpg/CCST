// ──────────────────────────────────────────────
// Feature registry. Features (src/panel/features/) are loaded by the bootstrap one by one, each
// in its own try/catch, and register here. A feature that failed to load — or an older copy
// without it — answers every call with a no-op, so one broken file never takes the panel down.
//
//     F.checkup.renderLatestFlags()   // no-op (returns undefined) when the checkup feature is missing
// ──────────────────────────────────────────────

const registry = Object.create(null);
const MISSING = new Proxy({}, { get: () => () => undefined });

export const F = new Proxy(registry, { get: (table, name) => table[name] ?? MISSING });

export function registerFeature(name, api) {
    registry[name] = api;
}

export function loadedFeatures() {
    return Object.keys(registry);
}
