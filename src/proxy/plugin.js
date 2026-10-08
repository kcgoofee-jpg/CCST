// ──────────────────────────────────────────────
// SillyTavern Server Plugin — Claude (Subscription) Proxy v2
// ──────────────────────────────────────────────
//
// Exposes an OpenAI-compatible chat-completions API backed by the local
// Claude Agent SDK, billing against an Anthropic Pro/Max subscription. The
// chat endpoints run on a *separate* HTTP listener (default 127.0.0.1:8901)
// so they sit outside SillyTavern's CSRF middleware — see api/listener.js.
//
// v2 additions:
//   • Companion UI extension ("CCST") is auto-installed/updated into
//     SillyTavern's third-party extensions on startup — it provides one-click
//     connection (no URL typing), Claude-native reasoning-effort control
//     (low/medium/high/xhigh/max), thinking display, and a quota meter.
//   • Fable 5.1 / Opus 5 / explicit "(1M context)" model variants.
//   • Synthetic-session resume (real multi-turn context + prompt caching).
//   • OAuth auto-refresh, rate-limit retries, Extra-Usage fallback.
//
// Env overrides:
//   CLAUDE_SUBSCRIPTION_PORT=8901       listener port
//   CLAUDE_SUBSCRIPTION_HOST=127.0.0.1  listener host
//   CLAUDE_SUBSCRIPTION_USE_RESUME=0    force the v1 transcript-fold path
//   CLAUDE_SUBSCRIPTION_MAX_TURNS=N     SDK maxTurns override (default 1)
//   CLAUDE_SUBSCRIPTION_CLAUDE_PATH=…   explicit claude executable
//   CLAUDE_SUBSCRIPTION_NO_UI_INSTALL=1 skip the UI-extension auto-install
//   CLAUDE_SUBSCRIPTION_CONTEXT_PIN_FILE=…|off  CLI context pin file (off = memory only)

import './features/diag-log.js'; // first: keep the proxy's log lines for the diagnostics report
import express from 'express';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { registerRoutes } from './api/routes.js';
import { startStandaloneListener, stopStandaloneListener, probeExistingProxy, portInUseMessage } from './api/listener.js';
import { startSharing, stopSharing } from './api/shared-proxy.js';
import { markPluginHosted } from './api/status.js';
import { noteSdkVersionRun } from './features/sdk-version.js';
import { ROOT } from './paths.js';

// 审: 默认端口 / 地址 / 面板扩展安装目录名；环境变量可覆盖前两个。
const DEFAULT_PORT = 8901;
const DEFAULT_HOST = '127.0.0.1';
const UI_EXTENSION_DIR_NAME = 'CCST';

// 审: 酒馆插件加载器要求的插件信息（id 也是路由前缀 /api/plugins/claude-subscription）。
export const info = {
    id: 'claude-subscription',
    name: 'Claude (Subscription) Proxy',
    description:
        'Routes chat through the local Claude Agent SDK so it bills against your Anthropic Pro / Max ' +
        'subscription instead of an sk-ant-* API key. Fable 5.1 / Opus 5 / 1M context / reasoning ' +
        'effort / thinking display / quota meter. Pairs with the auto-installed "CCST" UI extension.',
};

// 审: 版本比较，自动安装面板时只升级不降级。
/** true if dotted version a is strictly newer than b (numeric compare). */
function isNewerVersion(a, b) {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] ?? 0;
        const y = pb[i] ?? 0;
        if (x !== y) return x > y;
    }
    return false;
}

// The UI extension lives at the REPO ROOT (manifest.json + index.js +
// style.css) so the repo can ALSO be installed directly through
// SillyTavern's "Install extension" dialog, which requires a root
// manifest.json. Only these files make up the extension: the manifest,
// index.js + style.css, and the browser modules index.js imports from lib/
// (keep this list in step with index.js's imports).
// 审: 自动复制进酒馆的面板文件清单；必须与面板实际 import 的文件一致（test/panel-files.test.js 会核对），且保持单行。
const UI_EXTENSION_FILES = ['manifest.json', 'src/panel/index.js', 'src/panel/style.css', 'src/panel/shell.js', 'src/panel/guide.js', 'src/panel/core/boot.js', 'src/panel/core/capabilities.js', 'src/panel/core/connect-help.js', 'src/panel/core/help-items.js', 'src/panel/core/external.js', 'src/panel/core/chat-key.js', 'src/panel/core/connection-profile.js', 'src/panel/core/quota-gate.js', 'src/panel/core/stats-after-reply.js', 'src/panel/core/connection.js', 'src/panel/core/dom.js', 'src/panel/core/events.js', 'src/panel/core/guide.js', 'src/panel/core/inject.js', 'src/panel/core/libs.js', 'src/panel/core/live.js', 'src/panel/core/notify.js', 'src/panel/core/proxy.js', 'src/panel/core/registry.js', 'src/panel/core/replies.js', 'src/panel/core/settings.js', 'src/panel/core/st.js', 'src/panel/core/store.js', 'src/panel/core/tabs.js', 'src/panel/tabs/settings.js', 'src/panel/tabs/status.js', 'src/panel/features/checkup.js', 'src/panel/features/debug-request.js', 'src/panel/features/gen-progress.js', 'src/panel/features/models.js', 'src/panel/features/presets.js', 'src/panel/features/reply-keeper.js', 'src/panel/features/turn-notice.js', 'src/shared/chat-check.js', 'src/shared/preset-reco.js', 'src/shared/host.js', 'src/shared/sources.js', 'installer/CCST安装.bat'];

/**
 * Install or update the companion UI extension into SillyTavern's
 * third-party extensions directory. The plugin runs in-process inside
 * SillyTavern (plugins/<id>/), so the public directory is two levels up.
 * Version-gated: only copies when missing or strictly older — a manually
 * updated (newer) extension is never downgraded.
 *
 * If the user already installed the repo through SillyTavern's "Install
 * extension" dialog (a full clone in third-party, git-managed and updated
 * by ST itself), the auto-install stands down — the extension's runtime
 * window-guard would dedupe anyway, but skipping avoids a confusing
 * second copy.
 */
// 审: 启动时把面板扩展装进 / 更新到酒馆的第三方扩展目录（只升不降、用户自己装的 git 副本不动）；没了用户要手动装面板。
function installUiExtension() {
    if (/^(1|true|yes|on)$/i.test(process.env.CLAUDE_SUBSCRIPTION_NO_UI_INSTALL ?? '')) return;

    try {
        const here = ROOT;
        if (!existsSync(join(here, 'manifest.json'))) return;

        // plugins/<id>/ normally sits two levels under the ST root, but Node
        // resolves symlinks for ESM — a symlinked dev checkout reports its
        // real path. ST always runs with its root as cwd, so try that too.
        const stRoot = [resolve(here, '..', '..'), process.cwd()]
            .find((root) => existsSync(join(root, 'public', 'scripts', 'extensions')));
        const thirdParty = stRoot ? join(stRoot, 'public', 'scripts', 'extensions', 'third-party') : null;
        if (!thirdParty || !existsSync(thirdParty)) {
            console.warn(`[${info.id}] SillyTavern third-party extension dir not found — install the UI extension manually (see README).`);
            return;
        }

        // Dialog-installed clone present? It's git-managed by ST — let it own
        // the extension and skip the auto-copy. The repo was called
        // SillyTavern-ClaudeSubscription, then SillyTavern-ClaudeMax, now CCST;
        // the oldest name was never an auto-install target, so any copy there is
        // the user's own. SillyTavern-ClaudeMax was one (before 3.0): only a git
        // clone there counts, an old auto-copy must not block installing into CCST.
        // 审: 可能存在的「用户用酒馆安装框装的」副本位置（新旧三个仓库名 × 两个扩展目录）。
        const dialogClones = ['SillyTavern-ClaudeSubscription', 'SillyTavern-ClaudeMax', UI_EXTENSION_DIR_NAME].flatMap((name) => [
            join(thirdParty, name),
            join(stRoot, 'data', 'default-user', 'extensions', name),
        ]);
        // 审: 判断某目录是不是用户自己装的（有 .git，或最老的 SillyTavern-ClaudeSubscription 名字）。
        const userOwned = (dir) => existsSync(join(dir, '.git')) || /SillyTavern-ClaudeSubscription$/.test(dir);
        if (dialogClones.some((dir) => existsSync(join(dir, 'manifest.json')) && userOwned(dir))) {
            console.log(`[${info.id}] UI extension already installed via SillyTavern's extension installer — auto-install skipped`);
            return;
        }

        const target = join(thirdParty, UI_EXTENSION_DIR_NAME);
        const srcVersion = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8')).version ?? '0.0.0';
        let installedVersion = null;
        if (existsSync(join(target, 'manifest.json'))) {
            try {
                installedVersion = JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8')).version ?? '0.0.0';
            } catch { /* corrupted manifest → reinstall */ }
        }

        if (installedVersion !== null && !isNewerVersion(srcVersion, installedVersion)) return;

        mkdirSync(target, { recursive: true });
        for (const file of UI_EXTENSION_FILES) {
            mkdirSync(dirname(join(target, file)), { recursive: true });
            cpSync(join(here, file), join(target, file));
        }
        console.log(
            `[${info.id}] ${installedVersion ? `updated UI extension ${installedVersion} → ${srcVersion}` : `installed UI extension v${srcVersion}`} ` +
            `at public/scripts/extensions/third-party/${UI_EXTENSION_DIR_NAME} (hard-refresh the browser to load it)`,
        );
    } catch (err) {
        console.warn(`[${info.id}] UI extension auto-install failed:`, err instanceof Error ? err.message : err);
    }
}

// 审: 酒馆插件入口：挂路由、装面板、起独立监听，端口上已有 CCST 就改为共用。
export async function init(router) {
    markPluginHosted();
    noteSdkVersionRun();
    // SillyTavern-mounted routes (GET is CSRF-exempt): /status for browser
    // health checks, /quota so the UI extension can read quota SAME-ORIGIN —
    // a direct browser fetch to 127.0.0.1:8901 resolves to the CLIENT device
    // and fails whenever SillyTavern is browsed from a phone/another PC.
    router.use(express.json({ limit: '50mb' }));
    // POSTs (/reply/:slot/cancel) go through SillyTavern's CSRF check.
    registerRoutes(router, 'plugin');

    installUiExtension();

    const port = parseInt(process.env.CLAUDE_SUBSCRIPTION_PORT, 10) || DEFAULT_PORT;
    const host = process.env.CLAUDE_SUBSCRIPTION_HOST || DEFAULT_HOST;

    // Probe first: on macOS a standalone proxy bound to 0.0.0.0 does not stop
    // us binding 127.0.0.1 on the same port, and then local requests would go
    // to this copy while the phone talks to the other (seen live: two proxies
    // on 8901, the one inside SillyTavern running older code).
    if (await probeExistingProxy({ port, host })) return share(port, host);
    try {
        await startStandaloneListener({ port, host });
        console.log(
            `[${info.id}] initialised — endpoint http://${host}:${port}/v1 ` +
            '(use the "CCST" panel in the Extensions drawer to connect)',
        );
    } catch (err) {
        if (err?.code === 'EADDRINUSE' && await probeExistingProxy({ port, host })) return share(port, host);
        if (err?.code === 'EADDRINUSE') console.error(portInUseMessage(port));
        console.error(
            `[${info.id}] failed to start standalone listener — chat completions will not work. ` +
            'Status endpoint on /api/plugins/claude-subscription/status remains available.',
            err,
        );
    }
}

// 审: 端口上已有 CCST 时进入共用模式：转发面板路由，对方关了就接管。
/** 端口上已经有一个 CCST（另一个酒馆的，或单独运行的）：共用它，它关了就接管。 */
function share(port, host) {
    console.log(`[${info.id}] 端口 ${port} 上已经有一个 CCST 代理（另一个酒馆的，或单独运行的），这个酒馆共用它；它关掉后这里会自动接管。`);
    startSharing({
        port, host,
        alive: () => probeExistingProxy({ port, host }),
        takeOver: async () => { await startStandaloneListener({ port, host }); return true; },
    });
}

// 审: 酒馆关闭插件时的清理：停共用检查、关监听。
export async function exit() {
    stopSharing();
    await stopStandaloneListener();
    console.log(`[${info.id}] shut down`);
}

// 审: 插件加载器按默认导出读入口。
export default { info, init, exit };
