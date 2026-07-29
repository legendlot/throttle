// Shopify connector (M4) — customer/consent sync into the comms substrate.
// Mapping is pure + unit-testable; fetch uses the Admin GraphQL API; a whole page is
// applied in ONE DB call via comms.shopify_apply_customers (well under the 50-subreq cap).
const A = require('./auth.js');

const API_VERSION = '2026-04';
const adminUrl = (env) => `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${env.SHOPIFY_API_VERSION || API_VERSION}/graphql.json`;

// Auth mirrors odoops/csops: a Dev-Dashboard app mints an access token via the
// client-credentials grant (CLIENT_ID + CLIENT_SECRET). A static SHOPIFY_ACCESS_TOKEN
// (store custom app, shpat_…) is used directly if present.
let _tok = null, _tokExp = 0;
async function getShopifyToken(env, force = false) {
  if (env.SHOPIFY_ACCESS_TOKEN) return env.SHOPIFY_ACCESS_TOKEN;
  const now = Date.now();
  if (!force && _tok && now < _tokExp - 60_000) return _tok;
  const res = await fetch(`https://${env.SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.SHOPIFY_CLIENT_ID, client_secret: env.SHOPIFY_CLIENT_SECRET }),
  }).catch(() => null);
  if (!res || !res.ok) { _tok = null; _tokExp = 0; throw new Error(`shopify_auth:${res ? res.status : 'network'}`); }
  const data = await res.json().catch(() => null);
  if (!data?.access_token) { _tok = null; _tokExp = 0; throw new Error('shopify_auth:no_token'); }
  _tok = data.access_token; _tokExp = now + (Number(data.expires_in) || 86399) * 1000;
  return _tok;
}

async function shopifyGraphQL(env, query, variables) {
  if (!env.SHOPIFY_STORE_DOMAIN || (!env.SHOPIFY_ACCESS_TOKEN && (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET)))
    throw new Error('shopify_not_configured');
  const run = async (tok) => {
    const res = await fetch(adminUrl(env), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': tok },
      body: JSON.stringify({ query, variables: variables || {} }),
    });
    return res;
  };
  let token = await getShopifyToken(env);
  let res = await run(token);
  if (res.status === 401) { token = await getShopifyToken(env, true); res = await run(token); }   // re-mint once
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.errors) throw new Error(`shopify_graphql:${res.status}:${data.errors ? JSON.stringify(data.errors).slice(0, 300) : 'http'}`);
  return data.data;
}

// ── pure mapping ──────────────────────────────────────────────────────────────
function gidNum(gid) { const m = String(gid || '').match(/(\d+)\s*$/); return m ? m[1] : null; }

// Normalize to E.164, defaulting to India (+91). Best-effort; identity resolution keys on it.
function normalizePhone(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (s.startsWith('+')) return '+' + s.slice(1).replace(/\D/g, '');
  const d = s.replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 10) return `+91${d}`;
  if (d.length === 12 && d.startsWith('91')) return `+${d}`;
  if (d.length === 11 && d.startsWith('0')) return `+91${d.slice(1)}`;
  return `+${d}`;
}

const MKT = { SUBSCRIBED: 'opted_in', UNSUBSCRIBED: 'opted_out' };
const mktState = (s) => MKT[String(s || '').toUpperCase()] || 'unknown';

function mapCustomer(n) {
  const idents = [];
  if (n.email) idents.push({ type: 'email', value: String(n.email).toLowerCase().trim(), is_verified: true });
  const phone = normalizePhone(n.phone);
  if (phone) idents.push({ type: 'phone', value: phone, is_verified: true });
  const cid = gidNum(n.id);
  if (cid) idents.push({ type: 'shopify_customer_id', value: cid, is_verified: true });

  const first = (n.firstName || '').trim();
  const full = [first, (n.lastName || '').trim()].filter(Boolean).join(' ');
  const attrs = {
    lifetime_orders: Number(n.numberOfOrders || 0),
    total_spent: n.amountSpent ? Number(n.amountSpent.amount || 0) : 0,
    accepts_email_marketing: mktState(n.emailMarketingConsent?.marketingState) === 'opted_in',
    accepts_sms_marketing: mktState(n.smsMarketingConsent?.marketingState) === 'opted_in',
    shopify_created_at: n.createdAt || null,
  };
  if (full) attrs.full_name = full;
  if (Array.isArray(n.tags) && n.tags.length) attrs.tags = n.tags;

  const consent = [];
  if (n.email) {
    consent.push({ channel: 'email', purpose: 'marketing', state: mktState(n.emailMarketingConsent?.marketingState),
      source: 'shopify_import', captured_at: n.emailMarketingConsent?.consentUpdatedAt || null });
    consent.push({ channel: 'email', purpose: 'transactional', state: 'opted_in',
      source: 'shopify_import', captured_at: n.createdAt || null });
  }
  if (phone) {  // store SMS/WA marketing consent now for the future WhatsApp cutover
    consent.push({ channel: 'whatsapp', purpose: 'marketing', state: mktState(n.smsMarketingConsent?.marketingState),
      source: 'shopify_import', captured_at: n.smsMarketingConsent?.consentUpdatedAt || null });
  }

  return { identifiers: idents, display_name: first || full || null,
    city: n.defaultAddress?.city || null, locale: null, attributes: attrs, consent };
}

// ── webhook (REST JSON) mappers ──────────────────────────────────────────────
// Shopify webhook payloads are REST-shaped (snake_case) — distinct from the
// GraphQL camelCase nodes mapCustomer consumes. These produce the SAME internal
// mapped shape so they reuse comms.shopify_apply_customers / the /ingest seam.

// customers/create + customers/update → the mapCustomer internal shape.
function mapCustomerRest(c) {
  const idents = [];
  if (c.email) idents.push({ type: 'email', value: String(c.email).toLowerCase().trim(), is_verified: true });
  const phone = normalizePhone(c.phone || c.default_address?.phone);
  if (phone) idents.push({ type: 'phone', value: phone, is_verified: true });
  const cid = c.id != null ? String(c.id) : null;
  if (cid) idents.push({ type: 'shopify_customer_id', value: cid, is_verified: true });

  const first = (c.first_name || '').trim();
  const full = [first, (c.last_name || '').trim()].filter(Boolean).join(' ');
  const tags = typeof c.tags === 'string'
    ? c.tags.split(',').map((s) => s.trim()).filter(Boolean)
    : (Array.isArray(c.tags) ? c.tags : []);
  const attrs = {
    lifetime_orders: Number(c.orders_count || 0),
    total_spent: c.total_spent != null ? Number(c.total_spent) : 0,
    accepts_email_marketing: mktState(c.email_marketing_consent?.state) === 'opted_in',
    accepts_sms_marketing: mktState(c.sms_marketing_consent?.state) === 'opted_in',
    shopify_created_at: c.created_at || null,
  };
  if (full) attrs.full_name = full;
  if (tags.length) attrs.tags = tags;

  const consent = [];
  if (c.email) {
    consent.push({ channel: 'email', purpose: 'marketing', state: mktState(c.email_marketing_consent?.state),
      source: 'shopify_webhook', captured_at: c.email_marketing_consent?.consent_updated_at || null });
    consent.push({ channel: 'email', purpose: 'transactional', state: 'opted_in',
      source: 'shopify_webhook', captured_at: c.created_at || null });
  }
  if (phone) {
    consent.push({ channel: 'whatsapp', purpose: 'marketing', state: mktState(c.sms_marketing_consent?.state),
      source: 'shopify_webhook', captured_at: c.sms_marketing_consent?.consent_updated_at || null });
  }
  return { identifiers: idents, display_name: first || full || null,
    city: c.default_address?.city || null, locale: null, attributes: attrs, consent };
}

// Identifiers from an order/checkout contact block (weaker is_verified than a
// customer record — these come off the transaction, not the customer profile).
function identsFromContact({ email, phone, customer } = {}) {
  const out = [];
  const em = email || customer?.email;
  if (em) out.push({ type: 'email', value: String(em).toLowerCase().trim(), is_verified: false });
  const ph = normalizePhone(phone || customer?.phone || customer?.default_address?.phone);
  if (ph) out.push({ type: 'phone', value: ph, is_verified: false });
  const cid = customer?.id != null ? String(customer.id) : null;
  if (cid) out.push({ type: 'shopify_customer_id', value: cid, is_verified: true });
  return out;
}

// ── Shopify fulfillment shipment_status → the courier lifecycle events ──────────────────
// WHY THIS EXISTS: `order_delivered` fired 2.4/day against ~80-105 real deliveries (~2.5%).
// BiteSpeed's own Delivered journey does ~6.7/day (47 over 7 days, read off their canvas
// 2026-07-27 — our records said "~47/day (~55%)", which was a 7-day total misread as daily).
// Their trigger is `FULFILLMENT_DELIVERED` / "Shipment Delivered" = Shopify's fulfillment
// shipment_status, which we simply never subscribed to. So this closes a parity gap, NOT the
// real problem: Shopify's delivered status is largely the merchant's manual "Mark as delivered"
// button, hence ~7% coverage for everyone. The durable fix is the Delhivery ScanPush feed.
//
// Only the two transitions a customer should hear about are mapped. `in_transit` is deliberately
// NOT mapped — Uniware already emits order_shipped (11.9/day) and a second source would compete
// with a working feed for no gain. attempted_delivery/failure have no journey.
const FULFILLMENT_STATUS_EVENT = {
  delivered: 'order_delivered',
  out_for_delivery: 'order_out_for_delivery',
};

// Same 30-day guard the Uniware emitter applies: a delivered flag set weeks after dispatch is a
// bookkeeping catch-up, not news — and "your order is on the way" for a month-old parcel is the
// exact blast this codebase has already had to design against once.
const FULFILLMENT_MAX_AGE_MS = 30 * 86400000;

// mapFulfillmentEvent(payload) → an /ingest envelope, or null when there is nothing to say.
// Identity is best-effort: a fulfillment payload often carries no contact at all, so the caller
// falls back to resolving the profile from the order id (every delivered order necessarily had
// an order_placed, and those are 100% phone-identified).
function mapFulfillmentEvent(f) {
  const status = String(f?.shipment_status || '').toLowerCase();
  const name = FULFILLMENT_STATUS_EVENT[status];
  if (!name) return null;
  const orderId = f?.order_id != null ? String(f.order_id) : null;
  if (!orderId) return null;                       // nothing to key or attribute it to

  const born = new Date(f?.created_at || 0).getTime();
  if (born && Date.now() - born > FULFILLMENT_MAX_AGE_MS) return null;

  const occurredAt = f?.updated_at || f?.created_at || null;
  const tracking = {
    tracking_number: f?.tracking_number
      || (Array.isArray(f?.tracking_numbers) ? f.tracking_numbers[0] : null) || null,
    tracking_url: f?.tracking_url
      || (Array.isArray(f?.tracking_urls) ? f.tracking_urls[0] : null) || null,
    tracking_company: f?.tracking_company || null,
  };
  return {
    identifiers: identsFromContact({ email: f?.email, phone: f?.destination?.phone }),
    name,
    source: 'shopify_webhook',
    occurred_at: occurredAt ? new Date(occurredAt).toISOString() : null,
    // ⚠️ ORDER-SCOPED AND SHARED WITH THE UNIWARE EMITTER ON PURPOSE. Both feeds can observe the
    // same delivery; keying per-source would let one customer be messaged twice for one parcel.
    // shipment-events.js emits the identical key for these two lifecycles, so whichever source
    // sees it first wins and the second dedupes on arrival. Do not "namespace" this per source.
    idempotency_key: `delivery:${orderId}:${status}`,
    properties: {
      shopify_order_id: orderId,
      order_number: f?.name ? String(f.name).replace(/^#?(LOT)?/i, '').split('.')[0] : null,
      shipment_status: status,
      fulfillment_id: f?.id != null ? String(f.id) : null,
      ...tracking,
      source_surface: 'shopify_fulfillment',
    },
  };
}

// orders/* topic → comms event name. order_placed bumps lifetime in deriveAttributes;
// orders/paid is intentionally NOT subscribed (would double-count order_placed).
const ORDER_TOPIC_EVENT = {
  'orders/create': 'order_placed',
  'orders/fulfilled': 'order_fulfilled',
  'orders/cancelled': 'order_cancelled',
};

// "Ghost RC Drift Car", "Ghost RC Drift Car + 1 more", "Ghost RC Drift Car + 2 more" — a
// human-readable item summary for message copy ({items}). Kept short on purpose: WA bodies
// are capped and a 6-item order should not blow the template.
function summariseItems(lineItems) {
  const names = (Array.isArray(lineItems) ? lineItems : [])
    .map((li) => li?.title || li?.name).filter(Boolean);
  if (!names.length) return null;
  return names.length === 1 ? names[0] : `${names[0]} + ${names.length - 1} more`;
}

// Variant ids for the WA IMAGE header, and WHICH line the header should show.
//
// A header carries ONE image but an order can have many lines, so a rule is required. Rule:
// the HIGHEST-VALUE line (price × quantity) — Afshaan, 2026-07-28. It is the most
// representative thing the customer bought, and for a single-line order (the common case)
// every candidate rule agrees, so this only ever differs where it matters.
//
// `price` is a STRING on the REST payload ("2249.00") and quantity may be absent — coerce
// both, and treat a non-numeric price as 0 rather than NaN (NaN comparisons are always false,
// which would silently make the FIRST line win and look like the rule was never applied).
function headerLineFrom(lineItems) {
  const lines = (Array.isArray(lineItems) ? lineItems : []).filter(Boolean);
  if (!lines.length) return { variant_ids: null, primary_title: null };
  const value = (li) => {
    const p = Number(li?.price);
    const q = Number(li?.quantity);
    return (Number.isFinite(p) ? p : 0) * (Number.isFinite(q) && q > 0 ? q : 1);
  };
  let best = lines[0];
  for (const li of lines) if (value(li) > value(best)) best = li;
  // Compose the VARIANT-level title, because that is what comms.variant_images stores
  // ("{product} - {variant}", per shopflo.js variantImageIndex). A REST line item's `title`
  // is PRODUCT-level ("L.O.T Cars Ghost - RC Drift Car") while the cache key carries the
  // colourway ("… - Burnout Red"), so passing `title` straight through would miss the title
  // match on every single order and leave us silently relying on the resolver's positional
  // fallback. `name` already contains the composed form, so it is used as-is when present.
  // Shopify's synthetic 'Default Title' must never be appended (single-variant products).
  const composedTitle = (li) => {
    const vt = String(li?.variant_title || '').trim();
    if (li?.title) return (vt && vt !== 'Default Title') ? `${li.title} - ${vt}` : li.title;
    return li?.name || null;
  };
  // Every variant id goes on the event (the resolver matches the primary title against them
  // and falls back to the first it can resolve), so a title mismatch still yields an image.
  // The BEST line is listed FIRST so that fallback lands on the highest-value item too.
  const ids = [best, ...lines.filter((li) => li !== best)]
    .map((li) => li?.variant_id).filter((v) => v !== null && v !== undefined).map(String);
  return {
    variant_ids: ids.length ? ids.join(',') : null,
    primary_title: composedTitle(best),
  };
}

// Pull tracking off the fulfillments array. Shopify sends BOTH `tracking_number`/`tracking_url`
// (singular, first entry) and `tracking_numbers`/`tracking_urls` (arrays) — prefer the singular,
// fall back to the array. The LAST fulfillment is the most recent one.
function trackingFrom(order) {
  const fs = Array.isArray(order?.fulfillments) ? order.fulfillments : [];
  if (!fs.length) return {};
  const f = fs[fs.length - 1];
  const number = f.tracking_number || (Array.isArray(f.tracking_numbers) ? f.tracking_numbers[0] : null) || null;
  const url = f.tracking_url || (Array.isArray(f.tracking_urls) ? f.tracking_urls[0] : null) || null;
  return {
    tracking_number: number,
    tracking_company: f.tracking_company || null,
    tracking_url: url,
    fulfillment_status: f.status || null,
    fulfillment_count: fs.length,
  };
}

function mapOrderEvent(o, name) {
  const identifiers = identsFromContact(o);
  if (!identifiers.length) return null;
  // Weak key — same role web_session plays for the browser. The pixel emits checkout_token on
  // checkout_started, so attaching it to the order lets resolve_identity fold that anonymous
  // session profile into this customer automatically (weak-key rules keep it safe). This is
  // the ONLY bridge that survives the Shopflo hand-off.
  const ckTok = o.checkout_token || null;
  if (ckTok) identifiers.push({ type: 'checkout_token', value: String(ckTok), is_verified: false });
  const oid = o.id != null ? String(o.id) : null;
  const total = o.total_price != null ? Number(o.total_price) : null;
  const track = trackingFrom(o);
  // Checkout/cart tokens. Shopify's own guidance is to correlate a storefront session to an
  // order via the CHECKOUT token (the pixel's cart id is a different namespace and does not
  // match the Ajax cart token, so it is not a reliable join key). Capturing it here is what
  // makes an anonymous pixel session recoverable AFTER the fact — the Shopflo checkout sits on
  // its own domain where our pixel cannot run, so the order is the first server-side record
  // that can carry the link back.
  const checkoutToken = o.checkout_token || o.checkout_id != null && String(o.checkout_id) || null;
  const cartToken = o.cart_token || null;
  const props = {
    shopify_order_id: oid,
    checkout_token: checkoutToken,
    cart_token: cartToken,
    order_number: o.order_number || o.name || null,
    total, total_price: total,
    currency: o.currency || o.currency_code || null,
    financial_status: o.financial_status || null,
    fulfillment_status: o.fulfillment_status || null,
    // COD discriminator for the J3 COD→prepaid trigger (2026-07-23). financial_status='pending'
    // ⇔ COD held 1,802/1,802 on live data, but the gateway name makes it explicit: Shopify
    // sends payment_gateway_names (array, e.g. ["Cash on Delivery (COD)"]). is_cod derives
    // here so the journey filter stays a simple equality, robust to gateway renames upstream
    // of the trigger. Forward-only — J3 is forward-only anyway.
    payment_gateway_names: Array.isArray(o.payment_gateway_names) ? o.payment_gateway_names : null,
    // Either signal marks COD: a matching gateway name OR financial_status='pending'. The
    // first live order showed Shopflo prepaid orders carry gateway "shopflo" — if COD orders
    // do too, a gateway-only test would false-negative and J3 would never fire; pending⇔COD
    // held 1,802/1,802 so the OR is safe. false only when a signal exists and neither says
    // COD; null when both are absent (never a silent false).
    is_cod: (Array.isArray(o.payment_gateway_names)
              && o.payment_gateway_names.some((g) => /cash on delivery|\bcod\b/i.test(String(g))))
      ? true
      : o.financial_status === 'pending' ? true
      : (Array.isArray(o.payment_gateway_names) || o.financial_status) ? false
      : null,
    line_item_count: Array.isArray(o.line_items) ? o.line_items.length : null,
    // ── message-copy bindings (these were being dropped, leaving WA/email templates to
    //    fall back to generic values): {items}, {order_url}, {tracking_url}.
    items: summariseItems(o.line_items),
    order_status_url: o.order_status_url || null,
    // Feed the WA IMAGE header: the variant ids to resolve an image from, and which line the
    // header should represent. The image URL itself is resolved in the webhook handler (it
    // needs a DB/catalog round-trip; this mapper stays pure).
    ...headerLineFrom(o.line_items),
    ...track,
  };
  const occurred = (name === 'order_cancelled' ? o.cancelled_at : o.created_at) || new Date().toISOString();
  return { identifiers, name, occurred_at: occurred, properties: props, source: 'shopify_webhook',
    idempotency_key: `shopify:${name}:${oid}:${o.updated_at || o.created_at || ''}` };
}

// checkouts/create + checkouts/update → checkout_started (the abandoned-cart trigger).
// Keyed on the checkout TOKEN so repeated updates AND a Web-Pixel checkout_started
// for the same checkout dedup against each other (the pixel sends the same token).
function mapCheckoutEvent(co) {
  const identifiers = identsFromContact(co);
  if (!identifiers.length) return null;
  const tok = co.token || co.cart_token || (co.id != null ? String(co.id) : null);
  const props = {
    checkout_id: co.id != null ? String(co.id) : null,
    checkout_token: tok,
    checkout_url: co.abandoned_checkout_url || null,
    total: co.total_price != null ? Number(co.total_price) : null,
    currency: co.currency || null,
    line_item_count: Array.isArray(co.line_items) ? co.line_items.length : null,
  };
  return { identifiers, name: 'checkout_started', occurred_at: co.created_at || new Date().toISOString(),
    properties: props, source: 'shopify_webhook', idempotency_key: `shopify:checkout_started:${tok}` };
}

// HMAC-SHA256 verify of a Shopify webhook: base64(HMAC(rawBody, app secret)) vs
// the X-Shopify-Hmac-Sha256 header. Constant-time compare. Secret = the app's
// client/API secret (commsops SHOPIFY_WEBHOOK_SECRET).
async function verifyWebhookHmac(secret, rawBody, headerB64) {
  if (!secret || !headerB64) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const bytes = new Uint8Array(mac);
  let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const expected = btoa(bin);
  if (expected.length !== headerB64.length) return false;
  let diff = 0; for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ headerB64.charCodeAt(i);
  return diff === 0;
}

// ── fetch + apply ───────────────────────────────────────────────────────────
const CUSTOMERS_QUERY = `
query($first:Int!,$after:String){
  customers(first:$first, after:$after){
    pageInfo{ hasNextPage endCursor }
    edges{ node{
      id firstName lastName email phone numberOfOrders createdAt tags
      amountSpent{ amount currencyCode }
      defaultAddress{ city }
      emailMarketingConsent{ marketingState consentUpdatedAt }
      smsMarketingConsent{ marketingState consentUpdatedAt }
    }}
  }
}`;

async function fetchCustomerPage(env, { first = 100, after = null }) {
  const d = await shopifyGraphQL(env, CUSTOMERS_QUERY, { first, after });
  const conn = d.customers;
  return { customers: (conn.edges || []).map((e) => e.node),
    hasNext: !!conn.pageInfo?.hasNextPage, cursor: conn.pageInfo?.endCursor || null };
}

// Apply already-mapped customer objects (from GraphQL nodes OR REST webhooks) in
// one DB call — keeps both the backfill and customers/* webhooks under the subreq cap.
async function applyMapped(env, mapped) {
  const valid = (mapped || []).filter((m) => m && Array.isArray(m.identifiers) && m.identifiers.length > 0);
  if (!valid.length) return { profiles: 0, consent: 0, skipped: (mapped || []).length };
  const r = await A.sbComms('/rest/v1/rpc/shopify_apply_customers', env,
    { method: 'POST', body: JSON.stringify({ p_customers: valid }) });
  if (!r.ok) throw new Error(`apply_failed:${JSON.stringify(r.data).slice(0, 200)}`);
  const row = Array.isArray(r.data) ? r.data[0] : r.data;
  return { profiles: Number(row?.profiles_touched || 0), consent: Number(row?.consent_rows || 0), skipped: (mapped || []).length - valid.length };
}

async function applyNodes(env, nodes) {
  return applyMapped(env, nodes.map(mapCustomer));
}

// ── last_order_at targeted backfill (winback prerequisite, 2026-07-17) ────────
// The customer backfill (mapCustomer) captured numberOfOrders/amountSpent but NEVER a
// last-order DATE, so ~97% of profiles have no `last_order_at` and a winback segment
// ("ordered, but not in N days") cannot be built. This pulls ONLY lastOrder.createdAt per
// customer and patches ONLY that one attribute key — shopify_apply_customers shallow-merges
// (`attributes || incoming`), so it can neither clobber event-bumped lifetime_orders nor
// re-touch consent. Filtered to customers with >0 orders (a 0-order customer has no last
// order and can't be winback). Deliberately NOT the full mapCustomer re-run, which would
// re-merge counts/consent for all 92k.
const LAST_ORDER_QUERY = `
query($first:Int!,$after:String){
  customers(first:$first, after:$after, query:"orders_count:>0"){
    pageInfo{ hasNextPage endCursor }
    edges{ node{ id lastOrder{ createdAt } } }
  }
}`;

// pure: node -> { identifiers:[shopify_customer_id], attributes:{last_order_at} } | null.
// null when the id or the order date is missing — applyMapped filters those out.
function mapLastOrder(n) {
  const cid = gidNum(n?.id);
  const at = n?.lastOrder?.createdAt || null;
  if (!cid || !at) return null;
  return { identifiers: [{ type: 'shopify_customer_id', value: cid }], attributes: { last_order_at: at } };
}

async function fetchLastOrderPage(env, { first = 40, after = null }) {
  const d = await shopifyGraphQL(env, LAST_ORDER_QUERY, { first, after });
  const conn = d.customers;
  return { customers: (conn.edges || []).map((e) => e.node),
    hasNext: !!conn.pageInfo?.hasNextPage, cursor: conn.pageInfo?.endCursor || null };
}

// One page; caller continues from `cursor` while hasNext. lastOrder is a single nested
// object (not a connection) so cost is low — pageSize 40 mirrors the proven backfill.
async function backfillLastOrderPage(env, after, pageSize = 40) {
  const { customers, hasNext, cursor } = await fetchLastOrderPage(env, { first: pageSize, after });
  const res = await applyMapped(env, customers.map(mapLastOrder));
  return { fetched: customers.length, ...res, hasNext, cursor };
}

// ── webhook registration ──────────────────────────────────────────────────────
// GraphQL enum topics (uppercase) — runtime delivers the slash form in X-Shopify-Topic.
const WEBHOOK_TOPICS = [
  'CUSTOMERS_CREATE', 'CUSTOMERS_UPDATE',
  'ORDERS_CREATE', 'ORDERS_FULFILLED', 'ORDERS_CANCELLED',
  'CHECKOUTS_CREATE', 'CHECKOUTS_UPDATE',
  // Carries `shipment_status` — the ONLY Shopify-side delivered/out-for-delivery signal, and
  // the source BiteSpeed's Delivered journey rides. Needs `read_fulfillments` on the app
  // (added 2026-07-27); registration is a no-op until that scope is live.
  'FULFILLMENTS_CREATE', 'FULFILLMENTS_UPDATE',
];

// ── C2P draft-order replication (pure) ───────────────────────────────────────
// Kept pure and exported so the risky part — faithfully copying line items, prices and
// addresses onto a replacement order — is unit-testable. `journey-workflow.js` cannot be
// required from Node (it esm-imports `cloudflare:workers`), so logic left in there is
// effectively untested.
//
// Returns { input } for draftOrderCreate, or { error } when the order cannot be replicated
// faithfully. NO discount is applied here: the caller sizes the concession off the draft's
// own Shopify-computed total (see #recreateAsPrepaid PHASE A).
const c2pMoney = (amount, currencyCode) => ({ amount: String(amount), currencyCode });

function buildC2PDraftInput(order, enrolmentId) {
  if (!order) return { error: 'order_missing' };
  const cur = order.currentTotalPriceSet?.shopMoney?.currencyCode || 'INR';
  const edges = order.lineItems?.edges || [];
  const lines = edges.map((e) => e.node).filter((n) => n?.variant?.id);
  if (!lines.length) return { error: 'no_replicable_line_items' };
  // A custom line item carries no variant, so it cannot be replicated. Refuse outright rather
  // than silently ship a replacement missing part of what the customer bought.
  if (lines.length !== edges.length) return { error: 'custom_line_item_present' };

  const addr = (a) => (a ? {
    firstName: a.firstName, lastName: a.lastName, address1: a.address1, address2: a.address2,
    city: a.city, provinceCode: a.provinceCode, countryCode: a.countryCode,
    zip: a.zip, phone: a.phone, company: a.company,
  } : null);

  const input = {
    // Replicate at the price the customer was ACTUALLY charged per unit, so any coupon on the
    // original carries through with no discount-code lookup. `priceOverride` is the
    // non-deprecated per-unit override and is honoured alongside `variantId`.
    lineItems: lines.map((n) => ({
      variantId: n.variant.id,
      quantity: n.quantity,
      priceOverride: c2pMoney(n.discountedUnitPriceSet?.shopMoney?.amount ?? 0, cur),
    })),
    tags: ['relay-c2p-converted', `relay-c2p-from-${order.name}`],
    note: `COD→Prepaid conversion of ${order.name} (Relay enrolment ${enrolmentId}).`,
  };
  // `customerId` is deprecated at the top level of DraftOrderInput.
  if (order.customer?.id) input.purchasingEntity = { customerId: order.customer.id };
  if (order.email) input.email = order.email;
  if (order.phone) input.phone = order.phone;
  const sa = addr(order.shippingAddress); if (sa) input.shippingAddress = sa;
  const ba = addr(order.billingAddress);  if (ba) input.billingAddress = ba;
  if (order.shippingLine) input.shippingLine = {
    title: order.shippingLine.title || 'Shipping',
    // `price` is deprecated in favour of `priceWithCurrency`.
    priceWithCurrency: c2pMoney(order.shippingLine.originalPriceSet?.shopMoney?.amount ?? 0, cur),
  };
  return { input, currencyCode: cur };
}

// What the app can actually DO, straight from Shopify. A scope claim in a design doc is not
// evidence — a missing grant surfaces only as an ACCESS_DENIED mid-conversion.
//
// ⚠️ C2P_SCOPES IS DERIVED FROM WHAT THE QUERIES TOUCH, AND THAT LIST IS LOAD-BEARING.
// 2026-07-29: this check returned `c2p_ready: true` and the very first real conversion then died
// on `read_products` — because ORDER_FOR_RECREATE_Q reads `lineItems { variant { id } }`, and
// `variant` on a line item is a PRODUCTS-scoped field, not an Orders one. A customer had already
// paid ₹241.53 by the time that surfaced. The list below had been copied from the design doc's
// four scopes instead of read off the query, so the check verified the wrong set — which is
// worse than not checking, because it was reported as proof.
//
// If you add a field to ORDER_FOR_RECREATE_Q or the draft mutations, re-derive this list. The
// non-obvious ones are the cross-object reads: `variant` → read_products,
// `customer` → read_customers.
const C2P_SCOPES = [
  'read_orders',        // read the original order
  'write_orders',       // cancel it
  'read_draft_orders',  // read the draft back to verify its total
  'write_draft_orders', // create + complete the replacement
  'read_products',      // lineItems { variant { id } } — the one that was missed
  'read_customers',     // order.customer { id } → purchasingEntity
];

async function accessScopes(env) {
  const d = await shopifyGraphQL(env, `{ currentAppInstallation{ accessScopes{ handle } } }`, {});
  const have = (d.currentAppInstallation?.accessScopes || []).map((s) => s.handle).sort();
  const missing = C2P_SCOPES.filter((n) => !have.includes(n));
  return {
    scopes: have,
    c2p_required: C2P_SCOPES,
    c2p_ready: missing.length === 0,
    missing_for_c2p: missing,
    // Spelled out because "ready: false" alone sent someone hunting the wrong thing once.
    note: missing.length
      ? `NOT ready — grant ${missing.join(', ')} on the app AND REINSTALL it (adding a scope to the app config does not change the installation's grant), then re-run this.`
      : 'ready — every scope the recreate path touches is granted.',
  };
}

async function listWebhooks(env) {
  const q = `{ webhookSubscriptions(first:100){ edges{ node{ id topic
    endpoint{ __typename ... on WebhookHttpEndpoint{ callbackUrl } } } } } }`;
  const d = await shopifyGraphQL(env, q, {});
  return (d.webhookSubscriptions?.edges || []).map((e) => ({
    id: e.node.id, topic: e.node.topic, callbackUrl: e.node.endpoint?.callbackUrl || null }));
}

// Idempotent: create only the topics not already pointed at callbackUrl.
async function registerWebhooks(env, callbackUrl) {
  const existing = await listWebhooks(env);
  const have = new Set(existing.filter((n) => n.callbackUrl === callbackUrl).map((n) => n.topic));
  const created = [], skipped = [], errors = [];
  const m = `mutation($topic:WebhookSubscriptionTopic!,$url:URL!){
    webhookSubscriptionCreate(topic:$topic, webhookSubscription:{callbackUrl:$url, format:JSON}){
      webhookSubscription{ id } userErrors{ field message } } }`;
  for (const topic of WEBHOOK_TOPICS) {
    if (have.has(topic)) { skipped.push(topic); continue; }
    try {
      const r = await shopifyGraphQL(env, m, { topic, url: callbackUrl });
      const ue = r.webhookSubscriptionCreate?.userErrors || [];
      if (ue.length) errors.push({ topic, errors: ue }); else created.push(topic);
    } catch (e) { errors.push({ topic, error: e?.message || String(e) }); }
  }
  return { callbackUrl, created, skipped, errors };
}

// Small sample write so we can eyeball the mapping via SQL before the full run.
async function backfillSample(env, n = 5) {
  const { customers } = await fetchCustomerPage(env, { first: n });
  const res = await applyNodes(env, customers);
  return { fetched: customers.length, ...res };
}

// One page of the full phased backfill; caller continues from `cursor` while hasNext.
// pageSize kept modest so the nested-consent query stays under Shopify's 1000-pt cost cap.
async function backfillPage(env, after, pageSize = 40) {
  const { customers, hasNext, cursor } = await fetchCustomerPage(env, { first: pageSize, after });
  const res = await applyNodes(env, customers);
  return { fetched: customers.length, ...res, hasNext, cursor };
}

module.exports = {
  mapCustomer, normalizePhone, mktState, gidNum, fetchCustomerPage, applyNodes, applyMapped, backfillSample, backfillPage,
  mapLastOrder, fetchLastOrderPage, backfillLastOrderPage,
  // M4 webhooks + pixel
  mapCustomerRest, identsFromContact, mapOrderEvent, mapCheckoutEvent, ORDER_TOPIC_EVENT,
  mapFulfillmentEvent, FULFILLMENT_STATUS_EVENT,
  verifyWebhookHmac, registerWebhooks, listWebhooks, WEBHOOK_TOPICS,
  // J3 order_modify (COD→prepaid reconciliation) — raw Admin API access
  shopifyGraphQL, accessScopes,
  // C2P cancel-and-recreate — pure replication builder (unit-tested)
  buildC2PDraftInput,
};
