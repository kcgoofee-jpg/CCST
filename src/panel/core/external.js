// ──────────────────────────────────────────────
// Open a link in the system browser / copy text, in a way that works inside TauriTavern too.
// TauriTavern's webview ignores <a download> and does not open links on its own on desktop: it exposes
// the Tauri opener plugin (capability opener:default) and clipboard plugin through window.__TAURI__.
// Browser: a plain window.open / navigator.clipboard.
// ──────────────────────────────────────────────

const tauriInvoke = (win = globalThis.window) => {
    const fn = win?.__TAURI__?.core?.invoke;
    return typeof fn === 'function' ? fn : null;
};

/** Open `url` in the system browser. Resolves true when something was asked to open it. */
export async function openExternal(url, win = globalThis.window) {
    const invoke = tauriInvoke(win);
    if (invoke) {
        try { await invoke('plugin:opener|open_url', { url }); return true; } catch { /* fall through */ }
    }
    try { win.open(url, '_blank', 'noopener,noreferrer'); return true; } catch { return false; }
}

/** Copy text; true on success. Falls back to the TauriTavern clipboard plugin. */
export async function copyText(text, win = globalThis.window) {
    try { await win.navigator.clipboard.writeText(text); return true; } catch { /* try the plugin */ }
    const invoke = tauriInvoke(win);
    if (invoke) {
        try { await invoke('plugin:clipboard-manager|write_text', { text }); return true; } catch { /* give up */ }
    }
    return false;
}
