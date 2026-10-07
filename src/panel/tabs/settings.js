// ──────────────────────────────────────────────
// Tab 设置: connection to the local proxy, two display options, the folded 高级 (cache &
// context switches, 始终思考, the saved request), and 重新引导 at the bottom.
// ──────────────────────────────────────────────

import { store } from '../core/store.js';
import { getSettings, DEFAULT_ENDPOINT } from '../core/settings.js';
import { normalizeEndpoint, APP_NAME, debugViewState } from '../core/capabilities.js';
import { el, segmented, toggleRow, group, collapsible, button } from '../core/dom.js';
import { notify } from '../core/notify.js';
import { F } from '../core/registry.js';
import { refreshStatus } from '../core/live.js';
import { connect, renderGlance, SOURCE_LABELS } from '../shell.js';
import { syncThinkingControls } from './chat.js';
import { restartGuide } from '../guide.js';

/** 设置 → 连接's one status line. Plan and model are in the header: not repeated here. */
export function proxyInfoLine(status) {
    if (status?.phase === 'online') {
        const cred = status.cred ?? {};
        const where = cred.present ? SOURCE_LABELS[cred.source] ?? cred.source : '';
        return [`代理 v${status.version}`, where].filter(Boolean).join(' · ');
    }
    if (status?.phase === 'nologin') return '代理在线 · 未登录';
    if (status?.phase === 'offline' || status?.phase === 'denied') return '代理未连上';
    return '';
}

export function init() {
    store.subscribe('status', ({ status }) => {
        const info = document.getElementById('claude_max_proxy_info');
        if (!info) return;
        const text = proxyInfoLine(status);
        if (text || status.phase !== 'pending') info.textContent = text;
    });
}

/** Tab 设置: see the header comment. */
export function buildSettingsTab(pane, settings, save) {
    const conn = group('连接');
    const info = el('small', 'cm-hint');
    info.id = 'claude_max_proxy_info';
    info.textContent = proxyInfoLine(store.get().status);
    conn.body.append(info, endpointField(settings, save), reconnectButton());
    pane.append(conn.root);

    const opts = group('选项');
    opts.body.append(toggleRow({
        id: 'claudeMaxShowReasoning', title: '显示思考过程', tip: '跟随酒馆「显示模型思维」；关掉则总不显示',
        checked: settings.showReasoning, onChange: (v) => { settings.showReasoning = v; save(); },
    }));
    opts.body.append(toggleRow({
        id: 'claudeMaxIdentity', title: '身份模式', tip: '加 Claude Code 官方前言：模型能说出型号，但多耗 token。角色扮演建议关',
        checked: settings.identityMode, onChange: (v) => { settings.identityMode = v; save(); },
    }));
    pane.append(opts.root);

    // These decide themselves (defaults on, the preset's own recommendation, the proxy watching each
    // chat). Kept for chasing cache problems, folded away so nobody has to think about it.
    const adv = collapsible('高级', '', { id: 'claude_max_advanced' });
    const add = (x) => adv.body.append(x);
    // 只管「借用酒馆当前连接、被酒馆标成静默生成」的请求；扩展自己配了独立 API 的不经过代理，管不到。
    // 能关思考的模型上后台请求本来就不思考，这项只对总会思考的模型（Opus 5.5、Sonnet 5.5…）有影响。
    add(segmented({
        label: '后台请求思考深度',
        options: [
            { value: 'low', label: '低', hint: '总结、变量更新等后台请求用「低」（只影响总会思考的模型）' },
            { value: 'follow', label: '跟随', hint: '后台请求也用「聊天」页的思考深度' },
        ],
        current: settings.quietEffort === 'follow' ? 'follow' : 'low',
        onChange: (v) => { settings.quietEffort = v === 'follow' ? 'follow' : 'low'; save(); },
    }));
    add(toggleRow({
        id: 'claudeMaxAlwaysThink', title: '始终思考', tip: '每次都先思考（关 = 自适应）。Sonnet 5 按自适应处理',
        checked: settings.thinking === 'on',
        onChange: (v) => {
            settings.thinking = v ? 'on' : 'adaptive';
            save();
            renderGlance();
            syncThinkingControls();
        },
    }));
    add(toggleRow({
        id: 'claudeMaxResume', title: '会话续接', tip: '按真实多轮发送，能用上缓存。只在排查时关',
        checked: settings.useResume, onChange: (v) => { settings.useResume = v; save(); },
    }));
    add(toggleRow({
        id: 'claudeMaxInlineSystem', title: '深度注入保持原位', tip: '关掉则深度条目都提到系统提示词，一条变化整段缓存失效',
        checked: settings.inlineSystem, onChange: (v) => { settings.inlineSystem = v; save(); },
    }));
    add(toggleRow({
        id: 'claudeMaxLoreTail', title: '世界书变化部分移到末尾', tip: '每轮在变的世界书挪进本轮消息，旧内容能读缓存',
        checked: settings.loreTail, onChange: (v) => { settings.loreTail = v; save(); },
    }));
    add(toggleRow({
        id: 'claudeMaxFoldTail', title: '发言后的注入并进发言', tip: 'MVU 等放在发言后的深度 0 条目并进发言，下一轮缓存能对上',
        checked: settings.foldTail, onChange: (v) => { settings.foldTail = v; save(); },
    }));
    add(toggleRow({
        id: 'claudeMaxDebugDump', title: '保存最近一次完整请求', tip: '存在代理那台电脑的 data/debug/，每次覆盖',
        checked: settings.debugDump, onChange: (v) => { settings.debugDump = v; save(); syncView(); },
    }));
    const viewBtn = button('查看', () => F.debug.showDebugRequest(), { icon: 'fa-magnifying-glass', text: true, id: 'claude_max_debug_view' });
    const syncView = () => {
        const st = debugViewState(settings);
        viewBtn.disabled = !st.enabled;
        viewBtn.title = st.hint;
    };
    syncView();
    add(viewBtn);
    pane.append(adv.root);

    const again = el('button', 'cm-link-btn cm-guide-again', '重新引导');
    again.type = 'button';
    again.id = 'claude_max_guide_again';
    again.addEventListener('click', () => restartGuide());
    pane.append(again);
}

/** Every address input shows the same setting: keep them in step. */
function syncEndpointInputs(value) {
    for (const input of document.querySelectorAll('.cm-endpoint-input')) input.value = value;
}

/** The proxy address input. */
export function endpointField(settings, save, { id = 'claude_max_endpoint' } = {}) {
    const field = el('div', 'cm-field');
    field.append(el('div', 'cm-field-label', '代理地址'));
    const input = el('input', 'text_pole cm-endpoint-input');
    input.type = 'text';
    input.id = id;
    input.value = settings.endpoint;
    input.placeholder = DEFAULT_ENDPOINT;
    // Committed on change (Enter / leaving the field), not per keystroke:
    // half-typed addresses would be saved and probed by the heartbeat.
    input.addEventListener('change', () => {
        const next = normalizeEndpoint(input.value) || DEFAULT_ENDPOINT;
        if (normalizeEndpoint(settings.endpoint) === next) { input.value = settings.endpoint; return; }
        settings.endpoint = next;
        syncEndpointInputs(settings.endpoint);
        save();
        // Requests are only tagged when ST's own Custom URL matches this address.
        notify('info', '代理地址已改', `点「重新连接」让${APP_NAME}改用它。`, { ms: 10000, replace: 'endpoint' });
        refreshStatus();
    });
    field.append(input);
    return field;
}

export function reconnectButton() {
    return button('重新连接', () => connect(getSettings()), { icon: 'fa-plug', text: true });
}
