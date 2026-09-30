// ──────────────────────────────────────────────
// The first-run guide card (选来源 → 连接 → 完成), drawn above the connect card. The state logic and
// the wording are in core/guide.js (pure). For the proxy, step 2 is the ordinary connect card below
// this one; for the direct sources this card says where in SillyTavern's API panel the key goes
// (CCST never touches keys) and detection is the ordinary connectionInfo().
// ──────────────────────────────────────────────

import { store } from './core/store.js';
import { getSettings, saveSettingsDebounced } from './core/settings.js';
import { libs } from './core/libs.js';
import { connectionInfo, shortModel } from './core/connection.js';
import { el, note, button, cards } from './core/dom.js';
import { refreshAll } from './core/live.js';
import { directCacheCard } from './tabs/status.js';
import {
    SOURCES, STEP_TITLES, KEY_STEPS, SUMMARY, chosenSource, guideStep, shouldAutoOnboard, showsCacheCard, gateConnection, proxyUnknown,
    startGuide, pickSource, backToChoose, finishGuide,
} from './core/guide.js';

/** Re-draw everything that follows the connection (the shell listens to `pulse`). */
const redraw = () => store.set({ pulse: store.get().pulse + 1 });

function apply(patch) {
    Object.assign(getSettings(), patch);
    saveSettingsDebounced();
    redraw();
}

/** 其他 → 重新引导. */
export function restartGuide() {
    apply(startGuide());
    document.getElementById('claude_max_guide')?.scrollIntoView?.({ block: 'nearest' });
}

export function buildGuideCard() {
    const card = note('info');
    card.id = 'claude_max_guide';
    card.classList.add('cm-guide');
    card.hidden = true;
    drawn = '';
    return card;
}

function stepper(step) {
    const row = el('ol', 'cm-guide-steps');
    for (const n of [1, 2, 3]) {
        const li = el('li', null, STEP_TITLES[n]);
        if (n === step) li.className = 'active';
        else if (n < step) li.className = 'done';
        row.append(li);
    }
    return row;
}

const list = (cls, items) => {
    const ul = el('ul', `cm-guide-list ${cls}`);
    for (const t of items) ul.append(el('li', null, t));
    return ul;
};

function skipLink() {
    const b = el('button', 'cm-link-btn', '跳过引导');
    b.type = 'button';
    b.addEventListener('click', () => apply(finishGuide()));
    return b;
}

function backLink() {
    const b = el('button', 'cm-link-btn', '换个来源');
    b.type = 'button';
    b.addEventListener('click', () => apply(backToChoose()));
    return b;
}

function drawStep1(card) {
    card.append(
        el('div', 'cm-note-title', '欢迎用 CCST，你的 Claude 从哪来？'),
        el('small', 'cm-hint', '选一个，后面只给你看对应的步骤。之后随时能在「其他」里重新引导。'),
        cards({
            label: '', current: null, wrap: true,
            options: SOURCES.map((s) => ({ value: s.id, label: s.label, hint: s.who })),
            onChange: (id) => apply(pickSource(id)),
        }),
    );
    const row = el('div', 'cm-btn-row');
    row.append(skipLink());
    card.append(row);
}

function drawStep2(card, choice) {
    const label = SOURCES.find((s) => s.id === choice).label;
    if (choice === 'proxy') {
        card.append(
            el('div', 'cm-note-title', '连接本机代理'),
            el('small', 'cm-hint', '按下面这张卡片一步步来（启动代理 → 登录 → 一键连接），连上后自动进入下一步。'),
        );
        const row = el('div', 'cm-btn-row');
        row.append(backLink(), skipLink());
        card.append(row);
        return;
    }
    card.append(el('div', 'cm-note-title', `连接 ${label}`));
    const steps = el('ol', 'cm-notes');
    for (const t of KEY_STEPS[choice]) steps.append(el('li', null, t));
    card.append(
        steps,
        el('small', 'cm-hint', '密钥只填在酒馆自己的框里，CCST 不经手也不保存。选好 Claude 模型后这里会自动往下走。'),
    );
    const row = el('div', 'cm-btn-row');
    row.append(button('我填好了，重新检测', refreshAll, { icon: 'fa-rotate', primary: true }), backLink(), skipLink());
    card.append(row);
}

function drawStep3(card, choice) {
    const { model, where } = connectionInfo();
    const sum = SUMMARY[choice];
    card.append(
        el('div', 'cm-note-title', model ? `已连接 · ${where} · ${shortModel(model)}` : `已连接 · ${where}`),
        el('small', 'cm-hint', '这个来源下 CCST 能做的：'),
        list('cm-guide-ok', sum.works),
        el('small', 'cm-hint', '做不了或要注意的：'),
        list('cm-guide-gap', sum.gaps),
    );
    if (showsCacheCard(choice) && libs.sources) {
        card.append(el('small', 'cm-hint', '推荐的缓存设置：'), directCacheCard(connectionInfo().kind, where));
    }
    const row = el('div', 'cm-btn-row');
    row.append(button('完成', () => apply(finishGuide()), { icon: 'fa-check', primary: true }), skipLink());
    card.append(row);
}

let drawn = '';

/**
 * Draw (or hide) the guide card for the current settings and connection.
 * @returns {{ step: number, hideConnectCard: boolean }} the shell hides its own connect card while the
 *   guide speaks for itself (steps 1 and 3, and the direct sources' step 2).
 */
export function renderGuide() {
    const card = document.getElementById('claude_max_guide');
    const off = { step: 0, hideConnectCard: false };
    // Without the sources helper the connection can't be told apart reliably: no guide, no auto-mark.
    if (!card || !libs.sources) return off;
    const settings = getSettings();
    const raw = connectionInfo();
    const phase = store.get().status.phase;
    // ST's settings pointing at the proxy URL is not a connection: wait for / require the proxy's answer.
    if (raw.connected && proxyUnknown(phase)) return off;
    const conn = gateConnection(raw, phase);
    if ((conn.connected || conn.direct) && !settings.everConnected) {
        settings.everConnected = true;
        saveSettingsDebounced();
    }
    if (shouldAutoOnboard(settings, conn)) {
        Object.assign(settings, finishGuide());
        saveSettingsDebounced();
    }
    const step = guideStep({ ...settings, settingsExisted: !settings.freshInstall }, conn);
    card.hidden = step === 0;
    if (!step) { drawn = ''; return off; }
    const choice = chosenSource(settings.guideSource);
    const sig = `${step}|${choice}|${conn.kind}|${conn.model}`;
    if (sig !== drawn) {
        drawn = sig;
        card.replaceChildren(stepper(step));
        if (step === 1) drawStep1(card);
        else if (step === 2) drawStep2(card, choice);
        else drawStep3(card, choice);
    }
    return { step, hideConnectCard: step !== 2 || choice !== 'proxy' };
}
