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

const PLUGIN_TAG = '[claude-subscription]';

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

export const SDK_VERSION = detectSdkVersion();

// ── Startup trace (#30) ──
//
// Cache and transcript problems after an SDK update are near-impossible to
// diagnose afterwards, so the version this process runs on is kept on disk and
// a change is logged.

function versionFile() {
    if (process.env.NODE_TEST_CONTEXT && !process.env.CLAUDE_SUBSCRIPTION_SDK_VERSION_FILE) return null;
    return process.env.CLAUDE_SUBSCRIPTION_SDK_VERSION_FILE || join(DATA_DIR, 'sdk-version.json');
}

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
        console.log(`${PLUGIN_TAG} SDK 已从 ${previous} 变为 ${SDK_VERSION}（缓存和逐轮还原这次会全量重写一轮）`);
    }
    try {
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, JSON.stringify({ version: SDK_VERSION }));
    } catch { /* 只读目录：这次没留痕，不影响服务 */ }
    return previous;
}

