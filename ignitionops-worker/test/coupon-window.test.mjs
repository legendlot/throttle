import test from 'node:test';
import assert from 'node:assert/strict';
import { couponInWindow } from '../src/index.js';

test('an order at 01:00 IST on the 10th (19:30Z on the 9th) is on the 10th', () => {
  assert.equal(couponInWindow('2026-10-09T19:30:00Z', '2026-10-10', null), true);
  assert.equal(couponInWindow('2026-10-09T19:30:00Z', '2026-10-01', '2026-10-10'), false); // to is exclusive
});

test('window edges and junk', () => {
  assert.equal(couponInWindow('2026-10-05T10:00:00Z', null, null), false);
  assert.equal(couponInWindow('2026-10-05T10:00:00Z', '2026-10-05', '2026-10-06'), true);
  assert.equal(couponInWindow('not a date', '2026-10-01', null), false);
});
