import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Everything this file writes goes to a temp dir.
const TMP = mkdtempSync(join(tmpdir(), 'cm-chat-'));
process.env.CLAUDE_SUBSCRIPTION_STATS_FILE = join(TMP, 'usage.jsonl');
process.env.CLAUDE_SUBSCRIPTION_DEBUG_DIR = join(TMP, 'debug');
process.env.CLAUDE_SUBSCRIPTION_SCRATCH_CWD = join(TMP, 'scratch');
process.env.CLAUDE_SUBSCRIPTION_CONTEXT_PIN_FILE = 'off';

const { watchClient, maxTurnsFrom, statusForError, handleChatCompletions } = await import('../src/proxy/core/chat.js');
const { cancelReply, keptReply, __resetKeptReplies } = await import('../src/proxy/features/reply-keeper.js');
const { __setSdkForTesting } = await import('../src/proxy/core/sdk-loader.js');
const { startStandaloneListener, stopStandaloneListener } = await import('../src/proxy/api/listener.js');
const { busyCount } = await import('../src/proxy/platform/control.js');
const { __resetTurnCaptures } = await import('../src/proxy/features/turn-capture.js');

const SLOT = 'abcdef0123456789';
const quiet = (fn) => async (...a) => {
    const { log, warn } = console;
    console.log = () => {}; console.warn = () => {};
    try { return await fn(...a); } finally { console.log = log; console.warn = warn; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 3000) {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) throw new Error('timed out');
        await sleep(10);
    }
}

function fakeRes() {
    const res = new EventEmitter();
    res.writableFinished = false;
    res.write = () => true;
    res.end = () => res;
    return res;
}

test('watchClient: a client leaving with a reply slot keeps the reply going', quiet(() => {
    const res = fakeRes();
    const conn = watchClient(res, { keep: true, slot: SLOT });
    conn.controller = new AbortController();
    res.emit('close');
    assert.equal(conn.gone, true);
    assert.equal(conn.aborted, false);
    assert.equal(conn.controller.signal.aborted, false);
    conn.dispose();
}));

test('watchClient: without a slot the CLI is stopped; a finished response is not a disconnect', quiet(() => {
    const res = fakeRes();
    const conn = watchClient(res, { keep: false, slot: null });
    conn.controller = new AbortController();
    res.emit('close');
    assert.equal(conn.aborted, true);
    assert.equal(conn.controller.signal.aborted, true);
    const done = fakeRes();
    done.writableFinished = true;
    const c2 = watchClient(done, { keep: false, slot: null });
    done.emit('close');
    assert.equal(c2.aborted, false);
}));

test('watchClient: the panel\'s Stop cancels by slot, even while the client is still there', quiet(() => {
    const res = fakeRes();
    const conn = watchClient(res, { keep: true, slot: SLOT });
    conn.controller = new AbortController();
    assert.equal(cancelReply(SLOT), true);
    assert.equal(conn.cancelled, true);
    assert.equal(conn.controller.signal.aborted, true);
    conn.dispose();
    assert.equal(cancelReply(SLOT), false, 'unregistered after the request');
}));

test('MAX_TURNS is clamped to a whole number from 1 to 20', () => {
    assert.equal(maxTurnsFrom(undefined), 1);
    assert.equal(maxTurnsFrom('abc'), 1);
    assert.equal(maxTurnsFrom('-3'), 1);
    assert.equal(maxTurnsFrom('0'), 1);
    assert.equal(maxTurnsFrom('3.7'), 3);
    assert.equal(maxTurnsFrom('999'), 20);
});

test('upstream errors map to 429 / 401, the rest to 500', () => {
    assert.equal(statusForError('Claude AI usage limit reached|1790000000'), 429);
    assert.equal(statusForError('Not logged in · Please run /login'), 401);
    assert.equal(statusForError('something odd'), 500);
});

test('a null message entry is a 400, not a crash', async () => {
    const res = { statusCode: 200 };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    await handleChatCompletions({ body: { model: 'claude-opus-5', messages: [null] } }, res);
    assert.equal(res.statusCode, 400);
});

// ── End to end over a real listener, with a fake SDK ──

let queries = [];
function fakeSdk({ parts = 8, delay = 25 } = {}) {
    return {
        query({ options }) {
            const q = { aborted: false, finished: false };
            queries.push(q);
            const signal = options.abortController.signal;
            signal.addEventListener('abort', () => { q.aborted = true; });
            return (async function* run() {
                yield { type: 'system', subtype: 'init', model: 'claude-opus-5', session_id: `s${queries.length}` };
                yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { usage: { input_tokens: 7, cache_read_input_tokens: 100 } } } };
                for (let i = 0; i < parts; i++) {
                    await sleep(delay);
                    if (signal.aborted) throw new Error('aborted by user');
                    yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `第${i}段。` } } };
                    yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', usage: { output_tokens: i + 1 } } };
                }
                q.finished = true;
                yield { type: 'result', subtype: 'success', usage: { input_tokens: 7, output_tokens: parts, cache_read_input_tokens: 100 }, stop_reason: 'end_turn' };
            })();
        },
    };
}

let base = null;
test('listener up', async () => {
    const server = await startStandaloneListener({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${server.address().port}`;
});

const chatBody = (extra = {}) => JSON.stringify({
    model: 'claude-opus-5', stream: true,
    messages: [{ role: 'user', content: '去溪边' }],
    claude_subscription: { effort: 'low', ...extra },
});

/** Start a streamed chat, read the first chunk, then drop the connection. */
async function startAndLeave(extra) {
    const ac = new AbortController();
    const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: chatBody(extra), signal: ac.signal });
    const reader = res.body.getReader();
    await reader.read();
    ac.abort();
    await reader.read().catch(() => {});
}

test('client leaves, no slot: the CLI is stopped and the stats say client_closed', quiet(async () => {
    __setSdkForTesting(fakeSdk());
    queries = [];
    await startAndLeave({});
    await until(() => busyCount() === 0);
    assert.equal(queries[0].aborted, true);
    assert.equal(queries[0].finished, false);
    const last = readFileSync(process.env.CLAUDE_SUBSCRIPTION_STATS_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
    assert.equal(last.finish, 'client_closed');
    assert.equal(last.outputTokens > 0, true, 'usage from the stream events is kept');
}));

test('client leaves with a reply slot: the reply is finished, kept, and counted busy until then', quiet(async () => {
    __setSdkForTesting(fakeSdk());
    __resetKeptReplies();
    queries = [];
    await startAndLeave({ reply_slot: SLOT });
    assert.equal(busyCount(), 1, 'still writing after the client left');
    await until(() => busyCount() === 0);
    assert.equal(queries[0].aborted, false);
    assert.equal(queries[0].finished, true);
    assert.match(keptReply(SLOT)?.text ?? '', /第7段。$/);
    const last = readFileSync(process.env.CLAUDE_SUBSCRIPTION_STATS_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
    assert.deepEqual(last.notices, ['kept']);
}));

test('POST /v1/replies/:slot/cancel stops the kept-going reply and nothing is kept', quiet(async () => {
    __setSdkForTesting(fakeSdk({ parts: 40 }));
    __resetKeptReplies();
    queries = [];
    await startAndLeave({ reply_slot: SLOT });
    // A local web page must bring the access key for writes (guardPostOrigin);
    // the panel does, and its origin still gets the CORS echo.
    const savedKey = process.env.CLAUDE_SUBSCRIPTION_LAN_KEY;
    process.env.CLAUDE_SUBSCRIPTION_LAN_KEY = 'cancel-key';
    let r, body;
    try {
        r = await fetch(`${base}/v1/replies/${SLOT}/cancel`, { method: 'POST', headers: { Origin: 'http://127.0.0.1:8000', 'X-Claude-Max-Key': 'cancel-key' } });
        body = await r.json();
    } finally {
        if (savedKey === undefined) delete process.env.CLAUDE_SUBSCRIPTION_LAN_KEY; else process.env.CLAUDE_SUBSCRIPTION_LAN_KEY = savedKey;
    }
    assert.deepEqual(body, { ok: true, cancelled: true });
    assert.equal(r.headers.get('access-control-allow-origin'), 'http://127.0.0.1:8000');
    await until(() => busyCount() === 0);
    assert.equal(queries[0].aborted, true);
    assert.equal(keptReply(SLOT), null);
    const again = await fetch(`${base}/v1/replies/${SLOT}/cancel`, { method: 'POST' });
    assert.deepEqual(await again.json(), { ok: true, cancelled: false });
}));

test('cancel route: CORS preflight for the panel, bad slot, foreign origin', async () => {
    const pre = await fetch(`${base}/v1/replies/${SLOT}/cancel`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:8000', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-claude-max-key' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'http://localhost:8000');
    assert.match(pre.headers.get('access-control-allow-methods'), /POST/);
    assert.match(pre.headers.get('access-control-allow-headers'), /X-Claude-Max-Key/);
    assert.equal((await fetch(`${base}/v1/replies/zz/cancel`, { method: 'POST' })).status, 400);
    assert.equal((await fetch(`${base}/v1/replies/${SLOT}/cancel`, { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
});

test('bad JSON gets a JSON 400 from the error handler', async () => {
    const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
    assert.equal(r.status, 400);
    assert.ok((await r.json()).error.message);
});

test('dry run: the stand-in capture chains, and is found by text + the reply it answers', quiet(async () => {
    __setSdkForTesting(fakeSdk());
    __resetTurnCaptures();
    const turn = async (messages) => {
        const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            model: 'claude-opus-5', stream: false, messages,
            claude_subscription: { effort: 'low', debug_dump: true, dry_run: true, lore_tail: false, fold_tail: false },
        }) });
        assert.equal(r.status, 200);
        return JSON.parse(readFileSync(join(process.env.CLAUDE_SUBSCRIPTION_DEBUG_DIR, 'last-entries.json'), 'utf8'));
    };
    const sys = { role: 'system', content: '规则' };
    await turn([sys, { role: 'assistant', content: '开场' }, { role: 'user', content: '继续' }]);
    await turn([sys, { role: 'assistant', content: '开场' }, { role: 'user', content: '继续' }, { role: 'assistant', content: '回1' }, { role: 'user', content: '继续' }]);
    // Both 「继续」 are known now, each under its own reply; the uuids chain.
    const { historyReplay, sentTextFor } = await import('../src/proxy/features/turn-capture.js');
    assert.equal(sentTextFor('继续', '开场'), '继续');
    assert.equal(sentTextFor('继续', '回1'), '继续');
    const { assembleEntries } = await import('../src/proxy/features/jsonl-entries.js');
    const entries = assembleEntries([{ role: 'assistant', content: '开场' }, { role: 'user', content: '继续' }, { role: 'assistant', content: '回1' }, { role: 'user', content: '继续' }, { role: 'assistant', content: '回2' }],
        { sessionId: 's', cwd: '/x' }, 'm', { replay: historyReplay(null).replay });
    for (let i = 1; i < entries.length; i++) assert.ok(entries[i].parentUuid && entries[i].parentUuid === entries[i - 1].uuid, `entry ${i} chains`);
}));

test('dry run: a turn with the preset\'s post-history entries merged in is found again by the player\'s text', quiet(async () => {
    __setSdkForTesting(fakeSdk());
    __resetTurnCaptures();
    const tail = { role: 'system', content: '<rules>字数规范：800–2000 字</rules>' };
    const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        model: 'claude-opus-5', stream: false,
        messages: [{ role: 'system', content: '规则' }, { role: 'assistant', content: '开场' }, { role: 'user', content: '问她试拍要准备什么' }, tail],
        claude_subscription: { effort: 'low', debug_dump: true, dry_run: true },
    }) });
    assert.equal(r.status, 200);
    const { sentTextFor } = await import('../src/proxy/features/turn-capture.js');
    // Next turn ST sends the player's message back without the tail: the capture must answer to that text.
    assert.equal(sentTextFor('问她试拍要准备什么', '开场'), `问她试拍要准备什么\n\n${tail.content}`);
}));

test('dry run: preset entries around the chat (Kemini layout) — the turn is found again next turn', quiet(async () => {
    __setSdkForTesting(fakeSdk());
    __resetTurnCaptures();
    const msgs = [
        { role: 'user', content: '💠雪融雪降 规则很多很多' }, { role: 'system', content: '角色卡\n【柴火】木屋后面的柴堆只够烧两天，湿柴要先烘干。\n卡的结尾' },
        { role: 'assistant', content: '开场白：木屋里很冷' }, { role: 'user', content: '我先清点物资' },
        { role: 'system', content: '深度注入' }, { role: 'assistant', content: '明白了，接下来' }, { role: 'system', content: '尾部规则' },
    ];
    const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        model: 'claude-opus-5', stream: false, messages: msgs,
        claude_subscription: { effort: 'low', debug_dump: true, dry_run: true, hist: { start: ['开场白：木屋里很冷'], end: ['我先清点物资'] }, gen_type: 'normal', lore_text: ['【柴火】木屋后面的柴堆只够烧两天，湿柴要先烘干。'] },
    }) });
    assert.equal(r.status, 200);
    const { sentTextFor } = await import('../src/proxy/features/turn-capture.js');
    const sent = sentTextFor('我先清点物资', '开场白：木屋里很冷');
    assert.ok(sent, 'the turn is found by the player text');
    assert.match(sent, /^<triggered_lore>\n【柴火】/);
    assert.match(sent, /我先清点物资\n\n深度注入\n\n明白了，接下来\n\n尾部规则$/);
}));

function limitSdk({ text, mode }) {
    return { query() {
        return (async function* run() {
            yield { type: 'system', subtype: 'init', model: 'claude-opus-5', session_id: 'sl' };
            if (text) yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } };
            const msg = "API Error: Claude's response exceeded the 120 output token maximum. Try again.";
            if (mode === 'assistant') yield { type: 'assistant', error: 'unknown', message: { content: [{ type: 'text', text: msg }] } };
            else yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: [msg], usage: { input_tokens: 3, output_tokens: 120 } };
        })();
    } };
}
const lastStat = () => readFileSync(process.env.CLAUDE_SUBSCRIPTION_STATS_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
const post = (stream, extra = {}) => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    model: 'claude-opus-5', stream, max_tokens: 120, messages: [{ role: 'user', content: '写' }], claude_subscription: { effort: 'low', ...extra },
}) });

for (const mode of ['assistant', 'result']) {
    test(`max_tokens overflow (${mode}): non-stream returns partial text with finish_reason length`, quiet(async () => {
        __setSdkForTesting(limitSdk({ text: '写到一半', mode }));
        const r = await post(false);
        assert.equal(r.status, 200);
        const j = await r.json();
        assert.equal(j.choices[0].message.content, '写到一半');
        assert.equal(j.choices[0].finish_reason, 'length');
        assert.equal(lastStat().ok, true);
    }));
    test(`max_tokens overflow (${mode}): stream keeps chunks and ends with finish_reason length`, quiet(async () => {
        __setSdkForTesting(limitSdk({ text: '写到一半', mode }));
        const t = await (await post(true)).text();
        assert.match(t, /写到一半/);
        assert.match(t, /"finish_reason":"length"/);
        assert.doesNotMatch(t, /原因不明/);
        assert.equal(lastStat().ok, true);
    }));
}

test('max_tokens overflow with no text (thinking ate the budget): clear message, not 原因不明', quiet(async () => {
    __setSdkForTesting(limitSdk({ text: '', mode: 'result' }));
    const r = await post(false);
    const m = (await r.json()).error.message;
    assert.match(m, /最大回复长度/);
    assert.match(m, /120 token/);
    assert.doesNotMatch(m, /原因不明/);
}));

test('listener down', async () => {
    __setSdkForTesting(null);
    await stopStandaloneListener();
});
