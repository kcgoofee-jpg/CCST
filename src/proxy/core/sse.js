// ──────────────────────────────────────────────
// OpenAI chat-completions wire helpers (SSE + JSON)
// ──────────────────────────────────────────────
//
// Thinking deltas are emitted as `delta.reasoning_content` — the DeepSeek
// convention SillyTavern parses natively for Custom sources (its streaming
// reader takes choices[0].delta.reasoning_content into the collapsible
// reasoning block, gated by the user's "Show model thoughts" setting). The
// non-streaming shape mirrors it via message.reasoning_content.

// 审: 生成 OpenAI 格式的 completion id（流式每个 chunk 和非流式响应都带）。
export function makeCompletionId() {
    return 'chatcmpl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// 审: 写一条 SSE 数据行。
export function writeSse(res, payload) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// 审: 每个 chunk 共用的外壳（id / created / model），后面各 chunk 在它上面加 choices。
export function chunkShell(id, created, model) {
    return { id, object: 'chat.completion.chunk', created, model };
}

// 审: 流的第一个 chunk，声明 assistant 角色。
export function roleChunk(shell) {
    return { ...shell, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] };
}

// 审: 正文增量 chunk。
export function contentChunk(shell, text) {
    return { ...shell, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] };
}

// 审: 思考增量 chunk（delta.reasoning_content，酒馆原生显示成思考块）。
export function reasoningChunk(shell, text) {
    return { ...shell, choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }] };
}

// 审: 流的最后一个 chunk，带 finish_reason 和用量。
export function finishChunk(shell, finishReason, usage) {
    const chunk = { ...shell, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] };
    if (usage) chunk.usage = usage;
    return chunk;
}

// 审: 流已经开始后出错时发给酒馆的错误事件（此时不能再改状态码）。
export function errorEvent(message) {
    return { error: { message, type: 'server_error' } };
}

// 审: SDK 用量 → OpenAI usage，酒馆和面板靠它显示缓存读 / 写。
/** Map SDK result usage → OpenAI usage, keeping cache accounting visible. */
export function toOpenAiUsage(usage) {
    if (!usage) return undefined;
    const input = usage.input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheCreate = usage.cache_creation_input_tokens ?? 0;
    return {
        prompt_tokens: input + cacheRead + cacheCreate,
        completion_tokens: output,
        total_tokens: input + cacheRead + cacheCreate + output,
        prompt_tokens_details: {
            cached_tokens: cacheRead,
            cache_creation_tokens: cacheCreate,
        },
    };
}
