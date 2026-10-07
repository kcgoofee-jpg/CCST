// ──────────────────────────────────────────────
// Every SillyTavern event the panel listens to, in one place. The order of registration is the order
// the handlers run in, so it is kept as it always was. Handlers of optional features go through the
// registry (F): a feature that didn't load is simply skipped.
// ──────────────────────────────────────────────

import { F } from './registry.js';
import { isReplyEvent, recovery } from './replies.js';
import { onSettingsReady, noteActivatedLore, resetActivatedLore } from './inject.js';
import { connectionInfo } from './connection.js';
import { refreshStats, refreshQuota } from './live.js';
import { makeStatsAfterReply } from './stats-after-reply.js';
import { store } from './store.js';
import { renderConnect, renderGlance } from '../shell.js';
import { clearOneShotEffort, syncAlwaysThinks } from '../tabs/reason.js';
import { renderCacheCard } from '../tabs/status.js';

export function wireEvents({ eventSource, eventTypes }) {
    // Which world info entries fired for this request (the diagnostic report lists them).
    if (eventTypes.GENERATION_STARTED) eventSource.on(eventTypes.GENERATION_STARTED, resetActivatedLore);
    if (eventTypes.WORLD_INFO_ACTIVATED) eventSource.on(eventTypes.WORLD_INFO_ACTIVATED, noteActivatedLore);
    eventSource.on(eventTypes.CHAT_COMPLETION_SETTINGS_READY, onSettingsReady);
    // Keep stats fresh while the panel is open.
    const refreshAfterReply = makeStatsAfterReply({ refresh: refreshStats, getStats: () => store.get().stats, canRun: () => !!document.getElementById('claude_max_stats') });
    if (eventTypes.GENERATION_ENDED) eventSource.on(eventTypes.GENERATION_ENDED, () => refreshAfterReply());
    const refreshIfOpen = () => {
        const box = document.getElementById('claude_max_stats');
        if (box && box.offsetParent !== null) setTimeout(refreshStats, 500);
    };
    // Greetings (first_message) and /sendas-style messages (command) aren't replies to watch.
    const onOwnReply = (fn) => (id, type) => { if (isReplyEvent(type) && !recovery.emitting) fn(id, type); };
    eventSource.on(eventTypes.MESSAGE_RECEIVED, onOwnReply(clearOneShotEffort));
    eventSource.on(eventTypes.MESSAGE_RECEIVED, (id, type) => F.keeper.onReplyReceived(id, type));
    eventSource.on(eventTypes.CHAT_CHANGED, () => { setTimeout(() => F.keeper.recoverKeptReply(), 1500); });
    if (eventTypes.STREAM_TOKEN_RECEIVED) eventSource.on(eventTypes.STREAM_TOKEN_RECEIVED, (...a) => F.keeper.markPendingFloor(...a));
    if (eventTypes.GENERATION_STOPPED) eventSource.on(eventTypes.GENERATION_STOPPED, (...a) => F.keeper.onGenerationStopped(...a));
    if (eventTypes.GENERATION_ENDED) eventSource.on(eventTypes.GENERATION_ENDED, () => F.keeper.onGenerationEnded());
    if (eventTypes.MESSAGE_EDITED) eventSource.on(eventTypes.MESSAGE_EDITED, (...a) => F.keeper.onMessageEdited(...a));
    if (eventTypes.MESSAGE_DELETED) eventSource.on(eventTypes.MESSAGE_DELETED, (...a) => F.keeper.onMessageDeleted(...a));
    eventSource.on(eventTypes.CHAT_CHANGED, () => setTimeout(() => F.lore.refreshLoreBox(), 200));
    // Model / API switches: keep the header summary and connect button current.
    for (const ev of [eventTypes.CHATCOMPLETION_MODEL_CHANGED, eventTypes.CHATCOMPLETION_SOURCE_CHANGED, eventTypes.MAIN_API_CHANGED, eventTypes.SETTINGS_UPDATED]) {
        if (ev) eventSource.on(ev, () => setTimeout(() => { renderConnect(); renderGlance(); renderCacheCard(); F.models.modelRowFollowsSource(); syncAlwaysThinks(); }, 100));
    }
    for (const ev of [eventTypes.CHATCOMPLETION_SOURCE_CHANGED, eventTypes.APP_READY]) {
        if (ev) eventSource.on(ev, () => setTimeout(() => F.models.fillMissingClaudeModels(), 300));
    }
    eventSource.on(eventTypes.MESSAGE_RECEIVED, refreshIfOpen);
    eventSource.on(eventTypes.MESSAGE_RECEIVED, onOwnReply(() => refreshAfterReply()));
    // The quota is read after each reply (live.js keeps the 60 s gap and the backoff), not on opening.
    // Only when this chat talks to our proxy: elsewhere the subscription's 5h window says nothing.
    eventSource.on(eventTypes.MESSAGE_RECEIVED, onOwnReply(() => { if (connectionInfo().connected) setTimeout(() => refreshQuota(), 1500); }));
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED ?? eventTypes.MESSAGE_RECEIVED, onOwnReply(() => setTimeout(() => F.notice.noticeLastTurn(), 400)));
    eventSource.on(eventTypes.CHAT_CHANGED, refreshIfOpen);
    eventSource.on(eventTypes.OAI_PRESET_CHANGED_AFTER, () => F.presets.applyPresetRecommendation());
    if (eventTypes.CHATCOMPLETION_MODEL_CHANGED) eventSource.on(eventTypes.CHATCOMPLETION_MODEL_CHANGED, () => setTimeout(() => F.presets.applyModelProfile(), 150));
    const genStartEvent = eventTypes.GENERATION_AFTER_COMMANDS ?? eventTypes.GENERATION_STARTED;
    if (genStartEvent) eventSource.on(genStartEvent, (...a) => F.progress.genStart(...a));
    if (eventTypes.STREAM_TOKEN_RECEIVED) eventSource.on(eventTypes.STREAM_TOKEN_RECEIVED, (...a) => F.progress.genToken(...a));
    eventSource.on(eventTypes.MESSAGE_RECEIVED, onOwnReply(() => setTimeout(() => F.progress.genEnd(), 50)));
    if (eventTypes.GENERATION_STOPPED) eventSource.on(eventTypes.GENERATION_STOPPED, () => F.progress.genStopped());
    if (eventTypes.GENERATION_ENDED) eventSource.on(eventTypes.GENERATION_ENDED, () => setTimeout(() => F.progress.genEnd(), 100));
    if (eventTypes.APP_READY) eventSource.on(eventTypes.APP_READY, () => F.presets.adoptUnrecordedReco());
    // After a sync or a fresh start the preset may already be one with a per-model profile: apply it once.
    if (eventTypes.APP_READY) eventSource.on(eventTypes.APP_READY, () => setTimeout(() => F.presets.applyModelProfile(), 1500));
}
