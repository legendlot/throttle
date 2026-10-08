import test from 'node:test';
import assert from 'node:assert/strict';
import { istToday, istMonth } from '../src/lib/istDate.js';

// B3 (S412): the UTC month made 00:00–05:29 IST on the 1st show last month's target.
test('istMonth: 00:30 IST on 1 Nov is November (UTC still says October)', () => {
  const t = Date.parse('2026-10-31T19:00:00Z');           // 00:30 IST, 1 Nov
  assert.equal(new Date(t).toISOString().slice(0, 7), '2026-10');
  assert.equal(istMonth(t), '2026-11');
  assert.equal(istToday(t), '2026-11-01');
});

test('istMonth: 23:59 IST on 31 Oct is still October', () => {
  assert.equal(istMonth(Date.parse('2026-10-31T18:29:00Z')), '2026-10');
});

test('istToday: 05:30 IST onwards matches the UTC date', () => {
  assert.equal(istToday(Date.parse('2026-10-08T00:00:00Z')), '2026-10-08');
});
