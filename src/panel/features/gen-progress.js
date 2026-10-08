// ──────────────────────────────────────────────
// The reply being written, shown in the panel's status bar (core/store.js `gen`; drawn by shell.js)
// ──────────────────────────────────────────────

import { connectionInfo } from '../core/connection.js';
import { generating } from '../core/st.js';
import { store } from '../core/store.js';
import { libs } from '../core/libs.js';

// 审: 生成进度状态：是否在跟踪、完成行的消失计时、兜底看门狗、每秒重画计时。
// Only for chat replies going to a Claude connection (not background requests or other connections).
// thinking → writing → done (a few seconds: length, time, cache) → back to the normal bar.
let genActive = false;
let doneTimer = null;
let genWatch = null;
let tick = null;

// 审: 读当前生成进度。
const gen = () => store.get().gen;
// 审: 合并更新生成进度并触发顶栏重画。
const setGen = (patch) => store.set({ gen: { ...gen(), ...patch } });
// 审: 回到闲置：停掉每秒计时，清空进度。
const idle = () => { clearInterval(tick); tick = null; store.set({ gen: { kind: 'idle' } }); };

// 审: 一轮聊天回复开始：只跟踪发往本代理的真实回复（排除后台/代练/空跑），开计时与看门狗。
// Started on GENERATION_AFTER_COMMANDS: GENERATION_STARTED also fires when
// a slash command in the input box takes over and nothing is generated.
export function genStart(type, _opts, dryRun) {
    const link = connectionInfo();
    if (dryRun || type === 'quiet' || type === 'impersonate' || !link.connected) return;
    genActive = true;
    clearTimeout(doneTimer);
    store.set({ gen: { kind: 'thinking', startedAt: Date.now(), chars: 0, cache: null, seconds: null } });
    // Re-draw once a second so the seconds count up.
    clearInterval(tick);
    tick = setInterval(() => { if (genActive) setGen({}); }, 1000);
    // Safety net: an ending ST didn't announce (an error path) must not leave the bar counting.
    clearInterval(genWatch);
    let idleChecks = 0;
    genWatch = setInterval(() => {
        if (!genActive) { clearInterval(genWatch); return; }
        idleChecks = generating() ? 0 : idleChecks + 1;
        if (idleChecks >= 2 || Date.now() - (gen().startedAt ?? 0) > 30 * 60 * 1000) genStopped();
    }, 5000);
}
// 审: 字数统计：每个中日韩字算一个。
/**
 * Word count the way Word / WPS 字数 does for mixed text: each CJK character (Chinese, Japanese kana,
 * Korean) is one, a run of other letters or digits (an English / Russian word, a number) is one;
 * punctuation, emoji, markdown marks and HTML tags count nothing. Thinking a preset has the model write
 * into the reply (<thinking>…</thinking>, <think>; one still open while streaming) is not the reply.
 */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
// 审: 回复里预设让模型写出的 <thinking>/<think> 思考块（流式未闭合也算），不计入字数。
const THINKING = /<(thinking|think)(?:\s[^<>]*)?>[\s\S]*?(?:<\/\1\s*>|$)/gi;
// 审: 按 Word/WPS 的口径数字数（中日韩单字 + 西文词），去掉标签和思考块；测试引用。
export function countWords(text) {
    const plain = String(text ?? '').replace(THINKING, ' ').replace(/<[^>]*>/g, ' ');
    const cjk = plain.match(CJK)?.length ?? 0;
    const words = plain.replace(CJK, ' ').match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
    return cjk + words;
}
// 审: 上次按 token 更新的时间，用来节流到 200ms 一次。
let tokenAt = 0;
// 审: 流式每个 token 到达时更新「在写 N 字」。
export function genToken(text) {
    // Fires per token with the whole text so far (empty while the model is still thinking).
    if (!genActive || Date.now() - tokenAt < 200) return;
    tokenAt = Date.now();
    const chars = countWords(text);
    if (chars) setGen({ kind: 'writing', chars });
}
// 审: 回复结束：用最终正文算字数和用时，并带上可靠的问题标记，进入「完成」行。
export function genEnd() {
    if (!genActive) return;
    clearInterval(genWatch);
    genActive = false;
    const chat = SillyTavern.getContext().chat ?? [];
    const last = chat[chat.length - 1];
    if (!last || last.is_user || last.is_system) { idle(); return; }
    const chars = countWords(last.mes);
    const startedAt = gen().startedAt;
    // Reliable problems show right in the done line (refusal / empty; "cut off" arrives with the proxy's record).
    const flag = libs.chatCheck?.replyFlags?.(last.mes ?? '', null)[0]?.short;
    genDone({ chars, seconds: startedAt ? Math.round((Date.now() - startedAt) / 1000) : null, ...(flag ? { flag } : {}) });
}
// 审: 用户停止/出错时直接回到闲置，不显示完成行。
export function genStopped() {
    if (!genActive) return;
    clearInterval(genWatch);
    genActive = false;
    idle();
}
// 审: 显示完成行（约 6 秒）；缓存数字稍后由代理的统计补充，补充时再延长；不是我们跟踪的那一轮的统计不处理。
/** The finished line (~6 s). The cache figure arrives a moment later from the proxy and extends it. */
export function genDone(patch) {
    if (genActive) return;
    const wasDone = gen().kind === 'done';
    if (!wasDone && patch.chars == null) return; // stats for a turn we didn't watch
    clearInterval(tick);
    tick = null;
    store.set({ gen: { ...gen(), ...patch, kind: 'done' } });
    clearTimeout(doneTimer);
    doneTimer = setTimeout(idle, wasDone ? 4000 : 6000);
}
