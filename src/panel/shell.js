// ──────────────────────────────────────────────
// The panel shell: the drawer SillyTavern shows in its extension settings, the at-a-glance header and
// status bar, the tab bar, and one-click connect. The tabs themselves are in ./tabs/; live data comes
// from the store (core/live.js fills it).
// ──────────────────────────────────────────────

import { store } from './core/store.js';
import { getSettings, saveSettingsDebounced, EFFORT_LABEL } from './core/settings.js';
import { connectHelp, mismatchHelp } from './core/connect-help.js';
import { IS_TAURI, cloudHosted, isOurEndpoint, stSideEndpoint } from './core/capabilities.js';
import { libs } from './core/libs.js';
import { F } from './core/registry.js';
import { connectionInfo, shortModel } from './core/connection.js';
import { genLine } from './core/capabilities.js';
import { effectiveEffort } from './core/inject.js';
import { el, note } from './core/dom.js';
import { notify } from './core/notify.js';
import { refreshAll, refreshStatus, refreshStats } from './core/live.js';
import { buildReasonTab } from './tabs/reason.js';
import { buildStatusTab } from './tabs/status.js';
import { buildCheckTab } from './tabs/check.js';
import { refreshMac } from './tabs/mac.js';
import { buildSettingsTab } from './tabs/settings.js';
import { buildOtherTab } from './tabs/other.js';
import { TABS, resolveTab } from './core/tabs.js';
import { buildGuideCard, renderGuide } from './guide.js';
import { glanceLinked } from './core/guide.js';
import { PROFILE_MODEL, ensureProfile, profileNotice, describeCurrentConnection } from './core/connection-profile.js';

// ── One-click connect (same selector path as ST's /api-url command) ──

/** What ST is connected to right now, in words (for the confirm dialog). */
function currentConnectionText() {
    const src = $('#chat_completion_source').val();
    const url = src === 'custom' ? $('#custom_api_url_text').val() : '';
    // The model of the CURRENT source only (connectionInfo reads that source's own field).
    const model = connectionInfo().model || '';
    const profile = $('#connection_profiles option:selected').text?.() || '';
    return describeCurrentConnection({ profile, source: src, url, model });
}

/** Point SillyTavern's live connection fields at the proxy. */
function applyConnection(settings) {
    $('#main_api').val('openai').trigger('change');
    // Endpoint (and the LAN key) MUST be set before the source change: ST's change handler
    // auto-reconnects immediately, and firing it with the stale custom_url would race a status
    // check against the wrong endpoint.
    $('#custom_api_url_text').val(stSideEndpoint(settings)).trigger('input');
    // Only a LAN proxy needs a key (its access key). Otherwise the key field is left alone: it may
    // hold the user's key for another service.
    const keyField = $('#api_key_custom');
    if (keyField.length && settings.accessKey) keyField.val(settings.accessKey).trigger('input');
    $('#chat_completion_source').val('custom').trigger('change');
    // '' is ST's 「无」 (the dropdown shows 「未选择」), and it is the recommended value, so the CCST
    // profile saved from these live fields rightly has 提示词后处理 未选择 (see postProcessingCheck in
    // inject.js, which warns on any other value).
    // The proxy sorts out roles itself. ST's merge/strict post-processing
    // turns the whole preset into a user message (after the first
    // assistant-role preset entry), which kills prompt caching.
    $('#custom_prompt_post_processing').val('').trigger('change');
    $('#api_button_openai').trigger('click');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One-click connect rewrites SillyTavern's LIVE connection fields (source, URL, post-processing, and
// on a LAN the key), picks Opus 4.6, then saves that as the connection profile 「CCST」 (created, or
// updated when it exists). Other profiles are never edited, but the live connection is replaced — so
// it always asks first unless ST already points at this proxy.
export async function connect(settings) {
    try {
        const ours = $('#chat_completion_source').val() === 'custom'
            && isOurEndpoint($('#custom_api_url_text').val(), settings);
        if (!ours) {
            const ctx = SillyTavern.getContext();
            const box = document.createElement('div');
            for (const line of [
                '一键连接会把酒馆现在的连接改成 CCST 代理：',
                `现在：${currentConnectionText() || '（未连接）'}`,
                `改成：自定义来源 · ${stSideEndpoint(settings)}`,
                '同时会新建（或更新）一个叫「CCST」的连接配置并选中它，模型选 Opus 4.6；你别的连接配置不会被改，想切回在「API 连接」顶部选回来即可。继续吗？',
            ]) { const p = document.createElement('p'); p.textContent = line; box.append(p); }
            const ok = await ctx.callGenericPopup(box, ctx.POPUP_TYPE.CONFIRM);
            if (!ok) return;
        }
        applyConnection(settings);
        notify('info', '正在保存连接配置『CCST』…', '酒馆在等模型列表，大约要十秒，请稍候。', { ms: 0, replace: 'connect-profile' });
        await connectProfile(settings);
        setTimeout(refreshAll, 800);
    } catch (err) {
        console.error('[claude-max] connect failed', err);
        notify('bad', '一键连接没成功', `${String(err?.message ?? err)}。可以到「API 连接」手动选「自定义」来源，地址填上面的代理地址。`, { replace: 'connect' });
    }
}

/** After connecting: Opus 4.6, then the 「CCST」 profile (slash commands of ST's connection manager). */
async function connectProfile(settings) {
    try {
        const ctx = SillyTavern.getContext();
        const parser = ctx.SlashCommandParser;
        const run = async (cmd) => String((await ctx.executeSlashCommandsWithOptions(cmd, { handleExecutionErrors: true }))?.pipe ?? '');
        let modelOk = false;
        const pickModel = async () => {
            await sleep(600); // the source change reconnects asynchronously; the profile reads the settled fields
            modelOk = F.models.setModel(PROFILE_MODEL) === true;
            await sleep(300);
        };
        await pickModel();
        const res = await ensureProfile({
            run,
            applyConnection: async () => { applyConnection(settings); await pickModel(); },
            hasCommands: () => !!(ctx.executeSlashCommandsWithOptions && parser?.commands?.['profile-create'] && parser.commands['profile-list']),
        });
        if (res.ok) notify('ok', '连接配置', profileNotice({ existed: res.existed, modelOk }), { ms: 12000, replace: 'connect-profile' });
        else if (res.reason === 'no-connection-manager') notify('warn', '已连上代理，但没保存连接配置', '酒馆的「连接管理器」扩展没开，存不了「CCST」配置。不影响聊天；模型请到「API 连接」里选。', { ms: 10000, replace: 'connect-profile' });
        else notify('warn', '已连上代理，但没保存连接配置', '酒馆没接受「CCST」配置。不影响聊天；想保留的话，到「API 连接」核对后自己存一个。', { ms: 10000, replace: 'connect-profile' });
    } catch (err) {
        console.error('[claude-max] connection profile failed', err);
        notify('warn', '已连上代理，但没保存连接配置', `保存「CCST」配置时出错：${String(err?.message ?? err)}。不影响聊天。`, { ms: 10000, replace: 'connect-profile' });
    }
}

function setDot(state) {
    for (const dot of document.querySelectorAll('.cm-dot')) {
        dot.dataset.state = state;
    }
}

export const SUBSCRIPTION_LABELS = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise' };
export const SOURCE_LABELS = { keychain: '钥匙串', file: '凭据文件', env: '环境变量' };

const planOf = (cred) => SUBSCRIPTION_LABELS[cred?.subscriptionType] ?? cred?.subscriptionType ?? '订阅';

/** The header summary of the collapsed drawer and the status bar say the same thing:
 *  dot · model · where/billing · 5h quota. Clicking the bar opens 状态. */
export function renderGlance() {
    const { nextEffort, glance, gen } = store.get();
    const { connected, direct, model, where, billing } = connectionInfo();
    const linked = glanceLinked({ connected, direct }, store.get().status.phase);
    const settings = getSettings();
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
        const progress = genLine(gen);
        const barBtn = document.getElementById('claude_max_bar');
        if (progress) {
            // A reply is being written (or just finished): the bar says so in place of the model.
            if (barBtn) barBtn.dataset.gen = gen.kind;
            bar.replaceChildren(el('b', 'cm-bar-model', progress));
            if (linked && model) bar.append(el('span', 'cm-bar-src', shortModel(model)));
        } else {
            barBtn?.removeAttribute('data-gen');
            bar.replaceChildren(el('b', 'cm-bar-model', linked ? (model ? shortModel(model) : '未选模型') : '未连接'));
            if (linked && where) bar.append(el('span', 'cm-bar-src', `${where} · ${billing}`));
            // One-off boost: the only effort worth a place in the bar, because it expires by itself.
            if (connected && nextEffort) bar.append(el('span', 'cm-bar-effort', `下一轮${EFFORT_LABEL[effort]}`));
            // The 5h window is the subscription's: beside an API key or OpenRouter it says nothing.
            if (q != null && !direct) {
                const quota = el('span', 'cm-bar-quota', `5h ${q}%`);
                if (q >= 70) quota.dataset.tone = q >= 90 ? 'error' : 'warn';
                bar.append(quota);
            }
        }
    }
    // The check-up result lives on its tab: a count badge instead of another status block.
    const badge = document.getElementById('claude_max_check_badge');
    if (badge) {
        badge.textContent = glance.issues ? String(glance.issues) : '';
        badge.hidden = !glance.issues;
    }
}

// ── The connect card ──
// One card says what is missing and offers ONE button. Until SillyTavern is on a Claude connection the
// card is all the panel shows (the tabs stay reachable, dimmed); afterwards it only appears for a
// problem (proxy down, not logged in, wrong password) and is gone when everything is fine.

const STEPS = {
    login: [
        { text: '在 SillyTavern/plugins/CCST 文件夹里运行下面的命令，在弹出的浏览器里登录 Claude：', cmd: 'npm run login' },
        '用一键安装包装的：打开「酒馆工具」，按 3 登录 Claude。',
    ],
};

let stepsOpen = false;   // the steps under the card's button
let stepsFor = '';       // which situation they belong to (a new situation closes them)
let prevSetup = false;   // was the panel in the first-run state at the last render
let flashUntil = 0;      // the success card shows until then

/** One step: text, and a command (if any) in a box with a copy button. */
function stepItem(step) {
    const { text, cmd } = typeof step === 'string' ? { text: step } : step;
    const li = el('li', null, text);
    if (cmd) {
        const row = el('div', 'cm-cmd');
        const code = el('code', null, cmd);
        const copy = el('button', 'cm-link-btn', '复制');
        copy.type = 'button';
        copy.addEventListener('click', async () => {
            try { await navigator.clipboard.writeText(cmd); copy.textContent = '已复制'; } catch { copy.textContent = '请手动选中复制'; }
            setTimeout(() => { copy.textContent = '复制'; }, 2000);
        });
        row.append(code, copy);
        li.append(row);
    }
    return li;
}

/** 版本不一致：情况 → 影响 → 编号步骤（内容见 connect-help.js 的 mismatchHelp）。 */
function mismatchCard(base, status) {
    const help = mismatchHelp({ side: status.mismatchSide, proxyVersion: status.version, panelVersion: status.panelVersion, runtime: status.runtime, tauri: IS_TAURI });
    return { ...base, tone: 'warn', dot: 'warning', key: `mismatch-${status.mismatchSide}-${status.runtime ?? 'unknown'}`, title: '面板和代理版本不一致',
        sub: help.sub, steps: help.steps, showSteps: true, downloads: help.downloads, hint: help.hint };
}

/** What the card should say right now: null = no card. */
function describeCard() {
    const { connected, direct, model } = connectionInfo();
    const { proxyState, status } = store.get();
    const online = proxyState === 'online';
    const setup = !connected && !direct;
    const base = { setup };

    if (status.phase === 'denied') {
        return { ...base, tone: 'error', dot: 'offline', key: 'denied', title: status.code === 401 ? '访问密码不对' : '代理拒绝连接', sub: status.message,
            action: { label: '去改访问密码', run: () => showTab('other') } };
    }
    if (status.phase === 'offline') {
        if (!setup && direct) return null; // direct to Claude without the proxy: nothing is wrong
        const help = connectHelp({ endpoint: getSettings().endpoint });
        return {
            ...base, tone: setup ? 'info' : 'error', dot: 'offline', key: `start-${help.key}`,
            title: help.title,
            sub: help.sub, steps: help.steps, showSteps: true, downloads: help.downloads, hint: help.hint,
            action: { label: '我做好了，重新检测', run: refreshAll },
            edit: true,
        };
    }
    if (status.phase === 'nologin') {
        return { ...base, tone: 'warn', dot: 'warning', key: 'login', title: setup ? '代理在线，还差登录 Claude' : '代理在线，但没登录 Claude',
            sub: '登录一次后，聊天走你的订阅额度。', steps: STEPS.login,
            action: { label: '登录说明', again: '我登录好了，重新检测', run: refreshAll } };
    }
    if (status.phase === 'pending' || status.phase === 'idle') {
        return setup ? { ...base, tone: 'info', dot: 'pending', key: 'checking', title: '正在检测代理…', sub: '' } : null;
    }
    if (status.phase === 'online') {
        const mismatch = status.mismatch;
        if (connected) {
            if (Date.now() < flashUntil) {
                return { ...base, tone: 'ok', dot: 'online', key: 'ok', title: model ? `已连接 · ${shortModel(model)}` : '已连接 · 请选 Claude 模型', sub: '模型和思考深度在「推理」页。' };
            }
            return mismatch ? mismatchCard(base, status) : null;
        }
        // Proxy is fine, SillyTavern isn't on it (yet).
        const sub = direct ? '连上代理才有缓存排布、防丢回复和额度；现在酒馆直连 Claude，本地功能照常。'
            : `${planOf(status.cred)} 订阅 · 代理 v${status.version}。点「一键连接」让酒馆改用它：会自动选 Opus 4.6，并保存成「CCST」连接配置。`;
        return { ...base, tone: 'info', dot: mismatch ? 'warning' : 'online', key: 'connect', title: direct ? '代理在线，可以连上它' : '代理已就绪，酒馆还没接上',
            sub: mismatch ? `${sub}\n${mismatch}` : sub, action: { label: '一键连接', icon: 'fa-plug', primary: true, run: () => connect(getSettings()) } };
    }
    return null;
}

/** Draw the connect card and the stage of the whole panel from the store + SillyTavern's settings. */
export function renderConnect() {
    const card = document.getElementById('claude_max_status_block');
    if (!card) return;
    const before = prevSetup;
    let view = describeCard();
    const { connected } = connectionInfo();
    // Just left the first-run state: show the success card for a few seconds.
    if (before && connected && store.get().proxyState === 'online' && !view?.setup && Date.now() >= flashUntil && view === null) {
        flashUntil = Date.now() + 7000;
        setTimeout(renderConnect, 7100);
        view = describeCard();
    }
    prevSetup = !!view?.setup;
    const body = card.closest('.cm-body');
    if (body) {
        body.dataset.stage = view?.setup ? 'setup' : 'ready';
        if (!view?.setup) delete body.dataset.explore;
    }
    // The first-run guide speaks first; while it has something to say the connect card steps aside
    // (except for the proxy's step 2, where the connect card IS the step).
    const guide = renderGuide();
    card.hidden = !view || guide.hideConnectCard;
    if (view) {
        card.dataset.tone = view.tone;
        if (view.key !== 'checking' && stepsFor !== view.key) { stepsFor = view.key; stepsOpen = false; }
        card.querySelector('#claude_max_status_title').textContent = view.title;
        const sub = card.querySelector('#claude_max_status_sub');
        sub.textContent = view.sub ?? '';
        sub.hidden = !view.sub;
        const steps = card.querySelector('#claude_max_steps');
        steps.replaceChildren(...(view.steps ?? []).map(stepItem));
        steps.hidden = !view.steps || !(stepsOpen || view.showSteps);
        const dl = card.querySelector('#claude_max_downloads');
        dl.replaceChildren(...(view.downloads ?? []).map((d) => {
            const a = el('a', 'menu_button cm-btn', d.label);
            a.href = d.href;
            a.setAttribute('download', d.file);
            return a;
        }));
        dl.hidden = !view.downloads?.length;
        const dlHint = card.querySelector('#claude_max_downloads_hint');
        dlHint.textContent = view.hint ?? '';
        dlHint.hidden = dl.hidden || !view.hint;
        const btn = card.querySelector('#claude_max_status_action');
        btn.hidden = !view.action;
        if (view.action) {
            const label = stepsOpen && view.action.again ? view.action.again : view.action.label;
            btn.replaceChildren(...(view.action.icon ? [el('i', `fa-solid ${view.action.icon}`), document.createTextNode(` ${label}`)] : [document.createTextNode(label)]));
            btn.classList.toggle('cm-primary', true);
            btn.onclick = () => {
                if (view.steps && view.action.again && !stepsOpen) { stepsOpen = true; renderConnect(); return; }
                view.action.run();
            };
        }
        card.querySelector('#claude_max_status_conn').hidden = !view.edit;
    }
    const { proxyState } = store.get();
    const { direct } = connectionInfo();
    const up = proxyState === 'online' || proxyState === 'warning';
    // Direct to Claude with the proxy not running is not a fault: a hollow dot.
    setDot(direct && !connected && !up ? 'direct' : view?.dot ?? (proxyState ?? 'pending'));
    // The bar is for a working connection; during first-run the card is the only thing to look at.
    const bar = document.getElementById('claude_max_bar');
    if (bar) bar.hidden = !!view?.setup;
    // Cloud SillyTavern + loopback address + proxy unreachable: say why instead of "start the proxy".
    const cloud = document.getElementById('claude_max_cloud');
    if (cloud) {
        cloud.hidden = direct || proxyState !== 'offline' || !cloudHosted(libs.hostCheck, { hostname: location.hostname, endpoint: getSettings().endpoint, tauri: IS_TAURI });
    }
    renderGlance();
}

/** Status bar + the connect card. Everything fine: just the bar. */
function buildStatusBar(showTab) {
    const block = el('div', 'cm-status-block');
    const bar = el('button', 'cm-bar');
    bar.type = 'button';
    bar.id = 'claude_max_bar';
    bar.title = '打开「状态」';
    const sum = el('div', 'cm-bar-sum');
    sum.id = 'claude_max_bar_sum';
    bar.append(el('span', 'cm-dot'), sum, el('i', 'fa-solid fa-chevron-right cm-bar-go'));
    bar.addEventListener('click', () => { showTab('status'); refreshStats(); });

    const card = note('info');
    card.id = 'claude_max_status_block';
    card.classList.add('cm-setup');
    const head = el('div', 'cm-setup-head');
    const title = el('div', 'cm-note-title');
    title.id = 'claude_max_status_title';
    head.append(title);
    const sub = el('small', 'cm-hint');
    sub.id = 'claude_max_status_sub';
    const steps = el('ol', 'cm-notes');
    steps.id = 'claude_max_steps';
    const downloads = el('div', 'cm-btn-row');
    downloads.id = 'claude_max_downloads';
    const dlHint = el('small', 'cm-hint');
    dlHint.id = 'claude_max_downloads_hint';
    const row = el('div', 'cm-btn-row');
    const action = el('button', 'menu_button cm-btn cm-primary');
    action.type = 'button';
    action.id = 'claude_max_status_action';
    // The address field lives in 设置 (and 其他 → 手机连接); this jumps to 设置.
    const edit = el('button', 'cm-link-btn', '改地址');
    edit.type = 'button';
    edit.id = 'claude_max_status_conn';
    edit.addEventListener('click', () => showTab('settings'));
    row.append(action, edit);
    card.append(head, sub, steps, downloads, dlHint, row);

    const cloud = note('info', '酒馆在云端，连不到你电脑上的代理');
    cloud.id = 'claude_max_cloud';
    cloud.hidden = true;
    cloud.append(el('small', 'cm-hint', '云端酒馆里的 127.0.0.1 是服务器自己。可以：改用 API 密钥直连；在服务器上运行代理；或用内网穿透暴露代理，并设访问密码。'));

    block.append(bar, buildGuideCard(), card, cloud);
    return block;
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

    // Refresh live data whenever the drawer is opened.
    toggle.addEventListener('click', () => setTimeout(() => {
        if (drawerContent.offsetParent === null) return;
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
        if (remember) {
            try { localStorage.setItem(TAB_STORE, key); } catch { /* storage blocked: not remembered */ }
            // First-run: the card is all there is until the user goes looking on purpose.
            if (content.dataset.stage === 'setup') content.dataset.explore = '1';
        }
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
            if (k === 'status') refreshStats();
            if (k === 'other') refreshMac();
        });
        bar.append(b);
    }

    content.append(buildStatusBar((k) => showTab(k)), bar, ...TABS.map(([k]) => panes[k]));
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

/** Draw the proxy status: the connect card follows the store's `status` (see describeCard). */
export function renderStatus() {
    renderConnect();
}

/** Subscribe the shell's own drawing to the store (once; the drawing looks its DOM up by id, so a rebuilt panel needs nothing). */
export function initShell() {
    store.subscribe('status', () => renderStatus());
    store.subscribe(['glance', 'nextEffort', 'gen'], () => renderGlance());
    // A full refresh: re-read what SillyTavern is connected to (the connect note; the tabs' own pulse
    // listeners draw the cache card, lore box, check-up and card check).
    store.subscribe('pulse', () => { renderConnect(); renderGlance(); });
}
