# CCST

Chat in SillyTavern with your own Claude Pro / Max subscription. Windows and macOS only. [简体中文](README.md)

> [!CAUTION]
> Not an Anthropic product. Running third-party software on a subscription is outside what Anthropic allows; your account may be restricted. Content is subject to Anthropic's [Usage Policy](https://www.anthropic.com/legal/aup).

## Install

You need SillyTavern, [Node.js](https://nodejs.org) 18+, and Claude Pro or Max.

1. **Panel.** In SillyTavern open Extensions → Install extension, paste `https://github.com/kcgoofee-jpg/CCST` and install.
2. **One-click installer.**
   - **Windows:** in the CCST panel click "下载一键安装（Windows）" and double-click `CCST安装.bat`. If SmartScreen appears, choose "More info" → "Run anyway".
   - **Mac:** open Terminal and run:

     ```
     zsh -c "$(curl -fsSL https://raw.githubusercontent.com/kcgoofee-jpg/CCST/main/install-plugin-mac.sh)"
     ```

   A browser window opens once for the Claude login. You're done when it says "装好了".
3. **Restart SillyTavern** and hard-refresh the browser.
4. In the CCST panel click "一键连接".

## Update

Run step 2 again, then restart SillyTavern. The installer updates both the plugin and the panel. It also moves old copies into `CCST旧版备份-<date>` in the SillyTavern folder. Old copies are plugins in other folders, old panels, and old autostart entries.

## Problems

- **Install failed:** send the `CCST安装日志.txt` file on your Desktop.
- **Chat errors or low cache hits:** after two or three turns, CCST panel → 状态 → 导出诊断文件, and send the file privately. It contains the character card and chat text.

## World info moved to the current message (on by default)

Claude's cache only matches an unchanged beginning. Keyword-triggered world-info entries sit inside the system prompt and change from turn to turn, so every change re-writes the whole chat to the cache. CCST takes the entries SillyTavern triggered this turn out of the system prompt and puts their text in front of your message, so the rest stays cached. Which entries fire is still SillyTavern's decision; constant entries never move. An entry given in the last 10 turns is not repeated; older ones are sent again. An entry that stops firing stays in the turn where it was given. For cards that switch state with mutually exclusive entries (affection levels, day / night), turn it off in CCST → 设置 → 缓存 → 「世界书移到本轮消息」: it then behaves exactly like plain SillyTavern.

The old README is archived in [docs/归档](docs/归档/README-6.0.1.en.md). License: [AGPL-3.0](LICENSE).
