import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { tapSkipReason } from '../src/proxy/features/wire-tap.js';

test('no proxy, or an http:// one: the forwarder may be used', () => {
    assert.equal(tapSkipReason({}), null);
    assert.equal(tapSkipReason({ HTTPS_PROXY: 'http://127.0.0.1:7890' }), null);
    assert.equal(tapSkipReason({ https_proxy: 'http://user:pw@proxy.lan:3128', HTTP_PROXY: 'http://proxy.lan:3128' }), null);
    assert.equal(tapSkipReason({ HTTPS_PROXY: '   ' }), null, 'blank values are ignored');
});

test('a socks / https / scheme-less proxy anywhere in the environment: never through the forwarder', () => {
    for (const env of [
        { HTTPS_PROXY: 'socks5://127.0.0.1:1080' },
        { ALL_PROXY: 'socks5h://127.0.0.1:1080' },
        { all_proxy: 'socks://127.0.0.1:1080' },
        { https_proxy: 'https://proxy.example:443' },
        { HTTP_PROXY: '127.0.0.1:7890' },
        { HTTPS_PROXY: 'http://127.0.0.1:7890', ALL_PROXY: 'socks5://127.0.0.1:7891' },
    ]) {
        const reason = tapSkipReason(env);
        assert.ok(reason, JSON.stringify(env));
        assert.match(reason, /PROXY/i);
    }
});

test('chat.js checks the proxy before starting the forwarder and keeps the start-failure fallback', () => {
    const chat = readFileSync(new URL('../src/proxy/core/chat.js', import.meta.url), 'utf8');
    assert.match(chat, /const tapSkip = settings\.diagCapture \? tapSkipReason\(\) : null;/);
    assert.match(chat, /settings\.diagCapture && !tapSkip\b/);
    assert.match(chat, /tapBaseUrl\(\)\.catch\(/);
});
