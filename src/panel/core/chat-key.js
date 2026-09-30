// A short hash of the open chat (its file name): the reply keeper files replies under it, and the proxy
// records it in the usage log so 状态 can show THIS chat's last turn. No text, no names in the clear.

export function fnv64(str) {
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
        h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** The open chat's key, or null when no chat is open. */
export function chatKeyOf(ctx) {
    const id = ctx?.chatId;
    return id ? fnv64(`chat\u0000${id}`) : null;
}
