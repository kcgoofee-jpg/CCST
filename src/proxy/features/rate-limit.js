// ──────────────────────────────────────────────
// Subscription rate-limit status from the SDK's `rate_limit_event`
// ──────────────────────────────────────────────
//
// The CLI reports the account's limit state while a reply streams. Keeping the
// latest event per window gives the quota bar fresh numbers after every reply
// without calling /api/oauth/usage (which answers 429 when polled too often).

const latest = new Map();

/** Remember one event's `rate_limit_info`; anything without a status is ignored. */
export function recordRateLimit(info, now = Date.now()) {
    if (!info || typeof info.status !== 'string') return;
    const key = info.rateLimitType ?? 'unknown';
    latest.set(key, {
        status: info.status,
        resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : null,
        utilization: typeof info.utilization === 'number' ? info.utilization : null,
        seenAt: now,
    });
}

/** Latest info per window, e.g. { five_hour: {...}, seven_day: {...} }. */
export function rateLimitSnapshot() {
    return Object.fromEntries(latest);
}

export function resetRateLimit() {
    latest.clear();
}
