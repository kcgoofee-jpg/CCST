// ──────────────────────────────────────────────
// Tab 其他: everything that is not core for vanilla SillyTavern, as collapsible sections.
//   查看发给模型的请求 / 调试选项 · 体检（实验） · 重新引导 · 使用说明
// The work itself is in features/ (debug-request).
// ──────────────────────────────────────────────

import { IS_TAURI, debugViewState } from '../core/capabilities.js';
import { el, toggleRow, collapsible, button } from '../core/dom.js';
import { F } from '../core/registry.js';
import { restartGuide } from '../guide.js';
import { buildCheckupSection } from './check.js';

export const USAGE_NOTES = (tauri = IS_TAURI) => [
    tauri ? '代理要在一台电脑上一直开着（电脑上的「酒馆工具」启动，或 npm start）。TauriTavern 里装不了酒馆插件。' : '代理要一直开着（「酒馆工具」启动，或 npm start）。',
    `第一次用：点面板顶部的「一键连接」，会自动选好 Claude 模型。`,
    '换模型、调思考深度，都在「推理」页。',
    `${tauri ? 'TauriTavern' : '酒馆'}自带的「推理强度」保持「自动」。`,
    '温度、Top-P 等采样参数不能用。',
    '带「(1M context)」的模型有 100 万上下文；用不了时会自动换成普通版。',
    '直连 Claude（官方、OpenRouter 等）也能用：换模型、调预设、发送前检查照常；缓存、防丢回复、额度统计要走代理。',
];

function usageNotes() {
    const { root, body } = collapsible('使用说明', '代理、连接、思考深度、直连 Claude 的要点。');
    const list = el('ol', 'cm-notes');
    for (const line of USAGE_NOTES()) list.append(el('li', null, line));
    body.append(list);
    return root;
}

/** Tab 其他: see the header comment. Sections are folded; the description under each title says what it is. */
export function buildOtherTab(pane, settings, save) {
    pane.classList.add('cm-list');

    const dbg = collapsible('查看发给模型的请求', '排查缓存和提示词时，看最近一次发出的完整内容。', { id: 'claude_max_debug' });
    dbg.body.append(toggleRow({
        id: 'claudeMaxDebugDump', title: '保存最近一次完整请求', desc: '存到代理 data/debug/（本机，每次覆盖）。',
        checked: settings.debugDump, onChange: (v) => { settings.debugDump = v; save(); },
    }));
    const viewBtn = button('查看发给模型的内容', () => F.debug.showDebugRequest(), { icon: 'fa-magnifying-glass', text: true });
    const viewHint = el('small', 'cm-hint');
    const syncView = () => {
        const st = debugViewState(settings);
        viewBtn.disabled = !st.enabled;
        viewHint.textContent = st.hint;
        viewHint.hidden = st.enabled;
    };
    syncView();
    dbg.body.querySelector('#claudeMaxDebugDump')?.addEventListener('change', syncView);
    dbg.body.append(viewBtn, viewHint);
    pane.append(dbg.root);

    pane.append(buildCheckupSection(settings, save));

    pane.append(button('重新引导（选来源 → 连接 → 完成）', () => restartGuide(), { icon: 'fa-compass', id: 'claude_max_guide_again', text: true }));

    pane.append(usageNotes());
}
