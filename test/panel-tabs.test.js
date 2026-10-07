import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { TABS, OLD_TABS, resolveTab } from '../src/panel/core/tabs.js';

const src = (f) => readFileSync(new URL(`../src/panel/${f}`, import.meta.url), 'utf8');

test('tabs: 聊天 / 状态 / 设置 — no 其他, no 体检, no Mac tab', () => {
    assert.deepEqual(TABS, [['chat', '聊天'], ['status', '状态'], ['settings', '设置']]);
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

test('saved tab keys: current ones stay, old ones map to their successors, junk falls back to 聊天', () => {
    for (const [k] of TABS) assert.equal(resolveTab(k), k);
    assert.equal(resolveTab('reason'), 'chat');     // 5.3: 推理 → 聊天
    assert.equal(resolveTab('other'), 'settings');  // 5.3: 其他 folded into 设置
    assert.equal(resolveTab('mac'), 'settings');
    assert.equal(resolveTab('stats'), 'status');   // before 3.1
    assert.equal(resolveTab('adv'), 'settings');
    for (const junk of [null, undefined, '', 'nope']) assert.equal(resolveTab(junk), 'chat');
    // every old key points at a tab that exists
    for (const to of Object.values(OLD_TABS)) assert.ok(TABS.some(([k]) => k === to));
});

test('设置: 连接 / 选项, then 高级 (with 始终思考 and the saved request), then 重新引导; no backend form', () => {
    const settings = src('tabs/settings.js');
    const sections = [...settings.matchAll(/group\('([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(sections, ['连接', '选项']);
    assert.match(settings, /collapsible\('高级'/);
    for (const id of ['claudeMaxAlwaysThink', 'claudeMaxDebugDump', 'claude_max_debug_view', 'claude_max_guide_again']) assert.ok(settings.includes(id), id);
    assert.ok(settings.indexOf("collapsible('高级'") < settings.indexOf('claude_max_guide_again'), '重新引导 at the bottom');
    for (const gone of ['claude_max_backend', 'refreshBackend', 'API 密钥', 'claudeMaxCompactButtons', 'quietRender', 'showPerfDiag']) assert.ok(!settings.includes(gone), gone);
});

test('no 说明 links and no section descriptions anywhere in the panel', () => {
    const dom = src('core/dom.js');
    assert.ok(!dom.includes("'说明'") && !dom.includes('cm-desc-toggle') && !dom.includes('cm-more'));
    for (const f of ['tabs/chat.js', 'tabs/status.js', 'tabs/settings.js']) {
        const t = src(f);
        assert.doesNotMatch(t, /group\('[^']+', '/, `${f}: a group with a description`);
        assert.doesNotMatch(t, /\bmore: '/, `${f}: a toggle with a long explanation`);
        assert.doesNotMatch(t, /desc: '/, `${f}: a toggle with a description line`);
    }
});

test('状态: no 缓存建议; the last-turn line leaves the model to the header; 世界书缓存 hidden until needed', () => {
    const status = src('tabs/status.js');
    assert.ok(!status.includes('缓存建议') && !status.includes('renderCacheCard'));
    assert.doesNotMatch(status, /shortModel\(last\.model\)/);
    assert.match(status, /group\('世界书缓存', \{ id: 'claude_max_lore_sec' \}\);\s*lore\.root\.hidden = true;/);
    // One export button (report + raw data in one file), then the capture switch.
    assert.ok(!status.includes("button('复制诊断报告'") && !status.includes("button('下载完整请求'"));
    assert.ok(status.indexOf("button('导出诊断文件'") > 0 && status.indexOf("button('导出诊断文件'") < status.indexOf("title: '记录原始请求'"));
    assert.match(src('features/lore-cache.js'), /showSection\(parts\.length > 0\)/);
});

test('聊天: one thinking control, 不思考 first; model rows carry a short tag only', async () => {
    const chat = src('tabs/chat.js');
    assert.match(chat, /options: \[NO_THINKING_OPTION, \.\.\.EFFORT_OPTIONS\]/);
    assert.ok(!chat.includes("'claude_max_thinking'"));
    const models = src('features/models.js');
    const tags = [...models.matchAll(/tag: '([^']*)'/g)].map((m) => m[1]);
    assert.deepEqual(tags, ['最稳', '可关思考', '快']);
    for (const t of tags) assert.ok(t.length <= 4);
});
