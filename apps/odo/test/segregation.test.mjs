// Money-formula regression test for apps/odo/src/lib/segregation.js (S355, 2026-09-07).
// Run: node --test apps/odo/test/segregation.test.mjs   (from 05_Throttle; no runner is declared in
// apps/odo/package.json, and src/lib/*.js is ESM-in-.js, so the module is loaded via a data: URL.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = await readFile(new URL('../src/lib/segregation.js', import.meta.url), 'utf8');
const { GST_RATE, aggOrders, hybridHeadline, rowGst, TAX_AT_INGEST_ADAPTERS } =
  await import('data:text/javascript,' + encodeURIComponent(src));

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.005, `${msg}: ${a} vs ${b}`);
const flat = x => x - x / (1 + GST_RATE);

test('settlement-lag adapter (Amazon) reproduces the pre-S355 aggregate flat strip exactly', () => {
  const rows = [
    { channel_id: 'amz', adapter_kind: 'amazon_spapi', gross: 1000, discount: 50, tax: 3, tax_ingest: 3, returns_value: 100, orders: 2 },
    { channel_id: 'amz', adapter_kind: 'amazon_spapi', gross: 2500, discount: 0, tax: 0, tax_ingest: 0, returns_value: 0, orders: 3 },
  ];
  const a = aggOrders(rows);
  const netReturns = 3500 - 50 - 100;
  near(a.tax, flat(netReturns), 'tax = flat on netReturns');
  near(a.netExGst, netReturns / 1.18, 'net unchanged');
  assert.equal(a.gstSettled, 3, 'gstSettled still = summed tax');
});

test('rows with no adapter_kind (a foreign row shape) fall to the flat strip', () => {
  const a = aggOrders([{ channel_id: 'x', gross: 1180, discount: 0, tax: 180, returns_value: 0, orders: 1 }]);
  near(a.tax, flat(1180), 'flat');
});

test('ingest adapter with a plausible staged tax uses it', () => {
  const a = aggOrders([{ channel_id: 'web', adapter_kind: 'shopify', gross: 1180, discount: 0, tax: 100, tax_ingest: 100, returns_value: 0, orders: 1 }]);
  near(a.tax, 100, 'exact used');
  near(a.netExGst, 1080, 'net = base − exact');
  near(rowGst({ adapter_kind: 'shopify', gross: 1180, discount: 0, tax_ingest: '180' }), 180, 'string numeric → exact');
});

test('guard: zero, blank, partial capture, above-rate and tax≥base all fall to flat, never zero', () => {
  near(rowGst({ adapter_kind: 'shopify', gross: 1180, discount: 0, tax_ingest: 0 }), flat(1180), 'zero on positive base');
  near(rowGst({ adapter_kind: 'shopify', gross: 1180, discount: 0, tax_ingest: '' }), flat(1180), 'blank');
  near(rowGst({ adapter_kind: 'shopify', gross: 100000, discount: 0, tax_ingest: 1 }), flat(100000), 'partial capture (1 of 500 orders staged)');
  near(rowGst({ adapter_kind: 'snorkel_internal', gross: 2050, discount: 1948, tax_ingest: 313 }), flat(102), 'tax > base (Firstcry shape)');
  near(rowGst({ adapter_kind: 'shopify', gross: 1000, discount: 0, tax_ingest: 1000 }), flat(1000), 'tax == base');
  near(rowGst({ adapter_kind: 'shopify', gross: 0, discount: 0, tax_ingest: 0.4 }), 0, 'zero base → 0, not negative');
  near(rowGst({ adapter_kind: 'uniware', gross: 2099, discount: 1400, tax_ingest: 320 }), flat(699), 'uniware is NOT an ingest adapter yet');
  assert.ok(!TAX_AT_INGEST_ADAPTERS.has('amazon_spapi'));
});

test('5% lines net higher than a flat 18% strip; returns strip at the flat rate', () => {
  const rows = [
    { channel_id: 'gt', adapter_kind: 'snorkel_internal', gross: 2100, discount: 0, tax: 100, tax_ingest: 100, returns_value: 236, orders: 1 },
    { channel_id: 'gt', adapter_kind: 'snorkel_internal', gross: 1180, discount: 180, tax: 152.54, tax_ingest: 152.54, returns_value: 0, orders: 1 },
  ];
  const a = aggOrders(rows);
  near(a.tax, 100 + 152.54 - flat(236), 'GST = Σ exact − returns flat');
  near(a.netExGst, (2100 + 1180 - 180 - 236) - a.tax, 'ladder consistent');
  assert.ok(a.netExGst > (2100 + 1180 - 180 - 236) / 1.18, '5% line nets HIGHER than flat');
});

test('settledPct dips on a partially captured day (the badge stays a signal)', () => {
  const a = aggOrders([{ channel_id: 'web', adapter_kind: 'shopify', gross: 100000, discount: 0, tax: 1, tax_ingest: 1, returns_value: 0, orders: 500 }]);
  assert.ok(a.settledPct !== null && a.settledPct < 5, `settledPct should be ~0, got ${a.settledPct}`);
});

test('hybridHeadline still composes order-grain + product-grain', () => {
  const h = hybridHeadline(
    [{ channel_id: 'web', adapter_kind: 'shopify', gross: 1180, discount: 0, tax: 180, tax_ingest: 180, returns_value: 0, orders: 1 }],
    [{ channel_id: 'qc', gross_value: 236, tax_value: 36, units: 2 }, { channel_id: 'web', gross_value: 999, units: 1 }]);
  near(h.grossAll, 1180 + 236, 'grossAll');
  near(h.netExGst, 1000 + 200, 'netExGst');
  assert.equal(h.units, 3);
});
