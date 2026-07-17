// Unit tests for the last_order_at targeted backfill mapper (winback prerequisite).
// Run: node test/last-order-backfill.test.js   (Node 18+)
// Pure-function coverage of mapLastOrder; no network.

const assert = require('assert');
const SHOP = require('../src/shopify.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n        ', e.message); }
}

console.log('mapLastOrder — maps a Shopify customer node to a last_order_at patch');
t('id + lastOrder.createdAt -> patch with ONLY last_order_at', () => {
  const r = SHOP.mapLastOrder({ id: 'gid://shopify/Customer/12345', lastOrder: { createdAt: '2026-01-02T03:04:05Z' } });
  assert.deepEqual(r, {
    identifiers: [{ type: 'shopify_customer_id', value: '12345' }],
    attributes: { last_order_at: '2026-01-02T03:04:05Z' },
  });
});

t('patches EXACTLY one attribute key (no collateral on lifetime_orders etc.)', () => {
  const r = SHOP.mapLastOrder({ id: 'gid://shopify/Customer/9', lastOrder: { createdAt: '2025-12-31T00:00:00Z' } });
  assert.deepEqual(Object.keys(r.attributes), ['last_order_at'],
    'the merge is shallow — extra keys would overwrite live data');
});

t('resolves by shopify_customer_id (the RPC dedup key), numeric-tail only', () => {
  const r = SHOP.mapLastOrder({ id: 'gid://shopify/Customer/8006200066', lastOrder: { createdAt: '2026-02-02T00:00:00Z' } });
  assert.equal(r.identifiers[0].type, 'shopify_customer_id');
  assert.equal(r.identifiers[0].value, '8006200066');
});

console.log('mapLastOrder — returns null (skipped by applyMapped) when unusable');
t('no lastOrder (0-order customer slipped the filter) -> null', () =>
  assert.equal(SHOP.mapLastOrder({ id: 'gid://shopify/Customer/1', lastOrder: null }), null));
t('lastOrder present but no createdAt -> null', () =>
  assert.equal(SHOP.mapLastOrder({ id: 'gid://shopify/Customer/1', lastOrder: {} }), null));
t('no id -> null', () =>
  assert.equal(SHOP.mapLastOrder({ lastOrder: { createdAt: '2026-01-01T00:00:00Z' } }), null));
t('null node -> null (no crash)', () => assert.equal(SHOP.mapLastOrder(null), null));
t('undefined node -> null (no crash)', () => assert.equal(SHOP.mapLastOrder(undefined), null));
t('empty object -> null', () => assert.equal(SHOP.mapLastOrder({}), null));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
