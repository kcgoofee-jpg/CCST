// ──────────────────────────────────────────────
// 一键连接 → 「CCST」连接配置: which slash commands to run, and what to tell the user.
// SillyTavern's connection manager (extensions/connection-manager) owns profiles; we only drive its
// /profile-list, /profile, /profile-create and /profile-update. Pure functions, no ST objects.
// ──────────────────────────────────────────────

// 审: 一键连接创建/更新的酒馆连接配置名，只动这一个，不碰用户别的配置。
const PROFILE_NAME = 'CCST';
// 审: 酒馆里没有 Claude 模型时一键连接选的默认模型；测试引用。
export const PROFILE_MODEL = 'claude-opus-4-6';

// 审: 解析 /profile-list 的输出（JSON 数组），读不了就当「看不到任何配置」。
/** /profile-list prints a JSON array of names; anything else counts as "no profiles we can see". */
export function parseProfileList(output) {
    try {
        const list = JSON.parse(String(output ?? '[]'));
        return Array.isArray(list) ? list.map(String) : [];
    } catch {
        return [];
    }
}

// 审: 决定配置步骤的命令序列：已存在先选中再更新，不存在则直接创建。
/**
 * The command sequence for the profile step.
 *  - Profile exists: select it first (that loads its OLD settings), the caller then re-applies the
 *    connection and the model on top, and `save` updates the profile from the live settings.
 *  - Missing: the caller applies the connection first, `save` creates the profile from the live
 *    settings (and selects it). `select` is null.
 * Other profiles are never touched.
 */
export function planProfile(listOutput, name = PROFILE_NAME) {
    const existed = parseProfileList(listOutput).includes(name);
    return existed
        ? { existed, select: `/profile ${name}`, save: '/profile-update' }
        : { existed, select: null, save: `/profile-create ${name}` };
}

// 审: 酒馆 chat_completion_source 的 id → 来源下拉里用户看到的名字；确认弹窗的「现在：…」用，未知 id 原样显示。
/** ST's chat_completion_source ids → names the user sees in the 来源 dropdown (unknown ids stay raw). */
const SOURCE_NAMES = {
    custom: '自定义（兼容 OpenAI）', claude: 'Claude', openai: 'OpenAI', openrouter: 'OpenRouter',
    makersuite: 'Google AI Studio', vertexai: 'Google Vertex AI', mistralai: 'MistralAI', deepseek: 'DeepSeek',
    cohere: 'Cohere', perplexity: 'Perplexity', groq: 'Groq', ai21: 'AI21', xai: 'xAI (Grok)',
    aimlapi: 'AI/ML API', electronhub: 'Electron Hub', nanogpt: 'NanoGPT', pollinations: 'Pollinations',
    moonshot: 'Moonshot AI', fireworks: 'Fireworks AI', cometapi: 'CometAPI', azure_openai: 'Azure OpenAI',
    zai: 'Z.AI (GLM)', siliconflow: 'SiliconFlow', chutes: 'Chutes',
};
// 审: 来源 id → 显示名，查不到原样返回。
export const sourceLabel = (id) => SOURCE_NAMES[id] ?? id;

// 审: 连接确认弹窗里「现在：…」那一行（配置·来源·地址·模型），酒馆报「<None>」时省略配置。
/** The confirm popup's 「现在：…」 line. ST's connection manager reports "<None>" for no profile: leave it out. */
export function describeCurrentConnection({ profile = '', source = '', url = '', model = '' } = {}) {
    const p = String(profile ?? '').trim();
    const hasProfile = p && !/^<none>$/i.test(p);
    return [hasProfile && `连接配置「${p}」`, source && `来源 ${sourceLabel(source)}`, url, model].filter(Boolean).join(' · ');
}

// 审: 连接后应落在哪个模型：酒馆里已有的 Claude 模型原样保留（含 [1m]），否则用默认。
/**
 * The model the connect should end on: the Claude model ST already has (kept as it is, incl. a [1m] suffix),
 * else the default. `canonical(id)` turns any source's spelling into claude-xxx (null when not Claude).
 */
export function chooseConnectModel(current, canonical = (id) => (/^claude-/i.test(String(id ?? '')) ? String(id).replace(/\[1m\]$/i, '').toLowerCase() : null)) {
    const base = canonical(current);
    if (!base) return PROFILE_MODEL;
    return base + (/\[1m\]$/i.test(String(current ?? '')) ? '[1m]' : '');
}

// 审: 连接成功后的一行 toast 文案（模型已就绪 / 请去选模型）。
/** The one-line toast after a successful connect. `modelLabel` is the model as the user reads it (Opus 4.6). */
export function profileNotice({ modelOk = true, modelLabel = 'Opus 4.6' }) {
    return modelOk
        ? `${modelLabel} 已就绪`
        : '请到「API 连接」选模型';
}

// 审: 连接后额外的建议通知，只列适用的（预设/正则）。
/** Separate advice notices (only the ones that apply), after a successful connect. */
export function connectAdvice({ presetNote = '', regexNote = '' } = {}) {
    return [presetNote && { key: 'connect-preset', text: presetNote }, regexNote && { key: 'connect-regex', text: regexNote }].filter(Boolean);
}

// 审: 执行连接配置这一步：run 跑斜杠命令、applyConnection 写入实时字段；酒馆空答复视为被拒绝。
/**
 * Run the profile step. `run(cmd)` executes one slash command and resolves to its text result (empty
 * when it could not run); `applyConnection()` sets source / URL / key / model on the live fields.
 * Returns { ok, existed } or { ok: false, reason }.
 */
export async function ensureProfile({ run, applyConnection, hasCommands, settle = async () => {} }) {
    if (!hasCommands()) return { ok: false, reason: 'no-connection-manager' };
    const plan = planProfile(await run('/profile-list'));
    if (plan.select) {
        await run(plan.select);
        await applyConnection();
    }
    await settle();
    const saved = await run(plan.save);
    // Both commands answer with the profile's name; an empty answer means ST refused.
    if (!saved) return { ok: false, reason: 'refused', existed: plan.existed };
    return { ok: true, existed: plan.existed };
}
