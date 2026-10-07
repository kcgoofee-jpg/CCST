import test from 'node:test';
import assert from 'node:assert/strict';

import { inlineLateSystemMessages } from '../src/proxy/features/system-placement.js';
import { extractSettings } from '../src/proxy/features/settings.js';

const S = (content) => ({ role: 'system', content });
const U = (content) => ({ role: 'user', content });
const A = (content) => ({ role: 'assistant', content });

test('leading system messages stay; depth-injected ones merge into the neighboring user turn', () => {
    const out = inlineLateSystemMessages([
        S('preset'), S('card'),
        A('greeting'),
        U('u1'), A('a1'),
        S('<style>文风</style>'),   // depth 2 injection
        U('u2'),
    ]);
    assert.deepEqual(out, [
        S('preset'), S('card'),
        A('greeting'),
        U('u1'), A('a1'),
        U('<style>文风</style>\n\nu2'),
    ]);
});

test('a deep injection moves up to the current turn so older turns never change', () => {
    const out = inlineLateSystemMessages([
        S('preset'),
        A('greeting'),
        U('u1'),
        S('<mvu>格式</mvu>'),     // depth 4: would merge into u1
        A('a1'), U('u2'), A('a2'),
        S('<style>文风</style>'), // depth 2
        U('u3'),
    ]);
    assert.deepEqual(out, [
        S('preset'),
        A('greeting'),
        U('u1'), A('a1'), U('u2'), A('a2'),
        U('<mvu>格式</mvu>\n\n<style>文风</style>\n\nu3'),
    ]);
});

test('system note after the last user message merges into it (depth 0)', () => {
    const out = inlineLateSystemMessages([S('sys'), U('hi'), S('author note')]);
    assert.deepEqual(out, [S('sys'), U('hi\n\nauthor note')]);
});

test('system note after a trailing assistant prefill moves before it', () => {
    const out = inlineLateSystemMessages([S('sys'), U('hi'), A('prefill'), S('note')]);
    assert.deepEqual(out, [S('sys'), U('hi\n\nnote'), A('prefill')]);
});

test('image content is preserved when merging', () => {
    const img = { type: 'image_url', image_url: { url: 'data:image/png;base64,xx' } };
    const out = inlineLateSystemMessages([S('sys'), U('hi'), A('a'), S('note'), U([{ type: 'text', text: 'look' }, img])]);
    assert.deepEqual(out[3].content, [{ type: 'text', text: 'note' }, { type: 'text', text: 'look' }, img]);
});

test('system messages around a fake assistant acknowledgement all go to the system prompt', () => {
    const out = inlineLateSystemMessages([
        S('team'), A('我们收到了这封信'), S('rules'), S('card'),
        { role: 'user', content: '' },          // empty prompt-manager slot
        A('greeting'), U('u1'),
    ]);
    assert.deepEqual(out, [S('team'), S('rules'), S('card'), A('我们收到了这封信'), A('greeting'), U('u1')]);
});

test('no late system messages → same array back', () => {
    const msgs = [S('sys'), U('hi')];
    assert.equal(inlineLateSystemMessages(msgs), msgs);
});

test('system_placement setting defaults to inline', () => {
    assert.equal(extractSettings({}).systemPlacement, 'inline');
    assert.equal(extractSettings({ claude_subscription: { system_placement: 'hoist' } }).systemPlacement, 'hoist');
});

test('buildSystemPrompt splits at the boundary only when asked, and never lets the CLI record the prompt', async () => {
    const { buildSystemPrompt } = await import('../src/proxy/core/system-prompt.js');
    const plain = (prompt) => ({ type: 'custom', prompt, snapshot: false });
    assert.deepEqual(buildSystemPrompt('abcdef', false), plain('abcdef'));
    assert.deepEqual(buildSystemPrompt('abcdef', false, 3, null), plain('abcdef'));
    assert.deepEqual(buildSystemPrompt('abcdef', false, 3, 'B'), plain(['abc', 'B', 'def']));
    assert.deepEqual(buildSystemPrompt('abcdef', false, 6, 'B'), plain('abcdef'));
    assert.deepEqual(buildSystemPrompt('', false), plain(''));
    assert.equal(buildSystemPrompt('x', true).snapshot, false, 'identity mode too');
});

test('a recorded system prompt is never captured, pinned or replayed', async () => {
    const { createTurnCollector, isRecordedPrompt } = await import('../src/proxy/features/turn-capture.js');
    const snap = { type: 'attachment', uuid: 's', attachment: { type: 'prompt_snapshot', prompt: '别的聊天的预设' } };
    assert.equal(isRecordedPrompt(snap), true);
    assert.equal(isRecordedPrompt({ type: 'attachment', attachment: { type: 'date' } }), false);
    const c = createTurnCollector('你好', '你好', null, '');
    c.onAppend([{ type: 'user', uuid: 'u', message: { role: 'user', content: '你好' } }, snap, { type: 'attachment', uuid: 'd', attachment: { type: 'date' } }, { type: 'assistant', uuid: 'a' }]);
    assert.equal(c.captured, true);
});


test('a known depth injection above the chat (short chat) goes with the current turn, not the system prompt', () => {
    const late = ['<elite_daily>\n原则'];
    const turn1 = inlineLateSystemMessages([S('preset'), S('<elite_daily>\n原则：少写'), A('greeting'), U('u1'), S('tail')], { late });
    assert.deepEqual(turn1, [S('preset'), A('greeting'), U('<elite_daily>\n原则：少写\n\nu1\n\ntail')]);
    // Turn 2: ST now puts it between greeting and u1 → still the current turn, system unchanged.
    const turn2 = inlineLateSystemMessages([S('preset'), A('greeting'), S('<elite_daily>\n原则：少写'), U('u1'), A('a1'), U('u2'), S('tail')], { late });
    assert.deepEqual(turn2[0], S('preset'));
    assert.equal(turn2.at(-1).content, '<elite_daily>\n原则：少写\n\nu2\n\ntail');
    // Without the hint the fake-acknowledgement rule still applies.
    assert.deepEqual(inlineLateSystemMessages([S('a'), A('ack'), S('b'), U('u')])[1], S('b'));
});

test('history bounds: preset user/assistant entries before the chat join the system prompt; a post-history assistant entry is no prefill', async () => {
    const { applyHistoryBounds } = await import('../src/proxy/features/system-placement.js');
    const msgs = [U('💠雪融雪降 规则'), S('卡'), U('ROLE AND GUIDE'), A('开场白：木屋里很冷'), U('我去清点物资'), A('明白了，接下来'), S('尾部规则')];
    const hist = { start: ['开场白：木屋里很冷'], end: ['我去清点物资'] };
    const bounded = applyHistoryBounds(msgs, hist, 'normal');
    assert.deepEqual(bounded.map((m) => m.role), ['system', 'system', 'system', 'assistant', 'user', 'system', 'system']);
    const placed = inlineLateSystemMessages(bounded);
    assert.deepEqual(placed.map((m) => m.role), ['system', 'system', 'system', 'assistant', 'user']);
    assert.equal(placed.at(-1).content, '我去清点物资\n\n明白了，接下来\n\n尾部规则');
    // A continue keeps its trailing assistant as the prefill.
    const cont = applyHistoryBounds([U('规则'), A('开场白：木屋里很冷'), U('继续写'), A('她推开门')], { start: ['开场白：木屋里很冷'], end: ['她推开门'] }, 'continue');
    assert.equal(cont.at(-1).role, 'assistant');
    // A greeting stored with \r\n still matches what ST sends.
    assert.equal(applyHistoryBounds([U('规则'), A('开场白：\n\n木屋里很冷'), U('走')], { start: ['开场白：\r\n\r\n木屋'], end: ['走'] }, 'normal')[1].role, 'assistant');
    // No marks, or marks not found: unchanged.
    assert.equal(applyHistoryBounds(msgs, { start: [], end: [] }), msgs);
    assert.equal(applyHistoryBounds(msgs, { start: ['不存在的开头'], end: [] }), msgs);
});

test('a deep injection already given verbatim in an earlier turn becomes a one-line note', async () => {
    const { REPEAT_NOTE } = await import('../src/proxy/features/lore-tail.js');
    const block = '<WorldFrame>' + '世界书内容'.repeat(60) + '</WorldFrame>';
    let n = 0;
    const out = inlineLateSystemMessages([S('preset'), A('greeting'), U('u1'), S(block), A('a1'), U('u2'), S('tail')],
        { seen: (t) => t === block, onRepeat: () => { n++; } });
    assert.equal(out.at(-1).content, `${REPEAT_NOTE}\n\nu2\n\ntail`);
    assert.equal(n, 1);
    // Not seen before: kept in full.
    const fresh = inlineLateSystemMessages([S('preset'), A('greeting'), U('u1'), S(block), A('a1'), U('u2')], { seen: () => false });
    assert.equal(fresh.at(-1).content, `${block}\n\nu2`);
});
