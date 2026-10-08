// ──────────────────────────────────────────────
// Standalone shutdown (#33): flush the transcripts, close the listener, and
// never let a stuck socket or a second Ctrl+C leave the process hanging.
// ──────────────────────────────────────────────

// 审: 日志前缀。
const TAG = '[claude-subscription]';

// 审: 生成 SIGINT / SIGTERM 处理函数：先正常关闭，卡住或再按一次就强退；server.js 单独运行时用。
/**
 * @param {{ close: () => Promise<void>, hardExitMs?: number, exit?: (code: number) => void }} opts
 * @returns {(signal: string) => void} install as the SIGINT / SIGTERM handler
 */
export function makeShutdownHandler({ close, hardExitMs = 5000, exit = (code) => process.exit(code) }) {
    let stopping = false;
    return (signal) => {
        if (stopping) {
            // The flush is taking too long; the user is telling us so again.
            console.warn(`${TAG} 又在退出（${signal}）— 立即结束进程`);
            exit(1);
            return;
        }
        stopping = true;
        console.log(`${TAG} ${signal} — shutting down`);
        const hard = setTimeout(() => {
            console.warn(`${TAG} ${hardExitMs / 1000} 秒还没关完 — 立即结束进程`);
            exit(1);
        }, hardExitMs);
        hard.unref?.();
        Promise.resolve().then(close).then(
            () => { clearTimeout(hard); exit(0); },
            (err) => {
                console.warn(`${TAG} 关闭时出错:`, err instanceof Error ? err.message : err);
                clearTimeout(hard);
                exit(1);
            },
        );
    };
}
