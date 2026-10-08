// ──────────────────────────────────────────────
// First-run guide (装代理 → 登录 → 连接 → 完成): the state logic, pure (no DOM, no ST), so the tests can
// run it. The drawing is in ../guide.js.
//
// The steps depend only on three facts, never on how the proxy was installed:
//   reachable  the proxy answered /status
//   loggedIn   it says a Claude login is there
//   connected  SillyTavern's connection points at it
// A different backend (the Rust one on the dev branch) reuses the flow by swapping step 1's content.
//
// Two settings keys drive whether it shows:
//   onboarded    true once the guide is done, skipped, or the user was already connected
//   guideSource  '' = not started on purpose; anything else = started (「重新引导」; older versions
//                saved 'choose' / 'proxy', which count as started too)
// ──────────────────────────────────────────────

// 审: 首次引导的三步及各自「完成」的判据（只看代理是否应答/已登录/酒馆是否连上，不关心怎么装的）。
export const GUIDE_STEPS = [
    { key: 'install', title: '安装', done: (f) => f.reachable },
    { key: 'login', title: '登录', done: (f) => f.loggedIn },
    { key: 'connect', title: '连接', done: (f) => f.connected },
];
// 审: 三步都完成后的第 4 步（完成卡片）。
/** Every step done: the 完成 card. */
export const DONE_STEP = GUIDE_STEPS.length + 1;

// 审: 状态检测还没出结果（idle/pending）；测试引用，生产里 guideFacts 用它。
/** Is the proxy's answer still unknown (no status check has finished yet)? */
export const proxyUnknown = (phase) => phase === 'idle' || phase === 'pending' || phase == null;

// 审: 顶栏「已连上」的判据：连着本代理且代理没离线/被拒。
/** Status bar: linked to something that works. A proxy connection whose proxy is offline is not linked. */
export const glanceLinked = (conn, phase) => !!conn?.connected && phase !== 'offline' && phase !== 'denied';

// 审: 从状态阶段和酒馆连接得出引导依赖的三条事实（可达/已登录/已连接）。
/** The three facts from the last status check (`phase`) and SillyTavern's connection (`conn`). */
export function guideFacts(conn, phase) {
    const reachable = phase === 'online' || phase === 'nologin';
    return {
        checking: proxyUnknown(phase),
        reachable,
        loggedIn: phase === 'online',
        connected: reachable && !!conn?.connected,
    };
}

// 审: guideSource 非空即「引导已开始」（兼容旧版的 'choose' / 'proxy'）。
const started = (guideSource) => !!guideSource;

// 审: 从没开始过引导却已连上的用户直接标记完成、不弹引导。
/**
 * Should a user who is already connected just be marked done (no guide)? Only when they never started
 * the guide: someone who started it and connected must still see 完成.
 */
export function shouldAutoOnboard({ onboarded, guideSource }, facts) {
    return !onboarded && !started(guideSource) && !!facts?.connected;
}

// 审: 当前该显示哪一步（0 不显示）；老用户/曾连上过的断线不弹引导，只有全新安装或点「重新引导」才弹。
/**
 * Which step to show: 0 = no guide; 1 装代理; 2 登录; 3 连接; 4 (DONE_STEP) 完成.
 *   settingsExisted  the extension's settings were already saved when the panel booted (any install
 *                    before this one): a returning user, never shown the guide on its own
 *   everConnected    SillyTavern was on the proxy at least once: a later disconnect (proxy
 *                    down, Mac asleep) shows the connect card, never the guide
 * Only a brand-new install shows it by itself. 「设置 → 重新引导」 sets guideSource, which shows it for anyone.
 */
export function guideStep({ onboarded, guideSource, settingsExisted = false, everConnected = false }, facts) {
    if (onboarded) return 0;
    if (!started(guideSource) && (settingsExisted || everConnected || facts?.connected)) return 0;
    const i = GUIDE_STEPS.findIndex((s) => !s.done(facts ?? {}));
    return i === -1 ? DONE_STEP : i + 1;
}

// 审: 第 1、2 步在等浏览器外的事，面板要轮询代理。
/** Steps 1 and 2 wait for something outside the browser: the panel polls the proxy while on them. */
export const pollsProxy = (step) => step === 1 || step === 2;
// 审: 引导期间轮询代理的间隔。
export const GUIDE_POLL_MS = 4000;

// 审: 「重新引导」要写回设置的两个键。
/** Settings after each user action (the caller assigns the keys back). */
export const startGuide = () => ({ onboarded: false, guideSource: 'on' });
// 审: 完成/跳过引导要写回设置的两个键。
export const finishGuide = () => ({ onboarded: true, guideSource: '' });
