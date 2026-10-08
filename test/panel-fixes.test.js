import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeStatsAfterReply } from '../src/panel/core/stats-after-reply.js';
import { appName } from '../src/panel/core/capabilities.js';
import { canonicalModel, isAdaptiveOnly } from '../src/shared/sources.js';
import { isAdaptiveOnlyModel } from '../src/proxy/core/models.js';

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
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

test('TauriTavern named in the connect texts', () => {
    assert.equal(appName(true), 'TauriTavern');
    assert.equal(appName(false), '酒馆');
    const shell = src('panel/shell.js');
    // The short copy names no app at all, so TauriTavern users never read a hard-coded 「酒馆」 here.
    assert.match(shell, /key: 'connect', title: '还没连上'/);
    assert.match(src('panel/tabs/settings.js'), /notify\('info', '地址已改', '点「重新连接」生效'/);
    assert.doesNotMatch(shell, /callGenericPopup/, 'connecting no longer asks first');
});

test('always-thinking models: disabled 不思考, and the list matches the proxy catalog', () => {
    for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-opus-5-1']) assert.equal(isAdaptiveOnly(id), true, id);
    for (const id of ['claude-opus-4-7', 'claude-opus-4-8', 'anthropic/claude-opus-4.7', 'claude-opus-5', 'claude-opus-4-6', 'claude-opus-4-6[1m]', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'gemini-2.5-pro', '']) assert.equal(isAdaptiveOnly(id), false, id);
    for (const id of ['claude-fable-5-1', 'claude-fable-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5']) assert.equal(isAdaptiveOnly(id), isAdaptiveOnlyModel(id), id);
});

test('推理强度 decides thinking: a depth is sent, Minimum turns thinking off without a depth', async () => {
    const cs = { reasoning_effort: 'high' };
    globalThis.SillyTavern = { getContext: () => ({ chatCompletionSettings: cs }) };
    const { buildIncludeBodyYaml } = await import('../src/panel/core/inject.js');
    assert.match(buildIncludeBodyYaml({ loreTail: true }), /effort: high/);
    cs.reasoning_effort = 'min';
    const off = buildIncludeBodyYaml({ loreTail: true });
    assert.doesNotMatch(off, /effort:/);
    assert.match(off, /thinking: off/);
});

test('explainCache flags a first turn so the panel can show a neutral note', async () => {
    const { explainCache } = await import('../src/proxy/features/cache-diag.js');
    const base = { ok: true, cacheReadTokens: 0, cacheCreationTokens: 1000, inputTokens: 3, outputTokens: 10, model: 'm' };
    assert.equal(explainCache({ ...base, cacheDiag: { firstTurn: true, chat: 'a' } }).firstTurn, true);
    assert.equal(explainCache({ ...base }).firstTurn, true);
    assert.equal(explainCache({ ...base, cacheDiag: { firstTurn: false, chat: 'a', systemChanged: false, historyDiffAt: null } }, { ...base, model: 'm', cacheDiag: { chat: 'a' } }).firstTurn, false);
});

test('promptMutators lists only scripts / regexes that actually run, and never throws on odd shapes', async () => {
    globalThis.SillyTavern = { getContext: () => ({ chatCompletionSettings: {} }) };
    const { promptMutators, stFingerprint } = await import('../src/panel/core/inject.js');
    const script = (name, enabled = true) => ({ type: 'script', name, enabled });
    const deepRegex = (scriptName) => ({ scriptName, promptOnly: true, minDepth: 5, disabled: false });
    const ctx = (over = {}) => ({
        chatCompletionSettings: { preset_settings_openai: 'Izumi', extensions: { tavern_helper: { scripts: [script('悬浮窗'), script('关着', false)] }, regex_scripts: [deepRegex('预设摘要')] } },
        characterId: 0,
        characters: [{ avatar: 'a.png', data: { extensions: {
            tavern_helper: [['scripts', [{ type: 'folder', name: '文件夹', enabled: true, scripts: [script('卡内'), script('卡内关', false)] }, { type: 'folder', name: '关的夹', enabled: false, scripts: [script('不跑')] }]]],
            regex_scripts: [deepRegex('卡摘要')],
        } } }],
        extensionSettings: {
            tavern_helper: { script: { enabled: { global: false, presets: ['Izumi'], characters: ['a.png'] }, scripts: [script('全局')] } },
            preset_allowed_regex: { openai: ['Izumi'] }, character_allowed_regex: ['a.png'], regex: [deepRegex('全局摘要')],
            disabledExtensions: [],
        },
        ...over,
    });
    assert.deepEqual(promptMutators(ctx()), ['脚本「悬浮窗」', '脚本「卡内」', '正则「全局摘要」', '正则「预设摘要」', '正则「卡摘要」']);
    // Not allowed for this preset / card: their scripts and regexes don't run.
    const c = ctx();
    c.extensionSettings.tavern_helper.script.enabled = { global: true, presets: [], characters: [] };
    c.extensionSettings.preset_allowed_regex = {};
    c.extensionSettings.character_allowed_regex = [];
    assert.deepEqual(promptMutators(c), ['脚本「全局」', '正则「全局摘要」']);
    // 酒馆助手 / regex switched off, or 酒馆助手 not installed.
    const d = ctx();
    d.extensionSettings.disabledExtensions = ['third-party/JS-Slash-Runner', 'regex'];
    assert.deepEqual(promptMutators(d), []);
    const e = ctx();
    delete e.extensionSettings.tavern_helper;
    assert.ok(!promptMutators(e).some((x) => x.startsWith('脚本')));
    // Odd shapes are skipped.
    for (const odd of [{}, { extensionSettings: null, characters: 'x' }, { chatCompletionSettings: { extensions: { tavern_helper: { scripts: 'x' } } }, extensionSettings: { tavern_helper: { script: { enabled: 5, scripts: {} } }, regex: {} } }]) {
        assert.deepEqual(promptMutators(odd), []);
    }
    // The depth regexes go along as [name, minDepth], for naming the one that cut an old reply.
    assert.deepEqual(stFingerprint({}, { ...ctx(), eventTypes: {} }).rx, [['全局摘要', 5], ['预设摘要', 5], ['卡摘要', 5]]);
    assert.equal('rx' in stFingerprint({}, { chatCompletionSettings: {}, eventTypes: {} }), false);
    // Old SillyTavern without WORLD_INFO_ACTIVATED: the fingerprint says the world info list is unknown.
    assert.equal(stFingerprint({}, { chatCompletionSettings: {}, eventTypes: {} }).wiOff, true);
    assert.equal(stFingerprint({}, { chatCompletionSettings: {}, eventTypes: { WORLD_INFO_ACTIVATED: 'world_info_activated' } }).wiOff, undefined);
});

test('historyMarks: thinking written into a reply is skipped; a short last message goes whole in exact', async () => {
    globalThis.SillyTavern = { getContext: () => ({ chatCompletionSettings: {} }) };
    const { historyMarks } = await import('../src/panel/core/inject.js');
    const chat = [
        { mes: '开场白：木屋里很冷，炉火快灭了' },
        { mes: '<thinking>先想想她会怎么做\n再写</thinking>\n<content>雪落在门槛上，她没有回头。</content>' },
        { mes: '继续', is_user: true },
    ];
    const marks = historyMarks({ chat });
    assert.deepEqual(marks.end, ['<content>雪落在门槛上，她没有回头。</content>'.slice(0, 40)]);
    assert.deepEqual(marks.exact, ['继续']);
    assert.equal(historyMarks({ chat: chat.slice(0, 2) }).exact, undefined, 'a long last message needs no exact match');
});
