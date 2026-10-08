import test from 'node:test';
import assert from 'node:assert/strict';

const { countWords } = await import('../src/panel/features/gen-progress.js');

test('word count: CJK by character, other scripts by word, punctuation / markup / emoji not counted', () => {
    assert.equal(countWords('她第一次没有看他的嘴唇。'), 11);
    assert.equal(countWords('Where am I? I sit up slowly.'), 7);
    assert.equal(countWords('林知微说：“Hello, Mr. Shen!”'), 7); // 林知微说 4 + Hello, Mr, Shen
    assert.equal(countWords('「おはよう」と彼女は言った。'), 11);
    assert.equal(countWords('안녕하세요 친구'), 7);
    assert.equal(countWords('Привет, мир'), 2);
    assert.equal(countWords("don't stop 1996.12.03 4:17"), 5);
    assert.equal(countWords('<div class="status">**好感度** 80 ❤️</div>'), 4);
    assert.equal(countWords(''), 0);
});

test('word count: thinking written into the reply is not counted, also one still open while streaming', () => {
    assert.equal(countWords('<thinking>先想想她会怎么做</thinking>\n<content>她推开门。</content>'), 4);
    assert.equal(countWords('<think>想</think>门<thinking>又想一遍</thinking>开了'), 3);
    assert.equal(countWords('<thinking>\n还在想，她会不会'), 0);
    assert.equal(countWords('她推开门。<THINKING>第二套思维链'), 4);
});
