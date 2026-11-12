import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as t from './trend.js';

test('geometry: x spreads across the padded width; 100% at the top', () => {
  assert.equal(t.xAt(0, 3, 100, 10), 10);
  assert.equal(t.xAt(2, 3, 100, 10), 90);
  assert.equal(t.xAt(0, 1, 100, 10), 50);
  assert.equal(t.yAt(100, 40, 0), 0);
  assert.equal(t.yAt(0, 40, 0), 40);
  assert.equal(t.yAt(150, 40, 0), 0);   // clamped
});

test('path: null breaks the line, never drawn as zero', () => {
  const pts = [{ pct: 50 }, { pct: null }, { pct: 100 }, { pct: 0 }];
  assert.equal(t.linePath(pts, { w: 30, h: 10, pad: 0 }), 'M0 5M20 0L30 10');
  assert.equal(t.linePath([], {}), '');
  assert.equal(t.dots(pts, { w: 30, h: 10, pad: 0 }).length, 3);
});

test('trend needs two closed weeks with a cohort', () => {
  assert.equal(t.hasTrend({ overall: [{ week_end: 'a', cohort: 5, pct: 60 }] }), false);
  assert.equal(t.hasTrend({ overall: [{ cohort: 0 }, { cohort: 3 }] }), false);
  assert.equal(t.hasTrend({ overall: [{ cohort: 2 }, { cohort: 3 }] }), true);
  assert.equal(t.hasTrend(null), false);
});

test('pack series: trend + last week, deduped, oldest first, last 4; an empty cohort is a gap', () => {
  const team = { trend: [{ week_end: '2026-11-01', pct: 50, cohort: 2 }, { week_end: '2026-11-08', pct: 70, cohort: 0 }],
    last_week: { week_end: '2026-11-15', pct: 80, cohort: 5 } };
  assert.deepEqual(t.packSeries(team), [{ week_end: '2026-11-01', pct: 50 }, { week_end: '2026-11-08', pct: null }, { week_end: '2026-11-15', pct: 80 }]);
  assert.equal(t.packSeries({ trend: [{ week_end: 'a', cohort: 1, pct: 1 }, { week_end: 'b', cohort: 1, pct: 1 }, { week_end: 'c', cohort: 1, pct: 1 }, { week_end: 'd', cohort: 1, pct: 1 }], last_week: { week_end: 'e', cohort: 1, pct: 1 } }).length, 4);
  assert.deepEqual(t.packSeries({}), []);
});
