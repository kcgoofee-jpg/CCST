// ──────────────────────────────────────────────
// Tab 设置: the connection to the proxy, the two choices that are really the user's (cache lifetime,
// moving triggered world info), the viewer of what goes to the model, and 重新引导. Thinking, the
// model and showing reasoning are SillyTavern's own settings (API 连接 / 预设).
// ──────────────────────────────────────────────

import { store } from '../core/store.js';
import { DEFAULT_ENDPOINT, getSettings } from '../core/settings.js';
import { normalizeEndpoint } from '../core/capabilities.js';
import { el, segmented, toggleRow, group, button } from '../core/dom.js';
import { notify } from '../core/notify.js';
import { F } from '../core/registry.js';
import { refreshStatus } from '../core/live.js';
import { connect, SOURCE_LABELS } from '../shell.js';
import { restartGuide } from '../guide.js';

/** 设置 → 连接's one status line. Plan and model are in the header: not repeated here. */
export function proxyInfoLine(status) {
    if (status?.phase === 'online') {
        const cred = status.cred ?? {};
        const where = cred.present ? SOURCE_LABELS[cred.source] ?? cred.source : '';
        return [`代理 v${status.version}`, where].filter(Boolean).join(' · ');
    }
    if (status?.phase === 'nologin') return '未登录';
    if (status?.phase === 'offline' || status?.phase === 'denied') return '没连上';
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

    const cache = group('缓存');
    cache.body.append(segmented({
        label: '缓存时长',
        options: [
            { value: '1h', label: '1 小时', hint: '写入贵一倍，停久了也不重写' },
            { value: '5m', label: '5 分钟', hint: '快聊更省，停 5 分钟就重写' },
        ],
        current: settings.cacheTtl === '5m' ? '5m' : '1h',
        onChange: (v) => { settings.cacheTtl = v === '5m' ? '5m' : '1h'; save(); },
    }));
    cache.body.append(toggleRow({
        id: 'claudeMaxLoreTail', title: '条目后移',
        tip: '世界书挪到发言前；状态卡请关',
        checked: settings.loreTail, onChange: (v) => { settings.loreTail = v; save(); },
    }));
    pane.append(cache.root);

    const view = group('检查');
    view.body.append(button('发送内容', () => F.debug.showDebugRequest(), { icon: 'fa-magnifying-glass', text: true, id: 'claude_max_debug_view' }));
    pane.append(view.root);

    const again = el('button', 'cm-link-btn cm-guide-again', '重看引导');
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
    field.append(el('div', 'cm-field-label', '地址'));
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
        notify('info', '地址已改', '点「重新连接」生效', { ms: 10000, replace: 'endpoint' });
        refreshStatus();
    });
    field.append(input);
    return field;
}

export function reconnectButton() {
    return button('重新连接', () => connect(getSettings()), { icon: 'fa-plug', text: true });
}
