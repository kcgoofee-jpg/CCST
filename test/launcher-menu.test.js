import { test } from 'node:test';
import assert from 'node:assert/strict';

import { width, pad, problems, renderHome, screens, statusLines, nextStep, probLetters } from '../launcher/menu.mjs';

const base = {
    proxy: true, proxyVersion: null, loggedIn: true, plan: 'Max', stManaged: false,
    stRunning: false, autostart: false, backend: { id: 'subscription', label: '订阅', missing: [] },
};

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

test('problems: other backends need no login but need their settings', () => {
    const api = { ...base, loggedIn: false, backend: { id: 'apikey', label: 'API 密钥', missing: [] } };
    assert.deepEqual(problems(api), []);
    const p = problems({ ...api, backend: { ...api.backend, missing: ['apikey.apiKey'] } });
    assert.equal(p.length, 1);
    assert.equal(p[0].block, true);
});

test('home: can-play line, next step, SillyTavern line', () => {
    const st = { ...base, stRunning: true, stPort: 8000, hasST: true };
    const ok = statusLines(st);
    assert.equal(ok.length, 3);
    assert.match(ok[0], /● 可以玩 +代理 \? · 订阅 · 已登录（Max）/);
    assert.match(ok[1], /下一步 +去 .+ 里用，面板点「一键连接」/);
    assert.match(ok[2], /酒馆 运行中 · http:\/\/127\.0\.0\.1:8000/);
    assert.match(statusLines({ ...st, stRunning: false })[2], /酒馆 没运行/);
    assert.ok(!statusLines({ ...st, hasST: false }).join('\n').includes('酒馆 '), 'TT-only: no ST line');
    const down = statusLines({ ...st, proxy: false });
    assert.match(down[0], /● 还不能玩 +代理没运行/);
    assert.match(down[1], /下一步 +按 a：启动代理/);
    assert.match(down[2], /a  代理没在运行 +→ 启动代理/);
    assert.match(down[3], /酒馆/);
});

test('nextStep: fix the blocker first, otherwise say where to go', () => {
    assert.match(nextStep({ ...base, proxy: false }), /按 a：启动代理/);
    assert.match(nextStep({ ...base, loggedIn: false }), /按 a：登录/);
    assert.match(nextStep({ ...base, proxyVersion: '0.0.1' }), /按 a：重启代理/);
    assert.match(nextStep(base), /去 .+ 里用/);
    assert.match(nextStep({ ...base, stManaged: true }), /去 酒馆 里用/);
});

test('home menu tree: Enter / 1 restart / 2 check / 3 more', () => {
    const home = renderHome(base);
    assert.match(home.text, /CCST 酒馆工具 v\d+\.\d+/);
    assert.match(home.text, /回车  打开 TT/);
    assert.deepEqual(home.actions.map((a) => a.key ?? 'enter'), ['enter', '1', '2', '3']);
    assert.deepEqual(home.actions.map((a) => a.id ?? a.sub), ['start', 'restart', 'check', 'more']);
    // login lives in 更多
    assert.ok(!home.actions.some((a) => (a.id ?? a.sub) === 'login'));
});

test('home fits an 80x24 terminal in every state (<= 22 lines)', () => {
    const states = [
        base,
        { ...base, proxy: false },
        { ...base, loggedIn: false, proxyVersion: '0.0.1' },
        { ...base, stRunning: true, hasST: true },
    ];
    for (const s of states) assert.ok(renderHome(s, -1, '检查状态：没有成功（退出码 1）').text.split('\n').length <= 22);
});

test('更多: login, repair, logs, autostart, stop; keys are unique and skip h / q', () => {
    const items = screens(base).more.items.filter((i) => !i.group);
    assert.deepEqual(items.map((i) => i.sub ?? i.id), ['login', 'repair', 'logs', 'autostart-toggle', 'stop']);
    const keys = items.map((i) => i.key);
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(!keys.some((k) => ['h', 'q', '0'].includes(k)));
    assert.deepEqual(keys, [...'12345']);
});

test('home: key columns are CJK-aware and every line fits the rule width', () => {
    const { text } = renderHome(base, -1, '检查状态：没有成功（退出码 1）');
    for (const line of text.split('\n')) assert.ok(width(line) <= 60, line);
    assert.match(text, /✗ 检查状态：没有成功/);
    assert.match(text, /h 说明 · q 退出/);
});

test('problem letters are plain a b c…', () => {
    assert.deepEqual(probLetters().slice(0, 4), ['a', 'b', 'c', 'd']);
});
