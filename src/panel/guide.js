// ──────────────────────────────────────────────
// The first-run guide card (装代理 → 登录 → 连接 → 完成). The state logic is in core/guide.js (pure);
// what to install and the login command are in core/connect-help.js. While the guide shows, the
// connect card steps aside: the guide is the only thing a newcomer has to follow.
// ──────────────────────────────────────────────

import { store } from './core/store.js';
import { getSettings, saveSettingsDebounced } from './core/settings.js';
import { connectionInfo, shortModel } from './core/connection.js';
import { APP_NAME, IS_TAURI, COARSE } from './core/capabilities.js';
import { libs } from './core/libs.js';
import { fetchProxy } from './core/proxy.js';
import { refreshStatus } from './core/live.js';
import { el, note, button } from './core/dom.js';
import { cmdRow, linkButton } from './core/help-items.js';
import { hostKind, installHelp, loginHelp } from './core/connect-help.js';
import {
    GUIDE_STEPS, DONE_STEP, GUIDE_POLL_MS, guideFacts, guideStep, shouldAutoOnboard, pollsProxy,
    startGuide, finishGuide,
} from './core/guide.js';
import { connect } from './shell.js';

/** Re-draw everything that follows the connection (the shell listens to `pulse`). */
const redraw = () => store.set({ pulse: store.get().pulse + 1 });

function apply(patch) {
    Object.assign(getSettings(), patch);
    saveSettingsDebounced();
    redraw();
}

/** 设置 → 重新引导. */
export function restartGuide() {
    apply(startGuide());
    refreshStatus();
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

/** Where this panel runs, from facts only (the same as the connect card). */
function hostNow() {
    const remote = libs.hostCheck?.isLocalHost ? !libs.hostCheck.isLocalHost(location.hostname) : false;
    return hostKind({ tauri: IS_TAURI, elsewhere: COARSE || remote });
}

function stepper(step) {
    const row = el('ol', 'cm-guide-steps');
    GUIDE_STEPS.forEach((s, i) => {
        const li = el('li', null, s.title);
        if (i + 1 === step) li.className = 'active';
        else if (i + 1 < step) li.className = 'done';
        row.append(li);
    });
    return row;
}

function skipLink() {
    const b = el('button', 'cm-link-btn', '跳过');
    b.type = 'button';
    b.addEventListener('click', () => apply(finishGuide()));
    return b;
}

const waiting = (text) => el('small', 'cm-hint cm-guide-wait', text);

// Step 1 — 装代理. The only step that knows HOW the proxy is installed: another backend swaps this one.
function drawInstall(card) {
    const help = installHelp({ host: hostNow() });
    card.append(el('div', 'cm-note-title', '安装 CCST'));
    if (help.mac) card.append(el('div', 'cm-guide-os', 'Mac：在终端粘贴，回车'), cmdRow(help.mac, '复制命令'));
    if (help.win) {
        const row = el('div', 'cm-btn-row');
        row.append(linkButton(help.win));
        card.append(el('div', 'cm-guide-os', 'Windows：下载后双击'), row);
    }
    if (help.docs) {
        const row = el('div', 'cm-btn-row');
        row.append(linkButton({ label: '安装说明', href: help.docs, download: false }));
        card.append(row);
    }
    card.append(waiting(help.sub));
}

// Step 2 — 登录.
function drawLogin(card) {
    const help = loginHelp({ host: hostNow() });
    card.append(
        el('div', 'cm-note-title', '登录 Claude'),
        el('small', 'cm-hint', help.where),
        cmdRow(help.cmd),
        waiting('登好后自动下一步'),
    );
}

// Step 3 — 连接.
function drawConnect(card) {
    const { status } = store.get();
    card.append(
        el('div', 'cm-note-title', `连上${APP_NAME}`),
        el('small', 'cm-hint', '自动选好模型'),
    );
    if (status.mismatch) card.append(el('small', 'cm-hint cm-warn', status.mismatch));
    const row = el('div', 'cm-btn-row');
    row.append(button('连接', () => connect(getSettings()), { icon: 'fa-plug', primary: true }));
    card.append(row);
}

function drawDone(card) {
    const { model } = connectionInfo();
    card.append(
        el('div', 'cm-note-title', model ? `已连接 · ${shortModel(model)}` : '已连接'),
        el('small', 'cm-hint', '可以聊了；温度等参数无效'),
    );
    const row = el('div', 'cm-btn-row');
    row.append(button('完成', () => apply(finishGuide()), { icon: 'fa-check', primary: true }));
    card.append(row);
}

const DRAW = { 1: drawInstall, 2: drawLogin, 3: drawConnect, [DONE_STEP]: drawDone };

// ── Steps 1 and 2 wait for the proxy: ask it every few seconds, quietly (no 「正在检测」 flicker),
// and run the full status check only when its answer moved on. ──
let pollTimer = null;
let polling = false;

async function pollOnce() {
    if (polling || document.hidden) return;
    polling = true;
    try {
        let next = 'offline';
        try {
            const res = await fetchProxy('/status', '/status');
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.ok) next = data.credential?.present ? 'online' : 'nologin';
        } catch { /* still not there */ }
        if (next !== store.get().status.phase) refreshStatus();
    } finally {
        polling = false;
    }
}

function setPolling(on) {
    if (on && !pollTimer) pollTimer = setInterval(() => {
        if (!document.getElementById('claude_max_guide')?.isConnected) return setPolling(false);
        void pollOnce();
    }, GUIDE_POLL_MS);
    else if (!on && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

let drawn = '';

/**
 * Draw (or hide) the guide card for the current settings and connection.
 * @returns {{ step: number, hideConnectCard: boolean }} the shell hides its own connect card while the guide shows.
 */
export function renderGuide() {
    const card = document.getElementById('claude_max_guide');
    const off = { step: 0, hideConnectCard: false };
    if (!card) return off;
    const settings = getSettings();
    const phase = store.get().status.phase;
    const facts = guideFacts(connectionInfo(), phase);
    // Not known yet (first check at start-up): keep whatever is drawn; draw nothing before the first answer.
    if (facts.checking) return drawn ? { step: Number(drawn.split('|')[0]), hideConnectCard: true } : off;
    if (facts.connected && !settings.everConnected) {
        settings.everConnected = true;
        saveSettingsDebounced();
    }
    if (shouldAutoOnboard(settings, facts)) {
        Object.assign(settings, finishGuide());
        saveSettingsDebounced();
    }
    // The proxy turned this device away (access key): that is the connect card's to explain.
    const step = phase === 'denied' ? 0 : guideStep({ ...settings, settingsExisted: !settings.freshInstall }, facts);
    card.hidden = step === 0;
    setPolling(pollsProxy(step));
    if (!step) { drawn = ''; return off; }
    // A newcomer on the guide has started it: connecting at step 3 leads to 完成, not to an auto-close.
    if (!settings.guideSource) {
        settings.guideSource = 'on';
        saveSettingsDebounced();
    }
    const sig = `${step}|${connectionInfo().model ?? ''}|${store.get().status.mismatch ?? ''}`;
    if (sig !== drawn) {
        drawn = sig;
        card.replaceChildren(stepper(step));
        DRAW[step](card);
        const row = el('div', 'cm-guide-foot');
        if (step !== DONE_STEP) row.append(skipLink());
        if (row.childElementCount) card.append(row);
    }
    return { step, hideConnectCard: true };
}
