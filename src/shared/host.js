// ──────────────────────────────────────────────
// Is SillyTavern opened from this computer / the home network, or from a
// cloud server?
// ──────────────────────────────────────────────
//
// The subscription proxy runs on the user's own computer. A SillyTavern
// hosted in the cloud sends chat requests from ITS server, where
// 127.0.0.1 is the server itself, not the user's computer — so the default
// endpoint cannot work there. The panel uses this to explain that once,
// instead of the generic "can't reach the proxy".
// Pure function; shared by the panel (index.js) and the tests.

// 审: 判断 IPv4 是否私有/回环/链路本地/CGNAT 地址；isLocalHost 的子步骤（含 IPv4 映射的 IPv6）。
/** 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16 (link-local), 100.64/10 (CGNAT: Tailscale & co. on the user's own devices). */
function privateV4(host) {
    const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return false;
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
        || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

// 审: 页面是否从本机/局域网打开；cloudNeedsNote 和面板 shell/guide 用来判断是不是云端酒馆。
/** True for loopback, LAN addresses and local names — the page is served from the user's own network. */
export function isLocalHost(hostname) {
    const host = String(hostname ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!host) return true; // file:// or unknown: nothing to warn about
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
    if (privateV4(host)) return true;
    if (host.includes(':')) {
        // IPv6: loopback, unique-local fc00::/7, link-local fe80::/10, or an IPv4-mapped address.
        if (host === '::1') return true;
        if (/^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host)) return true;
        const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        return !!mapped && privateV4(mapped[1]);
    }
    return false;
}

// 审: 端点是否指向本机（localhost/127.x/::1）；cloudNeedsNote 的子判断，测试也直接用。
/** The endpoint points at the machine SillyTavern's server runs on (127.0.0.1 / localhost). */
export function isLoopbackUrl(url) {
    let host;
    try { host = new URL(String(url)).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return false; }
    return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

// 审: 云端酒馆 + 回环端点 = 连不上用户电脑上的代理；面板 capabilities 用它显示一次性说明。
/**
 * A cloud-hosted SillyTavern pointed at a loopback proxy address: the proxy on
 * the user's computer is out of its reach.
 * @param {{ hostname: string, endpoint: string, tauri?: boolean }} p
 */
export function cloudNeedsNote({ hostname, endpoint, tauri = false }) {
    return !tauri && !isLocalHost(hostname) && isLoopbackUrl(endpoint);
}
