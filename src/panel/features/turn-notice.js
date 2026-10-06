// ──────────────────────────────────────────────
// After a reply: what the proxy actually served (see the notices in the last request's stats)
// ──────────────────────────────────────────────

import { fetchProxy } from '../core/proxy.js';
import { shortModel } from '../core/connection.js';
import { notify } from '../core/notify.js';
import { F } from '../core/registry.js';
import { libs } from '../core/libs.js';
import { chatKeyOf } from '../core/chat-key.js';

// After a reply: tell the user when the proxy served something other
// than what was asked for (base model instead of 1M, a reply cut off by a
// safety stop, or redone by another model). Once per request.
let lastNoticeAt = 0;
export async function noticeLastTurn() {
    try {
        // This chat's own reply only: never a background call, never another chat.
        const chat = encodeURIComponent(chatKeyOf(SillyTavern.getContext()) ?? 'none');
        const res = await fetchProxy(`/stats?chat=${chat}`, `/v1/usage/stats?chat=${chat}`);
        if (!res.ok) return;
        const data = await res.json();
        const last = data.lastRequest;
        if (!last || last.auxiliary || last.at <= lastNoticeAt || Date.now() - last.at > 5 * 60 * 1000) return;
        lastNoticeAt = last.at;
        const flag = libs.chatCheck?.replyFlags?.(null, last)[0]?.short;
        F.progress.genDone({ cache: data.lastCache?.hitPct ?? null, seconds: last.durationMs != null ? Math.round(last.durationMs / 1000) : null, ...(flag ? { flag } : {}) });
        F.checkup.renderLatestFlags();
        const notices = last.notices ?? [];
        const fallback = notices.find((n) => n.startsWith('fallback:'))?.slice(9);
        if (fallback) {
            notify('warn', `换了模型：${shortModel(fallback)} 重写`, `${shortModel(last.model)} 写到一半被安全机制拦下，改由 ${shortModel(fallback)} 重写了整条，文风和格式可能和前文不一样。`, { ms: 15000 });
        } else if (notices.includes('refusal') || last.finish === 'content_filter') {
            const r = libs.chatCheck?.refusalNotice(last);
            notify('warn', r?.title ?? '回复被安全机制截断', r?.text ?? '这条回复写到一半被安全机制拦下，结尾缺了内容（变量、状态栏可能出错）。重新生成，或改一下上一条再发。', { ms: 15000 });
        } else if (last.finish === 'length') {
            notify('warn', '回复写到最大长度被截断', '调大酒馆的「最大回复长度」后重新生成。', { ms: 12000 });
        }
        if (notices.includes('no-1m')) {
            notify('info', '这一轮没用上 1M 上下文', `订阅的 1M 额度现在用不了，这轮用了普通上下文的 ${shortModel(last.model).replace(/\s*1M$/, '')}；约一小时后再试 1M。`, { ms: 12000 });
        }
        if (notices.includes('replay-reset')) {
            notify('warn', '已重置逐轮还原状态', '代理连着几轮没能还原上几轮的写法（多半是 Claude 命令行升级了），已重新开始；本轮缓存会全量重写一次，下一轮起恢复正常。', { ms: 15000 });
        }
    } catch { /* proxy unreachable: the status block already says so */ }
}
