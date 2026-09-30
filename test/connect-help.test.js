import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectHelp } from '../src/panel/core/connect-help.js';

const DEF = 'http://127.0.0.1:8901/v1';
const cmds = (h) => h.steps.map((s) => s.cmd).filter(Boolean);

test('plugin missing on original SillyTavern: install steps with copyable commands', () => {
    for (const pluginState of ['missing', 'unknown']) {
        const h = connectHelp({ pluginState, endpoint: DEF });
        assert.equal(h.key, 'plugin-missing');
        assert.ok(cmds(h).includes('enableServerPlugins: true'));
        assert.ok(cmds(h).some((c) => c.startsWith('node plugins.js install https://github.com/kcgoofee-jpg/CCST')));
        assert.ok(cmds(h).some((c) => c.includes('npm install') && c.includes('npm run login')));
        assert.ok(h.steps.some((s) => s.text.includes('重启')));
    }
});

test('plugin present but the proxy silent: restart SillyTavern, name the log line', () => {
    const h = connectHelp({ pluginState: 'present', endpoint: DEF });
    assert.equal(h.key, 'plugin-restart');
    assert.ok(h.steps[0].text.includes('重启 SillyTavern'));
    assert.ok(cmds(h).some((c) => c.includes('[claude-subscription]')));
});

test('panel on another device: no npm, no install; mention the launcher and the desktop shortcut', () => {
    for (const p of [{ tauri: true, endpoint: DEF }, { endpoint: 'http://192.168.1.8:8901/v1' }]) {
        for (const pluginState of ['missing', 'present', 'unknown']) {
            const h = connectHelp({ ...p, pluginState });
            assert.equal(h.key, 'other-device');
            assert.deepEqual(cmds(h), []);
            const all = h.steps.map((s) => s.text).join('\n');
            assert.ok(all.includes('启动 SillyTavern') && all.includes('launcher/mac/') && all.includes('酒馆工具'));
        }
    }
});

test('custom local address without the plugin: standalone proxy, npm start', () => {
    const h = connectHelp({ pluginState: 'missing', endpoint: 'http://127.0.0.1:9000/v1/' });
    assert.equal(h.key, 'standalone');
    assert.deepEqual(cmds(h), ['npm start', 'npm run login']);
    // the plugin is there: still the plugin's story
    assert.equal(connectHelp({ pluginState: 'present', endpoint: 'http://127.0.0.1:9000/v1' }).key, 'plugin-restart');
});

test('no card ever points at the old 「酒馆工具.command」 as the main way', () => {
    for (const pluginState of ['missing', 'present', 'unknown']) {
        for (const endpoint of [DEF, 'http://localhost:9000/v1', 'http://10.0.0.2:8901/v1']) {
            const h = connectHelp({ pluginState, endpoint });
            if (h.key !== 'other-device') assert.ok(!JSON.stringify(h).includes('.command'));
        }
    }
});
