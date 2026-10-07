<div align="center">

<img src="docs/assets/cover.png" alt="CCST：在 SillyTavern 里用你自己的 Claude 订阅聊天" width="100%">

**简体中文** · [English](README.en.md)

[![版本](https://img.shields.io/github/package-json/v/kcgoofee-jpg/CCST?label=%E7%89%88%E6%9C%AC&color=c08a55)](https://github.com/kcgoofee-jpg/CCST/releases)
[![最新发布](https://img.shields.io/github/v/release/kcgoofee-jpg/CCST?label=%E6%9C%80%E6%96%B0%E5%8F%91%E5%B8%83&color=c08a55)](https://github.com/kcgoofee-jpg/CCST/releases/latest)
[![测试](https://github.com/kcgoofee-jpg/CCST/actions/workflows/test.yml/badge.svg)](https://github.com/kcgoofee-jpg/CCST/actions/workflows/test.yml)
![平台](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-Mac%20%7C%20Windows%20%7C%20Linux-555)
![Node](https://img.shields.io/badge/node-%E2%89%A518-339933)
[![许可证](https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF%E8%AF%81-AGPL--3.0-blue)](LICENSE)

[安装](#安装5-分钟) · [常见问题](#常见问题) · [使用指南](docs/使用指南.md) · [路线图](docs/路线图.md) · [更新记录](CHANGELOG.md) · [参与开发](CONTRIBUTING.md) · [安全](SECURITY.md)

<sub>非 Anthropic 官方产品，与 Anthropic 无关。Claude 是 Anthropic 的商标。</sub>

<img src="docs/assets/panel-reason.png" width="200" alt="推理页">
<img src="docs/assets/panel-status.png" width="200" alt="状态页">

</div>

> [!IMPORTANT]
> **本分支（main）是维护版**：5.2.x 起只修关键 bug，不再加功能，现有用户放心继续用。下一代（Rust 写的直连代理，不再依赖 Claude Code CLI，彻底没有"SDK 一升级就出问题"这类事）在 [`dev`](https://github.com/kcgoofee-jpg/CCST/tree/dev) 分支开发。

## 这是什么

酒馆本身只能接按量付费的 API。CCST 是一个酒馆插件，装上以后：

| | |
| --- | --- |
| 🎟️ **用订阅聊天**<br>Claude Pro / Max，不用另买 API 额度；也支持 API 密钥、Bedrock、Vertex、OpenRouter | 💰 **长聊更省额度**<br>聊天记录走提示词缓存，每轮通常只重算最新一段；状态页显示每轮实测命中率 |
| 🛟 **断线回复不丢**<br>浏览器关了、断网了，回复照样写完，回来自动补上 | 🩺 **拒绝 / 截断提示**<br>模型拒绝、回复被截断或为空时直接告诉你；字数、禁词等检查在「其他」里（实验） |

省多少取决于预设、世界书和其他扩展的组合；面板「状态」页每轮都会写清楚这一轮读了多少缓存、为什么没读到。

> [!CAUTION]
> 用订阅跑第三方程序**不在** Anthropic 允许的范围内，账号可能被限制或封禁。不能接受就用 API 密钥（见[其他用法](#其他用法)）。详见[风险提示](#风险提示)。

## 你需要

- 一台装好 [SillyTavern](https://github.com/SillyTavern/SillyTavern) 的电脑或服务器，[Node.js](https://nodejs.org) 18 以上（没有的话安装程序会提示）。只用 TauriTavern / 手机、电脑上没装酒馆的，看[其他用法](#其他用法)的用法二（目前仅 Mac）。
- Claude Pro 或 Max 订阅（或 API 密钥）。
- Chrome 或 Edge 浏览器。

## 安装（5 分钟）

**1. 在酒馆里装面板。** 顶部「扩展」（积木图标）→「安装扩展」，粘贴下面的链接，点安装：

```
https://github.com/kcgoofee-jpg/CCST
```

**2. 拿到一键安装。** 打开 **CCST** 面板，会看到一张「连不上 CCST 代理」的卡片：Mac 点「复制命令」，Windows 点 **下载一键安装（Windows）**。

**3. 运行它，登录 Claude。** Mac 打开「终端」，粘贴下面这行回车；Windows 双击下载的文件。它会找到酒馆、装好依赖，中间打开一次浏览器让你登录 Claude。窗口里写「装好了」就完成了。

```
zsh -c "$(curl -fsSL https://raw.githubusercontent.com/kcgoofee-jpg/CCST/main/install-plugin-mac.sh)"
```

- Mac 不要双击下载来的 `.command`：macOS 15 起会提示「无法验证开发者」。用上面这行就不会。
- Windows 弹出「Windows 已保护你的电脑」：点「更多信息」→「仍要运行」。
- 没有 Node.js：它会打开下载页，装好后再运行一次。

**4. 重启酒馆。** 关掉再打开，浏览器强制刷新（`Ctrl+F5`，Mac `Cmd+Shift+R`）。面板会自动连上。

之后 CCST 跟着酒馆一起启动。**更新**：再运行一次同一个安装（Mac 粘贴同一行，Windows 再双击），然后重启酒馆。

<details>
<summary>装不上？手动安装</summary>

一键安装只做了这几件事：

1. **打开服务端插件。** 酒馆文件夹里的 `config.yaml`，把这一行改成 `true`：

   ```yaml
   enableServerPlugins: true
   ```

2. **下载 CCST。** 在酒馆文件夹（有 `server.js` 的那一层）打开终端：

   ```bash
   node plugins.js install https://github.com/kcgoofee-jpg/CCST
   ```

3. **装依赖并登录 Claude**（会打开一次浏览器）：

   ```bash
   cd plugins/CCST
   npm install
   npm run login
   ```

4. 重启酒馆，在 **CCST** 面板点 **一键连接**。

- **面板连不上代理**：确认 `config.yaml` 是 `true` 且重启过；酒馆控制台应该有 `[claude-subscription] initialised`。
- **安装程序找不到酒馆**：把酒馆文件夹拖进安装窗口，回车。
- **`npm install` 失败**：不要加 `--omit=optional`；`node -v` 要 18 以上。
- **面板说没登录**：再运行一次安装，或在 `plugins/CCST` 里 `npm run login`。

</details>

## 使用

第一次打开面板，点顶部的 **一键连接**：它会新建并选中一个叫「CCST」的连接配置（沿用你已选的 Claude 模型，没有就用 Opus 4.6），你原来的连接配置不会被改。面板 4 页，平时只用第一页：

| 页 | 干什么 |
| --- | --- |
| **推理** | 选模型、调思考深度（越深越慢越费额度） |
| **状态** | 这一轮用时、缓存命中和原因；回复被拒绝 / 截断 / 为空时的提示；订阅额度；7 天用量 |
| **设置** | 代理地址、后端（订阅 / API 密钥 / Bedrock …）、思考选项；「高级」里是缓存与上下文开关 |
| **其他** | 手机连接、Mac 遥控、调试；默认关闭的「体检（实验）」（字数、禁词、重复、角色卡检查） |

## 常见问题

**缓存命中一直 0%，只有重 roll 有命中。**
先升级到 **5.2.1** 并重启酒馆。订阅额度用超、开始扣额外用量时，Claude Code 只把缓存保留 5 分钟，长回复加上阅读时间一过就整段重写，只有紧接着发的重 roll 能命中；5.2.1 起固定要求 1 小时。升级后仍是 0%，看状态页「详情」写的原因，或按下面「还是解释不了」把数据发给维护者。

**状态页说「系统提示词 / 聊天记录从第 N 条起和上一轮不同」。**
那是预设或世界书每轮在改内容（按关键词触发的世界书、随机宏、按楼层改写旧消息的正则），状态页的「详情」会写具体位置和建议。

**还是解释不了。**
在 CCST 文件夹运行 `node scripts/wire-diagnosis.mjs`（会用掉约 3 万 token 额度），把输出发给维护者。维护者向的完整记录见[缓存命中排查](docs/缓存命中排查.md)。

## 其他用法

- **用 API 密钥 / Bedrock / Vertex / OpenRouter**：照上面装好，在「设置 → 代理后端」切换并填密钥。密钥只存在你电脑上。
- **不装代理，直连 Claude API 或 OpenRouter**：只在酒馆里装扩展。切模型、拒绝 / 截断提示照常；没有防丢回复和额度统计。
- **用法二：TauriTavern / 手机（目前仅 Mac）**：Mac 上单独跑代理。打开「终端」粘贴下面这行（装到 `~/CCST`，装依赖、登录、放桌面快捷方式、启动代理、打开 TauriTavern 一气呵成，最后进入「酒馆工具」菜单，按 `q` 退出）：
  ```bash
  zsh -c "$(curl -fsSL https://raw.githubusercontent.com/kcgoofee-jpg/CCST/main/install-mac.sh)"
  ```
  手机上：菜单首页按 `1` 进「手机」页，按 `x` 开启手机模式，把「手机连接码」粘到手机面板的卡片里点「连接」（也可以扫码）。更新：再运行同一行，然后在菜单里选「重启代理」。[详细](docs/使用指南.md#用法二-tauritavern-与手机)
- **用法三：服务器 / 云酒馆 / Docker**：[详细](docs/使用指南.md#用法三-服务器与-docker)。镜像 `ghcr.io/kcgoofee-jpg/ccst` 公开，`docker pull` 直接用。

更多细节（缓存原理、环境变量、所有设置项）在 **[使用指南](docs/使用指南.md)**。

## 限制

- 没有温度、Top-P、Top-K。
- 手机 / TauriTavern 连电脑上的代理（连接码、二维码、「酒馆工具」菜单）目前只支持 Mac。
- 额度和 Claude.ai 共用，受 5 小时与 7 天窗口限制。
- 首字比直连 API 慢几秒（要先启动 CLI）。

## 风险提示

- **不是官方认可的用法。** 官方文档写明，未经批准不允许第三方产品使用 claude.ai 登录或订阅额度。Anthropic 随时可能限制这种用法，或对账号采取措施。
- **内容受 Anthropic [使用政策](https://www.anthropic.com/legal/aup)约束。** 政策禁止露骨色情内容；任何涉及未成年人的性内容都绝对禁止并会被上报。
- **不要把代理开放给别人，不要共享账号。**

作者不对账号被限制、封禁或其他损失负责。

> 基于 [LukaTheHero/SillyTavern-ClaudeSubscription](https://github.com/LukaTheHero/SillyTavern-ClaudeSubscription)（AGPL-3.0）独立维护，感谢原作者。

## 相关项目

- [tt-root-module](https://github.com/kcgoofee-jpg/tt-root-module)：root 安卓手机上的 KernelSU 模块，自动备份、校验、同步 TauriTavern（及 SillyDroid / Termux 酒馆）的数据，一键恢复。

## 许可证

[GNU AGPL v3.0 或更高版本](LICENSE)
