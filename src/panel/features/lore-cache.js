// ──────────────────────────────────────────────
// 缓存优化：当前角色卡的世界书设为常驻 (shared/lore-constant.js)
// ──────────────────────────────────────────────

import { libs } from '../core/libs.js';
import { store } from '../core/store.js';
import { el, popupText, button } from '../core/dom.js';
import { currentCharKey } from '../core/st.js';
import { notify } from '../core/notify.js';

export function init() {
    store.subscribe('pulse', () => refreshLoreBox());
}

// ── 缓存优化：当前角色卡的世界书设为常驻 ──
// 状态 → 世界书缓存 only shows when there is something to do: a book with keyword entries (设为常驻),
// or a backup to restore. Otherwise the whole section stays hidden.

/** Show / hide the section around the box. */
function showSection(on) {
    const sec = document.getElementById('claude_max_lore_sec');
    if (sec) sec.hidden = !on;
}

export async function refreshLoreBox() {
    let box = document.getElementById('claude_max_lore');
    if (!box) return;
    const ctx = SillyTavern.getContext();
    const ch = ctx.groupId ? null : ctx.characters?.[ctx.characterId];
    if (!libs.loreConst || !ch) { box.replaceChildren(); showSection(false); return; }
    // Every book that feeds this chat, not just the card's own: global
    // (selected) books and the chat's bound book cost cache the same way.
    const names = [ch.data?.extensions?.world, ctx.chatMetadata?.world_info];
    try {
        const wi = await import('/scripts/world-info.js');
        names.push(...(wi.selected_world_info ?? []));
    } catch { /* global lorebooks unknown in this frontend */ }
    const books = [...new Set(names.filter(Boolean))];
    const charKey = currentCharKey();
    const parts = [];
    for (const name of books) {
        let book;
        try { book = await ctx.loadWorldInfo(name); } catch { book = null; }
        const row = book ? loreRow(ctx, name, book) : null;
        if (row) parts.push(row);
    }
    // The panel may have been rebuilt or the character switched meanwhile.
    box = document.getElementById('claude_max_lore');
    if (!box || currentCharKey() !== charKey) return;
    box.replaceChildren(...parts);
    showSection(parts.length > 0);
}

/** One book: a short line and its button, or null when there is nothing to do for it. */
function loreRow(ctx, name, book) {
    const sum = libs.loreConst.summarizeLore(book);
    const backup = libs.loreConst.backupName(name);
    const hasBackup = (ctx.getWorldInfoNames?.() ?? []).includes(backup);
    if (!sum.keyword && !hasBackup) return null;
    const box = el('div', 'cm-field');
    box.append(el('small', 'cm-hint', sum.keyword
        ? `「${name}」有 ${sum.keyword} 条关键词条目，可能让缓存每轮重写。`
        : `「${name}」已设为常驻。`));
    const row = el('div', 'cm-btn-row');
    if (sum.keyword) {
        const b = button('设为常驻', () => convertLore(name, book, backup));
        b.title = '常驻后每轮都发这些条目（多占上下文），聊天记录通常能读缓存；会先自动备份';
        row.append(b);
    }
    if (hasBackup) {
        row.append(button('恢复原样', () => restoreLore(name, backup)));
    }
    box.append(row);
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
        notify('bad', '世界书没改成', String(err instanceof Error ? err.message : err));
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
        notify('bad', '世界书没恢复成', String(err instanceof Error ? err.message : err));
    }
    refreshLoreBox();
}
