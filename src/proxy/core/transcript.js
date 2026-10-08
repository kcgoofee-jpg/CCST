// ──────────────────────────────────────────────
// OpenAI Chat Completion messages → Claude Agent SDK prompt
// ──────────────────────────────────────────────
//
// The Agent SDK accepts a single-string `prompt` plus an optional
// `systemPrompt`. We extract system messages so they go through the
// dedicated systemPrompt option (preserving system/user separation) and
// fold the rest of the conversation into a labelled transcript so the
// model sees prior turns even though the SDK is one-shot per call.
//
// Mirrors `renderTranscript()` in Marinara's claude-subscription.provider.ts.

import { contentToText } from './system-prompt.js';

// 审: 回退路径（逐轮还原失败 / 关闭时）把整段对话折成带标签的字符串提示词；chat.js 的 fold 分支用，没了回退就没有兜底。
export function renderTranscript(messages) {
    const turns = [];

    for (const message of messages) {
        const text = contentToText(message?.content).trim();
        if (!text) continue;
        // 审: system 消息已由 chat.js 走 systemPrompt 选项，这里不折进对话。
        if (message.role === 'system') continue;
        const label = message.role === 'user' ? 'User' : 'Assistant';
        turns.push(`${label}: ${text}`);
    }

    // The SDK rejects empty prompts; if the caller only supplied system
    // content (rare connection-test pings), inject a minimal user turn.
    if (turns.length === 0) turns.push('User: [Start]');

    return turns.join('\n\n');
}
