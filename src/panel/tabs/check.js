// ──────────────────────────────────────────────
// Tab 体检: latest reply check-up and the card check, then the switches that go with them.
// The work itself is in features/checkup.js and card-audit.js. (The performance test moved to 其他.)
// ──────────────────────────────────────────────

import { el, iconButton, toggleRow, group, stateLine } from '../core/dom.js';
import { currentCharKey } from '../core/st.js';
import { F } from '../core/registry.js';

/** Tab 体检: summary line + list first; the toggles are grouped at the bottom. */
export function buildCheckTab(pane, settings, save) {
    const reply = group('最新回复', '字数、禁词、破折号、「不是A，是B」、人称、重复段落等；范围和禁词读自当前预设。', {
        tools: iconButton('fa-stethoscope', '重新体检最新回复', () => F.checkup.runCheckup()),
    });
    const checkBox = el('div', 'cm-stats');
    checkBox.id = 'claude_max_checkup';
    checkBox.append(stateLine('empty', '还没有 AI 回复，生成后自动体检。'));
    reply.body.append(checkBox);
    pane.append(reply.root);

    const audit = group('角色卡检查', '查角色卡、世界书和你的人设里的未成年人物与幼态化描写。', {
        tools: iconButton('fa-user-shield', '检查当前角色卡', () => F.audit.runCardAudit({ force: true })),
    });
    const auditBox = el('div', 'cm-stats');
    auditBox.id = 'claude_max_card_audit';
    audit.body.append(auditBox);
    pane.append(audit.root);

    const opts = group('提示与开关', null);
    opts.body.append(toggleRow({
        id: 'claudeMaxCheckupToast', title: '体检有问题时提示', desc: '弹一条提示；同类点掉两次就不再弹。',
        checked: settings.checkupToast, onChange: (v) => { settings.checkupToast = v; save(); },
    }));
    opts.body.append(toggleRow({
        id: 'claude_max_card_audit_on', title: '切卡时自动检查角色卡', desc: '默认关；打开后每次换卡查一遍。',
        checked: !!settings.cardAudit,
        onChange: (on) => { settings.cardAudit = on; save(); F.audit.runCardAudit(); },
    }));
    const leakField = el('div', 'cm-field');
    leakField.append(el('div', 'cm-field-label', '隐藏设定关键词（仅当前角色卡）'));
    const leakInput = el('input', 'text_pole');
    leakInput.type = 'text';
    leakInput.id = 'claude_max_leak';
    leakInput.placeholder = '如：植物人, 医学院';
    leakInput.value = settings.leakWords?.[currentCharKey()] ?? '';
    leakInput.addEventListener('input', () => {
        settings.leakWords = { ...(settings.leakWords ?? {}), [currentCharKey()]: leakInput.value };
        save();
    });
    leakField.append(leakInput, el('small', 'cm-hint', '揭示之前不该出现的词，回复里出现就提醒。'));
    opts.body.append(leakField);
    const muted = Object.entries(settings.checkupMuted ?? {}).filter(([, n]) => n >= 2);
    if (muted.length) {
        const unmute = el('button', 'cm-link-btn', `恢复 ${muted.length} 类已静音的提示`);
        unmute.type = 'button';
        unmute.addEventListener('click', () => { settings.checkupMuted = {}; save(); unmute.remove(); });
        opts.body.append(unmute);
    }
    pane.append(opts.root);
}
