import test from 'node:test';
import assert from 'node:assert/strict';
import { metricsCompleteness } from '../src/lib/metrics.js';

// ⭐ Afshaan, 2026-09-10 (S369): a DECLARED metric_gaps reason satisfies a completeness check.
// Before this, `complete` was true on 0 of 497 deals ever, because it demanded a
// `followers_gained` number that has never once been entered.
const live = (over = {}) => ({
  stage: 'live', views: 1000, likes: 50, followers_gained: 7, total_cost: 250, ...over,
});

test('a fully measured live deal is complete, with nothing explained away', () => {
  const r = metricsCompleteness(live());
  assert.equal(r.complete, true);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.viaGaps, []);
});

test('the pre-fix reality: no followers_gained and no gap is still INCOMPLETE', () => {
  const r = metricsCompleteness(live({ followers_gained: null }));
  assert.equal(r.complete, false);
  assert.deepEqual(r.missing, ['Followers gained']);
});

test('a declared reason completes the deal and is reported as explained, not measured', () => {
  const r = metricsCompleteness(live({ followers_gained: null, metric_gaps: { followers_gained: 'gated_data' } }));
  assert.equal(r.complete, true);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.viaGaps, ['Followers gained'], 'must not masquerade as a measured value');
});

test('every gap-bearing check can be satisfied by a reason; all three at once still completes', () => {
  const r = metricsCompleteness({
    stage: 'live', views: null, likes: null, followers_gained: null, total_cost: 250,
    metric_gaps: { views: 'internal_gap', likes: 'system_timing', followers_gained: 'gated_data' },
  });
  assert.equal(r.complete, true);
  assert.deepEqual(r.viaGaps, ['Views', 'Likes', 'Followers gained']);
});

test('COST IS NOT GAP-SATISFIABLE — it is money, not a platform metric', () => {
  const r = metricsCompleteness(live({ total_cost: 0, metric_gaps: { total_cost: 'internal_gap', cost: 'internal_gap' } }));
  assert.equal(r.complete, false, 'a cost gap must never complete a deal');
  assert.deepEqual(r.missing, ['Cost']);
  assert.deepEqual(r.viaGaps, []);
});

test('an empty or whitespace reason is NOT a reason', () => {
  for (const bad of ['', '   ', null, undefined, false, 0]) {
    const r = metricsCompleteness(live({ followers_gained: null, metric_gaps: { followers_gained: bad } }));
    assert.equal(r.complete, false, `reason ${JSON.stringify(bad)} must not count`);
    assert.deepEqual(r.missing, ['Followers gained']);
  }
});

// metric_gaps is jsonb: it can arrive as an array, a string or a scalar. A string is the nasty one
// — `'gated_data'['views']` is undefined but `'abc'[0]` is a character, so an index-shaped key
// could read as a reason if this were not guarded.
test('a non-object metric_gaps is ignored, never indexed', () => {
  for (const bad of [['followers_gained'], 'followers_gained', 42, true]) {
    const r = metricsCompleteness(live({ followers_gained: null, metric_gaps: bad }));
    assert.equal(r.complete, false, `metric_gaps ${JSON.stringify(bad)} must not count`);
  }
  assert.doesNotThrow(() => metricsCompleteness({ stage: 'live', metric_gaps: null }));
});

test('a gap never makes a NON-LIVE deal complete', () => {
  const r = metricsCompleteness(live({ stage: 'shipped', followers_gained: null, metric_gaps: { followers_gained: 'gated_data' } }));
  assert.equal(r.live, false);
  assert.equal(r.complete, false);
  assert.deepEqual(r.missing, []);
});

test('a real value wins over a stale reason — no double-counting into viaGaps', () => {
  const r = metricsCompleteness(live({ followers_gained: 12, metric_gaps: { followers_gained: 'gated_data' } }));
  assert.equal(r.complete, true);
  assert.deepEqual(r.viaGaps, [], 'a measured number is measured, gap row or not');
});

test('views uses > 0 and likes uses != null — a real zero differs between them', () => {
  assert.deepEqual(metricsCompleteness(live({ views: 0 })).missing, ['Views']);
  assert.equal(metricsCompleteness(live({ likes: 0 })).complete, true, 'zero likes is a real answer');
});
