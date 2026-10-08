// When the panel may ask the proxy for the quota, and what the quota line shows when it does not.
// Pure: core/live.js passes its clock and flags in.

// 审: 额度请求最小间隔 60 秒；测试引用。
export const QUOTA_MIN_GAP_MS = 60000;

// 审: 纯函数：现在能不能问额度、不问时屏幕上该显示什么（已有数字保留，否则回到「点刷新」），避免占位符卡住。
/**
 * @param {{ now: number, phase: string, force?: boolean, inFlight?: boolean,
 *           askedAt?: number, notBefore?: number, gapMs?: number }} s
 * @returns {{ ask: boolean, phase?: string }} `phase` is the state to put on screen when NOT asking:
 *   the numbers already shown stay ('ok'); anything else falls back to 'idle' (「点刷新查看额度」), so a
 *   placeholder like 「正在读取…」 can never be left hanging by an early return.
 */
export function quotaGate({ now, phase, force = false, inFlight = false, askedAt = 0, notBefore = 0, gapMs = QUOTA_MIN_GAP_MS }) {
    if (inFlight) return { ask: false };
    const keep = phase === 'ok' ? 'ok' : 'idle';
    if (now < notBefore) return { ask: false, phase: keep };
    if (!force && askedAt && now - askedAt < gapMs) return { ask: false, phase: keep };
    return { ask: true };
}
