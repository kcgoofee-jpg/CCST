// ──────────────────────────────────────────────
// Checks of the latest reply (shared/chat-check.js), two kinds:
//   reliable (always on): refusal / cut off at the length limit / empty → the 「最新回复」 card in 状态.
//   heuristic (其他 → 体检（实验）, master switch settings.heuristicChecks, default off): length, banned
//     words, repeats, hidden-setting words…; only these may toast, and only when the switch is on.
// ──────────────────────────────────────────────

import { libs } from '../core/libs.js';
import { store } from '../core/store.js';
import { getSettings, saveSettingsDebounced } from '../core/settings.js';
import { el, note, stateLine } from '../core/dom.js';
import { currentCharKey, generating } from '../core/st.js';
import { makeCheckupGate } from '../core/checkup-gate.js';
import { notify } from '../core/notify.js';

export function init() {
    // A full refresh (drawer opened, 重新检测) re-reads the latest reply.
    store.subscribe('pulse', () => runCheckup());
    store.subscribe('stats', () => renderLatestFlags());
}

/** The flags of the latest reply: chat text + the proxy's record of this chat's last request. */
export function currentFlags() {
    if (!libs.chatCheck?.replyFlags) return [];
    const chat = SillyTavern.getContext().chat ?? [];
    const replies = chat.length < 2 ? null : libs.chatCheck.latestReplies(chat);
    if (!replies) return [];
    const stats = store.get().stats;
    return libs.chatCheck.replyFlags(replies.last.mes ?? '', stats?.phase === 'ok' ? stats.data?.lastRequest : null);
}

/** 状态 → 最新回复: one line per problem; the card is hidden when there is none. */
export function renderLatestFlags() {
    const sec = document.getElementById('claude_max_latest_sec');
    const box = document.getElementById('claude_max_latest');
    if (!sec || !box) return;
    const flags = currentFlags();
    sec.hidden = !flags.length;
    box.replaceChildren(...flags.map((f) => note('warn', f.text)));
}

let lastToastKey = '';

// Never while a reply is streaming (half a message trips checks and flashes the badge): asked
// meanwhile, it runs once the generation ended (events.js calls flushCheckup).
const gate = makeCheckupGate({ isGenerating: generating, run: (o) => runCheckupNow(o) });
export const runCheckup = (opts) => { gate.request(opts); };
export const flushCheckup = () => { gate.flush(); };

function runCheckupNow({ toast = false, force = false } = {}) {
    renderLatestFlags();
    const box = document.getElementById('claude_max_checkup');
    // Heuristic checks: off unless the switch is on (or the user asked for one run with the button).
    const settings = getSettings();
    if (!settings.heuristicChecks && !force) {
        box?.replaceChildren(stateLine('empty', '体检（实验）没开：打开上面的总开关后，每条回复写完会检查一遍。'));
        return;
    }
    if (!libs.chatCheck) {
        box?.replaceChildren(stateLine('error', '没加载（扩展文件不完整），重装扩展即可。'));
        return;
    }
    const ctx = SillyTavern.getContext();
    const chat = ctx.chat ?? [];
    // The greeting (floor 0) is not a reply.
    const replies = chat.length < 2 ? null : libs.chatCheck.latestReplies(chat);
    if (!replies) {
        box?.replaceChildren(stateLine('empty', '还没有回复，生成后自动体检。'));
        return;
    }
    const prompts = ctx.chatCompletionSettings?.prompts ?? [];
    const leaks = libs.chatCheck.parseLeakWords(settings.leakWords?.[currentCharKey()]);
    const { last, prev } = replies;
    const r = libs.chatCheck.checkReply({
        mes: last.mes ?? '', prevMes: prev?.mes ?? null,
        words: libs.chatCheck.wordRangeFromPreset(ctx.chatCompletionSettings), banned: libs.chatCheck.bannedFromPrompts(prompts), leaks,
        secondPerson: libs.chatCheck.secondPersonFromPreset(ctx.chatCompletionSettings),
        paragraphs: libs.chatCheck.paragraphRangeFromPreset?.(ctx.chatCompletionSettings) ?? null,
        sceneCard: libs.chatCheck.sceneCardFromPreset?.(ctx.chatCompletionSettings) ?? false,
    });
    if (box) {
        const card = note(r.issues.length ? 'warn' : 'ok', r.issues.length ? `${r.issues.length} 个问题` : '没有发现问题');
        card.append(el('small', 'cm-hint', `${r.chars} 字 / ${r.paragraphs ?? '?'} 段`));
        if (r.issues.length) {
            const list = el('ul', 'cm-issues');
            for (const i of r.issues) list.append(el('li', null, i.text));
            card.append(list);
        }
        box.replaceChildren(card);
    }
    // Toast only when the problems change: the same issue every reply is noise.
    const toastKey = `${currentCharKey()}|${r.issues.map((i) => i.code).sort().join(',')}`;
    if (!r.issues.length) lastToastKey = '';
    const always = r.issues.some((i) => i.code === 'flashback');
    // Tapping a check-up notice away twice mutes that kind of issue (the
    // 体检（实验）list still shows it).
    const muted = settings.checkupMuted ?? {};
    const loud = r.issues.filter((i) => (muted[i.code] ?? 0) < 2);
    if (toast && settings.heuristicChecks && loud.length && settings.checkupToast && (always || toastKey !== lastToastKey)) {
        lastToastKey = toastKey;
        notify('warn', `本轮体检 · ${loud.length} 个问题`, loud.map((i) => i.text).join('\n'), {
            ms: 9000,
            replace: 'checkup',
            onDismiss: () => {
                const m = { ...(getSettings().checkupMuted ?? {}) };
                for (const i of loud) m[i.code] = (m[i.code] ?? 0) + 1;
                getSettings().checkupMuted = m;
                saveSettingsDebounced();
                const now = loud.filter((i) => m[i.code] === 2);
                if (now.length) notify('info', '这类问题以后不再弹出', '「其他 → 体检（实验）」里照样能看到', { ms: 4000 });
            },
        });
    }
}
