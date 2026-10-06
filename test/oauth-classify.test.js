import test from 'node:test';
import assert from 'node:assert/strict';

import { isExpiredTokenError, isRateLimitError } from '../src/proxy/features/oauth.js';

test('the retry ladder recognizes the new CLI auth wording', () => {
    assert.equal(isExpiredTokenError('OAuth access token has expired'), true);
    assert.equal(isExpiredTokenError('OAuth token has expired'), true, 'the older spelling still works');
    assert.equal(isExpiredTokenError('Not logged in · Please run /login'), true);
    assert.equal(isExpiredTokenError('HTTP 401 Unauthorized'), true);
});

test('digits inside a longer number are not an HTTP status', () => {
    assert.equal(isRateLimitError('processed 242900 tokens in this chat'), false);
    assert.equal(isRateLimitError('upstream error: 429 Too Many Requests'), true);
    assert.equal(isExpiredTokenError('request (4012) failed validation'), false);
    assert.equal(isExpiredTokenError('invalid grant for 44012 users'), false);
});
