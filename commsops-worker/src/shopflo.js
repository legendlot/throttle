// Shopflo (Shop Pass) webhook mappers — PURE + unit-testable (no I/O here).
// Shopflo is LOT's checkout layer; its "Shop Pass Webhook Events" feed carries the
// phone/email identity + cart + payment_mode that Shopify's own pixel/webhooks do NOT
// surface. These mappers turn a Shopflo event body into the internal /ingest envelope
// (same shape the Shopify mappers produce) so identity resolution / idempotency / the
// journey-trigger fan-out are all reused unchanged.
//
// Schema notes (from Shopflo's Shop Pass Webhook Events doc, 2026-07-15):
//  - Most events are snake_case + flat with `event_name`; `store_page_view` is the odd
//    one — camelCase `eventName` + a nested `eventPayload`. eventName(body) reads both.
//  - Identity lives in a DIFFERENT place per event: top-level phone/email, `customer{}`,
//    `user_data{}`, `data.user_data{}`, or `eventPayload.userData{}`. pickIdentity scans
//    all of them, first-non-empty-wins.
//  - `customer.marketing_consent` (bool) on checkout_abandoned + order_completed is the
//    consent signal — mapped to the consent ledger by the handler (opt-in vs opt-out).
//  - The doc's own disclaimer says these payloads may not match the live wire shape, so
//    the handler still captures any UNMAPPED / errored event to comms.webhook_captures.
const SHOP = require('./shopify.js'); // reuse normalizePhone (E.164, +91 default)

// Shopflo event name — snake `event_name`, or camel `eventName` (store_page_view).
function eventName(body) {
  return (body && (body.event_name || body.eventName)) || null;
}

function firstNonEmpty(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== '') return v;
  return null;
}

// Scan every place Shopflo stashes contact fields; first non-empty wins.
function pickIdentity(body) {
  const b = body || {};
  const c = [
    b,
    b.customer,
    b.user_data,
    b.userData,
    b.data && b.data.user_data,
    b.eventPayload && b.eventPayload.userData,
  ].filter(Boolean);
  const get = (k1, k2) => firstNonEmpty(...c.map((o) => o[k1] || (k2 && o[k2])));
  return {
    email: get('email'),
    phone: get('phone'),
    first_name: get('first_name', 'firstName'),
    last_name: get('last_name', 'lastName'),
    uid: get('uid', 'userId'),
  };
}

// Contact-derived identifiers (weak is_verified — off the transaction, not a customer
// record). Shopflo's own uid is stashed in properties, NOT used as an identifier (its
// semantics differ per event — using it to merge would be unsafe).
function identsFromShopflo(body) {
  const id = pickIdentity(body);
  const out = [];
  if (id.email) out.push({ type: 'email', value: String(id.email).toLowerCase().trim(), is_verified: false });
  const ph = SHOP.normalizePhone(id.phone);
  if (ph) out.push({ type: 'phone', value: ph, is_verified: false });
  return out;
}

function displayName(body) {
  // Mirrors the Shopify customer mapper's `first || full` preference — display_name is
  // what template greetings bind ("Hi {first_name}"), so a bare first name beats
  // "Firstname Lastname" and the two feeds must agree on semantics.
  const id = pickIdentity(body);
  const first = String(id.first_name || '').trim();
  if (first) return first;
  const last = String(id.last_name || '').trim();
  return last || null;
}

function noteAttr(body, name) {
  const arr = Array.isArray(body && body.note_attributes) ? body.note_attributes : [];
  const hit = arr.find((n) => n && n.name === name);
  return hit ? hit.value : null;
}

function num(v) { const n = Number(v); return isFinite(n) ? n : null; }

// Indian-grouped integer string ("2,099", "1,29,999"). The render engine has no
// transforms, so display-ready values must be derived at MAP time.
function inrGroup(v) {
  if (v == null || v === '') return null;   // NB num(null) is 0 — a null total must NOT read "₹0"
  const n = num(v);
  if (n == null) return null;
  const s = String(Math.round(Math.abs(n)));
  const neg = n < 0 ? '-' : '';
  if (s.length <= 3) return neg + s;
  return neg + s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + s.slice(-3);
}

// Cart product names truncated at a comma boundary (WA template bodies cap at 1024
// chars AFTER substitution — a long multi-item cart string can fail the send). Always
// keeps the first item (hard-sliced if itself over budget), then whole names while
// they fit, then "+N more".
function shortNames(names, max = 110) {
  const parts = String(names || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  let out = parts[0].length > max ? parts[0].slice(0, max - 1) + '…' : parts[0];
  let used = 1;
  for (let i = 1; i < parts.length; i++) {
    const cand = `${out}, ${parts[i]}`;
    if (cand.length > max) break;
    out = cand; used++;
  }
  const rest = parts.length - used;
  return rest > 0 ? `${out} +${rest} more` : out;
}

// ms-epoch or ISO string → ISO string; null if neither.
function toIso(v) {
  if (!v) return null;
  if (typeof v === 'number') { const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString(); }
  const s = String(v);
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toISOString();
}

// The Shopflo checkout resume URL's fixed prefix. Meta URL buttons allow ONE trailing
// {{1}} on a static base, so the cart template's "Complete Purchase" button is
// `<base>{{1}}` and the send binds only the suffix. A checkout_url off this base yields
// null → the send-time variable is deliberately UNRESOLVED (no fallback) → the send
// fails loud and the journey health alert fires — the correct behaviour if Shopflo ever
// changes its URL shape (a silent homepage button would be worse).
const SHOPFLO_CHECKOUT_BASE = 'https://checkout.shopflo.co/stable/';
function checkoutUrlSuffix(url) {
  const s = String(url || '');
  if (!s.startsWith(SHOPFLO_CHECKOUT_BASE)) return null;
  return s.slice(SHOPFLO_CHECKOUT_BASE.length) || null;
}

// Best-effort product image from the payload itself (the doc doesn't promise one; scan
// the plausible spots). The handler falls back to the comms.product_images catalog cache.
function payloadImageUrl(body) {
  const li = Array.isArray(body?.line_items) ? body.line_items[0] : null;
  const cands = [li?.image_url, li?.image, li?.featured_image, li?.product_image,
    Array.isArray(body?.cart_product_images) ? body.cart_product_images[0] : null];
  for (const c of cands) {
    const s = typeof c === 'string' ? c : (c && typeof c === 'object' ? c.src : null);
    if (s && /^https?:\/\//.test(s)) return s;
  }
  return null;
}

// checkout_abandoned → the abandoned-cart signal (event name `checkout_abandoned`,
// already a registered event def). checkout_url is threaded so the recovery journey
// can deep-link back into the Shopflo checkout.
function mapCheckoutAbandoned(body) {
  const identifiers = identsFromShopflo(body);
  if (!identifiers.length) return null;
  const checkoutUrl = firstNonEmpty(
    noteAttr(body, 'shopflo_checkout_url'),
    (typeof body.token_id === 'string' && body.token_id.startsWith('http')) ? body.token_id : null,
    body.abandoned_checkout_url,
  );
  const key = firstNonEmpty(body.checkout_id, body.cart_token, body.session_id) || '';
  const props = {
    checkout_id: body.checkout_id || null,
    cart_token: body.cart_token || null,
    checkout_url: checkoutUrl || null,
    currency: body.currency || null,
    subtotal_price: num(body.subtotal_price),
    total_price: num(body.total_price),
    total: num(body.total_price),
    total_discount: num(body.total_discount),
    total_tax: num(body.total_tax),
    line_item_count: Array.isArray(body.line_items) ? body.line_items.length : null,
    product_names: body.cart_product_names || null,
    // Display-ready derivations for template slots (the cart-contents WA templates
    // bind these; raw product_names/total_price stay for analytics):
    product_names_short: shortNames(body.cart_product_names),
    total_display: inrGroup(body.total_price) != null ? `₹${inrGroup(body.total_price)}` : null,
    // v3 image-header template slots: the CTA button suffix + (if the payload carries
    // one) the cart product's image. The handler backfills product_image_url from the
    // comms.product_images catalog cache when the payload has none.
    checkout_url_suffix: checkoutUrlSuffix(checkoutUrl),
    product_image_url: payloadImageUrl(body),
    marketing_consent: (body.customer && body.customer.marketing_consent) ?? null,
    source_surface: 'shopflo',
  };
  return {
    identifiers, name: 'checkout_abandoned',
    occurred_at: toIso(firstNonEmpty(body.updated_at, body.created_at, body.timestamp)),
    properties: props, source: 'shopflo',
    idempotency_key: `shopflo:checkout_abandoned:${key}`,
  };
}

// order_completed → `shopflo_order_completed` (NOT `order_placed` — Shopify's
// orders/create already emits order_placed + bumps lifetime; reusing it here would
// double-count). Its value is the Shop Pass identity + `payment_mode` (COD detection
// for the COD→prepaid journey — a journey can trigger.filter {payment_mode:'COD'}).
function mapOrderCompleted(body) {
  const identifiers = identsFromShopflo(body);
  if (!identifiers.length) return null;
  const oid = body.order_id != null ? String(body.order_id) : (body.order_name || body.token_id || '');
  const props = {
    shopflo_order_id: body.order_id != null ? String(body.order_id) : null,
    order_name: body.order_name || null,
    payment_mode: body.payment_mode || null,
    pg_type: body.pg_type || null,
    currency: body.currency || null,
    subtotal_price: num(body.subtotal_price),
    total_price: num(body.total_price),
    total: num(body.total_price),
    total_payable: num(body.total_payable),
    total_discount: num(body.total_discount),
    total_shipping: num(body.total_shipping),
    total_tax: num(body.total_tax),
    line_item_count: Array.isArray(body.line_items) ? body.line_items.length : null,
    discount_codes: Array.isArray(body.discount_codes) ? body.discount_codes : null,
    marketing_consent: (body.customer && body.customer.marketing_consent) ?? null,
    source_surface: 'shopflo',
  };
  return {
    identifiers, name: 'shopflo_order_completed',
    occurred_at: toIso(firstNonEmpty(body.created_at, body.timestamp)),
    properties: props, source: 'shopflo',
    idempotency_key: `shopflo:order_completed:${oid}`,
  };
}

// added_to_cart_ui → the existing `add_to_cart` event (cart-building signal, identity
// from user_data). Keyed on session+timestamp so an idempotent retry dedups.
function mapAddToCart(body) {
  const identifiers = identsFromShopflo(body);
  if (!identifiers.length) return null;
  const props = {
    cart_product_ids: body.cart_product_ids || null,
    cart_product_names: body.cart_product_names || null,
    cart_variant_ids: body.cart_variant_ids || null,
    currency: body.currency || null,
    total_price: num(body.total_price),
    source_surface: 'shopflo',
  };
  return {
    identifiers, name: 'add_to_cart',
    occurred_at: toIso(body.timestamp),
    properties: props, source: 'shopflo',
    idempotency_key: body.session_id ? `shopflo:add_to_cart:${body.session_id}:${body.timestamp || ''}` : null,
  };
}

// Shopflo event_name → { event: comms event name, map: mapper }. Only the
// decision-driving events are mapped in v1; browse/page-view events are captured for
// discovery but not turned into substrate events (add a row here to promote one).
const EVENT_MAP = {
  checkout_abandoned: { event: 'checkout_abandoned', map: mapCheckoutAbandoned },
  order_completed: { event: 'shopflo_order_completed', map: mapOrderCompleted },
  added_to_cart_ui: { event: 'add_to_cart', map: mapAddToCart },
};

// Consent rows from `customer.marketing_consent` (true→opted_in, false→opted_out,
// absent→[] i.e. leave the gate's default block in place). One flag → both email
// (marketing) + whatsapp (marketing), mirroring the Shopify import's SMS→WA mapping.
// NB: Shop-Pass AUTO-identification ≠ a marketing opt-in — this trusts Shopflo's own
// `marketing_consent` determination. Consent basis to confirm with counsel before the
// TEST-MODE lock is lifted (see systems/relay.md Shopflo block).
function consentRowsFrom(body, capturedAt) {
  const mc = body && body.customer && body.customer.marketing_consent;
  if (mc !== true && mc !== false) return [];
  const state = mc === true ? 'opted_in' : 'opted_out';
  const id = pickIdentity(body);
  const rows = [];
  if (id.email) rows.push({ channel: 'email', purpose: 'marketing', state, source: 'shopflo', captured_at: capturedAt || null });
  if (SHOP.normalizePhone(id.phone)) rows.push({ channel: 'whatsapp', purpose: 'marketing', state, source: 'shopflo', captured_at: capturedAt || null });
  return rows;
}

module.exports = {
  eventName, pickIdentity, identsFromShopflo, displayName, noteAttr, toIso, num, inrGroup, shortNames,
  checkoutUrlSuffix, payloadImageUrl, SHOPFLO_CHECKOUT_BASE,
  mapCheckoutAbandoned, mapOrderCompleted, mapAddToCart, EVENT_MAP, consentRowsFrom,
};
