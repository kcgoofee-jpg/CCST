import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shapeOf, firstDifference } from '../src/proxy/features/diag-report.js';
import { usageOf } from '../src/proxy/features/wire-tap.js';

const billing = (v) => ({ type: 'text', text: `x-anthropic-billing-header: cc_version=2.1.285.${v}; cc_entrypoint=sdk-ts;` });
const rem = (t) => ({ type: 'text', text: `<system-reminder>\n${t}\n</system-reminder>\n` });
const body = (sysV, messages) => ({
    model: 'claude-opus-4-6', max_tokens: 100,
    system: [billing(sysV), { type: 'text', text: '角色卡'.repeat(100), cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages,
});

test('shape carries sizes, hashes and breakpoints, never the text', () => {
    const s = shapeOf(body('abc', [{ role: 'user', content: [rem('环境'), { type: 'text', text: '秘密台词', cache_control: { type: 'ephemeral', ttl: '1h' } }] }]));
    assert.equal(s.cliVersion, '2.1.285');
    assert.equal(s.system[0].kind, 'billing');
    assert.equal(s.system[1].cc, '1h');
    assert.equal(s.messages[0].blocks[0].kind, 'reminder');
    assert.ok(!JSON.stringify(s).includes('秘密台词'));
    assert.ok(!JSON.stringify(s).includes('角色卡'));
});

test('billing header changes are ignored; a history message that lost its reminder is named', () => {
    const t1 = shapeOf(body('aaa', [{ role: 'user', content: [rem('环境'), { type: 'text', text: '你好' }] }]));
    const t2 = shapeOf(body('bbb', [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: [{ type: 'text', text: '嗯' }] },
        { role: 'user', content: [rem('环境'), { type: 'text', text: '再见' }] },
    ]));
    assert.match(firstDifference(t1, t2), /逐轮还原没生效/);
    const t2b = shapeOf(body('ccc', [
        { role: 'user', content: [rem('环境'), { type: 'text', text: '你好' }] },
        { role: 'assistant', content: [{ type: 'text', text: '嗯' }] },
        { role: 'user', content: [rem('环境'), { type: 'text', text: '再见' }] },
    ]));
    assert.match(firstDifference(t1, t2b), /只在末尾新增/);
});

test('a changed system prompt and a model switch are named', () => {
    const a = shapeOf(body('a', [{ role: 'user', content: 'x' }]));
    const b = shapeOf({ ...body('a', [{ role: 'user', content: 'x' }]), system: [billing('a'), { type: 'text', text: '别的预设' }] });
    assert.match(firstDifference(a, b), /系统提示词第 1 块就不同/);
    assert.match(firstDifference(a, { ...a, model: 'claude-opus-5-5' }), /模型不同/);
});

test('usage is read from a streamed reply (message_start + message_delta)', () => {
    const sse = [
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":3,"cache_read_input_tokens":900,"cache_creation_input_tokens":20,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":20}}}}',
        '',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}',
    ].join('\n');
    const u = usageOf(sse);
    assert.equal(u.cache_read_input_tokens, 900);
    assert.equal(u.output_tokens, 7);
    assert.equal(u.cache_creation.ephemeral_1h_input_tokens, 20);
});

test('stChanges names what changed in SillyTavern between two turns of a chat', async () => {
    const { stChanges } = await import('../src/proxy/features/diag-report.js');
    const st = (over) => ({ preset: '衡', pp: 'none', order: 'aa', wi: ['输出格式', '机制索引'], ...over });
    const a = { chatKey: 'k', st: st() };
    assert.equal(stChanges({ chatKey: 'k', st: st() }, a), '');
    assert.match(stChanges({ chatKey: 'k', st: st({ pp: 'strict', wi: ['机制索引'] }) }, a), /后处理none→strict.*−输出格式/);
    assert.match(stChanges({ chatKey: 'k', st: st({ order: 'bb' }) }, a), /预设条目改动/);
    assert.equal(stChanges({ chatKey: 'other', st: st({ pp: 'strict' }) }, a), '', 'another chat is not compared');
});

test('report line names the scripts when the prompt changed with no SillyTavern change', async () => {
    const { stChanges } = await import('../src/proxy/features/diag-report.js');
    const st = { preset: 'Izumi', pp: 'none', order: 'aa', wi: [], mut: ['脚本「泉此方悬浮窗」'] };
    const line = stChanges({ chatKey: 'k', st, cacheDiag: { systemChanged: true } }, { chatKey: 'k', st });
    assert.match(line, /酒馆没改设置，可能是: 脚本「泉此方悬浮窗」/);
    assert.equal(stChanges({ chatKey: 'k', st, cacheDiag: { reroll: true } }, { chatKey: 'k', st }), '');
});
