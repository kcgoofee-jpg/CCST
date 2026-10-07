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
                // 缓存读写只在 message_start 里出现：整份留下
                self.usage = Some(ev.pointer("/message/usage").cloned().unwrap_or_else(|| json!({})));
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
                    if let (Some(cur), Some(u)) = (cur.as_object_mut(), u.as_object()) {
                        for (k, v) in u {
                            if !v.is_null() {
                                cur.insert(k.clone(), v.clone());
                            }
                        }
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
                    final_chunk["usage"] = openai_usage(u);
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

/// 按字节切 SSE 事件：网络分片可能落在一个汉字的 UTF-8 字节中间，逐片解码会变成
/// U+FFFD。只在收齐一个完整事件（空行结尾）后再解码。
#[derive(Debug, Default)]
pub struct SseFramer {
    buf: Vec<u8>,
}

impl SseFramer {
    /// 喂一片字节，返回其中已完整的事件里所有 `data:` 载荷。
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(bytes);
        let mut out = vec![];
        while let Some(pos) = self.buf.windows(2).position(|w| w == b"\n\n") {
            let event: Vec<u8> = self.buf.drain(..pos + 2).collect();
            let text = String::from_utf8_lossy(&event);
            for line in text.lines() {
                if let Some(payload) = line.strip_prefix("data:") {
                    let payload = payload.trim();
                    if !payload.is_empty() {
                        out.push(payload.to_string());
                    }
                }
            }
        }
        out
    }
}

/// Claude usage → OpenAI usage。prompt_tokens 按 OpenAI 语义含缓存读写；
/// 缓存明细原样附上（面板据此显示命中率与有效期）。
pub fn openai_usage(u: &Value) -> Value {
    let n = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
    let (input, read, write, output) = (n("input_tokens"), n("cache_read_input_tokens"), n("cache_creation_input_tokens"), n("output_tokens"));
    let prompt = input + read + write;
    let mut out = json!({
        "prompt_tokens": prompt,
        "completion_tokens": output,
        "total_tokens": prompt + output,
        "prompt_tokens_details": { "cached_tokens": read },
        "cache_read_input_tokens": read,
        "cache_creation_input_tokens": write,
    });
    if let Some(c) = u.get("cache_creation").filter(|c| c.is_object()) {
        out["cache_creation"] = c.clone();
    }
    out
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
    pub usage: Value,
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
        c.usage = u.cloned().unwrap_or(Value::Null);
        c
    }

    pub fn usage_json(&self) -> Value {
        openai_usage(&self.usage)
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

    #[test]
    fn framer_survives_a_chunk_boundary_inside_a_cjk_char() {
        let wire = "data: {\"t\":\"汉字\"}\n\ndata: {\"t\":\"二\"}\n\n".as_bytes();
        let cut = wire.iter().position(|&b| b >= 0x80).unwrap() + 1; // 切在「汉」的第 1 个字节之后
        let mut f = SseFramer::default();
        let mut got = f.push(&wire[..cut]);
        assert!(got.is_empty());
        got.extend(f.push(&wire[cut..]));
        assert_eq!(got, vec![r#"{"t":"汉字"}"#.to_string(), r#"{"t":"二"}"#.to_string()]);
    }

    #[test]
    fn usage_keeps_cache_read_write_and_ttl_split() {
        let mut t = SseTranslator::new("m");
        let out = feed_all(&mut t, &[
            json!({"type":"message_start","message":{"id":"m","usage":{"input_tokens":3,"cache_read_input_tokens":27700,"cache_creation_input_tokens":338,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":338}}}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}),
            json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}),
            json!({"type":"message_stop"}),
        ]);
        let last = out.last().unwrap().split('\n').next().unwrap().to_string();
        let u = &serde_json::from_str::<Value>(&last).unwrap()["usage"];
        assert_eq!(u["prompt_tokens"], 3 + 27700 + 338);
        assert_eq!(u["prompt_tokens_details"]["cached_tokens"], 27700);
        assert_eq!(u["cache_creation"]["ephemeral_1h_input_tokens"], 338);
        assert_eq!(u["completion_tokens"], 5);
    }
}
