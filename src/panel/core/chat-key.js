// A short hash of the open chat (its file name): the reply keeper files replies under it, and the proxy
// records it in the usage log so 状态 can show THIS chat's last turn. No text, no names in the clear.

// 审: 64 位 FNV 哈希（两个 32 位拼接）：把聊天名/回复槽位变成不含明文的短键，回复保管和用量记录都靠它。
export function fnv64(str) {
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
        h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

// 审: 当前聊天的键（给代理按聊天归档用量）；没开聊天返回 null。
/** The open chat's key, or null when no chat is open. */
export function chatKeyOf(ctx) {
    const id = ctx?.chatId;
    return id ? fnv64(`chat\u0000${id}`) : null;
}
