// ──────────────────────────────────────────────
// 其他 → 体检（实验）: the heuristic checks (字数 / 段落 / 禁词 / 重复 / 隐藏设定关键词 / 角色卡检查),
// behind one master switch (settings.heuristicChecks, default off). They depend on the preset and other
// extensions and can raise false alarms. The reliable checks (refusal / truncated / empty) are not here:
// they are in 状态 → 最新回复 (features/checkup.js). The work itself is in features/checkup.js, card-audit.js.
// ──────────────────────────────────────────────

import { el, iconButton, toggleRow, collapsible, stateLine } from '../core/dom.js';
import { currentCharKey } from '../core/st.js';
import { F } from '../core/registry.js';
import { libs } from '../core/libs.js';

/** The collapsible group 「体检（实验）」 for the 其他 tab. */
export function buildCheckupSection(settings, save) {
    const { root, body } = collapsible('体检（实验）', '受预设和其他扩展影响，可能误报。', { id: 'claude_max_checkup_sec' });
    body.append(toggleRow({
        id: 'claudeMaxHeuristicChecks', title: '开启体检（实验）', desc: '默认关。开了才会检查字数、段落、禁词、重复、隐藏设定关键词，并可弹提示。',
        checked: !!settings.heuristicChecks,
        onChange: (v) => { settings.heuristicChecks = v; save(); syncSubToggles(); F.checkup.runCheckup(); F.audit.runCardAudit(); },
    }));

    const reply = el('div', 'cm-field');
    const replyHead = el('div', 'cm-field-label', '最新回复');
    replyHead.append(iconButton('fa-stethoscope', '重新体检最新回复（开关没开也检查这一次）', () => F.checkup.runCheckup({ force: true })));
    const checkBox = el('div', 'cm-stats');
    checkBox.id = 'claude_max_checkup';
    checkBox.append(stateLine('empty', '体检（实验）没开：打开上面的总开关后，每条回复写完会检查一遍。'));
    reply.append(replyHead, el('small', 'cm-hint', '字数、禁词、破折号、「不是A，是B」、人称、重复段落等；范围和禁词读自当前预设。'), checkBox);
    body.append(reply);

    const audit = el('div', 'cm-field');
    const auditHead = el('div', 'cm-field-label', '角色卡检查');
    auditHead.append(iconButton('fa-user-shield', '检查当前角色卡', () => F.audit.runCardAudit({ force: true })));
    const auditBox = el('div', 'cm-stats');
    auditBox.id = 'claude_max_card_audit';
    audit.append(auditHead, el('small', 'cm-hint', '查角色卡、世界书和你的人设里的未成年人物与幼态化描写。'), auditBox);
    body.append(audit);

    body.append(toggleRow({
        id: 'claudeMaxCheckupToast', title: '体检有问题时提示', desc: '弹一条提示；同类点掉两次就不再弹。',
        checked: settings.checkupToast, onChange: (v) => { settings.checkupToast = v; save(); },
    }));
    body.append(toggleRow({
        id: 'claude_max_card_audit_on', title: '切卡时自动检查角色卡', desc: '默认关；需先开上面的总开关，之后每次换卡查一遍。',
        checked: !!settings.cardAudit,
        onChange: (on) => { settings.cardAudit = on; save(); F.audit.runCardAudit(); },
    }));
    // The sub-switches do nothing while the master switch is off: grey them so they don't look on.
    const syncSubToggles = () => {
        for (const id of ['claudeMaxCheckupToast', 'claude_max_card_audit_on']) {
            const input = body.querySelector(`#${id}`);
            if (!input) continue;
            input.disabled = !settings.heuristicChecks;
            input.closest('.cm-toggle')?.classList.toggle('cm-disabled', !settings.heuristicChecks);
        }
    };
    syncSubToggles();
    const leakField = el('div', 'cm-field');
    leakField.append(el('div', 'cm-field-label', '隐藏设定关键词（仅当前角色卡）'));
    const leakInput = el('input', 'text_pole');
    leakInput.type = 'text';
    leakInput.id = 'claude_max_leak';
    leakInput.placeholder = '如：植物人, 医学院';
    leakInput.value = settings.leakWords?.[currentCharKey()] ?? '';
    const leakMsg = el('small', 'cm-hint cm-ok');
    leakMsg.id = 'claude_max_leak_msg';
    leakMsg.setAttribute('role', 'status');
    // Saved when the field loses focus or on Enter (not per keystroke), then said out loud and the
    // latest reply is re-checked at once, so a hit shows up without waiting for the next reply.
    const saveLeak = () => {
        const words = libs.chatCheck?.parseLeakWords(leakInput.value) ?? [];
        settings.leakWords = { ...(settings.leakWords ?? {}), [currentCharKey()]: leakInput.value };
        save();
        leakMsg.textContent = libs.chatCheck ? libs.chatCheck.leakSavedText(words) : '已保存';
        F.checkup.runCheckup();
    };
    leakInput.addEventListener('change', saveLeak);
    leakInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveLeak(); leakInput.blur(); } });
    leakField.append(leakInput, leakMsg,
        el('small', 'cm-hint', '填角色卡里还不该揭开的设定词，比如「植物人」。多个词用逗号或空格隔开；回复里一出现就在体检里标出。'));
    body.append(leakField);
    const muted = Object.entries(settings.checkupMuted ?? {}).filter(([, n]) => n >= 2);
    if (muted.length) {
        const unmute = el('button', 'cm-link-btn', `恢复 ${muted.length} 类已静音的提示`);
        unmute.type = 'button';
        unmute.addEventListener('click', () => { settings.checkupMuted = {}; save(); unmute.remove(); });
        body.append(unmute);
    }
    return root;
}
