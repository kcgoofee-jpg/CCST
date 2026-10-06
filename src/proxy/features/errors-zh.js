// ──────────────────────────────────────────────
// Chinese explanations for common failures
// ──────────────────────────────────────────────
//
// Errors reach the user as a SillyTavern toast / chat error, so they should
// say what happened and what to do — in Chinese — while keeping the raw
// upstream text for debugging. Order matters: first match wins.

const RULES = [
    {
        code: 'output_limit',
        test: /最大回复长度|output token maximum/i,
        message: '回复超过了『最大回复长度』被截断，没有可保留的文字',
        hint: '到酒馆『AI 回复配置』把最大回复长度调大（思考也计入长度），再重新生成。',
    },
    {
        code: 'not_logged_in',
        // "oauth.{0,20}token has expired": the CLI says 「OAuth access token has expired」.
        test: /not logged in|please run \/login|oauth.{0,20}token has expired|token_expired|invalid_token|authentication_failed|authentication expired/i,
        message: 'Claude 订阅没登录，或登录已过期',
        hint: '这次没法生成。重新登录一次就好，不用重启代理：在 SillyTavern/plugins/CCST 文件夹里运行 npm run login（用一键安装包的：打开「酒馆工具」，按 4 进「更多」，选「登录 Claude」）。',
    },
    {
        code: 'reasoning_extraction',
        test: /reasoning_extraction/i,
        message: 'Claude 拒绝了这条请求：预设让模型把思考过程写进回复',
        hint: 'Opus 5、Opus 5.5、Sonnet 5.5 会拒绝这样的请求，拒绝了也照常计费，别反复重试。把预设里让模型输出思考过程（<thinking>、草稿、自检注释）的条目关掉；想看写在正文里的思考，改用 Opus 4.6 并把思考模式关闭。',
    },
    {
        code: 'safeguards',
        test: /safeguards flagged|stop_reason.{0,5}refusal|refusal/i,
        message: 'Claude 的安全审查拦下了这条请求',
        hint: '可以直接重新生成一次；反复被拦的话，改一下最近几条内容，或换个模型。拦截的类别写在下面的原始错误里。',
    },
    {
        code: 'extra_usage',
        test: /extra usage|out of extra usage/i,
        message: '这个 1M 上下文的模型需要订阅开通「额外用量」，现在用不了',
        hint: '换成不带「(1M context)」的同名模型就能继续。',
    },
    {
        code: 'usage_limit',
        // The newer CLI phrases limits as 「You've hit your weekly limit · resets
        // 5pm (Asia/Shanghai)」 instead of 「Claude AI usage limit reached」, so the
        // window names, 「hit your … limit」 and 「resets」 count as a limit too.
        test: /usage limit|limit reached|weekly limit|5[-\s]?hour limit|hourly limit|hit your.{0,40}limit|resets|quota|rate.?limit|too many requests|\b429\b/i,
        message: '订阅额度到上限了（请求太频繁，或 5 小时 / 7 天额度用完）',
        hint: '这次没生成。等几分钟再试；CCST 面板「状态」页能看到额度什么时候重置。',
    },
    {
        code: 'overloaded',
        test: /overloaded|\b529\b|\b503\b|service unavailable/i,
        message: 'Claude 服务器现在太忙',
        hint: '和你的设置无关。等一两分钟重新生成。',
    },
    {
        code: 'prompt_too_long',
        test: /prompt is too long|context.{0,20}(length|window)|too many tokens|maximum context/i,
        message: '聊天内容超过了模型能读的长度',
        hint: '在酒馆里调小「上下文长度」，或换成带「(1M context)」的模型。',
    },
    {
        code: 'served_model_guard',
        test: /served-model guard|model substitution refused/i,
        message: 'Fable 现在用不了（上游想悄悄换成别的模型，已被拦下）',
        hint: '先改选别的模型，比如 Opus 5；过一阵再试 Fable。',
    },
    {
        code: 'idle_timeout',
        test: /idle|deadline exceeded|aborted/i,
        message: 'Claude 太久没有回应，这次请求已中止',
        hint: '重新生成一次。经常这样的话，检查网络或稍后再试。',
    },
    {
        code: 'network',
        test: /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|fetch failed|network|socket hang up/i,
        message: '代理连不上 Claude 的服务器',
        hint: '通常是运行代理的这台电脑的网络或代理设置有问题。检查网络后重新生成。',
    },
    {
        code: 'sdk_unavailable',
        test: /failed to load @anthropic-ai\/claude-agent-sdk|没能加载 Claude SDK|native cli binary/i,
        message: 'CCST 代理缺少运行所需的组件（Claude SDK）',
        hint: '在 SillyTavern/plugins/CCST 文件夹里运行 npm install（不要加 --omit=optional），再重启酒馆。用一键安装包的：在「酒馆工具」的「更多」里选「修复依赖」，然后重启。',
    },
    {
        code: 'refusal',
        test: /declined|safety/i,
        message: 'Claude 拒绝了这次请求（安全策略）',
        hint: '改一下最近的内容或换个说法，再重新生成。',
    },
];

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
        message: 'Claude 请求失败，原因不明',
        hint: '先重新生成一次。还是不行的话看下面的原始错误；装成酒馆插件的，到酒馆的控制台窗口里找 [claude-subscription] 开头的日志；用一键安装包的，在「酒馆工具」里选「检查状态」。',
        raw: text,
    };
}

/** One-line user-facing text: 中文说明 + 办法 + 原始错误. */
export function formatErrorForUser(raw) {
    const e = explainError(raw);
    return `【CCST】${e.message}。${e.hint}（原始错误：${e.raw}）`;
}
