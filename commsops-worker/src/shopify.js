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

// orders/* topic → comms event name. order_placed bumps lifetime in deriveAttributes;
// orders/paid is intentionally NOT subscribed (would double-count order_placed).
const ORDER_TOPIC_EVENT = {
  'orders/create': 'order_placed',
  'orders/fulfilled': 'order_fulfilled',
  'orders/cancelled': 'order_cancelled',
};

function mapOrderEvent(o, name) {
  const identifiers = identsFromContact(o);
  if (!identifiers.length) return null;
  const oid = o.id != null ? String(o.id) : null;
  const total = o.total_price != null ? Number(o.total_price) : null;
  const props = {
    shopify_order_id: oid,
    order_number: o.order_number || o.name || null,
    total, total_price: total,
    currency: o.currency || o.currency_code || null,
    financial_status: o.financial_status || null,
    fulfillment_status: o.fulfillment_status || null,
    line_item_count: Array.isArray(o.line_items) ? o.line_items.length : null,
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
];

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
  verifyWebhookHmac, registerWebhooks, listWebhooks, WEBHOOK_TOPICS,
};
