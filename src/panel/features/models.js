// ──────────────────────────────────────────────
// Model picks: the quick model switch on the proxy connection (shared/sources.js knows the model names).
// ──────────────────────────────────────────────

import { libs } from '../core/libs.js';
import { connectionInfo, shortModel, modelKey, modelBase } from '../core/connection.js';
import { cards } from '../core/dom.js';
import { extraModelId } from '../core/capabilities.js';
import { notify } from '../core/notify.js';
import { F } from '../core/registry.js';
import { renderGlance, rebuildPanel } from '../shell.js';

// Quick model switch for the two models people actually alternate between. It writes
// SillyTavern's own custom model field (the same path as its model dropdown), so it lasts
// until the next preset switch — presets store their own model.
// `tag`: at most a few characters next to the name; `hint`: the tooltip.
export const MODEL_PICKS = [
    { value: 'claude-opus-5-5', label: 'Opus 5.5', tag: '最稳', hint: '最细腻，长篇最稳；总会思考，偏慢' },
    { value: 'claude-opus-4-6', label: 'Opus 4.6', tag: '可关思考', hint: '思考可关，过程完整可见' },
    { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5', tag: '快', hint: '通常更快更省，原生 1M 上下文；总会思考' },
];

/** Switch SillyTavern's model on the proxy connection (its custom model field). `id` is canonical
 *  (claude-opus-4-6), optionally with [1m]. */
export function setModel(id) {
    const ctx = SillyTavern.getContext();
    const input = globalThis.jQuery?.('#custom_model_id');
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

/** The Claude model that needs its own card ('' when none: a non-Claude leftover never gets one). */
function currentExtra(model) {
    return extraModelId(model, MODEL_PICKS, (id) => libs.sources?.canonicalModel(id) ?? (/^claude-/i.test(String(id ?? '')) ? modelBase(id).toLowerCase() : null));
}

export function modelRow() {
    const { connected, model } = connectionInfo();
    if (!connected) return null;
    const extra = currentExtra(model);
    const options = [...MODEL_PICKS];
    if (extra) options.push({ value: extra, label: shortModel(extra), hint: '当前模型，在「API 连接」里选的' });
    const current = extra || (MODEL_PICKS.some((o) => o.value === modelKey(model)) ? modelKey(model) : null);
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
            notify('info', `已切到 ${shortModel(id)}`, `这次聊天用 ${shortModel(id)}；切换到自带模型设置的预设时会改回预设的模型。`, { ms: 6000 });
        },
    });
    row.id = 'claude_max_model';
    row.dataset.extra = extra;
    row.setAttribute('aria-label', '模型');
    return row;
}

// A preset may name its model in extensions.claude_max.model. SillyTavern only switches the
// model with the preset when "bind preset to connection" is on, and that would also overwrite
// the endpoint saved in the preset (a phone would lose its LAN address) — so the model alone
// is applied here. Presets without one keep whatever model is selected.
export function applyPresetModel(model) {
    if (typeof model !== 'string' || !/^claude-[\w.-]+$/i.test(model)) return;
    const { connected, model: cur } = connectionInfo();
    if (!connected || modelKey(cur) === modelKey(model)) return;
    const id = modelBase(model) + (/\[1m\]$/i.test(cur ?? '') ? '[1m]' : '');
    if (!setModel(id)) return;
    renderGlance();
    notify('info', `这个预设用 ${shortModel(id)}`, '预设自带模型设置，已自动选上。想换的话在「聊天」页点另一个模型。', { ms: 5000 });
}

/** The model row exists only while ST is on the proxy: rebuild when that flips. */
export function modelRowFollowsSource() {
    const { connected } = connectionInfo();
    const has = !!document.getElementById('claude_max_model');
    if (has !== connected && document.querySelector('.inline-drawer.claude-max')) rebuildPanel();
    else syncModelControl();
}

export function syncModelControl() {
    const { model } = connectionInfo();
    const row = document.getElementById('claude_max_model');
    if (!row) return;
    // The card list was built for another model (an extra card appeared or went away): rebuild it.
    if ((row.dataset.extra ?? '') !== currentExtra(model) && document.querySelector('.inline-drawer.claude-max')) { rebuildPanel(); return; }
    row.select?.(modelKey(model));
}
