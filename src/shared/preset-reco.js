// ──────────────────────────────────────────────
// Preset recommendations are scoped to the preset that ships them
// ──────────────────────────────────────────────
//
// A preset can carry `extensions.claude_max = { inlineSystem: false, … }`.
// Applying it used to be sticky: switching to a preset WITHOUT
// recommendations kept the previous preset's values (e.g. a cache-tuned
// preset's "hoist depth injections" silently reordered the next preset's
// post-history entries). Now each switch first undoes what the previous
// recommendation changed — unless the user has since changed that setting
// by hand — then applies the new preset's own recommendation.
// Pure function; shared by the panel (index.js) and the tests.

/**
 * @param {object} settings        current panel settings
 * @param {object|null} rec        new preset's extensions.claude_max (or null)
 * @param {object|null} record     what the last recommendation changed: { before: {k: v}, applied: {k: v} }
 * @param {Record<string, {valid: (v:any)=>boolean}>} fields  keys a preset may set
 * @returns {{ next: object, restored: string[], applied: string[], record: object|null }}
 */
export function planPresetReco(settings, rec, record, fields) {
    const next = { ...settings };
    const restored = [];
    for (const [key, value] of Object.entries(record?.before ?? {})) {
        // Only undo what is still the recommended value — a manual change wins.
        if (key in fields && next[key] === record.applied?.[key] && next[key] !== value) {
            next[key] = value;
            restored.push(key);
        }
    }
    const applied = [];
    const newRecord = { before: {}, applied: {} };
    if (rec && typeof rec === 'object') {
        for (const [key, field] of Object.entries(fields)) {
            if (rec[key] === undefined || !field.valid(rec[key]) || next[key] === rec[key]) continue;
            newRecord.before[key] = next[key];
            newRecord.applied[key] = rec[key];
            next[key] = rec[key];
            applied.push(key);
        }
    }
    return {
        next,
        restored: restored.filter((k) => !applied.includes(k)),
        applied,
        record: applied.length ? newRecord : null,
    };
}

/** Which model family a preset NAME was made for: 'gemini' | 'gpt' | 'deepseek' | 'claude', or null when the name does not say. */
export function presetFamily(name) {
    const n = String(name ?? '');
    const hits = [];
    if (/claude|opus|sonnet|haiku|克劳德/i.test(n)) hits.push('claude');
    if (/gemini|\bgmn\b|谷歌|(?:^|[^\d.])\d(?:\.\d)?\s*P(?:ro)?(?![a-z])/i.test(n)) hits.push('gemini');
    if (/gpt|chatgpt|openai|\bo[134]\b/i.test(n)) hits.push('gpt');
    if (/deepseek|\bds\b|\bR1\b/i.test(n)) hits.push('deepseek');
    return hits.length === 1 ? hits[0] : null;
}

export const FAMILY_NAMES = { gemini: 'Gemini', gpt: 'GPT', deepseek: 'DeepSeek' };

/** Count of enabled regex scripts a preset carries (preset.extensions.regex_scripts, entries not `disabled`). */
export function presetRegexCount(preset) {
    const list = preset?.extensions?.regex_scripts;
    return Array.isArray(list) ? list.filter((r) => r && !r.disabled).length : 0;
}

/** Appended to the connect notice when the preset carries enabled regex scripts; '' otherwise. */
export function presetRegexNote(preset) {
    return presetRegexCount(preset) ? '点酒馆的「立即刷新」让正则生效' : '';
}

/** The prompt entries a preset has switched ON (prompt_order's longest list, entries with enabled: true). */
export function presetEnabledPrompts(preset) {
    const orders = Array.isArray(preset?.prompt_order) ? preset.prompt_order : [];
    const order = orders.reduce((best, o) => ((o?.order?.length ?? 0) > (best?.order?.length ?? 0) ? o : best), null)?.order ?? [];
    const on = new Set(order.filter((it) => it?.enabled).map((it) => it.identifier));
    return (Array.isArray(preset?.prompts) ? preset.prompts : []).filter((p) => p && on.has(p.identifier));
}

const ENTRY_WORDS = {
    claude: /claude|opus|sonnet|haiku|克劳德/i,
    gemini: /gemini|谷歌|google/i,
    gpt: /\bgpt|chatgpt|openai/i,
    deepseek: /deepseek|\bR1\b/i,
};

/**
 * Which model family the ENABLED entries of a preset were written for, ignoring its name (a preset can be renamed,
 * and a name can say nothing). 'claude' as soon as any enabled entry mentions Claude; another family only when its
 * word is in an entry's NAME, or in the text of two or more entries, and no other family is. Null when unsure.
 */
export function presetFamilyFromEntries(preset) {
    const prompts = presetEnabledPrompts(preset);
    if (!prompts.length) return null;
    const hits = {};
    for (const [fam, re] of Object.entries(ENTRY_WORDS)) {
        let strong = 0;
        let weak = 0;
        for (const p of prompts) {
            if (re.test(String(p.name ?? ''))) strong++;
            else if (re.test(String(p.content ?? ''))) weak++;
        }
        hits[fam] = { strong, weak };
    }
    if (hits.claude.strong + hits.claude.weak > 0) return 'claude';
    const others = Object.keys(FAMILY_NAMES).filter((f) => hits[f].strong >= 1 || hits[f].weak >= 2);
    return others.length === 1 ? others[0] : null;
}

/**
 * Note for the connect notice when the active preset looks made for another family; '' when unsure or fine.
 * The preset's enabled entries decide when they give a verdict; the name is the fallback (and the only
 * evidence when the preset's data cannot be read).
 */
export function presetMismatchNote(name, preset = null) {
    const fam = presetFamilyFromEntries(preset) ?? presetFamily(name);
    if (!fam || fam === 'claude') return '';
    return `「${name}」是给 ${FAMILY_NAMES[fam]} 的预设`;
}

// Presets CCST has looked at closely, recognised by what they contain (entry / script / regex names,
// marker text), never by the preset's name — those get renamed and re-versioned all the time.
const MARKERS = {
    // 果实 (V6.x): 「果实之心」 scripts, 「MoM必选」 regexes around <meow_FM>, the 💡 theatre entries, 果农.
    guoshi: [
        (p, t) => t.scripts.some((n) => /果实之心/.test(n)),
        (p) => !!p?.extensions?.fruitHeartSections,
        (p, t) => t.regexNames.some((n) => /^MoM必选/.test(n)),
        (p) => (p?.extensions?.regex_scripts ?? []).some((r) => /<meow_FM>/.test(String(r?.findRegex ?? ''))),
        (p, t) => t.entryNames.some((n) => /果农/.test(n)),
        (p, t) => t.entryNames.filter((n) => /^💡/.test(n)).length >= 5,
    ],
    // 灰烬之桥 (Ashen Bridge, Claude v4.x).
    ashen: [
        (p, t) => t.entryNames.some((n) => /🌈思考开始/.test(n)),
        (p, t) => t.entryNames.some((n) => /✨思维链锁/.test(n)),
        (p, t) => t.entryNames.some((n) => /⭐️注解残篇开始|🐕收尾标记/.test(n)),
        (p) => (p?.prompts ?? []).some((x) => String(x?.content ?? '').includes('灰烬里仍有余温')),
        (p, t) => t.regexNames.some((n) => /保留\d+层正文/.test(n)),
    ],
};

function scriptNames(list, out = []) {
    for (const s of Array.isArray(list) ? list : []) {
        if (!s || typeof s !== 'object' || s.enabled === false) continue;
        if (s.type === 'folder') scriptNames(s.scripts, out);
        else if (s.name) out.push(String(s.name));
    }
    return out;
}

/**
 * What a preset does that matters for the cache (pure; preset = SillyTavern's chat-completion preset object):
 * - family: 'guoshi' | 'ashen' | null — three or more of that preset's markers;
 * - prefill: an enabled assistant-role entry after the chat history (the reply is continued from it);
 * - depthRegexes: enabled prompt-only regexes that act from depth 2 on, { name, minDepth } — they cut
 *   older messages as they age, so the history changes there every turn.
 */
export function presetTraits(preset) {
    const orders = Array.isArray(preset?.prompt_order) ? preset.prompt_order : [];
    const order = orders.reduce((best, o) => ((o?.order?.length ?? 0) > (best?.order?.length ?? 0) ? o : best), null)?.order ?? [];
    const byId = new Map((Array.isArray(preset?.prompts) ? preset.prompts : []).filter(Boolean).map((p) => [p.identifier, p]));
    const hist = order.findIndex((it) => it?.identifier === 'chatHistory');
    const prefill = hist >= 0 && order.slice(hist + 1).some((it) => {
        const p = byId.get(it?.identifier);
        return it?.enabled && p?.role === 'assistant' && !p.injection_position && String(p.content ?? '').trim();
    });
    const regexes = (Array.isArray(preset?.extensions?.regex_scripts) ? preset.extensions.regex_scripts : []).filter((r) => r && !r.disabled);
    const depthRegexes = regexes
        .filter((r) => r.promptOnly && Number.isFinite(Number(r.minDepth)) && r.minDepth !== null && r.minDepth !== '' && Number(r.minDepth) >= 2)
        .map((r) => ({ name: String(r.scriptName ?? ''), minDepth: Number(r.minDepth) }));
    const t = {
        scripts: scriptNames(preset?.extensions?.tavern_helper?.scripts),
        regexNames: regexes.map((r) => String(r.scriptName ?? '')),
        entryNames: [...byId.values()].map((p) => String(p.name ?? '')),
    };
    let family = null;
    for (const [name, tests] of Object.entries(MARKERS)) {
        if (tests.filter((f) => { try { return f(preset, t); } catch { return false; } }).length >= 3) family = name;
    }
    return { family, prefill, depthRegexes };
}
