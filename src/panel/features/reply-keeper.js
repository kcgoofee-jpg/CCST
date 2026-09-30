// ──────────────────────────────────────────────
// Reply keeper client (proxy side: src/proxy/reply-keeper.js)
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

/** Slot of the reply at chat[floor] (swipe `swipeId`): chat, floor, swipe, the player's message before it. */
function slotFor(ctx, floor, swipeId = 0) {
    const chat = ctx.chat ?? [];
    for (let i = Math.min(floor, chat.length) - 1; i >= 0; i--) {
        const m = chat[i];
        if (m?.is_user) return fnv64(`${ctx.chatId ?? ''}\u0000${floor}\u0000${swipeId}\u0000${m.mes ?? ''}`);
    }
    return null;
}

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

// The chat reply in flight (set when its request goes out).
let inflight = null; // { slot, chatId, floor, marked, stopped, done }

// Final slots live in the chat's metadata (saved with the chat).
function isFinal(ctx, slot) {
    return (ctx.chatMetadata?.cm_final_slots ?? []).includes(slot);
}
function markFinal(slot, save = true) {
    const ctx = SillyTavern.getContext();
    if (!slot || !ctx.chatMetadata) return;
    const list = (ctx.chatMetadata.cm_final_slots ?? []).filter((s) => s !== slot);
    list.push(slot);
    ctx.chatMetadata.cm_final_slots = list.slice(-30);
    if (save) ctx.saveMetadataDebounced?.();
}
function unmarkFinal(slot) {
    const meta = SillyTavern.getContext().chatMetadata;
    if (meta?.cm_final_slots?.includes(slot)) meta.cm_final_slots = meta.cm_final_slots.filter((s) => s !== slot);
}
function clearPending(m) {
    if (m?.extra) delete m.extra.cm_pending;
    const info = Array.isArray(m?.swipe_info) ? m.swipe_info[m.swipe_id] : null;
    if (info?.extra) delete info.extra.cm_pending;
}

// First streamed token: the placeholder floor exists — mark it pending.
export function markPendingFloor() {
    if (!inflight || inflight.marked || inflight.done) return;
    const ctx = SillyTavern.getContext();
    const m = ctx.chat?.[inflight.floor];
    if (ctx.chatId !== inflight.chatId || !m || m.is_user || inflight.floor !== ctx.chat.length - 1) return;
    m.extra = { ...(m.extra ?? {}), cm_pending: inflight.slot };
    inflight.marked = true;
}

// The reply arrived: it is complete unless the stream broke (then the
// mark stays so the kept reply can fill it in later).
export function onReplyReceived(id, type) {
    if (!inflight || !isReplyEvent(type) || recovery.emitting) return;
    const ctx = SillyTavern.getContext();
    const broke = !!ctx.streamingProcessor?.isStopped && !inflight.stopped;
    if (!broke) clearPending(ctx.chat?.[id]);
    inflight.done = true;
}

// Stop pressed: the proxy aborts that reply and forgets it; the floor is final.
export function onGenerationStopped() {
    if (!inflight || inflight.done || inflight.stopped) return;
    inflight.stopped = true;
    markFinal(inflight.slot);
    fetchProxy(`/reply/${inflight.slot}/cancel`, `/v1/replies/${inflight.slot}/cancel`, { method: 'POST' }).catch(() => { /* proxy gone: nothing to cancel */ });
}

// The player edited a reply (trimmed it, rewrote it): final.
export function onMessageEdited(id) {
    const ctx = SillyTavern.getContext();
    const m = ctx.chat?.[id];
    if (!m || m.is_user || m.is_system) return;
    clearPending(m);
    markFinal(slotFor(ctx, Number(id), m.swipe_id ?? 0));
}

// The player deleted the reply and left their own message last: don't bring it back.
export function onMessageDeleted() {
    const ctx = SillyTavern.getContext();
    const chat = ctx.chat ?? [];
    if (chat.at(-1)?.is_user) markFinal(slotFor(ctx, chat.length, 0));
}

/** GENERATION_ENDED: the reply is complete a second later, whether or not MESSAGE_RECEIVED said so. */
export function onGenerationEnded() {
    const f = inflight;
    setTimeout(() => { if (f) f.done = true; }, 1000);
}

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

let recovering = false;
export async function recoverKeptReply() {
    if (recovering || generating() || !connectionInfo().connected) return;
    const ctx = SillyTavern.getContext();
    const chat = ctx.chat ?? [];
    const len = chat.length;
    const last = chat[len - 1];
    if (!last || last.is_system) return;
    if (ctx.streamingProcessor && !ctx.streamingProcessor.isFinished) return; // still being written
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
        notify('ok', `第 ${floor} 楼已补回`, `刚才没存上，从代理取回 ${text.length} 字`, { ms: 8000 });
    } catch { /* proxy unreachable: try again next time */ } finally {
        recovering = false;
    }
}
