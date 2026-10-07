import test from 'node:test';
import assert from 'node:assert/strict';

import { estimateCostUsd, priceFor, isApiBilled, BACKENDS } from '../src/shared/backends.js';
import { buildSubprocessEnv } from '../src/proxy/core/env.js';

test('the proxy runs on the subscription only', () => {
    assert.deepEqual(BACKENDS, ['subscription']);
    assert.equal(isApiBilled('subscription'), false);
});

test('buildSubprocessEnv: a stray shell provider switch or API key never reaches the CLI; the login token stays', () => {
    const saved = { ...process.env };
    Object.assign(process.env, { CLAUDE_CODE_USE_VERTEX: '1', ANTHROPIC_API_KEY: 'sk-ant-stray', AWS_BEARER_TOKEN_BEDROCK: 'stray', ANTHROPIC_BASE_URL: 'https://elsewhere', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' });
    try {
        const env = buildSubprocessEnv({ envPins: {} });
        for (const k of ['CLAUDE_CODE_USE_VERTEX', 'ANTHROPIC_API_KEY', 'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_BASE_URL']) assert.equal(env[k], undefined, k);
        assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-token');
    } finally {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
    }
});

test('no cost estimate on the subscription; price rows still known', () => {
    const e = { model: 'claude-opus-5', inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheCreationTokens: 0 };
    assert.equal(estimateCostUsd(e, 'subscription'), null);
    assert.equal(priceFor('claude-opus-5-5').cacheRead, 0.2);
});
