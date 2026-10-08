// ──────────────────────────────────────────────
// Start-up sequence: the callbacks for the optional shared helpers, subscribing the drawing to the
// store, building the panel, the heartbeat, and the SillyTavern events.
// ──────────────────────────────────────────────

import { getSettings } from './settings.js';
import { IS_TAURI } from './capabilities.js';
import { F, loadedFeatures } from './registry.js';
import { refreshAll, refreshStatus, startHeartbeat, heartbeat } from './live.js';
import { wireEvents } from './events.js';
import { initShell, renderConnect, addExtensionSettings } from '../shell.js';
import { init as initStatusTab } from '../tabs/status.js';
import { init as initSettingsTab } from '../tabs/settings.js';

// 审: 每个可选共享库加载完成后要做的事（重画对应卡片）；index.js 传给 loadLibs。
/** What to do when each optional shared helper (src/shared/) has finished loading. */
export const libHooks = {
    chatCheck: () => F.checkup.renderLatestFlags(),
    presetReco: () => F.presets.adoptUnrecordedReco(),
    hostCheck: () => renderConnect(),
    sources: () => {
        refreshAll();
    },
};

// 审: 启动序列的唯一入口：建壳与两个标签页、初始化各功能、挂载进酒馆扩展设置、开心跳、接事件。
export function boot() {
    const { eventSource, eventTypes } = SillyTavern.getContext();

    // Drawing follows the store; each feature (registered by the bootstrap) subscribes its own.
    initShell();
    initStatusTab();
    initSettingsTab();
    for (const name of loadedFeatures()) F[name].init?.();

    const settings = getSettings();
    // ST fills #extensions_settings during its own start-up: wait for it
    // rather than dumping the panel into <body>.
    if (!addExtensionSettings(settings)) {
        let tries = 0;
        // 审: 酒馆还没渲染出 #extensions_settings 时的重试：每 0.5 秒或 APP_READY 再挂一次，挂上后补一次状态检测。
        const retry = () => {
            if (document.querySelector('.inline-drawer.claude-max')) return true;
            if (!addExtensionSettings(getSettings())) return false;
            refreshStatus();
            return true;
        };
        // 审: 最多轮询 120 次（约 1 分钟），挂上或超时就停，避免永远轮询。
        const poll = setInterval(() => { if (retry() || ++tries > 120) clearInterval(poll); }, 500);
        if (eventTypes.APP_READY) eventSource.on(eventTypes.APP_READY, retry);
    }
    refreshStatus();
    startHeartbeat();
    // 审: 手机 App 从后台回来立刻检测代理并尝试补回丢失的回复（不等下一次心跳）。
    // Phone app back from the background: check right away, not up to 20 s later.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { heartbeat(); setTimeout(() => F.keeper.recoverKeptReply(), 1500); } });
    wireEvents({ eventSource, eventTypes });
    console.log(`[claude-max] UI extension loaded${IS_TAURI ? ' (TauriTavern mode)' : ''}`);
}
