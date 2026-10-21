import { test } from 'node:test';
import assert from 'node:assert/strict';
import { axis, bucketLabel, colourway, daysCover, OTHER, perHour, pivot, usual } from '../src/lib/production.mjs';

test('day axis: every calendar day of the range, worked or not', () => {
  assert.deepEqual(axis({ grain: 'day', from: '2026-10-29', to: '2026-11-02' }, []),
    ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
});

test('hour axis: first pack hour to last, contiguous, across midnight', () => {
  assert.deepEqual(axis({ grain: 'hour' }, ['2026-10-21T09:00', '2026-10-21T07:00', '2026-10-21T09:00']),
    ['2026-10-21T07:00', '2026-10-21T08:00', '2026-10-21T09:00']);
  assert.deepEqual(axis({ grain: 'hour' }, ['2026-10-20T23:00', '2026-10-21T01:00']),
    ['2026-10-20T23:00', '2026-10-21T00:00', '2026-10-21T01:00']);
  assert.deepEqual(axis({ grain: 'hour' }, []), []);
});

test('labels are IST wall clock text, never the browser zone', () => {
  assert.equal(bucketLabel('2026-10-21T07:00', 'hour', false), '07:00');
  assert.equal(bucketLabel('2026-10-21T07:00', 'hour', true), '21 Oct 07:00');
  assert.equal(bucketLabel('2026-01-05', 'day'), '5 Jan');
});

test('pivot: one row per bucket, keys biggest first, unknown buckets ignored', () => {
  const p = pivot([{ t: 'a', product: 'Shadow', model: 'Asphalt', color: 'Black', packs: 3 },
    { t: 'b', product: 'Gator', color: 'Green', packs: 5 }, { t: 'zz', product: 'Gator', packs: 9 }], ['a', 'b'], colourway);
  assert.deepEqual(p.keys, ['Gator · Green', 'Shadow · Asphalt · Black']);
  assert.deepEqual(p.rows.map(r => [r.t, r.total, Object.fromEntries(r.v)]),
    [['a', 3, { 'Shadow · Asphalt · Black': 3 }], ['b', 5, { 'Gator · Green': 5 }]]);
});

test('pivot: names like "total" or "Other" cannot collide; the overflow folds into OTHER', () => {
  const s = [['total', 10], ['Other', 1], ['a', 8], ['b', 7]].map(([n, packs]) => ({ t: 'x', n, packs }));
  const p = pivot(s, ['x'], r => r.n, 3);
  assert.equal(p.rows[0].total, 26);
  assert.deepEqual(p.keys, ['total', 'a', OTHER]);
  assert.deepEqual(Object.fromEntries(p.rows[0].v), { total: 10, a: 8, [OTHER]: 8 });
});

test('rates and cover are null with nothing to divide by', () => {
  assert.equal(perHour(60, 30), 120);
  assert.equal(perHour(60, 0), null);
  assert.equal(daysCover(100, 0), null);
  assert.equal(daysCover(100, 40), 2.5);
});

test('the usual day: hourly baseline summed; for today, the hours over plus the elapsed share of this one', () => {
  const b = { kind: 'hour', days: 2, by_hour: [{ h: 9, avg: 10 }, { h: 10, avg: 20 }, { h: 14, avg: 5 }] };
  assert.deepEqual(usual(b, { isToday: true, nowHour: 10, nowMin: 15 }), { perDay: 35, byNow: 15, days: 2 });
  assert.deepEqual(usual(b, { isToday: true, nowHour: 10, nowMin: 0 }), { perDay: 35, byNow: 10, days: 2 });
  assert.equal(usual({ kind: 'hour', days: 0, by_hour: [] }), null);
});

test('the usual day (day grain) is the first day of the range only, and nothing for all time', () => {
  assert.deepEqual(usual({ kind: 'day', by_day: [{ d: 'x', avg7: 12 }, { d: 'y', avg7: 16.5 }] }), { perDay: 12, byNow: null, days: null });
  assert.equal(usual({ kind: 'day', by_day: [{ d: 'x', avg7: null }, { d: 'y', avg7: 16.5 }] }), null);
  assert.equal(usual({ kind: 'day', by_day: [{ d: 'x', avg7: 12 }] }, { allTime: true }), null);
});
