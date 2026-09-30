// ──────────────────────────────────────────────
// 「还没连上代理」卡片该说什么: decided from what the panel can see, pure (no DOM, no ST) so the tests can
// run it. The drawing is in ../shell.js.
//
//   plugin-missing  原版酒馆，服务端插件没装（插件路由 404）→ 装插件的几步
//   plugin-restart  插件在，但代理没应答 → 重启酒馆（代理随酒馆启动）
//   other-device    面板在手机 / 别的电脑上，代理在另一台电脑 → 去那台电脑上开
//   standalone      自己指了别的本机地址（单独跑的代理）→ npm start
// ──────────────────────────────────────────────

import { DEFAULT_ENDPOINT, normalizeEndpoint } from './capabilities.js';

const LOOPBACK = /^https?:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\])([:/]|$)/i;

export const REPO_URL = 'https://github.com/kcgoofee-jpg/CCST';

/**
 * @param {{ pluginState?: 'present'|'missing'|'unknown', tauri?: boolean, endpoint?: string }} p
 *   pluginState: what GET /api/plugins/claude-subscription/status said (404 = missing).
 * @returns {{ key: string, title: string, sub: string, steps: { text: string, cmd?: string }[] }}
 */
export function connectHelp({ pluginState = 'unknown', tauri = false, endpoint = DEFAULT_ENDPOINT } = {}) {
    const ep = normalizeEndpoint(endpoint) || normalizeEndpoint(DEFAULT_ENDPOINT);
    const loopback = LOOPBACK.test(ep);
    const isDefault = ep === normalizeEndpoint(DEFAULT_ENDPOINT);

    if (tauri || !loopback) {
        return {
            key: 'other-device', title: '代理在你的电脑上没开',
            sub: `这台设备连不上 ${ep}。`,
            steps: [
                { text: '到电脑上启动 SillyTavern：装了 CCST 插件时，代理随酒馆一起启动。' },
                { text: '用 Mac 酒馆工具的：双击桌面上的「酒馆工具」（首次安装时放的；找不到就在 CCST 文件夹的 launcher/mac/ 里），按回车。' },
                { text: '电脑要开着、开了「手机模式」、和这台设备在同一个 Wi-Fi；换过 Wi-Fi 地址可能变了，点「改地址」。' },
            ],
        };
    }
    if (!isDefault && pluginState !== 'present') {
        return {
            key: 'standalone', title: '代理没在运行',
            sub: `酒馆连的是 ${ep}，那里没有代理应答。`,
            steps: [
                { text: '在 CCST 文件夹里启动代理：', cmd: 'npm start' },
                { text: '没登录过 Claude 的话再运行一次：', cmd: 'npm run login' },
            ],
        };
    }
    if (pluginState === 'present') {
        return {
            key: 'plugin-restart', title: '代理没有应答',
            sub: '服务端插件已经装了，代理随酒馆一起启动。',
            steps: [
                { text: '重启 SillyTavern。' },
                { text: '看酒馆的黑窗口 / 日志里有没有这一行，有就是启动好了：', cmd: '[claude-subscription] initialised' },
                { text: '看到 EADDRINUSE（端口被占用）说明 8901 端口另有程序在用，关掉它再重启酒馆。' },
            ],
        };
    }
    return {
        key: 'plugin-missing', title: '还没装 CCST 的服务端插件',
        sub: '面板要靠酒馆的服务端插件启动代理。装一次就好，几步：',
        steps: [
            { text: '打开酒馆文件夹里的 config.yaml，确保有这一行：', cmd: 'enableServerPlugins: true' },
            { text: '在 SillyTavern 文件夹里运行：', cmd: `node plugins.js install ${REPO_URL}` },
            { text: '登录 Claude（订阅用户）：', cmd: 'cd plugins/CCST && npm install && npm run login' },
            { text: '重启 SillyTavern，再点下面的重新检测。' },
        ],
    };
}
