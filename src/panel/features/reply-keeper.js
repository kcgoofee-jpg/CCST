// ──────────────────────────────────────────────
// Reply keeper client (proxy side: src/proxy/features/reply-keeper.js)
// ──────────────────────────────────────────────

import { fetchProxy } from '../core/proxy.js';
import { fnv64 } from '../core/chat-key.js';
import { connectionInfo } from '../core/connection.js';
import { generating } from '../core/st.js';
import { notify } from '../core/notify.js';
import { isReplyEvent, recovery } from '../core/replies.js';

// ── Reply keeper (lib/reply-keeper.js) ──
// Each chat reply carries a slot: a hash of the chat, the floor the reply
// goes to, its swipe and the player's message (no text). The proxy keeps
// the finished reply under it, in memory. A floor is filled back in only
// when the app lost the reply: the floor is empty / "..." or still carries
// the pending mark set while it was being written (the stream broke), or
// the app died before saving it (the chat ends with the player's message).
// A reply the player stopped, edited or deleted is final: never touched.

// 审: 回复槽位：聊天键+楼层+swipe+上一条玩家消息的哈希，不含明文；代理按它保管完整回复。
/** Slot of the reply at chat[floor] (swipe `swipeId`): chat, floor, swipe, the player's message before it. */
function slotFor(ctx, floor, swipeId = 0) {
    const chat = ctx.chat ?? [];
    for (let i = Math.min(floor, chat.length) - 1; i >= 0; i--) {
        const m = chat[i];
        if (m?.is_user) return fnv64(`${ctx.chatId ?? ''}\u0000${floor}\u0000${swipeId}\u0000${m.mes ?? ''}`);
    }
    return null;
}

// 审: 请求发出时调用（inject.js）：算出本次回复的槽位并登记在途回复；quiet/impersonate/continue 不保管。
/** Called as a chat request goes out (core/inject.js): the slot the reply will be kept under, or null. */
export function openSlot(data) {
    // A swipe rewrites the last floor under a new swipe id; everything else writes a new floor.
    if (['quiet', 'impersonate', 'continue'].includes(data.type)) return null;
    const ctx = SillyTavern.getContext();
    const chat = ctx.chat ?? [];
    const swipe = data.type === 'swipe' && chat.length > 0 && !chat.at(-1).is_user;
    const floor = swipe ? chat.length - 1 : chat.length;
    const slot = slotFor(ctx, floor, swipe ? (chat[floor].swipe_id ?? 0) : 0);
    if (slot) {
        inflight = { slot, chatId: ctx.chatId, floor };
        unmarkFinal(slot);
    }
    return slot;
}

// 审: 当前在途的聊天回复（槽位、楼层、是否已标记待定/已停止/已完成）。
// The chat reply in flight (set when its request goes out).
let inflight = null; // { slot, chatId, floor, marked, stopped, done }

// 审: 该槽位是否被玩家定稿（停止/编辑/删除后）——定稿的回复永不补回。
// Final slots live in the chat's metadata (saved with the chat).
function isFinal(ctx, slot) {
    return (ctx.chatMetadata?.cm_final_slots ?? []).includes(slot);
}
// 审: 把槽位记为定稿，存在聊天元数据里，最多留 30 个。
function markFinal(slot) {
    const ctx = SillyTavern.getContext();
    if (!slot || !ctx.chatMetadata) return;
    const list = (ctx.chatMetadata.cm_final_slots ?? []).filter((s) => s !== slot);
    list.push(slot);
    ctx.chatMetadata.cm_final_slots = list.slice(-30);
    ctx.saveMetadataDebounced?.();
}
// 审: 新请求用同一槽位（重新生成）时取消定稿标记。
function unmarkFinal(slot) {
    const meta = SillyTavern.getContext().chatMetadata;
    if (meta?.cm_final_slots?.includes(slot)) meta.cm_final_slots = meta.cm_final_slots.filter((s) => s !== slot);
}
// 审: 去掉楼层上的「待定」标记（回复已完整）。
function clearPending(m) {
    if (m?.extra) delete m.extra.cm_pending;
    const info = Array.isArray(m?.swipe_info) ? m.swipe_info[m.swipe_id] : null;
    if (info?.extra) delete info.extra.cm_pending;
}

// 审: 第一个流式 token 到达、占位楼层出现时，给它打「待定」标记；流断了标记留着以便之后补回。
// First streamed token: the placeholder floor exists — mark it pending.
export function markPendingFloor() {
    if (!inflight || inflight.marked || inflight.done) return;
    const ctx = SillyTavern.getContext();
    const m = ctx.chat?.[inflight.floor];
    if (ctx.chatId !== inflight.chatId || !m || m.is_user || inflight.floor !== ctx.chat.length - 1) return;
    m.extra = { ...(m.extra ?? {}), cm_pending: inflight.slot };
    inflight.marked = true;
}

// 审: 收到回复：流没断就清待定标记，断了保留标记；并标记在途回复已完成。
// The reply arrived: it is complete unless the stream broke (then the
// mark stays so the kept reply can fill it in later).
export function onReplyReceived(id, type) {
    if (!inflight || !isReplyEvent(type) || recovery.emitting) return;
    const ctx = SillyTavern.getContext();
    const broke = !!ctx.streamingProcessor?.isStopped && !inflight.stopped;
    if (!broke) clearPending(ctx.chat?.[id]);
    inflight.done = true;
}

// 审: 用户按了停止：该楼层定稿，并让代理取消并丢弃这条回复。
// Stop pressed: the proxy aborts that reply and forgets it; the floor is final.
export function onGenerationStopped() {
    if (!inflight || inflight.done || inflight.stopped) return;
    inflight.stopped = true;
    markFinal(inflight.slot);
    fetchProxy(`/reply/${inflight.slot}/cancel`, `/v1/replies/${inflight.slot}/cancel`, { method: 'POST' }).catch(() => { /* proxy gone: nothing to cancel */ });
}

// 审: 玩家编辑了回复：视为定稿，不再补回。
// The player edited a reply (trimmed it, rewrote it): final.
export function onMessageEdited(id) {
    const ctx = SillyTavern.getContext();
    const m = ctx.chat?.[id];
    if (!m || m.is_user || m.is_system) return;
    clearPending(m);
    markFinal(slotFor(ctx, Number(id), m.swipe_id ?? 0));
}

// 审: 玩家删了回复、最后一条是自己的消息：视为定稿，别把它找回来。
// The player deleted the reply and left their own message last: don't bring it back.
export function onMessageDeleted() {
    const ctx = SillyTavern.getContext();
    const chat = ctx.chat ?? [];
    if (chat.at(-1)?.is_user) markFinal(slotFor(ctx, chat.length, 0));
}

// 审: GENERATION_ENDED 一秒后视为回复完成（MESSAGE_RECEIVED 没触发时的兜底）。
/** GENERATION_ENDED: the reply is complete a second later, whether or not MESSAGE_RECEIVED said so. */
export function onGenerationEnded() {
    const f = inflight;
    setTimeout(() => { if (f) f.done = true; }, 1000);
}

// 审: 补回回复后向其他扩展（MVU、酒馆助手等）按酒馆自己的顺序发事件；recovery 标志让我们自己的监听跳过。
/** Tell other extensions (MVU, 酒馆助手…) about a recovered reply the way ST does after a reply; our own listeners skip it. */
async function emitRecovered(id, render) {
    const { eventSource: es, eventTypes: et } = SillyTavern.getContext();
    recovery.emitting = true;
    try {
        await es.emit(et.MESSAGE_RECEIVED, id, 'normal');
        render();
        await es.emit(et.CHARACTER_MESSAGE_RENDERED, id, 'normal');
    } finally {
        recovery.emitting = false;
    }
}

// 审: 补回流程的互斥锁。
let recovering = false;
// 审: 切回前台/切聊天/代理恢复时调用：若楼层空、「...」或带待定标记（流断了），或应用在保存前挂了（最后是玩家消息），就从代理取回完整回复补上。
export async function recoverKeptReply() {
    if (recovering || generating() || !connectionInfo().connected) return;
    const ctx = SillyTavern.getContext();
    const chat = ctx.chat ?? [];
    const len = chat.length;
    const last = chat[len - 1];
    if (!last || last.is_system) return;
    if (ctx.streamingProcessor && !ctx.streamingProcessor.isFinished) return; // still being written
    // 审: 应用在存盘前死掉时最后一条是玩家消息，此时新增楼层（群聊不做，因为不知道哪个角色说的）。
    // The app died before ST saved the reply's floor: append it (not in group chats: which member spoke is unknown).
    const append = !!last.is_user;
    if (append ? !!ctx.groupId : len < 2) return;
    const floor = append ? len : len - 1;
    const slot = slotFor(ctx, floor, append ? 0 : (last.swipe_id ?? 0));
    if (!slot || isFinal(ctx, slot)) return;
    const now = append ? '' : String(last.mes ?? '').trim();
    const empty = !now || now === '...';
    if (!append && !empty && last.extra?.cm_pending !== slot) return; // a finished reply: leave it
    recovering = true;
    try {
        const res = await fetchProxy(`/reply/${slot}`, `/v1/replies/${slot}`);
        if (!res.ok) return;
        const kept = await res.json();
        const text = String(kept?.text ?? '');
        if (!text) return;
        const c = SillyTavern.getContext();
        // Chat switched, grew, or the player acted meanwhile.
        if (c.chatId !== ctx.chatId || c.chat !== chat || chat.length !== len || chat[len - 1] !== last || generating() || isFinal(c, slot)) return;
        if (!append && !empty && !(text.length > now.length && text.startsWith(now.slice(0, 40)))) {
            if (text.trim() === now) clearPending(last); // it was complete after all
            return;
        }
        const at = new Date(Number.isFinite(kept.at) ? kept.at : Date.now()).toISOString();
        if (append) {
            const extra = { api: 'custom', model: c.chatCompletionSettings?.custom_model ?? '', reasoning: kept.reasoning ?? '', reasoning_duration: null };
            const msg = {
                name: c.name2, is_user: false, is_system: false, send_date: at, mes: text, title: '', extra,
                gen_started: at, gen_finished: at, swipe_id: 0, swipes: [text],
                swipe_info: [{ send_date: at, gen_started: at, gen_finished: at, extra: structuredClone(extra) }],
            };
            chat.push(msg);
            await emitRecovered(len, () => c.addOneMessage?.(msg));
        } else {
            last.mes = text;
            if (Array.isArray(last.swipes) && Number.isInteger(last.swipe_id)) last.swipes[last.swipe_id] = text;
            last.extra = { ...(last.extra ?? {}), ...(kept.reasoning ? { reasoning: kept.reasoning } : {}) };
            delete last.extra.cm_pending;
            last.gen_finished = at;
            const info = Array.isArray(last.swipe_info) ? last.swipe_info[last.swipe_id] : null;
            if (info && typeof info === 'object') {
                info.gen_finished = at;
                info.extra = structuredClone(last.extra);
            }
            await emitRecovered(len - 1, () => c.updateMessageBlock?.(len - 1, last));
        }
        await c.saveChat?.();
        notify('ok', '已补回', `第 ${floor} 楼没存上，已找回`, { ms: 8000 });
    } catch { /* proxy unreachable: try again next time */ } finally {
        recovering = false;
    }
}
