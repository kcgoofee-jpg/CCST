import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { genStarted, genFinished, isBackgroundRequest, __resetBackgroundForTesting } from '../src/panel/core/background.js';
import { makeCheckupGate } from '../src/panel/core/checkup-gate.js';
import { extractSettings } from '../src/proxy/features/settings.js';
import { refusalNotice, checkReply } from '../src/shared/chat-check.js';

beforeEach(() => __resetBackgroundForTesting());

test('a normal reply is the chat turn; the extension call right after it is background', () => {
    genStarted('normal', {}, false);
    assert.equal(isBackgroundRequest({ type: 'normal' }), false, 'the reply');
    // 柏宝绘 writes its image tags before GENERATION_ENDED, through a plain-typed call
    assert.equal(isBackgroundRequest({ type: 'normal' }), true, 'second request of the same generation');
    genFinished();
    assert.equal(isBackgroundRequest({ type: 'normal' }), true, 'no generation running');
});

test('quiet / raw / unknown types are background, even during a reply', () => {
    genStarted('swipe', {}, false);
    assert.equal(isBackgroundRequest({ type: 'quiet' }), true);
    assert.equal(isBackgroundRequest({}), true, 'generateRaw-style: no type');
    assert.equal(isBackgroundRequest({ type: 'something_custom' }), true);
    assert.equal(isBackgroundRequest({ type: 'swipe' }), false, 'the reply is still claimable');
});

test('quiet generations and dry runs never start a chat turn; each new generation re-arms', () => {
    genStarted('quiet', {}, false);
    assert.equal(isBackgroundRequest({ type: 'normal' }), true);
    genStarted('normal', { quiet_prompt: 'x' }, false);
    assert.equal(isBackgroundRequest({ type: 'normal' }), true);
    genStarted('normal', {}, true);
    assert.equal(isBackgroundRequest({ type: 'normal' }), true);
    genStarted('regenerate', {}, false);
    assert.equal(isBackgroundRequest({ type: 'regenerate' }), false);
    genFinished();
    genStarted('continue', {}, false);
    assert.equal(isBackgroundRequest({ type: 'continue' }), false);
});

test('without generation events (old ST) the type alone decides', () => {
    assert.equal(isBackgroundRequest({ type: 'normal' }), false);
    assert.equal(isBackgroundRequest({ type: 'quiet' }), true);
});

test('proxy: purpose quiet is auxiliary and carries no chat key, so it can never be 上一轮', () => {
    const s = extractSettings({ claude_subscription: { purpose: 'quiet', thinking: 'adaptive' } });
    assert.equal(s.auxiliary, true);
    assert.equal(s.purpose, 'quiet');
    assert.equal(s.chatKey, null);
    // a bare call (no panel settings) is auxiliary too
    assert.equal(extractSettings({}).auxiliary, true);
});

test('check-up waits for the generation to end, then runs once (toast request is kept)', () => {
    let generating = true;
    const runs = [];
    const gate = makeCheckupGate({ isGenerating: () => generating, run: (o) => runs.push(o) });
    assert.equal(gate.request({}), false);
    assert.equal(gate.request({ toast: true }), false);
    assert.equal(gate.request({}), false);
    assert.deepEqual(runs, [], 'nothing while streaming: no badge flash');
    assert.equal(gate.flush(), false, 'still generating');
    generating = false;
    assert.equal(gate.flush(), true);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].toast, true);
    assert.equal(gate.flush(), false, 'nothing left');
    assert.equal(gate.request({ toast: false }), true, 'idle: runs right away');
    assert.equal(runs.length, 2);
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
    assert.ok(checkReply({ mes: '我不能继续这个故事。' }).issues.some((i) => i.code === 'refusal'));
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
