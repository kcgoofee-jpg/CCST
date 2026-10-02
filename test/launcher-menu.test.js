import { test } from 'node:test';
import assert from 'node:assert/strict';

import { width, pad, problems, renderHome, renderPhone, screens, statusLines, nextStep, phoneCode, probLetters, copyToClipboard } from '../launcher/menu.mjs';
import { macOnly } from '../launcher/core.mjs';

const base = {
    proxy: true, proxyVersion: null, loggedIn: true, plan: 'Max', busy: 0, phoneMode: false, watchdog: false,
    lidInstalled: false, lidOn: false, ip: '', phone: 'none', lastSync: null, hubLabel: 'Mac TT', stManaged: false,
    stRunning: false, hasTT: true, macTTRunning: false, hasComfy: false, comfyRunning: false, hasModule: false,
    canTTImport: false, autostart: false, backend: { id: 'subscription', label: '订阅', missing: [] }, proxyVersion: null, phoneTT: null,
    lastSyncAt: null,
};
const mac = process.platform === 'darwin';

test('display width counts CJK as two columns and ignores colour codes', () => {
    assert.equal(width('abc'), 3);
    assert.equal(width('手机同步'), 8);
    assert.equal(width('\x1b[32m运行中\x1b[0m'), 6);
    assert.equal(width(pad('代理', 6)), 6);
});

test('problems: proxy down first, each with a fix', () => {
    assert.deepEqual(problems(base), []);
    const down = problems({ ...base, proxy: false });
    assert.equal(down.length, 1);
    assert.equal(down[0].fix, 'start');
    assert.equal(problems({ ...base, loggedIn: false })[0].fix, 'login');
    // not logged in is not reported while the proxy is down (can't tell yet)
    assert.equal(problems({ ...base, proxy: false, loggedIn: null }).length, 1);
});

test('problems: an outdated running proxy asks for a restart', () => {
    const p = problems({ ...base, proxyVersion: '0.0.1' });
    assert.equal(p.length, 1);
    assert.equal(p[0].fix, 'restart');
});

test('home: Enter starts when the proxy is down, opens when it runs', () => {
    assert.match(screens({ ...base, proxy: false }).home.primary.label, /启动/);
    assert.match(screens(base).home.primary.label, /打开/);
});

test('image-generation group only when ComfyUI is installed (macOS)', () => {
    const keys = (s) => screens(s).more.items.map((i) => i.sub).filter(Boolean);
    if (process.platform === 'darwin') {
        assert.ok(!keys(base).includes('comfy'));
        assert.ok(keys({ ...base, hasComfy: true }).includes('comfy'));
    } else {
        assert.ok(!keys({ ...base, hasComfy: true }).includes('comfy'));
    }
});

test('phone page: the toggle flips with the mode; copy only when there is a code', () => {
    const keys = (s) => renderPhone(s, -1, '', 60).actions.map((i) => i.key);
    const toggle = (s) => renderPhone(s, -1, '', 60).actions.find((i) => i.special === 'toggle').label;
    assert.equal(toggle(base), '开启手机模式');
    assert.equal(toggle({ ...base, phoneMode: true }), '关闭手机模式');
    assert.deepEqual(keys(base), ['x', 's', 'l']);
    assert.deepEqual(keys({ ...base, phoneMode: true, ip: '10.0.0.2', port: 8901, lanKey: 'k' }), ['c', 'x', 's', 'l']);
});

test('problems: other backends need no login but need their settings', () => {
    const api = { ...base, loggedIn: false, backend: { id: 'apikey', label: 'API 密钥', missing: [] } };
    assert.deepEqual(problems(api), []);
    const p = problems({ ...api, backend: { ...api.backend, missing: ['apikey.apiKey'] } });
    assert.equal(p.length, 1);
    assert.equal(p[0].block, true);
});

test('problems: TT guard restoring / unfinished restore on the phone', () => {
    if (!mac) return;
    assert.match(problems({ ...base, phoneMode: true, watchdog: true, phoneTT: { restoring: true } })[0].text, /正在恢复/);
    const p = problems({ ...base, phoneMode: true, watchdog: true, phoneTT: { restorePending: true } })[0];
    assert.equal(p.sub, 'guard');
    assert.equal(p.block, undefined);   // 不影响玩
    // 没开手机模式：这些提醒不出现在首页
    assert.deepEqual(problems({ ...base, phoneTT: { restoring: true } }), []);
});

test('home: can-play line, next step, SillyTavern line, phone line (mac only)', () => {
    const st = { ...base, stRunning: true, stPort: 8000, hasST: true };
    const ok = statusLines(st);
    assert.equal(ok.length, mac ? 4 : 3);
    assert.match(ok[0], /● 可以玩 +代理 \? · 订阅 · 已登录（Max）/);
    assert.match(ok[1], /下一步 +去 .+ 里用，面板点「一键连接」/);
    assert.match(ok[2], /酒馆 运行中 · http:\/\/127\.0\.0\.1:8000/);
    if (mac) assert.match(ok[3], /手机 +没开 · 按 1 开启/);
    assert.match(statusLines({ ...st, stRunning: false })[2], /酒馆 没运行/);
    assert.ok(!statusLines({ ...st, hasST: false }).join('\n').includes('酒馆 '), 'TT-only: no ST line');
    const down = statusLines({ ...st, proxy: false });
    assert.match(down[0], /● 还不能玩 +代理没运行/);
    assert.match(down[1], /下一步 +按 a：启动代理/);
    assert.match(down[2], /a  代理没在运行 +→ 启动代理/);
    assert.match(down[3], /酒馆/);
    if (mac) assert.match(statusLines({ ...st, phoneMode: true, watchdog: true })[3], /手机 +已开启 · 按 1 看连接码和二维码/);
    // 连接码和二维码不在首页
    assert.ok(!statusLines({ ...st, phoneMode: true, ip: '10.0.0.2', port: 8901, lanKey: 'Kx9mPq2' }).join('\n').match(/Kx9mPq2|▀|█/));
});

test('nextStep: fix the blocker first, otherwise say where to go', () => {
    assert.match(nextStep({ ...base, proxy: false }), /按 a：启动代理/);
    assert.match(nextStep({ ...base, loggedIn: false }), /按 a：登录/);
    assert.match(nextStep({ ...base, proxyVersion: '0.0.1' }), /按 a：重启代理/);
    assert.match(nextStep(base), /去 .+ 里用/);
    assert.match(nextStep({ ...base, stManaged: true }), /去 酒馆 里用/);
});

test('home menu tree: Enter / 1 phone / 2 restart / 3 check / 4 more', () => {
    const home = renderHome(base);
    assert.match(home.text, /CCST 酒馆工具 v\d+\.\d+/);
    assert.match(home.text, /回车  打开 TT/);
    assert.deepEqual(home.actions.map((a) => a.key ?? 'enter'), ['enter', '1', '2', '3', '4']);
    assert.deepEqual(home.actions.map((a) => a.id ?? a.sub), ['start', 'phone', 'restart', 'check', 'more']);
    // login moved into 更多; TT guard / sync are not on the home page
    assert.ok(!home.actions.some((a) => ['login', 'phone-sync', 'guard'].includes(a.id ?? a.sub)));
});

test('home fits an 80x24 terminal in every state (<= 22 lines)', () => {
    const states = [
        base,
        { ...base, proxy: false },
        { ...base, loggedIn: false, proxyVersion: '0.0.1', phoneMode: true, watchdog: false },
        { ...base, phoneMode: true, ip: '10.0.0.2', port: 8901, lanKey: 'k', stRunning: true, hasST: true },
    ];
    for (const s of states) assert.ok(renderHome(s, -1, '检查状态：没有成功（退出码 1）').text.split('\n').length <= 22);
});

test('更多: login, repair, logs, autostart, stop — then TT guard, lid, and the import tools; keys are unique and skip h / q / x', () => {
    const items = screens({ ...base, hasComfy: true, canTTImport: true }).more.items.filter((i) => !i.group);
    assert.deepEqual(items.map((i) => i.sub ?? i.id), mac
        ? ['login', 'repair', 'logs', 'autostart-toggle', 'stop', 'guard', 'lid', 'comfy', 'tt-import', 'baibai-import', 'prompt-split']
        : ['login', 'repair', 'logs', 'autostart-toggle', 'stop', 'guard', 'lid', 'tt-import', 'baibai-import', 'prompt-split']);
    const keys = items.map((i) => i.key);
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(!keys.some((k) => ['h', 'q', 'x', '0'].includes(k)));
    assert.deepEqual(keys.slice(0, 9), [...'123456789']);
    assert.ok(!screens(base).more.items.some((i) => i.id === 'tt-import'), 'nothing to import: no entry');
});

test('TT guard screen: version vs latest, auto pull, KernelSU hint', () => {
    const g = screens({ ...base, phone: 'usb', hasModule: true, guardLatest: '2.0', pullJob: { installed: true },
        phoneTT: { guardVersion: '1.9', guardLastBackup: null } }).guard;
    assert.deepEqual(g.items.map((i) => i.id), ['guard-status', 'guard-pull', 'guard-auto', 'guard-restore']);
    if (mac) {
        assert.match(g.note[0], /手机上 1\.9 · 有新版本 2\.0：在 KernelSU 里更新/);
        assert.match(g.note[1], /电脑自动拉备份 开着/);
        assert.match(g.note[2], /KernelSU → 模块 → TT 守护/);
        assert.equal(screens({ ...base, phone: 'none' }).guard.items[3].why, '手机没连');
    } else {
        assert.ok(g.items.every((i) => i.why));
    }
});

test('home: key columns are CJK-aware and every line fits the rule width', () => {
    const { text } = renderHome(base, -1, '检查状态：没有成功（退出码 1）');
    for (const line of text.split('\n')) assert.ok(width(line) <= 60, line);
    assert.match(text, /✗ 检查状态：没有成功/);
    assert.match(text, /h 说明 · q 退出/);
});

test('phone page (phone mode on): code once, QR when the window is tall enough, a hint when it is not', { skip: macOnly() }, () => {
    const s = { ...base, phoneMode: true, watchdog: true, ip: '192.168.31.7', port: 8901, lanKey: 'Kx9mPq2', stRunning: false };
    assert.equal(phoneCode(s), 'http://192.168.31.7:8901/v1#k=Kx9mPq2');
    const tall = renderPhone(s, -1, '', 60).text;
    assert.match(tall, /连接码：http:\/\/192\.168\.31\.7:8901\/v1#k=Kx9mPq2/);
    assert.equal(tall.split('Kx9mPq2').length - 1, 1);
    assert.match(tall, /▀|▄|█/, 'QR code shown');
    assert.ok(tall.split('\n').length <= 32);
    const short = renderPhone(s, -1, '', 20).text;
    assert.ok(!/▀|▄|█/.test(short));
    assert.match(short, /窗口再拉高一点就能显示二维码，至少 \d+ 行/);
    assert.match(short, /连接码：http/);
    // 关着的时候只有说明，没有码
    const off = renderPhone({ ...base, ip: '192.168.31.7', port: 8901, lanKey: 'Kx9mPq2' }, -1, '', 60).text;
    assert.ok(!off.includes('Kx9mPq2'));
    assert.match(off, /不要在公共 Wi-Fi/);
});

test('phone page: no LAN address or no key = no copyable code', () => {
    assert.equal(phoneCode({ ...base, phoneMode: true, ip: '', lanKey: 'k' }), '');
    assert.equal(phoneCode({ ...base, phoneMode: true, ip: '10.0.0.2', lanKey: '' }), '');
    assert.match(renderPhone({ ...base, phoneMode: true, ip: '' }, -1, '', 60).text, /连接码：.*没找到局域网地址/);
});

test('problem letters are plain a b c…', () => {
    assert.deepEqual(probLetters().slice(0, 4), ['a', 'b', 'c', 'd']);
});

test('copyToClipboard: pbcopy gets the text on stdin, never in the arguments', () => {
    const calls = [];
    assert.equal(copyToClipboard('secret-code', (cmd, args, opts) => { calls.push([cmd, args, opts.input]); return { status: 0 }; }), true);
    assert.deepEqual(calls, [['pbcopy', [], 'secret-code']]);
    assert.equal(copyToClipboard('x', () => { throw new Error('no pbcopy'); }), false);
});
