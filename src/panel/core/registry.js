// ──────────────────────────────────────────────
// Feature registry. Features (src/panel/features/) are loaded by the bootstrap one by one, each
// in its own try/catch, and register here. A feature that failed to load — or an older copy
// without it — answers every call with a no-op, so one broken file never takes the panel down.
//
//     F.checkup.renderLatestFlags()   // no-op (returns undefined) when the checkup feature is missing
// ──────────────────────────────────────────────

// 审: 已加载功能的注册表。
const registry = Object.create(null);
// 审: 缺席功能的替身：任何方法调用都是空操作，保证一个功能加载失败不连累别处。
const MISSING = new Proxy({}, { get: () => () => undefined });

// 审: 功能入口代理：F.<名>.<方法>() 没注册时返回空操作；全面板跨功能调用的统一方式。
export const F = new Proxy(registry, { get: (table, name) => table[name] ?? MISSING });

// 审: index.js 在功能加载成功后登记。
export function registerFeature(name, api) {
    registry[name] = api;
}

// 审: boot 据此给每个已加载功能调 init()。
export function loadedFeatures() {
    return Object.keys(registry);
}
