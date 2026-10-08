// ──────────────────────────────────────────────
// Notices: SillyTavern's ordinary toasts (toastr). `replace` swaps the earlier toast of that key.
// ──────────────────────────────────────────────

// 审: 面板的语气 → toastr 方法名。
const TOAST_KIND = { ok: 'success', info: 'info', warn: 'warning', bad: 'error' };
// 审: 带 replace 键的 toast 句柄，用于替换/清除同一键的旧提示。
const toastByKey = {};
// 审: 面板唯一的通知出口（酒馆 toastr），文本做 HTML 转义；replace 键替换旧提示，ms=0 常驻。
export function notify(tone, title, text = '', opts = {}) {
    const ms = opts.ms ?? 6000;
    if (opts.replace && toastByKey[opts.replace]) {
        toastr?.clear?.(toastByKey[opts.replace]);
        delete toastByKey[opts.replace];
    }
    const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const t = toastr?.[TOAST_KIND[tone]]?.(esc(text).replace(/\n/g, '<br>'), `CCST · ${esc(title)}`, {
        timeOut: ms, extendedTimeOut: ms === 0 ? 0 : 1000, escapeHtml: false, preventDuplicates: true,
    });
    if (opts.replace && t) toastByKey[opts.replace] = t;
    return t;
}

// 审: 清掉某个键的常驻提示（代理恢复/不再相关时）。
export function clearNotice(key) {
    if (toastByKey[key]) { toastr?.clear?.(toastByKey[key]); delete toastByKey[key]; }
}
