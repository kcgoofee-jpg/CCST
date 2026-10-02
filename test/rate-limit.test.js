import test from 'node:test';
import assert from 'node:assert/strict';
import { recordRateLimit, rateLimitSnapshot, resetRateLimit } from '../src/proxy/features/rate-limit.js';

test('keeps the latest info per window and ignores junk', () => {
    resetRateLimit();
    recordRateLimit(null);
    recordRateLimit({ foo: 1 });
    recordRateLimit({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: 100 }, 1);
    recordRateLimit({ status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: 100, utilization: 0.9 }, 2);
    recordRateLimit({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: 200 }, 3);
    assert.deepEqual(rateLimitSnapshot(), {
        five_hour: { status: 'allowed_warning', resetsAt: 100, utilization: 0.9, seenAt: 2 },
        seven_day: { status: 'rejected', resetsAt: 200, utilization: null, seenAt: 3 },
    });
});
