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

test('cost shares: an 87% hit can still be mostly writes and output', async () => {
    const { costShares } = await import('../src/panel/tabs/status.js');
    const { costParts } = await import('../src/proxy/features/cache-diag.js');
    const shares = costShares(costParts({ inputTokens: 3, cacheReadTokens: 60238, cacheCreationTokens: 9127, outputTokens: 2798, cacheTtl: '1h' }));
    assert.deepEqual(shares.map((p) => `${p.label} ${p.pct}%`), ['写缓存 48%', '输出 37%', '读缓存 16%']);
    assert.deepEqual(costShares(costParts({ cacheReadTokens: 1000, cacheCreationTokens: 1000, cacheTtl: '5m' })).map((p) => p.pct), [93, 7]);
    assert.deepEqual(costShares(null), []);
    assert.deepEqual(costShares({ write: 0, output: 0, read: 0, input: 0 }), []);
});

test('usage pace: projected to the reset; quiet under 10% or without a reset', async () => {
    const { usagePace } = await import('../src/panel/tabs/status.js');
    const H = 3600_000, W = 5 * H, now = 1_000_000_000_000;
    // 2 h into the 5 h window at 50%: ends at 125% → runs out in 2 h more
    const p = usagePace(50, now + 3 * H, W, now);
    assert.equal(p.level, 'critical');
    assert.equal(p.endPct, 125);
    assert.equal(p.runOutMs, 2 * H);
    assert.equal(usagePace(35, now + 3 * H, W, now).level, 'normal'); // ends at 88%
    assert.equal(usagePace(36, now + 3 * H, W, now).level, 'warning'); // ends at 90%
    assert.equal(usagePace(8, now + 4.9 * H, W, now).level, 'normal');
    assert.equal(usagePace(50, null, W, now), null);
    assert.equal(usagePace(50, now - 1, W, now), null);
});

test('context use and output speed for the last turn', async () => {
    const { contextUse, outputSpeed } = await import('../src/panel/tabs/status.js');
    assert.deepEqual(contextUse({ model: 'claude-opus-4-6', inputTokens: 3, cacheReadTokens: 150_000, cacheCreationTokens: 20_000 }), { tokens: 170_003, size: 200_000, pct: 85, level: 'critical' });
    assert.equal(contextUse({ model: 'claude-opus-4-6[1m]', cacheReadTokens: 170_000 }).level, '');
    assert.equal(contextUse({}), null);
    assert.equal(outputSpeed({ outputTokens: 4000, durationMs: 102_000, ttftMs: 2_000 }), 40);
    assert.equal(outputSpeed({ outputTokens: 10, durationMs: 300 }), null);
});

test('cost parts follow the model price row; API value in USD', async () => {
    const { costParts, apiValueUsd } = await import('../src/proxy/features/cache-diag.js');
    // Opus 5.5 reads at $0.20 of $4 input = 0.05×
    assert.equal(costParts({ model: 'claude-opus-5-5', cacheReadTokens: 100_000 }).read, 5000);
    assert.equal(costParts({ cacheReadTokens: 100_000 }).read, 10_000);
    // Opus 4.6: 9127 write ×2 + 2798 out ×5 + 60238 read ×0.1 + 3 = 38273 eq × $5/M
    assert.equal(apiValueUsd({ model: 'claude-opus-4-6', inputTokens: 3, cacheReadTokens: 60238, cacheCreationTokens: 9127, outputTokens: 2798 }).toFixed(4), '0.1914');
    assert.equal(apiValueUsd({ model: 'mystery' }), null);
});
