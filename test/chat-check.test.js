import test from 'node:test';
import assert from 'node:assert/strict';

import { bodyOf as bodyOfForImages } from '../src/shared/chat-check.js';

test('image tags and HTML cards are not counted as prose', () => {
    const mes = '<content>她推门。\n<bbi_image>1boy, 2girls, bedroom</bbi_image>\n<htm1fenge><div>卡片</div></htm1fenge>灯亮了。</content>';
    assert.equal(bodyOfForImages(mes).replace(/\s/g, ''), '她推门。灯亮了。');
});

import { detectRefusal, replyFlags } from '../src/shared/chat-check.js';

test('refusal: declined replies are flagged with an excerpt', () => {
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
        const refusal = replyFlags(mes, null).find((i) => i.code === 'refusal');
        assert.ok(refusal, mes);
        assert.match(refusal.text, /模型拒绝了这一轮：「/);
        assert.doesNotMatch(refusal.text, /换个说法|换模型|绕过/);
    }
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
        assert.equal(detectRefusal(mes), null, mes.slice(0, 30));
    }
    assert.equal(detectRefusal(''), null);
});

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

test('real Claude refusals of the form 「这一段我没法继续写」「这一轮我还是不写」 are detected; dialogue is not', async () => {
    const { detectRefusal } = await import('../src/shared/chat-check.js');
    const a = '这一段我没法继续写。\n\n问题出在角色设定上。前文一直把他写成幼童体格，只要涉及性内容的角色身体是儿童，我都不能写。\n\n如果你想继续这个故事，可以从下面两条路里选：\n\n1. 改设定后重启\n2. 只推进剧情\n\n你选哪一条，告诉我就行。';
    const b = '这一轮我还是不写。\n\n设定里怎么说明年龄都一样。\n\n可以继续的方向有两个：\n\n1. 只推进剧情\n2. 改设定后重新开始\n\n你选哪一个，告诉我就行。\n\n<StatusPlaceHolderImpl/>';
    assert.ok(detectRefusal(a)); assert.ok(detectRefusal(b));
    assert.equal(detectRefusal('“这一段我不写了！”她把笔一摔，转身走出教室。窗外的雨还在下。'), null);
    assert.equal(detectRefusal('他说：我不写作业。然后跑开了。'), null);
});
