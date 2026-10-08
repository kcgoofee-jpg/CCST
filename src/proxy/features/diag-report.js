// ──────────────────────────────────────────────
// Diagnostics report: one text a user can paste to the maintainer
// ──────────────────────────────────────────────
//
// Asking a user to run scripts and dig through folders did not work (2026-10
// 「缓存 0%」: the cause could not be found remotely). The panel's 「导出诊断文件」
// takes this text, adds what only the browser knows (SillyTavern version,
// prompt post-processing, preset, extensions) and saves it as a file with the raw data.
//
// The readable report has no chat text (the raw data after it does): versions,
// settings, the usage records (token counts, hashes), the proxy log, and the SHAPE
// of what the CLI sent: block sizes, short hashes, cache breakpoints with
// their TTL, the first place two consecutive requests differ, the cache usage
// and rate-limit headers Anthropic returned. /diag/full adds the captured
// request bodies (they contain the chat) for when the shape is not enough.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { join } from 'node:path';

import { ROOT } from '../paths.js';
import { SDK_VERSION } from './sdk-version.js';
import { recentEntries } from './usage-stats.js';
import { scriptSuspects } from './cache-diag.js';
import { recentLogLines } from './diag-log.js';
import { capturedExchanges } from './wire-tap.js';

// 审: CLI 在 system[0] 放的计费头前缀，用来识别它（它不参与缓存前缀）。
const BILLING = 'x-anthropic-billing-header:';
// 审: 6 位短哈希，报告里只放哈希不放正文。
const sha = (s) => createHash('sha1').update(s).digest('hex').slice(0, 6);
// 审: 数字缩写成 1.2k；null 显示 -。
const k = (n) => (n == null ? '-' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
// 审: 时间戳格式化成 MM-DD HH:MM:SS。
const hms = (t) => {
    const d = new Date(t);
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${[d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':')}`;
};

// 审: 读 package.json 的版本号写进报告头。
function pluginVersion() {
    try { return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version; } catch { return '?'; }
}

// 审: 把一个内容块转成文本（图片/思考块只给占位，用来算长度和哈希）。
function blockText(b) {
    if (typeof b === 'string') return b;
    if (b?.type === 'text') return b.text ?? '';
    if (b?.type === 'image') return `[image ${b.source?.media_type ?? ''} ${b.source?.data?.length ?? 0}]`;
    if (b?.type === 'thinking') return `[thinking ${b.thinking?.length ?? 0}]${b.signature ?? ''}`;
    return JSON.stringify(b);
}

// 审: 一个块的形状（种类/长度/哈希/缓存断点 TTL），不含正文。
/** Shape of one block: kind, size, short hash, breakpoint TTL. No text. */
function blockShape(b) {
    const t = blockText(b);
    const kind = typeof b === 'string' ? 'text'
        : b?.type === 'text' && t.startsWith(BILLING) ? 'billing'
            : b?.type === 'text' && t.trimStart().startsWith('<system-reminder>') ? 'reminder'
                : b?.type ?? 'text';
    const cc = b?.cache_control ? (b.cache_control.ttl ?? '5m') : null;
    return { kind, len: t.length, sha: kind === 'billing' ? 'billing' : sha(t), cc };
}

// 审: 请求形状；测试直接引用所以保留 export。
/** Request shape: everything that decides the cache prefix, with no text. */
export function shapeOf(body) {
    if (!body || typeof body !== 'object') return null;
    const sys = Array.isArray(body.system) ? body.system : body.system ? [body.system] : [];
    const msgs = (body.messages ?? []).map((m) => ({
        role: m.role,
        blocks: (typeof m.content === 'string' ? [m.content] : m.content ?? []).map(blockShape),
    }));
    return {
        model: body.model,
        thinking: body.thinking ? JSON.stringify(body.thinking) : null,
        effort: body.output_config?.effort ?? null,
        maxTokens: body.max_tokens,
        tools: body.tools?.length ? `${body.tools.length} 个 ${sha(JSON.stringify(body.tools))}` : '无',
        system: sys.map(blockShape),
        messages: msgs,
        cliVersion: (sys.map(blockText).find((t) => t.startsWith(BILLING))?.match(/cc_version=([\d.]+)\./) ?? [])[1] ?? null,
    };
}

// 审: 块形状格式化成一小段文字。
const fmtBlock = (b) => `${b.kind === 'text' ? '' : `${b.kind} `}${b.len}字${b.kind === 'billing' ? '' : ` ${b.sha}`}${b.cc ? ` ⚑${b.cc}` : ''}`;
// 审: 块的比较键，计费头恒等（它每次都不同但不影响缓存）。
const keyOf = (b) => (b.kind === 'billing' ? 'billing' : `${b.kind}:${b.len}:${b.sha}`);

// 审: 两个请求形状第一处不同在哪（诊断报告"与 #N 比"一行）；测试引用所以保留 export。
/** Where request `b` first differs from `a` (the cache prefix stops there). */
export function firstDifference(a, b) {
    if (!a || !b) return null;
    if (a.model !== b.model) return `模型不同（${a.model} → ${b.model}）：缓存按模型分开，整段读不到`;
    if (a.tools !== b.tools) return '工具定义不同：整段读不到';
    // The billing header (system[0]) does not take part in the cache prefix (measured).
    const sa = a.system.filter((x) => x.kind !== 'billing').map(keyOf);
    const sb = b.system.filter((x) => x.kind !== 'billing').map(keyOf);
    for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
        if (sa[i] !== sb[i]) return `系统提示词第 ${i + 1} 块就不同（${sa[i] ?? '无'} → ${sb[i] ?? '无'}）：整段读不到`;
    }
    if (a.thinking !== b.thinking || a.effort !== b.effort) {
        // Not a prefix break, but a different cache on most models.
        const note = `思考设置不同（${a.thinking}/${a.effort} → ${b.thinking}/${b.effort}）`;
        const rest = firstDifference({ ...a, thinking: null, effort: null }, { ...b, thinking: null, effort: null });
        return rest ? `${note}；另外${rest}` : `${note}：多数模型上聊天记录部分要重写`;
    }
    for (let i = 0; i < a.messages.length; i++) {
        const ma = a.messages[i];
        const mb = b.messages[i];
        if (!mb) return `这次比上次少了消息（上次 ${a.messages.length} 条，这次 ${b.messages.length} 条）`;
        const ka = ma.blocks.map(keyOf).join('|');
        const kb = mb.blocks.map(keyOf).join('|');
        if (ma.role !== mb.role || ka !== kb) {
            const isLast = i === a.messages.length - 1;
            const lostReminder = isLast && ma.blocks.some((x) => x.kind === 'reminder') && !mb.blocks.some((x) => x.kind === 'reminder');
            const where = `第 ${i + 1}/${b.messages.length} 条（${mb.role}）`;
            const detail = `上次 [${ma.blocks.map(fmtBlock).join(', ')}] → 这次 [${mb.blocks.map(fmtBlock).join(', ')}]`;
            if (lostReminder) return `${where}：上一轮的当前消息带着 CLI 的 reminder，这一轮作为历史时没带——逐轮还原没生效，之后的聊天记录全部重写。${detail}`;
            if (isLast) return `${where}：上一轮的最后一条，属正常（只重写最新一段）。${detail}`;
            return `${where}就不同，从这里往后全部重写。${detail}`;
        }
    }
    return b.messages.length > a.messages.length ? '前缀完全一致，只在末尾新增 ✅' : '和上一条完全相同（重 roll 或重试）';
}

// 审: 把 Anthropic 返回的 usage 写成一行缓存读写统计。
function usageLine(u) {
    if (!u) return '（没读到用量）';
    const split = u.cache_creation ? `（1h ${k(u.cache_creation.ephemeral_1h_input_tokens)} / 5m ${k(u.cache_creation.ephemeral_5m_input_tokens)}）` : '';
    const total = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const pct = total ? Math.round((100 * (u.cache_read_input_tokens ?? 0)) / total) : 0;
    return `读 ${k(u.cache_read_input_tokens)} 写 ${k(u.cache_creation_input_tokens)}${split} 未缓存 ${k(u.input_tokens)} 输出 ${k(u.output_tokens)} · 命中 ${pct}%`;
}

// 审: 把响应里的 ratelimit 头写成一行额度情况。
function ratelimitLine(h) {
    const g = (s) => h?.[`anthropic-ratelimit-unified-${s}`];
    const parts = [
        g('status') && `状态 ${g('status')}`,
        g('5h-utilization') && `5h ${Math.round(Number(g('5h-utilization')) * 100)}%`,
        g('7d-utilization') && `7d ${Math.round(Number(g('7d-utilization')) * 100)}%`,
        g('overage-status') && `超额 ${g('overage-status')}`,
        g('representative-claim') && `限制项 ${g('representative-claim')}`,
        g('fallback-percentage') && `fallback ${g('fallback-percentage')}`,
    ].filter(Boolean);
    return parts.length ? parts.join(' · ') : '（没有额度头）';
}

// 审: 酒馆侧相比上一条请求变了什么（预设/后处理/世界书/可疑脚本）；测试引用所以保留 export。
/** What changed on the SillyTavern side since the previous request of the same chat. */
export function stChanges(e, prev) {
    const a = prev?.st;
    const b = e?.st;
    if (!a || !b || (e.chatKey ?? e.cacheDiag?.chat) !== (prev.chatKey ?? prev.cacheDiag?.chat)) return '';
    const out = [];
    if (a.preset !== b.preset) out.push(`预设→${b.preset}`);
    else if (a.order !== b.order) out.push('预设条目改动');
    if (a.pp !== b.pp) out.push(`后处理${a.pp}→${b.pp}`);
    const added = (b.wi ?? []).filter((x) => !(a.wi ?? []).includes(x));
    const gone = (a.wi ?? []).filter((x) => !(b.wi ?? []).includes(x));
    if (added.length || gone.length) out.push(`世界书${added.length ? ` +${added.join(',')}` : ''}${gone.length ? ` −${gone.join(',')}` : ''}`);
    if (out.length) return `酒馆变化: ${out.join('；')}`;
    const suspects = scriptSuspects(e, prev);
    return suspects ? `酒馆没改设置，可能是: ${suspects.join(',')}（或改了角色卡 / 用户设定 / 作者注释）` : '';
}

// 审: 一条用量记录写成报告里的一行。
function usageEntryLine(e, prev) {
    const start = e.at - (e.durationMs ?? 0);
    const gap = prev ? Math.round((start - (prev.at - (prev.durationMs ?? 0))) / 1000) : null;
    const d = e.cacheDiag ?? {};
    const diag = [
        d.firstTurn && '首轮',
        d.reroll && '重roll',
        d.systemChanged && `系统@${d.systemDiffAt}${d.systemDiffLabel ? d.systemDiffLabel : ''}`,
        d.historyDiffAt != null && `${d.replyChanged ? '换回复' : d.summaryReplaced ? `正则改短(深${d.cutDepth})` : '历史'}@${d.historyDiffAt + 1}/${d.historyLen}`,
        d.tailRewritten && `尾部换新${d.tailRewritten}`,
        // 审(存疑): volatileTags 现在没有任何代码写入，只可能出现在旧版本留在 usage.jsonl 的记录里；删掉会让旧记录少一段，故没动。
        d.volatileTags?.length && `移位${d.volatileTags.join('/')}`,
        d.chat && `聊天${d.chat.slice(0, 6)}`,
    ].filter(Boolean).join(' ');
    return [
        hms(e.at),
        // 审: auxiliary（预设/扩展的安静调用）仍然存在，不是已移除的后台思考。
        e.auxiliary ? '后台' : '聊天',
        e.model,
        e.path ?? '-',
        e.shape ?? '-',
        e.ok ? `读${k(e.cacheReadTokens)} 写${k(e.cacheCreationTokens)} 入${k(e.inputTokens)} 出${k(e.outputTokens)}${e.cacheTtl ? ` ttl${e.cacheTtl}` : ''}` : `失败 ${e.errorCode ?? ''}`,
        `${Math.round((e.durationMs ?? 0) / 1000)}s`,
        gap != null ? `距上条${gap}s` : '',
        diag,
        stChanges(e, prev),
        e.notices?.length ? `[${e.notices.join(',')}]` : '',
    ].filter(Boolean).join(' | ');
}

// 审: 生成文字报告（handleDiagReport / handleDiagFull 用，不含聊天正文）；只在本文件内用。
/** The text report (no chat text). */
function buildReport({ usageCount = 20, exchangeCount = 12, logCount = 120 } = {}) {
    const out = [];
    out.push('## 代理');
    out.push(`版本 ${pluginVersion()} · SDK ${SDK_VERSION} · Node ${process.version} · ${platform()} ${release()} ${arch()}`);
    // 审(存疑): 列表里 ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN 对应的 API-key 路径已移除，但用户环境里设了它们会影响 CLI，仍是有用的诊断信息，且不能改报告数据，故保留。
    const env = ['CLAUDE_CODE_PROMPT_CACHE_TTL', 'FORCE_PROMPT_CACHING_5M', 'ENABLE_PROMPT_CACHING_1H', 'DISABLE_PROMPT_CACHING', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY']
        .filter((n) => process.env[n] !== undefined)
        .map((n) => (/TOKEN|KEY/.test(n) ? `${n}=(已设置)` : /PROXY/.test(n) ? `${n}=(已设置)` : `${n}=${process.env[n]}`));
    out.push(`相关环境变量：${env.length ? env.join(' ') : '无'}`);

    const entries = recentEntries(usageCount);
    out.push('', `## 用量记录（最近 ${entries.length} 次请求，不含内容）`);
    out.push('时间 | 类型 | 模型 | 路径 | 形状 | 缓存 | 耗时 | 间隔 | 诊断 | 提示');
    // Each line against the previous successful request of the same chat (any chat if unknown).
    entries.forEach((e, i) => {
        const before = entries.slice(0, i).reverse().filter((p) => !p.auxiliary && p.ok && !e.auxiliary);
        out.push(usageEntryLine(e, before.find((p) => e.chatKey && p.chatKey === e.chatKey) ?? before[0]));
    });

    const ex = capturedExchanges().slice(-exchangeCount);
    out.push('', `## 抓包：CLI 实际发给 Anthropic 的请求（${ex.length ? `最近 ${ex.length} 条` : '没有记录——代理重启后再聊几轮（环境变量里有 socks 等非 http 代理，或设了 CLAUDE_SUBSCRIPTION_DIAG_CAPTURE=0 时不记录）'}）`);
    let prevByModel = new Map();
    for (const x of ex) {
        const s = shapeOf(x.request);
        out.push('', `#${x.id} ${hms(x.at)} HTTP ${x.status ?? '…'} ${x.ms != null ? `${(x.ms / 1000).toFixed(1)}s` : '进行中'} ${s?.model ?? '?'} · CLI ${s?.cliVersion ?? '?'}${x.betas ? ` · beta ${x.betas}` : ''}`);
        if (!s) { out.push('  （请求体不是 JSON）'); continue; }
        out.push(`  思考 ${s.thinking ?? '无'} · effort ${s.effort ?? '-'} · max_tokens ${s.maxTokens} · 工具 ${s.tools}`);
        out.push(`  system ${s.system.length} 块：${s.system.map(fmtBlock).join(' | ')}`);
        const marks = s.messages.flatMap((m, i) => m.blocks.map((b, j) => (b.cc ? `第${i + 1}条第${j + 1}块⚑${b.cc}` : null)).filter(Boolean));
        const last = s.messages[s.messages.length - 1];
        out.push(`  messages ${s.messages.length} 条 · 断点 ${marks.join(' ') || '无'} · 末条 ${last?.role}[${(last?.blocks ?? []).map(fmtBlock).join(', ')}]`);
        out.push(`  缓存：${usageLine(x.usage)}`);
        out.push(`  额度：${ratelimitLine(x.ratelimit)}`);
        if (x.error) out.push(`  错误：${x.error.slice(0, 300)}`);
        const prev = prevByModel.get(s.model);
        if (prev) out.push(`  与 #${prev.id} 比：${firstDifference(prev.shape, s)}`);
        if (x.status === 200) prevByModel.set(s.model, { id: x.id, shape: s });
    }

    const logs = recentLogLines(logCount);
    out.push('', `## 代理日志（最近 ${logs.length} 行）`);
    out.push(...logs);
    return out.join('\n');
}

// 审: GET /diag/report 的处理函数，返回文字报告（routes.js 注册）。
export function handleDiagReport(_req, res) {
    res.type('text/plain; charset=utf-8').send(buildReport());
}

// 审: GET /diag/full 的处理函数（routes.js 注册，面板「导出诊断文件」用）。
/** Everything, including the captured request bodies — these contain the chat. */
export function handleDiagFull(_req, res) {
    res.json({
        report: buildReport({ usageCount: 50, exchangeCount: 30, logCount: 300 }),
        exchanges: capturedExchanges().map((x) => ({ ...x })),
        usage: recentEntries(50),
    });
}
