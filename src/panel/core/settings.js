// ──────────────────────────────────────────────
// Settings access: the defaults, getSettings() (fills in keys added by newer
// versions) and the debounced save. Key names are the ones stored in
// SillyTavern's extension settings — never rename them.
// ──────────────────────────────────────────────

import { DEFAULT_ENDPOINT } from './capabilities.js';

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
    diagCapture: true,       // 诊断：让 Claude Code 经过代理内部的转发口，记录原始请求（状态 → 诊断）；5.3 起默认开
    diagCaptureDefaulted: true, // 5.3 把 diagCapture 改成默认开：没有这个键的旧设置迁移一次（打开），之后尊重用户的选择
    presetRecoRecord: null,  // 上一个预设的推荐改了什么（切走时恢复）
    loreTail: true,          // 每轮变化的世界书移到本轮消息开头（省缓存）
    foldTail: true,          // 发言后面的深度 0 注入并进发言（省缓存）
    stEndpoint: '',          // 酒馆服务器访问代理用的地址（旧版设置里可能有）；空 = 同「代理地址」
    accessKey: '',           // 代理的访问密码（CLAUDE_SUBSCRIPTION_LAN_KEY，旧版设置里可能有）；空 = 不带
    skipVersion: '',         // 「这一版不再提醒」点过的版本号
    cacheTtl: '1h',          // 缓存有效期：'1h'（默认，写入 2 倍价）| '5m'（写入 1.25 倍，停 5 分钟以上就整段重写）
    quietEffort: 'low',      // 后台请求（其他插件的生图 tag、总结等）的思考深度；'follow' = 跟随面板
    panelTab: 'chat',        // 3.1 前记的分页；现在记在 localStorage，只用来迁移
    onboarded: false,        // 首次引导：走完、跳过、或打开时已经连上了
    guideSource: '',         // 引导：'' 没开始；非空 = 进行中（'on'；旧版的 'choose' / 'proxy' 同样算进行中）
    everConnected: false,    // 成功连上代理一次就记下：之后断线只显示连接卡片，不再出现首次引导
    freshInstall: false,     // 面板第一次启动时设置还不存在（全新安装）才是 true，只有这时才自动出现引导
};

export function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (extensionSettings[MODULE] === undefined) {
        // Nothing saved yet: a brand-new install, the only case that shows the first-run guide.
        extensionSettings[MODULE] = { ...structuredClone(defaultSettings), freshInstall: true };
    } else if (extensionSettings[MODULE].freshInstall === undefined) {
        // Saved by an earlier version: a returning user, never a newcomer (whatever the guide flags say).
        extensionSettings[MODULE].freshInstall = false;
        extensionSettings[MODULE].onboarded = true;
    }
    // 5.3: diagnostics capture became on by default. Settings saved before have no flag: turn it on once
    // (before the defaults fill the flag in), later choices stay.
    if (extensionSettings[MODULE].diagCaptureDefaulted === undefined) {
        extensionSettings[MODULE].diagCapture = true;
        extensionSettings[MODULE].diagCaptureDefaulted = true;
    }
    for (const key in defaultSettings) {
        if (extensionSettings[MODULE][key] === undefined) {
            extensionSettings[MODULE][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE];
}

export const EFFORT_LABEL = { auto: '自动', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大' };

// `hint` is a short tooltip (title), not text on the page.
export const EFFORT_OPTIONS = [
    { value: 'auto', label: '自动', hint: '模型默认（多数为「高」，Opus 5.5 为「中」）' },
    { value: 'low', label: '低', hint: '最快，长篇易漏规则' },
    { value: 'medium', label: '中', hint: '速度与质量平衡' },
    { value: 'high', label: '高', hint: '更连贯，稍慢；长篇推荐' },
    { value: 'xhigh', label: '超高', hint: '更慢更耗额度；Opus / Sonnet 4.6 按「高」' },
    { value: 'max', label: '最大', hint: '最慢最耗额度' },
];

/** 「不思考」 sits first in the one thinking control (聊天). */
export const NO_THINKING_OPTION = { value: 'off', label: '不思考', hint: '回得最快；总会思考的模型上无效' };

export const THINKING_OPTIONS = [
    { value: 'adaptive', label: '自适应' },
    { value: 'on', label: '始终思考' },
    { value: 'off', label: '关闭' },
];
