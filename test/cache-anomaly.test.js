// #26: the 「nothing changed, yet the history was re-written」 check is a server-side
// health signal now — after two turns in a row it resets the per-turn replay itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cacheAnomaly, explainCache } from '../src/proxy/features/cache-diag.js';
import { hasPinnedContext, pinContext, __resetTurnCaptures } from '../src/proxy/features/turn-capture.js';

const quiet = (fn) => async (...a) => {
    const log = console.log, warn = console.warn;
    console.log = console.warn = () => {};
    try { return await fn(...a); } finally { console.log = log; console.warn = warn; }
};

const diag = (chat) => ({ chat, firstTurn: false, systemChanged: false, historyDiffAt: null });
const entry = (chat, read, wrote) => ({ ok: true, model: 'claude-opus-5', cacheDiag: diag(chat), cacheReadTokens: read, cacheCreationTokens: wrote, inputTokens: 10 });

test('cacheAnomaly: same chat, nothing changed, read below last turn\'s prompt', () => {
    const prev = entry('c1', 40_000, 2_000);
    assert.equal(cacheAnomaly(entry('c1', 3_000, 30_000), prev), true);
    assert.equal(cacheAnomaly(entry('c1', 42_000, 1_000), prev), false, 'the read grew past last turn: cache is being used');
    assert.equal(cacheAnomaly(entry('c2', 3_000, 30_000), prev), false, 'another chat is not a continuation');
    assert.equal(cacheAnomaly({ ...entry('c1', 3_000, 30_000), cacheDiag: { ...diag('c1'), systemChanged: true } }, prev), false, 'the prompt did change');
    assert.equal(cacheAnomaly({ ...entry('c1', 3_000, 30_000), cacheDiag: { ...diag('c1'), historyDiffAt: 2 } }, prev), false, 'the history did change');
    assert.equal(cacheAnomaly({ ...entry('c1', 3_000, 30_000), model: 'claude-sonnet-5' }, prev), false, 'another model re-writes on its own');
    assert.equal(cacheAnomaly({ ...entry('c1', 3_000, 30_000), cacheDiag: { ...diag('c1'), firstTurn: true } }, prev), false, 'the first turn after a restart');
    assert.equal(cacheAnomaly(entry('c1', 3_000, 30_000), null), false);
    const t = 1_800_000_000_000;
    assert.equal(cacheAnomaly({ ...entry('c1', 3_000, 30_000), at: t + 2 * 3_600_000, durationMs: 1000 }, { ...prev, at: t, durationMs: 1000 }), false, 'past the 1-hour TTL the cache expired');
});

test('explainCache still says it out loud, with the way to fix it', () => {
    const prev = entry('c1', 40_000, 2_000);
    const line = explainCache(entry('c1', 3_000, 30_000), prev).reasons.find((r) => r.startsWith('异常'));
    assert.ok(line, 'the panel keeps the explanation');
    assert.match(line, /wire-diagnosis\.mjs/);
    assert.doesNotMatch(line, /claude-agent-sdk@/, 'no more 「downgrade the SDK」: 5.2.0 pins it, and it never fixed an expired cache');
});

test('two turns in a row of it reset the replay and tell the panel (#26)', quiet(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-anomaly-'));
    process.env.CLAUDE_SUBSCRIPTION_STATS_FILE = join(dir, 'usage.jsonl');
    process.env.CLAUDE_SUBSCRIPTION_CONTEXT_PIN_FILE = join(dir, 'cli-context.json');
    const stamp = Date.now();
    const stats = await import(`../src/proxy/features/usage-stats.js?a=${stamp}`);
    stats.__resetStatsForTesting();
    __resetTurnCaptures();
    pinContext('m-anomaly', [{ type: 'attachment', uuid: 'p1', attachment: { type: 'date', date: '2026-09-26' } }]);
    assert.equal(hasPinnedContext('m-anomaly'), true);

    const base = { model: 'claude-opus-5', startedAt: Date.now(), textChars: 10, stream: false, chatKey: 'c1' };
    const req = (wrote) => stats.recordRequest({ ...base, startedAt: Date.now(), usage: { cache_read_input_tokens: 3_000, cache_creation_input_tokens: wrote }, cacheDiag: diag('c1') });
    assert.equal(req(30_000).notices, undefined, 'no turn before it');
    assert.equal(req(30_000).notices, undefined, 'the first anomaly is still one turn of noise');
    assert.deepEqual(req(31_000).notices, ['replay-reset'], 'the second one in a row resets');
    assert.equal(hasPinnedContext('m-anomaly'), false, 'the pin is gone');
    const written = readFileSync(process.env.CLAUDE_SUBSCRIPTION_STATS_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(written.at(-1).notices, ['replay-reset']);
    delete process.env.CLAUDE_SUBSCRIPTION_CONTEXT_PIN_FILE;
    __resetTurnCaptures();
}));
