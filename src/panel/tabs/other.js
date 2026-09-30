// ──────────────────────────────────────────────
// Tab 其他: everything that is not core for vanilla SillyTavern, as collapsible sections. Frozen features
// (phone / TauriTavern / Mac) stay working here; nothing was removed when the main line narrowed to
// SillyTavern in 4.0.
//   Mac 遥控 (only when the proxy runs on the Mac launcher) · 手机连接 · 省电显示 · 性能诊断 ·
//   脚本按钮并排 · 查看发给模型的请求 / 调试选项 · 使用说明
// The work itself is in features/ (quiet-render, perf-diag, compact-buttons, debug-request).
// ──────────────────────────────────────────────

import { IS_TAURI } from '../core/capabilities.js';
import { DEFAULT_ENDPOINT } from '../core/settings.js';
import { el, segmented, toggleRow, collapsible } from '../core/dom.js';
import { F } from '../core/registry.js';
import { buildMacSection } from './mac.js';
import { endpointField, accessKeyField, reconnectButton } from './settings.js';

function usageNotes() {
    const { root, body } = collapsible('使用说明', '第一次用时看一眼：代理、连接、思考深度、直连 Claude。');
    const list = el('ol', 'cm-notes');
    for (const line of [
        '代理要一直开着（npm start；装了服务器插件的酒馆会自动启动）。',
        '点「一键连接」，再在「API 连接」里选 Claude 模型。',
        '酒馆自带的「推理强度」保持「自动」，思考深度在「推理」页设。',
        IS_TAURI
            ? '首次连接 TauriTavern 会弹授权框，允许即可。'
            : `默认地址 ${DEFAULT_ENDPOINT} 时，其他设备打开的酒馆经酒馆服务器读额度和状态。`,
        '不支持温度、Top-P 等采样参数（Agent SDK 限制）。',
        '「(1M context)」模型有 100 万上下文；不可用时自动退回普通版一小时。',
        '直连 Claude（官方源、OpenRouter、Electron Hub、NanoGPT、AI/ML API、CometAPI、自定义地址）也能用：模型切换、按模型调整预设、发送前检查、体检、灵动岛照常；缓存排布、防丢回复、额度统计要走代理。',
    ]) list.append(el('li', null, line));
    body.append(list);
    return root;
}

/** Tab 其他: see the header comment. Sections are folded; the description under each title says what it is. */
export function buildOtherTab(pane, settings, save) {
    pane.append(el('small', 'cm-hint', '主线以外的功能：手机、TauriTavern、Mac，以及一些显示和排查用的选项。都还能用，不再增加新功能。'));

    // Mac 遥控: hidden by default; refreshMac() shows it when the proxy reports it runs on the Mac launcher.
    pane.append(buildMacSection());

    const lan = collapsible('手机连接', '手机上的酒馆连电脑上的代理时，填电脑的地址和访问密码。', { id: 'claude_max_lan' });
    lan.body.append(
        endpointField(settings, save, { id: 'claude_max_endpoint_lan', hint: `填「酒馆工具」标题栏的地址，形如 http://电脑的局域网地址:8901/v1（手机同步会自动填）。本机使用保持 ${DEFAULT_ENDPOINT}。` }),
        accessKeyField(settings, save),
        reconnectButton(),
    );
    pane.append(lan.root);

    const quiet = collapsible('省电显示', '旧楼层的美化动画只播一遍、不做毛玻璃，手机上更省电更不卡。', { id: 'claude_max_quiet' });
    quiet.body.append(segmented({
        label: '省电显示',
        options: [
            { value: 'auto', label: '自动', hint: '手机和 TauriTavern 上开，电脑上关。' },
            { value: 'on', label: '开', hint: '旧楼层动画只播一遍、不做毛玻璃，悬浮挂件约 20 秒后停。' },
            { value: 'off', label: '关', hint: '动画照常循环。' },
        ],
        current: ['on', 'off'].includes(settings.quietRender) ? settings.quietRender : 'auto',
        onChange: (v) => { settings.quietRender = v; F.quiet.applyQuietRender(); save(); F.perf.renderPerfNote(); },
    }));
    pane.append(quiet.root);

    const perf = collapsible('性能诊断', '测几秒：哪些楼层的动画、内嵌窗口让页面卡。', { id: 'claude_max_perf_section' });
    const perfNote = el('small', 'cm-hint');
    perfNote.id = 'claude_max_perf_note';
    const perfRun = el('div', 'menu_button cm-connect cm-connect-quiet');
    perfRun.append(el('i', 'fa-solid fa-gauge-high'), document.createTextNode(' 测一次（约 4 秒）'));
    perfRun.addEventListener('click', () => F.perf.showPerfDiag());
    const perfBox = el('div', 'cm-stats');
    perfBox.id = 'claude_max_perf';
    perf.body.append(perfNote, perfRun, perfBox);
    F.perf.renderPerfNote(perfNote); // not in the document yet
    pane.append(perf.root);

    const compact = collapsible('脚本按钮并排', '酒馆助手的脚本按钮在输入栏排成一行。', { id: 'claude_max_compact' });
    compact.body.append(toggleRow({
        id: 'claudeMaxCompactButtons', title: '输入栏脚本按钮并排', desc: '酒馆助手的脚本按钮排成一行。',
        checked: settings.compactScriptButtons, onChange: (v) => { settings.compactScriptButtons = v; save(); F.compact.applyCompactButtons(); },
    }));
    pane.append(compact.root);

    const dbg = collapsible('查看发给模型的请求 / 调试选项', '看最近一次发给模型的完整内容，排查缓存和提示词问题时用。', { id: 'claude_max_debug' });
    dbg.body.append(toggleRow({
        id: 'claudeMaxDebugDump', title: '保存最近一次完整请求', desc: '存到代理 data/debug/（本机，每次覆盖）。',
        checked: settings.debugDump, onChange: (v) => { settings.debugDump = v; save(); },
    }));
    const debugBtn = el('div', 'menu_button cm-connect cm-connect-quiet');
    debugBtn.append(el('i', 'fa-solid fa-magnifying-glass'), document.createTextNode(' 查看发给模型的内容'));
    debugBtn.addEventListener('click', () => F.debug.showDebugRequest());
    dbg.body.append(debugBtn);
    pane.append(dbg.root);

    pane.append(usageNotes());
}
