import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectHelp, mismatchHelp, hostKind, installHelp, loginHelp, awayHelp, MAC_PLUGIN_CMD, DOCS_URL } from '../src/panel/core/connect-help.js';
import { openExternal, copyText } from '../src/panel/core/external.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const allText = (h) => [h.sub, h.hint, ...h.steps.flatMap((s) => [s.text, s.cmd ?? ''])].join('\n');

test('hostKind: facts only', () => {
    assert.equal(hostKind({ tauri: true, elsewhere: true }), 'away', 'TauriTavern on a phone cannot use CCST');
    assert.equal(hostKind({ elsewhere: true }), 'away');
    assert.equal(hostKind({ tauri: true }), 'tauri');
    assert.equal(hostKind({}), 'desktop');
});

test('phone / cloud SillyTavern: one card, no install or login steps', () => {
    assert.match(awayHelp({ touch: true }).sub, /手机/);
    assert.match(awayHelp({ touch: false }).sub, /同一台电脑/);
});

test('desktop: Mac gets a terminal line (downloaded .command files are blocked), Windows gets the .bat from the extension folder', () => {
    const h = connectHelp({ endpoint: 'http://192.168.31.7:8901/v1/', host: 'desktop' });
    assert.equal(h.key, 'offline');
    assert.deepEqual(h.downloads.map((d) => d.key), ['mac-plugin-cmd', 'win']);
    const [mac, win] = h.downloads;
    assert.equal(mac.copy, MAC_PLUGIN_CMD);
    assert.equal(mac.download, false);
    assert.match(MAC_PLUGIN_CMD, /install-plugin-mac\.sh/);
    assert.ok(existsSync(fileURLToPath(new URL('../install-plugin-mac.sh', import.meta.url))), 'the script the line downloads exists');
    assert.equal(win.label, '下载安装');
    assert.match(mac.label, /^Mac：在终端粘贴/);
    assert.ok(existsSync(fileURLToPath(win.href)), `${win.file} exists in installer/`);
    assert.equal(win.download, true);
    assert.match(win.copy, /^https:\/\/github\.com\/kcgoofee-jpg\/CCST\//, 'a copyable GitHub link as the fallback');
});

const noLoopback = (h) => assert.doesNotMatch(JSON.stringify(h), /127\.0\.0\.1|localhost/);
const cardText = (h) => [h.title, h.sub, h.hint, ...h.downloads.map((d) => d.label)].join('');

test('TauriTavern: one sentence and a docs link; no 127.0.0.1, no steps, no form', () => {
    for (const host of ['tauri']) {
        const h = connectHelp({ host });
        assert.equal(h.title, '连不上');
        assert.match(h.sub, /npm start/);
        assert.deepEqual(h.steps, []);
        assert.equal(h.form, undefined);
        assert.ok(h.downloads.every((d) => !/CCST安装|CCST-mac/.test(d.href)));
        assert.deepEqual(h.downloads.map((d) => d.href), [DOCS_URL]);
        noLoopback(h);
    }
});

test('desktop browser ST: one sentence, a Mac line and a Windows installer, no form, nothing collapsed', () => {
    const h = connectHelp({ host: 'desktop' });
    assert.deepEqual(h.steps, []);
    assert.equal(h.form, undefined);
    assert.equal(h.fold, undefined);
    assert.equal(h.sub, '请重启酒馆重试');
    assert.match(h.downloads[0].label, /^Mac：在终端粘贴/);
    assert.doesNotMatch(cardText(h), /仍要打开|CCST-mac/, 'no zip to double-click on Mac any more');
    assert.deepEqual(h.downloads.map((d) => d.key), ['mac-plugin-cmd', 'win']);
});

test('first-run guide: step 1 reuses the same install data, step 2 is one command', () => {
    const d = installHelp({ host: 'desktop' });
    assert.equal(d.mac, MAC_PLUGIN_CMD);
    assert.equal(d.win.download, true);
    assert.ok(existsSync(fileURLToPath(d.win.href)));
    assert.equal(d.docs, null);
    for (const host of ['tauri']) {
        const r = installHelp({ host });
        assert.equal(r.mac, null);
        assert.equal(r.win, null);
        assert.equal(r.docs, DOCS_URL);
    }
    for (const host of ['desktop', 'tauri']) assert.equal(loginHelp({ host }).cmd, 'npm run login');
    assert.match(loginHelp({ host: 'desktop' }).where, /plugins\/CCST/);
});

test('every link the cards offer has a URL to copy', () => {
    for (const host of ['desktop', 'tauri']) {
        const h = connectHelp({ host });
        for (const d of h.downloads) assert.match(d.copy, /^https:\/\/|^zsh -c "\$\(curl -fsSL https:\/\//, `${host}: ${d.key} has a URL or command to copy`);
    }
});

test('version mismatch, proxy older: one line and a link to the update notes, any host', () => {
    for (const tauri of [false, true]) {
        const h = mismatchHelp({ side: 'proxy', tauri });
        assert.equal(h.sub, '代理要更新：照说明更新');
        assert.deepEqual(h.steps, []);
        assert.deepEqual(h.downloads.map((d) => d.href), [DOCS_URL]);
    }
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

test('update card: only on a desktop SillyTavern, with the installer downloads', async () => {
    const { updateHelp, isNewerVersion } = await import('../src/panel/core/connect-help.js');
    const h = updateHelp({ latest: '6.0.4' });
    assert.equal(h.title, '有新版 v6.0.4');
    assert.ok(h.downloads.some((d) => d.file === 'CCST安装.bat') && h.downloads.some((d) => d.key === 'mac-plugin-cmd'));
    assert.equal(updateHelp({ latest: '6.0.4', host: 'tauri' }), null);
    assert.equal(isNewerVersion('6.0.10', '6.0.9'), true);
    assert.equal(isNewerVersion('6.0.3', '6.0.3'), false);
    assert.equal(isNewerVersion('6.0.2', '6.0.3'), false);
});
