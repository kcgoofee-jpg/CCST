import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestReplies, parseLeakWords, leakSavedText, checkReply } from '../src/shared/chat-check.js';
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

test('hidden-setting keywords: parsed, counted, and a saved word is flagged on the latest reply at once', () => {
    assert.deepEqual(parseLeakWords('植物人, 医学院、 她的父亲'), ['植物人', '医学院', '她的父亲']);
    assert.deepEqual(parseLeakWords('  '), []);
    assert.equal(leakSavedText(['植物人', '医学院']), '已保存 2 个词，之后的回复里出现会在体检里标出');
    assert.match(leakSavedText([]), /已清空/);
    const mes = '她想起了那个植物人。';
    assert.equal(checkReply({ mes, leaks: [] }).issues.some((i) => i.code === 'leak'), false);
    const issues = checkReply({ mes, leaks: parseLeakWords('植物人') }).issues;
    assert.equal(issues.filter((i) => i.code === 'leak').length, 1);
    assert.match(issues.find((i) => i.code === 'leak').text, /植物人/);
});

test('the proxy reads the chat key the panel sends, and only a hash', () => {
    assert.equal(extractSettings({ claude_subscription: { chat_key: 'abcdef0123456789' } }).chatKey, 'abcdef0123456789');
    assert.equal(extractSettings({ claude_subscription: { chat_key: 'My Chat' } }).chatKey, null);
    assert.equal(extractSettings({}).chatKey, null);
});
