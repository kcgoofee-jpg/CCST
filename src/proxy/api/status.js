// ──────────────────────────────────────────────
// /status handler — SDK availability + credential health
// ──────────────────────────────────────────────
//
// Cheap, no-query status: does the SDK import, which version is it, and does
// a subscription credential exist / look unexpired. A real query is the only
// way to fully verify auth (the CLI may refresh a stale token itself), so
// `credential.expired: true` is a warning, not a verdict.

import { rateLimitSnapshot } from '../features/rate-limit.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SDK_VERSION } from '../features/sdk-version.js';
import { credentialSummary } from '../features/oauth.js';
import { ROOT } from '../paths.js';
import { resolveBackendConfig } from '../features/backend-config.js';
import { BACKEND_LABELS } from '../../shared/backends.js';
import { checkSdkCompat, loadSdk } from '../core/sdk-loader.js';
import { foldStreak } from '../core/chat.js';
import { localEndpoint } from './listener.js';

let cachedPluginVersion = null;
function getPluginVersion() {
    if (cachedPluginVersion) return cachedPluginVersion;
    try {
        const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
        cachedPluginVersion = pkg.version || '0.0.0';
    } catch {
        cachedPluginVersion = '0.0.0';
    }
    return cachedPluginVersion;
}

/** 代理是怎么启动的：从请求走的入口看（酒馆插件挂在 /api/plugins/ 下），不探测环境。 */
function runtimeOf(req) {
    return String(req?.originalUrl ?? '').startsWith('/api/plugins/') ? 'plugin' : 'standalone';
}

export async function handleStatus(req, res) {
    const start = Date.now();
    const version = getPluginVersion();
    try {
        const sdk = await loadSdk();
        return res.json({
            ok: true,
            plugin: 'claude-subscription',
            version,
            // 面板靠它给「版本不一致」写对更新步骤：plugin = 装成酒馆插件，standalone = 单独运行
            runtime: runtimeOf(req),
            // 启动器按端口关代理时用来确认「这就是代理」（Termux 没有 lsof 时只能靠它）
            pid: process.pid,
            sdk: 'loaded',
            sdkVersion: SDK_VERSION,
            // 代理要用的 SDK 导出还在不在（SDK 换了版本改名时这里是 false）
            compat: checkSdkCompat(sdk),
            // 连续多少轮没能用上逐轮还原（超过 3 轮面板会提示）
            foldStreak: foldStreak(),
            // 这个进程实际在听的本机地址（面板用它核对设置里的端点，#36）
            endpoint: localEndpoint(),
            credential: credentialSummary(),
            // 最近一次回复里 CLI 报的各额度窗口状态（还没回复过则为空）
            rateLimit: rateLimitSnapshot(),
            // Name only; fields and secrets are at /v1/backend.
            backend: (({ backend }) => ({ id: backend, label: BACKEND_LABELS[backend] }))(resolveBackendConfig()),
            note: 'Credential expiry is advisory — the CLI can refresh a stale token on the next chat.',
            latencyMs: Date.now() - start,
        });
    } catch (err) {
        return res.status(503).json({
            ok: false,
            plugin: 'claude-subscription',
            version,
            sdk: 'unavailable',
            message: err instanceof Error ? err.message : String(err),
            latencyMs: Date.now() - start,
        });
    }
}
