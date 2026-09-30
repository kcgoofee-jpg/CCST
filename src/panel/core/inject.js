// ──────────────────────────────────────────────
// Per-request injection (CHAT_COMPLETION_SETTINGS_READY): the Claude-native settings go out through
// `custom_include_body`, only when the active connection points at this proxy. Also the pre-send
// checks (preflight, prompt post-processing) for requests that go to Claude directly.
// ──────────────────────────────────────────────

import { getSettings } from './settings.js';
import { classifyRequest } from './capabilities.js';
import { libs } from './libs.js';
import { store } from './store.js';
import { notify } from './notify.js';
import { F } from './registry.js';
import { chatKeyOf } from './chat-key.js';

// Opus 5.5's safeguards refuse prompts that make the model write its
// reasoning into the reply (category reasoning_extraction). Presets that
// prescribe a <thinking>/<cot> block in the output trip it every time.
// The instruction can also sit in a character card's lorebook (seen live: a constant entry
// 「<think> 已被禁止，请立即用全英文输出 <draft_notes>」), so user messages are read too.
const COT_TAGS = 'thinking|think|cot|draft_notes|draft|scratchpad|reasoning|analysis|思考|思维链';
const COT_ASK = new RegExp(
    `(?:输出|写出|写下|先写|先在|用全英文|放进|output|write)[^\\n]{0,40}<(?:${COT_TAGS})>` +
    `|<(?:${COT_TAGS})>[^\\n]{0,40}(?:中思考|里思考|内思考|中分析|里分析)`, 'i');
const warnedPresets = new Set();
function preflightCheck(data) {
    // Verified live: Opus 5 refuses these too, not only Opus 5.5 (the docs say 5.5 only).
    if (!/opus-5/i.test(String(data.model ?? ''))) return;
    const ctx = SillyTavern.getContext();
    const preset = ctx.chatCompletionSettings?.preset_settings_openai ?? '';
    const key = `${preset}\u0000${ctx.characterId ?? ''}`;
    if (warnedPresets.has(key)) return;
    const textOf = (role) => (data.messages ?? [])
        .filter((m) => m?.role === role)
        .map((m) => (typeof m.content === 'string' ? m.content : ''))
        .join('\n');
    const system = textOf('system');
    const asked = (system + '\n' + textOf('user')).match(COT_ASK);
    if (!asked && !/<\/?(thinking|cot)>/i.test(system)) return;
    warnedPresets.add(key);
    const where = asked
        ? `这段要求：「${asked[0].slice(0, 60)}」（多半在角色卡的世界书或预设条目里，把那一条关掉就好）。`
        : `预设「${preset}」要求模型把思考过程（<thinking>/<cot>）写进回复。`;
    notify('warn', 'Opus 5 / 5.5 可能会拦这条请求',
        `${where}Opus 5 / Opus 5.5 的安全分类器会拦截「把思考写进正文」的请求（reasoning_extraction），被拦也照样计费。` +
        '本扩展用的是原生思考，不需要这类条目；想看写在正文里的思维链，就在「推理」页把模型切到 Opus 4.6 并把思考关掉。',
        { ms: 20000 });
}

// ST's Custom-endpoint "prompt post-processing" (merge / semi / strict)
// merges the preset into user messages before the proxy sees it: the
// system prompt shrinks to the first entry, the preset loses system
// authority, and world info changing every turn breaks the cache for
// the whole conversation.
const POST_PROCESSING_LABELS = {
    merge: '合并连续角色', semi: '半严格', strict: '严格', single: '单条用户消息',
    merge_tools: '合并连续角色（工具）', semi_tools: '半严格（工具）', strict_tools: '严格（工具）',
};
let warnedPostProcessing = false;
function postProcessingCheck(data) {
    const mode = String(data.custom_prompt_post_processing ?? '');
    if (!mode || warnedPostProcessing) return;
    warnedPostProcessing = true;
    notify('warn', `提示词后处理是「${POST_PROCESSING_LABELS[mode] ?? mode}」`,
        '它会把预设合并成用户消息，预设失去系统权重，而且世界书一变整段缓存就失效。' +
        '改成「无」（API 连接 → 提示词后处理），或在 CCST「设置」点「重新连接」。',
        { ms: 20000 });
}

// One-shot effort for the next reply (M2): kept in memory only (store.nextEffort), used by
// every request until a chat message arrives, then cleared.
export function effectiveEffort(settings) {
    return store.get().nextEffort ?? settings.effort;
}

export function buildIncludeBodyYaml(settings, quiet = false, slot = null) {
    const lines = ['claude_subscription:'];
    // Background calls never take the one-shot effort meant for the next reply.
    const effort = quiet ? (settings.quietEffort === 'follow' ? settings.effort : settings.quietEffort) : effectiveEffort(settings);
    if (quiet) lines.push('  purpose: quiet');
    if (effort !== 'auto') lines.push(`  effort: ${effort}`);
    lines.push(`  thinking: ${settings.thinking}`);
    // Follows ST's「显示模型思维」; a preset can still turn it off.
    const stShows = SillyTavern.getContext().chatCompletionSettings?.show_thoughts !== false;
    lines.push(`  show_reasoning: ${settings.showReasoning && stShows}`);
    lines.push(`  identity_mode: ${settings.identityMode}`);
    lines.push(`  use_resume: ${settings.useResume}`);
    lines.push(`  system_placement: ${settings.inlineSystem ? 'inline' : 'hoist'}`);
    if (settings.tailBlockFront) lines.push('  tail_block: front');
    lines.push(`  lore_tail: ${settings.loreTail}`);
    lines.push(`  fold_tail: ${settings.foldTail}`);
    if (settings.debugDump) lines.push('  debug_dump: true');
    if (slot && !quiet) lines.push(`  reply_slot: ${slot}`);
    // Which chat this is (a hash): the proxy files the usage record under it, so 状态 shows this chat's last turn.
    const chatKey = quiet ? null : chatKeyOf(SillyTavern.getContext());
    if (chatKey) lines.push(`  chat_key: ${chatKey}`);
    return lines.join('\n');
}

export function onSettingsReady(data) {
    try {
        const settings = getSettings();
        if (!settings.enabled) return;
        if (!data) return;
        // Direct to Claude (no proxy): only the local pre-send check applies.
        const { ours, direct } = classifyRequest(data, settings, libs.sources);
        if (direct) {
            preflightCheck(data);
            return;
        }
        if (!ours) return;

        const existing = typeof data.custom_include_body === 'string' ? data.custom_include_body : '';
        const cleaned = existing
            .replace(/^claude_subscription:[\s\S]*?(?=^\S|\s*$(?![\s\S]))/m, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        // The reply keeper hands out the reply's slot (null for quiet / impersonate / continue).
        const slot = F.keeper.openSlot(data) ?? null;

        data.custom_include_body = (cleaned ? cleaned + '\n' : '') + buildIncludeBodyYaml(settings, data.type === 'quiet', slot);
        preflightCheck(data);
        postProcessingCheck(data);
    } catch (err) {
        console.error('[claude-max] failed to inject settings', err);
    }
}
