// ──────────────────────────────────────────────
// Start-up sequence: the callbacks for the optional shared helpers, subscribing the drawing to the
// store, building the panel, the heartbeat, and the SillyTavern events.
// ──────────────────────────────────────────────

import { getSettings } from './settings.js';
import { IS_TAURI } from './capabilities.js';
import { F, loadedFeatures } from './registry.js';
import { refreshAll, refreshStatus, startHeartbeat, heartbeat } from './live.js';
import { wireEvents } from './events.js';
import { initShell, renderConnect, rebuildPanel, addExtensionSettings } from '../shell.js';
import { init as initReasonTab } from '../tabs/reason.js';
import { init as initStatusTab } from '../tabs/status.js';
import { init as initSettingsTab } from '../tabs/settings.js';

/** What to do when each optional shared helper (src/shared/) has finished loading. */
export const libHooks = {
    chatCheck: () => F.checkup.renderLatestFlags(),
    loreConst: () => F.lore.refreshLoreBox(),
    presetReco: () => F.presets.adoptUnrecordedReco(),
    hostCheck: () => renderConnect(),
    sources: () => {
        // The panel may be built already, knowing only two sources: rebuild so the model row shows.
        if (document.querySelector('.inline-drawer.claude-max')) rebuildPanel();
        refreshAll();
        F.models.fillMissingClaudeModels();
    },
};

export function boot() {
    const { eventSource, eventTypes } = SillyTavern.getContext();

    // Drawing follows the store; each feature (registered by the bootstrap) subscribes its own.
    initShell();
    initReasonTab();
    initStatusTab();
    initSettingsTab();
    for (const name of loadedFeatures()) F[name].init?.();

    const settings = getSettings();
    // v2.10 dropped the「附加到请求」switch; nobody should be stuck with it off.
    settings.enabled = true;
    // ST fills #extensions_settings during its own start-up: wait for it
    // rather than dumping the panel into <body>.
    if (!addExtensionSettings(settings)) {
        let tries = 0;
        const retry = () => {
            if (document.querySelector('.inline-drawer.claude-max')) return true;
            if (!addExtensionSettings(getSettings())) return false;
            refreshStatus();
            return true;
        };
        const poll = setInterval(() => { if (retry() || ++tries > 120) clearInterval(poll); }, 500);
        if (eventTypes.APP_READY) eventSource.on(eventTypes.APP_READY, retry);
    }
    refreshStatus();
    startHeartbeat();
    // Phone app back from the background: check right away, not up to 20 s later.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { heartbeat(); setTimeout(() => F.keeper.recoverKeptReply(), 1500); } });
    wireEvents({ eventSource, eventTypes });
    console.log(`[claude-max] UI extension loaded${IS_TAURI ? ' (TauriTavern mode)' : ''}`);
}
