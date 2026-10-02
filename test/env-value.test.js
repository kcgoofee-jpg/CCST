import test from 'node:test';
import assert from 'node:assert/strict';
import { envValue } from '../src/proxy/env-value.js';
import { resolveBackendConfig } from '../src/proxy/features/backend-config.js';

test('envValue strips whitespace and one pair of outer quotes only', () => {
    for (const raw of ['abc', ' abc ', '"abc"', "'abc'", ' "abc" ']) assert.equal(envValue(raw), 'abc');
    assert.equal(envValue('a"b'), 'a"b');
    assert.equal(envValue('"abc'), '"abc');
    assert.equal(envValue('"'), '"');
    assert.equal(envValue(undefined), '');
});

test('a quoted CLAUDE_SUBSCRIPTION_BACKEND still selects the backend', () => {
    const cfg = resolveBackendConfig({ env: { CLAUDE_SUBSCRIPTION_BACKEND: '"apikey"', CLAUDE_SUBSCRIPTION_API_KEY: "'k'" }, file: {} });
    assert.equal(cfg.backend, 'apikey');
    assert.equal(cfg.fields.apikey.apiKey, 'k');
});
