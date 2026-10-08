import test from 'node:test';
import assert from 'node:assert/strict';

import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTurnCollector, replayTurn, hasPinnedContext, pinnedContext, historyReplay, replyBefore, repliesBefore, sentTextFor, pinContext, noteReplayHealth, __resetTurnCaptures, __reloadPinsForTesting } from '../src/proxy/features/turn-capture.js';
import { assembleEntries } from '../src/proxy/features/jsonl-entries.js';
import { SDK_VERSION } from '../src/proxy/features/sdk-version.js';

const meta = { sessionId: 's2', cwd: '/tmp/x', version: 'v', gitBranch: '', permissionMode: 'bypassPermissions' };
const cliEntries = [
    { type: 'queue-operation' },
    { type: 'user', uuid: 'u1', parentUuid: 'p', sessionId: 's1', message: { role: 'user', content: '去溪边' } },
    { type: 'attachment', uuid: 'a1', parentUuid: 'u1', sessionId: 's1', attachment: { type: 'environment' }, rendered: 'env' },
    { type: 'attachment', uuid: 'a2', parentUuid: 'a1', sessionId: 's1', attachment: { type: 'date' }, rendered: 'date' },
    { type: 'assistant', uuid: 'r1', parentUuid: 'a2', message: { content: [{ type: 'text', text: '好' }] } },
];

test('collector keeps the current user entry and its attachments, replay re-chains them', () => {
    __resetTurnCaptures();
    const c = createTurnCollector('去溪边');
    c.onAppend(cliEntries.slice(0, 3));      // arrives in several append() calls
    c.onAppend(cliEntries.slice(3));
    const r = replayTurn('去溪边', 'prev', meta);
    assert.deepEqual(r.map((e) => e.type), ['user', 'attachment', 'attachment']);
    assert.equal(r[0].parentUuid, 'prev');
    assert.equal(r[1].parentUuid, r[0].uuid, 'the chain follows the replay uuids');
    assert.ok(r.every((e) => e.sessionId === 's2' && e.cwd === '/tmp/x'));
    assert.equal(replayTurn('别的话', null, meta), null);
});

test('assembleEntries splices replayed turns and chains the next entry after them', () => {
    __resetTurnCaptures();
    const c = createTurnCollector('去溪边');
    c.onAppend(cliEntries);
    const c2 = createTurnCollector('去溪边', '去溪边', null, '开场'); // answers the greeting
    c2.onAppend(cliEntries);
    const entries = assembleEntries(
        [{ role: 'assistant', content: '开场' }, { role: 'user', content: '去溪边' }, { role: 'assistant', content: '好' }],
        meta, 'm', { replay: historyReplay(null).replay });
    assert.deepEqual(entries.map((e) => e.type), ['assistant', 'user', 'attachment', 'attachment', 'assistant']);
    assert.equal(entries[4].parentUuid, entries[3].uuid, 'the next entry chains after the replay');
    // without replay: plain synthetic entries, unchanged behavior
    assert.deepEqual(assembleEntries([{ role: 'user', content: '去溪边' }], meta, 'm').map((e) => e.type), ['user']);
});

test('the CLI context is pinned after the first entry and replayed turns lose their own copy', () => {
    __resetTurnCaptures();
    const c = createTurnCollector('去溪边', '去溪边', 'opus[1m]', '开场');
    c.onAppend(cliEntries);
    assert.equal(hasPinnedContext('opus[1m]'), true);
    assert.equal(hasPinnedContext('sonnet'), false);
    const history = [{ role: 'assistant', content: '开场' }, { role: 'user', content: '去溪边' }, { role: 'assistant', content: '好' }];
    const { replay, pinned } = historyReplay('opus[1m]');
    const entries = assembleEntries(history, meta, 'm', { replay, pinned });
    // greeting, pinned context, then the replayed user turn WITHOUT its attachments
    assert.deepEqual(entries.map((e) => e.type), ['assistant', 'attachment', 'attachment', 'user', 'assistant']);
    assert.equal(entries[1].parentUuid, entries[0].uuid);
    assert.equal(entries[3].parentUuid, 'a2');
    // The first pin sticks: a later turn's context (the next day's date)
    // does not replace it — it stays with the turn it came with.
    const c2 = createTurnCollector('再走', '再走', 'opus[1m]', '好');
    c2.onAppend([{ type: 'user', uuid: 'u9', message: { role: 'user', content: '再走' } },
        { type: 'attachment', uuid: 'a9', attachment: { type: 'date', date: '明天' } }, { type: 'assistant' }]);
    assert.deepEqual(pinnedContext('opus[1m]', null, meta).map((e) => e.uuid), ['a1', 'a2']);
    const again = replayTurn('再走', null, meta, { pinOn: true, context: '好' });
    assert.deepEqual(again.map((e) => e.parentUuid), [null, again[0].uuid], 'chained to the fresh uuids');
    assert.notEqual(again[1].uuid, 'a9', 'the replay does not reuse the stored uuid');
});

// The stored uuids are the CLI's from whatever session produced the turn.
// Replaying them unchanged can put one uuid in a transcript twice — the same
// capture reached by two history messages, or a replay beside the pinned copy
// of those very attachments — and a parent chain with repeats lets the CLI
// walk to the wrong branch.
test('a replayed turn carries fresh uuids', () => {
    __resetTurnCaptures();
    createTurnCollector('去溪边').onAppend(cliEntries);
    const one = replayTurn('去溪边', null, meta);
    const two = replayTurn('去溪边', 'x', meta);
    const ids = [...one, ...two].map((e) => e.uuid);
    assert.equal(new Set(ids).size, ids.length, 'the same turn replayed twice repeats no uuid');
    assert.equal(two[1].parentUuid, two[0].uuid, 'children chain onto the new uuids');
    assert.equal(cliEntries[1].uuid, 'u1', 'the stored capture keeps its own copy');
    __resetTurnCaptures();
    createTurnCollector('去溪边', '去溪边', 'opus[1m]').onAppend(cliEntries);
    const pin = pinnedContext('opus[1m]', null, meta);
    const replayed = replayTurn('去溪边', null, meta, { pinOn: false, context: '' });
    assert.equal(replayed.filter((r) => pin.some((p) => p.uuid === r.uuid)).length, 0, 'the pin and its own turn stay distinct');
});

// A half-written cli-context.json reads as "none yet" on the next start, and
// the pin for that model is then rebuilt on a turn that sits elsewhere in the
// transcript — every later turn re-writes the whole history.
test('the pin file lands whole, with no temp left behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-pin-'));
    const file = join(dir, 'cli-context.json');
    const saved = process.env.CLAUDE_SUBSCRIPTION_CONTEXT_PIN_FILE;
    process.env.CLAUDE_SUBSCRIPTION_CONTEXT_PIN_FILE = file;
    try {
        const mod = await import(`../src/proxy/features/turn-capture.js?atomic=${Date.now()}`);
        mod.pinContext('m-atomic', [{ type: 'attachment', uuid: 'z1', attachment: { type: 'model', id: 'm-atomic' } }]);
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        assert.equal(typeof saved.version, 'string', 'stamped with the SDK version (#26)');
        assert.deepEqual(saved.pins['m-atomic'].map((e) => e.uuid), ['z1']);
        assert.deepEqual(readdirSync(dir).filter((f) => f !== 'cli-context.json'), [], 'the temp file was renamed away');
        const reread = await import(`../src/proxy/features/turn-capture.js?reread=${Date.now()}`);
        assert.equal(reread.hasPinnedContext('m-atomic'), true, 'a restart reads it back');
        const src = readFileSync(new URL('../src/proxy/features/turn-capture.js', import.meta.url), 'utf8');
        for (const [, target] of src.matchAll(/writeFileSync\(\s*([^,]+),/g)) {
            assert.match(target, /tmp/, `${target.trim()} would be written in place`);
        }
    } finally {
        if (saved === undefined) delete process.env.CLAUDE_SUBSCRIPTION_CONTEXT_PIN_FILE; else process.env.CLAUDE_SUBSCRIPTION_CONTEXT_PIN_FILE = saved;
        __resetTurnCaptures();
    }
});

test('replyBefore / repliesBefore: the last non-blank assistant message before each index', () => {
    const list = [{ role: 'assistant', content: '开场' }, { role: 'user', content: 'a' }, { role: 'assistant', content: '  ' },
        { role: 'user', content: 'b' }, { role: 'assistant', content: [{ type: 'text', text: '回' }] }, { role: 'user', content: 'c' }];
    assert.deepEqual(repliesBefore(list), ['', '开场', '开场', '开场', '开场', '回']);
    assert.deepEqual(list.map((_, i) => replyBefore(list, i)), repliesBefore(list));
    assert.equal(replyBefore(list, list.length), '回');
});

// ── What the API sees, turn after turn ──
// A stand-in for the CLI: on a transcript without its context it adds the
// full context to the current message; with it, only a new date when the
// latest date in the transcript is not today (the real CLI: findLast of the
// date attachment vs today's local date).
const PIN = 'model-x';
function fakeCli(transcript, sentText, today) {
    const hasContext = transcript.some((e) => e.type === 'attachment' && e.attachment?.type === 'environment');
    const lastDate = transcript.filter((e) => e.type === 'attachment' && e.attachment?.type === 'date').at(-1)?.attachment.date;
    const user = { type: 'user', uuid: randomUUID(), message: { role: 'user', content: sentText } };
    const atts = !hasContext
        ? [{ type: 'environment' }, { type: 'model', id: PIN }, { type: 'date', date: today }]
        : lastDate !== today ? [{ type: 'date', date: today, changed: true }] : [];
    let parent = user.uuid;
    const out = [user, ...atts.map((attachment) => {
        const e = { type: 'attachment', uuid: randomUUID(), parentUuid: parent, attachment };
        parent = e.uuid;
        return e;
    })];
    return { added: [...out, { type: 'assistant', uuid: randomUUID(), parentUuid: parent }], sent: out };
}
// Only what reaches the model: role, text, attachment payload — no uuids.
const wire = (e) => JSON.stringify([e.type, e.message?.content ?? null, e.attachment ?? null]);

/** One request: returns the wire form of everything the CLI sends. */
function request(history, raw, sentText, today) {
    const { replay, pinned } = historyReplay(PIN);
    const entries = assembleEntries(history, meta, 'm', { replay, pinned });
    const { added, sent } = fakeCli(entries, sentText, today);
    createTurnCollector(sentText, raw, PIN, replyBefore(history, history.length)).onAppend(added);
    return [...entries.map(wire), ...sent.map(wire)];
}

/** Play a chat; returns each request's wire form. Each turn's player text is
 *  sent with this turn's lore on top (as lore-tail does) but comes back raw. */
function play(greeting, turns) {
    const history = [{ role: 'assistant', content: greeting }];
    const requests = [];
    turns.forEach(([raw, today], i) => {
        requests.push(request(history, raw, `<lore>${greeting}:${i}</lore>\n\n${raw}`, today));
        history.push({ role: 'user', content: raw }, { role: 'assistant', content: `${greeting} 回复 ${i}` });
    });
    return requests;
}

const isPrefix = (a, b) => a.length <= b.length && a.every((x, i) => x === b[i]);

function seedPin(date) {
    __resetTurnCaptures();
    play('seed', [['hi', date]]); // the first-ever request creates the pin
    assert.equal(hasPinnedContext(PIN), true);
}

test('repeating 「继续」 in one chat: every request starts with the whole previous one', () => {
    seedPin('2026-09-26');
    const reqs = play('开场A', [['继续', '2026-09-26'], ['继续', '2026-09-26'], ['继续', '2026-09-26'], ['去溪边', '2026-09-26']]);
    for (let i = 1; i < reqs.length; i++) assert.ok(isPrefix(reqs[i - 1], reqs[i]), `turn ${i + 1} re-sends turn ${i} unchanged`);
    // each 「继续」 kept its own lore
    const sent = reqs.at(-1).filter((w) => w.includes('继续'));
    assert.deepEqual(sent.map((w) => JSON.parse(w)[1].split('</lore>')[0]), ['<lore>开场A:0', '<lore>开场A:1', '<lore>开场A:2']);
});

test('the same text in another chat never picks up this chat\'s capture or lore', () => {
    seedPin('2026-09-26');
    play('开场A', [['继续', '2026-09-26'], ['再来', '2026-09-26']]);
    assert.match(sentTextFor('继续', '开场A'), /<lore>开场A:0/);
    assert.equal(sentTextFor('继续', '开场B'), null);
    assert.equal(replayTurn('继续', null, meta, { pinOn: true, context: '开场B' }), null);
    const reqs = play('开场B', [['继续', '2026-09-26'], ['再来', '2026-09-26']]);
    assert.ok(isPrefix(reqs[0], reqs[1]));
    assert.ok(!reqs.flat().some((w) => w.includes('开场A')), 'nothing from chat A in chat B');
});

test('across midnight: no turn re-sends the previous one differently, and the pin never changes', () => {
    seedPin('2026-09-26');
    const pinBefore = JSON.stringify(pinnedContext(PIN, null, meta).map((e) => e.attachment));
    const reqs = play('开场C', [['一', '2026-09-26'], ['二', '2026-09-26'], ['三', '2026-09-27'], ['四', '2026-09-27'], ['五', '2026-09-27'], ['六', '2026-09-28']]);
    for (let i = 1; i < reqs.length; i++) assert.ok(isPrefix(reqs[i - 1], reqs[i]), `turn ${i + 1} re-sends turn ${i} unchanged`);
    // the CLI announced each new day once, on that day's first message
    assert.equal(reqs.at(-1).filter((w) => w.includes('"changed":true')).length, 2);
    assert.equal(JSON.stringify(pinnedContext(PIN, null, meta).map((e) => e.attachment)), pinBefore);
});

test('a new chat on a later day than the pin stays stable too', () => {
    seedPin('2026-09-26');
    const reqs = play('开场D', [['一', '2026-10-01'], ['二', '2026-10-01'], ['三', '2026-10-01']]);
    for (let i = 1; i < reqs.length; i++) assert.ok(isPrefix(reqs[i - 1], reqs[i]), `turn ${i + 1}`);
});

test('without a pin (first ever request) the next turns settle after one structural change', () => {
    __resetTurnCaptures();
    const reqs = play('开场E', [['一', '2026-09-26'], ['二', '2026-09-26'], ['三', '2026-09-26'], ['四', '2026-09-27'], ['五', '2026-09-27']]);
    for (let i = 2; i < reqs.length; i++) assert.ok(isPrefix(reqs[i - 1], reqs[i]), `turn ${i + 1}`);
});

test('CLAUDE_SUBSCRIPTION_CONTEXT_PIN_FILE=off keeps the pin in memory only', async () => {
    const saved = process.env.CLAUDE_SUBSCRIPTION_CONTEXT_PIN_FILE;
    process.env.CLAUDE_SUBSCRIPTION_CONTEXT_PIN_FILE = 'off';
    try {
        const mod = await import(`../src/proxy/features/turn-capture.js?off=${Date.now()}`);
        const { existsSync } = await import('node:fs');
        mod.pinContext('m-off', [{ type: 'attachment', uuid: 'x', attachment: { type: 'date', date: 'd' } }]);
        assert.equal(mod.hasPinnedContext('m-off'), true);
        assert.equal(existsSync('off'), false);
    } finally {
        if (saved === undefined) delete process.env.CLAUDE_SUBSCRIPTION_CONTEXT_PIN_FILE; else process.env.CLAUDE_SUBSCRIPTION_CONTEXT_PIN_FILE = saved;
    }
});

// ── A prefill turn under a real request ──
// 「结尾 assistant 预填」 sends the synthetic continuation instruction instead of
// the player's message, so its capture must not be filed under the player's
// text: next turn that text is history and would replay the instruction.
const TMP = mkdtempSync(join(tmpdir(), 'cm-prefill-'));
process.env.CLAUDE_SUBSCRIPTION_SCRATCH_CWD = join(TMP, 'scratch');
process.env.CLAUDE_SUBSCRIPTION_CONTEXT_PIN_FILE = 'off';
process.env.CLAUDE_SUBSCRIPTION_CACHE_MEMORY_FILE = 'off';

const { handleChatCompletions } = await import('../src/proxy/core/chat.js');
const { __setSdkForTesting } = await import('../src/proxy/core/sdk-loader.js');
const { diagnoseCache, __resetCacheDiag } = await import('../src/proxy/features/cache-diag.js');
const { __lastEntries } = await import('../src/proxy/features/last-request.js');
const { EventEmitter } = await import('node:events');

/** One dry-run request: build everything, dump the transcript, never call Claude. */
async function turn(messages, ns = {}) {
    const res = new EventEmitter();
    res.statusCode = 200;
    res.writableFinished = false;
    res.write = () => true;
    res.end = () => res;
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    const log = console.log; const warn = console.warn;
    console.log = () => {}; console.warn = () => {};
    try {
        await handleChatCompletions({ body: { model: 'claude-opus-5', messages, claude_subscription: { dry_run: true, ...ns } }, get: () => '' }, res);
    } finally {
        console.log = log; console.warn = warn;
    }
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    return __lastEntries();
}
const text = (e) => (typeof e.message?.content === 'string' ? e.message.content : (e.message?.content ?? []).map((b) => b?.text ?? '').join('\n'));

test('a 「继续」 round is filed under its own instruction, not under the player message', async () => {
    __setSdkForTesting({ query: () => (async function* () {})() });
    __resetTurnCaptures();
    __resetCacheDiag();
    const rules = '规则'.repeat(2000);
    // Keyword world info changes every turn, so lore-tail moves it onto the player message.
    const lore = (k) => `【${k}】这一条世界书只在提到它的时候才会触发出现。`;
    const sys = (k) => `<rules>${rules}</rules>\n${lore(k)}`;
    const wi = (k) => ({ lore_text: [lore(k)] });
    await turn([{ role: 'system', content: sys('甲') }, { role: 'assistant', content: '开场' }, { role: 'user', content: '我推门' }], wi('甲'));
    const firstSent = sentTextFor('我推门', '开场');
    assert.match(firstSent, /^<triggered_lore>\n【甲】[\s\S]*我推门$/, 'filed as sent, lore included');

    // The 「继续」 round: SillyTavern ends with the reply it wants continued.
    const prefill = await turn([
        { role: 'system', content: sys('乙') }, { role: 'assistant', content: '开场' },
        { role: 'user', content: '我推门' }, { role: 'assistant', content: '门开了' },
    ], { ...wi('乙'), gen_type: 'continue' });
    assert.ok(!prefill.some((e) => text(e).includes('Continue the assistant')), 'the instruction is not history');
    assert.equal(sentTextFor('我推门', '开场'), firstSent, 'the prefill round does not refile the player message');

    // Next turn: the player message is back in history and must still be there.
    const next = await turn([
        { role: 'system', content: sys('乙') }, { role: 'assistant', content: '开场' },
        { role: 'user', content: '我推门' }, { role: 'assistant', content: '门开了' },
        { role: 'user', content: '我点灯' },
    ], wi('乙'));
    const players = next.filter((e) => text(e).includes('我推门'));
    assert.equal(players.length, 1, 'the player message is replayed once');
    assert.ok(!next.some((e) => text(e).includes('Continue the assistant')), 'no continuation instruction replaces it');
    __setSdkForTesting(null);
});

test('a prefill turn (果实: the preset ends on an assistant entry) is replayed whole next turn', async () => {
    __setSdkForTesting({ query: () => (async function* () {})() });
    __resetTurnCaptures();
    __resetCacheDiag();
    const sys = `<rules>${'规则'.repeat(2000)}</rules>`;
    const tail = '<输出要求>\n正文 2000 字，结尾写摘要。\n</输出要求>';
    const prefillOf = (said) => `[任务确认]\n<user_input>\n${said}\n</user_input>`;
    const ask = (history, said) => [{ role: 'system', content: sys }, ...history, { role: 'user', content: said }, { role: 'system', content: tail }, { role: 'assistant', content: prefillOf(said) }];
    const t1 = await turn(ask([{ role: 'assistant', content: '开场' }], '我推门'));
    assert.deepEqual(t1.map(text).slice(-2), [`我推门\n\n${tail}`, 'No response requested.'], 'the placeholder reply is ours, after the merged player message');
    const t2 = await turn(ask([{ role: 'assistant', content: '开场' }, { role: 'user', content: '我推门' }, { role: 'assistant', content: '门开了。' }], '我点灯'));
    const texts = t2.map(text);
    const at = texts.indexOf(`我推门\n\n${tail}`);
    assert.ok(at > 0, 'the player message goes out as it was sent, post-history entries included');
    assert.equal(texts[at + 1], 'No response requested.');
    assert.match(texts[at + 2], /^Continue the assistant's reply[\s\S]*我推门/, 'then the continuation instruction it was sent with');
    assert.equal(texts[at + 3], '门开了。', 'then the reply');
    assert.deepEqual(texts.slice(0, t1.length), t1.map(text), 'turn 2 starts with everything turn 1 sent');
    assert.equal(texts.filter((t) => t.includes('我推门')).length, 2, 'the player message once (plus the instruction quoting it)');
    // A reroll of the same turn: the earlier attempt's placeholder and instruction are not replayed twice.
    const again = await turn(ask([{ role: 'assistant', content: '开场' }, { role: 'user', content: '我推门' }, { role: 'assistant', content: '门开了。' }], '我点灯'));
    assert.deepEqual(again.map(text), texts);
    __setSdkForTesting(null);
});
// ── #26: the pin file and the replay know which SDK wrote them ──

/** Run `fn` with the pin file pointed at a fresh temp path (content: null = no file yet). */
function withPinFile(content, fn) {
    const saved = process.env.CLAUDE_SUBSCRIPTION_CONTEXT_PIN_FILE;
    const file = join(mkdtempSync(join(tmpdir(), 'ccst-pin-')), 'cli-context.json');
    if (content !== null) writeFileSync(file, JSON.stringify(content));
    process.env.CLAUDE_SUBSCRIPTION_CONTEXT_PIN_FILE = file;
    try {
        return fn(file);
    } finally {
        if (saved === undefined) delete process.env.CLAUDE_SUBSCRIPTION_CONTEXT_PIN_FILE; else process.env.CLAUDE_SUBSCRIPTION_CONTEXT_PIN_FILE = saved;
        __resetTurnCaptures();
    }
}

const datePin = [{ type: 'attachment', uuid: 'p1', parentUuid: null, attachment: { type: 'date', date: '2026-09-26' } }];

test('a pin file in the old format is dropped and rewritten with the version (#26)', () => {
    withPinFile({ 'm-old': datePin }, (file) => {
        __reloadPinsForTesting();
        assert.equal(hasPinnedContext('m-old'), false, 'no version stamp: nothing can be trusted');
        assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: SDK_VERSION, pins: {} });
    });
});

test('a pin file from another SDK version is dropped, the same version is kept (#26)', () => {
    withPinFile({ version: '0.1.0-other', pins: { 'm-shift': datePin } }, (file) => {
        __reloadPinsForTesting();
        assert.equal(hasPinnedContext('m-shift'), false);
        assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, SDK_VERSION);
    });
    withPinFile({ version: SDK_VERSION, pins: { 'm-same': datePin } }, (file) => {
        const before = readFileSync(file, 'utf8');
        __reloadPinsForTesting();
        assert.equal(hasPinnedContext('m-same'), true);
        assert.equal(readFileSync(file, 'utf8'), before, 'kept as written');
    });
});

test('the collector says whether the CLI wrote this turn at all (#26)', () => {
    __resetTurnCaptures();
    const c = createTurnCollector('去溪边');
    assert.equal(c.captured, false);
    c.onAppend(cliEntries.slice(0, 3));
    assert.equal(c.captured, false, 'still waiting for the reply');
    c.onAppend(cliEntries.slice(3));
    assert.equal(c.captured, true);
});

test('three resume turns with no capture reset the captures and the pin (#26)', () => {
    withPinFile(null, (file) => {
        __resetTurnCaptures();
        const c = createTurnCollector('去溪边');
        c.onAppend(cliEntries);
        pinContext('m-health', datePin);
        assert.equal(existsSync(file), true, 'the pin is on disk');
        assert.equal(noteReplayHealth(false), false);
        assert.equal(noteReplayHealth(false), false);
        assert.equal(hasPinnedContext('m-health'), true, 'two misses are not a verdict yet');
        assert.equal(noteReplayHealth(false), true, 'the third one resets');
        assert.equal(replayTurn('去溪边', 'prev', meta), null, 'captures gone');
        assert.equal(hasPinnedContext('m-health'), false, 'pin gone');
        assert.equal(existsSync(file), false, 'pin file deleted');
        assert.equal(noteReplayHealth(true), false);
        assert.equal(noteReplayHealth(false), false, 'the streak starts over');
    });
});

test('rewriteCaptured swaps an old post-history block in captured turns', async () => {
    const { createTurnCollector, sentTextFor, rewriteCaptured, __resetTurnCaptures } = await import('../src/proxy/features/turn-capture.js');
    __resetTurnCaptures();
    const c = createTurnCollector('你好\n\n<fmt>旧格式</fmt>', '你好', null, '');
    c.onAppend([{ type: 'user', uuid: 'u', message: { role: 'user', content: '你好\n\n<fmt>旧格式</fmt>' } }, { type: 'assistant', uuid: 'a' }]);
    assert.equal(rewriteCaptured('\n\n<fmt>旧格式</fmt>', ''), 1);
    assert.equal(sentTextFor('你好', ''), '你好');
});

test('rewriteCaptured replaces two different old tail versions; a turn already on the new one is left alone', async () => {
    const { createTurnCollector, sentTextFor, rewriteCaptured, __resetTurnCaptures } = await import('../src/proxy/features/turn-capture.js');
    __resetTurnCaptures();
    const turn = (text, sent, ctx) => {
        const c = createTurnCollector(sent, text, null, ctx);
        c.onAppend([{ type: 'user', uuid: `u${ctx}`, message: { role: 'user', content: sent } }, { type: 'assistant', uuid: `a${ctx}` }]);
    };
    turn('一', '一\n\n<规则>日记番外</规则>', 'r1');
    turn('二', '二\n\n<规则>日记番外</规则>\n\n<文风>嘎嘎</文风>', 'r2');
    // Rerolled after the edit: already carries the new tail, which contains an old version.
    turn('三', '三\n\n<规则>日记番外</规则>\n\n<文风>直白</文风>', 'r3');
    const n = rewriteCaptured(['\n\n<规则>日记番外</规则>', '\n\n<规则>日记番外</规则>\n\n<文风>嘎嘎</文风>'], '\n\n<规则>日记番外</规则>\n\n<文风>直白</文风>');
    assert.equal(n, 2);
    assert.equal(sentTextFor('一', 'r1'), '一\n\n<规则>日记番外</规则>\n\n<文风>直白</文风>');
    assert.equal(sentTextFor('二', 'r2'), '二\n\n<规则>日记番外</规则>\n\n<文风>直白</文风>');
    assert.equal(sentTextFor('三', 'r3'), '三\n\n<规则>日记番外</规则>\n\n<文风>直白</文风>');
});

test('a player message wrapped only while it is the newest (Kemini <interactive_input>) is found bare next turn', async () => {
    const { createTurnCollector, sentTextFor, __resetTurnCaptures } = await import('../src/proxy/features/turn-capture.js');
    __resetTurnCaptures();
    const wrapped = '<interactive_input>\n我走到窗边\n</interactive_input>';
    const c = createTurnCollector(`规则\n\n${wrapped}`, wrapped, null, '开场');
    c.onAppend([{ type: 'user', uuid: 'u', message: { role: 'user', content: `规则\n\n${wrapped}` } }, { type: 'assistant', uuid: 'a' }]);
    assert.equal(sentTextFor('我走到窗边', '开场'), `规则\n\n${wrapped}`);
    assert.equal(sentTextFor('我走到窗边', '另一段回复'), null, 'only under the same reply context');
    assert.equal(sentTextFor('我走到', '开场'), null, 'part of the message is not the same turn');
});

test('switching presets takes the old preset\'s post-history entries out of earlier turns', async () => {
    __setSdkForTesting({ query: () => (async function* () {})() });
    __resetTurnCaptures();
    __resetCacheDiag();
    const { __resetInjected } = await import('../src/proxy/features/lore-tail.js');
    __resetInjected();
    const ashenTail = `</Chat_History>\n<创作之律>${'灰烬的写作规则。'.repeat(80)}</创作之律>`;
    const sysA = `<ashen>${'灰烬'.repeat(2000)}</ashen>`;
    const sysB = `<guoshi>${'果实'.repeat(2000)}</guoshi>`;
    const fp = (preset) => ({ st_fp: { preset, order: preset, wi: [], mut: [] } });
    await turn([{ role: 'system', content: sysA }, { role: 'assistant', content: '开场' }, { role: 'user', content: '我推门' }, { role: 'system', content: ashenTail }], fp('灰烬之桥'));
    const ashen2 = await turn([{ role: 'system', content: sysA }, { role: 'assistant', content: '开场' }, { role: 'user', content: '我推门' }, { role: 'assistant', content: '门开了。' }, { role: 'user', content: '我点灯' }, { role: 'system', content: ashenTail }], fp('灰烬之桥'));
    assert.ok(ashen2.some((e) => text(e) === `我推门\n\n${ashenTail}`), 'same preset: the earlier turn goes out as sent, tail included');
    const guoshi = await turn([{ role: 'system', content: sysB }, { role: 'assistant', content: '开场' }, { role: 'user', content: '我推门' }, { role: 'assistant', content: '门开了。' }, { role: 'user', content: '我点灯' }, { role: 'assistant', content: '灯亮了。' }, { role: 'user', content: '我坐下' }, { role: 'system', content: '<输出要求>果实的尾部</输出要求>' }, { role: 'assistant', content: '[任务确认]' }], fp('果实V6.3'));
    assert.ok(!guoshi.some((e) => text(e).includes('创作之律')), 'no turn keeps the old preset\'s rules');
    assert.ok(guoshi.some((e) => text(e) === '我推门') && guoshi.some((e) => text(e) === '我点灯'), 'the player messages stay');
    __setSdkForTesting(null);
});
