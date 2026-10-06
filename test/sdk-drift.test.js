// #30: the SDK/CLI drift surface — what the proxy checks and says out loud when
// the SDK under it changes (startup self-check, version trace, visible sweeps,
// a number for how long it has been falling back to the transcript fold).

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REQUIRED_EXPORTS, checkSdkCompat, __setSdkForTesting } from '../src/proxy/core/sdk-loader.js';
import { handleStatus } from '../src/proxy/api/status.js';
import { SDK_VERSION, noteSdkVersionRun } from '../src/proxy/features/sdk-version.js';
import { noteFoldOutcome, foldStreak, __resetFoldStreakForTesting } from '../src/proxy/core/chat.js';
import { sweepSessionTranscript, sweepLeftovers, projectKeyFor, flushSweeps } from '../src/proxy/features/session-store.js';

/** Run fn with console.log/warn collected. */
function capture(fn) {
    const { log, warn } = console;
    const lines = [];
    console.log = (...a) => lines.push(a.join(' '));
    console.warn = (...a) => lines.push(a.join(' '));
    try { fn(); } finally { console.log = log; console.warn = warn; }
    return lines.join('\n');
}

async function statusOnce() {
    let out = null;
    const res = { json: (b) => { out = b; return res; }, status: (c) => ({ json: (b) => { out = b; return c; } }) };
    await handleStatus({ originalUrl: '/status' }, res);
    return out;
}

test('the proxy names the SDK exports it depends on (#30)', () => {
    assert.deepEqual(REQUIRED_EXPORTS, ['query', 'SYSTEM_PROMPT_DYNAMIC_BOUNDARY', 'deleteSession']);
    assert.deepEqual(checkSdkCompat({ query: () => {}, SYSTEM_PROMPT_DYNAMIC_BOUNDARY: 'b', deleteSession: () => {} }), { ok: true, missing: [] });
    assert.deepEqual(checkSdkCompat({ query: () => {} }).missing, ['SYSTEM_PROMPT_DYNAMIC_BOUNDARY', 'deleteSession']);
    assert.equal(checkSdkCompat(undefined).ok, false);
});

test('/status reports compat, ok and missing (#30)', async () => {
    __setSdkForTesting({ query: () => {}, SYSTEM_PROMPT_DYNAMIC_BOUNDARY: 'b' });
    assert.deepEqual((await statusOnce()).compat, { ok: false, missing: ['deleteSession'] });
    __setSdkForTesting({ query: () => {}, SYSTEM_PROMPT_DYNAMIC_BOUNDARY: 'b', deleteSession: () => {} });
    const body = await statusOnce();
    assert.deepEqual(body.compat, { ok: true, missing: [] });
    assert.equal(body.sdkVersion, SDK_VERSION);
    assert.equal(typeof body.foldStreak, 'number');
    __setSdkForTesting(null);
});

test('a different SDK than last run is logged and remembered (#30)', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cm-sdkver-')), 'sdk-version.json');
    const saved = process.env.CLAUDE_SUBSCRIPTION_SDK_VERSION_FILE;
    process.env.CLAUDE_SUBSCRIPTION_SDK_VERSION_FILE = file;
    try {
        writeFileSync(file, JSON.stringify({ version: '0.1.0-previous' }));
        let previous = null;
        const lines = capture(() => { previous = noteSdkVersionRun(); });
        assert.equal(previous, '0.1.0-previous');
        assert.match(lines, /SDK 已从 0\.1\.0-previous 变为/);
        assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, SDK_VERSION, 'the new version is on disk');

        const again = capture(() => noteSdkVersionRun());
        assert.doesNotMatch(again, /SDK 已从/, 'the same version says nothing');
    } finally {
        if (saved === undefined) delete process.env.CLAUDE_SUBSCRIPTION_SDK_VERSION_FILE; else process.env.CLAUDE_SUBSCRIPTION_SDK_VERSION_FILE = saved;
    }
});

test('a first run has nothing to compare against (#30)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-sdkver2-'));
    const saved = process.env.CLAUDE_SUBSCRIPTION_SDK_VERSION_FILE;
    process.env.CLAUDE_SUBSCRIPTION_SDK_VERSION_FILE = join(dir, 'sub', 'sdk-version.json');
    try {
        const lines = capture(() => assert.equal(noteSdkVersionRun(), null));
        assert.doesNotMatch(lines, /SDK 已从/);
        assert.equal(existsSync(process.env.CLAUDE_SUBSCRIPTION_SDK_VERSION_FILE), true, 'created, including the missing dir');
    } finally {
        if (saved === undefined) delete process.env.CLAUDE_SUBSCRIPTION_SDK_VERSION_FILE; else process.env.CLAUDE_SUBSCRIPTION_SDK_VERSION_FILE = saved;
    }
});

test('the fold streak counts degraded rounds and clears on a resume (#30)', () => {
    __resetFoldStreakForTesting();
    assert.equal(foldStreak(), 0);
    assert.equal(noteFoldOutcome('fold', { useResume: true }), 1);
    assert.equal(noteFoldOutcome('fold', { useResume: true }), 2);
    assert.equal(noteFoldOutcome('resume', { useResume: true }), 0, 'one resume round clears it');
    assert.equal(noteFoldOutcome('fold', { useResume: false }), 0, 'resume off by the user is not a degradation');
    assert.equal(foldStreak(), 0);
});

test('a SDK without deleteSession says so instead of sweeping silently (#30)', async () => {
    const lines = await captureAsync(async () => {
        sweepSessionTranscript(async () => ({ query: () => {} }), 'sess-quiet');
        await flushSweeps();
    });
    assert.match(lines, /没有 deleteSession/);
    assert.match(lines, /sess-quiet/);
});

/** capture() for async work. */
async function captureAsync(fn) {
    const { log, warn } = console;
    const lines = [];
    console.log = (...a) => lines.push(a.join(' '));
    console.warn = (...a) => lines.push(a.join(' '));
    try { await fn(); } finally { console.log = log; console.warn = warn; }
    return lines.join('\n');
}

test('a transcript dir that cannot be cleaned is reported (#30)', { skip: process.platform === 'win32' ? 'chmod 000 does not block deletion on Windows' : false }, () => {
    if (process.getuid && process.getuid() === 0) return; // root ignores the chmod below
    const base = mkdtempSync(join(tmpdir(), 'cm-sweep-'));
    const scratch = join(base, 'scratch');
    mkdirSync(scratch, { recursive: true });
    const project = join(base, 'config', 'projects', projectKeyFor(scratch));
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, '00000000-0000-4000-8000-000000000000.jsonl'), '{}\n');
    chmodSync(project, 0o000);
    try {
        const lines = capture(() => assert.equal(sweepLeftovers({ tmp: join(base, 'empty-tmp'), configDir: join(base, 'config'), scratch }).transcripts, 0));
        assert.match(lines, /清理会话记录目录|清理上次遗留的会话记录/);
        assert.ok(lines.includes(project), `names the dir: ${lines}`);
    } finally {
        chmodSync(project, 0o755);
    }
});
