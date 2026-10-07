<div align="center">

<img src="docs/assets/cover-en.png" alt="CCST: chat in SillyTavern with your own Claude subscription" width="100%">

[简体中文](README.md) · **English**

[![Version](https://img.shields.io/github/package-json/v/kcgoofee-jpg/CCST?label=version&color=c08a55)](https://github.com/kcgoofee-jpg/CCST/releases)
[![Release](https://img.shields.io/github/v/release/kcgoofee-jpg/CCST?label=release&color=c08a55)](https://github.com/kcgoofee-jpg/CCST/releases/latest)
[![Tests](https://github.com/kcgoofee-jpg/CCST/actions/workflows/test.yml/badge.svg)](https://github.com/kcgoofee-jpg/CCST/actions/workflows/test.yml)
![Platform](https://img.shields.io/badge/platform-Mac%20%7C%20Windows%20%7C%20Linux-555)
![Node](https://img.shields.io/badge/node-%E2%89%A518-339933)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

[Install](#install-5-minutes) · [FAQ](#faq) · [Guide](docs/使用指南.md) · [Roadmap](docs/路线图.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

<sub>Not an official Anthropic product and not affiliated with Anthropic. Claude is a trademark of Anthropic.</sub>

<img src="docs/assets/panel-reason.png" width="200" alt="Reasoning tab">
<img src="docs/assets/panel-status.png" width="200" alt="Status tab">

</div>

> [!IMPORTANT]
> **This branch (main) is in maintenance**: from 5.2.x on it only gets critical bug fixes; existing users can keep using it. The next generation (a direct proxy written in Rust that no longer depends on the Claude Code CLI) is being built on the [`dev`](https://github.com/kcgoofee-jpg/CCST/tree/dev) branch.

> The panel's interface is in Chinese for now.

## What it is

SillyTavern on its own only talks to pay-per-token APIs. CCST is a SillyTavern plugin; once installed:

| | |
| --- | --- |
| 🎟️ **Use your subscription**<br>Claude Pro / Max, no separate API credit; an Anthropic API key works too | 💰 **Long chats should cost less (estimate)**<br>In long chats the prompt cache can usually save re-processing part of the history; how much depends on your preset, world info and extensions |
| 🛟 **Replies survive disconnects**<br>Close the browser or drop the connection; the reply still finishes and is filled in later | 🔀 **Switch models in one click**<br>Opus 5.5 / Opus 4.6 / Sonnet 5.5, thinking depth on demand |
| 🩺 **Refusal / truncation alerts**<br>When the model refuses or the reply is cut off or empty, the status says so | 📦 **Short install**<br>SillyTavern: paste one line in Terminal (Mac) or double-click the installer (Windows) |

The panel also shows your quota and per-turn usage.

> Note: effects such as cache savings depend on your preset, world info and other extensions. They are estimates, not measured on every combination; the per-turn cache hit shown in the panel is a measured value.

> [!CAUTION]
> Using a subscription through third-party software is **not** permitted by Anthropic; your account may be limited or banned. If that's not acceptable, use an API key (see "Other setups"). Read the [risks](#risks).

## You need

- A computer (Mac / Windows / Linux) with [SillyTavern](https://github.com/SillyTavern/SillyTavern) installed. [Node.js](https://nodejs.org) 18+ (the installer tells you if it's missing).
- A Claude Pro or Max subscription (or an API key).
- Chrome or Edge.

## Install (5 minutes)

No terminal, no editing files.

**1. Install the panel in SillyTavern.** Extensions (puzzle icon) → Install extension, paste this link and install:

```
https://github.com/kcgoofee-jpg/CCST
```

**2. Get the one-click installer.** Open the **CCST** panel. A card says it can't reach the CCST proxy; on Mac click "复制命令" (copy command), on Windows click **下载一键安装（Windows）**.

**3. Run it and sign in to Claude.** Mac: open Terminal, paste the line below and press Enter (Terminal downloads it itself, so macOS does not block it); Windows: double-click the downloaded file. It finds SillyTavern, installs what's needed and opens your browser once to sign in to Claude. It says 「装好了」 (done) at the end.


```
zsh -c "$(curl -fsSL https://raw.githubusercontent.com/kcgoofee-jpg/CCST/main/install-plugin-mac.sh)"
```

- Mac: don't double-click a downloaded `.command` file. On macOS 15 and later it is blocked ("cannot verify the developer", only "Done / Move to Trash"). The Terminal line above avoids that.
- Windows "Windows protected your PC": **More info → Run anyway**.
- No Node.js yet: it opens the download page; install it and run it again (paste the same line on Mac, double-click again on Windows).

**4. Restart SillyTavern.** Close and reopen it, then hard-refresh the browser (`Ctrl+F5`, Mac `Cmd+Shift+R`). The panel connects by itself.

From then on CCST starts with SillyTavern. To update, double-click the same file again.

<details>
<summary>Didn't work?</summary>

The installer only does these steps; you can do them by hand:

1. **Allow server plugins.** In SillyTavern's `config.yaml` set:

   ```yaml
   enableServerPlugins: true
   ```

2. **Download CCST.** In the SillyTavern folder (the one with `server.js`) run:

   ```bash
   node plugins.js install https://github.com/kcgoofee-jpg/CCST
   ```

3. **Install and sign in** (opens the browser once):

   ```bash
   cd plugins/CCST
   npm install
   npm run login
   ```

4. Restart SillyTavern and click **一键连接** (connect) in the CCST panel.

- **Panel can't reach the proxy**: check `config.yaml` says `true` and that you restarted. The SillyTavern console should show `[claude-subscription] initialised`.
- **Installer can't find SillyTavern**: drag the SillyTavern folder (with `server.js`) into the installer window and press Enter.
- **`npm install` fails**: don't use `--omit=optional`; Node must be 18+ (`node -v`).
- **Panel says you're not signed in**: run the installer again, or `npm run login` in `plugins/CCST`.
- **No download button / blocked by security software**: download from the [installer folder](installer) or follow the manual steps.

</details>

## Using it

The panel has four tabs; you mostly need the first. The first time, click **一键连接** (connect): it creates and selects a SillyTavern connection profile named "CCST" (it keeps the Claude model you already picked, else Opus 4.6) and asks you to check it under API Connections. Your existing profiles are not changed.

| Tab | What it does |
| --- | --- |
| **推理** (Reasoning) | Model and thinking depth (deeper = slower, more usage) |
| **状态** (Status) | Last turn in this chat: time and cache hit (refreshed when a reply ends); a line when the latest reply was refused, cut off or empty; subscription quota; 7-day usage |
| **设置** (Settings) | Proxy address, backend (subscription / API key), thinking options, and an Advanced group (cache and context switches, thinking depth for background requests) |
| **其他** (Other) | View the request sent to the model, re-run the guide, usage notes |

## FAQ

**Cache hit stays at 0%; only rerolls hit.**
Update to **5.2.1** and restart SillyTavern. Once a subscription goes over its plan's usage and draws on extra usage, Claude Code keeps the cache for only 5 minutes, so a long reply plus reading time lets it expire while a quick reroll still hits; from 5.2.1 the proxy always asks for 1 hour. Still 0% after updating: read the Status tab details, or send the data as described below.

**The Status tab says the system prompt / history differs from message N on.**
Your preset or world info changes the content every turn (keyword-triggered world info, random macros, regexes that rewrite old messages). The details line says where and what to do.

**Still unexplained.**
Run `node scripts/wire-diagnosis.mjs` in the CCST folder (uses about 30k tokens of quota) and send the output to the maintainer. Maintainer notes: [cache troubleshooting](docs/缓存命中排查.md) (Chinese).

## Other setups

- **Anthropic API key instead of a subscription**: install as above, then switch in Settings → 代理后端 (proxy backend). Keys stay on your computer.
- **TauriTavern / not installed as a SillyTavern plugin**: run the proxy on its own on the same computer (`npm install`, `npm run login`, `npm start`); see the [guide](docs/使用指南.md#只跑代理命令行) (Chinese).

More in the [guide](docs/使用指南.md) and [roadmap](docs/路线图.md) (Chinese).

## Limits

- No temperature, Top-P or Top-K.
- Usage is shared with Claude.ai and subject to the 5-hour and 7-day windows.
- First token takes a few seconds longer than a direct API call.

## Risks

- **Not an approved use.** Anthropic's docs say third-party products may not use claude.ai sign-in or subscription usage without approval. Anthropic may restrict this at any time or act on accounts.
- **Content is bound by Anthropic's [Usage Policy](https://www.anthropic.com/legal/aup).** Explicit sexual content is prohibited; any sexual content involving minors is strictly prohibited and reported.
- **Don't expose the proxy to others or share accounts.**

The author is not responsible for limited or banned accounts or any other loss.

> Independently maintained fork of [LukaTheHero/SillyTavern-ClaudeSubscription](https://github.com/LukaTheHero/SillyTavern-ClaudeSubscription) (AGPL-3.0). Thanks to the original author.

## Related

- [tt-root-module](https://github.com/kcgoofee-jpg/tt-root-module): a KernelSU module for rooted Android phones that automatically backs up, verifies and syncs the data of TauriTavern (and SillyDroid / Termux SillyTavern) and restores it in one step. Worth installing if you run TauriTavern on a phone and don't want to lose your chats.

## License

[GNU AGPL v3.0 or later](LICENSE)
