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

/** The confirm popup's 「现在：…」 line. ST's connection manager reports "<None>" for no profile: leave it out. */
export function describeCurrentConnection({ profile = '', source = '', url = '', model = '' } = {}) {
    const p = String(profile ?? '').trim();
    const hasProfile = p && !/^<none>$/i.test(p);
    return [hasProfile && `连接配置「${p}」`, source && `来源 ${source}`, url, model].filter(Boolean).join(' · ');
}

/** The notice after the profile step (plain words: where to double-check). */
export function profileNotice({ existed, modelOk = true, name = PROFILE_NAME }) {
    const verb = existed ? '已更新' : '已新建并选中';
    return modelOk
        ? `${verb}连接配置『${name}』，模型 Opus 4.6。请到『API 连接』核对来源、地址和模型。`
        : `${verb}连接配置『${name}』，但模型没能自动选上。请到『API 连接』选好模型并核对来源、地址。`;
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
