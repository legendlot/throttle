// Per-order product image for the WA IMAGE header (2026-07-28).
//
// A header carries ONE image but an order can have many lines. Rule (Afshaan): the
// HIGHEST-VALUE line, price x quantity. These lock the rule and the coercion traps around it —
// Shopify sends `price` as a STRING, and a NaN comparison is always false, which would
// silently degrade "highest value" into "first line" with nothing visibly broken.
//
// Run: node test/order-header-image.test.js   (Node 18+)
const assert = require('assert');
const SHOP = require('../src/shopify.js');

let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e && e.message); });

const li = (variant_id, title, price, quantity = 1) => ({ variant_id, title, price, quantity });
const ORDER = (line_items) => ({
  id: 1, order_number: 44779, email: 'a@b.com', currency: 'INR', line_items,
  customer: { email: 'a@b.com' },
});
const props = (line_items) => SHOP.mapOrderEvent(ORDER(line_items), 'order_placed').properties;

(async () => {
  await t('single line → that line is primary, its variant listed', () => {
    const p = props([li(111, 'Shadow', '2249.00')]);
    assert.strictEqual(p.primary_title, 'Shadow');
    assert.strictEqual(p.variant_ids, '111');
  });

  await t('highest VALUE wins, not highest unit price (qty counts)', () => {
    // 3 x 999 = 2997 beats 1 x 2249
    const p = props([li(111, 'Shadow', '2249.00', 1), li(222, 'Bumble', '999.00', 3)]);
    assert.strictEqual(p.primary_title, 'Bumble');
  });

  await t('highest-value line is listed FIRST so the resolver fallback lands on it too', () => {
    const p = props([li(111, 'Cheap', '100.00', 1), li(222, 'Pricey', '5000.00', 1)]);
    assert.strictEqual(p.variant_ids.split(',')[0], '222');
    assert.strictEqual(p.primary_title, 'Pricey');
  });

  await t('every variant id still travels (so a title mismatch can still resolve)', () => {
    const p = props([li(111, 'A', '100'), li(222, 'B', '5000'), li(333, 'C', '200')]);
    assert.deepStrictEqual(p.variant_ids.split(',').sort(), ['111', '222', '333']);
  });

  await t('string prices are coerced — "999.00" > "1000" must NOT win lexically', () => {
    const p = props([li(111, 'Nine', '999.00', 1), li(222, 'Thousand', '1000.00', 1)]);
    assert.strictEqual(p.primary_title, 'Thousand');
  });

  await t('a non-numeric price scores 0 instead of NaN (NaN would elect the first line)', () => {
    const p = props([li(111, 'Broken', 'free', 1), li(222, 'Real', '499.00', 1)]);
    assert.strictEqual(p.primary_title, 'Real');
  });

  await t('missing quantity is treated as 1, not 0', () => {
    const p = props([li(111, 'NoQty', '5000.00', undefined), li(222, 'Other', '400.00', 2)]);
    assert.strictEqual(p.primary_title, 'NoQty');
  });

  await t('no line items → nulls, never a crash', () => {
    const p = props([]);
    assert.strictEqual(p.variant_ids, null);
    assert.strictEqual(p.primary_title, null);
  });

  await t('a line with no variant_id is skipped in the id list but can still be primary', () => {
    const p = props([li(undefined, 'Custom', '9000.00'), li(222, 'Other', '100.00')]);
    assert.strictEqual(p.primary_title, 'Custom');
    assert.strictEqual(p.variant_ids, '222');   // undefined must not become "undefined"
  });

  await t('existing item/order fields are untouched by the addition', () => {
    const p = props([li(111, 'Shadow', '2249.00')]);
    assert.strictEqual(p.items, 'Shadow');
    assert.strictEqual(p.order_number, 44779);
    assert.strictEqual(p.line_item_count, 1);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
