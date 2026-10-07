import { test } from 'node:test';
import assert from 'node:assert/strict';

import { countInFlight, busyCount, __setInFlight } from '../src/proxy/platform/control.js';

test('a reply counts as in flight until its handler is done, even after the client left', async () => {
    __setInFlight(0);
    const handlers = {};
    const res = { statusCode: 200, on: (ev, fn) => { handlers[ev] = fn; } };
    let finish;
    const wrapped = countInFlight(() => new Promise((r) => { finish = r; }));
    const done = wrapped({ socket: { remoteAddress: '192.168.31.6' } }, res, () => {});
    assert.equal(busyCount(), 1);
    handlers.close?.(); // the client went away: the reply is still being written
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
