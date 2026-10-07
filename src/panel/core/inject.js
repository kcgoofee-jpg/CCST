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
        ? `发现这段要求：「${asked[0].slice(0, 60)}」（多半在预设条目或角色卡的世界书里）。`
        : `预设「${preset}」要求模型把思考（<thinking> / <cot>）写进回复。`;
    notify('warn', 'Opus 5 / 5.5 可能会拦这条请求',
        `${where}这类条目让模型把思考写进回复，Opus 5、Opus 5.5、Sonnet 5.5 会拒绝这样的请求（拒绝了也照常计费）。` +
        '把那一条关掉；想看写在正文里的思考，用 Opus 4.6 并把思考模式关闭。',
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
    notify('warn', '连 CCST 时，提示词后处理建议选「无」',
        `现在是「${POST_PROCESSING_LABELS[mode] ?? mode}」：酒馆会把预设改成普通用户消息，Claude 对预设指令的遵循会变弱，长聊天的缓存也更容易整段失效。` +
        'CCST 代理会自己整理消息角色，所以选「无」更好。改法：API 连接 → 提示词后处理 → 无。用别的 API 时按预设作者的建议来。',
        { ms: 20000 });
}

// What SillyTavern injects INTO the chat this request, and how it was set up. Early in a chat ST
// puts a depth-N injection above every message, where the proxy could not tell it from the preset;
// the opening text of each one lets the proxy keep it with the current turn (system-placement.js).
let activatedLore = [];
export function resetActivatedLore() { activatedLore = []; }
export function noteActivatedLore(entries) {
    try {
        const list = Array.isArray(entries) ? entries : [...(entries?.values?.() ?? [])];
        activatedLore = list.map((e) => String(e?.comment || e?.uid || '').slice(0, 40)).filter(Boolean).slice(0, 80);
    } catch { activatedLore = []; }
}

function enabledPromptIds(oai) {
    const ids = new Set();
    for (const o of oai.prompt_order ?? []) for (const p of o?.order ?? []) if (p?.enabled) ids.add(p.identifier);
    return ids;
}

export function injectedOpenings(ctx = SillyTavern.getContext()) {
    const sub = (t) => { try { return ctx.substituteParams ? ctx.substituteParams(t) : t; } catch { return t; } };
    const pieces = [];
    for (const p of Object.values(ctx.extensionPrompts ?? {})) {
        if (p?.position === 1 && typeof p.value === 'string') pieces.push(sub(p.value));
    }
    const oai = ctx.chatCompletionSettings ?? {};
    const on = enabledPromptIds(oai);
    for (const pr of oai.prompts ?? []) {
        if (pr?.injection_position === 1 && on.has(pr.identifier) && typeof pr.content === 'string') pieces.push(sub(pr.content));
    }
    return [...new Set(pieces.map((t) => t.trim()).filter((t) => t.length >= 8).map((t) => t.slice(0, 48)))].slice(0, 64);
}

// FNV-1a: enough to tell "the preset's entries changed" apart, no crypto needed.
function fnv(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
}

export function stFingerprint(data, ctx = SillyTavern.getContext()) {
    const oai = ctx.chatCompletionSettings ?? {};
    const prompts = (oai.prompts ?? []).map((p) => [p.identifier, p.content, p.injection_position, p.injection_depth, p.role]);
    return {
        preset: String(oai.preset_settings_openai ?? ''),
        pp: String(data?.custom_prompt_post_processing ?? '') || 'none',
        order: fnv(JSON.stringify([oai.prompt_order ?? [], prompts])),
        wi: activatedLore,
    };
}

// One-shot effort for the next reply (M2): kept in memory only (store.nextEffort), used by
// every request until a chat message arrives, then cleared.
export function effectiveEffort(settings) {
    return store.get().nextEffort ?? settings.effort;
}

export function buildIncludeBodyYaml(settings, quiet = false, slot = null, model = '') {
    const lines = ['claude_subscription:'];
    // Background calls never take the one-shot effort meant for the next reply.
    const effort = quiet ? (settings.quietEffort === 'follow' ? settings.effort : settings.quietEffort) : effectiveEffort(settings);
    if (quiet) lines.push('  purpose: quiet');
    // 「不思考」 means no thinking at all: no effort level goes out with it.
    // 「不思考」 drops the depth, except on a model that always thinks (the proxy ignores off there).
    const thinksAnyway = !!(model && libs.sources?.isAdaptiveOnly?.(model));
    if (effort !== 'auto' && (settings.thinking !== 'off' || thinksAnyway)) lines.push(`  effort: ${effort}`);
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
    if (settings.diagCapture) lines.push('  diag_capture: true');
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

        const quiet = data.type === 'quiet';
        let yaml = buildIncludeBodyYaml(settings, quiet, slot, data.model ?? '');
        // JSON is valid YAML: the snippets carry quotes, colons and newlines safely.
        if (!quiet) yaml += `\n  late: ${JSON.stringify(injectedOpenings())}\n  st_fp: ${JSON.stringify(stFingerprint(data))}`;
        data.custom_include_body = (cleaned ? cleaned + '\n' : '') + yaml;
        preflightCheck(data);
        postProcessingCheck(data);
    } catch (err) {
        console.error('[claude-max] failed to inject settings', err);
    }
}
