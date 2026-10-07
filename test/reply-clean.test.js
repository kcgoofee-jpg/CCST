import test from 'node:test';
import assert from 'node:assert/strict';

import { detectRefusal } from '../src/shared/chat-check.js';
import { profileNotice, connectAdvice } from '../src/panel/core/connection-profile.js';
import { presetFamily, presetMismatchNote } from '../src/shared/preset-reco.js';

const REAL_REFUSAL = `I need to stop here. The previous conversation contains sexual content involving a character who is a minor, and I cannot continue writing any content in this narrative thread.

I'm happy to help with creative writing projects in other directions, for example:

- Uma historia de misterio ambientada em uma cidade portuaria, com foco em investigacao e atmosfera
<bbi_image>1girl, harbor, night<nl>harbor at night</nl><size>landscape</size></bbi_image>
- A politica interna de uma corte ficticia, com intrigas e alianças em disputa constante entre as casas
- Uma aventura de fantasia com um grupo de viajantes cruzando montanhas e vales desconhecidos
<bbi_image>1boy, mountain<nl>mountain pass</nl><size>landscape</size></bbi_image>
- Uma historia de slice-of-life sobre amigos que abrem uma pequena cafeteria no bairro antigo

Let me know which direction interests you and I will gladly continue from there.
<StatusPlaceHolderImpl/>`;

test('refusal with image blocks, alternatives and a placeholder is still detected', () => {
    const padded = REAL_REFUSAL + '\n\n' + 'Qualquer uma dessas opcoes pode ser desenvolvida em detalhe. '.repeat(10);
    assert.ok(detectRefusal(REAL_REFUSAL));
    assert.ok(detectRefusal(padded));
});

test('connect notice warns when the active preset looks made for another model family', () => {
    assert.equal(presetFamily('智脑-Z(3.1P)'), 'gemini');
    assert.equal(presetFamily('Gemini 破限 v2'), 'gemini');
    assert.equal(presetFamily('Opus 5.5 预设'), 'claude');
    assert.equal(presetFamily('Default'), null);
    assert.equal(presetMismatchNote('Default'), '');
    assert.equal(presetMismatchNote('Claude 专用'), '');
    const note = presetMismatchNote('智脑-Z(3.1P)');
    assert.match(note, /『智脑-Z\(3\.1P\)』看起来是给 Gemini 用的，Claude 可能表现不好；可以在『AI 回复配置』换成给 Claude 的预设/);
    assert.match(connectAdvice({ presetNote: note })[0].text, /Gemini/);
    assert.doesNotMatch(profileNotice({ existed: false }), /Gemini/);
    assert.deepEqual(connectAdvice({}), []);
});
