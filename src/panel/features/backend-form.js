// ──────────────────────────────────────────────
// 代理后端: which service the proxy runs chats on (设置 → 代理后端)
// Values go only to the proxy (same machine, or the Mac with the access key) and are stored there
// (data/backend.json). Secrets never come back: the proxy says only whether each one is set.
// ──────────────────────────────────────────────

import { store } from '../core/store.js';
import { fetchProxy, proxyErrorText } from '../core/proxy.js';
import { el, segmented, stateLine, button } from '../core/dom.js';
import { notify } from '../core/notify.js';
import { refreshQuota, refreshBackend } from '../core/live.js';

export function init() {
    store.subscribe('backend', ({ backend }) => renderBackend(backend));
}

/** Draw the form (or why there is none) into the 代理后端 box. */
export function renderBackend(state) {
    const box = document.getElementById('claude_max_backend');
    if (!box) return;
    if (state.phase === 'ok') box.replaceChildren(backendForm(state.view));
    else if (state.phase === 'error') box.replaceChildren(stateLine('error', proxyErrorText('代理后端', state.error), refreshBackend));
    else box.replaceChildren(stateLine('loading', '正在读取代理后端…'));
}

const BACKEND_SHORT = { subscription: '订阅', apikey: 'API', bedrock: 'Bedrock', vertex: 'Vertex', gateway: '网关', openrouter: 'OR' };
const BACKEND_FORM = {
    subscription: { note: '用本机 Claude 登录（Pro / Max），按订阅额度计。', fields: [] },
    apikey: { note: '按 token 计费（Anthropic 控制台）。', fields: [['apiKey', 'API 密钥（sk-ant-…）', true]] },
    bedrock: {
        note: '需要 AWS 账号开通 Bedrock 的 Claude 模型。凭证三选一：Bedrock API 密钥、AWS 配置名（~/.aws），或访问密钥；都不填则用本机默认 AWS 凭证。',
        fields: [['region', '区域（如 us-east-1）'], ['bearerToken', 'Bedrock API 密钥', true], ['profile', 'AWS 配置名（可选）'], ['accessKeyId', 'Access Key ID（可选）', true], ['secretAccessKey', 'Secret Access Key（可选）', true], ['sessionToken', 'Session Token（可选）', true], ['prefix', '跨区前缀 us / eu / apac / global（可选，默认按区域）']],
    },
    vertex: {
        note: '需要在代理这台电脑上先执行 gcloud auth application-default login（或填服务账号 JSON 的路径）。',
        fields: [['projectId', 'GCP 项目 ID'], ['region', '区域（如 global、us-east5）'], ['credentialsFile', '服务账号 JSON 路径（可选）']],
    },
    gateway: { note: '任何兼容 Anthropic Messages 接口的网关（Bearer 令牌）。模型名按官方 id 发送。', fields: [['baseUrl', '网关地址（https://…）'], ['authToken', '令牌', true]] },
    openrouter: { note: '走 OpenRouter 的 Anthropic 兼容接口（https://openrouter.ai/api）。模型名自动换成 anthropic/claude-…。', fields: [['authToken', 'OpenRouter 密钥（sk-or-…）', true]] },
};

function backendForm(view) {
    const wrap = el('div', 'cm-conn-fields');
    let chosen = view.backend;
    const status = el('small', 'cm-hint');
    status.textContent = `现在：${view.label}${view.source === 'env' ? '（环境变量 CLAUDE_SUBSCRIPTION_BACKEND 指定，面板改不了）' : ''}${view.missing?.length ? ` · 还缺 ${view.missing.join('、')}` : ''}`;
    const fieldsBox = el('div', 'cm-conn-fields');
    const inputs = {};
    const renderFields = () => {
        fieldsBox.replaceChildren();
        for (const k of Object.keys(inputs)) delete inputs[k];
        const form = BACKEND_FORM[chosen];
        fieldsBox.append(el('small', 'cm-hint', form.note));
        for (const [name, label, secret] of form.fields) {
            const info = view.fields?.[chosen]?.[name] ?? {};
            const f = el('div', 'cm-field');
            f.append(el('div', 'cm-field-label', `${label}${info.fromEnv ? '（环境变量）' : ''}`));
            const input = el('input', 'text_pole');
            input.type = secret ? 'password' : 'text';
            input.autocomplete = 'off';
            if (secret) input.placeholder = info.set ? '已填（留空不改）' : '未填';
            else input.value = info.value ?? '';
            if (info.fromEnv) input.disabled = true;
            inputs[name] = { input, secret, set: !!info.set };
            f.append(input);
            if (secret && info.set && !info.fromEnv) {
                const clear = el('button', 'cm-link-btn', '清除');
                clear.type = 'button';
                clear.addEventListener('click', () => saveBackend({ clear: [`${chosen}.${name}`] }));
                f.append(clear);
            }
            fieldsBox.append(f);
        }
    };
    const seg = segmented({
        label: '聊天走哪个服务',
        options: view.backends.map((b) => ({ value: b.id, label: BACKEND_SHORT[b.id] ?? b.label, hint: '' })),
        current: chosen,
        onChange: (v) => { chosen = v; renderFields(); },
    });
    const saveBtn = button('保存并切换', () => {
        const vals = {};
        for (const [name, { input }] of Object.entries(inputs)) if (!input.disabled) vals[name] = input.value;
        saveBackend({ backend: chosen, fields: { [chosen]: vals } });
    }, { icon: 'fa-floppy-disk', primary: true });
    renderFields();
    wrap.append(status, seg, fieldsBox, saveBtn,
        el('small', 'cm-hint', '密钥只存在代理那台电脑，只发给对应的服务，这里不会再显示。从下一条回复起生效。'));
    return wrap;
}

async function saveBackend(body) {
    try {
        const res = await fetchProxy('/backend', '/v1/backend', { method: 'POST', body });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.message ?? `HTTP ${res.status}`);
        notify('ok', '代理后端', data.message ?? '已保存', { ms: 8000, replace: 'backend' });
        refreshQuota();
    } catch (err) {
        notify('bad', '代理后端没改成', String(err instanceof Error ? err.message : err), { ms: 12000, replace: 'backend' });
    }
    refreshBackend();
}
