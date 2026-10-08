// ──────────────────────────────────────────────
// SDK subprocess environment builder
// ──────────────────────────────────────────────
//
// The Claude Code CLI resolves auth and model aliases from its environment.
// Getting this env exactly right is what keeps subscription billing working:
//
//   • ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL and
//     every provider switch are SCRUBBED — any stray key in SillyTavern's
//     process env would silently flip billing off the subscription
//     (Meridian scrubs identically). The proxy's own CLAUDE_SUBSCRIPTION_*
//     settings are dropped too.
//   • ANTHROPIC_DEFAULT_<TIER>_MODEL pins resolve tier aliases (and the
//     [1m] alias forms) to exact versions — request pins win over both
//     canonical defaults and inherited shell env.
//   • CLAUDE_CODE_MAX_OUTPUT_TOKENS carries SillyTavern's "Max response
//     length" to the CLI (the SDK has no per-query output cap option).
//   • ENABLE_CLAUDEAI_MCP_SERVERS=false kills claude.ai account connectors
//     (Notion/Gmail/etc.) that would otherwise reach the model
//     (Marinara's isolation hardening).
//   • CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 — every request here is a
//     fresh session, and without it the CLI sends the message to a model to
//     generate an `ai-title` for each one (observed in the session
//     transcript), i.e. an extra call per chat message. Per the Claude Code
//     docs it also turns off auto-updates, telemetry and error reporting,
//     which a one-shot RP subprocess doesn't need.
//   • CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 — settingSources:[] does NOT stop
//     the CLI from injecting the cwd project's auto-memory index into the
//     context (verified with a probe prompt); this does.

// 审: 要从子进程环境里清掉的变量清单（API key / 云厂商开关 / 改地址的变量），防止悄悄把计费从订阅切走；只在本文件用。
// Every env var that could send the CLI somewhere else or bill something
// other than the subscription. API-key users use SillyTavern's own Claude
// source; the proxy only runs on the subscription.
const SCRUB_KEYS = [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_GATEWAY',
    'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
    'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'AWS_BEARER_TOKEN_BEDROCK',
    'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'CLAUDE_CODE_SKIP_VERTEX_AUTH', 'ANTHROPIC_CUSTOM_HEADERS',
];

// 审: 组装 CLI 子进程的环境（清洗 + 模型版本钉 + 输出上限 + 缓存 TTL + 关闭隔离外的流量），聊天每次尝试 / oauth 刷新都用。
/**
 * @param {object} args
 * @param {Record<string,string>} args.envPins ANTHROPIC_DEFAULT_* pins from parseModelRequest
 * @param {number|undefined} args.maxTokens
 * @returns {Record<string,string|undefined>}
 */
export function buildSubprocessEnv({ envPins, maxTokens, cacheTtl = '1h' }) {
    const env = { ...process.env };
    for (const key of SCRUB_KEYS) delete env[key];
    // The proxy's own settings (file paths, switches, …) are none of
    // the CLI's business — it reads only ANTHROPIC_* / CLAUDE_CODE_* / CLAUDE_CONFIG_DIR.
    for (const key of Object.keys(env)) if (key.startsWith('CLAUDE_SUBSCRIPTION_')) delete env[key];
    // 审: 开发用：把 CLI 指到本地抓包（scripts/wire-diagnosis.mjs 和 wire-tap.js 在用）；聊天里诊断抓包开启时会再覆盖它。
    // Dev only: route the CLI through a local request tap (scripts/api_tap) to see what it really sends.
    if (process.env.CLAUDE_SUBSCRIPTION_DEV_BASE_URL) env.ANTHROPIC_BASE_URL = process.env.CLAUDE_SUBSCRIPTION_DEV_BASE_URL;

    // Request pins win over inherited shell env (the picked model version IS
    // the request's meaning; a stale shell pin must not redirect it).
    Object.assign(env, envPins);

    // 审: 下面三个开关见文件头注释：不让 claude.ai 连接器进上下文、不给每条消息生成标题、不注入自动记忆。
    env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
    // When a reply is stopped mid-way by a safety stop, the CLI would retry
    // the turn on another model and expect the client to retract the partial
    // it already received. A streamed reply can't be retracted in
    // SillyTavern: the two outputs end up spliced into one message (an
    // unclosed HTML card swallowing the rest) and the reply silently comes
    // from a different model. Stop at the refusal instead; the proxy reports
    // it. CLAUDE_SUBSCRIPTION_REFUSAL_FALLBACK=on restores the CLI default.
    // 审: 默认关掉 CLI 的拒答自动换模型（流式回复没法撤回，会拼成一条）；CLAUDE_SUBSCRIPTION_REFUSAL_FALLBACK=on 才恢复，文档和测试都有。
    if (!/^(1|true|on|yes)$/i.test(process.env.CLAUDE_SUBSCRIPTION_REFUSAL_FALLBACK ?? '')) {
        env.CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK = '1';
    }

    // 审: 请求带了最大回复长度就传给 CLI，否则清掉继承来的值（见分支内注释）。
    if (maxTokens) {
        env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxTokens);
    } else {
        // No "Max response length" in this request: an inherited shell value
        // would cap the reply without anything in the request asking for it.
        delete env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
    }

    // The subscription does not always get 1 hour either. Per the Claude Code docs (prompt
    // caching → "Which TTL each request gets"), the main conversation gets 1h only while the
    // account is within its plan's included usage; once it draws on usage credits (extra
    // usage — easy to reach on Pro) the CLI drops to 5 minutes. A long RP reply (3–4 min) plus
    // reading it outlasts that, so every new turn would re-write everything while a quick
    // reroll still hits. The env var outranks that default; an explicit value still wins.
    // The panel can pick 5 minutes (cheaper writes for fast back-and-forth).
    // 审: 提示缓存 TTL（面板可选 5 分钟 / 1 小时）；用户自己设的环境变量优先。
    env.CLAUDE_CODE_PROMPT_CACHE_TTL ??= cacheTtl;

    return env;
}
