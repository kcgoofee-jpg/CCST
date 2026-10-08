// ──────────────────────────────────────────────
// SessionStore adapter + scratch cwd + transcript privacy sweep
// ──────────────────────────────────────────────
//
// The SDK's `resume` + `sessionStore` combo lets us inject prior turns
// without touching the filesystem: the SDK calls `load()` once before
// spawning the subprocess, materializes the entries to its own temp JSONL,
// and resumes from there. `load()` matches on sessionId alone — we mint a
// fresh UUID per request, so no cwd→projectKey path math is needed
// (the part Marinara's earlier hand-rolled approach got wrong on Windows).
//
// PRIVACY: the subprocess still writes each live turn's transcript to a real
// session file (`sessionStore` cannot be combined with `persistSession:
// false`): in the SDK's temporary config dir ($TMPDIR/claude-resume-<uuid>/,
// which also holds a copy of the credentials and is removed by the SDK when
// the query ends) or under ~/.claude/projects/<scratch-key>/. Marinara leaves
// those roleplay transcripts on disk until Claude Code's cleanupPeriodDays
// reaps them — we don't: after each request the proxy best-effort deletes
// the session via the SDK's own deleteSession(), and at start-up it sweeps
// what a crash or kill left behind (sweepLeftovers). Roleplay content should
// not persist in plaintext outside SillyTavern.

import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// 审: 控制台日志统一前缀（多个文件各自重复定义了一份，跨分区未合并）。
const PLUGIN_TAG = '[claude-subscription]';

// 审: 把合成历史喂给 SDK resume 的一次性 SessionStore；没了就无法不落盘地注入历史。
/** One-shot in-process SessionStore holding the synthetic history for a
 *  single query() call. `append()` is a required part of the contract but a
 *  deliberate no-op — SillyTavern owns chat persistence. */
export class ResumeSessionStore {
    #sessionId;
    #entries;
    // 审: 回调：SDK 每次 append 把 CLI 写的条目交给 turn-capture 偷看。
    #onAppend;

    // 审: 绑定本次请求的 sessionId、历史条目和可选的捕获回调。
    constructor(sessionId, entries, onAppend = null) {
        this.#sessionId = sessionId;
        this.#entries = entries;
        this.#onAppend = onAppend;
    }

    // 审: SDK 恢复会话时调用，只认本次的 sessionId，其它返回 null。
    load(key) {
        return Promise.resolve(key.sessionId === this.#sessionId ? this.#entries : null);
    }

    // 审: SessionStore 接口要求有 append；这里不持久化，只把条目交给捕获回调（出错也不影响请求）。
    append(_key, entries) {
        // SillyTavern owns chat persistence; we only peek at what the CLI
        // wrote for this turn (see turn-capture.js).
        try { this.#onAppend?.(entries); } catch { /* capture is best-effort */ }
        return Promise.resolve();
    }
}

// 审: 暂存目录路径缓存，免得每次请求重新算。
// Scratch working directory for SDK subprocess cwd — keeps the live-turn
// transcripts in their own project bucket instead of intermingling with the
// user's real `claude` CLI sessions. Recreated on demand if pruned.
// It lives OUTSIDE any git repo: the CLI tells the model the cwd's git
// status and loads that project's auto-memory, and with the old
// `<plugin>/.scratch-cwd` location that meant this repo's branch/status (and,
// for a developer, their Claude Code memory notes) reached the roleplay.
let cachedScratchCwd = null;

// 审: 给 SDK 子进程用的工作目录（在 git 仓库之外，避免把仓库状态/记忆带给角色扮演）；chat.js 与 sweepLeftovers 使用。
export function resumeScratchCwd() {
    const dir = cachedScratchCwd ?? (process.env.CLAUDE_SUBSCRIPTION_SCRATCH_CWD || join(tmpdir(), 'claude-max-rp'));
    mkdirSync(dir, { recursive: true });
    cachedScratchCwd = dir;
    return dir;
}

// 审: 等待 2 秒定时器触发的会话记录清理任务，关机时 flushSweeps 要把它们立刻跑完。
/**
 * Best-effort removal of the live-turn transcript the subprocess wrote for
 * this session. Fire-and-forget; failures only mean the file waits for
 * Claude Code's own cleanupPeriodDays sweep instead.
 */
const pendingSweeps = new Map(); // sessionId → { timer, run }

// 审: 请求结束后延迟 2 秒用 SDK 的 deleteSession 删掉子进程写的会话记录（隐私：不让角色扮演内容留在磁盘）。
export function sweepSessionTranscript(loadSdk, sessionId) {
    let started = null;
    const run = () => {
        started ??= (async () => {
            pendingSweeps.delete(sessionId);
            try {
                const sdk = await loadSdk();
                if (typeof sdk.deleteSession !== 'function') {
                    // A SDK that renamed it would leave every transcript on disk silently (#30).
                    console.warn(`${PLUGIN_TAG} SDK 没有 deleteSession，这份会话记录没清（${sessionId}）—— SDK 版本和代理不匹配，请按文档锁定版本`);
                } else {
                    await sdk.deleteSession(sessionId);
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                // "not found" is fine — nothing was persisted for this session.
                if (!/not found/i.test(msg)) {
                    console.warn(`${PLUGIN_TAG} transcript sweep for ${sessionId} skipped: ${msg}`);
                }
            }
        })();
        return started;
    };
    const timer = setTimeout(run, 2000);
    timer.unref?.();
    pendingSweeps.set(sessionId, { timer, run });
}

// 审: 关机时立刻执行还没到时间的清理（定时器是 unref 的，不处理会永远不触发）；server.js 使用。
/** Run the sweeps still waiting on their timer now (shutdown: the timers are
 *  unref'd and would otherwise never fire). */
export async function flushSweeps() {
    const waiting = [...pendingSweeps.values()];
    for (const { timer } of waiting) clearTimeout(timer);
    await Promise.allSettled(waiting.map(({ run }) => run()));
}

// 审: 超过 30 分钟的遗留才算上次崩溃留下的，避免误删正在跑的请求。
// Leftovers older than this are from a proxy that is gone (a reply runs for
// minutes at most; the SDK deletes its own temp dir when the query ends).
const LEFTOVER_AGE_MS = 30 * 60 * 1000;
// 审: SDK 临时配置目录的名字格式；只清符合这个格式的目录。
// The SDK's temp config dir: `claude-resume-${randomUUID()}` in os.tmpdir()
// (@anthropic-ai/claude-agent-sdk sdk.mjs). Other SDK apps use the same name,
// so only dirs whose projects/ holds nothing but our scratch project count.
const RESUME_DIR_RE = /^claude-resume-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// 审: 复刻 CLI 把 cwd 变成项目目录名的规则（非字母数字都换成 -）；sweepLeftovers 与测试使用。
/** The CLI's project-dir name for a cwd: every non-alphanumeric → '-'. */
export function projectKeyFor(dir) {
    let real = dir;
    try { real = realpathSync(dir); } catch { /* not created yet */ }
    return real.replace(/[^a-zA-Z0-9]/g, '-');
}

// 审: 启动时清理上次崩溃遗留的会话记录和 SDK 临时目录；server.js 启动调用。
/**
 * Start-up sweep: session transcripts in the scratch project dir and stale
 * SDK temp dirs of ours, older than LEFTOVER_AGE_MS. Returns what was removed.
 */
export function sweepLeftovers({ now = Date.now(), tmp = tmpdir(), configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), scratch = null } = {}) {
    const removed = { transcripts: 0, tempDirs: 0 };
    const warn = (what, where, err) => console.warn(`${PLUGIN_TAG} 清理${what}没做成（${where}）：${err instanceof Error ? err.message : err}`);
    let key;
    try {
        key = projectKeyFor(scratch ?? resumeScratchCwd());
    } catch (err) {
        // #30: a CLAUDE_CONFIG_DIR layout change would otherwise hide itself here.
        warn('会话记录目录（找不到本代理的工作目录）', 'scratch', err);
        return removed;
    }
    const old = (p) => { try { return now - statSync(p).mtimeMs > LEFTOVER_AGE_MS; } catch { return false; } };
    const project = join(configDir, 'projects', key);
    try {
        for (const name of readdirSync(project)) {
            // <session-uuid>.jsonl and its <session-uuid>/ side dir (subagents, tool results)
            if (!/^[0-9a-f-]{36}(\.jsonl)?$/.test(name)) continue;
            const p = join(project, name);
            if (!old(p)) continue;
            rmSync(p, { recursive: true, force: true });
            removed.transcripts++;
        }
    } catch (err) {
        if (existsSync(project)) warn('上次遗留的会话记录', project, err);
    }
    try {
        for (const name of readdirSync(tmp)) {
            if (!RESUME_DIR_RE.test(name)) continue;
            const dir = join(tmp, name);
            if (!old(dir)) continue;
            let projects = [];
            try { projects = existsSync(join(dir, 'projects')) ? readdirSync(join(dir, 'projects')) : []; } catch { continue; }
            if (projects.some((p) => p !== key)) continue; // another app's session
            rmSync(dir, { recursive: true, force: true });
            removed.tempDirs++;
        }
    } catch (err) {
        warn('SDK 临时目录', tmp, err);
    }
    return removed;
}
