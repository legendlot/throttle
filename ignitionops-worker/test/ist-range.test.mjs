import test from 'node:test';
import assert from 'node:assert/strict';
import { istDayRangeFilters } from '../src/index.js';

test('whole IST days: from at 00:00 IST, to exclusive at the next IST midnight', () => {
  const { filters } = istDayRangeFilters('created_at', '2026-10-01', '2026-10-09');
  assert.deepEqual(filters.map(decodeURIComponent), [
    'created_at=gte.2026-10-01T00:00:00+05:30',
    'created_at=lt.2026-10-10T00:00:00+05:30',
  ]);
});

test('the Reports page form (date + naive time) keeps only the date', () => {
  const { filters } = istDayRangeFilters('created_at', '2026-01-01T00:00:00', '2026-12-31T23:59:59');
  assert.deepEqual(filters.map(decodeURIComponent), [
    'created_at=gte.2026-01-01T00:00:00+05:30',
    'created_at=lt.2027-01-01T00:00:00+05:30',
  ]);
});

test('+ is encoded so PostgREST does not read it as a space', () => {
  const { filters } = istDayRangeFilters('created_at', '2026-10-01', null);
  assert.equal(filters.length, 1);
  assert.ok(filters[0].includes('%2B05%3A30'));
});

test('a bad date is refused, not passed through', () => {
  assert.ok(istDayRangeFilters('created_at', '2026-02-30', null).error);
  assert.ok(istDayRangeFilters('created_at', null, 'x),or(true').error);
});
