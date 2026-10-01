import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProfileList, planProfile, profileNotice, ensureProfile, describeCurrentConnection } from '../src/panel/core/connection-profile.js';

test('no CCST profile yet: apply first, then create (which also selects it)', () => {
    const plan = planProfile('["我的 Claude","备用"]');
    assert.deepEqual(plan, { existed: false, select: null, save: '/profile-create CCST' });
    assert.equal(planProfile('[]').existed, false);
    assert.equal(planProfile('not json').existed, false);
    assert.deepEqual(parseProfileList('{"a":1}'), []);
});

test('CCST exists: select it, re-apply on top, then update; other profiles are never named', () => {
    const plan = planProfile('["备用","CCST"]');
    assert.deepEqual(plan, { existed: true, select: '/profile CCST', save: '/profile-update' });
});

test('ensureProfile runs the commands in order, awaiting each', async () => {
    const log = [];
    const run = async (cmd) => { log.push(cmd); await Promise.resolve(); return cmd === '/profile-list' ? '["CCST"]' : 'CCST'; };
    const res = await ensureProfile({
        run, hasCommands: () => true,
        applyConnection: async () => { log.push('apply'); },
        settle: async () => { log.push('settle'); },
    });
    assert.deepEqual(res, { ok: true, existed: true });
    assert.deepEqual(log, ['/profile-list', '/profile CCST', 'apply', 'settle', '/profile-update']);

    log.length = 0;
    const fresh = await ensureProfile({
        run: async (cmd) => { log.push(cmd); return cmd === '/profile-list' ? '["备用"]' : 'CCST'; },
        hasCommands: () => true, applyConnection: async () => { log.push('apply'); }, settle: async () => { log.push('settle'); },
    });
    assert.deepEqual(fresh, { ok: true, existed: false });
    assert.deepEqual(log, ['/profile-list', 'settle', '/profile-create CCST']);
});

test('no connection manager, or ST refusing, is reported instead of thrown', async () => {
    assert.deepEqual(await ensureProfile({ run: async () => '', hasCommands: () => false, applyConnection: async () => {} }),
        { ok: false, reason: 'no-connection-manager' });
    const refused = await ensureProfile({ run: async (c) => (c === '/profile-list' ? '[]' : ''), hasCommands: () => true, applyConnection: async () => {} });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'refused');
});

test('notice text: one short line', () => {
    assert.equal(profileNotice({ existed: false, modelLabel: 'Opus 4.6' }), '已连接 CCST · 模型 Opus 4.6');
    assert.equal(profileNotice({ existed: true, modelLabel: 'Sonnet 5.5 1M' }), '已连接 CCST · 模型 Sonnet 5.5 1M');
    assert.match(profileNotice({ existed: false, modelOk: false }), /模型没能自动选上/);
    assert.doesNotMatch(profileNotice({}), /Gemini|正则|核对/);
});

test('connect keeps a Claude model ST already has (incl. [1m]); default only for none / non-Claude', async () => {
    const { chooseConnectModel, PROFILE_MODEL } = await import('../src/panel/core/connection-profile.js');
    const { canonicalModel } = await import('../src/shared/sources.js');
    assert.equal(chooseConnectModel('claude-sonnet-5-5', canonicalModel), 'claude-sonnet-5-5');
    assert.equal(chooseConnectModel('claude-opus-4-6[1m]', canonicalModel), 'claude-opus-4-6[1m]');
    assert.equal(chooseConnectModel('anthropic/claude-opus-4.7', canonicalModel), 'claude-opus-4-7');
    assert.equal(chooseConnectModel('gemini-2.5-pro', canonicalModel), PROFILE_MODEL);
    assert.equal(chooseConnectModel('', canonicalModel), PROFILE_MODEL);
    assert.equal(chooseConnectModel(null), PROFILE_MODEL);
    assert.equal(chooseConnectModel('claude-opus-4-5[1m]'), 'claude-opus-4-5[1m]');
});

test('advice notices are separate and only when they apply', async () => {
    const { connectAdvice } = await import('../src/panel/core/connection-profile.js');
    assert.deepEqual(connectAdvice({}), []);
    assert.deepEqual(connectAdvice({ presetNote: 'A' }).map((a) => a.key), ['connect-preset']);
    assert.equal(connectAdvice({ presetNote: 'A', regexNote: 'B' }).length, 2);
});

test('confirm popup: no profile selected ("<None>") leaves the profile part out', () => {
    const t = describeCurrentConnection({ profile: '<None>', source: 'custom', url: 'http://127.0.0.1:8901/v1', model: 'claude-opus-4-6' });
    assert.equal(t, '来源 自定义（兼容 OpenAI） · http://127.0.0.1:8901/v1 · claude-opus-4-6');
    assert.equal(describeCurrentConnection({ profile: '我的 Claude', source: 'claude' }), '连接配置「我的 Claude」 · 来源 Claude');
    assert.equal(describeCurrentConnection({}), '');
});

test('confirm popup: only the given (current source) model is shown', () => {
    assert.equal(describeCurrentConnection({ source: 'openai', model: '' }), '来源 OpenAI');
});

import { sourceLabel } from '../src/panel/core/connection-profile.js';

test('source ids map to the names in ST\'s 来源 dropdown; unknown ids stay raw', () => {
    assert.equal(sourceLabel('custom'), '自定义（兼容 OpenAI）');
    assert.equal(sourceLabel('claude'), 'Claude');
    assert.equal(sourceLabel('openrouter'), 'OpenRouter');
    assert.equal(sourceLabel('makersuite'), 'Google AI Studio');
    assert.equal(sourceLabel('some-new-source'), 'some-new-source');
    assert.doesNotMatch(describeCurrentConnection({ source: 'custom' }), /\bcustom\b/);
});
