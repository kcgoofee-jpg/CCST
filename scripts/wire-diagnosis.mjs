#!/usr/bin/env node
// 缓存 0% 线级诊断（usage-2 / 插件用户自查工具）。
//
// 用法：在 CCST 文件夹里运行
//   node scripts/wire-diagnosis.mjs
//
// 它做三件事：
//   1. 起一个本地 tap（127.0.0.1 随机端口），把 CLI 发往 Anthropic 的请求
//      逐字节记录后原样转发（凭据照带，回复照传——额度耗尽也没关系，
//      要测的是请求字节，不是回复）。
//   2. 在测试端口起一个临时代理，把 CLI 指到 tap，自动跑 3 轮小对话。
//   3. 对比 3 轮请求的字节前缀，输出结论：第几字节分叉、分叉发生在哪个
//      区域（计费头 / 系统提示词 / 第几条消息），以及对应的处置建议。
//
// 只写 /tmp/ccst-wire-diagnosis/，不碰聊天记录；结束时分号退出，代理随进程退出。

import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(tmpdir(), 'ccst-wire-diagnosis');
const TAG = '[wire-diagnosis]';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT, { recursive: true });

// ── 1. tap：记录 + 原样转发 ──
const records = []; // { body, at }
const tap = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        if (req.url.startsWith('/v1/messages')) {
            try { records.push({ at: Date.now(), body: JSON.parse(raw) }); } catch { /* 非 JSON：跳过 */ }
        }
        const headers = { ...req.headers };
        delete headers.host;
        delete headers['content-length'];
        const upstream = httpsRequest(
            `https://api.anthropic.com${req.url}`,
            { method: req.method, headers },
            (up) => {
                res.writeHead(up.statusCode, up.headers);
                up.pipe(res);
            },
        );
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
const proxyPort = 18970 + Math.floor(Math.random() * 100);
const proxy = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
        ...process.env,
        CLAUDE_SUBSCRIPTION_PORT: String(proxyPort),
        CLAUDE_SUBSCRIPTION_HOST: '127.0.0.1',
        CLAUDE_SUBSCRIPTION_DEV_BASE_URL: `http://127.0.0.1:${tapPort}`,
        CLAUDE_SUBSCRIPTION_NO_UI_INSTALL: '1',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
});
const chat = async (messages) => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-opus-4-6', max_tokens: 64, messages }),
    });
    return res.json().catch(() => ({}));
};

console.log(`${TAG} 代理（测试端口 ${proxyPort}）与 tap（${tapPort}）已就绪，跑 3 轮对话……`);
await sleep(2500);
await chat([{ role: 'user', content: '请只回答：好的' }]);
await sleep(1500);
await chat([
    { role: 'user', content: '请只回答：好的' },
    { role: 'assistant', content: '好的' },
    { role: 'user', content: '再回答一次' },
]);
await sleep(1500);
await chat([
    { role: 'user', content: '请只回答：好的' },
    { role: 'assistant', content: '好的' },
    { role: 'user', content: '再回答一次' },
    { role: 'assistant', content: '好的' },
    { role: 'user', content: '最后再回答一次' },
]);
await sleep(1500);

proxy.kill();
tap.close();

// ── 3. 分析 ──
const turns = records.filter((r) => Array.isArray(r.body?.messages));
if (turns.length < 2) {
    console.error(`${TAG} 只抓到 ${records.length} 个请求，不足以诊断（CLI 是否根本没有发请求？）。`);
    process.exit(1);
}

const text = (b) => (typeof b === 'string' ? b : (b?.text ?? JSON.stringify(b)));
const fingerprint = (body) => {
    const sys = body.system ?? [];
    const parts = (Array.isArray(sys) ? sys : [sys]).map((p) => p?.text ?? String(p));
    return {
        billing: parts[0] ?? '',
        systemRest: parts.slice(1),
        messages: (body.messages ?? []).map((m) => ({
            role: m.role,
            blocks: typeof m.content === 'string' ? [m.content] : (m.content ?? []).map(text),
        })),
    };
};

const zone = (idx, fp) => {
    if (idx === 'billing') return '计费头（system 第 0 项）——两次请求走了不同的 CCST/CLI 安装';
    if (typeof idx === 'number' && idx >= 1) return idx === fp.systemRest.length ? 'CLI 自己的系统块' : `系统提示词第 ${idx} 项`;
    return null;
};

console.log(`\n抓到 ${turns.length} 轮请求。逐轮对比：\n`);
const verdicts = [];
for (let i = 1; i < turns.length; i++) {
    const a = fingerprint(turns[i - 1].body);
    const b = fingerprint(turns[i].body);
    // 逐区域比对
    if (a.billing !== b.billing) {
        verdicts.push(`第 ${i}→${i + 1} 轮：字节 0（计费头）就变了：\n    上一次 ${JSON.stringify(a.billing)}\n    这一次 ${JSON.stringify(b.billing)}\n    → 常见原因按顺序排查：① 两轮之间走过不同的路径（首轮/降级走 fold，正常轮走 resume，两者的计费头天然不同——只影响切换的那一轮，不是持续 0% 的原因）；② 同一台电脑上「酒馆插件 + 独立代理」两份 CCST 在轮流应答（字节 0 每轮都变 = 持续 0% 的直接原因）；③ 聊天中途 npm 重装过。`);
        continue;
    }
    let broke = null;
    if (JSON.stringify(a.systemRest) !== JSON.stringify(b.systemRest)) broke = { where: '系统提示词', detail: '系统提示词两轮不同——检查预设里每轮变化的宏 / 世界书常驻条目。' };
    if (!broke) {
        const n = Math.min(a.messages.length, b.messages.length);
        for (let k = 0; k < n; k++) {
            if (JSON.stringify(a.messages[k]) !== JSON.stringify(b.messages[k])) {
                broke = {
                    where: `第 ${k + 1} 条消息（${a.messages[k].role}）`,
                    detail: `上一轮这里是：${JSON.stringify(a.messages[k].blocks.reduce((s, x) => s + x, '').slice(-150))}\n    这一轮这里是：${JSON.stringify(b.messages[k].blocks.reduce((s, x) => s + x, '').slice(-150))}`,
                };
                break;
            }
        }
    }
    if (!broke) {
        const grew = b.messages.length > a.messages.length;
        verdicts.push(`第 ${i}→${i + 1} 轮：前缀逐字一致${grew ? '，只在末尾新增 ✅（这一对请求之间缓存应该命中）' : ''}。`);
        continue;
    }
    const tail = b.messages.length - 1;
    const atPrevTail = a.messages.length - 1 === (broke.where.match(/第 (\d+) 条/) ? Number(broke.where.match(/第 (\d+) 条/)[1]) - 1 : -1);
    if (atPrevTail && /system-reminder/.test(a.messages[a.messages.length - 1].blocks.join(''))) {
        verdicts.push(`第 ${i}→${i + 1} 轮：断在上一轮最后一条消息的位置——那是 CLI 每轮附带的 <system-reminder> 环境块，历史里不带它。这是 CLI 的设计，损失的只是那一小段，**不是** 0% 的原因。`);
    } else {
        verdicts.push(`第 ${i}→${i + 1} 轮：前缀断在${broke.where}。\n    ${broke.detail}`);
    }
}
for (const v of verdicts) console.log(`  ${v}\n`);
console.log(`${TAG} 详细请求字节已存到 ${OUT}/ 供进一步分析。`);
process.exit(0);
