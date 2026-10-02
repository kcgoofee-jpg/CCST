#!/usr/bin/env node
// ──────────────────────────────────────────────
// CCST 酒馆工具：菜单（Mac / Windows / Termux 共用一份）
// ──────────────────────────────────────────────
//
// 各系统只留一个启动壳（mac/酒馆工具.command、windows/酒馆工具.bat），
// 菜单的分组、说明、问题判断都在这里；状态和不分系统的动作在 core.mjs（三个系统同一份）：
// 首页只放每天要用的：打开 App、手机、重启代理、检查状态；登录、修复、日志、TT 守护、生图、导入这些收在「更多」里（都还能用）。
// 手机是单独一页（连接码、二维码、开关都在那里），不是一串子菜单。
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
import { fileURLToPath } from 'node:url';
import { emitKeypressEvents } from 'node:readline';

import { ACTIONS, HERE, IS_TERMUX, MAC_ONLY, OS, VERSION, ago, clock, getJson, loadConfig, macOnly, newerVersion, readState, refreshLatest, restartRefusal } from './core.mjs';
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
    // 有新版本：只提醒（黄色），一键更新在 Mac 上；没问过 GitHub 或没网时没有这一条
    if (!macOnly() && newerVersion(s.latestVersion, VERSION)) {
        out.push({ text: `有新版本 v${s.latestVersion}（现在 v${VERSION}）`, fix: 'update', fixLabel: '更新' });
    }
    // 手机相关的提醒只在开着手机模式时出现：不用手机的人首页不该看到这些
    if (s.phoneMode && !macOnly()) {
        if (!s.watchdog) out.push({ text: '手机模式的守护没在运行', fix: 'phone-on', fixLabel: '修复' });
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
        primary: { id: 'start', label: s.proxy ? openLabel : `启动代理${withSt}`, note: s.proxy ? '' : '代理没开，先启动它' },
        rows: [[
            { key: '1', sub: 'phone', label: '手机', note: '连接码、二维码、开关', why },
        ], [
            { key: '2', id: 'restart', label: `重启代理${withSt}`, note: '改了设置、更新后用' },
        ], [
            { key: '3', id: 'check', label: '检查状态', note: '出问题先点这里' },
        ], [
            { key: '4', sub: 'more', label: '更多 >', note: '登录、修复、日志、开机启动…' },
        ]],
    };
    const more = {
        title: '更多',
        items: [
            { group: '账号和维护' },
            { id: 'login', label: '登录 Claude', note: !sub ? `现在用 ${s.backend.label}，不用登录` : s.loggedIn ? `已登录${s.plan ? `（${s.plan}）` : ''}` : '浏览器登录订阅，一般只要一次' },
            { id: 'update', label: '检查更新', note: newerVersion(s.latestVersion, VERSION) ? `有新版本 v${s.latestVersion}` : `现在 v${VERSION}，一键更新到最新版`, why },
            { id: 'repair', label: '修复依赖', note: '报「缺少依赖 / Cannot find module」时' },
            { id: 'logs', label: '打开日志', note: '出错时附上最后几十行求助' },
            { id: 'shortcut', label: '桌面快捷方式', note: '在桌面放一个双击就能打开酒馆工具的图标', why },
            { id: 'autostart-toggle', label: '开机自动启动', note: s.autostart ? '已开 · 开 / 关' : '没开 · 开 / 关' },
            { id: 'stop', label: `关闭代理${withSt}`, note: '聊天记录都已保存' },
            { group: '手机上的 TauriTavern' },
            { sub: 'guard', label: 'TT 守护 >', note: '手机上 TT 的备份和恢复', why },
            { id: 'lid', label: '合盖不睡', note: s.lidInstalled ? '已安装 · 装 / 卸' : '没安装 · 装 / 卸（输一次密码）', why },
            { group: '其他' },
            ...(mac && s.hasComfy ? [{ sub: 'comfy', label: '生图 >', note: '本地 ComfyUI' }] : []),
            ...(s.canTTImport ? [{ id: 'tt-import', label: '本机TT导入', note: '测试用：电脑酒馆 -> 这台 Mac 的 TauriTavern', why }] : []),
            { id: 'baibai-import', label: '柏宝绘配方导入', note: '把「提示词拆分」导出的配方写进酒馆和手机', why },
            { id: 'prompt-split', label: '提示词拆分', note: '打开本机网页工具', why },
        ],
    };
    // 按实际出现的项连续编号；h、q、x 留给说明、退出和手机页的开关
    const KEYS = [...'123456789abdefgijkmnoprstuvwyz'];
    let n = 0;
    for (const it of more.items) if (!it.group) it.key = KEYS[n++];
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
    return { home, more, guard, comfy };
}

/** 手机要填的代理地址：http://<这台 Mac 的局域网地址>:端口/v1；没有局域网地址时 ''。 */
export function phoneAddress(s) {
    return s.ip ? `http://${s.ip}:${s.port ?? 8901}/v1` : '';
}

/** 手机连接码：代理地址 + 访问密码合成一串，手机上整串粘贴（格式见 src/panel/core/connect-code.js）。没有地址或密码时 ''。 */
export function phoneCode(s) {
    return phoneAddress(s) && s.lanKey ? makeConnectCode(phoneAddress(s), s.lanKey) : '';
}

/** 首页上的问题用 a b c… 当按键。 */
export function probLetters() {
    return [...'abcdefghijklmnopqrstuvwxyz'];
}

/** 连接码的二维码（终端字符画，每行前空两格）。依赖没装好时返回 null，调用方只显示连接码。 */
export function qrLines(text) {
    try {
        let out = '';
        createRequire(import.meta.url)('qrcode-terminal').generate(text, { small: true }, (q) => { out = q; });
        return out.split('\n').filter(Boolean).map((l) => `  ${l}`);
    } catch {
        return null;
    }
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

/** 一句话：现在该做什么。有挡路的问题先说修它（带按键），都好了就说去哪儿用。 */
export function nextStep(s, probs = problems(s)) {
    const first = probs.find((p) => p.block && (p.fix || p.fixLabel)) ?? probs.find((p) => p.fix);
    if (first) {
        const key = probLetters()[probs.indexOf(first)];
        return first.fix ? `按 ${key}：${first.fixLabel}` : first.fixLabel;
    }
    const mac = !macOnly();
    const target = s.stManaged ? '酒馆' : s.hasTT || !mac ? 'TauriTavern' : '酒馆';
    return `去 ${target} 里用，面板点「一键连接」`;
}

/** 首页状态：第一行能不能玩；下一步；问题和修复键；酒馆在不在；手机模式一句话（连接码和二维码在「手机」页）。 */
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
    L.push(`  ${c.bold('下一步')}  ${nextStep(s, probs)}`);
    const w = Math.max(0, ...probs.map((p) => width(p.text))) + 2;
    const letters = probLetters();
    probs.forEach((p, i) => {
        const act = p.fix || p.sub ? `→ ${p.fixLabel}` : c.dim(p.fixLabel);
        L.push(`    ${c.key(letters[i])}  ${pad(p.text, w)}${act}`);
    });
    // 没配置酒馆（只用 TauriTavern 的人）：什么都不显示。
    if (s.hasST !== false) L.push(`  酒馆 ${s.stRunning ? `${c.ok('运行中')} · http://127.0.0.1:${s.stPort ?? 8000}` : c.dim('没运行')}`);
    if (!macOnly()) L.push(`  手机 ${s.phoneMode ? `${c.ok('已开启')} · 按 1 看连接码和二维码` : c.dim('没开 · 按 1 开启')}`);
    return L;
}

/** 「手机」页：模式状态、连接码、二维码、按键。rows = 终端高度，放不下二维码时不画，提示拉高窗口。 */
export function renderPhone(s, sel = -1, msg = '', rows = process.stdout.rows ?? 0) {
    const L = [...header('手机')];
    const code = phoneCode(s);
    const mode = s.phoneMode ? `已开启${s.watchdog ? '（守护中）' : '（守护没在运行）'}` : '没开';
    const link = ['none', 'noadb', undefined].includes(s.phone) ? '' : `  ·  ${phoneText(s)}`; // 没插手机、没装 adb 不用说
    L.push(`  手机模式：${s.phoneMode ? c.ok(mode) : c.dim(mode)}${link}`);
    if (s.phoneMode) {
        L.push('');
        if (!code) L.push(`  连接码：${c.dim('没找到局域网地址：确认 Wi-Fi 已连接')}`);
        else {
            L.push(`  连接码：${code}`);
            const qr = qrLines(code);
            const need = (qr?.length ?? 0) + L.length + 9;
            if (qr && (!rows || rows >= need)) L.push(...qr);
            else if (qr) L.push(`  ${c.dim(`（窗口再拉高一点就能显示二维码，至少 ${need} 行）`)}`);
            else L.push(`  ${c.dim('（二维码依赖没装好：在「更多」里选「修复依赖」；连接码照样能用）')}`);
            L.push(`  ${c.dim('手机上：TauriTavern → 扩展 → CCST → 粘贴连接码 → 连接；或扫码后点「复制连接码」')}`);
        }
    } else {
        L.push('', `  ${c.dim('开启后：同一 Wi-Fi 的手机用这台 Mac 的代理（要访问密码）；Mac 不空闲睡眠。')}`);
        L.push(`  ${c.dim('不要在公共 Wi-Fi（咖啡店、学校、公司）开启。')}`);
    }
    L.push(RULE);
    const items = [
        ...(code ? [{ key: 'c', special: 'copy', label: '复制连接码' }] : []),
        { key: 'x', special: 'toggle', label: s.phoneMode ? '关闭手机模式' : '开启手机模式' },
        { key: 's', id: 'phone-sync', label: '同步手机', note: '电脑 <-> 手机：先预览，拿不准的问你' },
        { key: 'l', id: 'lid', label: '合盖不睡', note: s.lidInstalled ? '已安装' : '没安装（输一次密码）' },
    ];
    items.forEach((it, i) => {
        const line = `   ${c.key(it.key)}  ${pad(it.label, 14)}${c.dim(it.note ?? '')}`;
        L.push(sel === i ? c.inv(line) : line);
    });
    L.push(RULE, `  ${c.dim(HINT_SUB)}`);
    if (msg) L.push('', `  ${note(msg)}`);
    return { text: L.join('\n'), actions: items };
}

// ── 执行动作 ──

// 各系统还留在自己脚本里的动作
const WIN_ACTIONS = { login: 'login', repair: 'repair', logs: 'logs', 'autostart-toggle': 'autostart' };
const TERMUX_ACTIONS = { start: 'start', stop: 'stop', restart: 'restart', login: 'login', logs: 'logs' };
const MAC_SHELL = new Set(['start', 'stop', 'restart', 'phone-on', 'phone-off']);

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
            process.stdout.write(`\n  ${c.bad('✗')} 出错了：${String(err?.message ?? err).split('\n')[0]}\n  ${c.dim('可以在「更多 > 打开日志」里找到详情。')}\n`);
        }
        process.stdout.write(code === 0 ? `\n  ${c.ok('✓ 完成')}\n` : `\n  ${c.bad(`✗ 没有成功（退出码 ${code}）`)}\n`);
        await io.pause();
        return code === 0 ? null : `没有成功（退出码 ${code}）`;
    }
    const env = { ...process.env, CM_MENU: '1' };
    let r;
    if (OS === 'mac') {
        // 「手机」页里已经确认过：开 / 关手机模式直接带着答案进脚本
        if (id === 'phone-on' || id === 'phone-off') env.CM_PHONE_ACTION = id.slice(6);
        const f = join(HERE, 'mac', 'actions', `${id === 'phone-on' || id === 'phone-off' ? 'phone-mode' : id}.zsh`);
        if (!existsSync(f)) return `找不到动作脚本 ${id}`;
        r = spawnSync('/bin/zsh', [f], { stdio: 'inherit', env });
        // 更新把菜单自己的代码也换了：磁盘上的版本变了，就用新代码重开菜单（旧的这个进程还是旧代码）
        if (id === 'update' && r.status === 0 && diskVersion() !== VERSION) {
            const next = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { stdio: 'inherit', env: process.env });
            process.exit(next.status ?? 0);
        }
    } else if (OS === 'win') {
        if (!WIN_ACTIONS[id]) return `「${id}」${MAC_ONLY}`;
        r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'windows', 'claude-max.ps1'), WIN_ACTIONS[id]], { stdio: 'inherit', env });
    } else {
        if (!TERMUX_ACTIONS[id] || !IS_TERMUX) return `「${id}」${MAC_ONLY}`;
        r = spawnSync('bash', [join(HERE, 'termux', 'claude-max.sh'), TERMUX_ACTIONS[id]], { stdio: 'inherit', env });
    }
    return r.status === 0 ? null : `没有成功（退出码 ${r.status ?? r.signal}）`;
}

function diskVersion() {
    try { return JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version; } catch { return VERSION; }
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
    L.push(`  ${mark(0, `${c.key('回车')}  ${pad(home.primary.label, 14)}${c.dim(home.primary.note ?? '')}`)}`);
    let i = 1;
    for (const it of home.rows.flat()) {
        L.push('  ' + mark(i++, `${it.why ? c.dim(it.key) : c.key(it.key)}     ${pad(it.label, 14)}${c.dim(it.why ?? it.note ?? '')}`).trimEnd());
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
    // 状态探测不便宜（几个 HTTP 请求 + 一个脚本，连着手机还有 adb）：方向键、说明这类不改状态的按键不重新采集，最多隔 5 秒；
    // 进出页面、执行完动作后一定刷新
    let s = null;
    let sAt = 0;
    let dirty = true;
    // 后台问一次 GitHub 有没有新版本（缓存 12 小时）；问到了有新的，下一次刷新就会在首页提醒
    if (OS === 'mac') void refreshLatest().then((v) => { if (newerVersion(v, VERSION)) dirty = true; });
    for (;;) {
        if (dirty || !s || Date.now() - sAt > 5000) {
            s = await readState();
            if (screen === 'guard' && OS === 'mac') { s.guardLatest = await latestGuard(); s.pullJob = pullJob(); }
            sAt = Date.now();
            dirty = false;
        }
        const view = screen === 'home' ? renderHome(s, sel, msg) : screen === 'phone' ? renderPhone(s, sel, msg) : renderSub(s, screen, sel, msg);
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
        if (screen !== 'home' && (k === '0' || key.name === 'escape' || key.name === 'backspace' || key.name === 'left' || (screen === 'phone' && key.name === 'return'))) { screen = trail.pop() ?? 'home'; sel = 0; dirty = true; continue; }

        let item = null;
        if (key.name === 'return' || k === '\r') item = view.actions[sel] ?? null;
        else if (screen === 'home' && /^[a-z]$/.test(k) && view.probs?.[probLetters().indexOf(k)]) {
            const p = view.probs[probLetters().indexOf(k)];
            if (p.sub) { trail.push(screen); screen = p.sub; sel = 0; dirty = true; continue; }
            if (!p.fix) { msg = p.fixLabel; continue; }
            item = { id: p.fix, label: p.fixLabel };
        } else item = view.actions.find((a) => a.key === k) ?? null;

        if (!item) { if (k.trim()) msg = `没有「${k}」这一项`; continue; }
        if (item.why) { msg = `${item.label.replace(/ >$/, '')}：${item.why}`; continue; }
        if (item.sub) { trail.push(screen); screen = item.sub; sel = 0; dirty = true; continue; }
        if (item.special === 'copy') {
            msg = copyToClipboard(phoneCode(s)) ? '已复制手机连接码' : '复制失败（没有 pbcopy？）';
            continue;
        }
        if (item.special === 'toggle') {
            const on = !!s.phoneMode;
            if (!plain) process.stdout.write('\x1b[2J\x1b[H');
            if (on) {
                process.stdout.write(`\n  关闭后手机连不上这个代理，Mac 恢复正常睡眠。\n\n`);
            } else {
                process.stdout.write([
                    '',
                    '  开启手机模式：',
                    '  · 同一 Wi-Fi 的手机带访问密码就能用你的订阅；',
                    '  · Mac 不会空闲睡眠，代理掉了会自动重启；',
                    '  · 开启时代理会重启一次，Mac 可能弹出「是否允许 node 接受传入的网络连接」，请点「允许」。',
                    '  · 不要在公共 Wi-Fi（咖啡店、学校、公司）开启；密码别发给别人。',
                    '', ''].join('\n'));
            }
            const yes = /^y/i.test((await readLine(`  ${on ? '关闭' : '开启'}手机模式吗？ (y/N) `)) ?? '');
            if (!yes) { msg = '没有改动'; continue; }
            const err = await run(on ? 'phone-off' : 'phone-on', {
                ask: async (q) => /^y/i.test((await readLine(`  ${q} (y/N) `)) ?? ''),
                choose,
                pause: async () => {},
            });
            msg = err ? `手机模式：${err}` : '';
            dirty = true;
            continue;
        }
        if (!plain) process.stdout.write('\x1b[2J\x1b[H');
        const err = await run(item.id, {
            ask: async (q) => /^y/i.test((await readLine(`  ${q} (y/N) `)) ?? ''),
            choose,
            pause: async () => { if (!plain) await readLine('\n按回车回到菜单…'); },
        });
        msg = err ? `${item.label.replace(/ >$/, '')}：${err}` : '';
        sel = screen === 'home' ? 0 : sel;
        dirty = true;
    }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('menu.mjs')) {
    main().then((code) => { process.stdout.write('\n'); process.exit(code ?? 0); });
}
