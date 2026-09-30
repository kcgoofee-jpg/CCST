import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectHelp } from '../src/panel/core/connect-help.js';

test('one card, no guessing: names the address and lists what to check', () => {
    const h = connectHelp({ endpoint: 'http://192.168.31.7:8901/v1/' });
    assert.equal(h.key, 'offline');
    assert.match(h.sub, /192\.168\.31\.7:8901\/v1$/);
    assert.equal(h.steps.length, 3);
    assert.ok(h.steps.some((s) => /删了/.test(s.text)), 'covers a removed proxy');
});
