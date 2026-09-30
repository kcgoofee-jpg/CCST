import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelRequest } from '../src/proxy/models.js';
import { canonicalModel } from '../src/shared/sources.js';

test('Sonnet 5.5: always thinks, native 1M (no [1m] variant)', () => {
    const m = parseModelRequest('claude-sonnet-5-5');
    assert.equal(m.adaptiveOnly, true);
    assert.equal(m.oneM, false);
    assert.equal(canonicalModel('anthropic/claude-sonnet-5.5'), 'claude-sonnet-5-5');
});
