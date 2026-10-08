// ──────────────────────────────────────────────
// The first-run guide card (装代理 → 登录 → 连接 → 完成). The state logic is in core/guide.js (pure);
// what to install and the login command are in core/connect-help.js. While the guide shows, the
// connect card steps aside: the guide is the only thing a newcomer has to follow.
// ──────────────────────────────────────────────

import { store } from './core/store.js';
import { getSettings, saveSettingsDebounced } from './core/settings.js';
import { connectionInfo, shortModel } from './core/connection.js';
import { APP_NAME } from './core/capabilities.js';
import { fetchProxy } from './core/proxy.js';
import { refreshStatus } from './core/live.js';
import { el, note, button } from './core/dom.js';
import { cmdRow, linkButton } from './core/help-items.js';
import { installHelp, loginHelp } from './core/connect-help.js';
import {
    GUIDE_STEPS, DONE_STEP, GUIDE_POLL_MS, guideFacts, guideStep, shouldAutoOnboard, pollsProxy,
    startGuide, finishGuide,
} from './core/guide.js';
import { connect, hostNow } from './shell.js';

// 审: 让 shell 与各 tab 重画（它们订阅 pulse）；引导状态一变就要调。
/** Re-draw everything that follows the connection (the shell listens to `pulse`). */
const redraw = () => store.set({ pulse: store.get().pulse + 1 });

// 审: 把引导状态补丁写进设置、保存并重画；跳过/完成/重新引导都经过它。
function apply(patch) {
    Object.assign(getSettings(), patch);
    saveSettingsDebounced();
    redraw();
}

// 审: 「设置 → 重看引导」的入口（tabs/settings.js 引用）。
/** 设置 → 重新引导. */
export function restartGuide() {
    apply(startGuide());
    refreshStatus();
    document.getElementById('claude_max_guide')?.scrollIntoView?.({ block: 'nearest' });
}

// 审: 建引导卡的空壳（默认隐藏），由 renderGuide 填；shell 的 buildStatusBar 调。
export function buildGuideCard() {
    const card = note('info');
    card.id = 'claude_max_guide';
    card.classList.add('cm-guide');
    card.hidden = true;
    drawn = '';
    return card;
}

// 审: 顶部四步进度条（当前/已完成高亮）。
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

// 审: 「跳过」按钮，直接结束引导。
function skipLink() {
    const b = el('button', 'cm-link-btn', '跳过');
    b.type = 'button';
    b.addEventListener('click', () => apply(finishGuide()));
    return b;
}

// 审: 步骤里「等待中」的灰色小字。
const waiting = (text) => el('small', 'cm-hint cm-guide-wait', text);

// Step 1 — 装代理. The only step that knows HOW the proxy is installed: another backend swaps this one.
// 审: 步骤 1 画面：给出安装命令/下载链接；换后端只改这一步。
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
// 审: 步骤 2 画面：显示登录命令。
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
// 审: 步骤 3 画面：一键连接按钮（含版本不配的警告）。
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

// 审: 完成画面：已连接，点「完成」收起引导。
function drawDone(card) {
    const { model } = connectionInfo();
    card.append(
        el('div', 'cm-note-title', model ? `已连接 · ${shortModel(model)}` : '已连接'),
        el('small', 'cm-hint', '设置完成！'),
    );
    const row = el('div', 'cm-btn-row');
    row.append(button('完成', () => apply(finishGuide()), { icon: 'fa-check', primary: true }));
    card.append(row);
}

// 审: 步骤号 → 画面函数的分发表。
const DRAW = { 1: drawInstall, 2: drawLogin, 3: drawConnect, [DONE_STEP]: drawDone };

// ── Steps 1 and 2 wait for the proxy: ask it every few seconds, quietly (no 「正在检测」 flicker),
// and run the full status check only when its answer moved on. ──
// 审: 轮询定时器与重入锁，防止多个定时器/并发请求叠加。
let pollTimer = null;
let polling = false;

// 审: 安静地问代理一次 /status，答案变了才触发完整刷新（避免「正在检测」闪烁）。
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

// 审: 开关轮询；卡片已不在页面时自动停（面板重建后的旧定时器）。
function setPolling(on) {
    if (on && !pollTimer) pollTimer = setInterval(() => {
        if (!document.getElementById('claude_max_guide')?.isConnected) return setPolling(false);
        void pollOnce();
    }, GUIDE_POLL_MS);
    else if (!on && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// 审: 上次画的签名（步骤|模型|不配提示），没变就不重画，免得按钮被刷掉。
let drawn = '';

// 审: 引导卡的主流程：算出该在哪一步、画出来、告诉 shell 是否隐藏连接卡；每次 renderConnect 都调。
/**
 * Draw (or hide) the guide card for the current settings and connection.
 * @returns {{ hideConnectCard: boolean }} the shell hides its own connect card while the guide shows.
 */
export function renderGuide() {
    const card = document.getElementById('claude_max_guide');
    const off = { hideConnectCard: false };
    if (!card) return off;
    const settings = getSettings();
    const phase = store.get().status.phase;
    const facts = guideFacts(connectionInfo(), phase);
    // 手机 / 云端酒馆：连接卡片说「这里用不了」，不走安装引导。
    if (hostNow() === 'away') { card.hidden = true; drawn = ''; return off; }
    // Not known yet (first check at start-up): keep whatever is drawn; draw nothing before the first answer.
    if (facts.checking) return drawn ? { hideConnectCard: true } : off;
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
    return { hideConnectCard: true };
}
