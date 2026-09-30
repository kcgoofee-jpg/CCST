// ──────────────────────────────────────────────
// Tab 设置: connection (the only copy of the address / password fields), backend, debug options, notes.
// ──────────────────────────────────────────────

import { store } from '../core/store.js';
import { getSettings, DEFAULT_ENDPOINT, VALID_THINKING, THINKING_OPTIONS } from '../core/settings.js';
import { IS_TAURI, normalizeEndpoint } from '../core/capabilities.js';
import { el, segmented, toggleRow, section } from '../core/dom.js';
import { notify } from '../core/notify.js';
import { F } from '../core/registry.js';
import { refreshStatus, refreshBackend } from '../core/live.js';
import { connect, renderGlance, SUBSCRIPTION_LABELS, SOURCE_LABELS } from '../shell.js';
import { syncThinkingControls } from './reason.js';

export function init() {
    // The proxy line under 连接 follows the status.
    store.subscribe('status', ({ status }) => {
        if (status.phase !== 'online') return;
        const { cred, version } = status;
        const plan = SUBSCRIPTION_LABELS[cred.subscriptionType] ?? cred.subscriptionType ?? '订阅';
        const info = document.getElementById('claude_max_proxy_info');
        if (info) info.textContent = `代理 v${version} 在线 · ${plan} 订阅 · 凭据：${SOURCE_LABELS[cred.source] ?? cred.source}`;
    });
}

function usageNotes() {
    const steps = el('details', 'cm-details');
    steps.append(el('summary', null, '使用说明'));
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
    steps.append(list);
    return steps;
}

/** Tab 设置: connection (the only copy of the address / password fields), debug options, notes. */
export function buildSettingsTab(pane, settings, save) {
    pane.append(section('连接'));
    const info = el('small', 'cm-hint');
    info.id = 'claude_max_proxy_info';
    pane.append(info, connectionFields(settings, save));

    pane.append(section('代理后端'));
    const backendBox = el('div', 'cm-conn-fields');
    backendBox.id = 'claude_max_backend';
    backendBox.append(el('small', 'cm-hint', '加载中…'));
    pane.append(backendBox);
    // The pane isn't in the document yet (refreshBackend looks the box up by id): fetch once it is.
    queueMicrotask(() => setTimeout(refreshBackend, 0));

    // Everything below decides itself (defaults, the preset's own
    // recommendation, the proxy watching each chat). Kept for chasing
    // problems, folded away so nobody has to think about it.
    const dbg = el('details', 'cm-details cm-debug-box');
    dbg.append(el('summary', null, '调试选项'));
    dbg.append(el('small', 'cm-hint', '一般不用动：缓存项默认开、代理按聊天自动决定；思考和身份模式随预设推荐；省电显示按设备自动。'));
    const add = (x) => dbg.append(x);

    add(section('缓存与上下文'));
    add(toggleRow({
        id: 'claudeMaxResume', title: '会话续接', desc: '按真实多轮发送，能用缓存。',
        more: '关掉会把聊天记录压成一整段，只在排查时关。',
        checked: settings.useResume, onChange: (v) => { settings.useResume = v; save(); },
    }));
    add(toggleRow({
        id: 'claudeMaxInlineSystem', title: '深度注入保持原位', desc: '深度条目留在原位（预设可推荐）。',
        more: '预设深度条目、世界书深度条目、作者注释留在原位，同酒馆直连。关掉则都提到系统提示词，一条变化整个系统提示词缓存失效。',
        checked: settings.inlineSystem, onChange: (v) => { settings.inlineSystem = v; save(); },
    }));
    add(toggleRow({
        id: 'claudeMaxLoreTail', title: '世界书变化部分移到末尾', desc: '每轮在变的世界书挪进本轮消息。',
        more: '系统提示词和旧聊天记录每轮不变，能读缓存，只重写最近一轮。',
        checked: settings.loreTail, onChange: (v) => { settings.loreTail = v; save(); },
    }));
    add(toggleRow({
        id: 'claudeMaxFoldTail', title: '发言后的注入并进发言', desc: '放在你发言后的条目并进发言。',
        more: 'MVU 等变量卡把状态以「深度 0」放在发言后；并进去后下一轮原样重放，缓存对得上。',
        checked: settings.foldTail, onChange: (v) => { settings.foldTail = v; save(); },
    }));
    add(toggleRow({
        id: 'claudeMaxTailBlock', title: '实验：预设后置条目提前', desc: '只对 Ny、图灵这类预设有用。',
        more: '把每轮不变的后置条目挪到对话最前，旧楼层能命中缓存；代价是规则离回复更远。',
        checked: settings.tailBlockFront, onChange: (v) => { settings.tailBlockFront = v; save(); },
    }));

    add(section('思考'));
    const thinking = segmented({
        label: '思考模式',
        options: THINKING_OPTIONS,
        current: settings.thinking,
        onChange: (v) => { settings.thinking = VALID_THINKING.includes(v) ? v : 'adaptive'; save(); renderGlance(); syncThinkingControls(); },
    });
    thinking.id = 'claude_max_thinking';
    add(thinking);
    add(segmented({
        label: '后台请求思考深度',
        options: [
            { value: 'low', label: '低', hint: '其他插件的后台请求（生图 tag、总结）用「低」，快、省额度。' },
            { value: 'follow', label: '跟随', hint: '后台请求也用「推理」页的深度。' },
        ],
        current: settings.quietEffort === 'follow' ? 'follow' : 'low',
        onChange: (v) => { settings.quietEffort = v === 'follow' ? 'follow' : 'low'; save(); },
    }));
    add(toggleRow({
        id: 'claudeMaxShowReasoning', title: '显示思考过程', desc: '跟随酒馆「显示模型思维」；关掉则总不显示。',
        checked: settings.showReasoning, onChange: (v) => { settings.showReasoning = v; save(); },
    }));
    add(toggleRow({
        id: 'claudeMaxIdentity', title: '身份模式', desc: '角色扮演建议关（预设可推荐）。',
        more: '加上 Claude Code 官方前言，模型能说出型号，但多耗 token、带编程助手味。',
        checked: settings.identityMode, onChange: (v) => { settings.identityMode = v; save(); },
    }));

    add(section('显示'));
    add(segmented({
        label: '省电显示',
        options: [
            { value: 'auto', label: '自动', hint: '手机和 TauriTavern 上开，电脑上关。' },
            { value: 'on', label: '开', hint: '旧楼层动画只播一遍、不做毛玻璃，悬浮挂件约 20 秒后停。' },
            { value: 'off', label: '关', hint: '动画照常循环。' },
        ],
        current: ['on', 'off'].includes(settings.quietRender) ? settings.quietRender : 'auto',
        onChange: (v) => { settings.quietRender = v; F.quiet.applyQuietRender(); save(); F.perf.renderPerfNote(); },
    }));
    add(toggleRow({
        id: 'claudeMaxCheckupToast', title: '体检有问题时提示', desc: '点一下关掉；同类点掉两次不再提示。',
        checked: settings.checkupToast, onChange: (v) => { settings.checkupToast = v; save(); },
    }));
    add(toggleRow({
        id: 'claudeMaxCompactButtons', title: '输入栏脚本按钮并排', desc: '酒馆助手的脚本按钮排成一行。',
        checked: settings.compactScriptButtons, onChange: (v) => { settings.compactScriptButtons = v; save(); F.compact.applyCompactButtons(); },
    }));

    add(section('请求'));
    add(toggleRow({
        id: 'claudeMaxDebugDump', title: '保存最近一次完整请求', desc: '存到代理 data/debug/（本机，每次覆盖）。',
        checked: settings.debugDump, onChange: (v) => { settings.debugDump = v; save(); },
    }));
    const debugBtn = el('div', 'menu_button cm-connect cm-connect-quiet');
    debugBtn.append(el('i', 'fa-solid fa-magnifying-glass'), document.createTextNode(' 查看发给模型的内容'));
    debugBtn.addEventListener('click', () => F.debug.showDebugRequest());
    add(debugBtn);
    pane.append(dbg, usageNotes());
}

/** Proxy address + access key, in 设置 (the status note links here while the proxy can't be reached). */
function connectionFields(settings, save) {
    const box = el('div', 'cm-conn-fields');
    const endpointField = el('div', 'cm-field');
    endpointField.append(el('div', 'cm-field-label', '代理地址'));
    const endpointInput = el('input', 'text_pole cm-endpoint-input');
    endpointInput.type = 'text';
    endpointInput.id = 'claude_max_endpoint';
    endpointInput.value = settings.endpoint;
    endpointInput.placeholder = DEFAULT_ENDPOINT;
    // Committed on change (Enter / leaving the field), not per keystroke:
    // half-typed addresses would be saved and probed by the heartbeat.
    endpointInput.addEventListener('change', () => {
        const next = normalizeEndpoint(endpointInput.value) || DEFAULT_ENDPOINT;
        if (normalizeEndpoint(settings.endpoint) === next) return;
        settings.endpoint = next;
        endpointInput.value = next;
        save();
        // Requests are only tagged when ST's own Custom URL matches this address.
        notify('info', '代理地址已改', '点「重新连接」让酒馆改用它。', { ms: 10000, replace: 'endpoint' });
        refreshStatus();
    });
    endpointField.append(endpointInput, el('small', 'cm-hint', `默认 ${DEFAULT_ENDPOINT}。手机连 Mac：填「酒馆工具」标题栏的地址（手机同步会自动填）。`));
    const keyField = el('div', 'cm-field');
    keyField.append(el('div', 'cm-field-label', '访问密码'));
    const keyInput = el('input', 'text_pole cm-key-input');
    keyInput.type = 'password';
    keyInput.autocomplete = 'off';
    keyInput.value = settings.accessKey ?? '';
    keyInput.placeholder = '本机使用时留空';
    keyInput.addEventListener('change', () => {
        const next = keyInput.value.trim();
        if ((settings.accessKey ?? '') === next) return;
        settings.accessKey = next;
        save();
        notify('info', '访问密码已改', '点「重新连接」后生效。', { ms: 10000, replace: 'endpoint' });
        refreshStatus();
    });
    keyField.append(keyInput);
    const reconnect = el('div', 'menu_button cm-connect cm-connect-quiet');
    reconnect.append(el('i', 'fa-solid fa-plug'), document.createTextNode(' 重新连接'));
    reconnect.addEventListener('click', () => connect(getSettings()));
    box.append(endpointField, keyField, reconnect);
    return box;
}
