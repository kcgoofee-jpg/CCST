#!/usr/bin/env node
// 这个订阅账号有没有被灰度到 CLI 的「记录系统提示词」？
//
// 用法：在 CCST 文件夹运行  node scripts/prompt-recording-probe.mjs
//
// 发一条极小的请求（Haiku，几十个 token），系统提示词按 CLI 默认方式传（不带
// snapshot: false），看 CLI 写会话记录时有没有 prompt_snapshot 附件：有 = 已开启。
// 开启的账号上，5.2.1 及更早的 CCST 会把旧的系统提示词沿用到之后的轮次（缓存 0%、
// 串预设）；5.2.2 起代理关掉了它，不受影响。不写任何文件。

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { query } = await import('@anthropic-ai/claude-agent-sdk');
const cwd = join(tmpdir(), 'claude-max-rp');
mkdirSync(cwd, { recursive: true });
const seen = [];
const sessionId = randomUUID();
const store = {
    load: async () => null,
    append: async (_k, entries) => { for (const e of entries) seen.push(e?.attachment?.type ?? e?.type); },
};
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE_CODE_SESSION|CLAUDE_CODE_ENTRYPOINT|CLAUDECODE)/.test(k)));
Object.assign(env, { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' });
try {
    const q = query({ prompt: '只回答：好', options: { model: 'claude-haiku-4-5', systemPrompt: '测试', sessionId, sessionStore: store, cwd, env, settingSources: [], maxTurns: 1, tools: [] } });
    for await (const m of q) if (m.type === 'result' && m.subtype !== 'success') console.log(`请求没成功：${m.subtype}`);
} catch (err) {
    console.error(`请求失败：${err?.message ?? err}（没登录或额度用完时测不了）`);
    process.exit(1);
}
await new Promise((r) => setTimeout(r, 1500));
if (seen.includes('prompt_snapshot')) {
    console.log('✅ 这个账号已开启「记录系统提示词」。CCST 5.2.1 及更早版本会受影响（缓存 0%、沿用旧预设），请更新到 5.2.2 以上。');
} else if (seen.length) {
    console.log('这个账号还没开启「记录系统提示词」，目前不受这个问题影响。');
} else {
    console.log('没收到任何会话记录，无法判断。');
}
process.exit(0);
