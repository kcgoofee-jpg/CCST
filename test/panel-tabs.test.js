import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { TABS, OLD_TABS, resolveTab } from '../src/panel/core/tabs.js';

const src = (f) => readFileSync(new URL(`../src/panel/${f}`, import.meta.url), 'utf8');

test('tabs: 推理 / 状态 / 设置 / 其他, no 体检 and no Mac tab', () => {
    assert.deepEqual(TABS, [['reason', '推理'], ['status', '状态'], ['settings', '设置'], ['other', '其他']]);
    assert.ok(!TABS.some(([k]) => k === 'mac' || k === 'check'));
    assert.equal(resolveTab('check'), 'status'); // a saved 体检 tab lands on 状态
});

test('体检 tab is gone: no badge, no glance.issues, no tab switch to check', () => {
    const shell = src('shell.js');
    assert.ok(!shell.includes('check_badge') && !shell.includes('glance.issues') && !shell.includes("'check'") && !shell.includes('buildCheckTab'));
    assert.ok(!src('core/store.js').includes('issues'));
    assert.ok(!src('style.css').includes('cm-badge'));
});

test('heuristic checks: master switch exists, default off for new and existing users, gates run/toast/card audit', async () => {
    const { defaultSettings } = await import('../src/panel/core/settings.js');
    assert.equal(defaultSettings.heuristicChecks, false);
    // existing users' saved settings lack the key; the fill-in loop in getSettings uses the default (false)
    assert.ok(src('core/settings.js').includes('extensionSettings[MODULE][key] === undefined'));
    const checkup = src('features/checkup.js');
    assert.match(checkup, /!settings\.heuristicChecks && !force\) \{[\s\S]*?return;/);   // off: returns before checkReply
    assert.ok(checkup.indexOf('heuristicChecks') < checkup.indexOf('checkReply('));
    assert.match(checkup, /toast && settings\.heuristicChecks/);
    assert.match(src('features/card-audit.js'), /heuristicChecks && getSettings\(\)\.cardAudit/);
    // the group lives in 其他, collapsed, with the false-alarm note
    const other = src('tabs/other.js'), check = src('tabs/check.js');
    assert.ok(other.includes('buildCheckupSection'));
    assert.ok(check.includes("'体检（实验）'") && check.includes('受预设和其他扩展影响，可能误报'));
    assert.ok(check.includes('claudeMaxHeuristicChecks'));
});

test('状态 has the 最新回复 card; the turn notice carries the flag into the done line', () => {
    assert.ok(src('tabs/status.js').includes('claude_max_latest'));
    assert.ok(src('features/checkup.js').includes('renderLatestFlags'));
    assert.ok(src('features/turn-notice.js').includes('replyFlags'));
    assert.ok(src('features/gen-progress.js').includes('replyFlags'));
});

test('saved tab keys: current ones stay, old ones map to their successors, junk falls back to 推理', () => {
    for (const [k] of TABS) assert.equal(resolveTab(k), k);
    assert.equal(resolveTab('mac'), 'other');      // 4.0: the Mac tab moved into 其他
    assert.equal(resolveTab('stats'), 'status');   // before 3.1
    assert.equal(resolveTab('adv'), 'settings');
    for (const junk of [null, undefined, '', 'nope']) assert.equal(resolveTab(junk), 'reason');
    // every old key points at a tab that exists
    for (const to of Object.values(OLD_TABS)) assert.ok(TABS.some(([k]) => k === to));
});

test('其他 holds the moved sections; 设置 keeps 连接 / 代理后端 / 思考 / 高级 only', () => {
    const other = src('tabs/other.js') + src('tabs/check.js');
    for (const title of ['查看发给模型的请求', '体检（实验）']) {
        assert.ok(other.includes(`'${title}'`), `其他 lacks ${title}`);
    }
    const settings = src('tabs/settings.js');
    const sections = [...settings.matchAll(/group\('([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(sections, ['连接', '代理后端', '思考']);
    assert.match(settings, /collapsible\('高级'/);
    // cache & context switches sit inside 高级, the moved ones are gone from 设置 and 体检
    for (const gone of ['claudeMaxCompactButtons', 'claudeMaxDebugDump', 'quietRender', 'showPerfDiag']) assert.ok(!settings.includes(gone), gone);
    assert.ok(!src('tabs/check.js').includes('F.perf'));
});
