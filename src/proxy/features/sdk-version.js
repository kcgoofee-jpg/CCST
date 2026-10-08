// ──────────────────────────────────────────────
// The SDK version this process is actually running on
// ──────────────────────────────────────────────
//
// The Claude Code CLI rides inside @anthropic-ai/claude-agent-sdk, so the SDK
// version is also the version whose transcript/pin layout the proxy has to
// match. One module for it: jsonl-entries stamps it into every transcript
// entry, turn-capture keys its context pin by it, /status reports it.

import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { DATA_DIR } from '../paths.js';

// 审: 控制台日志统一前缀（多个文件各自重复定义了一份，跨分区未合并）。
const PLUGIN_TAG = '[claude-subscription]';

// 审: 读 SDK 包自己的 package.json 得到版本号，读不到记 unknown；缓存 pin 和诊断都按它判断「SDK 换了」。
function detectSdkVersion() {
    try {
        const req = createRequire(import.meta.url);
        const mainPath = req.resolve('@anthropic-ai/claude-agent-sdk');
        const pkg = JSON.parse(readFileSync(join(dirname(mainPath), 'package.json'), 'utf8'));
        if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
    } catch {
        // fall through
    }
    return 'unknown';
}

// 审: 本进程实际运行的 SDK 版本，diag-report/turn-capture/usage-stats 使用。
export const SDK_VERSION = detectSdkVersion();

// ── Startup trace (#30) ──
//
// Cache and transcript problems after an SDK update are near-impossible to
// diagnose afterwards, so the version this process runs on is kept on disk and
// a change is logged.

// 审: 记录上次 SDK 版本的文件路径；测试环境默认不落盘，除非显式给环境变量（CLAUDE_SUBSCRIPTION_SDK_VERSION_FILE，仅测试使用）。
function versionFile() {
    if (process.env.NODE_TEST_CONTEXT && !process.env.CLAUDE_SUBSCRIPTION_SDK_VERSION_FILE) return null;
    return process.env.CLAUDE_SUBSCRIPTION_SDK_VERSION_FILE || join(DATA_DIR, 'sdk-version.json');
}

// 审: 启动时对比上次版本，变了打一行日志并更新记录；plugin.js 和 server.js 启动时调用。
/** Log one line when the SDK differs from the last run, then remember this one.
 *  @returns {string|null} the version the previous run recorded */
export function noteSdkVersionRun() {
    const f = versionFile();
    if (!f) return null;
    let previous = null;
    try {
        previous = JSON.parse(readFileSync(f, 'utf8')).version ?? null;
    } catch { /* first run */ }
    if (previous && previous !== SDK_VERSION) {
        console.log(`${PLUGIN_TAG} 组件更新了（SDK ${previous} → ${SDK_VERSION}），这一轮多写一次缓存`);
    }
    try {
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, JSON.stringify({ version: SDK_VERSION }));
    } catch { /* 只读目录：这次没留痕，不影响服务 */ }
    return previous;
}

