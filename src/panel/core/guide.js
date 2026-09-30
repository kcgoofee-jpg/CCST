// ──────────────────────────────────────────────
// First-run guide (选来源 → 连接 → 完成): the state logic and the wording, pure (no DOM, no ST), so the
// tests can run it. The drawing is in ../guide.js.
//
// Two settings keys drive it:
//   onboarded    true once the guide is done, skipped, or the user was already connected
//   guideSource  '' = not started; 'choose' = started, no source picked yet; else a SOURCES id
// ──────────────────────────────────────────────

/** Who each source is for. `proxy` covers 订阅 / API 密钥 / 其他后端: the proxy's own backend form picks. */
export const SOURCES = [
    { id: 'proxy', label: '本机代理', who: '有 Claude 订阅（Pro / Max），或想用 API 密钥 / 其他后端，要最省缓存和防丢回复。' },
    { id: 'claude', label: 'Claude 官方', who: '手上有 Anthropic API 密钥，不想跑代理。' },
    { id: 'openrouter', label: 'OpenRouter', who: '用 OpenRouter 的额度，一个密钥换着用各家模型。' },
    { id: 'relay', label: '其他中转', who: '用第三方中转站或聚合站（Electron Hub、NanoGPT、自定义地址……）。' },
];

export const isSourceId = (id) => SOURCES.some((s) => s.id === id);

/** The source the user picked, or null (not started, or started and not yet picked). */
export function chosenSource(guideSource) {
    return isSourceId(guideSource) ? guideSource : null;
}

/** Is SillyTavern's current connection the one the picked source means? */
export function sourceLinked(choice, conn) {
    if (!choice || !conn) return false;
    if (choice === 'proxy') return !!conn.connected;
    if (!conn.direct) return false;
    if (choice === 'relay') return conn.kind !== 'claude' && conn.kind !== 'openrouter';
    return conn.kind === choice;
}

const linked = (conn) => !!(conn?.connected || conn?.direct);

/**
 * Should a user who is already connected just be marked done (no guide)? Only when they never started
 * the guide: someone who picked a source and connected must still see 第 3 步.
 */
export function shouldAutoOnboard({ onboarded, guideSource }, conn) {
    return !onboarded && !guideSource && linked(conn);
}

/**
 * Which step to show: 0 = no guide; 1 选来源; 2 连接; 3 完成.
 * A user who never started and is not connected begins at 1 (a fresh install).
 */
export function guideStep({ onboarded, guideSource }, conn) {
    if (onboarded) return 0;
    if (!guideSource && linked(conn)) return 0;
    const choice = chosenSource(guideSource);
    if (!choice) return 1;
    return sourceLinked(choice, conn) ? 3 : 2;
}

export const STEP_TITLES = { 1: '选来源', 2: '连接', 3: '完成' };

/** Step 2 for the direct sources: where in SillyTavern's own API panel the key goes (we never touch keys). */
export const KEY_STEPS = {
    claude: [
        '点酒馆顶部的插头图标（API 连接），「API」选 聊天补全（Chat Completion）。',
        '「聊天补全来源」选 Claude。',
        '把 API 密钥粘到「Claude API 密钥」框，点 连接。',
        '在下面的 Claude 模型里选一个。',
    ],
    openrouter: [
        '点酒馆顶部的插头图标（API 连接），「API」选 聊天补全（Chat Completion）。',
        '「聊天补全来源」选 OpenRouter。',
        '把 OpenRouter 密钥粘到「OpenRouter API 密钥」框（或点它旁边的登录），点 连接。',
        '模型选 anthropic/claude-… 开头的一个。',
    ],
    relay: [
        '点酒馆顶部的插头图标（API 连接），「API」选 聊天补全（Chat Completion）。',
        '「聊天补全来源」选你的中转：Electron Hub / NanoGPT 等直接选；其他选 自定义（兼容 OpenAI）。',
        '自定义要填中转的地址和密钥，模型 ID 填带 claude 的名字。密钥都粘在酒馆自己的框里，点 连接。',
    ],
};

/** Step 3: what CCST does for each source. */
export const SUMMARY = {
    proxy: {
        works: ['缓存排布（长提示词一直命中）', '防丢回复（断线后补回）', '额度和用量统计', '模型与思考深度、发送前检查、体检、灵动岛'],
        gaps: ['不支持温度、Top-P 等采样参数'],
    },
    claude: {
        works: ['模型切换、按预设调整模型', '发送前检查、体检、灵动岛'],
        gaps: ['没有防丢回复、额度和用量统计（要走代理）', '缓存靠酒馆自带设置，见下面的建议'],
    },
    openrouter: {
        works: ['模型切换、按预设调整模型', '发送前检查、体检、灵动岛'],
        gaps: ['没有防丢回复、额度和用量统计（要走代理）', '缓存靠酒馆自带设置，见下面的建议'],
    },
    relay: {
        works: ['发送前检查、体检、灵动岛'],
        gaps: ['没有防丢回复、额度和用量统计（要走代理）', '缓存由中转自己决定，酒馆多半没有设置'],
    },
};

/** Direct sources get the recommended-cache-settings card on 第 3 步. */
export const showsCacheCard = (choice) => choice === 'claude' || choice === 'openrouter' || choice === 'relay';

/** Settings after each user action (the caller assigns the keys back). */
export const startGuide = () => ({ onboarded: false, guideSource: 'choose' });
export const pickSource = (id) => ({ onboarded: false, guideSource: isSourceId(id) ? id : 'choose' });
export const backToChoose = () => ({ onboarded: false, guideSource: 'choose' });
export const finishGuide = () => ({ onboarded: true, guideSource: '' });
