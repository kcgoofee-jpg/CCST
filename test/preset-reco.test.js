import test from 'node:test';
import assert from 'node:assert/strict';

import { planPresetReco } from '../src/shared/preset-reco.js';

const fields = { inlineSystem: { valid: (v) => typeof v === 'boolean' }, effort: { valid: (v) => typeof v === 'string' } };

test('a recommendation is undone when switching to a preset without one', () => {
    const s0 = { inlineSystem: true, effort: 'auto' };
    const a = planPresetReco(s0, { inlineSystem: false }, null, fields);           // → v1.4
    assert.equal(a.next.inlineSystem, false);
    assert.deepEqual(a.applied, ['inlineSystem']);
    const b = planPresetReco(a.next, undefined, a.record, fields);                  // → Ny (no reco)
    assert.equal(b.next.inlineSystem, true);
    assert.deepEqual(b.restored, ['inlineSystem']);
    assert.equal(b.record, null);
});

test('a manual change after the recommendation is kept', () => {
    const a = planPresetReco({ inlineSystem: true }, { inlineSystem: false }, null, fields);
    const manual = { ...a.next, inlineSystem: true };                               // user flipped it back by hand
    const b = planPresetReco({ ...manual, effort: 'high' }, undefined, a.record, fields);
    assert.deepEqual(b.restored, []);
    assert.equal(b.next.effort, 'high');
});

test('switching between two recommending presets restores then applies', () => {
    const a = planPresetReco({ inlineSystem: true, effort: 'auto' }, { inlineSystem: false }, null, fields);
    const b = planPresetReco(a.next, { effort: 'high' }, a.record, fields);
    assert.deepEqual([b.next.inlineSystem, b.next.effort], [true, 'high']);
    assert.deepEqual(b.record, { before: { effort: 'auto' }, applied: { effort: 'high' } });
});

import { presetRegexCount, presetRegexNote } from '../src/shared/preset-reco.js';

test('preset regex note: only for enabled regex scripts in the preset data', () => {
    const on = { extensions: { regex_scripts: [{ scriptName: 'a' }, { scriptName: 'b', disabled: true }] } };
    assert.equal(presetRegexCount(on), 1);
    assert.equal(presetRegexNote(on), '点酒馆的「立即刷新」让正则生效');
    for (const none of [null, undefined, {}, { extensions: {} }, { extensions: { regex_scripts: [] } }, { extensions: { regex_scripts: [{ disabled: true }] } }]) {
        assert.equal(presetRegexNote(none), '');
    }
});

import { presetFamilyFromEntries, presetEnabledPrompts, presetMismatchNote as mismatchNote } from '../src/shared/preset-reco.js';

const mkPreset = (entries) => ({
    prompts: entries.map(([identifier, name, content]) => ({ identifier, name, content })),
    prompt_order: [{ character_id: 100001, order: entries.map(([identifier, , , enabled = true]) => ({ identifier, enabled })) }],
});

test('preset family comes from the ENABLED entries, not the name (#2)', () => {
    const claude = mkPreset([['a', '破限', '你是 Claude，按下面的规则写。'], ['b', '文风', '细腻']]);
    assert.equal(presetFamilyFromEntries(claude), 'claude');
    // a Claude preset with a Gemini-sounding NAME gets no warning
    assert.equal(mismatchNote('智脑-Z(3.1P)', claude), '');
    // a preset with a bland name whose entries are written for Gemini does
    const gem = mkPreset([['a', 'Gemini 破限', '...'], ['b', '文风', '细腻']]);
    assert.equal(presetFamilyFromEntries(gem), 'gemini');
    assert.match(mismatchNote('我的预设', gem), /^「我的预设」是给 Gemini 的预设$/);
});

test('preset family: disabled entries count for nothing; weak evidence needs two entries; unsure falls back to the name', () => {
    const offClaude = { prompts: [{ identifier: 'a', name: 'Claude 破限', content: '' }, { identifier: 'b', name: 'Gemini 越狱', content: '' }],
        prompt_order: [{ order: [{ identifier: 'a', enabled: false }, { identifier: 'b', enabled: true }] }] };
    assert.deepEqual(presetEnabledPrompts(offClaude).map((p) => p.identifier), ['b']);
    assert.equal(presetFamilyFromEntries(offClaude), 'gemini');
    assert.equal(presetFamilyFromEntries(mkPreset([['a', '规则', '参考 OpenAI 的写法'], ['b', '文风', '细腻']])), null, 'one passing mention is not enough');
    assert.equal(presetFamilyFromEntries(mkPreset([['a', '规则', '参考 OpenAI 的写法'], ['b', '文风', 'GPT 风格']])), 'gpt');
    assert.equal(presetFamilyFromEntries(mkPreset([['a', 'Gemini 破限', ''], ['b', 'GPT 规则', '']])), null, 'two families: no verdict');
    assert.equal(presetFamilyFromEntries(null), null);
    assert.match(mismatchNote('智脑-Z(3.1P)', mkPreset([['a', '文风', '细腻']])), /Gemini/, 'entries say nothing: the name still counts');
    assert.match(mismatchNote('智脑-Z(3.1P)'), /Gemini/, 'preset data unreadable: the name');
});

import { presetTraits } from '../src/shared/preset-reco.js';

test('presetTraits: 果实 and 灰烬之桥 recognised by what they contain, not by name', () => {
    const order = (ids) => [{ character_id: 100001, order: ids.map(([identifier, enabled = true]) => ({ identifier, enabled })) }];
    const guoshi = {
        prompts: [
            { identifier: 'main', name: '🍎 开头', role: 'system', content: '规则' },
            { identifier: 'chatHistory', name: 'Chat History' },
            { identifier: 'farmer', name: '👨🌾 果农来了|必开', role: 'assistant', content: '[任务确认]' },
            ...['盲盒', '日常', '论坛', '网黄', '后台'].map((n) => ({ identifier: n, name: `💡 ${n}剧场`, role: 'system', injection_position: 1, injection_depth: 3, content: n })),
        ],
        prompt_order: order([['main'], ['chatHistory'], ['farmer']]),
        extensions: {
            regex_scripts: [
                { scriptName: 'MoM必选-[3]3楼外伏笔不发送给AI(0927)', promptOnly: true, minDepth: 3, findRegex: '/(?<=<meow_FM>[\\s\\S]*?)seeds/i' },
                { scriptName: 'MoM必选-[2]5楼外只发送摘要和角色表(0927)', promptOnly: true, minDepth: 5, findRegex: '/^[\\s\\S]*(<meow_FM>[\\s\\S]*$)/i' },
                { scriptName: 'MoM美化-[11]摘要幽灵模式', markdownOnly: true, minDepth: null },
                { scriptName: '关着的', promptOnly: true, minDepth: 4, disabled: true },
            ],
            tavern_helper: { scripts: [{ type: 'folder', name: '果实之心', enabled: true, scripts: [{ type: 'script', name: '果实之心丨Git正式版', enabled: true }] }] },
        },
    };
    assert.deepEqual(presetTraits(guoshi), {
        family: 'guoshi',
        prefill: true,
        depthRegexes: [{ name: 'MoM必选-[3]3楼外伏笔不发送给AI(0927)', minDepth: 3 }, { name: 'MoM必选-[2]5楼外只发送摘要和角色表(0927)', minDepth: 5 }],
    });
    const ashen = {
        prompts: [
            { identifier: 'chatHistory' },
            { identifier: 'a', name: '🌈思考开始', role: 'user', content: '<thinking>' },
            { identifier: 'b', name: '✨思维链锁', role: 'system', content: '首段必须是<thinking>' },
            { identifier: 'c', name: '🐕收尾标记', role: 'system', content: '☽ 灰烬里仍有余温☾' },
        ],
        prompt_order: order([['chatHistory'], ['a'], ['b'], ['c']]),
        extensions: { regex_scripts: [{ scriptName: '（3）保留4层正文', promptOnly: true, minDepth: 4 }] },
    };
    assert.deepEqual(presetTraits(ashen), { family: 'ashen', prefill: false, depthRegexes: [{ name: '（3）保留4层正文', minDepth: 4 }] });
    // An assistant entry switched off, or before the history, is no prefill; two markers are not enough.
    const off = { ...guoshi, prompt_order: order([['farmer'], ['chatHistory'], ['main']]), extensions: {} };
    assert.deepEqual(presetTraits(off), { family: null, prefill: false, depthRegexes: [] });
    for (const odd of [null, {}, { prompts: 'x', prompt_order: [{}] }]) assert.deepEqual(presetTraits(odd), { family: null, prefill: false, depthRegexes: [] });
});
