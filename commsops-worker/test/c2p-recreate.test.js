// Unit tests for the C2P cancel-and-recreate replication builder + compile validator.
// Run: node test/c2p-recreate.test.js   (pure; no network)
//
// The invariant these protect: a replacement order must charge exactly what the pay-link
// collected and must carry the same goods to the same address. Getting either wrong bills a
// real customer the wrong amount, which is why the risky mapping lives in a pure function.
const assert = require('assert');
const SH = require('../src/shopify.js');
const { compile } = require('../src/journeys.js');

let pass = 0, fail = 0;
const queue = [];
function t(name, fn) { queue.push([name, fn]); }
async function run() {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok  ', name); }
    catch (e) { fail++; console.log('  FAIL', name, '\n        ', e.message); }
  }
}

// A realistic COD order: 2 line items (one qty 2), coupon already reflected in the
// discountedUnitPrice, shipping line, both addresses, an existing customer.
const ORDER = {
  id: 'gid://shopify/Order/111', name: '#LOT1234', tags: ['cod'],
  email: 'a@b.com', phone: '+919999999999',
  createdAt: '2026-07-29T06:00:00Z', cancelledAt: null,
  displayFulfillmentStatus: 'UNFULFILLED', displayFinancialStatus: 'PENDING',
  currentTotalPriceSet: { shopMoney: { amount: '2299.00', currencyCode: 'INR' } },
  customer: { id: 'gid://shopify/Customer/9' },
  shippingAddress: { firstName: 'A', lastName: 'B', address1: '1 St', address2: null,
    city: 'Bengaluru', provinceCode: 'KA', countryCode: 'IN', zip: '560001',
    phone: '+919999999999', company: null },
  billingAddress: { firstName: 'A', lastName: 'B', address1: '1 St', address2: null,
    city: 'Bengaluru', provinceCode: 'KA', countryCode: 'IN', zip: '560001',
    phone: '+919999999999', company: null },
  shippingLine: { title: 'Standard', originalPriceSet: { shopMoney: { amount: '0.00', currencyCode: 'INR' } } },
  lineItems: { edges: [
    { node: { quantity: 1, title: 'Shadow Tarmac', sku: 'SH-TB', variant: { id: 'gid://shopify/ProductVariant/1' },
              discountedUnitPriceSet: { shopMoney: { amount: '2199.00', currencyCode: 'INR' } } } },
    { node: { quantity: 2, title: 'Gift Wrapping', sku: 'GW', variant: { id: 'gid://shopify/ProductVariant/2' },
              discountedUnitPriceSet: { shopMoney: { amount: '50.00', currencyCode: 'INR' } } } },
  ] },
};

// ── line replication ──
t('replicates every line with variantId, quantity and priceOverride', () => {
  const { input } = SH.buildC2PDraftInput(ORDER, 'enr-1');
  assert.strictEqual(input.lineItems.length, 2);
  assert.deepStrictEqual(input.lineItems[0], {
    variantId: 'gid://shopify/ProductVariant/1', quantity: 1,
    priceOverride: { amount: '2199.00', currencyCode: 'INR' },
  });
  // quantity > 1 must be carried, not flattened to 1
  assert.strictEqual(input.lineItems[1].quantity, 2);
});

t('uses the DISCOUNTED unit price so a coupon carries through', () => {
  const coupon = JSON.parse(JSON.stringify(ORDER));
  coupon.lineItems.edges[0].node.discountedUnitPriceSet.shopMoney.amount = '1979.10';
  const { input } = SH.buildC2PDraftInput(coupon, 'enr-1');
  assert.strictEqual(input.lineItems[0].priceOverride.amount, '1979.10');
});

// ── faithfulness guards ──
t('refuses an order containing a custom (variant-less) line item', () => {
  const custom = JSON.parse(JSON.stringify(ORDER));
  custom.lineItems.edges.push({ node: { quantity: 1, title: 'Handling fee', variant: null,
    discountedUnitPriceSet: { shopMoney: { amount: '25.00', currencyCode: 'INR' } } } });
  assert.strictEqual(SH.buildC2PDraftInput(custom, 'e').error, 'custom_line_item_present');
});

t('refuses an order with no replicable lines', () => {
  const empty = { ...ORDER, lineItems: { edges: [] } };
  assert.strictEqual(SH.buildC2PDraftInput(empty, 'e').error, 'no_replicable_line_items');
  assert.strictEqual(SH.buildC2PDraftInput(null, 'e').error, 'order_missing');
});

// ── customer + addresses ──
t('attaches the existing customer via purchasingEntity, not deprecated customerId', () => {
  const { input } = SH.buildC2PDraftInput(ORDER, 'enr-1');
  assert.deepStrictEqual(input.purchasingEntity, { customerId: 'gid://shopify/Customer/9' });
  assert.strictEqual(input.customerId, undefined);
});

t('addresses use provinceCode/countryCode and omit deprecated province/country', () => {
  const { input } = SH.buildC2PDraftInput(ORDER, 'enr-1');
  assert.strictEqual(input.shippingAddress.countryCode, 'IN');
  assert.strictEqual(input.shippingAddress.provinceCode, 'KA');
  assert.ok(!('country' in input.shippingAddress), 'deprecated country must not be sent');
  assert.ok(!('province' in input.shippingAddress), 'deprecated province must not be sent');
  assert.strictEqual(input.billingAddress.zip, '560001');
});

t('omits address / customer / shipping keys entirely when absent', () => {
  const bare = { ...ORDER, customer: null, shippingAddress: null, billingAddress: null,
                 shippingLine: null, email: null, phone: null };
  const { input } = SH.buildC2PDraftInput(bare, 'e');
  for (const k of ['purchasingEntity', 'shippingAddress', 'billingAddress', 'shippingLine', 'email', 'phone'])
    assert.ok(!(k in input), `${k} should be omitted, not null`);
});

// ── shipping line ──
t('carries the shipping line with priceWithCurrency (not deprecated price)', () => {
  const ship = JSON.parse(JSON.stringify(ORDER));
  ship.shippingLine.originalPriceSet.shopMoney.amount = '99.00';
  const { input } = SH.buildC2PDraftInput(ship, 'e');
  assert.deepStrictEqual(input.shippingLine,
    { title: 'Standard', priceWithCurrency: { amount: '99.00', currencyCode: 'INR' } });
  assert.ok(!('price' in input.shippingLine));
});

// ── provenance ──
t('tags the replacement for traceability back to the original', () => {
  const { input } = SH.buildC2PDraftInput(ORDER, 'enr-42');
  assert.ok(input.tags.includes('relay-c2p-converted'));
  assert.ok(input.tags.includes('relay-c2p-from-#LOT1234'));
  assert.ok(input.note.includes('#LOT1234'));
  assert.ok(input.note.includes('enr-42'));
});

t('applies NO discount — the caller sizes it off the draft total', () => {
  const { input } = SH.buildC2PDraftInput(ORDER, 'e');
  assert.strictEqual(input.appliedDiscount, undefined,
    'discount must be applied in PHASE B against Shopify’s own computed total');
});

t('currency follows the order, not a hardcoded INR', () => {
  const usd = JSON.parse(JSON.stringify(ORDER));
  usd.currentTotalPriceSet.shopMoney.currencyCode = 'USD';
  const b = SH.buildC2PDraftInput(usd, 'e');
  assert.strictEqual(b.currencyCode, 'USD');
  assert.strictEqual(b.input.lineItems[0].priceOverride.currencyCode, 'USD');
});

// ── pre-flight stock check ──
// The replacement order reserves its OWN inventory while the original still holds its units, so
// this decides whether we are allowed to ask for money at all.
const stockOrder = (lines) => ({ id: 'gid://shopify/Order/1', name: '#LOT1',
  lineItems: { edges: lines.map((l) => ({ node: l })) } });

t('no shortfall when stock covers the replacement', () => {
  assert.deepStrictEqual(SH.stockShortfall(stockOrder([
    { quantity: 1, title: 'Tyres', variant: { id: 'v1', inventoryQuantity: 3 } },
  ])), []);
});

t('exactly enough is enough (>= not >)', () => {
  assert.deepStrictEqual(SH.stockShortfall(stockOrder([
    { quantity: 2, title: 'Tyres', variant: { id: 'v1', inventoryQuantity: 2 } },
  ])), []);
});

t('flags a shortfall, reporting need vs have', () => {
  const short = SH.stockShortfall(stockOrder([
    { quantity: 2, title: 'Tyres', variant: { id: 'v1', inventoryQuantity: 1 } },
  ]));
  assert.strictEqual(short.length, 1);
  assert.deepStrictEqual(short[0], { variant_id: 'v1', title: 'Tyres', need: 2, have: 1 });
});

t('ZERO stock is a shortfall — the exact case that strands a payment', () => {
  assert.strictEqual(SH.stockShortfall(stockOrder([
    { quantity: 1, title: 'Tyres', variant: { id: 'v1', inventoryQuantity: 0 } },
  ])).length, 1);
});

t('untracked inventory (null) does NOT block — refusing on missing data is the worse failure', () => {
  assert.deepStrictEqual(SH.stockShortfall(stockOrder([
    { quantity: 5, title: 'Untracked', variant: { id: 'v1', inventoryQuantity: null } },
  ])), []);
});

t('checks EVERY line, not just the first', () => {
  const short = SH.stockShortfall(stockOrder([
    { quantity: 1, title: 'Fine',  variant: { id: 'v1', inventoryQuantity: 9 } },
    { quantity: 3, title: 'Short', variant: { id: 'v2', inventoryQuantity: 1 } },
  ]));
  assert.strictEqual(short.length, 1);
  assert.strictEqual(short[0].title, 'Short');
});

t('an empty / missing order yields no shortfall (fails open)', () => {
  assert.deepStrictEqual(SH.stockShortfall(null), []);
  assert.deepStrictEqual(SH.stockShortfall({}), []);
  assert.deepStrictEqual(SH.stockShortfall(stockOrder([])), []);
});

// ── compile validator ──
const journeyWith = (op) => ({
  entry: 'a',
  steps: {
    a: { type: 'action', kind: 'order_modify', op, outcomes: { done: 'z', not_done: 'z' } },
    z: { type: 'exit' },
  },
});

t('compile ACCEPTS recreate_as_prepaid', async () => {
  const r = await compile({}, journeyWith('recreate_as_prepaid'));
  assert.deepStrictEqual(r.errors, [], JSON.stringify(r.errors));
});

t('compile still accepts the legacy ops and rejects an unknown one', async () => {
  for (const op of ['convert_to_prepaid', 'cancel', 'add_tag'])
    assert.deepStrictEqual((await compile({}, journeyWith(op))).errors, [], op);
  const bad = await compile({}, journeyWith('recreate'));
  assert.ok(bad.errors.some((e) => e.startsWith('bad_order_op:')),
    'a near-miss op name must be rejected, not silently accepted');
});

t('recreate_as_prepaid keeps done/not_done handles — an unrouted branch fails compile', async () => {
  const j = journeyWith('recreate_as_prepaid');
  delete j.steps.a.outcomes.not_done;
  const r = await compile({}, j);
  assert.ok(r.errors.some((e) => e.includes('action_handle_missing')),
    `not_done must still be a required handle; got ${JSON.stringify(r.errors)}`);
});

run().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
