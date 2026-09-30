// ──────────────────────────────────────────────
// The panel shell: the drawer SillyTavern shows in its extension settings, the at-a-glance header and
// status bar, the tab bar, and one-click connect. The tabs themselves are in ./tabs/; live data comes
// from the store (core/live.js fills it).
// ──────────────────────────────────────────────

import { store } from './core/store.js';
import { getSettings, saveSettingsDebounced, EFFORT_LABEL } from './core/settings.js';
import { IS_TAURI, cloudHosted } from './core/capabilities.js';
import { libs } from './core/libs.js';
import { connectionInfo, shortModel } from './core/connection.js';
import { effectiveEffort } from './core/inject.js';
import { el, note, iconButton } from './core/dom.js';
import { notify, ui, flushIsland } from './core/notify.js';
import { refreshAll, refreshStatus, refreshStats, refreshQuota } from './core/live.js';
import { buildReasonTab } from './tabs/reason.js';
import { buildStatusTab } from './tabs/status.js';
import { buildCheckTab } from './tabs/check.js';
import { refreshMac } from './tabs/mac.js';
import { buildSettingsTab } from './tabs/settings.js';
import { buildOtherTab } from './tabs/other.js';
import { TABS, resolveTab } from './core/tabs.js';

// ── One-click connect (same selector path as ST's /api-url command) ──

export function connect(settings) {
    try {
        $('#main_api').val('openai').trigger('change');
        // Endpoint + key MUST be set before the source change: ST's
        // change handler auto-reconnects immediately, and firing it with
        // the stale custom_url would race a status check against the
        // wrong endpoint.
        $('#custom_api_url_text').val(settings.endpoint).trigger('input');
        const keyField = $('#api_key_custom');
        if (keyField.length && settings.accessKey) {
            // LAN: the proxy checks this as the access key
            keyField.val(settings.accessKey).trigger('input');
        } else if (keyField.length && !String(keyField.val() ?? '').trim()) {
            keyField.val('sk-no-key-needed');
        }
        $('#chat_completion_source').val('custom').trigger('change');
        // The proxy sorts out roles itself. ST's merge/strict post-processing
        // turns the whole preset into a user message (after the first
        // assistant-role preset entry), which kills prompt caching.
        $('#custom_prompt_post_processing').val('').trigger('change');
        $('#api_button_openai').trigger('click');
        notify('ok', '正在连接', '稍后在「API 连接」里选模型。', { replace: 'connect' });
        if (IS_TAURI) {
            notify('info', '首次连接', `TauriTavern 会弹出授权框，请允许访问 ${settings.endpoint}。`, { ms: 10000 });
        }
        setTimeout(refreshAll, 800);
    } catch (err) {
        console.error('[claude-max] connect failed', err);
        notify('bad', '连接失败', String(err), { replace: 'connect' });
    }
}

function setDot(state) {
    for (const dot of document.querySelectorAll('.cm-dot')) {
        dot.dataset.state = state;
    }
}

export const SUBSCRIPTION_LABELS = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise' };
export const SOURCE_LABELS = { keychain: '钥匙串', file: '凭据文件', env: '环境变量' };

/** Card title once the proxy is up: whether SillyTavern is pointed at it, and with which model. */
function statusTitleOnline() {
    const { connected, model } = connectionInfo();
    if (!connected) {
        return connectionInfo().direct
            ? '代理在线，酒馆直连 Claude：连上代理可用缓存排布、防丢回复、额度'
            : '代理在线，酒馆还没连上';
    }
    return model ? `已连接 · ${shortModel(model)}` : '已连接 · 请选 Claude 模型';
}

/** The status bar (dot · model · effort · 5h quota) and the collapsed drawer's header say the same thing. */
export function renderGlance() {
    const settings = getSettings();
    const { nextEffort, glance } = store.get();
    const { connected, direct, model, where, billing } = connectionInfo();
    const linked = connected || direct;
    const effort = effectiveEffort(settings);
    const parts = [];
    if (linked && model) parts.push(shortModel(model));
    if (effort !== 'auto') parts.push(nextEffort ? `下一轮${EFFORT_LABEL[effort]}` : EFFORT_LABEL[effort]);
    if (glance.quota != null) parts.push(`5h ${glance.quota}%`);
    const head = document.getElementById('claude_max_head_sum');
    if (head) head.textContent = parts.join(' · ');

    const bar = document.getElementById('claude_max_bar_sum');
    if (bar) {
        const q = glance.quota;
        bar.replaceChildren(
            el('b', 'cm-bar-model', linked ? (model ? shortModel(model) : '未选模型') : '未连接'),
        );
        // 走哪 · 按什么计费
        if (linked && where) {
            const src = el('span', 'cm-bar-src', `${where} · ${billing}`);
            src.title = '现在走哪 · 按什么计费';
            bar.append(src);
        }
        // The panel's thinking settings reach Claude only through the proxy.
        if (connected || nextEffort) {
            bar.append(el('span', 'cm-bar-effort', nextEffort ? `下一轮${EFFORT_LABEL[effort]}` : `思考 ${settings.thinking === 'off' ? '关' : EFFORT_LABEL[effort]}`));
        }
        // The 5h window is the subscription's: beside an API key or OpenRouter it says nothing.
        if (q != null && !direct) {
            const quota = el('span', 'cm-bar-quota', `5h ${q}%`);
            if (q >= 70) quota.dataset.tone = q >= 90 ? 'error' : 'warn';
            bar.append(quota);
        }
    }
    // The check-up result lives on its tab: a count badge instead of another status block.
    const badge = document.getElementById('claude_max_check_badge');
    if (badge) {
        badge.textContent = glance.issues ? String(glance.issues) : '';
        badge.hidden = !glance.issues;
    }
}

/** Status bar + the one note that says what needs doing (proxy down, not logged in,
 *  SillyTavern not connected, cloud-hosted SillyTavern). Everything fine: just the bar. */
function buildStatusBar(showTab) {
    const block = el('div', 'cm-status-block');
    const bar = el('div', 'cm-bar');
    const sum = el('div', 'cm-bar-sum');
    sum.id = 'claude_max_bar_sum';
    bar.append(el('span', 'cm-dot'), sum, iconButton('fa-rotate', '重新检测', refreshAll));

    const alert = note('warn');
    alert.id = 'claude_max_status_block';
    const statusTitle = el('div', 'cm-note-title');
    statusTitle.id = 'claude_max_status_title';
    const statusSub = el('small', 'cm-hint');
    statusSub.id = 'claude_max_status_sub';
    const row = el('div', 'cm-btn-row');
    const connectBtn = el('div', 'menu_button cm-connect');
    connectBtn.id = 'claude_max_connect';
    connectBtn.append(el('i', 'fa-solid fa-plug'), document.createTextNode(' 一键连接'));
    connectBtn.addEventListener('click', () => connect(getSettings()));
    // The address field lives in 设置 (and 其他 → 手机连接); this jumps to 设置.
    const fieldsBtn = el('div', 'menu_button');
    fieldsBtn.id = 'claude_max_status_conn';
    fieldsBtn.append(el('i', 'fa-solid fa-gear'), document.createTextNode(' 改地址'));
    fieldsBtn.addEventListener('click', () => showTab('settings'));
    row.append(connectBtn, fieldsBtn);
    alert.append(statusTitle, statusSub, row);

    const cloud = note('info', '酒馆在云端，连不到你电脑上的代理');
    cloud.id = 'claude_max_cloud';
    cloud.hidden = true;
    cloud.append(el('small', 'cm-hint', '云端酒馆里的 127.0.0.1 是服务器自己。可以：改用 API 密钥直连；在服务器上运行代理；或用内网穿透暴露代理，并设访问密码。'));

    block.append(bar, alert, cloud);
    return block;
}

/** Show the status note only while something needs doing; connect button only when ST isn't connected. */
export function renderConnect() {
    const block = document.getElementById('claude_max_status_block');
    const btn = document.getElementById('claude_max_connect');
    if (!block || !btn) return;
    const { connected, direct } = connectionInfo();
    const { proxyState } = store.get();
    btn.hidden = connected;
    // Direct to Claude with no proxy running: nothing needs doing, the proxy is optional.
    block.hidden = (connected && proxyState === 'online') || (direct && proxyState !== 'online' && proxyState !== 'warning');
    block.dataset.tone = proxyState === 'offline' ? 'error' : proxyState === 'online' && !connected ? 'info' : 'warn';
    if (direct) setDot(proxyState === 'online' || proxyState === 'warning' ? 'online' : 'direct');
    const conn = document.getElementById('claude_max_status_conn');
    if (conn) conn.hidden = proxyState !== 'offline';
    const title = document.getElementById('claude_max_status_title');
    if (title && proxyState === 'online') title.textContent = statusTitleOnline();
    // Cloud SillyTavern + loopback address + proxy unreachable: say why instead of "start the proxy".
    const cloud = document.getElementById('claude_max_cloud');
    if (cloud) {
        cloud.hidden = direct || proxyState !== 'offline' || !cloudHosted(libs.hostCheck, { hostname: location.hostname, endpoint: getSettings().endpoint, tauri: IS_TAURI });
    }
    renderGlance();
}

const TAB_STORE = 'ccst.panelTab';

/** The tab last picked on this device (localStorage: a phone and the Mac needn't agree). Old keys are migrated (core/tabs.js). */
export function savedTab() {
    let key = null;
    try { key = localStorage.getItem(TAB_STORE); } catch { /* storage blocked */ }
    key ??= getSettings().panelTab; // settings from before 3.1
    return resolveTab(key);
}

let showTabFn = () => {};
/** Select a tab (the picker built with the drawer; a no-op until it exists). */
export const showTab = (...args) => showTabFn(...args);

/** Build the panel into ST's extension settings; false when that container isn't there yet. */
export function addExtensionSettings(settings) {
    const container = document.getElementById('extensions_settings');
    if (!container) return false;
    const save = () => saveSettingsDebounced();

    const drawer = el('div', 'inline-drawer claude-max');
    const toggle = el('div', 'inline-drawer-toggle inline-drawer-header');
    const heading = el('b', 'cm-heading');
    const headSum = el('small', 'cm-head-sum');
    headSum.id = 'claude_max_head_sum';
    heading.append(el('span', 'cm-dot'), el('span', 'cm-heading-name', 'CCST'), headSum);
    toggle.append(heading, el('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down'));
    const drawerContent = el('div', 'inline-drawer-content');
    // ST slide-toggles the drawer content's display — keep our flex
    // layout on an inner wrapper so it never fights that.
    const content = el('div', 'cm-body');
    drawerContent.append(content);
    drawer.append(toggle, drawerContent);
    container.append(drawer);

    // Refresh live data whenever the drawer is opened; closed with notices
    // still in the pill → they become toasts.
    toggle.addEventListener('click', () => setTimeout(() => {
        if (drawerContent.offsetParent === null) return flushIsland();
        refreshAll();
        refreshMac(); // decides whether 其他 shows the Mac section
    }, 50));

    const panes = Object.fromEntries(TABS.map(([k]) => [k, el('div', 'cm-pane')]));
    buildReasonTab(panes.reason, settings, save);
    buildStatusTab(panes.status);
    buildCheckTab(panes.check, settings, save);
    buildSettingsTab(panes.settings, settings, save);
    buildOtherTab(panes.other, settings, save);

    const bar = el('div', 'cm-tabs');
    bar.setAttribute('role', 'tablist');
    showTabFn = (key, remember = true) => {
        for (const [k] of TABS) panes[k].hidden = k !== key;
        bar.querySelectorAll('button').forEach((b) => {
            b.classList.toggle('active', b.dataset.tab === key);
            b.setAttribute('aria-selected', String(b.dataset.tab === key));
        });
        if (remember) { try { localStorage.setItem(TAB_STORE, key); } catch { /* storage blocked: not remembered */ } }
    };
    for (const [k, label] of TABS) {
        const b = el('button', 'cm-tab', label);
        b.type = 'button';
        b.dataset.tab = k;
        b.setAttribute('role', 'tab');
        if (k === 'check') {
            const badge = el('span', 'cm-badge');
            badge.id = 'claude_max_check_badge';
            badge.hidden = true;
            b.append(badge);
        }
        b.addEventListener('click', () => {
            showTab(k);
            // Stats go stale while the panel sits open: re-read on entering the tab
            if (k === 'status') { refreshStats(); refreshQuota(); }
            if (k === 'other') refreshMac();
        });
        bar.append(b);
    }

    const islandSlot = el('div', 'cm-island-slot');
    islandSlot.id = 'claude_max_island_slot';
    content.append(islandSlot, buildStatusBar((k) => showTab(k)), bar, ...TABS.map(([k]) => panes[k]));
    ui.island?.mount(islandSlot);
    showTab(savedTab(), false);
    renderConnect();
    renderGlance();
    return true;
}

export function rebuildPanel() {
    const old = document.querySelector('.inline-drawer.claude-max');
    const wasOpen = old?.querySelector('.inline-drawer-content')?.offsetParent != null;
    const anchor = old?.nextSibling ?? null;
    const parent = old?.parentElement;
    old?.remove();
    addExtensionSettings(getSettings());
    const fresh = document.querySelector('.inline-drawer.claude-max');
    if (parent && fresh && anchor) parent.insertBefore(fresh, anchor);
    if (wasOpen) {
        fresh?.querySelector('.inline-drawer-toggle')?.click();
    }
    refreshStatus();
}

/** Draw the proxy status (dot, title, sub-line) from the store. */
export function renderStatus(status) {
    const title = document.getElementById('claude_max_status_title');
    const sub = document.getElementById('claude_max_status_sub');
    if (!title || !sub) return;
    switch (status.phase) {
        case 'pending':
            setDot('pending');
            title.textContent = '正在检测代理…';
            sub.textContent = '';
            return;
        case 'denied':
            // Reached the proxy, which turned us away (access key / LAN not on)
            setDot('offline');
            title.textContent = status.code === 401 ? '访问密码不对' : '代理拒绝连接';
            sub.textContent = status.message;
            break;
        case 'online': {
            const { cred, version, mismatch } = status;
            setDot('online');
            title.textContent = statusTitleOnline();
            const plan = SUBSCRIPTION_LABELS[cred.subscriptionType] ?? cred.subscriptionType ?? '订阅';
            sub.textContent = `${plan} 订阅 · 代理 v${version}`;
            if (mismatch) {
                setDot('warning');
                sub.textContent = `${plan} 订阅 · ${mismatch}`; // the mismatch names both versions
            }
            break;
        }
        case 'nologin':
            setDot('warning');
            title.textContent = '代理在线，但未登录';
            sub.textContent = '「酒馆工具」选「登录 Claude」，或在代理目录运行 npm run login。';
            break;
        case 'offline':
            setDot('offline');
            title.textContent = '连接不到代理';
            sub.textContent = status.remote
                ? `连不上 ${status.where}。确认那台电脑开着、开了「手机模式」、两边同一个 Wi-Fi（换过 Wi-Fi 地址可能变了）。`
                : `连不上 ${status.where}。「酒馆工具」选「启动」，或在代理目录运行 npm start。`;
            break;
        default:
            return;
    }
    renderConnect();
}

/** Subscribe the shell's own drawing to the store (once; the drawing looks its DOM up by id, so a rebuilt panel needs nothing). */
export function initShell() {
    store.subscribe('status', ({ status }) => renderStatus(status));
    store.subscribe(['glance', 'nextEffort'], () => renderGlance());
    // A full refresh: re-read what SillyTavern is connected to (the connect note; the tabs' own pulse
    // listeners draw the cache card, lore box, check-up and card check).
    store.subscribe('pulse', () => { renderConnect(); renderGlance(); });
}
