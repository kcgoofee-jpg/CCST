// ──────────────────────────────────────────────
// Claude Subscription model catalog + request parsing
// ──────────────────────────────────────────────
//
// Two-layer model story (mirrors Meridian's proven mechanism rather than
// Marinara v2.0.8, which regressed 1M handling by stamping 1M context on the
// plain IDs without enabling anything):
//
//   1. The picker exposes full model IDs plus explicit "(1M context)"
//      variants suffixed `[1m]` — e.g. `claude-opus-4-8[1m]`.
//   2. For a base request we pass the full model ID straight to the SDK.
//      For a `[1m]` request we pass the CLI's tier alias with the 1M suffix
//      (`opus[1m]`, `fable[1m]`, `sonnet[1m]`) as `Options.model` and pin
//      the tier's concrete version via ANTHROPIC_DEFAULT_<TIER>_MODEL in the
//      subprocess env — that is exactly how the Claude Code CLI's own
//      "/model … [1m]" picker entries resolve, and how Meridian serves 1M.
//
// 1M context requires Extra Usage on some plans; failures are handled by the
// caller via the 1-hour cooldown below (probe pattern
// copied from Meridian: one failed [1m] request arms the cooldown, base model
// serves in the meantime, a single probe retries after the hour).

// 审: 模型档位 → CLI 里钉版本用的环境变量名；parseModelRequest 生成 envPins 用。
const TIER_ENV = {
    fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
    opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
};

// 审: 各档位的默认版本，先全部钉住，防止 CLI 内置的旧默认值悄悄决定没指定的档位；测试用到。
// Canonical tier defaults — pinned under the request-specific pin so the
// CLI's bundled (possibly stale) defaults never decide a tier we didn't pin
// explicitly (Meridian issue #419 class of bug).
export const CANONICAL_TIER_MODELS = {
    fable: 'claude-fable-5-1',
    opus: 'claude-opus-5',
    sonnet: 'claude-sonnet-4-6',
    haiku: 'claude-haiku-4-5',
};

// 审: 模型目录（id / 档位 / 能不能 1M / 思考能力 / 上下文），选择器列表、思考参数、请求解析的唯一数据源。
// `adaptiveOnly` = always-thinking model families; sampling params are
// rejected and `thinking: { type: 'enabled' | 'disabled' }` is invalid — only
// adaptive applies (Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable, Mythos). Measured live (5.1): `thinking: disabled` is accepted
// on all of them, but Opus 5.5 / Sonnet 5.5 still return a thinking block, so for them "off" does nothing.
// `noBudget` = thinking can be turned off, but `budget_tokens` is rejected —
// "always on" maps to adaptive instead of enabled+budget (Sonnet 5, Opus 4.7 / 4.8 / 5: measured live, off gives no thinking block).
export const CLAUDE_SUBSCRIPTION_MODELS = [
    { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', tier: 'fable', oneM: true, adaptiveOnly: true, context: 200000 },
    { id: 'claude-fable-5', name: 'Claude Fable 5', tier: 'fable', oneM: true, adaptiveOnly: true, context: 200000 },
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', tier: 'opus', oneM: true, adaptiveOnly: true, context: 200000 },
    { id: 'claude-opus-5', name: 'Claude Opus 5', tier: 'opus', oneM: true, adaptiveOnly: false, noBudget: true, context: 200000 },
    { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', tier: 'opus', oneM: true, adaptiveOnly: false, noBudget: true, context: 200000 },
    { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', tier: 'opus', oneM: true, adaptiveOnly: false, noBudget: true, context: 200000 },
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', tier: 'opus', oneM: true, adaptiveOnly: false, context: 200000 },
    // Sonnet 5.5: 1M is native (no [1m] variant) and thinking can't be turned off (CLI capability rejects_disabled_thinking).
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', tier: 'sonnet', oneM: false, adaptiveOnly: true, context: 1000000 },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', tier: 'sonnet', oneM: true, adaptiveOnly: false, noBudget: true, context: 200000 },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', tier: 'sonnet', oneM: true, adaptiveOnly: false, context: 200000 },
    { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', tier: 'opus', oneM: false, adaptiveOnly: false, context: 200000 },
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', tier: 'sonnet', oneM: false, adaptiveOnly: false, context: 200000 },
    // Haiku 5.5: same shape as Sonnet 5.5 in the CLI's model table (0.3.293): native 1M, rejects_disabled_thinking.
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', tier: 'haiku', oneM: false, adaptiveOnly: true, context: 1000000 },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', tier: 'haiku', oneM: false, adaptiveOnly: false, context: 200000 },
];

// 审: 1M 上下文变体的后缀。
const ONE_M_SUFFIX = '[1m]';

// 审: 按 id 查目录（容忍大小写和小数点写法），不在目录里返回 null。
function catalogEntry(baseId) {
    const raw = String(baseId).toLowerCase();
    const normalized = raw.replace(/\./g, '-');
    return CLAUDE_SUBSCRIPTION_MODELS.find((m) => m.id === raw || m.id === normalized) || null;
}

// 审: 目录外的新模型 id 靠名字猜档位，向前兼容。
/** Tier guess for model IDs not in the catalog (forward compatibility). */
function guessTier(id) {
    const s = String(id).toLowerCase();
    if (s.includes('fable') || s.includes('mythos')) return 'fable';
    if (s.includes('opus')) return 'opus';
    if (s.includes('haiku')) return 'haiku';
    return 'sonnet';
}

// 审: 是不是「总在思考」的模型（目录优先，未知 id 用正则）；parseModelRequest 用，测试直接用。
/** Always-thinking family detection, catalog first, regex for unknown IDs. */
export function isAdaptiveOnlyModel(id) {
    const s = String(id).toLowerCase();
    const entry = catalogEntry(s.replace(/\[1m\]$/, ''));
    if (entry) return entry.adaptiveOnly;
    return (
        /claude-opus-(?:4-(?:[7-9]|\d{2,})|[5-9]|\d{2,})/.test(s) ||
        /claude-sonnet-(?:5-(?:[5-9]|\d{2,})|[6-9]|\d{2,})/.test(s) ||
        /claude-haiku-(?:5-(?:[5-9]|\d{2,})|[6-9]|\d{2,})/.test(s) ||
        s.includes('fable') ||
        s.includes('mythos')
    );
}

// 审: 是不是不接受 budget_tokens 但能关思考的模型；parseModelRequest 用，测试直接用。
/** Models that reject `budget_tokens` but still allow thinking off. */
export function isNoBudgetModel(id) {
    const s = String(id).toLowerCase();
    const entry = catalogEntry(s.replace(/\[1m\]$/, ''));
    if (entry) return !!entry.noBudget;
    return /claude-sonnet-(?:[5-9]|\d{2,})/.test(s) && !isAdaptiveOnlyModel(s);
}

// 审: 按模型能力降级推理强度（4.5 代没有、4.6 没有 xhigh），免得靠 CLI 重试；chat.js 构造选项时用。
/**
 * Effort the model can take. The CLI's own model table (read from its binary) lists no effort at all for the
 * 4.5 generation and no xhigh for 4.6; it quietly drops or lowers those, so do the same here instead of
 * relying on its retry. Unknown / newer ids pass through untouched.
 */
export function effortForModel(id, effort) {
    if (!effort) return undefined;
    const s = String(id).toLowerCase().replace(/\[1m\]$/, '').replace(/\./g, '-');
    if (/claude-(?:haiku|opus|sonnet)-4-5(?:-|$)/.test(s)) return undefined;
    if (/claude-(?:opus|sonnet)-4-6(?:-|$)/.test(s) && effort === 'xhigh') return 'high';
    return effort;
}

// 审: 把请求里的模型串解析成 SDK 调用需要的全部信息（基础 id / 档位 / 1M / 环境钉）；chat.js 入口。
/**
 * Parse the model string from the request into everything the SDK call needs.
 *
 * @param {string} requested e.g. 'claude-opus-5', 'claude-fable-5-1[1m]'
 * @returns {{ requested: string, baseId: string, tier: string, oneM: boolean,
 *            sdkModel: string, envPins: Record<string,string>, adaptiveOnly: boolean,
 *            noBudget: boolean }}
 */
export function parseModelRequest(requested) {
    const raw = String(requested).trim();
    const oneM = raw.endsWith(ONE_M_SUFFIX);
    const rawBaseId = oneM ? raw.slice(0, -ONE_M_SUFFIX.length) : raw;
    const entry = catalogEntry(rawBaseId);
    const baseId = entry ? entry.id : rawBaseId;
    const tier = entry ? entry.tier : guessTier(baseId);

    // Canonical pins for every tier first, then override the requested tier
    // with the exact version the user picked — the request's semantics MUST
    // win over both canonical defaults and any inherited shell env.
    const envPins = {};
    for (const [t, envVar] of Object.entries(TIER_ENV)) {
        envPins[envVar] = CANONICAL_TIER_MODELS[t];
    }
    envPins[TIER_ENV[tier]] = baseId;

    const effectiveOneM = oneM && (entry ? entry.oneM : true);
    // Base request → full model ID direct to the SDK (per-request exactness).
    // [1m] request → tier alias + [1m] suffix; env pin resolves the version.
    const sdkModel = effectiveOneM ? `${tier}${ONE_M_SUFFIX}` : baseId;

    return {
        requested: raw,
        baseId,
        tier,
        oneM: effectiveOneM,
        sdkModel,
        envPins,
        adaptiveOnly: isAdaptiveOnlyModel(baseId),
        noBudget: isNoBudgetModel(baseId),
    };
}

// ──────────────────────────────────────────────
// Extra Usage / 1M cooldown (Meridian's probe pattern)
// ──────────────────────────────────────────────

// 审: 1M 额外用量失败后的冷却时长（1 小时）。
const EXTRA_USAGE_RETRY_MS = 60 * 60 * 1000; // 1 hour
// 审: 上次 1M 因额外用量失败的时间戳，0 = 没失败过。
let extraUsageUnavailableAt = 0;

// 审: 记下一次 1M 失败，开始冷却；chat.js 的重试阶梯用。
export function recordExtendedContextUnavailable() {
    extraUsageUnavailableAt = Date.now();
}

// 审: 冷却中则本次直接用基础模型；chat.js 用。
export function isExtendedContextKnownUnavailable() {
    return extraUsageUnavailableAt > 0 && Date.now() - extraUsageUnavailableAt < EXTRA_USAGE_RETRY_MS;
}

// ──────────────────────────────────────────────
// /v1/models handler
// ──────────────────────────────────────────────

// 审: GET /v1/models：列出目录里的模型和 1M 变体，酒馆的模型列表靠它。
export function listModelsHandler(_req, res) {
    const data = [];
    for (const m of CLAUDE_SUBSCRIPTION_MODELS) {
        data.push({
            id: m.id,
            object: 'model',
            created: 0,
            owned_by: 'anthropic',
            display_name: m.name,
            context_window: m.context,
        });
        if (m.oneM) {
            data.push({
                id: `${m.id}${ONE_M_SUFFIX}`,
                object: 'model',
                created: 0,
                owned_by: 'anthropic',
                display_name: `${m.name} (1M context)`,
                context_window: 1000000,
            });
        }
    }
    res.json({ object: 'list', data });
}
