# CCST

在 SillyTavern（酒馆）里用你自己的 Claude Pro / Max 订阅聊天。只支持 Windows 和 macOS。

> [!CAUTION]
> 非 Anthropic 官方产品。用订阅跑第三方程序不在 Anthropic 允许的范围内，账号可能被限制。内容受 Anthropic [使用政策](https://www.anthropic.com/legal/aup)约束。

## 安装

需要：装好的酒馆、[Node.js](https://nodejs.org) 18 以上、Claude Pro 或 Max。

**1. 装面板。** 酒馆顶部「扩展」（积木图标）→「安装扩展」，粘贴下面这行，点安装：

```
https://github.com/kcgoofee-jpg/CCST
```

**2. 运行一键安装。**

- **Windows**：在 CCST 面板点「下载一键安装（Windows）」，双击下载的 `CCST安装.bat`。弹出「Windows 已保护你的电脑」就点「更多信息」→「仍要运行」。
- **Mac**：打开「终端」（`Cmd+空格` 搜「终端」），粘贴下面这行，回车：

  ```
  zsh -c "$(curl -fsSL https://raw.githubusercontent.com/kcgoofee-jpg/CCST/main/install-plugin-mac.sh)"
  ```

中间会打开一次浏览器让你登录 Claude。窗口里出现「装好了」就完成了。

**3. 重启酒馆。** 关掉酒馆的黑窗口（Mac 是终端窗口）再启动，浏览器强制刷新（Windows `Ctrl+F5`，Mac `Cmd+Shift+R`）。

**4. 连接。** 打开 CCST 面板，点「一键连接」。

## 更新

再运行一次第 2 步（Windows 双击同一个 `.bat`，Mac 粘贴同一行），然后重启酒馆。

它会下载最新的安装程序，把插件和面板都更新到最新版本。以前装过旧版本的，它也会找出来，移到酒馆文件夹里的 `CCST旧版备份-日期` 里。旧版本包括别的文件夹里的旧插件、旧面板、旧的开机自启。这些东西不删除，用几天没问题再自己删掉。

## 出问题

- **安装失败**：把桌面上的 `CCST安装日志.txt` 发给作者。
- **聊天报错、缓存命中低**：聊两三轮后，CCST 面板 →「状态」→「导出诊断文件」，把下载的文件私发给作者。文件里有角色卡和聊天原文，别公开贴。

---

旧版说明（功能介绍、常见问题、手动安装等）在 [docs/归档](docs/归档/README-6.0.1.md)。许可证 [AGPL-3.0](LICENSE)，基于 [LukaTheHero/SillyTavern-ClaudeSubscription](https://github.com/LukaTheHero/SillyTavern-ClaudeSubscription)。
