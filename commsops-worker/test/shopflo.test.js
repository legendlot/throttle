// Node unit tests for the Shopflo (Shop Pass) webhook mappers (S212).
// Run: node test/shopflo.test.js   (Node 18+). Pure functions, no network.
// Payloads are shaped after Shopflo's "Shop Pass Webhook Events" doc (2026-07-15).

const assert = require('assert');
const FLO = require('../src/shopflo.js');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n        ', e.message); } }

// ── sample payloads (doc-shaped, concrete values) ──
const CHECKOUT_ABANDONED = {
  event_name: 'checkout_abandoned',
  session_id: 'sess-1', checkout_id: 'chk_abc', token_id: 'https://checkout.shopflo.co/?tokenId=chk_abc',
  source: 'shopflo', cart_token: 'cart_abc',
  email: 'top@buyer.com', phone: '+919000000000',
  created_at: '2026-05-27T10:00:00.000000Z', updated_at: '2026-05-27T10:06:00.000000Z',
  note_attributes: [
    { name: 'landing_page', value: '/products/ghost' },
    { name: 'shopflo_checkout_url', value: 'https://checkout.shopflo.co/?tokenId=chk_abc' },
    { name: 'cart_token', value: 'cart_abc' },
  ],
  line_items: [{ price: '799.00', id: '1', quantity: 1, title: 'A' }, { price: '1599.00', id: '2', quantity: 1, title: 'B' }],
  cart_product_names: 'A,B',
  customer: { uid: 'flo-uid-1', email: null, first_name: 'Riya', last_name: 'K', phone: '+919123456789', marketing_consent: true },
  currency: 'INR', subtotal_price: 2398, total_discount: 0, total_tax: 256.92, total_price: 2398, timestamp: 1779700813605,
};

const ORDER_COMPLETED = {
  event_name: 'order_completed', session_id: 'sess-2', token_id: 'tok-2', source: 'shopflo',
  email: 'buyer@gmail.com', phone: '+919812345678',
  created_at: '2026-05-27T10:01:19.419291Z',
  line_items: [{ price: '749.95', id: '55', quantity: 3, title: 'Snowboard' }],
  customer: { uid: 'flo-uid-2', email: 'buyer@gmail.com', first_name: 'Sam', last_name: 'P', phone: '+919812345678', marketing_consent: true },
  currency: 'INR', subtotal_price: 2249.85, total_shipping: 379, total_tax: 404.97,
  total_price: 2628.85, total_payable: 2628.85, discount_codes: [], payment_mode: 'COD', pg_type: '',
  timestamp: 1779876969665, order_id: 12121212121212, order_name: '#1002',
};

const ADDED_TO_CART = {
  event_name: 'added_to_cart_ui', session_id: 'sess-3', source: 'shopflo',
  line_items: [{ title: 'Snowboard', quantity: 2, price: 74995 }],
  cart_variant_ids: '55589142888521', cart_product_ids: '15510899228745', cart_product_names: 'Snowboard',
  currency: 'INR', total_price: 149990,
  user_data: { userId: 'flo-uid-3', phone: '+919777777777', email: 'cart@gmail.com', firstName: 'Cart', lastName: '' },
  timestamp: 1779876657975,
};

const STORE_PAGE_VIEW = {
  eventName: 'store_page_view', channel: 'web', timestamp: 1776854381425,
  eventPayload: { userData: { userId: 'flo-uid-4', phone: '+919666666666', email: 'view@ymail.com', firstName: '', lastName: '' } },
};

// ── eventName (snake + camel) ──
t('eventName reads snake + camel', () => {
  assert.equal(FLO.eventName(CHECKOUT_ABANDONED), 'checkout_abandoned');
  assert.equal(FLO.eventName(STORE_PAGE_VIEW), 'store_page_view');
  assert.equal(FLO.eventName({}), null);
});

// ── pickIdentity across the varying shapes ──
t('pickIdentity top-level wins over customer', () => {
  const id = FLO.pickIdentity(CHECKOUT_ABANDONED);
  assert.equal(id.email, 'top@buyer.com');   // customer.email was null
  assert.equal(id.phone, '+919000000000');
  assert.equal(id.first_name, 'Riya');        // falls through to customer{}
});
t('pickIdentity from user_data', () => {
  const id = FLO.pickIdentity(ADDED_TO_CART);
  assert.equal(id.email, 'cart@gmail.com');
  assert.equal(id.phone, '+919777777777');
});
t('pickIdentity from eventPayload.userData (store_page_view)', () => {
  const id = FLO.pickIdentity(STORE_PAGE_VIEW);
  assert.equal(id.email, 'view@ymail.com');
  assert.equal(id.phone, '+919666666666');
});

// ── identifiers ──
t('identsFromShopflo yields email + normalized phone, no uid', () => {
  const ids = FLO.identsFromShopflo(CHECKOUT_ABANDONED);
  assert.deepEqual(ids.map((i) => i.type).sort(), ['email', 'phone']);
  assert.equal(ids.find((i) => i.type === 'email').value, 'top@buyer.com');
  assert.equal(ids.find((i) => i.type === 'phone').value, '+919000000000');
  assert.ok(ids.every((i) => i.is_verified === false));
});
t('no identifier → mapper returns null', () => {
  assert.equal(FLO.mapCheckoutAbandoned({ event_name: 'checkout_abandoned', customer: {} }), null);
});

// ── checkout_abandoned mapper ──
t('mapCheckoutAbandoned shape + checkout_url + idem + consent-in-props', () => {
  const e = FLO.mapCheckoutAbandoned(CHECKOUT_ABANDONED);
  assert.equal(e.name, 'checkout_abandoned');
  assert.equal(e.source, 'shopflo');
  assert.equal(e.idempotency_key, 'shopflo:checkout_abandoned:chk_abc');
  assert.equal(e.occurred_at, '2026-05-27T10:06:00.000Z'); // updated_at preferred
  assert.equal(e.properties.checkout_url, 'https://checkout.shopflo.co/?tokenId=chk_abc');
  assert.equal(e.properties.line_item_count, 2);
  assert.equal(e.properties.total_price, 2398);
  assert.equal(e.properties.marketing_consent, true);
});

// ── order_completed mapper (→ shopflo_order_completed, COD) ──
t('mapOrderCompleted emits shopflo_order_completed w/ payment_mode + idem', () => {
  const e = FLO.mapOrderCompleted(ORDER_COMPLETED);
  assert.equal(e.name, 'shopflo_order_completed'); // NOT order_placed (no double-count)
  assert.equal(e.properties.payment_mode, 'COD');
  assert.equal(e.properties.order_name, '#1002');
  assert.equal(e.properties.shopflo_order_id, '12121212121212');
  assert.equal(e.idempotency_key, 'shopflo:order_completed:12121212121212');
  assert.equal(e.occurred_at, '2026-05-27T10:01:19.419Z');
});

// ── added_to_cart mapper ──
t('mapAddToCart emits add_to_cart from user_data', () => {
  const e = FLO.mapAddToCart(ADDED_TO_CART);
  assert.equal(e.name, 'add_to_cart');
  assert.equal(e.identifiers.find((i) => i.type === 'email').value, 'cart@gmail.com');
  assert.equal(e.idempotency_key, 'shopflo:add_to_cart:sess-3:1779876657975');
});

// ── EVENT_MAP dispatch ──
t('EVENT_MAP maps only v1 events; browse events unmapped', () => {
  assert.equal(FLO.EVENT_MAP.checkout_abandoned.event, 'checkout_abandoned');
  assert.equal(FLO.EVENT_MAP.order_completed.event, 'shopflo_order_completed');
  assert.equal(FLO.EVENT_MAP.added_to_cart_ui.event, 'add_to_cart');
  assert.equal(FLO.EVENT_MAP.store_page_view, undefined);
  assert.equal(FLO.EVENT_MAP.product_page_viewed, undefined);
});

// ── consent rows ──
t('consentRowsFrom true → opted_in email + whatsapp', () => {
  const rows = FLO.consentRowsFrom(CHECKOUT_ABANDONED, '2026-05-27T10:06:00.000Z');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.channel).sort(), ['email', 'whatsapp']);
  assert.ok(rows.every((r) => r.state === 'opted_in' && r.purpose === 'marketing' && r.source === 'shopflo'));
});
t('consentRowsFrom false → opted_out', () => {
  const b = { ...ORDER_COMPLETED, customer: { ...ORDER_COMPLETED.customer, marketing_consent: false } };
  const rows = FLO.consentRowsFrom(b, null);
  assert.ok(rows.length === 2 && rows.every((r) => r.state === 'opted_out'));
});
t('consentRowsFrom absent → [] (leave gate default block)', () => {
  const b = { ...ORDER_COMPLETED, customer: { ...ORDER_COMPLETED.customer, marketing_consent: undefined } };
  assert.deepEqual(FLO.consentRowsFrom(b, null), []);
});

// ── display derivations for the cart-contents template (v2) ──
t('inrGroup Indian grouping', () => {
  assert.equal(FLO.inrGroup(2099), '2,099');
  assert.equal(FLO.inrGroup(999), '999');
  assert.equal(FLO.inrGroup(129999), '1,29,999');
  assert.equal(FLO.inrGroup(1994.05), '1,994');
  assert.equal(FLO.inrGroup(null), null);
  assert.equal(FLO.inrGroup('garbage'), null);
});
t('shortNames single item passes through', () => {
  assert.equal(FLO.shortNames('L.O.T Cars Ghost - RC Drift Car'), 'L.O.T Cars Ghost - RC Drift Car');
});
t('shortNames truncates at comma boundary with +N more', () => {
  const names = 'L.O.T Cars Ghost - RC Drift Car, L.O.T Cars Flare 2.0 - RC Drift Car, L.O.T Cars Knox - Off-Road RC Truck, L.O.T Cars Shadow - RC Drift Car';
  const out = FLO.shortNames(names);
  assert.ok(out.length <= 110 + ' +9 more'.length);
  assert.ok(/\+\d+ more$/.test(out), out);
  assert.ok(out.startsWith('L.O.T Cars Ghost'));
});
t('shortNames keeps oversized first item hard-sliced', () => {
  const out = FLO.shortNames('X'.repeat(200) + ', Y');
  assert.ok(out.length <= 110 + ' +1 more'.length);
  assert.ok(out.includes('…'));
});
t('shortNames null on empty', () => { assert.equal(FLO.shortNames(''), null); });
t('mapCheckoutAbandoned carries product_names_short (value-ordered) + total_display', () => {
  const e = FLO.mapCheckoutAbandoned(CHECKOUT_ABANDONED);
  // fixture line_items: A ₹799, B ₹1599 → B headlines (display order = line value desc)
  assert.equal(e.properties.product_names_short, 'B, A');
  assert.equal(e.properties.total_display, '₹2,398');
});

// ── v3 image-header slots: button suffix + payload image ──
t('checkoutUrlSuffix strips the fixed Shopflo base', () => {
  assert.equal(
    FLO.checkoutUrlSuffix('https://checkout.shopflo.co/stable/?tokenId=abc&checkout_type=ABANDONED'),
    '?tokenId=abc&checkout_type=ABANDONED');
});
t('checkoutUrlSuffix null on foreign/absent URL (fail-loud path)', () => {
  assert.equal(FLO.checkoutUrlSuffix('https://elsewhere.example/x'), null);
  assert.equal(FLO.checkoutUrlSuffix(null), null);
  assert.equal(FLO.checkoutUrlSuffix('https://checkout.shopflo.co/stable/'), null);
});
t('payloadImageUrl scans line_items image shapes (single item)', () => {
  assert.equal(FLO.payloadImageUrl({ line_items: [{ image_url: 'https://cdn.x/a.webp' }] }), 'https://cdn.x/a.webp');
  assert.equal(FLO.payloadImageUrl({ line_items: [{ image: { src: 'https://cdn.x/b.webp' } }] }), 'https://cdn.x/b.webp');
  // cart_product_images fallback REMOVED by design (index-0 add-on risk) — cache resolves instead
  assert.equal(FLO.payloadImageUrl({ cart_product_images: ['https://cdn.x/c.webp'] }), null);
  assert.equal(FLO.payloadImageUrl({ line_items: [{ image: 'not-a-url' }] }), null);
  assert.equal(FLO.payloadImageUrl({}), null);
});
t('orderedNames: add-on last, highest line value first', () => {
  const items = [
    { title: 'Gift Wrapping', price: '49.00', quantity: 1 },
    { title: 'L.O.T Cars Shadow - RC Drift Car', price: '2199.00', quantity: 1 },
    { title: 'L.O.T Spare Parts - Battery pack for L.O.T Cars Flare/Bumble/Ghost', price: '499.00', quantity: 1 },
  ];
  assert.equal(
    FLO.orderedNames('Gift Wrapping,L.O.T Cars Shadow - RC Drift Car,L.O.T Spare Parts - Battery pack for L.O.T Cars Flare/Bumble/Ghost', items),
    'L.O.T Cars Shadow - RC Drift Car, L.O.T Spare Parts - Battery pack for L.O.T Cars Flare/Bumble/Ghost, Gift Wrapping');
});
t('orderedNames: no prices still demotes the add-on', () => {
  assert.equal(FLO.orderedNames('Gift Wrapping,L.O.T Cars Shadow - RC Drift Car', null),
    'L.O.T Cars Shadow - RC Drift Car, Gift Wrapping');
});
t('payloadImageUrl picks the PRIMARY item image, not item[0]', () => {
  const body = { line_items: [
    { title: 'Gift Wrapping', price: '49.00', quantity: 1, image_url: 'https://cdn.x/gift.avif' },
    { title: 'L.O.T Cars Shadow - RC Drift Car', price: '2199.00', quantity: 1, image_url: 'https://cdn.x/shadow.webp' },
  ] };
  assert.equal(FLO.payloadImageUrl(body, 'L.O.T Cars Shadow - RC Drift Car'), 'https://cdn.x/shadow.webp');
  // no primaryName → value sort still lands on the car
  assert.equal(FLO.payloadImageUrl(body, null), 'https://cdn.x/shadow.webp');
});
t('payloadImageUrl: primary item without an image → null (cache resolves), never the add-on image', () => {
  const body = { line_items: [
    { title: 'Gift Wrapping', price: '49.00', quantity: 1, image_url: 'https://cdn.x/gift.avif' },
    { title: 'L.O.T Cars Shadow - RC Drift Car', price: '2199.00', quantity: 1 },
  ] };
  assert.equal(FLO.payloadImageUrl(body, 'L.O.T Cars Shadow - RC Drift Car'), null);
});
t('mapCheckoutAbandoned: gift-wrap cart → car headlines, primary_product_name set', () => {
  const b = { ...CHECKOUT_ABANDONED,
    cart_product_names: 'Gift Wrapping,L.O.T Cars Shadow - RC Drift Car',
    line_items: [
      { title: 'Gift Wrapping', price: '49.00', quantity: 1, image_url: 'https://cdn.x/gift.avif' },
      { title: 'L.O.T Cars Shadow - RC Drift Car', price: '2199.00', quantity: 1, image_url: 'https://cdn.x/shadow.webp' },
    ] };
  const e = FLO.mapCheckoutAbandoned(b);
  assert.equal(e.properties.product_names_short, 'L.O.T Cars Shadow - RC Drift Car, Gift Wrapping');
  assert.equal(e.properties.primary_product_name, 'L.O.T Cars Shadow - RC Drift Car');
  assert.equal(e.properties.product_image_url, 'https://cdn.x/shadow.webp');
});

t('mapCheckoutAbandoned carries checkout_url_suffix (null when base differs)', () => {
  const e = FLO.mapCheckoutAbandoned(CHECKOUT_ABANDONED);
  // fixture's checkout_url is the doc shape (not /stable/) → suffix null by design
  assert.equal(e.properties.checkout_url_suffix, null);
  const b2 = { ...CHECKOUT_ABANDONED, note_attributes: [{ name: 'shopflo_checkout_url', value: 'https://checkout.shopflo.co/stable/?tokenId=t1&checkout_type=ABANDONED' }] };
  const e2 = FLO.mapCheckoutAbandoned(b2);
  assert.equal(e2.properties.checkout_url_suffix, '?tokenId=t1&checkout_type=ABANDONED');
});

// ── display name (Shop Pass identity → profile greeting backfill) ──
t('displayName prefers FIRST name (Shopify-mapper parity: first || full)', () => {
  assert.equal(FLO.displayName(CHECKOUT_ABANDONED), 'Riya');
});
t('displayName falls back to last name when first missing', () => {
  const b = { ...CHECKOUT_ABANDONED, customer: { ...CHECKOUT_ABANDONED.customer, first_name: null } };
  assert.equal(FLO.displayName(b), 'K');
});
t('displayName null when no name anywhere', () => {
  const b = { ...CHECKOUT_ABANDONED, customer: { ...CHECKOUT_ABANDONED.customer, first_name: null, last_name: '' } };
  assert.equal(FLO.displayName(b), null);
});
t('displayName reads camelCase userData (store_page_view shape)', () => {
  assert.equal(FLO.displayName({ eventName: 'store_page_view', eventPayload: { userData: { firstName: 'Aman', lastName: 'S' } } }), 'Aman');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
