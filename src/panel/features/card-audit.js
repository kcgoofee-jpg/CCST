// ──────────────────────────────────────────────
// 角色卡检查: minors and childlike descriptions in the card, its lorebooks and the persona (shared/card-audit.js)
// ──────────────────────────────────────────────

import { libs } from '../core/libs.js';
import { store } from '../core/store.js';
import { getSettings } from '../core/settings.js';
import { el, note, stateLine } from '../core/dom.js';
import { notify } from '../core/notify.js';

export function init() {
    store.subscribe('pulse', () => runCardAudit());
}

// ── 角色卡检查：未成年人物与幼态化描写（lib/card-audit.js）──

const auditedCards = new Set(); // warned once per card per page load

export async function runCardAudit({ toast = false, force = false } = {}) {
    let box = document.getElementById('claude_max_card_audit');
    if (!libs.cardAudit) {
        box?.replaceChildren(stateLine('error', '没加载（扩展文件不完整），重装扩展即可。'));
        return;
    }
    if (!force && !(getSettings().heuristicChecks && getSettings().cardAudit)) {
        box?.replaceChildren(stateLine('empty', '没开自动检查。点右上角按钮查一次，或在下面打开开关。'));
        return;
    }
    const ctx = SillyTavern.getContext();
    const ch = ctx.groupId ? null : ctx.characters?.[ctx.characterId];
    if (!ch) { box?.replaceChildren(stateLine('empty', '打开角色卡聊天后可用。')); return; }
    const items = libs.cardAudit.cardItems(ch.data ?? ch);
    const books = new Set([ch.data?.extensions?.world].filter(Boolean));
    try {
        const wi = await import('/scripts/world-info.js');
        for (const n of wi.selected_world_info ?? []) books.add(n);
    } catch { /* global lorebooks unknown in this frontend */ }
    for (const name of books) {
        try { items.push(...libs.cardAudit.worldItems(await ctx.loadWorldInfo(name), name)); } catch { /* unreadable book */ }
    }
    const persona = ctx.powerUserSettings?.persona_description;
    if (persona) items.push({ where: '你的人设', text: persona });
    // Switched to another card while the lorebooks loaded: that card gets its own run.
    const now = SillyTavern.getContext();
    if (now.groupId || now.characters?.[now.characterId] !== ch) return;
    box = document.getElementById('claude_max_card_audit');
    const found = libs.cardAudit.auditTexts(items);
    const high = found.filter((f) => f.level === 'high');
    if (box) {
        const card = note(high.length ? 'error' : found.length ? 'warn' : 'ok', found.length
            ? `「${ch.name}」：高风险 ${high.length} 处，提醒 ${found.length - high.length} 处`
            : `「${ch.name}」：未发现未成年相关内容`);
        const list = el('ul', 'cm-issues');
        for (const f of found.slice(0, 12)) {
            list.append(el('li', null, `${f.level === 'high' ? '高风险' : '提醒'} · ${f.text} · ${f.where}${f.disabled ? '（已关闭）' : ''}：${f.snippet}`));
        }
        if (found.length) card.append(list);
        if (found.length > 12) card.append(el('small', 'cm-hint', `……另有 ${found.length - 12} 处。`));
        if (found.length) {
            card.append(el('small', 'cm-hint', 'Claude 会因此每轮核查年龄、收敛剧情，也违反 Anthropic 使用政策。已关闭的条目也列出（换个开关就会被发出去）。'));
        }
        box.replaceChildren(card);
    }
    const key = ch.avatar ?? ch.name;
    if (toast && high.length && !auditedCards.has(key)) {
        auditedCards.add(key);
        notify('bad', `角色卡检查 ·「${ch.name}」`, `有 ${high.length} 处未成年人物相关内容（${[...new Set(high.map((f) => f.where))].slice(0, 3).join('、')}）。详见 CCST 面板「其他 → 体检（实验）」。`, { ms: 20000 });
    }
}
