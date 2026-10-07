import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalModel } from '../src/shared/sources.js';

test('canonical id from every source spelling', () => {
    assert.equal(canonicalModel('claude-opus-4-6'), 'claude-opus-4-6');
    assert.equal(canonicalModel('claude-opus-4-6[1m]'), 'claude-opus-4-6');
    assert.equal(canonicalModel('anthropic/claude-opus-4.6'), 'claude-opus-4-6');
    assert.equal(canonicalModel('anthropic/claude-3.7-sonnet:thinking'), 'claude-3-7-sonnet');
    assert.equal(canonicalModel('claude-opus-4-5-20251101'), 'claude-opus-4-5');
    assert.equal(canonicalModel('claude-opus-4-6-thinking'), 'claude-opus-4-6');
    assert.equal(canonicalModel('us.anthropic.claude-opus-4-6-v1:0'), 'claude-opus-4-6');
    assert.equal(canonicalModel('gpt-4o'), null);
});
