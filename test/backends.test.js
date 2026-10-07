import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { estimateCostUsd, priceFor, isApiBilled, BACKENDS } from '../src/shared/backends.js';
import { resolveBackendConfig, missingFields, backendEnv, publicView, applyUpdate, handleBackendPost, __resetBackendCache } from '../src/proxy/features/backend-config.js';
import { buildSubprocessEnv } from '../src/proxy/core/env.js';

const cfg = (backend, fields = {}) => resolveBackendConfig({ env: {}, file: { backend, ...fields } });

test('only the subscription and the Anthropic API key are backends; anything else falls back to the subscription', () => {
    assert.deepEqual(BACKENDS, ['subscription', 'apikey']);
    assert.equal(resolveBackendConfig({ env: {}, file: { backend: 'bedrock' } }).backend, 'subscription');
    assert.equal(resolveBackendConfig({ env: { CLAUDE_SUBSCRIPTION_BACKEND: 'openrouter' }, file: {} }).backend, 'subscription');
    assert.deepEqual(backendEnv('apikey', cfg('apikey', { apikey: { apiKey: 'sk-ant-x' } }).fields), { set: { ANTHROPIC_API_KEY: 'sk-ant-x' }, unset: ['CLAUDE_CODE_OAUTH_TOKEN'] });
});

test('buildSubprocessEnv: a stray shell provider switch or key never survives, the chosen backend adds only its own', () => {
    const saved = { ...process.env };
    process.env.CLAUDE_CODE_USE_VERTEX = '1';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-stray';
    process.env.AWS_BEARER_TOKEN_BEDROCK = 'stray';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-stray';
    try {
        const sub = buildSubprocessEnv({ envPins: {}, apiKey: null, backend: cfg('subscription') });
        assert.equal(sub.CLAUDE_CODE_USE_VERTEX, undefined);
        assert.equal(sub.ANTHROPIC_API_KEY, undefined);
        assert.equal(sub.AWS_BEARER_TOKEN_BEDROCK, undefined);
        const api = buildSubprocessEnv({ envPins: {}, apiKey: null, backend: cfg('apikey', { apikey: { apiKey: 'sk-ant-file' } }) });
        assert.equal(api.CLAUDE_CODE_USE_VERTEX, undefined);
        assert.equal(api.CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK, '1', 'no refusal-based model fallback on any backend');
        assert.equal(api.ANTHROPIC_API_KEY, 'sk-ant-file');
        assert.equal(api.ANTHROPIC_BASE_URL, undefined);
        assert.equal(api.CLAUDE_CODE_OAUTH_TOKEN, undefined, 'the apikey backend bills the key, never the login');
        // An explicit Bearer sk-ant key on the subscription backend is the same opt-in.
        const byo = buildSubprocessEnv({ envPins: {}, apiKey: 'sk-ant-header', backend: cfg('subscription') });
        assert.equal(byo.ANTHROPIC_API_KEY, 'sk-ant-header');
        assert.equal(byo.CLAUDE_CODE_OAUTH_TOKEN, undefined, 'a setup-token env would outrank the header key');
        // No 「最大回复长度」 in the request: an inherited shell cap would limit
        // the reply without anything in the request asking for it.
        process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '4096';
        assert.equal(buildSubprocessEnv({ envPins: {}, apiKey: null, backend: cfg('subscription') }).CLAUDE_CODE_MAX_OUTPUT_TOKENS, undefined);
        assert.equal(buildSubprocessEnv({ envPins: {}, maxTokens: 8192, apiKey: null, backend: cfg('subscription') }).CLAUDE_CODE_MAX_OUTPUT_TOKENS, '8192', 'the request wins');
    } finally {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
    }
});

test('env vars override the file; missing fields block a switch', () => {
    const c = resolveBackendConfig({ env: { CLAUDE_SUBSCRIPTION_BACKEND: 'apikey', CLAUDE_SUBSCRIPTION_API_KEY: 'sk-ant-env' }, file: { backend: 'subscription', apikey: { apiKey: 'sk-ant-file' } } });
    assert.equal(c.backend, 'apikey');
    assert.equal(c.source, 'env');
    assert.equal(c.fields.apikey.apiKey, 'sk-ant-env');
    assert.deepEqual(missingFields('apikey', c.fields), []);
    assert.deepEqual(missingFields('apikey', cfg('apikey', { apikey: { apiKey: 'nope' } }).fields), ['apikey.apiKey']);
    assert.equal(resolveBackendConfig({ env: {}, file: {} }).backend, 'subscription');
});

test('the public view never carries a secret value', () => {
    const view = publicView(cfg('apikey', { apikey: { apiKey: 'sk-ant-SECRET-4' } }));
    const text = JSON.stringify(view);
    assert.ok(!text.includes('SECRET-4'));
    assert.deepEqual(view.fields.apikey.apiKey, { set: true });
    assert.deepEqual(view.backends.map((b) => b.id), ['subscription', 'apikey']);
    assert.equal(view.apiBilled, true);
});

test('applyUpdate: an empty secret keeps the stored one, clear removes it, unknown keys are ignored', () => {
    const cur = { backend: 'apikey', apikey: { apiKey: 'sk-ant-keep' } };
    const { next } = applyUpdate(cur, { backend: 'apikey', fields: { apikey: { apiKey: '', evil: 'x' }, __proto__: { a: 1 } } });
    assert.equal(next.apikey.apiKey, 'sk-ant-keep');
    assert.equal(next.apikey.evil, undefined);
    assert.equal(applyUpdate(next, { clear: ['apikey.apiKey'] }).next.apikey.apiKey, undefined);
    assert.ok(applyUpdate(cur, { backend: 'nope' }).error);
    assert.ok(applyUpdate(cur, { backend: 'bedrock' }).error, 'removed backends are refused');
});

test('POST /v1/backend stores the file 0600, refuses an incomplete backend, answers without secrets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccst-backend-'));
    const file = join(dir, 'backend.json');
    const savedFile = process.env.CLAUDE_SUBSCRIPTION_BACKEND_FILE;
    const savedB = process.env.CLAUDE_SUBSCRIPTION_BACKEND;
    process.env.CLAUDE_SUBSCRIPTION_BACKEND_FILE = file;
    delete process.env.CLAUDE_SUBSCRIPTION_BACKEND;
    __resetBackendCache();
    const call = (body) => {
        let status = 200; let out = null;
        const res = { status(c) { status = c; return this; }, json(o) { out = o; return this; } };
        const log = console.log; console.log = () => {};
        try { handleBackendPost({ body }, res); } finally { console.log = log; }
        return { status, out };
    };
    try {
        const bad = call({ backend: 'apikey' });
        assert.equal(bad.status, 400);
        assert.equal(existsSync(file), false);
        const ok = call({ backend: 'apikey', fields: { apikey: { apiKey: 'sk-ant-SECRET' } } });
        assert.equal(ok.status, 200);
        assert.ok(!JSON.stringify(ok.out).includes('sk-ant-SECRET'));
        if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600); // Windows has no POSIX modes
        assert.equal(JSON.parse(readFileSync(file, 'utf8')).apikey.apiKey, 'sk-ant-SECRET');
        assert.equal(resolveBackendConfig().backend, 'apikey');
    } finally {
        if (savedFile === undefined) delete process.env.CLAUDE_SUBSCRIPTION_BACKEND_FILE; else process.env.CLAUDE_SUBSCRIPTION_BACKEND_FILE = savedFile;
        if (savedB !== undefined) process.env.CLAUDE_SUBSCRIPTION_BACKEND = savedB;
        __resetBackendCache();
    }
});

test('estimated cost: token counts × list price, none on the subscription', () => {
    const e = { model: 'claude-opus-5[1m]', inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 1_000_000, cacheCreationTokens: 100_000 };
    // 5 + 2.5 + 0.5 + 0.1M × 5 × 1.25 = 0.625
    assert.equal(estimateCostUsd(e, 'apikey'), 8.625);
    assert.equal(estimateCostUsd(e, 'apikey', { cacheTtl: '1h' }), 9);
    assert.equal(estimateCostUsd(e, 'subscription'), null);
    assert.equal(estimateCostUsd({ ...e, model: 'mystery' }, 'apikey'), null);
    assert.equal(priceFor('claude-opus-5-5').cacheRead, 0.2);
    assert.equal(isApiBilled('subscription'), false);
});
