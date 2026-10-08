// ──────────────────────────────────────────────
// Settings access: the defaults, getSettings() (fills in keys added by newer
// versions) and the debounced save. Key names are the ones stored in
// SillyTavern's extension settings — never rename them.
// ──────────────────────────────────────────────

import { DEFAULT_ENDPOINT } from './capabilities.js';

// 审(存疑): 只是转发 capabilities.js 的同名常量，给 tabs/settings.js 这一个消费者；改它要动别的分区的 import，未动。
export { DEFAULT_ENDPOINT };
// 审: 面板设置在酒馆扩展设置里的键名，永远不能改名；测试引用。
export const MODULE = 'claude_max';

// 审: 酒馆的防抖保存，设置改动后调用。
/** SillyTavern's debounced settings save. */
export function saveSettingsDebounced() {
    return SillyTavern.getContext().saveSettingsDebounced();
}

// 审: 面板设置的默认值（只剩这几项，其余是引导/预设推荐的内部状态）；getSettings 补缺失键。
export const defaultSettings = {
    endpoint: DEFAULT_ENDPOINT,
    presetRecoRecord: null,  // 上一个预设的推荐改了什么（切走时恢复）
    loreTail: true,          // 关键词触发的世界书移到本轮消息（省缓存，见 README「世界书移到本轮消息」）
    skipVersion: '',         // 「这一版不再提醒」点过的版本号
    cacheTtl: '1h',          // 缓存有效期：'1h'（默认，写入 2 倍价）| '5m'（写入 1.25 倍，停 5 分钟以上就整段重写）
    onboarded: false,        // 首次引导：走完、跳过、或打开时已经连上了
    guideSource: '',         // 引导：'' 没开始；非空 = 进行中（'on'；旧版的 'choose' / 'proxy' 同样算进行中）
    everConnected: false,    // 成功连上代理一次就记下：之后断线只显示连接卡片，不再出现首次引导
    freshInstall: false,     // 面板第一次启动时设置还不存在（全新安装）才是 true，只有这时才自动出现引导
};

// 审: 历史版本里已删除的设置键，每次读取时清掉，避免残留在设置文件和诊断导出里；测试引用。
// Keys of settings that were removed (6.1 moved thinking and the model to SillyTavern's own controls,
// fixed the cache switches on, dropped LAN access, identity mode and the saved request). Deleted once
// on start-up so they never linger in the settings file or the diagnostics export.
export const REMOVED_KEYS = [
    'enabled', 'effort', 'thinking', 'showReasoning', 'identityMode', 'useResume', 'inlineSystem', 'debugDump',
    'diagCapture', 'diagCaptureDefaulted', 'foldTail', 'stEndpoint', 'accessKey', 'quietEffort', 'panelTab',
    'heuristicChecks', 'tailBlockFront', 'compactScriptButtons', 'quietRender', 'cardAudit', 'checkupToast',
    'leakWords', 'checkupMuted',
];

// 审: 读面板设置：首次建档标记全新安装、老用户标记已引导、清掉已删键、补默认值。
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
    for (const key of REMOVED_KEYS) delete extensionSettings[MODULE][key];
    for (const key in defaultSettings) {
        if (extensionSettings[MODULE][key] === undefined) {
            extensionSettings[MODULE][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE];
}

// 审: 酒馆「推理强度」值 → 中文，顶栏摘要用。
// SillyTavern's 「推理强度」 (Reasoning Effort) as words; 'min' means no thinking.
export const EFFORT_LABEL = { min: '不思考', low: '低', medium: '中', high: '高', max: '最大' };
