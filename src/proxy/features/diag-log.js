// ──────────────────────────────────────────────
// Recent proxy log lines, in memory (for the diagnostics report)
// ──────────────────────────────────────────────
//
// Inside SillyTavern the proxy's console lines end up in SillyTavern's
// terminal window, which the panel cannot read and users rarely copy whole.
// Keep the proxy's own lines (tagged [claude-subscription]) in a small ring
// so 「导出诊断文件」 carries them. Lines are what the proxy logs anyway: no
// chat text (the proxy never logs message content).

// 审: 内存环最多留 300 行，防止无限增长。
const MAX_LINES = 300;
// 审: 只收带这个标记的行（本代理自己的日志）。
const TAG = '[claude-subscription]';
// 审: 最近日志行（内存环）。
const lines = [];

// 审: 把 console 参数拼成一行文本（Error 取 stack，对象转 JSON）。
function text(args) {
    return args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ');
}

// 审: 包住 console.log/warn/error 收集带标记的行；模块加载时只调用一次，故去掉了 export 和幂等守卫。
/** Start keeping tagged console lines. */
function installLogRing() {
    for (const level of ['log', 'warn', 'error']) {
        const orig = console[level].bind(console);
        console[level] = (...args) => {
            try {
                const t = text(args);
                if (t.includes(TAG)) {
                    const d = new Date();
                    const hh = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
                    lines.push(`${hh} ${level === 'log' ? '' : `${level.toUpperCase()} `}${t.replace(TAG, '').trim()}`.slice(0, 2000));
                    while (lines.length > MAX_LINES) lines.shift();
                }
            } catch { /* never break logging */ }
            orig(...args);
        };
    }
}

// 审: 取最近 n 行给诊断报告（diag-report.js 用）。
export function recentLogLines(n = 120) {
    return lines.slice(-n);
}

// 审: 加载即安装，保证代理一启动就开始收集。
installLogRing();
