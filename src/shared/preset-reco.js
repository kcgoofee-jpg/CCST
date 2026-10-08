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

// 审: 切换预设时先撤销上个预设的推荐值（用户手改过的不动），再应用新预设的推荐；面板 presets 用。
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

// 审: 按预设名字猜它是给哪个模型家族写的；presetMismatchNote 的后备依据，测试也用。
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

// 审: 非 Claude 家族的显示名；提示文案和 presetFamilyFromEntries 的候选集都靠它，仅本文件内用。
const FAMILY_NAMES = { gemini: 'Gemini', gpt: 'GPT', deepseek: 'DeepSeek' };

// 审: 预设带的已启用正则脚本数；presetRegexNote 用，测试也用。
/** Count of enabled regex scripts a preset carries (preset.extensions.regex_scripts, entries not `disabled`). */
export function presetRegexCount(preset) {
    const list = preset?.extensions?.regex_scripts;
    return Array.isArray(list) ? list.filter((r) => r && !r.disabled).length : 0;
}

// 审: 预设带正则时给连接提示追加「点立即刷新」；面板 shell 用。
/** Appended to the connect notice when the preset carries enabled regex scripts; '' otherwise. */
export function presetRegexNote(preset) {
    return presetRegexCount(preset) ? '点酒馆的「立即刷新」让正则生效' : '';
}

// 审: 取预设里实际开启的提示词条目；presetFamilyFromEntries 用，测试也用。
/** The prompt entries a preset has switched ON (prompt_order's longest list, entries with enabled: true). */
export function presetEnabledPrompts(preset) {
    const orders = Array.isArray(preset?.prompt_order) ? preset.prompt_order : [];
    const order = orders.reduce((best, o) => ((o?.order?.length ?? 0) > (best?.order?.length ?? 0) ? o : best), null)?.order ?? [];
    const on = new Set(order.filter((it) => it?.enabled).map((it) => it.identifier));
    return (Array.isArray(preset?.prompts) ? preset.prompts : []).filter((p) => p && on.has(p.identifier));
}

// 审: 各家族在条目名/正文里的特征词；presetFamilyFromEntries 的识别规则。
const ENTRY_WORDS = {
    claude: /claude|opus|sonnet|haiku|克劳德/i,
    gemini: /gemini|谷歌|google/i,
    gpt: /\bgpt|chatgpt|openai/i,
    deepseek: /deepseek|\bR1\b/i,
};

// 审: 按已启用条目判断预设是给哪个家族写的（不看名字）；presetMismatchNote 优先用它。
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

// 审: 预设像是给其他家族写的就返回一句提示，否则空串；面板 shell 用。
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
