import test from 'node:test';
import assert from 'node:assert/strict';
import { kpiPipeline } from '../src/index.js';

// Same formula getKpis passes in (total_cost, else payment + commission; numerics arrive as strings).
const num = v => (v == null || isNaN(Number(v)) ? 0 : Number(v));
const spendOf = e => (e.total_cost != null ? num(e.total_cost) : num(e.payment_amount) + num(e.commission_amount));
const row = (engagement_type, stage, o = {}) => ({ engagement_type, stage, total_cost: null, payment_amount: null, commission_amount: null, ...o });

test('splits stage counts into ugc vs everything-else (video), and all = both', () => {
  const { stage_counts } = kpiPipeline([
    row('video_tracking', 'live'), row('video_tracking', 'live'), row('video_tracking', 'posting'),
    row('ugc', 'live'), row(null, 'shipped'),
  ], spendOf);
  assert.deepEqual(stage_counts.video, { live: 2, posting: 1, shipped: 1 });
  assert.deepEqual(stage_counts.ugc, { live: 1 });
  assert.deepEqual(stage_counts.all, { live: 3, posting: 1, shipped: 1 });
});

test('a stage with no rows is absent (the page reads it as 0); a row with no stage is not counted', () => {
  const { stage_counts } = kpiPipeline([row('video_tracking', 'delivered'), row('video_tracking', null)], spendOf);
  assert.equal(stage_counts.video.proposed, undefined);
  assert.equal(stage_counts.video.proposed ?? 0, 0);
  assert.deepEqual(stage_counts.all, { delivered: 1 });
  assert.deepEqual(kpiPipeline([], spendOf).stage_counts, { video: {}, ugc: {}, all: {} });
});

test('committed = spend of every row passed (the caller already drops cancelled) — same as Total cost', () => {
  const { committed, stage_counts } = kpiPipeline([
    row('video_tracking', 'planning', { total_cost: '1000.40' }),
    row('video_tracking', 'live', { payment_amount: '2000', commission_amount: '500' }),
    row('video_tracking', 'dropped', { total_cost: '9999' }),
    row('ugc', 'ghosted', { total_cost: '9999' }),
    row('ugc', 'posting', { total_cost: '300' }),
  ], spendOf);
  // Dropped/ghosted money stays in: it matches the Engagements "Total cost" tile, not a third total.
  assert.deepEqual(committed, { video: 13499, ugc: 10299, all: 23798 });
  assert.equal(stage_counts.video.dropped, 1);
});
