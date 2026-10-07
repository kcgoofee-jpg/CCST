//! 出站代理探测：环境变量优先，其次 macOS 系统代理（scutil --proxy）。
//!
//! 国内网络直连 api.anthropic.com 会被掐断，而用户通常在系统层配了代理
//! 但 shell 里没有 HTTPS_PROXY——这时读系统代理是唯一自动可用的路径。

use reqwest::ClientBuilder;

/// 给客户端套上探测到的出站代理。环境变量（HTTPS_PROXY 等）reqwest
/// 默认就会用；这里补的是 macOS 系统代理。
pub fn apply(builder: ClientBuilder) -> ClientBuilder {
    if let Some(url) = detect() {
        if let Ok(proxy) = reqwest::Proxy::all(&url) {
            return builder.proxy(proxy);
        }
    }
    builder
}

/// 返回探测到的代理 URL（http://host:port 或 socks5://host:port）。
pub fn detect() -> Option<String> {
    for key in ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] {
        if let Ok(v) = std::env::var(key) {
            let v = v.trim().to_string();
            if !v.is_empty() {
                return Some(v);
            }
        }
    }
    #[cfg(target_os = "macos")]
    return macos_system_proxy();
    #[cfg(not(target_os = "macos"))]
    None
}

#[cfg(target_os = "macos")]
fn macos_system_proxy() -> Option<String> {
    let out = std::process::Command::new("scutil").arg("--proxy").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let get = |key: &str| -> Option<String> {
        text.lines().find_map(|l| {
            l.trim()
                .strip_prefix(key)
                .and_then(|rest| rest.trim().strip_prefix(':'))
                .map(|v| v.trim().to_string())
        })
    };
    // 优先 HTTPS 代理（http CONNECT），其次 SOCKS
    if get("HTTPSEnable")?.trim() == "1" {
        if let (Some(host), Some(port)) = (get("HTTPSProxy"), get("HTTPSPort")) {
            return Some(format!("http://{host}:{port}"));
        }
    }
    if get("SOCKSEnable")?.trim() == "1" {
        if let (Some(host), Some(port)) = (get("SOCKSProxy"), get("SOCKSPort")) {
            return Some(format!("socks5://{host}:{port}"));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_var_wins_when_set() {
        let saved = std::env::var("HTTPS_PROXY").ok();
        std::env::set_var("HTTPS_PROXY", "http://127.0.0.1:9999");
        assert_eq!(detect().as_deref(), Some("http://127.0.0.1:9999"));
        match saved {
            Some(v) => std::env::set_var("HTTPS_PROXY", v),
            None => std::env::remove_var("HTTPS_PROXY"),
        }
    }

    // macOS 本机：有系统代理时 detect() 应该能拿到（无断言值，只断言不 panic）
    #[test]
    #[cfg(target_os = "macos")]
    fn detect_never_panics() {
        let _ = detect();
    }
}
