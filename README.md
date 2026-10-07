# CCST · dev（下一代：Rust 直连）

> 这是 `dev` 分支，从零重写，还不能日常使用。能用的版本在 [`main`](https://github.com/kcgoofee-jpg/CCST)（6.0，经 Claude Code CLI，维护模式）。

**和 main 的区别**：main 让酒馆 → 本机代理 → Claude Code CLI → Anthropic；dev 由一个 Rust 程序直接调 Anthropic Messages API，不再经过 CLI。好处是缓存断点、请求形状完全由我们决定（main 的「预设尾部每轮重复」「CLI 沿用旧系统提示词」这类问题不再存在），也不跟着 CLI 的版本漂移。

**风险，请先读**：dev 用 Claude 订阅登录的凭据（OAuth）直接调 API，不是官方客户端。同类项目（clewdr）有用户报告账号被封（#161）、请求被拒「凭据只能给 Claude Code 用」（#129），新模型还会要求最低的 Claude Code 版本号（Opus 5.5 要求 ≥ 2.1.280）。我们会尽量对齐真实 CLI 的请求，但风险不能保证为零。官方路线（风险最低）是 main。

## 结构

```
crates/
├─ ccst-auth/  订阅 OAuth：PKCE 登录 / 交换 / 刷新 / 凭据存储（0600）
├─ ccst-wire/  Anthropic Messages API 客户端：订阅请求头、计费头（billing.rs）、探测
├─ ccst-chat/  OpenAI ↔ Claude 转换、缓存断点（cache.rs）、SSE 翻译与按字节分帧
└─ ccst/       二进制：login / auth-status / probe / serve
```

```sh
cargo build && cargo test
cargo run -p ccst -- login          # 浏览器授权
cargo run -p ccst -- probe          # 直连真实订阅一次
CCST_PORT=8901 cargo run -p ccst -- serve   # 酒馆「自定义（兼容 OpenAI）」填 http://127.0.0.1:8901/v1
```

凭据在 `~/.ccst-next/credentials.json`（0600，`CCST_HOME` 可改目录）。

## 里程碑

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| D0 | 登录、计费头、OpenAI 兼容接口、流式翻译、显式 1h 缓存断点（来自旧 dev 的 P0–P2） | ✅ 真实订阅 3 轮流式，第 2、3 轮命中 99.6% |
| D1 | 请求对齐真实 CLI：计费头版本号可配置、beta 头合并（oauth beta 在前、去重）、上游 400 按报错自适应参数（不照搬 clewdr 的规则表）；对照脚本：抓一次本机 CLI 请求逐项比较 | 待做 |
| D2 | 酒馆提示词整形（移植 main 6.0 的结论，见下） | 待做 |
| D3 | 登录与额度：网页登录、单飞刷新、轮换后的 refresh token 原子保存、/api/oauth/usage 的 5h / 7d | 待做 |
| D4 | 网页管理页 + /health + 诊断报告（沿用 main 的报告格式） | 待做 |
| D5 | 面板：沿用 main 6.0 的面板与「装代理 → 登录 → 连接」引导，只换第一步 | 待做 |
| D6 | 打包：Windows、macOS 的程序文件与一键安装 | 待做 |

## 从 main 6.0 带过来的规则（都有实测）

1. **断点放在玩家原话之后、预设尾部之前**：`[历史…][原话 ⚑][预设尾部]`。下一轮旧轮次只剩原话，前缀不变，预设尾部不再在历史里堆副本（main 受 CLI 限制做不到，第 7 轮时一半请求是重复的尾部）。
2. **聊天记录的起止由面板告诉后端**（面板发第一条 / 最后一条聊天消息的开头和生成类型）：之前的条目（含 user / assistant 角色，如 Kemini、Izumi）进系统提示词，之后的条目跟在原话后面；只有「继续」才保留末尾 assistant 作预填。
3. **深度注入**（面板发每条插进聊天的提示词开头）：永远跟本轮走，旧楼层不动；和之前给过的一字不差就换成一句说明。
4. **系统区的关键词世界书**（面板发本轮触发条目原文）：按原文连同一个换行移到本轮，系统提示词不随触发变化。
5. **只给最新发言套标签的正则**（Kemini `<interactive_input>`）：认旧轮次时容忍只差标签和空白。
6. **每个请求 system[0] 是计费头**；缺了上游回 `429 Error`，和额度无关。
7. **429 要分清**：额度耗尽、请求形状被拒、需要额外用量各有不同报错 / 头，不能一律当额度冷却（clewdr 的坑）。401 先单飞刷新一次再判失效。
8. 客户端脚本每轮改提示词（Izumi 悬浮窗的 Advice、关键词替换）任何后端都缓存不住，诊断要能直接指出来。

## 参考

- clewdr（AGPL-3.0）：OAuth 流程、计费头公式、beta 合并；它不放缓存断点、OpenAI 入口零命中（#140 未解），这正是我们要做的部分。
- main 的 `docs/缓存命中排查.md`：CLI 实际请求、缓存有效期、根因记录。
