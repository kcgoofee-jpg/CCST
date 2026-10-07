// ──────────────────────────────────────────────
// First-run guide (开始 → 连接 → 完成): the state logic and the wording, pure (no DOM, no ST), so the
// tests can run it. The drawing is in ../guide.js.
//
// Two settings keys drive it:
//   onboarded    true once the guide is done, skipped, or the user was already connected
//   guideSource  '' = not started; 'choose' = started, not past the welcome yet; 'proxy' = connecting
// ──────────────────────────────────────────────

/** The one way in: the local proxy (订阅 or API 密钥: the proxy's own backend form picks). */
export const SOURCES = [
    { id: 'proxy', label: '本机代理', who: '有 Claude 订阅（Pro / Max）或 Anthropic API 密钥，想要缓存排布（预计更省额度）和防丢回复。' },
];

export const isSourceId = (id) => SOURCES.some((s) => s.id === id);

/** The source the user picked, or null (not started, or started and not yet picked). */
export function chosenSource(guideSource) {
    return isSourceId(guideSource) ? guideSource : null;
}

/** Is SillyTavern's current connection the one the picked source means? */
export function sourceLinked(choice, conn) {
    if (!choice || !conn) return false;
    return choice === 'proxy' && !!conn.connected;
}

/**
 * SillyTavern's settings pointing at the proxy is only a claim; the proxy answering is the fact.
 * The connection as the guide and the status bar should see it: `connected` (the proxy) counts only
 * while the last status check says the proxy answered ('online' / 'nologin').
 */
export function gateConnection(conn, phase) {
    if (!conn?.connected) return conn;
    return phase === 'online' || phase === 'nologin' ? conn : { ...conn, connected: false };
}

/** Is the proxy's answer still unknown (no status check has finished yet)? */
export const proxyUnknown = (phase) => phase === 'idle' || phase === 'pending' || phase == null;

/** Status bar: linked to something that works. A proxy connection whose proxy is offline is not linked. */
export const glanceLinked = (conn, phase) => !!conn?.connected && phase !== 'offline' && phase !== 'denied';

const linked = (conn) => !!conn?.connected;

/**
 * Should a user who is already connected just be marked done (no guide)? Only when they never started
 * the guide: someone who picked a source and connected must still see 第 3 步.
 */
export function shouldAutoOnboard({ onboarded, guideSource }, conn) {
    return !onboarded && !guideSource && linked(conn);
}

/**
 * Which step to show: 0 = no guide; 1 选来源; 2 连接; 3 完成. Facts only, no guessing from setting values:
 *   settingsExisted  the extension's settings were already saved when the panel booted (any install
 *                    before this one): a returning user, never shown the guide on its own
 *   everConnected    SillyTavern was on the proxy at least once: a later disconnect (proxy
 *                    down, Mac asleep) shows the connect card, never the guide
 * Only a brand-new install begins at 1. 「其他 → 重新引导」 sets guideSource, which shows it for anyone.
 */
export function guideStep({ onboarded, guideSource, settingsExisted = false, everConnected = false }, conn) {
    if (onboarded) return 0;
    if (!guideSource && (settingsExisted || everConnected || linked(conn))) return 0;
    const choice = chosenSource(guideSource);
    if (!choice) return 1;
    return sourceLinked(choice, conn) ? 3 : 2;
}

export const STEP_TITLES = { 1: '开始', 2: '连接', 3: '完成' };

/** Step 3: what CCST does. */
export const SUMMARY = {
    proxy: {
        works: ['缓存排布（预计长提示词更容易命中，视预设和扩展而定）', '防丢回复（断线后补回）', '额度和用量统计', '模型与思考深度、发送前检查、最新回复检查（拒绝 / 截断）'],
        gaps: ['不支持温度、Top-P 等采样参数'],
    },
};

/** Settings after each user action (the caller assigns the keys back). */
export const startGuide = () => ({ onboarded: false, guideSource: 'choose' });
export const pickSource = (id) => ({ onboarded: false, guideSource: isSourceId(id) ? id : 'choose' });
export const backToChoose = () => ({ onboarded: false, guideSource: 'choose' });
export const finishGuide = () => ({ onboarded: true, guideSource: '' });
