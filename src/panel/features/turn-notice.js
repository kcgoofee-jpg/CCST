// ──────────────────────────────────────────────
// After a reply: what the proxy actually served (see the notices in the last request's stats)
// ──────────────────────────────────────────────

import { fetchProxy } from '../core/proxy.js';
import { shortModel } from '../core/connection.js';
import { notify } from '../core/notify.js';
import { F } from '../core/registry.js';
import { libs } from '../core/libs.js';
import { chatKeyOf } from '../core/chat-key.js';

// 审: 已提示过的最近一次请求时间，保证每个请求只提示一次。
// After a reply: tell the user when the proxy served something other
// than what was asked for (base model instead of 1M, a reply cut off by a
// safety stop, or redone by another model). Once per request.
let lastNoticeAt = 0;
// 审: 一轮回复后读代理对本聊天上一次请求的记录：补完成行的缓存/用时，并告知换了模型、被拦、写满、没用上 1M、重写缓存等。
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
        F.progress.genDone({ cache: data.lastCache?.reusePct ?? data.lastCache?.hitPct ?? null, seconds: last.durationMs != null ? Math.round(last.durationMs / 1000) : null, ...(flag ? { flag } : {}) });
        F.checkup.renderLatestFlags();
        const notices = last.notices ?? [];
        const fallback = notices.find((n) => n.startsWith('fallback:'))?.slice(9);
        if (fallback) {
            notify('warn', '已换模型', `${shortModel(last.model)} 被拦，改由 ${shortModel(fallback)} 重写`, { ms: 15000 });
        } else if (notices.includes('refusal') || last.finish === 'content_filter') {
            const r = libs.chatCheck?.refusalNotice(last);
            notify('warn', r?.title ?? '被拦一半', r?.text ?? '结尾缺了，重新生成试试', { ms: 15000 });
        } else if (last.finish === 'length') {
            notify('warn', '写满了', '调大「最大回复长度」', { ms: 12000 });
        }
        if (notices.includes('no-1m')) {
            notify('info', '没用上 1M', '暂时不可用，约 1 小时后再试', { ms: 12000 });
        }
        if (notices.includes('replay-reset')) {
            notify('warn', '缓存断了一次', '这轮多写，下轮恢复', { ms: 15000 });
        }
    } catch { /* proxy unreachable: the status block already says so */ }
}
