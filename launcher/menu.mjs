#!/usr/bin/env node
// ──────────────────────────────────────────────
// CCST 酒馆工具：菜单（Windows / Termux 共用一份）
// ──────────────────────────────────────────────
//
// 各系统只留一个启动壳（windows/酒馆工具.bat），
// 菜单的分组、说明、问题判断都在这里；状态和不分系统的动作在 core.mjs：
// 首页只放每天要用的：打开酒馆、重启代理、检查状态；登录、修复、日志、开机启动这些收在「更多」里。
//   检查状态                      都用 core.mjs
//   启动 / 关闭 / 重启            Windows、Linux 用 core.mjs；Termux 用 termux/claude-max.sh（代理在 Debian 子系统里）
//   其余（登录、修复、日志…）     Windows windows/claude-max.ps1 <动作>；Termux termux/claude-max.sh <动作>
// 不依赖任何 npm 包：依赖坏了的时候（菜单里正好有「修复依赖」）也要能打开。
//
// 按键：数字 / 字母直接执行；↑↓ 选、回车执行；0、Esc 返回；h 说明；q 退出。
// 不是终端（管道、测试）时退回「输入编号回车」。CCST_MENU_PLAIN=1 也强制用这种方式。

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emitKeypressEvents } from 'node:readline';

import { ACTIONS, HERE, IS_TERMUX, OS, VERSION, readState } from './core.mjs';

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
    return out;
}

/** 一个菜单项：key 按键、id 动作、sub 子菜单、label 名字、note 说明；why 有值时灰着显示原因。 */
export function screens(s) {
    const openLabel = s.stManaged ? '打开酒馆' : '打开 TT';
    const withSt = s.stManaged ? '和酒馆' : '';
    const sub = (s.backend?.id ?? 'subscription') === 'subscription';
    const home = {
        title: '首页',
        primary: { id: 'start', label: s.proxy ? openLabel : `启动代理${withSt}`, note: s.proxy ? '' : '代理没开，先启动它' },
        rows: [[
            { key: '1', id: 'restart', label: `重启代理${withSt}`, note: '改了设置、更新后用' },
        ], [
            { key: '2', id: 'check', label: '检查状态', note: '出问题先点这里' },
        ], [
            { key: '3', sub: 'more', label: '更多 >', note: '登录、修复、日志、开机启动…' },
        ]],
    };
    const more = {
        title: '更多',
        items: [
            { group: '账号和维护' },
            { id: 'login', label: '登录 Claude', note: !sub ? `现在用 ${s.backend.label}，不用登录` : s.loggedIn ? `已登录${s.plan ? `（${s.plan}）` : ''}` : '浏览器登录订阅，一般只要一次' },
            { id: 'repair', label: '修复依赖', note: '报「缺少依赖 / Cannot find module」时' },
            { id: 'logs', label: '打开日志', note: '出错时附上最后几十行求助' },
            { id: 'autostart-toggle', label: '开机自动启动', note: s.autostart ? '已开 · 开 / 关' : '没开 · 开 / 关' },
            { id: 'stop', label: `关闭代理${withSt}`, note: '聊天记录都已保存' },
        ],
    };
    // 按实际出现的项连续编号；h、q 留给说明和退出
    const KEYS = [...'123456789abdefgijkmnoprstuvwyz'];
    let n = 0;
    for (const it of more.items) if (!it.group) it.key = KEYS[n++];
    return { home, more };
}

/** 首页上的问题用 a b c… 当按键。 */
export function probLetters() {
    return [...'abcdefghijklmnopqrstuvwxyz'];
}

/** 一句话：现在该做什么。有挡路的问题先说修它（带按键），都好了就说去哪儿用。 */
export function nextStep(s, probs = problems(s)) {
    const first = probs.find((p) => p.block && (p.fix || p.fixLabel)) ?? probs.find((p) => p.fix);
    if (first) {
        const key = probLetters()[probs.indexOf(first)];
        return first.fix ? `按 ${key}：${first.fixLabel}` : first.fixLabel;
    }
    const target = s.stManaged ? '酒馆' : 'TauriTavern';
    return `去 ${target} 里用，面板点「一键连接」`;
}

/** 首页状态：第一行能不能玩；下一步；问题和修复键；酒馆在不在。 */
export function statusLines(s, probs = problems(s)) {
    const blocked = probs.some((p) => p.block);
    const head = blocked ? c.bad('● 还不能玩') : probs.length ? c.warn('● 可以玩') : c.ok('● 可以玩');
    const facts = [];
    if (!s.proxy) facts.push('代理没运行');
    else {
        facts.push(`代理 ${s.proxyVersion ?? '?'}`);
        if (s.backend) facts.push(s.backend.label);
        if ((s.backend?.id ?? 'subscription') === 'subscription') facts.push(s.loggedIn ? `已登录${s.plan ? `（${s.plan}）` : ''}` : '没登录');
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
    return L;
}

// ── 执行动作 ──

// 各系统还留在自己脚本里的动作
const WIN_ACTIONS = { login: 'login', repair: 'repair', logs: 'logs', 'autostart-toggle': 'autostart' };
const TERMUX_ACTIONS = { start: 'start', stop: 'stop', restart: 'restart', login: 'login', logs: 'logs' };
const UNSUPPORTED = '这个系统上没有';

/** 这个动作在这个系统上由 Node（core.mjs）做（返回动作函数）还是交给系统脚本（返回 null）。 */
export function nodeAction(id, os = OS, termux = IS_TERMUX) {
    if (!ACTIONS[id]) return null;
    if (id === 'check') return ACTIONS.check;
    if (termux) return null;
    return ACTIONS[id];
}

async function run(id, io) {
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
    if (OS === 'win') {
        if (!WIN_ACTIONS[id]) return `「${id}」${UNSUPPORTED}`;
        r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'windows', 'claude-max.ps1'), WIN_ACTIONS[id]], { stdio: 'inherit', env });
    } else {
        if (!TERMUX_ACTIONS[id] || !IS_TERMUX) return `「${id}」${UNSUPPORTED}`;
        r = spawnSync('bash', [join(HERE, 'termux', 'claude-max.sh'), TERMUX_ACTIONS[id]], { stdio: 'inherit', env });
    }
    return r.status === 0 ? null : `没有成功（退出码 ${r.status ?? r.signal}）`;
}

function openHelp() {
    const f = join(HERE, '使用说明.txt');
    if (OS === 'win') spawnSync('cmd', ['/c', 'start', '', f]);
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
    // 状态探测不便宜（几个 HTTP 请求）：方向键、说明这类不改状态的按键不重新采集，最多隔 5 秒；
    // 进出页面、执行完动作后一定刷新
    let s = null;
    let sAt = 0;
    let dirty = true;
    for (;;) {
        if (dirty || !s || Date.now() - sAt > 5000) {
            s = await readState();
            sAt = Date.now();
            dirty = false;
        }
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
        if (screen !== 'home' && (k === '0' || key.name === 'escape' || key.name === 'backspace' || key.name === 'left')) { screen = trail.pop() ?? 'home'; sel = 0; dirty = true; continue; }

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
