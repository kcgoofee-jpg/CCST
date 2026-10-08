# 待做：手机上用 CCST（单独模块）

状态：**没做**。主线从 6.1.2 起，在手机和「不在这台电脑上打开的酒馆」里只显示一张卡片「这里用不了 CCST」，不再给安装、登录、更新步骤。这个分支保留了 6.1.1 时的手机相关代码，留作以后做成单独模块的起点。

## 现在的实际情况
- **手机浏览器打开电脑上的酒馆**：聊天可以走 CCST（请求是电脑上的酒馆服务器发给本机代理的）；但面板的状态、额度、用量读不到，代理只接受本机来的请求。
- **TauriTavern 手机版**：没有服务器插件，手机上也跑不了代理，用不了。
- **云端酒馆**：代理要和酒馆在同一台电脑，用不了。

## 这个分支里和手机有关的代码
- `src/panel/core/connect-help.js`：`hostKind` 的 `elsewhere`，以及 `connectHelp` / `installHelp` / `loginHelp` / `mismatchHelp` 里 `elsewhere` 的分支（「到运行酒馆的电脑上…」）。
- `src/panel/shell.js`：`hostNow()`（触屏 `COARSE` 或页面不是本机/局域网打开 → elsewhere）；云端酒馆的「连不上 · CCST 要和酒馆在同一台电脑」卡片。
- `src/panel/core/capabilities.js`：`COARSE`、`cloudHosted`。
- `src/shared/host.js`：`isLocalHost`、`cloudNeedsNote`。
- `src/proxy/api/guards.js`：拒绝其他设备（`guardRemote`）。

## 要做成模块需要想清楚的
1. 手机上的面板要显示什么：至少「上一轮」和额度。需要代理给局域网里的设备开只读接口，并且有办法确认是自己的手机（6.1 删掉了访问密码）。
2. 是否重新支持局域网访问：安全和额度被别人用的风险。
3. 布局：手机竖屏 375px 的面板。
4. TauriTavern 手机版是否能连电脑上的代理（跨设备，同上）。
