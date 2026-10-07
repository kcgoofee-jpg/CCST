import test from 'node:test';
import assert from 'node:assert/strict';
import { envValue } from '../src/proxy/env-value.js';

test('envValue strips whitespace and one pair of outer quotes only', () => {
    for (const raw of ['abc', ' abc ', '"abc"', "'abc'", ' "abc" ']) assert.equal(envValue(raw), 'abc');
    assert.equal(envValue('a"b'), 'a"b');
    assert.equal(envValue('"abc'), '"abc');
    assert.equal(envValue('"'), '"');
    assert.equal(envValue(undefined), '');
});
