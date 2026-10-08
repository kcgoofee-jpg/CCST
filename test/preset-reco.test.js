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
