// The 状态 tab's advisory lines come from /status's own self-checks (#30, #36).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { statusAdvisories } = await import('../src/panel/tabs/status.js');

const src = (f) => readFileSync(new URL(`../src/panel/${f}`, import.meta.url), 'utf8');
const online = (extra) => ({ phase: 'online', ...extra });

test('a SDK the proxy cannot work with gets the top banner (#30)', () => {
    const lines = statusAdvisories(online({ compat: { ok: false, missing: ['SYSTEM_PROMPT_DYNAMIC_BOUNDARY'] }, via: 'direct' }), 'http://127.0.0.1:8901/v1');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].tone, 'error');
    assert.match(lines[0].text, /当前 SDK 版本与代理不兼容/);
    assert.match(lines[0].text, /SYSTEM_PROMPT_DYNAMIC_BOUNDARY/);
    assert.match(lines[0].text, /--save-exact/);
});

test('a compatible SDK says nothing, a long fold streak says one line (#30)', () => {
    assert.deepEqual(statusAdvisories(online({ compat: { ok: true, missing: [] }, foldStreak: 0 }), 'http://127.0.0.1:8901/v1'), []);
    assert.deepEqual(statusAdvisories(online({ compat: { ok: true }, foldStreak: 3 }), 'http://127.0.0.1:8901/v1'), [], '3 is still normal');
    const [line] = statusAdvisories(online({ compat: { ok: true }, foldStreak: 7 }), 'http://127.0.0.1:8901/v1');
    assert.equal(line.tone, 'warn');
    assert.match(line.text, /连续 7 轮/);
});

test('the proxy answering over SillyTavern\'s route is checked against the set endpoint (#36)', () => {
    const status = online({ endpoint: 'http://127.0.0.1:8902/v1', via: 'plugin' });
    const lines = statusAdvisories(status, 'http://127.0.0.1:8901/v1');
    assert.equal(lines.length, 1);
    assert.match(lines[0].text, /代理实际地址与面板设置不一致/);
    assert.deepEqual(statusAdvisories({ ...status, via: 'direct' }, 'http://127.0.0.1:8901/v1'), [], 'asked the proxy itself: nothing to warn about');
    assert.deepEqual(statusAdvisories(status, 'http://127.0.0.1:8902/v1'), [], 'the same address with a trailing slash is the same address');
    assert.deepEqual(statusAdvisories(online({ endpoint: null, via: 'plugin' }), 'http://127.0.0.1:8901/v1'), [], 'an old proxy that reports nothing');
});

test('the status tab draws the advisories at its top, and the store feeds it (#30, #36)', () => {
    const tab = src('tabs/status.js');
    assert.ok(tab.indexOf("id = 'claude_max_advice'") < tab.indexOf("stamp.id = 'claude_max_stats_time'"), 'above the rest of the tab');
    assert.match(tab, /store\.subscribe\('status', \(\{ status \}\) => renderAdvice\(status\)\)/);
    assert.match(src('core/live.js'), /compat: data\.compat \?\? null, foldStreak: data\.foldStreak \?\? null, endpoint: data\.endpoint \?\? null/);
    assert.match(src('core/live.js'), /api\/plugins\/claude-subscription/);
});

test('another CCST answering for this SillyTavern: warn only when it is a different version', () => {
    const shared = (version) => online({ root: '/old/CCST', version, sharedBy: { root: '/st/plugins/CCST', version: '6.0.2' } });
    assert.match(statusAdvisories(shared('5.2.0'), 'http://127.0.0.1:8901/v1')[0].text, /另一份 CCST v5\.2\.0/);
    assert.deepEqual(statusAdvisories(shared('6.0.2'), 'http://127.0.0.1:8901/v1'), []);
    assert.deepEqual(statusAdvisories(online({ root: '/st/plugins/CCST', version: '6.0.2' }), 'http://127.0.0.1:8901/v1'), []);
});

test('cost split: an 87% hit can still be mostly writes and output', async () => {
    const { costSplit } = await import('../src/panel/tabs/status.js');
    assert.equal(costSplit({ inputTokens: 3, cacheReadTokens: 60238, cacheCreationTokens: 9127, outputTokens: 2798, cacheTtl: '1h' }), '花在：写缓存 48% · 输出 37% · 读缓存 16%');
    assert.match(costSplit({ cacheReadTokens: 1000, cacheCreationTokens: 1000, outputTokens: 0, cacheTtl: '5m' }), /^花在：写缓存 93% · 读缓存 7%$/);
    assert.equal(costSplit(null), '');
});
