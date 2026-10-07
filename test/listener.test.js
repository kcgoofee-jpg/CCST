import test from 'node:test';
import assert from 'node:assert/strict';

import { isAllowedOrigin, isAllowedHost, isTrustedPostOrigin, guardPostOrigin } from '../src/proxy/api/guards.js';

test('loopback origins are allowed (SillyTavern in a local browser)', () => {
    for (const o of ['http://127.0.0.1:8000', 'http://localhost:8000', 'https://localhost', 'http://[::1]:8000']) {
        assert.equal(isAllowedOrigin(o), true, o);
    }
});

test('TauriTavern WebView origins are allowed', () => {
    for (const o of ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']) {
        assert.equal(isAllowedOrigin(o), true, o);
    }
});

test('other origins are rejected', () => {
    for (const o of [undefined, '', 'null', 'https://evil.com', 'http://localhost.evil.com', 'tauri://evil', 'http://tauri.localhost.evil.com']) {
        assert.equal(isAllowedOrigin(o), false, String(o));
    }
});

test('host guard: loopback names pass, rebinding names do not', () => {
    for (const h of ['127.0.0.1:8901', 'localhost:8901', '[::1]:8901', 'tauri.localhost', undefined]) {
        assert.equal(isAllowedHost(h, '127.0.0.1', ''), true, String(h));
    }
    for (const h of ['evil.example.com:8901', 'attacker.test', '192.168.1.5:8901']) {
        assert.equal(isAllowedHost(h, '127.0.0.1', ''), false, h);
    }
});

test('host guard: LAN binding accepts IP literals; extra names are opt-in', () => {
    assert.equal(isAllowedHost('192.168.1.5:8901', '0.0.0.0', ''), true);
    assert.equal(isAllowedHost('mac.local:8901', '0.0.0.0', ''), false);
    assert.equal(isAllowedHost('mac.local:8901', '0.0.0.0', 'mac.local, other'), true);
    assert.equal(isAllowedHost('myhost:8901', 'myhost', ''), true);
});

import { isLoopbackAddress, keyMatches, isLocalCaller } from '../src/proxy/api/guards.js';

test('LAN access: loopback needs no key, others must match it exactly', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true);
    assert.equal(isLoopbackAddress('::1'), true);
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
    assert.equal(isLoopbackAddress('192.168.31.20'), false);
    assert.equal(isLoopbackAddress('::ffff:192.168.31.20'), false);
    assert.equal(keyMatches('abc', 'abc'), true);
    assert.equal(keyMatches('abd', 'abc'), false);
    assert.equal(keyMatches('abc', ''), false);
    assert.equal(keyMatches(null, 'abc'), false);
});

import { presentedKey } from '../src/proxy/api/guards.js';

test('access key: X-Claude-Max-Key is trimmed; a blank one does not hide a valid Bearer', () => {
    assert.equal(presentedKey({ headers: { 'x-claude-max-key': ' k1 ' } }), 'k1');
    assert.equal(presentedKey({ headers: { 'x-claude-max-key': '', authorization: 'Bearer k2' } }), 'k2');
    assert.equal(presentedKey({ headers: { 'x-claude-max-key': '   ', authorization: 'Bearer  k3 ' } }), 'k3');
    assert.equal(presentedKey({ headers: { 'x-claude-max-key': 'k4', authorization: 'Bearer k5' } }), 'k4');
    assert.equal(presentedKey({ headers: {} }), null);
});

test('ALLOWED_ORIGINS adds exact origins (trailing slash / case ignored), nothing broader', () => {
    const extra = 'https://st.example.com/, HTTPS://Other.example.com';
    assert.equal(isAllowedOrigin('https://st.example.com', extra), true);
    assert.equal(isAllowedOrigin('https://other.example.com', extra), true);
    assert.equal(isAllowedOrigin('https://evil.st.example.com', extra), false);
    assert.equal(isAllowedOrigin('http://st.example.com', extra), false);
    assert.equal(isAllowedOrigin('https://st.example.com', ''), false);
});

test('isLocalCaller: loopback without proxy headers is local; forwarded or REQUIRE_KEY is not', () => {
    const lo = (headers = {}) => ({ socket: { remoteAddress: '127.0.0.1' }, headers });
    assert.equal(isLocalCaller(lo(), {}), true);
    assert.equal(isLocalCaller({ socket: { remoteAddress: '10.0.0.5' }, headers: {} }, {}), false);
    for (const h of ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip']) {
        assert.equal(isLocalCaller(lo({ [h]: '1.2.3.4' }), {}), false, h);
    }
    assert.equal(isLocalCaller(lo({ origin: 'http://localhost:8000', host: 'localhost:8901' }), {}), true);
    assert.equal(isLocalCaller(lo(), { CLAUDE_SUBSCRIPTION_REQUIRE_KEY: '1' }), false);
    assert.equal(isLocalCaller(lo(), { CLAUDE_SUBSCRIPTION_REQUIRE_KEY: '0' }), true);
});

// ── Trust given to a browser page (spending the subscription costs real money) ──

const postRes = () => {
    const out = { status: 0, json: null, headers: {} };
    return {
        out,
        setHeader(k, v) { out.headers[k] = v; },
        status(n) { out.status = n; return this; },
        json(b) { out.json = b; return this; },
    };
};

test('POST: only the TauriTavern WebView and listed origins are trusted, loopback is not', () => {
    for (const o of ['tauri://localhost', 'https://tauri.localhost', 'http://tauri.localhost', 'https://st.example.com']) {
        assert.equal(isTrustedPostOrigin(o, 'https://st.example.com'), true, o);
    }
    for (const o of ['http://localhost:5173', 'http://127.0.0.1:8000', 'https://localhost', 'http://[::1]:3000', 'https://evil.com', '']) {
        assert.equal(isTrustedPostOrigin(o, ''), false, o);
    }
    assert.equal(isTrustedPostOrigin(undefined), false, 'no Origin header at all is not an origin');
});

test('guardPostOrigin: a local web page must bring the access key, Tauri and SillyTavern need none', () => {
    process.env.CLAUDE_SUBSCRIPTION_LAN_KEY = 'secretKey123';
    try {
        const verdict = (headers) => {
            const res = postRes();
            let nexted = false;
            guardPostOrigin({ headers }, res, () => { nexted = true; });
            return nexted ? 'next' : res.out.status;
        };
        assert.equal(verdict({}), 'next', 'SillyTavern forwards chat server-side: no Origin');
        assert.equal(verdict({ origin: 'tauri://localhost' }), 'next', 'TauriTavern WebView');
        assert.equal(verdict({ origin: 'http://localhost:5173', 'x-claude-max-key': 'secretKey123' }), 'next', 'the key makes a local page a known caller');
        assert.equal(verdict({ origin: 'http://localhost:5173' }), 401, 'a loopback page without the key is asked for it');
        assert.equal(verdict({ origin: 'http://localhost:5173', 'x-claude-max-key': 'wrong' }), 401);
        assert.equal(verdict({ origin: 'https://evil.com' }), 403, 'any other site is refused outright');
    } finally {
        delete process.env.CLAUDE_SUBSCRIPTION_LAN_KEY;
    }
});

test('the chat-text dump reflects CORS only for trusted origins', async () => {
    const { allowCorsGet, allowCorsGetTrusted } = await import('../src/proxy/api/guards.js');
    const run = (mw, origin) => {
        const res = postRes();
        mw({ headers: origin ? { origin } : {} }, res, () => {});
        return res.out.headers['Access-Control-Allow-Origin'] ?? null;
    };
    assert.equal(run(allowCorsGet, 'http://127.0.0.1:8000'), 'http://127.0.0.1:8000', 'quota and stats stay readable from the local panel');
    assert.equal(run(allowCorsGetTrusted, 'http://127.0.0.1:8000'), null, 'whole chats are not');
    assert.equal(run(allowCorsGetTrusted, 'tauri://localhost'), 'tauri://localhost');
});
