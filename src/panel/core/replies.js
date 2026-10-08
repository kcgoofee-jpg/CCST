// Which reply events are the ones to watch, and the flag that keeps our own re-emitted events out.

// 审: 不算「回复」的事件类型（开场白、斜杠命令发的消息）。
// Greetings (first_message) and /sendas-style messages (command) aren't replies to watch.
const REPLY_TYPES_SKIP = ['first_message', 'command'];
// 审: 是否真实回复事件，回复保管和事件分发共用。
export const isReplyEvent = (type) => !REPLY_TYPES_SKIP.includes(type);

// 审: 补回回复时正在向其他扩展重放事件的标志，我们自己的监听据此跳过，避免递归。
/** True while a recovered reply is being announced to other extensions: our own listeners skip it. */
export const recovery = { emitting: false };
