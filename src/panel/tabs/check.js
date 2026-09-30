// ──────────────────────────────────────────────
// Tab 体检: latest reply check-up, the card check, hidden-setting words and the performance test.
// The work itself is in features/checkup.js, card-audit.js and perf-diag.js.
// ──────────────────────────────────────────────

import { el, iconButton, toggleRow, section } from '../core/dom.js';
import { currentCharKey } from '../core/st.js';
import { F } from '../core/registry.js';

/** Tab 体检: latest reply check-up and its per-card settings. */
export function buildCheckTab(pane, settings, save) {
    const checkTools = el('div', 'cm-section-tools');
    checkTools.append(iconButton('fa-stethoscope', '重新体检最新回复', () => F.checkup.runCheckup()));
    pane.append(section('最新回复', checkTools));
    const checkBox = el('div', 'cm-stats');
    checkBox.id = 'claude_max_checkup';
    pane.append(checkBox);
    pane.append(el('small', 'cm-hint', '查字数、禁词、破折号、「不是A，是B」、人称、重复段落等；范围和禁词读自当前预设。'));

    const auditTools = el('div', 'cm-section-tools');
    auditTools.append(iconButton('fa-user-shield', '检查当前角色卡', () => F.audit.runCardAudit({ force: true })));
    pane.append(section('角色卡检查', auditTools));
    pane.append(toggleRow({
        id: 'claude_max_card_audit_on', title: '切卡时自动检查', desc: '查未成年人物和幼态化描写。',
        checked: !!settings.cardAudit,
        onChange: (on) => { settings.cardAudit = on; save(); F.audit.runCardAudit(); },
    }));
    const auditBox = el('div', 'cm-stats');
    auditBox.id = 'claude_max_card_audit';
    pane.append(auditBox);

    pane.append(section('隐藏设定'));
    const leakField = el('div', 'cm-field');
    leakField.append(el('div', 'cm-field-label', '关键词'));
    const leakInput = el('input', 'text_pole');
    leakInput.type = 'text';
    leakInput.id = 'claude_max_leak';
    leakInput.placeholder = '如：植物人, 医学院（仅当前角色卡）';
    leakInput.value = settings.leakWords?.[currentCharKey()] ?? '';
    leakInput.addEventListener('input', () => {
        settings.leakWords = { ...(settings.leakWords ?? {}), [currentCharKey()]: leakInput.value };
        save();
    });
    leakField.append(leakInput, el('small', 'cm-hint', '揭示前不该出现的词，出现就提醒。'));
    pane.append(leakField);
    const muted = Object.entries(settings.checkupMuted ?? {}).filter(([, n]) => n >= 2);
    if (muted.length) {
        const unmute = el('a', 'cm-more', `恢复 ${muted.length} 类已静音的提示`);
        unmute.href = '#';
        unmute.addEventListener('click', (e) => { e.preventDefault(); settings.checkupMuted = {}; save(); unmute.remove(); });
        pane.append(el('small', 'cm-hint', '同类提示点掉两次就不再弹。'), unmute);
    }

    const perfTools = el('div', 'cm-section-tools');
    perfTools.append(iconButton('fa-gauge-high', '测一次（约 4 秒）', () => F.perf.showPerfDiag()));
    pane.append(section('性能', perfTools));
    const perfNote = el('small', 'cm-hint');
    perfNote.id = 'claude_max_perf_note';
    pane.append(perfNote);
    F.perf.renderPerfNote(perfNote); // not in the document yet
    const perfBox = el('div', 'cm-stats');
    perfBox.id = 'claude_max_perf';
    pane.append(perfBox);
}
