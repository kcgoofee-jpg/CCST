// ──────────────────────────────────────────────
// Notices: SillyTavern's ordinary toasts (toastr). `replace` swaps the earlier toast of that key.
// ──────────────────────────────────────────────

const TOAST_KIND = { ok: 'success', info: 'info', warn: 'warning', bad: 'error' };
const toastByKey = {};
export function notify(tone, title, text = '', opts = {}) {
    const ms = opts.ms ?? 6000;
    if (opts.replace && toastByKey[opts.replace]) {
        toastr?.clear?.(toastByKey[opts.replace]);
        delete toastByKey[opts.replace];
    }
    const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const t = toastr?.[TOAST_KIND[tone]]?.(esc(text).replace(/\n/g, '<br>'), `CCST · ${esc(title)}`, {
        timeOut: ms, extendedTimeOut: ms === 0 ? 0 : 1000, escapeHtml: false, preventDuplicates: true,
        // ST turns toastr's close button off: tapping the toast is how it gets dismissed.
        ...(opts.onDismiss ? { onclick: () => opts.onDismiss() } : {}),
    });
    if (opts.replace && t) toastByKey[opts.replace] = t;
    return t;
}

export function clearNotice(key) {
    if (toastByKey[key]) { toastr?.clear?.(toastByKey[key]); delete toastByKey[key]; }
}
