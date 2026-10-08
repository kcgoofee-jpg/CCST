#!/usr/bin/env node
// ──────────────────────────────────────────────
// Standalone entry — run the proxy without SillyTavern
// ──────────────────────────────────────────────
//
// TauriTavern (and any other OpenAI-compatible frontend) has no Node server
// plugins, so the proxy runs as its own process:
//
//   npm start            (or: node server.js)
//
// Same env overrides as the plugin (CLAUDE_SUBSCRIPTION_PORT / _HOST / …).
// If SillyTavern with the server plugin starts later, the plugin detects
// this listener on the port and reuses it instead of failing.

import './features/diag-log.js'; // first: keep the proxy's log lines for the diagnostics report
import { startStandaloneListener, stopStandaloneListener, portInUseMessage, probeExistingProxy } from './api/listener.js';
import { makeShutdownHandler } from './api/shutdown.js';

import { credentialSummary } from './features/oauth.js';
import { noteSdkVersionRun } from './features/sdk-version.js';
import { flushSweeps, sweepLeftovers } from './features/session-store.js';

// 审: 日志前缀。
const TAG = '[claude-subscription]';
// 审: 监听端口 / 地址，环境变量覆盖，与 plugin.js 的默认一致。
const port = parseInt(process.env.CLAUDE_SUBSCRIPTION_PORT, 10) || 8901;
const host = process.env.CLAUDE_SUBSCRIPTION_HOST || '127.0.0.1';

// A stray rejected promise must not take the proxy (and every reply being
// written) down: log it and keep serving.
// 审: 兜底：游离的 rejected promise 只记日志不退出，免得正在写的回复全断。
process.on('unhandledRejection', (reason) => {
    console.error(`${TAG} 未处理的异步错误（代理继续运行）：`, reason instanceof Error ? reason.stack ?? reason.message : reason);
});

// 审: 记录本次运行的 SDK 版本（版本变了会提示缓存可能失效）。
noteSdkVersionRun();

// 审: 启动：先探测端口上是不是已有 CCST，有就退出，没有才监听；其他失败退出码 1。
try {
    // Probe before binding, exactly like the plugin side does: on macOS a proxy
    // already listening on 127.0.0.1:<port> does not stop this one from binding
    // 0.0.0.0:<port>, and then two proxies share a port — the local app talks to
    // this copy while the phone talks to the other one (possibly older code).
    if (await probeExistingProxy({ port, host: host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host })) {
        console.error(`${TAG} 端口 ${port} 上已经有一个 CCST 代理在运行，本次启动退出，免得两个代理共用一个端口。` +
            `先到它的终端窗口按 Ctrl+C 停掉，再运行 npm start。`);
        process.exit(1);
    }
    await startStandaloneListener({ port, host });
} catch (err) {
    if (err?.code === 'EADDRINUSE') console.error(portInUseMessage(port));
    process.exit(1);
}

// 审: 启动时报告订阅凭据状态（找不到就提示 npm run login）。
const cred = credentialSummary();
if (cred.present) {
    console.log(`${TAG} 已找到订阅凭据（来源: ${cred.source}，类型: ${cred.subscriptionType}${cred.expired ? '，access token 已过期，下次对话时 CLI 会自动刷新' : ''}）`);
} else {
    console.warn(`${TAG} 未找到订阅凭据 — 请先在扩展目录运行 npm run login 登录订阅账号（或设置 CLAUDE_CODE_OAUTH_TOKEN）`);
}
console.log(`${TAG} 在酒馆里把 Custom (OpenAI-compatible) 端点设为 http://127.0.0.1:${port}/v1，或使用 CCST 面板一键连接。Ctrl+C 退出。`);

// 审: 启动时清理上次崩溃 / 被杀遗留的会话记录（隐私清理）。
// Roleplay transcripts a crash or kill left on disk (see features/session-store.js).
try {
    const swept = sweepLeftovers();
    if (swept.transcripts || swept.tempDirs) console.log(`${TAG} 清理了上次遗留的 ${swept.transcripts} 份会话记录、${swept.tempDirs} 个临时目录`);
} catch { /* best effort */ }

// 审: 退出流程：冲洗隐私清理、关监听，再冲洗一次（关闭时还在写的回复）。
async function closeEverything() {
    // Delete this run's last transcripts before exiting (their timers would never fire).
    const flush = () => Promise.race([flushSweeps(), new Promise((r) => setTimeout(r, 5000).unref())]);
    await flush();
    await stopStandaloneListener();
    await flush(); // replies that were still running when the signal came
}
// 审: Ctrl+C / kill 的处理函数。
const shutdown = makeShutdownHandler({ close: closeEverything });
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
