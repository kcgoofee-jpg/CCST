import { test } from 'node:test';
import assert from 'node:assert/strict';

import { width, pad, problems, renderHome, screens, statusLines, phoneCode, probLetters, copyToClipboard } from '../launcher/menu.mjs';
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
    const keys = (s) => screens(s).other.items.map((i) => i.sub).filter(Boolean);
    if (process.platform === 'darwin') {
        assert.ok(!keys(base).includes('comfy'));
        assert.ok(keys({ ...base, hasComfy: true }).includes('comfy'));
    } else {
        assert.ok(!keys({ ...base, hasComfy: true }).includes('comfy'));
    }
});

test('phone mode item flips its label with the mode', () => {
    const item = (s) => screens(s).phone.items.find((i) => i.id === 'phone-mode');
    assert.match(item(base).label, /切到手机模式/);
    assert.match(item({ ...base, phoneMode: true }).label, /切到电脑模式/);
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

test('home: line 1 can-play, line 2 SillyTavern; phone lines only in phone mode', () => {
    const st = { ...base, stRunning: true, stPort: 8000, hasST: true };
    const ok = statusLines(st);
    assert.equal(ok.length, 2);
    assert.match(ok[0], /● 可以玩 +代理 \? · 订阅 · 已登录（Max）/);
    assert.match(ok[1], /酒馆 运行中 · http:\/\/127\.0\.0\.1:8000/);
    assert.match(statusLines({ ...st, stRunning: false })[1], /酒馆 没运行/);
    assert.ok(!statusLines({ ...st, hasST: false }).join('\n').includes('酒馆'), 'TT-only: no ST line');
    const down = statusLines({ ...st, proxy: false });
    assert.match(down[0], /● 还不能玩 +代理没运行/);
    assert.match(down[1], /a  代理没在运行 +→ 启动代理/);
    assert.match(down[2], /酒馆/);
    const phoneMode = statusLines({ ...st, phoneMode: true, watchdog: true, macTTRunning: true, phone: 'usb', lastSyncAt: new Date(Date.now() - 2 * 3600e3),
        phoneTT: { ttRunning: true, generating: true, root: true, guardVersion: '1.9', guardLastBackup: new Date() } });
    if (mac) {
        assert.match(phoneMode[2], /手机连接码：/);
        assert.ok(!phoneMode.join('\n').match(/Mac TT|上次同步|TT 守护/), 'no advanced phone status on home');
    } else {
        assert.equal(phoneMode.length, 2);
    }
});

test('home menu tree: Enter / 1 restart / 2 check / 3 login / 4 maintenance / 5 other', () => {
    const home = renderHome(base);
    assert.match(home.text, /CCST 酒馆工具 v\d+\.\d+/);
    assert.match(home.text, /回车  打开 TT/);
    assert.deepEqual(home.actions.map((a) => a.key ?? 'enter'), ['enter', '1', '2', '3', '4', '5']);
    assert.deepEqual(home.actions.map((a) => a.id ?? a.sub), ['start', 'restart', 'check', 'login', 'maint', 'other']);
    // phone / TT guard / sync are no longer on the home page
    assert.ok(!home.actions.some((a) => ['phone-sync', 'phone', 'guard'].includes(a.id ?? a.sub)));
});

test('maintenance: repair, logs, autostart, stop — login moved home', () => {
    const ids = screens(base).maint.items.map((i) => i.id);
    assert.deepEqual(ids, ['repair', 'logs', 'autostart-toggle', 'stop']);
});

test('other: phone / TT guard / (ComfyUI) submenus and the import tools, numbered in order', () => {
    const o = screens({ ...base, hasComfy: true, canTTImport: true }).other.items.filter((i) => !i.group);
    if (mac) {
        assert.deepEqual(o.map((i) => i.sub ?? i.id), ['phone', 'guard', 'comfy', 'tt-import', 'baibai-import', 'prompt-split']);
        assert.ok(o.every((i) => !i.why));
    } else {
        assert.deepEqual(o.map((i) => i.sub ?? i.id), ['phone', 'guard', 'tt-import', 'baibai-import', 'prompt-split']);
        assert.ok(o.every((i) => i.why === '只支持 Mac'));
    }
    assert.deepEqual(o.map((i) => i.key), o.map((_, i) => String(i + 1)));
    // no TauriTavern import when there is nothing to import
    assert.ok(!screens(base).other.items.some((i) => i.id === 'tt-import'));
    // phone submenu keeps mode, sync and lid
    assert.deepEqual(screens(base).phone.items.filter((i) => !i.group).map((i) => i.id), ['phone-sync', 'phone-mode', 'lid']);
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

test('home (phone mode on): shows 「手机连接码：<地址>#k=<密码>」 and a c key to copy it; the code is never on other lines', { skip: macOnly() }, () => {
    const s = { ...base, phoneMode: true, watchdog: true, ip: '192.168.31.7', port: 8901, lanKey: 'Kx9mPq2', stRunning: false };
    assert.equal(phoneCode(s), 'http://192.168.31.7:8901/v1#k=Kx9mPq2');
    const lines = statusLines(s);
    const line = lines.find((l) => l.includes('手机连接码'));
    assert.match(line, /手机连接码：http:\/\/192\.168\.31\.7:8901\/v1#k=Kx9mPq2$/);
    assert.ok(lines.some((l) => /\bc\b.*复制连接码/.test(l)));
    assert.equal(lines.filter((l) => l.includes('Kx9mPq2')).length, 1);
    assert.ok(lines.some((l) => /▀|▄|█/.test(l)), 'QR code shown');
    assert.ok(renderHome(s).text.includes('手机连接码：http://192.168.31.7:8901/v1#k=Kx9mPq2'));
});

test('home: no 连接码 line in computer mode; no LAN address or no key = no copyable code', () => {
    assert.ok(!statusLines(base).join('\n').includes('手机连接码'));
    assert.equal(phoneCode({ ...base, phoneMode: true, ip: '', lanKey: 'k' }), '');
    assert.equal(phoneCode({ ...base, phoneMode: true, ip: '10.0.0.2', lanKey: '' }), '');
    if (!macOnly()) assert.match(statusLines({ ...base, phoneMode: true, ip: '' }).join('\n'), /手机连接码：.*没找到局域网地址/);
});

test('problem letters skip c while the copy key is on the home screen', () => {
    assert.deepEqual(probLetters(base).slice(0, 3), ['a', 'b', 'c']);
    if (!macOnly()) assert.deepEqual(probLetters({ ...base, phoneMode: true, ip: '10.0.0.2', port: 8901, lanKey: 'k' }).slice(0, 3), ['a', 'b', 'd']);
});

test('copyToClipboard: pbcopy gets the text on stdin, never in the arguments', () => {
    const calls = [];
    assert.equal(copyToClipboard('secret-code', (cmd, args, opts) => { calls.push([cmd, args, opts.input]); return { status: 0 }; }), true);
    assert.deepEqual(calls, [['pbcopy', [], 'secret-code']]);
    assert.equal(copyToClipboard('x', () => { throw new Error('no pbcopy'); }), false);
});
