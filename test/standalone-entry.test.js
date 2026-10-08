import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The standalone entry (npm start) is a real process here: it must refuse to
// start a second proxy on top of one that already answers on the port. On
// macOS binding 0.0.0.0:<port> succeeds while 127.0.0.1:<port> is taken, so
// without the probe two proxies share a port and answer with different code.
const ROOT = resolve(join(fileURLToPath(import.meta.url), '..', '..'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
    return new Promise((res, rej) => {
        const s = createServer();
        s.on('error', rej);
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => res(port));
        });
    });
}

function child(env) {
    const tmp = mkdtempSync(join(tmpdir(), 'cm-entry-'));
    return spawn(process.execPath, [join(ROOT, 'server.js')], {
        env: {
            ...process.env,
            ...env,
            CLAUDE_SUBSCRIPTION_REQUIRE_KEY: '',
            CLAUDE_SUBSCRIPTION_DEBUG_DIR: join(tmp, 'debug'),
            CLAUDE_SUBSCRIPTION_SCRATCH_CWD: join(tmp, 'scratch'),
            CLAUDE_SUBSCRIPTION_STATS_FILE: join(tmp, 'usage.jsonl'),
            CLAUDE_SUBSCRIPTION_CONTEXT_PIN_FILE: 'off',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

/** Collect a child's output until `re` matches (or ms pass); returns the text. */
function readUntil(p, re, ms = 30000) {
    return new Promise((res) => {
        let buf = '';
        const onData = (d) => {
            buf += String(d);
            if (re.test(buf)) finish();
        };
        const finish = () => {
            clearTimeout(t);
            p.stdout.off('data', onData);
            p.stderr.off('data', onData);
            res(buf);
        };
        const t = setTimeout(finish, ms);
        p.stdout.on('data', onData);
        p.stderr.on('data', onData);
    });
}

async function exitCode(p, ms = 30000) {
    const end = Date.now() + ms;
    while (p.exitCode === null && Date.now() < end) await sleep(25);
    return p.exitCode;
}

test('npm start refuses to double up on a port another CCST proxy already holds', async (t) => {
    const port = await freePort();
    const first = child({ CLAUDE_SUBSCRIPTION_PORT: String(port), CLAUDE_SUBSCRIPTION_HOST: '127.0.0.1' });
    t.after(() => { if (first.exitCode === null) first.kill('SIGTERM'); });
    assert.match(await readUntil(first, /standalone listener/), /claude-subscription/);
    // /status answers only once the SDK import behind it is done: without it
    // the probe could not tell a running proxy from a dead port.
    for (let i = 0; i < 120; i++) {
        try {
            const r = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(2000) });
            if ((await r.json())?.plugin === 'claude-subscription') break;
        } catch { /* not ready yet */ }
        await sleep(250);
    }

    const second = child({ CLAUDE_SUBSCRIPTION_PORT: String(port), CLAUDE_SUBSCRIPTION_HOST: '0.0.0.0' });
    t.after(() => { if (second.exitCode === null) second.kill('SIGTERM'); });
    const out = await readUntil(second, /已经有一个 CCST 代理|already in use/, 20000);
    assert.match(out, /已经有一个 CCST 代理|already in use/, 'it says why it quit');
    assert.notEqual(await exitCode(second, 20000), 0, 'the second copy exits instead of sharing the port');
    assert.equal(first.exitCode, null, 'the proxy that was running keeps running');
});
