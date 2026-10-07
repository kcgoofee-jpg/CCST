// ──────────────────────────────────────────────
// Platform capabilities: every "what am I running on / talking to" check in
// one place (they used to be scattered through the panel).
//
//   • TauriTavern (no server plugins), a touch device (COARSE)
//   • which chat-completion source SillyTavern is on: this proxy ("ours"), or something else
//   • whether the proxy can be reached only directly (no ST plugin route)
//   • cloud-hosted SillyTavern
//
// The functions are pure (state is passed in) so the tests can run them
// without a browser; `platform` / IS_TAURI / COARSE read the window once.
// ──────────────────────────────────────────────

export const DEFAULT_ENDPOINT = 'http://127.0.0.1:8901/v1';

export function normalizeEndpoint(url) {
    return String(url ?? '').trim().replace(/\/+$/, '');
}

/** ST's Custom URL is this proxy's address. */
export function isOurEndpoint(customUrl, settings) {
    const a = normalizeEndpoint(customUrl);
    return a !== '' && (a === normalizeEndpoint(settings.endpoint) || a === normalizeEndpoint(settings.stEndpoint));
}

/** The address SillyTavern's server uses for the proxy: differs from the browser's only when they are deployed apart. */
export function stSideEndpoint(settings) {
    return normalizeEndpoint(settings.stEndpoint) || normalizeEndpoint(settings.endpoint);
}

/** The proxy's own base URL: the endpoint without its /v1. */
export function proxyBaseOf(endpoint) {
    return normalizeEndpoint(endpoint).replace(/\/v1$/, '');
}

/** What the page is running in. Read once; `win` is injectable for tests. */
export function detectPlatform(win = globalThis.window) {
    return {
        tauri: !!win?.__TAURITAVERN__,
        coarse: win?.matchMedia?.('(pointer: coarse)')?.matches ?? false,
        hostname: win?.location?.hostname ?? '',
    };
}

export const platform = detectPlatform();
// TauriTavern has a Rust backend: no server plugins, so the ST-origin
// /api/plugins routes don't exist — talk to the standalone proxy directly.
export const IS_TAURI = platform.tauri;
export const COARSE = platform.coarse;
/** What the app is called in panel text: TauriTavern there, 酒馆 elsewhere. */
export const appName = (tauri = IS_TAURI) => (tauri ? 'TauriTavern' : '酒馆');
export const APP_NAME = appName();

/** The plugin route speaks for the proxy on the default port only: with another endpoint
 *  (another machine, another port) or in TauriTavern, calls go to the proxy itself and nothing else. */
export function proxyDirectOnly({ tauri, endpoint }) {
    return !!tauri || normalizeEndpoint(endpoint) !== normalizeEndpoint(DEFAULT_ENDPOINT);
}

/** Cloud-hosted SillyTavern with a loopback proxy address (needs shared/host.js; without it, no note). */
export function cloudHosted(hostCheck, { hostname, endpoint, tauri }) {
    return !!hostCheck?.cloudNeedsNote({ hostname, endpoint, tauri });
}

/** 查看发给模型的内容 needs 保存最近一次完整请求 to be on; otherwise the button is greyed with this hint. */
export function debugViewState(settings) {
    return settings?.debugDump
        ? { enabled: true, hint: '' }
        : { enabled: false, hint: '先打开上面的开关，再聊一轮。' };
}

/**
 * Where SillyTavern sends chat requests, from its settings.
 *   connected: this proxy (everything works); anything else is not ours.
 */
export function resolveConnection({ mainApi, oai = {}, settings }) {
    const src = mainApi === 'openai' ? oai.chat_completion_source : null;
    if (src === 'custom' && isOurEndpoint(oai.custom_url, settings)) {
        return { kind: 'ours', connected: true, model: oai.custom_model, where: '本机代理', billing: '订阅' };
    }
    return { kind: 'other', connected: false, model: null };
}

/** A chat request about to leave (CHAT_COMPLETION_SETTINGS_READY): ours or someone else's. */
export function classifyRequest(data, settings) {
    return { ours: data.chat_completion_source === 'custom' && isOurEndpoint(data.custom_url, settings) };
}

/** The status bar's text while a reply is being written or has just finished; '' when idle. */
export function genLine(gen) {
    if (!gen || gen.kind === 'idle') return '';
    const n = (v) => Number(v).toLocaleString('en-US');
    if (gen.kind === 'thinking') return `思考中 ${Math.max(0, Math.round((Date.now() - gen.startedAt) / 1000))} 秒`;
    if (gen.kind === 'writing') return `写作中 ${n(gen.chars ?? 0)} 字`;
    return ['完成', gen.chars != null ? `${n(gen.chars)} 字` : null, gen.seconds != null ? `${gen.seconds} 秒` : null, gen.cache != null ? `缓存 ${Math.round(gen.cache)}%` : null, gen.flag || null].filter(Boolean).join(' · ');
}

/**
 * The id the 「模型」 cards need as an extra option: the current model's canonical Claude id when it is a
 * Claude model that is not one of `picks`; '' otherwise (a leftover Gemini / GPT id never gets a card).
 * `canonical(id)` is shared/sources.js canonicalModel (null for non-Claude).
 */
export function extraModelId(model, picks, canonical) {
    const key = canonical(model);
    return key && !picks.some((o) => o.value === key) ? key : '';
}
