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

async function applyNodes(env, nodes) {
  const mapped = nodes.map(mapCustomer).filter((m) => m.identifiers.length > 0);
  if (!mapped.length) return { profiles: 0, consent: 0, skipped: nodes.length };
  const r = await A.sbComms('/rest/v1/rpc/shopify_apply_customers', env,
    { method: 'POST', body: JSON.stringify({ p_customers: mapped }) });
  if (!r.ok) throw new Error(`apply_failed:${JSON.stringify(r.data).slice(0, 200)}`);
  const row = Array.isArray(r.data) ? r.data[0] : r.data;
  return { profiles: Number(row?.profiles_touched || 0), consent: Number(row?.consent_rows || 0), skipped: nodes.length - mapped.length };
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

module.exports = { mapCustomer, normalizePhone, mktState, gidNum, fetchCustomerPage, applyNodes, backfillSample, backfillPage };
