import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyText } from '../src/panel/core/external.js';

const never = () => new Promise(() => {});
const fakeDoc = (ok, log) => ({
    body: { append() { log.push('append'); } },
    createElement: () => ({ setAttribute() {}, style: {}, focus() {}, select() {}, setSelectionRange() {}, remove() { log.push('remove'); } }),
    execCommand: (c) => { log.push(c); return ok; },
});

test('TauriTavern: the plugin is tried first and wins', async () => {
    const calls = [];
    const win = {
        __TAURI__: { core: { invoke: async (cmd, args) => { calls.push([cmd, args]); } } },
        navigator: { clipboard: { writeText: async () => assert.fail('web clipboard used') } },
    };
    assert.equal(await copyText('hi', win), true);
    assert.deepEqual(calls, [['plugin:clipboard-manager|write_text', { text: 'hi' }]]);
});

test('a hanging plugin and a hanging web clipboard time out into execCommand', async () => {
    const log = [];
    const win = { __TAURI__: { core: { invoke: never } }, navigator: { clipboard: { writeText: never } }, document: fakeDoc(true, log) };
    assert.equal(await copyText('x', win, 20), true);
    assert.deepEqual(log, ['append', 'copy', 'remove']);
});

test('plugin rejects: web clipboard is next', async () => {
    const win = { __TAURI__: { core: { invoke: async () => { throw new Error('denied'); } } }, navigator: { clipboard: { writeText: async () => {} } } };
    assert.equal(await copyText('x', win, 20), true);
});

test('browser without Tauri: web clipboard, then execCommand, then false', async () => {
    assert.equal(await copyText('x', { navigator: { clipboard: { writeText: async () => {} } } }, 20), true);
    const log = [];
    assert.equal(await copyText('x', { navigator: { clipboard: { writeText: async () => { throw new Error('no'); } } }, document: fakeDoc(true, log) }, 20), true);
    assert.equal(await copyText('x', { navigator: {}, document: fakeDoc(false, []) }, 20), false);
    assert.equal(await copyText('x', {}, 20), false);
});
