// ──────────────────────────────────────────────
// Reliable checks of the latest reply (refusal / cut off / empty), shared by the panel
// ──────────────────────────────────────────────
//
// Pure functions, no Node or browser APIs — imported by the UI panel
// (index.js) and by the tests. Every check looks at ONE assistant reply.

const stripTags = (s) => s.replace(/<[^>]+>/g, '');

/** The cleaner behind the refusal check: drops extension markup that is not
 *  prose (柏宝绘 <bbi_image> blocks, HTML cards, variable / status blocks, placeholder tags). */
export function cleanReply(mes) {
    return String(mes ?? '')
        .replace(/<bbi_image>[\s\S]*?<\/bbi_image>/g, '')
        .replace(/<htm1fenge>[\s\S]*?<\/htm1fenge>/g, '')
        .replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, '')
        .replace(/<(StatusPlaceHolder\w*)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/<StatusPlaceHolder\w*\b[^>]*\/?>/gi, '')
        .replace(/<\w+(?:\s[^>]*)?\/>/g, '');
}

export function bodyOf(mes) {
    // Image tags another extension writes into the reply (柏宝绘) and HTML
    // cards inside the prose are not prose.
    mes = cleanReply(mes);
    const m = mes.match(/<content>([\s\S]*?)<\/content>/);
    let body = m ? m[1] : mes.replace(/<(div|style|details|branches|status|meow_FM)[\s\S]*/, '');
    body = body.replace(/<!--[\s\S]*?-->/g, '');
    return stripTags(body).trim();
}

// ── Refusal: the model declined this turn (Anthropic usage policy), instead of writing the scene ──
// Conservative on purpose: a short reply whose first sentences open with a first-person refusal. A
// character who says「我拒绝！」in dialogue, or narration that merely mentions 拒绝, is not flagged:
// the phrase must START a sentence outside any quotation (an opening quote breaks the anchor).
const REFUSAL_EN = /(?:I(?:'|’)?m sorry,? (?:but )?(?:I )?(?:can(?:'|’)?t|cannot|won(?:'|’)?t|am unable|(?:'|’)m unable)|Sorry,? (?:but )?I (?:can(?:'|’)?t|cannot|won(?:'|’)?t)|I apologi[sz]e,? but I (?:can(?:'|’)?t|cannot|won(?:'|’)?t)|I (?:need|have|want|must|will have) to (?:decline|stop here|pause here|step out|refuse)|I (?:can(?:'|’)?t|cannot|won(?:'|’)?t|am not able to|am unable to|(?:'|’)m not able to|(?:'|’)m unable to|(?:'|’)m not going to|am not going to) (?:continue|write|help|assist|create|generate|produce|engage|roleplay|role-play|proceed|go on|do that|provide|take this))/i;
const REFUSAL_ZH = /(?:(?:很抱歉|抱歉|对不起|十分抱歉|非常抱歉)[，,、]?\s*(?:但)?我(?:不能|无法|没法|不会|不可以)|我(?:必须|需要|只能|得)(?:要)?(?:拒绝|停下|停在这里|婉拒)|我(?:拒绝|不能|无法|没法|不会|不可以)(?:继续|接着|再)?(?:写|创作|续写|撰写|生成|提供|协助|参与|描写|扮演|进行)?(?:这个|这段|这场|该|本|下去的|此)?(?:故事|剧情|角色扮演|扮演|创作|写作|内容|请求|场景|情节|描写|设定|方向)|我(?:不能|无法|没法)(?:继续|再)(?:写|创作|续写|扮演|这个|这样|这类)|我(?:不能|无法)继续(?=[。.！!，,]?\s*$)|无法继续(?:这个|这段|这场|该|本|此)?(?:故事|剧情|角色扮演|扮演|创作|写作|内容|请求|场景|情节)|(?:这(?:一|个)?(?:段|轮|部分|场|条|次)?(?:内容|剧情)?)?我(?:还是|就|恐怕|暂时)?(?:不写|不会写|不能写|没法写|无法写|写不了|不(?:会|能)?(?:再)?(?:继续|接着)写|没法(?:再)?(?:继续|接着)写|无法(?:再)?(?:继续|接着)写)(?=[。.！!，,：:\s]|$))/;
const REFUSAL_HEAD_CHARS = 300;   // the refusal sits at the head of the reply
const REFUSAL_SHORT_BODY = 700;
const REFUSAL_OFFER = /happy to help|glad to help|instead|alternative|let me know|other directions|would you like|another direction|可以帮你|愿意帮|换个方向|换一个方向|其他方向|另外的方向|你可以告诉我|可以继续的方向|可以从下面|你选哪|告诉我就行/i;
const REFUSAL_MAX_BODY = 1500;    // refusal + a list of alternative suggestions; a long scene that mentions one is far longer

/** One-line excerpt of the refusal, or null when the reply does not look like one. */
export function detectRefusal(mes) {
    const body = bodyOf(String(mes ?? ''));
    if (!body || body.length > REFUSAL_MAX_BODY) return null;
    // Past a short reply the refusal must come with its usual follow-up (an offer of alternatives), or it is just a scene that starts that way.
    if (body.length > REFUSAL_SHORT_BODY && !REFUSAL_OFFER.test(body)) return null;
    const head = body.slice(0, REFUSAL_HEAD_CHARS);
    // Sentence starts: the very beginning, after a line break, after 。！？.!?
    const starts = [0];
    for (const m of head.matchAll(/[\n。！？!?.]+\s*/g)) starts.push(m.index + m[0].length);
    for (const at of starts) {
        // Leading markdown (bold / blockquote marks) is not dialogue.
        const rest = body.slice(at).replace(/^[\s*_>#-]+/, '');
        const m = REFUSAL_EN.exec(rest) ?? REFUSAL_ZH.exec(rest);
        if (m && m.index === 0) {
            const line = rest.split('\n')[0];
            return line.length > 60 ? `${line.slice(0, 60)}…` : line;
        }
    }
    return null;
}

/**
 * The proxy's definitive signal (stop_reason "refusal", recorded as notice 'refusal' / finish
 * 'content_filter'): a reply that is nearly empty was a refusal of the whole turn; one with real text
 * was cut off part-way. Returns { title, text } or null when the request carries no refusal.
 */
export function refusalNotice(last) {
    if (!last || !(last.notices?.includes('refusal') || last.finish === 'content_filter')) return null;
    if ((last.textChars ?? 0) < 300) {
        return { declined: true, title: '被拒绝了', text: REFUSAL_HINT };
    }
    return { declined: false, title: '被拦一半', text: '结尾缺了，重新生成试试' };
}

export const REFUSAL_HINT = '多半是卡里内容触发了政策';

/**
 * The reliable checks of the latest reply (always on, no switch): the model refused, the reply was cut
 * off at the length limit, or it is empty. `mes` is the reply text, `last` the proxy's record of that
 * request (stats.lastRequest; background calls are ignored). One entry per problem, in this order:
 * { code: 'refusal' | 'length' | 'empty', text: one line for 状态, short: the words for the done line }.
 */
export function replyFlags(mes, last = null) {
    const out = [];
    const req = last && !last.auxiliary ? last : null;
    const notice = refusalNotice(req);
    if (notice) {
        out.push({ code: 'refusal', text: notice.declined ? '被拒绝了' : '被拦一半，结尾缺了', short: notice.declined ? '被拒绝了' : '被拦一半' });
    } else if (mes != null) {
        const excerpt = detectRefusal(mes);
        if (excerpt) out.push({ code: 'refusal', text: `被拒绝了：「${excerpt}」`, short: '被拒绝了' });
    }
    if (req?.finish === 'length') out.push({ code: 'length', text: '写满了：调大「最大回复长度」', short: '写满了' });
    if (mes != null && String(mes).trim() === '') out.push({ code: 'empty', text: '空回复', short: '空回复' });
    return out;
}

/**
 * The replies the checks look at: the newest AI reply and the one before it. The greeting (floor 0,
 * the card's first_mes) is not a reply and is never checked; player and system messages are skipped.
 * Null when the chat has no reply yet.
 */
export function latestReplies(chat) {
    const ai = (chat ?? []).filter((m, i) => i > 0 && m && !m.is_user && !m.is_system);
    if (!ai.length) return null;
    return { last: ai[ai.length - 1], prev: ai.length > 1 ? ai[ai.length - 2] : null };
}
