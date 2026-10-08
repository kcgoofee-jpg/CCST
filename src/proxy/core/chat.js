// ──────────────────────────────────────────────
// /v1/chat/completions handler — v2 orchestrator
// ──────────────────────────────────────────────
//
// Accepts an OpenAI Chat Completions request, runs it through the local
// Claude Agent SDK, and emits OpenAI-format SSE chunks when stream=true (or a
// single JSON response otherwise, OpenAI's default).
//
// v2 pipeline per request:
//   1. Parse model ([1m] variants → tier alias + env pin), settings
//      (effort / thinking / stops / max_tokens from the request body, with
//      the companion UI extension's `claude_subscription` namespace).
//   2. System messages → SDK systemPrompt (plain client string by default —
//      the roleplay path: the coding preamble is replaced).
//   3. Prior turns → synthetic Claude Code JSONL session, replayed through a
//      one-shot SessionStore + `resume` so the model sees REAL multi-turn
//      context (role fidelity + prompt caching). Trailing-assistant prefill
//      becomes a continuation instruction. Falls back to the v1 transcript
//      fold on any resume-path failure.
//   4. Query with the roleplay isolation recipe: tools:[], skills:[],
//      settingSources:[], bypassPermissions + explicit opt-in, no MCP.
//   5. Stream translation: text deltas → delta.content (with server-side
//      stop-sequence enforcement — the SDK has none), thinking deltas →
//      delta.reasoning_content (SillyTavern renders these natively).
//   6. Resilience ladder (from Meridian, retries only before first output):
//      expired token → out-of-band OAuth refresh + one retry;
//      [1m] Extra-Usage failure → strip to base model + 1h cooldown + retry;
//      rate limit → up to 2 retries with 1s/2s backoff.
//   7. Privacy sweep: best-effort delete of the live-turn transcript the CLI
//      wrote under ~/.claude/projects (roleplay text shouldn't persist).

import { randomUUID } from 'node:crypto';

import { loadSdk } from './sdk-loader.js';
import { renderTranscript } from './transcript.js';
import { extractSettings } from '../features/settings.js';
import { parseModelRequest, effortForModel, isExtendedContextKnownUnavailable, recordExtendedContextUnavailable } from './models.js';
import { buildSubprocessEnv } from './env.js';
import { tapBaseUrl, tapSkipReason } from '../features/wire-tap.js';
import { buildSystemPrompt, extractSystemText } from './system-prompt.js';
import { assembleEntries, buildAssistantEntry, splitHistoryForResume, currentToSdkUserMessage, singleMessageStream, NO_RESPONSE_FILLER } from '../features/jsonl-entries.js';
import { SDK_VERSION } from '../features/sdk-version.js';
import { ResumeSessionStore, resumeScratchCwd, sweepSessionTranscript } from '../features/session-store.js';
import { createTurnCollector, historyReplay, repliesBefore, replyBefore, sentTextFor, noteReplayHealth, rewriteCaptured } from '../features/turn-capture.js';
import { StopScanner } from './stops.js';
import { makeCompletionId, writeSse, chunkShell, roleChunk, contentChunk, reasoningChunk, finishChunk, errorEvent, toOpenAiUsage } from './sse.js';
import { isExpiredTokenError, isRateLimitError, isExtraUsageRequiredError, isStaleSessionError, refreshOAuthToken } from '../features/oauth.js';
import { explainError, formatErrorForUser } from '../features/errors-zh.js';
import { recordRequest, promptShape } from '../features/usage-stats.js';
import { applyHistoryBounds, inlineLateSystemMessages } from '../features/system-placement.js';
import { diagnoseCache, describeDiag, discardDiag } from '../features/cache-diag.js';
import { foldTrailingInjections, injectBlocks, injectedTextFor, loreTarget, newLoreOnly, noteTail, tailsOfOldPreset, rememberInjected, rewriteInjected, cutExactLore, TRIGGERED_TAG, LORE_WINDOW } from '../features/lore-tail.js';
import { noteLastRequest, noteLastEntries } from '../features/last-request.js';
import { keepReply, trackGeneration } from '../features/reply-keeper.js';

// 审: 日志前缀。
const PLUGIN_TAG = '[claude-subscription]';

// 审: 上一次提示「诊断抓包不启用」的原因，同一原因只提示一次。
let tapSkipWarned = null;
// 审: 抓包被跳过时按原因去重打印一次，免得每轮刷屏。
/** Say once per reason (not every turn) that diagnostics capture is skipped. */
function warnTapSkippedOnce(reason) {
    if (tapSkipWarned === reason) return;
    tapSkipWarned = reason;
    console.warn(`${PLUGIN_TAG} 诊断抓包不启用：${reason}。聊天照常直连。`);
}
// 审: 限流时最多重试次数（退避 1s / 2s）。
const MAX_RATE_LIMIT_RETRIES = 2;
// 审: 非自适应模型开思考所需的最小 max_tokens，低于它 API 会 400。
// Below this max_tokens, the CLI's derived thinking budget violates the
// API's >= 1024 floor on non-adaptive models (verified live).
const MIN_MAX_TOKENS_FOR_THINKING = 2048;
// 审: 非流式请求的绝对超时（中途没有心跳，只能整体计时）。
// Absolute deadline for non-streaming queries (no heartbeat exists between
// init and the finished assistant message, so idle-based detection is
// impossible; this only reaps a truly hung subprocess).
const NONSTREAM_DEADLINE_MS = 10 * 60 * 1000;
// 审: 流式时上游多久没有真消息就中止（下游心跳会掩盖子进程挂死）。
// No real upstream message for this long → abort (downstream keep-alives can
// mask a hung subprocess forever otherwise). Meridian uses the same figure.
const UPSTREAM_IDLE_MS = 90000;

// CLAUDE_SUBSCRIPTION_MAX_TURNS: a whole number from 1 to this (default 1).
// 审: MAX_TURNS 环境变量的上限。
const MAX_TURNS_LIMIT = 20;

// 审: 解析 MAX_TURNS 环境变量成 1~20 的整数（默认 1）；buildSdkOptions 用，测试直接用。
export function maxTurnsFrom(value) {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_TURNS_LIMIT) : 1;
}

// 审: 读布尔环境变量（空 = 默认值，0/false/no/off = 关）；resume / 固定上下文 / 逐轮还原 / 原样提示词开关共用。
const envFlag = (name, fallback) => {
    const v = process.env[name];
    if (v === undefined || v === '') return fallback;
    return !/^(0|false|no|off)$/i.test(v);
};

// 审: 组装 SDK query 选项：模型、系统提示词、隔离配方（无工具 / 无设置）、思考与强度、cwd 与 resume；每次尝试都调用。
function buildSdkOptions({ modelInfo, oneMActive, settings, systemText, abortController, stream, env, resume }) {
    const options = {
        abortController,
        model: oneMActive ? modelInfo.sdkModel : modelInfo.baseId,
        systemPrompt: buildSystemPrompt(systemText),
        includePartialMessages: stream,
        env,

        // Roleplay isolation recipe — SillyTavern owns the conversation
        // surface; nothing from the host machine may leak into the context:
        tools: [],                    // no built-in agent tools (0.2.x enforces this)
        skills: [],                   // no skills
        settingSources: [],           // no ~/.claude settings, CLAUDE.md, hooks, output styles
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true, // required with bypassPermissions on 0.2.x

        // maxTurns: 1 is safe with tools:[] (no tool round-trips) and is what
        // Marinara ships in production on this SDK line. Overridable because
        // v1 removed it over thinking-steps-consume-turns (their PR #294).
        maxTurns: maxTurnsFrom(process.env.CLAUDE_SUBSCRIPTION_MAX_TURNS),

        // Deliver the chat text as written: no `@path` file expansion (a
        // roleplay line containing "@notes.txt" would otherwise pull a local
        // file into the prompt), no slash-command dispatch, and none of the
        // CLI's turn-start reminders, which the model kept noticing and
        // "skipping as irrelevant" in its thinking. CLI ≥ 2.1.248.
        // 审(存疑): VERBATIM 环境变量只写在使用指南里，默认开；关掉会让 @路径展开等恢复，属于行为开关，没动。
        verbatimPrompts: envFlag('CLAUDE_SUBSCRIPTION_VERBATIM', true),
    };

    // 审: 用户指定 claude 可执行文件路径（optional 依赖没装上时的出路），使用指南有写。
    if (process.env.CLAUDE_SUBSCRIPTION_CLAUDE_PATH) {
        options.pathToClaudeCodeExecutable = process.env.CLAUDE_SUBSCRIPTION_CLAUDE_PATH;
    }

    // Thinking / effort. ALWAYS set thinking explicitly — omitting it lets
    // the CLI auto-enable thinking with a budget derived from
    // CLAUDE_CODE_MAX_OUTPUT_TOKENS, which 400s below ~2048 max tokens
    // ("thinking.enabled.budget_tokens: Input should be >= 1024", verified
    // live). Rules:
    //   • Adaptive-only families (Opus 5.5, Sonnet 5.5, Fable) natively adapt; no
    //     budget field is ever sent — safe at any max_tokens. Always adaptive.
    //   • Other models translate adaptive/enabled into a budgeted request;
    //     with max_tokens set below MIN_MAX_TOKENS_FOR_THINKING the budget
    //     is illegal, so thinking is forced off (raise SillyTavern's "Max
    //     response length" to re-enable).
    // `display` controls whether thinking CONTENT is emitted at all: without
    // it the CLI streams only a signature and delivers an EMPTY thinking
    // block (verified live on 0.2.141) — 'summarized' streams real
    // thinking_delta events; 'omitted' saves the bandwidth when the user
    // hides reasoning.
    // 审: 下面按模型能力决定 thinking 选项；display 决定要不要真的收到思考内容。
    const display = settings.showReasoning ? 'summarized' : 'omitted';
    if (modelInfo.adaptiveOnly) {
        options.thinking = { type: 'adaptive', display };
    } else if (modelInfo.noBudget) {
        // Sonnet 5: budget_tokens 400s, so "on" becomes adaptive; no budget
        // is ever sent, so the max_tokens floor doesn't apply.
        options.thinking = settings.thinking === 'off'
            ? { type: 'disabled' }
            : { type: 'adaptive', display };
    } else {
        // 审(存疑): 'on' 和 thinkingBudget 分支面板已不发（始终思考已移除），只有直接调 API 的请求体 claude_subscription.thinking='on' / thinking_budget 才到；settings.js 与 test/settings.test.js 仍解析 'on'，要删需一起动，没动。
        const wantsThinking = settings.thinking === 'adaptive' || settings.thinking === 'on';
        const roomForThinking = !settings.maxTokens || settings.maxTokens >= MIN_MAX_TOKENS_FOR_THINKING;
        if (wantsThinking && roomForThinking) {
            if (settings.thinking === 'on') {
                const budget = settings.thinkingBudget
                    ? Math.max(1024, Math.min(settings.thinkingBudget, (settings.maxTokens ?? Infinity) - 512))
                    : undefined;
                options.thinking = budget
                    ? { type: 'enabled', budgetTokens: budget, display }
                    : { type: 'enabled', display };
            } else {
                options.thinking = { type: 'adaptive', display };
            }
        } else {
            if (wantsThinking && !roomForThinking) {
                console.log(`${PLUGIN_TAG} thinking disabled: max_tokens ${settings.maxTokens} < ${MIN_MAX_TOKENS_FOR_THINKING} (raise Max response length in SillyTavern to enable thinking on ${modelInfo.baseId})`);
            }
            options.thinking = { type: 'disabled' };
        }
    }
    // 审: 推理强度按模型能力降级；没选强度又要「不思考」的总在思考模型，退到最低强度。
    // 「不思考」 on a model that always thinks: the lowest depth is the closest it gets.
    const effort = effortForModel(modelInfo.baseId, settings.effort ?? (settings.thinking === 'off' && modelInfo.adaptiveOnly ? 'low' : undefined));
    if (effort) {
        options.effort = effort;
    }

    // 审: 子进程固定在暂存目录运行，泄漏的会话记录落在插件自己的项目目录。
    // Always run the subprocess in the scratch bucket so any live-turn
    // transcript that escapes the best-effort sweep lands in the plugin's
    // own project dir instead of intermingling with the user's real
    // `claude` sessions for SillyTavern's working directory.
    try {
        options.cwd = resume ? resume.cwd : resumeScratchCwd();
    } catch { /* unwritable scratch dir — fall back to process cwd */ }

    // 审: 走逐轮还原路径时把合成会话和会话存储交给 SDK。
    if (resume) {
        options.resume = resume.sessionId;
        options.sessionStore = resume.store;
    }

    return options;
}

// 审: 取玩家本轮自己的消息（放置合并注入之前的原文），用来给本轮记录定 key；没有则 null。
/** The player's own message of this turn, before any placement merged
 *  injections into it (the first of the trailing user messages). */
function plainPlayerText(rawMessages) {
    const hist = (rawMessages ?? []).filter((m) => m?.role !== 'system');
    const i = loreTarget(hist);
    return i >= 0 && typeof hist[i]?.content === 'string' ? hist[i].content : null;
}

// 审: 连续走了「折叠回退」的请求数；resume 一轮就清零。
// How many requests in a row had to fall back to the transcript fold (#30): one is
// normal (a chat's first turn), a long run means the resume path stopped working.
let foldRounds = 0;
// 审: 读折叠回退连续次数，/status 的 foldStreak 给面板提示用。
export function foldStreak() {
    return foldRounds;
}

// 审: 每个请求结束时登记走了哪条路径，更新连续回退计数。
/** Called once per finished request with the path it took. */
export function noteFoldOutcome(path, settings) {
    if (path === 'resume') foldRounds = 0;
    else if (settings?.useResume && envFlag('CLAUDE_SUBSCRIPTION_USE_RESUME', true)) foldRounds += 1;
    return foldRounds;
}

// 审: 测试接缝：清零回退计数。
/** Test seam. */
export function __resetFoldStreakForTesting() {
    foldRounds = 0;
}

/**
 * Build the query configuration. Tries the resume path; falls back to the
 * v1 transcript fold when disabled or when scratch-dir setup fails.
 */
// 审: 决定本次请求走哪条路（resume 合成会话 / 仅图片的流式输入 / 折叠回退）并给出 prompt + 选项；sdk 参数从未被用到，已删。
function buildQueryConfig({ messages: rawMessages, modelInfo, oneMActive, settings, abortController, stream, env }) {
    // 审: 内联放置时把深度注入的 system 消息放回对话里（和 completeChat 里的同一函数，这里是给最终提示词用的版本）。
    const messages = settings.systemPlacement === 'inline' ? inlineLateSystemMessages(rawMessages, { late: settings.lateSnippets }) : rawMessages;
    const systemText = extractSystemText(messages);

    // 审: 主路径：把历史合成成 Claude Code 会话文件再 resume，模型才看到真实多轮并能命中缓存；关掉 / 失败才走折叠回退。
    if (settings.useResume && envFlag('CLAUDE_SUBSCRIPTION_USE_RESUME', true)) {
        try {
            const cwd = resumeScratchCwd();
            const sessionId = randomUUID();
            const split = splitHistoryForResume(messages);
            const meta = {
                sessionId,
                cwd,
                version: SDK_VERSION,
                gitBranch: '',
                permissionMode: 'bypassPermissions',
            };
            // CLI context pinned after the first entry (see turn-capture.js): keyed by the
            // model as served, since the context names it.
            // 审(存疑): CONTEXT_PIN 环境变量没有任何文档，只是出问题时关掉固定上下文的排查开关，删掉等于去掉排查手段，没动。
            const pinKey = envFlag('CLAUDE_SUBSCRIPTION_CONTEXT_PIN', true) ? `${modelInfo.baseId}${oneMActive ? '[1m]' : ''}` : null;
            // 审: 取之前各轮「当时实际发出」的原文（逐轮还原）和固定的 CLI 上下文，让重发历史与上次一字不差。
            const { replay, pinned } = historyReplay(pinKey, { replay: envFlag('CLAUDE_SUBSCRIPTION_TURN_REPLAY', true) });
            // 审: 末尾是助手消息（预填 / 续写）的形状。
            const prefill = split.shape === 'trailing-assistant-continue';
            const entries = assembleEntries(split.history, meta, modelInfo.baseId, { replay, pinned, trimLast: prefill });
            // A prefill turn sends [player message, placeholder reply, continuation instruction]; the
            // CLI adds the placeholder itself when the transcript ends on a user entry. Next turn
            // SillyTavern sends just the player message and the reply, and without these three the
            // history changed right there: every turn of a prefill preset (果实) re-wrote the whole
            // history (measured 2026-10-08: read = system prompt only). Write the placeholder here and
            // keep all three as this turn, under the player's text. Not for SillyTavern's 「继续」: the
            // player's message was a turn of its own and the reply keeps the continued text.
            let lead = null;
            const lastUserEntry = entries.findLastIndex((e) => e?.type === 'user');
            if (prefill && lastUserEntry >= 0 && entries.slice(lastUserEntry + 1).every((e) => e?.type === 'attachment')) {
                entries.push(buildAssistantEntry({ message: { role: 'assistant', content: NO_RESPONSE_FILLER }, parentUuid: entries.at(-1).uuid, meta, model: modelInfo.baseId }));
                if (settings.genType !== 'continue' && lastUserEntry > 0) lead = entries.slice(lastUserEntry);
            }
            // 审: 有历史才走 resume（空列表 SDK 会拒绝）。
            // Empty entry lists make the SDK reject the resume with "No
            // conversation found" — first turns can't resume.
            if (entries.length > 0) {
                const prompt = singleMessageStream(currentToSdkUserMessage(split.current));
                const currentText = typeof split.current?.content === 'string' ? split.current.content : null;
                // Filed under its text and the reply it answers; background
                // calls record nothing (no capture, no pin).
                // A trailing-assistant prefill sends the synthetic continuation
                // instruction, not the player's message: filed alone under
                // settings.captureKey it would replay the INSTRUCTION in place of
                // the player's text (#28). Kept behind the player's message and
                // the placeholder (lead) it is the whole turn, filed under the
                // player's text; without a lead it goes under its own text — a
                // key no future history message has.
                const playerText = typeof split.history.at(-1)?.content === 'string' ? split.history.at(-1).content : null;
                const keyText = !prefill ? settings.captureKey : lead ? settings.captureKey ?? playerText : null;
                const collector = settings.auxiliary
                    ? null
                    : createTurnCollector(currentText, keyText, pinKey, replyBefore(split.history, split.history.length), lead);
                const resume = { sessionId, store: new ResumeSessionStore(sessionId, entries, collector?.onAppend), cwd };
                if (settings.dryRun) noteLastEntries(entries);
                const options = buildSdkOptions({ modelInfo, oneMActive, settings, systemText, abortController, stream, env, resume });
                return { prompt, options, path: 'resume', sessionId, shape: split.shape, collector, currentText, hasHistory: split.history.length > 0 };
            }
            // 审: 第一轮就带图片：字符串折叠会丢图，改用不带 resume 的流式输入。
            // No replayable history, but a string fold would drop image
            // blocks — use streaming-input mode without resume so images
            // survive turn one.
            const hasImages = Array.isArray(split.current?.content)
                && split.current.content.some((p) => p?.type === 'image_url');
            if (hasImages) {
                const prompt = singleMessageStream(currentToSdkUserMessage(split.current));
                const options = buildSdkOptions({ modelInfo, oneMActive, settings, systemText, abortController, stream, env, resume: null });
                return { prompt, options, path: 'stream-input', sessionId: null, shape: split.shape };
            }
        // 审: 合成会话任何一步失败都退回折叠，保证能出回复。
        } catch (err) {
            console.warn(`${PLUGIN_TAG} resume path unavailable, folding transcript:`, err instanceof Error ? err.message : err);
        }
    }

    // Fold fallback: renderTranscript folds the non-system turns into a
    // labelled string prompt (the system text is already in systemText).
    const prompt = renderTranscript(messages);
    const options = buildSdkOptions({ modelInfo, oneMActive, settings, systemText, abortController, stream, env, resume: null });
    return { prompt, options, path: 'fold', sessionId: null, shape: 'fold' };
}

/** Served-model guard: refuse to silently substitute another model for an
 *  explicit Fable request. If Anthropic gates/disables Fable (it has been
 *  toggled off before), the CLI can resolve the request to its default Opus
 *  instead — a silent style/capability switch mid-roleplay is exactly what
 *  the user must NOT get. Checked against the resolved model on the init
 *  message (before any output) and each main-thread assistant message. */
// 审: 服务端把「明确要 Fable 却被换成别的模型」当错误拒绝（静默换模型会毁掉角色扮演）；init 消息和每条助手消息都查；测试 errors-stats.test.js 直接用。
export function assertServedModel(guardTier, servedModel, requestedModel) {
    if (guardTier !== 'fable') return;
    const served = String(servedModel ?? '').toLowerCase();
    // '<synthetic>' is the CLI's own error/notice message (auth failure,
    // API error, limit hit) — not a substitution. Let the error path report
    // the real cause instead of masking it as a guard violation.
    if (!served || served === '<synthetic>') return;
    if (!served.includes('fable') && !served.includes('mythos')) {
        const err = new Error(
            `Model substitution refused: you requested ${requestedModel} but the upstream resolved to ` +
            `${servedModel}. Fable may be temporarily unavailable on your plan — pick another model ` +
            'explicitly instead of being silently switched. (served-model guard)',
        );
        err.sdkErrorText = 'served-model-guard';
        err.noRetry = true;
        throw err;
    }
}

// 审: 跑一次 SDK query 并把消息归一成简单事件（文本 / 思考 / 用量 / 完成 / 拒答），含空闲超时和已服务模型检查。
/**
 * Run one SDK query attempt, normalizing SDK messages into simple events:
 *   { kind: 'text', text }        visible output delta (stream only)
 *   { kind: 'reasoning', text }   thinking delta (stream only)
 *   { kind: 'blocks', blocks }    full assistant content (non-stream)
 *   { kind: 'done', usage, stopReason }  success terminator
 *   { kind: 'refusal', fallback, category }  the model stopped with stop_reason "refusal"
 * Throws Error with .sdkErrorText on failure (classified by the caller).
 */
async function* runQuery({ sdk, prompt, options, stream, guardTier, requestedModel, timing = {} }) {
    // 审: 空闲 / 绝对超时的计时器句柄，finally 里清掉。
    let idleTimer = null;
    const abort = options.abortController;
    // Idle guard: with includePartialMessages (stream) the SDK emits a
    // steady message flow, so per-message re-arming detects a hung upstream.
    // With stream=false NOTHING arrives between init and the finished
    // assistant message — a healthy long generation (xhigh + long RP reply)
    // easily exceeds 90s — so non-stream gets one long absolute deadline
    // instead. Idle aborts are tagged on the controller so the caller can
    // distinguish them from client-close / stop-sequence aborts.
    const idleMs = stream ? UPSTREAM_IDLE_MS : NONSTREAM_DEADLINE_MS;
    // 审: 超时触发：打日志、在控制器上标 idleAbort（让调用方区分于客户端断开），然后中止。
    const fireIdleAbort = () => {
        console.warn(`${PLUGIN_TAG} upstream ${stream ? 'idle' : 'deadline exceeded'} after ${idleMs}ms — aborting query`);
        abort.idleAbort = true;
        abort.abort();
    };
    // 审: 流式时每收到一条消息重置空闲计时；非流式只用一开始的绝对期限。
    const armIdleGuard = () => {
        if (!stream) return; // absolute deadline armed once below
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(fireIdleAbort, idleMs);
        idleTimer.unref?.();
    };

    idleTimer = setTimeout(fireIdleAbort, idleMs);
    idleTimer.unref?.();
    try {
        timing.queryAt ??= Date.now();
        const handle = sdk.query({ prompt, options });
        for await (const message of handle) {
            armIdleGuard();

            // A safety stop mid-reply: the text so far is kept but the reply
            // is cut off. With a fallback configured the CLI retries the
            // turn on another model — the reply then comes from that model.
            // 审: 安全拒答事件（可能带回退模型）转成 refusal 事件，由调用方提示面板。
            if (message.type === 'system' && (message.subtype === 'model_refusal_no_fallback' || message.subtype === 'model_refusal_fallback')) {
                yield { kind: 'refusal', fallback: message.subtype === 'model_refusal_fallback' ? message.fallback_model ?? '?' : null, category: message.api_refusal_category ?? null };
                continue;
            }
            if (message.type === 'system' && message.subtype === 'init') {
                timing.initAt ??= Date.now();
                // Resolved model is known BEFORE any generation — the guard
                // fires here so a substituted request dies with zero output.
                assertServedModel(guardTier, message.model, requestedModel);
                // 审: 把 CLI 自己的会话 id 交出去，折叠 / 流式输入路径的隐私清理要用。
                if (message.session_id) {
                    // The CLI-minted session id — needed to privacy-sweep the
                    // live-turn transcript on the fold/stream-input paths
                    // where no pre-minted resume sessionId exists.
                    yield { kind: 'session', id: message.session_id };
                }
            } else if (message.type === 'stream_event') {
                const event = message.event;
                // 审: 记录首字耗时分段（面板「首字去哪了」），只记一次。
                if (event?.type === 'message_start') timing.messageStartAt ??= Date.now();
                if (event?.type === 'content_block_delta') timing.firstDeltaAt ??= Date.now();
                // parent_tool_use_id != null would be subagent traffic; with
                // tools:[] there are no subagents, but filter defensively.
                if (message.parent_tool_use_id) continue;
                // 审: 流式中的实时用量，调用方在没收到 result 时兜底。
                // Running usage: kept by the caller in case the attempt ends
                // before the result message (stop sequence, abort).
                if (event?.type === 'message_start' && event.message?.usage) {
                    yield { kind: 'usage', usage: event.message.usage };
                } else if (event?.type === 'message_delta' && event.usage) {
                    yield { kind: 'usage', usage: event.usage };
                }
                // 审: 正文 / 思考增量转成事件。
                if (event?.type === 'content_block_delta' && event.delta) {
                    if (event.delta.type === 'text_delta' && event.delta.text) {
                        yield { kind: 'text', text: event.delta.text };
                    } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
                        yield { kind: 'reasoning', text: event.delta.thinking };
                    }
                }
            } else if (message.type === 'assistant') {
                // Belt-and-suspenders served-model check on the actual reply
                // (main thread only — parent_tool_use_id filters bookkeeping
                // side-channels like the SDK's Haiku title generator).
                if (!message.parent_tool_use_id) {
                    assertServedModel(guardTier, message.message?.model, requestedModel);
                }
                // 审: 助手消息自带 error：撞最大长度当正常结束，其余抛出让重试阶梯分类。
                // Assistant-level errors (auth failures, API 4xx) surface here
                // with the useful text in the content blocks, not in the enum —
                // extract both so the retry ladder can classify them.
                if (message.error) {
                    if (isOutputLimitText(message.message?.content)) {
                        // Reply hit max_tokens: the CLI reports it as an error,
                        // but the text so far already streamed — end it like
                        // the real API does (finish_reason "length").
                        yield { kind: 'done', usage: null, stopReason: 'max_tokens' };
                        return;
                    }
                    const blocks = message.message?.content ?? [];
                    const text = blocks
                        .filter((b) => b.type === 'text' && b.text)
                        .map((b) => b.text)
                        .join(' ');
                    const err = new Error(text || `assistant error: ${message.error}`);
                    err.sdkErrorText = `${message.error} ${text}`;
                    throw err;
                }
                // 审: 非流式拿整条助手内容；流式只补发整块思考（摘要思考不走 thinking_delta）。
                if (!stream) {
                    yield { kind: 'blocks', blocks: message.message?.content ?? [] };
                } else {
                    // Streamed thinking arrives as a COMPLETE block on the
                    // assistant message, not as thinking_delta events — the
                    // CLI's summarized-thinking display only streams a
                    // signature_delta (verified live on 0.2.141 + Fable).
                    // The thinking-block assistant message lands before the
                    // text deltas start, so emitting here still renders ahead
                    // of the reply in SillyTavern.
                    for (const block of message.message?.content ?? []) {
                        if (block.type === 'thinking' && block.thinking) {
                            yield { kind: 'reasoning-block', text: block.thinking };
                        }
                    }
                }
            // 审: 结果消息：success 即完成；撞输出上限当正常结束；其余抛错。
            } else if (message.type === 'result') {
                if (message.subtype === 'success') {
                    yield { kind: 'done', usage: message.usage ?? null, stopReason: message.stop_reason ?? null };
                    return;
                }
                const detail = (message.errors ?? []).join('; ');
                if (OUTPUT_LIMIT_RE.test(`${detail} ${message.result ?? ''}`)) {
                    yield { kind: 'done', usage: message.usage ?? null, stopReason: 'max_tokens' };
                    return;
                }
                const err = new Error(`Claude (Subscription) request failed (${message.subtype})${detail ? ' — ' + detail : ''}`);
                err.sdkErrorText = `${message.subtype} ${detail}`;
                throw err;
            }
            // Everything else (system/init, status, ...)
            // is bookkeeping; prompt_suggestion can arrive after result but
            // we return at result.
        }
        // 审: SDK 流结束但没有 result 消息时按完成处理（用量由调用方用实时用量兜底）。
        // Generator ended without a result message.
        yield { kind: 'done', usage: null };
    } finally {
        if (idleTimer) clearTimeout(idleTimer);
    }
}

// The CLI raises this as an error when a reply (thinking included) runs past max_tokens.
// 审: CLI 报「超过输出 token 上限」的错误文本匹配；runQuery 两处和 isOutputLimitText 用。
const OUTPUT_LIMIT_RE = /exceeded the \d+ output token maximum/i;
// 审: 助手内容是不是「超过输出上限」错误。
function isOutputLimitText(content) {
    const text = Array.isArray(content) ? content.map((b) => b?.text ?? '').join(' ') : String(content ?? '');
    return OUTPUT_LIMIT_RE.test(text);
}

// Upstream failures the client can act on get their own status code (a
// retrying client backs off on 429; 401 says "log in again"); the rest are 500.
// 审: 错误类别 → HTTP 状态码表。
const ERROR_STATUS = { usage_limit: 429, not_logged_in: 401 };

// 审: 上游错误文本 → HTTP 状态码（限额 429 / 未登录 401 / 其余 500），让客户端按状态处理；测试用。
export function statusForError(raw) {
    return ERROR_STATUS[explainError(raw).code] ?? 500;
}

/**
 * Watch one request's client and the panel's Stop button.
 *
 * Disconnects are seen on `res` 'close': by the time the handler runs,
 * express has read the body and `req` has ended, so a `req` 'close'
 * listener added then never fires on Node 24 (verified). Registered before
 * the handler's first await, so a client that leaves early is seen too.
 *
 * With a reply slot (`keep`) the reply is finished and kept when the client
 * goes away (closed, killed, backgrounded): it is paid for, and the panel
 * puts it back when the chat is opened again (features/reply-keeper.js). Without
 * one the CLI is stopped. POST …/replies/<slot>/cancel (the panel's Stop)
 * always stops it, and nothing is kept.
 */
// 审: 监听客户端断开和面板的停止键，决定中止还是继续写完暂存；handleChatCompletions 每请求一个。
export function watchClient(res, { keep, slot }) {
    // 审: 连接状态：keep 要暂存 / gone 客户端已走 / aborted 已中止 / cancelled 面板停止 / controller 当前尝试的中止器。
    const conn = { keep, gone: false, aborted: false, cancelled: false, controller: null };
    // 审: 响应关闭时：封住写入，有暂存槽就让回复继续写，否则中止 CLI。
    const onClose = () => {
        if (res.writableFinished || conn.gone) return;
        conn.gone = true;
        // Nothing can reach the client any more; the rest of the handler runs as usual.
        res.write = () => true;
        res.end = () => res;
        if (conn.keep && !conn.cancelled) {
            console.log(`${PLUGIN_TAG} 对方断开了连接，这条回复继续写完并暂存，重新打开聊天时自动补回`);
            return;
        }
        conn.aborted = true;
        conn.controller?.abort();
    };
    res.on('close', onClose);
    // 审: 登记到面板停止键的回调表，按停止就中止且不暂存。
    const untrack = slot ? trackGeneration(slot, () => {
        if (conn.cancelled) return;
        conn.cancelled = true;
        conn.aborted = true;
        console.log(`${PLUGIN_TAG} 面板按了停止：这条回复中止，不再暂存`);
        conn.controller?.abort();
    }) : () => {};
    // 审: 请求结束时撤销监听和登记。
    conn.dispose = () => {
        res.off('close', onClose);
        untrack();
    };
    return conn;
}

// 审: POST /v1/chat/completions 入口：校验请求、建客户端监听，再交给 completeChat。
export async function handleChatCompletions(req, res) {
    const body = req.body || {};
    let messages = body.messages;

    if (!Array.isArray(messages) || messages.length === 0 || !body.model
        || messages.some((m) => !m || typeof m !== 'object' || Array.isArray(m))) {
        return res.status(400).json({
            error: { message: '请求格式不对：需要 messages（非空的消息列表）和 model。', type: 'invalid_request_error' },
        });
    }

    const settings = extractSettings(body);
    const conn = watchClient(res, { keep: !!settings.replySlot && !settings.auxiliary, slot: settings.replySlot });
    try {
        return await completeChat(req, res, body, settings, conn);
    } finally {
        conn.dispose();
    }
}

// 审: 一次聊天请求的完整流程：缓存诊断与放置改写、重试阶梯、流式 / 非流式输出、统计与暂存。
async function completeChat(req, res, body, settings, conn) {
    // 审: 本函数里 messages 会被放置 / 世界书改写后重新赋值，所以用 let。
    let messages = body.messages;
    const requestedModel = body.model;
    // OpenAI's default is a single JSON response; SillyTavern always says which it wants.
    const wantStream = body.stream === true;
    // The proxy only runs on the subscription (API-key users use SillyTavern's own Claude source).
    // 审: 计费来源常量，只用作统计里的 backend 字段（recordRequest 需要）；API-key 路径已移除。
    const billedAs = 'subscription';
    const modelInfo = parseModelRequest(requestedModel);

    let sdk;
    try {
        sdk = await loadSdk();
    } catch (err) {
        return res.status(500).json({
            error: { message: err instanceof Error ? err.message : String(err), type: 'sdk_unavailable' },
        });
    }

    // 审: 开始时间与请求形状，进统计。
    const startedAt = Date.now();
    const shape = promptShape(messages);
    // 审: 缓存诊断结果；出错 / 世界书移动都要读，诊断失败时保持 null。
    let cacheDiag = null;
    // Background calls (another extension's tag writer, a summary) are not
    // turns of the conversation: they leave the per-chat state alone — cache
    // memory, lore-tail learning and the
    // turn captures / context pin (buildQueryConfig). They may still READ
    // captured turns, which only helps their prompt match the chat's cache.
    // Preset entries before / after the chat history (system-placement.js applyHistoryBounds).
    // 审: 预设里「聊天记录前 / 后」的条目归位。
    if (settings.systemPlacement === 'inline') messages = applyHistoryBounds(messages, settings.hist, settings.genType);
    // 审: 缓存诊断 + 放置改写 + 世界书移动整段（背景调用不碰逐聊天的状态），任何一步失败只记警告、按原样发。
    if (!settings.auxiliary) try {
        // Earlier player messages as they were sent (turn captures): an injection
        // already given verbatim there is not repeated (system-placement.js).
        const rawHist = messages.filter((m) => m?.role !== 'system');
        const rawReplies = repliesBefore(rawHist);
        const lastRawUser = rawHist.findLastIndex((m) => m?.role === 'user');
        const earlierSent = rawHist.slice(0, Math.max(0, lastRawUser))
            .map((m, i) => (m?.role === 'user' && typeof m.content === 'string' ? sentTextFor(m.content, rawReplies[i]) ?? '' : ''))
            .join('\n');
        // 审: 深度注入里和之前某轮一字不差的段落改成一句说明（seen 判重，repeats 计数）。
        let repeats = 0;
        const seen = (t) => t.length >= 200 && earlierSent.includes(t);
        const placed = settings.systemPlacement === 'inline'
            ? inlineLateSystemMessages(messages, { late: settings.lateSnippets, seen, onRepeat: () => { repeats++; } })
            : messages;
        if (repeats) console.log(`${PLUGIN_TAG} ${repeats} 段深度注入和之前某轮给过的一字不差，本轮改为一句说明`);
        const history = placed.filter((m) => m?.role !== 'system');
        // Keyword-triggered world info inside the system prompt, by its exact text (lore-tail.js).
        // 审: 精确切出系统提示词里被触发的世界书文本（用于移到发言开头）。
        const exact = settings.loreTail && settings.loreText.length ? cutExactLore(extractSystemText(placed) ?? '', settings.loreText, settings.wiFormat) : null;
        cacheDiag = diagnoseCache(exact ? exact.system : extractSystemText(placed), history, { chatKey: settings.chatKey });
        console.log(`${PLUGIN_TAG} ${describeDiag(cacheDiag)}`);
        // Post-history entries changed (one switched off, edited): earlier
        // turns go out again as sent, so swap their old copy for the new one
        // (lore-tail.js noteTail). Not on a reroll: nothing was changed then.
        // 审: 预设改过则把之前轮次里旧预设放在聊天记录后面的条目换掉，免得历史前缀变动。
        const preset = settings.stFingerprint?.preset || null;
        const oldTails = cacheDiag?.systemChanged && !cacheDiag.reroll ? tailsOfOldPreset(cacheDiag.chat ?? null, preset) : null;
        if (oldTails) {
            const from = oldTails.map((t) => `\n\n${t}`);
            const n = rewriteCaptured(from, '') + rewriteInjected(from, '');
            if (n) console.log(`${PLUGIN_TAG} 换了预设：之前 ${n} 轮里旧预设放在聊天记录后面的条目一起去掉`);
        }
        // 审: 预设放在聊天记录后面的 system 条目变了（开关 / 编辑）时，把之前轮次的旧版本一并换成新的。
        const lastUserAt = messages.findLastIndex((m) => m?.role === 'user');
        const trailing = lastUserAt >= 0 ? messages.slice(lastUserAt + 1) : null;
        if (settings.systemPlacement === 'inline' && trailing && trailing.every((m) => m?.role === 'system' && typeof m.content === 'string')) {
            const tail = trailing.map((m) => m.content).filter(Boolean).join('\n\n');
            const change = noteTail(cacheDiag?.chat ?? null, tail, { order: settings.stFingerprint?.order ?? null, reroll: !!cacheDiag?.reroll, preset });
            if (change) {
                const from = change.from.map((t) => `\n\n${t}`);
                const to = change.to ? `\n\n${change.to}` : '';
                const n = rewriteCaptured(from, to) + rewriteInjected(from, to);
                if (n && cacheDiag) cacheDiag.tailRewritten = n;
                if (n) console.log(`${PLUGIN_TAG} 预设放在聊天记录后面的条目变了（开关或编辑）：之前 ${n} 轮里的旧版本一起换成新的，这一轮聊天记录重写一次`);
            }
        }
        // 审: 最终要发给模型的消息；下面世界书 / 折叠改写时会替换。
        let sent = placed;
        // Inline placement merges this turn's injections into the player's
        // message; next turn ST sends it back as the player wrote it.
        const plain = settings.systemPlacement === 'inline' ? plainPlayerText(messages) : null;
        // The turn is filed under the player's text as ST will send it back
        // next turn — also when nothing is moved: inline placement alone
        // merges the preset's post-history entries into this message, and
        // filed under that merged text the turn was never found again
        // (history re-written every turn; measured 2026-10-07, 衡 + 军训14天).
        if (typeof plain === 'string') settings.captureKey = plain;
        // 审: 世界书移动 + 角色卡深度 0 注入折叠（lore-tail.js），保持历史前缀不变以命中缓存。
        if (settings.loreTail || settings.foldTail) {
            const system = exact ? exact.system : extractSystemText(placed) ?? '';
            const blocks = exact?.text ? [{ tag: TRIGGERED_TAG, text: exact.text }] : [];
            const rawTarget = loreTarget(history);
            const rawLast = history.findLastIndex((m) => m?.role === 'user');
            // Each user message is remembered by its text and the reply it
            // answers (turn-capture.js), never by its text alone.
            const replies = repliesBefore(history);
            // Earlier player messages that carried lore go out again as they
            // were sent (turn captures replay the current-turn ones).
            // 审: 之前带过世界书的玩家消息按当时发出的原样还原。
            const restored = history.map((m, i) => {
                if (i === rawTarget || m?.role !== 'user' || typeof m.content !== 'string' || sentTextFor(m.content, replies[i])) return m;
                const was = injectedTextFor(m.content, replies[i]);
                return was ? { ...m, content: was } : m;
            });
            // 审: 目标消息之前各轮玩家消息当时发出的文本，用来判重。
            const earlierOf = (list, upTo) => {
                const ctx = repliesBefore(list);
                return list.slice(0, Math.max(0, upTo))
                    .map((m, i) => (m?.role === 'user' && typeof m.content === 'string' ? sentTextFor(m.content, ctx[i]) ?? m.content : null))
                    .filter((t) => t !== null);
            };
            const fold = settings.foldTail ? foldTrailingInjections(restored, earlierOf(restored, rawTarget)) : { history: restored, folded: 0, repeated: 0 };
            const target = loreTarget(fold.history);
            const lastUser = fold.history.findLastIndex((m) => m?.role === 'user');
            const fresh = blocks.length ? newLoreOnly(blocks, earlierOf(fold.history, target)) : [];
            const withLore = injectBlocks(fold.history, fresh);
            // 审: 有任何改写才重建消息，并记下「酒馆下一轮会怎么发回来」好原样重发。
            if (repeats || blocks.length || fold.folded || restored.some((m, i) => m !== history[i])) {
                sent = [{ role: 'system', content: system }, ...withLore];
                messages = sent;
                // Next turn these messages come back as ST has them (no lore,
                // injections separate): file them under that text so they
                // are sent again exactly as they went out.
                if (target >= 0 && target !== lastUser) rememberInjected(plain ?? history[rawTarget].content, withLore[target].content, replies[rawTarget]);
                const key = plain ?? history[fold.folded ? rawTarget : rawLast]?.content;
                if (typeof key === 'string') settings.captureKey = key;
            }
            if (fold.folded) {
                console.log(`${PLUGIN_TAG} 你发言后面的 ${fold.folded} 条注入（角色卡深度 0 条目）接在发言末尾一起发${fold.repeated ? `，其中 ${fold.repeated} 段与之前一字不差，改为一句说明` : ''}`);
            }
            if (blocks.length) {
                cacheDiag.loreMoved = blocks.map((b) => b.tag);
                const n = (list) => list.reduce((k, b) => k + b.text.length, 0).toLocaleString();
                console.log(`${PLUGIN_TAG} 本轮触发的世界书移出系统提示词（${n(blocks)} 字），放在发言开头 ${n(fresh)} 字（最近 ${LORE_WINDOW} 轮给过的不再重复）`);
            }
        }
        // 审: 记下发给模型的内容，供面板「查看发给模型的内容」重放（外层已保证非背景调用）。
        // Earlier turns go out as they were sent (turn captures): show those, not ST's copy.
        const ctx = repliesBefore(sent);
        const asSent = sent.map((m, i) => (m?.role === 'user' && typeof m.content === 'string' ? { ...m, content: sentTextFor(m.content, ctx[i]) ?? m.content } : m));
        noteLastRequest({ model: requestedModel, placed: asSent, cacheDiag });
    } catch (err) {
        console.warn(`${PLUGIN_TAG} cache diagnostics failed:`, err instanceof Error ? err.message : err);
    }
    // 审: 首个内容出现的时间，进统计。
    let firstTokenAt = null;
    // Where the time to first token goes (M-opt #4): proxy + CLI start-up,
    // CLI → API until the response starts, then the first content delta.
    const timing = {};
    // 审: 最后一次尝试走的路径（resume / stream-input / fold），统计和回退计数用。
    let lastPath = null;
    // The collector of the resume turn we just ran, for the replay health check (#26).
    let replayWatch = null;
    // 审: 本次响应的 id / 时间 / chunk 外壳。
    const completionId = makeCompletionId();
    const created = Math.floor(Date.now() / 1000);
    const shell = chunkShell(completionId, created, modelInfo.requested);

    // 审: 下面这组是跨重试共享的输出状态：是否已出过内容 / SSE 是否已开始 / 用量 / 结束原因 / 拒答 / 已收集文本与思考 / 待清理的会话 id。
    // Stream state shared across retry attempts.
    let didYieldContent = false;
    let sseStarted = false;
    let usage = null;
    // Usage from the stream's message_start / message_delta events, for when
    // the attempt ends without a result message (stop sequence, abort).
    let partialUsage = null;
    let finishReason = 'stop';
    let refusal = null;
    let collectedText = '';
    let collectedReasoning = '';
    const sweepIds = [];

    // 审: 第一次真有输出时才发 SSE 头和角色 chunk（之前出错还能回正常状态码）。
    const startSse = () => {
        firstTokenAt ??= Date.now();
        if (sseStarted) return;
        sseStarted = true;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        writeSse(res, roleChunk(shell));
    };

    // Fresh AbortController per attempt — an aborted controller (idle guard,
    // failed attempt) must never poison the retry. A client that left
    // without a reply slot, or the panel's Stop, aborts whichever attempt is
    // current (conn.controller, see watchClient).

    // Retry ladder state.
    // 审: 本次是否真用 1M（冷却中或失败后降为基础模型）。
    let oneMActive = modelInfo.oneM && !isExtendedContextKnownUnavailable();
    // Diagnostics (panel → 状态 → 诊断): route the CLI through the in-process wire
    // capture.
    // Never with a non-http proxy in the environment (socks5:// …): the forwarder would bypass it.
    // 审: 诊断抓包（面板开了才有）：能起则把 CLI 指到本地抓包地址，起不来 / 有不兼容代理就跳过、聊天照常。
    const tapSkip = settings.diagCapture ? tapSkipReason() : null;
    if (tapSkip) warnTapSkippedOnce(tapSkip);
    const tapUrl = settings.diagCapture && !tapSkip
        ? await tapBaseUrl().catch((err) => { console.warn(`${PLUGIN_TAG} 诊断抓包没能启动，本轮不记录：${err.message}`); return null; })
        : null;
    // 审: 重试阶梯状态：登录过期只刷新一次、限流次数。
    let didTokenRefresh = false;
    let rateLimitRetries = 0;

    // 审: 尝试循环：一次尝试 = 新建中止器 + 子进程环境 + 查询配置 + 消费事件流；失败按阶梯决定重试，成功 break。
    try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            if (conn.aborted) break;
            const abortController = new AbortController();
            conn.controller = abortController;
            partialUsage = null;
            const env = buildSubprocessEnv({ envPins: modelInfo.envPins, maxTokens: settings.maxTokens, cacheTtl: settings.cacheTtl });
            if (tapUrl) env.ANTHROPIC_BASE_URL = tapUrl;
            const cfg = buildQueryConfig({
                messages, modelInfo, oneMActive, settings,
                abortController, stream: wantStream, env,
            });
            if (cfg.sessionId) sweepIds.push(cfg.sessionId);
            lastPath = cfg.path;
            replayWatch = cfg.path === 'resume' && cfg.hasHistory ? cfg.collector : null;
            // 审: 开发用 dry_run：不真调 Claude，只把会发出去的内容留给 /v1/debug/last（缓存模拟测试用）。
            if (settings.dryRun) {
                // Cache simulation (tests, scripts/cache-matrix.mjs): what would go out is in /v1/debug/last.
                // Stand in for the CLI's own user entry so next turn replays this message as sent
                // (with a uuid: the replayed entry is what the next entry chains to).
                if (cfg.collector && cfg.currentText !== null) {
                    cfg.collector.onAppend([{ type: 'user', uuid: randomUUID(), message: { role: 'user', content: cfg.currentText } }, { type: 'assistant', uuid: randomUUID() }]);
                }
                return res.json({ object: 'claude_max.dry_run', path: cfg.path, cacheDiag: cacheDiag ?? null, captureKeyChars: settings.captureKey?.length ?? null });
            }

            try {
                let stopMatched = false;
                let sawReasoningDeltas = false;
                // Per-attempt scanner — a shared one would leak held-back
                // text from a failed attempt into the retry's output.
                const scanner = new StopScanner(settings.stops);
                // 审: 事件分发：会话 id / 用量 / 正文（过停止序列）/ 思考 / 整块思考 / 非流式整块 / 拒答 / 完成。

                for await (const ev of runQuery({
                    sdk, prompt: cfg.prompt, options: cfg.options, stream: wantStream,
                    guardTier: modelInfo.tier, requestedModel: modelInfo.requested, timing,
                })) {
                    if (ev.kind === 'session') {
                        // CLI-minted session id (fold / stream-input paths)
                        // so the privacy sweep covers their transcripts too.
                        if (!sweepIds.includes(ev.id)) sweepIds.push(ev.id);
                    } else if (ev.kind === 'usage') {
                        partialUsage ??= {};
                        for (const [k, v] of Object.entries(ev.usage)) if (typeof v === 'number') partialUsage[k] = v;
                        // 5m / 1h split of the cache write (usage-stats cacheTtl)
                        if (ev.usage.cache_creation && typeof ev.usage.cache_creation === 'object') partialUsage.cache_creation = ev.usage.cache_creation;
                    } else if (ev.kind === 'text') {
                        const { emit, matched } = scanner.feed(ev.text);
                        if (emit) {
                            didYieldContent = true;
                            if (wantStream) {
                                startSse();
                                writeSse(res, contentChunk(shell, emit));
                            }
                            collectedText += emit;
                        }
                        if (matched) {
                            stopMatched = true;
                            finishReason = 'stop';
                            abortController.abort();
                            break;
                        }
                    } else if (ev.kind === 'reasoning') {
                        if (!settings.showReasoning) continue;
                        didYieldContent = true;
                        sawReasoningDeltas = true;
                        if (wantStream) {
                            startSse();
                            writeSse(res, reasoningChunk(shell, ev.text));
                        }
                        collectedReasoning += ev.text;
                    } else if (ev.kind === 'reasoning-block') {
                        // Complete thinking block from the assistant message.
                        // Skip if raw deltas already streamed it (older CLIs).
                        if (!settings.showReasoning || sawReasoningDeltas) continue;
                        didYieldContent = true;
                        if (wantStream) {
                            startSse();
                            writeSse(res, reasoningChunk(shell, ev.text));
                        }
                        collectedReasoning += ev.text;
                    } else if (ev.kind === 'blocks') {
                        for (const block of ev.blocks) {
                            if (block.type === 'text' && block.text) {
                                const { emit, matched } = scanner.feed(block.text);
                                if (emit) collectedText += emit;
                                if (matched) { stopMatched = true; break; }
                            } else if (block.type === 'thinking' && block.thinking && settings.showReasoning) {
                                collectedReasoning += block.thinking;
                            }
                        }
                        if (collectedText || collectedReasoning) {
                            didYieldContent = true;
                            firstTokenAt ??= Date.now();
                        }
                    } else if (ev.kind === 'refusal') {
                        refusal = { fallback: ev.fallback, category: ev.category };
                    } else if (ev.kind === 'done') {
                        usage = ev.usage;
                        if (ev.stopReason === 'refusal') refusal ??= { fallback: null, category: null };
                        if (ev.stopReason === 'max_tokens') finishReason = 'length';
                    }
                }

                // 审: 没命中停止序列时放出扣住的尾部。
                if (!stopMatched) {
                    const tail = scanner.flush();
                    if (tail) {
                        didYieldContent = true;
                        if (wantStream) {
                            startSse();
                            writeSse(res, contentChunk(shell, tail));
                        }
                        collectedText += tail;
                    }
                }
                // 审: 撞上长度上限且没有任何正文（思考吃光）→ 报可操作的错误，不当成空回复。
                if (finishReason === 'length' && !collectedText) {
                    // Thinking used the whole budget (or nothing came out): no text to keep.
                    const err = new Error(`回复超过了『最大回复长度』${settings.maxTokens ? `（${settings.maxTokens} token）` : ''}被截断，没有产出可用的文字（思考也计入长度）。到酒馆『AI 回复配置』把最大回复长度调大。`);
                    err.sdkErrorText = err.message;
                    throw err;
                }
                break; // success
            } catch (err) {
                // 审: 失败分类：不可重试 / 用户中止当正常结束 / 没出内容时按阶梯重试（1M 额外用量、登录过期、限流、会话失效），否则抛出。
                const errText = err?.sdkErrorText ?? (err instanceof Error ? err.message : String(err));

                // Guard violations (served-model) are terminal by design —
                // never retried into a different model.
                if (err?.noRetry) throw err;

                // Client went away / Stop / stop-sequence abort → not an error.
                // Idle-guard aborts are excluded: a hang after partial output
                // must surface as an error, not a clean finish.
                if (abortController.signal.aborted && didYieldContent && !abortController.idleAbort) break;
                if (conn.aborted) break;

                // Never retry into a stream that already has content.
                if (!didYieldContent) {
                    if (oneMActive && isExtraUsageRequiredError(errText)) {
                        console.warn(`${PLUGIN_TAG} 1M context unavailable (Extra Usage) — retrying on base model, cooldown 1h`);
                        recordExtendedContextUnavailable();
                        oneMActive = false;
                        continue;
                    }
                    if (isExpiredTokenError(errText) && !didTokenRefresh) {
                        didTokenRefresh = true;
                        console.warn(`${PLUGIN_TAG} auth expired — attempting OAuth refresh + one retry`);
                        await refreshOAuthToken();
                        // Keychain logins are refreshed by the CLI itself, and
                        // the failed attempt usually already did it: a fresh
                        // subprocess picks up the new token. Retry once either
                        // way (measured: 401 "access token has expired" twice,
                        // then the next request went through untouched).
                        await new Promise((r) => setTimeout(r, 500));
                        continue;
                    }
                    if (isRateLimitError(errText) && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
                        rateLimitRetries += 1;
                        if (oneMActive) {
                            // 1M quota is a separate bucket — drop to base, no cooldown.
                            oneMActive = false;
                        }
                        const delay = 1000 * rateLimitRetries;
                        console.warn(`${PLUGIN_TAG} rate limited — retry ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES} in ${delay}ms`);
                        await new Promise((r) => setTimeout(r, delay));
                        continue;
                    }
                    if (isStaleSessionError(errText) && cfg.path === 'resume') {
                        console.warn(`${PLUGIN_TAG} stale resume session — retrying via transcript fold`);
                        settings.useResume = false;
                        continue;
                    }
                }
                throw err;
            }
        }
    } catch (err) {
        // 审: 终局失败：登记回退计数、丢弃诊断、记统计，再按流是否已开始用 SSE 错误事件或 JSON 错误回复。
        const raw = err instanceof Error ? err.message : String(err);
        const described = err?.sdkErrorText === 'served-model-guard' ? `served-model guard: ${raw}` : raw;
        noteFoldOutcome(lastPath, settings);
        // Nothing was cached: the resend is compared with the last request that went through.
        discardDiag(cacheDiag);
        recordRequest({
            backend: billedAs, model: modelInfo.requested, effort: settings.effort ?? null, placement: settings.systemPlacement, auxiliary: settings.auxiliary, purpose: settings.purpose, chatKey: settings.chatKey, timing, path: lastPath, stream: wantStream, startedAt, firstTokenAt, shape, cacheDiag, st: settings.stFingerprint,
            usage: usage ?? partialUsage, textChars: collectedText.length,
            error: described,
        });
        const message = formatErrorForUser(described);
        if (wantStream && sseStarted) {
            writeSse(res, errorEvent(message));
            res.write('data: [DONE]\n\n');
            return res.end();
        }
        return res.status(statusForError(described)).json({ error: { message, type: 'server_error' } });
    } finally {
        // 审: 隐私清理：无论成败都删掉本次 CLI 写下的会话记录。
        for (const id of sweepIds) sweepSessionTranscript(loadSdk, id);
    }

    // Ended without a result message (stop sequence, client gone, Stop):
    // the tokens were still spent — count what the stream reported.
    // 审: 没有 result 消息时用流里的实时用量兜底。
    usage ??= partialUsage;
    noteFoldOutcome(lastPath, settings);

    // What the panel should tell the user about this turn (it shows a toast).
    const notices = [];
    if (modelInfo.oneM && !oneMActive) notices.push('no-1m');
    if (refusal) notices.push(refusal.fallback ? `fallback:${refusal.fallback}` : 'refusal');
    // 审: 回复中途的状态通知，面板据此弹提示。
    if (conn.cancelled) notices.push('cancelled');
    else if (conn.gone && conn.keep) notices.push('kept');
    if (replayWatch && noteReplayHealth(replayWatch.captured)) notices.push('replay-reset');
    if (refusal) {
        finishReason = 'content_filter';
        console.warn(`${PLUGIN_TAG} ⚠ 回复被 Claude 的安全机制中途截断（stop_reason: refusal${refusal.category ? `，类别 ${refusal.category}` : ''}）${refusal.fallback ? `，CLI 已改用 ${refusal.fallback} 重试，这条回复来自该模型` : '，保留了截断前的文字'}`);
    }

    recordRequest({
        backend: billedAs, model: modelInfo.requested, effort: settings.effort ?? null, placement: settings.systemPlacement, auxiliary: settings.auxiliary, purpose: settings.purpose, chatKey: settings.chatKey, timing, path: lastPath, stream: wantStream, startedAt, firstTokenAt, shape, cacheDiag, st: settings.stFingerprint,
        usage, textChars: collectedText.length,
        finish: finishReason, clientClosed: conn.aborted, notices,
    });

    // 审: 客户端已走但回复写完了：暂存起来，重新打开聊天时补回。
    if (conn.keep && !conn.cancelled && collectedText) {
        keepReply(settings.replySlot, { text: collectedText, reasoning: collectedReasoning, finish: finishReason });
    }

    // 审: 收尾：按流式 / 非流式输出最终响应。
    const openAiUsage = toOpenAiUsage(usage);

    if (wantStream) {
        startSse(); // ensure headers even for instant empty results
        writeSse(res, finishChunk(shell, finishReason, openAiUsage));
        res.write('data: [DONE]\n\n');
        return res.end();
    }

    const message = { role: 'assistant', content: collectedText };
    if (collectedReasoning) message.reasoning_content = collectedReasoning;
    const response = {
        id: completionId,
        object: 'chat.completion',
        created,
        model: modelInfo.requested,
        choices: [{ index: 0, message, finish_reason: finishReason }],
    };
    if (openAiUsage) response.usage = openAiUsage;
    return res.json(response);
}

// 审: POST /v1/embeddings 固定回 501，让酒馆给出清楚的提示而不是 404。
// Embeddings are not supported on the subscription path.
export function rejectEmbeddings(_req, res) {
    return res.status(501).json({
        error: {
            message: 'CCST 代理不支持向量嵌入（embeddings）。请在酒馆里另外设置向量来源（OpenAI、Google 或本地模型）。',
            type: 'not_supported',
        },
    });
}
