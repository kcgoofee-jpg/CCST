import test from 'node:test';
import assert from 'node:assert/strict';

import { injectBlocks, TAIL_NOTE } from '../src/proxy/features/lore-tail.js';

test('inject: goes on top of the last user message, before a prefill', () => {
    const h = [
        { role: 'assistant', content: '开场' },
        { role: 'user', content: '我推门' },
        { role: 'assistant', content: '（预填' },
    ];
    const out = injectBlocks(h, [{ tag: 'world_info', text: '门后是地窖' }]);
    assert.equal(out[1].content, `<world_info>\n门后是地窖\n</world_info>\n${TAIL_NOTE}\n\n我推门`);
    assert.equal(out[2].content, '（预填');
    assert.equal(h[1].content, '我推门');
});

import { newLoreOnly, LORE_WINDOW } from '../src/proxy/features/lore-tail.js';
import { createTurnCollector, sentTextFor, __resetTurnCaptures } from '../src/proxy/features/turn-capture.js';

test('newLoreOnly: lines already given in earlier turns are not repeated', () => {
    const earlier = ['<world_info>\n地窖在木屋北侧\n</world_info>\n我推门'];
    const out = newLoreOnly([{ tag: 'world_info', text: '地窖在木屋北侧\n溪水向东流' }], earlier);
    assert.deepEqual(out, [{ tag: 'world_info', text: '溪水向东流' }]);
    assert.deepEqual(newLoreOnly([{ tag: 'world_info', text: '地窖在木屋北侧' }], earlier), []);
});

test('newLoreOnly: an entry last given more than LORE_WINDOW player messages ago is sent again in full', () => {
    const lore = [{ tag: 'triggered_lore', text: '地窖在木屋北侧' }];
    const given = '<triggered_lore>\n地窖在木屋北侧\n</triggered_lore>\n我推门';
    const filler = Array.from({ length: LORE_WINDOW }, (_, i) => `第${i}句`);
    assert.deepEqual(newLoreOnly(lore, [given, ...filler.slice(1)]), [], 'still within the window');
    assert.deepEqual(newLoreOnly(lore, [given, ...filler]), lore, 'fell out of the window');
});

test('collector files the sent message under the text ST sends next turn', () => {
    __resetTurnCaptures();
    const sent = '<world_info>\n甲\n</world_info>\n\n我推门';
    const c = createTurnCollector(sent, '我推门');
    c.onAppend([{ type: 'user', uuid: 'u1', message: { role: 'user', content: sent } }, { type: 'assistant', uuid: 'a1' }]);
    assert.equal(sentTextFor('我推门'), sent);
    assert.equal(sentTextFor(sent), null);
});

import { loreTarget, rememberInjected, injectedTextFor, __resetInjected } from '../src/proxy/features/lore-tail.js';

test('lore goes on the player message, not on a depth-0 injection after it', () => {
    const h = [
        { role: 'assistant', content: '开场' },
        { role: 'user', content: '我推门' },
        { role: 'user', content: '【变量更新规则】' },
    ];
    assert.equal(loreTarget(h), 1);
    const out = injectBlocks(h, [{ tag: 'Lore', text: '门后是地窖' }]);
    assert.ok(out[1].content.startsWith('<Lore>\n门后是地窖'));
    assert.equal(out[2].content, '【变量更新规则】');
    assert.equal(loreTarget([{ role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }]), 1);
    assert.equal(loreTarget([{ role: 'assistant', content: 'a' }]), -1);
});

test('a message sent with lore is remembered under the text ST sends next turn', () => {
    __resetInjected();
    rememberInjected('我推门', '<Lore>\n甲\n</Lore>\n\n我推门');
    assert.equal(injectedTextFor('我推门'), '<Lore>\n甲\n</Lore>\n\n我推门');
    assert.equal(injectedTextFor('别的'), null);
    for (let i = 0; i < 250; i++) rememberInjected(`m${i}`, `s${i}`);
    assert.equal(injectedTextFor('我推门'), null);
    assert.equal(injectedTextFor('m249'), 's249');
});

import { foldTrailingInjections, REPEAT_NOTE } from '../src/proxy/features/lore-tail.js';

test('depth-0 injections after the player message are folded into it', () => {
    const rules = '---\n变量更新规则:\n' + '每轮结束输出变量更新。'.repeat(30);
    const state = '---\n<status_current_variables>\n时刻: 02:10\n</status_current_variables>';
    const h = [
        { role: 'assistant', content: '开场' },
        { role: 'user', content: '我推门' },
        { role: 'user', content: `${state}\n${rules}` },
        { role: 'assistant', content: '（预填' },
    ];
    const first = foldTrailingInjections(h, []);
    assert.equal(first.folded, 1);
    assert.equal(first.repeated, 0);
    assert.equal(first.history.length, 3);
    assert.equal(first.history[1].content, `我推门\n\n${state}\n${rules}`);
    assert.equal(first.history[2].content, '（预填');
    // next turn: the rules were given verbatim before, the state changed
    const state2 = state.replace('02:10', '02:40');
    const h2 = [{ role: 'user', content: '我点灯' }, { role: 'user', content: `${state2}\n${rules}` }];
    const second = foldTrailingInjections(h2, [first.history[1].content]);
    assert.equal(second.repeated, 1);
    assert.equal(second.history[0].content, `我点灯\n\n${state2}\n${REPEAT_NOTE}`);
    // nothing after the player message: untouched
    const lone = [{ role: 'user', content: '只有我' }];
    assert.equal(foldTrailingInjections(lone).history, lone);
});

test('lore memory is keyed by text AND the reply it answers', () => {
    __resetInjected();
    rememberInjected('继续', '<Lore>\n甲\n</Lore>\n\n继续', '回复一');
    assert.equal(injectedTextFor('继续', '回复一'), '<Lore>\n甲\n</Lore>\n\n继续');
    assert.equal(injectedTextFor('继续', '回复二'), null, 'a later 「继续」 in the same chat');
    assert.equal(injectedTextFor('继续', '别的聊天的开场'), null, 'the same text in another chat');
});

test('newLoreOnly: a block reduced to closing tags adds nothing', async () => {
    const { newLoreOnly } = await import('../src/proxy/features/lore-tail.js');
    const earlier = ['<money_scale>\n- 金额按现代高资产尺度判断\n'];
    assert.deepEqual(newLoreOnly([{ tag: 'WorldFrame_components', text: '- 金额按现代高资产尺度判断\n</money_scale>]' }], earlier), []);
    assert.equal(newLoreOnly([{ tag: 'W', text: '</money_scale>]\n新的设定一行' }], earlier).length, 1);
});

test('noteTail: a tail that was stable and then changed is a settings change; per-turn churn is not', async () => {
    const { noteTail, __resetInjected } = await import('../src/proxy/features/lore-tail.js');
    __resetInjected();
    const old = '规则'.repeat(200);
    assert.equal(noteTail('c', old), null);
    assert.equal(noteTail('c', old), null);
    assert.deepEqual(noteTail('c', '新规则'.repeat(100)), { from: [old], to: '新规则'.repeat(100) });
    // Changes every turn (variables in the tail): never rewritten.
    __resetInjected();
    noteTail('d', 'x'.repeat(300) + 1);
    assert.equal(noteTail('d', 'x'.repeat(300) + 2), null);
    assert.equal(noteTail('d', 'x'.repeat(300) + 3), null);
});

test('noteTail: edited preset entries replace the old tail at once, every earlier version of it', async () => {
    const { noteTail, __resetInjected } = await import('../src/proxy/features/lore-tail.js');
    __resetInjected();
    const v1 = '日记番外'.repeat(100);
    const v2 = '直白肉欲'.repeat(100);
    const v3 = '双人直播'.repeat(100);
    assert.equal(noteTail('c', v1, { order: 'o1' }), null);
    // Seen one turn only, but the entries' fingerprint changed: a settings change (灰烬之桥 #66).
    assert.deepEqual(noteTail('c', v2, { order: 'o2' }), { from: [v1], to: v2 });
    assert.equal(noteTail('c', v2, { order: 'o2' }), null);
    // Per-turn churn with the same entries collects versions; the next edit replaces all of them.
    __resetInjected();
    noteTail('d', v1 + 1, { order: 'o1' });
    assert.equal(noteTail('d', v1 + 2, { order: 'o1' }), null);
    assert.deepEqual(noteTail('d', v3, { order: 'o2' }), { from: [v1 + 1, v1 + 2], to: v3 });
    // A reroll learns nothing: the change still shows on the next turn.
    __resetInjected();
    noteTail('e', v1, { order: 'o1' });
    assert.equal(noteTail('e', v2, { order: 'o2', reroll: true }), null);
    assert.deepEqual(noteTail('e', v2, { order: 'o2' }), { from: [v1], to: v2 });
});

test('noteTail: only the end of the old tail with the same entries is a missed history end, not a change', async () => {
    const { noteTail, __resetInjected } = await import('../src/proxy/features/lore-tail.js');
    __resetInjected();
    const full = `${'写作规则'.repeat(100)}\n\n${'思维链锁'.repeat(60)}`;
    noteTail('c', full, { order: 'o1' });
    noteTail('c', full, { order: 'o1' });
    assert.equal(noteTail('c', '思维链锁'.repeat(60), { order: 'o1' }), null, 'a short 「继续」 lost the history end');
    assert.equal(noteTail('c', full, { order: 'o1' }), null, 'and the full tail is still the known one');
    // Entries switched off at the front: the fingerprint changed, so it is a change.
    assert.deepEqual(noteTail('c', '思维链锁'.repeat(60), { order: 'o2' }), { from: [full], to: '思维链锁'.repeat(60) });
});

test('rewriteInjected replaces any of several old versions in one pass', async () => {
    const { rememberInjected, injectedTextFor, rewriteInjected, __resetInjected } = await import('../src/proxy/features/lore-tail.js');
    __resetInjected();
    rememberInjected('甲', '甲\n\n旧A', 'r1');
    rememberInjected('乙', '乙\n\n旧A\n\n旧B', 'r2');
    assert.equal(rewriteInjected(['\n\n旧A', '\n\n旧A\n\n旧B'], '\n\n新'), 2);
    assert.equal(injectedTextFor('甲', 'r1'), '甲\n\n新');
    assert.equal(injectedTextFor('乙', 'r2'), '乙\n\n新', 'the longer version wins, nothing left over');
});

test('cutExactLore lifts triggered entries out of the system prompt by their text', async () => {
    const { cutExactLore } = await import('../src/proxy/features/lore-tail.js');
    const a = '【柴火】木屋后面的柴堆只够烧两天，湿柴要先烘干。';
    const b = '【雪地】外面的积雪没过膝盖，出门要绑绑腿防止雪灌进去。';
    const sys = (...xs) => ['开头规则', ...xs, '结尾规则'].join('\n');
    const one = cutExactLore(sys(a, b), [a, b]);
    const two = cutExactLore(sys(b), [b]);
    assert.equal(one.system, two.system, 'the system prompt is the same whichever entries fired');
    assert.equal(two.system, sys(), '… and as if none had fired');
    assert.equal(one.text, `${a}\n\n${b}`);
    assert.deepEqual(cutExactLore('无关', [a]), { system: '无关', text: '' });
});

test('cutExactLore: a lore message that was the whole block leaves the prompt as if nothing fired', async () => {
    const { cutExactLore } = await import('../src/proxy/features/lore-tail.js');
    const lore = 'Eldoria is an ancient forest guarded by Seraphina, full of shadowfang beasts.';
    const quiet = '【结论】直觉多数时候够用。\n\n[Seraphina\'s Personality= "caring"]';
    const fired = '【结论】直觉多数时候够用。\n\n' + lore + '\n\n[Seraphina\'s Personality= "caring"]';
    assert.equal(cutExactLore(fired, [lore]).system, quiet);
    // inside a block joined by single newlines: just the entry and one join
    assert.equal(cutExactLore(`A line here\n${lore}\nB line here`, [lore]).system, 'A line here\nB line here');
});

test('cutExactLore: the world-info wrapper left empty goes too, so the prompt equals a turn with nothing triggered', async () => {
    const { cutExactLore } = await import('../src/proxy/features/lore-tail.js');
    const fmt = '[Details of the fictional world the RP is set in:\n{0}]';
    const entry = 'Eldoria is a magical forest, home to the Shadowfang beasts.';
    const card = '<components>\n[Scenario: you wake in her glade.]';
    const end = '</components>\n<timeline>';
    const fired = `${card}\n\n[Details of the fictional world the RP is set in:\n${entry}]\n\n${end}`;
    const quiet = `${card}\n\n${end}`;
    assert.equal(cutExactLore(fired, [entry], fmt).system, quiet);
    assert.equal(cutExactLore(fired, [entry]).system.includes('[Details'), true, 'without the format the wrapper stays (old panels)');
    // A constant entry keeps the wrapper in every turn: nothing to remove.
    const constant = 'The glade is protected by old wards that no beast can cross.';
    const both = `${card}\n\n[Details of the fictional world the RP is set in:\n${constant}\n${entry}]\n\n${end}`;
    assert.equal(cutExactLore(both, [entry], fmt).system, `${card}\n\n[Details of the fictional world the RP is set in:\n${constant}]\n\n${end}`);
});

test('tailsOfOldPreset: after a switch, the post-history versions noted under the old preset, once', async () => {
    const { noteTail, tailsOfOldPreset, __resetInjected } = await import('../src/proxy/features/lore-tail.js');
    __resetInjected();
    const v1 = '灰烬规则一'.repeat(60);
    const v2 = '灰烬规则二'.repeat(60);
    noteTail('c', v1, { order: 'o1', preset: '灰烬之桥' });
    noteTail('c', v2, { order: 'o1', preset: '灰烬之桥' });
    assert.equal(tailsOfOldPreset('c', '灰烬之桥'), null, 'same preset: nothing');
    assert.deepEqual(tailsOfOldPreset('c', '果实V6.3'), [v1, v2]);
    assert.equal(tailsOfOldPreset('c', '果实V6.3'), null, 'taken out once');
    noteTail('d', 'x'.repeat(300), { order: 'o1' });
    assert.equal(tailsOfOldPreset('d', '果实V6.3'), null, 'no preset name known: nothing');
});
