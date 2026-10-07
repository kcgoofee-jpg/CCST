//! 提示词缓存断点（P2）。
//!
//! 直连路线上没有 CLI 替我们打断点，下游（酒馆）也不会打：不打就没有缓存。
//! 这里每个请求统一放断点，规则来自 main 线两次「缓存 0%」事故：
//!
//! - **一律显式 `ttl: "1h"`**。5 分钟缓存撑不过一条长回复加阅读时间（2026-10-07 事故：
//!   CLI 按账号开关退回 5m，每轮都过期、只有重 roll 命中）。不留给任何默认值。
//! - **system 末尾**一个：角色卡 / 预设整段缓存。
//! - **最后一条 user 消息末尾**一个：写入到本轮为止的整段对话。结尾是 assistant 续写
//!   （prefill）时也放在它前面那条 user 上——续写下一轮会变成完整回复，挂在它上面的
//!   缓存永远对不上。
//! - **倒数第二条 user 消息末尾**一个：上一轮写入的条目正好在这里，保证本轮命中，
//!   不依赖服务端回溯窗口（约 20 个块；带多张图的一轮可能超出）。
//!
//! 合计不超过 4 个（API 上限）。下游带来的 cache_control 一律先清掉，以这里为准。

use serde_json::{json, Value};

pub const TTL: &str = "1h";

fn breakpoint() -> Value {
    json!({ "type": "ephemeral", "ttl": TTL })
}

/// 能挂断点的块：有类型且不是 thinking（thinking 块不接受 cache_control）。
fn cacheable(block: &Value) -> bool {
    matches!(block.get("type").and_then(Value::as_str), Some(t) if t != "thinking" && t != "redacted_thinking")
}

fn mark_last_block(message: &mut Value) -> bool {
    let Some(blocks) = message.get_mut("content").and_then(Value::as_array_mut) else { return false };
    match blocks.iter_mut().rev().find(|b| cacheable(b)) {
        Some(b) => {
            b["cache_control"] = breakpoint();
            true
        }
        None => false,
    }
}

/// 在 Claude 请求体上放断点（就地修改）。
pub fn place_breakpoints(body: &mut Value) {
    if let Some(sys) = body.get_mut("system").and_then(Value::as_array_mut) {
        for b in sys.iter_mut() {
            if let Some(o) = b.as_object_mut() {
                o.remove("cache_control");
            }
        }
        if let Some(last) = sys.iter_mut().rev().find(|b| cacheable(b)) {
            last["cache_control"] = breakpoint();
        }
    }
    let Some(msgs) = body.get_mut("messages").and_then(Value::as_array_mut) else { return };
    for m in msgs.iter_mut() {
        if let Some(blocks) = m.get_mut("content").and_then(Value::as_array_mut) {
            for b in blocks.iter_mut() {
                if let Some(o) = b.as_object_mut() {
                    o.remove("cache_control");
                }
            }
        }
    }
    let users: Vec<usize> = msgs
        .iter()
        .enumerate()
        .filter(|(_, m)| m.get("role").and_then(Value::as_str) == Some("user"))
        .map(|(i, _)| i)
        .collect();
    for &i in users.iter().rev().take(2) {
        mark_last_block(&mut msgs[i]);
    }
}

/// 请求里实际放了几个断点（测试与诊断用）。
pub fn count_breakpoints(body: &Value) -> usize {
    body.to_string().matches("\"cache_control\"").count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(t: &str) -> Value {
        json!({"role": "user", "content": [{"type": "text", "text": t}]})
    }
    fn asst(t: &str) -> Value {
        json!({"role": "assistant", "content": [{"type": "text", "text": t}]})
    }

    #[test]
    fn system_and_last_two_user_turns_all_1h() {
        let mut body = json!({
            "system": [{"type": "text", "text": "billing"}, {"type": "text", "text": "角色卡"}],
            "messages": [user("1"), asst("a"), user("2"), asst("b"), user("3")]
        });
        place_breakpoints(&mut body);
        assert_eq!(count_breakpoints(&body), 3);
        assert_eq!(body["system"][1]["cache_control"]["ttl"], "1h");
        assert!(body["system"][0].get("cache_control").is_none());
        assert_eq!(body["messages"][4]["content"][0]["cache_control"]["ttl"], "1h");
        assert_eq!(body["messages"][2]["content"][0]["cache_control"]["ttl"], "1h");
        assert!(body["messages"][0]["content"][0].get("cache_control").is_none());
    }

    #[test]
    fn prefill_keeps_the_tail_on_the_user_turn() {
        let mut body = json!({"messages": [user("1"), asst("a"), user("2"), asst("续写开头")]});
        place_breakpoints(&mut body);
        assert!(body["messages"][3]["content"][0].get("cache_control").is_none());
        assert_eq!(body["messages"][2]["content"][0]["cache_control"]["ttl"], "1h");
    }

    #[test]
    fn downstream_breakpoints_are_replaced_and_limit_respected() {
        let mut body = json!({
            "system": [{"type": "text", "text": "s", "cache_control": {"type": "ephemeral"}}],
            "messages": [
                {"role": "user", "content": [{"type": "text", "text": "x", "cache_control": {"type": "ephemeral"}}]},
                asst("a"), user("y"), asst("b"), user("z")
            ]
        });
        place_breakpoints(&mut body);
        assert_eq!(count_breakpoints(&body), 3);
        let s = body.to_string();
        assert_eq!(s.matches("\"cache_control\"").count(), s.matches("\"ttl\":\"1h\"").count(), "每个断点都带 1h");
    }

    #[test]
    fn last_block_is_marked_even_after_an_image() {
        let mut body = json!({"messages": [{"role": "user", "content": [
            {"type": "text", "text": "看图"},
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "QUJD"}}
        ]}]});
        place_breakpoints(&mut body);
        assert_eq!(body["messages"][0]["content"][1]["cache_control"]["ttl"], "1h");
    }
}
