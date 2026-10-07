//! CCST 下一代后端——CLI 入口。
//!
//! P0 子命令：
//!   ccst login            浏览器 OAuth 登录（订阅）
//!   ccst auth-status      凭据状态（是否登录 / 是否需要刷新）
//!   ccst probe            直连发一条最小订阅请求，验证通道（P0 验收）
//!   ccst serve            启动反代（P1 起逐步落地）

use anyhow::{bail, Context};
use std::io::{BufRead, Write};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let cmd = args.next().unwrap_or_else(|| "help".into());
    match cmd.as_str() {
        "login" => login().await,
        "auth-status" => auth_status().await,
        "probe" => probe().await,
        "serve" => bail!("serve 尚未实现：P1 落地（当前处于 P0 协议尖兵阶段）"),
        _ => {
            println!("用法: ccst <login [--import-cli]|auth-status|probe|serve>");
            println!("  login --import-cli  从本机已登录的 Claude CLI 导入凭据（免浏览器授权）");
            Ok(())
        }
    }
}

async fn login() -> anyhow::Result<()> {
    let import = std::env::args().any(|a| a == "--import-cli");
    if import {
        return import_cli().await;
    }
    let session = ccst_auth::begin_login();
    println!("即将打开浏览器完成 Claude 订阅授权；若没有自动打开，请手动访问：\n\n  {}\n", session.authorize_url);
    open_browser(&session.authorize_url);
    println!("授权完成后，页面会显示一串授权码（形如 `xxxxxx#yyyyyy`），整串粘贴到这里并回车：");
    let pasted = read_line()?;
    let code = ccst_auth::parse_pasted_code(&pasted, &session)?;
    let resp = ccst_auth::exchange(&code, &session.verifier).await.context("令牌交换失败")?;
    let creds = ccst_auth::Credentials::from_response(&resp, None);
    ccst_auth::save_credentials(&creds)?;
    println!("登录成功，凭据已保存到 {}。", ccst_auth::credentials_path().display());
    Ok(())
}

/// 从本机已有的 Claude CLI 安装导入凭据（钥匙串 / 凭据文件），免浏览器登录。
async fn import_cli() -> anyhow::Result<()> {
    let creds = ccst_auth::import_from_cli().context(
        "没找到本机 Claude CLI 的凭据（macOS 钥匙串服务 \"Claude Code-credentials\" 或 ~/.claude/.credentials.json）。请改用 `ccst login` 走浏览器授权。",
    )?;
    let left = creds.expires_at.saturating_sub(now_ms()) / 1000;
    ccst_auth::save_credentials(&creds)?;
    println!(
        "已从本机 Claude CLI 导入凭据（access token 剩余约 {} 分{}秒，{}）。保存到 {}。",
        left / 60,
        left % 60,
        if creds.refresh_token.is_some() { "可自动刷新" } else { "无 refresh token" },
        ccst_auth::credentials_path().display(),
    );
    Ok(())
}

async fn auth_status() -> anyhow::Result<()> {
    match ccst_auth::load_credentials() {
        Err(ccst_auth::AuthError::NoCredentials) => {
            println!("未登录。运行 `ccst login` 开始订阅授权。");
        }
        Err(e) => return Err(e.into()),
        Ok(creds) => {
            let left = creds.expires_at.saturating_sub(now_ms()) / 1000;
            println!(
                "已登录。access token 剩余约 {} 分{}秒；{}",
                left / 60,
                left % 60,
                if creds.refresh_token.is_some() { "可自动刷新。" } else { "没有 refresh token，过期后需重新登录。" }
            );
        }
    }
    Ok(())
}

async fn probe() -> anyhow::Result<()> {
    let creds = ccst_auth::ensure_fresh().await?;
    let client = ccst_wire::SubscriptionClient::new(&creds.access_token, ccst_wire::DEFAULT_CLIENT_VERSION)?;
    println!("正在直连 {} 发送探测请求（模型 {}）……", ccst_wire::ANTHROPIC_BASE, ccst_wire::PROBE_MODEL);
    match client.probe(ccst_wire::PROBE_MODEL).await? {
        ccst_wire::ProbeOutcome::Ok(reply) => {
            println!(
                "✅ 通道可用：model={} 回复={:?} usage(in/out/cache_r/cache_w)={}/{}/{}/{}",
                reply.model,
                reply.plain_text(),
                reply.usage.input,
                reply.usage.output,
                reply.usage.cache_read,
                reply.usage.cache_write,
            );
        }
        ccst_wire::ProbeOutcome::Rejected { status, body } => {
            bail!("上游拒绝（HTTP {status}）：{body}")
        }
    }
    Ok(())
}

fn open_browser(url: &str) {
    let cmd = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(url).spawn()
    } else if cfg!(target_os = "windows") {
        std::process::Command::new("cmd").args(["/C", "start", url]).spawn()
    } else {
        std::process::Command::new("xdg-open").arg(url).spawn()
    };
    if cmd.is_err() {
        println!("（无法自动打开浏览器，请复制上面的地址手动访问）");
    }
}

fn read_line() -> anyhow::Result<String> {
    let mut line = String::new();
    std::io::stdout().flush().ok();
    std::io::stdin().lock().read_line(&mut line)?;
    Ok(line.trim().to_string())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
