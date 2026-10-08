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

// 审: 代理的默认地址；设置里没改就是它，proxyDirectOnly 也拿它判断「是不是默认端口」。
export const DEFAULT_ENDPOINT = 'http://127.0.0.1:8901/v1';

// 审: 地址比较前先规整（去空白、去结尾斜杠）；所有「是不是同一个地址」的判断都靠它。
export function normalizeEndpoint(url) {
    return String(url ?? '').trim().replace(/\/+$/, '');
}

// 审: 酒馆「自定义」来源的 URL 是否就是本代理——决定「已连接」状态和连接按钮的显示。
/** ST's Custom URL is this proxy's address. */
export function isOurEndpoint(customUrl, settings) {
    const a = normalizeEndpoint(customUrl);
    return a !== '' && a === normalizeEndpoint(settings.endpoint);
}

// 审: 端点去掉结尾 /v1 得到代理根地址，面板直连代理路由时用。
/** The proxy's own base URL: the endpoint without its /v1. */
export function proxyBaseOf(endpoint) {
    return normalizeEndpoint(endpoint).replace(/\/v1$/, '');
}

// 审: 探测一次运行环境（TauriTavern？触屏？）；win 可注入，非浏览器环境（测试）下全走默认值。
/** What the page is running in. Read once; `win` is injectable for tests. */
function detectPlatform(win = globalThis.window) {
    return {
        tauri: !!win?.__TAURITAVERN__,
        coarse: win?.matchMedia?.('(pointer: coarse)')?.matches ?? false,
    };
}

// 审: 加载模块时探测的结果，下面的 IS_TAURI / COARSE 由它派生。
const platform = detectPlatform();
// 审: TauriTavern 没有服务端插件，面板只能直连代理，多处据此分叉。
// TauriTavern has a Rust backend: no server plugins, so the ST-origin
// /api/plugins routes don't exist — talk to the standalone proxy directly.
export const IS_TAURI = platform.tauri;
// 审: 触屏设备：引导和连接卡片据此判断「酒馆在另一台机器上」。
export const COARSE = platform.coarse;
// 审: 面板文案里的应用名（TauriTavern / 酒馆）；参数可注入，test/panel-fixes 两种都测。
/** What the app is called in panel text: TauriTavern there, 酒馆 elsewhere. */
export const appName = (tauri = IS_TAURI) => (tauri ? 'TauriTavern' : '酒馆');
// 审: 当前环境下的 appName()，guide.js 直接用。
export const APP_NAME = appName();

// 审: 非默认端点或 TauriTavern 时只直连代理、不回落到酒馆插件路由（那条路由只代表默认端口的代理）。
/** The plugin route speaks for the proxy on the default port only: with another endpoint
 *  (another machine, another port) or in TauriTavern, calls go to the proxy itself and nothing else. */
export function proxyDirectOnly({ tauri, endpoint }) {
    return !!tauri || normalizeEndpoint(endpoint) !== normalizeEndpoint(DEFAULT_ENDPOINT);
}

// 审: 云端酒馆却配着本机回环地址时为真，shell 据此提示；host.js 没加载就不提示。
/** Cloud-hosted SillyTavern with a loopback proxy address (needs shared/host.js; without it, no note). */
export function cloudHosted(hostCheck, { hostname, endpoint, tauri }) {
    return !!hostCheck?.cloudNeedsNote({ hostname, endpoint, tauri });
}

// 审: 把酒馆当前的来源/URL/模型归纳成「是否连着本代理」，面板所有「已连接」判断的唯一来源。
/**
 * Where SillyTavern sends chat requests, from its settings.
 *   connected: this proxy (everything works); anything else is not ours.
 */
export function resolveConnection({ mainApi, oai = {}, settings }) {
    const src = mainApi === 'openai' ? oai.chat_completion_source : null;
    if (src === 'custom' && isOurEndpoint(oai.custom_url, settings)) {
        return { connected: true, model: oai.custom_model, billing: '订阅' };
    }
    return { connected: false, model: null };
}

// 审: 即将发出的聊天请求是不是发给本代理的；inject.js 只对本代理的请求注入设置。
/** A chat request about to leave (CHAT_COMPLETION_SETTINGS_READY): ours or someone else's. */
export function classifyRequest(data, settings) {
    return { ours: data.chat_completion_source === 'custom' && isOurEndpoint(data.custom_url, settings) };
}

// 审: 状态栏里生成进度那一段的文字（思考中/在写/完成·字数·秒数·缓存）；闲置返回空串。
/** The status bar's text while a reply is being written or has just finished; '' when idle. */
export function genLine(gen) {
    if (!gen || gen.kind === 'idle') return '';
    // 审: 千分位格式化字数。
    const n = (v) => Number(v).toLocaleString('en-US');
    if (gen.kind === 'thinking') return `思考中 ${Math.max(0, Math.round((Date.now() - gen.startedAt) / 1000))} 秒`;
    if (gen.kind === 'writing') return `在写 ${n(gen.chars ?? 0)} 字`;
    return ['完成', gen.chars != null ? `${n(gen.chars)} 字` : null, gen.seconds != null ? `${gen.seconds} 秒` : null, gen.cache != null ? `命中 ${Math.round(gen.cache)}%` : null, gen.flag || null].filter(Boolean).join(' · ');
}
