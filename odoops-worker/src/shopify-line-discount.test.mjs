// Website order-level discount codes must reach sales_fact (2026-11-09 Odo healthcheck).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shopifyLineDiscount, SHOPIFY_LINE_DISCOUNT_SELECTION } from './shopify-line-discount.mjs';

const m = (a) => ({ shopMoney: { amount: String(a) } });

test('order-level code: discountedTotalSet unchanged, allocation carries it (#LOT65378 shape)', () => {
  const l = { originalTotalSet: m(3418), discountedTotalSet: m(3418), discountAllocations: [{ allocatedAmountSet: m(1367.2) }] };
  assert.equal(shopifyLineDiscount(l), 1367.2);
});

test('line-level discount appears in BOTH forms — never double-counted', () => {
  const l = { originalTotalSet: m(1000), discountedTotalSet: m(900), discountAllocations: [{ allocatedAmountSet: m(100) }] };
  assert.equal(shopifyLineDiscount(l), 100);
});

test('line + order discount: allocations sum both applications', () => {
  const l = { originalTotalSet: m(1000), discountedTotalSet: m(900), discountAllocations: [{ allocatedAmountSet: m(100) }, { allocatedAmountSet: m(50) }] };
  assert.equal(shopifyLineDiscount(l), 150);
});

test('allocations field missing → falls back to the legacy line-level form', () => {
  assert.equal(shopifyLineDiscount({ originalTotalSet: m(1000), discountedTotalSet: m(950) }), 50);
});

test('no discount → 0; never exceeds the line gross; never negative', () => {
  assert.equal(shopifyLineDiscount({ originalTotalSet: m(500), discountedTotalSet: m(500), discountAllocations: [] }), 0);
  assert.equal(shopifyLineDiscount({ originalTotalSet: m(500), discountedTotalSet: m(500), discountAllocations: [{ allocatedAmountSet: m(800) }] }), 500);
  assert.equal(shopifyLineDiscount({ originalTotalSet: m(500), discountedTotalSet: m(600) }), 0);
});

test('index.js: every Shopify order query selects discountAllocations, and the mapper uses the helper', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('./index.js', import.meta.url), 'utf8');
  const queries = src.split('\n').filter(l => /orders\(first:/.test(l) && /lineItems\(/.test(l));
  assert.ok(queries.length >= 2, `expected poll + webhook queries, found ${queries.length}`);
  for (const q of queries) assert.ok(q.includes('${SHOPIFY_LINE_DISCOUNT_SELECTION}'), `query missing discountAllocations: ${q.slice(0, 80)}`);
  assert.match(src, /const disc\s*=\s*shopifyLineDiscount\(l\);/);
  assert.equal(SHOPIFY_LINE_DISCOUNT_SELECTION.includes('discountAllocations'), true);
});
