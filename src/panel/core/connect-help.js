// ──────────────────────────────────────────────
// 「连不上代理」卡片的内容。故意不猜原因（装没装插件、在哪台设备）：面板看不到代理那边的情况，
// 猜错比不说更糟。只写连的是哪个地址，和该逐项检查什么。
// ──────────────────────────────────────────────

export const REPO_URL = 'https://github.com/kcgoofee-jpg/CCST';

// 一键安装程序（装成酒馆服务器插件）只给「本机浏览器里的原版酒馆」：Windows 的 .bat 在扩展自己的文件夹里（installer/），
// 用相对地址下载，离线 / 镜像环境也能用。Mac 不给下载文件：下载来的 .command 在 macOS 15 以上会被系统拦住，改给终端一行命令。
// TauriTavern / 手机 / 别处打开的酒馆都装不了这个插件，给的是别的路：见 hostKind。
const INSTALLER_BASE = new URL('../../../installer/', import.meta.url);
export const INSTALLERS = [
    { key: 'win', label: '下载一键安装（Windows）', file: 'CCST安装.bat' },
];
// 下载链接的备份：.bat 在 raw 地址会当文本显示，所以给 installer 文件夹的页面。
export const RAW_BASE = `${REPO_URL}/raw/main/installer/`;
export const REPO_ZIP_URL = `${REPO_URL}/archive/refs/heads/main.zip`;
export const DOCS_URL = `${REPO_URL}/blob/main/docs/%E4%BD%BF%E7%94%A8%E6%8C%87%E5%8D%97.md`;
export const MAC_PLUGIN_CMD = 'zsh -c "$(curl -fsSL https://raw.githubusercontent.com/kcgoofee-jpg/CCST/main/install-plugin-mac.sh)"';

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
const desktopDownloads = () => [
    { key: 'mac-plugin-cmd', label: 'Mac：打开「终端」粘贴下面这行（打开安装说明）', file: '', href: DOCS_URL, copy: MAC_PLUGIN_CMD, copyLabel: '复制命令', download: false },
    ...INSTALLERS.map((d) => ({ ...d, href: new URL(d.file, INSTALLER_BASE).href, download: true, copy: REPO_URL + '/tree/main/installer' })),
];

/** 有新版本时的卡片内容（只给本机原版酒馆：装的是插件，一键安装会连面板一起更新、关掉再重开酒馆）。 */
export function updateHelp({ latest, host = 'desktop' }) {
    if (host !== 'desktop') return null;
    return {
        title: `有新版本 v${latest}`,
        sub: '再运行一次一键安装就是更新：面板一起更新，装完自动重开酒馆。',
        downloads: desktopDownloads(),
    };
}

/** dotted version a newer than b */
export function isNewerVersion(a, b) {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
    return false;
}

/**
 * 「连不上代理」卡片。host 见 hostKind。
 *   tauri / elsewhere：一句话 + 一行可见的安装说明链接（downloads）。
 *   desktop：一句话 + 一键安装的下载按钮 + 一行 Mac 提示。
 * 没有折叠、没有步骤列表。
 * @returns {{ key: string, host: string, title: string, sub: string, steps: [], downloads: object[], hint: string }}
 */
export function connectHelp({ host = 'desktop' } = {}) {
    const base = { key: 'offline', host, title: '连不上 CCST 代理', steps: [] };
    if (host === 'tauri' || host === 'elsewhere') {
        return {
            ...base,
            sub: '代理没在运行：到运行代理的那台电脑上启动它（npm start）。',
            downloads: [remoteItem('docs', '还没装？看安装说明', DOCS_URL)],
            hint: '',
        };
    }
    return {
        ...base,
        sub: '代理没在运行：重启酒馆。没装或删了：Mac 在「终端」粘贴下面一行，Windows 下载一键安装并双击运行。',
        downloads: desktopDownloads(),
        hint: '',
    };
}

/**
 * 首次引导第 1 步「装代理」的内容（和「连不上」卡片同一份安装方式）。
 * desktop：Mac 一行终端命令 + Windows 安装程序；tauri / elsewhere：装不了酒馆插件，给安装说明链接。
 * @returns {{ sub: string, mac: string|null, win: object|null, docs: string|null }}
 */
export function installHelp({ host = 'desktop' } = {}) {
    if (host === 'tauri' || host === 'elsewhere') {
        return { sub: '到要运行代理的那台电脑上装好并启动 CCST 代理，这里连上后会自动进入下一步。', mac: null, win: null, docs: DOCS_URL };
    }
    const [win] = desktopDownloads().filter((d) => d.key === 'win');
    return {
        sub: '装好后重启酒馆，这里会自动进入下一步。',
        mac: MAC_PLUGIN_CMD,
        win: { ...win, label: '下载安装程序' },
        docs: null,
    };
}

/** 首次引导第 2 步「登录」：要运行的那一条命令和它在哪儿运行。 */
export function loginHelp({ host = 'desktop' } = {}) {
    return {
        where: host === 'desktop' ? '在酒馆文件夹的 plugins/CCST 里运行：' : '在运行代理那台电脑的 CCST 文件夹里运行：',
        cmd: 'npm run login',
    };
}

const REFRESH = '回到浏览器，按 Cmd+Shift+R（Windows 按 Ctrl+F5）刷新酒馆页面。';
const DESKTOP_HINT = 'Mac 在终端粘贴上面那行，Windows 双击下载的文件，按提示做完后重启酒馆';

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
        { text: '在 CCST 文件夹里运行下面这行命令，更新代码：', cmd: 'git pull && npm install' },
        { text: '重启代理：用「酒馆工具」的，选「重启代理」；用 npm start 的，关掉那个窗口再运行 npm start。' },
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
        { text: 'Mac：在「终端」再粘贴一次下面那行。Windows：双击之前下载的「CCST安装」再运行一次，找不到了点下面的按钮重新下载。它会把代理更新到最新。' },
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
