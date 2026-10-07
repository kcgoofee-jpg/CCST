// ──────────────────────────────────────────────
// 查看发给模型的内容: the last full request the proxy saved (设置 → 高级 → 查看)
// ──────────────────────────────────────────────

import { fetchProxy } from '../core/proxy.js';
import { el } from '../core/dom.js';
import { notify } from '../core/notify.js';

export async function showDebugRequest() {
    let data;
    try {
        const res = await fetchProxy('/debug', '/v1/debug/last');
        data = await res.json();
    } catch (err) {
        notify('bad', '没读到发给模型的请求', String(err instanceof Error ? err.message : err));
        return;
    }
    if (!data?.ok) {
        notify('info', '没有可看的请求', String(data?.error ?? '还没有保存的请求。'), { ms: 8000 });
        return;
    }
    const wrap = el('div', 'cm-debug-view');
    const s = data.settings ?? {};
    wrap.append(el('div', 'cm-note-title',
        `${new Date(data.at).toLocaleString('zh-CN')} · ${data.model} · 思考深度 ${s.effort ?? '默认'} · 深度注入${s.systemPlacement === 'hoist' ? '提到系统提示词' : '保持原位'}`));
    wrap.append(el('small', 'cm-hint', `系统提示词 ${data.systemMarked.length.toLocaleString()} 字${s.systemSplitAt ? `，缓存分界在第 ${s.systemSplitAt.toLocaleString()} 字（文中有标记）` : ''}；聊天记录 ${data.messages.length} 条。`));
    const sys = el('details', 'cm-details');
    sys.append(el('summary', null, '系统提示词'), el('pre', 'cm-debug-pre', data.systemMarked));
    wrap.append(sys);
    const hist = el('details', 'cm-details');
    hist.append(el('summary', null, '聊天记录（代理整理后的顺序）'));
    data.messages.forEach((m, i) => {
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        const item = el('details', 'cm-details');
        item.append(el('summary', null, `${i + 1}. ${m.role === 'user' ? '用户' : 'AI'} · ${text.length} 字`), el('pre', 'cm-debug-pre', text));
        hist.append(item);
    });
    wrap.append(hist);
    const ctx = SillyTavern.getContext();
    await ctx.callGenericPopup(wrap, ctx.POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
}
