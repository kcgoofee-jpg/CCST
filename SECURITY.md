# 安全政策 / Security Policy

## 怎么报告

发现安全问题（代理被外部访问、密钥或登录凭据泄露、命令注入等），请用 GitHub 的私密通道：本仓库 **Security → Report a vulnerability**。不要开公开 issue。

If you find a security issue, use **Security → Report a vulnerability** on this repository (private). Please do not open a public issue.

## 报告里不要放

- API 密钥、访问密码、登录令牌（`~/.claude` 下的文件）。
- 完整的聊天记录或角色卡。

只需要说明：哪个版本、怎么复现、影响是什么。日志请先把密钥和令牌涂掉。如果你不小心贴出了密钥，请立刻去对应平台作废并重新生成。

## 范围

CCST 代理默认只监听 `127.0.0.1`；开放到局域网时需要设置访问密码，不要把它暴露到公网，也不要共享账号。使用订阅的风险见 [README](README.md#风险提示)，那不属于安全漏洞。

## 支持的版本

只维护最新发布的版本。
