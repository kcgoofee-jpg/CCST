import { test, } from 'node:test';
import assert from 'node:assert/strict';

import { extractSettings } from '../src/proxy/features/settings.js';
import { refusalNotice, replyFlags } from '../src/shared/chat-check.js';


test('proxy: purpose quiet is auxiliary and carries no chat key, so it can never be 上一轮', () => {
    const s = extractSettings({ claude_subscription: { purpose: 'quiet', thinking: 'adaptive' } });
    assert.equal(s.auxiliary, true);
    assert.equal(s.purpose, 'quiet');
    assert.equal(s.chatKey, null);
    // a bare call (no panel settings) is auxiliary too
    assert.equal(extractSettings({}).auxiliary, true);
});

test('proxy refusal signal: an empty refused turn is a decline, partial text is a cut-off', () => {
    const declined = refusalNotice({ notices: ['refusal'], finish: 'content_filter', textChars: 40 });
    assert.equal(declined.declined, true);
    assert.match(declined.title, /模型拒绝了这一轮/);
    assert.match(declined.text, /Anthropic 使用政策/);
    assert.doesNotMatch(declined.text, /重新生成|换/);
    const cut = refusalNotice({ notices: ['refusal'], finish: 'content_filter', textChars: 1500 });
    assert.equal(cut.declined, false);
    assert.equal(refusalNotice({ notices: [], finish: 'stop', textChars: 10 }), null);
    assert.equal(refusalNotice(null), null);
    assert.ok(replyFlags('我不能继续这个故事。', null).some((i) => i.code === 'refusal'));
});

test('stats: a background call after the reply never becomes the chat\'s last turn', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    process.env.CLAUDE_SUBSCRIPTION_STATS_FILE = join(mkdtempSync(join(tmpdir(), 'cm-bg-')), 'usage.jsonl');
    const stats = await import('../src/proxy/features/usage-stats.js');
    stats.__resetStatsForTesting();
    const log = console.log;
    console.log = () => {};
    try {
        const t0 = Date.now() - 80000;
        stats.recordRequest({ model: 'claude-opus-4-6', stream: true, startedAt: t0, usage: { input_tokens: 5, output_tokens: 900, cache_read_input_tokens: 70, cache_creation_input_tokens: 930 }, textChars: 713, chatKey: 'aaaa1111aaaa1111', purpose: 'chat' });
        stats.recordRequest({ model: 'claude-opus-4-6', stream: true, startedAt: Date.now() - 15000, usage: { input_tokens: 5, output_tokens: 197 }, textChars: 90, auxiliary: true, purpose: 'quiet' });
    } finally {
        console.log = log;
    }
    const s = stats.summarizeStats(Date.now(), { chat: 'aaaa1111aaaa1111' });
    assert.equal(s.lastRequest.textChars, 713);
    assert.equal(s.lastRequest.auxiliary, false);
    assert.equal(stats.summarizeStats().lastRequest.textChars, 713);
});
