// ──────────────────────────────────────────────
// 「连不上代理」卡片的内容。故意不猜原因（装没装插件、在哪台设备）：面板看不到代理那边的情况，
// 猜错比不说更糟。只写连的是哪个地址，和该逐项检查什么。
// ──────────────────────────────────────────────

import { DEFAULT_ENDPOINT, normalizeEndpoint } from './capabilities.js';

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

const TT_STEPS = [
    { text: 'TauriTavern 里没有酒馆服务器插件，所以这里不用「一键安装」。代理要在一台电脑上单独运行：下载 CCST 的 zip（下面的按钮），解压。' },
    { text: 'Mac：双击解压出来的 launcher/mac/首次安装.command（提示「无法验证开发者」就右键 → 打开）。它会装好环境、让你登录 Claude，并在桌面放一个「酒馆工具」，同时启动代理。以后用「酒馆工具」启动、重启。已经装过的：打开桌面的「酒馆工具」，首页选「重启代理」。' },
    { text: 'Windows（实验性，没在真机上测过）：先装 Node.js LTS，再双击 launcher\\windows\\酒馆工具.bat，首页按 3 登录 Claude，回车启动。' },
    { text: '用手机：代理仍在电脑上跑。电脑上「酒馆工具」→ 其他 → 手机 → 手机模式，会显示代理地址和访问密码；回到这里点下面的「去填地址和密码」，填好点「重新连接」。手机和电脑要在同一个 Wi-Fi。' },
];

/**
 * 「连不上代理」卡片。host 见 hostKind；每种环境只给在那儿真能做的步骤。
 * @returns {{ key: string, host: string, title: string, sub: string, steps: { text: string, cmd?: string }[], downloads: object[], hint: string, goto?: { label: string, tab: string } }}
 */
export function connectHelp({ endpoint = DEFAULT_ENDPOINT, host = 'desktop' } = {}) {
    const ep = normalizeEndpoint(endpoint) || normalizeEndpoint(DEFAULT_ENDPOINT);
    const base = { key: 'offline', host, title: '连不上 CCST 代理', sub: `地址：${ep}` };
    if (host === 'tauri') {
        return {
            ...base,
            steps: [
                ...TT_STEPS,
                { text: '代理已经在跑，还是连不上：点「改地址」核对地址；换过网络，电脑的局域网地址可能变了。' },
            ],
            downloads: [remoteItem('repo-zip', '下载 CCST（zip）', REPO_ZIP_URL)],
            hint: '点按钮会用系统浏览器打开；打不开就点「复制链接」，粘贴到浏览器地址栏。',
            goto: { label: '去填地址和密码', tab: 'other' },
        };
    }
    if (host === 'elsewhere') {
        return {
            ...base,
            steps: [
                { text: '这台设备只是打开酒馆网页的浏览器：代理要装在运行酒馆的那台机器上，在这里下载安装器没用。' },
                { text: '酒馆在 Linux 服务器上：SSH 登录服务器，运行下面这行（可重复运行；订阅登录和访问密码见使用指南「用法三」）。', cmd: SERVER_INSTALL_CMD },
                { text: '酒馆在家里的电脑上、你用手机或别的设备打开：到那台电脑上运行一键安装（或 Mac 的「酒馆工具」→ 手机模式）。' },
                { text: '代理已经在跑，只是这里连不上：点「改地址」填这台设备能访问到的地址（不能是 127.0.0.1），再到「其他 → 手机连接」填访问密码。' },
            ],
            downloads: [remoteItem('docs', '打开使用指南（用法三）', DOCS_URL)],
            hint: '不想装代理：改用 API 密钥直连，见面板的「重新引导」。',
            goto: { label: '去填地址和密码', tab: 'other' },
        };
    }
    return {
        ...base,
        steps: [
            { text: '代理启动了吗？装成酒馆插件的：重启酒馆；单独运行的：在 CCST 文件夹里运行', cmd: 'npm start' },
            { text: '代理在另一台电脑上：那台电脑要开着、和这台在同一个网络；换过网络地址可能变了，点「改地址」。' },
            { text: '还没装代理，或已经删了：点下面的「下载一键安装」，双击运行；不用代理、直连 Claude 的话忽略这张卡。' },
        ],
        downloads: desktopDownloads(),
        hint: '双击下载的文件，按提示做完后重启酒馆。下载没反应：点「复制链接」，粘贴到浏览器地址栏。',
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
            ? '更新代理代码：在电脑上的 CCST 文件夹里运行下面这行。不是用命令行装的（没有这个文件夹的 .git）：点下面的按钮重新下载 CCST 的 zip，解压后覆盖原来的文件夹。'
            : '在 CCST 文件夹里运行下面这行命令，更新代码：', cmd: 'git pull && npm install' },
        { text: '重启代理：用「酒馆工具」的，首页选「1 重启代理」；用 npm start 的，关掉那个窗口再运行 npm start。' },
    ];
    if (isTT || host === 'elsewhere') {
        // No plugin installer on these hosts: the proxy is the standalone one on another machine.
        return {
            sub,
            steps: [...(host === 'elsewhere' ? [{ text: '代理在运行酒馆的那台机器上，更新要到那台机器上做，不是在这台设备上。' }] : []), ...standaloneSteps, { text: REFRESH_STEP }],
            downloads: isTT ? [remoteItem('repo-zip', '下载 CCST（zip）', REPO_ZIP_URL)] : [remoteItem('docs', '打开使用指南', DOCS_URL)],
            hint: isTT ? '点按钮会用系统浏览器打开；打不开就点「复制链接」。' : '',
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
