// A Website refund line must not count GST twice (2026-11-09 Odo healthcheck).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shopifyRefundLineAmount } from './shopify-refund.mjs';

const m = (a) => ({ shopMoney: { amount: String(a) } });
const lot51546 = { quantity: 1, subtotalSet: m(1994.05), totalTaxSet: m(304.18) };

test('tax-inclusive store: subtotal already holds the GST (#LOT51546 → ₹1,994.05, not ₹2,298.23)', () => {
  assert.equal(shopifyRefundLineAmount(lot51546, true), 1994.05);
});

test('taxesIncluded missing → still the subtotal (LOT is tax-inclusive; never re-add tax on a guess)', () => {
  assert.equal(shopifyRefundLineAmount(lot51546, undefined), 1994.05);
});

test('tax-EXCLUSIVE order: tax is added so the return stays on the tax-inclusive basis of the sale rows', () => {
  assert.equal(shopifyRefundLineAmount({ subtotalSet: m(1000), totalTaxSet: m(180) }, false), 1180);
});

test('empty / malformed line → 0', () => {
  assert.equal(shopifyRefundLineAmount({}, true), 0);
  assert.equal(shopifyRefundLineAmount(null, false), 0);
});

test('index.js: refund line uses the helper and both order queries select taxesIncluded', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('./index.js', import.meta.url), 'utf8');
  assert.match(src, /const amt = shopifyRefundLineAmount\(rl, o\.taxesIncluded\);/);
  assert.doesNotMatch(src, /subtotalSet\?\.shopMoney\?\.amount\) \+ num\(rl\.totalTaxSet/);
  const queries = src.split('\n').filter(l => /orders\(first:/.test(l) && /refundLineItems\(/.test(l));
  assert.ok(queries.length >= 2, `expected poll + webhook queries, found ${queries.length}`);
  for (const q of queries) assert.match(q, /\btaxesIncluded\b/, `query missing taxesIncluded: ${q.slice(0, 80)}`);
});
