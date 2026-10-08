import test from 'node:test';
import assert from 'node:assert/strict';

import { isLocalHost } from '../src/shared/host.js';

test('loopback, LAN and local names count as local', () => {
    for (const h of ['localhost', '127.0.0.1', '[::1]', '::1', '192.168.1.5', '10.0.0.2', '172.20.3.4',
        'macbook.local', 'tauri.localhost', '100.100.1.2', 'fd12:3456::1', 'fe80::1', '::ffff:192.168.0.9', '']) {
        assert.equal(isLocalHost(h), true, h);
    }
});

test('public hosts count as remote', () => {
    for (const h of ['st.example.com', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:db8::1', '::ffff:8.8.8.8']) {
        assert.equal(isLocalHost(h), false, h);
    }
});


