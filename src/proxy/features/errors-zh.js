// ──────────────────────────────────────────────
// Chinese explanations for common failures
// ──────────────────────────────────────────────
//
// Errors reach the user as a SillyTavern toast / chat error, so they should
// say what happened and what to do — in Chinese — while keeping the raw
// upstream text for debugging. Order matters: first match wins.

// 审: 错误文本 → 中文说明的规则表，按顺序第一条匹配的生效。
const RULES = [
    {
        code: 'output_limit',
        test: /最大回复长度|output token maximum/i,
        message: '写满了',
        hint: '调大「最大回复长度」再生成',
    },
    {
        code: 'not_logged_in',
        // "oauth.{0,20}token has expired": the CLI says 「OAuth access token has expired」.
        test: /not logged in|please run \/login|oauth.{0,20}token has expired|token_expired|invalid_token|authentication_failed|authentication expired/i,
        message: '没登录',
        hint: '在酒馆的 plugins/CCST 里运行 npm run login',
    },
    {
        code: 'reasoning_extraction',
        test: /reasoning_extraction/i,
        message: '5.x 不许写出思考',
        // Measured 2026-10-08 (图灵预设 × Opus 5.5): 10 of 14 blocked; a reroll of the same request sometimes
        // passed; every block still wrote ~40k cache twice (the CLI asks once more); Opus 4.6 passed.
        hint: '关掉思维链条目，或换 4.6',
    },
    {
        code: 'safeguards',
        test: /safeguards flagged|stop_reason.{0,5}refusal|refusal/i,
        message: '被拦了',
        hint: '重新生成，或改改最近几条',
    },
    {
        code: 'extra_usage',
        test: /extra usage|out of extra usage/i,
        message: '1M 用不了',
        hint: '换不带 1M 的同名模型',
    },
    {
        code: 'usage_limit',
        // The newer CLI phrases limits as 「You've hit your weekly limit · resets
        // 5pm (Asia/Shanghai)」 instead of 「Claude AI usage limit reached」, so the
        // window names, 「hit your … limit」 and 「resets」 count as a limit too.
        test: /usage limit|limit reached|weekly limit|5[-\s]?hour limit|hourly limit|hit your.{0,40}limit|resets|quota|rate.?limit|too many requests|\b429\b/i,
        message: '额度用完',
        hint: '等一等；「状态」看重置时间',
    },
    {
        code: 'overloaded',
        test: /overloaded|\b529\b|\b503\b|service unavailable/i,
        message: 'Claude 太忙',
        hint: '等一两分钟再生成',
    },
    {
        code: 'prompt_too_long',
        test: /prompt is too long|context.{0,20}(length|window)|too many tokens|maximum context/i,
        message: '聊天太长',
        hint: '调小上下文，或换 1M 模型',
    },
    {
        code: 'served_model_guard',
        test: /served-model guard|model substitution refused/i,
        message: 'Fable 不可用',
        hint: '先换 Opus 5，过会儿再试',
    },
    {
        code: 'idle_timeout',
        test: /idle|deadline exceeded|aborted/i,
        message: '没回应',
        hint: '重新生成；常这样就查网络',
    },
    {
        code: 'network',
        test: /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|fetch failed|network|socket hang up/i,
        message: '连不上 Claude',
        hint: '检查这台电脑的网络',
    },
    {
        code: 'sdk_unavailable',
        test: /failed to load @anthropic-ai\/claude-agent-sdk|没能加载 Claude SDK|native cli binary/i,
        message: '缺少组件',
        hint: '再运行一次安装那一行',
    },
    {
        code: 'refusal',
        test: /declined|safety/i,
        message: '被拒绝了',
        hint: '换个说法再生成',
    },
];

// 审: 把上游错误文本归类成 {code, message, hint, raw}（chat.js、usage-stats 用）。
/**
 * @param {string} raw upstream error text
 * @returns {{ code: string, message: string, hint: string, raw: string }}
 */
export function explainError(raw) {
    const text = String(raw ?? '');
    for (const rule of RULES) {
        if (rule.test.test(text)) {
            return { code: rule.code, message: rule.message, hint: rule.hint, raw: text };
        }
    }
    return {
        code: 'unknown',
        message: '失败了',
        hint: '先重试；不行就导出诊断',
        raw: text,
    };
}

// 审: 拼成发给酒馆的一行用户可见错误文本（chat.js 用）。
/** One-line user-facing text: 中文说明 + 办法 + 原始错误. */
export function formatErrorForUser(raw) {
    const e = explainError(raw);
    return `【CCST】${e.message}。${e.hint}（原始错误：${e.raw}）`;
}
