// ──────────────────────────────────────────────
// Recent proxy log lines, in memory (for the diagnostics report)
// ──────────────────────────────────────────────
//
// Inside SillyTavern the proxy's console lines end up in SillyTavern's
// terminal window, which the panel cannot read and users rarely copy whole.
// Keep the proxy's own lines (tagged [claude-subscription]) in a small ring
// so 「导出诊断文件」 carries them. Lines are what the proxy logs anyway: no
// chat text (the proxy never logs message content).

const MAX_LINES = 300;
const TAG = '[claude-subscription]';
const lines = [];
let installed = false;

function text(args) {
    return args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ');
}

/** Start keeping tagged console lines (idempotent). */
export function installLogRing() {
    if (installed) return;
    installed = true;
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

export function recentLogLines(n = 120) {
    return lines.slice(-n);
}

installLogRing();
