import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectHelp, mismatchHelp, hostKind, REPO_ZIP_URL } from '../src/panel/core/connect-help.js';
import { openExternal, copyText } from '../src/panel/core/external.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const allText = (h) => [h.sub, h.hint, ...h.steps.flatMap((s) => [s.text, s.cmd ?? ''])].join('\n');

test('hostKind: facts only', () => {
    assert.equal(hostKind({ tauri: true, elsewhere: true }), 'tauri');
    assert.equal(hostKind({ elsewhere: true }), 'elsewhere');
    assert.equal(hostKind({}), 'desktop');
});

test('desktop browser: one card, names the address, offers the two installers from the extension folder', () => {
    const h = connectHelp({ endpoint: 'http://192.168.31.7:8901/v1/', host: 'desktop' });
    assert.equal(h.key, 'offline');
    assert.match(h.sub, /192\.168\.31\.7:8901\/v1$/);
    assert.equal(h.steps.length, 3);
    assert.ok(h.steps.some((s) => /删了/.test(s.text)), 'covers a removed proxy');
    assert.deepEqual(h.downloads.map((d) => d.label), ['下载一键安装（Mac）', '下载一键安装（Windows）']);
    for (const d of h.downloads) {
        assert.ok(existsSync(fileURLToPath(d.href)), `${d.file} exists in installer/`);
        assert.match(d.href, /\/installer\//);
        assert.equal(d.download, true);
        assert.match(d.copy, /^https:\/\/github\.com\/kcgoofee-jpg\/CCST\//, 'a copyable GitHub link as the fallback');
    }
});

test('TauriTavern: no plugin installer; repo zip opened in the system browser; Mac launcher, Windows, phone steps', () => {
    const h = connectHelp({ host: 'tauri' });
    assert.deepEqual(h.downloads.map((d) => d.key), ['repo-zip']);
    assert.equal(h.downloads[0].href, REPO_ZIP_URL);
    assert.equal(h.downloads[0].download, false, 'not a webview download');
    assert.equal(h.downloads[0].copy, REPO_ZIP_URL);
    const t = allText(h);
    assert.doesNotMatch(t, /下载一键安装/);
    assert.match(t, /首次安装\.command/);
    assert.match(t, /酒馆工具/);
    assert.match(t, /Windows（实验性/);
    assert.match(t, /手机模式/);
    assert.deepEqual(h.goto, { label: '去填地址和密码', tab: 'other' });
});

test('elsewhere (cloud / phone browser): no installer for this device; server command is copyable', () => {
    const h = connectHelp({ host: 'elsewhere' });
    assert.ok(h.downloads.every((d) => !/CCST安装|CCST-mac/.test(d.href)));
    assert.ok(h.steps.some((s) => /deploy\/install\.sh/.test(s.cmd ?? '')));
    assert.match(allText(h), /运行酒馆的那台机器/);
    assert.equal(h.goto.tab, 'other');
});

test('every link the cards offer has a URL to copy', () => {
    for (const host of ['desktop', 'tauri', 'elsewhere']) {
        const h = connectHelp({ host });
        for (const d of h.downloads) assert.match(d.copy, /^https:\/\//, `${host}: ${d.key} has a URL to copy`);
    }
});

test('version mismatch, proxy older: TauriTavern gets the standalone steps only', () => {
    for (const runtime of [null, 'plugin', 'standalone']) {
        const h = mismatchHelp({ side: 'proxy', proxyVersion: '4.0.0', panelVersion: '4.5.1', runtime, tauri: true });
        assert.deepEqual(h.downloads.map((d) => d.key), ['repo-zip'], `runtime ${runtime}`);
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
