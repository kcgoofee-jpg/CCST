// ──────────────────────────────────────────────
// 本轮体检（M4）: check the latest reply (shared/chat-check.js) and, when the problems change, say so.
// ──────────────────────────────────────────────

import { libs } from '../core/libs.js';
import { store } from '../core/store.js';
import { getSettings, saveSettingsDebounced } from '../core/settings.js';
import { el, note } from '../core/dom.js';
import { currentCharKey } from '../core/st.js';
import { notify } from '../core/notify.js';

export function init() {
    // A full refresh (drawer opened, 重新检测) re-reads the latest reply.
    store.subscribe('pulse', () => runCheckup());
}

let lastToastKey = '';

export function runCheckup({ toast = false } = {}) {
    const box = document.getElementById('claude_max_checkup');
    if (!libs.chatCheck) {
        box?.replaceChildren(el('small', 'cm-hint', '没加载（扩展文件不完整），重装扩展即可。'));
        return;
    }
    const settings = getSettings();
    const ctx = SillyTavern.getContext();
    const chat = ctx.chat ?? [];
    const ai = chat.filter((m) => !m.is_user && !m.is_system);
    if (chat.length < 2 || !ai.length) {
        box?.replaceChildren(el('small', 'cm-hint', '还没有 AI 回复，生成后自动体检。'));
        return;
    }
    const prompts = ctx.chatCompletionSettings?.prompts ?? [];
    const leaks = String(settings.leakWords?.[currentCharKey()] ?? '').split(/[,，、\s]+/).filter(Boolean);
    const last = ai[ai.length - 1];
    const prev = ai.length > 1 ? ai[ai.length - 2] : null;
    const r = libs.chatCheck.checkReply({
        mes: last.mes ?? '', prevMes: prev?.mes ?? null,
        words: libs.chatCheck.wordRangeFromPreset(ctx.chatCompletionSettings), banned: libs.chatCheck.bannedFromPrompts(prompts), leaks,
        secondPerson: libs.chatCheck.secondPersonFromPreset(ctx.chatCompletionSettings),
        paragraphs: libs.chatCheck.paragraphRangeFromPreset?.(ctx.chatCompletionSettings) ?? null,
        sceneCard: libs.chatCheck.sceneCardFromPreset?.(ctx.chatCompletionSettings) ?? false,
    });
    store.merge('glance', { issues: r.issues.length });
    if (box) {
        const card = note(r.issues.length ? 'warn' : 'ok', `${r.chars} 字 / ${r.paragraphs ?? '?'} 段 · ${r.issues.length ? `${r.issues.length} 个问题` : '正常'}`);
        for (const i of r.issues) card.append(el('small', 'cm-hint', `· ${i.text}`));
        box.replaceChildren(card);
    }
    // Toast only when the problems change: the same issue every reply is noise.
    const toastKey = `${currentCharKey()}|${r.issues.map((i) => i.code).sort().join(',')}`;
    if (!r.issues.length) lastToastKey = '';
    const always = r.issues.some((i) => i.code === 'flashback');
    // Tapping a check-up notice away twice mutes that kind of issue (the
    // 体检 tab still lists it).
    const muted = settings.checkupMuted ?? {};
    const loud = r.issues.filter((i) => (muted[i.code] ?? 0) < 2);
    if (toast && loud.length && settings.checkupToast && (always || toastKey !== lastToastKey)) {
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
                if (now.length) notify('info', '这类问题以后不再弹出', '体检页里照样能看到', { ms: 4000 });
            },
        });
    }
}
