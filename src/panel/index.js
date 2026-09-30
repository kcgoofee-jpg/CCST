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
//   tabs/       one module per tab (推理 / 状态 / 体检 / 设置 / 其他)
//   features/   optional pieces (reply keeper, check-up, card check, lore cache, backend form, …):
//               each is loaded on its own, and one that fails to load is skipped, never fatal
//   ../shared/  pure helpers also used by the tests, loaded by core/libs.js the same forgiving way
//
// What it does:
//   • One-click Connect: pilots SillyTavern's Custom (OpenAI-compatible) source at the plugin's local
//     endpoint — no URL typing. The endpoint and key are set BEFORE the source switch because ST's
//     change handler auto-reconnects immediately with whatever URL is current.
//   • Claude-native settings (effort low..max, thinking mode, reasoning display, identity mode,
//     session resume) injected per-request through `custom_include_body` — the only channel ST's
//     backend forwards unconditionally for Custom sources. ST's own Reasoning Effort dropdown is
//     bypassed entirely (it downgrades max→high client-side and drops the field for Claude model IDs
//     server-side); leave it on "Auto".
//   • Quota meter: the proxy directly first (source of truth); with the default endpoint, ST's
//     same-origin plugin route as the fallback (works from remote browsers, where 127.0.0.1 is not
//     the proxy).
//
// Injection is scoped: it only fires when the active connection actually points at this plugin's
// endpoint, so other Custom endpoints (Meridian, llama.cpp, etc.) are untouched.

// [name it registers under (F.<name>), file in features/]
const FEATURES = [
    ['keeper', 'reply-keeper'], ['lore', 'lore-cache'], ['checkup', 'checkup'], ['audit', 'card-audit'],
    ['backend', 'backend-form'], ['perf', 'perf-diag'], ['quiet', 'quiet-render'], ['compact', 'compact-buttons'],
    ['models', 'models'], ['presets', 'presets'], ['notice', 'turn-notice'], ['island', 'gen-island'],
    ['score', 'image-score'], ['debug', 'debug-request'],
];

const load = (path) => import(new URL(path, import.meta.url).href);

if (window.__claudeMaxUiLoaded) {
    console.log('[claude-max] another copy of the CCST extension is already active — this one will stay dormant');
} else {
    window.__claudeMaxUiLoaded = true;
    try {
        // Required: the core and the shell. A copy that is missing them cannot run at all.
        const [boot, libs, registry] = await Promise.all([load('./core/boot.js'), load('./core/libs.js'), load('./core/registry.js')]);
        // Optional: each feature on its own.
        await Promise.all(FEATURES.map(async ([name, file]) => {
            try {
                registry.registerFeature(name, await load(`./features/${file}.js`));
            } catch (err) {
                console.warn(`[claude-max] feature "${file}" unavailable`, err);
            }
        }));
        libs.loadLibs(boot.libHooks);
        boot.boot();
    } catch (err) {
        console.error('[claude-max] failed to start', err);
    }
}
