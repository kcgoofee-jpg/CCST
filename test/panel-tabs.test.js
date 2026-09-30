import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { TABS, OLD_TABS, resolveTab } from '../src/panel/core/tabs.js';

const src = (f) => readFileSync(new URL(`../src/panel/${f}`, import.meta.url), 'utf8');

test('tabs: 推理 / 状态 / 体检 / 设置 / 其他, no Mac tab', () => {
    assert.deepEqual(TABS, [['reason', '推理'], ['status', '状态'], ['check', '体检'], ['settings', '设置'], ['other', '其他']]);
    assert.ok(!TABS.some(([k]) => k === 'mac'));
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
    const other = src('tabs/other.js') + src('tabs/mac.js');
    for (const title of ['Mac 遥控', '手机连接', '省电显示', '性能诊断', '脚本按钮并排', '查看发给模型的请求']) {
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
