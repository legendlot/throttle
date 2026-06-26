/**
 * Ignition — ignitionops Cloudflare Worker
 * ignitionops.afshaan.workers.dev
 *
 * API for the Influencer Marketing CRM at ignition.legendoftoys.com.
 * Sibling to lotopsproxy (Garage/Redline/Scanner), throttleops (Throttle),
 * and csops (Pitstop).
 *
 * Pattern: GET  /?action=<actionName>            (reads)
 *          POST /  body: { action, ...params }   (writes, JWT-authenticated)
 *
 * Spec:  systems/ignition.md
 *        05_Throttle/apps/ignition/DESIGN.md
 */

// ── CORS ────────────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, If-Match',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
function err(message, status = 400) {
  return json({ ok: false, error: message }, status);
}
function ok(data) {
  return json({ ok: true, data });
}

// ── Supabase helpers ────────────────────────────────────────────────────────

async function sb(path, env, opts = {}) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type':    'application/json',
      'apikey':          env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization':   `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Accept-Profile':  'ignition',
      'Content-Profile': 'ignition',
      'Prefer':          opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

async function sbStore(path, env, opts = {}) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type':    'application/json',
      'apikey':          env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization':   `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Accept-Profile':  'store',
      'Content-Profile': 'store',
      'Prefer':          opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

// Supabase Storage REST (service_role) — for private payment-proof bucket.
async function storageFetch(path, env, opts = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/storage/v1${path}`, {
    ...opts,
    headers: {
      'apikey':        env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

const PAYMENT_PROOF_BUCKET = 'ignition-payment-proofs';

// ── Shopify helpers (ported from csops — same Dev Dashboard app/store) ────────
//
// Ignition reuses the SAME Shopify Dev Dashboard app as Pitstop (one LOT store,
// `ed7e3f-cf.myshopify.com`). There is no static token to copy: tokens are minted
// per-worker via the client-credentials grant (PATTERN-084) and expire in ~24h.
// Set the SAME three secrets on ignitionops:
//   wrangler secret put SHOPIFY_CLIENT_ID
//   wrangler secret put SHOPIFY_CLIENT_SECRET
//   wrangler secret put SHOPIFY_STORE_DOMAIN
// Until they are set, shopifyLookup() returns { configured:false } gracefully.

// Normalise an India phone to E.164.
function toE164(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 10) return `+91${d}`;
  if (d.length === 12 && d.startsWith('91')) return `+${d}`;
  return `+${d}`;
}

const SHOPIFY_API_VERSION = '2026-04';

// Module-level token cache (per isolate). client_id/client_secret are static secrets.
let _shopifyToken = null;
let _shopifyTokenExp = 0;

async function getShopifyToken(env, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _shopifyToken && now < _shopifyTokenExp - 60_000) return _shopifyToken;
  const res = await fetch(`https://${env.SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.SHOPIFY_CLIENT_ID,
      client_secret: env.SHOPIFY_CLIENT_SECRET,
    }),
  }).catch(() => null);
  if (!res || !res.ok) { _shopifyToken = null; _shopifyTokenExp = 0; return null; }
  const data = await res.json().catch(() => null);
  if (!data?.access_token) { _shopifyToken = null; _shopifyTokenExp = 0; return null; }
  _shopifyToken = data.access_token;
  _shopifyTokenExp = now + (Number(data.expires_in) || 86399) * 1000;
  return _shopifyToken;
}

// Lazy on-demand Shopify customer lookup by phone (email fallback).
// Returns graceful states, never throws.
async function shopifyLookup({ phone, email }, env) {
  if (!env.SHOPIFY_STORE_DOMAIN || !env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) {
    return { configured: false, found: false, customer: null, recent_orders: [] };
  }
  const e164 = toE164(phone);
  const term = e164 ? `phone:${e164}` : (email ? `email:${email}` : null);
  if (!term) return { configured: true, found: false, customer: null, recent_orders: [] };

  const query = `query($q:String!){ customers(first:1, query:$q){ edges{ node{
    id displayName email phone numberOfOrders
    amountSpent{ amount currencyCode }
    orders(first:5, sortKey: CREATED_AT, reverse:true){ edges{ node{
      name createdAt displayFulfillmentStatus displayFinancialStatus
      currentTotalPriceSet{ shopMoney{ amount currencyCode } }
      lineItems(first:25){ edges{ node{ title quantity variantTitle sku } } }
    }}}
  }}}}`;
  const runQuery = (token) => fetch(`https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables: { q: term } }),
  });

  let token = await getShopifyToken(env);
  if (!token) return { configured: true, found: false, error: 'shopify auth failed (client credentials)', customer: null, recent_orders: [] };
  let res = await runQuery(token).catch(() => null);
  // Token rejected mid-flight (expired/rotated) — force one refresh and retry.
  if (res && res.status === 401) {
    token = await getShopifyToken(env, true);
    if (!token) return { configured: true, found: false, error: 'shopify auth failed (client credentials)', customer: null, recent_orders: [] };
    res = await runQuery(token).catch(() => null);
  }
  if (!res || !res.ok) return { configured: true, found: false, error: `shopify ${res ? res.status : 'network'}`, customer: null, recent_orders: [] };
  const data = await res.json().catch(() => null);
  if (data?.errors?.length) {
    return { configured: true, found: false, error: data.errors[0]?.message, customer: null, recent_orders: [] };
  }
  const node = data?.data?.customers?.edges?.[0]?.node || null;
  if (!node) return { configured: true, found: false, customer: null, recent_orders: [] };
  const customer = {
    id: node.id, name: node.displayName, email: node.email, phone: node.phone,
    orders_count: node.numberOfOrders, total_spent: node.amountSpent?.amount, currency: node.amountSpent?.currencyCode,
  };
  const recent_orders = (node.orders?.edges || []).map(e => ({
    order_no: e.node.name, created_at: e.node.createdAt,
    fulfillment: e.node.displayFulfillmentStatus, financial: e.node.displayFinancialStatus,
    total: e.node.currentTotalPriceSet?.shopMoney?.amount, currency: e.node.currentTotalPriceSet?.shopMoney?.currencyCode,
    line_items: (e.node.lineItems?.edges || []).map(li => ({
      title: li.node.title, quantity: li.node.quantity, variant: li.node.variantTitle, sku: li.node.sku,
    })),
  }));
  return { configured: true, found: true, customer, recent_orders };
}

// ── Auth ────────────────────────────────────────────────────────────────────

async function verifyJWT(authHeader, env) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  if (!user?.id) return null;

  const profileRes = await sbStore(
    `/rest/v1/users_profile?id=eq.${user.id}&select=role,full_name,active&limit=1`,
    env,
  );
  if (!profileRes.ok || !profileRes.data?.[0]) return null;
  const profile = profileRes.data[0];
  if (!profile.active) return null;

  const rolesRes = await sbStore(
    `/rest/v1/roles?role_id=eq.${encodeURIComponent(profile.role)}&select=permissions&limit=1`,
    env,
  );
  const permissions = (rolesRes.ok && rolesRes.data?.[0]?.permissions) || {};

  return {
    userId: user.id,
    email: user.email,
    role: profile.role,
    fullName: profile.full_name,
    permissions,
    // Echo the raw JWT so sibling-worker calls (csops createTicket) can re-use it.
    bearer: token,
  };
}

function requirePerm(perm, auth) {
  if (!auth?.permissions?.[perm]) {
    return err(`Forbidden — missing permission: ${perm}`, 403);
  }
  return null;
}

// ── Stage state machine ────────────────────────────────────────────────────

// Stage model (Reann #8, S138). Free transitions — any stage to any other.
// Main flow then side/terminal states; order here drives picker/stepper order.
const STAGES = [
  'planning','agreed','shipped','delivered','scheduled','posting','live','completed',
  'delayed','on_hold','ghosted','dropped',
];

// Terminal stages — entering one stamps closed_at + closed_reason.
const TERMINAL_FAIL = new Set(['ghosted','dropped']);
const TERMINAL = new Set(['completed','ghosted','dropped','retired']);   // 'retired' = UGC terminal (C1, S177)

// UGC pipeline stage set (Reann Batch C1, S177). Reuses engagements with
// engagement_type='ugc'; vault/paused are non-terminal holds (vault reopenable to live).
const UGC_STAGES = ['outreach','agreed','shipped','delivered','draft','live','paused','vault','retired','dropped'];

// Free model: from any stage you may move to any other (terminals reopenable).
function allowedTransitions(stage) {
  return STAGES.filter(s => s !== stage);
}

// ── Util ────────────────────────────────────────────────────────────────────

function pickPatch(body, allowed) {
  if (!body || typeof body.patch !== 'object') return {};
  const patch = {};
  for (const k of allowed) {
    if (k in body.patch) patch[k] = body.patch[k];
  }
  return patch;
}

function nowIso() { return new Date().toISOString(); }
// IST (UTC+5:30) YYYY-MM key for month attribution (UGC dashboard, C1).
function istMonthKey(d) {
  const ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}`;
}
// Render the UGC brief / written-agreement body (C1 #11). Logged to ugc_briefs.
function renderUgcBrief(f, e) {
  const lines = [];
  lines.push(`UGC Brief & Agreement — ${f.creator || 'Creator'}${f.handle ? ' (@' + f.handle + ')' : ''}`);
  lines.push('');
  lines.push(`Product(s): ${f.products}`);
  lines.push(`Deal: ${f.is_barter ? 'Barter' : 'Paid'}${f.creator_fee != null ? ' — creator fee ₹' + f.creator_fee : ''}${f.commission_rate != null ? ' + ' + f.commission_rate + '% commission' : ''}`);
  if (f.hook_version || f.hook_script) lines.push(`Hook ${f.hook_version || ''}: ${f.hook_script || ''}`.trim());
  lines.push('');
  lines.push('Creative guidelines:');
  lines.push('• Show the product/car in motion for 15–20 seconds.');
  lines.push('• Mention the discount code verbally + put the link in the caption.');
  lines.push('• Tag @legendoftoys and include the agreed partnership / #ad disclosure.');
  if (e.expected_post_date) lines.push(`• Target posting date: ${e.expected_post_date}.`);
  lines.push('');
  lines.push('This brief also serves as the written agreement for the deal terms above.');
  return lines.join('\n');
}

async function mintEngagementNo(env, year) {
  const yyyy = year || String(new Date().getUTCFullYear());
  const r = await sbStore(`/rest/v1/rpc/next_engagement_seq`, env, {
    method: 'POST',
    headers: { 'Accept-Profile': 'ignition', 'Content-Profile': 'ignition' },
    body: JSON.stringify({ p_year: yyyy }),
  });
  if (!r.ok || typeof r.data !== 'number') return null;
  const seq = String(r.data).padStart(5, '0');
  return `IGN-${yyyy}-${seq}`;
}

// Atomic influencer-code mint (IN<n>) from store.sequences (RULE-IGN-001/002).
async function mintInfluencerCode(env) {
  const r = await sbStore(`/rest/v1/rpc/next_influencer_seq`, env, {
    method: 'POST',
    headers: { 'Accept-Profile': 'ignition', 'Content-Profile': 'ignition' },
    body: JSON.stringify({}),
  });
  if (!r.ok || typeof r.data !== 'number') return null;
  return `IN${r.data}`;
}

async function writeHistory(env, engagement_id, action, from, to, note, actor) {
  return sb(`/rest/v1/engagement_history`, env, {
    method: 'POST',
    body: JSON.stringify([{
      engagement_id, action, stage_from: from || null, stage_to: to || null,
      note: note || null, actor: actor || null,
    }]),
    prefer: 'return=minimal',
  });
}

// ────────────────────────────────────────────────────────────────────────────
// GET ACTIONS
// ────────────────────────────────────────────────────────────────────────────

const INFLUENCER_TYPES = ['nano', 'micro', 'macro', 'brand', 'store'];

// Scope filters shared by getInfluencers + getInfluencerCounts — everything
// EXCEPT influencer_type, so the type-breakdown cards stay a faithful facet of
// whatever else (tab / search / rating / location / reach) is currently applied.
function influencerScopeFilters(url) {
  const tab = (url.searchParams.get('tab') || 'master').toLowerCase();
  const category = url.searchParams.get('category');
  const location = url.searchParams.get('location');
  const rating = url.searchParams.get('rating');
  const search = (url.searchParams.get('search') || '').trim();
  const reachMin = url.searchParams.get('reach_min');
  const reachMax = url.searchParams.get('reach_max');

  const filters = [];
  if (tab === 'master')   filters.push('list_status=eq.master');
  else if (tab === 'b_list') filters.push('list_status=eq.b_list');
  else if (tab === 'archived') filters.push('list_status=eq.archived');
  if (location) filters.push(`location=ilike.*${encodeURIComponent(location)}*`);
  if (rating)   filters.push(`quality_rating=eq.${encodeURIComponent(rating)}`);
  if (category) filters.push(`categories=cs.{${encodeURIComponent(category)}}`);
  if (reachMin && Number.isFinite(Number(reachMin))) filters.push(`reach=gte.${Number(reachMin)}`);
  if (reachMax && Number.isFinite(Number(reachMax))) filters.push(`reach=lt.${Number(reachMax)}`);
  if (search) {
    const s = encodeURIComponent(search);
    filters.push(`or=(channel_name.ilike.*${s}*,person_name.ilike.*${s}*,email.ilike.*${s}*,contact_number.ilike.*${s}*,influencer_code.ilike.*${s}*)`);
  }
  return filters;
}

// Map a UI type selection to a PostgREST filter ('__untyped__' → IS NULL).
function influencerTypeFilter(type) {
  if (!type) return null;
  if (type === '__untyped__') return 'influencer_type=is.null';
  return `influencer_type=eq.${encodeURIComponent(type)}`;
}

// Sort options for the influencer list. 'code' = "arranged in sequence" (Reann
// ask #2) — by code prefix then numeric seq via the generated sort columns.
const INFLUENCER_SORTS = {
  recent: 'updated_at.desc',
  code:   'code_prefix.asc,code_seq.asc.nullslast',
  reach:  'reach.desc.nullslast',
};

async function getInfluencers(url, auth, env) {
  const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
  const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);
  const order = INFLUENCER_SORTS[url.searchParams.get('sort')] || INFLUENCER_SORTS.recent;

  const filters = influencerScopeFilters(url);
  const typeF = influencerTypeFilter(url.searchParams.get('type'));
  if (typeF) filters.push(typeF);

  const qs = filters.join('&');
  const r = await sb(
    `/rest/v1/influencers?${qs}&select=*&order=${order}&limit=${limit}&offset=${offset}`,
    env,
  );
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);
  return ok({ influencers: r.data || [], offset, limit });
}

// Exact row count via PostgREST count=exact (reads the Content-Range header).
async function countInfluencers(filters, env) {
  const qs = [...filters, 'select=id', 'limit=1'].join('&');
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/influencers?${qs}`, {
    headers: {
      'apikey':         env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization':  `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Accept-Profile': 'ignition',
      'Prefer':         'count=exact',
      'Range-Unit':     'items',
      'Range':          '0-0',
    },
  });
  const cr = res.headers.get('content-range') || '';
  const total = Number(cr.split('/')[1]);
  return Number.isFinite(total) ? total : 0;
}

// Type breakdown for the type cards. Honours every scope filter EXCEPT type, so
// the cards always show the full type distribution you can drill into. Untyped
// is derived (total − sum of known types) to save a query.
// Sum of reach across the scoped set (Reann ask #7 — "total reach"). Fetches the
// reach-only projection (small int column) and sums in JS; aggregate functions
// are not relied on (may be disabled in PostgREST).
async function sumReach(filters, env) {
  const qs = [...filters, 'reach=not.is.null', 'select=reach', 'limit=20000'].join('&');
  const r = await sb(`/rest/v1/influencers?${qs}`, env);
  if (!r.ok || !Array.isArray(r.data)) return 0;
  return r.data.reduce((acc, row) => acc + (Number(row.reach) || 0), 0);
}

async function getInfluencerCounts(url, auth, env) {
  const base = influencerScopeFilters(url);
  const [total, totalReach, ...typeCounts] = await Promise.all([
    countInfluencers(base, env),
    sumReach(base, env),
    ...INFLUENCER_TYPES.map(t => countInfluencers([...base, `influencer_type=eq.${t}`], env)),
  ]);
  const counts = {};
  let known = 0;
  INFLUENCER_TYPES.forEach((t, i) => { counts[t] = typeCounts[i]; known += typeCounts[i]; });
  return ok({ total, total_reach: totalReach, counts, untyped: Math.max(total - known, 0) });
}

async function getInfluencer(url, auth, env) {
  const id = url.searchParams.get('id');
  const code = url.searchParams.get('code');
  if (!id && !code) return err('id or code required', 400);
  const filter = id ? `id=eq.${id}` : `influencer_code=eq.${encodeURIComponent(code)}`;
  const r = await sb(`/rest/v1/influencers?${filter}&select=*&limit=1`, env);
  if (!r.ok) return err('db_error', 500);
  const inf = r.data?.[0];
  if (!inf) return err('not_found', 404);

  // Pull history of engagements
  const er = await sb(
    `/rest/v1/engagements?influencer_id=eq.${inf.id}&select=*&order=created_at.desc`,
    env,
  );
  return ok({ influencer: inf, engagements: er.data || [] });
}

async function getEngagements(url, auth, env) {
  const type = url.searchParams.get('type');
  const stage = url.searchParams.get('stage');
  const product = url.searchParams.get('product');
  const dealType = url.searchParams.get('deal_type');
  const dateFrom = url.searchParams.get('date_from');
  const dateTo = url.searchParams.get('date_to');
  const search = (url.searchParams.get('search') || '').trim();
  const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
  const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);

  const stages = url.searchParams.get('stages');   // multi-stage filter (Reann #11)
  const filters = [];
  if (type && type !== 'all') filters.push(`engagement_type=eq.${encodeURIComponent(type)}`);
  if (stages) {
    const list = stages.split(',').map(s => s.trim()).filter(Boolean).map(encodeURIComponent).join(',');
    if (list) filters.push(`stage=in.(${list})`);
  } else if (stage) {
    filters.push(`stage=eq.${encodeURIComponent(stage)}`);
  }
  if (product)  filters.push(`product_code=eq.${encodeURIComponent(product)}`);
  if (dealType) filters.push(`deal_type=eq.${encodeURIComponent(dealType)}`);
  if (dateFrom) filters.push(`post_date=gte.${dateFrom}`);
  if (dateTo)   filters.push(`post_date=lte.${dateTo}`);
  if (search) {
    const s = encodeURIComponent(search);
    filters.push(`or=(engagement_no.ilike.*${s}*,video_link.ilike.*${s}*,tracking_id.ilike.*${s}*,shipping_order_id.ilike.*${s}*)`);
  }

  const qs = filters.join('&');
  const r = await sb(
    `/rest/v1/engagements?${qs}&select=*,influencer:influencer_id(influencer_code,channel_name,person_name,influencer_type)&order=updated_at.desc&limit=${limit}&offset=${offset}`,
    env,
  );
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);
  return ok({ engagements: r.data || [], offset, limit });
}

async function getEngagement(url, auth, env) {
  const id = url.searchParams.get('id');
  const eno = url.searchParams.get('engagement_no');
  if (!id && !eno) return err('id or engagement_no required', 400);
  const filter = id ? `id=eq.${id}` : `engagement_no=eq.${encodeURIComponent(eno)}`;
  const r = await sb(
    `/rest/v1/engagements?${filter}&select=*,influencer:influencer_id(*)&limit=1`,
    env,
  );
  if (!r.ok) return err('db_error', 500);
  const eng = r.data?.[0];
  if (!eng) return err('not_found', 404);

  const [hr, nr, ar, pr, epr, ubr] = await Promise.all([
    sb(`/rest/v1/engagement_history?engagement_id=eq.${eng.id}&select=*&order=created_at.desc&limit=200`, env),
    sb(`/rest/v1/engagement_notes?engagement_id=eq.${eng.id}&select=*&order=created_at.desc&limit=200`, env),
    sb(`/rest/v1/engagement_attachments?engagement_id=eq.${eng.id}&select=*&order=created_at.desc&limit=200`, env),
    sb(`/rest/v1/payments?engagement_id=eq.${eng.id}&select=*&order=paid_on.desc,created_at.desc&limit=200`, env),
    sb(`/rest/v1/engagement_products?engagement_id=eq.${eng.id}&select=*&order=sort_order.asc`, env),
    sb(`/rest/v1/ugc_briefs?engagement_id=eq.${eng.id}&select=*&order=created_at.desc&limit=50`, env),
  ]);

  const payments = pr.data || [];
  const paid_total = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);

  // Multi-product lines (#4). Legacy single-product deals (no lines yet) get a
  // synthesized line from the engagement row so the UI always has ≥1 product.
  let products = epr.data || [];
  if (!products.length && eng.product_code) {
    products = [{
      id: null, engagement_id: eng.id, product_code: eng.product_code,
      product_variant: eng.product_variant || null, quantity: 1,
      goodies_cost: eng.goodies_cost ?? null, shipping_cost: eng.shipping_cost ?? null,
      sort_order: 0, synthesized: true,
    }];
  }

  return ok({
    engagement: eng,
    products,
    ugc_briefs: ubr.data || [],
    history: hr.data || [],
    notes: nr.data || [],
    attachments: ar.data || [],
    payments,
    paid_total: Math.round(paid_total),
    allowed_next: allowedTransitions(eng.stage),
  });
}

async function getRoster(url, auth, env) {
  // Derived: influencers who have at least one engagement past 'shipped'.
  const rating = url.searchParams.get('rating');
  const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500);
  const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);

  const filters = [];
  if (rating) filters.push(`quality_rating=eq.${encodeURIComponent(rating)}`);
  filters.push('list_status=neq.archived');

  const r = await sb(
    `/rest/v1/influencers?${filters.join('&')}&select=*,engagements:engagements!influencer_id(id,engagement_no,stage,post_date,closed_reason)&order=updated_at.desc&limit=${limit}&offset=${offset}`,
    env,
  );
  if (!r.ok) return err('db_error', 500);
  // Roster = influencers with at least one engagement in shipped+ stages.
  const PROGRESSED = new Set(['shipped','delivered','scheduled','posting','live','completed']);
  const rows = (r.data || []).filter(i => (i.engagements || []).some(e => PROGRESSED.has(e.stage)));
  return ok({ roster: rows, offset, limit });
}

async function getDiscountCodes(url, auth, env) {
  const utilized = url.searchParams.get('utilized');
  const pool = url.searchParams.get('pool');
  const engagementId = url.searchParams.get('engagement_id');
  const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500);
  const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);

  const filters = [];
  if (utilized != null) filters.push(`utilized=eq.${utilized === 'true'}`);
  if (pool)             filters.push(`pool_label=eq.${encodeURIComponent(pool)}`);
  if (engagementId)     filters.push(`engagement_id=eq.${engagementId}`);

  const r = await sb(
    `/rest/v1/discount_codes?${filters.join('&')}&select=*&order=created_at.desc&limit=${limit}&offset=${offset}`,
    env,
  );
  if (!r.ok) return err('db_error', 500);
  return ok({ codes: r.data || [], offset, limit });
}

// Roll up the embedded engagements of a campaign into summary numbers.
// PostgREST returns numeric columns as strings — coerce with Number().
function campaignRollup(c) {
  const engs = c.engagements || [];
  const num = v => Number(v) || 0;
  const POSTED = new Set(['posting', 'live', 'completed']);
  const spend = engs.reduce((s, e) => s + (e.total_cost != null ? num(e.total_cost) : num(e.payment_amount)), 0);
  return {
    linked_count: engs.length,
    posted_count: engs.filter(e => POSTED.has(e.stage)).length,
    spend,
    views: engs.reduce((s, e) => s + num(e.views), 0),
    orders: engs.reduce((s, e) => s + num(e.orders), 0),
  };
}

const CAMPAIGN_ENG_SELECT =
  'engagements:engagements!campaign_id(id,engagement_no,engagement_type,stage,product_code,product_variant,payment_amount,total_cost,views,orders,post_date,expected_post_date,video_link)';

async function getCampaigns(url, auth, env) {
  const status = url.searchParams.get('status');
  const filters = [];
  if (status) filters.push(`status=eq.${encodeURIComponent(status)}`);
  const r = await sb(
    `/rest/v1/campaigns?${filters.join('&')}&select=*,influencer:influencer_id(influencer_code,channel_name,person_name),${CAMPAIGN_ENG_SELECT}&order=created_at.desc`,
    env,
  );
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);
  const campaigns = (r.data || []).map(c => ({ ...c, rollup: campaignRollup(c) }));
  return ok({ campaigns });
}

async function getCampaign(url, auth, env) {
  const id = url.searchParams.get('id');
  const no = url.searchParams.get('campaign_no');
  if (!id && !no) return err('id or campaign_no required', 400);
  const filter = id ? `id=eq.${id}` : `campaign_no=eq.${encodeURIComponent(no)}`;
  const r = await sb(
    `/rest/v1/campaigns?${filter}&select=*,influencer:influencer_id(*),${CAMPAIGN_ENG_SELECT}&limit=1`,
    env,
  );
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);
  const c = r.data?.[0];
  if (!c) return err('not_found', 404);
  return ok({ campaign: { ...c, rollup: campaignRollup(c) } });
}

// Delete a campaign (Reann #1). Refuses if any engagement is still linked (detach first).
async function deleteCampaign(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.campaign_id) return err('campaign_id required', 400);
  const lr = await sb(`/rest/v1/engagements?campaign_id=eq.${body.campaign_id}&select=id&limit=500`, env);
  const n = (lr.data || []).length;
  if (n > 0) return err(`campaign_has_${n}_linked_engagements`, 409);
  const dr = await sb(`/rest/v1/campaigns?id=eq.${body.campaign_id}`, env, { method: 'DELETE', prefer: 'return=minimal' });
  if (!dr.ok) return err(`db_error: ${JSON.stringify(dr.data)}`, 400);
  return ok({ deleted: true });
}

// UGC pipeline dashboard + table (Reann Batch C1, S177). One read + JS aggregation.
async function getUgcPipeline(_url, auth, env) {
  const r = await sb(
    `/rest/v1/engagements?engagement_type=eq.ugc&select=*,influencer:influencer_id(channel_name,person_name,channel_link,channel_platform,follower_count,contact_number)&order=updated_at.desc&limit=1000`,
    env,
  );
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);
  const engs = r.data || [];
  const num = v => Number(v) || 0;
  const now = new Date();
  const monthKey = istMonthKey(now);
  const TERMINAL_UGC = new Set(['retired', 'dropped']);
  let month_ad_spend = 0, month_revenue = 0, commissions_owed = 0, active_creatives = 0;
  const by_stage = {};
  const rows = engs.map(e => {
    const inf = e.influencer || {};
    const adSpend = num(e.ad_spend);
    const revenue = num(e.conversions_value);
    const roas = adSpend > 0 ? revenue / adSpend : null;
    const commOutstanding = Math.max(0, num(e.commission_earned) - num(e.commission_paid));
    const feeUnpaid = (e.creator_fee_status !== 'paid') ? num(e.payment_amount) : 0;
    by_stage[e.stage] = (by_stage[e.stage] || 0) + 1;
    if (!TERMINAL_UGC.has(e.stage)) active_creatives += 1;
    commissions_owed += commOutstanding;
    const when = e.live_at || e.post_date;
    if (when && istMonthKey(new Date(when)) === monthKey) { month_ad_spend += adSpend; month_revenue += revenue; }
    let days_active = null;
    if (e.live_at && !TERMINAL_UGC.has(e.stage)) {
      days_active = Math.floor((now.getTime() - new Date(e.live_at).getTime()) / 86400000);
    }
    return {
      id: e.id, engagement_no: e.engagement_no, stage: e.stage,
      creator_name: inf.person_name || inf.channel_name || null,
      ig_handle: inf.channel_name || null, channel_link: inf.channel_link || null,
      follower_count: inf.follower_count ?? null,
      ad_spend: adSpend, revenue, roas, days_active,
      amount_owed: commOutstanding + feeUnpaid, commission_outstanding: commOutstanding,
    };
  });
  const blended_roas = month_ad_spend > 0 ? month_revenue / month_ad_spend : null;
  return ok({
    summary: { active_creatives, month_ad_spend, month_revenue, blended_roas, commissions_owed, by_stage },
    rows,
  });
}

// Generate + log a UGC brief / written agreement (Reann #11). Each call logs a
// timestamped version (the paper trail). Email send is Batch B.
async function generateUgcBrief(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.engagement_id) return err('engagement_id required', 400);
  const er = await sb(`/rest/v1/engagements?id=eq.${body.engagement_id}&select=*,influencer:influencer_id(channel_name,person_name,email,contact_number)&limit=1`, env);
  if (!er.ok || !er.data?.[0]) return err('not_found', 404);
  const e = er.data[0];
  const inf = e.influencer || {};
  const lr = await sb(`/rest/v1/engagement_products?engagement_id=eq.${body.engagement_id}&select=product_code,product_variant,quantity&order=sort_order.asc`, env);
  let products = (lr.ok ? lr.data || [] : []);
  if (!products.length && e.product_code) products = [{ product_code: e.product_code, product_variant: e.product_variant, quantity: 1 }];
  const productList = products.map(p => `${p.product_code}${p.product_variant ? ' / ' + p.product_variant : ''}${p.quantity ? ' ×' + p.quantity : ''}`).join(', ') || '—';
  const fields = {
    creator: inf.person_name || inf.channel_name || null, handle: inf.channel_name || null,
    products: productList, creator_fee: e.payment_amount ?? null, is_barter: !!e.is_barter,
    commission_rate: e.commission_rate ?? null, hook_version: e.hook_version || null, hook_script: e.hook_script || null,
  };
  const bodyText = renderUgcBrief(fields, e);
  const ins = await sb(`/rest/v1/ugc_briefs`, env, { method: 'POST', body: JSON.stringify([{ engagement_id: body.engagement_id, body: bodyText, fields, created_by: auth.userId }]) });
  if (!ins.ok) return err(`db_error: ${JSON.stringify(ins.data)}`, 400);
  return ok({ brief: ins.data?.[0] || null });
}

// POC dropdown source (Reann #5): people on roles that carry ignition_view.
async function getIgnitionUsers(_url, auth, env) {
  const rr = await sbStore(`/rest/v1/roles?select=role_id,permissions`, env);
  const roleIds = (rr.ok ? rr.data || [] : [])
    .filter(r => r.permissions && (r.permissions.ignition_view === true || r.permissions.ignition_view === 'true'))
    .map(r => r.role_id);
  if (!roleIds.length) return ok({ users: [] });
  const inList = roleIds.map(encodeURIComponent).join(',');
  const ur = await sbStore(`/rest/v1/users_profile?active=eq.true&role=in.(${inList})&select=id,full_name&order=full_name.asc`, env);
  return ok({ users: (ur.ok ? ur.data || [] : []).filter(u => u.full_name) });
}

async function getKpis(url, auth, env) {
  // Header tile counts. Three quick queries via Prefer: count.
  async function count(filter) {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/engagements?${filter}&select=id`, {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Accept-Profile': 'ignition',
        'Prefer': 'count=exact',
        'Range-Unit': 'items',
        'Range': '0-0',
      },
    });
    const cr = res.headers.get('content-range');
    if (!cr) return 0;
    const m = cr.match(/\/(\d+)$/);
    return m ? Number(m[1]) : 0;
  }
  // Active = anything not terminal (completed/ghosted/dropped), incl. delayed/on_hold.
  const ACTIVE = "stage=in.(planning,agreed,shipped,delivered,scheduled,posting,live,delayed,on_hold)";
  // `closed` KPI now counts Completed deals (frontend key kept for compat).
  const [active, live, closed, ghosted, overdue] = await Promise.all([
    count(ACTIVE),
    count('stage=eq.live'),
    count('stage=eq.completed'),
    count('stage=eq.ghosted'),
    count(overdueFilter()),
  ]);

  // All-time engagement totals + UGC summary (Reann dashboard tiles). One scan,
  // summed in JS (PostgREST has no SUM here) — ~2k small rows, within the budget.
  const num = v => (v == null || isNaN(Number(v)) ? 0 : Number(v));
  const spendOf = e => (e.total_cost != null ? num(e.total_cost) : num(e.payment_amount) + num(e.ad_spend) + num(e.commission_amount));
  let engagement_totals = { views: 0, likes: 0, shares: 0 };
  const ugc_summary = { deals: 0, views: 0, likes: 0, budget_consumed: 0, orders: 0, conversions_value: 0 };
  const aggR = await sb(
    `/rest/v1/engagements?select=engagement_type,views,likes,shares,orders,conversions_value,total_cost,payment_amount,ad_spend,commission_amount&limit=5000`,
    env,
  );
  if (aggR.ok) {
    for (const e of (aggR.data || [])) {
      const v = num(e.views), l = num(e.likes), s = num(e.shares);
      engagement_totals.views += v; engagement_totals.likes += l; engagement_totals.shares += s;
      if (e.engagement_type === 'ugc') {
        ugc_summary.deals += 1; ugc_summary.views += v; ugc_summary.likes += l;
        ugc_summary.budget_consumed += spendOf(e); ugc_summary.orders += num(e.orders);
        ugc_summary.conversions_value += num(e.conversions_value);
      }
    }
    ugc_summary.budget_consumed = Math.round(ugc_summary.budget_consumed);
    ugc_summary.conversions_value = Math.round(ugc_summary.conversions_value);
  }

  return ok({ active, live, closed, ghosted, overdue, engagement_totals, ugc_summary });
}

// ── Overdue-post detection (auto-rating signal) ──────────────────────────────
// An engagement is "overdue" when its expected post date has passed by more
// than `days` and it still hasn't gone live (no post_date, not in a posted/
// terminal stage). Drives the dashboard signal + the flagOverdueRatings sweep.
const OVERDUE_DEFAULT_DAYS = 7;
// Don't flag as overdue if it's already posting/posted/done, terminal, or
// deliberately paused/late (on_hold/delayed) — the team already knows about those.
const POSTED_OR_TERMINAL = ['posting', 'live', 'completed', 'ghosted', 'dropped', 'on_hold', 'delayed'];

function overdueCutoffDate(days) {
  const n = Number(days) || OVERDUE_DEFAULT_DAYS;
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}
function overdueFilter(days) {
  const cutoff = overdueCutoffDate(days);
  return `expected_post_date=lt.${cutoff}&post_date=is.null&stage=not.in.(${POSTED_OR_TERMINAL.join(',')})`;
}

async function getOverdueEngagements(url, auth, env) {
  const days = url.searchParams.get('days') || OVERDUE_DEFAULT_DAYS;
  const r = await sb(
    `/rest/v1/engagements?${overdueFilter(days)}&select=id,engagement_no,stage,product_code,product_variant,expected_post_date,influencer:influencer_id(id,influencer_code,channel_name,person_name,quality_rating)&order=expected_post_date.asc&limit=500`,
    env,
  );
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);
  const today = new Date().toISOString().slice(0, 10);
  const rows = (r.data || []).map(e => ({
    ...e,
    days_overdue: e.expected_post_date
      ? Math.floor((Date.parse(today) - Date.parse(e.expected_post_date)) / 86400000)
      : null,
  }));
  return ok({ overdue: rows, days: Number(days) || OVERDUE_DEFAULT_DAYS });
}

// Schedule — engagements with a planned (expected_post_date) or actual
// (post_date) date inside [from,to], for the calendar + list view. Each row's
// effective_date = post_date || expected_post_date; is_planned flags the ones
// not yet posted. Bounded window keeps one query.
async function getSchedule(url, auth, env) {
  const from = url.searchParams.get('from');
  const to   = url.searchParams.get('to');
  if (!from || !to) return err('from and to required (YYYY-MM-DD)', 400);
  const f = encodeURIComponent(from), t = encodeURIComponent(to);
  const dateOr = `or=(and(expected_post_date.gte.${f},expected_post_date.lte.${t}),and(post_date.gte.${f},post_date.lte.${t}))`;
  const r = await sb(
    `/rest/v1/engagements?${dateOr}&select=id,engagement_no,stage,engagement_type,product_code,product_variant,deal_type,expected_post_date,post_date,video_link,influencer:influencer_id(id,influencer_code,channel_name,person_name)&order=expected_post_date.asc&limit=1000`,
    env,
  );
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);
  const rows = (r.data || []).map(e => ({
    ...e,
    effective_date: e.post_date || e.expected_post_date,
    is_planned: !e.post_date,
  })).sort((a, b) => (a.effective_date || '').localeCompare(b.effective_date || ''));
  return ok({ engagements: rows, from, to });
}

// ── Payments ─────────────────────────────────────────────────────────────────
// Simple per-deal payment log (advance / final / other). One table; spend
// tiles are aggregated in JS from a single read.
const PAYMENT_KINDS = ['advance', 'final', 'other'];

async function addPayment(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.engagement_id) return err('engagement_id required', 400);
  const amount = Number(body.amount);
  if (!(amount >= 0)) return err('valid amount required', 400);
  // Payment screenshot is mandatory (Reann #12).
  if (!body.proof_path) return err('payment_proof_required', 400);
  const kind = PAYMENT_KINDS.includes(body.kind) ? body.kind : 'advance';

  const er = await sb(`/rest/v1/engagements?id=eq.${body.engagement_id}&select=influencer_id&limit=1`, env);
  if (!er.ok || !er.data?.[0]) return err('engagement_not_found', 404);

  const row = {
    engagement_id: body.engagement_id,
    influencer_id: er.data[0].influencer_id,
    kind,
    amount: Math.round(amount * 100) / 100,
    paid_on: body.paid_on || undefined,   // omit → DB default current_date
    note: body.note || null,
    proof_path: body.proof_path || null,  // payment screenshot (Reann #4)
    proof_name: body.proof_name || null,
    proof_mime: body.proof_mime || null,
    created_by: auth.userId,
  };
  const r = await sb(`/rest/v1/payments`, env, { method: 'POST', body: JSON.stringify([row]) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

async function deletePayment(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.id) return err('id required', 400);
  // Clean up the proof object too, if any.
  const pr = await sb(`/rest/v1/payments?id=eq.${body.id}&select=proof_path&limit=1`, env);
  const proofPath = pr.data?.[0]?.proof_path;
  const r = await sb(`/rest/v1/payments?id=eq.${body.id}`, env, { method: 'DELETE', prefer: 'return=minimal' });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  if (proofPath) {
    const seg = String(proofPath).split('/').map(encodeURIComponent).join('/');
    await storageFetch(`/object/${PAYMENT_PROOF_BUCKET}/${seg}`, env, { method: 'DELETE' });
  }
  return ok({ deleted: body.id });
}

// Reann #4 — payment proof: mint a signed upload URL into the private bucket. The
// client PUTs the file (uploadToSignedUrl), then sends proof_path to addPayment.
function safeSeg(s) { return encodeURIComponent(String(s || '').replace(/[^\w.\-]+/g, '_')); }

async function createPaymentProofUploadUrl(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.engagement_id) return err('engagement_id required', 400);
  if (!body.file_name) return err('file_name required', 400);
  const path = `${safeSeg(body.engagement_id)}/${Date.now()}_${safeSeg(body.file_name)}`;
  const sr = await storageFetch(`/object/upload/sign/${PAYMENT_PROOF_BUCKET}/${path}`, env, { method: 'POST' });
  if (!sr.ok || !sr.data?.url) return err(`sign_failed: ${JSON.stringify(sr.data)}`, 502);
  const tokenMatch = String(sr.data.url).match(/token=([^&]+)/);
  return ok({ storage_path: path, token: tokenMatch ? decodeURIComponent(tokenMatch[1]) : null });
}

// Signed GET URL to view a payment proof (short-lived).
async function getPaymentProofUrl(url, auth, env) {
  const gate = requirePerm('ignition_view', auth); if (gate) return gate;
  const id = url.searchParams.get('id');
  if (!id) return err('id required', 400);
  const pr = await sb(`/rest/v1/payments?id=eq.${id}&select=proof_path,proof_name,proof_mime&limit=1`, env);
  const p = pr.data?.[0];
  if (!p || !p.proof_path) return err('no_proof', 404);
  const seg = String(p.proof_path).split('/').map(encodeURIComponent).join('/');
  const sr = await storageFetch(`/object/sign/${PAYMENT_PROOF_BUCKET}/${seg}`, env, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 120 }),
  });
  if (!sr.ok || !sr.data?.signedURL) return err(`sign_failed: ${JSON.stringify(sr.data)}`, 502);
  return ok({ url: `${env.SUPABASE_URL}/storage/v1${sr.data.signedURL}`, file_name: p.proof_name, mime_type: p.proof_mime });
}

// Reann #3 — delete an influencer. Hard-delete only when it has NO engagements
// (junk/duplicate cleanup); refuse otherwise so history stays intact (archive instead).
async function deleteInfluencer(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.id) return err('id required', 400);
  const er = await sb(`/rest/v1/engagements?influencer_id=eq.${body.id}&select=id&limit=1`, env);
  if (er.ok && Array.isArray(er.data) && er.data.length > 0) {
    return err('has_engagements', 409);
  }
  const r = await sb(`/rest/v1/influencers?id=eq.${body.id}`, env, { method: 'DELETE', prefer: 'return=minimal' });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok({ deleted: body.id });
}

// ── Slice C — influencer growth history (manual periodic reach snapshots) ─────

async function getInfluencerMetrics(url, auth, env) {
  const id = url.searchParams.get('id');
  if (!id) return err('id required', 400);
  const r = await sb(
    `/rest/v1/influencer_metrics_history?influencer_id=eq.${id}&select=*&order=captured_on.asc`,
    env,
  );
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);
  return ok({ metrics: r.data || [] });
}

// Upsert one dated reach snapshot (one per influencer per day) and keep the
// influencer's current `reach` synced to its latest-dated snapshot.
async function addMetricSnapshot(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.influencer_id) return err('influencer_id required', 400);
  if (!body.captured_on) return err('captured_on required', 400);
  const reach = (body.reach === '' || body.reach == null) ? null : Math.round(Number(body.reach));
  if (reach != null && !Number.isFinite(reach)) return err('valid reach required', 400);

  const row = {
    influencer_id: body.influencer_id,
    captured_on: body.captured_on,
    reach,
    note: body.note || null,
    created_by: auth.userId,
  };
  const r = await sb(`/rest/v1/influencer_metrics_history?on_conflict=influencer_id,captured_on`, env, {
    method: 'POST',
    body: JSON.stringify([row]),
    prefer: 'resolution=merge-duplicates,return=representation',
  });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);

  const latest = await sb(
    `/rest/v1/influencer_metrics_history?influencer_id=eq.${body.influencer_id}&reach=not.is.null&select=reach&order=captured_on.desc&limit=1`,
    env,
  );
  const top = latest.data?.[0];
  if (top && top.reach != null) {
    await sb(`/rest/v1/influencers?id=eq.${body.influencer_id}`, env, {
      method: 'PATCH',
      body: JSON.stringify({ reach: top.reach, updated_at: nowIso() }),
      prefer: 'return=minimal',
    });
  }
  return ok(r.data?.[0]);
}

async function deleteMetricSnapshot(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.id) return err('id required', 400);
  const r = await sb(`/rest/v1/influencer_metrics_history?id=eq.${body.id}`, env, { method: 'DELETE', prefer: 'return=minimal' });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok({ deleted: body.id });
}

async function getPayments(url, auth, env) {
  const r = await sb(
    `/rest/v1/payments?select=*,influencer:influencer_id(influencer_code,channel_name,person_name),engagement:engagement_id(engagement_no,product_code)&order=paid_on.desc,created_at.desc&limit=2000`,
    env,
  );
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);
  const rows = r.data || [];

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const todayStr = now.toISOString().slice(0, 10);
  const monthStart = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-01`;
  const dow = (now.getUTCDay() + 6) % 7;                 // 0 = Monday
  const ws = new Date(now); ws.setUTCDate(now.getUTCDate() - dow);
  const weekStart = ws.toISOString().slice(0, 10);

  const tally = (pred) => {
    let amount = 0, count = 0; const infs = new Set();
    for (const p of rows) {
      if (!pred(p.paid_on)) continue;
      amount += Number(p.amount) || 0; count++;
      if (p.influencer_id) infs.add(p.influencer_id);
    }
    return { amount: Math.round(amount), count, influencers: infs.size };
  };
  const summary = {
    today: tally(d => d === todayStr),
    week:  tally(d => d >= weekStart),
    month: tally(d => d >= monthStart),
    all:   tally(() => true),
  };
  return ok({ payments: rows.slice(0, 200), summary });
}

// ── Reports (spend / ROAS / CPM / top performers) ───────────────────────────
// One range-scoped query over engagements; all aggregation happens in JS to
// stay within the 50-subrequest budget. Gated on ignition_reports_view.
async function getReports(url, auth, env) {
  const gate = requirePerm('ignition_reports_view', auth); if (gate) return gate;
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const filters = [];
  if (from) filters.push(`created_at=gte.${encodeURIComponent(from)}`);
  if (to) filters.push(`created_at=lte.${encodeURIComponent(to)}`);

  const r = await sb(
    `/rest/v1/engagements?${filters.join('&')}&select=engagement_no,created_at,post_date,product_code,engagement_type,deal_type,payment_amount,total_cost,ad_spend,commission_amount,views,likes,shares,orders,conversions_value,cpm,actual_roas,roas_on_ad_spend,influencer:influencer_id(influencer_code,channel_name,person_name,influencer_type)&order=created_at.desc&limit=5000`,
    env,
  );
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);
  const rows = r.data || [];
  const num = v => (v == null || isNaN(Number(v)) ? 0 : Number(v));
  const spendOf = e => (e.total_cost != null ? num(e.total_cost) : num(e.payment_amount) + num(e.ad_spend) + num(e.commission_amount));
  const roasOf = e => (e.actual_roas != null ? num(e.actual_roas) : (e.roas_on_ad_spend != null ? num(e.roas_on_ad_spend) : null));

  // Spend / orders / views by month (post_date if posted, else created_at).
  const byMonthMap = {};
  const byProductMap = {};
  let totalSpend = 0, totalOrders = 0, totalViews = 0, totalConv = 0;
  let totLikes = 0, totShares = 0;
  let cpmSum = 0, cpmN = 0, roasSum = 0, roasN = 0;
  const byTierMap = {};
  const ugcAgg = { deals: 0, views: 0, likes: 0, budget_consumed: 0, orders: 0, conversions_value: 0 };

  const ROAS_BUCKETS = [{ k: '<1', lo: -Infinity, hi: 1 }, { k: '1–2', lo: 1, hi: 2 }, { k: '2–3', lo: 2, hi: 3 }, { k: '3–5', lo: 3, hi: 5 }, { k: '5+', lo: 5, hi: Infinity }];
  const CPM_BUCKETS = [{ k: '<50', lo: -Infinity, hi: 50 }, { k: '50–100', lo: 50, hi: 100 }, { k: '100–200', lo: 100, hi: 200 }, { k: '200–500', lo: 200, hi: 500 }, { k: '500+', lo: 500, hi: Infinity }];
  const roasDist = Object.fromEntries(ROAS_BUCKETS.map(b => [b.k, 0]));
  const cpmDist = Object.fromEntries(CPM_BUCKETS.map(b => [b.k, 0]));
  const bucketOf = (buckets, v) => (buckets.find(b => v >= b.lo && v < b.hi) || buckets[buckets.length - 1]).k;

  for (const e of rows) {
    const spend = spendOf(e);
    const orders = num(e.orders), views = num(e.views), conv = num(e.conversions_value);
    const likes = num(e.likes), shares = num(e.shares);
    totalSpend += spend; totalOrders += orders; totalViews += views; totalConv += conv;
    totLikes += likes; totShares += shares;

    // By influencer tier (Reann analytics): delivered views/likes/shares + distinct active influencers.
    const tier = (e.influencer && e.influencer.influencer_type) || 'untyped';
    const t = byTierMap[tier] || (byTierMap[tier] = { tier, deals: 0, views: 0, likes: 0, shares: 0, spend: 0, orders: 0, conversions_value: 0, influencer_ids: new Set() });
    t.deals += 1; t.views += views; t.likes += likes; t.shares += shares; t.spend += spend; t.orders += orders; t.conversions_value += conv;
    if (e.influencer && e.influencer.influencer_code) t.influencer_ids.add(e.influencer.influencer_code);

    // UGC rollup
    if (e.engagement_type === 'ugc') {
      ugcAgg.deals += 1; ugcAgg.views += views; ugcAgg.likes += likes;
      ugcAgg.budget_consumed += spend; ugcAgg.orders += orders; ugcAgg.conversions_value += conv;
    }

    const month = (e.post_date || e.created_at || '').slice(0, 7);
    if (month) {
      const m = byMonthMap[month] || (byMonthMap[month] = { month, spend: 0, orders: 0, views: 0, deals: 0 });
      m.spend += spend; m.orders += orders; m.views += views; m.deals += 1;
    }
    const prod = e.product_code || '—';
    const p = byProductMap[prod] || (byProductMap[prod] = { name: prod, deals: 0, spend: 0, orders: 0, views: 0 });
    p.deals += 1; p.spend += spend; p.orders += orders; p.views += views;

    if (e.cpm != null) { const c = num(e.cpm); cpmSum += c; cpmN++; cpmDist[bucketOf(CPM_BUCKETS, c)]++; }
    const roas = roasOf(e);
    if (roas != null) { roasSum += roas; roasN++; roasDist[bucketOf(ROAS_BUCKETS, roas)]++; }
  }

  const byMonth = Object.values(byMonthMap).sort((a, b) => a.month.localeCompare(b.month))
    .map(m => ({ ...m, spend: Math.round(m.spend) }));
  const byProduct = Object.values(byProductMap).sort((a, b) => b.spend - a.spend)
    .map(p => ({ ...p, spend: Math.round(p.spend) }));

  const by_tier = Object.values(byTierMap)
    .map(t => ({
      tier: t.tier, deals: t.deals, views: t.views, likes: t.likes, shares: t.shares,
      spend: Math.round(t.spend), orders: t.orders, conversions_value: Math.round(t.conversions_value),
      influencer_count: t.influencer_ids.size,
      avg_views_per_influencer: t.influencer_ids.size ? Math.round(t.views / t.influencer_ids.size) : 0,
    }))
    .sort((a, b) => b.views - a.views);
  const engagement_totals = { views: totalViews, likes: totLikes, shares: totShares };
  const ugc = { ...ugcAgg, budget_consumed: Math.round(ugcAgg.budget_consumed), conversions_value: Math.round(ugcAgg.conversions_value) };

  const topPerformers = rows
    .map(e => ({
      engagement_no: e.engagement_no,
      influencer: e.influencer?.channel_name || e.influencer?.person_name || e.influencer?.influencer_code || '—',
      product: e.product_code || '—',
      orders: num(e.orders),
      conversions_value: Math.round(num(e.conversions_value)),
      spend: Math.round(spendOf(e)),
      roas: roasOf(e),
    }))
    .filter(e => e.orders > 0 || e.conversions_value > 0 || e.roas != null)
    .sort((a, b) => (b.conversions_value - a.conversions_value) || (b.orders - a.orders))
    .slice(0, 15);

  return ok({
    range: { from: from || null, to: to || null, total_deals: rows.length },
    totals: {
      deals: rows.length,
      spend: Math.round(totalSpend),
      orders: totalOrders,
      views: totalViews,
      conversions_value: Math.round(totalConv),
      avg_cpm: cpmN ? Math.round((cpmSum / cpmN) * 100) / 100 : null,
      avg_roas: roasN ? Math.round((roasSum / roasN) * 100) / 100 : null,
    },
    by_month: byMonth,
    by_product: byProduct,
    roas_distribution: ROAS_BUCKETS.map(b => ({ bucket: b.k, count: roasDist[b.k] })),
    cpm_distribution: CPM_BUCKETS.map(b => ({ bucket: b.k, count: cpmDist[b.k] })),
    top_performers: topPerformers,
    by_tier,
    engagement_totals,
    ugc,
  });
}

// Distinct non-empty influencer locations for the master-list location filter
// (Reann ask #1). Deduped + trimmed + sorted in JS.
async function getLocations(url, auth, env) {
  const r = await sb(
    `/rest/v1/influencers?location=not.is.null&select=location&limit=20000`,
    env,
  );
  if (!r.ok || !Array.isArray(r.data)) return ok({ locations: [] });
  const set = new Set();
  for (const row of r.data) {
    const v = (row.location || '').trim();
    if (v) set.add(v);
  }
  return ok({ locations: [...set].sort((a, b) => a.localeCompare(b)) });
}

async function getCatalogs(url, auth, env) {
  // Static enums + product list from store schema.
  const productsRes = await sbStore(
    `/rest/v1/product_master?select=name,sku&order=name`,
    env,
  ).catch(() => ({ data: [] }));
  return ok({
    influencer_types: ['nano','micro','macro','brand','store'],
    deal_types: ['paid','barter','affiliate','paid_plus_affiliate'],
    payment_terms: ['advance','on_draft','on_release','n_a'],
    engagement_types: ['video_tracking','ugc'],
    stages: STAGES,
    closed_reasons: ['completed','ghosted','declined','dropped','historical_import'],
    list_statuses: ['master','b_list','archived'],
    quality_ratings: ['green','yellow','red','unrated'],
    directed_to: ['website','amazon','flipkart'],
    products: productsRes.data || [],
  });
}

async function getMe(url, auth, env) {
  return ok({
    userId: auth.userId,
    email: auth.email,
    role: auth.role,
    fullName: auth.fullName,
    permissions: auth.permissions,
  });
}

// ── Shopify lookups ──────────────────────────────────────────────────────────

// Generic ad-hoc lookup by phone/email (parity with csops searchShopifyCustomer).
async function searchShopifyCustomer(url, auth, env) {
  const phone = url.searchParams.get('phone');
  const email = url.searchParams.get('email');
  if (!phone && !email) return err('phone or email required', 400);
  return ok(await shopifyLookup({ phone, email }, env));
}

// Influencer → Shopify customer match. Resolves the influencer's stored
// contact_number (email fallback), then looks the customer up on Shopify.
// On-demand (UI-triggered), mirrors Pitstop's ShopifyPanel — does NOT slow
// the main getInfluencer read. Safe before secrets are set (configured:false).
async function getInfluencerShopify(url, auth, env) {
  const id = url.searchParams.get('id');
  const code = url.searchParams.get('code');
  if (!id && !code) return err('id or code required', 400);
  const filter = id ? `id=eq.${id}` : `influencer_code=eq.${encodeURIComponent(code)}`;
  const r = await sb(`/rest/v1/influencers?${filter}&select=influencer_code,contact_number,email&limit=1`, env);
  if (!r.ok) return err('db_error', 500);
  const inf = r.data?.[0];
  if (!inf) return err('not_found', 404);
  if (!inf.contact_number && !inf.email) {
    return ok({ influencer_code: inf.influencer_code, matched_by: null, configured: true, found: false, customer: null, recent_orders: [] });
  }
  const result = await shopifyLookup({ phone: inf.contact_number, email: inf.email }, env);
  const matched_by = result.found ? (inf.contact_number ? 'phone' : 'email') : null;
  return ok({ influencer_code: inf.influencer_code, matched_by, ...result });
}

// ────────────────────────────────────────────────────────────────────────────
// POST ACTIONS
// ────────────────────────────────────────────────────────────────────────────

const INFLUENCER_FIELDS = [
  'channel_name','person_name','channel_link','channel_platform','channel_platforms',
  'influencer_type','categories','reach','follower_count','audience','location',
  'contact_number','address','email','contact_poc_type','contact_poc_name',
  'first_invite_sent_at','list_status','quality_rating','rating_notes',
  'onboarded','onboarded_at',
];

const ENGAGEMENT_FIELDS = [
  'engagement_type','campaign_id','product_code','product_variant',
  'deal_type','payment_terms','payment_amount','affiliate_pct','commission_amount',
  'ad_spend','goodies_cost','shipping_cost','return_cost','cpm',
  'expected_post_date','post_date','delivered_date','video_link','utm_link',
  'utm_source','utm_medium','utm_campaign',
  'views','likes','comments','shares','impressions','sessions','orders',
  'conversions_value','roas_on_ad_spend','actual_roas','orders_cc',
  'shipping_order_id','tracking_id','shipping_month','shipping_date','directed_to',
  'poc_user_id','poc_name',
  // UGC pipeline (Reann Batch C1, S177) — live_at is worker-stamped only (not here).
  'hook_version','hook_script','meta_ad_id','tracking_url',
  'creator_fee_status','creator_fee_paid_date','is_barter',
  'commission_rate','commission_earned','commission_paid',
  'ctr','frequency','purchases',
];

// ── Multi-product engagement lines (Reann Batch A #4, S177) ──────────────────
// Each deal can carry several products. Per-product cost lives on the child line;
// the worker rolls Σ goodies/shipping up into the engagement's cost columns + mirrors
// the first line into engagements.product_code/variant, so the GENERATED total_cost
// and every single-product reader/report stay correct untouched.
async function insertEngagementProducts(env, engagement_id, products) {
  const rows = (products || [])
    .filter(p => p && p.product_code)
    .map((p, i) => ({
      engagement_id,
      product_code: p.product_code,
      product_variant: p.product_variant || null,
      quantity: Math.round(Number(p.quantity) || 1),
      goodies_cost: (p.goodies_cost != null && p.goodies_cost !== '') ? Number(p.goodies_cost) : null,
      shipping_cost: (p.shipping_cost != null && p.shipping_cost !== '') ? Number(p.shipping_cost) : null,
      sort_order: i,
    }));
  if (!rows.length) return;
  await sb(`/rest/v1/engagement_products`, env, {
    method: 'POST', prefer: 'return=minimal', body: JSON.stringify(rows),
  });
}

async function rollupEngagementProducts(env, engagement_id) {
  const lr = await sb(
    `/rest/v1/engagement_products?engagement_id=eq.${engagement_id}&select=product_code,product_variant,goodies_cost,shipping_cost&order=sort_order.asc`,
    env,
  );
  const lines = lr.ok ? (lr.data || []) : [];
  if (!lines.length) return;
  const sum = (k) => lines.reduce((s, l) => s + (Number(l[k]) || 0), 0);
  await sb(`/rest/v1/engagements?id=eq.${engagement_id}`, env, {
    method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({
      goodies_cost: sum('goodies_cost'),
      shipping_cost: sum('shipping_cost'),
      product_code: lines[0].product_code,
      product_variant: lines[0].product_variant || null,
      updated_at: nowIso(),
    }),
  });
}

async function createInfluencer(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;

  // influencer_code is immutable once set (RULE-IGN-001). Auto-mint IN<n> from
  // the ignition_influencer sequence when the caller doesn't supply one.
  let code = String(body.influencer_code || '').trim();
  if (!code) {
    code = await mintInfluencerCode(env);
    if (!code) return err('failed_to_mint_influencer_code', 500);
  }

  const row = { influencer_code: code, created_by: auth.userId };
  for (const k of INFLUENCER_FIELDS) {
    if (k in body) row[k] = body[k];
  }
  // Keep the legacy single channel_platform synced to the first multi-platform
  // entry so existing single-platform readers (cards/detail) keep working (#5).
  if (Array.isArray(row.channel_platforms) && row.channel_platforms.length) {
    row.channel_platform = row.channel_platforms[0];
  }
  const r = await sb(`/rest/v1/influencers`, env, {
    method: 'POST',
    body: JSON.stringify([row]),
  });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

async function updateInfluencer(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.influencer_id) return err('influencer_id required', 400);
  const patch = pickPatch(body, INFLUENCER_FIELDS);
  patch.updated_at = nowIso();
  // influencer_code is immutable: strip even if it sneaks in via patch.
  delete patch.influencer_code;
  // Keep legacy single channel_platform synced to the multi-platform list (#5).
  if (Array.isArray(patch.channel_platforms) && patch.channel_platforms.length) {
    patch.channel_platform = patch.channel_platforms[0];
  }
  if (Object.keys(patch).length === 1 /* only updated_at */) return err('no_patch', 400);

  const r = await sb(`/rest/v1/influencers?id=eq.${body.influencer_id}`, env, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

async function createEngagement(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.influencer_id) return err('influencer_id required', 400);
  if (!body.engagement_type) return err('engagement_type required', 400);
  if (!body.deal_type) return err('deal_type required', 400);

  const eno = await mintEngagementNo(env);
  if (!eno) return err('failed_to_mint_engagement_no', 500);

  const startStage = STAGES.includes(body.stage) ? body.stage : 'planning';
  const row = {
    engagement_no: eno,
    influencer_id: body.influencer_id,
    stage: startStage,
    created_by: auth.userId,
  };
  for (const k of ENGAGEMENT_FIELDS) if (k in body) row[k] = body[k];

  const r = await sb(`/rest/v1/engagements`, env, {
    method: 'POST',
    body: JSON.stringify([row]),
  });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  const eng = r.data?.[0];
  await writeHistory(env, eng.id, 'create', null, startStage, null, auth.userId);
  // Multi-product (#4): if explicit product lines were supplied, store them + roll up.
  if (Array.isArray(body.products) && body.products.length) {
    await insertEngagementProducts(env, eng.id, body.products);
    await rollupEngagementProducts(env, eng.id);
  }
  return ok({ engagement_no: eno, id: eng.id });
}

// Replace the full product-line set for a deal, then roll up (#4).
async function setEngagementProducts(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.engagement_id) return err('engagement_id required', 400);
  if (!Array.isArray(body.products)) return err('products[] required', 400);
  await sb(`/rest/v1/engagement_products?engagement_id=eq.${body.engagement_id}`, env, {
    method: 'DELETE', prefer: 'return=minimal',
  });
  if (body.products.length) await insertEngagementProducts(env, body.engagement_id, body.products);
  await rollupEngagementProducts(env, body.engagement_id);
  const lr = await sb(`/rest/v1/engagement_products?engagement_id=eq.${body.engagement_id}&select=*&order=sort_order.asc`, env);
  return ok({ products: lr.data || [] });
}

// Delete a deal (Reann #2, human-error cleanup). Refuses if payments exist — use
// cancel/close instead. Children deleted explicitly (robust regardless of FK cascade).
async function deleteEngagement(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.engagement_id) return err('engagement_id required', 400);
  const er = await sb(`/rest/v1/engagements?id=eq.${body.engagement_id}&select=id,engagement_no&limit=1`, env);
  if (!er.ok || !er.data?.[0]) return err('not_found', 404);
  const pr = await sb(`/rest/v1/payments?engagement_id=eq.${body.engagement_id}&select=id&limit=1`, env);
  if (pr.ok && pr.data?.[0]) return err('has_payments_cannot_delete', 409);
  // Detach discount codes (one-way utilized stays), then remove children + the deal.
  await sb(`/rest/v1/discount_codes?engagement_id=eq.${body.engagement_id}`, env, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ engagement_id: null }) }).catch(() => {});
  for (const child of ['engagement_products', 'engagement_attachments', 'engagement_notes', 'engagement_history']) {
    await sb(`/rest/v1/${child}?engagement_id=eq.${body.engagement_id}`, env, { method: 'DELETE', prefer: 'return=minimal' }).catch(() => {});
  }
  const dr = await sb(`/rest/v1/engagements?id=eq.${body.engagement_id}`, env, { method: 'DELETE', prefer: 'return=minimal' });
  if (!dr.ok) return err(`db_error: ${JSON.stringify(dr.data)}`, 400);
  return ok({ deleted: true, engagement_no: er.data[0].engagement_no });
}

async function updateEngagement(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.engagement_id) return err('engagement_id required', 400);
  const patch = pickPatch(body, ENGAGEMENT_FIELDS);
  patch.updated_at = nowIso();
  if (Object.keys(patch).length === 1) return err('no_patch', 400);

  const r = await sb(`/rest/v1/engagements?id=eq.${body.engagement_id}`, env, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

async function advanceStage(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.engagement_id) return err('engagement_id required', 400);
  if (!body.to_stage) return err('to_stage required', 400);

  const cur = await sb(
    `/rest/v1/engagements?id=eq.${body.engagement_id}&select=stage,video_link,shipping_order_id,influencer_id,engagement_type,live_at,tracking_url&limit=1`, env,
  );
  if (!cur.ok || !cur.data?.[0]) return err('not_found', 404);
  const from = cur.data[0].stage;
  const isUgc = cur.data[0].engagement_type === 'ugc';
  const allowed = allowedTransitions(from);
  if (!allowed.includes(body.to_stage)) {
    return err(`illegal_transition: ${from} → ${body.to_stage}`, 422);
  }

  // Going live requires a video link (Reann #4) — accepted inline or already set.
  if (body.to_stage === 'live') {
    const incomingLink = (body.video_link != null ? String(body.video_link) : '').trim();
    const existingLink = (cur.data[0].video_link || '').trim();
    if (!incomingLink && !existingLink) return err('video_link_required_for_live', 422);
  }

  // Shipped guard. UGC (C1 #2) requires a tracking LINK; influencer deals (Batch A #7)
  // require the Shopify order ID. Either accepted inline or already on the row.
  if (body.to_stage === 'shipped') {
    if (isUgc) {
      const incoming = (body.tracking_url != null ? String(body.tracking_url) : '').trim();
      const existing = (cur.data[0].tracking_url || '').trim();
      if (!incoming && !existing) return err('tracking_url_required_for_shipped', 422);
    } else {
      const incoming = (body.shipping_order_id != null ? String(body.shipping_order_id) : '').trim();
      const existing = (cur.data[0].shipping_order_id || '').trim();
      if (!incoming && !existing) return err('shipping_order_id_required_for_shipped', 422);
    }
  }

  // Completed requires a colour rating on the influencer (Reann #3) — apply inline if given.
  if (body.to_stage === 'completed') {
    const infId = cur.data[0].influencer_id;
    let rated = false;
    if (infId) {
      const ir = await sb(`/rest/v1/influencers?id=eq.${infId}&select=quality_rating&limit=1`, env);
      rated = ['green', 'yellow', 'red'].includes(ir.data?.[0]?.quality_rating);
      if (!rated && ['green', 'yellow', 'red'].includes(body.rating)) {
        await sb(`/rest/v1/influencers?id=eq.${infId}`, env, {
          method: 'PATCH', prefer: 'return=minimal',
          body: JSON.stringify({ quality_rating: body.rating, rating_notes: body.rating_notes || null, updated_at: nowIso() }),
        });
        rated = true;
      }
    }
    if (!rated) return err('rating_required_for_completed', 422);
  }

  const patch = { stage: body.to_stage, updated_at: nowIso() };
  // Stamp live_at on first go-live (drives UGC "days active"). Don't overwrite.
  if (body.to_stage === 'live' && !cur.data[0].live_at) patch.live_at = nowIso();
  if (TERMINAL.has(body.to_stage)) {
    patch.closed_at = nowIso();
    patch.closed_reason = body.closed_reason
      || (TERMINAL_FAIL.has(body.to_stage) ? body.to_stage
        : (body.to_stage === 'retired' ? 'retired' : 'completed'));
  } else {
    // Moving back out of a terminal stage reopens the deal.
    patch.closed_at = null;
    patch.closed_reason = null;
  }
  // Allow incidental field updates in the same call (e.g. video_link on go-live).
  const extra = pickPatch(body, ENGAGEMENT_FIELDS);
  Object.assign(patch, extra);

  const r = await sb(`/rest/v1/engagements?id=eq.${body.engagement_id}`, env, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);

  await writeHistory(env, body.engagement_id, 'advance_stage', from, body.to_stage, body.note || null, auth.userId);
  return ok({ stage: body.to_stage, allowed_next: allowedTransitions(body.to_stage) });
}

async function closeEngagement(body, auth, env) {
  // Default close = Completed; caller can pass to_stage ghosted/dropped instead.
  if (!TERMINAL.has(body.to_stage)) body.to_stage = 'completed';
  return advanceStage(body, auth, env);
}

async function setRating(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.influencer_id) return err('influencer_id required', 400);
  if (!['green','yellow','red','unrated'].includes(body.rating)) return err('invalid_rating', 400);

  const r = await sb(`/rest/v1/influencers?id=eq.${body.influencer_id}`, env, {
    method: 'PATCH',
    body: JSON.stringify({
      quality_rating: body.rating,
      rating_notes: body.rating_notes || null,
      updated_at: nowIso(),
    }),
  });
  if (!r.ok) return err('db_error', 400);
  return ok(r.data?.[0]);
}

async function addNote(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.body) return err('body required', 400);
  if (!body.engagement_id && !body.influencer_id) return err('engagement_id or influencer_id required', 400);
  const r = await sb(`/rest/v1/engagement_notes`, env, {
    method: 'POST',
    body: JSON.stringify([{
      engagement_id: body.engagement_id || null,
      influencer_id: body.influencer_id || null,
      body: body.body,
      actor: auth.userId,
    }]),
  });
  if (!r.ok) return err('db_error', 400);
  return ok(r.data?.[0]);
}

async function addAttachment(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.engagement_id) return err('engagement_id required', 400);
  if (!body.url) return err('url required', 400);
  const r = await sb(`/rest/v1/engagement_attachments`, env, {
    method: 'POST',
    body: JSON.stringify([{
      engagement_id: body.engagement_id,
      kind: body.kind || 'proof',
      url: body.url,
      name: body.name || null,
      created_by: auth.userId,
    }]),
  });
  if (!r.ok) return err('db_error', 400);
  return ok(r.data?.[0]);
}

async function assignDiscountCode(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.code) return err('code required', 400);
  if (!body.engagement_id) return err('engagement_id required', 400);
  const r = await sb(`/rest/v1/discount_codes?code=eq.${encodeURIComponent(body.code)}`, env, {
    method: 'PATCH',
    body: JSON.stringify({ engagement_id: body.engagement_id }),
  });
  if (!r.ok) return err('db_error', 400);
  return ok(r.data?.[0]);
}

// Sibling-worker call: open a Pitstop ticket for a damaged shipment.
async function openPitstopTicket(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.engagement_id) return err('engagement_id required', 400);
  if (!body.issue_description) return err('issue_description required', 400);

  // Load engagement + influencer for prefill
  const er = await sb(
    `/rest/v1/engagements?id=eq.${body.engagement_id}&select=*,influencer:influencer_id(channel_name,person_name,contact_number,email)&limit=1`,
    env,
  );
  if (!er.ok || !er.data?.[0]) return err('engagement_not_found', 404);
  const eng = er.data[0];
  if (eng.cs_ticket_no) {
    return err(`already_linked_to_${eng.cs_ticket_no}`, 409);
  }
  const inf = eng.influencer || {};

  // POST to csops createTicket using the same bearer token
  const csopsUrl = env.CSOPS_URL || 'https://csops.afshaan.workers.dev';
  const csopsBody = {
    action: 'createTicket',
    intake_channel: 'sheet', // closest existing enum value; future: add 'ignition'
    customer_name: inf.person_name || inf.channel_name || 'Influencer',
    customer_phone: inf.contact_number || null,
    customer_email: inf.email || null,
    platform: 'website',
    external_order_id: eng.shipping_order_id || null,
    issue_description: body.issue_description,
    disposition: body.disposition || 'replacement',
  };
  if (body.issue_category) csopsBody.issue_category = body.issue_category;
  if (body.issue_subcategory) csopsBody.issue_subcategory = body.issue_subcategory;

  const r = await fetch(csopsUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.bearer}`,
    },
    body: JSON.stringify(csopsBody),
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok || !data?.ok) {
    return err(`csops_error: ${JSON.stringify(data)}`, r.status || 502);
  }
  const ticket_no = data.data?.ticket_no;
  if (!ticket_no) return err('csops_no_ticket_no', 502);

  // Patch the engagement
  await sb(`/rest/v1/engagements?id=eq.${body.engagement_id}`, env, {
    method: 'PATCH',
    body: JSON.stringify({ cs_ticket_no: ticket_no, updated_at: nowIso() }),
    prefer: 'return=minimal',
  });
  await writeHistory(env, body.engagement_id, 'open_pitstop_ticket', null, null,
    `Linked to Pitstop ${ticket_no}: ${body.issue_description}`, auth.userId);

  return ok({ ticket_no, engagement_no: eng.engagement_no });
}

async function createCampaign(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.influencer_id) return err('influencer_id required', 400);
  if (!body.video_count || body.video_count < 1) return err('video_count required', 400);
  // Mint a campaign_no using the same year sequence approach
  const yyyy = String(new Date().getUTCFullYear());
  const code = `CMP-${yyyy}-${String(Date.now()).slice(-6)}`;
  const r = await sb(`/rest/v1/campaigns`, env, {
    method: 'POST',
    body: JSON.stringify([{
      campaign_no: code,
      influencer_id: body.influencer_id,
      video_count: body.video_count,
      agreed_total: body.agreed_total || null,
      status: 'active',
    }]),
  });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

const CAMPAIGN_FIELDS = ['video_count', 'agreed_total', 'status'];

async function updateCampaign(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.campaign_id) return err('campaign_id required', 400);
  const patch = pickPatch(body, CAMPAIGN_FIELDS);
  if (Object.keys(patch).length === 0) return err('no_patch', 400);
  if ('status' in patch && !['active', 'completed', 'cancelled'].includes(patch.status)) {
    return err('invalid_status', 400);
  }
  const r = await sb(`/rest/v1/campaigns?id=eq.${body.campaign_id}`, env, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

// Sweep overdue engagements and flip the offending influencers' rating to red.
// Conservative: only touches influencers currently rated 'unrated' or 'green',
// so a human-set 'yellow'/'red' (or a deliberate green) is never clobbered.
// Returns the list flagged so the dashboard can show what changed.
async function flagOverdueRatings(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  const days = body.days || OVERDUE_DEFAULT_DAYS;

  const r = await sb(
    `/rest/v1/engagements?${overdueFilter(days)}&select=influencer_id,influencer:influencer_id(quality_rating)&limit=1000`,
    env,
  );
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);

  // Distinct influencer_ids whose current rating is auto-flippable.
  const ids = [...new Set(
    (r.data || [])
      .filter(e => ['unrated', 'green'].includes(e.influencer?.quality_rating))
      .map(e => e.influencer_id)
      .filter(Boolean),
  )];
  if (ids.length === 0) return ok({ flagged: 0, influencer_ids: [] });

  const note = `Auto-flagged red — post overdue >${Number(days) || OVERDUE_DEFAULT_DAYS}d past expected date (${nowIso().slice(0, 10)})`;
  const pr = await sb(
    `/rest/v1/influencers?id=in.(${ids.join(',')})&quality_rating=in.(unrated,green)`, env, {
    method: 'PATCH',
    body: JSON.stringify({ quality_rating: 'red', rating_notes: note, updated_at: nowIso() }),
    prefer: 'return=minimal',
  });
  if (!pr.ok) return err(`db_error: ${JSON.stringify(pr.data)}`, 400);
  return ok({ flagged: ids.length, influencer_ids: ids });
}

// Attach an engagement to a campaign (or detach when campaign_id is null/''):
// sets ignition.engagements.campaign_id. The FK guarantees the campaign exists.
async function assignEngagementToCampaign(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.engagement_id) return err('engagement_id required', 400);
  const campaign_id = body.campaign_id || null; // null = detach
  const r = await sb(`/rest/v1/engagements?id=eq.${body.engagement_id}`, env, {
    method: 'PATCH',
    body: JSON.stringify({ campaign_id, updated_at: nowIso() }),
  });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

// ── Monthly targets & budgets (Slice B) ──────────────────────────────────────
// Reann sets a per-month views target + ₹ budget; we track actuals against them.
// Actuals match the Reports by_month logic: month = post_date||created_at, spend=spendOf.
async function getMonthlyTargets(url, auth, env) {
  const tr = await sb(`/rest/v1/monthly_targets?select=*&order=month.desc`, env);
  if (!tr.ok) return err(`db_error: ${JSON.stringify(tr.data)}`, 500);
  const targets = tr.data || [];

  const num = v => (v == null || isNaN(Number(v)) ? 0 : Number(v));
  const spendOf = e => (e.total_cost != null ? num(e.total_cost) : num(e.payment_amount) + num(e.ad_spend) + num(e.commission_amount));
  const er = await sb(`/rest/v1/engagements?select=post_date,created_at,views,total_cost,payment_amount,ad_spend,commission_amount&limit=5000`, env);
  const actMap = {};
  if (er.ok) {
    for (const e of (er.data || [])) {
      const month = (e.post_date || e.created_at || '').slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month)) continue;
      const a = actMap[month] || (actMap[month] = { actual_views: 0, actual_spend: 0 });
      a.actual_views += num(e.views); a.actual_spend += spendOf(e);
    }
  }

  const months = new Set([...targets.map(t => t.month), ...Object.keys(actMap)]);
  const rows = [...months].sort().reverse().slice(0, 24).map(month => {
    const t = targets.find(x => x.month === month) || {};
    const a = actMap[month] || { actual_views: 0, actual_spend: 0 };
    const target_views = t.target_views != null ? Number(t.target_views) : null;
    const budget_amount = t.budget_amount != null ? Number(t.budget_amount) : null;
    return {
      month, target_views, budget_amount, note: t.note || null,
      actual_views: a.actual_views, actual_spend: Math.round(a.actual_spend),
      views_pct: target_views ? Math.round(a.actual_views / target_views * 100) : null,
      spend_pct: budget_amount ? Math.round(a.actual_spend / budget_amount * 100) : null,
    };
  });
  return ok({ months: rows });
}

async function upsertMonthlyTarget(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  const month = String(body.month || '').trim();
  if (!/^\d{4}-\d{2}$/.test(month)) return err('month must be YYYY-MM', 400);
  // '' / null → null; negative/NaN → invalid (undefined sentinel)
  const numOrNull = (v) => {
    if (v === '' || v == null) return null;
    const n = Number(v); if (isNaN(n) || n < 0) return undefined;
    return n;
  };
  const tv = numOrNull(body.target_views);
  const ba = numOrNull(body.budget_amount);
  if (tv === undefined) return err('target_views must be a non-negative number', 400);
  if (ba === undefined) return err('budget_amount must be a non-negative number', 400);
  const note = (body.note != null && String(body.note).trim()) ? String(body.note).trim() : null;

  const ex = await sb(`/rest/v1/monthly_targets?month=eq.${encodeURIComponent(month)}&select=month`, env);
  const exists = ex.ok && (ex.data || []).length > 0;

  let r;
  if (exists) {
    r = await sb(`/rest/v1/monthly_targets?month=eq.${encodeURIComponent(month)}`, env, {
      method: 'PATCH',
      body: JSON.stringify({ target_views: tv != null ? Math.round(tv) : null, budget_amount: ba, note, updated_by: auth.userId, updated_at: nowIso() }),
    });
  } else {
    r = await sb(`/rest/v1/monthly_targets`, env, {
      method: 'POST',
      body: JSON.stringify([{ month, target_views: tv != null ? Math.round(tv) : null, budget_amount: ba, note, created_by: auth.userId }]),
    });
  }
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(Array.isArray(r.data) ? r.data[0] : r.data);
}

// ────────────────────────────────────────────────────────────────────────────
// UGC META AD AUTO-PULL (Reann Batch C2, S177) — PER-AD-ID ONLY
// ────────────────────────────────────────────────────────────────────────────
// Pulls ONE Meta ad's insights per UGC deal's meta_ad_id. NEVER an account-level
// sweep (act_<id>/insights) — that's Odo's job. Reuses META_SYSTEM_USER_TOKEN.
const META_API_VER = 'v21.0';
const META_MAX_ADS_PER_RUN = 40;   // subrequest budget; cron drains the rest next day

async function metaAdInsights(env, adId) {
  const url = `https://graph.facebook.com/${META_API_VER}/${encodeURIComponent(adId)}/insights`
    + `?fields=spend,impressions,clicks,ctr,frequency,actions,action_values`
    + `&action_attribution_windows=${encodeURIComponent(JSON.stringify(['7d_click']))}`
    + `&date_preset=maximum&access_token=${env.META_SYSTEM_USER_TOKEN}`;
  const res = await fetch(url).catch(() => null);
  if (!res || !res.ok) return null;
  const j = await res.json().catch(() => null);
  const d = j && j.data && j.data[0];
  const num = v => Number(v) || 0;
  if (!d) return { spend: 0, impressions: 0, ctr: 0, frequency: 0, purchases: 0, revenue: 0 };
  const PURCH = new Set(['omni_purchase', 'purchase']);
  const purch = (d.actions || []).find(a => PURCH.has(a.action_type));
  const purchVal = (d.action_values || []).find(a => PURCH.has(a.action_type));
  return {
    spend: num(d.spend), impressions: num(d.impressions),
    ctr: num(d.ctr), frequency: num(d.frequency),
    purchases: purch ? Math.round(num(purch.value)) : 0,
    revenue: purchVal ? num(purchVal.value) : 0,
  };
}

async function applyMetaMetrics(env, engagementId, m) {
  await sb(`/rest/v1/engagements?id=eq.${engagementId}`, env, {
    method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({
      ad_spend: m.spend, conversions_value: m.revenue, purchases: m.purchases,
      impressions: m.impressions, ctr: m.ctr, frequency: m.frequency,
      meta_synced_at: nowIso(), updated_at: nowIso(),
    }),
  });
}

// Daily cron: refresh active UGC deals that carry a meta_ad_id (oldest-synced first).
async function syncUgcMetaMetrics(env) {
  if (!env.META_SYSTEM_USER_TOKEN) return { skipped: 'meta_not_configured' };
  const r = await sb(
    `/rest/v1/engagements?engagement_type=eq.ugc&meta_ad_id=not.is.null&stage=not.in.(retired,dropped)&select=id,meta_ad_id&order=meta_synced_at.asc.nullsfirst&limit=${META_MAX_ADS_PER_RUN}`,
    env,
  );
  const rows = (r.ok ? r.data || [] : []).filter(e => e.meta_ad_id && String(e.meta_ad_id).trim());
  let updated = 0, failed = 0;
  for (const e of rows) {
    const m = await metaAdInsights(env, String(e.meta_ad_id).trim());
    if (!m) { failed++; continue; }
    await applyMetaMetrics(env, e.id, m);
    updated++;
  }
  return { scanned: rows.length, updated, failed };
}

// On-demand single-deal refresh (button on the UGC detail card).
async function refreshUgcMetrics(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.engagement_id) return err('engagement_id required', 400);
  if (!env.META_SYSTEM_USER_TOKEN) return err('meta_not_configured', 503);
  const er = await sb(`/rest/v1/engagements?id=eq.${body.engagement_id}&select=id,meta_ad_id&limit=1`, env);
  const e = er.data?.[0];
  if (!e) return err('not_found', 404);
  if (!e.meta_ad_id || !String(e.meta_ad_id).trim()) return err('no_meta_ad_id', 422);
  const m = await metaAdInsights(env, String(e.meta_ad_id).trim());
  if (!m) return err('meta_fetch_failed', 502);
  await applyMetaMetrics(env, e.id, m);
  return ok({ metrics: m, meta_synced_at: nowIso() });
}

// ────────────────────────────────────────────────────────────────────────────
// CONNECTS — Pitstop→Ignition transferred conversations (S177)
// ────────────────────────────────────────────────────────────────────────────
// Pitstop owns the IG/WhatsApp/email channels + stores the conversation. The CS
// team transfers a thread to the Influencer team; we read/reply through csops's
// token-authed bridge (scope-checked to ignition_connect=true). `ignition.connects`
// holds only Reann's workflow overlay (status + influencer link) — never messages.
// See spec 2026-06-26-ignition-pitstop-connects-transfer-design.md.

async function csopsBridge(env, action, payload = {}) {
  const base = env.CSOPS_URL || 'https://csops.afshaan.workers.dev';
  let raw, status;
  try {
    const r = await fetch(`${base}/bridge/ignition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ignition-Bridge-Token': env.IGNITION_BRIDGE_TOKEN || '' },
      body: JSON.stringify({ action, ...payload }),
    });
    status = r.status;
    const text = await r.text();
    try { raw = JSON.parse(text); } catch { raw = text; }
  } catch (e) {
    return { ok: false, status: 502, data: null, raw: { error: String(e?.message || e) } };
  }
  return { ok: status < 400 && raw?.ok !== false, status, data: raw?.data ?? null, raw };
}

// Load (and lazily create) the ignition.connects overlay for a set of threads.
async function loadConnectOverlay(env, threads) {
  const ids = threads.map(t => t.id);
  const byThread = {};
  if (!ids.length) return byThread;
  const r = await sb(`/rest/v1/connects?thread_id=in.(${ids.join(',')})&select=*`, env);
  for (const row of (r.ok ? r.data || [] : [])) byThread[row.thread_id] = row;
  const missing = threads.filter(t => !byThread[t.id]);
  if (missing.length) {
    const rows = missing.map(t => ({
      thread_id: t.id, channel: t.channel || null, status: 'new',
      transferred_at: t.ignition_transferred_at || null,
    }));
    const ins = await sb(`/rest/v1/connects`, env, {
      method: 'POST', prefer: 'resolution=ignore-duplicates,return=representation',
      body: JSON.stringify(rows),
    });
    for (const row of (ins.ok ? ins.data || [] : [])) byThread[row.thread_id] = row;
  }
  return byThread;
}

async function getConnects(url, auth, env) {
  const gate = requirePerm('ignition_connects', auth); if (gate) return gate;
  const channel = url.searchParams.get('channel');
  const statusFilter = url.searchParams.get('status');
  const br = await csopsBridge(env, 'getIgnitionConnects',
    channel && channel !== 'all' ? { channel } : {});
  if (!br.ok) return err(`csops_bridge_error: ${JSON.stringify(br.raw)}`, br.status || 502);
  const threads = br.data?.threads || [];
  if (!threads.length) return ok({ connects: [] });

  const overlay = await loadConnectOverlay(env, threads);
  let connects = threads.map(t => {
    const ov = overlay[t.id] || {};
    return {
      thread_id: t.id,
      channel: t.channel,
      customer_handle: t.customer_handle,
      customer_phone: t.customer_phone,
      customer_email: t.channel === 'email' ? t.external_user_id : null,
      subject: t.subject || null,
      last_message: t.last_message || null,
      last_message_at: t.last_message_at,
      awaiting_reply: !!t.awaiting_reply,
      within_customer_window: !!t.within_customer_window,
      transferred_at: t.ignition_transferred_at || ov.transferred_at || null,
      status: ov.status || 'new',
      influencer_id: ov.influencer_id || null,
    };
  });
  if (statusFilter && statusFilter !== 'all') connects = connects.filter(c => c.status === statusFilter);

  // Attach influencer codes for any promoted connects (batched).
  const infIds = [...new Set(connects.map(c => c.influencer_id).filter(Boolean))];
  if (infIds.length) {
    const ir = await sb(`/rest/v1/influencers?id=in.(${infIds.join(',')})&select=id,influencer_code,channel_name`, env);
    const byId = {};
    for (const row of (ir.ok ? ir.data || [] : [])) byId[row.id] = row;
    connects = connects.map(c => ({ ...c, influencer: c.influencer_id ? byId[c.influencer_id] || null : null }));
  }
  return ok({ connects });
}

async function getConnect(url, auth, env) {
  const gate = requirePerm('ignition_connects', auth); if (gate) return gate;
  const thread_id = url.searchParams.get('thread_id');
  if (!thread_id) return err('thread_id required', 400);
  const br = await csopsBridge(env, 'getIgnitionThread', { thread_id });
  if (!br.ok) return err(`csops_bridge_error: ${JSON.stringify(br.raw)}`, br.status || 502);
  const thread = br.data?.thread;
  if (!thread) return err('not_found', 404);

  const overlay = await loadConnectOverlay(env, [thread]);
  const connect = overlay[thread.id] || { thread_id, status: 'new' };
  let influencer = null;
  if (connect.influencer_id) {
    const ir = await sb(`/rest/v1/influencers?id=eq.${connect.influencer_id}&select=id,influencer_code,channel_name,person_name&limit=1`, env);
    influencer = ir.ok && ir.data?.[0] ? ir.data[0] : null;
  }
  return ok({
    thread,
    messages: br.data?.messages || [],
    within_customer_window: !!br.data?.within_customer_window,
    connect,
    influencer,
  });
}

async function replyConnect(body, auth, env) {
  const gate = requirePerm('ignition_connects', auth); if (gate) return gate;
  const { thread_id, text, html } = body;
  if (!thread_id || (!text && !html)) return err('thread_id and text required', 400);
  const br = await csopsBridge(env, 'sendConnectReply', {
    thread_id, text, html,
    actor: { id: auth.userId, name: auth.fullName || auth.email, email: auth.email },
  });
  if (!br.ok) return err(`csops_bridge_error: ${JSON.stringify(br.raw?.error || br.raw)}`, br.status || 502);
  // First reply moves a 'new' connect to 'working' (best-effort).
  await sb(`/rest/v1/connects?thread_id=eq.${encodeURIComponent(thread_id)}&status=eq.new`, env, {
    method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({ status: 'working', updated_at: nowIso() }),
  }).catch(() => {});
  return ok(br.data);
}

async function setConnectStatus(body, auth, env) {
  const gate = requirePerm('ignition_connects', auth); if (gate) return gate;
  const { thread_id, status } = body;
  if (!thread_id) return err('thread_id required', 400);
  if (!['new', 'working', 'promoted', 'closed'].includes(status)) return err('invalid_status', 400);
  const r = await sb(`/rest/v1/connects?thread_id=eq.${encodeURIComponent(thread_id)}`, env, {
    method: 'PATCH', prefer: 'return=representation',
    body: JSON.stringify({ status, updated_at: nowIso() }),
  });
  if (r.ok && r.data?.[0]) return ok({ connect: r.data[0] });
  const ins = await sb(`/rest/v1/connects`, env, {
    method: 'POST', prefer: 'resolution=ignore-duplicates,return=representation',
    body: JSON.stringify([{ thread_id, status }]),
  });
  return ok({ connect: ins.data?.[0] || null });
}

// Promote a connect into an influencer (lead → CRM record), prefilled from the
// conversation. Idempotent — returns the existing influencer if already promoted.
async function promoteConnect(body, auth, env) {
  const gate = requirePerm('ignition_connects', auth); if (gate) return gate;
  const { thread_id } = body;
  if (!thread_id) return err('thread_id required', 400);

  const overlay = await sb(`/rest/v1/connects?thread_id=eq.${encodeURIComponent(thread_id)}&select=*&limit=1`, env);
  const existing = overlay.ok && overlay.data?.[0] ? overlay.data[0] : null;
  if (existing?.influencer_id) {
    const ir = await sb(`/rest/v1/influencers?id=eq.${existing.influencer_id}&select=id,influencer_code,channel_name&limit=1`, env);
    return ok({ already_promoted: true, influencer: ir.data?.[0] || null });
  }

  const br = await csopsBridge(env, 'getIgnitionThread', { thread_id });
  if (!br.ok) return err(`csops_bridge_error: ${JSON.stringify(br.raw)}`, br.status || 502);
  const thread = br.data?.thread;
  if (!thread) return err('not_found', 404);

  const ch = thread.channel || '';
  const handle = thread.customer_handle || null;
  const email = ch === 'email' ? (thread.external_user_id || null) : null;
  const phone = thread.customer_phone || null;
  const platform = ch === 'instagram' ? 'instagram' : 'other';
  const channel_name = handle || phone || email || thread.external_user_id || 'New connect';
  const channel_link = ch === 'instagram' && handle ? `https://instagram.com/${handle}` : null;

  const code = await mintInfluencerCode(env);
  if (!code) return err('failed_to_mint_influencer_code', 500);
  const row = {
    influencer_code: code, created_by: auth.userId,
    channel_name, person_name: handle || null,
    channel_platform: platform, channel_platforms: [platform],
    channel_link, contact_number: phone, email,
    list_status: 'master',
  };
  const ins = await sb(`/rest/v1/influencers`, env, { method: 'POST', body: JSON.stringify([row]) });
  if (!ins.ok || !ins.data?.[0]) return err(`db_error: ${JSON.stringify(ins.data)}`, 400);
  const influencer = ins.data[0];

  // Link + mark the connect promoted (upsert).
  if (existing) {
    await sb(`/rest/v1/connects?thread_id=eq.${encodeURIComponent(thread_id)}`, env, {
      method: 'PATCH', prefer: 'return=minimal',
      body: JSON.stringify({ influencer_id: influencer.id, status: 'promoted', updated_at: nowIso() }),
    });
  } else {
    await sb(`/rest/v1/connects`, env, {
      method: 'POST', prefer: 'resolution=ignore-duplicates,return=minimal',
      body: JSON.stringify([{ thread_id, channel: ch || null, influencer_id: influencer.id, status: 'promoted', transferred_at: thread.ignition_transferred_at || null }]),
    });
  }
  return ok({ influencer });
}

// ────────────────────────────────────────────────────────────────────────────
// DISPATCH
// ────────────────────────────────────────────────────────────────────────────

const GET_ACTIONS = {
  getInfluencers,
  getInfluencerCounts,
  getInfluencer,
  getEngagements,
  getEngagement,
  getRoster,
  getDiscountCodes,
  getCampaigns,
  getCampaign,
  getOverdueEngagements,
  getSchedule,
  getPayments,
  getKpis,
  getReports,
  getMonthlyTargets,
  getCatalogs,
  getLocations,
  getPaymentProofUrl,
  getInfluencerMetrics,
  getMe,
  searchShopifyCustomer,
  getInfluencerShopify,
  getConnects,
  getConnect,
  getIgnitionUsers,
  getUgcPipeline,
};

const POST_ACTIONS = {
  createInfluencer,
  updateInfluencer,
  deleteInfluencer,
  createEngagement,
  updateEngagement,
  setEngagementProducts,
  deleteEngagement,
  generateUgcBrief,
  refreshUgcMetrics,
  advanceStage,
  closeEngagement,
  setRating,
  addNote,
  addAttachment,
  assignDiscountCode,
  openPitstopTicket,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  assignEngagementToCampaign,
  flagOverdueRatings,
  addPayment,
  deletePayment,
  createPaymentProofUploadUrl,
  addMetricSnapshot,
  deleteMetricSnapshot,
  upsertMonthlyTarget,
  replyConnect,
  promoteConnect,
  setConnectStatus,
};

async function handleGet(url, request, env) {
  const action = url.searchParams.get('action');
  if (!action) return err('action_required', 400);
  if (action === 'ping') return ok({ pong: true });
  const auth = await verifyJWT(request.headers.get('Authorization'), env);
  if (!auth) return err('unauthorized', 401);
  if (!auth.permissions?.ignition_view) return err('forbidden_ignition_view', 403);

  const handler = GET_ACTIONS[action];
  if (!handler) return err(`unknown_action: ${action}`, 400);
  try { return await handler(url, auth, env); }
  catch (e) { return err(`server_error: ${e?.message || String(e)}`, 500); }
}

async function handlePost(request, env) {
  const auth = await verifyJWT(request.headers.get('Authorization'), env);
  if (!auth) return err('unauthorized', 401);
  if (!auth.permissions?.ignition_view) return err('forbidden_ignition_view', 403);

  let body;
  try { body = await request.json(); } catch { return err('bad_json', 400); }
  const action = body?.action;
  if (!action) return err('action_required', 400);
  const handler = POST_ACTIONS[action];
  if (!handler) return err(`unknown_action: ${action}`, 400);
  try { return await handler(body, auth, env); }
  catch (e) { return err(`server_error: ${e?.message || String(e)}`, 500); }
}

// ────────────────────────────────────────────────────────────────────────────
// MAIN
// ────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    if (url.pathname === '/health' || url.pathname === '/healthz') {
      return ok({ service: 'ignitionops', time: nowIso() });
    }

    if (request.method === 'GET')  return handleGet(url, request, env);
    if (request.method === 'POST') return handlePost(request, env);
    return err('method_not_allowed', 405);
  },

  // Daily cron (wrangler.toml [triggers]) — UGC Meta ad-metrics pull (Batch C2, S177).
  // Per-ad-id only; inert (no-op) until META_SYSTEM_USER_TOKEN is set.
  async scheduled(_event, env, ctx) {
    if (!env.META_SYSTEM_USER_TOKEN) return;
    ctx.waitUntil(syncUgcMetaMetrics(env).then(
      r => console.log('[ugc-meta] cron', JSON.stringify(r)),
      e => console.error('[ugc-meta] cron error', e),
    ));
  },
};
