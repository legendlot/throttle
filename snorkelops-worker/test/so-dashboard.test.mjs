// Sales Orders date filter + value tiles (Akshay, #bugs 1790855178). Logic lives in
// apps/snorkel/src/lib/soDashboard.js. Run: node --test snorkelops-worker/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inDateRange, soValueTiles } from '../../apps/snorkel/src/lib/soDashboard.js';

test('inDateRange: inclusive bounds on order_date, open ends, missing date only under All time', () => {
  const o = { order_date: '2026-10-01' };
  assert.equal(inDateRange(o, { from: '2026-10-01', to: '2026-10-01' }), true);
  assert.equal(inDateRange(o, { from: '2026-10-02', to: '' }), false);
  assert.equal(inDateRange(o, { from: '', to: '2026-09-30' }), false);
  assert.equal(inDateRange(o, { from: '', to: '' }), true);
  assert.equal(inDateRange({ order_date: null }, { from: '2026-01-01', to: '' }), false);
  assert.equal(inDateRange({ order_date: null }, {}), true);
});

test('soValueTiles: confirmed only; numeric strings summed; unknown fulfilment counted, not zeroed silently', () => {
  const t = soValueTiles([
    { status: 'confirmed', grand_total: '1000.50', fulfilled_value: 400 },
    { status: 'confirmed', grand_total: '2000', fulfilled_value: '2000.00' },
    { status: 'confirmed', grand_total: 500, fulfilled_value: null },
    { status: 'draft', grand_total: 9999, fulfilled_value: 0 },
    { status: 'cancelled', grand_total: 8888, fulfilled_value: 100 },
  ]);
  assert.deepEqual(t, { orders: 3, unknown: 1, poValue: 3500.5, orderedValue: 3500.5, fulfilledValue: 2400 });
});

test('soValueTiles: empty list is zeros, not NaN', () => {
  assert.deepEqual(soValueTiles([]), { orders: 0, unknown: 0, poValue: 0, orderedValue: 0, fulfilledValue: 0 });
});

test('soValueTiles: orderedValue uses the line-derived ordered_value, falling back to grand_total', () => {
  const t = soValueTiles([
    { status: 'confirmed', grand_total: 1000, ordered_value: 1100, fulfilled_value: 1100 },
    { status: 'confirmed', grand_total: 500, fulfilled_value: 0 },
  ]);
  assert.equal(t.poValue, 1500);
  assert.equal(t.orderedValue, 1600);
});
