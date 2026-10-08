// ──────────────────────────────────────────────
// 「连不上代理」卡片的内容。故意不猜原因（装没装插件、在哪台设备）：面板看不到代理那边的情况，
// 猜错比不说更糟。只写连的是哪个地址，和该逐项检查什么。
// ──────────────────────────────────────────────

// 审: 仓库地址，下面各链接的前缀。
const REPO_URL = 'https://github.com/kcgoofee-jpg/CCST';

// 审: 安装程序文件在扩展自己的 installer/ 目录，用相对地址下载，离线/镜像环境也能用。
// 一键安装程序（装成酒馆服务器插件）只给「本机浏览器里的原版酒馆」：Windows 的 .bat 在扩展自己的文件夹里（installer/），
// 用相对地址下载，离线 / 镜像环境也能用。Mac 不给下载文件：下载来的 .command 在 macOS 15 以上会被系统拦住，改给终端一行命令。
// TauriTavern 装不了酒馆插件，给单独运行的路；手机和不在这台电脑上打开的酒馆用不了 CCST（见 hostKind、awayHelp；手机支持留在 todo/mobile 分支）。
const INSTALLER_BASE = new URL('../../../installer/', import.meta.url);
// 审: 桌面端可下载的安装程序（只剩 Windows 的 .bat；Mac 给终端命令不给文件）。
const INSTALLERS = [
    { key: 'win', label: '下载安装', file: 'CCST安装.bat' },
];
// 审: 使用指南地址，tauri / 别处打开的酒馆没法一键安装时指向它；测试也引用。
export const DOCS_URL = `${REPO_URL}/blob/main/docs/%E4%BD%BF%E7%94%A8%E6%8C%87%E5%8D%97.md`;
// 审: Mac 一行安装命令（下载的 .command 会被 macOS 拦，所以给命令）；测试引用。
export const MAC_PLUGIN_CMD = 'zsh -c "$(curl -fsSL https://raw.githubusercontent.com/kcgoofee-jpg/CCST/main/install-plugin-mac.sh)"';

// 审: 面板跑在哪（tauri / elsewhere / desktop），决定给安装卡片哪套内容；只用已知事实不探测。
/**
 * 面板在哪儿运行，只用已知的事实（不探测）：
 *   away      触屏设备（手机，含 TauriTavern 手机版），或页面不是从本机 / 局域网打开的（云端酒馆）：用不了 CCST
 *   tauri     电脑上的 TauriTavern
 *   desktop   电脑浏览器里打开本机的原版酒馆
 */
export function hostKind({ tauri = false, elsewhere = false } = {}) {
    return elsewhere ? 'away' : tauri ? 'tauri' : 'desktop';
}

// 审: 手机 / 云端酒馆只给这一张卡片，不给安装登录步骤。
/** 这台设备用不了 CCST 时的卡片。touch：手机（触屏）；否则是云端或别处打开的酒馆。 */
export function awayHelp({ touch = false } = {}) {
    return { title: '这里用不了 CCST', sub: touch ? '手机上用不了；在电脑上打开酒馆就行' : 'CCST 要和酒馆在同一台电脑上' };
}

// 审: 只有链接没有下载文件的条目（装不了插件的环境给安装说明）。
/** A download / link item: `href` is what the button opens; `copy` is the URL to show and copy. */
const remoteItem = (key, label, url) => ({ key, label, file: '', href: url, copy: url, download: false });
// 审: 桌面端的安装条目：Mac 终端命令 + Windows 安装程序，连不上卡片/更新卡片/版本不配卡片共用。
const desktopDownloads = () => [
    { key: 'mac-plugin-cmd', label: 'Mac：在终端粘贴这行', file: '', href: DOCS_URL, copy: MAC_PLUGIN_CMD, copyLabel: '复制', download: false },
    ...INSTALLERS.map((d) => ({ ...d, href: new URL(d.file, INSTALLER_BASE).href, download: true, copy: REPO_URL + '/tree/main/installer' })),
];

// 审: 有新版本时的卡片内容；只给本机原版酒馆（一键安装会连面板一起更新）。
/** 有新版本时的卡片内容（只给本机原版酒馆：装的是插件，一键安装会连面板一起更新、关掉再重开酒馆）。 */
export function updateHelp({ latest, host = 'desktop' }) {
    if (host !== 'desktop') return null;
    return {
        title: `有新版 v${latest}`,
        sub: '',
        downloads: desktopDownloads(),
    };
}

// 审: 点分版本号 a 是否比 b 新，更新提示用（plugin.js 也用）。
/** dotted version a newer than b */
export function isNewerVersion(a, b) {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
    return false;
}

// 审: 「连不上代理」卡片：不猜原因，只给该做什么；shell 的离线状态用。
/**
 * 「连不上代理」卡片。host 见 hostKind。
 *   tauri / elsewhere：一句话 + 一行可见的安装说明链接（downloads）。
 *   desktop：一句话 + 一键安装的下载按钮 + 一行 Mac 提示。
 * 没有折叠、没有步骤列表。
 * @returns {{ key: string, host: string, title: string, sub: string, steps: [], downloads: object[], hint: string }}
 */
export function connectHelp({ host = 'desktop' } = {}) {
    const base = { key: 'offline', host, title: '连不上', steps: [] };
    if (host === 'tauri') {
        return {
            ...base,
            sub: '在 CCST 文件夹里运行 npm start',
            downloads: [remoteItem('docs', '安装说明', DOCS_URL)],
            hint: '',
        };
    }
    return {
        ...base,
        sub: '请重启酒馆重试',
        downloads: desktopDownloads(),
        hint: '',
    };
}

// 审: 首次引导第 1 步「装代理」的内容，和连不上卡片同一份安装方式。
/**
 * 首次引导第 1 步「装代理」的内容（和「连不上」卡片同一份安装方式）。
 * desktop：Mac 一行终端命令 + Windows 安装程序；tauri / elsewhere：装不了酒馆插件，给安装说明链接。
 * @returns {{ sub: string, mac: string|null, win: object|null, docs: string|null }}
 */
export function installHelp({ host = 'desktop' } = {}) {
    if (host === 'tauri') {
        return { sub: 'TauriTavern 装不了插件：照安装说明单独运行 CCST', mac: null, win: null, docs: DOCS_URL };
    }
    const [win] = desktopDownloads().filter((d) => d.key === 'win');
    return {
        sub: '',
        mac: MAC_PLUGIN_CMD,
        win,
        docs: null,
    };
}

// 审: 首次引导第 2 步「登录」要运行的命令和运行位置；shell 的未登录卡片也用。
/** 首次引导第 2 步「登录」：要运行的那一条命令和它在哪儿运行。 */
export function loginHelp({ host = 'desktop' } = {}) {
    return {
        where: host === 'desktop' ? '在酒馆文件夹的 plugins/CCST 里运行：' : '在 CCST 文件夹里运行：',
        cmd: 'npm run login',
    };
}

// 审: 版本不配后「刷新页面」这一步的统一文案。
// 审: 版本对不上时的卡片：面板旧就在酒馆里更新面板；代理旧就指向更新说明（README），不在卡片里写步骤。
/** 「面板和代理版本不一致」卡片。side：谁旧（'panel' | 'proxy'）。 */
export function mismatchHelp({ side, tauri = false, host = tauri ? 'tauri' : 'desktop' }) {
    if (side === 'panel') {
        return {
            sub: '面板要更新：',
            steps: [
                { text: '扩展 → 管理扩展 → 更新 CCST' },
                { text: host === 'tauri' ? '完全退出 TauriTavern 再打开' : '刷新页面（Cmd+Shift+R / Ctrl+F5）' },
            ],
            downloads: [], hint: '',
        };
    }
    return { sub: '代理要更新：照说明更新', steps: [], downloads: [remoteItem('docs', '更新说明', DOCS_URL)], hint: '' };
}
