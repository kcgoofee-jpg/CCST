import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeStatsAfterReply } from '../src/panel/core/stats-after-reply.js';
import { extraModelId, appName, isPhoneLike } from '../src/panel/core/capabilities.js';
import { canonicalModel, isAdaptiveOnly } from '../src/shared/sources.js';
import { isAdaptiveOnlyModel } from '../src/proxy/core/models.js';

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
const PICKS = [{ value: 'claude-opus-5-5' }, { value: 'claude-opus-4-6' }, { value: 'claude-sonnet-5-5' }];

test('model card: extra option only for Claude ids', () => {
    assert.equal(extraModelId('gemini-2.5-pro', PICKS, canonicalModel), '');
    assert.equal(extraModelId('gpt-5', PICKS, canonicalModel), '');
    assert.equal(extraModelId(null, PICKS, canonicalModel), '');
    assert.equal(extraModelId('claude-opus-4-6[1m]', PICKS, canonicalModel), '');
    assert.equal(extraModelId('claude-haiku-4-5', PICKS, canonicalModel), 'claude-haiku-4-5');
    assert.equal(extraModelId('anthropic/claude-opus-4.7', PICKS, canonicalModel), 'claude-opus-4-7');
    assert.match(src('panel/features/models.js'), /dataset\.extra[\s\S]*rebuildPanel/);
});

test('stats refresh after a reply: waits, reads, retries once if lastRequest unchanged', async () => {
    const timers = [];
    let stats = { phase: 'ok', data: { lastRequest: { id: 1 } } };
    let calls = 0;
    const refresh = async () => { calls++; };
    const schedule = makeStatsAfterReply({ refresh, getStats: () => stats, setTimer: (fn, ms) => { timers.push([fn, ms]); return timers.length; } });
    schedule(); schedule(); // two events for one reply share one run
    assert.equal(timers.length, 1);
    assert.equal(timers[0][1], 1500);
    const run = timers.shift()[0]();
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 1);
    assert.equal(timers.length, 1);        // unchanged: one retry is queued
    timers.shift()[0]();
    await run;
    assert.equal(calls, 2);

    // changed on the first read: no retry
    calls = 0;
    const s2 = makeStatsAfterReply({ refresh: async () => { calls++; stats = { phase: 'ok', data: { lastRequest: { id: 2 } } }; }, getStats: () => stats, setTimer: (fn, ms) => { timers.push([fn, ms]); return 1; } });
    s2();
    await timers.shift()[0]();
    assert.equal(calls, 1);
    assert.equal(timers.length, 0);
});

test('events: MESSAGE_RECEIVED and GENERATION_ENDED both trigger the stats refresh', () => {
    const ev = src('panel/core/events.js');
    assert.match(ev, /GENERATION_ENDED, \(\) => refreshAfterReply\(\)/);
    assert.match(ev, /MESSAGE_RECEIVED, onOwnReply\(\(\) => refreshAfterReply\(\)\)/);
});

test('connect toast is one line, long-lived; advice is separate', () => {
    const shell = src('panel/shell.js');
    assert.match(shell, /notify\('ok', '已连接', profileNotice\([^\n]*ms: 10000/);
    assert.match(shell, /connectAdvice\(/);
    assert.doesNotMatch(shell, /presetNote: \(libs/);
});

test('手机连接: 酒馆侧地址 hidden on TauriTavern / phone, kept on desktop', () => {
    assert.equal(isPhoneLike({ tauri: true, coarse: false }), true);
    assert.equal(isPhoneLike({ tauri: false, coarse: true }), true);
    assert.equal(isPhoneLike({ tauri: false, coarse: false }), false);
    assert.match(src('panel/tabs/other.js'), /showStEndpoint\(\) \? \[stEndpointField/);
});

test('使用说明: plain, current wording', () => {
    const other = src('panel/tabs/other.js');
    assert.doesNotMatch(other, /Agent SDK|一小时|里选 Claude 模型/);
    assert.match(other, /一键连接」，会自动选好 Claude 模型/);
});

test('TauriTavern named in the connect texts', () => {
    assert.equal(appName(true), 'TauriTavern');
    assert.equal(appName(false), '酒馆');
    const shell = src('panel/shell.js');
    assert.match(shell, /\$\{APP_NAME\}还没接上/);
    assert.match(shell, /让\$\{APP_NAME\}改用它/);
    assert.match(shell, /会把\$\{APP_NAME\}现在的连接/);
});

test('always-thinking models: disabled 不思考, and the list matches the proxy catalog', () => {
    for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-opus-4-7', 'claude-opus-4-8', 'anthropic/claude-opus-4.7', 'claude-opus-5']) assert.equal(isAdaptiveOnly(id), true, id);
    for (const id of ['claude-opus-4-6', 'claude-opus-4-6[1m]', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'gemini-2.5-pro', '']) assert.equal(isAdaptiveOnly(id), false, id);
    for (const id of ['claude-fable-5-1', 'claude-fable-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5']) assert.equal(isAdaptiveOnly(id), isAdaptiveOnlyModel(id), id);
    assert.match(src('panel/tabs/reason.js'), /这个模型总会思考/);
});

test('不思考: no effort is sent', async () => {
    globalThis.SillyTavern = { getContext: () => ({ chatCompletionSettings: {} }) };
    const { buildIncludeBodyYaml } = await import('../src/panel/core/inject.js');
    const base = { effort: 'high', thinking: 'adaptive', showReasoning: true, identityMode: 'x', useResume: false, loreTail: false, foldTail: false };
    assert.match(buildIncludeBodyYaml(base), /effort: high/);
    const off = buildIncludeBodyYaml({ ...base, thinking: 'off' });
    assert.doesNotMatch(off, /effort:/);
    assert.match(off, /thinking: off/);
});

test('体检: sub-toggles are greyed while the master switch is off', () => {
    const check = src('panel/tabs/check.js');
    assert.match(check, /input\.disabled = !settings\.heuristicChecks/);
    assert.match(check, /claudeMaxCheckupToast', 'claude_max_card_audit_on/);
});
