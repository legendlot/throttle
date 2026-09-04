import test from 'node:test';
import assert from 'node:assert/strict';
import { bucketVideoViewsByMonth } from '../src/index.js';

const deals = [
  { id: 'A', post_date: '2026-09-28', views: 1250 },
  { id: 'B', post_date: '2026-09-10', views: 400 },
  { id: 'C', post_date: null, views: 0 },
];
const videos = [
  { engagement_id: 'A', seq: 1, post_date: '2026-09-28', views: 1000 },
  { engagement_id: 'A', seq: 2, post_date: '2026-10-03', views: 250 },
  // B has no video rows (a deal created before slice 1 could, in theory) → falls back to the deal
];

test('a second take posted next month lands in NEXT month, not the deal post_date month', () => {
  const { byMonth } = bucketVideoViewsByMonth(deals, videos);
  assert.equal(byMonth['2026-09'], 1000 + 400);
  assert.equal(byMonth['2026-10'], 250);
});

test('tile equals the sum of its drill-down rows, for every month', () => {
  const { byMonth, rows } = bucketVideoViewsByMonth(deals, videos);
  for (const m of Object.keys(byMonth)) {
    assert.equal(byMonth[m], rows.filter(r => r.month === m).reduce((t, r) => t + r.views, 0));
  }
});

test('a take with no post_date or zero views contributes no row', () => {
  const { rows } = bucketVideoViewsByMonth([{ id: 'D', post_date: '2026-09-01', views: 5 }],
    [{ engagement_id: 'D', seq: 1, post_date: null, views: 5 }, { engagement_id: 'D', seq: 2, post_date: '2026-09-02', views: 0 }]);
  assert.deepEqual(rows, []);
});

test('the fallback row is marked seq null and uses the deal date', () => {
  const { rows } = bucketVideoViewsByMonth(deals, videos);
  const b = rows.find(r => r.engagement_id === 'B');
  assert.deepEqual(b, { engagement_id: 'B', seq: null, post_date: '2026-09-10', month: '2026-09', views: 400 });
});
