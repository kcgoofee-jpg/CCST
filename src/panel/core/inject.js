// ──────────────────────────────────────────────
// Per-request injection (CHAT_COMPLETION_SETTINGS_READY): the Claude-native settings go out through
// `custom_include_body`, only when the active connection points at this proxy. Also the pre-send
// checks (preflight, prompt post-processing) for those requests.
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
    `|<(?:${COT_TAGS})>[^\\n]{0,40}(?:中思考|里思考|内思考|中分析|里分析)` +
    // 「写正文前在思考中逐步完成以下步骤，每一步都要写出具体结论」(图灵预设的思维链条目，实测 Opus 5.5 十四次拦了十次)
    '|(?:在|于)思考(?:中|里|时)[^\\n]{0,20}(?:逐步|按步骤|步骤|写出|完成以下)', 'i');
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
    notify('warn', 'Opus 5.5 多半会拦这条',
        `${where}关掉那一条，或换 Opus 4.6。被拦也照扣额度。`,
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
// Keyword-triggered entries placed before / after the character (inside the system prompt): their text,
// so the proxy can lift exactly them out when they change from turn to turn (lore-tail.js cutExactLore).
let triggeredLore = [];
const MAX_TRIGGERED_CHARS = 200_000;
export function resetActivatedLore() { activatedLore = []; triggeredLore = []; }
export function noteActivatedLore(entries) {
    try {
        const ctx = SillyTavern.getContext();
        const sub = (t) => { try { return ctx.substituteParams ? ctx.substituteParams(t) : t; } catch { return t; } };
        const list = Array.isArray(entries) ? entries : [...(entries?.values?.() ?? [])];
        activatedLore = list.map((e) => String(e?.comment || e?.uid || '').slice(0, 40)).filter(Boolean).slice(0, 80);
        let total = 0;
        triggeredLore = [];
        for (const e of list) {
            if (e?.constant || (e?.position !== 0 && e?.position !== 1) || typeof e?.content !== 'string') continue;
            const t = sub(e.content).trim();
            if (t.length < 20 || total + t.length > MAX_TRIGGERED_CHARS) continue;
            total += t.length;
            triggeredLore.push(t);
        }
    } catch { activatedLore = []; triggeredLore = []; }
}

/** Opening text of the first and last chat messages in this prompt: where the chat history starts
 *  and ends. Presets put user / assistant entries before the history (Kemini, Izumi) and after it;
 *  without these the proxy took the first user message for the start of the chat. */
export function historyMarks(ctx = SillyTavern.getContext()) {
    const sub = (t) => { try { return ctx.substituteParams ? ctx.substituteParams(t) : t; } catch { return t; } };
    const snip = (m) => sub(String(m?.mes ?? '')).trim().slice(0, 40);
    const shown = (ctx.chat ?? []).filter((m) => !m?.is_system);
    const ok = (s) => s.length >= 8;
    return {
        start: shown.slice(0, 3).map(snip).filter(ok),
        end: shown.slice(-2).map(snip).filter(ok),
    };
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

/** What could rewrite the prompt on its own at send time: 酒馆助手 scripts that actually run (global ones
 *  while global scripts are on; the preset's / card's only when allowed for that preset / card; a folder's
 *  enabled scripts when the folder is on), and prompt-only regexes that act by depth (preset / card ones
 *  only when allowed) — they rewrite older messages as they age. Named in the cache explanation when the
 *  prompt changed but no setting did (Izumi's 悬浮窗). Unknown shapes are skipped, never thrown on. */
export function promptMutators(ctx = SillyTavern.getContext()) {
    const out = [];
    const arr = (v) => (Array.isArray(v) ? v : []);
    const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
    const safe = (fn) => { try { fn(); } catch { /* unexpected shape: skip */ } };
    const ext = obj(ctx?.extensionSettings);
    const off = arr(ext.disabledExtensions).map(String);
    const oai = obj(ctx?.chatCompletionSettings);
    const preset = String(oai.preset_settings_openai ?? '');
    let card = {};
    safe(() => { card = obj(ctx.characters?.[ctx.characterId]); });
    const avatar = typeof card.avatar === 'string' ? card.avatar : null;
    const cardExt = obj(card.data?.extensions);

    safe(() => {
        if (off.some((x) => /JS-Slash-Runner|tavern.?helper/i.test(x))) return;
        const th = obj(obj(ext.tavern_helper).script);
        const allow = obj(th.enabled);
        // Older 酒馆助手 kept a card's settings as [key, value] pairs.
        let cardTh = cardExt.tavern_helper;
        if (Array.isArray(cardTh)) { try { cardTh = Object.fromEntries(cardTh); } catch { cardTh = {}; } }
        const lists = [];
        if (allow.global !== false) lists.push(th.scripts);
        if (preset && arr(allow.presets).includes(preset)) lists.push(obj(obj(oai.extensions).tavern_helper).scripts);
        if (avatar && arr(allow.characters).includes(avatar)) lists.push(obj(cardTh).scripts);
        const add = (list, inFolder) => {
            for (const s of arr(list)) {
                if (!s || typeof s !== 'object' || s.enabled !== true) continue;
                if (s.type === 'folder') { if (!inFolder) add(s.scripts, true); continue; }
                if (s.name) out.push(`脚本「${String(s.name).slice(0, 24)}」`);
            }
        };
        for (const list of lists) safe(() => add(list, false));
    });

    safe(() => {
        if (off.includes('regex')) return;
        const deep = (v) => v !== null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 2;
        const lists = [ext.regex];
        if (preset && arr(obj(ext.preset_allowed_regex).openai).includes(preset)) lists.push(obj(oai.extensions).regex_scripts);
        if (avatar && arr(ext.character_allowed_regex).includes(avatar)) lists.push(cardExt.regex_scripts);
        for (const list of lists) {
            for (const r of arr(list)) {
                if (r && typeof r === 'object' && !r.disabled && r.promptOnly && (deep(r.minDepth) || deep(r.maxDepth))) out.push(`正则「${String(r.scriptName ?? '').slice(0, 24)}」`);
            }
        }
    });
    return [...new Set(out)].slice(0, 12);
}

export function stFingerprint(data, ctx = SillyTavern.getContext()) {
    const oai = ctx.chatCompletionSettings ?? {};
    const prompts = (oai.prompts ?? []).map((p) => [p.identifier, p.content, p.injection_position, p.injection_depth, p.role]);
    return {
        preset: String(oai.preset_settings_openai ?? ''),
        pp: String(data?.custom_prompt_post_processing ?? '') || 'none',
        order: fnv(JSON.stringify([oai.prompt_order ?? [], prompts])),
        wi: activatedLore,
        mut: promptMutators(ctx),
        // No WORLD_INFO_ACTIVATED (old SillyTavern): wi stays empty whatever fired.
        ...(ctx.eventTypes?.WORLD_INFO_ACTIVATED ? {} : { wiOff: true }),
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
    lines.push(`  lore_tail: ${settings.loreTail}`);
    lines.push(`  fold_tail: ${settings.foldTail}`);
    if (settings.cacheTtl === '5m') lines.push('  cache_ttl: 5m');
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
        const { ours } = classifyRequest(data, settings);
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
        if (!quiet) {
            yaml += `\n  late: ${JSON.stringify(injectedOpenings())}\n  st_fp: ${JSON.stringify(stFingerprint(data))}`;
            yaml += `\n  hist: ${JSON.stringify(historyMarks())}\n  gen_type: ${JSON.stringify(String(data.type ?? 'normal'))}`;
            if (triggeredLore.length) yaml += `\n  lore_text: ${JSON.stringify(triggeredLore)}`;
        }
        data.custom_include_body = (cleaned ? cleaned + '\n' : '') + yaml;
        preflightCheck(data);
        postProcessingCheck(data);
    } catch (err) {
        console.error('[claude-max] failed to inject settings', err);
    }
}
