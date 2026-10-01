import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectHelp, mismatchHelp, hostKind, formPrefill, connectOutcome, MAC_INSTALL_CMD } from '../src/panel/core/connect-help.js';
import { makeConnectCode, parseConnectCode } from '../src/panel/core/connect-code.js';
import { submitConnect, revealGroup } from '../src/panel/core/connect-form.js';
import { readFileSync } from 'node:fs';
import { openExternal, copyText } from '../src/panel/core/external.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const allText = (h) => [h.sub, h.hint, ...h.steps.flatMap((s) => [s.text, s.cmd ?? ''])].join('\n');

test('hostKind: facts only', () => {
    assert.equal(hostKind({ tauri: true, elsewhere: true }), 'tauri');
    assert.equal(hostKind({ elsewhere: true }), 'elsewhere');
    assert.equal(hostKind({}), 'desktop');
});

test('desktop installers exist in the extension folder and carry a copyable GitHub link', () => {
    const h = connectHelp({ endpoint: 'http://192.168.31.7:8901/v1/', host: 'desktop' });
    assert.equal(h.key, 'offline');
    assert.deepEqual(h.downloads.map((d) => d.label), ['下载一键安装（Mac）', '下载一键安装（Windows）']);
    for (const d of h.downloads) {
        assert.ok(existsSync(fileURLToPath(d.href)), `${d.file} exists in installer/`);
        assert.match(d.href, /\/installer\//);
        assert.equal(d.download, true);
        assert.match(d.copy, /^https:\/\/github\.com\/kcgoofee-jpg\/CCST\//, 'a copyable GitHub link as the fallback');
    }
});

const noLoopback = (h) => assert.doesNotMatch(JSON.stringify(h), /127\.0\.0\.1|localhost/);
const cardText = (h) => [h.title, h.sub, h.hint, ...h.downloads.map((d) => d.label)].join('');

test('TauriTavern: one sentence, one 连接码 box, one visible download line; no 127.0.0.1, no steps, nothing collapsed', () => {
    const h = connectHelp({ host: 'tauri', endpoint: 'http://127.0.0.1:8901/v1' });
    assert.equal(h.title, '连不上 CCST 代理');
    assert.equal(h.sub, '把电脑上酒馆工具首页显示的「手机连接码」粘贴到这里');
    assert.deepEqual(h.steps, []);
    assert.equal(h.fold, undefined);
    assert.deepEqual(h.form, { value: '', placeholder: 'http://192.168.x.x:8901/v1#k=…' });
    noLoopback(h);
    assert.deepEqual(h.downloads.map((d) => [d.key, d.label]), [['mac-cmd', '电脑上还没装？Mac 打开「终端」粘贴下面这行']]);
    assert.equal(h.downloads[0].copy, MAC_INSTALL_CMD, 'a terminal line, not a zip: downloaded .command files are blocked by macOS');
    assert.equal(h.downloads[0].download, false, 'opened by the system browser, not a webview download');
    assert.ok(cardText(h).length < 80, 'short');
});

test('phone form is prefilled with the saved 连接码 (address + key), but never with a loopback address', () => {
    const h = connectHelp({ host: 'tauri', endpoint: 'http://192.168.31.7:8901/v1/', accessKey: 'Kx9' });
    assert.equal(h.form.value, 'http://192.168.31.7:8901/v1#k=Kx9');
    assert.equal(formPrefill('http://localhost:8901/v1', 'k', 'elsewhere'), '');
    assert.equal(formPrefill('http://127.0.0.1:8901/v1', '', 'desktop'), 'http://127.0.0.1:8901/v1');
});

test('elsewhere (cloud / phone browser): same box, a docs link instead of an installer', () => {
    const h = connectHelp({ host: 'elsewhere', endpoint: 'http://127.0.0.1:8901/v1' });
    assert.ok(h.downloads.every((d) => !/CCST安装|CCST-mac/.test(d.href)));
    assert.equal(h.form.value, '');
    noLoopback(h);
    assert.equal(h.downloads.length, 1);
});

test('desktop browser ST: one sentence, installers, one visible Mac 15 line, no form, nothing collapsed', () => {
    const h = connectHelp({ host: 'desktop' });
    assert.deepEqual(h.steps, []);
    assert.equal(h.form, undefined);
    assert.equal(h.fold, undefined);
    assert.match(h.hint, /系统设置 → 隐私与安全性 → 拉到底点「仍要打开」/);
    assert.deepEqual(h.downloads.map((d) => d.key), ['mac', 'win']);
});

test('connectOutcome: the proxy\'s own answer decides the message', () => {
    assert.deepEqual(connectOutcome({ phase: 'online' }), { kind: 'ok', text: '连上了' });
    assert.equal(connectOutcome({ phase: 'nologin' }).kind, 'ok');
    assert.deepEqual(connectOutcome({ phase: 'denied', code: 401, message: 'Invalid access key' }), { kind: 'denied', text: '连接码里的密码不对' });
    assert.equal(connectOutcome({ phase: 'denied', code: 403, message: 'LAN access is off' }).text, 'LAN access is off');
    assert.equal(connectOutcome({ phase: 'offline' }).text, '连不上：电脑开着酒馆工具且在同一 Wi-Fi？');
});

test('连接码: build / parse round trip, tolerant of spaces, newlines, labels and bare IP:port', () => {
    const code = makeConnectCode('http://192.168.31.7:8901/v1/', 'Kx9mPq2');
    assert.equal(code, 'http://192.168.31.7:8901/v1#k=Kx9mPq2');
    const want = { endpoint: 'http://192.168.31.7:8901/v1', accessKey: 'Kx9mPq2' };
    assert.deepEqual(parseConnectCode(code), want);
    assert.deepEqual(parseConnectCode(`  手机连接码：${code}\n`), want);
    assert.deepEqual(parseConnectCode('http://192.168.31.7:8901/v1#k=Kx9\n mPq2'), want, 'a soft-wrapped paste');
    assert.deepEqual(parseConnectCode('192.168.31.7:8901#k=Kx9mPq2'), want, 'bare IP:port gets http:// and /v1');
    assert.deepEqual(parseConnectCode('http://192.168.31.7:8901/v1'), { endpoint: 'http://192.168.31.7:8901/v1', accessKey: '' }, 'a plain address is accepted');
    assert.deepEqual(parseConnectCode('http://10.0.0.2:8901/v1#k=a%2Fb'), { endpoint: 'http://10.0.0.2:8901/v1', accessKey: 'a/b' });
    assert.equal(makeConnectCode('http://127.0.0.1:8901/v1', ''), 'http://127.0.0.1:8901/v1');
    for (const bad of ['', '   ', '你好', 'abc#k=def']) assert.equal(parseConnectCode(bad), null, JSON.stringify(bad));
});

test('submitConnect: saves address + key like 其他 → 手机连接 does, re-checks, then goes on to one-click connect', async () => {
    const calls = [];
    const settings = { endpoint: 'http://127.0.0.1:8901/v1', accessKey: '' };
    let status = { phase: 'pending' };
    const deps = {
        settings, save: () => calls.push('save'), sync: (s) => calls.push(`sync:${s.endpoint}`),
        refresh: async () => { calls.push('refresh'); status = { phase: 'online', version: '4.6.0' }; },
        getStatus: () => status, connect: async (s) => calls.push(`connect:${s.accessKey}`),
    };
    const out = await submitConnect({ code: ' 手机连接码：http://192.168.1.5:8901/v1#k=abc \n' }, deps);
    assert.equal(out.kind, 'ok');
    assert.equal(settings.endpoint, 'http://192.168.1.5:8901/v1');
    assert.equal(settings.accessKey, 'abc');
    assert.deepEqual(calls, ['sync:http://192.168.1.5:8901/v1', 'save', 'refresh', 'connect:abc']);
});

test('submitConnect: wrong password / unreachable / junk / empty do not connect', async () => {
    const mk = (status) => { const calls = []; return { calls, settings: {}, deps: { save: () => calls.push('save'), refresh: async () => {}, getStatus: () => status, connect: () => calls.push('connect') } }; };
    const run = (t, code) => submitConnect({ code }, { ...t.deps, settings: t.settings });
    let t = mk({ phase: 'denied', code: 401, message: 'bad key' });
    assert.deepEqual(await run(t, 'http://10.0.0.2:8901/v1#k=x'), { kind: 'denied', text: '连接码里的密码不对' });
    t = mk({ phase: 'offline' });
    assert.equal((await run(t, 'http://10.0.0.2:8901/v1#k=x')).kind, 'offline');
    t = mk({ phase: 'nologin' });
    assert.equal((await run(t, 'http://10.0.0.2:8901/v1#k=x')).kind, 'ok');
    assert.ok(!t.calls.includes('connect'), 'not logged in: no one-click connect yet');
    t = mk({ phase: 'online' });
    assert.equal((await run(t, '')).kind, 'empty');
    assert.equal((await run(t, '你好')).kind, 'bad');
    assert.deepEqual(t.calls, [], 'nothing saved, nothing connected');
    assert.deepEqual(t.settings, {});
});

test('revealGroup: opens the target tab, expands the group, focuses its first input', () => {
    const log = [];
    const input = { focus: () => log.push('focus') };
    const group = { open: false, querySelector: (q) => (q === 'input' ? input : null), scrollIntoView: () => log.push('scroll') };
    const doc = { getElementById: (id) => (id === 'claude_max_lan' ? group : null) };
    assert.equal(revealGroup({ showTab: (t) => log.push(`tab:${t}`), tab: 'other', groupId: 'claude_max_lan', doc }), true);
    assert.equal(group.open, true);
    assert.deepEqual(log, ['tab:other', 'scroll', 'focus']);
    assert.equal(revealGroup({ showTab: () => {}, tab: 'other', groupId: 'nope', doc }), false);
});

test('shell: no jump to 设置, no 改地址 / 去填地址和密码; the 其他 jump goes through revealGroup', () => {
    const shell = readFileSync(fileURLToPath(new URL('../src/panel/shell.js', import.meta.url)), 'utf8');
    assert.doesNotMatch(shell, /showTab\('settings'\)|改地址|去填地址和密码/);
    assert.match(shell, /revealGroup\(\{ showTab, tab: 'other', groupId: 'claude_max_lan' \}\)/);
    assert.doesNotMatch(shell, /<details|collapsible|cm-fold/);
});

test('every link the cards offer has a URL to copy', () => {
    for (const host of ['desktop', 'tauri', 'elsewhere']) {
        const h = connectHelp({ host });
        for (const d of h.downloads) assert.match(d.copy, /^https:\/\/|^zsh -c "\$\(curl -fsSL https:\/\//, `${host}: ${d.key} has a URL or command to copy`);
    }
});

test('version mismatch, proxy older: TauriTavern gets the standalone steps only', () => {
    for (const runtime of [null, 'plugin', 'standalone']) {
        const h = mismatchHelp({ side: 'proxy', proxyVersion: '4.0.0', panelVersion: '4.5.1', runtime, tauri: true });
        assert.deepEqual(h.downloads, [], `runtime ${runtime}`);
        assert.ok(h.steps.some((st) => st.cmd === MAC_INSTALL_CMD), 'update = the same terminal line');
        const t = allText(h);
        assert.doesNotMatch(t, /CCST安装|一键安装|酒馆的黑色窗口/);
        assert.match(t, /重启代理/);
        assert.match(t, /重启 TauriTavern/);
    }
});

test('version mismatch on a desktop browser keeps the plugin path', () => {
    const plugin = mismatchHelp({ side: 'proxy', proxyVersion: '4.0.0', panelVersion: '4.5.1', runtime: 'plugin' });
    assert.equal(plugin.downloads.length, 2);
    assert.match(allText(plugin), /CCST安装/);
    const standalone = mismatchHelp({ side: 'proxy', proxyVersion: '4.0.0', panelVersion: '4.5.1', runtime: 'standalone' });
    assert.equal(standalone.downloads.length, 0);
    const unknown = mismatchHelp({ side: 'proxy', proxyVersion: '4.0.0', panelVersion: '4.5.1' });
    assert.equal(unknown.downloads.length, 2);
});

test('version mismatch, panel older: no downloads, TauriTavern wording', () => {
    const h = mismatchHelp({ side: 'panel', proxyVersion: '4.5.1', panelVersion: '4.0.0', tauri: true });
    assert.equal(h.downloads.length, 0);
    assert.match(allText(h), /TauriTavern/);
});

test('openExternal: opener plugin first, window.open as fallback; copyText falls back to the clipboard plugin', async () => {
    const calls = [];
    const tt = { __TAURI__: { core: { invoke: async (cmd, args) => { calls.push([cmd, args]); } } }, navigator: { clipboard: { writeText: async () => { throw new Error('denied'); } } } };
    assert.equal(await openExternal('https://x.test/a.zip', tt), true);
    assert.deepEqual(calls[0], ['plugin:opener|open_url', { url: 'https://x.test/a.zip' }]);
    assert.equal(await copyText('hi', tt), true);
    assert.deepEqual(calls[1], ['plugin:clipboard-manager|write_text', { text: 'hi' }]);
    let opened = null;
    assert.equal(await openExternal('https://x.test/b', { open: (u) => { opened = u; return {}; } }), true);
    assert.equal(opened, 'https://x.test/b');
    assert.equal(await copyText('x', { navigator: { clipboard: { writeText: async () => { throw new Error('no'); } } } }), false);
});
