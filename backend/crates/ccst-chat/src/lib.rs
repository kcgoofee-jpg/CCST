//! OpenAI ↔ Claude 转换与 SSE 翻译。

pub mod cache;
mod sse;

pub use sse::{finish_reason_of, openai_usage, Collector, SseFramer, SseTranslator};

use serde_json::{json, Value};
use std::error::Error;

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ConvertError(pub String);

pub struct Converted {
    pub body: Value,
    pub extra_beta: Vec<String>,
}

/// 上游错误 → (HTTP 状态, OpenAI 错误体 JSON 字符串)。
pub fn upstream_error(upstream_status: u16, body: &str) -> (u16, String) {
    let err_type = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.pointer("/error/type").and_then(Value::as_str).map(str::to_string));

    let (hint, out_status) = match err_type.as_deref() {
        Some("authentication_error") => (
            "订阅没登录或登录已过期：运行 `ccst login`（或 `ccst login --import-cli`）重新认证。",
            401,
        ),
        Some("rate_limit_error") => (
            "订阅额度到上限了（请求太频繁，或 5 小时 / 周额度用完）。等一会儿再试。",
            429,
        ),
        Some("permission_error") => ("订阅没有权限使用这个模型或功能。", 403),
        Some("not_found_error") => ("模型或端点不存在：检查模型名。", 404),
        Some("request_too_large") => ("请求体太大：减少附件图片或历史长度。", 413),
        Some("overloaded_error") => ("Claude 服务器太忙，稍等再试。", 529),
        Some("invalid_request_error") => ("请求参数被上游拒绝：检查模型名与参数组合。", 400),
        _ => ("Claude 请求失败，原因不明。", upstream_status),
    };
    let raw = body.chars().take(300).collect::<String>();
    let message = format!("【CCST】{hint}（原始错误：{raw}）");
    (out_status, json!({"error": {"message": message, "type": err_type.unwrap_or_else(|| "server_error".into())}}).to_string())
}

/// 转换结果：Claude 请求体 + 需要追加的 anthropic-beta 头。
///
/// OpenAI 请求 → Claude Messages 请求：system 归并、缓存断点（[`cache`]，一律 1h）、连续同角色合并、data-URL
/// 图片转 base64 块、`[1m]` 变体剥后缀并加 context-1m beta、stop/温度透传。
pub fn to_claude_request(openai: &Value) -> Result<Converted, ConvertError> {
    let obj = openai.as_object().ok_or_else(|| ConvertError("请求体不是 JSON 对象".into()))?;

    let raw_model = obj
        .get("model")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| ConvertError("缺少 model".into()))?;
    let (model, one_m) = match raw_model.strip_suffix("[1m]") {
        Some(base) => (base.to_string(), true),
        None => (raw_model.to_string(), false),
    };

    let max_tokens = obj.get("max_tokens").and_then(Value::as_u64).unwrap_or(8192);
    let messages_in = obj
        .get("messages")
        .and_then(Value::as_array)
        .filter(|m| !m.is_empty())
        .ok_or_else(|| ConvertError("缺少 messages（非空数组）".into()))?;

    // system 全部归并（保序），挂 1h 缓存断点
    let mut system_text = String::new();
    let mut messages: Vec<Value> = Vec::new();
    for m in messages_in {
        let role = m.get("role").and_then(Value::as_str).unwrap_or("");
        let content = m.get("content").unwrap_or(&Value::Null);
        match role {
            "system" => {
                let t = content_to_text(content);
                if !t.is_empty() {
                    if !system_text.is_empty() {
                        system_text.push_str("\n\n");
                    }
                    system_text.push_str(&t);
                }
            }
            "user" | "assistant" => {
                let blocks = content_to_blocks(content)?;
                if blocks.is_empty() {
                    continue;
                }
                // Claude 要求 user/assistant 交替：连续同角色并入上一条
                if messages.last().and_then(|p| p.get("role")).and_then(Value::as_str) == Some(role) {
                    if let Some(arr) = messages
                        .last_mut()
                        .and_then(|p| p.get_mut("content"))
                        .and_then(Value::as_array_mut)
                    {
                        arr.extend(blocks);
                    }
                } else {
                    messages.push(json!({ "role": role, "content": blocks }));
                }
            }
            _ => {} // tool 等角色 P1 不支持
        }
    }
    if messages.is_empty() {
        return Err(ConvertError("没有可发送的消息".into()));
    }

    let mut body = json!({
        "model": model,
        "max_tokens": max_tokens,
        "messages": messages,
    });
    if !system_text.is_empty() {
        body["system"] = json!([{ "type": "text", "text": system_text }]);
    }
    cache::place_breakpoints(&mut body);
    if obj.get("stream").and_then(Value::as_bool) == Some(true) {
        body["stream"] = json!(true);
    }
    if let Some(stop) = stop_sequences(openai) {
        body["stop_sequences"] = stop;
    }
    for key in ["temperature", "top_p"] {
        if let Some(v) = obj.get(key).filter(|v| v.is_number()) {
            body[key] = v.clone();
        }
    }

    let mut extra_beta = vec![];
    if one_m {
        extra_beta.push("context-1m-2025-08-07".into());
    }
    Ok(Converted { body, extra_beta })
}

fn stop_sequences(obj: &Value) -> Option<Value> {
    let mut seqs: Vec<String> = match obj.get("stop") {
        Some(Value::String(s)) if !s.is_empty() => vec![s.clone()],
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect(),
        _ => vec![],
    };
    if seqs.is_empty() {
        return None;
    }
    seqs.truncate(4);
    Some(json!(seqs))
}

fn content_to_blocks(content: &Value) -> Result<Vec<Value>, ConvertError> {
    match content {
        Value::String(s) => Ok(text_blocks(s)),
        Value::Array(parts) => {
            let mut out = Vec::new();
            for p in parts {
                let ptype = p.get("type").and_then(Value::as_str).unwrap_or("text");
                match ptype {
                    "text" => out.extend(text_blocks(p.get("text").and_then(Value::as_str).unwrap_or(""))),
                    "image_url" => {
                        let url = p
                            .get("image_url")
                            .and_then(|i| i.get("url"))
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        if let Some(block) = data_url_to_image(url) {
                            out.push(block);
                        }
                        // http(s) 图片 URL 需要额外下载，P1 不支持：静默跳过
                    }
                    _ => {}
                }
            }
            Ok(out)
        }
        Value::Null => Ok(vec![]),
        other => Err(ConvertError(format!("不支持的 content 类型：{other}"))),
    }
}

fn text_blocks(s: &str) -> Vec<Value> {
    if s.is_empty() {
        return vec![];
    }
    vec![json!({ "type": "text", "text": s })]
}

/// `data:image/png;base64,xxxx` → Claude image 块。非 data URL 返回 None。
fn data_url_to_image(url: &str) -> Option<Value> {
    let rest = url.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    let media_type = meta.strip_suffix(";base64")?.trim().to_string();
    if media_type.is_empty() || data.is_empty() {
        return None;
    }
    Some(json!({
        "type": "image",
        "source": { "type": "base64", "media_type": media_type, "data": data },
    }))
}

fn content_to_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

// 让 thiserror 的错误链可用（未直接使用 Error trait 时保持导入有效）
#[allow(dead_code)]
fn _error_chain(e: &dyn Error) -> String {
    e.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn basic_conversion_with_system_cache_breakpoint() {
        let req = json!({
            "model": "claude-opus-4-6",
            "max_tokens": 123,
            "messages": [
                {"role": "system", "content": "你是猫娘。"},
                {"role": "user", "content": "你好"},
                {"role": "assistant", "content": "喵。"},
                {"role": "user", "content": "继续"}
            ]
        });
        let c = to_claude_request(&req).unwrap();
        assert_eq!(c.body["model"], "claude-opus-4-6");
        assert_eq!(c.body["max_tokens"], 123);
        let sys = c.body["system"].as_array().unwrap();
        assert_eq!(sys[0]["text"], "你是猫娘。");
        assert_eq!(sys[0]["cache_control"]["ttl"], "1h");
        let msgs = c.body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 3);
        assert!(c.extra_beta.is_empty());
        assert!(c.body.get("stream").is_none());
        let streamed = to_claude_request(&json!({"model": "m", "stream": true, "messages": [{"role": "user", "content": "hi"}]})).unwrap();
        assert_eq!(streamed.body["stream"], true, "流式要转发给上游，否则上游回整段 JSON");
    }

    #[test]
    fn consecutive_same_role_merge() {
        let req = json!({
            "model": "m",
            "messages": [
                {"role": "user", "content": "a"},
                {"role": "user", "content": "b"},
                {"role": "assistant", "content": "c"}
            ]
        });
        let msgs = to_claude_request(&req).unwrap().body["messages"].as_array().unwrap().clone();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["content"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn one_m_variant_strips_suffix_and_adds_beta() {
        let req = json!({"model": "claude-opus-4-6[1m]", "messages": [{"role": "user", "content": "hi"}]});
        let c = to_claude_request(&req).unwrap();
        assert_eq!(c.body["model"], "claude-opus-4-6");
        assert_eq!(c.extra_beta, vec!["context-1m-2025-08-07"]);
    }

    #[test]
    fn stop_temperature_passthrough() {
        let req = json!({
            "model": "m",
            "stop": ["###"],
            "temperature": 0.7,
            "messages": [{"role": "user", "content": "hi"}]
        });
        let c = to_claude_request(&req).unwrap();
        assert_eq!(c.body["stop_sequences"], json!(["###"]));
        assert_eq!(c.body["temperature"], 0.7);
        assert!(c.body.get("top_p").is_none());
    }

    #[test]
    fn data_url_image_becomes_base64_block() {
        let req = json!({
            "model": "m",
            "messages": [
                {"role": "user", "content": [
                    {"type": "text", "text": "看图"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,QUJD"}}
                ]}
            ]
        });
        let blocks = to_claude_request(&req).unwrap().body["messages"][0]["content"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[1]["source"]["media_type"], "image/png");
    }

    #[test]
    fn errors_are_named() {
        assert!(to_claude_request(&json!({"messages": [{"role": "user", "content": "x"}]})).is_err());
        assert!(to_claude_request(&json!({"model": "m", "messages": []})).is_err());
    }

    #[test]
    fn upstream_errors_map_to_chinese() {
        let (status, msg) = upstream_error(401, r#"{"error":{"type":"authentication_error","message":"x"}}"#);
        assert_eq!(status, 401);
        assert!(msg.contains("没登录或登录已过期"));
        let (status, msg) = upstream_error(400, r#"{"error":{"type":"rate_limit_error","message":"x"}}"#);
        assert_eq!(status, 429, "按错误类型而非 HTTP 状态映射");
        assert!(msg.contains("额度到上限"));
        let (_, msg) = upstream_error(500, "not json");
        assert!(msg.contains("原因不明"));
    }
}
