import test from 'node:test';
import assert from 'node:assert/strict';
import { reportAttribution, bucketVideoViewsByMonth, cpmStats, cpmCostOf } from '../src/index.js';

const deals = [
  { id: 'old', created_at: '2026-08-20T10:00:00Z', post_date: '2026-10-05', views: 1000 },   // made before, posted in range
  { id: 'new', created_at: '2026-10-10T10:00:00Z', post_date: null, views: null },            // made in range, not posted
  { id: 'two', created_at: '2026-08-01T10:00:00Z', post_date: '2026-09-20', views: 500 },     // deal posted before, 2nd video in range
];
const videos = [
  { engagement_id: 'old', seq: 1, post_date: '2026-10-05', views: 1000, paid_views: 100 },
  { engagement_id: 'two', seq: 1, post_date: '2026-09-20', views: 300, paid_views: 0 },
  { engagement_id: 'two', seq: 2, post_date: '2026-10-02', views: 200, paid_views: 0 },
];

test('deals created go by created date, posted deals by post date', () => {
  const a = reportAttribution(deals, videos, '2026-10-01', '2026-10-31');
  assert.deepEqual(a.created.map(e => e.id), ['new']);
  assert.deepEqual(a.posted.map(e => e.id), ['old']);
});
test('views go by each video\'s own post date', () => {
  const a = reportAttribution(deals, videos, '2026-10-01', '2026-10-31');
  assert.equal(a.views.old, 900);
  assert.equal(a.paid.old, 100);
  assert.equal(a.views.two, 200);
  assert.equal(a.views.new, undefined);
});
test('a month reads the same as Targets, which buckets the same videos', () => {
  const a = reportAttribution(deals, videos, null, null);
  assert.deepEqual(a.viewsByMonth, bucketVideoViewsByMonth(deals, videos).byMonth);
});
test('a created_at in the first hours of the 1st IST counts on that IST day', () => {
  const a = reportAttribution([{ id: 'x', created_at: '2026-09-30T19:00:00Z' }], [], '2026-10-01', '2026-10-01');
  assert.equal(a.created.length, 1);
});

test('blended is total cost over total views, median is the middle deal', () => {
  const s = cpmStats([{ cost: 100, views: 1000 }, { cost: 900, views: 1000 }, { cost: 2000, views: 1000 }, { cost: 500, views: 0 }]);
  assert.equal(s.blended, 1000);
  assert.equal(s.median, 900);
  assert.equal(s.deals, 3);
});
test('even count takes the midpoint, and no views reads as none rather than zero', () => {
  assert.equal(cpmStats([{ cost: 100, views: 1000 }, { cost: 200, views: 1000 }]).median, 150);
  assert.deepEqual(cpmStats([{ cost: 5, views: 0 }]), { blended: null, median: null, deals: 0 });
  assert.deepEqual(cpmStats(null), { blended: null, median: null, deals: 0 });
});
test('commission stays out of the CPM cost', () => {
  assert.equal(cpmCostOf({ total_cost: 1000, commission_amount: 300 }), 700);
  assert.equal(cpmCostOf({ total_cost: null, payment_amount: 400, commission_amount: 300 }), 400);
  assert.equal(cpmCostOf({ total_cost: '1000', commission_amount: null }), 1000);
});

test('total views per deal are kept whatever the range, so a split deal can be charged its share', () => {
  const a = reportAttribution(deals, videos, '2026-10-01', '2026-10-31');
  assert.equal(a.allViews.two, 500);
  assert.equal(a.views.two, 200);
});
