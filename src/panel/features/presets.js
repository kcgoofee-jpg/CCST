// ──────────────────────────────────────────────
// Preset recommendations and per-model entries. A preset can ship `extensions.claude_max`
// ({ loreTail, cacheTtl, byModel }); switching to it applies those values. Thinking and the model
// are the preset's own SillyTavern fields (推理强度, 模型), so they need nothing here.
// ──────────────────────────────────────────────

import { libs } from '../core/libs.js';
import { getSettings, saveSettingsDebounced, defaultSettings } from '../core/settings.js';
import { connectionInfo, shortModel, modelKey } from '../core/connection.js';
import { notify } from '../core/notify.js';
import { rebuildPanel } from '../shell.js';

// 审: 收编 v2.5.0 没留记录的推荐，条件满足时仍会走到，保留。
// Recommendations applied by v2.5.0 left no record, so switching away
// couldn't undo them. If the active preset's recommendation is in effect
// and differs from the defaults, record it once (restore target: default).
export function adoptUnrecordedReco() {
    try {
        const settings = getSettings();
        if (settings.presetRecoRecord) return;
        const rec = SillyTavern.getContext().chatCompletionSettings?.extensions?.claude_max;
        if (!rec || typeof rec !== 'object') return;
        const record = { before: {}, applied: {} };
        for (const key of Object.keys(PRESET_FIELDS)) {
            if (rec[key] !== undefined && settings[key] === rec[key] && rec[key] !== defaultSettings[key]) {
                record.before[key] = defaultSettings[key];
                record.applied[key] = rec[key];
            }
        }
        if (Object.keys(record.applied).length) {
            settings.presetRecoRecord = record;
            saveSettingsDebounced();
        }
    } catch { /* best-effort */ }
}

// ── Preset-recommended settings ──

// 审: 预设可推荐的设置项（条目后移、缓存时长）及校验；其余旧字段忽略。
// A preset can ship `extensions.claude_max = { loreTail, cacheTtl }`; switching to it applies those
// values (and switching away restores them). Fields of older versions (effort, thinking, …) are ignored.
const PRESET_FIELDS = {
    loreTail: { label: '世界书后移', valid: (v) => typeof v === 'boolean' },
    cacheTtl: { label: '缓存时长', valid: (v) => v === '1h' || v === '5m' },
};

// 审: 切预设后的总入口：应用推荐设置 + 按模型的条目开关。
export function applyPresetRecommendation() {
    applyPresetRecoCore();
    applyModelProfile();
}

// 审: 按当前模型开关预设里指定的条目（如 4.6 开思维链条目、5.5 关）；换模型/切预设/启动时调用，有改动才提示。
// A preset can switch its own entries per model: extensions.claude_max.byModel =
//   { "claude-opus-4-6": { prompts: { "<entry id>": true } }, "claude-opus-5-5": { prompts: { "<entry id>": false } } }
// Applied on every model change and preset switch — e.g. on Opus 4.6 turn on an entry that writes
// the chain of thought into the reply; on Opus 5.5 (which refuses requests to write reasoning into
// the reply) turn it off again.
export async function applyModelProfile() {
    const ctx = SillyTavern.getContext();
    const byModel = ctx.chatCompletionSettings?.extensions?.claude_max?.byModel;
    const { connected, model } = connectionInfo();
    if (!byModel || typeof byModel !== 'object' || !model || !connected) return;
    const prof = byModel[modelKey(model)];
    if (!prof || typeof prof !== 'object') return;
    const done = [];
    if (prof.prompts && typeof prof.prompts === 'object') {
        const pm = (await import('/scripts/openai.js').catch(() => null))?.promptManager;
        if (pm?.activeCharacter) {
            let changed = false;
            for (const [id, on] of Object.entries(prof.prompts)) {
                const entry = pm.getPromptOrderEntry(pm.activeCharacter, id);
                if (!entry || entry.enabled === !!on) continue;
                entry.enabled = !!on;
                changed = true;
                done.push(`${on ? '开' : '关'}「${pm.getPromptById(id)?.name ?? id}」`);
            }
            if (changed) { pm.render(); pm.saveServiceSettings(); }
        }
    }
    if (done.length) notify('info', '按模型调', `${shortModel(model)}：${done.join('；')}`, { ms: 5000 });
}

// 审: 应用或还原预设带的推荐设置（切走时还原到之前的值），改了就重建面板并提示。
function applyPresetRecoCore() {
    const ctx = SillyTavern.getContext();
    const rec = ctx.chatCompletionSettings?.extensions?.claude_max;
    if (!libs.presetReco) return;
    const settings = getSettings();
    const { next, restored, applied, record } = libs.presetReco.planPresetReco(settings, rec, settings.presetRecoRecord ?? null, PRESET_FIELDS);
    settings.presetRecoRecord = record;
    if (!restored.length && !applied.length) return;
    Object.assign(settings, next, { presetRecoRecord: record });
    saveSettingsDebounced();
    rebuildPanel();
    const preset = ctx.chatCompletionSettings?.preset_settings_openai ?? '当前预设';
    const parts = [];
    if (applied.length) parts.push(`已调好 ${applied.map((k) => PRESET_FIELDS[k].label).join('、')}`);
    if (restored.length) parts.push(`已还原 ${restored.map((k) => PRESET_FIELDS[k].label).join('、')}`);
    notify('info', '按预设调', `「${preset}」：${parts.join('；')}`, { ms: 8000 });
}
