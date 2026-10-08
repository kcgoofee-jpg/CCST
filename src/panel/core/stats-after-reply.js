// ──────────────────────────────────────────────
// 状态 → 上一轮 / 用量 refresh after a reply ends. The proxy writes the usage record when the stream
// closes, which can be after SillyTavern's MESSAGE_RECEIVED / GENERATION_ENDED, so: wait ~1.5 s, read,
// and if the last request did not change yet, read once more. Several events for one reply share one run.
// Pure: the refresh, the reader and the timer are passed in (tests inject fakes).
// ──────────────────────────────────────────────

// 审: 回复结束后等待代理写完用量记录的时间。
const STATS_DELAY_MS = 1500;

// 审: 用量里「上一次请求」的指纹，用来判断记录有没有更新。
const keyOf = (stats) => (stats?.phase === 'ok' && stats.data?.lastRequest ? JSON.stringify(stats.data.lastRequest) : '');

// 审: 回复后刷新用量的调度器：多个事件合并成一次，读完若没变化再等一次重读；时钟与读取可注入（测试用）。
export function makeStatsAfterReply({ refresh, getStats, canRun = () => true, delay = STATS_DELAY_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
    let timer = null;
    let running = false;
    const run = async () => {
        timer = null;
        if (running || !canRun()) return;
        running = true;
        try {
            const before = keyOf(getStats());
            await refresh();
            if (keyOf(getStats()) === before) {
                await new Promise((r) => { timer = setTimer(r, delay); });
                timer = null;
                await refresh();
            }
        } finally { running = false; }
    };
    return function schedule() {
        if (timer || running) return;
        timer = setTimer(run, delay);
    };
}
