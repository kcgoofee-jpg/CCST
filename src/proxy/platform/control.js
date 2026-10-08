// ──────────────────────────────────────────────
// Replies being written right now (the chat route counts them)
// ──────────────────────────────────────────────
//
// The panel reads the count to say which replies still run on the
// old backend after a switch.

// 审: 正在写的回复数；只有 busyCount（仅测试读）在读它。
// 审: 计数只给测试验证「客户端走了回复还在写」；包装本身还负责接住异步报错，不能删。
let inFlight = 0;

// 审: 包住聊天处理函数：计数 + 把异步拒绝交给 express 错误处理（express 4 不接 async 拒绝，Node 会直接崩）；routes.js 的聊天路由用。
/** Wrap the chat handler: count replies being generated until the handler
 *  itself is done — NOT until the response closes: a client that went away
 *  drops the connection while the reply keeps being written and kept
 *  (reply-keeper.js). A rejected handler goes to express's error handler
 *  instead of crashing. */
export function countInFlight(handler) {
    return async (req, res, next) => {
        inFlight++;
        try {
            await handler(req, res, next);
        } catch (err) {
            next?.(err);
        } finally {
            inFlight--;
        }
    };
}

// 审: 读当前在写的回复数，仅测试使用（见上面存疑）。
export function busyCount() {
    return inFlight;
}

// 审: 测试接缝：直接设计数。
/** Test seam. */
export function __setInFlight(n) {
    inFlight = n;
}
