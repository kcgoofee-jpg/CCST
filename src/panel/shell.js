// ──────────────────────────────────────────────
// The panel shell: the drawer SillyTavern shows in its extension settings, the at-a-glance header and
// status bar, the tab bar, and one-click connect. The tabs themselves are in ./tabs/; live data comes
// from the store (core/live.js fills it).
// ──────────────────────────────────────────────

import { store } from './core/store.js';
import { getSettings, saveSettingsDebounced, EFFORT_LABEL } from './core/settings.js';
import { connectHelp, mismatchHelp, hostKind, loginHelp, updateHelp, isNewerVersion, awayHelp } from './core/connect-help.js';
import { stepItem, downloadItem } from './core/help-items.js';
import { IS_TAURI, COARSE, isOurEndpoint } from './core/capabilities.js';
import { libs } from './core/libs.js';
import { F } from './core/registry.js';
import { connectionInfo, shortModel } from './core/connection.js';
import { genLine } from './core/capabilities.js';
import { stEffort } from './core/inject.js';
import { el, note } from './core/dom.js';
import { notify } from './core/notify.js';
import { refreshAll, refreshStatus, refreshStats } from './core/live.js';
import { buildStatusTab } from './tabs/status.js';
import { buildSettingsTab } from './tabs/settings.js';
import { TABS, resolveTab } from './core/tabs.js';
import { buildGuideCard, renderGuide } from './guide.js';
import { glanceLinked } from './core/guide.js';
import { chooseConnectModel, ensureProfile, profileNotice, connectAdvice, describeCurrentConnection, sourceLabel } from './core/connection-profile.js';

// ── One-click connect (same selector path as ST's /api-url command) ──

// 审: 「连到 CCST？」确认框里的「现在：…」；没了用户看不到自己会被换掉什么连接。
/** What ST is connected to right now, in words (for the confirm dialog). */
function currentConnectionText() {
    const src = $('#chat_completion_source').val();
    const url = src === 'custom' ? $('#custom_api_url_text').val() : '';
    // The model of the CURRENT source only (connectionInfo reads that source's own field).
    const model = connectionInfo().model || '';
    const profile = $('#connection_profiles option:selected').text?.() || '';
    return describeCurrentConnection({ profile, source: src, url, model });
}

// 审: 酒馆在用别的连接时它叫什么（配置名，或已连上的接口名），连接卡片据此提示「现在用的是…」。
/** The connection SillyTavern is on when it is not CCST, as the user named it: the profile name, else
 *  the source and model; '' when nothing is set up yet (a fresh SillyTavern). */
function otherConnectionName() {
    const profile = String($('#connection_profiles option:selected').text?.() || '').trim();
    if (profile && !/^<none>$|^无$|^未选择$/i.test(profile)) return profile;
    // No profile: only when SillyTavern is actually connected somewhere (a fresh install sits on OpenAI, unconnected).
    const online = SillyTavern.getContext().onlineStatus;
    if (!online || online === 'no_connection') return '';
    const src = $('#main_api').val() === 'openai' ? $('#chat_completion_source').val() : $('#main_api').val();
    return src ? sourceLabel(src) : '';
}

// 审: 一键连接的核心：把酒馆当前连接字段改成指向本代理；connect 与 connectProfile 重试都用它。
/** Point SillyTavern's live connection fields at the proxy. */
function applyConnection(settings) {
    $('#main_api').val('openai').trigger('change');
    // The endpoint MUST be set before the source change: ST's change handler auto-reconnects
    // immediately, and firing it with the stale custom_url would race a status check against the
    // wrong endpoint. The key field is left alone: it may hold the user's key for another service.
    $('#custom_api_url_text').val(settings.endpoint).trigger('input');
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

// 审: 等酒馆异步重连稳定的延时 helper（仅 connectProfile 用）。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One-click connect rewrites SillyTavern's LIVE connection fields (source, URL, post-processing),
// keeps a Claude model ST already has (else Opus 4.6), then saves that as the connection profile 「CCST」 (created, or
// updated when it exists). Other profiles are never edited, but the live connection is replaced — so
// it always asks first unless ST already points at this proxy.
// 审: 一键连接入口（引导卡、连接卡、设置页「重新连接」都调它）：确认 → 改字段 → 存「CCST」配置。
export async function connect(settings) {
    try {
        // Taken before anything is rewritten: a Claude model ST already has is kept.
        const keepModel = connectionInfo().model ?? '';
        const ours = $('#chat_completion_source').val() === 'custom'
            && isOurEndpoint($('#custom_api_url_text').val(), settings);
        if (!ours) {
            const ctx = SillyTavern.getContext();
            const box = document.createElement('div');
            for (const line of [
                '连到 CCST？',
                `现在：${currentConnectionText() || '（未连接）'}`,
                `改成：CCST · ${settings.endpoint}`,
                '会存一个「CCST」配置，别的不动',
            ]) { const p = document.createElement('p'); p.textContent = line; box.append(p); }
            const ok = await ctx.callGenericPopup(box, ctx.POPUP_TYPE.CONFIRM);
            if (!ok) return;
        }
        applyConnection(settings);
        notify('info', '连接中…', '在读模型列表，约 10 秒', { ms: 0, replace: 'connect-profile' });
        await connectProfile(settings, keepModel);
        setTimeout(refreshAll, 800);
    } catch (err) {
        console.error('[claude-max] connect failed', err);
        notify('bad', '连接失败', `到「API 连接」手动选自定义（${String(err?.message ?? err)}）`, { replace: 'connect' });
    }
}

// 审: 读当前预设数据，供预设提示用；读不到返回 null，不让连接流程因它失败。
/** The selected chat-completion preset's data, or null when it cannot be read. */
function activePreset(ctx) {
    try {
        const name = ctx.chatCompletionSettings?.preset_settings_openai;
        return name ? ctx.getPresetManager?.('openai')?.getCompletionPresetByName?.(name) ?? null : null;
    } catch { return null; }
}

// 审: 连接后提示「预设带正则脚本」的文案来源，包一层可选链避免 libs 没加载时报错。
/** 「预设带正则脚本…」 when the selected preset's data carries enabled regex scripts; '' when unknown. */
function presetRegexNote(ctx) {
    return libs.presetReco?.presetRegexNote?.(activePreset(ctx)) ?? '';
}

// 审: 同一个预设的连接提示只说一次，没了重复点连接会重复弹。
// 同一个预设的提示只说一次（重新连接、再点一键连接时不要又弹一遍）
const advised = new Set();

// 审: 连接后选模型并存/更新「CCST」配置，再给预设建议；失败只提示不影响已能聊天。
/** After connecting: Opus 4.6, then the 「CCST」 profile (slash commands of ST's connection manager). */
async function connectProfile(settings, keepModel = '') {
    try {
        const ctx = SillyTavern.getContext();
        const parser = ctx.SlashCommandParser;
        const run = async (cmd) => String((await ctx.executeSlashCommandsWithOptions(cmd, { handleExecutionErrors: true }))?.pipe ?? '');
        let modelOk = false;
        const target = chooseConnectModel(keepModel, libs.sources?.canonicalModel);
        const pickModel = async () => {
            await sleep(600); // the source change reconnects asynchronously; the profile reads the settled fields
            modelOk = F.models.setModel(target) === true;
            await sleep(300);
        };
        await pickModel();
        const res = await ensureProfile({
            run,
            applyConnection: async () => { applyConnection(settings); await pickModel(); },
            hasCommands: () => !!(ctx.executeSlashCommandsWithOptions && parser?.commands?.['profile-create'] && parser.commands['profile-list']),
        });
        if (res.ok) {
            notify('ok', '已连接', profileNotice({ existed: res.existed, modelOk, modelLabel: shortModel(target) }), { ms: 10000, replace: 'connect-profile' });
            const preset = ctx.chatCompletionSettings?.preset_settings_openai ?? '';
            for (const a of connectAdvice({ presetNote: libs.presetReco?.presetMismatchNote?.(preset, activePreset(ctx)) ?? '', regexNote: presetRegexNote(ctx) })) {
                const once = `${preset}|${a.key}`;
                if (advised.has(once)) continue;
                advised.add(once);
                notify('warn', '提示', a.text, { ms: 12000, replace: a.key });
            }
        }
        else if (res.reason === 'no-connection-manager') notify('warn', '没存成配置', '能聊天；酒馆的连接管理器没开', { ms: 10000, replace: 'connect-profile' });
        else notify('warn', '没存成配置', '能聊天；酒馆没让保存', { ms: 10000, replace: 'connect-profile' });
    } catch (err) {
        console.error('[claude-max] connection profile failed', err);
        notify('warn', '没存成配置', `能聊天；保存出错（${String(err?.message ?? err)}）`, { ms: 10000, replace: 'connect-profile' });
    }
}

// 审: 抽屉标题和状态栏的小圆点同步颜色（页面上有两个 .cm-dot）。
function setDot(state) {
    for (const dot of document.querySelectorAll('.cm-dot')) {
        dot.dataset.state = state;
    }
}

// 审: 凭证来源的中文名，设置页「连接」那行用（tabs/settings.js 引用，不能去 export）。
export const SOURCE_LABELS = { keychain: '钥匙串', file: '登录文件', env: '环境变量' };

// 审: 折叠抽屉头与状态栏的一行摘要；事件、store 订阅、renderConnect 都调（events.js 引用，不能去 export）。
/** The header summary of the collapsed drawer and the status bar say the same thing:
 *  dot · model · where/billing · 5h quota. Clicking the bar opens 状态. */
export function renderGlance() {
    const { glance, gen } = store.get();
    const { connected, model } = connectionInfo();
    const linked = glanceLinked({ connected }, store.get().status.phase);
    // Thinking is SillyTavern's own 「推理强度」: named here when it isn't Auto.
    const effort = stEffort();
    const parts = [];
    if (linked && model) parts.push(shortModel(model));
    if (linked && effort !== 'auto') parts.push(EFFORT_LABEL[effort]);
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
            // Only the local proxy is left: 「本机代理」 says nothing; the billing (订阅) does.
            if (q != null) {
                const quota = el('span', 'cm-bar-quota', `5h ${q}%`);
                // The worse of how much is used and how fast (pace, see tabs/status.js usagePace); ▲ = on track to run out.
                const pace = store.get().glance?.quotaPace;
                if (q >= 90 || pace === 'critical') quota.dataset.tone = 'error';
                else if (q >= 75 || pace === 'warning') quota.dataset.tone = 'warn';
                if (pace === 'critical' || pace === 'warning') quota.textContent += ' ▲';
                bar.append(quota);
            }
        }
    }
}

// ── The connect card ──
// One card says what is missing and offers ONE button. Until SillyTavern is on a Claude connection the
// card is all the panel shows (the tabs stay reachable, dimmed); afterwards it only appears for a
// problem (proxy down, not logged in, wrong password) and is gone when everything is fine.

// 审: 「还没登录」卡片的步骤（一条登录命令）；代理装成插件或独立版都是同一条命令。
function loginSteps(host) {
    const h = loginHelp({ host });
    return [{ text: h.where, cmd: h.cmd }];
}

// 审: 判断面板跑在哪（Tauri/手机或远程/桌面浏览器），决定给哪套安装/启动文案；guide.js 共用（原先两处各抄一份）。
/** Where this panel runs, from facts only: TauriTavern, a touch device / a page opened from beyond the home network, or a desktop browser. */
export function hostNow() {
    const remote = libs.hostCheck?.isLocalHost ? !libs.hostCheck.isLocalHost(location.hostname) : false;
    return hostKind({ tauri: IS_TAURI, elsewhere: COARSE || remote });
}

// 审: 以下四个是连接卡的渲染状态（步骤展开、所属情形、上次是否首次设置、成功卡截止时间），没了卡片会闪或不会自动收起。
let stepsOpen = false;   // the steps under the card's button
let stepsFor = '';       // which situation they belong to (a new situation closes them)
let prevSetup = false;   // was the panel in the first-run state at the last render
let flashUntil = 0;      // the success card shows until then

// 审: 代理与面板版本不一致时的卡片描述。
/** 版本不一致：情况 → 影响 → 编号步骤（内容见 connect-help.js 的 mismatchHelp）。 */
function mismatchCard(base, status) {
    const help = mismatchHelp({ side: status.mismatchSide, proxyVersion: status.version, panelVersion: status.panelVersion, runtime: status.runtime, tauri: IS_TAURI, host: hostNow() });
    return { ...base, tone: 'warn', dot: 'warning', key: `mismatch-${status.mismatchSide}-${status.runtime ?? 'unknown'}`, title: '版本对不上',
        sub: help.sub, steps: help.steps, showSteps: true, downloads: help.downloads, hint: help.hint };
}

// 审: 有新版本时的下载卡片描述，null 表示不显示。
/** 有新版本：一键安装那张下载卡片，加「这一版不再提醒」。只对装成酒馆插件的代理（一键安装更新的就是它）。 */
function updateCard(base, status) {
    const latest = store.get().latestVersion;
    if (!latest || !status.version || status.runtime === 'standalone' || !isNewerVersion(latest, status.version)) return null;
    if (getSettings().skipVersion === latest) return null;
    const help = updateHelp({ latest, host: hostNow() });
    if (!help) return null;
    return { ...base, tone: 'info', dot: 'online', key: `update-${latest}`, title: help.title, sub: help.sub, downloads: help.downloads, showSteps: true, steps: [],
        action: { label: '不再提醒', run: () => { getSettings().skipVersion = latest; saveSettingsDebounced(); renderConnect(); } } };
}

// 审: 把 store 里的代理状态翻译成连接卡该显示什么（纯数据），renderConnect 只管画。
/** What the card should say right now: null = no card. */
function describeCard() {
    const { connected, model } = connectionInfo();
    const { status } = store.get();
    const setup = !connected;
    const base = { setup };
    const phase = status.phase;

    if (hostNow() === 'away') {
        const help = awayHelp({ touch: COARSE });
        return { ...base, setup: true, tone: 'info', dot: 'offline', key: 'away', title: help.title, sub: help.sub };
    }
    if (phase === 'denied') {
        return { ...base, tone: 'error', dot: 'offline', key: 'denied', title: '只能本机用', sub: status.message || '只给装 CCST 的那台电脑用' };
    }
    if (phase === 'offline') {
        const help = connectHelp({ host: hostNow() });
        return {
            ...base, tone: setup ? 'info' : 'error', dot: 'offline', key: `start-${help.key}`,
            title: help.title,
            sub: help.sub, steps: help.steps, showSteps: true, downloads: help.downloads, hint: help.hint,
        };
    }
    if (status.phase === 'nologin') {
        return { ...base, tone: 'warn', dot: 'warning', key: 'login', title: '还没登录',
            sub: '登录一次，就用你的订阅', steps: loginSteps(hostNow()),
            action: { label: '怎么登录', again: '登好了', run: refreshAll } };
    }
    if (status.phase === 'pending' || status.phase === 'idle') {
        return setup ? { ...base, tone: 'info', dot: 'pending', key: 'checking', title: '检测中…', sub: '' } : null;
    }
    if (status.phase === 'online') {
        const mismatch = status.mismatch;
        if (connected) {
            if (Date.now() < flashUntil) {
                return { ...base, tone: 'ok', dot: 'online', key: 'ok', title: model ? `已连接 · ${shortModel(model)}` : '请选模型', sub: '' };
            }
            return mismatch ? mismatchCard(base, status) : updateCard(base, status);
        }
        // Proxy is fine, SillyTavern isn't on it (yet). Using another connection on purpose (a Gemini
        // profile…): say which, and let the card be closed until the connection changes.
        const using = otherConnectionName();
        if (using && !mismatch) {
            if (getSettings().hideConnectFor === using) return null;
            return { ...base, setup: false, tone: 'info', dot: 'online', key: `other-${using}`, title: `现在用的是「${using}」`,
                sub: '要用 Claude 订阅就点连接；暂时不用可以关掉该扩展',
                action: { label: '连接', icon: 'fa-plug', primary: true, run: () => connect(getSettings()) },
                action2: { label: '不再提示', run: () => { getSettings().hideConnectFor = using; saveSettingsDebounced(); renderConnect(); } } };
        }
        const sub = '点一下，自动选好模型';
        return { ...base, tone: 'info', dot: mismatch ? 'warning' : 'online', key: 'connect', title: '差一步',
            sub: mismatch ? `${sub}\n${mismatch}` : sub, action: { label: '连接', icon: 'fa-plug', primary: true, run: () => connect(getSettings()) } };
    }
    return null;
}

// 审: 画连接卡、定整个面板的阶段（首次设置/就绪）、状态栏显隐、云端提示；store 订阅与事件都调它。
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
    // The first-run guide speaks first; while it shows, the connect card steps aside.
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
        dl.replaceChildren(...(view.downloads ?? []).map(downloadItem));
        dl.hidden = !dl.childElementCount;
        const dlHint = card.querySelector('#claude_max_downloads_hint');
        dlHint.textContent = view.hint ?? '';
        dlHint.hidden = dl.hidden || !view.hint;
        const btn2 = card.querySelector('#claude_max_status_action2');
        btn2.hidden = !view.action2;
        if (view.action2) { btn2.textContent = view.action2.label; btn2.onclick = () => view.action2.run(); }
        const btn = card.querySelector('#claude_max_status_action');
        btn.hidden = !view.action;
        if (view.action) {
            const label = stepsOpen && view.action.again ? view.action.again : view.action.label;
            btn.replaceChildren(...(view.action.icon ? [el('i', `fa-solid ${view.action.icon}`), document.createTextNode(` ${label}`)] : [document.createTextNode(label)]));
            btn.onclick = () => {
                if (view.steps && view.action.again && !stepsOpen) { stepsOpen = true; renderConnect(); return; }
                view.action.run();
            };
        }
    }
    const { proxyState } = store.get();
    setDot(view?.dot ?? (proxyState ?? 'pending'));
    // The bar is for a working connection; during first-run the card is the only thing to look at.
    const bar = document.getElementById('claude_max_bar');
    if (bar) bar.hidden = !!view?.setup;
    renderGlance();
}

// 审: 构建状态栏 + 引导卡 + 连接卡 + 云端提示的 DOM 骨架；内容由 renderConnect/renderGlance 按 id 填。
/** Status bar + the connect card. Everything fine: just the bar. */
function buildStatusBar(showTab) {
    const block = el('div', 'cm-status-block');
    const bar = el('button', 'cm-bar');
    bar.type = 'button';
    bar.id = 'claude_max_bar';
    bar.title = '看状态';
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
    const action2 = el('button', 'menu_button cm-btn');
    action2.type = 'button';
    action2.id = 'claude_max_status_action2';
    action2.hidden = true;
    row.append(action, action2);
    card.append(head, sub, steps, downloads, dlHint, row);

    block.append(bar, buildGuideCard(), card);
    return block;
}

// 审: 记住上次所选 tab 的 localStorage 键（每台设备各自记）。
const TAB_STORE = 'ccst.panelTab';

// 审: 读上次选的 tab，旧版本的键经 resolveTab 迁移。
/** The tab last picked on this device (localStorage: a phone and the Mac needn't agree). Old keys are migrated (core/tabs.js). */
function savedTab() {
    let key = null;
    try { key = localStorage.getItem(TAB_STORE); } catch { /* storage blocked */ }
    return resolveTab(key);
}

// 审: showTab 的真身在抽屉建好后才赋值，之前调用是空操作。
let showTabFn = () => {};
// 审: 切换 tab 的统一入口（状态栏点击、tab 按钮都走它）。
/** Select a tab (the picker built with the drawer; a no-op until it exists). */
const showTab = (...args) => showTabFn(...args);

// 审: 在酒馆扩展设置里建出整个面板（抽屉 + 状态栏 + tab）；boot.js 与 rebuildPanel 调用。
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
    }, 50));

    const panes = Object.fromEntries(TABS.map(([k]) => [k, el('div', 'cm-pane')]));
    buildStatusTab(panes.status);
    buildSettingsTab(panes.settings, settings, save);

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
        b.addEventListener('click', () => {
            showTab(k);
            // Stats go stale while the panel sits open: re-read on entering the tab
            if (k === 'status') refreshStats();
        });
        bar.append(b);
    }

    content.append(buildStatusBar((k) => showTab(k)), bar, ...TABS.map(([k]) => panes[k]));
    showTab(savedTab(), false);
    renderConnect();
    renderGlance();
    return true;
}

// 审: 预设推荐应用后整体重建面板（features/presets.js 调用），保持原位置与展开状态。
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

// 审: 把 shell 自己的绘制挂到 store（只调一次，boot.js 调用）；没了面板不会随状态刷新。
/** Subscribe the shell's own drawing to the store (once; the drawing looks its DOM up by id, so a rebuilt panel needs nothing). */
export function initShell() {
    store.subscribe('status', () => renderConnect());
    store.subscribe(['glance', 'gen'], () => renderGlance());
    // A full refresh: re-read what SillyTavern is connected to (the connect note; the tabs' own pulse
    // listeners draw the cache card, lore box, check-up and card check).
    store.subscribe('pulse', () => { renderConnect(); renderGlance(); });
    store.subscribe('latestVersion', () => renderConnect());
}
