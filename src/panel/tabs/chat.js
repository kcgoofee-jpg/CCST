// ──────────────────────────────────────────────
// Tab 聊天: the model, one thinking control (不思考 / 自动 / 低 … 最大), and「仅下一轮加深」.
// Everything else about thinking follows the preset or SillyTavern (始终思考 is in 设置 → 高级).
// ──────────────────────────────────────────────

import { store } from '../core/store.js';
import { getSettings, EFFORT_OPTIONS, NO_THINKING_OPTION, VALID_EFFORTS } from '../core/settings.js';
import { connectionInfo, modelKey } from '../core/connection.js';
import { el, note, segmented, group } from '../core/dom.js';
import { F } from '../core/registry.js';
import { libs } from '../core/libs.js';
import { renderGlance } from '../shell.js';

export function init() {
    // The one-shot effort changes from the button, or is cleared when a reply arrives.
    store.subscribe('nextEffort', () => document.getElementById('claude_max_oneshot')?.refresh?.());
    // Every finished stats read (ok or not) is a moment to look at the latest reply for a written-out chain of thought.
    store.subscribe('stats', ({ stats }) => { if (stats.phase === 'ok' || stats.phase === 'error') checkInlineCot(); });
}

/** 「仅下一轮加深」: a quiet one-off boost. Only the next reply; spent when it arrives. */
function oneShotEffortRow() {
    const row = el('div', 'cm-oneshot-row cm-oneshot');
    row.id = 'claude_max_oneshot';
    row.title = '只管下一条回复，之后恢复；再点一次取消';
    row.append(el('span', 'cm-oneshot-title', '仅下一轮加深'));
    const btns = el('div', 'cm-mini-seg');
    row.append(btns);
    const render = () => {
        const { nextEffort } = store.get();
        btns.querySelectorAll('button').forEach((b) => {
            const on = b.dataset.effort === (nextEffort ?? '');
            b.classList.toggle('active', on);
            b.setAttribute('aria-pressed', String(on));
        });
    };
    for (const [value, label] of [['high', '高'], ['xhigh', '超高']]) {
        const b = el('button', 'cm-mini-btn', label);
        b.type = 'button';
        b.dataset.effort = value;
        b.addEventListener('click', () => { store.set({ nextEffort: store.get().nextEffort === value ? null : value }); render(); });
        btns.append(b);
    }
    row.refresh = render;
    render();
    return row;
}

/** The reply arrived: the one-shot effort is spent. */
export function clearOneShotEffort() {
    if (!store.get().nextEffort) return;
    store.set({ nextEffort: null });
}

// Presets that make the model write its chain of thought INTO the reply
// (<thinking>…</thinking>) leave the native reasoning box empty, and ST's
// auto-parse only catches it when its prefix/suffix match those tags.
function checkInlineCot() {
    const tip = document.getElementById('claude_max_cot_tip');
    if (!tip) return;
    const chat = SillyTavern.getContext().chat ?? [];
    const last = [...chat].reverse().find((m) => !m.is_user && !m.is_system);
    const match = last?.mes?.match(/<(thinking|think|cot|analysis)\b[^>]*>/i);
    // The preset tunes itself for this model (byModel): a written-out chain of thought is on purpose.
    const byModel = SillyTavern.getContext().chatCompletionSettings?.extensions?.claude_max?.byModel;
    const planned = !!byModel?.[modelKey(connectionInfo().model)];
    if (!match || last.extra?.reasoning || planned) {
        tip.hidden = true;
        return;
    }
    const tag = match[1];
    tip.hidden = false;
    tip.replaceChildren(
        el('div', 'cm-note-title', '预设把思维链写进了正文'),
        el('small', 'cm-hint', `收进折叠框：酒馆「用户设置 → 推理 → 自动解析」，前缀 <${tag}>、后缀 </${tag}>。`),
    );
}

/** The thinking control (聊天) and 始终思考 (设置 → 高级) show the same settings. */
export function syncThinkingControls() {
    const s = getSettings();
    document.getElementById('claude_max_depth')?.select?.(s.thinking === 'off' ? 'off' : s.effort);
    const always = document.getElementById('claudeMaxAlwaysThink');
    if (always) always.checked = s.thinking === 'on';
    syncAlwaysThinks();
}

export const ALWAYS_THINKS = '这个模型总会思考';

/** On a model that always thinks, 「不思考」 stays visible but greyed out, with the reason. */
export function syncAlwaysThinks() {
    const { model } = connectionInfo();
    const reason = model && libs.sources?.isAdaptiveOnly(model) ? ALWAYS_THINKS : '';
    document.getElementById('claude_max_depth')?.setDisabled?.('off', reason);
    // The saved 「不思考」 does not apply on this model: show what actually happens (the depth).
    const s = getSettings();
    if (reason && s.thinking === 'off') document.getElementById('claude_max_depth')?.select?.(s.effort);
}

export function buildChatTab(pane, settings, save) {
    const model = F.models.modelRow();
    if (model) {
        const g = group('模型');
        g.body.append(model);
        pane.append(g.root);
    }
    const think = group('思考');
    const depth = segmented({
        label: '思考', hideLabel: true,
        options: [NO_THINKING_OPTION, ...EFFORT_OPTIONS],
        current: settings.thinking === 'off' ? 'off' : settings.effort,
        onChange: (v) => {
            if (v === 'off') settings.thinking = 'off';
            else {
                settings.effort = VALID_EFFORTS.includes(v) ? v : 'auto';
                // A depth means thinking: 自适应 (or 始终思考, kept when it was on).
                if (settings.thinking === 'off') settings.thinking = 'adaptive';
            }
            save();
            renderGlance();
            syncThinkingControls();
        },
    });
    depth.id = 'claude_max_depth';
    queueMicrotask(syncAlwaysThinks); // the tab is not in the document yet
    think.body.append(depth, oneShotEffortRow());
    const cotTip = note('warn');
    cotTip.id = 'claude_max_cot_tip';
    cotTip.hidden = true;
    think.body.append(cotTip);
    pane.append(think.root);
}
