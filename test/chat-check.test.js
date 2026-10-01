import test from 'node:test';
import assert from 'node:assert/strict';

import { checkReply, bannedFromPrompts, wordRangeFromPrompts, statusNumbers } from '../src/shared/chat-check.js';

const status = (hp, food, pts) => `<status>\n生命: ${hp}/100 | 饥饿: ${food}/100\n资源: 木材 3 | 积分 ${pts}\n好感: 苏念念 5 | 林初晴 6\n</status>`;
const reply = (body, extra = '') => `<content>${body}</content>\n${extra}`;
const opts = (labels) => `<branches>\n<details><summary>🧩Select</summary>\n${'ABCDEFGHIJ'.split('').map((l) => `${l}.${labels ? '[稳健路线] ' : ''}去溪边`).join('\n')}\n</details>\n</branches>`;

test('preset parsing: banned list and word range', () => {
    const prompts = [
        { name: '❎丨禁词表', content: '禁止使用‘似笑非笑、嘴角勾起’等套话\n用‘语气、声音’给台词贴标签' },
        { name: '💬丨字数设定', content: '{{setvar::word_count::[大于1200小于1600]}}{{trim}}' },
    ];
    assert.deepEqual(bannedFromPrompts(prompts).sort(), ['似笑非笑', '嘴角勾起'].sort());
    assert.deepEqual(wordRangeFromPrompts(prompts), [1200, 1600]);
});

test('status numbers parse the 7-line block', () => {
    assert.deepEqual(statusNumbers(status(96, 80, 50)), { 生命: 96, 饥饿: 80, 木材: 3, 积分: 50, 苏念念: 5, 林初晴: 6 });
});

test('checkReply flags the usual problems and only gauge jumps', () => {
    const body = '他笑了——似笑非笑。这不是害怕，是兴奋。你看你你你你。'.repeat(3) + '她学过医学院的课。';
    const r = checkReply({
        mes: reply(body, status(40, 79, 350) + opts(false)),
        prevMes: reply('上一轮。', status(96, 80, 50)),
        words: [1200, 1600], banned: ['似笑非笑'], leaks: ['医学院'],
    });
    const codes = r.issues.map((i) => i.code);
    for (const c of ['length', 'person', 'banned', 'dash', 'notbut', 'labels', 'leak', 'status']) assert.ok(codes.includes(c), c);
    assert.match(r.issues.find((i) => i.code === 'status').text, /生命 96→40/);
    assert.doesNotMatch(r.issues.find((i) => i.code === 'status').text, /积分/);   // 50→350 is a reward, not a gauge
});

test('a clean reply has no issues', () => {
    const body = '溪水很凉。'.repeat(280);
    const r = checkReply({ mes: reply(body, status(96, 79, 50) + opts(true)), prevMes: reply('昨天的事。', status(98, 80, 50)), words: [1200, 1600], banned: ['似笑非笑'] });
    assert.deepEqual(r.issues, []);
});

test('second-person presets do not trigger the person check', async () => {
    const { secondPersonFromPreset } = await import('../src/shared/chat-check.js');
    const preset = {
        prompts: [{ identifier: 'a', name: '👤第二人称user视角' }, { identifier: 'b', name: '👤第三人称' }],
        prompt_order: [{ order: [{ identifier: 'a', enabled: true }, { identifier: 'b', enabled: false }] }],
    };
    assert.equal(secondPersonFromPreset(preset), true);
    preset.prompt_order[0].order[0].enabled = false;
    assert.equal(secondPersonFromPreset(preset), false);
    const body = '<content>' + '你推开门，你看见她，你愣住，你后退，你笑了。'.repeat(2) + '</content>';
    assert.ok(checkReply({ mes: body }).issues.some((i) => i.code === 'person'));
    assert.ok(!checkReply({ mes: body, secondPerson: true }).issues.some((i) => i.code === 'person'));
});

test('word range from an enabled「字数」entry name, and Ny-style four options', async () => {
    const { wordRangeFromPreset } = await import('../src/shared/chat-check.js');
    const preset = {
        prompts: [{ identifier: 'w', name: '✂️ 字数｜1400–1600字', content: '' }, { identifier: 'x', name: '✂️ 字数｜800–1000字', content: '' }],
        prompt_order: [{ order: [{ identifier: 'w', enabled: true }, { identifier: 'x', enabled: false }] }],
    };
    assert.deepEqual(wordRangeFromPreset(preset), [1400, 1600]);
    assert.equal(wordRangeFromPreset({ prompts: [], prompt_order: [] }), null);
    const ny = (n) => `<content>正文</content><small>接下来\n${['1️⃣ 走', '2️⃣ 跑', '3️⃣ 停', '4️⃣ 看'].slice(0, n).join('\n')}\ntips: 小心</small>`;
    assert.ok(!checkReply({ mes: ny(4) }).issues.some((i) => i.code === 'options'));
    assert.match(checkReply({ mes: ny(3) }).issues.find((i) => i.code === 'options').text, /只有 3 个/);
});

test('childhood flashbacks must stay innocent', async () => {
    const { flashbackText } = await import('../src/shared/chat-check.js');
    const clean = '<content>现在的剧情。\n> 【回忆】\n> 那年夏天我们在河边钓鱼，他把唯一的面包掰成两半。\n回到现在。</content>';
    assert.match(flashbackText(clean), /钓鱼/);
    assert.ok(!checkReply({ mes: clean }).issues.some((i) => i.code === 'flashback'));
    const bad = '<content>> 【回忆】\n> 她的胸部……\n</content>';
    assert.match(checkReply({ mes: bad }).issues.find((i) => i.code === 'flashback').text, /胸部/);
    // explicit words OUTSIDE the flashback are not this check's business
    assert.ok(!checkReply({ mes: '<content>成年人的剧情：吻。\n> 【回忆】\n> 我们爬上了老槐树。</content>' }).issues.some((i) => i.code === 'flashback'));
});

import { bodyOf as bodyOfForImages } from '../src/shared/chat-check.js';

test('image tags and HTML cards are not counted as prose', () => {
    const mes = '<content>她推门。\n<bbi_image>1boy, 2girls, bedroom</bbi_image>\n<htm1fenge><div>卡片</div></htm1fenge>灯亮了。</content>';
    assert.equal(bodyOfForImages(mes).replace(/\s/g, ''), '她推门。灯亮了。');
});

import { paragraphRangeFromPreset, sceneCardFromPreset, paragraphCount } from '../src/shared/chat-check.js';

test('paragraph plan and scene card come from the preset; the reply is checked against them', () => {
    const preset = {
        prompts: [
            { identifier: 'w', content: '{{setvar::word_plan::  - 按段落控制篇幅：正文分 8–11 段，每段约 120–180 字}}' },
            { identifier: 'c', content: '<scene_card_rule>…</scene_card_rule>' },
        ],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'w', enabled: true }, { identifier: 'c', enabled: true }] }],
    };
    assert.deepEqual(paragraphRangeFromPreset(preset), [8, 11]);
    assert.equal(sceneCardFromPreset(preset), true);
    const para = '她抬手把门推开，走廊的灯一格一格亮起来，照出地毯上的铆钉印。';
    const long = `<content>\n${Array(15).fill(para).join('\n')}\n</content>`;
    const r = checkReply({ mes: long, paragraphs: [8, 11], sceneCard: true });
    assert.equal(r.paragraphs, 15);
    assert.ok(r.issues.some((i) => i.code === 'paragraphs'));
    assert.ok(r.issues.some((i) => i.code === 'scenecard'));
    const ok = checkReply({ mes: `<content>\n${Array(9).fill(para).join('\n')}\n</content>\n<scene_card>地点：书房</scene_card>`, paragraphs: [8, 11], sceneCard: true });
    assert.ok(!ok.issues.some((i) => i.code === 'paragraphs' || i.code === 'scenecard'));
    assert.equal(paragraphCount('短\n' + para), 1);
});

test('paragraphCount: blank-line blocks are paragraphs, dialogue lines inside them are not', () => {
    const p = '她把地图放到矮桌上，摊平在旅人手边，伸出一根手指点在那个红圈上。';
    const d = '"你记得它画在哪里吗？"她问，声音压得很低，像怕惊动外面的东西。';
    assert.equal(paragraphCount([p + '\n' + d, p, p + '\n' + d + '\n' + d].join('\n\n')), 3);
    assert.equal(paragraphCount([p, d, p].join('\n')), 3); // no blank lines: one per line
});

import { detectRefusal } from '../src/shared/chat-check.js';

test('refusal: declined replies are flagged with an excerpt and the usage-policy hint', () => {
    for (const mes of [
        "I need to decline continuing this story. The scene involves a character who is a minor.",
        "I can't write this scene.",
        "I'm sorry, but I can't continue with this roleplay.",
        'I understand the setup. I cannot continue with content like this.',
        '我不能继续这个故事。',
        '无法继续这个故事，抱歉。',
        '很抱歉，我无法继续这个角色扮演。',
        '我不能继续',
        '**我必须拒绝这个请求。**',
        "<content>I won't write this.</content>",
    ]) {
        const r = checkReply({ mes });
        const refusal = r.issues.find((i) => i.code === 'refusal');
        assert.ok(refusal, mes);
        assert.match(refusal.text, /模型拒绝了这一轮：「/);
        assert.match(refusal.text, /Anthropic 使用政策/);
        assert.match(refusal.text, /切卡时自动检查角色卡/);
        assert.doesNotMatch(refusal.text, /换个说法|换模型|绕过/);
    }
    assert.equal(checkReply({ mes: '我不能继续这个故事。', words: [1200, 1600] }).issues.length, 1, 'a refusal is not also a length problem');
});

test('refusal: in-character replies that mention refusing are not flagged', () => {
    const long = '她把杯子放下，窗外的雨很大。'.repeat(60);
    for (const mes of [
        '“我拒绝！”她猛地站起来，把信摔在桌上。门外的风声越来越大。',
        '「我不能继续了。」他靠在墙边，喘着气。',
        '他拒绝了她的邀请，转身离开了房间，留下一杯凉掉的茶。',
        '我无法继续忍受这种日子，她想。窗外下着雨。',
        '女王拒绝了使节的请求。大厅里一片寂静。',
        '她说：我不能继续留在这里了。',
        'He refused the offer and turned away. “I can\'t write you a letter,” he said.',
        `我不能继续这个故事。${long}`,
        long,
    ]) {
        assert.ok(!checkReply({ mes }).issues.some((i) => i.code === 'refusal'), mes.slice(0, 30));
    }
    assert.equal(detectRefusal(''), null);
});

import { replyFlags } from '../src/shared/chat-check.js';

test('replyFlags: refusal / truncated / empty are reliable flags; ordinary replies and background calls give none', () => {
    const fine = '她推开门，雨还在下。'.repeat(40);
    assert.deepEqual(replyFlags(fine, { finish: 'stop', notices: [] }), []);
    // proxy refusal: nearly empty → declined; with real text → cut off
    const declined = replyFlags('', { notices: ['refusal'], finish: 'content_filter', textChars: 0 });
    assert.equal(declined[0].code, 'refusal');
    assert.equal(declined[0].short, '模型拒绝了这一轮');
    assert.equal(replyFlags(fine, { notices: ['refusal'], textChars: 900 })[0].short, '被截断');
    // text-only refusal (no proxy record)
    const textRefusal = replyFlags("I can't continue with this story. I'm happy to help with other directions instead.", null);
    assert.equal(textRefusal[0].code, 'refusal');
    assert.match(textRefusal[0].text, /模型拒绝了这一轮/);
    // length
    const cut = replyFlags(fine, { finish: 'length' });
    assert.deepEqual(cut.map((f) => f.code), ['length']);
    assert.equal(cut[0].short, '被截断');
    // empty
    assert.deepEqual(replyFlags('  \n', null).map((f) => f.code), ['empty']);
    // a background request never flags this reply; the reply text is not needed for proxy-only flags
    assert.deepEqual(replyFlags(fine, { auxiliary: true, finish: 'length' }), []);
    assert.equal(replyFlags(null, { finish: 'length' })[0].code, 'length');
});
