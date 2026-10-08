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

// 审: 面板监听的全部酒馆事件集中在此；注册顺序即处理顺序，不要调换；可选功能经 F 调用，没加载就跳过。
export function wireEvents({ eventSource, eventTypes }) {
    // 审: 每轮开始清空上轮触发的世界书记录，之后 WORLD_INFO_ACTIVATED 再记本轮的（注入给代理用）。
    // Which world info entries fired for this request (the diagnostic report lists them).
    if (eventTypes.GENERATION_STARTED) eventSource.on(eventTypes.GENERATION_STARTED, resetActivatedLore);
    if (eventTypes.WORLD_INFO_ACTIVATED) eventSource.on(eventTypes.WORLD_INFO_ACTIVATED, noteActivatedLore);
    // 审: 请求发出前注入 custom_include_body——整个面板与代理协作的核心触发点。
    eventSource.on(eventTypes.CHAT_COMPLETION_SETTINGS_READY, onSettingsReady);
    // 审: 回复结束后刷新用量（代理在流关闭时才写记录，可能晚于酒馆事件，所以带延迟与重读）；面板没建好时不跑。
    // Keep stats fresh while the panel is open.
    const refreshAfterReply = makeStatsAfterReply({ refresh: refreshStats, getStats: () => store.get().stats, canRun: () => !!document.getElementById('claude_max_stats') });
    if (eventTypes.GENERATION_ENDED) eventSource.on(eventTypes.GENERATION_ENDED, () => refreshAfterReply());
    // 审: 切聊天时若用量卡片可见就刷新，隐藏的面板不发请求。
    const refreshIfOpen = () => {
        const box = document.getElementById('claude_max_stats');
        if (box && box.offsetParent !== null) setTimeout(refreshStats, 500);
    };
    // 审: 只响应真实回复（排除开场白/斜杠命令）且不是自己补回回复时重发的事件。
    // Greetings (first_message) and /sendas-style messages (command) aren't replies to watch.
    const onOwnReply = (fn) => (id, type) => { if (isReplyEvent(type) && !recovery.emitting) fn(id, type); };
    // 审: 回复保管（reply-keeper）的各个事件：收到回复/切聊天/流式首 token/停止/结束/编辑/删除。
    eventSource.on(eventTypes.MESSAGE_RECEIVED, (id, type) => F.keeper.onReplyReceived(id, type));
    eventSource.on(eventTypes.CHAT_CHANGED, () => { setTimeout(() => F.keeper.recoverKeptReply(), 1500); });
    if (eventTypes.STREAM_TOKEN_RECEIVED) eventSource.on(eventTypes.STREAM_TOKEN_RECEIVED, (...a) => F.keeper.markPendingFloor(...a));
    if (eventTypes.GENERATION_STOPPED) eventSource.on(eventTypes.GENERATION_STOPPED, (...a) => F.keeper.onGenerationStopped(...a));
    if (eventTypes.GENERATION_ENDED) eventSource.on(eventTypes.GENERATION_ENDED, () => F.keeper.onGenerationEnded());
    if (eventTypes.MESSAGE_EDITED) eventSource.on(eventTypes.MESSAGE_EDITED, (...a) => F.keeper.onMessageEdited(...a));
    if (eventTypes.MESSAGE_DELETED) eventSource.on(eventTypes.MESSAGE_DELETED, (...a) => F.keeper.onMessageDeleted(...a));
    // 审: 模型/来源/API/设置变了就重画连接按钮和顶栏摘要（延迟 100ms 等酒馆先写完设置）。
    // Model / API switches: keep the header summary and connect button current.
    for (const ev of [eventTypes.CHATCOMPLETION_MODEL_CHANGED, eventTypes.CHATCOMPLETION_SOURCE_CHANGED, eventTypes.MAIN_API_CHANGED, eventTypes.SETTINGS_UPDATED]) {
        if (ev) eventSource.on(ev, () => setTimeout(() => { renderConnect(); renderGlance(); }, 100));
    }
    eventSource.on(eventTypes.MESSAGE_RECEIVED, onOwnReply(() => refreshAfterReply()));
    // 审: 回复后读额度（只在连着本代理时；live.js 管 60 秒间隔和退避）。
    // The quota is read after each reply (live.js keeps the 60 s gap and the backoff), not on opening.
    // Only when this chat talks to our proxy: elsewhere the subscription's 5h window says nothing.
    eventSource.on(eventTypes.MESSAGE_RECEIVED, onOwnReply(() => { if (connectionInfo().connected) setTimeout(() => refreshQuota(), 1500); }));
    // 审: 回复渲染完后提示代理实际给了什么（换模型/被拦/写满等）；老版本酒馆没有该事件就退回 MESSAGE_RECEIVED。
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED ?? eventTypes.MESSAGE_RECEIVED, onOwnReply(() => setTimeout(() => F.notice.noticeLastTurn(), 400)));
    eventSource.on(eventTypes.CHAT_CHANGED, refreshIfOpen);
    // 审: 切预设后应用预设自带的推荐设置并更新顶栏。
    eventSource.on(eventTypes.OAI_PRESET_CHANGED_AFTER, () => { F.presets.applyPresetRecommendation(); renderGlance(); });
    // 审: 推理强度改了酒馆不发事件，只能监听控件本身来更新顶栏。
    // 推理强度 is shown in the header; SillyTavern raises no event when it changes.
    globalThis.jQuery?.(document).on('input change', '#openai_reasoning_effort', () => setTimeout(renderGlance, 50));
    // 审: 换模型后应用预设里按模型的条目开关。
    if (eventTypes.CHATCOMPLETION_MODEL_CHANGED) eventSource.on(eventTypes.CHATCOMPLETION_MODEL_CHANGED, () => setTimeout(() => F.presets.applyModelProfile(), 150));
    // 审: 生成进度从 GENERATION_AFTER_COMMANDS 起算（斜杠命令接管时 GENERATION_STARTED 也会触发但并没生成）。
    const genStartEvent = eventTypes.GENERATION_AFTER_COMMANDS ?? eventTypes.GENERATION_STARTED;
    if (genStartEvent) eventSource.on(genStartEvent, (...a) => F.progress.genStart(...a));
    if (eventTypes.STREAM_TOKEN_RECEIVED) eventSource.on(eventTypes.STREAM_TOKEN_RECEIVED, (...a) => F.progress.genToken(...a));
    // 审: 生成进度的结束有三路兜底（收到回复/停止/GENERATION_ENDED），genEnd 内部幂等。
    eventSource.on(eventTypes.MESSAGE_RECEIVED, onOwnReply(() => setTimeout(() => F.progress.genEnd(), 50)));
    if (eventTypes.GENERATION_STOPPED) eventSource.on(eventTypes.GENERATION_STOPPED, () => F.progress.genStopped());
    if (eventTypes.GENERATION_ENDED) eventSource.on(eventTypes.GENERATION_ENDED, () => setTimeout(() => F.progress.genEnd(), 100));
    // 审: 酒馆启动完成后收编旧版本留下的未记录推荐，并对当前预设应用一次按模型条目。
    if (eventTypes.APP_READY) eventSource.on(eventTypes.APP_READY, () => F.presets.adoptUnrecordedReco());
    // After a sync or a fresh start the preset may already be one with a per-model profile: apply it once.
    if (eventTypes.APP_READY) eventSource.on(eventTypes.APP_READY, () => setTimeout(() => F.presets.applyModelProfile(), 1500));
}
