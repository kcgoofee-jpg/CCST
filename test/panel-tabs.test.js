import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { TABS, OLD_TABS, resolveTab } from '../src/panel/core/tabs.js';

const src = (f) => readFileSync(new URL(`../src/panel/${f}`, import.meta.url), 'utf8');

test('tabs: 状态 / 设置 — no 聊天 (model and thinking are SillyTavern\'s), no 其他, no 体检, no Mac tab', () => {
    assert.deepEqual(TABS, [['status', '状态'], ['settings', '设置']]);
    assert.ok(!TABS.some(([k]) => k === 'mac' || k === 'check' || k === 'other'));
    assert.equal(resolveTab('check'), 'status'); // a saved 体检 tab lands on 状态
});

test('体检 tab is gone: no badge, no glance.issues, no tab switch to check', () => {
    const shell = src('shell.js');
    assert.ok(!shell.includes('check_badge') && !shell.includes('glance.issues') && !shell.includes("'check'") && !shell.includes('buildCheckTab'));
    assert.ok(!src('core/store.js').includes('issues'));
    assert.ok(!src('style.css').includes('cm-badge'));
});

test('状态 has the 最新回复 card; the turn notice carries the flag into the done line', () => {
    assert.ok(src('tabs/status.js').includes('claude_max_latest'));
    assert.ok(src('features/checkup.js').includes('renderLatestFlags'));
    assert.ok(src('features/turn-notice.js').includes('replyFlags'));
    assert.ok(src('features/gen-progress.js').includes('replyFlags'));
});

test('saved tab keys: current ones stay, old ones map to their successors, junk falls back to 状态', () => {
    for (const [k] of TABS) assert.equal(resolveTab(k), k);
    assert.equal(resolveTab('chat'), 'status');     // 6.1: 聊天 went
    assert.equal(resolveTab('reason'), 'status');
    assert.equal(resolveTab('other'), 'settings');  // 5.3: 其他 folded into 设置
    assert.equal(resolveTab('mac'), 'settings');
    assert.equal(resolveTab('stats'), 'status');   // before 3.1
    assert.equal(resolveTab('adv'), 'settings');
    for (const junk of [null, undefined, '', 'nope']) assert.equal(resolveTab(junk), 'status');
    // every old key points at a tab that exists
    for (const to of Object.values(OLD_TABS)) assert.ok(TABS.some(([k]) => k === to));
});

test('设置: 连接 / 缓存 / 检查, then 重看引导; thinking, model and the cache switches are not here', () => {
    const settings = src('tabs/settings.js');
    const sections = [...settings.matchAll(/group\('([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(sections, ['连接', '缓存', '排查']);
    for (const id of ['claudeMaxLoreTail', 'claude_max_debug_view', 'claude_max_guide_again']) assert.ok(settings.includes(id), id);
    assert.ok(settings.indexOf("group('检查')") < settings.indexOf('claude_max_guide_again'), '重看引导 at the bottom');
    for (const gone of ['claudeMaxAlwaysThink', 'claudeMaxDebugDump', 'claudeMaxIdentity', 'claudeMaxResume', 'claudeMaxInlineSystem', 'claudeMaxFoldTail', '后台请求思考深度', "collapsible('高级'", 'claude_max_backend', 'API 密钥']) assert.ok(!settings.includes(gone), gone);
});

test('no 说明 links and no section descriptions anywhere in the panel', () => {
    const dom = src('core/dom.js');
    assert.ok(!dom.includes("'说明'") && !dom.includes('cm-desc-toggle') && !dom.includes('cm-more'));
    for (const f of ['tabs/status.js', 'tabs/settings.js']) {
        const t = src(f);
        assert.doesNotMatch(t, /group\('[^']+', '/, `${f}: a group with a description`);
        assert.doesNotMatch(t, /\bmore: '/, `${f}: a toggle with a long explanation`);
        assert.doesNotMatch(t, /desc: '/, `${f}: a toggle with a description line`);
    }
});

test('状态: no 缓存建议; the last-turn line leaves the model to the header; no 世界书缓存; one export, no capture switch', () => {
    const status = src('tabs/status.js');
    assert.ok(!status.includes('缓存建议') && !status.includes('renderCacheCard'));
    assert.doesNotMatch(status, /shortModel\(last\.model\)/);
    assert.ok(!status.includes('世界书缓存') && !status.includes('记录原始请求'));
    // One export button (report + raw data in one file).
    assert.ok(!status.includes("button('复制诊断报告'") && !status.includes("button('下载完整请求'"));
    assert.ok(status.indexOf("button('导出诊断'") > 0);
    assert.equal(status.split("button('导出").length, 2, 'exactly one export button');
});

test('thinking follows SillyTavern\'s 推理强度: Minimum = no thinking, Auto sends no depth, background calls never think', () => {
    const inject = src('core/inject.js');
    assert.match(inject, /cs\?\.reasoning_effort/);
    assert.match(inject, /if \(effort === 'min'\) lines\.push\('  thinking: off'\)/);
    assert.match(inject, /lines\.push\('  purpose: quiet', '  thinking: off'\)/);
    assert.match(inject, /show_reasoning: \$\{cs\?\.show_thoughts !== false\}/);
});
