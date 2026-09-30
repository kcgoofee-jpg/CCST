import test from 'node:test';
import assert from 'node:assert/strict';

import { loadCredentials } from '../src/proxy/features/oauth.js';

const FILE_CREDS = { claudeAiOauth: { accessToken: 'file-token', refreshToken: 'r' } };
const KEYCHAIN_CREDS = { claudeAiOauth: { accessToken: 'kc-token', subscriptionType: 'max' } };

const noFile = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
const noKeychain = () => { throw new Error('item not found'); };

test('CLAUDE_CODE_OAUTH_TOKEN wins over every other source', () => {
    const { source, creds } = loadCredentials({
        env: { CLAUDE_CODE_OAUTH_TOKEN: ' env-token ' },
        platform: 'darwin',
        readFile: () => JSON.stringify(FILE_CREDS),
        exec: () => JSON.stringify(KEYCHAIN_CREDS),
    });
    assert.equal(source, 'env');
    assert.equal(creds.claudeAiOauth.accessToken, 'env-token');
});

test('credentials file is used before the keychain', () => {
    const { source, creds } = loadCredentials({
        env: {},
        platform: 'darwin',
        readFile: () => JSON.stringify(FILE_CREDS),
        exec: () => { throw new Error('keychain should not be read'); },
    });
    assert.equal(source, 'file');
    assert.equal(creds.claudeAiOauth.accessToken, 'file-token');
});

test('macOS falls back to the "Claude Code-credentials" keychain item', () => {
    let called = null;
    const { source, creds } = loadCredentials({
        env: {},
        platform: 'darwin',
        readFile: noFile,
        exec: (cmd, args) => { called = [cmd, ...args]; return JSON.stringify(KEYCHAIN_CREDS) + '\n'; },
    });
    assert.equal(source, 'keychain');
    assert.equal(creds.claudeAiOauth.accessToken, 'kc-token');
    assert.deepEqual(called, ['security', 'find-generic-password', '-s', 'Claude Code-credentials', '-w']);
});

test('keychain is never consulted off macOS', () => {
    const { source, creds } = loadCredentials({
        env: {},
        platform: 'linux',
        readFile: noFile,
        exec: () => { throw new Error('keychain should not be read'); },
    });
    assert.equal(source, null);
    assert.equal(creds, null);
});

test('no credentials anywhere → null source', () => {
    const { source, creds } = loadCredentials({ env: {}, platform: 'darwin', readFile: noFile, exec: noKeychain });
    assert.equal(source, null);
    assert.equal(creds, null);
});

import { mkdtempSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchQuota, loadCredentialsCached, __resetCredentialCache, __setQuotaClock, __resetQuota } from '../src/proxy/features/oauth.js';

test('"no credentials" is cached briefly (the keychain lookup blocks); file results never are', () => {
    __resetCredentialCache();
    let calls = 0;
    const none = () => { calls++; return { source: null, creds: null }; };
    loadCredentialsCached(none, 1000);
    loadCredentialsCached(none, 20000);
    assert.equal(calls, 1);
    loadCredentialsCached(none, 40000); // past the 30 s TTL
    assert.equal(calls, 2);
    __resetCredentialCache();
    let fileCalls = 0;
    const file = () => { fileCalls++; return { source: 'file', creds: {} }; };
    loadCredentialsCached(file, 1000);
    loadCredentialsCached(file, 1001);
    assert.equal(fileCalls, 2);
    __resetCredentialCache();
});

test('quota: a persistent 401 refreshes once and retries once — no loop; the new file is 0600', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-cred-'));
    const file = join(dir, '.credentials.json');
    writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'old', refreshToken: 'r1' } }));
    const saved = { cfg: process.env.CLAUDE_CONFIG_DIR, tok: process.env.CLAUDE_CODE_OAUTH_TOKEN, fetch: globalThis.fetch, log: console.log, warn: console.warn };
    process.env.CLAUDE_CONFIG_DIR = dir;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    __resetCredentialCache();
    const calls = { usage: 0, token: 0 };
    globalThis.fetch = async (url) => {
        if (String(url).includes('/oauth/usage')) { calls.usage++; return new Response('{}', { status: 401 }); }
        calls.token++;
        return new Response(JSON.stringify({ access_token: 'new', refresh_token: 'r2', expires_in: 3600 }), { status: 200 });
    };
    console.log = () => {}; console.warn = () => {};
    try {
        assert.equal(await fetchQuota({ force: true }), null);
        assert.deepEqual(calls, { usage: 2, token: 1 });
        assert.equal(JSON.parse(readFileSync(file, 'utf8')).claudeAiOauth.refreshToken, 'r2');
        if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600); // Windows has no POSIX modes
    } finally {
        globalThis.fetch = saved.fetch; console.log = saved.log; console.warn = saved.warn;
        if (saved.cfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved.cfg;
        if (saved.tok !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = saved.tok;
        __resetCredentialCache();
    }
});

test('quota: 429 backs off (Retry-After, else 60s doubling to 15min), serves cache, logs once per window', async () => {
    const saved = { tok: process.env.CLAUDE_CODE_OAUTH_TOKEN, fetch: globalThis.fetch, warn: console.warn };
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
    __resetCredentialCache();
    let t = 1_000_000;
    __setQuotaClock(() => t);
    let mode = 'ok'; let retryAfter = null; let calls = 0;
    const warns = [];
    console.warn = (m) => warns.push(String(m));
    globalThis.fetch = async () => {
        calls++;
        if (mode === '429') return new Response('{}', { status: 429, headers: retryAfter ? { 'retry-after': retryAfter } : {} });
        return new Response(JSON.stringify({ five_hour: { utilization: 42, resets_at: null } }), { status: 200 });
    };
    try {
        __resetQuota(); __setQuotaClock(() => t);
        // No data yet + 429: noData shell with retryAt, no throw, one upstream call
        mode = '429';
        let r = await fetchQuota({ force: true });
        assert.equal(r.noData, true); assert.equal(r.retryAt, t + 60000);
        for (let i = 0; i < 5; i++) await fetchQuota({ force: true }); // inside the window: no upstream
        assert.equal(calls, 1); assert.equal(warns.length, 1);
        // Window over: second 429 doubles to 120s
        t += 60000; r = await fetchQuota(); assert.equal(calls, 2); assert.equal(r.retryAt, t + 120000);
        // Recovery caches the good value and resets the step
        mode = 'ok'; t += 120000; r = await fetchQuota();
        assert.equal(r.windows[0].utilization, 0.42); assert.equal(r.stale, undefined);
        // Later 429 with Retry-After: 300 -> serve the cached numbers flagged stale
        mode = '429'; retryAfter = '300'; t += 31000; r = await fetchQuota();
        assert.equal(r.stale, true); assert.equal(r.windows[0].utilization, 0.42); assert.equal(r.retryAt, t + 300000);
        // Cap at 15 minutes
        t += 300000; retryAfter = '99999'; r = await fetchQuota(); assert.equal(r.retryAt, t + 900000);
        // Step resets after success -> back to 60s
        mode = 'ok'; t += 900000; await fetchQuota(); mode = '429'; retryAfter = null; t += 31000; r = await fetchQuota();
        assert.equal(r.retryAt, t + 60000);
    } finally {
        globalThis.fetch = saved.fetch; console.warn = saved.warn;
        if (saved.tok === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved.tok;
        __resetQuota(); __resetCredentialCache();
    }
});
