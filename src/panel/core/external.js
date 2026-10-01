// ──────────────────────────────────────────────
// Open a link in the system browser / copy text, in a way that works inside TauriTavern too.
// TauriTavern's webview ignores <a download> and does not open links on its own on desktop: it exposes
// the Tauri opener plugin (capability opener:default) and clipboard plugin (clipboard-manager:allow-write-text)
// through window.__TAURI__. Browser: a plain window.open / navigator.clipboard.
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

const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    Promise.resolve(promise).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

/** The classic fallback: a hidden textarea + execCommand('copy'). Needs no permission and no secure context. */
function execCopy(text, win) {
    const doc = win?.document;
    if (!doc?.body || typeof doc.execCommand !== 'function') return false;
    const ta = doc.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    doc.body.append(ta);
    try {
        ta.focus();
        ta.select();
        ta.setSelectionRange?.(0, text.length);
        return !!doc.execCommand('copy');
    } catch { return false; } finally { ta.remove(); }
}

/**
 * Copy text; true on success. Order: TauriTavern's own clipboard plugin (what its copy buttons use; the web
 * clipboard can hang forever in its WKWebView), then navigator.clipboard (with a timeout: it may never settle),
 * then the hidden-textarea execCommand fallback.
 */
export async function copyText(text, win = globalThis.window, timeoutMs = 800) {
    const invoke = tauriInvoke(win);
    if (invoke) {
        try { await withTimeout(invoke('plugin:clipboard-manager|write_text', { text }), timeoutMs); return true; } catch { /* next */ }
    }
    if (typeof win?.navigator?.clipboard?.writeText === 'function') {
        try { await withTimeout(win.navigator.clipboard.writeText(text), timeoutMs); return true; } catch { /* next */ }
    }
    return execCopy(text, win);
}
