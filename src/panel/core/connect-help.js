// ──────────────────────────────────────────────
// 「连不上代理」卡片的内容。故意不猜原因（装没装插件、在哪台设备）：面板看不到代理那边的情况，
// 猜错比不说更糟。只写连的是哪个地址，和该逐项检查什么。
// ──────────────────────────────────────────────

import { DEFAULT_ENDPOINT, normalizeEndpoint } from './capabilities.js';
import { makeConnectCode } from './connect-code.js';

export const REPO_URL = 'https://github.com/kcgoofee-jpg/CCST';

// 一键安装程序（装成酒馆服务器插件）只给「本机浏览器里的原版酒馆」：它在扩展自己的文件夹里（installer/），
// 用相对地址下载，离线 / 镜像环境也能用。Mac 给 zip：浏览器下载的 .command 没有「可执行」权限；zip 解压后权限是对的。
// TauriTavern / 手机 / 别处打开的酒馆都装不了这个插件，给的是别的路：见 hostKind。
const INSTALLER_BASE = new URL('../../../installer/', import.meta.url);
export const INSTALLERS = [
    { key: 'mac', label: '下载一键安装（Mac）', file: 'CCST-mac.zip' },
    { key: 'win', label: '下载一键安装（Windows）', file: 'CCST安装.bat' },
];
// 下载链接的备份：GitHub 上的同一批文件。.bat 在 raw 地址会当文本显示，所以只给 Mac 的 zip 和整个仓库的 zip。
export const RAW_BASE = `${REPO_URL}/raw/main/installer/`;
export const REPO_ZIP_URL = `${REPO_URL}/archive/refs/heads/main.zip`;
export const DOCS_URL = `${REPO_URL}/blob/main/docs/%E4%BD%BF%E7%94%A8%E6%8C%87%E5%8D%97.md`;
export const MAC_INSTALL_CMD = 'zsh -c "$(curl -fsSL https://raw.githubusercontent.com/kcgoofee-jpg/CCST/main/install-mac.sh)"';
// 电脑上装代理（Mac）：不给 zip，下载的 .command 会被系统拦住；给一行终端命令，按钮打开安装说明。
const macInstallItem = (label) => ({ key: 'mac-cmd', label, file: '', href: DOCS_URL, copy: MAC_INSTALL_CMD, copyLabel: '复制命令', download: false });
export const SERVER_INSTALL_CMD = 'curl -fsSL https://raw.githubusercontent.com/kcgoofee-jpg/CCST/main/deploy/install.sh | sh';

/**
 * 面板在哪儿运行，只用已知的事实（不探测）：
 *   tauri     窗口里有 __TAURITAVERN__（TauriTavern，电脑或手机）
 *   elsewhere 不是 TauriTavern，但是触屏设备，或页面不是从本机 / 局域网打开的（云端酒馆、手机浏览器）：
 *             这台设备只是个浏览器，酒馆和代理在别的机器上
 *   desktop   电脑浏览器里打开本机的原版酒馆
 */
export function hostKind({ tauri = false, elsewhere = false } = {}) {
    return tauri ? 'tauri' : elsewhere ? 'elsewhere' : 'desktop';
}

/** A download / link item: `href` is what the button opens; `copy` is the URL to show and copy. */
const remoteItem = (key, label, url) => ({ key, label, file: '', href: url, copy: url, download: false });
const desktopDownloads = () => INSTALLERS.map((d) => {
    const href = new URL(d.file, INSTALLER_BASE).href;
    return { ...d, href, download: true, copy: d.key === 'mac' ? `${RAW_BASE}${d.file}` : REPO_URL + '/tree/main/installer' };
});

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/i;
export const CODE_PLACEHOLDER = 'http://192.168.x.x:8901/v1#k=…';

/** What the card's box starts with: the saved connection as a 连接码, but on a phone / TauriTavern a loopback address points at the phone itself, so start empty. */
export function formPrefill(endpoint, accessKey, host) {
    const ep = normalizeEndpoint(endpoint) || '';
    if (!ep || (host !== 'desktop' && LOOPBACK.test(ep))) return '';
    return makeConnectCode(ep, accessKey);
}

/** The possible outcomes of 「连接」, from the proxy's own answer (the status after a re-check). */
export function connectOutcome(status) {
    const phase = status?.phase;
    if (phase === 'online' || phase === 'nologin') return { kind: 'ok', text: '连上了' };
    if (phase === 'denied') {
        return { kind: 'denied', text: status.code === 401 ? '连接码里的密码不对' : (status.message || '代理拒绝了连接') };
    }
    return { kind: 'offline', text: '连不上：电脑开着酒馆工具且在同一 Wi-Fi？' };
}

/**
 * 「连不上代理」卡片。host 见 hostKind。
 *   tauri / elsewhere：一句话 + 连接码输入框（form）+ 一行可见的下载（downloads）。
 *   desktop：一句话 + 一键安装的下载按钮 + 一行 Mac 提示。
 * 没有折叠、没有步骤列表。
 * @returns {{ key: string, host: string, title: string, sub: string, steps: [], downloads: object[], hint: string, form?: { value: string, placeholder: string } }}
 */
export function connectHelp({ endpoint = DEFAULT_ENDPOINT, accessKey = '', host = 'desktop' } = {}) {
    const base = { key: 'offline', host, title: '连不上 CCST 代理', steps: [] };
    if (host === 'tauri' || host === 'elsewhere') {
        const tt = host === 'tauri';
        return {
            ...base,
            sub: '把电脑上酒馆工具首页显示的「手机连接码」粘贴到这里',
            form: { value: formPrefill(endpoint, accessKey, host), placeholder: CODE_PLACEHOLDER },
            downloads: [tt ? macInstallItem('电脑上还没装？（目前只支持 Mac）打开「终端」粘贴下面这行') : remoteItem('docs', '电脑上还没装？看安装说明', DOCS_URL)],
            hint: '',
        };
    }
    return {
        ...base,
        sub: '代理没在运行：重启酒馆。没装或删了：下载一键安装，双击运行。',
        downloads: desktopDownloads(),
        hint: 'Mac 双击被拦时：系统设置 → 隐私与安全性 → 拉到底点「仍要打开」。',
    };
}

const REFRESH = '回到浏览器，按 Cmd+Shift+R（Windows 按 Ctrl+F5）刷新酒馆页面。';
const DESKTOP_HINT = '双击下载的文件，按提示做完后重启酒馆';

/**
 * 「面板和代理版本不一致」卡片：情况 → 影响 → 怎么办（编号步骤）。
 * runtime 是代理自己在 /status 里报的（'plugin' 装成酒馆插件 | 'standalone' 单独运行）；旧代理不报，
 * 这时不去猜，两种做法都列出来让用户对号入座。TauriTavern 跑不了酒馆插件，只列单独运行的做法，不给安装器。
 * @returns {{ sub: string, steps: { text: string, cmd?: string }[], downloads: object[], hint: string }}
 */
export function mismatchHelp({ side, proxyVersion, panelVersion, runtime = null, tauri = false, host = tauri ? 'tauri' : 'desktop' }) {
    const isTT = host === 'tauri';
    // TauriTavern is an app, not a browser tab, and has no black server window: restart the app instead.
    const REFRESH_STEP = isTT ? '重启 TauriTavern（完全退出再打开）。' : REFRESH;
    const impact = '影响：新功能可能用不了，个别设置可能不生效。';
    if (side === 'panel') {
        return {
            sub: `情况：面板 v${panelVersion} 比代理 v${proxyVersion} 旧。
${impact}
怎么办：`,
            steps: [
                { text: isTT ? 'TauriTavern 里点「扩展 → 管理扩展」，找到 CCST，点它的更新按钮。' : '酒馆里点「扩展 → 管理扩展」，找到 CCST，点它的更新按钮。' },
                { text: REFRESH_STEP },
            ],
            downloads: [], hint: '',
        };
    }
    const sub = `情况：代理 v${proxyVersion} 比面板 v${panelVersion} 旧。
${impact}
怎么办：`;
    const standaloneSteps = [
        { text: isTT
            ? '更新代理代码：Mac 打开「终端」，粘贴下面这行，回车（会保留登录和数据）。'
            : '在 CCST 文件夹里运行下面这行命令，更新代码：', cmd: isTT ? MAC_INSTALL_CMD : 'git pull && npm install' },
        { text: '重启代理：用「酒馆工具」的，首页选「1 重启代理」；用 npm start 的，关掉那个窗口再运行 npm start。' },
    ];
    if (isTT || host === 'elsewhere') {
        // No plugin installer on these hosts: the proxy is the standalone one on another machine.
        return {
            sub,
            steps: [...(host === 'elsewhere' ? [{ text: '代理在运行酒馆的那台机器上，更新要到那台机器上做，不是在这台设备上。' }] : []), ...standaloneSteps, { text: REFRESH_STEP }],
            downloads: isTT ? [] : [remoteItem('docs', '打开使用指南', DOCS_URL)],
            hint: '',
        };
    }
    const pluginSteps = [
        { text: '双击之前下载的「CCST安装」再运行一次，它会把代理更新到最新。找不到了，点下面的按钮重新下载。' },
        { text: '关掉酒馆的黑色窗口，重新打开酒馆。' },
    ];
    let steps;
    if (runtime === 'plugin') steps = pluginSteps;
    else if (runtime === 'standalone') steps = standaloneSteps;
    else {
        steps = [
            { text: `这个代理太旧，报不出自己是怎么运行的，所以两种情况都列在下面，照你的做。
装成酒馆插件的（一键安装包装的）：${pluginSteps[0].text}${pluginSteps[1].text}` },
            { text: `单独运行的（酒馆工具 / npm start）：${standaloneSteps[0].text}（${standaloneSteps[0].cmd}）；${standaloneSteps[1].text}` },
        ];
    }
    return {
        sub,
        steps: [...steps, { text: REFRESH_STEP }],
        downloads: runtime === 'standalone' ? [] : desktopDownloads(),
        hint: runtime === 'standalone' ? '' : DESKTOP_HINT,
    };
}
