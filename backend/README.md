# backend — CCST 下一代反代（Rust）

`dev` 分支的重写主线。定位与里程碑见仓库内计划文档（CLI/SDK 线在 `main`，维护模式）。

## 结构

```
crates/
├─ ccst-auth/  Claude 订阅 OAuth（PKCE 登录 / 交换 / 刷新 / 凭据存储 0600）
├─ ccst-wire/  Anthropic Messages API 客户端（订阅请求头 + 计费头 billing.rs、探测）
├─ ccst-chat/  OpenAI ↔ Claude 转换、缓存断点 cache.rs、SSE 翻译与按字节分帧
└─ ccst/       二进制入口：login / auth-status / probe / serve
```

## 本地构建与 P0 验收

```sh
cd backend
cargo build
cargo test

cargo run -p ccst -- login        # 浏览器授权，粘贴回调授权码
cargo run -p ccst -- auth-status
cargo run -p ccst -- probe        # 直连真实订阅请求（P0 验收）
```

凭据存在 `~/.ccst-next/credentials.json`（0600，可用 `CCST_HOME` 覆盖目录）。

```sh
CCST_PORT=8901 cargo run -p ccst -- serve   # 酒馆「自定义（兼容 OpenAI）」端点填 http://127.0.0.1:8901/v1
```

## 进度

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 | OAuth 登录 / 导入 CLI 凭据 / 出站代理；直连探测 | ✅ 2026-10-07 实测 200 |
| P1 | serve：OpenAI 兼容接口、流式 SSE 翻译、401 自动刷新 | ✅ 真实订阅 3 轮流式通过 |
| P2 | 缓存断点：system + 最近两条 user，全部显式 1h | ✅ 第 2、3 轮命中 99.6%（约 2.9 万 token 读，116 写） |
| P3 | 酒馆兼容：深度注入归位、世界书移位（移植 main 的 system-placement / lore-tail）、访问密码 | 待做 |
| P4 | 面板对接：/status、用量与缓存诊断、额度 | 待做 |
| P5 | 切换：安装器改装二进制，旧 JS 代理下线 | 待做 |

## 订阅通道的两条硬规则（实测）

1. **每个请求 `system[0]` 必须是 Claude Code 计费头**（`billing.rs`，与 CLI 2.1.285 / clewdr 同一公式）。缺了它上游回 `429 rate_limit_error`、message 只有 `Error`——和额度无关。P0 首跑把这个 429 误读成"周额度耗尽"。
2. **断点一律显式 `ttl: "1h"`**（`cache.rs`）。main 线 2026-10 的「缓存 0%」就是 CLI 按账号开关退回 5 分钟：长回复 + 阅读时间一过，每轮都过期。

## 协议参考

- clewdr（AGPL-3.0）`src/claude_code_state/`：OAuth 常量与流程（token 端点、公开 client_id、redirect URI、beta 头）。
- 本仓库 `docs/缓存命中排查.md`：tap 实测的 CLI wire 行为（缓存有效期的选择逻辑、计费头、system-reminder、断点规则）。
