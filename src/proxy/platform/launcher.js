// ──────────────────────────────────────────────
// The one place that shells out to the launcher (launcher/mac/lib.zsh)
// ──────────────────────────────────────────────
//
// Everything the proxy asks of the Mac launcher goes through here: run a
// snippet after sourcing lib.zsh, write a launcher log line plus a Mac
// notification, and read the tail of a log file. Nothing else in src/proxy
// spawns zsh, so a change to lib.zsh's interface only touches this file.

import { execFile, spawn } from 'node:child_process';
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../paths.js';

const LAUNCHER_LIB = join(ROOT, 'launcher', 'mac', 'lib.zsh');
/** File whose presence pauses the lid-awake keeper (read by the launcher too). */
export const LID_PAUSE_FILE = join(ROOT, 'launcher', 'lid-pause.local');

/** Is there a Mac launcher to talk to? (macOS with launcher/mac/lib.zsh present) */
export function launcherAvailable() {
    return existsSync(LAUNCHER_LIB) && process.platform === 'darwin';
}

/** Put a value on a zsh command line so nothing in it runs: single quotes are
 *  literal in POSIX shells, and a ' inside the value is spelled '\''.
 *  JSON.stringify's double quotes would keep `$HOME` and backticks live, and a
 *  path holding them would expand (or execute) inside the sourced command. */
export function shQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Run `script` in zsh after sourcing lib.zsh. Detached: fire and forget ('' at once);
 *  otherwise resolves with stdout ('' on error, 15 s timeout). */
export function zsh(script, { detached = false } = {}) {
    const args = ['-c', `source ${shQuote(LAUNCHER_LIB)}; ${script}`];
    if (detached) {
        const child = spawn('/bin/zsh', args, { detached: true, stdio: 'ignore' });
        child.unref();
        return Promise.resolve('');
    }
    return new Promise((resolve) => {
        execFile('/bin/zsh', args, { timeout: 15000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
    });
}

/** Launcher log line + Mac notification. */
export function logEvent(text) {
    return zsh(`log_event ${shQuote(`[遥控] ${text}`)}; osascript -e ${shQuote(`display notification "${text.replace(/"/g, '')}" with title "CCST · 手机遥控"`)} >/dev/null 2>&1`);
}

/** Last `lines` non-empty lines of a text file (reads at most its last 64 KB). */
export function tail(file, lines) {
    try {
        const size = statSync(file).size;
        const len = Math.min(size, 64 * 1024);
        const buf = Buffer.alloc(len);
        const fd = openSync(file, 'r');
        readSync(fd, buf, 0, len, size - len);
        closeSync(fd);
        return buf.toString('utf8').split('\n').filter(Boolean).slice(-lines);
    } catch {
        return [];
    }
}
