import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { diagnoseCache, describeDiag, nearestLabel, explainCache, __resetCacheDiag } from '../src/proxy/features/cache-diag.js';

const U = (content) => ({ role: 'user', content });
const A = (content) => ({ role: 'assistant', content });

test('first turn, then a stable system prompt', () => {
    __resetCacheDiag();
    assert.equal(diagnoseCache('<preset>rules</preset>', [A('hi'), U('u1')]).firstTurn, true);
    const d = diagnoseCache('<preset>rules</preset>', [A('hi'), U('u1'), A('a1'), U('u2')]);
    assert.equal(d.systemChanged, false);
    assert.equal(d.historyDiffAt, null);
    assert.match(describeDiag(d), /系统提示词与上一轮相同/);
});

test('reports where the system prompt changed and the enclosing tag', () => {
    __resetCacheDiag();
    diagnoseCache('<preset>rules</preset><world_info>雪山</world_info>', [A('hi'), U('u1')]);
    const d = diagnoseCache('<preset>rules</preset><world_info>沙漠</world_info>', [A('hi'), U('u1'), A('a1'), U('u2')]);
    assert.equal(d.systemChanged, true);
    assert.equal(d.systemDiffAt, '<preset>rules</preset><world_info>'.length);
    assert.equal(d.systemDiffLabel, '<world_info>');
    assert.match(describeDiag(d), /整段缓存失效/);
});

test('history rewritten by regex is reported', () => {
    __resetCacheDiag();
    diagnoseCache('sys', [A('hi'), U('u1'), A('long reply'), U('u2')]);
    const d = diagnoseCache('sys', [A('hi'), U('u1'), A('summary only'), U('u2'), A('a2'), U('u3')]);
    assert.equal(d.historyDiffAt, 2);
});

test('separate chats do not interfere', () => {
    __resetCacheDiag();
    diagnoseCache('sys A', [A('greeting A'), U('x')]);
    assert.equal(diagnoseCache('sys B', [A('greeting B'), U('y')]).firstTurn, true);
});

test('nearestLabel names tags, but never quotes a heading (prompt text) — only its kind', () => {
    const t = '# 世界设定\n北境很冷';
    assert.equal(nearestLabel(t, t.length - 1), '世界书标题段落');
    const u = '## 小美的秘密日记\n内容';
    assert.equal(nearestLabel(u, u.length - 1), '某个标题段落');
    assert.equal(nearestLabel('<rules>abc', 8), '<rules>');
});

test('explainCache: system change, history rewrite, effort switch', () => {
    const e = (over) => ({ ok: true, model: 'm', effort: 'high', inputTokens: 2, cacheReadTokens: 30000, cacheCreationTokens: 10000, ...over });
    const c = explainCache(e({ cacheDiag: { firstTurn: false, systemChanged: true, systemDiffAt: 36000, systemDiffLabel: '<world_info>', splitAt: 35000, historyDiffAt: 5, historyLen: 12 } }), e({}));
    assert.equal(c.hitPct, 75);
    assert.match(c.reasons[0], /设定在 <world_info> 变了/);
    assert.doesNotMatch(c.reasons.join('\n'), /单独缓存/, 'the CLI sends the system prompt as one block: no split claim');
    assert.match(c.reasons.join('\n'), /第 6 楼起变了/);
    assert.match(c.reasons.join('\n'), /改常驻/);
    const sw = explainCache(e({ cacheReadTokens: 0, cacheDiag: { firstTurn: false, systemChanged: false, historyDiffAt: null } }), e({ effort: 'medium' }));
    assert.match(sw.reasons.join(), /思考深度/);
    const first = explainCache(e({ cacheDiag: { firstTurn: true } }));
    assert.equal(first.state, 'first');
    assert.equal(first.title, '第一轮');
    assert.match(first.reasons[0], /先存进缓存/);
    assert.equal(explainCache({ ok: false }), null);
});

test('two chats with the same card greeting are kept apart', () => {
    __resetCacheDiag();
    const sys = '规则'.repeat(1000);
    const open = [A('三人XX ack'), A('greeting')];
    diagnoseCache(sys, [...open, U('问她们有没有系统')]);
    const other = diagnoseCache(sys, [...open, U('先去溪边')]);
    assert.equal(other.firstTurn, true);
    assert.notEqual(other.chat, diagnoseCache(sys, [...open, U('问她们有没有系统'), A('a'), U('u2')]).chat);
});

test('chat key survives an injection dropping off the first user message', () => {
    __resetCacheDiag();
    const sys = '规则'.repeat(1000);
    diagnoseCache(sys, [A('greeting'), U('问她们有没有系统\n\n【文风提醒】')]);
    assert.equal(diagnoseCache(sys, [A('greeting'), U('问她们有没有系统'), A('a1'), U('u2\n\n【文风提醒】')]).firstTurn, false);
});

test('explainCache flags history that stopped caching although nothing changed', () => {
    const diag = { chat: 'c1', firstTurn: false, systemChanged: false, historyDiffAt: null, historyLen: 9 };
    const prev = { ok: true, model: 'm', cacheReadTokens: 47000, cacheCreationTokens: 4000, cacheDiag: { chat: 'c1' } };
    const broken = explainCache({ ok: true, model: 'm', cacheReadTokens: 26000, cacheCreationTokens: 28000, cacheDiag: diag }, prev);
    assert.match(broken.reasons.join(), /内容没变却没读到/);
    const healthy = explainCache({ ok: true, model: 'm', cacheReadTokens: 51000, cacheCreationTokens: 2500, cacheDiag: diag }, prev);
    assert.doesNotMatch(healthy.reasons.join(), /内容没变却没读到/);
});

test('costParts uses list-price ratios', async () => {
    const { costParts } = await import('../src/proxy/features/cache-diag.js');
    const equivalentTokens = (e) => { const p = costParts(e); return Math.round(p.write + p.output + p.read + p.input); };
    // 1-hour writes (what CCST asks for) at 2×, 5-minute writes at 1.25×.
    assert.equal(equivalentTokens({ inputTokens: 2, cacheReadTokens: 50000, cacheCreationTokens: 2800, outputTokens: 5000 }), 2 + 5000 + 5600 + 25000);
    assert.equal(equivalentTokens({ inputTokens: 2, cacheReadTokens: 50000, cacheCreationTokens: 2800, outputTokens: 5000, cacheTtl: '5m' }), 2 + 5000 + 3500 + 25000);
});

test('a reroll (same conversation sent again) is marked', () => {
    __resetCacheDiag();
    const sys = '规则'.repeat(3000);
    const h = [{ role: 'user', content: '开始' }, { role: 'assistant', content: '好' }, { role: 'user', content: '推门' }];
    diagnoseCache(sys, h);
    assert.equal(diagnoseCache(sys, h).reroll, true);
    assert.equal(diagnoseCache(sys, [...h, { role: 'assistant', content: '门开了' }, { role: 'user', content: '进去' }]).reroll, undefined);
});

test('a turn started after the cache TTL ran out is expiry, not a broken replay', async () => {
    const { cacheExpired, cacheAnomaly } = await import('../src/proxy/features/cache-diag.js');
    const diag = { chat: 'c1', firstTurn: false, systemChanged: false, historyDiffAt: null, historyLen: 9 };
    const t0 = 1_800_000_000_000;
    // 5-minute write, 4-minute reply, next turn sent 3 minutes after it finished
    const prev = { ok: true, model: 'm', at: t0 + 240_000, durationMs: 240_000, cacheReadTokens: 0, cacheCreationTokens: 60000, cacheTtl: '5m', cacheDiag: { chat: 'c1' } };
    const cur = { ok: true, model: 'm', at: t0 + 420_000 + 200_000, durationMs: 200_000, cacheReadTokens: 0, cacheCreationTokens: 62000, cacheTtl: '5m', cacheDiag: diag };
    assert.deepEqual(cacheExpired(cur, prev), { gapMin: 7, ttl: '5m' });
    assert.equal(cacheAnomaly(cur, prev), false);
    assert.match(explainCache(cur, prev).reasons.join(), /5 分钟/);
    // The same gap with a 1-hour write is neither expired nor explained away
    const prev1h = { ...prev, cacheTtl: '1h' };
    assert.equal(cacheExpired({ ...cur, cacheTtl: '1h' }, prev1h), null);
    assert.equal(cacheAnomaly({ ...cur, cacheTtl: '1h' }, prev1h), true);
});

test('usage-stats reads which TTL the cache was written with', async () => {
    const { writtenTtl } = await import('../src/proxy/features/usage-stats.js');
    assert.equal(writtenTtl({ cache_creation: { ephemeral_5m_input_tokens: 9, ephemeral_1h_input_tokens: 0 } }), '5m');
    assert.equal(writtenTtl({ cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 9 } }), '1h');
    assert.equal(writtenTtl({ cache_creation_input_tokens: 9 }), null);
});

test('a reply that differs from last turn is reported as a swipe / edit', () => {
    __resetCacheDiag();
    const sys = '规则'.repeat(1000);
    diagnoseCache(sys, [A('greeting'), U('u1'), A('a1'), U('u2')]);
    const d = diagnoseCache(sys, [A('greeting'), U('u1'), A('a1 另一个分支'), U('u2'), A('a2'), U('u3')]);
    assert.equal(d.replyChanged, true);
    const e = { ok: true, model: 'm', inputTokens: 1, cacheReadTokens: 100, cacheCreationTokens: 900, cacheDiag: d };
    assert.match(explainCache(e, { ok: true, model: 'm' }).reasons.join(), /第 3 楼换了回复/);
});

test('an older reply cut down to its <摘要> by a depth regex is summaryReplaced, not a swipe', () => {
    __resetCacheDiag();
    const sys = '规则'.repeat(1000);
    const full = `:::newspaper 第一章\n她推开门，雪落进来。${'正文'.repeat(200)}\n<摘要>\n她推开木屋的门。\n雪很大。\n</摘要>\n状态栏：体力 80`;
    diagnoseCache(sys, [A('greeting'), U('u1'), A(full), U('u2'), A('a2'), U('u3')]);
    const d = diagnoseCache(sys, [A('greeting'), U('u1'), A('\n她推开木屋的门。\n雪很大。\n'), U('u2'), A('a2'), U('u3'), A('a3'), U('u4')]);
    assert.equal(d.summaryReplaced, true);
    assert.equal(d.historyDiffAt, 2);
    assert.equal(d.replyChanged, undefined);
    // The latest reply cut down is an edit, and a shorter reply with lines of its own is a swipe.
    __resetCacheDiag();
    diagnoseCache(sys, [A('greeting'), U('u1'), A(full), U('u2')]);
    const last = diagnoseCache(sys, [A('greeting'), U('u1'), A('她推开木屋的门。'), U('u2')]);
    assert.equal(last.summaryReplaced, undefined);
    assert.equal(last.replyChanged, true);
    __resetCacheDiag();
    diagnoseCache(sys, [A('greeting'), U('u1'), A(full), U('u2'), A('a2'), U('u3')]);
    const swipe = diagnoseCache(sys, [A('greeting'), U('u1'), A('另一个分支：她没有开门。'), U('u2'), A('a2'), U('u3'), A('a3'), U('u4')]);
    assert.equal(swipe.summaryReplaced, undefined);
    assert.equal(swipe.replyChanged, true);
});

test('prompt changed with the SillyTavern setup unchanged: scripts named as a maybe, only when some run and nothing else explains it', () => {
    const st = { preset: 'Izumi 1002', pp: 'none', order: 'aa', wi: ['x'], mut: ['脚本「泉此方悬浮窗」'] };
    const d = { chat: 'c', firstTurn: false, systemChanged: true, systemDiffAt: 2161, systemDiffLabel: '<ban>', historyDiffAt: null, historyLen: 4 };
    const e = { ok: true, model: 'm', chatKey: 'k', inputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 44000, cacheDiag: d, st };
    const prev = { ok: true, model: 'm', chatKey: 'k', st: { ...st } };
    const blamed = (entry, p = prev) => explainCache(entry, p).reasons.some((x) => /设置没动/.test(x));
    const r = explainCache(e, prev).reasons;
    assert.match(r[0], /设置没动却变了.*查脚本.*泉此方悬浮窗/);
    assert.ok(!blamed(e, { ...prev, st: { ...st, preset: '衡' } }), 'a preset switch is a setting change');
    assert.ok(!blamed({ ...e, st: { ...st, mut: [] } }), 'no script running: no claim');
    assert.ok(!blamed({ ...e, cacheDiag: { ...d, loreMoved: ['Lore'] } }), 'lore moved explains it');
    assert.ok(!blamed({ ...e, cacheDiag: { ...d, tailRewritten: 2 } }), 'post-history entries explain it');
    assert.ok(!blamed({ ...e, cacheDiag: { ...d, historyDiffAt: 1 } }), 'an edited older message');
    assert.ok(!blamed({ ...e, cacheDiag: { ...d, rewrite: true } }));
    assert.ok(!blamed({ ...e, st: { ...st, wiOff: true } }), 'old SillyTavern: world info unknown');
    assert.ok(!blamed(e, { ...prev, chatKey: 'other' }), 'another chat');
});

test('scriptSuspects: one rule for the status card and the report', async () => {
    const { scriptSuspects } = await import('../src/proxy/features/cache-diag.js');
    const st = { preset: 'p', pp: 'none', order: 'aa', wi: [], mut: ['正则「摘要」'] };
    const e = { chatKey: 'k', st, cacheDiag: { firstTurn: false, systemChanged: true, historyDiffAt: null } };
    assert.deepEqual(scriptSuspects(e, { chatKey: 'k', st }), ['正则「摘要」']);
    assert.equal(scriptSuspects({ ...e, cacheDiag: { systemChanged: false, replyChanged: true, historyDiffAt: 3 } }, { chatKey: 'k', st }), null);
    assert.equal(scriptSuspects({ ...e, chatKey: undefined, cacheDiag: { ...e.cacheDiag } }, { st }), null, 'no chat to compare');
});

test('a failed request is discarded: the resend is compared with the last request that went through', async () => {
    const { discardDiag } = await import('../src/proxy/features/cache-diag.js');
    __resetCacheDiag();
    const h1 = [A('hi'), U('u1')];
    const h2 = [A('hi'), U('u1'), A('a1'), U('u2')];
    diagnoseCache('<p>rules</p>', h1, { chatKey: 'k' });
    const failed = diagnoseCache('<p>rules</p>', h2, { chatKey: 'k' });
    assert.equal(failed.reroll, undefined);
    discardDiag(failed);
    const resend = diagnoseCache('<p>rules</p>', h2, { chatKey: 'k' });
    assert.equal(resend.reroll, undefined, 'not a reroll of the failed request');
    assert.equal(resend.firstTurn, false);
    // A true reroll of the last successful request stays one.
    assert.equal(diagnoseCache('<p>rules</p>', h2, { chatKey: 'k' }).reroll, true);
    // A first turn that failed leaves nothing behind.
    __resetCacheDiag();
    discardDiag(diagnoseCache('<p>rules</p>', h1, { chatKey: 'n' }));
    assert.equal(diagnoseCache('<p>rules</p>', h1, { chatKey: 'n' }).firstTurn, true);
});

test('cache writes of unknown TTL count as 1 hour in the equivalent tokens', async () => {
    const { cacheWriteMultiplier } = await import('../src/shared/backends.js');
    const { costParts } = await import('../src/proxy/features/cache-diag.js');
    const equivalentTokens = (e) => { const p = costParts(e); return Math.round(p.write + p.output + p.read + p.input); };
    assert.equal(cacheWriteMultiplier(null), 2);
    assert.equal(cacheWriteMultiplier('1h'), 2);
    assert.equal(cacheWriteMultiplier('5m'), 1.25);
    assert.equal(equivalentTokens({ cacheCreationTokens: 1000, cacheTtl: null }), 2000);
});

test('a reroll that read nothing does not claim it read everything', async () => {
    const { explainCache } = await import('../src/proxy/features/cache-diag.js');
    const base = { ok: true, model: 'claude-opus-5-5', inputTokens: 2, outputTokens: 2600, cacheTtl: '1h' };
    const missed = explainCache({ ...base, cacheReadTokens: 0, cacheCreationTokens: 39878, cacheDiag: { chat: 'p1', firstTurn: false, reroll: true, systemChanged: true, systemDiffAt: 5609, systemDiffLabel: '<story_setting>', historyDiffAt: null, historyLen: 2 } });
    assert.match(missed.reasons[0], /^重新生成，但整段重写了/);
    assert.match(missed.reasons.join('\n'), /设定在 <story_setting> 变了/);
    const hit = explainCache({ ...base, cacheReadTokens: 65385, cacheCreationTokens: 0, cacheDiag: { chat: 'p1', firstTurn: false, reroll: true, systemChanged: false, historyDiffAt: null, historyLen: 6 } });
    assert.match(hit.reasons[0], /几乎全读缓存/);
});

// ── 果实V6.3: depth regexes cut older replies every turn, and the preset ends on an assistant prefill ──
const SEEDS = /(?<=<meow_FM>[\s\S]*?)seeds[:：][\s\S]*?(?=<\/meow_FM)/i; // 「[3]3楼外伏笔不发送给AI」 minDepth 3
const SUMMARY = /^[\s\S]*(<meow_FM>[\s\S]*$)/i; // 「[2]5楼外只发送摘要和角色表」 minDepth 5
const reply = (n) => `<novel_header>\n[CHAP] 第${n}章\n</novel_header>\n${`第${n}章正文。`.repeat(300)}\n<meow_FM>\nserial:🍎No.00${n}\nplot:第${n}章发生的事。\nseeds:\n  [短期 1/5] 第${n}章埋下的伏笔，后面要回收<br>\n  [长期] 第${n}章的暗线<br>\nenigma:谁知道什么\n</meow_FM>\n`;
/** What SillyTavern sends on turn `t`: replies cut by depth (newest player message = depth 0), then the prefill. */
function guoshiTurn(t) {
    const msgs = [A('开场白')];
    for (let i = 1; i < t; i++) msgs.push(U(`第${i}句`), A(reply(i)));
    msgs.push(U(`第${t}句\n\n<输出要求>每轮都一样的预设尾部</输出要求>`));
    const last = msgs.length - 1;
    const out = msgs.map((m, i) => {
        const depth = last - i;
        if (m.role !== 'assistant' || i === 0) return m;
        let c = m.content;
        if (depth >= 3) c = c.replace(SEEDS, '');
        if (depth >= 5) c = c.replace(SUMMARY, '$1');
        return A(c);
    });
    return [...out, A(`[任务确认]\n<user_input>\n第${t}句\n</user_input>`)];
}

test('果实: a reply losing its seeds (depth 3) or all but its summary (depth 5) is a regex cut, never a swipe', () => {
    __resetCacheDiag();
    const sys = '规则'.repeat(1000);
    const seen = [];
    for (let t = 1; t <= 6; t++) {
        const d = diagnoseCache(sys, guoshiTurn(t), { chatKey: 'guoshi' });
        if (t === 1) continue;
        assert.equal(d.replyChanged, undefined, `turn ${t}: not a swipe`);
        seen.push(d.historyDiffAt === null ? null : `${d.historyDiffAt}:${d.cutDepth}`);
        if (d.historyDiffAt !== null) assert.equal(d.summaryReplaced, true, `turn ${t}`);
    }
    // turn 2: only the previous player message (sent with the preset's tail and prefill) differs — that is
    // not history yet; turn 3 cuts the first reply's seeds (depth 3); from turn 4 a reply reaches depth 5.
    assert.deepEqual(seen, [null, '2:3', '2:5', '4:5', '6:5']);
    assert.match(describeDiag(diagnoseCache(sys, guoshiTurn(7), { chatKey: 'guoshi' })), /深度 5 的旧回复）被预设正则改短了/);
});

test('explainCache names the depth regex that cut the reply and what that costs every turn', async () => {
    const { depthRegexAt } = await import('../src/proxy/features/cache-diag.js');
    const rx = [['MoM必选-[3]3楼外伏笔不发送给AI(092', 3], ['MoM必选-[2]5楼外只发送摘要和角色表(09', 5]];
    assert.equal(depthRegexAt(rx, 5), '[2]');
    assert.equal(depthRegexAt(rx, 3), '[3]');
    assert.equal(depthRegexAt(rx, 4), '[3]', 'the deepest one it has crossed');
    assert.equal(depthRegexAt(rx, 2), null);
    assert.equal(depthRegexAt([['保留4层正文', 4]], 5), '「保留4层正文」');
    assert.equal(depthRegexAt(undefined, 5), null);
    const st = { preset: '果实V6.3', order: 'a', wi: [], mut: [], rx };
    const d = { chat: 'p', firstTurn: false, systemChanged: false, historyDiffAt: 10, historyLen: 17, summaryReplaced: true, cutDepth: 5 };
    const e = { ok: true, model: 'claude-opus-4-6', inputTokens: 3, cacheReadTokens: 21727, cacheCreationTokens: 75167, cacheTtl: '1h', cacheDiag: d, st };
    const prev = { ok: true, model: 'claude-opus-4-6', inputTokens: 3, cacheReadTokens: 21727, cacheCreationTokens: 74514, cacheTtl: '1h', st };
    const why = explainCache(e, prev).reasons[0];
    assert.equal(why, '第 11 楼被正则[2]改短，每轮重写 75k');
    assert.ok(why.replace(/\s/g, '').length <= 20, why);
    // No regex list (an older panel): still not called a swipe.
    assert.equal(explainCache({ ...e, st: { ...st, rx: undefined } }, prev).reasons[0], '第 11 楼被预设正则改短了');
});

test('explainCache: another preset says so, not 「换了回复」 for old replies its regexes no longer touch', () => {
    const d = { chat: 'p', firstTurn: false, systemChanged: true, systemDiffAt: 0, systemDiffLabel: null, historyDiffAt: 6, historyLen: 11, replyChanged: true };
    const e = { ok: true, model: 'm', inputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 78399, cacheDiag: d, st: { preset: '果实V6.3', mut: ['脚本「果实之心」'] } };
    const r = explainCache(e, { ok: true, model: 'm', st: { preset: '【Ashen Bridge · 灰烬之桥】Claude-v4.9', mut: [] } }).reasons;
    assert.deepEqual(r, ['换了预设，整段重写']);
});
