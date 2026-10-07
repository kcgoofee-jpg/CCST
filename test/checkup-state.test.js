import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestReplies } from '../src/shared/chat-check.js';
import { extractSettings } from '../src/proxy/features/settings.js';

const greeting = { mes: '欢迎来到庄园。', is_user: false };
const user = (t) => ({ mes: t, is_user: true });
const ai = (t) => ({ mes: t, is_user: false });

test('no reply yet: only the greeting (floor 0) → nothing to check, so the badge is 0', () => {
    assert.equal(latestReplies([]), null);
    assert.equal(latestReplies([greeting]), null);
    assert.equal(latestReplies([greeting, user('你好')]), null);
});

test('the greeting is never the reply or the "previous" reply', () => {
    const r = latestReplies([greeting, user('你好'), ai('第一条')]);
    assert.equal(r.last.mes, '第一条');
    assert.equal(r.prev, null);
    const r2 = latestReplies([greeting, user('a'), ai('第一条'), user('b'), ai('第二条'), { mes: '系统', is_system: true }]);
    assert.equal(r2.last.mes, '第二条');
    assert.equal(r2.prev.mes, '第一条');
});

test('the proxy reads the chat key the panel sends, and only a hash', () => {
    assert.equal(extractSettings({ claude_subscription: { chat_key: 'abcdef0123456789' } }).chatKey, 'abcdef0123456789');
    assert.equal(extractSettings({ claude_subscription: { chat_key: 'My Chat' } }).chatKey, null);
    assert.equal(extractSettings({}).chatKey, null);
});
