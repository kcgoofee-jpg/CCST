import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelRequest, isAdaptiveOnlyModel } from '../src/proxy/core/models.js';
import { canonicalModel, isAdaptiveOnly } from '../src/shared/sources.js';
import { priceFor } from '../src/shared/backends.js';

test('Haiku 5.5: always thinks, native 1M (no [1m] variant), haiku tier', () => {
    const m = parseModelRequest('claude-haiku-5-5');
    assert.equal(m.adaptiveOnly, true);
    assert.equal(m.oneM, false);
    assert.equal(m.tier, 'haiku');
    assert.equal(canonicalModel('anthropic/claude-haiku-5.5'), 'claude-haiku-5-5');
    assert.equal(isAdaptiveOnly('claude-haiku-5-5'), true);
    assert.equal(isAdaptiveOnly('claude-haiku-4-5'), false);
    assert.equal(isAdaptiveOnlyModel('claude-haiku-6'), true, 'newer haiku ids are treated the same');
    assert.deepEqual(priceFor('claude-haiku-5-5'), { input: 0.1, output: 0.5, cacheRead: 0.01 });
});
