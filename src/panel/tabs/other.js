// ──────────────────────────────────────────────
// Tab 其他: everything that is not core for vanilla SillyTavern, as collapsible sections. Frozen features
// (phone / TauriTavern / Mac) stay working here; nothing was removed when the main line narrowed to
// SillyTavern in 4.0.
//   Mac 遥控 (only when the proxy runs on the Mac launcher) · 手机连接 · 省电显示 · 性能诊断 ·
//   脚本按钮并排 · 查看发给模型的请求 / 调试选项 · 体检（实验） · 使用说明
// The work itself is in features/ (quiet-render, perf-diag, compact-buttons, debug-request).
// ──────────────────────────────────────────────

import { IS_TAURI, isPhoneLike, debugViewState } from '../core/capabilities.js';
import { el, segmented, toggleRow, collapsible, button } from '../core/dom.js';
import { F } from '../core/registry.js';
import { buildMacSection } from './mac.js';
import { restartGuide } from '../guide.js';
import { buildCheckupSection } from './check.js';
import { connectCodeField, stEndpointField, reconnectButton } from './settings.js';

/** 「酒馆侧地址」 is for Docker on a desktop browser only: not in TauriTavern, not on a phone / touch device. */
export function showStEndpoint(p) {
    return !isPhoneLike(p);
}

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
    
    // Mac 遥控: hidden by default; refreshMac() shows it when the proxy reports it runs on the Mac launcher.
    pane.append(buildMacSection());

    const lan = collapsible('手机连接', '手机连电脑上的代理：粘贴电脑上的手机连接码。', { id: 'claude_max_lan' });
    lan.body.append(
        connectCodeField(settings, save),
        el('small', 'cm-hint', '电脑上打开「酒馆工具」，开手机模式，首页会显示「手机连接码」，整行粘贴到这里（手机同步会自动填）。本机使用时留空。'),
        ...(showStEndpoint() ? [stEndpointField(settings, save)] : []),
        reconnectButton(),
    );
    pane.append(lan.root);

    const quiet = collapsible('省电显示', '旧楼层动画只播一遍，手机上通常更省电、更不卡。', { id: 'claude_max_quiet' });
    quiet.body.append(segmented({
        label: '省电显示', hideLabel: true,
        options: [
            { value: 'auto', label: '自动', hint: '手机和 TauriTavern 上开，电脑上关。' },
            { value: 'on', label: '开', hint: '旧楼层动画只播一遍、不做毛玻璃，悬浮挂件约 20 秒后停。' },
            { value: 'off', label: '关', hint: '动画照常循环。' },
        ],
        current: ['on', 'off'].includes(settings.quietRender) ? settings.quietRender : 'auto',
        onChange: (v) => { settings.quietRender = v; F.quiet.applyQuietRender(); save(); F.perf.renderPerfNote(); },
    }));
    pane.append(quiet.root);

    const perf = collapsible('性能诊断', '测几秒，找出让页面卡的楼层。', { id: 'claude_max_perf_section' });
    const perfNote = el('small', 'cm-hint');
    perfNote.id = 'claude_max_perf_note';
    const perfRun = button('测一次（约 4 秒）', () => F.perf.showPerfDiag(), { icon: 'fa-gauge-high' });
    const perfBox = el('div', 'cm-stats');
    perfBox.id = 'claude_max_perf';
    perf.body.append(perfNote, perfRun, perfBox);
    F.perf.renderPerfNote(perfNote); // not in the document yet
    pane.append(perf.root);

    const compact = collapsible('脚本按钮并排', '酒馆助手的脚本按钮排成一行。', { id: 'claude_max_compact' });
    compact.body.append(toggleRow({
        id: 'claudeMaxCompactButtons', title: '输入栏脚本按钮并排', desc: '省一行输入栏高度。',
        checked: settings.compactScriptButtons, onChange: (v) => { settings.compactScriptButtons = v; save(); F.compact.applyCompactButtons(); },
    }));
    pane.append(compact.root);

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
