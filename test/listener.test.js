import test from 'node:test';
import assert from 'node:assert/strict';

import { isAllowedOrigin, isAllowedHost } from '../src/proxy/api/guards.js';

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

test('a phone browser opening the scanned 连接码 gets a readable page, never JSON or the key', async () => {
    const { guardRemote } = await import('../src/proxy/api/guards.js');
    let sent = null; let status = 0; let type = '';
    const res = { setHeader() {}, status(n) { status = n; return this; }, type(t) { type = t; return this; }, send(b) { sent = b; return this; }, json(b) { sent = b; return this; } };
    process.env.CLAUDE_SUBSCRIPTION_LAN_KEY = 'secretKey123';
    guardRemote({ method: 'GET', headers: { accept: 'text/html,*/*' }, socket: { remoteAddress: '192.168.1.5' } }, res, () => assert.fail('must not pass'));
    delete process.env.CLAUDE_SUBSCRIPTION_LAN_KEY;
    assert.equal(status, 200); assert.equal(type, 'html');
    assert.match(sent, /复制连接码/); assert.ok(!sent.includes('secretKey123'));
});
