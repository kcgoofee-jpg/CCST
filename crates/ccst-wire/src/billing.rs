//! Claude Code 计费头（`system[0]`）。
//!
//! 订阅通道对"不像 Claude Code 的请求"直接回 `429 rate_limit_error`（message 只有
//! `Error`），与额度无关——P0 曾把它误读成"认证通过、周额度耗尽"。CLI 的每个请求
//! 都以这一块开头：
//!
//! `x-anthropic-billing-header: cc_version=<版本>.<后缀>; cc_entrypoint=<入口>;`
//!
//! 后缀 = sha256(盐 + 首条用户消息首个文本块的第 4/7/20 个 UTF-16 码元 + 版本号)
//! 的前 3 个十六进制字符（CLI 2.1.285 源码 `aS()`；clewdr `claude_code_billing_header`
//! 同式）。缺位补 `'0'`。实测它不参与提示词缓存的前缀比对：后缀在两轮间变化时缓存照样命中。

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const BILLING_SALT: &str = "59cf53e54c78";
pub const BILLING_PREFIX: &str = "x-anthropic-billing-header:";

/// 首条 user 消息的首个文本（字符串内容或第一个 text 块）。
fn first_user_text(body: &Value) -> &str {
    let Some(msgs) = body.get("messages").and_then(Value::as_array) else { return "" };
    let Some(first) = msgs.iter().find(|m| m.get("role").and_then(Value::as_str) == Some("user")) else { return "" };
    match first.get("content") {
        Some(Value::String(s)) => s,
        Some(Value::Array(blocks)) => blocks
            .iter()
            .find(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .and_then(|b| b.get("text").and_then(Value::as_str))
            .unwrap_or(""),
        _ => "",
    }
}

/// 计费头文本。
pub fn billing_header(first_user: &str, version: &str, entrypoint: &str) -> String {
    let units: Vec<u16> = first_user.encode_utf16().collect();
    let sampled: Vec<u16> = [4usize, 7, 20].iter().map(|&i| units.get(i).copied().unwrap_or(u16::from(b'0'))).collect();
    let sampled = String::from_utf16_lossy(&sampled);
    let digest = Sha256::digest(format!("{BILLING_SALT}{sampled}{version}").as_bytes());
    let suffix: String = digest.iter().take(2).map(|b| format!("{b:02x}")).collect::<String>()[..3].to_string();
    format!("{BILLING_PREFIX} cc_version={version}.{suffix}; cc_entrypoint={entrypoint};")
}

/// 把计费头放到 `system[0]`（已有则替换）；字符串 system 先转成块数组。
pub fn stamp(body: &mut Value, version: &str, entrypoint: &str) {
    let header = json!({ "type": "text", "text": billing_header(first_user_text(body), version, entrypoint) });
    let mut blocks = match body.get_mut("system").map(Value::take) {
        Some(Value::Array(a)) => a,
        Some(Value::String(s)) if !s.is_empty() => vec![json!({ "type": "text", "text": s })],
        _ => vec![],
    };
    blocks.retain(|b| !b.get("text").and_then(Value::as_str).is_some_and(|t| t.starts_with(BILLING_PREFIX)));
    blocks.insert(0, header);
    body["system"] = Value::Array(blocks);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn suffix(h: &str) -> &str {
        h.split("cc_version=2.1.258.").nth(1).unwrap().split(';').next().unwrap()
    }

    #[test]
    fn matches_clewdr_test_vectors() {
        // clewdr src/middleware/claude/request.rs 的三条向量（同一公式）
        assert_eq!(suffix(&billing_header("hey", "2.1.258", "cli")), "1e2");
        assert_eq!(suffix(&billing_header("aaaa😀😀abcdefghijklmnop", "2.1.258", "cli")), "fde", "按 UTF-16 码元采样，代理对拼回后再编码");
        assert_eq!(suffix(&billing_header("abcdefg", "2.1.258", "cli")), "de6");
    }

    #[test]
    fn first_text_block_of_first_user_message() {
        let body = json!({"messages": [
            {"role": "assistant", "content": "开场白"},
            {"role": "user", "content": [{"type": "image", "source": {}}, {"type": "text", "text": "abcdefg"}, {"type": "text", "text": "ignored"}]},
            {"role": "user", "content": "later"}
        ]});
        assert_eq!(first_user_text(&body), "abcdefg");
    }

    #[test]
    fn stamp_puts_header_first_and_replaces_old_one() {
        let mut body = json!({
            "system": [{"type": "text", "text": "x-anthropic-billing-header: old"}, {"type": "text", "text": "角色卡"}],
            "messages": [{"role": "assistant", "content": "开场白"}, {"role": "user", "content": [{"type": "text", "text": "abcdefghijklmnopqrstuvwxyz"}]}]
        });
        stamp(&mut body, "2.1.285", "cli");
        let sys = body["system"].as_array().unwrap();
        assert_eq!(sys.len(), 2);
        assert_eq!(sys[0]["text"], billing_header("abcdefghijklmnopqrstuvwxyz", "2.1.285", "cli"));
        assert_eq!(sys[1]["text"], "角色卡");
    }

    #[test]
    fn stamp_handles_missing_and_string_system() {
        let mut body = json!({"messages": [{"role": "user", "content": "hi"}]});
        stamp(&mut body, "2.1.285", "cli");
        assert_eq!(body["system"].as_array().unwrap().len(), 1);
        let mut body = json!({"system": "规则", "messages": [{"role": "user", "content": "hi"}]});
        stamp(&mut body, "2.1.285", "cli");
        assert_eq!(body["system"][1]["text"], "规则");
    }
}
