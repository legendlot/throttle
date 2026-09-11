import test from 'node:test';
import assert from 'node:assert/strict';
import { organicViews, deriveMetrics, metricsCompleteness } from '../src/lib/metrics.js';
import { organicViews as workerOrganic } from '../../../ignitionops-worker/src/index.js';

// S373 — collab performance is judged on ORGANIC views (views − paid); completeness is not.

test('organicViews: views − paid, null when views unknown, never below 0', () => {
  assert.equal(organicViews(1000, 300), 700);
  assert.equal(organicViews(1000, null), 1000);
  assert.equal(organicViews('1000', ' 250 '), 750);
  assert.equal(organicViews(null, 50), null);
  assert.equal(organicViews('  ', 50), null);
  assert.equal(organicViews(100, 400), 0);
});

test('organicViews: the app and the worker copies agree', () => {
  for (const [v, p] of [[1000, 300], [1000, null], ['1000', '250'], [null, 50], [100, 400], [0, 0], ['', 5]]) {
    assert.equal(organicViews(v, p), workerOrganic(v, p), `${v} / ${p}`);
  }
});

test('views/followers, CPM and revenue per view divide by ORGANIC views', () => {
  const e = { views: 10000, paid_views: 6000, follower_count_at_post: 2000, total_cost: 2000, conversions_value: 800 };
  const d = deriveMetrics(e, 'instagram');
  assert.equal(d.ratios.find(r => r.key === 'views_to_followers').value, 2);    // 4000 / 2000
  assert.equal(d.business.find(b => b.key === 'cpm').value, 500);                // 2000 / 4000 × 1000
  assert.equal(d.business.find(b => b.key === 'revenue_per_view').value, 0.2);   // 800 / 4000
});

test('no paid views → unchanged from total-views maths', () => {
  const d = deriveMetrics({ views: 4000, follower_count_at_post: 2000, total_cost: 2000 }, 'instagram');
  assert.equal(d.business.find(b => b.key === 'cpm').value, 500);
});

test('an all-paid take has no organic CPM (null, not Infinity)', () => {
  const d = deriveMetrics({ views: 500, paid_views: 500, follower_count_at_post: 100, total_cost: 1000 }, 'instagram');
  assert.equal(d.business.find(b => b.key === 'cpm').value, null);
});

test('completeness keeps reading TOTAL views — paid views do not un-complete a deal', () => {
  const r = metricsCompleteness({ stage: 'live', views: 500, paid_views: 500, likes: 1, followers_gained: 0, total_cost: 10 });
  assert.equal(r.complete, true);
});
