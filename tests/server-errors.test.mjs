import test from 'node:test';
import assert from 'node:assert/strict';
import { isRateLimit } from '../src/server-errors.js';

test('rate-limit detection ignores incidental 429 digits and recognizes explicit errors', () => {
  for (const message of ['line 1429', 'C:/429/data', 'price 429.00']) assert.equal(isRateLimit(new Error(message)), false, message);
  for (const message of ['HTTP 429', 'HTTP Error 429', 'status code: 429', 'Too Many Requests', 'rate limit']) assert.equal(isRateLimit(new Error(message)), true, message);
  assert.equal(isRateLimit(Object.assign(new Error('Yahoo error'), { code: 'rate_limited' })), true);
});
