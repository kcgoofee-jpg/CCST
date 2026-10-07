//! 反代服务：`ccst serve`。
//!
//! 路由：
//!   GET  /status                 凭据/版本概览
//!   GET  /v1/models              OpenAI 模型列表（含 [1m] 变体）
//!   POST /v1/chat/completions    OpenAI 兼容聊天（流式 SSE + 非流式）
//!
//! 默认绑定 127.0.0.1:8901（`CCST_PORT` 覆盖）。鉴权（LAN 密码）在 P3。

use anyhow::Context;
use axum::body::Body;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::state::SharedState;

pub fn router(state: SharedState) -> Router {
    Router::new()
        .route("/status", get(status))
        .route("/v1/models", get(models))
        .route("/v1/chat/completions", post(chat_completions))
        .with_state(state)
}

pub async fn serve() -> anyhow::Result<()> {
    let state = SharedState::new();
    let port: u16 = std::env::var("CCST_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8901);
    let app = router(state);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .with_context(|| format!("绑定 127.0.0.1:{port} 失败"))?;
    println!("CCST 反代已启动：http://127.0.0.1:{port}/v1  （酒馆自定义端点填 http://127.0.0.1:{port}/v1）");
    axum::serve(listener, app).await?;
    Ok(())
}

// ── /status ──

async fn status(State(state): State<SharedState>) -> Response {
    let creds = state.credentials().await;
    let body = json!({
        "ok": true,
        "service": "ccst-next",
        "version": env!("CARGO_PKG_VERSION"),
        "clientVersion": ccst_wire::DEFAULT_CLIENT_VERSION,
        "credential": match creds {
            Some(c) => json!({
                "loggedIn": true,
                "expiresAt": c.expires_at,
                "canRefresh": c.refresh_token.is_some(),
            }),
            None => json!({"loggedIn": false}),
        },
    });
    json_response(StatusCode::OK, &body)
}

// ── /v1/models ──

/// 模型目录（P1 静态表；配置表驱动在 P2）。
const CATALOG: &[(&str, &str, bool)] = &[
    ("claude-fable-5-1", "Claude Fable 5.1", true),
    ("claude-opus-5-5", "Claude Opus 5.5", true),
    ("claude-opus-5", "Claude Opus 5", true),
    ("claude-opus-4-8", "Claude Opus 4.8", true),
    ("claude-opus-4-6", "Claude Opus 4.6", true),
    ("claude-sonnet-5-5", "Claude Sonnet 5.5", false),
    ("claude-sonnet-5", "Claude Sonnet 5", true),
    ("claude-sonnet-4-6", "Claude Sonnet 4.6", true),
    ("claude-haiku-4-5", "Claude Haiku 4.5", false),
];

async fn models() -> Response {
    let mut data = vec![];
    for (id, name, one_m) in CATALOG {
        data.push(json!({
            "id": id, "object": "model", "created": 0, "owned_by": "anthropic",
            "display_name": name, "context_window": 200_000,
        }));
        if *one_m {
            data.push(json!({
                "id": format!("{id}[1m]"), "object": "model", "created": 0, "owned_by": "anthropic",
                "display_name": format!("{name} (1M context)"), "context_window": 1_000_000,
            }));
        }
    }
    json_response(StatusCode::OK, &json!({ "object": "list", "data": data }))
}

// ── /v1/chat/completions ──

async fn chat_completions(State(state): State<SharedState>, axum::Json(body): axum::Json<Value>) -> Response {
    let want_stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let model = body.get("model").and_then(Value::as_str).unwrap_or("").to_string();

    // 转换失败 → 400
    let converted = match ccst_chat::to_claude_request(&body) {
        Ok(c) => c,
        Err(e) => return json_response(StatusCode::BAD_REQUEST, &error_body(&e.to_string())),
    };

    match complete(state, converted).await {
        Ok(upstream) => match upstream {
            UpstreamOutcome::Ok(resp, extra_beta) => {
                if want_stream {
                    stream_reply(resp, &model, &extra_beta).await
                } else {
                    aggregate_reply(resp, &model).await
                }
            }
            UpstreamOutcome::Error(status, message) => json_response(
                StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                &error_body(&message),
            ),
        },
        Err(e) => json_response(StatusCode::INTERNAL_SERVER_ERROR, &error_body(&format!("{e:#}"))),
    }
}

enum UpstreamOutcome {
    /// 已认证的响应（含重试后成功），连同最终使用的 beta 头。
    Ok(reqwest::Response, Vec<String>),
    /// 上游错误（含一次刷新重试后仍失败）。
    Error(u16, String),
}

/// 发送上游请求；401 时强制刷新凭据重试一次。
async fn complete(state: SharedState, converted: ccst_chat::Converted) -> anyhow::Result<UpstreamOutcome> {
    let creds = match state.ensure_credentials().await {
        Some(c) => c,
        None => {
            return Ok(UpstreamOutcome::Error(
                401,
                "未登录。先在终端运行 `ccst login`（或 `ccst login --import-cli`）导入/完成订阅授权。".into(),
            ))
        }
    };
    let client = ccst_wire::SubscriptionClient::new(&creds.access_token, ccst_wire::DEFAULT_CLIENT_VERSION)?;
    let resp = client.post_messages(&converted.body, &converted.extra_beta).await?;
    if resp.status().as_u16() != 401 {
        return Ok(UpstreamOutcome::Ok(resp, converted.extra_beta));
    }
    // 401：强制刷新凭据后重试一次
    let fresh = state.force_refresh().await?;
    let retried = ccst_wire::SubscriptionClient::new(&fresh.access_token, ccst_wire::DEFAULT_CLIENT_VERSION)?
        .post_messages(&converted.body, &converted.extra_beta)
        .await?;
    Ok(UpstreamOutcome::Ok(retried, converted.extra_beta))
}

async fn stream_reply(resp: reqwest::Response, model: &str, _extra_beta: &[String]) -> Response {
    use futures::StreamExt;
    let mut upstream: futures::stream::BoxStream<'static, Result<bytes::Bytes, reqwest::Error>> =
        Box::pin(resp.bytes_stream());
    let (tx, rx) = mpsc::channel::<Result<bytes::Bytes, std::io::Error>>(32);
    let model = model.to_string();
    tokio::spawn(async move {
        let mut translator = ccst_chat::SseTranslator::new(&model);
        let mut buffer = String::new();
        while let Some(chunk) = upstream.next().await {
            let bytes = match chunk {
                Ok(b) => b,
                Err(e) => {
                    let _ = tx.send(Err(std::io::Error::new(std::io::ErrorKind::Other, e))).await;
                    return;
                }
            };
            buffer.push_str(&String::from_utf8_lossy(&bytes));
            // SSE 事件以空行分隔
            while let Some(pos) = buffer.find("\n\n") {
                let event = buffer.drain(..pos + 2).collect::<String>();
                for line in event.lines().filter(|l| l.starts_with("data:")) {
                    let payload = line.trim_start_matches("data:").trim();
                    if payload.is_empty() {
                        continue;
                    }
                    for chunk in translator.feed(payload) {
                        let wire = format!("data: {chunk}\n\n");
                        if tx.send(Ok(bytes::Bytes::from(wire))).await.is_err() {
                            return;
                        }
                    }
                }
            }
        }
    });
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "text/event-stream")
        .header("Cache-Control", "no-cache")
        .body(Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx)))
        .unwrap()
}

async fn aggregate_reply(resp: reqwest::Response, model: &str) -> Response {
    let status = resp.status().as_u16();
    let payload = resp.text().await.unwrap_or_default();
    if status != 200 {
        let (out_status, message) = ccst_chat::upstream_error(status, &payload);
        return json_response(
            StatusCode::from_u16(out_status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            &error_body(&message),
        );
    }
    let reply: Value = match serde_json::from_str(&payload) {
        Ok(v) => v,
        Err(e) => return json_response(StatusCode::INTERNAL_SERVER_ERROR, &error_body(&format!("上游响应解析失败：{e}"))),
    };
    let c = ccst_chat::Collector::from_messages_reply(&reply);
    let mut message = json!({ "role": "assistant", "content": c.text });
    if !c.reasoning.is_empty() {
        message["reasoning_content"] = json!(c.reasoning);
    }
    json_response(
        StatusCode::OK,
        &json!({
            "id": reply.get("id").cloned().unwrap_or(json!("chatcmpl-ccst")),
            "object": "chat.completion",
            "created": reply.get("created").cloned().unwrap_or(json!(0)),
            "model": model,
            "choices": [{"index": 0, "message": message, "finish_reason": c.finish_reason.clone().unwrap_or_else(|| "stop".into())}],
            "usage": c.usage_json(),
        }),
    )
}

// ── 小工具 ──

fn error_body(message: &str) -> Value {
    json!({ "error": { "message": message, "type": "server_error" } })
}

fn json_response(status: StatusCode, body: &Value) -> Response {
    (status, axum::Json(body.clone())).into_response()
}
