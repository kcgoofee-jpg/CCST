// ──────────────────────────────────────────────
// 「连不上代理」卡片的内容。故意不猜原因（装没装插件、在哪台设备）：面板看不到代理那边的情况，
// 猜错比不说更糟。只写连的是哪个地址，和该逐项检查什么。
// ──────────────────────────────────────────────

import { DEFAULT_ENDPOINT, normalizeEndpoint } from './capabilities.js';

export const REPO_URL = 'https://github.com/kcgoofee-jpg/CCST';

// 一键安装程序放在扩展自己的文件夹里（installer/），用相对地址下载，离线 / 镜像环境也能用。
// Mac 给 zip：浏览器下载的 .command 没有「可执行」权限，双击会报权限不够；zip 解压后权限是对的。
const INSTALLER_BASE = new URL('../../../installer/', import.meta.url);
export const INSTALLERS = [
    { key: 'mac', label: '下载一键安装（Mac）', file: 'CCST-mac.zip' },
    { key: 'win', label: '下载一键安装（Windows）', file: 'CCST安装.bat' },
];

/** @returns {{ key: string, title: string, sub: string, steps: { text: string, cmd?: string }[], downloads: { key: string, label: string, file: string, href: string }[], hint: string }} */
export function connectHelp({ endpoint = DEFAULT_ENDPOINT } = {}) {
    const ep = normalizeEndpoint(endpoint) || normalizeEndpoint(DEFAULT_ENDPOINT);
    return {
        key: 'offline', title: '连不上 CCST 代理',
        sub: `地址：${ep}`,
        steps: [
            { text: '代理启动了吗？装成酒馆插件的：重启酒馆；单独运行的：在 CCST 文件夹里运行', cmd: 'npm start' },
            { text: '代理在另一台电脑上：那台电脑要开着、和这台在同一个网络；换过网络地址可能变了，点「改地址」。' },
            { text: '还没装代理，或已经删了：点下面的「下载一键安装」，双击运行；不用代理、直连 Claude 的话忽略这张卡。' },
        ],
        downloads: INSTALLERS.map((d) => ({ ...d, href: new URL(d.file, INSTALLER_BASE).href })),
        hint: '双击下载的文件，按提示做完后重启酒馆',
    };
}

const downloadsOf = () => INSTALLERS.map((d) => ({ ...d, href: new URL(d.file, INSTALLER_BASE).href }));
const REFRESH = '回到浏览器，按 Cmd+Shift+R（Windows 按 Ctrl+F5）刷新酒馆页面。';

/**
 * 「面板和代理版本不一致」卡片：情况 → 影响 → 怎么办（编号步骤）。
 * runtime 是代理自己在 /status 里报的（'plugin' 装成酒馆插件 | 'standalone' 单独运行）；旧代理不报，
 * 这时不去猜，两种做法都列出来让用户对号入座。
 * @returns {{ sub: string, steps: { text: string, cmd?: string }[], downloads: object[], hint: string }}
 */
export function mismatchHelp({ side, proxyVersion, panelVersion, runtime = null }) {
    const impact = '影响：新功能可能用不了，个别设置可能不生效。';
    if (side === 'panel') {
        return {
            sub: `情况：面板 v${panelVersion} 比代理 v${proxyVersion} 旧。
${impact}
怎么办：`,
            steps: [
                { text: '酒馆里点「扩展 → 管理扩展」，找到 CCST，点它的更新按钮（手机用「手机同步」）。' },
                { text: REFRESH },
            ],
            downloads: [], hint: '',
        };
    }
    const pluginSteps = [
        { text: '双击之前下载的「CCST安装」再运行一次，它会把代理更新到最新。找不到了，点下面的按钮重新下载。已经在酒馆「扩展」里更新过 CCST 的，这一步可以跳过。' },
        { text: '关掉酒馆的黑色窗口，重新打开酒馆。' },
    ];
    const standaloneSteps = [
        { text: '在 CCST 文件夹里运行下面这行命令，更新代码：', cmd: 'git pull && npm install' },
        { text: '重启代理：用「酒馆工具」的，首页选「重启代理」；用 npm start 的，关掉那个窗口再运行 npm start。' },
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
        sub: `情况：代理 v${proxyVersion} 比面板 v${panelVersion} 旧。
${impact}
怎么办：`,
        steps: [...steps, { text: REFRESH }],
        downloads: runtime === 'standalone' ? [] : downloadsOf(),
        hint: runtime === 'standalone' ? '' : '双击下载的文件，按提示做完后重启酒馆',
    };
}
