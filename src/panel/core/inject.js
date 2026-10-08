// ──────────────────────────────────────────────
// Per-request injection (CHAT_COMPLETION_SETTINGS_READY): the Claude-native settings go out through
// `custom_include_body`, only when the active connection points at this proxy. Also the pre-send
// checks (preflight, prompt post-processing) for those requests.
// ──────────────────────────────────────────────

import { getSettings } from './settings.js';
import { classifyRequest } from './capabilities.js';
import { libs } from './libs.js';
import { notify } from './notify.js';
import { F } from './registry.js';
import { chatKeyOf } from './chat-key.js';

// 审: 预检用的「思维链标签」名单；5.x 模型会拦截让它把思考写进回复的提示词，发出前先预警。
// Opus 5.5's safeguards refuse prompts that make the model write its
// reasoning into the reply (category reasoning_extraction). Presets that
// prescribe a <thinking>/<cot> block in the output trip it every time.
// The instruction can also sit in a character card's lorebook (seen live: a constant entry
// 「<think> 已被禁止，请立即用全英文输出 <draft_notes>」), so user messages are read too.
const COT_TAGS = 'thinking|think|cot|draft_notes|draft|scratchpad|reasoning|analysis|思考|思维链';
// 审: 识别「要求模型输出/写出 <思考标签>」的几种常见写法（含角色卡世界书里的）。
const COT_ASK = new RegExp(
    `(?:输出|写出|写下|先写|先在|用全英文|放进|output|write)[^\\n]{0,40}<(?:${COT_TAGS})>` +
    `|<(?:${COT_TAGS})>[^\\n]{0,40}(?:中思考|里思考|内思考|中分析|里分析)` +
    // 「写正文前在思考中逐步完成以下步骤，每一步都要写出具体结论」(图灵预设的思维链条目，实测 Opus 5.5 十四次拦了十次)
    '|(?:在|于)思考(?:中|里|时)[^\\n]{0,20}(?:逐步|按步骤|步骤|写出|完成以下)', 'i');
// 审: 每个「预设+角色」只预警一次，别刷屏。
const warnedPresets = new Set();
// 审: 发往 Opus 5.x 前检查提示词是否让模型写出思考，是则弹一次「可能被拦」；纯提示，不改请求。
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
        ? `「${asked[0].slice(0, 40)}」：`
        : `「${preset}」：`;
    notify('warn', '可能被拦',
        `${where}5.x 不许写出思考：关掉或换 4.6`,
        { ms: 20000 });
}

// 审: 酒馆「提示词后处理」各模式的中文名，仅用于下面的提示文案。
// ST's Custom-endpoint "prompt post-processing" (merge / semi / strict)
// merges the preset into user messages before the proxy sees it: the
// system prompt shrinks to the first entry, the preset loses system
// authority, and world info changing every turn breaks the cache for
// the whole conversation.
const POST_PROCESSING_LABELS = {
    merge: '合并连续角色', semi: '半严格', strict: '严格', single: '单条用户消息',
    merge_tools: '合并连续角色（工具）', semi_tools: '半严格（工具）', strict_tools: '严格（工具）',
};
// 审: 后处理预警整个会话只弹一次。
let warnedPostProcessing = false;
// 审: 酒馆自定义来源开着「提示词后处理」会把预设并进用户消息、破坏缓存，发现就提示改成无。
function postProcessingCheck(data) {
    const mode = String(data.custom_prompt_post_processing ?? '');
    if (!mode || warnedPostProcessing) return;
    warnedPostProcessing = true;
    notify('warn', '改后处理',
        `「API 连接」里提示词后处理选无（现在是「${POST_PROCESSING_LABELS[mode] ?? mode}」）`,
        { ms: 20000 });
}

// 审: 对一段文字做酒馆宏展开（{{char}} 等），酒馆没有该能力或出错则原样返回；三处共用。
// ST's macro expansion ({{char}} etc.) of a piece of text; unchanged when ST can't.
const substitute = (ctx, t) => { try { return ctx.substituteParams ? ctx.substituteParams(t) : t; } catch { return t; } };

// 审: 本轮触发的世界书条目名（给代理的 st_fp.wi，用来解释缓存为何变化）；每轮开始清空。
// What SillyTavern injects INTO the chat this request, and how it was set up. Early in a chat ST
// puts a depth-N injection above every message, where the proxy could not tell it from the preset;
// the opening text of each one lets the proxy keep it with the current turn (system-placement.js).
let activatedLore = [];
// 审: 本轮关键词触发、位置在角色前后的条目全文，代理据此把它们精确挪到本轮消息（lore_text）。
// Keyword-triggered entries placed before / after the character (inside the system prompt): their text,
// so the proxy can lift exactly them out when they change from turn to turn (lore-tail.js cutExactLore).
let triggeredLore = [];
// 审: 上面全文总长上限，防止请求体过大。
const MAX_TRIGGERED_CHARS = 200_000;
// 审: GENERATION_STARTED 时清空上一轮的世界书记录。
export function resetActivatedLore() { activatedLore = []; triggeredLore = []; }
// 审: WORLD_INFO_ACTIVATED 时记下触发条目名与可挪动条目的全文（常驻和非前后位置的不记）。
export function noteActivatedLore(entries) {
    try {
        const ctx = SillyTavern.getContext();
        const list = Array.isArray(entries) ? entries : [...(entries?.values?.() ?? [])];
        activatedLore = list.map((e) => String(e?.comment || e?.uid || '').slice(0, 40)).filter(Boolean).slice(0, 80);
        let total = 0;
        triggeredLore = [];
        for (const e of list) {
            if (e?.constant || (e?.position !== 0 && e?.position !== 1) || typeof e?.content !== 'string') continue;
            const t = substitute(ctx, e.content).trim();
            if (t.length < 20 || total + t.length > MAX_TRIGGERED_CHARS) continue;
            total += t.length;
            triggeredLore.push(t);
        }
    } catch { activatedLore = []; triggeredLore = []; }
}

// 审: 提示里聊天记录的首尾几条开头文字，代理靠它定位「聊天从哪开始/到哪结束」，否则会把预设里的 user 条目当成聊天起点。
/** Opening text of the first and last chat messages in this prompt: where the chat history starts
 *  and ends. Presets put user / assistant entries before the history (Kemini, Izumi) and after it;
 *  without these the proxy took the first user message for the start of the chat. Thinking written
 *  into a reply is skipped (a prompt regex strips it, 灰烬之桥). A short last message (「继续」) is
 *  sent whole in `exact`: the proxy matches it as the whole message, so it can't hit an old turn. */
export function historyMarks(ctx = SillyTavern.getContext()) {
    const body = (m) => substitute(ctx, String(m?.mes ?? '')).replace(/^(?:\s*<(thinking|think)(?:\s[^<>]*)?>[\s\S]*?<\/\1\s*>)+/i, '').trim();
    const snip = (m) => body(m).slice(0, 40);
    const shown = (ctx.chat ?? []).filter((m) => !m?.is_system);
    const ok = (s) => s.length >= 8;
    const last = shown.length ? body(shown[shown.length - 1]) : '';
    return {
        start: shown.slice(0, 3).map(snip).filter(ok),
        end: shown.slice(-2).map(snip).filter(ok),
        ...(last && !ok(last) ? { exact: [last] } : {}),
    };
}

// 审: 预设里当前启用的条目 id 集合，injectedOpenings 过滤用。
function enabledPromptIds(oai) {
    const ids = new Set();
    for (const o of oai.prompt_order ?? []) for (const p of o?.order ?? []) if (p?.enabled) ids.add(p.identifier);
    return ids;
}

// 审: 酒馆本轮在聊天里插入的深度注入的开头文字，代理据此把它们留在本轮而不是当成预设。
function injectedOpenings(ctx = SillyTavern.getContext()) {
    const pieces = [];
    for (const p of Object.values(ctx.extensionPrompts ?? {})) {
        if (p?.position === 1 && typeof p.value === 'string') pieces.push(substitute(ctx, p.value));
    }
    const oai = ctx.chatCompletionSettings ?? {};
    const on = enabledPromptIds(oai);
    for (const pr of oai.prompts ?? []) {
        if (pr?.injection_position === 1 && on.has(pr.identifier) && typeof pr.content === 'string') pieces.push(substitute(ctx, pr.content));
    }
    return [...new Set(pieces.map((t) => t.trim()).filter((t) => t.length >= 8).map((t) => t.slice(0, 48)))].slice(0, 64);
}

// 审(存疑): 32 位 FNV，用于预设条目指纹 order；与 chat-key.js 的 fnv64 近似重复但输出位数不同，合并会让指纹值变化（升级后首轮误报缓存变化），故未合并。
// FNV-1a: enough to tell "the preset's entries changed" apart, no crypto needed.
function fnv(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
}

// 审: 会在发送时悄悄改写提示词的东西（酒馆助手脚本、按深度生效的提示词正则）；状态页解释缓存变化时点名它们。
/** What could rewrite the prompt on its own at send time: 酒馆助手 scripts that actually run (global ones
 *  while global scripts are on; the preset's / card's only when allowed for that preset / card; a folder's
 *  enabled scripts when the folder is on), and prompt-only regexes that act by depth (preset / card ones
 *  only when allowed) — they rewrite older messages as they age. Named in the cache explanation when the
 *  prompt changed but no setting did (Izumi's 悬浮窗). Unknown shapes are skipped, never thrown on. */
export function promptMutators(ctx = SillyTavern.getContext()) {
    return promptScan(ctx).mut;
}

// 审: 实际扫描脚本/正则，返回 mut（名单）和 rx（深度正则及最小深度）；任何形状异常都跳过不抛错。
/** promptMutators, plus the depth regexes among them as [name, minDepth] (minDepth ≥ 2): the proxy
 *  names the one that cut an old reply short (cache-diag.js depthRegexAt). */
function promptScan(ctx) {
    const out = [];
    const rx = [];
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

    // 审: 酒馆助手脚本：全局/预设/角色卡三处，仅收实际会运行的；插件被禁用则整段跳过。
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

    // 审: 提示词专用且按深度（≥2）生效的正则：预设/角色卡的需被允许才算；会随消息变老改写旧回复。
    safe(() => {
        if (off.includes('regex')) return;
        const deep = (v) => v !== null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 2;
        const lists = [ext.regex];
        if (preset && arr(obj(ext.preset_allowed_regex).openai).includes(preset)) lists.push(obj(oai.extensions).regex_scripts);
        if (avatar && arr(ext.character_allowed_regex).includes(avatar)) lists.push(cardExt.regex_scripts);
        for (const list of lists) {
            for (const r of arr(list)) {
                if (r && typeof r === 'object' && !r.disabled && r.promptOnly && (deep(r.minDepth) || deep(r.maxDepth))) {
                    out.push(`正则「${String(r.scriptName ?? '').slice(0, 24)}」`);
                    if (deep(r.minDepth)) rx.push([String(r.scriptName ?? '').slice(0, 24), Number(r.minDepth)]);
                }
            }
        }
    });
    return { mut: [...new Set(out)].slice(0, 12), rx: rx.slice(0, 12) };
}

// 审: 把 promptScan 的结果整理成指纹里的字段，没有深度正则就不带 rx。
function scanFields(ctx) {
    const { mut, rx } = promptScan(ctx);
    return rx.length ? { mut, rx } : { mut };
}

// 审: 酒馆侧「什么变了」的指纹（预设名、后处理、条目哈希、触发的世界书、脚本/正则），代理拿它解释缓存为何失效。
export function stFingerprint(data, ctx = SillyTavern.getContext()) {
    const oai = ctx.chatCompletionSettings ?? {};
    const prompts = (oai.prompts ?? []).map((p) => [p.identifier, p.content, p.injection_position, p.injection_depth, p.role]);
    return {
        preset: String(oai.preset_settings_openai ?? ''),
        pp: String(data?.custom_prompt_post_processing ?? '') || 'none',
        order: fnv(JSON.stringify([oai.prompt_order ?? [], prompts])),
        wi: activatedLore,
        ...scanFields(ctx),
        // No WORLD_INFO_ACTIVATED (old SillyTavern): wi stays empty whatever fired.
        ...(ctx.eventTypes?.WORLD_INFO_ACTIVATED ? {} : { wiOff: true }),
    };
}

// 审: 读酒馆自己的「推理强度」（从设置读，因为请求里的会被酒馆降级/丢弃）；认不出当 auto。
// SillyTavern's own 「推理强度」 (Reasoning Effort, saved with the preset) decides thinking. Read from the
// settings, not the request: ST downgrades 「Maximum」 to high client-side and drops the field for Claude
// model ids server-side. 'auto' = the model's default; 'min' = no thinking (a model that always thinks
// gets the lowest depth instead).
export function stEffort(cs = SillyTavern.getContext().chatCompletionSettings) {
    const v = String(cs?.reasoning_effort ?? 'auto');
    return ['min', 'low', 'medium', 'high', 'max'].includes(v) ? v : 'auto';
}

// 审: 拼出 custom_include_body 里 claude_subscription 那段 YAML（思考、显示思维、世界书后移、缓存、回复槽位、聊天键）。
export function buildIncludeBodyYaml(settings, quiet = false, slot = null) {
    const lines = ['claude_subscription:'];
    const cs = SillyTavern.getContext().chatCompletionSettings;
    if (quiet) {
        // Background calls (summaries, image tags, variable updates): no thinking (the proxy gives a
        // model that always thinks the lowest depth instead).
        lines.push('  purpose: quiet', '  thinking: off');
    } else {
        const effort = stEffort(cs);
        if (effort === 'min') lines.push('  thinking: off');
        else {
            lines.push('  thinking: adaptive');
            if (effort !== 'auto') lines.push(`  effort: ${effort}`);
        }
    }
    // Follows ST's「显示模型思维」.
    lines.push(`  show_reasoning: ${cs?.show_thoughts !== false}`);
    lines.push(`  lore_tail: ${settings.loreTail !== false}`);
    if (settings.cacheTtl === '5m') lines.push('  cache_ttl: 5m');
    if (slot && !quiet) lines.push(`  reply_slot: ${slot}`);
    // Which chat this is (a hash): the proxy files the usage record under it, so 状态 shows this chat's last turn.
    const chatKey = quiet ? null : chatKeyOf(SillyTavern.getContext());
    if (chatKey) lines.push(`  chat_key: ${chatKey}`);
    return lines.join('\n');
}

// 审: CHAT_COMPLETION_SETTINGS_READY 的处理：仅对发往本代理的请求注入设置并做发前预检，出错只记日志不拦请求。
export function onSettingsReady(data) {
    try {
        const settings = getSettings();
        if (!data) return;
        const { ours } = classifyRequest(data, settings);
        if (!ours) return;

        const existing = typeof data.custom_include_body === 'string' ? data.custom_include_body : '';
        // 审: 去掉请求里已有的 claude_subscription 段（重复触发时避免叠加），保留用户自己的 include body。
        const cleaned = existing
            .replace(/^claude_subscription:[\s\S]*?(?=^\S|\s*$(?![\s\S]))/m, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        // 审: 回复保管发放本次回复的槽位（quiet/impersonate/continue 返回 null）。
        // The reply keeper hands out the reply's slot (null for quiet / impersonate / continue).
        const slot = F.keeper.openSlot(data) ?? null;

        const quiet = data.type === 'quiet';
        let yaml = buildIncludeBodyYaml(settings, quiet, slot);
        // 审: 只有正式聊天请求才带这些诊断字段；后台调用（摘要/生图标签等）不带。
        // JSON is valid YAML: the snippets carry quotes, colons and newlines safely.
        if (!quiet) {
            yaml += `\n  late: ${JSON.stringify(injectedOpenings())}\n  st_fp: ${JSON.stringify(stFingerprint(data))}`;
            yaml += `\n  hist: ${JSON.stringify(historyMarks())}\n  gen_type: ${JSON.stringify(String(data.type ?? 'normal'))}`;
            if (triggeredLore.length) yaml += `\n  lore_text: ${JSON.stringify(triggeredLore)}\n  wi_format: ${JSON.stringify(String(data.wi_format ?? SillyTavern.getContext().chatCompletionSettings?.wi_format ?? ''))}`;
        }
        data.custom_include_body = (cleaned ? cleaned + '\n' : '') + yaml;
        preflightCheck(data);
        postProcessingCheck(data);
    } catch (err) {
        console.error('[claude-max] failed to inject settings', err);
    }
}
