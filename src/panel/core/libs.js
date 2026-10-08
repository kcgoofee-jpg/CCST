// ──────────────────────────────────────────────
// The optional helpers in src/shared/ (also used by the tests), loaded with
// dynamic import() relative to this file. A copy without one of them still
// works: that section just says it is unavailable, so a failed import is
// swallowed. `libs.<name>` is the loaded module or null; a hook runs once
// its module is there.
// ──────────────────────────────────────────────

// 审: src/shared 里可选共享库的句柄表，加载前为 null；各处用 libs.x?. 访问，缺哪个只是那一块不可用。
export const libs = {
    chatCheck: null,     // 最新回复检查 (shared/chat-check.js)
    presetReco: null,    // 预设推荐 (shared/preset-reco.js)
    hostCheck: null,     // 云端酒馆检测 (shared/host.js)
    sources: null,       // Claude 模型名 (shared/sources.js)
};

// 审: 句柄名 → shared/ 下的文件名；test/panel-files 据此核对随面板安装的文件。
const FILES = {
    chatCheck: 'chat-check.js', presetReco: 'preset-reco.js',
    hostCheck: 'host.js', sources: 'sources.js',
};

// 审: 逐个动态 import 共享库，到位后写进 libs 并调用对应 hook；失败静默吞掉（该库不可用）。
/** Start loading every helper; `hooks[name](module)` runs when that one arrives. */
export function loadLibs(hooks = {}) {
    for (const [name, file] of Object.entries(FILES)) {
        import(new URL(`../../shared/${file}`, import.meta.url).href)
            .then((m) => { libs[name] = m; hooks[name]?.(m); })
            .catch(() => { /* that helper is unavailable */ });
    }
}
