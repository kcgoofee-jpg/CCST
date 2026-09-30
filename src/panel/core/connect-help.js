// ──────────────────────────────────────────────
// 「连不上代理」卡片的内容。故意不猜原因（装没装插件、在哪台设备）：面板看不到代理那边的情况，
// 猜错比不说更糟。只写连的是哪个地址，和该逐项检查什么。
// ──────────────────────────────────────────────

import { DEFAULT_ENDPOINT, normalizeEndpoint } from './capabilities.js';

export const REPO_URL = 'https://github.com/kcgoofee-jpg/CCST';

/** @returns {{ key: string, title: string, sub: string, steps: { text: string, cmd?: string }[] }} */
export function connectHelp({ endpoint = DEFAULT_ENDPOINT } = {}) {
    const ep = normalizeEndpoint(endpoint) || normalizeEndpoint(DEFAULT_ENDPOINT);
    return {
        key: 'offline', title: '连不上 CCST 代理',
        sub: `地址：${ep}`,
        steps: [
            { text: '代理启动了吗？装成酒馆插件的：重启酒馆；单独运行的：在 CCST 文件夹里运行', cmd: 'npm start' },
            { text: '代理在另一台电脑上：那台电脑要开着、和这台在同一个网络；换过网络地址可能变了，点「改地址」。' },
            { text: `还没装代理，或已经删了：安装说明在 ${REPO_URL}；不用代理、直连 Claude 的话忽略这张卡。` },
        ],
    };
}
