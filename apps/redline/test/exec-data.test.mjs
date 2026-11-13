import { test } from 'node:test';
import assert from 'node:assert/strict';
import { istDay, istMonth, normaliseDashboard, sumMtdPacked, normaliseRange, countOf } from '../src/lib/execData.js';

// The Overview's fetcher normalisation — what is held and cached is exactly what renders.

test('cache-key dates are IST, not the machine clock', () => {
  // 2026-11-30 20:00 UTC = 2026-12-01 01:30 IST: a new IST day AND month.
  const ms = Date.UTC(2026, 10, 30, 20, 0);
  assert.equal(istDay(ms), '2026-12-01');
  assert.equal(istMonth(ms), '2026-12');
  // 18:29 UTC is still the same IST day; 18:30 UTC is the next.
  assert.equal(istDay(Date.UTC(2026, 10, 12, 18, 29)), '2026-11-12');
  assert.equal(istDay(Date.UTC(2026, 10, 12, 18, 30)), '2026-11-13');
});

test('dashboard: hourly prefers hourly_dispatch, falls back to hourly_chart', () => {
  const a = normaliseDashboard({ summary: { x: 1 }, hourly_dispatch: [{ h: 9 }], hourly_chart: [{ h: 1 }], open_runs: [{ r: 1 }], scan_products: [] });
  assert.deepEqual(a, { summary: { x: 1 }, hourly: [{ h: 9 }], runs: [{ r: 1 }], scanProducts: [] });
  const b = normaliseDashboard({ hourly_dispatch: [], hourly_chart: [{ h: 1 }] });
  assert.deepEqual(b, { summary: null, hourly: [{ h: 1 }], runs: [], scanProducts: [] });
});

test('month-to-date packed sums cnt; a non-array answer is an error, not 0', () => {
  assert.equal(sumMtdPacked([{ cnt: '3' }, { cnt: 4 }, { cnt: null }]), 7);
  assert.equal(sumMtdPacked([]), 0);
  assert.throws(() => sumMtdPacked(null));
  assert.throws(() => sumMtdPacked({}));
});

test('range: PvA non-array reads as no rows, packed non-array as unknown', () => {
  assert.deepEqual(normaliseRange([{ a: 1 }], [{ cnt: 2 }]), { pva: [{ a: 1 }], packed: [{ cnt: 2 }] });
  assert.deepEqual(normaliseRange(null, {}), { pva: [], packed: null });
});

test('pending counts hold the count only', () => {
  assert.equal(countOf([{ upc: 'a' }, { upc: 'b' }]), 2);
  assert.equal(countOf(null), 0);
});
