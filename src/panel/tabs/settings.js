// ──────────────────────────────────────────────
// Tab 设置: connection to the local proxy, backend, thinking, and the folded 高级 (cache & context switches).
// ──────────────────────────────────────────────

import { store } from '../core/store.js';
import { getSettings, DEFAULT_ENDPOINT, VALID_THINKING, THINKING_OPTIONS } from '../core/settings.js';
import { normalizeEndpoint, APP_NAME } from '../core/capabilities.js';
import { makeConnectCode, parseConnectCode } from '../core/connect-code.js';
import { el, segmented, toggleRow, group, collapsible, stateLine, button } from '../core/dom.js';
import { notify } from '../core/notify.js';
import { refreshStatus, refreshBackend } from '../core/live.js';
import { connect, renderGlance, SUBSCRIPTION_LABELS, SOURCE_LABELS } from '../shell.js';
import { syncThinkingControls, syncAlwaysThinks } from './reason.js';

export function init() {
    // The proxy line under 连接 follows the status.
    store.subscribe('status', ({ status }) => {
        // The proxy came up after the panel was built: the backend read that failed earlier gets another go.
        if (status.phase === 'online' && store.get().backend.phase !== 'ok') refreshBackend();
        if (status.phase !== 'online') return;
        const { cred, version } = status;
        const plan = SUBSCRIPTION_LABELS[cred.subscriptionType] ?? cred.subscriptionType ?? '订阅';
        const info = document.getElementById('claude_max_proxy_info');
        if (info) info.textContent = `代理 v${version} 在线 · ${plan} 订阅 · 凭据：${SOURCE_LABELS[cred.source] ?? cred.source}`;
    });
}

/** Tab 设置: connection to the local proxy, backend, thinking; the cache & context switches are folded into 高级. */
export function buildSettingsTab(pane, settings, save) {
    const conn = group('连接', '酒馆通过这个地址连本机的代理；本机使用不用改地址。');
    const info = el('small', 'cm-hint');
    info.id = 'claude_max_proxy_info';
    conn.body.append(info, connectionFields(settings, save));
    pane.append(conn.root);

    const backend = group('代理后端', '代理用哪个服务回答：订阅、API 密钥或其他。');
    const backendBox = el('div', 'cm-conn-fields');
    backendBox.id = 'claude_max_backend';
    backendBox.append(stateLine('loading', '正在读取代理后端…'));
    backend.body.append(backendBox);
    pane.append(backend.root);
    // The pane isn't in the document yet (refreshBackend looks the box up by id): fetch once it is.
    queueMicrotask(() => setTimeout(refreshBackend, 0));

    const think = group('思考', '深度在「推理」页；这里是模式和显示。');
    const thinking = segmented({
        label: '思考模式',
        options: THINKING_OPTIONS,
        current: settings.thinking,
        onChange: (v) => { settings.thinking = VALID_THINKING.includes(v) ? v : 'adaptive'; save(); renderGlance(); syncThinkingControls(); },
    });
    thinking.id = 'claude_max_thinking';
    queueMicrotask(syncAlwaysThinks);
    think.body.append(thinking);
    think.body.append(segmented({
        label: '后台请求思考深度',
        options: [
            { value: 'low', label: '低', hint: '其他插件的后台请求（生图 tag、总结）用「低」，通常更快、更省额度。' },
            { value: 'follow', label: '跟随', hint: '后台请求也用「推理」页的深度。' },
        ],
        current: settings.quietEffort === 'follow' ? 'follow' : 'low',
        onChange: (v) => { settings.quietEffort = v === 'follow' ? 'follow' : 'low'; save(); },
    }));
    think.body.append(toggleRow({
        id: 'claudeMaxShowReasoning', title: '显示思考过程', desc: '跟随酒馆「显示模型思维」；关掉则总不显示。',
        checked: settings.showReasoning, onChange: (v) => { settings.showReasoning = v; save(); },
    }));
    think.body.append(toggleRow({
        id: 'claudeMaxIdentity', title: '身份模式', desc: '角色扮演建议关（预设可推荐）。',
        more: '加上 Claude Code 官方前言，模型能说出型号，但多耗 token、带编程助手味。',
        checked: settings.identityMode, onChange: (v) => { settings.identityMode = v; save(); },
    }));
    pane.append(think.root);

    // These decide themselves (defaults on, the preset's own recommendation, the proxy watching each
    // chat). Kept for chasing cache problems, folded away so nobody has to think about it.
    const adv = collapsible('高级', '缓存与上下文的开关，一般不用动。', { id: 'claude_max_advanced' });
    const add = (x) => adv.body.append(x);
    add(toggleRow({
        id: 'claudeMaxResume', title: '会话续接', desc: '按真实多轮发送，预计能用上缓存。',
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
        more: '系统提示词和旧聊天记录每轮不变，预计能读缓存，通常只重写最近一轮（取决于预设和其他扩展）。',
        checked: settings.loreTail, onChange: (v) => { settings.loreTail = v; save(); },
    }));
    add(toggleRow({
        id: 'claudeMaxFoldTail', title: '发言后的注入并进发言', desc: '放在你发言后的条目并进发言。',
        more: 'MVU 等变量卡把状态以「深度 0」放在发言后；并进去后下一轮原样重放，预计缓存能对上。',
        checked: settings.foldTail, onChange: (v) => { settings.foldTail = v; save(); },
    }));
    add(toggleRow({
        id: 'claudeMaxTailBlock', title: '实验：预设后置条目提前', desc: '只对 Ny、图灵这类预设有用。',
        more: '把每轮不变的后置条目挪到对话最前，预计旧楼层更容易命中缓存；代价是规则离回复更远。',
        checked: settings.tailBlockFront, onChange: (v) => { settings.tailBlockFront = v; save(); },
    }));
    pane.append(adv.root);
}

/** Every address input shows the same setting (设置 → 连接 and 其他 → 手机连接): keep them in step. */
function syncEndpointInputs(value) {
    for (const input of document.querySelectorAll('.cm-endpoint-input')) input.value = value;
}

/** The 手机连接码 as the fields show it: the saved address + password; empty for the plain local default. */
function codeFor(settings) {
    const ep = normalizeEndpoint(settings.endpoint);
    return !ep || ep === DEFAULT_ENDPOINT ? '' : makeConnectCode(ep, settings.accessKey);
}

/** After the connect card (or a field) saved a new address / password: show them in the fields of 设置 and 其他 → 手机连接. */
export function syncConnectionInputs(settings) {
    syncEndpointInputs(settings.endpoint);
    for (const input of document.querySelectorAll('.cm-code-input')) input.value = codeFor(settings);
}

/** The proxy address input. `id` differs per copy (设置 has one, 其他 → 手机连接 the other). */
export function endpointField(settings, save, { id = 'claude_max_endpoint', hint } = {}) {
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
        syncConnectionInputs(settings);
        save();
        // Requests are only tagged when ST's own Custom URL matches this address.
        notify('info', '代理地址已改', `点「重新连接」让${APP_NAME}改用它。`, { ms: 10000, replace: 'endpoint' });
        refreshStatus();
        refreshBackend();
    });
    if (hint) field.append(input, el('small', 'cm-hint', hint));
    else field.append(input);
    return field;
}

/** 酒馆和代理分开部署时，酒馆服务器访问代理用的地址（浏览器用上面的代理地址）。 */
export function stEndpointField(settings, save) {
    const field = el('div', 'cm-field');
    field.append(el('div', 'cm-field-label', '酒馆侧地址（可选）'));
    const input = el('input', 'text_pole');
    input.type = 'text';
    input.value = settings.stEndpoint ?? '';
    input.placeholder = '留空 = 同上';
    input.addEventListener('change', () => {
        const next = normalizeEndpoint(input.value);
        if (normalizeEndpoint(settings.stEndpoint) === next) return;
        settings.stEndpoint = next;
        save();
        notify('info', '酒馆侧地址已改', '点「重新连接」后生效。', { ms: 10000, replace: 'endpoint' });
    });
    field.append(input, el('small', 'cm-hint', 'Docker 里酒馆和代理是两个容器时填（如 http://ccst:8901/v1）：酒馆服务器用它连代理，你的浏览器用上面的代理地址。其他情况留空。'));
    return field;
}

/**
 * 其他 → 手机连接: ONE box for the 手机连接码 (the address and the access password together, as the Mac's 酒馆工具 shows it).
 * A plain address is accepted too. Saved to the same two settings the connect card uses.
 */
export function connectCodeField(settings, save, { id = 'claude_max_lan_code' } = {}) {
    const field = el('div', 'cm-field');
    field.append(el('div', 'cm-field-label', '手机连接码'));
    const input = el('input', 'text_pole cm-code-input');
    input.type = 'text';
    input.id = id;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = codeFor(settings);
    input.placeholder = 'http://192.168.x.x:8901/v1#k=…';
    input.addEventListener('change', () => {
        if (!input.value.trim()) {
            // Emptied: back to the local proxy, no password.
            settings.endpoint = DEFAULT_ENDPOINT;
            settings.accessKey = '';
        } else {
            const parsed = parseConnectCode(input.value);
            if (!parsed) { notify('warn', '没认出连接码', '请把电脑上酒馆工具首页显示的「手机连接码」整行粘贴过来。', { ms: 8000, replace: 'endpoint' }); input.value = codeFor(settings); return; }
            settings.endpoint = parsed.endpoint;
            settings.accessKey = parsed.accessKey;
        }
        syncConnectionInputs(settings);
        save();
        notify('info', '连接码已保存', `点「重新连接」让${APP_NAME}改用它。`, { ms: 10000, replace: 'endpoint' });
        refreshStatus();
        refreshBackend();
    });
    field.append(input);
    return field;
}

export function reconnectButton() {
    return button('重新连接', () => connect(getSettings()), { icon: 'fa-plug', text: true });
}

/** 设置 → 连接: the local proxy's address. (The LAN password lives in 其他 → 手机连接.) */
function connectionFields(settings, save) {
    const box = el('div', 'cm-conn-fields');
    box.append(endpointField(settings, save), reconnectButton());
    return box;
}
