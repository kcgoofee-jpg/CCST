// ──────────────────────────────────────────────
// Per-request settings extraction
// ──────────────────────────────────────────────
//
// The companion UI extension injects a `claude_subscription` object into the
// request body via SillyTavern's `custom_include_body` channel — the only
// per-request path that survives ST's backend unconditionally (its native
// reasoning_effort field is dropped for non-OpenAI model IDs at
// src/endpoints/backends/chat-completions.js:2507-2513, and its "Maximum"
// dropdown value is downgraded to "high" client-side before that).
//
// Direct API users (curl, other frontends) can send the same object, or the
// standard OpenAI `reasoning_effort` field, or nothing at all.

// 审: 环境变量开关：默认开，只有 0/false/off/no 才算关（与 chat.js 的 envFlag 类似但语义不同，跨分区未合并）。
const envOn = (name) => !/^(0|false|off|no)$/i.test(process.env[name] ?? '');

// 审: SDK 认的推理强度词表（仅本文件使用）。
const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// 审: 思考模式的合法取值。
const VALID_THINKING = ['off', 'adaptive', 'on'];

// 审: 非法强度一律当作未指定，避免整个请求报错。
/** Gate effort to the SDK's closed vocabulary; anything else → undefined
 *  (model default) instead of erroring the whole request. Case-sensitive on
 *  purpose — the SDK wants lowercase. */
function normalizeEffort(value) {
    return VALID_EFFORTS.includes(value) ? value : undefined;
}

// 审: chat_key / reply_slot 共用的格式校验（8-40 位十六进制），不合格当作没有。
const hexId = (v) => (typeof v === 'string' && /^[0-9a-f]{8,40}$/.test(v) ? v : null);
// 审: 取正数并向下取整，否则 undefined（thinking_budget / max_tokens 共用）。
const posInt = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);
// 审: 字符串截断，非字符串给 null。
const short = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
// 审: 取字符串数组：去空、去首尾空白、限长度和个数。
const strList = (v, max, len) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().slice(0, len)).slice(0, max) : []);

// 审: 面板发来的酒馆配置指纹，只保留已知字段并限长，仅用于诊断和缓存变化提示。
/** The panel's per-request fingerprint, kept to known fields of bounded size. */
function stFingerprint(fp) {
    if (!fp || typeof fp !== 'object' || Array.isArray(fp)) return null;
    return {
        preset: short(fp.preset, 80),
        pp: short(fp.pp, 24),
        order: short(fp.order, 16),
        wi: Array.isArray(fp.wi) ? fp.wi.filter((s) => typeof s === 'string').map((s) => s.slice(0, 40)).slice(0, 80) : [],
        mut: Array.isArray(fp.mut) ? fp.mut.filter((s) => typeof s === 'string').map((s) => s.slice(0, 40)).slice(0, 12) : [],
        // Depth regexes as [name, minDepth] (cache-diag.js depthRegexAt).
        ...(Array.isArray(fp.rx) && fp.rx.length ? { rx: fp.rx.filter((r) => Array.isArray(r) && typeof r[0] === 'string' && Number.isFinite(r[1])).map((r) => [r[0].slice(0, 40), Math.floor(r[1])]).slice(0, 12) } : {}),
        // SillyTavern too old to report triggered world info: wi is always empty, not "unchanged".
        ...(fp.wiOff === true ? { wiOff: true } : {}),
    };
}

// 审: 把请求体里的 claude_subscription（和标准 OpenAI 字段）整理成代理内部设置；chat.js 每次请求先调它。
/**
 * @param {object} body OpenAI chat completions request body
 * @returns {{
 *   effort: string|undefined,
 *   thinking: 'off'|'adaptive'|'on',
 *   thinkingBudget: number|undefined,
 *   showReasoning: boolean,
 *   useResume: boolean,
 *   systemPlacement: 'inline'|'hoist',
 *   auxiliary: boolean,
 *   maxTokens: number|undefined,
 *   stops: string[],
 * }}
 */
export function extractSettings(body) {
    // 审: 请求是否带了面板设置；没带就按辅助请求处理（见下）。
    const fromPanel = !!(body.claude_subscription && typeof body.claude_subscription === 'object');
    const ns = fromPanel ? body.claude_subscription : {};
    // 审: 酒馆的后台调用（quiet）面板会标成 purpose: quiet，同样算辅助请求。
    // No panel settings and no effort field: an auxiliary caller (a preset
    // helper's "API" mode such as 嘤嘤札记, another extension's summary call)
    // rather than the main chat. Those want a quick answer — thinking first
    // just adds seconds — so they default to thinking OFF. Adaptive-only
    // models still think (they cannot turn it off).
    // CLAUDE_SUBSCRIPTION_AUX_THINKING=adaptive restores the old default.
    // SillyTavern marks background calls (generateRaw / quiet prompts: image-tag
    // writers like 柏宝绘, summaries, other extensions) as type 'quiet'; the panel
    // forwards that as purpose: quiet. They are auxiliary too.
    const purpose = ns.purpose === 'quiet' ? 'quiet' : 'chat';
    const auxiliary = purpose === 'quiet' || (!fromPanel && body.reasoning_effort === undefined && body.reasoning?.effort === undefined);

    // 审: 推理强度优先取面板的，其次 OpenAI 标准字段，都没有就用模型默认。
    const effort = normalizeEffort(ns.effort)
        ?? normalizeEffort(body.reasoning_effort)
        ?? normalizeEffort(body.reasoning?.effort);

    // 审: 辅助请求的思考默认值，环境变量 CLAUDE_SUBSCRIPTION_AUX_THINKING 可改（已写进使用指南）。
    // Default adaptive: the model decides when to think (and adaptive-only
    // families always think regardless).
    const auxDefault = VALID_THINKING.includes(process.env.CLAUDE_SUBSCRIPTION_AUX_THINKING) ? process.env.CLAUDE_SUBSCRIPTION_AUX_THINKING : 'off';
    const thinking = VALID_THINKING.includes(ns.thinking) ? ns.thinking : (auxiliary ? auxDefault : 'adaptive');

    // 审: thinking_budget 只有直接调 API 的人会带，chat.js 还在用，保留。
    const thinkingBudget = posInt(ns.thinking_budget);

    // 审: 输出上限，先看 max_tokens 再看 max_completion_tokens。
    const maxTokens = posInt(body.max_tokens) ?? posInt(body.max_completion_tokens);

    // 审: 停止词整理成字符串数组，StopScanner 在代理侧自己截断。
    let stops = [];
    if (Array.isArray(body.stop)) stops = body.stop.filter((s) => typeof s === 'string' && s.length > 0);
    else if (typeof body.stop === 'string' && body.stop.length > 0) stops = [body.stop];
    // Anthropic caps stop sequences at 4 upstream; we enforce client-side
    // anyway, but keep the list sane.
    stops = stops.slice(0, 16);

    return {
        // 审: 下面每个字段都由 chat.js / diag / 缓存逻辑读取，已逐个核对过有使用者。
        effort,
        thinking,
        thinkingBudget,
        showReasoning: ns.show_reasoning !== false, // default ON — ST renders reasoning_content natively
        // 审: 环境变量总开关，关了走旧的折叠文本路径。
        // The cache switches below are fixed on since 6.1 (no panel switch); the environment
        // variables turn them off when chasing a problem.
        useResume: envOn('CLAUDE_SUBSCRIPTION_USE_RESUME'),  // synthetic-session resume (fold fallback when off/failed)
        // 审: 深度注入保持原位（inline）还是提到系统提示（hoist），环境变量开关（使用指南已写）。
        // Depth-injected system messages stay in place as user turns (like
        // SillyTavern's own Claude converter).
        systemPlacement: envOn('CLAUDE_SUBSCRIPTION_INLINE_SYSTEM') ? 'inline' : 'hoist',
        // 审: 是否走抓包转发（wire-tap.js），环境变量可关。
        // Diagnostics: send the CLI through the wire capture (features/wire-tap.js).
        diagCapture: envOn('CLAUDE_SUBSCRIPTION_DIAG_CAPTURE'),
        // 审: 当前聊天的哈希，用量记录按它归档。
        // Hash of the open chat: the usage log files each request under it (per-chat last turn).
        chatKey: hexId(ns.chat_key),
        // 审: 回复存档用的编号（reply-keeper.js）。
        // Slot the finished reply is kept under (features/reply-keeper.js): a hash of chat + player message.
        replySlot: hexId(ns.reply_slot),
        // 审: 只构建不调用 Claude，测试和开发用（面板不发，仅直连/测试）。
        // Dev only: build everything (placement, lore, transcript), keep it for /v1/debug/last, never call Claude.
        dryRun: ns.dry_run === true,
        // 审: 关键词世界书移到本轮消息（lore-tail.js）；面板没发时看环境变量。
        // Keyword-triggered world info moves from the system prompt to the
        // current message so the history stays cached (lore-tail.js; README).
        loreTail: ns.lore_tail !== undefined ? ns.lore_tail !== false : envOn('CLAUDE_SUBSCRIPTION_LORE_TAIL'),
        // 审: 发言后的深度 0 注入并进发言，环境变量开关（使用指南已写）。
        // A card's depth-0 injections after the player's message are folded into it.
        foldTail: envOn('CLAUDE_SUBSCRIPTION_FOLD_TAIL'),
        // 审: 酒馆注入聊天中的提示的开头文本，用来识别「本该跟随本轮」的注入（system-placement.js）。
        // Opening text of each prompt SillyTavern injects INTO the chat this
        // request (depth world info, the preset's in-chat entries, Author's
        // Note — panel inject.js). Early in a chat ST puts them above every
        // message, where they would pass for part of the system prompt.
        lateSnippets: Array.isArray(ns.late)
            ? ns.late.filter((s) => typeof s === 'string' && s.trim().length >= 8).map((s) => s.trim()).slice(0, 64)
            : [],
        // 审: 酒馆配置指纹，只给诊断报告和缓存变化提示用。
        // What SillyTavern had set up for this request (preset, post-processing,
        // entry order / toggles, triggered world info): only for the diagnostic report.
        stFingerprint: stFingerprint(ns.st_fp),
        // 审: 聊天记录首尾消息的开头文本，用来划定历史范围（applyHistoryBounds）。
        // Opening text of the first / last chat messages (panel inject.js historyMarks): where the
        // chat history starts and ends inside the prompt (system-placement.js applyHistoryBounds).
        hist: {
            start: strList(ns.hist?.start, 3, 80),
            end: strList(ns.hist?.end, 2, 80),
            // A short last message (「继续」), whole: matched as the whole message.
            exact: strList(ns.hist?.exact, 1, 80),
        },
        // 审: 缓存时长，面板选 5m 才是 5m，否则 1 小时；传给子进程环境变量。
        // Cache lifetime the panel picked (env.js); 1 hour unless it asks for 5 minutes.
        cacheTtl: ns.cache_ttl === '5m' ? '5m' : '1h',
        // 审: 酒馆的生成类型（continue 等），影响续写的预填处理。
        genType: typeof ns.gen_type === 'string' ? ns.gen_type.slice(0, 20) : null,
        // 审: 触发的关键词世界书条目原文，供 cutExactLore 精确移走。
        // Text of the keyword-triggered entries inside the system prompt (lore-tail.js cutExactLore).
        loreText: strList(ns.lore_text, 120, 20_000),
        // 审: 酒馆世界书外框模板，条目全移走后一并去掉外框。
        // SillyTavern's world-info wrapper (「[Details …:\n{0}]」): removed too when every entry in it moved.
        wiFormat: typeof ns.wi_format === 'string' ? ns.wi_format.slice(0, 400) : '',
        // 审: 是否辅助请求（不存档回复、不做缓存诊断、用量单独统计）。
        auxiliary,
        // 审: 记入用量日志的用途标签：quiet / aux / chat。
        purpose: fromPanel ? purpose : (auxiliary ? 'aux' : 'chat'),
        // 审: 见上，输出上限。
        maxTokens,
        // 审: 见上，停止词。
        stops,
    };
}
