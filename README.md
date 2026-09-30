<div align="center">

# CCST

**在 SillyTavern（酒馆）里用你自己的 Claude 订阅聊天。**

[![版本](https://img.shields.io/github/package-json/v/kcgoofee-jpg/CCST?label=%E7%89%88%E6%9C%AC&color=0d0d0d)](https://github.com/kcgoofee-jpg/CCST/releases)
[![测试](https://github.com/kcgoofee-jpg/CCST/actions/workflows/test.yml/badge.svg)](https://github.com/kcgoofee-jpg/CCST/actions/workflows/test.yml)
[![许可证](https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF%E8%AF%81-AGPL--3.0-blue)](LICENSE)

<sub>非 Anthropic 官方产品，与 Anthropic 无关。Claude 是 Anthropic 的商标。</sub>

<img src="docs/assets/panel-reason.png" width="200" alt="推理页">
<img src="docs/assets/panel-status.png" width="200" alt="状态页">
<img src="docs/assets/panel-check.png" width="200" alt="体检页">

</div>

## 这是什么

酒馆本身只能用按量付费的 API。CCST 是一个酒馆插件，装上以后：

- **用 Claude Pro / Max 订阅聊天**，不用另外买 API 额度（也支持 API 密钥、Bedrock、Vertex、OpenRouter）。
- **自动省额度**：长聊天每轮只重算新内容，其余走缓存。
- **回复不丢**：浏览器关了、断网了，回复照样写完，回来自动补上。
- **面板里一键切模型**（Opus 5.5 / Opus 4.6 / Sonnet 5.5）、调思考深度、看额度和每轮用量、检查回复质量。

> [!CAUTION]
> 用订阅跑第三方程序**不在** Anthropic 允许的范围内，账号可能被限制或封禁。不能接受就用 API 密钥（见下面「其他用法」）。详见[风险提示](#风险提示)。

## 你需要

- 一台电脑（Mac / Windows / Linux），装好 [SillyTavern](https://github.com/SillyTavern/SillyTavern) 和 [Node.js](https://nodejs.org) 18 以上。
- Claude Pro 或 Max 订阅（或 API 密钥）。
- 浏览器用 Chrome 或 Edge。

## 安装（5 分钟）

**1. 打开插件开关。** 用记事本打开酒馆文件夹里的 `config.yaml`，找到这一行改成 `true`：

```yaml
enableServerPlugins: true
```

**2. 下载 CCST。** 在酒馆文件夹（有 `server.js` 的那一层）打开终端，运行：

```bash
node plugins.js install https://github.com/kcgoofee-jpg/CCST
```

**3. 安装依赖并登录 Claude。** 接着运行（会打开浏览器让你登录 Claude 账号，只需一次）：

```bash
cd plugins/CCST
npm install
npm run login
```

**4. 重启酒馆。** 关掉酒馆再打开，浏览器按 `Ctrl+F5`（Mac 是 `Cmd+Shift+R`）强制刷新。

**5. 连接。** 酒馆顶部「扩展」（积木图标）里找到 **CCST** 面板，点 **一键连接**。连上后就能聊天了。

以后只要正常启动酒馆，CCST 会跟着启动，不用再做任何事。

<details>
<summary>装不上？</summary>

- **面板说「连不上 CCST 代理」**：确认第 1 步改成了 `true`，并且重启过酒馆。酒馆的黑窗口里应该有一行 `[claude-subscription] initialised`。
- **`npm install` 报错**：不要加 `--omit=optional`；Node 版本要 18 以上（终端运行 `node -v` 查看）。
- **面板说「没登录 Claude」**：在 `plugins/CCST` 里再运行一次 `npm run login`。
- **面板没出现**：强制刷新浏览器；还不行就在「扩展 → 管理扩展」里看 CCST 有没有被关掉。

</details>

## 使用

面板有 5 页，平时只用第一页：

| 页 | 干什么 |
| --- | --- |
| **推理** | 选模型、调思考深度（越深越慢越费额度） |
| **状态** | 上一轮用了多久、缓存命中多少；订阅额度；近 7 天用量 |
| **体检** | 自动检查最新回复（字数、禁词、重复段落等）和角色卡 |
| **设置** | 代理地址、切换后端（订阅 / API 密钥 / Bedrock …）、思考选项 |
| **其他** | 手机连接、Mac 遥控、调试等不常用的功能 |

## 其他用法

- **不用订阅，用 API 密钥 / Bedrock / Vertex / OpenRouter**：照上面装好，在面板「设置 → 代理后端」里切换并填密钥。密钥只存在你电脑上。
- **不装代理，直接连 Claude API 或 OpenRouter**：只在酒馆「扩展 → 安装扩展」里填本仓库地址。面板照样能切模型、做体检，但没有防丢回复和额度统计。
- **酒馆装在服务器上 / 用 Docker**：见[使用指南 · 服务器与 Docker](docs/使用指南.md#服务器与-docker)。
- **手机 TauriTavern、Mac 一键脚本**：见[使用指南 · 其他](docs/使用指南.md#其他mac-一键安装tauritavern-与命令行)。

更多细节（缓存原理、环境变量、所有设置项）在 **[使用指南](docs/使用指南.md)**，计划在 **[路线图](docs/路线图.md)**。

## 限制

- 不支持温度、Top-P、Top-K。
- 额度和 Claude 网页版共用，受 5 小时和 7 天窗口限制。
- 首字要等几秒，比直接用 API 慢一点。

## 风险提示

- **不是官方认可的用法。** 官方文档写明，未经批准不允许第三方产品使用 claude.ai 登录或订阅额度。Anthropic 随时可能限制这种用法，或对账号采取措施。
- **内容受 Anthropic [使用政策](https://www.anthropic.com/legal/aup)约束。** 政策禁止露骨色情内容；任何涉及未成年人的性内容都绝对禁止并会被上报。
- **不要把代理开放给别人，不要共享账号。**

作者不对账号被限制、封禁或其他损失负责。

> 基于 [LukaTheHero/SillyTavern-ClaudeSubscription](https://github.com/LukaTheHero/SillyTavern-ClaudeSubscription)（AGPL-3.0）独立维护，感谢原作者。

## 许可证

[GNU AGPL v3.0 或更高版本](LICENSE)
