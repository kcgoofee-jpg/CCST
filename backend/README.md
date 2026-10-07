# backend — CCST 下一代反代（Rust）

`dev` 分支的重写主线。定位与里程碑见仓库内计划文档（CLI/SDK 线在 `main`，维护模式）。

## 结构

```
crates/
├─ ccst-auth/  Claude 订阅 OAuth（PKCE 登录 / 交换 / 刷新 / 凭据存储 0600）
├─ ccst-wire/  Anthropic Messages API 客户端（订阅请求头、模型探测、流式解析待 P1）
└─ ccst/       二进制入口：login / auth-status / probe / serve(P1)
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

## 协议参考

- clewdr（AGPL-3.0）`src/claude_code_state/`：OAuth 常量与流程（token 端点、公开 client_id、redirect URI、beta 头）。
- 本仓库 `docs/缓存命中排查.md`：tap 实测的 CLI wire 行为（计费头、system-reminder、断点规则），是新后端请求构造的对齐基准。
