// ──────────────────────────────────────────────
// Turn capture: replay each past user turn exactly as the CLI sent it
// ──────────────────────────────────────────────
//
// The CLI appends its per-turn context (environment, model, date, session
// info) to the CURRENT user message as system-reminder blocks, and records
// them as `attachment` entries after that user entry in the session
// transcript. Next turn that message is history; our synthetic transcript
// used to replay it WITHOUT those attachments, so its bytes changed and the
// prompt cache — whose only message breakpoint is the end of the previous
// request — could never read any of the conversation back: every turn
// re-wrote the whole history (verified live: identical history, system
// prompt read, history always re-written).
//
// Real Claude Code sessions don't have this problem because the transcript
// keeps the attachments. So do the same: the SessionStore's append() hands
// us every entry the CLI writes; keep the current user entry plus its
// attachments IN MEMORY (never on disk), keyed by the user text AND the reply
// it answers, and splice them back in when that message shows up in a later
// request's history. The text alone is not enough: a player who types 「继续」
// three times in one chat sends three different messages (each with its own
// lore and context), and the same 「继续」 in another chat must never pick up
// this chat's lore. The reply before a message is the same every time that
// message is replayed, survives the oldest turns being trimmed off, and
// differs between chats.

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { DATA_DIR } from '../paths.js';
import { SDK_VERSION } from './sdk-version.js';

const PLUGIN_TAG = '[claude-subscription]';

const MAX_TURNS = 400;
const captures = new Map(); // key → { entries: user entry + its attachments, contextPinned }

/** The CLI's record of the system prompt (CLI 2.1.28x, rolled out per account): on a
 *  resume the CLI sends the recorded prompt instead of the one it was given. A record
 *  from an earlier turn — or, through the pin, from another chat — must never be
 *  replayed (see system-prompt.js). */
export function isRecordedPrompt(e) {
    return e?.type === 'attachment' && e?.attachment?.type === 'prompt_snapshot';
}

/** Memory key of a player message: its text plus the reply it answers (see above). */
export function turnKey(text, context = '') {
    return createHash('sha1').update(`${context ?? ''}\u0000${text}`).digest('hex');
}

function contentText(c) {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
    return '';
}

function entryText(entry) {
    return contentText(entry?.message?.content);
}

/**
 * The reply a message at `index` answers: the text of the last non-blank
 * assistant message before it ('' if none). The proxy never changes
 * assistant messages, so this is the same in every request that contains the
 * message, whatever was done to the user messages around it.
 * @param {Array<{role: string, content: any}>} list
 */
export function replyBefore(list, index) {
    for (let j = Math.min(index, list?.length ?? 0) - 1; j >= 0; j--) {
        const m = list[j];
        if (m?.role !== 'assistant') continue;
        const t = contentText(m.content);
        if (t.trim()) return t;
    }
    return '';
}

/** replyBefore for every index of `list`, in one pass. */
export function repliesBefore(list) {
    const out = [];
    let last = '';
    for (const m of list ?? []) {
        out.push(last);
        if (m?.role === 'assistant') {
            const t = contentText(m.content);
            if (t.trim()) last = t;
        }
    }
    return out;
}

/**
 * Per-request collector for SessionStore.append(). Picks the user entry
 * whose text is the current prompt and the attachment entries that follow
 * it, up to the first assistant entry.
 *
 * `keyText` is what this message will look like in NEXT turn's history when
 * the proxy changed it before sending (lore-tail.js puts moving world info
 * on top of it): the capture is filed under that text, so next turn replays
 * the message exactly as it was sent and the cached prefix still matches.
 *
 * `lead`: entries of this turn that come before the current user entry and are not written by the
 * CLI — a prefill turn's player message (as sent) and the placeholder reply after it. The turn is
 * kept as lead + continuation instruction (+ its attachments), filed under the player's text, so
 * next turn the player's message is replayed as the CLI saw it, not bare.
 */
export function createTurnCollector(currentText, keyText = currentText, model = null, context = '', lead = null) {
    let collecting = null;
    let done = false;
    return {
        /** False when the CLI never wrote this turn's user entry — the shape we
         *  replay is gone (see noteReplayHealth). */
        get captured() {
            return done;
        },
        onAppend(entries) {
            if (done) return;
            for (const e of entries ?? []) {
                if (done) break;
                if (!collecting) {
                    if (e?.type === 'user' && entryText(e) === currentText) collecting = [e];
                    else if (e?.type === 'user' && debugCapture()) console.log(`[claude-subscription] capture: 用户条目对不上（${entryText(e).length} 字 vs ${String(currentText).length} 字）`);
                    continue;
                }
                if (e?.type === 'attachment') {
                    if (!isRecordedPrompt(e)) collecting.push(e);
                } else if (e?.type === 'assistant' || e?.type === 'user') {
                    const attachments = collecting.filter((x) => x?.type === 'attachment');
                    // The first context the CLI adds becomes the pin. Anything it
                    // adds once a pin exists (the new date after midnight) is part
                    // of this turn only and stays with it on replay.
                    const becomesPin = !!model && attachments.length > 0 && !hasPinnedContext(model);
                    if (becomesPin) pinContext(model, attachments);
                    remember(keyText ?? currentText, context, lead?.length ? [...lead, ...collecting] : collecting, becomesPin);
                    done = true;
                }
            }
        },
    };
}

const debugCapture = () => /^(1|on|true)$/i.test(process.env.CLAUDE_SUBSCRIPTION_DEBUG_CAPTURE ?? '');

function remember(text, context, entries, contextPinned) {
    const key = turnKey(text, context);
    if (debugCapture()) console.log(`[claude-subscription] capture: 记下 ${key.slice(0, 8)}（${String(text).slice(0, 20)}… / 回复前文 ${String(context).length} 字）`);
    captures.delete(key);
    captures.set(key, { entries: entries.map((e) => JSON.parse(JSON.stringify(e))), contextPinned, text: String(text), context: String(context ?? '') });
    while (captures.size > MAX_TURNS) captures.delete(captures.keys().next().value);
}

/**
 * Copies of `entries` re-chained after `parentUuid`, with sessionId and cwd
 * of the new transcript.
 *
 * Each copy gets a FRESH uuid. The captured uuids are the ones the CLI wrote
 * in whatever session produced this turn, and the same captured entries can
 * land in one transcript twice — a turn's attachments are also the pinned
 * context, so a replay that keeps them next to the pin repeats their uuids.
 * A parent chain with duplicate uuids lets the CLI walk the transcript to the
 * wrong branch, which changes the bytes the cache was built for.
 */
function rechain(entries, parentUuid, meta) {
    const uuids = new Map();
    for (const e of entries) if (e?.uuid) uuids.set(e.uuid, randomUUID());
    let parent = parentUuid;
    return entries.map((e) => {
        const prev = e?.parentUuid;
        const copy = {
            ...JSON.parse(JSON.stringify(e)),
            parentUuid: prev && uuids.has(prev) ? uuids.get(prev) : parent,
            uuid: uuids.get(e?.uuid) ?? randomUUID(),
            sessionId: meta.sessionId,
            cwd: meta.cwd,
        };
        parent = copy.uuid;
        return copy;
    });
}

/**
 * Captured entries for a past user message, re-chained into the new
 * transcript (parentUuid / sessionId / cwd rewritten). Null when unknown —
 * e.g. the first turn after a proxy restart; the caller then falls back to
 * a synthetic user entry and that one turn misses the cache.
 */
/**
 * `pinOn`: the request carries the pinned context — a turn whose attachments
 * BECAME that pin is replayed without them (they are already there, after the
 * first entry). Attachments the CLI added while a pin existed (e.g. the date
 * after midnight) are kept: they were sent with that turn, and the CLI looks
 * for the latest date in the transcript — without it the CLI would add the
 * date again to every new message and the previous one would change.
 * `context`: the reply this message answers (replyBefore).
 */
// Presets that wrap only the newest player message (Kemini: a prompt-only
// regex, maxDepth 1, puts it in <interactive_input>) send it wrapped on its
// turn and bare the turn after, so the exact key never matched again and the
// history was re-written every turn (measured 2026-10-07: 木屋求生 × Kemini).
// When no exact key matches, a capture with the same reply context whose
// text is this text plus a short wrapper is the same turn.
const MAX_WRAPPER_CHARS = 200;
function findCapture(text, context) {
    const exact = captures.get(turnKey(text, context));
    if (exact) return exact;
    const t = String(text ?? '');
    if (t.trim().length < 2) return null;
    const ctx = String(context ?? '');
    let best = null;
    for (const c of captures.values()) {
        if (c.context !== ctx || c.text === t || c.text.length - t.length > MAX_WRAPPER_CHARS || !c.text.includes(t)) continue;
        // Only markup and whitespace around it: 「继续」 is not 「继续一下」.
        if (!c.text.replace(t, '').replace(/<\/?[^<>\n]{1,60}>/g, '').trim()) best = c; // latest wins
    }
    return best;
}

export function replayTurn(text, parentUuid, meta, { pinOn = false, context = '' } = {}) {
    const found = findCapture(text, context);
    if (debugCapture()) console.log(`[claude-subscription] capture: 查 ${turnKey(text, context).slice(0, 8)}（${String(text).slice(0, 20)}… / 回复前文 ${String(context).length} 字）→ ${found ? '有' : '没有'}；已存 ${captures.size} 条`);
    if (!found) return null;
    const list = pinOn && found.contextPinned ? found.entries.filter((e) => e?.type !== 'attachment') : found.entries;
    return rechain(list, parentUuid, meta);
}

/**
 * `text` with every copy of any of `from` (one text or several versions)
 * replaced by `to`, in one pass: where one version contains another the
 * longest wins, and replaced text is never matched again. A text that already
 * carries `to` is up to date and left alone (a turn rerolled after the edit:
 * an old version that is part of the new one would be swapped twice).
 */
export function swapVersions(text, from, to) {
    const list = [...new Set([from].flat().filter((f) => f && f !== to))].sort((a, b) => b.length - a.length);
    if (typeof text !== 'string' || !list.length || (to && text.includes(to)) || !list.some((f) => text.includes(f))) return text;
    const re = new RegExp(list.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
    return text.replace(re, () => to);
}

/**
 * Replace `from` (one text or several versions) with `to` in the text of every
 * captured user entry; returns how many entries changed. Used when the preset's
 * post-history entries were changed (an entry switched off): earlier turns were
 * replayed as sent, so without this the switched-off entry stayed in every one of them.
 */
export function rewriteCaptured(from, to) {
    let n = 0;
    for (const { entries } of captures.values()) {
        const msg = entries[0]?.message;
        if (!msg) continue;
        const before = JSON.stringify(msg.content);
        if (typeof msg.content === 'string') msg.content = swapVersions(msg.content, from, to);
        else if (Array.isArray(msg.content) && !(to && msg.content.some((b) => b?.type === 'text' && b.text?.includes?.(to)))) {
            for (const b of msg.content) if (b?.type === 'text') b.text = swapVersions(b.text, from, to);
        }
        if (JSON.stringify(msg.content) !== before) n++;
    }
    return n;
}

/** The text a past user message was actually sent with (null if unknown). */
export function sentTextFor(text, context = '') {
    const found = findCapture(text, context);
    return found ? entryText(found.entries[0]) : null;
}

/**
 * The replay/pin callbacks for assembleEntries. `pinKey` null = no pin.
 * @returns {{ replay: Function|null, pinned: Function|null, pinOn: boolean }}
 */
export function historyReplay(pinKey, { replay = true } = {}) {
    const pinOn = !!pinKey && hasPinnedContext(pinKey);
    return {
        pinOn,
        replay: replay ? (text, parent, meta, context) => replayTurn(text, parent, meta, { pinOn, context }) : null,
        pinned: pinOn ? (parent, meta) => pinnedContext(pinKey, parent, meta) : null,
    };
}

// ── Context pin ──
//
// The CLI adds its per-session context (environment, model, date, account)
// as attachments to the current message only when the transcript it resumes
// has none. On the first request after a restart that is the LAST message of
// the request (a trailing system message); from the next request on the same
// text is mid-conversation and the API renders it differently — so the
// second turn after every restart re-wrote the whole history (seen with a
// request tap: identical bytes, cache read = system prompt only). Pinning a
// copy of that context right after the first transcript entry, in every
// request, keeps the structure the same from the first turn on; the CLI then
// adds nothing at the end. Kept per model (the model attachment names it) in
// data/ — account/environment details, no chat text.

const pins = new Map(); // model → attachment entries
let pinsLoaded = false;

function pinFile() {
    const env = process.env.CLAUDE_SUBSCRIPTION_CONTEXT_PIN_FILE;
    if (env) return /^off$/i.test(env) ? null : env; // 'off': memory only, like CACHE_MEMORY_FILE
    if (process.env.NODE_TEST_CONTEXT) return null;
    return join(DATA_DIR, 'cli-context.json');
}

function loadPins() {
    if (pinsLoaded) return;
    pinsLoaded = true;
    const f = pinFile();
    if (!f) return;
    let saved;
    try {
        saved = JSON.parse(readFileSync(f, 'utf8'));
    } catch { /* none yet */ }
    if (saved?.version === SDK_VERSION && saved.pins && typeof saved.pins === 'object') {
        for (const [model, entries] of Object.entries(saved.pins)) {
            // Pins saved before 5.2.1 can carry a recorded system prompt: drop it.
            const kept = Array.isArray(entries) ? entries.filter((e) => !isRecordedPrompt(e)) : [];
            if (kept.length) pins.set(model, kept);
        }
        return;
    }
    // The CLI renders this context itself, so a saved one from another SDK version is
    // wrong bytes: keeping it re-writes the whole history every turn (#26). Drop it —
    // this turn re-pins and rewrites the cache once.
    const from = typeof saved?.version === 'string' ? saved.version : '旧格式';
    pins.clear();
    writePinFile(f);
    console.log(`${PLUGIN_TAG} SDK 版本 ${from}→${SDK_VERSION}，已重置 CLI 上下文 pin，本轮缓存会全量重写一次`);
}

function writePinFile(f) {
    try {
        mkdirSync(dirname(f), { recursive: true });
        // Write-through-rename like the token file: a proxy killed mid-write
        // would otherwise leave half a JSON here, and loadPins reads it at
        // startup with no way back to the pinned context.
        const tmp = `${f}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ version: SDK_VERSION, pins: Object.fromEntries(pins) }), { mode: 0o600 }); // account details
        renameSync(tmp, f);
    } catch { /* memory only */ }
}

export function pinContext(model, entries) {
    loadPins();
    if (pins.has(model)) return; // keep the first one: changing it would change every request (later changes ride on their turn, see replayTurn)
    pins.set(model, entries.filter((e) => !isRecordedPrompt(e)).map((e) => JSON.parse(JSON.stringify(e))));
    const f = pinFile();
    if (f) writePinFile(f);
}

export function hasPinnedContext(model) {
    loadPins();
    return pins.has(model);
}

/** The pinned context for this model, re-chained after `parentUuid`; null if none yet. */
export function pinnedContext(model, parentUuid, meta) {
    loadPins();
    const found = pins.get(model);
    if (!found) return null;
    let parent = parentUuid;
    return found.map((e) => {
        const copy = { ...JSON.parse(JSON.stringify(e)), parentUuid: parent, sessionId: meta.sessionId, cwd: meta.cwd };
        parent = copy.uuid;
        return copy;
    });
}

/** The CLI changed what it sends (update, or a replay that stopped matching): nothing
 *  captured or pinned still fits, so start over — the next turn rewrites the cache once. */
export function resetReplayState(reason) {
    captures.clear();
    pins.clear();
    pinsLoaded = true;
    replayMissStreak = 0;
    const f = pinFile();
    if (f) { try { unlinkSync(f); } catch { /* 本来就没有 */ } }
    console.warn(`${PLUGIN_TAG} ${reason}`);
}

const REPLAY_RESET_AFTER_MISSES = 3;
let replayMissStreak = 0;

/** One resume turn, checked after the request ended: `captured` false means the CLI did not
 *  write the transcript entry we replay, so every turn from now on would re-write the whole
 *  history. After a few turns of that the capture is clearly broken — reset it (#26).
 * @returns {boolean} true when this call reset the replay state */
export function noteReplayHealth(captured) {
    if (captured) {
        replayMissStreak = 0;
        return false;
    }
    replayMissStreak += 1;
    console.warn(`${PLUGIN_TAG} 这一轮没有捕获到逐轮还原的上下文（连续 ${replayMissStreak} 轮），Claude 命令行可能改了写入方式`);
    if (replayMissStreak < REPLAY_RESET_AFTER_MISSES) return false;
    resetReplayState('已重置逐轮还原状态，本轮缓存会全量重写一次');
    return true;
}

/** Test seam. */
export function __resetTurnCaptures() {
    captures.clear();
    pins.clear();
    pinsLoaded = true;
    replayMissStreak = 0;
}

/** Test seam — read the pin file again on next use. */
export function __reloadPinsForTesting() {
    pins.clear();
    pinsLoaded = false;
}
