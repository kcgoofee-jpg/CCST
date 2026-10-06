import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { shQuote } from '../launcher/core.mjs';
import { ACTIONS, actionAnswer, handleControlAction, countInFlight, busyCount, markStandalone, __setInFlight, LID_PAUSE_FILE } from '../src/proxy/platform/control.js';

function fakeRes() {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}

test('only named actions exist, none takes a command', () => {
    assert.deepEqual(Object.keys(ACTIONS).sort(), ['comfy-start', 'comfy-stop', 'lid-pause', 'lid-resume', 'phone-sync', 'restart-proxy']);
    for (const a of Object.values(ACTIONS)) assert.ok(a.label && (a.script || a.run));
});

test('an unknown action is refused', async () => {
    const res = fakeRes();
    await handleControlAction({ body: { action: 'rm -rf /' } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.ok, false);
});

// The idle check moved into the action's own script: the phone presses once and the
// restart runs when the reply in progress is finished, instead of being refused and
// pressed again. (Asserted on the action, because running it would restart the proxy.)
test('a restart pressed while a reply is being written queues itself instead of bouncing the phone', () => {
    const a = ACTIONS['restart-proxy'];
    assert.equal(a.whenIdle, undefined, 'no up-front refusal');
    assert.equal(a.idleQueue, 120);
    assert.match(a.script, /^wait_proxy_idle 120 \|\| \{ log_event .*已取消"; exit 1; \}/, 'the script waits, and gives up');
    assert.match(a.script, /stop_one \$PROXY_PORT/, 'then stops and starts as before');
    assert.match(actionAnswer(a).message, /已排队/);
    assert.match(actionAnswer(a).message, /120/);
    assert.match(actionAnswer(ACTIONS['lid-resume']).message, /已执行$/);
});

test('a reply counts as in flight until its handler is done, even after the client left', async () => {
    __setInFlight(0);
    const handlers = {};
    const res = { statusCode: 200, on: (ev, fn) => { handlers[ev] = fn; } };
    let finish;
    const wrapped = countInFlight(() => new Promise((r) => { finish = r; }));
    const done = wrapped({ socket: { remoteAddress: '192.168.31.6' } }, res, () => {});
    assert.equal(busyCount(), 1);
    handlers.close?.(); // the phone app went to the background: the reply is still being written
    assert.equal(busyCount(), 1);
    finish();
    await done;
    assert.equal(busyCount(), 0);
});

test('a rejected chat handler goes to next() and still ends the count', async () => {
    __setInFlight(0);
    let passed = null;
    await countInFlight(async () => { throw new Error('boom'); })({ socket: { remoteAddress: '127.0.0.1' } }, { statusCode: 500 }, (err) => { passed = err; });
    assert.equal(passed?.message, 'boom');
    assert.equal(busyCount(), 0);
});

test('Object.prototype names are not actions (no crash)', async () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
        const res = fakeRes();
        await handleControlAction({ body: { action: name } }, res);
        assert.equal(res.statusCode, 400, name);
    }
});

test('phone sync also waits while a reply is being written', async () => {
    assert.equal(ACTIONS['phone-sync'].whenIdle, true);
    if (process.platform !== 'darwin') return;
    __setInFlight(2);
    try {
        const res = fakeRes();
        await handleControlAction({ body: { action: 'phone-sync' } }, res);
        assert.equal(res.statusCode, 409);
        assert.match(res.body.message, /写完再同步/);
    } finally {
        __setInFlight(0);
    }
});

// The action script the phone runs uses the launcher's own wait; it must exist and
// mean what the action assumes: 0 = idle now, 1 = still writing when the wait runs out.
const ZSH = ['/bin/zsh', '/usr/bin/zsh', '/usr/local/bin/zsh', '/opt/homebrew/bin/zsh'].find(existsSync) ?? null;
test('wait_proxy_idle waits for the proxy to finish writing', { skip: process.platform === 'win32' || !ZSH }, () => {
    const lib = new URL('../launcher/mac/lib.zsh', import.meta.url);
    assert.ok(existsSync(lib), 'launcher/mac/lib.zsh is part of this checkout');
    const run = (stub, limit) => spawnSync(ZSH,
        ['-c', `source ${shQuote(fileURLToPath(lib))} >/dev/null 2>&1; proxy_busy() { ${stub} }; wait_proxy_idle ${limit} >/dev/null 2>&1; print $?`],
        { encoding: 'utf8', timeout: 30000 }).stdout.trim();
    assert.equal(run('return 1', 4), '0', 'idle: do it right away');
    assert.equal(run('return 0', 2), '1', 'still writing at the limit: cancel');
});

test('inside SillyTavern (plugin mode) restart-proxy is refused: it would stop SillyTavern', async () => {
    assert.equal(ACTIONS['restart-proxy'].standaloneOnly, true);
    if (process.platform !== 'darwin') return;
    markStandalone(false); // never run the real restart from a test
    __setInFlight(0);
    const res = fakeRes();
    await handleControlAction({ body: { action: 'restart-proxy' } }, res);
    if (res.statusCode === 501) return; // no launcher checkout here
    assert.equal(res.statusCode, 409);
    assert.match(res.body.message, /酒馆/);
});

test('restart-proxy re-checks busy inside the detached script, right before it stops (closes the TOCTOU window)', () => {
    const script = ACTIONS['restart-proxy'].script;
    assert.ok(script.includes('wait_proxy_idle'), '脚本要在停之前等代理空闲（wait_proxy_idle）');
    assert.ok(script.indexOf('wait_proxy_idle') < script.indexOf('stop_one'), '确认空闲在 stop_one 之前');
    // wait_proxy_idle itself polls proxy_busy (launcher/mac/lib.zsh) — the busy re-check is real
    const lib = readFileSync(new URL('../launcher/mac/lib.zsh', import.meta.url), 'utf8');
    const body = lib.slice(lib.indexOf('wait_proxy_idle()'));
    assert.ok(body.slice(0, body.indexOf('\n}')).includes('proxy_busy'), 'wait_proxy_idle 轮询的是 proxy_busy');
});

test('a detached action reports what actually happened: queued, waiting for idle, gives up after the wait', () => {
    const a = ACTIONS['restart-proxy'];
    assert.ok(a.idleQueue, 'restart is a queued action');
    const answer = actionAnswer(a);
    assert.match(answer.message, /已排队/, 'says queued rather than done');
    assert.match(answer.message, /取消/, 'says it can give up');
    assert.equal(actionAnswer({ label: '合盖暂停', run: () => {} }).message, '合盖暂停：已执行', 'instant actions still say done');
});

test('the lid pause file lives in launcher/ and is git-ignored (*.local)', () => {
    assert.match(LID_PAUSE_FILE, /launcher[\/\\]lid-pause\.local$/);
    assert.equal(existsSync(LID_PAUSE_FILE), existsSync(LID_PAUSE_FILE)); // path resolves
});

test('macStatus: a proxy running inside SillyTavern (plugin mode) reports remote control as unsupported', async () => {
    const { macStatus } = await import('../src/proxy/platform/control.js');
    markStandalone(false);
    assert.equal((await macStatus()).supported, false);
});
