// ──────────────────────────────────────────────
// Settings access: the defaults, getSettings() (fills in keys added by newer
// versions) and the debounced save. Key names are the ones stored in
// SillyTavern's extension settings — never rename them.
// ──────────────────────────────────────────────

import { DEFAULT_ENDPOINT, quietRenderOn } from './capabilities.js';

export { DEFAULT_ENDPOINT };
export const MODULE = 'claude_max';

/** SillyTavern's debounced settings save. */
export function saveSettingsDebounced() {
    return SillyTavern.getContext().saveSettingsDebounced();
}

export const VALID_EFFORTS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
export const VALID_THINKING = ['adaptive', 'on', 'off'];
export const defaultSettings = {
    enabled: true,
    endpoint: DEFAULT_ENDPOINT,
    effort: 'auto',          // 'auto' = don't send → model default
    thinking: 'adaptive',
    showReasoning: true,
    identityMode: false,
    useResume: true,
    inlineSystem: true,
    debugDump: false,
    checkupToast: true,      // 本轮体检发现问题时弹提示
    leakWords: {},           // 角色卡 → 隐藏设定关键词（逗号分隔）
    presetRecoRecord: null,  // 上一个预设的推荐改了什么（切走时恢复）
    tailBlockFront: false,   // 实验：预设后置条目提前（省缓存）
    loreTail: true,          // 每轮变化的世界书移到本轮消息开头（省缓存）
    foldTail: true,          // 发言后面的深度 0 注入并进发言（省缓存）
    accessKey: '',           // 局域网访问密码（手机连 Mac 上的代理时用）
    quietEffort: 'low',      // 后台请求（其他插件的生图 tag、总结等）的思考深度；'follow' = 跟随面板
    panelTab: 'reason',      // 3.1 前记的分页；现在记在 localStorage，只用来迁移
    compactScriptButtons: true, // 输入栏上方的脚本按钮并排显示
    quietRender: 'auto',     // 省电显示：'auto'（手机 / TauriTavern 上开）| 'on' | 'off'
    checkupMuted: {},        // 体检提示被点掉的次数（按问题类型）；两次后不再弹
    cardAudit: false,        // 切卡时检查角色卡（未成年相关内容）；默认关，体检页可开
};

export function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (extensionSettings[MODULE] === undefined) {
        extensionSettings[MODULE] = structuredClone(defaultSettings);
    }
    for (const key in defaultSettings) {
        if (extensionSettings[MODULE][key] === undefined) {
            extensionSettings[MODULE][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE];
}

export const EFFORT_LABEL = { auto: '自动', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大' };

export const EFFORT_OPTIONS = [
    { value: 'auto', label: '自动', hint: '用模型默认（多数为「高」，Opus 5.5 为「中」）。' },
    { value: 'low', label: '低', hint: '最快最省，但长篇容易漏规则，不推荐。' },
    { value: 'medium', label: '中', hint: '速度与质量平衡。' },
    { value: 'high', label: '高', hint: '剧情更连贯、规则更完整，稍慢。长篇推荐。' },
    { value: 'xhigh', label: '超高', hint: '更慢、更耗额度。Opus 4.6 按「高」处理。' },
    { value: 'max', label: '最大', hint: '最慢、最耗额度。' },
];

export const THINKING_OPTIONS = [
    { value: 'adaptive', label: '自适应', hint: '模型自己判断要不要思考（推荐）。' },
    { value: 'on', label: '始终思考', hint: '每次都先思考。Sonnet 5 按自适应处理。' },
    { value: 'off', label: '关闭', hint: '不思考。Fable、Opus 4.7 及以上总会思考。' },
];

/** 省电显示: on for phones and TauriTavern unless the debug switch says otherwise. */
export const quietOn = () => quietRenderOn(getSettings().quietRender);
