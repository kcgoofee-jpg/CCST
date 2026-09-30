// ──────────────────────────────────────────────
// After a reply: what the proxy actually served (see the notices in the last request's stats)
// ──────────────────────────────────────────────

import { fetchProxy } from '../core/proxy.js';
import { shortModel } from '../core/connection.js';
import { notify } from '../core/notify.js';
import { F } from '../core/registry.js';

// After a reply: tell the user when the proxy served something other
// than what was asked for (base model instead of 1M, a reply cut off by a
// safety stop, or redone by another model). Once per request.
let lastNoticeAt = 0;
export async function noticeLastTurn() {
    try {
        const res = await fetchProxy('/stats', '/v1/usage/stats');
        if (!res.ok) return;
        const data = await res.json();
        const last = data.lastRequest;
        if (!last || last.auxiliary || last.at <= lastNoticeAt || Date.now() - last.at > 5 * 60 * 1000) return;
        lastNoticeAt = last.at;
        F.island.islandDone({ cache: data.lastCache?.hitPct ?? null, seconds: last.durationMs != null ? Math.round(last.durationMs / 1000) : null });
        const notices = last.notices ?? [];
        const fallback = notices.find((n) => n.startsWith('fallback:'))?.slice(9);
        if (fallback) {
            notify('warn', `换了模型：${shortModel(fallback)} 重写`, `${shortModel(last.model)} 被安全机制中途截断。文风可能不同，格式可能错乱。`, { ms: 15000 });
        } else if (notices.includes('refusal') || last.finish === 'content_filter') {
            notify('warn', '回复被安全机制截断', '结尾缺了内容（变量、状态栏可能报错）。重新生成，或回退一楼换个说法。', { ms: 15000 });
        } else if (last.finish === 'length') {
            notify('warn', '回复写到最大长度被截断', '调高酒馆的「最大回复长度」。', { ms: 12000 });
        }
        if (notices.includes('no-1m')) {
            notify('info', '这一轮用的是普通上下文', `1M 额度不可用，用了 ${shortModel(last.model).replace(/\s*1M$/, '')}，一小时后再试 1M。`, { ms: 12000 });
        }
    } catch { /* proxy unreachable: the status block already says so */ }
}
