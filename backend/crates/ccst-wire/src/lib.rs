//! Anthropic Messages API 客户端（订阅通道）。
//!
//! 请求头与端点参考 clewdr（AGPL-3.0）与 Claude Code CLI 的公开 wire 形态：
//! `Authorization: Bearer <oauth token>` + `anthropic-beta: oauth-2025-04-20`
//! + `claude-cli/<version>` User-Agent。客户端版本号是配置项：上游会在版本
//! 过旧时拒绝请求，届时只改这里的一个常量/配置。

use serde::{Deserialize, Serialize};

pub const ANTHROPIC_BASE: &str = "https://api.anthropic.com";
pub const API_VERSION: &str = "2023-06-01";
/// 订阅（OAuth 走 Claude Code 通道）必需的 beta 头。
pub const BETA_OAUTH: &str = "oauth-2025-04-20";
/// 跟随上游 Claude Code 的客户端版本（配置项；过旧会被 400）。
pub const DEFAULT_CLIENT_VERSION: &str = "2.1.258";

#[derive(Debug, Clone)]
pub struct SubscriptionClient {
    http: reqwest::Client,
    access_token: String,
    client_version: String,
}

impl SubscriptionClient {
    pub fn new(access_token: impl Into<String>, client_version: impl Into<String>) -> anyhow::Result<Self> {
        let client_version = client_version.into();
        let http = ccst_auth::apply_outbound_proxy(reqwest::Client::builder())
            .user_agent(format!("claude-cli/{}", client_version))
            .build()?;
        Ok(Self { http, access_token: access_token.into(), client_version })
    }

    /// 订阅通道的公共请求头。
    pub fn headers(&self) -> reqwest::header::HeaderMap {
        use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION};
        let mut h = HeaderMap::new();
        h.insert(AUTHORIZATION, HeaderValue::from_str(&format!("Bearer {}", self.access_token)).expect("token 应为合法头值"));
        h.insert(HeaderName::from_static("anthropic-version"), HeaderValue::from_static(API_VERSION));
        h.insert(HeaderName::from_static("anthropic-beta"), HeaderValue::from_static(BETA_OAUTH));
        h.insert(HeaderName::from_static("x-app"), HeaderValue::from_static("cli"));
        let _ = &self.client_version;
        h
    }

    /// 非流式最小探测：验证凭据与通道是否可用（P0 验收用）。
    pub async fn probe(&self, model: &str) -> anyhow::Result<ProbeOutcome> {
        let body = serde_json::json!({
            "model": model,
            "max_tokens": 32,
            "messages": [{"role": "user", "content": "Reply with exactly: ok"}],
        });
        let resp = self
            .http
            .post(format!("{ANTHROPIC_BASE}/v1/messages"))
            .headers(self.headers())
            .json(&body)
            .send()
            .await?;
        let status = resp.status().as_u16();
        let payload = resp.text().await?;
        Ok(match status {
            200 => ProbeOutcome::Ok(serde_json::from_str(&payload)?),
            code => ProbeOutcome::Rejected { status: code, body: payload },
        })
    }
}

#[derive(Debug)]
pub enum ProbeOutcome {
    Ok(MessagesReply),
    Rejected { status: u16, body: String },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct MessagesReply {
    pub id: String,
    pub model: String,
    #[serde(default)]
    pub role: String,
    pub stop_reason: Option<String>,
    #[serde(default)]
    pub content: Vec<ContentBlock>,
    #[serde(default)]
    pub usage: Usage,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text { text: String },
    Thinking { thinking: String },
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Usage {
    #[serde(default, rename = "input_tokens")]
    pub input: u64,
    #[serde(default, rename = "output_tokens")]
    pub output: u64,
    #[serde(default, rename = "cache_read_input_tokens")]
    pub cache_read: u64,
    #[serde(default, rename = "cache_creation_input_tokens")]
    pub cache_write: u64,
}

impl MessagesReply {
    pub fn plain_text(&self) -> String {
        self.content
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("")
    }
}

/// P0 默认探测模型（真实 API id；目录表在 P1 落地）。
pub const PROBE_MODEL: &str = "claude-opus-4-6";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headers_carry_subscription_identity() {
        let c = SubscriptionClient::new("tok", DEFAULT_CLIENT_VERSION).unwrap();
        let h = c.headers();
        assert_eq!(h.get("Authorization").unwrap(), "Bearer tok");
        assert_eq!(h.get("anthropic-version").unwrap(), API_VERSION);
        assert_eq!(h.get("anthropic-beta").unwrap(), BETA_OAUTH);
        assert_eq!(h.get("x-app").unwrap(), "cli");
    }

    #[test]
    fn reply_parses_text_and_usage() {
        let raw = r#"{
            "id": "msg_1", "model": "claude-opus-4-6", "role": "assistant",
            "stop_reason": "end_turn",
            "content": [
                {"type": "thinking", "thinking": "…"},
                {"type": "text", "text": "ok"}
            ],
            "usage": {"input_tokens": 12, "output_tokens": 3, "cache_read_input_tokens": 40, "cache_creation_input_tokens": 7}
        }"#;
        let reply: MessagesReply = serde_json::from_str(raw).unwrap();
        assert_eq!(reply.plain_text(), "ok");
        assert_eq!(reply.usage.input, 12);
        assert_eq!(reply.usage.cache_read, 40);
        assert_eq!(reply.usage.cache_write, 7);
        assert_eq!(reply.stop_reason.as_deref(), Some("end_turn"));
    }

    #[test]
    fn unknown_blocks_are_tolerated() {
        let raw = r#"{"id":"m","model":"x","role":"assistant","stop_reason":null,"content":[{"type":"server_tool_use","name":"web_search"}],"usage":{}}"#;
        let reply: MessagesReply = serde_json::from_str(raw).unwrap();
        assert_eq!(reply.content.len(), 1);
        assert!(matches!(reply.content[0], ContentBlock::Other));
    }
}
