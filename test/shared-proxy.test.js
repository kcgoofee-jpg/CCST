import test from 'node:test';
import assert from 'node:assert/strict';

import { forwardToShared, sharingWith, startSharing, stopSharing } from '../src/proxy/api/shared-proxy.js';

function fakeRes() {
    const r = { code: 200, body: null, kind: null };
    r.status = (c) => { r.code = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    r.type = (t) => { r.kind = t; return r; };
    r.send = (b) => { r.body = b; return r; };
    return r;
}

test('plugin routes forward to the shared proxy, /status says which copy this SillyTavern has', async () => {
    startSharing({ port: 8901, host: '127.0.0.1', alive: async () => true, takeOver: async () => false, checkMs: 60_000 });
    assert.equal(sharingWith(), 'http://127.0.0.1:8901');
    const seen = [];
    const fetchImpl = async (url, opts) => {
        seen.push([url, opts.method]);
        return new Response(JSON.stringify({ ok: true, version: '5.2.0', root: '/old' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const res = fakeRes();
    await forwardToShared({ method: 'GET', originalUrl: '/api/plugins/claude-subscription/status' }, res, '/status', fetchImpl);
    assert.equal(res.body.version, '5.2.0');
    assert.ok(res.body.sharedBy.root && res.body.sharedBy.version);

    await forwardToShared({ method: 'POST', params: { slot: 'a b' }, body: {}, originalUrl: '/api/plugins/claude-subscription/reply/a%20b/cancel' }, fakeRes(), '/v1/replies/:slot/cancel', fetchImpl);
    await forwardToShared({ method: 'GET', originalUrl: '/api/plugins/claude-subscription/stats?chat=1' }, fakeRes(), '/v1/usage/stats', fetchImpl);
    assert.deepEqual(seen.slice(1), [['http://127.0.0.1:8901/v1/replies/a%20b/cancel', 'POST'], ['http://127.0.0.1:8901/v1/usage/stats?chat=1', 'GET']]);
    stopSharing();
    assert.equal(sharingWith(), null);
});

test('when the shared proxy goes away this SillyTavern takes the port over', async () => {
    let tries = 0;
    startSharing({ port: 8901, host: '127.0.0.1', alive: async () => false, takeOver: async () => { tries++; return true; }, checkMs: 5 });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(tries, 1);
    assert.equal(sharingWith(), null);
});
