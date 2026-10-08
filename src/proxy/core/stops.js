// ──────────────────────────────────────────────
// Server-side stop-sequence enforcement
// ──────────────────────────────────────────────
//
// The Agent SDK has no stop-sequence option (Marinara silently drops the
// `stop` array — a real regression for roleplay, where "\n{{user}}:" stop
// strings are the standard guard against the model impersonating the user).
// We enforce them here by scanning the visible-text stream: hold back a tail
// window shorter than the longest stop string so matches spanning chunk
// boundaries are caught, truncate at the first match, and let the caller
// abort the SDK query.

// 审: 服务端停止序列扫描器（SDK 没有 stop 选项），没了「\n{{user}}:」之类的防抢话就失效。
export class StopScanner {
    // 审: 私有状态：有效停止串、需要扣住的尾部长度、已扣住的文本、是否已命中。
    #stops;
    #holdback;
    #buffer = '';
    #done = false;

    // 审: 过滤掉非字符串 / 空串，holdback = 最长停止串长度-1（跨 chunk 的匹配才抓得到）。
    /** @param {string[]} stops */
    constructor(stops) {
        this.#stops = (stops ?? []).filter((s) => typeof s === 'string' && s.length > 0);
        this.#holdback = this.#stops.length
            ? Math.max(...this.#stops.map((s) => s.length)) - 1
            : 0;
    }

    // 审: 有没有可用的停止串；没有时 feed 直通。
    get active() {
        return this.#stops.length > 0;
    }

    // 审: 喂入一段文本增量，返回可以放行的文本和是否命中。
    /**
     * Feed a text delta. Returns { emit, matched }:
     *  - emit: text safe to forward downstream now
     *  - matched: true when a stop sequence fired (emit contains the final
     *    text up to — excluding — the stop string; feed no more after this)
     */
    feed(text) {
        if (this.#done) return { emit: '', matched: true };
        if (!this.active) return { emit: text, matched: false };

        this.#buffer += text;

        let earliest = -1;
        for (const stop of this.#stops) {
            const idx = this.#buffer.indexOf(stop);
            if (idx !== -1 && (earliest === -1 || idx < earliest)) earliest = idx;
        }

        if (earliest !== -1) {
            this.#done = true;
            const emit = this.#buffer.slice(0, earliest);
            this.#buffer = '';
            return { emit, matched: true };
        }

        if (this.#buffer.length > this.#holdback) {
            const emit = this.#buffer.slice(0, this.#buffer.length - this.#holdback);
            this.#buffer = this.#buffer.slice(this.#buffer.length - this.#holdback);
            return { emit, matched: false };
        }

        return { emit: '', matched: false };
    }

    // 审: 流结束且没命中时，把扣住的尾部放出去。
    /** Flush the held-back tail at end of stream (no stop ever matched). */
    flush() {
        if (this.#done) return '';
        const rest = this.#buffer;
        this.#buffer = '';
        return rest;
    }
}
