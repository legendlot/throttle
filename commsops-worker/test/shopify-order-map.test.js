// Unit tests for mapOrderEvent's message-copy bindings.
// Run: node test/shopify-order-map.test.js
//
// Why this exists: the mapper originally emitted only totals + statuses, so the WA templates
// bound to {tracking_url}, {order_url} and {items} silently fell back to generic values. These
// tests pin the fields those templates depend on.

const assert = require('assert');
const { mapOrderEvent } = require('../src/shopify.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n        ', e.message); }
};

const base = {
  id: 6289680760884,
  order_number: 43700,
  total_price: '2099.00',
  currency: 'INR',
  email: 'rahul@example.com',
  customer: { id: 123, email: 'rahul@example.com' },
  order_status_url: 'https://legendoftoys.com/orders/abc123',
  line_items: [{ title: 'Ghost RC Drift Car' }],
};

t('carries tracking off the fulfillments array', () => {
  const e = mapOrderEvent({
    ...base,
    fulfillments: [{
      status: 'success', tracking_company: 'Delhivery',
      tracking_number: '39308710277896',
      tracking_url: 'https://www.delhivery.com/track/package/39308710277896',
    }],
  }, 'order_fulfilled');
  assert.equal(e.properties.tracking_number, '39308710277896');
  assert.equal(e.properties.tracking_company, 'Delhivery');
  assert.equal(e.properties.tracking_url, 'https://www.delhivery.com/track/package/39308710277896');
  assert.equal(e.properties.fulfillment_count, 1);
});

t('falls back to the plural tracking_numbers/urls arrays', () => {
  const e = mapOrderEvent({
    ...base,
    fulfillments: [{ tracking_numbers: ['ABC1'], tracking_urls: ['https://t/ABC1'] }],
  }, 'order_fulfilled');
  assert.equal(e.properties.tracking_number, 'ABC1');
  assert.equal(e.properties.tracking_url, 'https://t/ABC1');
});

t('uses the LAST fulfillment (most recent) when there are several', () => {
  const e = mapOrderEvent({
    ...base,
    fulfillments: [
      { tracking_number: 'OLD', tracking_url: 'https://t/OLD' },
      { tracking_number: 'NEW', tracking_url: 'https://t/NEW' },
    ],
  }, 'order_fulfilled');
  assert.equal(e.properties.tracking_number, 'NEW');
  assert.equal(e.properties.fulfillment_count, 2);
});

t('no fulfillments → tracking keys absent, not null-noise', () => {
  const e = mapOrderEvent(base, 'order_placed');
  assert.equal('tracking_number' in e.properties, false);
  assert.equal(e.properties.order_status_url, 'https://legendoftoys.com/orders/abc123');
});

t('summarises a single item by name', () => {
  const e = mapOrderEvent(base, 'order_placed');
  assert.equal(e.properties.items, 'Ghost RC Drift Car');
});

t('summarises multiple items compactly (WA bodies are length-capped)', () => {
  const e = mapOrderEvent({
    ...base,
    line_items: [{ title: 'Ghost RC Drift Car' }, { title: 'Flare' }, { title: 'Vortex' }],
  }, 'order_placed');
  assert.equal(e.properties.items, 'Ghost RC Drift Car + 2 more');
});

t('items is null when line items carry no titles', () => {
  const e = mapOrderEvent({ ...base, line_items: [{}] }, 'order_placed');
  assert.equal(e.properties.items, null);
});

t('still returns null without a resolvable identifier', () => {
  assert.equal(mapOrderEvent({ id: 1, line_items: [] }, 'order_placed'), null);
});

// COD discriminator (J3 trigger). Gateway name is authoritative; financial_status='pending'
// is the fallback (measured ⇔ COD on live data); an explicit prepaid gateway wins over pending.
t('is_cod=true from a COD gateway name', () => {
  const e = mapOrderEvent({ ...base, payment_gateway_names: ['Cash on Delivery (COD)'], financial_status: 'pending' }, 'order_placed');
  assert.equal(e.properties.is_cod, true);
  assert.deepEqual(e.properties.payment_gateway_names, ['Cash on Delivery (COD)']);
});

t('is_cod=false for a prepaid gateway even while pending', () => {
  const e = mapOrderEvent({ ...base, payment_gateway_names: ['Cashfree Payments'], financial_status: 'pending' }, 'order_placed');
  assert.equal(e.properties.is_cod, false);
});

t('is_cod falls back to financial_status=pending when gateways are absent', () => {
  const e = mapOrderEvent({ ...base, financial_status: 'pending' }, 'order_placed');
  assert.equal(e.properties.is_cod, true);
  assert.equal(e.properties.payment_gateway_names, null);
});

t('is_cod=null when neither signal exists (never a false negative)', () => {
  const e = mapOrderEvent({ ...base, financial_status: 'paid' }, 'order_placed');
  assert.equal(e.properties.is_cod, null);
});

t('existing fields are unchanged (regression)', () => {
  const e = mapOrderEvent(base, 'order_placed');
  assert.equal(e.properties.shopify_order_id, '6289680760884');
  assert.equal(e.properties.order_number, 43700);
  assert.equal(e.properties.total, 2099);
  assert.equal(e.properties.currency, 'INR');
  assert.equal(e.name, 'order_placed');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
