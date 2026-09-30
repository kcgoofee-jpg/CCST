import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quotaGate, QUOTA_MIN_GAP_MS } from '../src/panel/core/quota-gate.js';
import { chatKeyOf } from '../src/panel/core/chat-key.js';

test('first ask goes through; too soon or backing off falls back to idle, never a stuck loading', () => {
    const now = 1_000_000;
    assert.deepEqual(quotaGate({ now, phase: 'idle' }), { ask: true });
    assert.deepEqual(quotaGate({ now, phase: 'loading', askedAt: now - 1000 }), { ask: false, phase: 'idle' });
    assert.deepEqual(quotaGate({ now, phase: 'ok', askedAt: now - 1000 }), { ask: false, phase: 'ok' });
    assert.deepEqual(quotaGate({ now, phase: 'loading', notBefore: now + 5000, force: true }), { ask: false, phase: 'idle' });
    assert.deepEqual(quotaGate({ now, phase: 'ok', notBefore: now + 5000 }), { ask: false, phase: 'ok' });
    assert.equal(quotaGate({ now, phase: 'ok', askedAt: now - QUOTA_MIN_GAP_MS }).ask, true);
    assert.equal(quotaGate({ now, phase: 'ok', askedAt: now - 1000, force: true }).ask, true);
    assert.deepEqual(quotaGate({ now, phase: 'loading', inFlight: true }), { ask: false });
});

test('chat key: stable hash of the chat id, null without a chat', () => {
    const a = chatKeyOf({ chatId: 'Seraphina - 2026-01-01' });
    assert.match(a, /^[0-9a-f]{16}$/);
    assert.equal(a, chatKeyOf({ chatId: 'Seraphina - 2026-01-01' }));
    assert.notEqual(a, chatKeyOf({ chatId: 'Seraphina - 2026-01-02' }));
    assert.equal(chatKeyOf({}), null);
});
