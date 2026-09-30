// Which reply events are the ones to watch, and the flag that keeps our own re-emitted events out.

// Greetings (first_message) and /sendas-style messages (command) aren't replies to watch.
const REPLY_TYPES_SKIP = ['first_message', 'command'];
export const isReplyEvent = (type) => !REPLY_TYPES_SKIP.includes(type);

/** True while a recovered reply is being announced to other extensions: our own listeners skip it. */
export const recovery = { emitting: false };
