import test from 'node:test';
import assert from 'node:assert/strict';
import { isExtraUsageRequiredError } from '../src/proxy/features/oauth.js';

test('both wordings of "1M needs extra usage" are recognized', () => {
    assert.equal(isExtraUsageRequiredError('Extra usage is required for 1M context'), true);
    assert.equal(isExtraUsageRequiredError('You are out of extra usage'), true);
    // 真机实测的新版 CLI 原文
    assert.equal(isExtraUsageRequiredError('API Error: Usage credits required for 1M context · turn on usage credits at claude.ai/settings/usage?from=cc_cli_limit_message (they take effect in a new session), or use --model to switch to standard context'), true);
});

test('unrelated errors are not mistaken for it', () => {
    assert.equal(isExtraUsageRequiredError('429 rate limit'), false);
    assert.equal(isExtraUsageRequiredError('Usage credits required'), false);
    assert.equal(isExtraUsageRequiredError(undefined), false);
});
