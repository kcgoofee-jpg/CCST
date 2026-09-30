// ──────────────────────────────────────────────
// Model picks & source handling: the quick model switch, each source's own model spelling, and filling
// the Claude source's model list (shared/sources.js knows the sources).
// ──────────────────────────────────────────────

import { libs } from '../core/libs.js';
import { getSettings } from '../core/settings.js';
import { proxyBase, timeoutSignal } from '../core/proxy.js';
import { connectionInfo, shortModel, modelKey, modelBase } from '../core/connection.js';
import { cards } from '../core/dom.js';
import { notify } from '../core/notify.js';
import { F } from '../core/registry.js';
import { renderGlance, rebuildPanel } from '../shell.js';

// Quick model switch for the two models people actually alternate between. It writes
// SillyTavern's own custom model field (the same path as its model dropdown), so it lasts
// until the next preset switch — presets store their own model.
export const MODEL_PICKS = [
    { value: 'claude-opus-5-5', label: 'Opus 5.5', hint: '最细腻，长篇最稳；总会思考，偏慢。' },
    { value: 'claude-opus-4-6', label: 'Opus 4.6', hint: '思考可关，过程完整可见；老牌稳定。' },
    { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: '更快更省，原生 1M 上下文；总会思考。' },
];

/** Add an option the dropdown lacks (ST's static Claude list lags new models). */
function addMissingOption(sel, id, label = id) {
    if (sel.find('option').filter((_, o) => o.value === id).length) return false;
    sel.append(new Option(label, id));
    return true;
}

/** Switch SillyTavern's model on whatever source it is on. `id` is canonical (claude-opus-4-6),
 *  optionally with [1m]; each source gets its own spelling. False when the source has no such model. */
export function setModel(id) {
    const ctx = SillyTavern.getContext();
    const $ = globalThis.jQuery;
    const { kind } = connectionInfo();
    const meta = kind === 'ours' ? null : libs.sources?.CLAUDE_SOURCES[kind] ?? (kind === 'claude' ? { select: '#model_claude_select', modelKey: 'claude_model' } : null);
    if (meta?.select) {
        const sel = $?.(meta.select);
        if (sel?.length) {
            const ids = sel.find('option').map((_, o) => o.value).get().filter(Boolean);
            // Claude source: [1m] rides along as before; elsewhere ids are the source's own.
            const target = kind === 'claude' ? id : (libs.sources?.sourceModelId(kind, id, ids) ?? null);
            if (!target) return false;
            // The Claude source's dropdown can lag behind new models (1.19 has no Opus 5.5):
            // add the option so the dropdown and the setting agree, then pick it.
            if (kind === 'claude') addMissingOption(sel, target);
            else if (!ids.includes(target)) return false;
            sel.val(target).trigger('change');
        } else if (ctx.chatCompletionSettings) {
            const target = kind === 'claude' ? id : libs.sources?.sourceModelId(kind, id, []);
            if (!target) return false;
            ctx.chatCompletionSettings[meta.modelKey] = target;
            ctx.saveSettingsDebounced?.();
        }
        return true;
    }
    const input = $?.('#custom_model_id');
    if (input?.length) input.val(id).trigger('input');
    else if (ctx.chatCompletionSettings) {
        ctx.chatCompletionSettings.custom_model = id;
        ctx.saveSettingsDebounced?.();
    }
    // The Custom source's model field doesn't raise CHATCOMPLETION_MODEL_CHANGED: apply the
    // preset's per-model profile here too.
    setTimeout(() => F.presets.applyModelProfile(), 150);
    return true;
}

// #7: ST's Claude source has a fixed dropdown and never asks Anthropic for its model list
// (that needs the key, which stays on ST's server). Fill it from this proxy's list when it is
// reachable, else from the few ids the panel knows are missing. Sources with a live list
// (OpenRouter and the aggregators) are filled by ST itself.
export async function fillMissingClaudeModels() {
    const sel = globalThis.jQuery?.('#model_claude_select');
    if (!libs.sources || !sel?.length) return;
    const ids = new Set(libs.sources.KNOWN_CLAUDE_MODELS);
    try {
        const settings = getSettings();
        const res = await fetch(`${proxyBase(settings)}/v1/models`, {
            signal: timeoutSignal(1500), headers: settings.accessKey ? { 'X-Claude-Max-Key': settings.accessKey } : {},
        });
        const data = res.ok ? await res.json() : null;
        for (const m of data?.data ?? []) if (/^claude-[\w-]+$/.test(m?.id ?? '')) ids.add(m.id);
    } catch { /* proxy not running: the known ids only */ }
    const added = [...ids].filter((id) => addMissingOption(sel, id));
    if (added.length) {
        const cur = SillyTavern.getContext().chatCompletionSettings?.claude_model;
        if (added.includes(cur)) sel.val(cur); // a saved model the dropdown didn't have
        console.log(`[claude-max] added to the Claude model list: ${added.join(', ')}`);
    }
}

export function modelRow() {
    const { connected, direct, model } = connectionInfo();
    if (!connected && !direct) return null;
    const current = modelKey(model);
    const options = [...MODEL_PICKS];
    if (current && !options.some((o) => o.value === current)) {
        options.push({ value: current, label: shortModel(current), hint: '当前模型，在「API 连接」里选的。' });
    }
    const row = cards({
        label: '',
        options,
        current,
        onChange: (v) => {
            const cur = connectionInfo().model ?? '';
            const id = v + (/\[1m\]$/i.test(cur) ? '[1m]' : '');
            if (id === cur || v === modelKey(cur)) return;
            if (!setModel(id)) {
                syncModelControl();
                notify('warn', `${connectionInfo().where ?? '这个来源'}没有 ${shortModel(v)}`, '在「API 连接」里刷新模型列表，或换个来源。', { ms: 8000 });
                return;
            }
            renderGlance();
            notify('info', `已切到 ${shortModel(id)}`, '到下次切换预设为止。', { ms: 6000 });
        },
    });
    row.id = 'claude_max_model';
    row.setAttribute('aria-label', '模型');
    return row;
}

// A preset may name its model in extensions.claude_max.model. SillyTavern only switches the
// model with the preset when "bind preset to connection" is on, and that would also overwrite
// the endpoint saved in the preset (a phone would lose its LAN address) — so the model alone
// is applied here. Presets without one keep whatever model is selected.
export function applyPresetModel(model) {
    if (typeof model !== 'string' || !/^claude-[\w.-]+$/i.test(model)) return;
    const { connected, direct, model: cur } = connectionInfo();
    if ((!connected && !direct) || modelKey(cur) === modelKey(model)) return;
    const id = modelBase(model) + (/\[1m\]$/i.test(cur ?? '') ? '[1m]' : '');
    if (!setModel(id)) return;
    renderGlance();
    notify('info', `预设用 ${shortModel(id)}`, '临时换：在「推理」页点另一个。', { ms: 5000 });
}

/** The model row exists only while ST is on a Claude source: rebuild when that flips. */
export function modelRowFollowsSource() {
    const { connected, direct } = connectionInfo();
    const has = !!document.getElementById('claude_max_model');
    if (has !== (connected || direct) && document.querySelector('.inline-drawer.claude-max')) rebuildPanel();
    else syncModelControl();
}

export function syncModelControl() {
    const { model } = connectionInfo();
    document.getElementById('claude_max_model')?.select?.(modelKey(model));
}
