// ──────────────────────────────────────────────
// 「手机连接码」：代理地址 + 访问密码合成一个字符串，电脑上的「酒馆工具」里「手机」页显示，手机上整串粘贴。
//   http://192.168.31.7:8901/v1#k=访问密码
// 没有密码（本机）时就是一个普通地址。纯函数、不依赖浏览器：面板和「酒馆工具」（launcher/）共用同一份。
// ──────────────────────────────────────────────

const KEY_MARK = '#k=';

/** 地址 + 密码 → 连接码；密码为空时只有地址。 */
export function makeConnectCode(address, key = '') {
    const a = String(address ?? '').trim().replace(/\/+$/, '');
    if (!a) return '';
    const k = String(key ?? '').trim();
    return k ? `${a}${KEY_MARK}${k}` : a;
}

/**
 * 粘贴来的文字 → { endpoint, accessKey }；认不出来返回 null。
 * 宽松：空格、换行、前面带「手机连接码：」、没写 http:// 或 /v1、只有「IP:端口」都行；密码里的 % 转义会还原。
 */
export function parseConnectCode(text) {
    const flat = String(text ?? '').replace(/\s+/g, '');
    const m = flat.match(/(https?:\/\/.*|\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?.*|localhost(?::\d+)?.*)$/i);
    if (!m) return null;
    const i = m[1].indexOf(KEY_MARK);
    let address = i < 0 ? m[1] : m[1].slice(0, i);
    let key = i < 0 ? '' : m[1].slice(i + KEY_MARK.length);
    try { key = decodeURIComponent(key); } catch { /* 密码里有单独的 %：按原样 */ }
    if (!/^https?:\/\//i.test(address)) address = `http://${address}`;
    address = address.replace(/\/+$/, '');
    let url;
    try { url = new URL(address); } catch { return null; }
    if (!url.hostname) return null;
    // 只写了 IP:端口：补上代理的路径
    if (url.pathname === '/' || url.pathname === '') address = `${url.origin}/v1`;
    return { endpoint: address, accessKey: key };
}
