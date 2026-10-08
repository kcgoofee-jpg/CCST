// ──────────────────────────────────────────────
// The pieces the connect card and the first-run guide share: a copy button that survives redraws, a
// step with a copyable command, and a download / link with its URL to copy.
// ──────────────────────────────────────────────

import { el } from './dom.js';
import { notify } from './notify.js';
import { openExternal, copyText } from './external.js';

// 审: 复制按钮的「已复制」反馈按文本记住；卡片每次 store 变化都重画，不记的话反馈会被冲掉。
// The cards are redrawn whenever the store changes, which would wipe a button's "已复制" before it is seen:
// the feedback is kept per text and re-applied to the fresh button, and a toast says it too.
const copyFeedback = new Map(); // text -> { label, until }
// 审: 复制反馈保留时长。
const COPY_FEEDBACK_MS = 2000;

// 审: 复制按钮，点击后把反馈重新应用到重画后的新按钮，同时弹 toast。
function copyButton(idle, text) {
    const btn = el('button', 'cm-link-btn', idle);
    btn.type = 'button';
    const apply = () => {
        const fb = copyFeedback.get(text);
        btn.textContent = fb && fb.until > Date.now() ? fb.label : idle;
    };
    apply();
    btn.addEventListener('click', async () => {
        const ok = await copyText(text);
        copyFeedback.set(text, { label: ok ? '已复制' : '请手动选中复制', until: Date.now() + COPY_FEEDBACK_MS });
        notify(ok ? 'ok' : 'warn', ok ? '已复制' : '复制失败', ok ? '' : '请手动选中复制', { ms: 2500, replace: 'copy' });
        apply();
        setTimeout(() => { if (btn.isConnected) apply(); }, COPY_FEEDBACK_MS + 50);
    });
    return btn;
}

// 审: 命令框 + 复制按钮，引导和卡片里要用户运行的命令都用它。
/** A command in a box with a copy button. */
export function cmdRow(cmd, label = '复制') {
    const row = el('div', 'cm-cmd');
    row.append(el('code', null, cmd), copyButton(label, cmd));
    return row;
}

// 审: 一个编号步骤：文字，有命令的话带命令框。
/** One step: text, and a command (if any) in a box with a copy button. */
export function stepItem(step) {
    const { text, cmd } = step;
    const li = el('li', null, text);
    if (cmd) li.append(cmdRow(cmd));
    return li;
}

// 审: 链接按钮：扩展自带文件在浏览器里真下载，其他链接走系统浏览器（TauriTavern 的 <a> 不会自己打开）。
/** A button that works where the panel runs: a real download for the extension's own file in a browser,
 *  the system browser for other links (through TauriTavern's opener). */
export function linkButton(d) {
    const a = el('a', 'menu_button cm-btn', d.label);
    a.href = d.href;
    if (d.download) a.setAttribute('download', d.file);
    else {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.addEventListener('click', (e) => { e.preventDefault(); void openExternal(d.href); });
    }
    return a;
}

// 审: 一个下载/链接条目：按钮 + 可复制的 URL，按钮没反应时用户仍有办法。
/**
 * One download / link: the button, plus the URL as text and a copy button, so there is always something
 * to do when the button does nothing.
 */
export function downloadItem(d) {
    const box = el('div', 'cm-dl');
    box.append(linkButton(d), cmdRow(d.copy ?? d.href, d.copyLabel ?? '复制'));
    return box;
}
