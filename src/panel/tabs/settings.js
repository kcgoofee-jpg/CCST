// ──────────────────────────────────────────────
// Tab 设置: the connection to the proxy, the two choices that are really the user's (cache lifetime,
// moving triggered world info), the viewer of what goes to the model, and 重新引导. Thinking, the
// model and showing reasoning are SillyTavern's own settings (API 连接 / 预设).
// ──────────────────────────────────────────────

import { store } from '../core/store.js';
import { getSettings } from '../core/settings.js';
import { DEFAULT_ENDPOINT } from '../core/capabilities.js';
import { normalizeEndpoint } from '../core/capabilities.js';
import { el, segmented, toggleRow, group, button } from '../core/dom.js';
import { notify } from '../core/notify.js';
import { F } from '../core/registry.js';
import { refreshStatus } from '../core/live.js';
import { connect, SOURCE_LABELS } from '../shell.js';
import { restartGuide } from '../guide.js';

// 审: 连接分区那一行状态（代理版本 · 凭证来源 / 未登录 / 没连上），随 status 订阅更新。
/** 设置 → 连接's one status line. Plan and model are in the header: not repeated here. */
function proxyInfoLine(status) {
    if (status?.phase === 'online') {
        const cred = status.cred ?? {};
        const where = cred.present ? SOURCE_LABELS[cred.source] ?? cred.source : '';
        return [`代理 v${status.version}`, where].filter(Boolean).join(' · ');
    }
    if (status?.phase === 'nologin') return '未登录';
    if (status?.phase === 'offline' || status?.phase === 'denied') return '没连上';
    return '';
}

// 审: 设置页的 store 订阅，只刷新「连接」那行；boot.js 调用。
export function init() {
    store.subscribe('status', ({ status }) => {
        const info = document.getElementById('claude_max_proxy_info');
        if (!info) return;
        const text = proxyInfoLine(status);
        if (text || status.phase !== 'pending') info.textContent = text;
    });
}

// 审: 建设置页：连接（地址 + 重新连接）、缓存（时长 + 条目后移）、检查（发送内容）、重看引导；shell.js 调用。
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
        id: 'claudeMaxLoreTail', title: '世界书后移',
        tip: '触发的世界书放到发言前，省缓存；卡里有状态栏的请关',
        checked: settings.loreTail, onChange: (v) => { settings.loreTail = v; save(); },
    }));
    pane.append(cache.root);

    const view = group('排查');
    view.body.append(button('查看发给模型的内容', () => F.debug.showDebugRequest(), { icon: 'fa-magnifying-glass', text: true, id: 'claude_max_debug_view' }));
    pane.append(view.root);

    const again = el('button', 'cm-link-btn cm-guide-again', '重看引导');
    again.type = 'button';
    again.id = 'claude_max_guide_again';
    again.addEventListener('click', () => restartGuide());
    pane.append(again);
}

// 审: 代理地址输入框：改完存设置、提示「点重新连接生效」并立刻重测状态。
/** The proxy address input. */
function endpointField(settings, save) {
    const field = el('div', 'cm-field');
    field.append(el('div', 'cm-field-label', '地址'));
    const input = el('input', 'text_pole cm-endpoint-input');
    input.type = 'text';
    input.id = 'claude_max_endpoint';
    input.value = settings.endpoint;
    input.placeholder = DEFAULT_ENDPOINT;
    // Committed on change (Enter / leaving the field), not per keystroke:
    // half-typed addresses would be saved and probed by the heartbeat.
    input.addEventListener('change', () => {
        const next = normalizeEndpoint(input.value) || DEFAULT_ENDPOINT;
        if (normalizeEndpoint(settings.endpoint) === next) { input.value = settings.endpoint; return; }
        settings.endpoint = next;
        input.value = next; // 显示规范化后的地址
        save();
        // Requests are only tagged when ST's own Custom URL matches this address.
        notify('info', '地址已改', '点「重新连接」生效', { ms: 10000, replace: 'endpoint' });
        refreshStatus();
    });
    field.append(input);
    return field;
}

// 审: 「重新连接」按钮，直接走 shell 的一键连接；地址改完或连接乱了用。
function reconnectButton() {
    return button('重新连接', () => connect(getSettings()), { icon: 'fa-plug', text: true });
}
