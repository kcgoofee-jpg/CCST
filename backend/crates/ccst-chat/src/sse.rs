//! Claude SSE 事件流 → OpenAI chat.completion.chunk 翻译。
//!
//! 输入：Claude SSE 的 `data:` JSON 行（逐条喂给 [`SseTranslator::feed`]）。
//! 输出：可直接写回下游的 OpenAI chunk JSON 字符串（不含 `data: ` 前缀与
//! 结尾空行——由调用方统一包装），以及终止信号（`[DONE]`）。

use serde_json::{json, Value};

/// 翻译器状态：块索引 → 块类型（决定 delta 落在 content 还是 reasoning_content）。
#[derive(Debug, Default)]
pub struct SseTranslator {
    id: String,
    model: String,
    created: u64,
    role_sent: bool,
    block_types: std::collections::HashMap<u64, String>,
    finish_reason: Option<String>,
    usage: Option<Value>,
    done: bool,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

impl SseTranslator {
    pub fn new(model: impl Into<String>) -> Self {
        SseTranslator {
            id: format!("chatcmpl-ccst-{}", now_secs()),
            model: model.into(),
            created: now_secs(),
            role_sent: false,
            block_types: Default::default(),
            finish_reason: None,
            usage: None,
            done: false,
        }
    }

    fn chunk(&self, delta: Value, finish_reason: Option<&str>) -> String {
        json!({
            "id": self.id,
            "object": "chat.completion.chunk",
            "created": self.created,
            "model": self.model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
        })
        .to_string()
    }

    /// 喂一条 Claude SSE `data:` 载荷；返回要写给下游的 OpenAI chunk 列表。
    /// 事件顺序异常（块没 start 先 delta）时按 delta 类型兜底路由。
    pub fn feed(&mut self, line: &str) -> Vec<String> {
        if self.done {
            return vec![];
        }
        let ev: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return vec![],
        };
        let etype = ev.get("type").and_then(Value::as_str).unwrap_or("");
        match etype {
            "message_start" => {
                let input = ev
                    .pointer("/message/usage/input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                self.usage = Some(json!({"input_tokens": input}));
                vec![]
            }
            "content_block_start" => {
                let idx = ev.get("index").and_then(Value::as_u64).unwrap_or(0);
                let bt = ev
                    .pointer("/content_block/type")
                    .and_then(Value::as_str)
                    .unwrap_or("text")
                    .to_string();
                self.block_types.insert(idx, bt.clone());
                // 首个内容块出现时先发 role
                if !self.role_sent {
                    self.role_sent = true;
                    return vec![self.chunk(json!({"role": "assistant"}), None)];
                }
                vec![]
            }
            "content_block_delta" => {
                let idx = ev.get("index").and_then(Value::as_u64).unwrap_or(0);
                let delta = ev.get("delta").cloned().unwrap_or(Value::Null);
                let dtype = delta.get("type").and_then(Value::as_str).unwrap_or("");
                let (field, payload) = match dtype {
                    "text_delta" => ("content", delta.get("text")),
                    "thinking_delta" => ("reasoning_content", delta.get("thinking")),
                    _ => return vec![],
                };
                let piece = payload.and_then(Value::as_str).unwrap_or("");
                if piece.is_empty() {
                    return vec![];
                }
                let mut out = vec![];
                if !self.role_sent {
                    self.role_sent = true;
                    out.push(self.chunk(json!({"role": "assistant"}), None));
                }
                let _ = self.block_types.entry(idx).or_insert_with(|| {
                    if field == "reasoning_content" { "thinking".into() } else { "text".into() }
                });
                out.push(self.chunk(json!({ field: piece }), None));
                out
            }
            "content_block_stop" => vec![],
            "message_delta" => {
                let reason = ev
                    .pointer("/delta/stop_reason")
                    .and_then(Value::as_str)
                    .map(finish_reason_of);
                if let Some(r) = &reason {
                    self.finish_reason = Some(r.clone());
                }
                if let Some(u) = ev.get("usage") {
                    let cur = self.usage.get_or_insert_with(|| json!({}));
                    if let Some(o) = u.get("output_tokens") {
                        cur["output_tokens"] = o.clone();
                    }
                }
                vec![]
            }
            "message_stop" => {
                self.done = true;
                let reason = self.finish_reason.clone().unwrap_or_else(|| "stop".into());
                let mut final_chunk: Value = serde_json::from_str(&self.chunk(json!({}), Some(&reason))).unwrap_or(Value::Null);
                // usage 挂在最后一个 chunk 的顶层（OpenAI stream_options 习惯）
                if let Some(u) = &self.usage {
                    let input = u.get("input_tokens").cloned().unwrap_or(json!(0));
                    let output = u.get("output_tokens").cloned().unwrap_or(json!(0));
                    let total = input.as_u64().unwrap_or(0) + output.as_u64().unwrap_or(0);
                    final_chunk["usage"] = json!({
                        "prompt_tokens": input,
                        "completion_tokens": output,
                        "total_tokens": total,
                    });
                }
                out_done(final_chunk.to_string())
            }
            // error 事件（上游中途报错）：交给调用方走错误路径，这里只吞掉
            "error" => vec![],
            _ => vec![],
        }
    }
}

fn out_done(mut final_chunk: String) -> Vec<String> {
    final_chunk.push('\n');
    final_chunk.push_str("[DONE]");
    vec![final_chunk]
}

/// Claude stop_reason → OpenAI finish_reason。
pub fn finish_reason_of(claude: &str) -> String {
    match claude {
        "max_tokens" => "length".into(),
        "refusal" => "content_filter".into(),
        _ => "stop".into(), // end_turn / stop_sequence
    }
}

/// 非流式：把翻译器吃到的文本/思考聚合成一条完整 OpenAI 响应。
#[derive(Debug, Default)]
pub struct Collector {
    pub text: String,
    pub reasoning: String,
    pub finish_reason: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

impl Collector {
    /// 从非流式 Claude 响应体直接聚合（不走 SSE）。
    pub fn from_messages_reply(reply: &Value) -> Collector {
        let mut c = Collector {
            finish_reason: reply
                .get("stop_reason")
                .and_then(Value::as_str)
                .map(finish_reason_of),
            ..Default::default()
        };
        for block in reply.get("content").and_then(Value::as_array).into_iter().flatten() {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => c.text.push_str(block.get("text").and_then(Value::as_str).unwrap_or("")),
                Some("thinking") => c.reasoning.push_str(block.get("thinking").and_then(Value::as_str).unwrap_or("")),
                _ => {}
            }
        }
        let u = reply.get("usage");
        c.input_tokens = u.and_then(|u| u.get("input_tokens")).and_then(Value::as_u64).unwrap_or(0);
        c.output_tokens = u.and_then(|u| u.get("output_tokens")).and_then(Value::as_u64).unwrap_or(0);
        c
    }

    pub fn usage_json(&self) -> Value {
        json!({
            "prompt_tokens": self.input_tokens,
            "completion_tokens": self.output_tokens,
            "total_tokens": self.input_tokens + self.output_tokens,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_all(t: &mut SseTranslator, events: &[Value]) -> Vec<String> {
        let mut out = vec![];
        for e in events {
            out.extend(t.feed(&e.to_string()));
        }
        out
    }

    fn chunk_delta(s: &str) -> Value {
        let v: Value = serde_json::from_str(s.lines().next().unwrap()).unwrap();
        v["choices"][0]["delta"].clone()
    }

    #[test]
    fn streams_role_then_content_then_reasoning_then_done() {
        let mut t = SseTranslator::new("claude-opus-4-6");
        let events = vec![
            json!({"type":"message_start","message":{"id":"m","usage":{"input_tokens":100}}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"想"}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"content_block_start","index":1,"content_block":{"type":"text"}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"你好"}}),
            json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}),
            json!({"type":"message_stop"}),
        ];
        let out = feed_all(&mut t, &events);
        // role → reasoning → content → final+DONE
        assert_eq!(chunk_delta(&out[0]), json!({"role": "assistant"}));
        assert_eq!(chunk_delta(&out[1]), json!({"reasoning_content": "想"}));
        assert_eq!(chunk_delta(&out[2]), json!({"content": "你好"}));
        let last = out.last().unwrap();
        assert!(last.ends_with("[DONE]"));
        let final_obj: Value = serde_json::from_str(last.trim_end_matches("[DONE]").trim_end()).unwrap();
        assert_eq!(final_obj["choices"][0]["finish_reason"], "stop");
        assert_eq!(final_obj["usage"]["prompt_tokens"], 100);
        assert_eq!(final_obj["usage"]["completion_tokens"], 9);
        assert_eq!(final_obj["usage"]["total_tokens"], 109);
    }

    #[test]
    fn max_tokens_maps_to_length() {
        assert_eq!(finish_reason_of("max_tokens"), "length");
        assert_eq!(finish_reason_of("refusal"), "content_filter");
        assert_eq!(finish_reason_of("stop_sequence"), "stop");
    }

    #[test]
    fn collector_from_nonstream_reply() {
        let reply = json!({
            "content": [{"type":"thinking","thinking":"…"},{"type":"text","text":"答案"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 5, "output_tokens": 2}
        });
        let c = Collector::from_messages_reply(&reply);
        assert_eq!(c.text, "答案");
        assert_eq!(c.reasoning, "…");
        assert_eq!(c.finish_reason.as_deref(), Some("stop"));
        assert_eq!(c.usage_json()["total_tokens"], 7);
    }
}
