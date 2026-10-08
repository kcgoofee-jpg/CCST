// ──────────────────────────────────────────────
// 一键连接 → 「CCST」连接配置: which slash commands to run, and what to tell the user.
// SillyTavern's connection manager (extensions/connection-manager) owns profiles; we only drive its
// /profile-list, /profile, /profile-create and /profile-update. Pure functions, no ST objects.
// ──────────────────────────────────────────────

export const PROFILE_NAME = 'CCST';
export const PROFILE_MODEL = 'claude-opus-4-6';

/** /profile-list prints a JSON array of names; anything else counts as "no profiles we can see". */
export function parseProfileList(output) {
    try {
        const list = JSON.parse(String(output ?? '[]'));
        return Array.isArray(list) ? list.map(String) : [];
    } catch {
        return [];
    }
}

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

/** ST's chat_completion_source ids → names the user sees in the 来源 dropdown (unknown ids stay raw). */
export const SOURCE_NAMES = {
    custom: '自定义（兼容 OpenAI）', claude: 'Claude', openai: 'OpenAI', openrouter: 'OpenRouter',
    makersuite: 'Google AI Studio', vertexai: 'Google Vertex AI', mistralai: 'MistralAI', deepseek: 'DeepSeek',
    cohere: 'Cohere', perplexity: 'Perplexity', groq: 'Groq', ai21: 'AI21', xai: 'xAI (Grok)',
    aimlapi: 'AI/ML API', electronhub: 'Electron Hub', nanogpt: 'NanoGPT', pollinations: 'Pollinations',
    moonshot: 'Moonshot AI', fireworks: 'Fireworks AI', cometapi: 'CometAPI', azure_openai: 'Azure OpenAI',
    zai: 'Z.AI (GLM)', siliconflow: 'SiliconFlow', chutes: 'Chutes',
};
export const sourceLabel = (id) => SOURCE_NAMES[id] ?? id;

/** The confirm popup's 「现在：…」 line. ST's connection manager reports "<None>" for no profile: leave it out. */
export function describeCurrentConnection({ profile = '', source = '', url = '', model = '' } = {}) {
    const p = String(profile ?? '').trim();
    const hasProfile = p && !/^<none>$/i.test(p);
    return [hasProfile && `连接配置「${p}」`, source && `来源 ${sourceLabel(source)}`, url, model].filter(Boolean).join(' · ');
}

/**
 * The model the connect should end on: the Claude model ST already has (kept as it is, incl. a [1m] suffix),
 * else the default. `canonical(id)` turns any source's spelling into claude-xxx (null when not Claude).
 */
export function chooseConnectModel(current, canonical = (id) => (/^claude-/i.test(String(id ?? '')) ? String(id).replace(/\[1m\]$/i, '').toLowerCase() : null)) {
    const base = canonical(current);
    if (!base) return PROFILE_MODEL;
    return base + (/\[1m\]$/i.test(String(current ?? '')) ? '[1m]' : '');
}

/** The one-line toast after a successful connect. `modelLabel` is the model as the user reads it (Opus 4.6). */
export function profileNotice({ modelOk = true, modelLabel = 'Opus 4.6', name = PROFILE_NAME, existed = false }) {
    return modelOk
        ? `${modelLabel} 已就绪`
        : '请到「API 连接」选模型';
}

/** Separate advice notices (only the ones that apply), after a successful connect. */
export function connectAdvice({ presetNote = '', regexNote = '' } = {}) {
    return [presetNote && { key: 'connect-preset', text: presetNote }, regexNote && { key: 'connect-regex', text: regexNote }].filter(Boolean);
}

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
