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
    return presetRegexCount(preset) ? '预设带正则脚本：先点酒馆提示里的『点击此处立即刷新』，正则才生效。' : '';
}

/** Note for the connect notice when the active preset looks made for another family; '' when unsure or fine. */
export function presetMismatchNote(name) {
    const fam = presetFamily(name);
    if (!fam || fam === 'claude') return '';
    return `当前预设『${name}』看起来是给 ${FAMILY_NAMES[fam]} 用的，Claude 可能表现不好；可以在『AI 回复配置』换成给 Claude 的预设。`;
}
