// ──────────────────────────────────────────────
// Tab 推理: the model row, how hard to think (or not at all), and「仅下一轮」.
// Everything else about thinking follows the preset or SillyTavern.
// ──────────────────────────────────────────────

import { store } from '../core/store.js';
import { getSettings, EFFORT_LABEL, EFFORT_OPTIONS, VALID_EFFORTS } from '../core/settings.js';
import { connectionInfo, modelKey } from '../core/connection.js';
import { el, note, segmented, group } from '../core/dom.js';
import { F } from '../core/registry.js';
import { renderGlance } from '../shell.js';

export function init() {
    // The one-shot effort changes from the button, or is cleared when a reply arrives.
    store.subscribe('nextEffort', () => document.getElementById('claude_max_oneshot')?.refresh?.());
    // Every finished stats read (ok or not) is a moment to look at the latest reply for a written-out chain of thought.
    store.subscribe('stats', ({ stats }) => { if (stats.phase === 'ok' || stats.phase === 'error') checkInlineCot(); });
}

/** 「仅下一轮」: a quiet one-off boost. Only the next reply; spent when it arrives. */
function oneShotEffortRow(settings) {
    const wrap = el('div', 'cm-oneshot');
    wrap.id = 'claude_max_oneshot';
    const row = el('div', 'cm-oneshot-row');
    const text = el('div', 'cm-oneshot-text');
    text.append(el('span', 'cm-oneshot-title', '仅下一轮加深'));
    const status = el('small', 'cm-hint');
    text.append(status);
    const group = el('div', 'cm-mini-seg');
    row.append(text, group);
    const render = () => {
        const { nextEffort } = store.get();
        group.querySelectorAll('button').forEach((b) => {
            const on = b.dataset.effort === (nextEffort ?? '');
            b.classList.toggle('active', on);
            b.setAttribute('aria-pressed', String(on));
        });
        status.textContent = nextEffort
            ? `下一条用「${EFFORT_LABEL[nextEffort]}」，之后恢复「${EFFORT_LABEL[settings.effort]}」。再点一次取消。`
            : '关键剧情用。高约慢 1/3，超高约慢 3 倍，这一轮缓存要重写一次。';
    };
    for (const [value, label] of [['high', '高'], ['xhigh', '超高']]) {
        const b = el('button', 'cm-mini-btn', label);
        b.type = 'button';
        b.dataset.effort = value;
        b.addEventListener('click', () => { store.set({ nextEffort: store.get().nextEffort === value ? null : value }); render(); });
        group.append(b);
    }
    wrap.append(row);
    wrap.refresh = render;
    render();
    return wrap;
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
        el('small', 'cm-hint',
            `回复里有 <${tag}> 块，原生思考框因此是空的，还占输出长度。` +
            `收进折叠框：酒馆「用户设置 → 推理 → 自动解析」，前缀 <${tag}>、后缀 </${tag}>。` +
            '改用原生思考：关掉预设里的思维链条目（需要时在「设置 → 思考」选「始终思考」）。'),
    );
}

/** The two thinking controls (推理 page, 设置) show the same settings. */
export function syncThinkingControls() {
    const s = getSettings();
    document.getElementById('claude_max_depth')?.select?.(s.thinking === 'off' ? 'off' : s.effort);
    document.getElementById('claude_max_thinking')?.select?.(s.thinking);
}

export function buildReasonTab(pane, settings, save) {
    const model = F.models.modelRow();
    if (model) {
        const g = group('模型', '这次聊天用哪个 Claude；换预设时会跟着预设走。');
        g.body.append(model);
        pane.append(g.root);
    }
    const think = group('思考', '想多久再回答：越深越连贯，也越慢、越耗额度。');
    if (connectionInfo().direct) {
        const n = note('info');
        n.append(el('small', 'cm-hint', '直连 Claude 时这里不生效，请用酒馆「AI 回复配置」的「推理强度」。'));
        think.body.append(n);
    }
    const depth = segmented({
        label: '思考深度',
        options: [...EFFORT_OPTIONS, { value: 'off', label: '不思考', hint: '回得最快。Fable、Opus 4.7 及以上总会思考，对它们无效。' }],
        current: settings.thinking === 'off' ? 'off' : settings.effort,
        onChange: (v) => {
            if (v === 'off') settings.thinking = 'off';
            else {
                settings.effort = VALID_EFFORTS.includes(v) ? v : 'auto';
                if (settings.thinking === 'off') settings.thinking = 'adaptive';
            }
            save();
            renderGlance();
            syncThinkingControls();
        },
    });
    depth.id = 'claude_max_depth';
    think.body.append(depth, oneShotEffortRow(settings));
    const cotTip = note('warn');
    cotTip.id = 'claude_max_cot_tip';
    cotTip.hidden = true;
    think.body.append(cotTip);
    pane.append(think.root);
}
