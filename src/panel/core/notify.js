// ──────────────────────────────────────────────
// Notices: the 灵动岛 pill when the panel is open, an ordinary toast otherwise.
// `ui.island` is the pill (set by the bootstrap once shared/island.js is loaded).
// ──────────────────────────────────────────────

export const ui = { island: null };

const TOAST_KIND = { ok: 'success', info: 'info', warn: 'warning', bad: 'error' };
const toastByKey = {};
/** One notice: the island when the panel is open, a toast otherwise. */
export function notify(tone, title, text = '', opts = {}) {
    const ms = opts.ms ?? 6000;
    if (opts.replace && toastByKey[opts.replace]) {
        toastr?.clear?.(toastByKey[opts.replace]);
        delete toastByKey[opts.replace];
    }
    if (ui.island?.visible) return ui.island.notice({ tone, title, text, ms, replace: opts.replace, onDismiss: opts.onDismiss });
    if (opts.replace) ui.island?.clear(opts.replace);
    const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const t = toastr?.[TOAST_KIND[tone]]?.(esc(text).replace(/\n/g, '<br>'), `CCST · ${esc(title)}`, {
        timeOut: ms, extendedTimeOut: ms === 0 ? 0 : 1000, escapeHtml: false, preventDuplicates: true,
        // ST turns toastr's close button off: tapping the toast is how it gets dismissed.
        ...(opts.onDismiss ? { onclick: () => opts.onDismiss() } : {}),
    });
    if (opts.replace && t) toastByKey[opts.replace] = t;
    return t;
}

/** The panel was closed with notices still waiting in the pill: show them as toasts. */
export function flushIsland() {
    if (!ui.island?.pending || ui.island.visible || document.hidden) return;
    for (const n of ui.island.drain()) notify(n.tone, n.title, n.text, { ms: n.ms, replace: n.replace, onDismiss: n.onDismiss });
}

export function clearNotice(key) {
    if (toastByKey[key]) { toastr?.clear?.(toastByKey[key]); delete toastByKey[key]; }
    ui.island?.clear(key);
}
