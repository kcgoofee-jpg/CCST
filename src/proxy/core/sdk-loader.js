// ──────────────────────────────────────────────
// Lazy import wrapper for @anthropic-ai/claude-agent-sdk
// ──────────────────────────────────────────────
//
// The SDK is heavy; keeping the import behind a cached promise avoids loading
// it until the first chat request. On failure the cache is cleared so the
// next request retries the import.
//
// NOTE on 0.2+ installs: the Claude Code CLI ships INSIDE the SDK as
// per-platform optionalDependencies (@anthropic-ai/claude-agent-sdk-win32-x64
// etc.). If npm installed with --omit=optional, the import succeeds but
// query() throws "Native CLI binary for <platform>-<arch> not found" — the
// fix is reinstalling without --omit=optional (or setting
// CLAUDE_SUBSCRIPTION_CLAUDE_PATH to a claude executable), NOT installing
// claude-code globally.

// 审: SDK 模块的缓存 promise；首次聊天才加载，失败时清空让下次重试。
let cachedSdk = null;

// 审: 代理实际调用的 SDK 导出清单；SDK 改名时 /status 的 compat 靠它报警，否则缓存静默失效。
/** What the proxy actually calls on the SDK. A version that renamed one of
 *  these is not compatible, and the failure would be silent (option ignored,
 *  no resume) — so it is checked at startup instead. */
export const REQUIRED_EXPORTS = ['query', 'SYSTEM_PROMPT_DYNAMIC_BOUNDARY', 'deleteSession'];

// 审: 检查已加载的 SDK 是否有 REQUIRED_EXPORTS 里的全部导出；/status 用。
/** @returns {{ ok: boolean, missing: string[] }} */
export function checkSdkCompat(sdk) {
    const missing = REQUIRED_EXPORTS.filter((name) => sdk?.[name] === undefined);
    return { ok: missing.length === 0, missing };
}

// 审: 懒加载 SDK（带缓存），聊天 / 状态 / 清理会话记录都从这里拿 SDK。
export function loadSdk() {
    if (!cachedSdk) {
        cachedSdk = import('@anthropic-ai/claude-agent-sdk').catch((err) => {
            cachedSdk = null;
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(
                '没能加载 Claude SDK（@anthropic-ai/claude-agent-sdk）。在 SillyTavern/plugins/CCST 文件夹里运行 npm install（不要加 --omit=optional），' +
                `然后重启酒馆，并确认这台电脑上登录过一次 Claude。底层错误：${msg}`,
            );
        });
    }
    return cachedSdk;
}

// 审: 测试接缝：塞入假 SDK 或清空缓存。
// Test seam — replace the cached SDK module with a fake or clear it.
export function __setSdkForTesting(mod) {
    cachedSdk = mod ? Promise.resolve(mod) : null;
}
