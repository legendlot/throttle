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
  // `range` carries PostgREST's Content-Range (e.g. "0-49/233"), which is the ONLY way to learn
  // the true total for a paged read — and a page with no total is how "100 of 233" shipped as a
  // complete-looking answer (S297). Populated always; only meaningful with Prefer: count=exact.
  return { ok: res.ok, status: res.status, data, range: res.headers.get('content-range') };
}

// Total row count out of a Content-Range header. "0-49/233" -> 233. Returns null when the caller
// did not ask for a count, which must stay distinguishable from a genuine zero.
function rangeTotal(range) {
  const m = /\/(\d+)$/.exec(range || '');
  return m ? Number(m[1]) : null;
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

// Ignition permissions come from the Ignition-only layer, NOT the user's global
// `users_profile.role` (2026-07-20). Ignition was the last system deriving perms from
// the shared single-role column, which made Ignition access mutually exclusive with a
// person's other job — an active Pitstop CS agent could not also be an Ignition manager.
// Mirrors snorkelops `getSnorkelPerms` / RULE-SNORKEL-002. `active=false` is a
// Ignition-scoped kill switch (Manifest's RULE-MANIFEST-006 pattern); no row = no access.
async function getIgnitionPerms(userId, env) {
  const ur = await sbStore(
    `/rest/v1/ignition_user_roles?user_id=eq.${userId}&active=is.true&select=role_key&limit=1`,
    env,
  );
  if (!ur.ok || !ur.data?.[0]) return { __role: null, perms: {} };
  const roleKey = ur.data[0].role_key;
  const r = await sbStore(
    `/rest/v1/ignition_roles?role_key=eq.${encodeURIComponent(roleKey)}&select=permissions&limit=1`,
    env,
  );
  return { __role: roleKey, perms: (r.ok && r.data?.[0]?.permissions) || {} };
}

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

  const ip = await getIgnitionPerms(user.id, env);

  return {
    userId: user.id,
    email: user.email,
    role: profile.role,               // global role — display/context only, NOT the gate
    ignitionRole: ip.__role,
    fullName: profile.full_name,
    permissions: ip.perms,
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

// Stage model (Reann #8, S138; S214 6-pt ⑤). Free transitions — any stage to any other.
// Main flow then side/terminal states; order here drives picker/stepper order.
// S214: 'completed' dropped — for a video deal **'live' is the terminal success stage**
// (video posted = deal done); mandatory colour rating + post_date now enforced at live.
// ('completed' stays legal in the DB CHECK as an unused legacy value; app never emits it.)
// 2026-08-27 (Reann #11): 'agreed' RETIRED — "the agreed state is not required, it can be
// removed". Approval is now the go-ahead (see approveEngagement), which is what 'agreed' was
// standing in for, so the stage was a second confirmation of the same fact. Retired the same way
// S214 retired 'completed': the value stays LEGAL in engagements_stage_check and in historical
// engagement_history rows, and simply stops being offered. The 3 deals that were sitting on it
// moved to 'planning' (migration ignition_retire_agreed_stage_v1, snapshot
// ignition.safety_stage_agreed_retire_2026_08_27) — all three approved, none shipped.
const STAGES = [
  // 'proposed' is the mandatory first stage (Reann #5, Afshaan 2026-08-11). Leaving it requires an
  // explicit approval — see the gate in advanceStage. Every OTHER transition stays free (S138).
  'proposed',
  'planning','shipped','delivered','scheduled','posting','live',
  // 'cancelled' (Reann, 2026-08-27) is terminal like 'dropped' but its money NEVER HAPPENED, so it
  // is excluded from every spend/metric aggregation — see SPEND_EXCLUDED_STAGES.
  'delayed','on_hold','ghosted','dropped','cancelled',
];

// ── Deals whose numbers must not reach any total (Reann, 2026-08-27) ─────────────────────────
// "Some deals are dropped but are not losses; they are simply postponed or cancelled before the
// products were shipped."
//
// ⚠️ 'dropped' is deliberately NOT in here. The two mean different things and the distinction is
// the whole point of the request: a DROPPED deal shipped goods that never became a video, so its
// cost is a real loss and must keep counting; a CANCELLED deal was called off before anything was
// spent, so counting it invents spend that never left the building.
//
// ⚠️ This is ONE list on purpose. There are five separate spend aggregations in this file
// (getReports · getMonthlyTargets · getMonthlyBreakdown · getCampaignSummary · campaignRollup)
// plus the KPI tiles and the engagements summary in the app. A rule applied to four of them is
// the PATTERN-218 shape and would surface as two screens quoting different spend for the same
// month — exactly the divergence fixed earlier this session between the deal list and the deal page.
const SPEND_EXCLUDED_STAGES = ['cancelled'];
// PostgREST filter fragment; append to any aggregation query that totals money or metrics.
const EXCLUDE_NON_SPEND = `stage=not.in.(${SPEND_EXCLUDED_STAGES.join(',')})`;
/** JS-side twin of EXCLUDE_NON_SPEND, for rows already fetched (e.g. embedded engagements). */
function countsTowardSpend(e) {
  return !SPEND_EXCLUDED_STAGES.includes(e && e.stage);
}

// Terminal stages — entering one stamps closed_at + closed_reason.
// 'live' is terminal-success for video deals but NOT for UGC (UGC terminals = retired/dropped),
// so it's handled conditionally in advanceStage rather than sitting in this global set.
// 'cancelled' joins both sets: it stamps closed_at/closed_reason like any terminal, and being in
// TERMINAL_FAIL is what lets a PROPOSED deal be cancelled without first being approved — you must
// be able to call off a proposal you are not going ahead with (same reasoning as drop/ghost).
const TERMINAL_FAIL = new Set(['ghosted','dropped','cancelled']);
const TERMINAL = new Set(['ghosted','dropped','cancelled','retired']);   // 'retired' = UGC terminal (C1, S177)

// UGC pipeline stage set (Reann Batch C1, S177). Reuses engagements with
// engagement_type='ugc'; vault/paused are non-terminal holds (vault reopenable to live).
// 'proposed' leads the UGC set too: getUgcPipeline buckets by_stage with NO stage filter, so a
// proposed UGC deal that was not in this list would be fetched but render in no column — i.e.
// silently invisible on the board.
// 'agreed' dropped here too (2026-08-27) — verified first that no UGC deal is sitting on it, since
// a stage missing from this list renders in no column on the board rather than erroring.
const UGC_STAGES = ['proposed','outreach','shipped','delivered','draft','live','paused','vault','retired','dropped','cancelled'];

// Free model: from any stage you may move to any other (terminals reopenable) — but only
// within the vocabulary that belongs to the deal's TYPE.
//
// ⚠️ `isUgc` is not optional decoration. This used to return the video `STAGES` for every deal,
// so a UGC deal could be advanced to `planning`/`scheduled`/`posting`/`delayed`/`on_hold` —
// none of which are UGC stages. The /ugc board builds its count chips and its stage filter from
// `UGC_STAGE_VALUES`, so such a deal became **uncountable and unfilterable**: still in the
// all-stages table, absent from every chip, unreachable by the filter, and carrying a stage its
// own board has no name for. Same family as the S272 `proposed` trap, found by the S317 hostile
// review. Latent at the time — 0 UGC deals were in a video-only stage and only 2 UGC deals
// existed at all, which is exactly why nobody had hit it (cf. S267: a fully-coded rule whose
// first real exercise would have been its first failure).
//
// Callers MUST pass the deal's type. A missing argument defaults to the video set, which is the
// pre-existing behaviour and correct for the 351 video deals.
function allowedTransitions(stage, isUgc = false) {
  return (isUgc ? UGC_STAGES : STAGES).filter(s => s !== stage);
}

// ── Util ────────────────────────────────────────────────────────────────────

/**
 * Display casing for a free-text product name. Mirror of `titleish` in
 * apps/ignition/src/lib/productLabel.js — kept in step by hand because the worker and the app
 * are separate deploy units and share no package.
 *
 * Only re-cases a string that is uniformly upper or lower case; anything already mixed-case is
 * returned untouched, so "McCloud" does not become "Mccloud".
 */
function productDisplay(raw) {
  const s = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  const letters = s.replace(/[^A-Za-z]/g, '');
  if (!letters) return s;
  const uniform = letters === letters.toUpperCase() || letters === letters.toLowerCase();
  if (!uniform) return s;
  return s.replace(/[A-Za-z][A-Za-z']*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

function pickPatch(body, allowed) {
  if (!body) return {};
  // Accept BOTH shapes: an explicit { patch: {...} } wrapper (updateCampaign) OR
  // fields sent flat on the body (updateEngagement performance/compliance, ugc,
  // updateInfluencer identity/archive). Explicit patch wins when present. (S191 —
  // fixes the "no_patch" error Reann hit adding performance stats + ticking the
  // compliance boxes: those callers send fields flat, but this only read body.patch.)
  const src = (body.patch && typeof body.patch === 'object') ? body.patch : body;
  const patch = {};
  for (const k of allowed) {
    if (k in src) patch[k] = src[k];
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
  const niche = url.searchParams.get('niche');
  const ageRange = url.searchParams.get('age_range');
  const gender = url.searchParams.get('gender');
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
  if (niche)    filters.push(`audience_niches=cs.{${encodeURIComponent(niche)}}`);
  if (ageRange) filters.push(`age_range=eq.${encodeURIComponent(ageRange)}`);
  if (gender)   filters.push(`gender_majority=eq.${encodeURIComponent(gender)}`);
  if (reachMin && Number.isFinite(Number(reachMin))) filters.push(`reach=gte.${Number(reachMin)}`);
  if (reachMax && Number.isFinite(Number(reachMax))) filters.push(`reach=lt.${Number(reachMax)}`);
  if (search) {
    const s = encodeURIComponent(search);
    // channel_link included so a search by the raw IG handle (e.g. "homelyshark")
    // matches the profile URL even when channel_name is a spaced display name.
    filters.push(`or=(channel_name.ilike.*${s}*,person_name.ilike.*${s}*,email.ilike.*${s}*,contact_number.ilike.*${s}*,influencer_code.ilike.*${s}*,channel_link.ilike.*${s}*)`);
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

// Ceiling for the two search reads. Comfortably above the whole table today (346 rows) so a
// search is complete by construction; if the table ever outgrows it the overflow is LOGGED, never
// silently dropped — the failure mode this replaced.
const SEARCH_SCAN_MAX = 2000;

// List order — creation order, NOT last-touched order (Reann #10, 2026-08-27: "when an action
// is performed on a deal in engagements, the deal automatically moves to the top of the list;
// please stop this from happening. Please keep the engagement in the same chronological order
// it was initially added").
//
// This read used to be `updated_at.desc`, so ANY edit — a stage move, a note, a metric, the
// worker's own `updated_at` stamp — teleported that row to row 1 and shifted everything the
// user was reading. Creation order is stable: a deal sits where it was filed and stays there.
// `id` is the tie-break so rows created in the same millisecond cannot swap places between
// two page fetches, which would drop or duplicate a row at a page boundary (CORE: order by
// something unique before paging).
const LIST_ORDER = 'created_at.desc,id.desc';

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
  const SELECT = '*,influencer:influencer_id(influencer_code,channel_name,person_name,influencer_type)';

  // ── Search: two reads merged, deliberately NOT one OR ────────────────────────────────────────
  // This used to pre-resolve matching influencer ids and fold them into the OR, capped at
  // `limit=200`. Two things were wrong with that, and the cap was the smaller one: a search for
  // "a" matches 1,028 of 1,480 influencers (measured 2026-08-26), so 80% were dropped with no
  // signal — and folding 1,028 UUIDs into a query string is ~38 KB of URL, which would fail
  // outright. Raising the cap could not work.
  //
  // Instead: one read matching the engagement's own fields, one matching THROUGH the influencer
  // (`!inner` filters the embedded resource, which is the thing an OR cannot express), then merge
  // by id in the worker. Whole-table reads are safe here precisely because the table is small —
  // 346 engagements (measured 2026-08-26) — and BOTH reads carry an exact count so a future size
  // change surfaces as a logged truncation rather than a quietly short answer.
  if (search) {
    const s = encodeURIComponent(search);
    const own = `or=(engagement_no.ilike.*${s}*,video_link.ilike.*${s}*,tracking_id.ilike.*${s}*,shipping_order_id.ilike.*${s}*)`;
    const viaInf = `influencer.or=(channel_name.ilike.*${s}*,person_name.ilike.*${s}*,influencer_code.ilike.*${s}*,channel_link.ilike.*${s}*)`;
    const base = qsFrom(filters);
    const [a, b] = await Promise.all([
      sb(`/rest/v1/engagements?${base}${own}&select=${SELECT}&order=${LIST_ORDER}&limit=${SEARCH_SCAN_MAX}`, env,
        { prefer: 'return=representation,count=exact' }),
      sb(`/rest/v1/engagements?${base}${viaInf}&select=*,influencer:influencer_id!inner(influencer_code,channel_name,person_name,influencer_type)&order=${LIST_ORDER}&limit=${SEARCH_SCAN_MAX}`, env,
        { prefer: 'return=representation,count=exact' }),
    ]);
    if (!a.ok) return err(`db_error: ${JSON.stringify(a.data)}`, 500);
    if (!b.ok) return err(`db_error: ${JSON.stringify(b.data)}`, 500);
    // Never truncate in silence (CORE): if either side filled the scan window there may be more.
    for (const [side, res] of [['own', a], ['influencer', b]]) {
      const t = rangeTotal(res.range);
      if (t != null && t > SEARCH_SCAN_MAX) {
        console.error(`[getEngagements] search scan truncated on ${side}: ${t} matches > ${SEARCH_SCAN_MAX}`);
      }
    }
    const byId = new Map();
    for (const row of [...(a.data || []), ...(b.data || [])]) if (row && row.id) byId.set(row.id, row);
    // Same creation order as the unsearched list, so searching does not silently re-sort.
    const merged = [...byId.values()]
      .sort((x, y) => String(y.created_at || '').localeCompare(String(x.created_at || ''))
        || String(y.id || '').localeCompare(String(x.id || '')));
    return ok({
      engagements: merged.slice(offset, offset + limit),
      offset, limit, total: merged.length,
    });
  }

  const r = await sb(
    `/rest/v1/engagements?${qsFrom(filters)}select=${SELECT}&order=${LIST_ORDER}&limit=${limit}&offset=${offset}`,
    env,
    // count=exact so a caller can tell a page from the whole list. Scoped to this read — an exact
    // count is a full scan, and it is only worth paying for where something pages.
    { prefer: 'return=representation,count=exact' },
  );
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);
  return ok({ engagements: r.data || [], offset, limit, total: rangeTotal(r.range) });
}

// Filters joined for direct concatenation with the next query param — '' or 'a=1&b=2&'.
function qsFrom(filters) {
  return filters.length ? `${filters.join('&')}&` : '';
}

async function getEngagement(url, auth, env) {
  const id = url.searchParams.get('id');
  const eno = url.searchParams.get('engagement_no');
  if (!id && !eno) return err('id or engagement_no required', 400);
  const filter = id ? `id=eq.${id}` : `engagement_no=eq.${encodeURIComponent(eno)}`;
  const r = await sb(
    // campaign is embedded (S309) so the deal page can SHOW which campaign a deal is
    // on without fetching the whole campaign list just to resolve one name. The picker
    // still loads the active list, but only when the card is opened for editing.
    `/rest/v1/engagements?${filter}&select=*,influencer:influencer_id(*),campaign:campaign_id(id,name)&limit=1`,
    env,
  );
  if (!r.ok) return err('db_error', 500);
  const eng = r.data?.[0];
  if (!eng) return err('not_found', 404);

  const [hr, nr, ar, pr, epr, ubr, vr] = await Promise.all([
    sb(`/rest/v1/engagement_history?engagement_id=eq.${eng.id}&select=*&order=created_at.desc&limit=200`, env),
    sb(`/rest/v1/engagement_notes?engagement_id=eq.${eng.id}&select=*&order=created_at.desc&limit=200`, env),
    sb(`/rest/v1/engagement_attachments?engagement_id=eq.${eng.id}&select=*&order=created_at.desc&limit=200`, env),
    sb(`/rest/v1/payments?engagement_id=eq.${eng.id}&select=*&order=paid_on.desc,created_at.desc&limit=200`, env),
    sb(`/rest/v1/engagement_products?engagement_id=eq.${eng.id}&select=*&order=sort_order.asc`, env),
    sb(`/rest/v1/ugc_briefs?engagement_id=eq.${eng.id}&select=*&order=created_at.desc&limit=50`, env),
    sb(`/rest/v1/engagement_videos?engagement_id=eq.${eng.id}&select=*&order=seq.asc`, env),
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
    // Multiple videos per deal (Reann #10). Every deal has exactly one row today (seq 1,
    // backfilled from engagement.video_link/post_date), so this is read-only scaffolding —
    // the deal-level metrics on `engagement` are still the ones the app writes and totals.
    videos: vr.data || [],
    ugc_briefs: ubr.data || [],
    history: hr.data || [],
    notes: nr.data || [],
    attachments: ar.data || [],
    payments,
    paid_total: Math.round(paid_total),
    allowed_next: allowedTransitions(eng.stage, eng.engagement_type === 'ugc'),
  });
}

async function getEngagementVideos(url, auth, env) {
  const eid = url.searchParams.get('engagement_id');
  if (!eid) return err('engagement_id required', 400);
  const r = await sb(`/rest/v1/engagement_videos?engagement_id=eq.${eid}&select=*&order=seq.asc`, env);
  return ok({ videos: r.data || [] });
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
  const PROGRESSED = new Set(['shipped','delivered','scheduled','posting','live']);
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
  const POSTED = new Set(['posting', 'live']);
  // Embedded rows, so the exclusion is applied here rather than in the query (Reann, 2026-08-27).
  // `linked_count` deliberately still counts cancelled deals — they ARE linked to the campaign and
  // hiding them would make the list disagree with the campaign's own deal table — but their money
  // and metrics are left out of every total below.
  const counted = engs.filter(countsTowardSpend);
  const spend = counted.reduce((s, e) => s + (e.total_cost != null ? num(e.total_cost) : num(e.payment_amount)), 0);
  // Reann #3 — budget consumed / remaining. "Consumed" is the deal's agreed cost the moment it is
  // linked, NOT amounts actually paid: a campaign's budget is committed when the deal is struck,
  // and a manager needs to see the commitment before the money moves. Remaining is null (not 0)
  // when no budget is set, so "no budget" never renders as "fully spent".
  const budget = c.budget_amount != null ? num(c.budget_amount) : null;
  return {
    linked_count: engs.length,
    posted_count: engs.filter(e => POSTED.has(e.stage)).length,
    spend,
    budget,
    budget_remaining: budget != null ? budget - spend : null,
    budget_pct: budget ? Math.round(spend / budget * 100) : null,
    views: counted.reduce((s, e) => s + num(e.views), 0),
    orders: counted.reduce((s, e) => s + num(e.orders), 0),
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
  // ⚠️ 'cancelled' belongs here too — MISSED when the stage was added and caught by the S317
  // hostile review. This is a LOCAL duplicate of the module-level TERMINAL set, so widening that
  // one did not reach it: a cancelled UGC deal would have been counted as an active creative and
  // accrued "days active" forever. Latent (no UGC deal is cancelled today) but exactly the
  // PATTERN-218 shape — a rule taught to every site but one. Mirrors UGC_TERMINAL in ugcStages.js.
  const TERMINAL_UGC = new Set(['retired', 'dropped', 'cancelled']);
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

// POC dropdown source (Reann #5): people who hold an Ignition role carrying ignition_view.
// Repointed off store.roles onto the Ignition-only layer (2026-07-20) — otherwise it would
// still list the whole company `admin` cohort and miss anyone granted Ignition directly.
async function getIgnitionUsers(_url, auth, env) {
  const rr = await sbStore(`/rest/v1/ignition_roles?select=role_key,permissions`, env);
  const roleKeys = (rr.ok ? rr.data || [] : [])
    .filter(r => r.permissions && (r.permissions.ignition_view === true || r.permissions.ignition_view === 'true'))
    .map(r => r.role_key);
  if (!roleKeys.length) return ok({ users: [] });
  const inList = roleKeys.map(encodeURIComponent).join(',');
  const ar = await sbStore(`/rest/v1/ignition_user_roles?active=is.true&role_key=in.(${inList})&select=user_id`, env);
  const userIds = (ar.ok ? ar.data || [] : []).map(r => r.user_id);
  if (!userIds.length) return ok({ users: [] });
  const ur = await sbStore(
    `/rest/v1/users_profile?active=eq.true&id=in.(${userIds.join(',')})&select=id,full_name&order=full_name.asc`, env);
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
  // Active = in-progress, non-terminal. 'live' is now the terminal SUCCESS stage
  // (S214 ⑤) — excluded from active and shown on its own "Live" tile.
  const ACTIVE = "stage=in.(planning,agreed,shipped,delivered,scheduled,posting,delayed,on_hold)";
  const [active, live, ghosted, overdue] = await Promise.all([
    count(ACTIVE),
    count('stage=eq.live'),
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
    `/rest/v1/engagements?${EXCLUDE_NON_SPEND}&select=engagement_type,views,likes,shares,orders,conversions_value,total_cost,payment_amount,ad_spend,commission_amount&limit=5000`,
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

  return ok({ active, live, ghosted, overdue, engagement_totals, ugc_summary });
}

// ── Overdue-post detection (auto-rating signal) ──────────────────────────────
// An engagement is "overdue" when its expected post date has passed by more
// than `days` and it still hasn't gone live (no post_date, not in a posted/
// terminal stage). Drives the dashboard signal + the flagOverdueRatings sweep.
const OVERDUE_DEFAULT_DAYS = 7;
// Don't flag as overdue if it's already posting/posted/done, terminal, or
// deliberately paused/late (on_hold/delayed) — the team already knows about those.
// 'cancelled' added 2026-08-27: a called-off deal must never surface as "overdue to post" —
// it drives the Schedule chase list and the auto-red-rating sweep, and neither should be
// hounding a creator about a deal LOT itself cancelled.
const POSTED_OR_TERMINAL = ['posting', 'live', 'ghosted', 'dropped', 'cancelled', 'on_hold', 'delayed'];

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
  // Cancelled deals are excluded from the whole report, not just its money columns — a report is
  // metrics end to end, and a deal called off before anything was spent has no numbers to add.
  filters.push(EXCLUDE_NON_SPEND);

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
    // ⚠️ Keyed CASE-INSENSITIVELY (2026-08-27). `product_code` holds free text — 44 distinct
    // spellings for 22 products, measured the same day — and this map keyed on the raw string,
    // so "CREST", "Crest" and "crest" were three separate bars in the spend-by-product chart,
    // each holding a third of the real spend. Nothing on the report said so. The stored values
    // were cleaned in the same session, but new free text keeps arriving, so the fix belongs
    // here as well as in the data. Mirrors apps/ignition/src/lib/productLabel.js.
    const prodRaw = String(e.product_code || '').trim().replace(/\s+/g, ' ') || '—';
    const prodKey = prodRaw.toLowerCase();
    const p = byProductMap[prodKey]
      || (byProductMap[prodKey] = { name: productDisplay(prodRaw), deals: 0, spend: 0, orders: 0, views: 0 });
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
  // ⛔ FIXED S309: this used sbStore(), i.e. Accept-Profile 'store' — but product_master
  // lives in PUBLIC and has no `store` counterpart. Every call returned PostgREST
  // PGRST205 "Could not find the table 'store.product_master' in the schema cache",
  // the frontend's `Array.isArray(r?.products) ? … : []` turned that error object into
  // an EMPTY catalogue, and the product picker silently offered zero options — so every
  // product on every deal was typed free-hand. That is precisely Reann's "we still have
  // to enter the product name and price manually" (#bugs 2026-08-18), and it also killed
  // the whole S273 COGS chain in the field: with nothing to pick, `opt` was always null,
  // so product_ref was never recorded and getProductCogs was never called.
  // Cross-schema READ with a per-call profile override, same as getProductCogs.
  // product_code added S273 (Reann #2) — without it the picker cannot record a real product
  // reference, which is what made COGS unlookupable. Inactive rows excluded: a discontinued
  // variant should not be pickable on a new deal.
  // ⛔ REMOTES EXCLUDED 2026-08-28 (S321, Nandu #bugs) — this is the fix for "the variant is
  // not visible", and the mechanism is worth keeping in mind before widening this select again.
  // A remote row carries `model = color = NULL`, so ProductLinesEditor's
  // `[name, model, color].filter(Boolean).join(' · ')` collapses it to the BARE PRODUCT NAME —
  // "Ghost" sitting in the same dropdown as "Ghost · Underground · White". Typing the product
  // name therefore surfaces the remote as the closest match, and picking it stores the remote's
  // product_code with an empty variant. That is not a display quirk: it is how IGN-2026-00550,
  // -00544 and -00156 each ended up with a REMOTE saved as the deal's product (3 of the only 9
  // rows that carry a product_ref at all). The S310 pick-splitting fix corrected which FIELD the
  // variant lands in; it could not help here, because a remote genuinely has no variant to split.
  // Ignition never ships a bare remote as a goodie, so the row has no business in this picker.
  // The Combobox stays creatable, so a genuine one-off can still be typed as free text.
  // ⚠️ NULL-SAFE ON PURPOSE — `component_type=not.eq.remote` alone would DROP a row whose
  // component_type is NULL, because SQL comparisons against NULL are unknown, not true. Every
  // active row carries one today (car 126 · remote 38 · puzzle 28 · drone 7, measured
  // 2026-08-28), so the plain filter would look correct forever right up until someone
  // registers a product without it — and it would then vanish from the picker with no error,
  // which is the same silent-exclusion class RULE-009 records. An unclassified product should
  // stay pickable; only an explicit remote is excluded.
  const productsRes = await sb(
    `/rest/v1/product_master?select=name:product,sku,product_code,model,color&is_active=eq.true`
    + `&or=(component_type.is.null,component_type.neq.remote)&order=product`,
    env,
    { headers: { 'Accept-Profile': 'public', 'Content-Profile': 'public' } },
  ).catch(() => ({ ok: false, data: [] }));
  // Managed category options (both axes) — admin-extendable via addCategoryOption.
  const catOptsRes = await sb(
    `/rest/v1/category_options?active=is.true&select=axis,label,sort_order&order=axis,sort_order,label`,
    env,
  ).catch(() => ({ data: [] }));
  const catOpts = catOptsRes.data || [];
  // Never hand the client an error object under `products`: the picker does
  // `Array.isArray(r?.products) ? … : []`, so a failed read degrades to an empty
  // catalogue that looks exactly like a real one. Log it and send a real array.
  const products = Array.isArray(productsRes.data) ? productsRes.data : [];
  if (!products.length) console.error('[getCatalogs] product_master read returned no rows', JSON.stringify(productsRes.data));
  return ok({
    influencer_types: ['nano','micro','macro','brand','store'],
    deal_types: ['paid','barter','affiliate','paid_plus_affiliate'],
    payment_terms: ['advance','on_draft','on_release','n_a'],
    engagement_types: ['video_tracking','ugc'],
    stages: STAGES,
    closed_reasons: ['completed','ghosted','declined','dropped','cancelled','historical_import'],
    list_statuses: ['master','b_list','archived'],
    quality_ratings: ['green','yellow','red','unrated'],
    directed_to: ['website','amazon','flipkart'],
    products,
    category_options: {
      format: catOpts.filter(o => o.axis === 'format').map(o => o.label),
      niche:  catOpts.filter(o => o.axis === 'niche').map(o => o.label),
      // Reann #7 — marketing campaigns. Kept on the same managed picklist so Reann can add one
      // without a deploy; see the matching axis guard in addCategoryOption.
      campaign: catOpts.filter(o => o.axis === 'campaign').map(o => o.label),
    },
    // Reann #2 — the reason vocabulary behind metric_gaps. Served from here (not hardcoded in the
    // app) so the list stays one definition; the column deliberately has no CHECK (PATTERN-218).
    metric_gap_reasons: [
      { value: 'internal_gap',  label: 'Internal gap — we never captured it' },
      { value: 'gated_data',    label: 'Gated — platform will not expose it' },
      { value: 'system_timing', label: 'System / timing — too early or a sync issue' },
    ],
    age_ranges: AGE_RANGES,
    gender_majorities: GENDER_MAJORITIES,
  });
}

async function getMe(url, auth, env) {
  return ok({
    userId: auth.userId,
    email: auth.email,
    role: auth.role,                  // global role — context only
    ignitionRole: auth.ignitionRole,  // the role that actually gates Ignition
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
  // Profile enrichment (Reann Batch B #7/#8): audience-niche axis + demographics.
  'audience_niches','age_range','gender_majority',
];

const AGE_RANGES = ['13-17','18-24','25-34','35-44','45-54','55-64','65+'];
const GENDER_MAJORITIES = ['male','female','balanced'];

const ENGAGEMENT_FIELDS = [
  'engagement_type','campaign_id','product_code','product_variant',
  'deal_type','payment_terms','payment_amount','affiliate_pct','commission_amount',
  'ad_spend','goodies_cost','shipping_cost','return_cost',
  // Ad rights (Reann #4, 2026-08-27). `ad_rights_amount` is a term of the GENERATED total_cost,
  // so saving one recomputes CPM through the same path every other cost field uses.
  'ad_rights','ad_rights_amount','ad_rights_duration',
  // cpm is worker-computed (recomputeCpm), not a manual field (theme ④ B13).
  'compliance_caption_link','compliance_coupon_verbal','compliance_car_motion',
  'expected_post_date','post_date','delivered_date','video_link','utm_link',
  'utm_source','utm_medium','utm_campaign',
  'views','likes','comments','shares','impressions','sessions','orders',
  // Reann 2026-08-10 #1 — the four capture fields the ratio framework needs.
  // follower_count_at_post is point-in-time and NOT backfillable (see the column comment).
  'saves','reposts','followers_gained','follower_count_at_post',
  // Reann #2 — per-metric "why is this blank" reasons; distinguishes a real 0 from unknown.
  'metric_gaps',
  // 'campaign_tag' was here (Reann #7, S272) and is DELIBERATELY REMOVED (S273): campaigns are
  // now real rows via campaign_id. The column survives read-only so the old tags stay auditable —
  // leaving it writable would rebuild the second campaign list we just collapsed.
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
      product_ref: (p.product_ref && String(p.product_ref).trim()) || null,
      cogs_inr: (p.cogs_inr != null && p.cogs_inr !== '') ? Number(p.cogs_inr) : null,
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

// Add a managed category option on either axis (Reann Batch B #7 "add more").
// Case-insensitive dedupe — returns the existing row if the label already exists.
async function addCategoryOption(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  const axis = String(body.axis || '').trim();
  const label = String(body.label || '').trim();
  // 'campaign' added 2026-08-11 (Reann #7). ⚠️ This guard is the second enforcement point for a new
  // axis — getCatalogs below is the first. Adding an axis in only one of them is the PATTERN-218
  // shape: the picklist renders but nothing can be added to it, or vice versa.
  if (!['format', 'niche', 'campaign'].includes(axis)) return err('invalid_axis', 400);
  if (!label) return err('label_required', 400);

  const existing = await sb(
    `/rest/v1/category_options?axis=eq.${axis}&label=ilike.${encodeURIComponent(label)}&select=id,axis,label&limit=1`,
    env,
  );
  if (existing.ok && existing.data?.[0]) return ok(existing.data[0]);

  const r = await sb(`/rest/v1/category_options`, env, {
    method: 'POST',
    body: JSON.stringify([{ axis, label, created_by: auth.userId }]),
  });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0] || { axis, label });
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

  // Reann #5 — all new deals start at 'proposed' and need approval to move on.
  const startStage = STAGES.includes(body.stage) ? body.stage : 'proposed';
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
// CPM auto-calc (theme ④ B13): cost-per-1000-views off the GENERATED total_cost
// (payment+commission+ad_spend+goodies+shipping+return). Worker-owned, not manual.
async function recomputeCpm(env, engagementId) {
  const r = await sb(`/rest/v1/engagements?id=eq.${engagementId}&select=views,total_cost&limit=1`, env);
  const e = r.data?.[0]; if (!e) return;
  const views = Number(e.views) || 0;
  const cpm = views > 0 ? Math.round((Number(e.total_cost || 0) / views) * 1000 * 100) / 100 : null;
  await sb(`/rest/v1/engagements?id=eq.${engagementId}`, env, {
    method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ cpm }),
  });
}

async function setEngagementProducts(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.engagement_id) return err('engagement_id required', 400);
  if (!Array.isArray(body.products)) return err('products[] required', 400);
  await sb(`/rest/v1/engagement_products?engagement_id=eq.${body.engagement_id}`, env, {
    method: 'DELETE', prefer: 'return=minimal',
  });
  if (body.products.length) await insertEngagementProducts(env, body.engagement_id, body.products);
  await rollupEngagementProducts(env, body.engagement_id);
  await recomputeCpm(env, body.engagement_id);   // goodies changed → cost changed
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
  await recomputeCpm(env, body.engagement_id);   // views/costs may have changed (B13)
  return ok(r.data?.[0]);
}

// Gifted-but-never-posted (theme ④ B14) — distinct from ghosted. Flags the deal +
// marks the influencer do-not-ship. Goodies value rolls into "unrecovered" (getQualityFlags).
async function markGiftedNoPost(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.engagement_id) return err('engagement_id required', 400);
  const val = body.value !== false;   // default true
  const er = await sb(`/rest/v1/engagements?id=eq.${body.engagement_id}&select=influencer_id&limit=1`, env);
  if (!er.ok || !er.data?.[0]) return err('not_found', 404);
  await sb(`/rest/v1/engagements?id=eq.${body.engagement_id}`, env, {
    method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({ gifted_no_post: val, gifted_no_post_at: val ? nowIso() : null, updated_at: nowIso() }),
  });
  // Set do-not-ship when flagging; don't auto-clear (another deal may still warrant it).
  if (val && er.data[0].influencer_id) {
    await sb(`/rest/v1/influencers?id=eq.${er.data[0].influencer_id}`, env, {
      method: 'PATCH', prefer: 'return=minimal',
      body: JSON.stringify({ do_not_ship: true, do_not_ship_reason: 'gifted, never posted', updated_at: nowIso() }),
    });
  }
  return ok({ gifted_no_post: val });
}

// Dashboard quality/lifecycle surfacing (theme ④ B6/B12/B14).
async function getQualityFlags(url, auth, env) {
  const re = await sb(`/rest/v1/rpc/reengage_list`, env, { method: 'POST', body: JSON.stringify({ p_days: 60 }) });
  const gp = await sb(`/rest/v1/engagements?gifted_no_post=eq.true&select=goodies_cost`, env);
  const nc = await sb(`/rest/v1/engagements?stage=eq.live&or=(compliance_caption_link.is.false,compliance_coupon_verbal.is.false,compliance_car_motion.is.false)&select=id`, env);
  const gifted = gp.data || [];
  return ok({
    reengage: re.data || [],
    unrecovered_value: gifted.reduce((s, e) => s + Number(e.goodies_cost || 0), 0),
    gifted_no_post_count: gifted.length,
    noncompliant_count: (nc.data || []).length,
  });
}

// ── Reann #5 — approve a proposed deal (ignition_manage) ──────────────────────────────────────
// Deliberately its own action rather than a field on updateEngagement: approval is an event with
// an actor and a time, it belongs in engagement_history, and keeping approved_at out of
// ENGAGEMENT_FIELDS means no ordinary patch can forge it.
async function approveEngagement(body, auth, env) {
  // ⚠️ Gated on `ignition_approve`, NOT `ignition_manage` (changed 2026-08-26, S313, Afshaan:
  // "final approval will be with Reann, his team loses access to final approvals").
  //
  // ⚠️ `ignition_approve` was a DEAD PERMISSION until this line: it existed in the role table and
  // was described in the manual as the thing that gates approval, but nothing anywhere read it —
  // approval ran on `ignition_manage`, which every role but viewer holds. That is why 26 people
  // could approve while the docs said Lead-and-Admin, and how two `ignition_manager` users
  // (a role with no approve permission at all) approved 15 deals between them.
  // Removing the key from a role would therefore have changed NOTHING. Wiring it is the fix.
  const gate = requirePerm('ignition_approve', auth); if (gate) return gate;
  if (!body.engagement_id) return err('engagement_id required', 400);
  const cur = await sb(`/rest/v1/engagements?id=eq.${body.engagement_id}&select=stage,approved_at,engagement_type&limit=1`, env);
  if (!cur.ok || !cur.data?.[0]) return err('not_found', 404);
  // Idempotent — re-approving is a no-op rather than an error, so a double-click cannot
  // overwrite who actually approved it or when.
  if (cur.data[0].approved_at) {
    return ok({ already_approved: true, approved_at: cur.data[0].approved_at });
  }
  const from = cur.data[0].stage;
  const isUgc = cur.data[0].engagement_type === 'ugc';

  // ── Reann #11 (2026-08-27): approval MOVES the deal on ──────────────────────────────────────
  // "Once the video is approved, could you please move it to planning automatically? Right now,
  // it just stays in proposed."
  //
  // Approving was previously a flag and nothing more: the deal sat in Proposed wearing an
  // "approved" stamp, and someone still had to open Advance and pick the next stage by hand.
  // Since the ONLY thing the gate blocks is leaving Proposed, an approved deal that is still in
  // Proposed is a contradiction — the approval is the go-ahead.
  //
  // ⚠️ UGC goes to `outreach`, not `planning`: `planning` is not in UGC_STAGES, so a UGC deal
  // parked there would be fetched by getUgcPipeline and render in NO column — the same silent
  // invisibility the S272 'proposed' bucket trap caused. Only a deal actually in Proposed is
  // moved; approving anything else stamps the flag and leaves the stage alone.
  const autoStage = from === 'proposed' ? (isUgc ? 'outreach' : 'planning') : null;

  const at = nowIso();
  const patch = { approved_at: at, approved_by: auth.userId, updated_at: at };
  if (autoStage) patch.stage = autoStage;
  const r = await sb(`/rest/v1/engagements?id=eq.${body.engagement_id}`, env, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  await writeHistory(env, body.engagement_id, 'approve', from, autoStage || from,
    (body.note && String(body.note).trim()) || null, auth.userId);
  return ok({ approved_at: at, approved_by: auth.userId, stage: autoStage || from, auto_advanced: !!autoStage });
}

async function advanceStage(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.engagement_id) return err('engagement_id required', 400);
  if (!body.to_stage) return err('to_stage required', 400);

  const cur = await sb(
    `/rest/v1/engagements?id=eq.${body.engagement_id}&select=stage,video_link,shipping_order_id,influencer_id,engagement_type,live_at,tracking_url,affiliate_active_from,post_date,approved_at&limit=1`, env,
  );
  if (!cur.ok || !cur.data?.[0]) return err('not_found', 404);
  const from = cur.data[0].stage;
  const isUgc = cur.data[0].engagement_type === 'ugc';
  const allowed = allowedTransitions(from, isUgc);
  if (!allowed.includes(body.to_stage)) {
    // The message names the deal's type deliberately: "illegal_transition: delivered → planning"
    // is baffling on its own when planning is a perfectly ordinary stage for the OTHER type.
    return err(
      `illegal_transition: ${from} → ${body.to_stage} (not a ${isUgc ? 'UGC' : 'video'} stage)`,
      422,
    );
  }

  // ── Reann #5: the approval gate ────────────────────────────────────────────────────────────
  // A deal cannot LEAVE 'proposed' until it has been approved. Rejecting is deliberately still
  // allowed: you must be able to drop or ghost a proposal you are declining without first
  // approving it, which would be nonsense and would also pollute the approved-deal count.
  // NB advanceStage already requires ignition_manage, so this is not a second permission — it is
  // an explicit, recorded decision point, which is what "cannot be skipped" actually asks for.
  if (from === 'proposed' && !TERMINAL_FAIL.has(body.to_stage) && !cur.data[0].approved_at) {
    return err('approval_required: approve this deal before moving it out of Proposed', 422);
  }

  // Going live requires a video link (Reann #4) — accepted inline or already set.
  if (body.to_stage === 'live') {
    const incomingLink = (body.video_link != null ? String(body.video_link) : '').trim();
    const existingLink = (cur.data[0].video_link || '').trim();
    if (!incomingLink && !existingLink) return err('video_link_required_for_live', 422);
  }

  // Video deals (S214 6-pt ②): a video POST DATE is mandatory at go-live so views
  // attribute to the month the video actually posted (the monthly-target driver).
  // Accepted inline or already on the row. UGC uses live_at instead — exempt.
  if (body.to_stage === 'live' && !isUgc) {
    const incomingDate = (body.post_date != null ? String(body.post_date) : '').trim();
    const existingDate = (cur.data[0].post_date || '').toString().trim();
    if (!incomingDate && !existingDate) return err('post_date_required_for_live', 422);
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

  // Going live requires a colour rating on the influencer (Reann Batch A#3, moved to
  // 'live' in S214 6-pt ⑤ now that 'live' is the terminal success stage) — apply inline
  // if given. Video deals only; UGC keeps its own quality flow.
  if (body.to_stage === 'live' && !isUgc) {
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
    if (!rated) return err('rating_required_for_live', 422);
  }

  const patch = { stage: body.to_stage, updated_at: nowIso() };
  // Stamp live_at on first go-live (drives UGC "days active"). Don't overwrite.
  if (body.to_stage === 'live' && !cur.data[0].live_at) patch.live_at = nowIso();
  // Affiliate commission window (theme ②): opens when the video goes live, closes when
  // it leaves live (paused/vault/completed/…). Re-entering live re-opens it. Revenue
  // still attributes after close; only commission stops (couponInWindow check).
  const _today = nowIso().slice(0, 10);
  if (body.to_stage === 'live') {
    if (!cur.data[0].affiliate_active_from) patch.affiliate_active_from = _today;
    patch.affiliate_active_to = null;
  } else if (from === 'live') {
    patch.affiliate_active_to = _today;
  }
  // 'live' is the terminal SUCCESS stage for video deals (S214 ⑤); UGC still closes at
  // retired/dropped, so live is terminal only when !isUgc.
  const terminalSuccessLive = body.to_stage === 'live' && !isUgc;
  if (TERMINAL.has(body.to_stage) || terminalSuccessLive) {
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

  // Reann's "mandatory tracking link at Shipped" (B-theme ①). Auto-mint on arrival at shipped,
  // and ONLY if the deal has none — mintTrackingLinkFor is idempotent on utm_link.
  // ⚠️ Deliberately non-fatal: the goods have shipped either way, and failing the stage move
  // because a link service was briefly unreachable would leave the pipeline lying about where
  // the deal is. A miss is recoverable — the deal page has an explicit mint button.
  let tracking_link = null;
  if (body.to_stage === 'shipped') {
    try {
      const lr = await mintTrackingLinkFor(env, body.engagement_id, {});
      if (lr.ok) tracking_link = lr.data.url;
      else console.error('[advanceStage] tracking link mint failed', body.engagement_id, lr.error);
    } catch (e) { console.error('[advanceStage] tracking link mint threw', String(e?.message || e)); }
  }
  return ok({ stage: body.to_stage, allowed_next: allowedTransitions(body.to_stage, isUgc), tracking_link });
}

async function closeEngagement(body, auth, env) {
  // Default close = Live (the terminal success stage, S214 ⑤); caller can pass
  // to_stage ghosted/dropped/retired instead. Live close still runs the go-live
  // guards (video link + post date + rating) in advanceStage.
  if (!TERMINAL.has(body.to_stage)) body.to_stage = 'live';
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

// ─────────────────────────────────────────────────────────────────────────────
// Coupon + attribution + goodies pricing (Reann Batch B theme ②)
// Spec: docs/superpowers/specs/2026-06-28-ignition-reann-batch-b-coupon-attribution-design.md
// ─────────────────────────────────────────────────────────────────────────────

const COUPON_SYNC_MAX = 6;   // active codes per "sync all" pass (50-subrequest budget; cron drains over days)

const shopifyConfigured = (env) => !!(env.SHOPIFY_STORE_DOMAIN && env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET);

// Generic Shopify Admin GraphQL call, one token-refresh retry on 401. Never throws.
async function shopifyGraphql(env, query, variables) {
  if (!shopifyConfigured(env)) return { ok: false, configured: false, error: 'shopify_not_configured' };
  const run = (token) => fetch(`https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  let token = await getShopifyToken(env);
  if (!token) return { ok: false, configured: true, error: 'shopify_auth_failed' };
  let res = await run(token).catch(() => null);
  if (res && res.status === 401) { token = await getShopifyToken(env, true); if (token) res = await run(token).catch(() => null); }
  if (!res || !res.ok) return { ok: false, configured: true, error: `shopify_${res ? res.status : 'network'}` };
  let data = await res.json().catch(() => null);
  // A scope/access-denied GraphQL error (HTTP 200) can mean the app's scopes were
  // updated AFTER this cached token was minted — force one fresh token + retry so a
  // just-released scope change takes effect without a worker redeploy.
  if (data?.errors?.length && isScopeError(data.errors[0]?.message)) {
    const t2 = await getShopifyToken(env, true);
    if (t2) {
      const res2 = await run(t2).catch(() => null);
      if (res2 && res2.ok) data = await res2.json().catch(() => data);
    }
  }
  if (data?.errors?.length) return { ok: false, configured: true, error: data.errors[0]?.message, errors: data.errors };
  return { ok: true, configured: true, data: data?.data };
}

const isScopeError = (msg) => /access|scope|permission|not approved|requires merchant/i.test(String(msg || ''));

// Create a basic code discount. pct is a percentage (100, 10…). Returns { gid } or { error }.
async function shopifyCreateDiscount(env, { code, pct, singleUse }) {
  const mutation = `mutation($d: DiscountCodeBasicInput!){ discountCodeBasicCreate(basicCodeDiscount:$d){ codeDiscountNode{ id } userErrors{ field message code } } }`;
  const d = {
    title: code, code, startsAt: nowIso(),
    customerSelection: { all: true },
    customerGets: { value: { percentage: Math.min(Math.max(Number(pct) || 0, 0), 100) / 100 }, items: { all: true } },
    appliesOncePerCustomer: !!singleUse,
    ...(singleUse ? { usageLimit: 1 } : {}),
  };
  const r = await shopifyGraphql(env, mutation, { d });
  if (!r.ok) return { error: r.error, scope_missing: isScopeError(r.error) };
  const ue = r.data?.discountCodeBasicCreate?.userErrors || [];
  if (ue.length) return { error: ue[0].message, scope_missing: isScopeError(ue[0].message) };
  return { gid: r.data?.discountCodeBasicCreate?.codeDiscountNode?.id || null };
}

async function shopifyDeactivateDiscount(env, gid) {
  if (!gid) return { ok: true };
  const mutation = `mutation($id: ID!){ discountCodeDeactivate(id:$id){ codeDiscountNode{ id } userErrors{ field message } } }`;
  const r = await shopifyGraphql(env, mutation, { id: gid });
  if (!r.ok) return { ok: false, error: r.error };
  const ue = r.data?.discountCodeDeactivate?.userErrors || [];
  if (ue.length) return { ok: false, error: ue[0].message };
  return { ok: true };
}

// Orders that used a code (paginated, capped). Returns [{order_id,name,date,gross,refunded}].
async function shopifyOrdersForCode(env, code, sinceDate, maxPages = 3) {
  const q = `discount_code:${code}` + (sinceDate ? ` created_at:>=${sinceDate}` : '');
  const query = `query($q:String!,$cursor:String){ orders(first:50, after:$cursor, query:$q, sortKey:CREATED_AT){ edges{ cursor node{ id name createdAt totalPriceSet{ shopMoney{ amount } } totalRefundedSet{ shopMoney{ amount } } } } pageInfo{ hasNextPage } } }`;
  const out = []; let cursor = null;
  for (let p = 0; p < maxPages; p++) {
    const r = await shopifyGraphql(env, query, { q, cursor });
    if (!r.ok) return { ok: false, error: r.error, orders: out };
    const conn = r.data?.orders;
    for (const e of (conn?.edges || [])) {
      const n = e.node;
      out.push({
        order_id: n.id, name: n.name, date: n.createdAt,
        gross: Number(n.totalPriceSet?.shopMoney?.amount || 0),
        refunded: Number(n.totalRefundedSet?.shopMoney?.amount || 0),
      });
      cursor = e.cursor;
    }
    if (!conn?.pageInfo?.hasNextPage) break;
  }
  return { ok: true, orders: out };
}

// A vanity code base from the creator's name/handle: "REANNLOT".
function couponBase(inf) {
  const raw = inf?.person_name || inf?.channel_name || inf?.influencer_code || 'CREATOR';
  return (String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'CREATOR') + 'LOT';
}
async function mintCouponCode(env, inf) {
  const base = couponBase(inf);
  const r = await sb(`/rest/v1/coupon_codes?code=like.${encodeURIComponent(base)}*&select=code`, env);
  const taken = new Set((r.ok ? r.data || [] : []).map(x => x.code));
  let code = base, n = 1;
  while (taken.has(code)) { n += 1; code = `${base}${n}`; }
  return code;
}

// Gift codes are 100%-off internal codes — they must be UNGUESSABLE so a customer
// can never land one by fluke (the old vanity `<NAME>LOT` was predictable — a shopper
// could type a name + LOT and get a free order). So gift codes are random gibberish
// (crypto-random, ambiguous chars I/O/0/1/L dropped for legibility). Affiliate codes
// stay vanity (they're meant to be shared and aren't 100% off). Reann #bugs 2026-07-16.
function randomGiftCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 31 chars, no I/O/L/0/1
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}
async function mintRandomGiftCode(env) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = randomGiftCode();
    const r = await sb(`/rest/v1/coupon_codes?code=eq.${encodeURIComponent(code)}&select=code&limit=1`, env);
    if (r.ok && (r.data || []).length === 0) return code;
  }
  return null; // astronomically unlikely — 31^12 space
}

// Is an order's date inside the engagement's commission window? from required (window
// not open until live); to is exclusive (commission stops the day it leaves live).
function couponInWindow(orderDateIso, from, to) {
  if (!from) return false;
  const d = String(orderDateIso || '').slice(0, 10);
  if (!d || d < from) return false;
  if (to && d >= to) return false;
  return true;
}

async function issueCoupon(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  const kind = body.kind === 'gift' ? 'gift' : 'affiliate';
  if (!body.engagement_id) return err('engagement_id required', 400);
  const er = await sb(`/rest/v1/engagements?id=eq.${body.engagement_id}&select=id,influencer_id,influencer:influencer_id(person_name,channel_name,influencer_code)&limit=1`, env);
  if (!er.ok || !er.data?.[0]) return err('engagement_not_found', 404);
  const eng = er.data[0];
  const pct = kind === 'gift' ? 100 : (body.discount_pct != null ? Number(body.discount_pct) : NaN);
  if (kind === 'affiliate' && (isNaN(pct) || pct <= 0 || pct > 100)) return err('discount_pct (1-100) required for affiliate', 400);
  // Gift = ALWAYS a random unguessable code (ignore any passed code — a gift code must
  // never be a predictable vanity string, RULE below). Affiliate = vanity (passed or minted).
  const code = kind === 'gift'
    ? await mintRandomGiftCode(env)
    : (body.code
        ? String(body.code).toUpperCase().replace(/[^A-Z0-9]/g, '')
        : await mintCouponCode(env, eng.influencer || {}));
  if (!code) return err('could_not_mint_code', 500);

  // Create on Shopify — gated on write_discounts; graceful pending_shopify if unavailable.
  const sh = await shopifyCreateDiscount(env, { code, pct, singleUse: kind === 'gift' });
  const gid = sh.gid || null;
  const status = gid ? 'active' : 'pending_shopify';

  const ins = await sb(`/rest/v1/coupon_codes`, env, {
    method: 'POST',
    body: JSON.stringify([{
      code, kind, engagement_id: eng.id, influencer_id: eng.influencer_id,
      discount_pct: pct, shopify_discount_gid: gid, status,
      usage_limit: kind === 'gift' ? 1 : null, created_by: auth.userId,
    }]),
  });
  if (!ins.ok) return err(`db_error: ${JSON.stringify(ins.data)}`, 400);
  return ok({ coupon: ins.data?.[0], shopify: gid ? 'created' : 'pending', note: gid ? null : (sh.error || 'shopify_unavailable') });
}

// Re-attempt the Shopify create for a code stuck at pending_shopify (e.g. issued
// while write_discounts was missing on the app). Pushes the SAME code — no new row,
// so a vanity code already handed to a creator goes live unchanged (S214).
async function retryCoupon(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.coupon_code_id) return err('coupon_code_id required', 400);
  const cr = await sb(`/rest/v1/coupon_codes?id=eq.${body.coupon_code_id}&select=id,code,kind,discount_pct,status,shopify_discount_gid&limit=1`, env);
  if (!cr.ok || !cr.data?.[0]) return err('not_found', 404);
  const c = cr.data[0];
  if (c.shopify_discount_gid) return ok({ pushed: true, already: true, shopify: 'exists' });
  if (c.status !== 'pending_shopify') return err('not_pending', 400);
  const sh = await shopifyCreateDiscount(env, { code: c.code, pct: Number(c.discount_pct) || 0, singleUse: c.kind === 'gift' });
  if (!sh.gid) return ok({ pushed: false, shopify: 'pending', note: sh.error || 'shopify_unavailable', scope_missing: !!sh.scope_missing });
  await sb(`/rest/v1/coupon_codes?id=eq.${body.coupon_code_id}`, env, {
    method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({ shopify_discount_gid: sh.gid, status: 'active' }),
  });
  return ok({ pushed: true, shopify: 'created', code: c.code, gid: sh.gid });
}

async function retireCoupon(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.coupon_code_id) return err('coupon_code_id required', 400);
  const cr = await sb(`/rest/v1/coupon_codes?id=eq.${body.coupon_code_id}&select=shopify_discount_gid&limit=1`, env);
  if (!cr.ok || !cr.data?.[0]) return err('not_found', 404);
  const deact = await shopifyDeactivateDiscount(env, cr.data[0].shopify_discount_gid);
  await sb(`/rest/v1/coupon_codes?id=eq.${body.coupon_code_id}`, env, {
    method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({ status: 'retired', retired_at: nowIso() }),
  });
  return ok({ retired: true, shopify_deactivated: deact.ok, shopify_note: deact.error || null });
}

// Reconcile one code's redemptions off Shopify; recompute its rollups (refund-aware).
async function syncOneCoupon(env, coupon, maxPages) {
  let win = { from: null, to: null, rate: 0 };
  if (coupon.engagement_id) {
    const e = await sb(`/rest/v1/engagements?id=eq.${coupon.engagement_id}&select=affiliate_active_from,affiliate_active_to,commission_rate&limit=1`, env);
    const row = e.data?.[0] || {};
    win = { from: row.affiliate_active_from || null, to: row.affiliate_active_to || null, rate: Number(row.commission_rate) || 0 };
  }
  const since = coupon.last_synced_at ? String(coupon.last_synced_at).slice(0, 10) : null;
  const ord = await shopifyOrdersForCode(env, coupon.code, since, maxPages);
  const rows = (ord.orders || []).map(o => {
    const net = Math.max(0, o.gross - o.refunded);
    const eligible = coupon.kind === 'affiliate' && couponInWindow(o.date, win.from, win.to);
    return {
      coupon_code_id: coupon.id, shopify_order_id: o.order_id, shopify_order_name: o.name,
      order_date: o.date, gross_value: o.gross, net_value: net,
      refunded: o.gross > 0 && o.refunded >= o.gross,
      commission_eligible: eligible, commission_amount: eligible ? net * (win.rate / 100) : 0,
      synced_at: nowIso(),
    };
  });
  if (rows.length) {
    await sb(`/rest/v1/coupon_redemptions?on_conflict=coupon_code_id,shopify_order_id`, env, {
      method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: JSON.stringify(rows),
    });
  }
  const all = await sb(`/rest/v1/coupon_redemptions?coupon_code_id=eq.${coupon.id}&select=gross_value,net_value,commission_amount`, env);
  const reds = all.data || [];
  const sum = (k) => reds.reduce((s, r) => s + Number(r[k] || 0), 0);
  await sb(`/rest/v1/coupon_codes?id=eq.${coupon.id}`, env, {
    method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({
      redemptions: reds.length, attributed_revenue: sum('gross_value'),
      attributed_revenue_net: sum('net_value'), commission_accrued: sum('commission_amount'),
      last_synced_at: nowIso(),
    }),
  });
  return { ok: ord.ok, count: rows.length, error: ord.error };
}

// Roll an engagement's AFFILIATE coupons up onto conversions_value + commission_earned.
// Gift codes are excluded (never count as affiliate revenue).
async function recomputeEngagementAttribution(env, engagementId) {
  if (!engagementId) return;
  const cs = await sb(`/rest/v1/coupon_codes?engagement_id=eq.${engagementId}&kind=eq.affiliate&select=attributed_revenue_net,commission_accrued`, env);
  const rows = cs.data || [];
  await sb(`/rest/v1/engagements?id=eq.${engagementId}`, env, {
    method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({
      conversions_value: rows.reduce((s, r) => s + Number(r.attributed_revenue_net || 0), 0),
      commission_earned: rows.reduce((s, r) => s + Number(r.commission_accrued || 0), 0),
      updated_at: nowIso(),
    }),
  });
}

async function syncCouponRedemptions(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!shopifyConfigured(env)) return err('shopify_not_configured', 503);
  let coupons;
  if (body.coupon_code_id) {
    const r = await sb(`/rest/v1/coupon_codes?id=eq.${body.coupon_code_id}&select=*&limit=1`, env);
    coupons = r.data || [];
  } else {
    const r = await sb(`/rest/v1/coupon_codes?status=eq.active&select=*&order=last_synced_at.asc.nullsfirst&limit=${COUPON_SYNC_MAX}`, env);
    coupons = r.data || [];
  }
  const maxPages = body.coupon_code_id ? 10 : 3;
  const touched = new Set();
  let synced = 0;
  for (const c of coupons) {
    const res = await syncOneCoupon(env, c, maxPages);
    if (res.ok) synced += 1;
    if (c.engagement_id) touched.add(c.engagement_id);
  }
  for (const eid of touched) await recomputeEngagementAttribution(env, eid);
  return ok({ coupons: coupons.length, synced });
}

// ── COGS lookup (Reann #2, S273) ─────────────────────────────────────────────────────────────
// sales.product_cost is effective-dated: many rows per product_code, one per effective_from.
// Take the latest row NOT IN THE FUTURE — a cost dated next month must not price today's deal.
// ⚠️ Cross-schema: sb() pins Accept-Profile to 'ignition', so the profile headers are overridden
// per call. This is a READ ONLY — ignitionops must never write outside its own schema.
async function getProductCogs(url, auth, env) {
  const code = String(url.searchParams.get('product_code') || '').trim();
  if (!code) return err('product_code required', 400);
  const today = new Date().toISOString().slice(0, 10);
  const r = await sb(
    `/rest/v1/product_cost?product_code=eq.${encodeURIComponent(code)}&effective_from=lte.${today}`
    + `&select=product_code,cogs_inr,effective_from&order=effective_from.desc&limit=1`,
    env,
    { headers: { 'Accept-Profile': 'sales', 'Content-Profile': 'sales' } },
  );
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);
  const row = r.data?.[0] || null;
  // A miss is a legitimate answer (uncosted SKU), not an error — the UI leaves the field manual.
  return ok({ product_code: code, cogs_inr: row ? Number(row.cogs_inr) : null, effective_from: row?.effective_from || null });
}

// Cache Shopify variant prices into ignition.product_prices (goodies auto-fill, Half B).
async function refreshProductPrices(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!shopifyConfigured(env)) return err('shopify_not_configured', 503);
  // `handle` (S313) is the storefront path segment — it is what lets a tracking link point at
  // the product page instead of the site root. Minted links never expire and the mint seam
  // cannot repoint them, so the target has to be right at mint time.
  // ⚠️ `id` (S324) is the Shopify ProductVariant GID and it is load-bearing, not decorative: the
  // handle alone identifies the PRODUCT PAGE, never the colour. All 6 Shadow car SKUs share
  // `shadow-rc-drift-car`, so a link built from the handle showed whichever variant Shopify has
  // first (Tarmac Black) regardless of which colour the deal was for. `?variant=<id>` is the only
  // thing the storefront honours — verified live 2026-08-31.
  const query = `query($cursor:String){ productVariants(first:100, after:$cursor){ edges{ cursor node{ id sku price product{ title handle } } } pageInfo{ hasNextPage } } }`;
  // Page until Shopify says there is no next page. This was `p < 8` — a hard 800-variant ceiling
  // that would have truncated silently once the catalogue outgrew it (266 today, so it had not
  // bitten yet). PAGE_MAX is a runaway guard, not a budget: hitting it is logged and reported, so
  // a short sweep can never again read as a complete one. The subrequest ceiling is 10,000.
  const PAGE_MAX = 200;
  const seen = []; let cursor = null; let truncated = false; let pages = 0;
  for (let p = 0; p < PAGE_MAX; p++) {
    const r = await shopifyGraphql(env, query, { cursor });
    if (!r.ok) return err(r.error || 'shopify_error', 502);
    const conn = r.data?.productVariants;
    pages++;
    for (const e of (conn?.edges || [])) {
      const n = e.node; cursor = e.cursor;
      const sku = (n.sku || '').trim();
      if (!sku) continue;
      // GID → bare number. Stored as text: it is an identifier we only ever concatenate into a
      // URL, and 47394784149556 is already past what a JS number holds exactly for arithmetic.
      const variantId = String(n.id || '').split('/').pop() || null;
      seen.push({ sku, title: n.product?.title || null, handle: n.product?.handle || null, variant_id: /^\d+$/.test(variantId || '') ? variantId : null, price: Number(n.price) || 0, currency: 'INR', synced_at: nowIso() });
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    if (p === PAGE_MAX - 1) truncated = true;
  }
  if (truncated) console.error(`[refreshProductPrices] stopped at the ${PAGE_MAX}-page guard with more pages available — ${seen.length} variants read`);
  // A sweep that upserts nothing is the six-week silent failure repeating. Say so out loud.
  if (!seen.length) console.error('[refreshProductPrices] read ZERO variants — check the Shopify grant (read_products)');
  for (let i = 0; i < seen.length; i += 200) {
    await sb(`/rest/v1/product_prices?on_conflict=sku`, env, {
      method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: JSON.stringify(seen.slice(i, i + 200)),
    });
  }
  return ok({ upserted: seen.length, pages, truncated });
}

async function getProductPrice(url, auth, env) {
  const sku = (url.searchParams.get('sku') || '').trim();
  // Optional: lets the sku_map fallback below run when the direct sku misses.
  const productCode = (url.searchParams.get('product_code') || '').trim();
  if (!sku && !productCode) return err('sku required', 400);
  if (sku) {
    const r = await sb(`/rest/v1/product_prices?sku=eq.${encodeURIComponent(sku)}&select=sku,title,price,currency,synced_at&limit=1`, env);
    if (r.data?.[0]) return ok({ price: r.data[0] });
  }
  // ⚠️ product_master.sku is STALE for some rows — the HP crest sells on Shopify as
  // `lotbuild-housecrest-*` while product_master still says `hp-desk-standee-house-crest-*`,
  // so the direct lookup can never hit (Himani, #bugs 2026-08-26). Odo's sku_map already
  // holds the live channel sku → product_code mapping, so resolve through it: aliases for
  // this product_code, tried against the synced price cache. Cross-schema READ only, same
  // pattern as getProductCogs reading sales.product_cost.
  if (productCode) {
    const aliases = await sb(
      `/rest/v1/sku_map?product_code=eq.${encodeURIComponent(productCode)}&select=channel_sku&limit=20`,
      env,
      { headers: { 'Accept-Profile': 'sales', 'Content-Profile': 'sales' } },
    ).catch(() => ({ data: [] }));
    const skus = [...new Set((aliases.data || []).map(a => (a.channel_sku || '').trim()).filter(s => s && s !== sku))];
    if (skus.length) {
      const inList = skus.map(s => `"${s.replace(/"/g, '')}"`).join(',');
      const r2 = await sb(`/rest/v1/product_prices?sku=in.(${encodeURIComponent(inList)})&select=sku,title,price,currency,synced_at&order=synced_at.desc&limit=1`, env);
      if (r2.data?.[0]) return ok({ price: r2.data[0] });
    }
  }
  return ok({ price: null });
}

// ── Influencer tracking links (B3 UTM auto-gen + the S312 campaign-link seam) ─────────────────
//
// One campaign link per deal, minted through commsops `POST /internal/campaign-link`. The UTM
// shape is fixed by the Ignition↔Relay design doc (2026-08-17 §B3) and is what makes per-deal
// GA4 attribution possible at all:
//   utm_source   = influencer_code   → WHO promoted it
//   utm_medium   = 'influencer'      → a fixed namespace, so Odo can filter all influencer
//                                      traffic in one predicate rather than enumerating people
//   utm_campaign = engagement_no     → WHICH DEAL, so two deals with one creator stay separable
//
// ⚠️ MINT ONLY, and never silently re-mint. A campaign link never expires, the seam cannot
// repoint one, and the influencer may already have posted it — so an existing utm_link is
// returned as-is unless the caller explicitly forces a new slug. (`utm_link` is overwritable
// by a human, never auto-overwritten — design doc §B3.)
// `www` is the canonical storefront host — the apex 301s to it. Matches commsops'
// STOREFRONT_BASE. The apex works (the redirect does preserve the query string, verified
// 2026-08-26, so UTM survives it), but a link that is going to be printed or posted should
// not spend a hop getting to the host it will end on anyway.
const LOT_STORE_URL = 'https://www.legendoftoys.com';

// Slug must satisfy commsops' SLUG_RE: ^[a-z0-9][a-z0-9-]{1,30}$ — lower-case, no dots or
// underscores, because a slug has to survive being read off printed artwork and typed by hand.
//
// ⚠️ The digits MUST include the year. `store.sequences` runs a counter PER YEAR
// (`ignition_eng_2025` reached 288, `ignition_eng_2026` is at 538), so the number alone repeats
// annually: IGN-2025-00288 and IGN-2026-00288 both exist. A last-5-digits slug therefore collides
// for any creator who gets the same number in two different years — no such pair exists today
// (checked 2026-08-26), which is exactly what makes it a latent one rather than a visible one.
function trackingSlug(influencerCode, engagementNo) {
  const digits = String(engagementNo || '').replace(/[^0-9]/g, '').slice(-9) || '000000000';
  const who = String(influencerCode || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
  return (who ? `${who}-${digits}` : `ign-${digits}`).slice(0, 31);
}

// Target resolution, best-known-first. A homepage link still attributes correctly but converts
// worse, so prefer the product page whenever the handle cache has one.
/**
 * Last-resort product resolution from the TYPED product + variant (Reann, 2026-08-27, approved
 * in-thread: "Yes please go ahead").
 *
 * Why it exists: a tracking link only points at a product page when the deal's line carries a
 * catalogue `product_ref`, and **only 7 of 378 lines do** (measured 2026-08-27) — so ~98% of links
 * sent a creator's audience to the shop front. Reann raised it twice. Matching the typed text
 * rescues 107 of the 371 ref-less lines with **zero ambiguous matches** (measured against live
 * `product_master`); the remaining 264 are free text that is not a product/model/colour
 * (`Crest`/`Ravenclaw`-shaped) and is deliberately left unresolved.
 *
 * ⚠️ **Returns a match ONLY when exactly one active product fits.** Two candidates means we do not
 * know which, and sending a creator's followers to the WRONG product is worse than sending them to
 * the shop front — the wrong page damages their post. Never "pick the first".
 *
 * ⚠️ The whole catalogue is fetched and matched in JS rather than filtered in PostgREST, on
 * purpose: the comparison is on `model || ' ' || color`, which no single column holds, and an
 * `ilike` prefilter would treat `%`/`_` in a product name as wildcards. `product_master` is small
 * (a few hundred active rows) and a mint is rare.
 */
async function matchProductsFromText(env, productText, variantText) {
  const norm = s => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const p = norm(productText);
  if (!p) return [];
  const v = norm(variantText);
  const r = await sb(
    `/rest/v1/product_master?is_active=eq.true&select=product_code,sku,product,model,color&limit=1000`,
    env,
    { headers: { 'Accept-Profile': 'public', 'Content-Profile': 'public' } },
  ).catch(() => ({ data: [] }));
  return (r.data || []).filter(row => {
    if (norm(row.product) !== p) return false;
    // No variant typed — every variant of that product is a candidate. That is NOT treated as a
    // failure: the caller checks whether they all lead to the SAME page, and on Shopify a product's
    // colourways usually do (all 12 Flare rows → /products/flare-2-rc-drift-car).
    if (!v) return true;
    return norm(`${row.model} ${row.color}`) === v;
  });
}

/**
 * The Shopify handle these candidates point at, but ONLY when they agree on one.
 *
 * ⚠️ The test is on the DESTINATION, not the catalogue row, and that is what makes it both safe and
 * useful. A deal typed as bare "Fang" with no variant matches two active products — ambiguous as a
 * row — yet both sell on `/products/fang-rc-excavator`, so the page is not in doubt at all.
 * Measured 2026-08-27: judging by product row resolves 116 of 371 ref-less lines; judging by handle
 * resolves **139**, and still refuses the **1** line whose candidates genuinely disagree.
 *
 * Batched deliberately — three reads regardless of how many candidates, rather than three per
 * candidate (bare "Flare" has 12).
 */
// The storefront URL for a product page, with the deal's own colour preselected when we know it.
// Without `?variant=` Shopify shows the product's DEFAULT variant, which is how a Tarmac Purple
// deal sent its audience to Tarmac Black (Reann, 2026-08-31). `appendUtm` in commsops parses with
// `new URL()` and appends, so an existing query string survives the 302 — verified before shipping.
function productUrl(handle, variantId) {
  if (!handle) return LOT_STORE_URL;
  const base = `${LOT_STORE_URL}/products/${handle}`;
  return /^\d+$/.test(String(variantId || '')) ? `${base}?variant=${variantId}` : base;
}

async function singleHandleFor(env, candidates) {
  const codes = [...new Set(candidates.map(c => c.product_code).filter(Boolean))];
  if (!codes.length) return null;
  const inCodes = codes.map(c => `"${String(c).replace(/"/g, '')}"`).join(',');
  // product_master.sku can be stale vs the live Shopify sku (the HP crest case), so take the
  // channel aliases too — same fallback the price lookup uses.
  const aliases = await sb(
    `/rest/v1/sku_map?product_code=in.(${encodeURIComponent(inCodes)})&select=channel_sku&limit=200`, env,
    { headers: { 'Accept-Profile': 'sales', 'Content-Profile': 'sales' } },
  ).catch(() => ({ data: [] }));
  const skus = [...new Set([
    ...candidates.map(c => c.sku),
    ...(aliases.data || []).map(a => a.channel_sku),
  ].map(s => (s || '').trim()).filter(Boolean))];
  if (!skus.length) return null;
  const inSkus = skus.map(s => `"${s.replace(/"/g, '')}"`).join(',');
  const pp = await sb(
    `/rest/v1/product_prices?sku=in.(${encodeURIComponent(inSkus)})&handle=not.is.null&select=sku,handle,variant_id&limit=200`, env,
  ).catch(() => ({ data: [] }));
  const handles = [...new Set((pp.data || []).map(x => x.handle).filter(Boolean))];
  if (handles.length !== 1) return null;
  // ⚠️ The VARIANT is held to a stricter test than the handle, deliberately. A bare "Flare" with
  // no colour typed matches 12 rows that all sell on one page — the page is certain, the colour is
  // not. Preselecting one of the 12 would be a guess shown to a creator's audience as a choice we
  // made, which is worse than the page default. So: one candidate, one variant id, or nothing.
  const variantIds = [...new Set((pp.data || []).map(x => x.variant_id).filter(Boolean))];
  const variantId = (candidates.length === 1 && variantIds.length === 1) ? variantIds[0] : null;
  return { handle: handles[0], variantId };
}

async function resolveLinkTarget(env, engagementId, explicit) {
  if (explicit && /^https?:\/\//i.test(explicit)) return String(explicit);
  const pr = await sb(
    `/rest/v1/engagement_products?engagement_id=eq.${engagementId}&select=product_ref,product_code,product_variant,sort_order&order=sort_order.asc&limit=1`,
    env,
  ).catch(() => ({ data: [] }));
  const line = pr.data?.[0] || null;

  if (line?.product_ref) {
    // ⚠️ An explicit pick is an INSTRUCTION, not an inference, so this path keeps its original
    // first-handle-wins behaviour. Applying the stricter "all candidates must agree" rule here
    // would be a regression: the user already told us which product, and a second handle arriving
    // via a channel alias must not be allowed to veto their choice.
    const pm = await sb(
      `/rest/v1/product_master?product_code=eq.${encodeURIComponent(line.product_ref)}&select=sku&limit=1`, env,
      { headers: { 'Accept-Profile': 'public', 'Content-Profile': 'public' } },
    ).catch(() => ({ data: [] }));
    const aliases = await sb(
      `/rest/v1/sku_map?product_code=eq.${encodeURIComponent(line.product_ref)}&select=channel_sku&limit=20`, env,
      { headers: { 'Accept-Profile': 'sales', 'Content-Profile': 'sales' } },
    ).catch(() => ({ data: [] }));
    const skus = [...new Set([pm.data?.[0]?.sku, ...(aliases.data || []).map(a => a.channel_sku)]
      .map(s => (s || '').trim()).filter(Boolean))];
    if (!skus.length) return LOT_STORE_URL;
    const inList = skus.map(s => `"${s.replace(/"/g, '')}"`).join(',');
    // ⚠️ Was `select=handle&limit=1`. The extra rows are needed to pick the right VARIANT: the sku
    // list is the product's own sku PLUS its channel aliases, and first-row-wins could land on an
    // alias belonging to a sibling colour on the same page. The product's own sku is the
    // instruction; aliases are only a fallback for when product_master.sku is stale (the HP crest
    // case). First-handle-wins is unchanged — see the note above.
    const pp = await sb(
      `/rest/v1/product_prices?sku=in.(${encodeURIComponent(inList)})&handle=not.is.null&select=sku,handle,variant_id&order=sku.asc&limit=20`, env,
    ).catch(() => ({ data: [] }));
    const rows = pp.data || [];
    // ⚠️ `own` first, `rows[0]` only as the stale-sku fallback — and the query is ORDERED
    // (`order=sku.asc`) precisely so that fallback is deterministic. An unordered `limit`
    // plus a first-row pick is the defect that produced the DSO-0397 phantom manifest slots
    // the same day (PACK and RESTOCK each picked a different row from an unordered
    // `limit=1`); this is the same shape and it was caught here by hostile review, latent.
    // Measured 2026-08-31: every `product_ref` in use resolves to exactly ONE variant, so it
    // could not bite yet — the tomorrow-input is a `sku_map` alias that matches a sibling
    // colour's Shopify sku, which would make the picked colour arbitrary.
    const own = pm.data?.[0]?.sku ? rows.find(r => r.sku === pm.data[0].sku) : null;
    const row = own || rows[0];
    return productUrl(row?.handle, row?.variant_id);
  }

  // Typed, not picked — the ~98% case. Infer, but only when the destination is not in doubt.
  const candidates = await matchProductsFromText(env, line?.product_code, line?.product_variant);
  if (!candidates.length) return LOT_STORE_URL;
  const hit = await singleHandleFor(env, candidates);
  return productUrl(hit?.handle, hit?.variantId);
}

// ── Is this deal's link still pointing at this deal's product? (S342) ───────────────────────
//
// ⚠️ The staleness the mint path reports (`target_stale` below) can NEVER reach the deals that
// need it. It is computed only on a 409 from a FORCED re-mint, and the deal page hides the mint
// button the moment `utm_link` is set — so for a deal whose product changed after minting, the
// mint call is never made and the flag is never produced. Shipped S324, consumed by nobody
// (grep: one occurrence in the tree). This is the read-only version that the page CAN call:
// resolve where the deal points TODAY and hold it against what the link actually stores.
//
// Read-only ON PURPOSE. Repointing stays out of Ignition: commsops `/internal/campaign-link` is
// mint-only because a target change moves where already-printed artwork sends customers, so every
// one is audited to `comms.link_changes` against a named person and a service token has none.
// The fix path is Relay → Links; this endpoint exists so somebody KNOWS to walk it.
async function getTrackingLinkStatus(url, auth, env) {
  const id = url.searchParams.get('engagement_id');
  if (!id) return err('engagement_id required', 400);
  const er = await sb(`/rest/v1/engagements?id=eq.${id}&select=utm_link&limit=1`, env);
  const eng = er.ok ? er.data?.[0] : null;
  if (!eng) return err('not_found', 404);
  if (!eng.utm_link) return ok({ has_link: false, target_stale: false });

  // The stored link is `<link_base_url>/r/<code>`; `code` is comms.links' primary key.
  const code = String(eng.utm_link).split('/r/')[1]?.split(/[?#/]/)[0] || null;
  if (!code) return ok({ has_link: true, target_stale: false, reason: 'unparseable_link' });
  const lr = await sb(
    `/rest/v1/links?code=eq.${encodeURIComponent(code)}&select=code,target_url,active&limit=1`, env,
    { headers: { 'Accept-Profile': 'comms' } },
  ).catch(() => ({ ok: false }));
  const link = lr.ok ? lr.data?.[0] : null;
  if (!link) return ok({ has_link: true, code, target_stale: false, reason: 'link_not_found' });

  const resolved = await resolveLinkTarget(env, id).catch(() => null);
  // ⚠️ Only a REAL product URL is allowed to accuse a link of being stale. resolveLinkTarget
  // falls back to the bare store root BOTH when the deal genuinely has no product and when a
  // catalogue lookup fails, so treating that fallback as "the current target" would flag every
  // unresolvable deal — a banner is worth nothing the moment it cries wolf. Say "cannot tell"
  // instead, and let the page stay silent.
  if (!resolved || resolved === LOT_STORE_URL) {
    return ok({ has_link: true, code, link_target: link.target_url, resolved_target: null,
      target_stale: false, reason: 'target_unresolvable' });
  }
  return ok({ has_link: true, code, link_target: link.target_url, resolved_target: resolved,
    target_stale: link.target_url !== resolved });
}

async function mintTrackingLink(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.engagement_id) return err('engagement_id required', 400);
  const r = await mintTrackingLinkFor(env, body.engagement_id, {
    target: body.target_url, force: body.force === true,
  });
  if (!r.ok) return err(r.error, r.status || 400);
  return ok(r.data);
}

// Shared by the explicit action and the auto-mint on Shipped. Returns a plain result rather
// than a Response so the stage handler can ignore a failure without failing the stage move.
async function mintTrackingLinkFor(env, engagementId, { target, force } = {}) {
  if (!env.COMMSOPS || !env.COMMSOPS_LINK_TOKEN) return { ok: false, error: 'link_seam_not_configured', status: 503 };
  const er = await sb(
    `/rest/v1/engagements?id=eq.${engagementId}&select=engagement_no,utm_link,utm_source,utm_medium,utm_campaign,influencer_id&limit=1`,
    env,
  );
  const eng = er.ok ? er.data?.[0] : null;
  if (!eng) return { ok: false, error: 'not_found', status: 404 };
  // Already has one — hand it back untouched. Re-minting would strand a link the influencer
  // may already have posted, and the click history with it.
  if (eng.utm_link && !force) {
    return { ok: true, data: { url: eng.utm_link, already: true,
      utm: { utm_source: eng.utm_source, utm_medium: eng.utm_medium, utm_campaign: eng.utm_campaign } } };
  }

  const ir = eng.influencer_id
    ? await sb(`/rest/v1/influencers?id=eq.${eng.influencer_id}&select=influencer_code&limit=1`, env)
    : { data: [] };
  const code = ir.data?.[0]?.influencer_code || null;
  const utm = {
    utm_source: (code || 'ignition').toLowerCase(),
    utm_medium: 'influencer',
    utm_campaign: String(eng.engagement_no || '').toLowerCase(),
  };
  const targetUrl = await resolveLinkTarget(env, engagementId, target);
  let slug = trackingSlug(code, eng.engagement_no);

  // The title is the ONLY deal-specific thing on the stored link, which is what makes it the
  // right identity test on a 409 — see below.
  const title = `Ignition ${eng.engagement_no}`;
  const call = (s) => env.COMMSOPS.fetch(new Request('https://commsops/internal/campaign-link', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.COMMSOPS_LINK_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: s, target_url: targetUrl, title, utm }),
  })).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }));

  let res = await call(slug);
  // 409 = the slug is taken. The seam deliberately does NOT auto-reuse: adopting a stranger's
  // link would point this influencer's traffic at another campaign AND credit their clicks to
  // it. Only adopt when the existing link is provably THIS DEAL's — the retry-after-timeout
  // case. Otherwise suffix and try once more rather than fail the deal.
  //
  // ⚠️ Identity is the TITLE, not the target. Comparing targets looks equivalent and is not:
  // every deal with no `product_ref` targets the bare store root, so a target match would be
  // true for two *unrelated* deals and would silently merge their links and their clicks —
  // reintroducing precisely the failure the seam's 409 exists to prevent. `product_ref` is
  // null on every pre-S313 deal, so that is the common case, not the exotic one.
  let staleTarget = null;
  if (res.status === 409) {
    const existing = res.body?.existing;
    if (existing && existing.title === title) {
      // ⚠️ Adopting our own link does NOT repoint it, and `force` cannot make it. The commsops
      // seam is mint-only by design (repointing a campaign link is audited to a named person and
      // a service token has none), so a deal whose product changed AFTER the link was minted keeps
      // the old destination and every path here reports success. Say so instead of lying: Nandu
      // hit exactly this on IGN-2026-00550 (2026-08-31) — the link was minted against the Ghost
      // remote, she corrected the product, and nothing she could do in Ignition moved the link.
      // Repointing is Relay → Links (JWT + comms.link_changes).
      if (existing.target_url && existing.target_url !== targetUrl) staleTarget = existing.target_url;
      res = { status: 200, body: { ok: true, data: { link: existing, url: res.body.url } } };
    } else {
      slug = `${slug.slice(0, 27)}-${Math.random().toString(36).slice(2, 5)}`;
      res = await call(slug);
    }
  }
  if (res.status !== 200 || !res.body?.data?.url) {
    return { ok: false, error: `link_mint_failed: ${res.body?.error || res.status}`, status: 502 };
  }

  const url = res.body.data.url;
  await sb(`/rest/v1/engagements?id=eq.${engagementId}`, env, {
    method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({ utm_link: url, ...utm, updated_at: nowIso() }),
  });
  return { ok: true, data: { url, slug, target_url: targetUrl, utm, already: false,
    ...(staleTarget ? { target_stale: true, current_target: staleTarget } : {}) } };
}

// ── Batch B ① — deal brief + post reminder, DRAFT AND INERT (S313) ──────────────────────────
//
// ⚠️ NOTHING HERE SENDS ANYTHING, and that is the decision, not an omission (Afshaan
// 2026-08-26: "build a draft first, ship inert, Reann edits real content before anything is
// armed"). These endpoints COMPOSE and RETURN text. Wiring them to commsops `/send` is a
// separate phase with two hard prerequisites that do not exist yet:
//   · `/send` resolves a Relay TEMPLATE (`template_not_found` without one) — the brief has to
//     become a real template, authored by whoever owns the words;
//   · influencers are not `comms.profiles` yet, so there is no profile/consent record to send
//     against, and the send gate is what makes suppressions work.
// Building the send first would mean inventing the copy AND the consent story. Compose first,
// let Reann edit, then arm.
//
// Wording note: this draft is deliberately plain and slightly under-written. It is meant to be
// argued with, not shipped as-is.
function composeDealBrief(eng, products, coupons) {
  const inf = eng.influencer || {};
  const who = inf.person_name || inf.channel_name || 'there';
  const items = (products || [])
    .map(p => `· ${[p.product_code, p.product_variant].filter(Boolean).join(' ')}${Number(p.quantity) > 1 ? ` ×${p.quantity}` : ''}`)
    .join('\n') || '· (product to be confirmed)';
  const code = (coupons || []).find(c => c.kind === 'affiliate' && c.status === 'active');
  const lines = [
    `Hi ${who},`,
    '',
    `Here are the details for your collaboration with Legend of Toys (${eng.engagement_no}).`,
    '',
    'What we are sending you:',
    items,
    '',
  ];
  if (eng.expected_post_date) lines.push(`When we would like it live: ${eng.expected_post_date}`, '');
  if (eng.utm_link) {
    lines.push(
      'Your tracking link — please use this one, it is how your results are credited to you:',
      eng.utm_link, '',
    );
  }
  if (code) {
    lines.push(`Your discount code for your audience: ${code.code}`, '');
  }
  // The checklist only asks for things this deal actually has. Telling a creator to "put the
  // tracking link in your caption" on a deal with no link is an instruction they cannot follow,
  // and it is the kind of detail that makes a brief look automated.
  lines.push('A few things to include:');
  if (code) lines.push('· mention the discount code out loud, not only on screen');
  lines.push('· show the car actually moving for 15–20 seconds');
  if (eng.utm_link) lines.push('· put the tracking link in your caption or bio');
  lines.push(
    '',
    'Anything unclear, just reply to this email.',
    '',
    'Thanks,',
    'Legend of Toys',
  );
  // Gaps worth seeing BEFORE the thing is sent, rather than discovering them in a creator's inbox.
  const warnings = [];
  if (!inf.email) warnings.push('This influencer has no email address on record — there is nowhere to send this.');
  if (!eng.utm_link) warnings.push('No tracking link on this deal yet — the brief will not carry one.');
  if (!code) warnings.push('No active affiliate code on this deal — the brief will not carry one.');
  if (!eng.expected_post_date) warnings.push('No expected post date set, so the brief does not ask for one.');
  return {
    to: inf.email || null,
    subject: `Your Legend of Toys collaboration — ${eng.engagement_no}`,
    body: lines.join('\n'),
    warnings,
  };
}

async function getDealBriefPreview(url, auth, env) {
  const id = url.searchParams.get('engagement_id');
  if (!id) return err('engagement_id required', 400);
  const r = await sb(`/rest/v1/engagements?id=eq.${id}&select=*,influencer:influencer_id(*)&limit=1`, env);
  const eng = r.ok ? r.data?.[0] : null;
  if (!eng) return err('not_found', 404);
  const [pr, cr] = await Promise.all([
    sb(`/rest/v1/engagement_products?engagement_id=eq.${id}&select=*&order=sort_order.asc`, env),
    sb(`/rest/v1/coupon_codes?engagement_id=eq.${id}&select=code,kind,status`, env),
  ]);
  const draft = composeDealBrief(eng, pr.data || [], cr.data || []);
  // `armed:false` is load-bearing in the response: the UI must be able to say plainly that this
  // is a preview of something that cannot currently be sent, rather than implying a Send button
  // is one click away.
  return ok({ ...draft, armed: false });
}

// Who would be nudged today, and why. Merges B5 (10 days after delivery, no post) with Reann's
// separate "(3) Delhivery status → follow-up reminder" request — they are the same nudge with
// two triggers, and building them separately would let both fire at one creator.
const CHASE_SCAN_MAX = 500;

async function getPostReminderDue(url, auth, env) {
  const days = Math.max(Number(url.searchParams.get('days') || 10), 1);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  // Deliberately narrow: a nudge is only fair if we know they HAVE the goods, they have not
  // posted, and nobody has already written the deal off.
  const r = await sb(
    '/rest/v1/engagements?select=id,engagement_no,stage,post_date,delivered_date,shipping_date,utm_link,gifted_no_post,'
    + 'influencer:influencer_id(influencer_code,channel_name,person_name,email,do_not_ship)'
    + '&post_date=is.null&gifted_no_post=not.is.true'
    + '&stage=in.(shipped,delivered,scheduled,draft,posting,delayed)'
    + `&limit=${CHASE_SCAN_MAX}`,
    env,
    // Same reason as the broken-link scan: a chasing list that quietly stops at the cap reads as
    // "fewer creators are overdue", which is the opposite of what it is for. 139 candidates today.
    { prefer: 'return=representation,count=exact' },
  );
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);
  const scanTotal = rangeTotal(r.range);
  if (scanTotal != null && scanTotal > CHASE_SCAN_MAX) {
    console.error(`[getPostReminderDue] scan truncated: ${scanTotal} candidates > ${CHASE_SCAN_MAX} — the chasing list is INCOMPLETE`);
  }
  const rows = r.data || [];

  // ⚠️ `delivered_date` / `shipping_date` are NULL on EVERY engagement (346 of 346, measured
  // 2026-08-26) — nobody has ever filled them in. The B5 spec dates the nudge from those two
  // columns, so as specified this reminder could never fire: it would run daily, find nothing,
  // and look perfectly healthy while 139 deals sat unposted. Same silent-success shape as the
  // price sweep that failed for six weeks.
  // So fall back to WHEN THE DEAL ENTERED shipped/delivered, which `engagement_history` records
  // for all 139 of them. One batched read — never a query per row.
  const needAnchor = rows.filter(e => !e.delivered_date && !e.shipping_date).map(e => e.id);
  const entered = new Map();
  if (needAnchor.length) {
    const hr = await sb(
      `/rest/v1/engagement_history?engagement_id=in.(${needAnchor.join(',')})`
      + '&stage_to=in.(shipped,delivered)&select=engagement_id,created_at&order=created_at.desc&limit=2000',
      env,
    );
    // Keep the LATEST transition per deal: a deal that went shipped → delivered should age from
    // the delivery, and one bounced back and re-shipped should age from the re-ship, not the first.
    for (const h of (hr.data || [])) if (!entered.has(h.engagement_id)) entered.set(h.engagement_id, h.created_at);
  }

  const due = rows
    .map(e => {
      if (e.influencer?.do_not_ship) return null;
      const explicit = e.delivered_date || e.shipping_date || null;
      const anchorRaw = explicit || entered.get(e.id) || null;
      if (!anchorRaw) return null;
      const anchorDay = String(anchorRaw).slice(0, 10);
      if (anchorDay > cutoff) return null;
      return {
        engagement_no: e.engagement_no, stage: e.stage,
        influencer: e.influencer?.channel_name || e.influencer?.person_name || e.influencer?.influencer_code,
        email: e.influencer?.email || null,
        trigger: e.delivered_date ? 'delivered'
          : e.shipping_date ? 'shipped'
            : `reached ${e.stage} (no delivery date recorded)`,
        days_since: Math.floor((Date.now() - new Date(anchorRaw).getTime()) / 86400000),
        has_tracking_link: !!e.utm_link,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.days_since - a.days_since);
  return ok({
    days, due, count: due.length,
    unreachable: due.filter(d => !d.email).length,
    armed: false,
  });
}

// ── Broken profile links (S313, Reann approved 2026-08-26) ──────────────────────────────────
//
// `channel_link` has been collecting BROWSER TAB TITLES pasted instead of URLs — "(9) Instagram",
// "(14) Tamu Toys - YouTube". They break link matching and make people look like duplicates. The
// source forms now reject them, so the set is closed; this is the worklist for clearing what is
// already stored.
//
// ⚠️ A suggestion is NEVER auto-applied, and that restraint is the point. `instagram.com/Beebom`
// or `/Cassy` may well be somebody else — in an influencer CRM a link pointing at a stranger is
// worse than a blank one. The person confirms; the machine only proposes.
// ⚠️ Only INSTAGRAM handles are derivable. A YouTube tab title carries the channel's display name
// ("Tamu Toys"), not its handle, and `youtube.com/@TamuToys` is a guess with nothing behind it —
// so those get no suggestion and are left for a human.
const HANDLE_RE = /^[A-Za-z0-9._]{2,30}$/;

function suggestChannelLink(inf) {
  const platforms = Array.isArray(inf.channel_platforms) ? inf.channel_platforms : [];
  const isIg = inf.channel_platform === 'instagram' || platforms.includes('instagram');
  const name = String(inf.channel_name || '').trim();
  if (!isIg || !HANDLE_RE.test(name)) return null;
  // A leading @ is how people write handles; the URL does not take one.
  return `https://instagram.com/${name.replace(/^@+/, '')}`;
}

async function getBrokenChannelLinks(url, auth, env) {
  // ⚠️ The "is it a URL" test is applied HERE, in code, not as three stacked negated PostgREST
  // filters. Chaining `not.is.null` + two `not.like.*…*` on the same column returned an empty set
  // rather than an error — a filter that silently matches nothing looks exactly like clean data,
  // which is the failure this codebase keeps paying for. One coarse filter that is obviously
  // right, then the precise predicate in JS where it can be read and reasoned about.
  // ⚠️ count=exact + the overflow log below, because a bare `limit` here would be the very
  // defect this panel exists to clear: 1,480 influencers today against a 2,000 ceiling, and a
  // truncated worklist reads as "fewer broken links" rather than as a truncated worklist.
  const SCAN_MAX = 2000;
  const r = await sb(
    '/rest/v1/influencers?select=id,influencer_code,channel_name,person_name,channel_platform,channel_platforms,channel_link'
    + `&channel_link=not.is.null&order=influencer_code&limit=${SCAN_MAX}`,
    env,
    { prefer: 'return=representation,count=exact' },
  );
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);
  const scanTotal = rangeTotal(r.range);
  if (scanTotal != null && scanTotal > SCAN_MAX) {
    console.error(`[getBrokenChannelLinks] scan truncated: ${scanTotal} influencers with a link > ${SCAN_MAX} — the list is INCOMPLETE`);
  }
  const isUrl = (v) => /https?:\/\//i.test(v) || /\.[a-z]{2,}\//i.test(v);
  const rows = (r.data || []).filter(i => !isUrl(String(i.channel_link || ''))).map(i => {
    const current = String(i.channel_link || '');
    return {
      id: i.id,
      influencer_code: i.influencer_code,
      channel_name: i.channel_name,
      person_name: i.person_name,
      platform: i.channel_platform || (Array.isArray(i.channel_platforms) ? i.channel_platforms[0] : null),
      current,
      // An empty string is not a pasted tab title — it is simply blank, and wants clearing to
      // NULL rather than "fixing". Kept visible so the count in the UI matches the pass condition.
      blank: current.trim() === '',
      suggested: suggestChannelLink(i),
    };
  });
  return ok({
    rows,
    count: rows.length,
    suggestable: rows.filter(x => x.suggested).length,
    manual: rows.filter(x => !x.suggested && !x.blank).length,
    blank: rows.filter(x => x.blank).length,
  });
}

async function getCouponsForEngagement(url, auth, env) {
  const eid = url.searchParams.get('engagement_id');
  if (!eid) return err('engagement_id required', 400);
  const r = await sb(`/rest/v1/coupon_codes?engagement_id=eq.${eid}&select=*&order=created_at.desc`, env);
  return ok({ coupons: r.data || [] });
}

// "How much business has this creator driven" = Σ across their affiliate codes.
async function getInfluencerAttribution(url, auth, env) {
  const iid = url.searchParams.get('influencer_id');
  if (!iid) return err('influencer_id required', 400);
  const r = await sb(`/rest/v1/coupon_codes?influencer_id=eq.${iid}&kind=eq.affiliate&select=attributed_revenue_net,commission_accrued,redemptions`, env);
  const rows = r.data || [];
  return ok({
    net_revenue: rows.reduce((s, x) => s + Number(x.attributed_revenue_net || 0), 0),
    commission: rows.reduce((s, x) => s + Number(x.commission_accrued || 0), 0),
    redemptions: rows.reduce((s, x) => s + Number(x.redemptions || 0), 0),
    codes: rows.length,
  });
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

  // Open the ticket via the token-authed Ignition bridge — NOT the user's JWT.
  // The influencer-team user has no cs_ticket_manage permission of their own, so
  // forwarding their bearer to csops createTicket 403s ("missing permission:
  // cs_ticket_manage"). The bridge runs a synth-auth (cs_ticket_manage) and lands
  // the ticket Unassigned for CS to triage. Mirrors the Connects bridge (S177).
  const ticketPayload = {
    intake_channel: 'sheet', // closest existing enum value; future: add 'ignition'
    customer_name: inf.person_name || inf.channel_name || 'Influencer',
    customer_phone: inf.contact_number || null,
    customer_email: inf.email || null,
    platform: 'website',
    external_order_id: eng.shipping_order_id || null,
    issue_description: body.issue_description,
    disposition: body.disposition || 'replacement',
  };
  if (body.issue_category) ticketPayload.issue_category = body.issue_category;
  if (body.issue_subcategory) ticketPayload.issue_subcategory = body.issue_subcategory;

  const br = await csopsBridge(env, 'createTicketFromIgnition', {
    ticket: ticketPayload,
    actor: { id: auth.userId, name: auth.fullName || auth.name || null, email: auth.email || null },
  });
  if (!br.ok) return err(`csops_error: ${JSON.stringify(br.raw?.error || br.raw)}`, br.status || 502);
  const ticket_no = br.data?.ticket_no;
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

// A campaign is now a MARKETING campaign (Reann #3, S273) — it spans influencers and carries a
// budget. `influencer_id` and `video_count` are legacy columns from the dormant per-influencer
// construct: both are nullable and left NULL, video count being DERIVED from linked deals.
async function createCampaign(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  const name = String(body.name || '').trim();
  if (!name) return err('name required', 400);
  const budget = (body.budget_amount != null && body.budget_amount !== '') ? Number(body.budget_amount) : null;
  if (budget != null && (isNaN(budget) || budget < 0)) return err('budget_amount must be a non-negative number', 400);
  // Case-insensitive dedupe, matching campaigns_name_ci_key — a friendly 409 beats a raw 23505.
  const dupe = await sb(`/rest/v1/campaigns?name=ilike.${encodeURIComponent(name)}&select=id,name&limit=1`, env);
  if (dupe.ok && dupe.data?.[0]) return err(`a campaign named "${dupe.data[0].name}" already exists`, 409);
  const yyyy = String(new Date().getUTCFullYear());
  const code = `CMP-${yyyy}-${String(Date.now()).slice(-6)}`;
  const r = await sb(`/rest/v1/campaigns`, env, {
    method: 'POST',
    body: JSON.stringify([{
      campaign_no: code,
      name,
      budget_amount: budget,
      influencer_id: body.influencer_id || null,
      video_count: null,
      agreed_total: body.agreed_total || null,
      status: 'active',
    }]),
  });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

const CAMPAIGN_FIELDS = [
  'name', 'budget_amount', 'video_count', 'agreed_total', 'status',
  // Brief upload (Reann #8, 2026-08-27). Written by the client after it has uploaded to the
  // signed URL — the object is already in the private bucket by then, so these three only
  // record where it landed.
  'brief_path', 'brief_name', 'brief_mime', 'brief_uploaded_at',
];

const CAMPAIGN_BRIEF_BUCKET = 'ignition-campaign-briefs';

/**
 * Mint a signed upload token for a campaign brief (Reann #8). Same shape as
 * createPaymentProofUploadUrl: the browser never sees a service key, only a one-object token.
 */
async function createCampaignBriefUploadUrl(body, auth, env) {
  const gate = requirePerm('ignition_manage', auth); if (gate) return gate;
  if (!body.campaign_id) return err('campaign_id required', 400);
  if (!body.file_name) return err('file_name required', 400);
  const path = `${safeSeg(body.campaign_id)}/${Date.now()}_${safeSeg(body.file_name)}`;
  const sr = await storageFetch(`/object/upload/sign/${CAMPAIGN_BRIEF_BUCKET}/${path}`, env, { method: 'POST' });
  if (!sr.ok || !sr.data?.url) return err(`sign_failed: ${JSON.stringify(sr.data)}`, 502);
  const tokenMatch = String(sr.data.url).match(/token=([^&]+)/);
  return ok({ storage_path: path, token: tokenMatch ? decodeURIComponent(tokenMatch[1]) : null });
}

/** Short-lived signed URL for reading a campaign brief. The bucket is private. */
async function getCampaignBriefUrl(url, auth, env) {
  const gate = requirePerm('ignition_view', auth); if (gate) return gate;
  const id = url.searchParams.get('id');
  if (!id) return err('id required', 400);
  const cr = await sb(`/rest/v1/campaigns?id=eq.${id}&select=brief_path,brief_name,brief_mime&limit=1`, env);
  const c = cr.data?.[0];
  if (!c || !c.brief_path) return err('no_brief', 404);
  const seg = String(c.brief_path).split('/').map(encodeURIComponent).join('/');
  const sr = await storageFetch(`/object/sign/${CAMPAIGN_BRIEF_BUCKET}/${seg}`, env, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 120 }),
  });
  if (!sr.ok || !sr.data?.signedURL) return err(`sign_failed: ${JSON.stringify(sr.data)}`, 502);
  return ok({ url: `${env.SUPABASE_URL}/storage/v1${sr.data.signedURL}`, file_name: c.brief_name, mime_type: c.brief_mime });
}

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
// ── Reann #8 — month drill-down: the itemised rows BEHIND a month's totals ───────────────────
// getMonthlyTargets returns aggregates only; this returns the individual spends and the individual
// posts that compose them, so a month tile can expand into "which influencer, which deal, how much".
// Deliberately reuses getMonthlyTargets' EXACT attribution rules so the drill-down always sums to
// the tile above it: views attribute to post_date's month, spend to post_date falling back to
// created_at. Diverging here would produce a breakdown that silently disagrees with the total.
async function getMonthlyBreakdown(url, auth, env) {
  const month = String(url.searchParams.get('month') || '').trim();
  // 'unallocated' (Reann #1) is a first-class bucket, not a month: deals whose video has not
  // posted, so their spend belongs to no month yet. Same rule as getMonthlyTargets — if you
  // change one, change the other, or the drill-down stops summing to the tile above it.
  const isUnalloc = month === 'unallocated';
  if (!isUnalloc && !/^\d{4}-\d{2}$/.test(month)) return err('month must be YYYY-MM or "unallocated"', 400);
  const num = v => (v == null || isNaN(Number(v)) ? 0 : Number(v));
  const spendOf = e => (e.total_cost != null ? num(e.total_cost)
    : num(e.payment_amount) + num(e.ad_spend) + num(e.commission_amount));

  const sel = 'id,engagement_no,post_date,created_at,views,orders,conversions_value,campaign_tag,'
    + 'total_cost,payment_amount,ad_spend,commission_amount,engagement_type,stage,'
    + 'influencer:influencers(id,influencer_code,channel_name,person_name,channel_link,channel_platform)';
  // Must match getMonthlyTargets' exclusion or the drill-down stops summing to the tile above it.
  const r = await sb(`/rest/v1/engagements?${EXCLUDE_NON_SPEND}&select=${encodeURIComponent(sel)}&limit=5000`, env);
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);

  const spend = [], views = [], conversions = [];
  for (const e of (r.data || [])) {
    const postMonth  = (e.post_date || '').slice(0, 7);
    const spendMonth = (e.post_date || '').slice(0, 7);   // no created_at fallback — see the unallocated bucket
    const who = e.influencer || {};
    const base = {
      engagement_id: e.id, engagement_no: e.engagement_no, stage: e.stage,
      engagement_type: e.engagement_type, campaign_tag: e.campaign_tag || null,
      influencer_id: who.id || null, influencer_code: who.influencer_code || null,
      influencer_name: who.channel_name || who.person_name || null,
      channel_link: who.channel_link || null, platform: who.channel_platform || null,
      post_date: e.post_date || null,
    };
    if (isUnalloc) {
      // Unposted only. Everything else in this loop is month-scoped and stays skipped.
      if (!e.post_date) {
        const amt = spendOf(e);
        if (amt > 0) spend.push({ ...base, amount: Math.round(amt), dated_by: 'unallocated' });
      }
      continue;
    }
    if (e.post_date && spendMonth === month) {
      const amt = spendOf(e);
      if (amt > 0) spend.push({ ...base, amount: Math.round(amt), dated_by: 'post_date' });
    }
    if (postMonth === month) {
      if (num(e.views) > 0) views.push({ ...base, views: num(e.views) });
      // Reann #9 — conversions itemised. Counted on the POST month so it lines up with views.
      if (num(e.orders) > 0 || num(e.conversions_value) > 0) {
        conversions.push({ ...base, orders: num(e.orders), order_value: num(e.conversions_value) });
      }
    }
  }
  const sum = (a, k) => a.reduce((t, x) => t + num(x[k]), 0);
  spend.sort((a, b) => b.amount - a.amount);
  views.sort((a, b) => b.views - a.views);
  conversions.sort((a, b) => (b.order_value - a.order_value) || (b.orders - a.orders));
  return ok({
    month,
    spend, views, conversions,
    totals: {
      spend: sum(spend, 'amount'), spend_lines: spend.length,
      views: sum(views, 'views'), view_lines: views.length,
      orders: sum(conversions, 'orders'),
      order_value: Math.round(sum(conversions, 'order_value')),
      conversion_lines: conversions.length,
    },
  });
}

// ── Reann #7 — campaign-level performance, grouped by the campaign_tag on each deal ──────────
// Untagged deals are returned as their own bucket rather than dropped: a summary that silently
// omits half the spend is worse than one that shows an "Untagged" row you can act on.
async function getCampaignSummary(url, auth, env) {
  const num = v => (v == null || isNaN(Number(v)) ? 0 : Number(v));
  const spendOf = e => (e.total_cost != null ? num(e.total_cost)
    : num(e.payment_amount) + num(e.ad_spend) + num(e.commission_amount));
  const from = String(url.searchParams.get('from') || '').trim();
  const to   = String(url.searchParams.get('to') || '').trim();
  const sel = 'id,campaign_tag,post_date,created_at,views,likes,comments,shares,saves,reposts,'
    + 'orders,conversions_value,total_cost,payment_amount,ad_spend,commission_amount,'
    + 'follower_count_at_post,stage,influencer_id';
  const r = await sb(`/rest/v1/engagements?${EXCLUDE_NON_SPEND}&select=${sel}&limit=5000`, env);
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);

  const g = {};
  for (const e of (r.data || [])) {
    const d = e.post_date || (e.created_at || '').slice(0, 10);
    if (from && d && d < from) continue;
    if (to && d && d > to) continue;
    const key = e.campaign_tag || '';
    const b = g[key] || (g[key] = {
      campaign_tag: e.campaign_tag || null, deals: 0, live_deals: 0, influencers: new Set(),
      views: 0, likes: 0, comments: 0, shares: 0, saves: 0, reposts: 0,
      orders: 0, order_value: 0, spend: 0, reach_at_post: 0,
    });
    b.deals++; if (e.stage === 'live') b.live_deals++;
    if (e.influencer_id) b.influencers.add(e.influencer_id);
    for (const k of ['views','likes','comments','shares','saves','reposts','orders']) b[k] += num(e[k]);
    b.order_value += num(e.conversions_value);
    b.spend += spendOf(e);
    b.reach_at_post += num(e.follower_count_at_post);
  }
  const rows = Object.values(g).map(b => ({
    ...b,
    influencers: b.influencers.size,
    spend: Math.round(b.spend), order_value: Math.round(b.order_value),
    // CPM and cost-per-view only mean anything with views; null beats a divide-by-zero Infinity.
    cpm: b.views > 0 ? Math.round(b.spend / b.views * 1000 * 100) / 100 : null,
    roas: b.spend > 0 ? Math.round(b.order_value / b.spend * 100) / 100 : null,
    // Engagement rate over the summed at-post follower base — only where it was captured.
    engagement_rate: b.reach_at_post > 0
      ? Math.round((b.likes + b.comments + b.shares + b.saves + b.reposts) / b.reach_at_post * 10000) / 100
      : null,
  })).sort((a, b) => b.spend - a.spend);
  return ok({ campaigns: rows, untagged_deals: (g[''] ? g[''].deals : 0) });
}

async function getMonthlyTargets(url, auth, env) {
  const tr = await sb(`/rest/v1/monthly_targets?select=*&order=month.desc`, env);
  if (!tr.ok) return err(`db_error: ${JSON.stringify(tr.data)}`, 500);
  const targets = tr.data || [];

  const num = v => (v == null || isNaN(Number(v)) ? 0 : Number(v));
  const spendOf = e => (e.total_cost != null ? num(e.total_cost) : num(e.payment_amount) + num(e.ad_spend) + num(e.commission_amount));
  const er = await sb(`/rest/v1/engagements?${EXCLUDE_NON_SPEND}&select=post_date,created_at,views,total_cost,payment_amount,ad_spend,commission_amount&limit=5000`, env);
  const actMap = {};
  let unallocSpend = 0, unallocDeals = 0;
  const bucket = (m) => (actMap[m] || (actMap[m] = { actual_views: 0, actual_spend: 0 }));
  if (er.ok) {
    for (const e of (er.data || [])) {
      // Views attribute to the month the video actually POSTED (S214 6-pt ②) — post_date
      // is now mandatory at go-live, so a deal without one hasn't posted and its views
      // (which should be 0) don't count toward any month's target.
      const postMonth = (e.post_date || '').slice(0, 7);
      if (/^\d{4}-\d{2}$/.test(postMonth)) bucket(postMonth).actual_views += num(e.views);
      // ⭐ UNALLOCATED SPEND (Reann #1, S273 — the column deferred in S214 is now built).
      // Spend on a deal whose video has NOT posted cannot honestly belong to any month: the
      // product shipped, the money is committed, but the month it will land in is unknown.
      // It used to fall back to created_at, which quietly charged it to the month the deal was
      // RAISED — inflating that month and then never correcting when the video posted later.
      // ⚠️ This LOWERS actual_spend for months carrying not-yet-posted deals. That is the fix,
      // not a regression: the money moves to the unallocated bucket, it is not lost. Views were
      // already post_date-only, so only spend changes.
      if (e.post_date) {
        const spendMonth = e.post_date.slice(0, 7);
        if (/^\d{4}-\d{2}$/.test(spendMonth)) bucket(spendMonth).actual_spend += spendOf(e);
      } else {
        const amt = spendOf(e);
        if (amt > 0) { unallocSpend += amt; unallocDeals++; }
      }
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
  // Reann #1 — surfaced as its own bucket, never folded into a month. Drill down with
  // getMonthlyBreakdown?month=unallocated, which applies the identical no-post_date rule.
  return ok({ months: rows, unallocated: { spend: Math.round(unallocSpend), deals: unallocDeals } });
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
    const req = new Request(`${base}/bridge/ignition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ignition-Bridge-Token': env.IGNITION_BRIDGE_TOKEN || '' },
      body: JSON.stringify({ action, ...payload }),
    });
    // Worker-to-worker MUST use the service binding — a public workers.dev fetch is
    // blocked by Cloudflare (error 1042, same-zone). Fall back to fetch only if unbound.
    const r = env.CSOPS ? await env.CSOPS.fetch(req) : await fetch(req);
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
      thread_id: t.id, channel: t.channel || null,
      // Seed from real message activity, not a hardcoded 'new'. A thread that has
      // already been replied to has plainly been worked, and hardcoding 'new' here
      // is why 897 of 901 rows sat at 'new' while 706 threads had real replies.
      status: t.has_reply === true ? 'working' : 'new',
      transferred_at: t.ignition_transferred_at || null,
    }));
    const ins = await sb(`/rest/v1/connects`, env, {
      method: 'POST', prefer: 'resolution=ignore-duplicates,return=representation',
      body: JSON.stringify(rows),
    });
    for (const row of (ins.ok ? ins.data || [] : [])) byThread[row.thread_id] = row;
  }

  // Converge rows that predate the seeding above: a stored 'new' whose thread has a
  // reply becomes 'working'. `status=eq.new` is on the WRITE filter, not just the JS
  // side, so this can never downgrade a human-set 'promoted'/'closed'/'working'.
  // `has_reply === true` is strict: null means csops could not tell us, and unknown
  // must leave the stored value alone.
  const stale = threads
    .filter(t => t.has_reply === true && byThread[t.id] && byThread[t.id].status === 'new')
    .map(t => t.id);
  if (stale.length) {
    const up = await sb(`/rest/v1/connects?thread_id=in.(${stale.join(',')})&status=eq.new`, env, {
      method: 'PATCH', body: JSON.stringify({ status: 'working', updated_at: new Date().toISOString() }),
    });
    if (up.ok) for (const id of stale) byThread[id].status = 'working';
  }

  // S351 (2026-09-04): a CLOSED connect whose customer writes again must come back as 'new'.
  // Closing is overlay-only (setConnectStatus patches this table and nothing else), csops never
  // writes here, and the converge above only touches 'new' — so before this, fresh inbound on a
  // closed connect stayed 'closed' with no signal at all. 470 stale connects were bulk-closed on
  // 2026-09-04 with a 7-day-quiet cut precisely because of that gap. The tell is the thread's
  // `last_inbound_at` (from the csops bridge, select=*) being LATER than the close (`updated_at`,
  // which every close path stamps). `status=eq.closed` is on the WRITE filter, so a row a human
  // has meanwhile moved to working/promoted is left alone. Strict on both timestamps: an unknown
  // must not re-open anything.
  const reopen = threads
    .filter(t => {
      const row = byThread[t.id];
      if (!row || row.status !== 'closed' || !t.last_inbound_at || !row.updated_at) return false;
      const inbound = Date.parse(t.last_inbound_at), closed = Date.parse(row.updated_at);
      return Number.isFinite(inbound) && Number.isFinite(closed) && inbound > closed;
    })
    .map(t => t.id);
  if (reopen.length) {
    const up = await sb(`/rest/v1/connects?thread_id=in.(${reopen.join(',')})&status=eq.closed`, env, {
      method: 'PATCH', body: JSON.stringify({ status: 'new', updated_at: new Date().toISOString() }),
    });
    if (up.ok) for (const id of reopen) byThread[id].status = 'new';
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

// Return a connect back to Pitstop CS (reclaim a mis-transfer). Flips the thread's
// ignition_connect off (→ reappears in the CS inbox) via the bridge, then drops the
// local overlay row so it leaves Connects.
async function returnConnect(body, auth, env) {
  const gate = requirePerm('ignition_connects', auth); if (gate) return gate;
  if (!body.thread_id) return err('thread_id required', 400);
  const br = await csopsBridge(env, 'returnConnectToPitstop', {
    thread_id: body.thread_id,
    actor: { id: auth.userId, name: auth.fullName || auth.email },
  });
  if (!br.ok) return err(`csops_bridge_error: ${JSON.stringify(br.raw?.error || br.raw)}`, br.status || 502);
  await sb(`/rest/v1/connects?thread_id=eq.${encodeURIComponent(body.thread_id)}`, env, {
    method: 'DELETE', prefer: 'return=minimal',
  }).catch(() => {});
  return ok({ returned: true });
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
// ACCESS CONTROL (Ignition-only permission layer, 2026-07-20)
// Governance is gated on `ignition_admin` — a key that only exists in this layer,
// so holding the company-wide `admin` role no longer confers it.
// ────────────────────────────────────────────────────────────────────────────

// Roster + the assignable role presets. Read-gated on ignition_admin (not ignition_view):
// who has access to what is itself sensitive.
async function getIgnitionAccess(_url, auth, env) {
  const gate = requirePerm('ignition_admin', auth);
  if (gate) return gate;
  const rr = await sbStore(`/rest/v1/ignition_roles?select=role_key,label,description,permissions,is_system&order=role_key.asc`, env);
  const ar = await sbStore(`/rest/v1/ignition_user_roles?select=user_id,role_key,active,assigned_at&order=assigned_at.desc`, env);
  const assignments = ar.ok ? ar.data || [] : [];
  let users = [];
  if (assignments.length) {
    const ids = assignments.map(a => a.user_id);
    const ur = await sbStore(`/rest/v1/users_profile?id=in.(${ids.join(',')})&select=id,full_name,role,active`, env);
    const byId = Object.fromEntries((ur.ok ? ur.data || [] : []).map(u => [u.id, u]));
    users = assignments.map(a => ({
      ...a,
      full_name: byId[a.user_id]?.full_name || null,
      global_role: byId[a.user_id]?.role || null,   // shown for context; never the gate
      profile_active: byId[a.user_id]?.active ?? null,
    }));
  }
  return ok({ roles: rr.ok ? rr.data || [] : [], users });
}

// People who could be granted access — every active profile, so a person's other job
// (CS agent, social, production) no longer disqualifies them from Ignition.
async function getGrantableUsers(_url, auth, env) {
  const gate = requirePerm('ignition_admin', auth);
  if (gate) return gate;
  const ur = await sbStore(`/rest/v1/users_profile?active=eq.true&select=id,full_name,role&order=full_name.asc`, env);
  return ok({ users: (ur.ok ? ur.data || [] : []).filter(u => u.full_name) });
}

async function grantIgnitionAccess(body, auth, env) {
  const gate = requirePerm('ignition_admin', auth);
  if (gate) return gate;
  const { user_id, role_key } = body?.data || {};
  if (!user_id || !role_key) return err('user_id and role_key required', 400);
  const rr = await sbStore(`/rest/v1/ignition_roles?role_key=eq.${encodeURIComponent(role_key)}&select=role_key&limit=1`, env);
  if (!rr.ok || !rr.data?.[0]) return err('unknown_role_key', 400);
  const up = await sbStore(`/rest/v1/users_profile?id=eq.${user_id}&select=id,active&limit=1`, env);
  if (!up.ok || !up.data?.[0]) return err('user_not_found', 404);
  if (!up.data[0].active) return err('user_is_deactivated', 400);
  const res = await sbStore(`/rest/v1/ignition_user_roles`, env, {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: JSON.stringify([{
      user_id, role_key, active: true,
      assigned_by: auth.userId, assigned_at: nowIso(),
      disabled_at: null, disabled_by: null,
    }]),
  });
  if (!res.ok) return err(`db_error: ${JSON.stringify(res.data)}`, 400);
  return ok({ user_id, role_key });
}

// Ignition-scoped kill switch. Revoking Ignition NEVER touches users_profile — the
// person keeps their other systems (this is the whole point of the separate layer).
async function setIgnitionUserActive(body, auth, env) {
  const gate = requirePerm('ignition_admin', auth);
  if (gate) return gate;
  const { user_id, active } = body?.data || {};
  if (!user_id || typeof active !== 'boolean') return err('user_id and active(boolean) required', 400);
  if (user_id === auth.userId && !active) return err('You cannot revoke your own Ignition access', 400);
  const patch = active
    ? { active: true,  disabled_at: null,      disabled_by: null }
    : { active: false, disabled_at: nowIso(),  disabled_by: auth.userId };
  const res = await sbStore(`/rest/v1/ignition_user_roles?user_id=eq.${user_id}`, env, {
    method: 'PATCH', prefer: 'return=representation', body: JSON.stringify(patch),
  });
  if (!res.ok) return err(`db_error: ${JSON.stringify(res.data)}`, 400);
  if (!res.data?.length) return err('user_has_no_ignition_access', 404);
  return ok({ user_id, active });
}

// ────────────────────────────────────────────────────────────────────────────
// DISPATCH
// ────────────────────────────────────────────────────────────────────────────

const GET_ACTIONS = {
  getIgnitionAccess,
  getGrantableUsers,
  getInfluencers,
  getInfluencerCounts,
  getInfluencer,
  getEngagements,
  getEngagement,
  getEngagementVideos,
  getRoster,
  getDiscountCodes,
  getCampaigns,
  getCampaign,
  getOverdueEngagements,
  getSchedule,
  getPayments,
  getKpis,
  getReports,
  getProductCogs,
  getMonthlyTargets,
  getMonthlyBreakdown,
  getCampaignSummary,
  getCatalogs,
  getLocations,
  getPaymentProofUrl,
  getCampaignBriefUrl,
  getInfluencerMetrics,
  getMe,
  searchShopifyCustomer,
  getInfluencerShopify,
  getConnects,
  getConnect,
  getIgnitionUsers,
  getUgcPipeline,
  getCouponsForEngagement,
  getProductPrice,
  getInfluencerAttribution,
  getQualityFlags,
  getDealBriefPreview,
  getPostReminderDue,
  getBrokenChannelLinks,
  getTrackingLinkStatus,
};

const POST_ACTIONS = {
  createInfluencer,
  updateInfluencer,
  deleteInfluencer,
  addCategoryOption,
  createEngagement,
  updateEngagement,
  setEngagementProducts,
  deleteEngagement,
  generateUgcBrief,
  refreshUgcMetrics,
  approveEngagement,
  advanceStage,
  closeEngagement,
  setRating,
  addNote,
  addAttachment,
  assignDiscountCode,
  issueCoupon,
  retryCoupon,
  retireCoupon,
  syncCouponRedemptions,
  refreshProductPrices,
  mintTrackingLink,
  markGiftedNoPost,
  openPitstopTicket,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  assignEngagementToCampaign,
  flagOverdueRatings,
  addPayment,
  deletePayment,
  createPaymentProofUploadUrl,
  createCampaignBriefUploadUrl,
  addMetricSnapshot,
  deleteMetricSnapshot,
  upsertMonthlyTarget,
  replyConnect,
  promoteConnect,
  setConnectStatus,
  returnConnect,
  grantIgnitionAccess,
  setIgnitionUserActive,
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

    // Which Shopify app do OUR creds belong to, and what is it actually granted?
    // Read-only, mirrors commsops /internal/shopify-app-info (S232). Added S309
    // because the knowledge layer disagreed with itself about the scope state —
    // BACKLOG said write_discounts + read_products were both missing while
    // integrations.md recorded both as released in S214 — and a scope question can
    // only be settled by asking the live installation, never by reading either doc.
    // ignitionops authenticates as the PITSTOP CS-lookup app, not the Odo app
    // (PATTERN-084), so this also confirms WHICH app a release must target.
    // Gated on its OWN token, deliberately NOT IGNITION_BRIDGE_TOKEN: that one is
    // shared with csops (which validates it at /bridge/ignition), so anything that
    // would ever force a rotation of it drags a second worker along in lockstep —
    // the WA_SYNC_TOKEN/INGEST_TOKEN trap in reference/integrations.md. A diagnostic
    // endpoint should not be able to do that.
    if (url.pathname === '/internal/shopify-app-info' && request.method === 'POST') {
      const want = env.IGNITION_PROBE_TOKEN;
      const a = request.headers.get('Authorization') || '';
      const bearer = a.slice(0, 7).toLowerCase() === 'bearer ' ? a.slice(7).trim() : '';
      if (!want || bearer !== want) return err('unauthorised', 401);
      const r = await shopifyGraphql(env,
        `{ currentAppInstallation { app { title handle apiKey } accessScopes { handle } } }`, {});
      if (!r.ok) return err(r.error || 'shopify_error', 502);
      const inst = r.data?.currentAppInstallation || {};
      return ok({
        app: inst.app || null,
        scopes: (inst.accessScopes || []).map(s => s.handle).sort(),
      });
    }

    // Run the Shopify price+handle sweep on demand (S313). The sweep otherwise runs ONLY on
    // the Monday cron with no trigger anywhere, which is exactly how it failed silently for six
    // weeks behind a missing scope and nobody saw. Its own token, for the reason spelled out
    // above /internal/shopify-app-info: a maintenance trigger must not be able to force the
    // rotation of a secret another worker also validates.
    if (url.pathname === '/internal/refresh-prices' && request.method === 'POST') {
      const want = env.IGNITION_MAINT_TOKEN;
      const a = request.headers.get('Authorization') || '';
      const bearer = a.slice(0, 7).toLowerCase() === 'bearer ' ? a.slice(7).trim() : '';
      if (!want || bearer !== want) return err('unauthorised', 401);
      return refreshProductPrices({}, { userId: 'maint', permissions: { ignition_manage: true } }, env);
    }

    if (request.method === 'GET')  return handleGet(url, request, env);
    if (request.method === 'POST') return handlePost(request, env);
    return err('method_not_allowed', 405);
  },

  // Cron entrypoint (wrangler.toml [triggers]) — branch on event.cron so each schedule
  // is its own invocation + subrequest budget. System auth passes the perm gates.
  async scheduled(event, env, ctx) {
    const cron = event?.cron || '';
    const CRON_AUTH = { userId: 'cron', permissions: { ignition_manage: true, ignition_view: true } };

    // 07:50 IST daily — UGC Meta ad-metrics pull (Batch C2, S177). Inert until token set.
    if (cron === '20 2 * * *') {
      if (!env.META_SYSTEM_USER_TOKEN) return;
      ctx.waitUntil(syncUgcMetaMetrics(env).then(
        r => console.log('[ugc-meta] cron', JSON.stringify(r)),
        e => console.error('[ugc-meta] cron error', e),
      ));
      return;
    }

    // 08:40 IST daily — reconcile coupon redemptions off Shopify (S214). Drains
    // COUPON_SYNC_MAX active codes/pass (oldest-synced first); refund-aware. No-op if
    // Shopify unconfigured (the action returns a 503 that just resolves here).
    if (cron === '10 3 * * *') {
      ctx.waitUntil(syncCouponRedemptions({}, CRON_AUTH, env).then(
        () => console.log('[coupon-sync] cron done'),
        e => console.error('[coupon-sync] cron error', e),
      ));
      return;
    }

    // 09:00 IST Mondays — refresh the Shopify variant-price cache (goodies auto-fill).
    if (cron === '30 3 * * 1') {
      ctx.waitUntil(refreshProductPrices({}, CRON_AUTH, env).then(
        () => console.log('[price-refresh] cron done'),
        e => console.error('[price-refresh] cron error', e),
      ));
      return;
    }
  },
};
