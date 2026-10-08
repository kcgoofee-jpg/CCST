// ──────────────────────────────────────────────
// Where SillyTavern sends chat requests, and the model names the panel shows.
// The logic is in capabilities.js (pure); this reads SillyTavern's live settings.
// ──────────────────────────────────────────────

import { resolveConnection } from './capabilities.js';
import { getSettings } from './settings.js';
import { libs } from './libs.js';

// 审: 读酒馆实时设置，返回「是否连着本代理/模型/计费」；全面板的连接状态都从这里取。
/** `where` / `billing`: 走哪 · 按什么计费, for the status bar. */
export function connectionInfo() {
    const ctx = SillyTavern.getContext();
    return resolveConnection({ mainApi: ctx.mainApi, oai: ctx.chatCompletionSettings ?? {}, settings: getSettings() });
}

// 审: 模型 id → 面板显示名的匹配表，顺序重要（fable-5-1 要排在 fable-5 前，5-5 排在 5 前）。
const MODEL_SHORT = [
    [/fable-5-1/, 'Fable 5.1'], [/fable-5/, 'Fable 5'], [/opus-5-5/, 'Opus 5.5'], [/opus-5/, 'Opus 5'],
    [/sonnet-5-5/, 'Sonnet 5.5'], [/sonnet-5/, 'Sonnet 5'], [/opus-4-(\d)/, 'Opus 4.$1'], [/sonnet-4-(\d)/, 'Sonnet 4.$1'], [/haiku-5-5/, 'Haiku 5.5'], [/haiku-4-5/, 'Haiku 4.5'],
];

// 审: 任意来源写法的模型 id → 用户看的短名（Opus 4.6，1M 加后缀）；认不出就原样。
export function shortModel(id) {
    const s = libs.sources?.canonicalModel(id) ?? String(id ?? '');
    for (const [re, label] of MODEL_SHORT) {
        const m = s.match(re);
        if (m) return label.replace('$1', m[1] ?? '') + (/\[1m\]|-1m/i.test(String(id ?? '')) ? ' 1M' : '');
    }
    return String(id ?? '');
}

// 审: 去掉结尾 [1m]，canonicalModel 不可用时 modelKey 的退路。
const modelBase = (id) => String(id ?? '').replace(/\[1m\]$/i, '');
// 审: 规范 id（claude-opus-4-6）：预设 byModel 的查找键。
/** The canonical id (claude-opus-4-6) behind any source's name: what MODEL_PICKS and byModel use. */
export const modelKey = (id) => libs.sources?.canonicalModel(id) ?? modelBase(id);
