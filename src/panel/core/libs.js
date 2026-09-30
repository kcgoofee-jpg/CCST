// ──────────────────────────────────────────────
// The optional helpers in src/shared/ (also used by the tests), loaded with
// dynamic import() relative to this file. A copy without one of them still
// works: that section just says it is unavailable, so a failed import is
// swallowed. `libs.<name>` is the loaded module or null; a hook runs once
// its module is there.
// ──────────────────────────────────────────────

export const libs = {
    chatCheck: null,     // 体检 (shared/chat-check.js)
    loreConst: null,     // 世界书常驻 (shared/lore-constant.js)
    cardAudit: null,     // 角色卡检查 (shared/card-audit.js)
    presetReco: null,    // 预设推荐 (shared/preset-reco.js)
    hostCheck: null,     // 云端酒馆检测 (shared/host.js)
    sources: null,       // 哪些来源连 Claude、模型名、缓存 (shared/sources.js)
};

const FILES = {
    chatCheck: 'chat-check.js', loreConst: 'lore-constant.js', cardAudit: 'card-audit.js', presetReco: 'preset-reco.js',
    hostCheck: 'host.js', sources: 'sources.js',
};

/** Start loading every helper; `hooks[name](module)` runs when that one arrives. */
export function loadLibs(hooks = {}) {
    for (const [name, file] of Object.entries(FILES)) {
        import(new URL(`../../shared/${file}`, import.meta.url).href)
            .then((m) => { libs[name] = m; hooks[name]?.(m); })
            .catch(() => { /* that helper is unavailable */ });
    }
}
