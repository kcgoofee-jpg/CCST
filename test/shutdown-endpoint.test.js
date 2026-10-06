// #33 / #36: shutting down without leaving sockets or a second Ctrl+C hanging,
// and the address the proxy actually listens on for the panel to check against.

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeShutdownHandler } from '../src/proxy/api/shutdown.js';
import { startStandaloneListener, stopStandaloneListener, localEndpoint } from '../src/proxy/api/listener.js';
import { handleStatus } from '../src/proxy/api/status.js';
import { __setSdkForTesting } from '../src/proxy/core/sdk-loader.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a slow close gets a hard exit, a second signal ends it at once (#33)', async () => {
    const exits = [];
    const shutdown = makeShutdownHandler({ close: () => new Promise(() => {}), hardExitMs: 30, exit: (code) => exits.push(code) });
    shutdown('SIGINT');
    await sleep(60);
    assert.deepEqual(exits, [1], 'the 5-second timer (here: 30ms) fired');
    shutdown('SIGINT');
    assert.deepEqual(exits, [1, 1], 'and a second signal is honoured, not swallowed');
});

test('a clean shutdown exits 0 once and ignores later signals (#33)', async () => {
    let closed = 0;
    const exits = [];
    const shutdown = makeShutdownHandler({ close: async () => { closed++; }, hardExitMs: 50, exit: (code) => exits.push(code) });
    shutdown('SIGTERM');
    await sleep(10);
    assert.deepEqual(exits, [0]);
    assert.equal(closed, 1);
    shutdown('SIGINT');
    assert.deepEqual(exits, [0, 1], 'shutting down but not finished: a second signal leaves now');
});

test('a shutdown that throws still exits, with 1 (#33)', async () => {
    const exits = [];
    const shutdown = makeShutdownHandler({ close: async () => { throw new Error('卡住了'); }, exit: (code) => exits.push(code) });
    shutdown('SIGINT');
    await sleep(10);
    assert.deepEqual(exits, [1]);
});

test('stop closes idle keep-alive sockets instead of waiting for them (#33)', async () => {
    const server = await startStandaloneListener({ port: 0, host: '127.0.0.1' });
    let idleClosed = 0;
    server.closeIdleConnections = () => { idleClosed++; };
    await stopStandaloneListener();
    const afterFirst = idleClosed;
    assert.ok(afterFirst >= 1, 'idle keep-alive sockets are dropped on close');
    await stopStandaloneListener(); // already stopped: nothing to close, nothing thrown
    assert.equal(idleClosed, afterFirst);
});

test('/status says where this proxy actually listens (#36)', async () => {
    __setSdkForTesting({ query: () => {}, SYSTEM_PROMPT_DYNAMIC_BOUNDARY: 'b', deleteSession: () => {} });
    const server = await startStandaloneListener({ port: 0, host: '127.0.0.1' });
    let out = null;
    const res = { json: (b) => { out = b; return res; }, status: () => res };
    await handleStatus({ originalUrl: '/status' }, res);
    assert.equal(out.endpoint, `http://127.0.0.1:${server.address().port}/v1`);
    assert.equal(localEndpoint(), out.endpoint);
    await stopStandaloneListener();
    assert.equal(localEndpoint(), null, 'stopped: nothing to advertise');
    __setSdkForTesting(null);
});
