// ──────────────────────────────────────────────
// CCST — UI extension for the claude-subscription server plugin
// ──────────────────────────────────────────────
//
// This file is the UI EXTENSION bootstrap (loaded in the browser, src/panel/). The SERVER plugin entry
// is src/proxy/plugin.js (wired via package.json "main"). manifest.json at the repo root points here,
// which makes the repo installable straight from SillyTavern's "Install extension" dialog, AND the
// server plugin auto-installs these same files — a window guard below makes whichever copy loads
// second a no-op.
//
// Built on SillyTavern.getContext() (no static imports of ST modules), so the panel works unchanged
// from ANY install location (global third-party, per-user data extensions, or the plugin's
// auto-installed copy). Everything is loaded with import() relative to import.meta.url:
//
//   core/       state store, settings, platform capabilities, notices, proxy access, live data, events
//   shell.js    the drawer, header, status bar and tab bar
//   tabs/       one module per tab (状态 / 设置)
//   features/   optional pieces (reply keeper, latest-reply check, presets, …):
//               each is loaded on its own, and one that fails to load is skipped, never fatal
//   ../shared/  pure helpers also used by the tests, loaded by core/libs.js the same forgiving way
//
// What it does:
//   • One-click Connect: pilots SillyTavern's Custom (OpenAI-compatible) source at the plugin's local
//     endpoint — no URL typing. The endpoint is set BEFORE the source switch because ST's
//     change handler auto-reconnects immediately with whatever URL is current.
//   • Claude-native settings injected per-request through `custom_include_body` — the only channel
//     ST's backend forwards unconditionally for Custom sources: thinking from ST's own 「推理强度」
//     (read from the settings: ST downgrades max→high client-side and drops the field for Claude
//     model IDs server-side), reasoning display from 「显示模型思维」, the cache choices, and what
//     the proxy needs to keep the cache (triggered world info, injection openings).
//   • Quota meter: the proxy directly first (source of truth); with the default endpoint, ST's
//     same-origin plugin route as the fallback (works from remote browsers, where 127.0.0.1 is not
//     the proxy).
//
// Injection is scoped: it only fires when the active connection actually points at this plugin's
// endpoint, so other Custom endpoints (Meridian, llama.cpp, etc.) are untouched.

// 审: 可选功能清单 [注册名, features/ 下的文件名]；某项加载失败只跳过它，面板其余照常；test/panel-files 核对这里与目录一一对应。
// [name it registers under (F.<name>), file in features/]
const FEATURES = [
    ['keeper', 'reply-keeper'], ['checkup', 'checkup'],
    ['models', 'models'], ['presets', 'presets'], ['notice', 'turn-notice'], ['progress', 'gen-progress'],
    ['debug', 'debug-request'],
];

// 审: 以本文件位置为基准的动态 import，面板装在任何位置（全局/用户目录/插件自动装的副本）都能找到兄弟文件。
const load = (path) => import(new URL(path, import.meta.url).href);

// 审: 防重复加载：扩展可能同时有手动装的和插件自动装的两份，后加载的那份什么都不做。
if (window.__claudeMaxUiLoaded) {
    console.log('[claude-max] another copy of the CCST extension is already active — this one will stay dormant');
} else {
    window.__claudeMaxUiLoaded = true;
    try {
        // 审: 必需模块（核心、共享库加载器、注册表）；缺任何一个面板都跑不了，所以一起 await，失败只打一条错误。
        // Required: the core and the shell. A copy that is missing them cannot run at all.
        const [boot, libs, registry] = await Promise.all([load('./core/boot.js'), load('./core/libs.js'), load('./core/registry.js')]);
        // 审: 可选功能各自 try/catch 并行加载；失败的功能不进注册表，调用方经 F 代理拿到空操作。
        // Optional: each feature on its own.
        await Promise.all(FEATURES.map(async ([name, file]) => {
            try {
                registry.registerFeature(name, await load(`./features/${file}.js`));
            } catch (err) {
                console.warn(`[claude-max] feature "${file}" unavailable`, err);
            }
        }));
        // 审: 异步加载 src/shared 的可选 helper，到位后触发 libHooks 里对应的重画/刷新。
        libs.loadLibs(boot.libHooks);
        // 审: 真正的启动（建面板、订阅、心跳、接酒馆事件）都在 core/boot.js。
        boot.boot();
    } catch (err) {
        console.error('[claude-max] failed to start', err);
    }
}
