// node --test src/lib/*.test.mjs  (npm test) — the checklist's "This week" preview: the
// client mirror of the worker's isDueOn / isExpired, and the rest-of-week date range.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDueOn, isExpired, restOfWeek } from './recurrence.js';

test('restOfWeek: the days after the date, through Sunday (Mon-start week)', () => {
  assert.deepEqual(restOfWeek('2026-11-09'), ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15']); // Mon
  assert.deepEqual(restOfWeek('2026-11-14'), ['2026-11-15']);                                                                     // Sat
  assert.deepEqual(restOfWeek('2026-11-15'), []);                                                                                 // Sun
  assert.deepEqual(restOfWeek('2026-12-30'), ['2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);                           // year roll
});

test('isDueOn mirrors the worker: daily, weekly by weekday, monthly with short-month clamp', () => {
  assert.equal(isDueOn({ freq: 'daily' }, '2026-11-10'), true);
  assert.equal(isDueOn({ freq: 'weekly', days_of_week: [3] }, '2026-11-11'), true);     // Wed
  assert.equal(isDueOn({ freq: 'weekly', days_of_week: ['3'] }, '2026-11-12'), false);  // Thu; string days too
  assert.equal(isDueOn({ freq: 'monthly', day_of_month: 31 }, '2026-11-30'), true);     // clamps to the 30th
  assert.equal(isDueOn({ freq: 'monthly', day_of_month: 15 }, '2026-11-14'), false);
  assert.equal(isDueOn(null, '2026-11-10'), false);
});

test('isExpired: only once the date is past `until`', () => {
  assert.equal(isExpired({ freq: 'daily', until: '2026-11-12' }, '2026-11-12'), false);
  assert.equal(isExpired({ freq: 'daily', until: '2026-11-12' }, '2026-11-13'), true);
  assert.equal(isExpired({ freq: 'daily' }, '2030-01-01'), false);
});
