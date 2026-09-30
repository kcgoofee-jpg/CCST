import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test("last turn is per chat: another chat's turns never show, a chat without replies gets none", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-stats-chat-'));
    process.env.CLAUDE_SUBSCRIPTION_STATS_FILE = join(dir, 'usage.jsonl');
    const stats = await import('../src/proxy/features/usage-stats.js');
    stats.__resetStatsForTesting();
    const log = console.log;
    console.log = () => {};
    try {
        const t0 = Date.now() - 5000;
        const usage = { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 500, cache_creation_input_tokens: 50 };
        stats.recordRequest({ model: 'claude-opus-4-6', path: 'resume', stream: true, startedAt: t0, usage, textChars: 10, chatKey: 'aaaa1111aaaa1111' });
        stats.recordRequest({ model: 'claude-sonnet-5-5', path: 'resume', stream: true, startedAt: t0, usage, textChars: 10, chatKey: 'bbbb2222bbbb2222' });
    } finally {
        console.log = log;
    }
    const a = stats.summarizeStats(Date.now(), { chat: 'aaaa1111aaaa1111' });
    assert.equal(a.lastRequest.model, 'claude-opus-4-6');
    assert.ok(a.lastCache);
    const fresh = stats.summarizeStats(Date.now(), { chat: 'cccc3333cccc3333' });
    assert.equal(fresh.lastRequest, null);
    assert.equal(fresh.lastCache, null);
    assert.equal(fresh.week.requests, 2, 'totals stay global');
    assert.equal(stats.summarizeStats().lastRequest.model, 'claude-sonnet-5-5', 'no ?chat= keeps the old behaviour');
    let body;
    stats.handleStats({ query: { chat: 'cccc3333cccc3333' } }, { json: (b) => { body = b; } });
    assert.equal(body.lastRequest, null);
});
