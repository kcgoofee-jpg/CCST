// ──────────────────────────────────────────────
// 其他 → Mac 遥控（手机遥控）: the proxy's /v1/control routes (src/proxy/platform/control.js).
// Until 4.0 this was a tab of its own; now it is a section of 其他 that stays hidden until the proxy
// says it runs on the Mac launcher.
// ──────────────────────────────────────────────

import { canSyncPhone, PHONE_SYNC_WARNING, PHONE_SYNC_LABEL } from '../core/capabilities.js';
import { controlFetch } from '../core/proxy.js';
import { el, note, collapsible, popupText, stateLine } from '../core/dom.js';
import { notify } from '../core/notify.js';
import { copyText } from '../core/external.js';

const SECTION_ID = 'claude_max_mac_section';

/** Show / hide the Mac section (hidden unless the proxy runs on the Mac launcher). */
function setMacSection(on) {
    const root = document.getElementById(SECTION_ID);
    if (root) root.hidden = !on;
}

// Read when the panel opens and when 其他 is entered; the section stays
// hidden unless the proxy was started by the Mac launcher.
export async function refreshMac() {
    if (!document.getElementById('claude_max_mac')) return;
    let s;
    try {
        const res = await controlFetch('/v1/control/status');
        s = await res.json();
    } catch {
        s = null;
    }
    const box = document.getElementById('claude_max_mac');
    if (!box) return;
    if (s && !s.supported) { setMacSection(false); return; }
    if (!s) {
        // Only worth a line when this proxy was known to be the Mac's (the section is shown already).
        box.replaceChildren(stateLine('error', '连不上代理，看不到 Mac 状态。', refreshMac));
        return;
    }
    setMacSection(true);
    const lid = s.lid ?? {};
    const lines = [
        `模式：${s.phoneMode ? '手机模式' : '电脑模式'}${s.watchdog ? '（守护中）' : ''}${s.ip ? ` · ${s.ip}` : ''}`,
        `电量：${s.battery ?? '?'}%${s.onBattery ? '（用电池）' : '（插着电）'}${lid.closed == null ? '' : ` · 盖子${lid.closed ? '合着' : '开着'}`}`,
        `合盖不睡：${!lid.installed ? '没安装' : lid.paused ? '已暂停' : lid.on ? '开着' : '放开了（电量低 / 闲置）'}`,
        `本地生图：${s.comfy ? '运行中' : '没开'} · 在写的回复：${s.busy}`,
    ];
    const card = note('info');
    for (const l of lines) card.append(el('small', 'cm-hint', l));
    for (const e of s.recentErrors ?? []) card.append(el('small', 'cm-hint cm-warn', `错误：${e}`));
    const row = el('div', 'cm-btn-row');
    const act = (label, action, confirmText) => {
        const b = el('button', 'menu_button cm-btn', label);
        b.type = 'button';
        b.addEventListener('click', async () => {
            if (confirmText) {
                // window.confirm may do nothing in TauriTavern's web view.
                const ctx = SillyTavern.getContext();
                const lines = Array.isArray(confirmText) ? confirmText : [confirmText];
                if (!await ctx.callGenericPopup(popupText(...lines), ctx.POPUP_TYPE.CONFIRM)) return;
            }
            b.disabled = true;
            try {
                const res = await controlFetch('/v1/control/action', { action });
                const r = await res.json().catch(() => ({}));
                notify(res.ok ? 'ok' : 'warn', `Mac · ${label}`, String(r.message ?? `HTTP ${res.status}`));
            } catch {
                notify('warn', `Mac · ${label}`, '没发出去：连不上代理，请确认它还在运行');
            } finally {
                b.disabled = false;
                setTimeout(refreshMac, action === 'restart-proxy' ? 6000 : 1500);
            }
        });
        row.append(b);
    };
    act('重启代理', 'restart-proxy', '重启 Mac 上的代理？几秒后自动恢复。');
    // Syncs the phone's TauriTavern: only makes sense from inside it.
    if (canSyncPhone(s)) act(PHONE_SYNC_LABEL, 'phone-sync', [PHONE_SYNC_WARNING, '仍要从 Mac 同步这台手机？TauriTavern 会先关闭，同步完自动重新打开。']);
    const copyBtn = el('button', 'menu_button cm-btn', '复制');
    copyBtn.type = 'button';
    copyBtn.style.display = 'none'; // .menu_button sets display, which would override [hidden]
    copyBtn.addEventListener('click', async () => {
        if (await copyText(pre.textContent)) {
            notify('ok', 'Mac · 看日志', '已复制');
        } else {
            // No clipboard permission (TauriTavern web view): select the text so the user can copy it by hand.
            const range = document.createRange();
            range.selectNodeContents(pre);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            notify('info', 'Mac · 看日志', '已全选，请手动复制');
        }
    });
    const logBtn = el('button', 'menu_button cm-btn', '看日志');
    logBtn.type = 'button';
    const pre = el('pre', 'cm-log');
    pre.hidden = true;
    logBtn.addEventListener('click', async () => {
        if (!pre.hidden) { pre.hidden = true; copyBtn.style.display = 'none'; return; }
        try {
            const r = await (await controlFetch('/v1/control/log')).json();
            pre.textContent = [...(r.launcher ?? []), '──', ...(r.proxy ?? [])].join('\n');
            pre.hidden = false;
            copyBtn.style.display = '';
        } catch {
            notify('warn', 'Mac · 看日志', '没取到日志：连不上代理');
        }
    });
    row.append(logBtn, copyBtn);
    box.replaceChildren(card, row, pre);
}

/** 其他 → Mac 遥控: the phone's remote for the Mac launcher. Hidden until the proxy says it runs there. */
export function buildMacSection() {
    const { root, body } = collapsible('Mac 遥控', '看 Mac 上代理的状态，重启代理、同步手机、看日志。', { id: SECTION_ID });
    root.hidden = true;
    const macBox = el('div', 'cm-field');
    macBox.id = 'claude_max_mac';
    body.append(macBox);
    return root;
}
