// ──────────────────────────────────────────────
// 状态 → 上一轮 / 用量 refresh after a reply ends. The proxy writes the usage record when the stream
// closes, which can be after SillyTavern's MESSAGE_RECEIVED / GENERATION_ENDED, so: wait ~1.5 s, read,
// and if the last request did not change yet, read once more. Several events for one reply share one run.
// Pure: the refresh, the reader and the timer are passed in (tests inject fakes).
// ──────────────────────────────────────────────

export const STATS_DELAY_MS = 1500;

const keyOf = (stats) => (stats?.phase === 'ok' && stats.data?.lastRequest ? JSON.stringify(stats.data.lastRequest) : '');

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
