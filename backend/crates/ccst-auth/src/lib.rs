//! Claude 订阅 OAuth（PKCE）——登录、令牌交换、刷新、凭据存储。
//!
//! 协议常量与流程参考 clewdr（AGPL-3.0）`src/claude_code_state/` 的实现，
//! 端点与 client_id 为 Claude Code CLI 的公开值。

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

mod outbound;
pub use outbound::apply as apply_outbound_proxy;

pub const AUTHORIZE_URL: &str = "https://claude.ai/oauth/authorize";
pub const TOKEN_URL: &str = "https://api.anthropic.com/v1/oauth/token";
/// Claude Code CLI 的公开 OAuth client id（无 client secret，公开值）。
pub const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
pub const REDIRECT_URI: &str = "https://console.anthropic.com/oauth/code/callback";
pub const SCOPES: &str = "user:profile user:inference";

const VERIFIER_BYTES: usize = 32;
/// access token 剩余寿命低于该值时提前刷新。
const REFRESH_MARGIN: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("登录被取消或回调里没有 code")]
    NoCode,
    #[error("state 不匹配（回调 {callback}，本机 {local}）——请重试登录")]
    StateMismatch { callback: String, local: String },
    #[error("上游拒绝（{status}）：{body}")]
    Upstream { status: u16, body: String },
    #[error("凭据不存在：请先运行登录")]
    NoCredentials,
    #[error("令牌已过期且没有 refresh token：请重新登录")]
    RefreshImpossible,
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

/// 一次登录会话的本地状态：verifier 必须留到换 token 那一步。
#[derive(Debug, Clone)]
pub struct LoginSession {
    pub verifier: String,
    pub state: String,
    pub authorize_url: String,
}

/// 生成 PKCE 会话与浏览器授权地址。
pub fn begin_login() -> LoginSession {
    let verifier = random_b64url(VERIFIER_BYTES);
    let state = random_b64url(VERIFIER_BYTES);
    let authorize_url = format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&state={}",
        AUTHORIZE_URL,
        urlenc(CLIENT_ID),
        urlenc(REDIRECT_URI),
        urlenc(SCOPES),
        code_challenge(&verifier),
        urlenc(&state),
    );
    LoginSession { verifier, state, authorize_url }
}

/// 用户从回调页复制回来的串可能是 `code#state`，也可能是裸 code。
pub fn parse_pasted_code(pasted: &str, session: &LoginSession) -> Result<String, AuthError> {
    let pasted = pasted.trim();
    let (code, state) = match pasted.split_once('#') {
        Some((c, s)) => (c, Some(s)),
        None => (pasted, None),
    };
    if code.is_empty() {
        return Err(AuthError::NoCode);
    }
    if let Some(s) = state {
        if s != session.state {
            return Err(AuthError::StateMismatch { callback: s.to_string(), local: session.state.clone() });
        }
    }
    Ok(code.to_string())
}

#[derive(Debug, Clone, Serialize)]
pub struct TokenRequest<'a> {
    pub grant_type: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code_verifier: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<&'a str>,
    pub client_id: &'a str,
    pub redirect_uri: &'a str,
}

impl<'a> TokenRequest<'a> {
    /// 授权码换 token 的表单体。
    pub fn authorization_code(code: &'a str, verifier: &'a str, redirect_uri: &'a str) -> TokenRequest<'a> {
        TokenRequest {
            grant_type: "authorization_code",
            code: Some(code),
            code_verifier: Some(verifier),
            refresh_token: None,
            client_id: CLIENT_ID,
            redirect_uri,
        }
    }

    /// 刷新令牌的表单体（恰好三个字段）。
    pub fn refresh(refresh_token: &'a str) -> TokenRequest<'a> {
        TokenRequest {
            grant_type: "refresh_token",
            code: None,
            code_verifier: None,
            refresh_token: Some(refresh_token),
            client_id: CLIENT_ID,
            redirect_uri: REDIRECT_URI,
        }
    }

    pub fn to_form(&self) -> String {
        let mut pairs = vec![("grant_type", self.grant_type), ("client_id", self.client_id)];
        if let Some(c) = self.code {
            pairs.push(("code", c));
        }
        if let Some(v) = self.code_verifier {
            pairs.push(("code_verifier", v));
        }
        if let Some(r) = self.refresh_token {
            pairs.push(("refresh_token", r));
        }
        // 与 clewdr/Claude CLI 一致：redirect_uri 只在授权码交换时携带，
        // 刷新表单恰好三个字段。
        if self.grant_type == "authorization_code" {
            pairs.push(("redirect_uri", self.redirect_uri));
        }
        pairs.iter().map(|(k, v)| format!("{k}={}", urlenc(v))).collect::<Vec<_>>().join("&")
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub expires_in: u64,
    #[serde(default)]
    pub token_type: Option<String>,
}

/// 磁盘上的凭据：access token + 刷新用的 refresh token + 过期时刻。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Credentials {
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// epoch 毫秒
    pub expires_at: u64,
}

impl Credentials {
    pub fn from_response(resp: &TokenResponse, fallback_refresh: Option<&str>) -> Self {
        let expires_at = now_ms() + resp.expires_in.saturating_mul(1000);
        Credentials {
            access_token: resp.access_token.clone(),
            refresh_token: resp.refresh_token.clone().or_else(|| fallback_refresh.map(str::to_string)),
            expires_at,
        }
    }

    pub fn expired(&self) -> bool {
        self.expires_at <= now_ms() + REFRESH_MARGIN.as_millis() as u64
    }

    pub fn needs_refresh(&self) -> bool {
        self.expired() && self.refresh_token.is_some()
    }
}

/// HTTP 客户端无关的令牌交换：返回 (响应, 表单体) 由调用方发送后回填。
/// 这里只做纯计算与解析，网络在 `exchange`/`refresh_async` 中。
pub async fn exchange(code: &str, verifier: &str) -> Result<TokenResponse, AuthError> {
    let form = TokenRequest::authorization_code(code, verifier, REDIRECT_URI).to_form();
    post_token(&form).await
}

pub async fn refresh(refresh_token: &str) -> Result<TokenResponse, AuthError> {
    let form = TokenRequest::refresh(refresh_token).to_form();
    post_token(&form).await
}

async fn post_token(form: &str) -> Result<TokenResponse, AuthError> {
    // 令牌端点固定，不复用 wire crate，保持本 crate 轻依赖。
    let client = apply_outbound_proxy(reqwest::Client::builder())
        .build()
        .map_err(|e| AuthError::Upstream { status: 0, body: e.to_string() })?;
    let resp = client
        .post(TOKEN_URL)
        .header("Accept", "application/json")
        .header("anthropic-version", "2023-06-01")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form.to_string())
        .send()
        .await
        .map_err(|e| AuthError::Upstream { status: 0, body: e.to_string() })?;
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    if status != 200 {
        return Err(AuthError::Upstream { status, body });
    }
    Ok(serde_json::from_str(&body)?)
}

// ── 存储 ──

/// 凭据文件位置：`$CCST_HOME/credentials.json`，默认 `~/.ccst-next/`。
pub fn credentials_path() -> PathBuf {
    if let Some(home) = std::env::var_os("CCST_HOME") {
        return Path::new(&home).join("credentials.json");
    }
    let base = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join(".ccst-next").join("credentials.json")
}

pub fn load_credentials() -> Result<Credentials, AuthError> {
    let path = credentials_path();
    let raw = std::fs::read_to_string(&path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AuthError::NoCredentials
        } else {
            e.into()
        }
    })?;
    Ok(serde_json::from_str(&raw)?)
}

pub fn save_credentials(creds: &Credentials) -> Result<(), AuthError> {
    let path = credentials_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    write_private(&path, &serde_json::to_string_pretty(creds)?).map_err(AuthError::Io)
}

/// 强制刷新（上游 401 时重试前调用），无论剩余寿命。
pub async fn force_refresh() -> Result<Credentials, AuthError> {
    let creds = load_credentials()?;
    let rt = creds.refresh_token.clone().ok_or(AuthError::RefreshImpossible)?;
    let resp = refresh(&rt).await?;
    let fresh = Credentials::from_response(&resp, Some(&rt));
    save_credentials(&fresh)?;
    Ok(fresh)
}

/// 取可用 access token：没过期直接用；快过期且有 refresh token 则刷新并落盘。
pub async fn ensure_fresh() -> Result<Credentials, AuthError> {
    let creds = load_credentials()?;
    if !creds.needs_refresh() {
        return Ok(creds);
    }
    let rt = creds.refresh_token.clone().ok_or(AuthError::RefreshImpossible)?;
    let resp = refresh(&rt).await?;
    let fresh = Credentials::from_response(&resp, Some(&rt));
    save_credentials(&fresh)?;
    Ok(fresh)
}

// ── 从已有 Claude CLI 安装导入 ──

/// Claude Code CLI 的钥匙串服务名（macOS）。
pub const CLI_KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
/// Linux/Windows 下 CLI 的凭据文件。
pub fn cli_credentials_file() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let base = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".claude"));
    Some(base.join(".credentials.json"))
}

/// 从本机已有的 Claude CLI 安装导入凭据（钥匙串 / 凭据文件）。
/// CLI 用的 OAuth client 与本工具相同，token 可直接复用，免去浏览器登录。
pub fn import_from_cli() -> Result<Credentials, AuthError> {
    let raw = read_cli_credentials_raw().ok_or(AuthError::NoCredentials)?;
    import_json(&raw)
}

fn read_cli_credentials_raw() -> Option<String> {
    // 1. 文件（Linux/Windows，或配置了 CLAUDE_CONFIG_DIR 的 macOS）
    if let Some(path) = cli_credentials_file() {
        if let Ok(raw) = std::fs::read_to_string(&path) {
            return Some(raw);
        }
    }
    // 2. macOS 钥匙串
    if cfg!(target_os = "macos") {
        let out = std::process::Command::new("security")
            .args(["find-generic-password", "-s", CLI_KEYCHAIN_SERVICE, "-w"])
            .output()
            .ok()?;
        if out.status.success() {
            return Some(String::from_utf8_lossy(&out.stdout).trim().to_string());
        }
    }
    None
}

/// 解析 CLI 凭据 JSON：`{claudeAiOauth: {accessToken, refreshToken, expiresAt}}`
/// 或平铺的同名字段。
fn import_json(raw: &str) -> Result<Credentials, AuthError> {
    #[derive(Deserialize)]
    struct CliOauth {
        #[serde(rename = "accessToken")]
        access_token: String,
        #[serde(rename = "refreshToken")]
        refresh_token: Option<String>,
        #[serde(rename = "expiresAt")]
        expires_at: Option<u64>,
    }
    #[derive(Deserialize)]
    struct CliEnvelope {
        #[serde(rename = "claudeAiOauth")]
        claude_ai_oauth: Option<CliOauth>,
        #[serde(flatten)]
        flat: Option<CliOauth>,
    }
    let env: CliEnvelope = serde_json::from_str(raw)?;
    let oauth = env.claude_ai_oauth.or(env.flat).ok_or(AuthError::NoCredentials)?;
    if oauth.access_token.is_empty() {
        return Err(AuthError::NoCredentials);
    }
    Ok(Credentials {
        access_token: oauth.access_token,
        refresh_token: oauth.refresh_token,
        expires_at: oauth.expires_at.unwrap_or(0),
    })
}

// ── 内部 ──

pub fn code_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn random_b64url(n: usize) -> String {
    use rand::RngCore;
    let mut buf = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn urlenc(s: &str) -> String {
    // 查询串/表单都只需要转义保留字符；值里出现的安全字符集有限，简单足矣。
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(unix)]
fn write_private(path: &Path, content: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)?;
    f.write_all(content.as_bytes())
}

#[cfg(not(unix))]
fn write_private(path: &Path, content: &str) -> std::io::Result<()> {
    std::fs::write(path, content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_credentials_json_both_shapes() {
        // 钥匙串形态：包在 claudeAiOauth 里
        let wrapped = r#"{"claudeAiOauth":{"accessToken":"sk-ant-oat01-x","refreshToken":"rt","expiresAt":1791500000000,"scopes":["user:inference"],"subscriptionType":"max"}}"#;
        let c = import_json(wrapped).unwrap();
        assert_eq!(c.access_token, "sk-ant-oat01-x");
        assert_eq!(c.refresh_token.as_deref(), Some("rt"));
        assert_eq!(c.expires_at, 1791500000000);

        // 平铺形态（部分版本）
        let flat = r#"{"accessToken":"a","refreshToken":null,"expiresAt":1}"#;
        let c2 = import_json(flat).unwrap();
        assert_eq!(c2.access_token, "a");
        assert_eq!(c2.refresh_token, None);
    }

    /// RFC 7636 附录 B 的官方测试向量。
    #[test]
    fn pkce_challenge_matches_rfc7636() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(code_challenge(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn login_url_carries_all_params() {
        let s = begin_login();
        assert!(s.authorize_url.starts_with("https://claude.ai/oauth/authorize?"));
        assert!(s.authorize_url.contains("response_type=code"));
        assert!(s.authorize_url.contains(&format!("client_id={}", CLIENT_ID)));
        assert!(s.authorize_url.contains(&format!("redirect_uri={}", urlenc(REDIRECT_URI))));
        assert!(s.authorize_url.contains(&format!("scope={}", urlenc(SCOPES))));
        assert!(s.authorize_url.contains("code_challenge_method=S256"));
        assert!(s.authorize_url.contains(&format!("code_challenge={}", code_challenge(&s.verifier))));
        assert!(s.authorize_url.contains(&format!("state={}", s.state)));
        // verifier 是 43 字符的 base64url（32 字节）
        assert_eq!(s.verifier.len(), 43);
        assert!(!s.verifier.contains('=') && !s.verifier.contains('+') && !s.verifier.contains('/'));
    }

    #[test]
    fn pasted_code_parses_code_and_state() {
        let s = begin_login();
        assert_eq!(parse_pasted_code(&format!("abc#{}", s.state), &s).unwrap(), "abc");
        assert_eq!(parse_pasted_code("abc", &s).unwrap(), "abc");
        assert!(matches!(
            parse_pasted_code("abc#wrong", &s),
            Err(AuthError::StateMismatch { .. })
        ));
        assert!(matches!(parse_pasted_code("  #state", &s), Err(AuthError::NoCode)));
    }

    #[test]
    fn forms_carry_exact_fields() {
        let exchange = TokenRequest::authorization_code("c1", "v1", REDIRECT_URI).to_form();
        assert!(exchange.contains("grant_type=authorization_code"));
        assert!(exchange.contains("code=c1"));
        assert!(exchange.contains("code_verifier=v1"));
        assert!(exchange.contains(&format!("client_id={}", CLIENT_ID)));
        assert!(!exchange.contains("refresh_token"));

        let refresh = TokenRequest::refresh("r1").to_form();
        assert!(refresh.contains("grant_type=refresh_token"));
        assert!(refresh.contains("refresh_token=r1"));
        assert_eq!(refresh.matches('&').count(), 2, "刷新表单恰好三个字段");
        assert!(!refresh.contains("code="));
    }

    #[test]
    fn token_response_parses_and_keeps_fallback_refresh() {
        let resp: TokenResponse = serde_json::from_str(
            r#"{"access_token":"at","expires_in":3600,"refresh_token":"rt2","token_type":"bearer","organization":{"uuid":"u"}}"#,
        )
        .unwrap();
        let creds = Credentials::from_response(&resp, Some("rt1"));
        assert_eq!(creds.refresh_token.as_deref(), Some("rt2"), "新 refresh 优先");
        assert!(!creds.expired());

        let resp2: TokenResponse =
            serde_json::from_str(r#"{"access_token":"at","expires_in":3600}"#).unwrap();
        let creds2 = Credentials::from_response(&resp2, Some("rt1"));
        assert_eq!(creds2.refresh_token.as_deref(), Some("rt1"), "上游没发新 refresh 时保留旧的");
    }

    #[test]
    fn expiry_margin_triggers_refresh() {
        let mut creds = Credentials {
            access_token: "a".into(),
            refresh_token: Some("r".into()),
            expires_at: now_ms() + 1000,
        };
        assert!(creds.needs_refresh());
        creds.expires_at = now_ms() + 3600_000;
        assert!(!creds.needs_refresh());
        creds.refresh_token = None;
        creds.expires_at = now_ms() + 1000;
        assert!(!creds.needs_refresh(), "没有 refresh token 时无从刷新，保持原样由调用方报错");
    }
}
