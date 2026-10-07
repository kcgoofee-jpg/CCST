// ──────────────────────────────────────────────
// Preset recommendations and per-model profiles. A preset can ship `extensions.claude_max`
// (effort, thinking, model, byModel …); switching to it applies those values so preset and panel stay in sync.
// ──────────────────────────────────────────────

import { libs } from '../core/libs.js';
import { getSettings, saveSettingsDebounced, defaultSettings, VALID_EFFORTS, VALID_THINKING, THINKING_OPTIONS } from '../core/settings.js';
import { connectionInfo, shortModel, modelKey } from '../core/connection.js';
import { notify } from '../core/notify.js';
import { F } from '../core/registry.js';
import { rebuildPanel } from '../shell.js';
import { syncThinkingControls } from '../tabs/reason.js';

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

// A preset can ship `extensions.claude_max = { effort, thinking, ... }`;
// switching to it applies those values so preset and panel stay in sync.
const PRESET_FIELDS = {
    effort: { label: '思考深度', valid: (v) => VALID_EFFORTS.includes(v) },
    thinking: { label: '思考模式', valid: (v) => VALID_THINKING.includes(v) },
    showReasoning: { label: '显示思考过程', valid: (v) => typeof v === 'boolean' },
    useResume: { label: '会话续接', valid: (v) => typeof v === 'boolean' },
    inlineSystem: { label: '深度注入保持原位', valid: (v) => typeof v === 'boolean' },
    loreTail: { label: '世界书变化部分移到末尾', valid: (v) => typeof v === 'boolean' },
    foldTail: { label: '发言后的注入并进发言', valid: (v) => typeof v === 'boolean' },
    identityMode: { label: '身份模式', valid: (v) => typeof v === 'boolean' },
};

export function applyPresetRecommendation() {
    applyPresetRecoCore();
    applyModelProfile(); // last: the model profile wins over the preset-wide thinking setting
}

// A preset can tune itself per model: extensions.claude_max.byModel =
//   { "claude-opus-4-6": { thinking: "off", prompts: { "<entry id>": true } }, "claude-opus-5-5": { … } }
// Applied on every model change and preset switch — e.g. on Opus 4.6 turn on an entry that writes
// the chain of thought into the reply and turn native thinking off; on Opus 5.5 (which refuses
// requests to write reasoning into the reply) turn that entry off again.
export async function applyModelProfile() {
    const ctx = SillyTavern.getContext();
    const byModel = ctx.chatCompletionSettings?.extensions?.claude_max?.byModel;
    const { connected, model } = connectionInfo();
    if (!byModel || typeof byModel !== 'object' || !model || !connected) return;
    const prof = byModel[modelKey(model)];
    if (!prof || typeof prof !== 'object') return;
    const done = [];
    const settings = getSettings();
    if (connected && VALID_THINKING.includes(prof.thinking) && settings.thinking !== prof.thinking) {
        settings.thinking = prof.thinking;
        saveSettingsDebounced();
        syncThinkingControls();
        done.push(`思考模式「${THINKING_OPTIONS.find((o) => o.value === prof.thinking)?.label ?? prof.thinking}」`);
    }
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
    if (done.length) notify('info', `按 ${shortModel(model)} 调整预设`, done.join('；'), { ms: 5000 });
}

function applyPresetRecoCore() {
    const ctx = SillyTavern.getContext();
    const rec = ctx.chatCompletionSettings?.extensions?.claude_max;
    F.models.applyPresetModel(rec?.model);
    F.models.syncModelControl();
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
    if (applied.length) parts.push(`按预设「${preset}」的推荐调整：${applied.map((k) => PRESET_FIELDS[k].label).join('、')}`);
    if (restored.length) parts.push(`恢复上一个预设改动过的：${restored.map((k) => PRESET_FIELDS[k].label).join('、')}`);
    notify('info', `预设「${preset}」`, `${parts.join('；')}。`, { ms: 8000 });
}
