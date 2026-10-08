#!/usr/bin/env node
// 缓存命中线级诊断（插件用户自查工具）。
//
// 用法：在 CCST 文件夹里运行
//   node scripts/wire-diagnosis.mjs
//
// 它做三件事：
//   1. 起一个本地 tap（127.0.0.1 随机端口），把 CLI 发往 Anthropic 的请求和回复
//      逐字节记录后原样转发（凭据照带）。
//   2. 在测试端口起一个临时代理（用量记到临时目录，不碰你的 data/），把 CLI 指到
//      tap，自动跑 4 轮对话（系统提示词约 2 万 token，够得上所有模型的缓存下限）。
//   3. 输出每轮：CLI 要求的缓存有效期（5m / 1h）、Anthropic 回的缓存读 / 写，以及
//      相邻两轮请求的前缀在哪里分叉。
//
// 会用掉一点订阅额度（首轮写入约 2 万 token，后两轮基本读缓存）。
// 字节明细写到系统临时目录 ccst-wire-diagnosis/。

import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 审: 仓库根目录，用来在这里启动临时代理。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// 审: 诊断输出目录（系统临时目录），不碰用户 data/。
const OUT = join(tmpdir(), 'ccst-wire-diagnosis');
// 审: 控制台输出前缀。
const TAG = '[wire-diagnosis]';
// 审: 诊断用模型，可用环境变量 MODEL 覆盖。
const MODEL = process.env.MODEL ?? 'claude-opus-4-6';
// 审: 轮间等待。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT, { recursive: true });

// 审: 从上游回复（流式或非流式）取 usage，读出缓存读写数。
/** 回复里的 usage：流式取 message_start（缓存读写都在这里），非流式取顶层。 */
function usageOf(text) {
    try { return JSON.parse(text).usage ?? null; } catch { /* 流式 */ }
    for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
            const ev = JSON.parse(line.slice(5));
            if (ev.type === 'message_start') return ev.message?.usage ?? null;
        } catch { /* 跳过 */ }
    }
    return null;
}

// ── 1. tap：记录请求与回复，原样转发 ──
// 审: 抓到的所有 /v1/messages 请求与对应 usage。
const records = []; // { body, usage }
// 审: 本地 tap：逐字节记录 CLI 发往 Anthropic 的请求并原样转发。
const tap = createServer((req, res) => {
    // 按 Buffer 收齐再解码：逐块拼字符串会把跨块的汉字切坏，转发出去的就不是原请求了
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        const raw = Buffer.concat(chunks);
        let rec = null;
        if (req.url.startsWith('/v1/messages') && !req.url.includes('count_tokens')) {
            try { rec = { body: JSON.parse(raw.toString('utf8')), usage: null }; records.push(rec); } catch { /* 非 JSON：跳过 */ }
        }
        // 不要压缩：要读回复里的 usage
        const headers = { ...req.headers, 'accept-encoding': 'identity' };
        delete headers.host;
        delete headers['content-length'];
        const upstream = httpsRequest(`https://api.anthropic.com${req.url}`, { method: req.method, headers }, (up) => {
            res.writeHead(up.statusCode, up.headers);
            const body = [];
            up.on('data', (c) => { if (rec) body.push(c); res.write(c); });
            up.on('end', () => {
                res.end();
                if (!rec) return;
                rec.status = up.statusCode;
                rec.usage = usageOf(Buffer.concat(body).toString('utf8'));
            });
        });
        upstream.on('error', (err) => {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: `tap 上游错误：${err.message}` } }));
        });
        upstream.end(raw);
    });
});

await new Promise((resolve) => tap.listen(0, '127.0.0.1', resolve));
const tapPort = tap.address().port;

// ── 2. 临时代理（复用本仓库代码，指到 tap）──
// 审: 临时代理的随机测试端口。
const proxyPort = 18970 + Math.floor(Math.random() * 100);
// 审: 起临时代理子进程，指向 tap；env 里的开关均为 src 里仍存在的变量。
const proxy = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
        ...process.env,
        CLAUDE_SUBSCRIPTION_PORT: String(proxyPort),
        CLAUDE_SUBSCRIPTION_HOST: '127.0.0.1',
        CLAUDE_SUBSCRIPTION_DEV_BASE_URL: `http://127.0.0.1:${tapPort}`,
        CLAUDE_SUBSCRIPTION_NO_UI_INSTALL: '1',
        CLAUDE_SUBSCRIPTION_STATS_FILE: join(OUT, 'usage.jsonl'),
    },
    stdio: ['ignore', 'ignore', 'ignore'],
});
// 每次运行换一个开头，避开上一次运行留下的缓存
// 审: 每次运行唯一的开头，避开上次运行留下的缓存。
const nonce = Date.now().toString(36);
const system = `【诊断 ${nonce}】你在做一次缓存诊断，只按要求简短回答。\n${'【规则】保持角色，不要出戏，回答尽量简短。'.repeat(1200)}`;
// 审: 向临时代理发一轮聊天请求（带面板参数，才会走逐轮还原）。
const chat = async (turns) => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 带上面板参数：不带的请求会被当成后台调用，不做逐轮还原，测不到真实聊天的行为
        body: JSON.stringify({ claude_subscription: {}, model: MODEL, max_tokens: 2000, messages: [{ role: 'system', content: system }, ...turns] }),
    });
    return res.json().catch(() => ({}));
};

console.log(`${TAG} 代理（测试端口 ${proxyPort}）与 tap（${tapPort}）已就绪，用 ${MODEL} 跑 4 轮对话……`);
await sleep(3000);
const h = [];
for (const line of ['请只回答：好的', '再回答一次', '第三次回答', '最后再回答一次']) {
    h.push({ role: 'user', content: line });
    const r = await chat(h);
    const reply = r?.choices?.[0]?.message?.content;
    if (!reply) console.log(`${TAG} 这一轮没有拿到回复：${JSON.stringify(r?.error?.message ?? r).slice(0, 200)}`);
    h.push({ role: 'assistant', content: reply || '好的' });
    await sleep(1500);
}

proxy.kill();
tap.close();

// ── 3. 分析 ──
// 审: 只留主聊天模型的请求用于分析。
const turns = records.filter((r) => Array.isArray(r.body?.messages) && r.body.model?.startsWith(MODEL));
writeFileSync(join(OUT, 'requests.json'), JSON.stringify(records, null, 2));
if (turns.length < 2) {
    console.error(`${TAG} 只抓到 ${records.length} 个请求，不足以诊断（额度用完、没登录，或 CLI 根本没有发请求？）。`);
    process.exit(1);
}

// 审: token 数简写（1.2k）。
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0));
// 审: 请求体里所有 cache_control 的 ttl 值。
const ttlsOf = (body) => [...JSON.stringify(body).matchAll(/"ttl":"(\w+)"/g)].map((m) => m[1]);
// 审: 取内容块的文本。
const text = (b) => (typeof b === 'string' ? b : (b?.text ?? JSON.stringify(b)));
// 审: 提取比较用的指纹（系统提示词去掉计费头 + 各条消息的块文本）。
const fingerprint = (body) => {
    const sys = body.system ?? [];
    const parts = (Array.isArray(sys) ? sys : [sys]).map((p) => p?.text ?? String(p));
    return {
        // system[0] 是 CLI 的计费头（x-anthropic-billing-header），服务端不把它算进缓存前缀：
        // 实测它在第 1→2 轮变化（后缀取自首条用户消息的哈希）时缓存照样命中。
        systemRest: parts.slice(1),
        messages: (body.messages ?? []).map((m) => ({ role: m.role, blocks: typeof m.content === 'string' ? [m.content] : (m.content ?? []).map(text) })),
    };
};

console.log(`\n抓到 ${turns.length} 轮请求：\n`);
// 审: 是否发现 CLI 按 5 分钟写缓存。
let saw5m = false;
turns.forEach((t, i) => {
    const ttls = [...new Set(ttlsOf(t.body))];
    if (ttls.includes('5m') || (!ttls.length && JSON.stringify(t.body).includes('cache_control'))) saw5m = true;
    const u = t.usage ?? {};
    const split = u.cache_creation ? `（5m ${k(u.cache_creation.ephemeral_5m_input_tokens)} / 1h ${k(u.cache_creation.ephemeral_1h_input_tokens)}）` : '';
    console.log(`  第 ${i + 1} 轮：缓存有效期 ${ttls.join('、') || '未标注（默认 5m）'}；读 ${k(u.cache_read_input_tokens)}，写 ${k(u.cache_creation_input_tokens)}${split}，未缓存输入 ${k(u.input_tokens)}${t.status && t.status !== 200 ? `；HTTP ${t.status}` : ''}`);
});
console.log('');

// 审: 逐对相邻轮次比较前缀并给出结论。
const verdicts = [];
for (let i = 1; i < turns.length; i++) {
    const a = fingerprint(turns[i - 1].body);
    const b = fingerprint(turns[i].body);
    let broke = null;
    if (JSON.stringify(a.systemRest) !== JSON.stringify(b.systemRest)) broke = { where: '系统提示词', detail: '系统提示词两轮不同。' };
    if (!broke) {
        const n = Math.min(a.messages.length, b.messages.length);
        for (let j = 0; j < n; j++) {
            if (JSON.stringify(a.messages[j]) !== JSON.stringify(b.messages[j])) {
                broke = {
                    at: j,
                    where: `第 ${j + 1} 条消息（${a.messages[j].role}）`,
                    detail: `上一轮：${JSON.stringify(a.messages[j].blocks.join('').slice(-150))}\n    这一轮：${JSON.stringify(b.messages[j].blocks.join('').slice(-150))}`,
                };
                break;
            }
        }
    }
    if (!broke) {
        verdicts.push(`第 ${i}→${i + 1} 轮：前缀逐字一致，只在末尾新增 ✅`);
    } else if (broke.at === a.messages.length - 1 && /system-reminder/.test(a.messages[broke.at].blocks.join(''))) {
        verdicts.push(`第 ${i}→${i + 1} 轮：断在上一轮最后一条消息——CLI 只给当前轮附带 <system-reminder> 环境块，历史里不带。这是 CLI 的设计，只损失最后一小段 ✅`);
    } else if (broke.at === 0 && /system-reminder/.test(b.messages[0].blocks.join('')) && !/system-reminder/.test(a.messages[0].blocks.join(''))) {
        verdicts.push(`第 ${i}→${i + 1} 轮：断在第 1 条消息——代理第一次把 CLI 的上下文钉到首条消息上（之后每轮固定不变），一次性的 ✅`);
    } else {
        verdicts.push(`第 ${i}→${i + 1} 轮：前缀断在${broke.where} ❌\n    ${broke.detail}`);
    }
}
for (const v of verdicts) console.log(`  ${v}`);

// 审: 最后一轮 usage，用来下总结论。
const last = turns[turns.length - 1].usage ?? {};
console.log('\n结论：');
if (saw5m) {
    console.log('  ❌ CLI 按 5 分钟写缓存：两轮间隔（含回复和阅读时间）超过 5 分钟就全部过期，表现为「只有重 roll 有命中」。');
    console.log('     5.2.1 起代理会固定要求 1 小时；仍是 5m 说明环境变量 FORCE_PROMPT_CACHING_5M 或 CLAUDE_CODE_PROMPT_CACHE_TTL=5m 生效了，去掉它们并重启代理。');
} else if ((last.cache_read_input_tokens ?? 0) > 10000) {
    console.log('  ✅ 1 小时缓存，后续轮正常读缓存。代理和 CLI 本身没问题；酒馆里仍然 0% 的话，看面板「状态」页每轮的「详情」——多半是预设/世界书让内容每轮变化，或两轮间隔超过 1 小时。');
} else {
    console.log('  ⚠ 请求结构正常、有效期 1 小时，最后一轮却没读到多少缓存。把上面的全部输出和临时目录里的 requests.json 发给维护者。');
}
console.log(`\n${TAG} 详细请求与回复已存到 ${OUT}/requests.json。`);
process.exit(0);
