// ──────────────────────────────────────────────
// Reply keeper: the last reply of each chat, in memory, for the panel to
// put back when the app lost it
// ──────────────────────────────────────────────
//
// A phone app in the background may receive a reply and never save it (the
// OS pauses its web view), or be closed mid-stream; the floor then shows
// "..." and the reply — already paid for — is gone. The UI extension tags
// each request with a slot: a short hash of the chat and the player's
// message (no text). The finished reply is kept here under that slot, IN
// MEMORY ONLY (never written to disk), for a few hours; when the chat is
// opened again and its last reply is empty, "..." or cut short, the panel
// fetches it by the same slot and puts it back.
//
// The panel's Stop button cancels by the same slot (POST …/replies/:slot/
// cancel): the generation still running for it is aborted and any reply
// kept for it is dropped, so a stopped reply never comes back.

// 审: 内存里最多留 40 条回复，防止长期运行吃内存。
const MAX_SLOTS = 40;
// 审: 回复保留 6 小时，过期视为没有；手机后台丢回复通常几小时内会回来。
const TTL_MS = 6 * 3600 * 1000;
// 审: slot 只许 8-40 位十六进制，挡掉路径/注入式的怪值（同时被路由参数和 settings 使用）。
const SLOT_RE = /^[0-9a-f]{8,40}$/;

// 审: 回复仓库，Map 插入序即最旧在前，超限时删最旧。
const kept = new Map(); // slot → { text, reasoning, finish, at }

// 审: 校验 slot 格式；keep/kept/cancel/路由都先过它；测试也直接用。
export function isValidSlot(slot) {
    return typeof slot === 'string' && SLOT_RE.test(slot);
}

// 审: chat.js 回复完成后存档，供面板在 app 丢回复时取回；空文本不存。
export function keepReply(slot, { text, reasoning = '', finish = 'stop' }) {
    if (!isValidSlot(slot) || !text) return;
    kept.delete(slot);
    kept.set(slot, { text, reasoning, finish, at: Date.now() });
    while (kept.size > MAX_SLOTS) kept.delete(kept.keys().next().value);
}

// 审: 按 slot 取回复并顺带清理过期项；now 参数仅为测试能注入时间。
export function keptReply(slot, now = Date.now()) {
    const r = isValidSlot(slot) ? kept.get(slot) : null;
    if (!r) return null;
    if (now - r.at > TTL_MS) {
        kept.delete(slot);
        return null;
    }
    return r;
}

// 审: slot → 正在跑的生成的取消函数集合，供「停止」按钮按同一 slot 中止。
// slot → cancel functions of the generations running for it (a regenerate
// can start while the previous request for the same message still runs).
const running = new Map();

// 审: chat.js 登记一次生成，返回注销函数；没了它「停止」就找不到要中止的请求。
/** Register a running generation; returns the function that unregisters it. */
export function trackGeneration(slot, cancel) {
    if (!isValidSlot(slot) || typeof cancel !== 'function') return () => {};
    const set = running.get(slot) ?? new Set();
    running.set(slot, set);
    set.add(cancel);
    return () => {
        set.delete(cancel);
        if (!set.size && running.get(slot) === set) running.delete(slot);
    };
}

// 审: 中止该 slot 在跑的生成并删掉已存回复，让停掉的回复不会被取回；chat.test 直接用。
/** Abort what is running for this slot and forget its kept reply. true if something was running. */
export function cancelReply(slot) {
    if (!isValidSlot(slot)) return false;
    let cancelled = false;
    for (const cancel of [...(running.get(slot) ?? [])]) {
        try { cancel(); cancelled = true; } catch { /* already finished */ }
    }
    kept.delete(slot);
    return cancelled;
}

// 审: 路由 POST /reply/:slot/cancel 的处理器（routes.js 注册）。
export function handleCancelReply(req, res) {
    const slot = String(req.params?.slot ?? '');
    if (!isValidSlot(slot)) return res.status(400).json({ ok: false, message: '回复编号无效' });
    res.json({ ok: true, cancelled: cancelReply(slot) });
}

// 审: 路由 GET /reply/:slot 的处理器（routes.js 注册）；没有就 404。
export function handleKeptReply(req, res) {
    const r = keptReply(String(req.params?.slot ?? ''));
    if (!r) return res.status(404).json({ ok: false });
    res.json({ ok: true, ...r });
}

// 审: 测试接缝，清空两张表让用例互不影响。
/** Test seam. */
export function __resetKeptReplies() {
    kept.clear();
    running.clear();
}
