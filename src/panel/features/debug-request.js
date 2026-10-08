// ──────────────────────────────────────────────
// 查看发给模型的内容: the last chat request as the proxy handed it to Claude (设置 → 查看), kept in the proxy's memory
// ──────────────────────────────────────────────

import { fetchProxy } from '../core/proxy.js';
import { el } from '../core/dom.js';
import { notify } from '../core/notify.js';

// 审: 设置 → 检查 →「发送内容」：从代理取最后一次请求（代理内存里）并以弹窗展示，让用户看到实际发给模型的内容。
export async function showDebugRequest() {
    let data;
    try {
        const res = await fetchProxy('/debug', '/v1/debug/last');
        data = await res.json();
    } catch (err) {
        notify('bad', '读取失败', String(err instanceof Error ? err.message : err));
        return;
    }
    if (!data?.ok) {
        notify('info', '暂无请求', String(data?.error ?? '先聊一句再看'), { ms: 8000 });
        return;
    }
    const wrap = el('div', 'cm-debug-view');
    wrap.append(el('div', 'cm-note-title', `${new Date(data.at).toLocaleString('zh-CN')} · ${data.model}`));
    wrap.append(el('small', 'cm-hint', `设定 ${data.systemMarked.length.toLocaleString()} 字 · 记录 ${data.messages.length} 条`));
    const sys = el('details', 'cm-details');
    sys.append(el('summary', null, '设定部分'), el('pre', 'cm-debug-pre', data.systemMarked));
    wrap.append(sys);
    const hist = el('details', 'cm-details');
    hist.append(el('summary', null, '聊天记录'));
    data.messages.forEach((m, i) => {
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        const item = el('details', 'cm-details');
        item.append(el('summary', null, `${i + 1}. ${m.role === 'user' ? '你' : 'AI'} · ${text.length} 字`), el('pre', 'cm-debug-pre', text));
        hist.append(item);
    });
    wrap.append(hist);
    const ctx = SillyTavern.getContext();
    await ctx.callGenericPopup(wrap, ctx.POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
}
