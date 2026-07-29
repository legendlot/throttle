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
// Was 'browse events unmapped' — that was the v1 intent and is now SUPERSEDED: browse events
// are deliberately mapped (S233 authored the keys, 2026-07-27 added the live past-tense
// spellings). `store_page_view` remains the ONE deliberate exclusion — ~267k/24d of near-zero
// intent signal — so it is the only thing this guard should still assert is absent.
t('EVENT_MAP covers the decision-driving events; store_page_view stays excluded', () => {
  assert.equal(FLO.EVENT_MAP.checkout_abandoned.event, 'checkout_abandoned');
  assert.equal(FLO.EVENT_MAP.order_completed.event, 'shopflo_order_completed');
  assert.equal(FLO.EVENT_MAP.added_to_cart_ui.event, 'add_to_cart');
  assert.equal(FLO.EVENT_MAP.product_page_viewed.event, 'product_viewed');
  assert.equal(FLO.EVENT_MAP.collection_page_viewed.event, 'collection_viewed');
  assert.equal(FLO.EVENT_MAP.store_page_view, undefined);
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


// ── Cart-token normalisation (2026-07-25, Shopflo started sending it) ──────────────────
// Two silent traps: the wire uses camel `cartToken` while the doc used snake `cart_token`
// (which arrived NULL on every live event), and the value carries Shopify's `?key=` permalink
// suffix. Either one alone makes the stitching key quietly never match.
t('normalizeCartToken strips the ?key= permalink suffix', () => {
  const raw = 'hWNEcGe5qKlOtm1QkMUkF7eG?key=2b56e8f311a84d1995a47852e65416c0';
  assert.equal(FLO.normalizeCartToken(raw), 'hWNEcGe5qKlOtm1QkMUkF7eG');
  // suffixed and bare forms MUST collapse to the same identifier, or they never join
  assert.equal(FLO.normalizeCartToken('hWNEcGe5qKlOtm1QkMUkF7eG'), FLO.normalizeCartToken(raw));
  assert.equal(FLO.normalizeCartToken('  padded?key=x  '), 'padded');
  assert.equal(FLO.normalizeCartToken(''), null);
  assert.equal(FLO.normalizeCartToken(null), null);
  assert.equal(FLO.normalizeCartToken('?key=onlysecret'), null);   // no cart id at all
});

t('cartToken reads BOTH casings and the usual nestings', () => {
  assert.equal(FLO.cartToken({ cartToken: 'abc?key=1' }), 'abc');     // camel (the live shape)
  assert.equal(FLO.cartToken({ cart_token: 'abc' }), 'abc');          // snake (the doc shape)
  assert.equal(FLO.cartToken({ cart: { cartToken: 'nested' } }), 'nested');
  assert.equal(FLO.cartToken({ cart_token: null, cartToken: 'wins' }), 'wins'); // null snake ignored
  assert.equal(FLO.cartToken({}), null);
});

t('cart token rides as a WEAK cart_id identifier, never instead of identity', () => {
  const body = {
    event_name: 'checkout_abandoned',
    cartToken: 'hWNEcGe5qKlOtm1QkMUkF7eG?key=2b56e8f311a84d1995a47852e65416c0',
    customer: { phone: '9876543210', email: 'A@B.com' },
    total_price: 2099,
  };
  const e = FLO.mapCheckoutAbandoned(body);
  const cart = e.identifiers.filter((i) => i.type === 'cart_id');
  assert.equal(cart.length, 1);
  assert.equal(cart[0].value, 'hWNEcGe5qKlOtm1QkMUkF7eG');   // normalised
  assert.equal(cart[0].is_verified, false);                   // weak — identifies a cart, not a person
  // the strong keys are still there and still first
  assert.ok(e.identifiers.some((i) => i.type === 'phone'));
  assert.ok(e.identifiers.some((i) => i.type === 'email'));
  assert.equal(e.properties.cart_token, 'hWNEcGe5qKlOtm1QkMUkF7eG');
});

// The guard that stops us minting weak-only orphans (the 19.7k web_session profiles at 2.2%
// messageable are that lesson). A cart token must never make an anonymous event look identified.
t('a cart token alone does NOT make an anonymous event ingestable', () => {
  assert.equal(FLO.mapCheckoutAbandoned({ cartToken: 'abc?key=1', total_price: 999 }), null);
  assert.equal(FLO.mapAddToCart({ cartToken: 'abc?key=1' }), null);
});

// ── cart_link: the per-customer cart permalink (2026-07-27) ───────────────────────────
// WHY: the add-to-cart recovery template needs a button that reopens the shopper's OWN cart.
// `cart_url_suffix` cannot do it (a Shopflo CHECKOUT token, which does not exist yet at
// add-to-cart — the CR1 failure), and a static /cart depends on the browser cookie, which
// WhatsApp's in-app browser usually does not share. A Shopify cart permalink rebuilds the
// cart from variant ids on ANY device, so it is the only option that actually works here.
// `cart_variant_ids` is present on 100% of live add_to_cart events (44/44 measured).
t('cartLink builds a Shopify cart permalink from variant ids', () => {
  assert.equal(FLO.cartLink('47394784149556'),
    'https://www.legendoftoys.com/cart/47394784149556:1');
});

t('cartLink keeps every line, in order, one unit each', () => {
  // Shopflo gives no quantities, so each variant is requested once — see the qty note in src.
  assert.equal(FLO.cartLink('47294771134516,47907123167284'),
    'https://www.legendoftoys.com/cart/47294771134516:1,47907123167284:1');
});

t('cartLink tolerates spacing and dedupes a repeated variant', () => {
  // A duplicate id would otherwise add the same product twice on open.
  assert.equal(FLO.cartLink(' 111 , 222 , 111 '),
    'https://www.legendoftoys.com/cart/111:1,222:1');
});

t('cartLink returns null when there is nothing to rebuild', () => {
  // Null → the template's own fallback URL applies. Never emit a half-built /cart/ path.
  for (const v of [null, undefined, '', '   ', ',,', 0]) assert.equal(FLO.cartLink(v), null);
});

t('cartLink rejects non-numeric ids rather than pasting them into a URL', () => {
  // Variant ids are numeric; anything else is untrusted vendor input heading into a live link.
  assert.equal(FLO.cartLink('abc'), null);
  assert.equal(FLO.cartLink('47394784149556,../../evil'), 'https://www.legendoftoys.com/cart/47394784149556:1');
});

t('mapAddToCart exposes cart_link for the recovery template button', () => {
  const e = FLO.mapAddToCart(ADDED_TO_CART);
  assert.equal(e.properties.cart_link, 'https://www.legendoftoys.com/cart/55589142888521:1');
});

// A Meta URL button is `static base + ONE trailing {{1}}`, never a whole-URL slot. Binding the
// absolute cart_link to a button would render
// `…/cart/https://www.legendoftoys.com/cart/…` — dead, and it would still PASS Meta review,
// because Meta only ever sees the static base. Hence a separate suffix token.
t('cartLinkSuffix is the button-bindable tail, with no origin', () => {
  assert.equal(FLO.cartLinkSuffix('47394784149556'), '47394784149556:1');
  assert.equal(FLO.cartLinkSuffix('111,222'), '111:1,222:1');
  assert.ok(!String(FLO.cartLinkSuffix('111')).includes('http'));
});

t('cartLinkSuffix is null exactly when cartLink is', () => {
  for (const v of [null, '', '   ', 'abc', '0']) {
    assert.equal(FLO.cartLinkSuffix(v), null, `expected null for ${JSON.stringify(v)}`);
  }
});

t('suffix appended to the authored button base reproduces the absolute link', () => {
  // The invariant that keeps the two tokens honest: base + suffix === cart_link.
  const ids = '47294771134516,47907123167284';
  assert.equal(`https://www.legendoftoys.com/cart/${FLO.cartLinkSuffix(ids)}`, FLO.cartLink(ids));
});

t('mapAddToCart exposes cart_link_suffix alongside the absolute link', () => {
  const e = FLO.mapAddToCart(ADDED_TO_CART);
  assert.equal(e.properties.cart_link_suffix, '55589142888521:1');
});

// ── per-variant header imagery (2026-07-27) ───────────────────────────────────────────
// Shopflo sends NO product_image on add_to_cart (0 of 15 live events), so the WA image
// header always fell back to the generic creative — confirmed on a real journey send:
// Pruthvi added a Mac Gray at 21:43 and the 22:13 message carried the stock cart artwork.
// The title-keyed comms.product_images cache cannot fix it: add_to_cart names are
// VARIANT-level ("... - Tarmac Black") while the catalog holds the PRODUCT title, so only
// 2 of 17 live titles matched. `cart_variant_ids` is the exact key and yields the
// customer's own colourway.
const CATALOG = { products: [
  { title: 'L.O.T Cars Mac - 1:64 Scale Mini RC Car',
    images: [{ src: 'https://cdn/mac-product.webp' }],
    variants: [{ id: 47907665346612, title: 'Gray', featured_image: { src: 'https://cdn/mac-gray.webp' } }] },
  { title: 'L.O.T Cars Shadow - RC Drift Car',
    images: [{ src: 'https://cdn/shadow-product.webp' }],
    variants: [
      { id: 47394784149556, title: 'Tarmac Black', featured_image: { src: 'https://cdn/shadow-tarmac.webp' } },
      { id: 111, title: 'Asphalt Silver', featured_image: null },   // falls back to product image
    ] },
  { title: 'Gift Wrapping', images: [{ src: 'https://cdn/giftwrap.webp' }],
    variants: [{ id: 999, title: 'Default Title', featured_image: null }] },
] };

t('variantImageIndex keys on variant id and composes the cart-style title', () => {
  const ix = FLO.variantImageIndex(CATALOG);
  assert.equal(ix['47907665346612'].image_url, 'https://cdn/mac-gray.webp');
  assert.equal(ix['47907665346612'].title, 'L.O.T Cars Mac - 1:64 Scale Mini RC Car - Gray');
});

t('variantImageIndex falls back to the product image when a variant has none', () => {
  assert.equal(FLO.variantImageIndex(CATALOG)['111'].image_url, 'https://cdn/shadow-product.webp');
});

t("variantImageIndex does not suffix 'Default Title' onto single-variant products", () => {
  // Otherwise the composed title never matches the cart name for single-variant products.
  assert.equal(FLO.variantImageIndex(CATALOG)['999'].title, 'Gift Wrapping');
});

t('pickVariantImage returns the PRIMARY product image, not the first cart line', () => {
  // Gift Wrapping is first in the cart; the customer's actual purchase must headline
  // (same rule that keeps add-ons out of primary_product_name).
  const ix = FLO.variantImageIndex(CATALOG);
  assert.equal(
    FLO.pickVariantImage('999,47394784149556', 'L.O.T Cars Shadow - RC Drift Car - Tarmac Black', ix),
    'https://cdn/shadow-tarmac.webp');
});

t('pickVariantImage falls back to the first known variant when the name does not match', () => {
  const ix = FLO.variantImageIndex(CATALOG);
  assert.equal(FLO.pickVariantImage('47907665346612', 'Something Renamed', ix), 'https://cdn/mac-gray.webp');
});

t('pickVariantImage returns null for unknown or empty ids', () => {
  const ix = FLO.variantImageIndex(CATALOG);
  for (const v of [null, '', '   ', '123456789', 'abc']) {
    assert.equal(FLO.pickVariantImage(v, 'X', ix), null, `expected null for ${JSON.stringify(v)}`);
  }
});

t('pickVariantImage resolves the exact live case that shipped the wrong image', () => {
  // Pruthvi's real 21:43 event: Mac Gray, variant 47907665346612.
  const ix = FLO.variantImageIndex(CATALOG);
  assert.equal(
    FLO.pickVariantImage('47907665346612', 'L.O.T Cars Mac - 1:64 Scale Mini RC Car - Gray', ix),
    'https://cdn/mac-gray.webp');
});

t('mapAddToCart leaves cart_link null when variant ids are absent', () => {
  const e = FLO.mapAddToCart({ ...ADDED_TO_CART, cart_variant_ids: null });
  assert.equal(e.properties.cart_link, null);
});



// ── Shopflo's own event-name list (Pruthvi, 2026-07-25) ───────────────────────────────
// Their list spells it `add_to_cart_ui` (no "ed") and capitalises the browse events, while
// our live wire is lowercase and our original key was `added_to_cart_ui`. The lookup used to
// be exact-match, so a spelling/casing difference would drop a whole event type as UNMAPPED —
// captured, never ingested, and invisible until someone asked why a journey never fired.
t('lookupEvent tolerates the add_to_cart_ui / added_to_cart_ui spelling split', () => {
  assert.equal(FLO.lookupEvent('added_to_cart_ui').event, 'add_to_cart');
  assert.equal(FLO.lookupEvent('add_to_cart_ui').event, 'add_to_cart');
});

t('lookupEvent folds case (their list reads Product_page_view)', () => {
  assert.equal(FLO.lookupEvent('Product_page_view').event, 'product_viewed');
  assert.equal(FLO.lookupEvent('Collection_page_view').event, 'collection_viewed');
  assert.equal(FLO.lookupEvent('Checkout_clicked').event, 'checkout_started');
  // Their list writes it `Abandoned_checkout`; the live wire sends `checkout_abandoned`.
  // Both must resolve — we do not know which spelling a given event type will use.
  assert.equal(FLO.lookupEvent('Abandoned_checkout').event, 'checkout_abandoned');
  assert.equal(FLO.lookupEvent('checkout_abandoned').event, 'checkout_abandoned');
  assert.equal(FLO.lookupEvent(''), null);
  assert.equal(FLO.lookupEvent(null), null);
});

t('browse mapper carries identity + product context + cart token', () => {
  const e = FLO.mapBrowse('product_viewed')({
    event_name: 'Product_page_view',
    userData: { phone: '9876543210', email: 'B@C.com' },
    product_name: 'L.O.T Cars Dash', product_id: '15510899228745',
    cartToken: 'tok123?key=secret', timestamp: '2026-07-25T10:00:00Z',
  });
  assert.equal(e.name, 'product_viewed');
  assert.equal(e.properties.product_name, 'L.O.T Cars Dash');
  assert.equal(e.properties.cart_token, 'tok123');
  assert.equal(e.properties.source_surface, 'shopflo');   // distinguishes from the pixel's copy
  assert.ok(e.identifiers.some((i) => i.type === 'phone'));
  assert.ok(e.identifiers.some((i) => i.type === 'cart_id' && i.value === 'tok123'));
});

// The volume guard. Product page views are Shopflo's highest-volume event (~90.8k/24d in their
// own analytics); ingesting anonymous ones would flood the substrate with unreachable profiles.
t('browse mapper DROPS anonymous page views (no strong identity)', () => {
  assert.equal(FLO.mapBrowse('product_viewed')({ product_name: 'X', cartToken: 'tok' }), null);
  assert.equal(FLO.mapBrowse('collection_viewed')({ collection_name: 'Drift' }), null);
});

// The payload guard (2026-07-29). Shopflo sends ~2.5% of product_page_view events with an
// identified user but EVERY product field null. The identity guard above lets those through, so
// we were emitting "someone viewed a product" events naming no product — Browse Abandonment
// enrolled on them, slept 30 minutes, then failed the send (14 of 95) on
// `unresolved_variables:product_handle`.
t('browse mapper DROPS a product_viewed with an identified user but NO product at all', () => {
  const empty = FLO.mapBrowse('product_viewed')({
    userData: { phone: '9876543210' }, cartToken: 'tok123',
    // exactly the live shape: identity present, product entirely absent
  });
  assert.equal(empty, null, 'a product view naming no product must not be emitted');
});

t('the guard is scoped to product_viewed — collection + checkout still map without a product', () => {
  const coll = FLO.mapBrowse('collection_viewed')({
    userData: { phone: '9876543210' }, collection_name: 'Drift Cars', cartToken: 'tok123' });
  assert.ok(coll && coll.name === 'collection_viewed', 'collection views legitimately have no product');
  const chk = FLO.mapBrowse('checkout_started')({
    userData: { phone: '9876543210' }, cartToken: 'tok123' });
  assert.ok(chk && chk.name === 'checkout_started', 'checkout_started legitimately has no product');
});

t('a product_viewed with ANY product signal still maps (guard is not over-tightened)', () => {
  // Live data has zero of these, but dropping real signal would be worse than the bug —
  // so a partially-populated event must survive.
  const partial = FLO.mapBrowse('product_viewed')({
    userData: { phone: '9876543210' }, product_name: 'L.O.T Cars Dash', cartToken: 'tok123' });
  assert.ok(partial && partial.name === 'product_viewed');
  assert.equal(partial.properties.product_name, 'L.O.T Cars Dash');
});


// Shopflo's five named events (Pruthvi, 2026-07-25) must ALL resolve. This is the coverage
// guard: if someone renames a key, this fails instead of a journey quietly never firing.
t('all 5 Shopflo event names resolve to a mapped event', () => {
  const expected = {
    // As DOCUMENTED by Pruthvi 2026-07-25 …
    'Product_page_view': 'product_viewed',
    'Collection_page_view': 'collection_viewed',
    'add_to_cart_ui': 'add_to_cart',
    'Checkout_clicked': 'checkout_started',
    'Abandoned_checkout': 'checkout_abandoned',
    // … and as ACTUALLY SENT on the wire 2026-07-27 (past tense — 19 identity-bearing browse
    // events were dropped as UNMAPPED before these two keys existed). Both spellings stay.
    'product_page_viewed': 'product_viewed',
    'collection_page_viewed': 'collection_viewed',
    'added_to_cart_ui': 'add_to_cart',
    'checkout_abandoned': 'checkout_abandoned',
  };
  for (const [wire, want] of Object.entries(expected)) {
    const spec = FLO.lookupEvent(wire);
    assert.ok(spec, `unmapped Shopflo event: ${wire}`);
    assert.equal(spec.event, want, `${wire} should map to ${want}`);
  }
});

// The Browse Abandonment template binds `product_handle` with NO fallback and an IMAGE header
// that fails closed on a missing link — so a browse event that carries neither cannot send.
// This asserts both come off the REAL wire shape captured 2026-07-27.
t('browse mapper extracts handle + image from the live Shopflo wire shape', () => {
  const spec = FLO.lookupEvent('product_page_viewed');
  const out = spec.map({
    event_name: 'product_page_viewed',
    phone: '+918287063949',
    session_id: 'd256c89a',
    timestamp: 1785152871573,
    data: {
      user_data: { phone: '+918287063949', userId: '30cf64c5' },
      product_url: 'https://www.legendoftoys.com/products/l-o-t-aviation-wisp?utm_source=fb',
      product_name: 'L.O.T Aviation Wisp',
      product_image: 'https://cdn.shopify.com/s/files/1/x/Asset_1.webp?v=1784630969',
      product_price: '3999.00',
      product_type: 'Aviation',
    },
  });
  assert.ok(out, 'identity-bearing browse event must map');
  assert.equal(out.name, 'product_viewed');
  assert.equal(out.properties.product_handle, 'l-o-t-aviation-wisp');
  // cdnImage constrains width so the header stays under WhatsApp's 5MB media limit (131053).
  assert.equal(out.properties.product_image_url, 'https://cdn.shopify.com/s/files/1/x/Asset_1.webp?v=1784630969&width=1200');
  assert.equal(out.properties.product_name, 'L.O.T Aviation Wisp');
  assert.equal(out.properties.price, 3999);
  assert.ok(out.identifiers.some((i) => i.type === 'phone'), 'phone identifier must be extracted');
});

// Shopflo sends add_to_cart totals in PAISE but checkout_abandoned totals in RUPEES (measured
// 2026-07-27). A template binding the raw value would render "₹219900" to a customer.
t('add_to_cart total is normalised to rupees; raw paise preserved', () => {
  const spec = FLO.lookupEvent('add_to_cart_ui');
  const out = spec.map({
    event_name: 'add_to_cart_ui',
    phone: '+919876543210',
    session_id: 's1',
    timestamp: 1785152871573,
    currency: 'INR',
    total_price: 219900,
    cart_product_names: 'L.O.T Cars Shadow - RC Drift Car - Tarmac Black',
  });
  assert.ok(out, 'identity-bearing add_to_cart must map');
  assert.equal(out.properties.total_price, 219900, 'raw value preserved as received');
  assert.equal(out.properties.total, 2199, 'normalised to rupees');
  assert.equal(out.properties.total_display, '₹2,199');
  assert.equal(out.properties.primary_product_name, 'L.O.T Cars Shadow - RC Drift Car - Tarmac Black');
});

// Add-ons must never headline a cart message (the live Gift Wrapping case).
t('add_to_cart orders add-ons last for display', () => {
  const spec = FLO.lookupEvent('add_to_cart_ui');
  const out = spec.map({
    event_name: 'add_to_cart_ui',
    phone: '+919876543210',
    session_id: 's2',
    timestamp: 1785152871573,
    total_price: 504800,
    cart_product_names: 'Gift Wrapping,L.O.T Car Vortex - RC Drift Car - Overdrive Yellow',
  });
  assert.ok(out);
  assert.equal(out.properties.primary_product_name, 'L.O.T Car Vortex - RC Drift Car - Overdrive Yellow');
  assert.equal(out.properties.total_display, '₹5,048');
});

// WhatsApp rejects header media >5MB (error 131053). Shopify originals hit 25MB; the CDN
// resizes on demand, so we constrain width at map time. MEASURED: 25.24MB -> 1.72MB at w=1200.
t('cdnImage constrains Shopify CDN images and leaves others alone', () => {
  const big = 'https://cdn.shopify.com/s/files/1/0669/4721/9508/files/underground_blue_1.webp?v=1784635763';
  assert.equal(FLO.cdnImage(big), big + '&width=1200');
  // no query string
  assert.equal(FLO.cdnImage('https://cdn.shopify.com/s/files/x.png'), 'https://cdn.shopify.com/s/files/x.png?width=1200');
  // already constrained — do not double-append
  const done = 'https://cdn.shopify.com/s/files/x.png?width=800';
  assert.equal(FLO.cdnImage(done), done);
  // non-Shopify host untouched (cannot assume it honours `width`)
  const other = 'https://images.example.com/a.jpg?v=1';
  assert.equal(FLO.cdnImage(other), other);
  assert.equal(FLO.cdnImage(null), null);
});

// A collection view has no product URL — it must NOT invent a handle.
t('collection view yields no product_handle', () => {
  const spec = FLO.lookupEvent('collection_page_viewed');
  const out = spec.map({
    event_name: 'collection_page_viewed',
    session_id: 'abc',
    timestamp: 1785152871573,
    data: {
      user_data: { phone: '+919446792900', email: 'x@example.com' },
      page_url: 'https://www.legendoftoys.com/collections/all?utm_source=fb',
      collection_page_url: '/collections/all',
    },
  });
  assert.ok(out, 'identity-bearing collection view must map');
  assert.equal(out.name, 'collection_viewed');
  assert.equal(out.properties.product_handle, null);
  assert.equal(out.properties.collection_url, '/collections/all');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
