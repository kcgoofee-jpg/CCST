// ──────────────────────────────────────────────
// 缓存优化：当前角色卡的世界书设为常驻 (shared/lore-constant.js)
// ──────────────────────────────────────────────

import { libs } from '../core/libs.js';
import { store } from '../core/store.js';
import { el, popupText, stateLine, button } from '../core/dom.js';
import { currentCharKey } from '../core/st.js';
import { notify } from '../core/notify.js';

export function init() {
    store.subscribe('pulse', () => refreshLoreBox());
}

// ── 缓存优化：当前角色卡的世界书设为常驻 ──

export async function refreshLoreBox() {
    let box = document.getElementById('claude_max_lore');
    if (!box) return;
    if (!libs.loreConst) {
        box.replaceChildren(stateLine('error', '没加载（扩展文件不完整），重装扩展即可。'));
        return;
    }
    const ctx = SillyTavern.getContext();
    const ch = ctx.groupId ? null : ctx.characters?.[ctx.characterId];
    if (!ch) { box.replaceChildren(stateLine('empty', '打开角色卡聊天后可用。')); return; }
    // Every book that feeds this chat, not just the card's own: global
    // (selected) books and the chat's bound book cost cache the same way.
    const names = [ch.data?.extensions?.world, ctx.chatMetadata?.world_info];
    try {
        const wi = await import('/scripts/world-info.js');
        names.push(...(wi.selected_world_info ?? []));
    } catch { /* global lorebooks unknown in this frontend */ }
    const books = [...new Set(names.filter(Boolean))];
    if (!books.length) { box.replaceChildren(stateLine('empty', '这个聊天没用世界书。')); return; }
    const charKey = currentCharKey();
    const parts = [];
    for (const name of books) {
        let book;
        try { book = await ctx.loadWorldInfo(name); } catch { book = null; }
        parts.push(loreRow(ctx, name, book));
    }
    // The panel may have been rebuilt or the character switched meanwhile.
    box = document.getElementById('claude_max_lore');
    if (!box || currentCharKey() !== charKey) return;
    box.replaceChildren(...parts);
}

function loreRow(ctx, name, book) {
    const box = el('div', 'cm-field');
    if (!book) { box.append(el('small', 'cm-hint', `读不到世界书「${name}」。`)); return box; }
    const sum = libs.loreConst.summarizeLore(book);
    const backup = libs.loreConst.backupName(name);
    const hasBackup = (ctx.getWorldInfoNames?.() ?? []).includes(backup);
    box.append(el('small', 'cm-hint', sum.keyword
        ? `「${name}」有 ${sum.keyword} 条关键词条目（约 ${sum.keywordChars.toLocaleString()} 字），聊天记录每轮重写缓存。`
        : `「${name}」已全部常驻，不影响缓存。`));
    if (sum.keyword) {
        const why = el('details', 'cm-mini');
        why.append(el('summary', null, '有什么影响'), el('small', 'cm-hint',
            '常驻后每轮都发这些条目（多占上下文），但聊天记录能命中缓存；实测每轮缓存写入从约 2.8 万降到 3 千 token。'));
        box.append(why);
    }
    const row = el('div', 'cm-btn-row');
    if (sum.keyword) {
        row.append(button('设为常驻（自动备份）', () => convertLore(name, book, backup)));
    }
    if (hasBackup) {
        row.append(button('恢复原样', () => restoreLore(name, backup)));
    }
    if (row.childElementCount) box.append(row);
    return box;
}

async function convertLore(name, book, backup) {
    const ctx = SillyTavern.getContext();
    const ok = await ctx.callGenericPopup(popupText(`把世界书「${name}」里按关键词触发的条目全部改为常驻？`, `原世界书会先备份为「${backup}」，之后可以一键恢复。`), ctx.POPUP_TYPE.CONFIRM);
    if (!ok) return;
    try {
        if (!(ctx.getWorldInfoNames?.() ?? []).includes(backup)) {
            await ctx.saveWorldInfo(backup, book, true);
            await ctx.updateWorldInfoList?.();
        }
        const { book: next, changed } = libs.loreConst.makeAllConstant(book);
        await ctx.saveWorldInfo(name, next, true);
        ctx.reloadWorldInfoEditor?.(name);
        notify('ok', `「${name}」已设为常驻`, `${changed} 条改为常驻，备份在「${backup}」。`, { ms: 8000 });
    } catch (err) {
        notify('bad', '没改成', String(err instanceof Error ? err.message : err));
    }
    refreshLoreBox();
}

async function restoreLore(name, backup) {
    const ctx = SillyTavern.getContext();
    const ok = await ctx.callGenericPopup(popupText(`用备份「${backup}」覆盖世界书「${name}」，恢复成设为常驻之前的样子？`), ctx.POPUP_TYPE.CONFIRM);
    if (!ok) return;
    try {
        const saved = await ctx.loadWorldInfo(backup);
        await ctx.saveWorldInfo(name, saved, true);
        ctx.reloadWorldInfoEditor?.(name);
        notify('ok', `「${name}」已恢复`, '备份仍保留，不需要时可在世界书列表里删除。', { ms: 8000 });
    } catch (err) {
        notify('bad', '没恢复成', String(err instanceof Error ? err.message : err));
    }
    refreshLoreBox();
}
