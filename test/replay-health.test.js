// #26: when the CLI stops writing the per-turn entries the proxy replays, every
// turn re-writes the whole history. The proxy notices after three such turns,
// resets the replay state, and tells the panel through the request notices.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'cm-replay-'));
process.env.CLAUDE_SUBSCRIPTION_STATS_FILE = join(TMP, 'usage.jsonl');
process.env.CLAUDE_SUBSCRIPTION_SCRATCH_CWD = join(TMP, 'scratch');
process.env.CLAUDE_SUBSCRIPTION_CONTEXT_PIN_FILE = join(TMP, 'cli-context.json');

const { __setSdkForTesting } = await import('../src/proxy/core/sdk-loader.js');
const { startStandaloneListener, stopStandaloneListener } = await import('../src/proxy/api/listener.js');
const { __resetTurnCaptures, pinContext, hasPinnedContext } = await import('../src/proxy/features/turn-capture.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A CLI that answers but never writes anything to the session store. */
function silentSdk() {
    return {
        query({ options }) {
            const signal = options.abortController.signal;
            return (async function* run() {
                yield { type: 'system', subtype: 'init', model: 'claude-opus-5', session_id: 's1' };
                await sleep(5);
                if (signal.aborted) throw new Error('aborted by user');
                yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '好。' } } };
                yield { type: 'result', subtype: 'success', usage: { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 100 }, stop_reason: 'end_turn' };
            })();
        },
    };
}

const lastStat = () => readFileSync(process.env.CLAUDE_SUBSCRIPTION_STATS_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);

const quiet = (fn) => async (...a) => {
    const { log, warn } = console;
    console.log = () => {}; console.warn = () => {};
    try { return await fn(...a); } finally { console.log = log; console.warn = warn; }
};

let base = null;
test('listener up', async () => {
    const server = await startStandaloneListener({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${server.address().port}`;
});

const turn = quiet(async (n) => {
    const messages = [{ role: 'system', content: '规则' }, { role: 'assistant', content: '开场' }];
    for (let i = 1; i < n; i++) messages.push({ role: 'user', content: `第${i}句` }, { role: 'assistant', content: `回${i}` });
    messages.push({ role: 'user', content: `第${n}句` });
    const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-opus-5', stream: false, messages, claude_subscription: { effort: 'low' } }),
    });
    assert.equal(res.status, 200);
    return lastStat();
});

test('three resume turns the CLI never wrote reset the replay and show up as a notice (#26)', quiet(async () => {
    __setSdkForTesting(silentSdk());
    __resetTurnCaptures();
    pinContext('m-replay', [{ type: 'attachment', uuid: 'p1', attachment: { type: 'date', date: '2026-09-26' } }]);
    assert.equal(hasPinnedContext('m-replay'), true);

    const first = await turn(1);
    assert.equal(first.path, 'resume', 'the replay is what runs');
    assert.equal(first.notices, undefined, 'a first miss is noise');
    assert.equal((await turn(2)).notices, undefined, 'two still are');
    assert.deepEqual((await turn(3)).notices, ['replay-reset']);
    assert.equal(hasPinnedContext('m-replay'), false, 'the pin is gone with it');
    assert.equal((await turn(4)).notices, undefined, 'the count starts over');
}));

test('listener down', async () => {
    await stopStandaloneListener();
    __setSdkForTesting(null);
});
