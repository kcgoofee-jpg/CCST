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

export const GUIDE_STEPS = [
    { key: 'install', title: '装代理', done: (f) => f.reachable },
    { key: 'login', title: '登录', done: (f) => f.loggedIn },
    { key: 'connect', title: '连接', done: (f) => f.connected },
];
export const STEP_TITLES = Object.fromEntries(GUIDE_STEPS.map((s, i) => [i + 1, s.title]));
/** Every step done: the 完成 card. */
export const DONE_STEP = GUIDE_STEPS.length + 1;

/** Is the proxy's answer still unknown (no status check has finished yet)? */
export const proxyUnknown = (phase) => phase === 'idle' || phase === 'pending' || phase == null;

/**
 * SillyTavern's settings pointing at the proxy is only a claim; the proxy answering is the fact.
 * The connection as the guide and the status bar should see it: `connected` (the proxy) counts only
 * while the last status check says the proxy answered ('online' / 'nologin').
 */
export function gateConnection(conn, phase) {
    if (!conn?.connected) return conn;
    return phase === 'online' || phase === 'nologin' ? conn : { ...conn, connected: false };
}

/** Status bar: linked to something that works. A proxy connection whose proxy is offline is not linked. */
export const glanceLinked = (conn, phase) => !!conn?.connected && phase !== 'offline' && phase !== 'denied';

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

const started = (guideSource) => !!guideSource;

/**
 * Should a user who is already connected just be marked done (no guide)? Only when they never started
 * the guide: someone who started it and connected must still see 完成.
 */
export function shouldAutoOnboard({ onboarded, guideSource }, facts) {
    return !onboarded && !started(guideSource) && !!facts?.connected;
}

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

/** Steps 1 and 2 wait for something outside the browser: the panel polls the proxy while on them. */
export const pollsProxy = (step) => step === 1 || step === 2;
export const GUIDE_POLL_MS = 4000;

/** Settings after each user action (the caller assigns the keys back). */
export const startGuide = () => ({ onboarded: false, guideSource: 'on' });
export const finishGuide = () => ({ onboarded: true, guideSource: '' });
