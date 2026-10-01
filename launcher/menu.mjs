#!/usr/bin/env node
// ──────────────────────────────────────────────
// CCST 酒馆工具：菜单（Mac / Windows / Termux 共用一份）
// ──────────────────────────────────────────────
//
// 各系统只留一个启动壳（mac/酒馆工具.command、windows/酒馆工具.bat），
// 菜单的分组、说明、问题判断都在这里；状态和不分系统的动作在 core.mjs（三个系统同一份）：
// 首页只放每天要用的；手机、TT 守护、生图、导入这些主线以外的收在「其他」里（冻结维护，都还能用）。
// 只有 Mac 的功能统一用 core.mjs 的 macOnly() 判断，不在各处散着写 OS === 'mac'。
//   检查状态                      三个系统都用 core.mjs
//   启动 / 关闭 / 重启            Windows、Linux 用 core.mjs；Mac 用 mac/actions/*.zsh（要连带手机模式守护、合盖）、
//                                 Termux 用 termux/claude-max.sh（代理在 Debian 子系统里）。重启前统一由 core.mjs 把关
//   同步手机、TT 守护             phone.mjs（只 Mac）
//   其余（手机模式、合盖、生图…） Mac mac/actions/<id>.zsh；Windows windows/claude-max.ps1 <动作>
// 不依赖任何 npm 包：依赖坏了的时候（菜单里正好有「修复依赖」）也要能打开。
//
// 按键：数字 / 字母直接执行；↑↓ 选、回车执行；0、Esc 返回；h 说明；q 退出。
// 不是终端（管道、测试）时退回「输入编号回车」。CCST_MENU_PLAIN=1 也强制用这种方式。

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emitKeypressEvents } from 'node:readline';

import { ACTIONS, HERE, IS_TERMUX, MAC_ONLY, OS, VERSION, ago, clock, getJson, loadConfig, macOnly, readState, restartRefusal } from './core.mjs';
import { createRequire } from 'node:module';
import { makeConnectCode } from '../src/panel/core/connect-code.js';
import { PHONE_ACTIONS, latestGuard, pullJob, versionNote } from './phone.mjs';

export { readState };

// ── 显示宽度（中文两格）和颜色 ──

export function width(s) {
    let w = 0;
    for (const ch of String(s).replace(/\x1b\[[0-9;]*m/g, '')) {
        const c = ch.codePointAt(0);
        w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
            || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60)
            || (c >= 0xffe0 && c <= 0xffe6) || c >= 0x20000 ? 2 : 1;
    }
    return w;
}
export const pad = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)));
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { dim: paint('2'), bold: paint('1'), ok: paint('32'), warn: paint('33'), bad: paint('31'), key: paint('36'), inv: paint('7') };
const RULE_W = 56;
const RULE = ' ' + '─'.repeat(RULE_W - 2);
// 每一屏底部的按键说明用同一套说法，子菜单只多一个「0 返回」
const HINT_HOME = '按键直接执行 · ↑↓ 选、回车执行 · h 说明 · q 退出';
const HINT_SUB = '按键直接执行 · ↑↓ 选、回车执行 · 0 返回 · h 说明 · q 退出';
const note = (m) => (/^(没有成功|出错|.*：(没有成功|出错|结束))/.test(m) ? c.bad(`✗ ${m}`) : c.warn(m));

// ── 菜单内容：只描述「有什么、叫什么、什么时候能用」，怎么做交给 run() ──

/**
 * 要处理的问题，每条带一个修复动作（fix = 动作，sub = 子菜单；都没有就只提示）。
 * block = 不修就不能玩（首页第一行变红）；其余是提醒（变黄）。
 */
export function problems(s) {
    const out = [];
    const backend = s.backend?.id ?? 'subscription';
    if (!s.proxy) out.push({ text: '代理没在运行', fix: 'start', fixLabel: '启动代理', block: true });
    else {
        if (backend === 'subscription' && s.loggedIn === false) out.push({ text: 'Claude 还没登录', fix: 'login', fixLabel: '登录', block: true });
        if (s.backend?.missing?.length) out.push({ text: `代理后端「${s.backend.label}」还缺设置`, fixLabel: '在面板「设置 → 代理后端」补上', block: true });
    }
    if (s.proxy && s.proxyVersion && s.proxyVersion !== VERSION) {
        out.push({ text: `代理还在跑 v${s.proxyVersion}（本地代码 v${VERSION}）`, fix: 'restart', fixLabel: '重启代理' });
    }
    // 手机相关的提醒只在开着手机模式时出现：不用手机的人首页不该看到这些
    if (s.phoneMode && !macOnly()) {
        if (!s.watchdog) out.push({ text: '手机模式的守护没在运行', fix: 'phone-mode', fixLabel: '修复' });
        if (s.phone === 'unauthorized') out.push({ text: '手机上还没允许这台电脑调试', fixLabel: '在手机上点「允许」' });
        if (s.phoneTT?.restoring) out.push({ text: '手机上 TT 守护正在恢复备份', fixLabel: '恢复完再同步' });
        else if (s.phoneTT?.restorePending) out.push({ text: '手机上次从备份恢复没做完', sub: 'guard', fixLabel: '看 TT 守护' });
    }
    return out;
}

const NEED_REPO = '要 tt-root-module（clone 到本仓库同级目录）';
const phoneOn = (s) => s.phone === 'usb' || s.phone === 'wifi';

/** 一个菜单项：key 按键、id 动作、sub 子菜单、label 名字、note 说明；why 有值时灰着显示原因。 */
export function screens(s) {
    const mac = !macOnly();
    const why = macOnly();
    const openLabel = s.stManaged ? '打开酒馆' : s.hasTT || !mac ? '打开 TT' : '打开酒馆';
    const withSt = s.stManaged ? '和酒馆' : '';
    const sub = (s.backend?.id ?? 'subscription') === 'subscription';
    const home = {
        title: '首页',
        primary: { id: 'start', label: s.proxy ? openLabel : `启动代理${withSt}` },
        rows: [[
            { key: '1', id: 'restart', label: `重启代理${withSt}` },
            { key: '2', id: 'check', label: '检查状态' },
            { key: '3', id: 'login', label: '登录 Claude', note: !sub ? `现在用 ${s.backend.label}，不用登录` : s.loggedIn ? `已登录${s.plan ? `（${s.plan}）` : ''}` : '浏览器登录订阅，一般只要一次' },
        ], [
            { key: '4', sub: 'maint', label: '维护 >' },
            { key: '5', sub: 'other', label: '其他 >' },
        ]],
    };
    const other = {
        title: '其他',
        note: '主线以外的功能：手机、TT、生图、导入。冻结维护，都还能用。',
        items: [
            { key: '1', sub: 'phone', label: '手机 >', note: '手机模式、手机同步、合盖不睡', why },
            { key: '2', sub: 'guard', label: 'TT 守护 >', note: '手机上 TT 的备份和恢复', why },
            ...(mac && s.hasComfy ? [{ key: '3', sub: 'comfy', label: '生图 >', note: '本地 ComfyUI' }] : []),
            { group: '导入和工具' },
            ...(s.canTTImport ? [{ key: '4', id: 'tt-import', label: '本机TT导入', note: '测试用：电脑酒馆 -> 这台 Mac 的 TauriTavern', why }] : []),
            { key: '5', id: 'baibai-import', label: '柏宝绘配方导入', note: '把「提示词拆分」导出的配方写进酒馆和手机', why },
            { key: '6', id: 'prompt-split', label: '提示词拆分', note: '打开本机网页工具', why },
        ],
    };
    const phone = {
        title: '手机',
        note: mac
            ? `${s.phoneMode ? '手机模式' + (s.watchdog ? '（守护中）' : '（守护没在运行）') : '电脑模式'}  ·  ${phoneText(s)}${s.lastSyncAt ? `  ·  上次同步 ${ago(s.lastSyncAt)}` : ''}`
            : '手机相关功能只支持 Mac。',
        items: [
            { key: '1', id: 'phone-sync', label: '同步手机', note: `${s.hubLabel || '电脑'} <-> 手机：先预览，拿不准的问你`, why },
            { key: '2', id: 'phone-mode', label: s.phoneMode ? '切到电脑模式' : '切到手机模式', note: s.phoneMode ? '关掉防睡眠和掉线重启' : '同一 Wi-Fi 的手机用这台 Mac 的代理', why },
            { group: '一次性设置' },
            { key: '3', id: 'lid', label: '合盖不睡', note: s.lidInstalled ? '已安装 · 装 / 卸' : '没安装 · 装 / 卸（输一次密码）', why },
        ],
    };
    const g = s.phoneTT;
    const guard = {
        title: 'TT 守护',
        note: mac ? [
            phoneOn(s) ? versionNote(g?.guardVersion, s.guardLatest) : `手机没连${s.guardLatest ? `（最新版本 ${s.guardLatest}）` : ''}`,
            `上次备份 ${g?.guardLastBackup ? clock(g.guardLastBackup) : '—'}  ·  电脑自动拉备份 ${s.pullJob?.installed ? '开着' : '没开'}`,
            '手机上的界面：KernelSU → 模块 → TT 守护（更新也在那里点）',
        ] : '只支持 Mac。',
        items: [
            { key: '1', id: 'guard-status', label: '看状态', note: '版本、备份、有没有新版本', why },
            { key: '2', id: 'guard-pull', label: '立即拉一次备份', note: '手机上的新备份拷到电脑', why: why ?? (s.hasModule ? null : NEED_REPO) },
            { key: '3', id: 'guard-auto', label: '电脑自动拉备份', note: s.pullJob?.installed ? '开着 · 关掉' : '没开 · 打开', why: why ?? (s.hasModule ? null : NEED_REPO) },
            { key: '4', id: 'guard-restore', label: '从备份恢复', note: '选一份 → 确认 → 恢复（TT 要先关）', why: why ?? (phoneOn(s) ? null : '手机没连') },
        ],
    };
    const comfy = {
        title: '生图',
        note: `本地 ComfyUI ${s.comfyRunning ? '运行中' : '没运行'}（用 NovelAI 出图不需要它）`,
        items: [
            s.comfyRunning
                ? { key: '1', id: 'comfy-stop', label: '关闭生图', note: '很占内存，不用时关掉' }
                : { key: '1', id: 'comfy-start', label: '启动生图', note: '本地 ComfyUI，端口 8188' },
        ],
    };
    const maint = {
        title: '维护',
        items: [
            { key: '1', id: 'repair', label: '修复依赖', note: '报「缺少依赖 / Cannot find module」时' },
            { key: '2', id: 'logs', label: '打开日志', note: '出错时附上最后几十行求助' },
            { key: '3', id: 'autostart-toggle', label: '开机自动启动', note: s.autostart ? '已开 · 开 / 关' : '没开 · 开 / 关' },
            { key: '4', id: 'stop', label: `关闭代理${withSt}`, note: '聊天记录都已保存' },
        ],
    };
    let n = 0;
    for (const it of other.items) if (!it.group) it.key = String(++n); // 按实际出现的项连续编号
    return { home, other, phone, guard, comfy, maint };
}

/** 手机要填的代理地址：http://<这台 Mac 的局域网地址>:端口/v1；没有局域网地址时 ''。 */
export function phoneAddress(s) {
    return s.ip ? `http://${s.ip}:${s.port ?? 8901}/v1` : '';
}

/** 手机连接码：代理地址 + 访问密码合成一串，手机上整串粘贴（格式见 src/panel/core/connect-code.js）。没有地址或密码时 ''。 */
export function phoneCode(s) {
    return phoneAddress(s) && s.lanKey ? makeConnectCode(phoneAddress(s), s.lanKey) : '';
}

/** 首页上的问题用 a b c… 当按键；开着手机模式时 c 留给「复制连接码」，问题的字母跳过它。 */
export function probLetters(s) {
    return [...'abcdefghijklmnopqrstuvwxyz'].filter((l) => !(l === 'c' && phoneCode(s) && !macOnly()));
}

/** 连接码的二维码（终端字符画，每行前空两格）。 */
export function qrLines(text) {
    let out = '';
    createRequire(import.meta.url)('qrcode-terminal').generate(text, { small: true }, (q) => { out = q; });
    return out.split('\n').filter(Boolean).map((l) => `  ${l}`);
}

/** 复制到 macOS 剪贴板（pbcopy，内容走 stdin，不进命令行参数和日志）。 */
export function copyToClipboard(text, run = spawnSync) {
    try { return run('pbcopy', [], { input: text }).status === 0; } catch { return false; }
}

function phoneText(s) {
    if (phoneOn(s)) {
        const t = s.phoneTT;
        if (!t) return '手机连着';
        return t.ttRunning ? `手机 TT 在线${t.generating ? '（在生成回复）' : ''}` : '手机 TT 没开';
    }
    return { unauthorized: '手机待授权', noadb: '没找到 adb' }[s.phone] ?? '手机没连';
}

/** 首页状态：第一行能不能玩（+ 问题和修复键）；第二行酒馆在不在、地址；开着手机模式时多连接码和二维码。 */
export function statusLines(s, probs = problems(s)) {
    const blocked = probs.some((p) => p.block);
    const head = blocked ? c.bad('● 还不能玩') : probs.length ? c.warn('● 可以玩') : c.ok('● 可以玩');
    const facts = [];
    if (!s.proxy) facts.push('代理没运行');
    else {
        facts.push(`代理 ${s.proxyVersion ?? '?'}`);
        if (s.backend) facts.push(s.backend.label);
        if ((s.backend?.id ?? 'subscription') === 'subscription') facts.push(s.loggedIn ? `已登录${s.plan ? `（${s.plan}）` : ''}` : '没登录');
        if (s.busy) facts.push(c.warn(`在写 ${s.busy} 条回复`));
    }
    const L = [`  ${pad(head, 11)}  ${facts.join(' · ')}`];
    const w = Math.max(0, ...probs.map((p) => width(p.text))) + 2;
    const letters = probLetters(s);
    probs.forEach((p, i) => {
        const act = p.fix || p.sub ? `→ ${p.fixLabel}` : c.dim(p.fixLabel);
        L.push(`    ${c.key(letters[i])}  ${pad(p.text, w)}${act}`);
    });
    // 没配置酒馆（只用 TauriTavern 的人）：什么都不显示。
    if (s.hasST !== false) L.push(`  酒馆 ${s.stRunning ? `${c.ok('运行中')} · http://127.0.0.1:${s.stPort ?? 8000}` : c.dim('没运行')}`);
    if (!s.phoneMode || macOnly()) return L;
    // 手机上要粘贴的连接码：开着手机模式时首页常驻（只显示在屏幕上，不写日志）
    L.push(`  手机连接码：${phoneCode(s) || c.dim('（没找到局域网地址：确认 Wi-Fi 已连接）')}`);
    if (!phoneCode(s)) return L;
    L.push(`  ${c.key('c')}  复制连接码    或用手机扫下面的二维码，打开后点「复制连接码」`);
    L.push(...qrLines(phoneCode(s)));
    return L;
}

// ── 执行动作 ──

// 各系统还留在自己脚本里的动作
const WIN_ACTIONS = { login: 'login', repair: 'repair', logs: 'logs', 'autostart-toggle': 'autostart' };
const TERMUX_ACTIONS = { start: 'start', stop: 'stop', restart: 'restart', login: 'login', logs: 'logs' };
const MAC_SHELL = new Set(['start', 'stop', 'restart']);

/** 这个动作在这个系统上由 Node（core.mjs / phone.mjs）做（返回动作函数）还是交给系统脚本（返回 null）。 */
export function nodeAction(id, os = OS, termux = IS_TERMUX) {
    if (PHONE_ACTIONS[id]) return os === 'mac' ? PHONE_ACTIONS[id] : null;
    if (!ACTIONS[id]) return null;
    if (id === 'check') return ACTIONS.check;
    if (os === 'mac' && MAC_SHELL.has(id)) return null;
    if (termux) return null;
    return ACTIONS[id];
}

async function run(id, io) {
    // 重启会掐断正在写的回复：哪个系统、谁来重启都先问代理
    if (id === 'restart') {
        const why = restartRefusal(await getJson(`http://127.0.0.1:${loadConfig().proxyPort}/v1/control/status`));
        if (why) return why;
    }
    const fn = nodeAction(id);
    if (fn) {
        let code;
        try {
            code = await fn({ ask: io.ask, choose: io.choose });
        } catch (err) {
            // 不把堆栈甩给玩家：一句话，细节在日志里
            code = 1;
            process.stdout.write(`\n  ${c.bad('✗')} 出错了：${String(err?.message ?? err).split('\n')[0]}\n  ${c.dim('可以在「维护 > 打开日志」里找到详情。')}\n`);
        }
        process.stdout.write(code === 0 ? `\n  ${c.ok('✓ 完成')}\n` : `\n  ${c.bad(`✗ 没有成功（退出码 ${code}）`)}\n`);
        await io.pause();
        return code === 0 ? null : `没有成功（退出码 ${code}）`;
    }
    const env = { ...process.env, CM_MENU: '1' };
    let r;
    if (OS === 'mac') {
        const f = join(HERE, 'mac', 'actions', `${id}.zsh`);
        if (!existsSync(f)) return `找不到动作脚本 ${id}`;
        r = spawnSync('/bin/zsh', [f], { stdio: 'inherit', env });
    } else if (OS === 'win') {
        if (!WIN_ACTIONS[id]) return `「${id}」${MAC_ONLY}`;
        r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'windows', 'claude-max.ps1'), WIN_ACTIONS[id]], { stdio: 'inherit', env });
    } else {
        if (!TERMUX_ACTIONS[id] || !IS_TERMUX) return `「${id}」${MAC_ONLY}`;
        r = spawnSync('bash', [join(HERE, 'termux', 'claude-max.sh'), TERMUX_ACTIONS[id]], { stdio: 'inherit', env });
    }
    return r.status === 0 ? null : `没有成功（退出码 ${r.status ?? r.signal}）`;
}

function openHelp() {
    const f = join(HERE, '使用说明.txt');
    if (OS === 'mac') spawnSync('open', [f]);
    else if (OS === 'win') spawnSync('cmd', ['/c', 'start', '', f]);
    else console.log(readFileSync(f, 'utf8'));
}

// ── 画面 ──

function header(title) {
    const now = new Date();
    const t = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const left = ` ${c.bold('CCST 酒馆工具')}${title === '首页' ? ` ${c.dim('v' + VERSION.split('.').slice(0, 2).join('.'))}` : ` > ${title}`}`;
    return [pad(left, RULE_W - 10) + c.dim(t), RULE];
}

export function renderHome(s, sel = -1, msg = '') {
    const { home } = screens(s);
    const probs = problems(s);
    const L = [...header('首页'), ...statusLines(s, probs), RULE];
    const mark = (i, text) => (sel === i ? c.inv(text) : text);
    L.push(`  ${mark(0, `${c.key('回车')}  ${home.primary.label}`)}`);
    let i = 1;
    const colW = Math.max(...home.rows.flat().map((it) => width(`${it.key} ${it.label}`))) + 3;
    for (const row of home.rows) {
        L.push('  ' + row.map((it) => mark(i++, pad(it.why ? c.dim(`${it.key} ${it.label}`) : `${c.key(it.key)} ${it.label}`, colW))).join('').trimEnd());
    }
    L.push(RULE, `  ${c.dim(HINT_HOME)}`);
    if (msg) L.push('', `  ${note(msg)}`);
    return { text: L.join('\n'), actions: [home.primary, ...home.rows.flat()], probs };
}

function renderSub(s, name, sel, msg) {
    const scr = screens(s)[name];
    const L = [...header(scr.title)];
    if (scr.note) L.push(...[].concat(scr.note).map((n) => `  ${n}`), RULE);
    const actions = [];
    for (const it of scr.items) {
        if (it.group) { L.push('', `  ${c.dim(it.group)}`); continue; }
        const idx = actions.push(it) - 1;
        const line = `   ${it.why ? c.dim(it.key) : c.key(it.key)}  ${pad(it.label, 16)}${c.dim(it.why ?? it.note ?? '')}`;
        L.push(sel === idx ? c.inv(line) : line);
    }
    L.push('', RULE, `  ${c.dim(HINT_SUB)}`);
    if (msg) L.push('', `  ${note(msg)}`);
    return { text: L.join('\n'), actions };
}

// ── 主循环 ──

function readKey() {
    return new Promise((resolve) => {
        const onKey = (str, key) => { process.stdin.off('keypress', onKey); resolve({ str, key: key ?? {} }); };
        process.stdin.on('keypress', onKey);
    });
}

// 不是终端时一行一个按键；管道里一次给多行也要一行一行用，不能丢
let lineBuf = '';
let stdinEnded = false;
async function readLine(prompt) {
    process.stdout.write(prompt);
    const take = () => {
        const i = lineBuf.indexOf('\n');
        if (i < 0) return undefined;
        const line = lineBuf.slice(0, i).trim();
        lineBuf = lineBuf.slice(i + 1);
        return line;
    };
    const ready = take();
    if (ready !== undefined) return ready;
    if (stdinEnded) return lineBuf ? (() => { const l = lineBuf.trim(); lineBuf = ''; return l; })() : null;
    return new Promise((resolve) => {
        const onData = (d) => {
            lineBuf += d;
            const line = take();
            if (line !== undefined) { cleanup(); resolve(line); }
        };
        const onEnd = () => { stdinEnded = true; cleanup(); const l = lineBuf.trim(); lineBuf = ''; resolve(l || null); };
        const cleanup = () => { process.stdin.off('data', onData); process.stdin.off('end', onEnd); process.stdin.pause(); };
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', onData);
        process.stdin.on('end', onEnd);
        process.stdin.resume();
    });
}

/** 从几个选项里选一个：输编号；直接回车 = 默认；q 取消（返回 null）。 */
async function choose(q, options, def = 0) {
    process.stdout.write(`\n  ${c.bold(q)}\n`);
    options.forEach((o, i) => process.stdout.write(`    ${c.key(String(i + 1))}  ${o}${i === def ? c.dim('（默认）') : ''}\n`));
    for (;;) {
        const a = await readLine(`  编号（回车 = ${def + 1}，q 取消）：`);
        if (a === null || /^q$/i.test(a)) return null;
        if (a === '') return def;
        const n = Number(a);
        if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
    }
}

async function main() {
    const plain = !process.stdin.isTTY || process.env.CCST_MENU_PLAIN === '1';
    if (!plain) emitKeypressEvents(process.stdin);
    let screen = 'home';
    const trail = []; // 从哪一层进来的：返回时回到上一层，不是一律回首页
    let sel = 0;
    let msg = '';
    for (;;) {
        const s = await readState();
        if (screen === 'guard' && OS === 'mac') { s.guardLatest = await latestGuard(); s.pullJob = pullJob(); }
        const view = screen === 'home' ? renderHome(s, sel, msg) : renderSub(s, screen, sel, msg);
        msg = '';
        if (!plain) process.stdout.write('\x1b[2J\x1b[H');
        process.stdout.write(view.text + '\n');

        let pressed;
        if (plain) {
            const line = await readLine('\n输入按键回车：');
            if (line === null) return 0;
            pressed = { str: line === '' ? '\r' : line, key: line === '' ? { name: 'return' } : {} };
        } else {
            process.stdin.setRawMode(true);
            process.stdin.resume();
            pressed = await readKey();
            process.stdin.setRawMode(false);
            process.stdin.pause();
        }
        const { str, key } = pressed;
        const k = String(str ?? '').toLowerCase();
        if (key.ctrl && key.name === 'c') return 0;
        if (k === 'q') return 0;
        if (k === 'h') { openHelp(); continue; }
        if (key.name === 'up') { sel = Math.max(0, sel - 1); continue; }
        if (key.name === 'down') { sel = Math.min(view.actions.length - 1, sel + 1); continue; }
        if (screen !== 'home' && (k === '0' || key.name === 'escape' || key.name === 'backspace' || key.name === 'left')) { screen = trail.pop() ?? 'home'; sel = 0; continue; }

        let item = null;
        if (key.name === 'return' || k === '\r') item = view.actions[sel] ?? null;
        else if (screen === 'home' && k === 'c' && phoneCode(s) && !macOnly()) {
            msg = copyToClipboard(phoneCode(s)) ? '已复制手机连接码' : '复制失败（没有 pbcopy？）';
            continue;
        }
        else if (screen === 'home' && /^[a-z]$/.test(k) && view.probs?.[probLetters(s).indexOf(k)]) {
            const p = view.probs[probLetters(s).indexOf(k)];
            if (p.sub) { trail.push(screen); screen = p.sub; sel = 0; continue; }
            if (!p.fix) { msg = p.fixLabel; continue; }
            item = { id: p.fix, label: p.fixLabel };
        } else item = view.actions.find((a) => a.key === k) ?? null;

        if (!item) { if (k.trim()) msg = `没有「${k}」这一项`; continue; }
        if (item.why) { msg = `${item.label.replace(/ >$/, '')}：${item.why}`; continue; }
        if (item.sub) { trail.push(screen); screen = item.sub; sel = 0; continue; }
        if (!plain) process.stdout.write('\x1b[2J\x1b[H');
        const err = await run(item.id, {
            ask: async (q) => /^y/i.test((await readLine(`  ${q} (y/N) `)) ?? ''),
            choose,
            pause: async () => { if (!plain) await readLine('\n按回车回到菜单…'); },
        });
        msg = err ? `${item.label.replace(/ >$/, '')}：${err}` : '';
        sel = screen === 'home' ? 0 : sel;
    }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('menu.mjs')) {
    main().then((code) => { process.stdout.write('\n'); process.exit(code ?? 0); });
}
