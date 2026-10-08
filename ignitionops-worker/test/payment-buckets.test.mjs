import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentBuckets } from '../src/index.js';

// B3 (S412): the Payments today/week/month bounds were UTC.
test('paymentBuckets: 00:30 IST Monday 2 Nov 2026 is today 2 Nov, week from 2 Nov, month Nov', () => {
  const t = Date.parse('2026-11-01T19:00:00Z');              // Mon 2 Nov, 00:30 IST (UTC: Sun 1 Nov)
  assert.deepEqual(paymentBuckets(t), { todayStr: '2026-11-02', weekStart: '2026-11-02', monthStart: '2026-11-01' });
});

test('paymentBuckets: 00:30 IST on the 1st reads the new month', () => {
  const t = Date.parse('2026-09-30T19:00:00Z');              // Thu 1 Oct, 00:30 IST
  const b = paymentBuckets(t);
  assert.equal(b.todayStr, '2026-10-01');
  assert.equal(b.monthStart, '2026-10-01');
  assert.equal(b.weekStart, '2026-09-28');                     // Monday
});

test('paymentBuckets: a Sunday counts back to its Monday', () => {
  assert.equal(paymentBuckets(Date.parse('2026-10-11T12:00:00Z')).weekStart, '2026-10-05');
});
