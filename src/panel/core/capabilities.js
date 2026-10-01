// ──────────────────────────────────────────────
// Platform capabilities: every "what am I running on / talking to" check in
// one place (they used to be scattered through the panel).
//
//   • TauriTavern (no server plugins), a touch device (COARSE), phone-like
//   • which chat-completion source SillyTavern is on: this proxy ("ours"),
//     Claude without the proxy ("direct"), or something else
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

/** A phone or TauriTavern: the devices that get the lighter display and phone wording. */
export function isPhoneLike(p = platform) {
    return !!(p.tauri || p.coarse);
}

/** The 省电显示 setting normalised to 'auto' | 'on' | 'off'. */
export function quietRenderMode(setting) {
    return ['on', 'off'].includes(setting) ? setting : 'auto';
}

/** 省电显示 is in effect: on for phones and TauriTavern unless the debug switch says otherwise. */
export function quietRenderOn(setting, p = platform) {
    return setting === 'on' || (setting !== 'off' && isPhoneLike(p));
}

/** The plugin route speaks for the proxy on the default port only: with another endpoint
 *  (phone → Mac, another port) or in TauriTavern, calls go to the proxy itself and nothing else. */
export function proxyDirectOnly({ tauri, endpoint }) {
    return !!tauri || normalizeEndpoint(endpoint) !== normalizeEndpoint(DEFAULT_ENDPOINT);
}

/** Cloud-hosted SillyTavern with a loopback proxy address (needs shared/host.js; without it, no note). */
export function cloudHosted(hostCheck, { hostname, endpoint, tauri }) {
    return !!hostCheck?.cloudNeedsNote({ hostname, endpoint, tauri });
}

/** Phone → Mac sync only makes sense from inside TauriTavern on a proxy in phone mode. */
export function canSyncPhone(macStatus, p = platform) {
    return !!(macStatus?.phoneMode && p.tauri);
}

/** 同步手机 inside TauriTavern: TT has its own sync / backup; Mac-to-TT sync is untested. */
export const PHONE_SYNC_WARNING = 'TauriTavern 自带同步和备份，建议用它；电脑酒馆和 TT 之间的同步还没测试过，可能有问题。';
export const PHONE_SYNC_LABEL = '仍要同步（未测试）';

/** 查看发给模型的内容 needs 保存最近一次完整请求 to be on; otherwise the button is greyed with this hint. */
export function debugViewState(settings) {
    return settings?.debugDump
        ? { enabled: true, hint: '' }
        : { enabled: false, hint: '先打开上面的开关，再聊一轮。' };
}

const CLAUDE_OPENROUTER = /claude/i;

/**
 * Where SillyTavern sends chat requests, from its settings.
 *   connected: this proxy (everything works)
 *   direct:    Claude without this proxy — SillyTavern's own Claude source, or a Claude model on an
 *              aggregator. Local features work there too; cache layout, reply recovery, quota need the proxy.
 * `sources` (shared/sources.js) is optional: without it only the Claude source and OpenRouter are known.
 */
export function resolveConnection({ mainApi, oai = {}, settings, sources = null }) {
    const src = mainApi === 'openai' ? oai.chat_completion_source : null;
    if (src === 'custom' && isOurEndpoint(oai.custom_url, settings)) {
        return { kind: 'ours', connected: true, direct: false, model: oai.custom_model, where: '本机代理', billing: '订阅' };
    }
    if (sources) {
        const model = oai[sources.CLAUDE_SOURCES[src]?.modelKey] ?? null;
        const d = sources.describeSource({ source: src, model, reverseProxy: src === 'claude' ? oai.reverse_proxy : '' });
        if (d) return { kind: src, connected: false, direct: true, model, where: d.where, billing: d.billing };
        return { kind: 'other', connected: false, direct: false, model: null };
    }
    if (src === 'claude') return { kind: 'claude', connected: false, direct: true, model: oai.claude_model ?? null, where: 'Claude 官方', billing: 'API 密钥' };
    if (src === 'openrouter' && CLAUDE_OPENROUTER.test(oai.openrouter_model ?? '')) {
        return { kind: 'openrouter', connected: false, direct: true, model: oai.openrouter_model, where: 'OpenRouter', billing: 'OpenRouter 额度' };
    }
    return { kind: 'other', connected: false, direct: false, model: null };
}

/** A chat request about to leave (CHAT_COMPLETION_SETTINGS_READY): ours, direct to Claude, or someone else's. */
export function classifyRequest(data, settings, sources = null) {
    const ours = data.chat_completion_source === 'custom' && isOurEndpoint(data.custom_url, settings);
    const direct = !ours && (sources
        ? !!sources.describeSource({ source: data.chat_completion_source, model: data.model })
        : data.chat_completion_source === 'claude' || (data.chat_completion_source === 'openrouter' && CLAUDE_OPENROUTER.test(String(data.model ?? ''))));
    return { ours, direct };
}

/** The status bar's text while a reply is being written or has just finished; '' when idle. */
export function genLine(gen) {
    if (!gen || gen.kind === 'idle') return '';
    const n = (v) => Number(v).toLocaleString('en-US');
    if (gen.kind === 'thinking') return `思考中 ${Math.max(0, Math.round((Date.now() - gen.startedAt) / 1000))} 秒`;
    if (gen.kind === 'writing') return `写作中 ${n(gen.chars ?? 0)} 字`;
    return ['完成', gen.chars != null ? `${n(gen.chars)} 字` : null, gen.seconds != null ? `${gen.seconds} 秒` : null, gen.cache != null ? `缓存 ${Math.round(gen.cache)}%` : null, gen.flag || null].filter(Boolean).join(' · ');
}
