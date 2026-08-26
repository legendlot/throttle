/**
 * Pitstop — csops Cloudflare Worker
 * csops.afshaan.workers.dev
 *
 * API for the customer support portal at pitstop.legendoftoys.com.
 * Sibling to lotopsproxy (Garage/Redline/Scanner) and throttleops (Throttle).
 *
 * Pattern: GET  /?action=<actionName>            (reads)
 *          POST /  body: { action, ...params }   (writes, JWT-authenticated)
 *
 * Spec:  docs/superpowers/specs/2026-05-26-pitstop-design.md
 * Plan:  docs/superpowers/plans/2026-05-26-pitstop.md
 */

// ── Telephony ────────────────────────────────────────────────────────────────
// The vendor-neutral call pipeline (S301). MyOperator and Exotel both normalise into
// one NormalisedCall and call in here, so ticket creation, RULE-PITSTOP-018 coalescing
// and agent attribution exist once. See src/telephony/call-pipeline.js.
import {
  makeCallPipeline, agentEmailFromLegs, normaliseDirection,
} from './telephony/call-pipeline.js';
import { exotelConfigured, makeExotelClient } from './telephony/exotel-client.js';
import {
  reconcileExotelCalls, settleExotelCalls, backfillExotelCalls,
} from './telephony/exotel-poller.js';
import { igAccessToken, refreshIgToken } from './meta-token.js';
import { makeCallContext } from './telephony/call-context.js';
import { makeSoftphone } from './telephony/softphone.js';
import { mapExotelStatus } from './telephony/exotel-adapter.js';
import { fromIstNaive } from './telephony/exotel-client.js';


// ── CORS ─────────────────────────────────────────────────────────────────────

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

// ── Supabase helpers ─────────────────────────────────────────────────────────

async function sb(path, env, opts = {}) {
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

async function sbPublic(path, env, opts = {}) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type':  'application/json',
      'apikey':        env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Prefer':        opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

// Exact row count for a `store` query via Content-Range (sb() drops headers).
// Returns 0 on any parse failure. Used where a full row fetch is too large.
async function sbCount(path, env) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${env.SUPABASE_URL}${path}${sep}limit=1`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Accept-Profile': 'store',
      Prefer: 'count=exact',
      Range: '0-0',
    },
  });
  const cr = res.headers.get('content-range') || '';
  const n = Number(cr.split('/')[1]);
  return Number.isFinite(n) ? n : 0;
}

// ── Shopify helpers ──────────────────────────────────────────────────────────

// Normalise an India phone to E.164 (mirrors createTicket's logic).
function toE164(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, '');
  // ⚠️ Strip leading zeros BEFORE classifying (S301, 2026-08-20). Exotel returns
  // Indian numbers in NATIONAL format — `09959953604` — where MyOperator sent bare
  // 10-digit or 91-prefixed. The old code fell through to `+09959953604`, which is
  // not a valid E.164 number and, worse, is a DIFFERENT KEY from the `+91…` that all
  // 17,703 MyOperator rows use: coalescing (RULE-PITSTOP-018), the Shopify lookup and
  // WhatsApp thread matching would all silently miss, so every Exotel caller would
  // show as "Unknown caller" with no order history. Found on the first live poll.
  //
  // Safe for international numbers too: a country code never begins with 0, so a
  // leading zero is always a trunk prefix (0…) or an international prefix (00…).
  // `00974…` → `+974…` is correct.
  // ⚠️ Strip ONLY when the result is a plausible phone number (E.164 is max 15 digits).
  //
  // This function is also handed things that are NOT phone numbers: the Chatwoot web
  // widget yields 20-22 digit visitor identifiers, and `findOrCreateWaThread` /
  // `chatwootThread` fall back to matching a thread on this value. Stripping leading
  // zeros unconditionally would change the stored shape of those identifiers
  // (`+0099622…` -> `+99622…`) and a returning web visitor could miss their existing
  // thread. Both forms are meaningless as phone numbers; the point is that the value
  // stays BYTE-IDENTICAL to what is already in cs_wa_threads for anything that was
  // never a phone number in the first place.
  const stripped = d.replace(/^0+/, '');
  // All zeros is not a number at all — return null rather than a bare "+0".
  if (!stripped) return null;
  if (stripped.length <= 15) d = stripped;
  if (d.length === 10) return `+91${d}`;
  if (d.length === 12 && d.startsWith('91')) return `+${d}`;
  return `+${d}`;
}

const SHOPIFY_API_VERSION = '2026-04';

// Shopify access tokens for Dev Dashboard apps are minted via the client-
// credentials grant and expire in ~24h. Cache one per isolate and refresh
// on demand. client_id/client_secret are static (set as worker secrets).
let _shopifyToken = null;   // cached access token
let _shopifyTokenExp = 0;   // epoch ms when the cached token expires

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

// Lazy on-demand Shopify lookup. Returns graceful states, never throws.
async function shopifyLookup({ phone, email }, env) {
  if (!env.SHOPIFY_STORE_DOMAIN || !env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) {
    return { configured: false, found: false, customer: null, recent_orders: [] };
  }
  const e164 = toE164(phone);
  const term = e164 ? `phone:${e164}` : (email ? `email:${email}` : null);
  if (!term) return { configured: true, found: false, customer: null, recent_orders: [] };

  const query = `query($q:String!){ customers(first:1, query:$q){ edges{ node{
    id displayName email phone numberOfOrders createdAt
    amountSpent{ amount currencyCode }
    defaultAddress{ city province country }
    orders(first:10, sortKey: CREATED_AT, reverse:true){ edges{ node{
      id name createdAt displayFulfillmentStatus displayFinancialStatus
      currentTotalPriceSet{ shopMoney{ amount currencyCode } }
      subtotalPriceSet{ shopMoney{ amount } }
      totalShippingPriceSet{ shopMoney{ amount } }
      shippingAddress{ city province country }
      fulfillments(first:5){ status trackingInfo{ number company url } }
      lineItems(first:25){ edges{ node{ title quantity sku variantTitle
        originalTotalSet{ shopMoney{ amount currencyCode } } } } }
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
  const addr = a => a ? [a.city, a.province, a.country].filter(Boolean).join(', ') : null;
  const customer = {
    id: node.id, name: node.displayName, email: node.email, phone: node.phone,
    orders_count: node.numberOfOrders, total_spent: node.amountSpent?.amount, currency: node.amountSpent?.currencyCode,
    since: node.createdAt, location: addr(node.defaultAddress),
  };
  const recent_orders = (node.orders?.edges || []).map(e => {
    const o = e.node;
    const tracking = [];
    for (const f of (o.fulfillments || [])) {
      for (const ti of (f.trackingInfo || [])) {
        if (ti.number || ti.url) tracking.push({ number: ti.number, company: ti.company, url: ti.url });
      }
    }
    // Deep link to the Shopify admin order page (Pruthvi 2026-07-31 — the order number
    // was plain text, so "open this order" meant retyping it into Shopify). Built HERE,
    // not in the app: the store domain is a worker secret and must not ship to the client.
    // `id` is a gid (`gid://shopify/Order/123`); the admin route wants the trailing digits.
    const legacyId = String(o.id || '').match(/(\d+)\s*$/)?.[1] || null;
    return {
      order_no: o.name, created_at: o.createdAt,
      admin_url: legacyId ? `https://${env.SHOPIFY_STORE_DOMAIN}/admin/orders/${legacyId}` : null,
      fulfillment: o.displayFulfillmentStatus, financial: o.displayFinancialStatus,
      total: o.currentTotalPriceSet?.shopMoney?.amount, currency: o.currentTotalPriceSet?.shopMoney?.currencyCode,
      subtotal: o.subtotalPriceSet?.shopMoney?.amount,
      shipping: o.totalShippingPriceSet?.shopMoney?.amount,
      ship_to: addr(o.shippingAddress),
      tracking,
      line_items: (o.lineItems?.edges || []).map(li => ({
        title: li.node.title, quantity: li.node.quantity, variant: li.node.variantTitle, sku: li.node.sku,
        amount: li.node.originalTotalSet?.shopMoney?.amount,
      })),
    };
  });
  await attachShipments(recent_orders, env);
  return { configured: true, found: true, customer, recent_orders };
}

// ── Outbound shipment state (public.ecom_shipments) ───────────────────────────────────────
// Shopify knows only that an AWB EXISTS — its fulfillment stops at "dispatched" and never moves
// (the "Mark as delivered" button is manual). The courier lifecycle lives in Uniware, which
// odoops polls into public.ecom_shipments. Attaching it here means the agent sees "Delivered
// 18 Jul" on the order card instead of having to leave Pitstop, enter a phone number and wait
// for a Delhivery OTP just to answer "where is my order".
//
// Join is on the Shopify order NAME (#LOT43700) — Uniware's own order code is the Shopify order
// ID, which Shopify's GraphQL order list does not return here.
const SHIPMENT_LIFECYCLE_LABEL = {
  pending: 'Preparing', manifested: 'Label created', in_transit: 'In transit',
  out_for_delivery: 'Out for delivery', delivered: 'Delivered', rto: 'Returning to sender',
  cancelled: 'Cancelled', unknown: 'Unknown',
};
// Anything an agent should react to without being asked.
const SHIPMENT_ALERT = new Set(['rto']);

async function attachShipments(orders, env) {
  try {
    const names = [...new Set((orders || []).map(o => o.order_no).filter(Boolean))];
    if (!names.length) return;
    // encodeURIComponent is REQUIRED, not tidiness: order names start with '#', and fetch()
    // treats that as a URL fragment and drops everything after it — the query silently arrives
    // truncated and PostgREST 400s.
    const inList = names.map(n => `"${encodeURIComponent(String(n).replace(/"/g, ''))}"`).join(',');
    const r = await sbPublic(`/rest/v1/ecom_shipments?shopify_order_name=in.(${inList})`
      + `&select=shopify_order_name,courier,shipping_provider,tracking_number,tracking_link,`
      + `lifecycle,package_status,courier_status,dispatched_at,delivered_at,uniware_updated_at,`
      + `is_cod,collectable_amount,collected_amount`
      + `&order=uniware_updated_at.desc.nullslast`, env);
    // Log rather than fail silently. The catch below is deliberate (tracking must never break
    // the customer lookup) but a swallowed error is invisible — which is exactly how the '#'
    // fragment bug above shipped unnoticed.
    if (!r.ok || !Array.isArray(r.data)) { console.log('attachShipments_failed', r.status, JSON.stringify(r.data).slice(0, 200)); return; }
    const byName = {};
    // An order can have several packages (split shipment). Keep the first per name — the query
    // is newest-first — and count the rest so the UI can say "+1 more parcel".
    for (const row of r.data) {
      const k = row.shopify_order_name;
      if (!byName[k]) byName[k] = { ...row, parcels: 1 };
      else byName[k].parcels += 1;
    }
    for (const o of orders) {
      const s = byName[o.order_no];
      if (!s) { o.shipment = null; continue; }
      o.shipment = {
        courier: s.courier, provider: s.shipping_provider,
        awb: s.tracking_number, tracking_link: s.tracking_link,
        lifecycle: s.lifecycle, label: SHIPMENT_LIFECYCLE_LABEL[s.lifecycle] || s.lifecycle,
        alert: SHIPMENT_ALERT.has(s.lifecycle),
        // Raw upstream values kept so an agent can quote the exact courier code on a call.
        package_status: s.package_status, courier_status: s.courier_status,
        dispatched_at: s.dispatched_at, delivered_at: s.delivered_at,
        as_of: s.uniware_updated_at,
        is_cod: s.is_cod, cod_collectable: s.collectable_amount, cod_collected: s.collected_amount,
        parcels: s.parcels,
      };
    }
  } catch (e) { console.log('attachShipments_error', e?.message || String(e)); /* never fail the customer lookup over tracking */ }
}

// Resolve Shopify order names → createdAt (for the purchase-date backfill). The Shopify order
// NAME carries a "#" prefix (e.g. "#LOT36533"); tickets store external_order_id sometimes with
// it, mostly without ("LOT36533"). So we search WITH the "#" and key the result map by the
// normalised name (leading "#" stripped) so both sides match. Batches into one
// orders(query:"status:any AND (name:.. OR ..)") call per CHUNK. Never throws.
const normOrderName = (s) => String(s || '').trim().replace(/^#/, '');
async function shopifyOrderDatesByName(names, env) {
  const out = {};                                   // keyed by normalised name (no "#")
  if (!names.length || !env.SHOPIFY_STORE_DOMAIN || !env.SHOPIFY_CLIENT_ID) return out;
  let token = await getShopifyToken(env);
  if (!token) return out;
  const CHUNK = 40;
  for (let i = 0; i < names.length; i += CHUNK) {
    const batch = names.slice(i, i + CHUNK);
    // status:any — Shopify's orders search defaults to OPEN only; fulfilled orders are archived.
    // "#"+core — the order name includes the "#" prefix; searching bare misses them.
    const q = `status:any AND (${batch.map(n => `name:${JSON.stringify('#' + normOrderName(n))}`).join(' OR ')})`;
    const query = `query($q:String!){ orders(first:${CHUNK}, query:$q){ edges{ node{ name createdAt } } } }`;
    const run = (t) => fetch(`https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': t },
      body: JSON.stringify({ query, variables: { q } }),
    });
    let res = await run(token).catch(() => null);
    if (res && res.status === 401) { token = await getShopifyToken(env, true); if (!token) break; res = await run(token).catch(() => null); }
    if (!res || !res.ok) continue;
    const data = await res.json().catch(() => null);
    for (const e of (data?.data?.orders?.edges || [])) {
      const o = e.node; if (o?.name && o?.createdAt) out[normOrderName(o.name)] = o.createdAt;
    }
  }
  return out;
}

// Fill cs_tickets.purchase_date for Website complaints from their Shopify order date.
// Batch-bounded (subrequest-safe) + idempotent (RPC only fills NULLs); drains history over
// runs and tops up new tickets. Called by the admin action + the cron. Marketplace channels
// (Amazon/QC/etc.) have no Shopify order → stay NULL (manual field / "Ageing unknown").
async function runPurchaseDateBackfill(env, { limit = 120 } = {}) {
  if (!env.SHOPIFY_STORE_DOMAIN) return { ok: false, reason: 'shopify not configured' };
  const r = await sb(`/rest/v1/cs_tickets?platform=eq.website&external_order_id=not.is.null&purchase_date=is.null&select=id,external_order_id&order=created_at.desc&limit=${limit}`, env);
  const rows = r.data || [];
  if (!rows.length) return { ok: true, scanned: 0, resolved: 0, updated: 0, remaining: 0 };
  const names = [...new Set(rows.map(t => t.external_order_id).filter(Boolean))];
  const dateByName = await shopifyOrderDatesByName(names, env);
  const istDay = (ts) => new Date(new Date(ts).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const updates = [];
  for (const t of rows) { const c = dateByName[normOrderName(t.external_order_id)]; if (c) updates.push({ id: t.id, purchase_date: istDay(c) }); }
  let updated = 0;
  if (updates.length) {
    const up = await sb(`/rest/v1/rpc/set_ticket_purchase_dates`, env, { method: 'POST', body: JSON.stringify({ p: updates }) });
    updated = Number(up.data) || 0;
  }
  const remaining = await sbCount(`/rest/v1/cs_tickets?platform=eq.website&external_order_id=not.is.null&purchase_date=is.null&select=id`, env);
  return { ok: true, scanned: rows.length, resolved: updates.length, updated, remaining };
}

// Admin action — run one backfill batch on demand (the cron also drains it). Re-run until
// remaining=0. gated cs_ticket_admin.
async function backfillPurchaseDates(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  const limit = Math.min(Math.max(Number(body?.limit) || 120, 1), 200);
  const res = await runPurchaseDateBackfill(env, { limit });
  return res.ok ? ok(res) : err(res.reason || 'backfill failed', 503);
}

// ── Auth ─────────────────────────────────────────────────────────────────────

async function verifyJWT(authHeader, env) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  if (!user?.id) return null;

  // users_profile lives in 'store' schema
  const profileRes = await sb(
    `/rest/v1/users_profile?id=eq.${user.id}&select=role,full_name,active,cs_department_id&limit=1`,
    env,
  );
  if (!profileRes.ok || !profileRes.data?.[0]) return null;
  const profile = profileRes.data[0];
  if (!profile.active) return null;

  const rolesRes = await sb(
    `/rest/v1/roles?role_id=eq.${encodeURIComponent(profile.role)}&select=permissions&limit=1`,
    env,
  );
  const permissions = rolesRes.ok && rolesRes.data?.[0]?.permissions || {};

  // Resolve dept slug for the topbar switcher + default-filter logic
  let cs_department_slug = null;
  let cs_department_name = null;
  if (profile.cs_department_id) {
    const d = await sb(
      `/rest/v1/cs_departments?id=eq.${profile.cs_department_id}&select=slug,name&limit=1`,
      env,
    );
    cs_department_slug = d.data?.[0]?.slug || null;
    cs_department_name = d.data?.[0]?.name || null;
  }

  return {
    userId: user.id,
    email: user.email,
    role: profile.role,
    fullName: profile.full_name,
    permissions,
    cs_department_id:   profile.cs_department_id || null,
    cs_department_slug,
    cs_department_name,
  };
}

function require(perm, auth) {
  if (!auth?.permissions?.[perm]) {
    return err(`Forbidden — missing permission: ${perm}`, 403);
  }
  return null;
}

// Resolve the effective department filter. Admins may override via
// ?department=<slug> (or `all` to disable). Non-admins are locked to the
// departments they belong to — the union of store.cs_user_departments and their
// primary users_profile.cs_department_id (#2 multi-department, S138).
// Returns { mode: 'none' | 'id' | 'ids', id?, ids? } or null if a requested
// admin slug isn't found.
async function resolveDeptFilter(slugParam, auth, env) {
  const isAdmin = !!auth?.permissions?.cs_ticket_admin;
  if (isAdmin) {
    if (!slugParam || slugParam === 'all') return { mode: 'none' };
    const r = await sb(
      `/rest/v1/cs_departments?slug=eq.${encodeURIComponent(slugParam)}&select=id&limit=1`,
      env,
    );
    const id = r.data?.[0]?.id;
    return id ? { mode: 'id', id } : null;
  }
  // Non-admin: union of all departments the user belongs to.
  const r = await sb(
    `/rest/v1/cs_user_departments?user_id=eq.${auth.userId}&select=cs_department_id`,
    env,
  );
  const ids = new Set((r.data || []).map(x => x.cs_department_id).filter(Boolean));
  if (auth?.cs_department_id) ids.add(auth.cs_department_id);   // primary, back-compat
  const arr = [...ids];
  if (arr.length === 0) return { mode: 'none' };
  if (arr.length === 1) return { mode: 'id', id: arr[0] };
  return { mode: 'ids', ids: arr };
}

// PostgREST filter fragment for a resolved dept filter ('' when unfiltered).
// ⚠️ NULL-TOLERANT BY DESIGN. A row with NO department belongs to no department, so an
// `eq`/`in` filter — which never matches NULL in Postgres — hid it from EVERYONE rather
// than from the wrong people. That is strictly worse than showing it to everyone, and it
// was not theoretical (found 2026-08-26, S311):
//
// Nothing has stamped `cs_department_id` on a call since the Exotel cutover on 19 Aug —
// `exotelToNormalised` accepts a `departmentId` option and `reconcileExotelCalls(env, pipe)`
// never passes one — so EVERY Exotel call, and every ticket auto-created from one, carries
// NULL. The four `cs_agent`s are department-scoped; Afshaan, Pruthvi and Sunitha are admins
// and are not. Result:
//   · 445 calls flagged `needs_callback`, ZERO ever cleared, invisible to every agent who
//     would make the call — the "Needs callback" tab and its KPI both read empty for them.
//   · 313 phone tickets since 20 Aug, of which 306 (97.8%) are STILL OPEN, against 50% for
//     the handful that did get a department. That gap is the proof: they are not being
//     ignored, they cannot be seen.
//
// Nested as `and=(or(...))` rather than a top-level `or=` on purpose: visibilityFilters
// already pushes a top-level `or=` for operator self-scope, and two `or=` params on one
// query collide.
//
// ⚠️ This widens visibility, it does NOT fix attribution — the calls still have no
// department, so per-department reporting stays wrong until an exophone→department mapping
// exists. That needs Pruthvi (one exophone today, 08044656833). See BACKLOG.
function buildDeptFilter(df) {
  if (!df) return '';
  if (df.mode === 'id') return `and=(or(cs_department_id.eq.${df.id},cs_department_id.is.null))`;
  if (df.mode === 'ids') return `and=(or(cs_department_id.in.(${df.ids.join(',')}),cs_department_id.is.null))`;
  return '';
}

// ── Visibility scope (agent-only dashboard, Pruthvi S144) ─────────────────────
// The operator tier — a role with cs_ticket_manage but WITHOUT cs_ticket_reassign
// or cs_ticket_admin (i.e. cs_agent) — is restricted to its OWN tickets: assigned
// to them, created by them, or still unassigned (so they can self-claim from the
// pool). Leads/admins are unaffected — they keep the full department view + the
// agent filter. Mirrors the oversight gating already used for the agent dropdown.
function isOperatorScope(auth) {
  const p = auth?.permissions || {};
  return !!p.cs_ticket_manage && !p.cs_ticket_reassign && !p.cs_ticket_admin;
}

// PostgREST filter fragments scoping a ticket list/count to what `auth` may see:
// the existing dept filter, plus the operator self-scope when applicable. Returns
// null when the requested department slug is unknown (caller should 404).
async function visibilityFilters(params, auth, env) {
  const out = [];
  const deptFilter = await resolveDeptFilter(params.get('department'), auth, env);
  if (!deptFilter) return null;
  const dc = buildDeptFilter(deptFilter);
  if (dc) out.push(dc);
  if (isOperatorScope(auth)) {
    out.push(`or=(assigned_agent_id.eq.${auth.userId},created_by_user_id.eq.${auth.userId},assigned_agent_id.is.null)`);
  }
  return out;
}

// ── Domain constants ─────────────────────────────────────────────────────────

const SLA_DAYS = { pending: 7, query: 1, no_action: 1, awaiting_info: 7, replacement: 5, refund: 7, repair: 14 };
// COALESCE_WINDOW_MS (RULE-PITSTOP-018) is imported from the telephony pipeline — it
// governs BOTH vendors, so it lives with the code that applies it. A new answered call
// from a phone that already has an OPEN ticket in the same department inside the window
// attaches to that ticket instead of spawning a duplicate; every call is still logged
// independently in cs_calls.

const SHARED_STAGES = [
  'intake', 'awaiting_evidence', 'verified', 'pickup_scheduled',
  'picked_up', 'at_warehouse', 'inspected',
];
const BRANCH_STAGES = {
  replacement: ['replacement_dispatched'],
  refund:      ['refund_initiated', 'refund_completed'],
  repair:      ['handed_to_production', 'repaired_ready', 'repair_dispatched'],
  // pending / query / no_action / awaiting_info intentionally have no branch stages;
  // they resolve out of the shared flow. allowedTransitions already does BRANCH_STAGES[d] || [].
};
const SIDE_EXITS = ['cancelled', 'rejected', 'escalated'];
// closed_reason is a constrained enum (cs_tickets_closed_reason_check). Free-text
// reasons (e.g. the cancel modal's note) must never be written into it — they get
// coerced to the stage default and preserved as a history note instead.
const ALLOWED_CLOSED_REASONS = ['resolved', 'duplicate', 'no_response', 'no_evidence', 'no_payment', 'wrong_system', 'goodwill', 'other', 'rejected', 'no_action', 'historical_import'];

// Resolve vs Close (Pruthvi #bugs 2026-07-25, built 2026-07-28). ONE vocabulary
// shared by tickets and conversations so the two objects end the same way:
//   'resolved'  → the customer's issue was actually addressed  (the Resolve action)
//   everything else → shut for an operational reason           (the Close action)
// Kept OUT of this list on purpose: 'rejected' / 'historical_import' are ticket-only
// stage artefacts, never offered as a conversation close reason.
const CONVO_CLOSE_REASONS = ['resolved', 'no_response', 'no_evidence', 'no_payment',
                             'duplicate', 'wrong_system', 'goodwill', 'no_action', 'other'];

// Returns the next allowed stages for a given (current, disposition)
function allowedTransitions(current, disposition) {
  const branch = BRANCH_STAGES[disposition] || [];
  const flow = [...SHARED_STAGES, ...branch, 'closed'];
  const i = flow.indexOf(current);
  const next = i === -1 || i === flow.length - 1 ? [] : [flow[i + 1]];
  // From any non-closed stage, side-exits are allowed
  if (current !== 'closed' && current !== 'cancelled' && current !== 'rejected') {
    next.push(...SIDE_EXITS.filter(s => s !== current));
  }
  return next;
}

// Per-stage gate fields required to advance into `target`
function gateRequirements(current, target, disposition, ticket, attachments_count = 0) {
  switch (target) {
    case 'verified':
      if (attachments_count < 1) {
        return 'At least 1 attachment required before verifying the case.';
      }
      return null;
    case 'pickup_scheduled':
      if (!ticket.return_awb || !ticket.return_courier) {
        return 'return_awb and return_courier required.';
      }
      return null;
    case 'at_warehouse':
      // warehouse_received_at auto-stamped by advanceStage
      return null;
    case 'inspected':
      if (!ticket.inspection_note) {
        return 'inspection_note required.';
      }
      return null;
    case 'replacement_dispatched':
      // replacement_unit_upc is now OPTIONAL (the replacement process doesn't require
      // entering the new unit's UPC at creation). replacement_order_id is mandatory.
      if (!ticket.replacement_order_id || !ticket.replacement_awb) {
        return 'replacement_order_id and replacement_awb required.';
      }
      return null;
    case 'refund_initiated':
      if (ticket.refund_amount_inr == null) {
        return 'refund_amount_inr required.';
      }
      return null;
    case 'refund_completed':
      // refund_reference (UTR / payment ref) is now OPTIONAL (Pruthvi, S149) —
      // a refund can be marked completed before the UTR/payment ref is captured.
      return null;
    case 'handed_to_production':
      // repair_run_id can be set later — agent might link a run before or at this stage.
      return null;
    default:
      return null;
  }
}

// ── Entrypoint ───────────────────────────────────────────────────────────────

export default {
  // `ctx` is required by the Exotel call-flow webhooks: they must return a bare 200
  // immediately (Exotel is holding a live customer on the line) and do their work in
  // ctx.waitUntil(). Adding the third parameter is backward-compatible - Cloudflare has
  // always passed it.
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    if (url.pathname === '/health' || action === 'health') {
      return json({ ok: true, service: 'csops', ts: new Date().toISOString() });
    }
    if (url.pathname === '/webhooks/myoperator' && request.method === 'POST') {
      return handleMyOperatorWebhook(request, env);
    }
    // Exotel fires these as GET from inside a call flow — there is no header slot, so
    // the shared secret travels in the query string (same posture as the MyOperator
    // webhook). Both mounted before the JWT gate.
    if (url.pathname === '/webhooks/exotel/warm') {
      return handleExotelWarm(request, url, env, ctx);
    }
    if (url.pathname === '/webhooks/exotel/agent') {
      return handleExotelAgent(request, url, env, ctx);
    }
    if (url.pathname === '/webhooks/exotel/status' && request.method === 'POST') {
      return handleExotelStatus(request, url, env, ctx);
    }
    if (url.pathname === '/webhooks/bitespeed' && request.method === 'POST') {
      return handleBiteSpeedWebhook(request, env);
    }
    // Relay WhatsApp inbound forward (WS-D) — token-authed, before JWT like the other
    // webhooks. Inert until Relay forwards (post live-number cutover). See waTransport.
    if (url.pathname === '/webhooks/relay-wa' && request.method === 'POST') {
      return handleRelayWaWebhook(request, env);
    }
    // BiteSpeed history backfill (S245) — token-gated, before the JWT gate like the webhooks
    // so it can be driven without a Google login. Time-boxed: only works while the vendor
    // token still authenticates.
    if (url.pathname === '/internal/wa-history-backfill' && request.method === 'POST') {
      return handleWaHistoryBackfill(request, env);
    }
    // Read-only Instagram sendability probe, token-gated and placed before the JWT gate
    // for the same reason the webhooks are: diagnosing why Meta refuses ONE recipient must
    // not require a Google login and an agent session. Sends nothing. See diagIgRecipient.
    if (url.pathname === '/internal/ig-recipient-probe' && request.method === 'POST') {
      const a = request.headers.get('Authorization') || '';
      const bearer = a.slice(0, 7).toLowerCase() === 'bearer ' ? a.slice(7).trim() : '';
      if (!env.WA_SYNC_TOKEN || bearer !== env.WA_SYNC_TOKEN) return err('unauthorised', 401);
      let pb = {}; try { pb = await request.json(); } catch { /* ignore */ }
      return diagIgRecipient(pb, { permissions: { cs_ticket_admin: true } }, env);
    }
    // Meta (Instagram + Facebook Messenger DMs) — GET verify handshake + POST events.
    if (url.pathname === '/webhooks/meta') {
      if (request.method === 'GET')  return handleMetaVerify(url, env);
      if (request.method === 'POST') return handleMetaWebhook(request, env);
    }
    // Ignition bridge — sibling-worker (ignitionops) read/reply on transferred
    // "Connect" threads. Token-authed (NOT a user JWT), placed BEFORE the JWT gate
    // like the webhooks. Every handler hard-scopes to ignition_connect=true, so
    // Ignition can never reach general channel traffic. See the Ignition Connects spec.
    if (url.pathname === '/bridge/ignition' && request.method === 'POST') {
      return handleIgnitionBridge(request, env);
    }
    if (!action && request.method === 'GET') return err('Missing action parameter', 400);

    // Authenticate every request (besides /health)
    if (url.pathname === '/internal/ping-bindings' && request.method === 'POST') {
    const a = request.headers.get('Authorization') || '';
    const bearer = a.slice(0, 7).toLowerCase() === 'bearer ' ? a.slice(7).trim() : '';
    if (!env.ODOOPS_INTERNAL_TOKEN || bearer !== env.ODOOPS_INTERNAL_TOKEN) return err('unauthorised', 401);
    let pb = {}; try { pb = await request.json(); } catch { /* ignore */ }
    // Optional: exercise the shipment enrichment against real order names. Post-deploy smoke for
    // a path that is otherwise only reachable behind a Google login — which is how the '#'
    // URL-fragment bug reached production unnoticed.
    if (Array.isArray(pb.checkOrders) && pb.checkOrders.length) {
      const probe = pb.checkOrders.map((n) => ({ order_no: n }));
      await attachShipments(probe, env);
      return ok({ bindings: await pingBindings(env), orders: probe });
    }
    return ok(await pingBindings(env));
  }

  const auth = await verifyJWT(request.headers.get('Authorization'), env);
    if (!auth) return err('Unauthorized', 401);

    if (request.method === 'GET') {
      return handleGet(action, url.searchParams, auth, env);
    }

    if (request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch {}
      const actionPost = body.action || action;
      return handlePost(actionPost, body, auth, env, request);
    }

    return err('Method not allowed', 405);
  },

  // Cron: poll carecrew@ for new inbound email (Pitstop email channel, S175).
  // Armed via wrangler.toml [triggers] crons. Inert (no-op) until the Gmail SA
  // secrets are set. Idempotent — provider_message_id unique dedupes redelivery.
  async scheduled(event, env, ctx) {
    if (gmailConfigured(env)) {
      ctx.waitUntil(syncGmail(env).then(
        r => console.log('[email] cron sync', JSON.stringify(r)),
        e => console.error('[email] cron sync error', e),
      ));
    }
    // Purchase-date backfill for Support Analytics ageing — throttled to ~every 20 min
    // (the cron is */2). Cheap when drained: 0 unfilled tickets → no Shopify call.
    const mins = new Date(event?.scheduledTime || Date.now()).getUTCMinutes();
    if (env.SHOPIFY_STORE_DOMAIN && mins % 10 === 0) {
      ctx.waitUntil(runPurchaseDateBackfill(env, { limit: 200 }).then(
        r => console.log('[purchase-date] cron backfill', JSON.stringify(r)),
        e => console.error('[purchase-date] cron backfill error', e),
      ));
    }

    // Exotel reconcile (S301). The cron is */2, and this is the COMPLETENESS
    // GUARANTEE for the call log — not an optimisation. A caller who hangs up during
    // the greeting fires no webhook at all, so polling Exotel's own record is the only
    // way to see them. Inert until EXOTEL_API_KEY/TOKEN are set.
    //
    // The window is 30 min against a 2-min tick: the overlap is free (the upsert is
    // idempotent on (provider, provider_call_sid)) and it means one failed tick
    // self-heals on the next rather than leaving a permanent hole.
    // Instagram token refresh (S311). An IGAA token caps at 60 days and nothing renewed
    // it — Instagram replies were dead 20–24 Aug 2026 and surfaced only as a Slack
    // message. refreshIgToken() is safe to call every tick: its own decision function
    // gates on the expiry window (14 days out) AND a 6h floor between attempts, so the
    // */2 cron does not become 720 Meta calls a day. Gated to `mins % 10` as well, purely
    // to keep the tick cheap. Inert when the row is missing.
    if (mins % 10 === 0) {
      ctx.waitUntil(refreshIgToken(env, sb).then(
        r => { if (!r?.skipped) console.log('[meta-token] ig refresh', JSON.stringify(r)); },
        e => console.error('[meta-token] ig refresh error', e),
      ));
    }

    if (exotelConfigured(env)) {
      const pipe = callPipeline(env);
      ctx.waitUntil(reconcileExotelCalls(env, pipe).then(
        r => console.log('[exotel] cron reconcile', JSON.stringify(r)),
        e => console.error('[exotel] cron reconcile error', e),
      ));
      // Settlement runs less often — Exotel finalises Duration/Price/RecordingUrl
      // ~2 min after a call ends, so a sweep every 10 min catches them all without
      // spending the shared 200/min budget on rows that were never going to be ready.
      if (mins % 10 === 0) {
        ctx.waitUntil(settleExotelCalls(env, pipe, sb).then(
          r => console.log('[exotel] cron settle', JSON.stringify(r)),
          e => console.error('[exotel] cron settle error', e),
        ));
      }
    }
  },
};

// ── Read dispatcher ──────────────────────────────────────────────────────────

async function handleGet(action, params, auth, env) {
  const g = require('cs_ticket_view', auth); if (g) return g;

  switch (action) {
    case 'getMe':            return ok({ ...auth });
    case 'getTickets':       return getTickets(params, auth, env);
    case 'getTicket':        return getTicket(params, auth, env);
    case 'getQueueCounts':   return getQueueCounts(params, auth, env);
    case 'getKpis':          return getKpis(params, auth, env);
    case 'getOverviewSummary': return getOverviewSummary(params, auth, env);
    case 'lookupByUpc':      return lookupByUpc(params, auth, env);
    case 'lookupPastCases':  return lookupPastCases(params, auth, env);
    case 'getStageRules':    return getStageRules(params, auth, env);
    case 'getReports': {
      const g2 = require('cs_reports_view', auth); if (g2) return g2;
      return getReports(params, auth, env);
    }
    case 'getCallReports': {
      const g2 = require('cs_reports_view', auth); if (g2) return g2;
      return getCallReports(params, auth, env);
    }
    case 'getTicketHistory': {
      const g2 = require('cs_reports_view', auth); if (g2) return g2;
      return getTicketHistory(params, auth, env);
    }
    case 'getAgentConversationReport': {
      const g2 = require('cs_reports_view', auth); if (g2) return g2;
      return getAgentConversationReport(params, auth, env);
    }
    case 'getSupportAnalytics': {
      const g2 = require('cs_reports_view', auth); if (g2) return g2;
      return getSupportAnalytics(params, auth, env);
    }
    case 'getAgents':        return getAgents(params, auth, env);
    case 'getIssueCatalog':  return getIssueCatalog(env);
    case 'getDepartments':   return getDepartments(params, auth, env);
    case 'getDeptAgents':    return getDeptAgents(params, auth, env);
    case 'getProductCatalog': return getProductCatalog(params, auth, env);
    case 'getCsAgents':      return getCsAgents(params, auth, env);
    case 'getPresence':      return getPresence(params, auth, env);
    case 'getShifts':        return getShifts(params, auth, env);
    case 'getRoutingConfig': return getRoutingConfig(params, auth, env);
    case 'getTags':          return getTags(params, auth, env);
    case 'getCannedResponses': return getCannedResponses(params, auth, env);
    case 'getMyopAccounts':  return getMyopAccounts(params, auth, env);
    case 'getCalls':         return getCalls(params, auth, env);
    case 'getCall':          return getCall(params, auth, env);
    case 'getCallsKpis':     return getCallsKpis(params, auth, env);
    case 'getExotelHealth':  return getExotelHealth(params, auth, env);
    case 'getCallRecording': return getCallRecording(params, auth, env);
    case 'getCallContext':   return getCallContext(params, auth, env);
    case 'getTelephonyAgents': return getTelephonyAgents(params, auth, env);
    case 'getSoftphoneToken': {
      // Any authed CS user may ask; the handler itself 404s unless they are an
      // active SIP agent, which is what gates the SDK download in the browser.
      return makeSoftphone({ env, sb, ok, err }).getSoftphoneToken(params, auth);
    }
    case 'getWaThread':      return getWaThread(params, auth, env);
    case 'getWaTemplates':   return getWaTemplates(params, auth, env);
    case 'getWaSendTemplates': return getWaSendTemplates(params, auth, env);
    case 'getWaNumbers':     return getWaNumbers(params, auth, env);
    case 'getMessagingThreads': return getMessagingThreads(params, auth, env);
    case 'getMessagingThread':  return getMessagingThread(params, auth, env);
    case 'getWaConversation':   return getWaConversation(params, auth, env);
    case 'getMessagingStats':   return getMessagingStats(params, auth, env);
    case 'getClosureRequests':  return getClosureRequests(params, auth, env);
    case 'getAgentInboxCounts': return getAgentInboxCounts(params, auth, env);
    case 'getEmailAttachment':  return getEmailAttachment(params, auth, env);
    case 'searchShopifyCustomer':
      return ok(await shopifyLookup({ phone: params.get('phone'), email: params.get('email') }, env));
    default:
      return err(`Unknown action: ${action}`, 404);
  }
}

// ── Write dispatcher ─────────────────────────────────────────────────────────

async function handlePost(action, body, auth, env, request) {
  switch (action) {
    case 'createTicket':     return createTicket(body, auth, env);
    case 'updateTicket':     return updateTicket(body, auth, env);
    case 'switchResolution': return switchResolution(body, auth, env);
    case 'advanceStage':     return advanceStage(body, auth, env, request);
    case 'assignAgent':      return assignAgent(body, auth, env);
    case 'addNote':          return addNote(body, auth, env);
    case 'addAttachment':    return addAttachment(body, auth, env);
    case 'linkTicket':       return linkTicket(body, auth, env);
    case 'cancelTicket':     return cancelTicket(body, auth, env);
    case 'escalateTicket':   return escalateTicket(body, auth, env);
    case 'closeTicket':      return closeTicket(body, auth, env);
    case 'requestTicketClosure': return requestTicketClosure(body, auth, env);
    case 'approveTicketClosure': return approveTicketClosure(body, auth, env);
    case 'rejectTicketClosure':  return rejectTicketClosure(body, auth, env);
    case 'placeCall':        return placeCall(body, auth, env);
    case 'softphoneSetup': {
      const g = require('cs_ticket_admin', auth); if (g) return g;
      return makeSoftphone({ env, sb, ok, err }).softphoneSetup(body, auth);
    }
    case 'setTelephonyAgent': return setTelephonyAgent(body, auth, env);
    case 'runExotelBackfill': return runExotelBackfill(body, auth, env);
    case 'createMyopAccount': return createMyopAccount(body, auth, env);
    case 'updateMyopAccount': return updateMyopAccount(body, auth, env);
    case 'createDepartment':     return createDepartment(body, auth, env);
    case 'updateDepartment':     return updateDepartment(body, auth, env);
    case 'assignUserDepartment': return assignUserDepartment(body, auth, env);
    case 'setUserDepartments':   return setUserDepartments(body, auth, env);
    case 'setCsRole':            return setCsRole(body, auth, env);
    case 'setPresence':          return setPresence(body, auth, env);
    case 'heartbeat':            return heartbeat(body, auth, env);
    case 'setShift':             return setShift(body, auth, env);
    case 'setAgentShift':        return setAgentShift(body, auth, env);
    case 'setThreadState':       return setThreadState(body, auth, env);
    case 'dismissCollabFlag':    return dismissCollabFlag(body, auth, env);
    case 'markThreadRead':       return markThreadRead(body, auth, env);
    case 'setRoutingConfig':     return setRoutingConfig(body, auth, env);
    case 'setRoutingAgents':     return setRoutingAgents(body, auth, env);
    case 'createTag':            return createTag(body, auth, env);
    case 'updateTag':            return updateTag(body, auth, env);
    case 'deleteTag':            return deleteTag(body, auth, env);
    case 'setTicketTags':        return setTicketTags(body, auth, env);
    case 'refreshShipment':      return refreshShipment(body, auth, env);
    case 'setThreadTags':        return setThreadTags(body, auth, env);
    case 'setMyopDefaultDepartment': return setMyopDefaultDepartment(body, auth, env);
    case 'markCalledBack':           return markCalledBack(body, auth, env);
    case 'createTicketFromCall':     return createTicketFromCall(body, auth, env);
    case 'sendWaMessage':            return sendWaMessage(body, auth, env);
    case 'sendWaReply':              return sendWaReply(body, auth, env);
    case 'sendWaAttachment':         return sendWaAttachment(body, auth, env);
    case 'sendWaTemplateReply':      return sendWaTemplateReply(body, auth, env);
    case 'startWaConversation':      return startWaConversation(body, auth, env);
    case 'startEmailConversation':   return startEmailConversation(body, auth, env);
    case 'sendMetaMessage':          return sendMetaMessage(body, auth, env);
    case 'diagIgPageRoute':          return diagIgPageRoute(body, auth, env);   // TEMPORARY — remove after the S263 human_agent test
    case 'diagIgRecipient':          return diagIgRecipient(body, auth, env);   // read-only: why does Meta refuse THIS recipient
    case 'sendMetaAttachment':       return sendMetaAttachment(body, auth, env);
    case 'sendEmailReply':           return sendEmailReply(body, auth, env);
    case 'syncGmailNow':             return syncGmailNow(body, auth, env);
    case 'backfillEmailAttachments': return backfillEmailAttachments(body, auth, env);
    case 'backfillPurchaseDates':    return backfillPurchaseDates(body, auth, env);
    case 'linkMessagingThread':      return linkMessagingThread(body, auth, env);
    case 'assignThread':             return assignThread(body, auth, env);
    case 'transferThread':           return transferThread(body, auth, env);
    case 'transferThreadToIgnition': return transferThreadToIgnition(body, auth, env);
    case 'bulkAssignThreads':        return bulkAssignThreads(body, auth, env);
    case 'bulkSetThreadState':      return bulkSetThreadState(body, auth, env);
    case 'setThreadPriority':        return setThreadPriority(body, auth, env);
    case 'createTicketFromThread':   return createTicketFromThread(body, auth, env);
    case 'addThreadNote':            return addThreadNote(body, auth, env);
    case 'createCannedResponse':     return createCannedResponse(body, auth, env);
    case 'updateCannedResponse':     return updateCannedResponse(body, auth, env);
    case 'recordInboundWaStub':      return recordInboundWaStub(body, auth, env);
    case 'createWaTemplate':         return createWaTemplate(body, auth, env);
    case 'updateWaTemplate':         return updateWaTemplate(body, auth, env);
    default:
      return err(`Unknown action: ${action}`, 404);
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

async function getTickets(params, auth, env) {
  const tab = params.get('tab') || 'open';
  const search = (params.get('search') || '').trim();
  const limit = Math.min(parseInt(params.get('limit') || '50'), 200);
  const offset = parseInt(params.get('offset') || '0');

  const filters = [];

  // Visibility scope: dept default-filter (admins override via ?department=<slug>|all)
  // + operator self-scope (own + unassigned). 404 on unknown slug.
  const scope = await visibilityFilters(params, auth, env);
  if (!scope) return err(`Unknown department slug`, 404);
  filters.push(...scope);

  // tab → preset filter
  if (tab === 'my')                filters.push(`assigned_agent_id=eq.${auth.userId}`, `closed_at=is.null`);
  else if (tab === 'open')         filters.push(`closed_at=is.null`);
  else if (tab === 'awaiting')     filters.push(`stage=eq.awaiting_evidence`, `closed_at=is.null`);
  else if (tab === 'logistics')    filters.push(`stage=in.(pickup_scheduled,picked_up,at_warehouse)`, `closed_at=is.null`);
  else if (tab === 'inspection')   filters.push(`stage=eq.inspected`, `closed_at=is.null`);
  else if (tab === 'resolution')   filters.push(`stage=in.(replacement_dispatched,refund_initiated,refund_completed,handed_to_production,repaired_ready,repair_dispatched)`, `closed_at=is.null`);
  else if (tab === 'closed')       filters.push(`closed_at=not.is.null`);
  else if (tab === 'escalated')    filters.push(`stage=eq.escalated`);

  // Optional explicit filters (override tab presets if both present)
  const disposition = params.get('disposition');
  if (disposition) filters.push(`disposition=eq.${encodeURIComponent(disposition)}`);
  const category = params.get('category');
  if (category) filters.push(`issue_category=eq.${encodeURIComponent(category)}`);
  const platform = params.get('platform');
  if (platform) filters.push(`platform=eq.${encodeURIComponent(platform)}`);
  const stage = params.get('stage');
  if (stage) filters.push(`stage=eq.${encodeURIComponent(stage)}`);
  const agent = params.get('agent');
  if (agent) filters.push(`assigned_agent_id=eq.${encodeURIComponent(agent)}`);
  const createdBy = params.get('created_by');
  if (createdBy) filters.push(`created_by_user_id=eq.${encodeURIComponent(createdBy)}`);
  const tagFilter = params.get('tag');                       // tag facet (S163)
  if (tagFilter) {
    const tagged = await idsWithTag('ticket', tagFilter, env);
    if (!tagged.length) return ok({ tickets: [], offset, limit });
    filters.push(`id=in.(${tagged.join(',')})`);
  }

  // Multi-token AND-of-OR search
  if (search) {
    const tokens = search.split(/\s+/).filter(Boolean);
    for (const tok of tokens) {
      const enc = encodeURIComponent(`*${tok}*`);
      filters.push(
        `or=(customer_name.ilike.${enc},customer_phone.ilike.${enc},customer_email.ilike.${enc},ticket_no.ilike.${enc},external_order_id.ilike.${enc},lot_unit_upc.ilike.${enc})`
      );
    }
  }

  // Sort axis (Pruthvi #bugs 2026-07-15): newest (default) | oldest | due (SLA soonest) | updated.
  const sort = params.get('sort') || 'newest';
  const ORDERS = {
    newest:  'created_at.desc',
    oldest:  'created_at.asc',
    due:     'due_at.asc.nullslast',
    updated: 'stage_changed_at.desc.nullslast',
  };
  const orderClause = `order=${ORDERS[sort] || ORDERS.newest}`;
  const path = `/rest/v1/cs_tickets?select=id,ticket_no,created_at,customer_name,customer_phone,product,product_model,product_color,platform,external_order_id,disposition,issue_category,issue_subcategory,issue_subcategory_custom,stage,stage_changed_at,assigned_agent_id,assigned_agent_name,due_at,closed_at,auto_created&${filters.join('&')}&${orderClause}&limit=${limit}&offset=${offset}`;

  const res = await sb(path, env, {
    headers: { Prefer: 'count=exact' },
  });
  if (!res.ok) return err(`Failed to fetch tickets: ${JSON.stringify(res.data)}`, res.status);

  const tickets = res.data || [];
  const tagsByTicket = await fetchTagsFor('ticket', tickets.map(t => t.id), env);
  return ok({ tickets: tickets.map(t => ({ ...t, tags: tagsByTicket[t.id] || [] })), offset, limit });
}

async function getTicket(params, auth, env) {
  const ticket_no = params.get('ticket_no');
  if (!ticket_no) return err('ticket_no required');

  const tRes = await sb(
    `/rest/v1/cs_tickets?ticket_no=eq.${encodeURIComponent(ticket_no)}&select=*&limit=1`,
    env,
  );
  if (!tRes.ok || !tRes.data?.[0]) return err('Ticket not found', 404);
  const ticket = tRes.data[0];

  // Fetch children + enrichments in parallel
  const [historyRes, attachRes, notesRes, linksRes, dispatchInfo, pastCases, repairRun] = await Promise.all([
    sb(`/rest/v1/cs_ticket_history?ticket_id=eq.${ticket.id}&select=*&order=changed_at.desc`, env),
    sb(`/rest/v1/cs_ticket_attachments?ticket_id=eq.${ticket.id}&select=*&order=added_at.desc`, env),
    sb(`/rest/v1/cs_ticket_notes?ticket_id=eq.${ticket.id}&select=*&order=created_at.desc`, env),
    sb(`/rest/v1/cs_ticket_links?ticket_id=eq.${ticket.id}&select=*,related:related_ticket_id(id,ticket_no,disposition,stage,customer_name)`, env),
    ticket.lot_unit_upc ? fetchDispatchInfo(ticket.lot_unit_upc, env) : Promise.resolve(null),
    ticket.customer_phone ? fetchPastCases(ticket.customer_phone, ticket.id, env) : Promise.resolve([]),
    ticket.repair_run_id ? sb(`/rest/v1/production_runs?id=eq.${ticket.repair_run_id}&select=run_no,status,completed_at`, env) : Promise.resolve({ data: null }),
  ]);

  let updatedTicket = ticket;

  // Lazy repair auto-advance
  if (
    ticket.disposition === 'repair' &&
    ticket.repair_run_id &&
    ['handed_to_production', 'repaired_ready'].includes(ticket.stage) &&
    repairRun?.data?.[0]?.status === 'Completed' &&
    ticket.stage === 'handed_to_production'
  ) {
    // Auto-advance to repaired_ready
    const advRes = await sb(
      `/rest/v1/cs_tickets?id=eq.${ticket.id}`,
      env,
      {
        method: 'PATCH',
        body: JSON.stringify({ stage: 'repaired_ready', stage_changed_at: new Date().toISOString() }),
        prefer: 'return=representation',
      },
    );
    if (advRes.ok && advRes.data?.[0]) {
      updatedTicket = advRes.data[0];
      await sb(`/rest/v1/cs_ticket_history`, env, {
        method: 'POST',
        body: JSON.stringify({
          ticket_id: ticket.id,
          changed_by_name: 'csops (auto)',
          field_name: 'stage',
          old_value: 'handed_to_production',
          new_value: 'repaired_ready',
          note: 'Auto-advanced from linked production_runs.status=Completed',
        }),
      });
    }
  }

  const tagsByTicket = await fetchTagsFor('ticket', [ticket.id], env);
  return ok({
    ticket: updatedTicket,
    history: historyRes.data || [],
    attachments: attachRes.data || [],
    notes: notesRes.data || [],
    links: linksRes.data || [],
    dispatch_info: dispatchInfo,
    past_cases: pastCases,
    repair_run: repairRun?.data?.[0] || null,
    tags: tagsByTicket[ticket.id] || [],
    // Outbound parcel state for THIS ticket's order. Surfaced on the ticket (not just the
    // Shopify panel) so an RTO or an already-delivered parcel is visible without the agent
    // going to look — that changes how the conversation opens.
    shipment: await fetchTicketShipment(updatedTicket, env),
    // When each lifecycle stage was first reached, so the spine can carry dates. Derived from
    // the history we already fetched — no extra query. FIRST occurrence per stage: a ticket can
    // be bounced back to an earlier stage, and the spine should show when it was first reached,
    // not when it was last re-entered.
    stage_dates: stageDates(historyRes.data || [], updatedTicket),
  });
}

function stageDates(history, ticket) {
  const out = {};
  for (const h of history) {
    if (h.field_name !== 'stage' || !h.new_value) continue;
    const at = h.changed_at;
    if (!out[h.new_value] || at < out[h.new_value]) out[h.new_value] = at;
  }
  // `intake` is the opening stage, so it never appears as a TRANSITION in the history.
  if (!out.intake && ticket?.created_at) out.intake = ticket.created_at;
  if (!out.closed && ticket?.closed_at) out.closed = ticket.closed_at;
  return out;
}

// Pre-flight for the service bindings. A Worker cannot fetch() another Worker on the same
// workers.dev zone (Cloudflare error 1042), so csops MUST reach commsops and odoops over
// bindings — and a missing binding degrades to exactly the broken route. This proves both are
// wired without needing a Google login, and is the check to run before flipping WA_TRANSPORT.
async function pingBindings(env) {
  const out = {};
  for (const [name, b, path] of [['commsops', env.COMMSOPS, '/health'], ['odoops', env.ODOOPS, '/health']]) {
    if (!b || typeof b.fetch !== 'function') { out[name] = { bound: false }; continue; }
    try {
      const r = await b.fetch(new Request(`https://internal${path}`));
      out[name] = { bound: true, status: r.status };
    } catch (e) { out[name] = { bound: true, error: String(e?.message || e).slice(0, 120) }; }
  }
  return out;
}

// Agent-triggered courier refresh (the ⟳ on the shipment line). The hourly Uniware poll can be
// up to an hour stale, which is exactly when it matters — an agent on a call. Goes to odoops
// over the ODOOPS service binding; a plain fetch() to odoops.workers.dev would 404 with
// Cloudflare error 1042 (same-zone worker-to-worker). Returns the refreshed row so the UI can
// re-render without a second round trip.
async function refreshShipment(body, auth, env) {
  const order = String(body?.order_no || '').trim();
  if (!order) return err('order_no required');
  const withHash = order.startsWith('#') ? order : `#${order}`;
  if (!/^#LOT/i.test(withHash)) return err('Not a website order — no courier record to refresh', 422);
  try {
    const res = await callWorker(env.ODOOPS, env, '/internal/uniware-probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.ODOOPS_INTERNAL_TOKEN}` },
      body: JSON.stringify({ op: 'refreshOrder', order: withHash }),
    });
    if (!res.ok) {
      // 404 = we have never tracked this order (pre-backfill, or a marketplace parcel).
      return res.status === 404
        ? err('No courier record for this order yet', 404)
        : err(`Courier refresh failed (${res.status})`, 502);
    }
  } catch (e) { return err(`Courier refresh failed: ${e?.message || e}`, 502); }
  const r = await sbPublic(`/rest/v1/ecom_shipments?shopify_order_name=eq.${encodeURIComponent(withHash)}`
    + `&select=courier,shipping_provider,tracking_number,tracking_link,lifecycle,package_status,`
    + `courier_status,dispatched_at,delivered_at,uniware_updated_at,is_cod,collectable_amount,collected_amount`
    + `&order=uniware_updated_at.desc.nullslast&limit=1`, env);
  const row = (r.ok && Array.isArray(r.data) && r.data[0]) || null;
  if (!row) return err('No courier record for this order yet', 404);
  return ok({
    courier: row.courier, provider: row.shipping_provider,
    awb: row.tracking_number, tracking_link: row.tracking_link,
    lifecycle: row.lifecycle, label: SHIPMENT_LIFECYCLE_LABEL[row.lifecycle] || row.lifecycle,
    alert: SHIPMENT_ALERT.has(row.lifecycle),
    package_status: row.package_status, courier_status: row.courier_status,
    dispatched_at: row.dispatched_at, delivered_at: row.delivered_at, as_of: row.uniware_updated_at,
    is_cod: row.is_cod, cod_collectable: row.collectable_amount, cod_collected: row.collected_amount,
  });
}

// Resolve a ticket's outbound shipment. Tickets store external_order_id in mixed shapes —
// '#LOT25126', bare 'LOT25126', an Amazon id ('043-…'), a Shopflo ULID — so match the two
// Shopify-name forms and return null for everything else rather than guessing.
async function fetchTicketShipment(ticket, env) {
  try {
    const raw = String(ticket?.external_order_id || '').trim();
    if (!raw) return null;
    const withHash = raw.startsWith('#') ? raw : `#${raw}`;
    if (!/^#LOT/i.test(withHash)) return null;      // marketplace order — never a Uniware website parcel
    const r = await sbPublic(`/rest/v1/ecom_shipments?shopify_order_name=eq.${encodeURIComponent(withHash)}`
      + `&select=courier,shipping_provider,tracking_number,tracking_link,lifecycle,package_status,`
      + `courier_status,dispatched_at,delivered_at,uniware_updated_at,is_cod,collectable_amount,collected_amount`
      + `&order=uniware_updated_at.desc.nullslast&limit=1`, env);
    const row = (r.ok && Array.isArray(r.data) && r.data[0]) || null;
    if (!row) return null;
    return {
      courier: row.courier, provider: row.shipping_provider,
      awb: row.tracking_number, tracking_link: row.tracking_link,
      lifecycle: row.lifecycle, label: SHIPMENT_LIFECYCLE_LABEL[row.lifecycle] || row.lifecycle,
      alert: SHIPMENT_ALERT.has(row.lifecycle),
      package_status: row.package_status, courier_status: row.courier_status,
      dispatched_at: row.dispatched_at, delivered_at: row.delivered_at, as_of: row.uniware_updated_at,
      is_cod: row.is_cod, cod_collectable: row.collectable_amount, cod_collected: row.collected_amount,
    };
  } catch (_) { return null; }   // enrichment only — never fail the ticket load
}

async function fetchDispatchInfo(upc, env) {
  // unit → product_master, dispatch_allocations, dispatch_shipments
  const [unitRes, allocRes] = await Promise.all([
    sbPublic(`/rest/v1/units?upc=eq.${encodeURIComponent(upc)}&select=upc,product,model,color,sku,current_status,production_run_id&limit=1`, env),
    sbPublic(`/rest/v1/dispatch_allocations?unit_upc=eq.${encodeURIComponent(upc)}&select=*&order=allocated_at.desc&limit=1`, env),
  ]);
  if (!unitRes.ok || !unitRes.data?.[0]) return null;
  const unit = unitRes.data[0];
  let shipment = null;
  const alloc = allocRes.data?.[0];
  if (alloc?.shipment_id) {
    const shipRes = await sbPublic(`/rest/v1/dispatch_shipments?id=eq.${alloc.shipment_id}&select=*&limit=1`, env);
    shipment = shipRes.data?.[0] || null;
  }
  return { unit, allocation: alloc || null, shipment };
}

async function fetchPastCases(phone, excludeTicketId, env) {
  const filters = [`customer_phone=eq.${encodeURIComponent(phone)}`];
  if (excludeTicketId) filters.push(`id=neq.${excludeTicketId}`);
  const path = `/rest/v1/cs_tickets?${filters.join('&')}&select=ticket_no,disposition,issue_category,issue_subcategory,stage,created_at,closed_at,closed_reason&order=created_at.desc&limit=5`;
  const res = await sb(path, env);
  return res.data || [];
}

async function getQueueCounts(params, auth, env) {
  // 7 counts; uses HEAD + Prefer: count=exact pattern via PostgREST returns count via Content-Range
  // Simpler: SELECT count(*) FROM cs_tickets WHERE ... via a single RPC OR multiple cheap queries
  // We'll use a single SQL function via /rest/v1/rpc to keep subrequests low.
  // Scope counts to what the caller may see, so tab badges match the list.
  const scope = await visibilityFilters(params, auth, env);
  if (!scope) return err(`Unknown department slug`, 404);
  const scopeQs = scope.length ? `&${scope.join('&')}` : '';
  // Optional assigned-agent filter — keeps the tab badges in lock-step with the
  // agent-filtered list (getTickets ?agent=). Skipped for the 'my' tab, which is
  // always the viewer's own queue.
  const agent = params.get('agent');
  const agentQs = agent ? `&assigned_agent_id=eq.${encodeURIComponent(agent)}` : '';
  const tabs = {
    my:         `?assigned_agent_id=eq.${auth.userId}&closed_at=is.null&select=id`,
    open:       `?closed_at=is.null&select=id`,
    awaiting:   `?stage=eq.awaiting_evidence&closed_at=is.null&select=id`,
    logistics:  `?stage=in.(pickup_scheduled,picked_up,at_warehouse)&closed_at=is.null&select=id`,
    inspection: `?stage=eq.inspected&closed_at=is.null&select=id`,
    resolution: `?stage=in.(replacement_dispatched,refund_initiated,refund_completed,handed_to_production,repaired_ready,repair_dispatched)&closed_at=is.null&select=id`,
    closed:     `?closed_at=not.is.null&select=id`,
  };
  const results = {};
  const entries = Object.entries(tabs);
  // Parallel — 7 subrequests, well under budget
  const responses = await Promise.all(entries.map(([k, qs]) =>
    sb(`/rest/v1/cs_tickets${qs}${scopeQs}${k === 'my' ? '' : agentQs}&limit=5000`, env, {
      headers: { Prefer: 'count=exact' },
    })
  ));
  for (let i = 0; i < entries.length; i++) {
    const [k] = entries[i];
    // count is exposed via Content-Range; we asked PostgREST for it but sb() doesn't surface headers.
    // Workaround: re-issue a HEAD-style query — easier to just fetch ids and length-check up to a cap.
    // For accuracy, use HEAD via a small Range trick; here keep simple: count rows up to 5000.
    results[k] = (responses[i].data || []).length;
  }
  return ok(results);
}

async function getKpis(params, auth, env) {
  const nowIso = new Date().toISOString();
  const startOfTodayIso = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  // Scope tiles to what the caller may see (dept + operator self-scope), so an
  // operator's Overdue / Awaiting / Closed counts reflect only their own tickets.
  const scope = await visibilityFilters(params, auth, env);
  if (!scope) return err(`Unknown department slug`, 404);
  const scopeQs = scope.length ? `&${scope.join('&')}` : '';

  const [myOpen, overdue, awaitingOld, closedToday, mtdClosed] = await Promise.all([
    sb(`/rest/v1/cs_tickets?assigned_agent_id=eq.${auth.userId}&closed_at=is.null&select=id&limit=5000`, env),
    sb(`/rest/v1/cs_tickets?closed_at=is.null&due_at=lt.${encodeURIComponent(nowIso)}&select=id&limit=5000${scopeQs}`, env),
    sb(`/rest/v1/cs_tickets?stage=eq.awaiting_evidence&closed_at=is.null&stage_changed_at=lt.${encodeURIComponent(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString())}&select=id&limit=5000${scopeQs}`, env),
    sb(`/rest/v1/cs_tickets?closed_at=gte.${encodeURIComponent(startOfTodayIso)}&select=id&limit=5000${scopeQs}`, env),
    sb(`/rest/v1/cs_tickets?closed_at=gte.${encodeURIComponent(startOfMonth.toISOString())}&select=created_at,closed_at&limit=5000${scopeQs}`, env),
  ]);

  // Avg close days MTD
  const closeds = mtdClosed.data || [];
  let avg = null;
  if (closeds.length) {
    const sum = closeds.reduce((s, t) =>
      s + (new Date(t.closed_at).getTime() - new Date(t.created_at).getTime()), 0);
    avg = +(sum / closeds.length / (24 * 60 * 60 * 1000)).toFixed(1);
  }

  return ok({
    my_open: (myOpen.data || []).length,
    overdue: (overdue.data || []).length,
    awaiting_evidence_old: (awaitingOld.data || []).length,
    closed_today: (closedToday.data || []).length,
    avg_close_days_mtd: avg,
  });
}

// getOverviewSummary — the CS lead's "what needs me now" command view in ONE
// dept-scoped, server-computed call. Returns the point-in-time KPI/exception
// counts (open / SLA breached / evidence aging / unassigned / refunds pending)
// + EXACT per-agent open load (grouped over the whole dept, not a client
// sample). Calls KPIs stay in getCallsKpis; ranged calls/resolved stay in
// getReports/getCallReports. Scope = the same dept + operator self-scope as
// getKpis/getTickets (so an operator sees only their own slice).
async function getOverviewSummary(params, auth, env) {
  const nowIso = new Date().toISOString();
  // IST start-of-day for "resolved today"
  const istMidnight = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  istMidnight.setHours(0, 0, 0, 0);
  const startOfTodayIso = istMidnight.toISOString();
  const agingIso = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

  const scope = await visibilityFilters(params, auth, env);
  if (!scope) return err('Unknown department slug', 404);
  const scopeQs = scope.length ? `&${scope.join('&')}` : '';

  const [openR, slaR, awaitingR, resolvedR, unassignedR, refundsR, agentRowsR, rosterR, membersR, createdTodayR] = await Promise.all([
    sb(`/rest/v1/cs_tickets?closed_at=is.null&select=id&limit=5000${scopeQs}`, env),
    sb(`/rest/v1/cs_tickets?closed_at=is.null&due_at=lt.${encodeURIComponent(nowIso)}&select=created_at&order=created_at.asc&limit=5000${scopeQs}`, env),
    sb(`/rest/v1/cs_tickets?stage=eq.awaiting_evidence&closed_at=is.null&stage_changed_at=lt.${encodeURIComponent(agingIso)}&select=id&limit=5000${scopeQs}`, env),
    sb(`/rest/v1/cs_tickets?closed_at=gte.${encodeURIComponent(startOfTodayIso)}&select=id&limit=5000${scopeQs}`, env),
    sb(`/rest/v1/cs_tickets?closed_at=is.null&assigned_agent_id=is.null&select=auto_created&limit=5000${scopeQs}`, env),
    sb(`/rest/v1/cs_tickets?closed_at=is.null&disposition=eq.refund&stage=eq.inspected&select=refund_amount_inr&limit=5000${scopeQs}`, env),
    sb(`/rest/v1/cs_tickets?closed_at=is.null&assigned_agent_id=not.is.null&select=assigned_agent_id,assigned_agent_name&limit=5000${scopeQs}`, env),
    sb(`/rest/v1/users_profile?active=eq.true&select=id,full_name,role,cs_department_id&order=full_name.asc&limit=500`, env),
    sb(`/rest/v1/cs_user_departments?select=user_id`, env),
    sb(`/rest/v1/cs_tickets?created_at=gte.${encodeURIComponent(startOfTodayIso)}&select=created_at&limit=5000${scopeQs}`, env),
  ]);

  // Tickets created per IST hour today (0-23) — for the Overview hourly chart.
  const hourBuckets = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }));
  for (const t of (createdTodayR.data || [])) {
    if (!t.created_at) continue;
    const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }).format(new Date(t.created_at))) % 24;
    if (h >= 0 && h < 24) hourBuckets[h].count += 1;
  }

  const sla = slaR.data || [];
  const slaOldestDays = sla.length
    ? Math.floor((Date.now() - new Date(sla[0].created_at).getTime()) / (24 * 60 * 60 * 1000))
    : 0;

  const unassignedRows = unassignedR.data || [];
  const refunds = refundsR.data || [];
  const refundsTotal = refunds.reduce((s, r) => s + (Number(r.refund_amount_inr) || 0), 0);

  // EXACT per-agent open load — seed from the CS-TEAM roster (so idle agents show
  // at 0) then add the grouped open counts. NOT every cs_ticket_manage holder: the
  // generic admin/super_admin roles carry that perm via the catch-all grant, which
  // floods the widget with non-CS org users. CS-team = a CS-tier role OR a CS-dept
  // member (mirrors getCsAgents, S162/S163).
  const CS_ROLES = new Set(['cs_agent', 'cs_lead']);
  const inCsDept = new Set((membersR.data || []).map(m => m.user_id));
  const agentMap = {};
  for (const u of (rosterR.data || [])) {
    if (CS_ROLES.has(u.role) || !!u.cs_department_id || inCsDept.has(u.id)) {
      agentMap[u.id] = { user_id: u.id, name: u.full_name || '—', open: 0 };
    }
  }
  for (const t of (agentRowsR.data || [])) {
    const id = t.assigned_agent_id;
    if (!id) continue;
    if (!agentMap[id]) agentMap[id] = { user_id: id, name: t.assigned_agent_name || '—', open: 0 };
    agentMap[id].open += 1;
  }
  const agents = Object.values(agentMap).sort((a, b) => b.open - a.open);

  return ok({
    open: (openR.data || []).length,
    sla_breached: sla.length,
    sla_oldest_days: slaOldestDays,
    awaiting_evidence: (awaitingR.data || []).length,
    resolved_today: (resolvedR.data || []).length,
    unassigned: unassignedRows.length,
    unassigned_from_calls: unassignedRows.filter(t => t.auto_created).length,
    refunds_pending: refunds.length,
    refunds_total_inr: refundsTotal,
    agents,
    created_today_hourly: hourBuckets,
  });
}

// getTicketHistory — ticket-creation time series for the History page.
// Buckets cs_tickets.created_at by day / week (ISO, Mon-start) / month over
// [from,to], split into auto-created (call requests) vs manual. Dept-scoped
// (mirrors getReports — dept filter only, gated by cs_reports_view in the
// dispatcher). Bucketed in-worker (current volume is well under the row cap).
async function getTicketHistory(params, auth, env) {
  const granularity = ['day', 'week', 'month'].includes(params.get('granularity')) ? params.get('granularity') : 'day';
  const to = params.get('to') ? new Date(params.get('to')) : new Date();
  const from = params.get('from') ? new Date(params.get('from')) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const deptFilter = await resolveDeptFilter(params.get('department'), auth, env);
  if (!deptFilter) return err('Unknown department slug', 404);
  const deptClause = (() => { const c = buildDeptFilter(deptFilter); return c ? `&${c}` : ''; })();

  const path = `/rest/v1/cs_tickets?created_at=gte.${encodeURIComponent(from.toISOString())}&created_at=lt.${encodeURIComponent(to.toISOString())}&select=created_at,auto_created&order=created_at.asc&limit=10000${deptClause}`;
  const res = await sb(path, env);
  if (!res.ok) return err(`Failed to load ticket history: ${JSON.stringify(res.data)}`, res.status);

  // IST-anchored bucket key.
  const istParts = (iso) => {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
    const g = (t) => p.find(x => x.type === t)?.value;
    return { y: Number(g('year')), m: Number(g('month')), d: Number(g('day')) };
  };
  const bucketKey = (iso) => {
    const { y, m, d } = istParts(iso);
    if (granularity === 'month') return `${y}-${String(m).padStart(2, '0')}`;
    if (granularity === 'week') {
      // ISO week start (Monday), computed on the IST calendar date.
      const dt = new Date(Date.UTC(y, m - 1, d));
      const dow = (dt.getUTCDay() + 6) % 7; // 0=Mon
      dt.setUTCDate(dt.getUTCDate() - dow);
      return dt.toISOString().slice(0, 10);
    }
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };

  const map = {};
  for (const t of (res.data || [])) {
    if (!t.created_at) continue;
    const k = bucketKey(t.created_at);
    if (!map[k]) map[k] = { bucket: k, total: 0, auto: 0, manual: 0 };
    map[k].total += 1;
    if (t.auto_created) map[k].auto += 1; else map[k].manual += 1;
  }
  const series = Object.values(map).sort((a, b) => (a.bucket < b.bucket ? -1 : 1));
  return ok({ granularity, from: from.toISOString(), to: to.toISOString(), total: (res.data || []).length, series });
}

// Normalize a scanned/typed/spoken UPC to the canonical LOT-XXXXXXXX form.
// The unit's QR encodes "LOT-00081760"; the printed human-readable is
// "<product_code><serial>" e.g. "SHAK00081760" (Redline apps/redline .../upc/page.js).
// Agents or customers may read out the human-readable or bare digits, so resolve
// LOT-00081760 / lot-81760 / 00081760 / 81760 / SHAK00081760 → LOT-<8-pad>.
// No trailing digits → returned unchanged (exact-match fallback).
function normalizeUpc(raw) {
  const s = String(raw || '').trim();
  if (!s) return s;
  const m = s.match(/(\d+)\s*$/);   // trailing run of digits = the serial
  return (m && m[1]) ? 'LOT-' + m[1].padStart(8, '0') : s;
}

async function lookupByUpc(params, auth, env) {
  const raw = params.get('upc');
  if (!raw) return err('upc required');
  const info = await fetchDispatchInfo(normalizeUpc(raw), env);
  return ok(info);
}

async function lookupPastCases(params, auth, env) {
  const phone = params.get('phone');
  const order_id = params.get('order_id');
  const upc = params.get('upc');
  const exclude = params.get('exclude_ticket_id');

  if (!phone && !order_id && !upc) return err('phone, order_id, or upc required');

  const orFilters = [];
  if (phone)    orFilters.push(`customer_phone.eq.${encodeURIComponent(phone)}`);
  if (order_id) orFilters.push(`external_order_id.eq.${encodeURIComponent(order_id)}`);
  if (upc)      orFilters.push(`lot_unit_upc.eq.${encodeURIComponent(upc)}`);

  const filters = [`or=(${orFilters.join(',')})`];
  if (exclude) filters.push(`id=neq.${exclude}`);
  filters.push(`order=created_at.desc`, `limit=5`,
    `select=ticket_no,disposition,issue_category,issue_subcategory,stage,created_at,closed_at,closed_reason,product,product_model`);

  const res = await sb(`/rest/v1/cs_tickets?${filters.join('&')}`, env);
  return ok(res.data || []);
}

async function getStageRules(params, auth, env) {
  const ticket_no = params.get('ticket_no');
  if (!ticket_no) return err('ticket_no required');
  const tRes = await sb(`/rest/v1/cs_tickets?ticket_no=eq.${encodeURIComponent(ticket_no)}&select=stage,disposition&limit=1`, env);
  const t = tRes.data?.[0];
  if (!t) return err('Ticket not found', 404);
  return ok({
    current: t.stage,
    disposition: t.disposition,
    allowed: allowedTransitions(t.stage, t.disposition),
  });
}

async function getReports(params, auth, env) {
  const from = params.get('from') || (() => { const d = new Date(); d.setMonth(0, 1); d.setHours(0,0,0,0); return d.toISOString(); })();
  const to   = params.get('to')   || new Date().toISOString();

  // Fetch all tickets in range — single query, light columns
  const res = await sb(
    `/rest/v1/cs_tickets?created_at=gte.${encodeURIComponent(from)}&created_at=lte.${encodeURIComponent(to)}&select=created_at,closed_at,disposition,issue_category,product,platform,assigned_agent_id,assigned_agent_name,return_cost_inr,replacement_cost_inr,refund_amount_inr&limit=20000`,
    env,
  );
  if (!res.ok) return err('Failed to load reports data', 500);
  const rows = res.data || [];

  // Conversations handled alongside tickets raised (Pruthvi #bugs 2026-07-25,
  // clarified in-thread: not every conversation becomes a ticket — shipment and
  // general queries often don't). Cheap counts RPC, NOT the full agent report,
  // which does response-time math and would add ~2.5s to the default YTD load.
  // Non-fatal: the ticket panels must still render if this one call fails.
  let conversations = null;
  const convR = await sb('/rest/v1/rpc/cs_conversation_counts', env, {
    method: 'POST',
    body: JSON.stringify({ p_from: from, p_to: to }),
  });
  if (convR.ok) conversations = convR.data || null;

  // Aggregate
  const monthly = {};
  const byDisposition = {};
  const byIssueCategory = {};
  const byProduct = {};
  const byPlatform = {};
  const byAgent = {};
  let totalReturnCost = 0, totalReplacementCost = 0, totalRefundAmount = 0;

  for (const r of rows) {
    const month = (r.created_at || '').slice(0, 7);
    const disp = r.disposition || 'pending';

    // monthly trend (keyed by disposition)
    if (month) {
      monthly[month] = monthly[month] || { month, pending: 0, query: 0, no_action: 0, awaiting_info: 0, replacement: 0, refund: 0, repair: 0, total: 0 };
      monthly[month][disp] = (monthly[month][disp] || 0) + 1;
      monthly[month].total++;
    }

    // by disposition
    byDisposition[disp] = (byDisposition[disp] || 0) + 1;

    // by issue_category (skip null)
    if (r.issue_category) {
      byIssueCategory[r.issue_category] = (byIssueCategory[r.issue_category] || 0) + 1;
    }

    // by product
    const product = r.product || '—';
    byProduct[product] = byProduct[product] || { name: product, total: 0 };
    byProduct[product].total++;
    byProduct[product][disp] = (byProduct[product][disp] || 0) + 1;

    // by platform
    const platform = r.platform || '—';
    byPlatform[platform] = byPlatform[platform] || { name: platform, total: 0 };
    byPlatform[platform].total++;
    byPlatform[platform][disp] = (byPlatform[platform][disp] || 0) + 1;

    // by agent
    const agentName = r.assigned_agent_name || '— unassigned —';
    byAgent[agentName] = byAgent[agentName] || { name: agentName, total: 0, closed: 0, total_close_days: 0 };
    byAgent[agentName].total++;
    if (r.closed_at) {
      byAgent[agentName].closed++;
      byAgent[agentName].total_close_days += (new Date(r.closed_at).getTime() - new Date(r.created_at).getTime()) / (24*60*60*1000);
    }

    totalReturnCost      += Number(r.return_cost_inr || 0);
    totalReplacementCost += Number(r.replacement_cost_inr || 0);
    totalRefundAmount    += Number(r.refund_amount_inr || 0);
  }

  // Finalise agent averages
  for (const k of Object.keys(byAgent)) {
    const a = byAgent[k];
    a.avg_close_days = a.closed ? +(a.total_close_days / a.closed).toFixed(1) : null;
    delete a.total_close_days;
  }

  return ok({
    range: { from, to, total_rows: rows.length },
    conversations,   // { total, handled, outbound_only, no_history } | null
    monthly_trend: Object.values(monthly).sort((a, b) => a.month.localeCompare(b.month)),
    by_disposition: Object.entries(byDisposition).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    by_issue_category: Object.entries(byIssueCategory).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    by_product:  Object.values(byProduct).sort((a, b) => b.total - a.total),
    by_platform: Object.values(byPlatform).sort((a, b) => b.total - a.total),
    by_agent:    Object.values(byAgent).sort((a, b) => b.total - a.total),
    cost_summary: {
      return_cost_inr:      +totalReturnCost.toFixed(2),
      replacement_cost_inr: +totalReplacementCost.toFixed(2),
      refund_amount_inr:    +totalRefundAmount.toFixed(2),
    },
  });
}

// getAgentConversationReport — agent-wise CONVERSATION report (Pruthvi #bugs 2026-07-25).
//
// Distinct from getReports/getSupportAnalytics, which are TICKET-grain. This is
// cs_wa_threads grain: it answers "how is each agent handling conversations" —
// first-response / response / resolution times, waiting-on state, per channel and
// per tag. Tags only exist on threads (cs_thread_tags), so this filter is not
// expressible on the ticket-grain reports at all.
//
// The whole aggregation is ONE Postgres RPC on purpose: it spans ~12.4k threads x
// ~47k messages, and paging that through the Worker to aggregate in JS is the
// RULE-AUDIT-001 / S220 subrequest trap. One round trip, set-based.
async function getAgentConversationReport(params, auth, env) {
  const from = params.get('from') || (() => { const d = new Date(); d.setMonth(0, 1); d.setHours(0,0,0,0); return d.toISOString(); })();
  const to   = params.get('to')   || new Date().toISOString();
  const channel = params.get('channel') || null;
  const tagId   = params.get('tag_id')  || null;
  // Anything but an explicit 'true' means 24x7 — the honest default, since a
  // business-hours figure silently flatters every response time.
  const businessHours = params.get('business_hours') === 'true';

  const r = await sb('/rest/v1/rpc/cs_agent_conversation_report', env, {
    method: 'POST',
    body: JSON.stringify({
      p_from: from, p_to: to,
      p_channel: channel, p_tag_id: tagId,
      p_business_hours: businessHours,
    }),
  });
  if (!r.ok) return err('Failed to load agent conversation report', 500);
  return ok(r.data || {});
}

// getSupportAnalytics — the Support Analytics Dashboard (Pruthvi #bugs 2026-07-14).
// One scoped cs_tickets fetch → every panel, JS-aggregated (mirrors getReports; volume is
// small). Respects dept + operator visibility. Ageing = created_at(IST) − purchase_date.
// Spec: docs/superpowers/specs/2026-07-16-pitstop-support-analytics-dashboard-design.md
function istDate(ts) {                       // UTC ISO → 'YYYY-MM-DD' in IST
  if (!ts) return null;
  return new Date(new Date(ts).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}
const SUPPORT_CHANNEL_LABELS = {
  whatsapp: 'WhatsApp', email: 'Email', instagram: 'Instagram', messenger: 'Messenger',
  web: 'Web', sheet: 'Imported', other: 'Other',
};
async function getSupportAnalytics(params, auth, env) {
  // Default range = current month-to-date (IST). Presets/custom come from the page.
  const nowIstIso = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString();
  const monthStartIso = new Date(`${nowIstIso.slice(0, 7)}-01T00:00:00+05:30`).toISOString();
  const from = params.get('from') || monthStartIso;
  const to   = params.get('to')   || new Date().toISOString();

  const scope = await visibilityFilters(params, auth, env);
  if (!scope) return err('Unknown department slug', 404);

  // A "complaint" = a triaged ticket carrying an issue_category. This is the same
  // universe the team's manual sheet counts (verified 2026-07-16: issue_category
  // IS NOT NULL ≈ 1,159 for Feb–Jun vs the sheet's ~1,160s) and it excludes the
  // ~6.9k call/general support tickets that have no product-complaint categorisation.
  const filters = [
    `created_at=gte.${encodeURIComponent(from)}`,
    `created_at=lte.${encodeURIComponent(to)}`,
    `issue_category=not.is.null`,
    ...scope,
  ];
  const [tRes, catRes, pmRes] = await Promise.all([
    sb(`/rest/v1/cs_tickets?${filters.join('&')}&select=created_at,purchase_date,product,issue_category,issue_subcategory,issue_subcategory_custom,platform,intake_channel,auto_created&limit=20000`, env, { headers: { Prefer: 'count=exact' } }),
    sb(`/rest/v1/cs_issue_catalog?is_active=eq.true&select=category,sort_order&order=sort_order.asc`, env),
    sbPublic(`/rest/v1/product_master?select=product,product_line&product_line=not.is.null&limit=2000`, env),
  ]);
  if (!tRes.ok) return err(`Failed to load analytics data: ${JSON.stringify(tRes.data)}`, tRes.status);
  const rows = tRes.data || [];

  // product → LOT line map (seeded on product_master.product_line)
  const lineOf = {};
  for (const r of (pmRes.data || [])) if (r.product) lineOf[r.product] = r.product_line;
  // issue-category display order (catalog sort_order); dedup preserving order
  const catSeen = new Set(); const catOrderAll = [];
  for (const r of (catRes.data || [])) if (r.category && !catSeen.has(r.category)) { catSeen.add(r.category); catOrderAll.push(r.category); }

  const kpis = { total: rows.length, within_3d: 0, after_3d: 0, ageing_unknown: 0 };
  const byCategory = {}, byLine = {}, bySale = {}, bySupport = {}, bySub = {};
  const prodMap = {};                 // product → { total, cats:{cat:n} }
  const catsPresent = new Set();
  const monthProd = {}, monthCat = {}; // month → { total, <dim>:n }

  for (const r of rows) {
    // ageing
    const pd = r.purchase_date, cd = istDate(r.created_at);
    if (!pd || !cd) kpis.ageing_unknown++;
    else {
      const days = Math.floor((Date.parse(`${cd}T00:00:00Z`) - Date.parse(`${pd}T00:00:00Z`)) / 86400000);
      if (days >= 0 && days <= 3) kpis.within_3d++;
      else if (days > 3) kpis.after_3d++;
      else kpis.ageing_unknown++;     // complaint dated before purchase = anomaly
    }

    const product = r.product || '—';
    const cat = r.issue_category || 'Uncategorised';
    catsPresent.add(cat);

    byCategory[cat] = (byCategory[cat] || 0) + 1;

    const line = lineOf[r.product] || 'Unclassified';
    byLine[line] = (byLine[line] || 0) + 1;

    const sale = r.platform || 'Unknown';
    bySale[sale] = (bySale[sale] || 0) + 1;

    const sup = r.auto_created || r.intake_channel === 'phone' || r.intake_channel === 'call'
      ? 'Calls'
      : (SUPPORT_CHANNEL_LABELS[r.intake_channel] || (r.intake_channel ? r.intake_channel : 'Unknown'));
    bySupport[sup] = (bySupport[sup] || 0) + 1;

    const sub = r.issue_subcategory || r.issue_subcategory_custom;
    if (sub) bySub[sub] = (bySub[sub] || 0) + 1;

    // product × category matrix
    const pm = prodMap[product] || (prodMap[product] = { product, total: 0, cats: {} });
    pm.total++; pm.cats[cat] = (pm.cats[cat] || 0) + 1;

    // monthly trends
    const mo = (cd || '').slice(0, 7);
    if (mo) {
      const mp = monthProd[mo] || (monthProd[mo] = { month: mo, total: 0 });
      mp.total++; mp[product] = (mp[product] || 0) + 1;
      const mc = monthCat[mo] || (monthCat[mo] = { month: mo, total: 0 });
      mc.total++; mc[cat] = (mc[cat] || 0) + 1;
    }
  }

  const pct = (n) => kpis.total ? +((n / kpis.total) * 100).toFixed(1) : 0;
  const rank = (obj) => Object.entries(obj).map(([name, count]) => ({ name, count, pct: pct(count) })).sort((a, b) => b.count - a.count);
  // matrix columns = catalog order, then any extra categories present, "Uncategorised" last
  const categories = [
    ...catOrderAll.filter(c => catsPresent.has(c)),
    ...[...catsPresent].filter(c => !catSeen.has(c) && c !== 'Uncategorised').sort(),
    ...([...catsPresent].includes('Uncategorised') ? ['Uncategorised'] : []),
  ];

  return ok({
    range: { from, to, total: rows.length },
    kpis,
    by_product_matrix: {
      categories,
      products: Object.values(prodMap).sort((a, b) => b.total - a.total),
    },
    by_issue_category: rank(byCategory),
    by_product_line: rank(byLine),
    by_sale_channel: rank(bySale),
    by_support_channel: rank(bySupport),
    top_subcategories: Object.entries(bySub).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 20),
    monthly_product_trend: Object.values(monthProd).sort((a, b) => a.month.localeCompare(b.month)),
    monthly_category_trend: Object.values(monthCat).sort((a, b) => a.month.localeCompare(b.month)),
  });
}

async function getCallReports(params, auth, env) {
  const from = params.get('from') || (() => { const d = new Date(); d.setMonth(0, 1); d.setHours(0,0,0,0); return d.toISOString(); })();
  const to   = params.get('to')   || new Date().toISOString();

  // Dept filter (non-admins locked to own)
  const deptFilter = await resolveDeptFilter(params.get('department'), auth, env);
  const deptClause = (() => { const c = buildDeptFilter(deptFilter); return c ? `&${c}` : ''; })();

  const select = 'created_at,direction,status,duration_seconds,agent_user_id,agent_name,myop_account_id,cs_department_id,ticket_id,called_back_at';
  const r = await sb(
    `/rest/v1/cs_calls?created_at=gte.${encodeURIComponent(from)}&created_at=lte.${encodeURIComponent(to)}${deptClause}&select=${select}&limit=20000`,
    env,
  );
  if (!r.ok) return err('Failed to load call reports', 500);
  const rows = r.data || [];

  // Resolve account + dept lookups in parallel for label-friendly grouping
  const [acctR, deptR] = await Promise.all([
    sb(`/rest/v1/myop_accounts?select=id,slug,name`, env),
    sb(`/rest/v1/cs_departments?select=id,slug,name`, env),
  ]);
  const acctById = Object.fromEntries((acctR.data || []).map(a => [a.id, a]));
  const deptById = Object.fromEntries((deptR.data || []).map(d => [d.id, d]));

  let total = 0, answered = 0, missed = 0, abandoned = 0, totalDur = 0, durCount = 0;
  const daily = {}, byAccount = {}, byDepartment = {}, byAgent = {}, byHour = Array(24).fill(0);
  let incoming_total = 0, incoming_answered = 0, outgoing_total = 0, outgoing_answered = 0;

  for (const c of rows) {
    total++;
    if (c.status === 'answered')  answered++;
    if (c.status === 'missed')    missed++;
    if (c.status === 'abandoned') abandoned++;
    if (c.duration_seconds && c.duration_seconds > 0) { totalDur += c.duration_seconds; durCount++; }

    const day = (c.created_at || '').slice(0, 10);
    if (day) {
      daily[day] = daily[day] || { date: day, in_total: 0, in_answered: 0, out_total: 0, out_answered: 0 };
      if (c.direction === 'incoming') { daily[day].in_total++; if (c.status === 'answered') daily[day].in_answered++; }
      else if (c.direction === 'outgoing') { daily[day].out_total++; if (c.status === 'answered') daily[day].out_answered++; }
    }

    if (c.direction === 'incoming') { incoming_total++; if (c.status === 'answered') incoming_answered++; }
    else if (c.direction === 'outgoing') { outgoing_total++; if (c.status === 'answered') outgoing_answered++; }

    const acct = c.myop_account_id ? acctById[c.myop_account_id] : null;
    const ak = acct?.slug || '—';
    byAccount[ak] = byAccount[ak] || { slug: ak, name: acct?.name || '—', total: 0, answered: 0, missed: 0 };
    byAccount[ak].total++;
    if (c.status === 'answered') byAccount[ak].answered++;
    if (c.status === 'missed')   byAccount[ak].missed++;

    const dept = c.cs_department_id ? deptById[c.cs_department_id] : null;
    const dk = dept?.slug || '—';
    byDepartment[dk] = byDepartment[dk] || { slug: dk, name: dept?.name || '—', total: 0, answered: 0, missed: 0, total_dur: 0, dur_count: 0 };
    byDepartment[dk].total++;
    if (c.status === 'answered') byDepartment[dk].answered++;
    if (c.status === 'missed')   byDepartment[dk].missed++;
    if (c.duration_seconds && c.duration_seconds > 0) { byDepartment[dk].total_dur += c.duration_seconds; byDepartment[dk].dur_count++; }

    const agentName = c.agent_name || '— unassigned —';
    // ⚠️ `answered_calls` counts answered calls in BOTH directions and is deliberately left
    // that way — other readers and the sort below depend on it. It is also exactly why
    // Pruthvi could not see outgoing activity (#bugs 2026-08-26): an agent's "Answered"
    // silently blended calls they took with calls they placed, so the two could never be
    // told apart. The three fields below split it explicitly; the UI reads those.
    // Measured 2026-08-26: 1,704 outgoing calls in 30 days were invisible on this table.
    byAgent[agentName] = byAgent[agentName] || {
      name: agentName, answered_calls: 0, missed_returned: 0, total_dur: 0, dur_count: 0, tickets_opened: 0,
      incoming_answered: 0, outgoing_total: 0, outgoing_answered: 0,
    };
    if (c.status === 'answered') byAgent[agentName].answered_calls++;
    if (c.direction === 'incoming') {
      if (c.status === 'answered') byAgent[agentName].incoming_answered++;
    } else if (c.direction === 'outgoing') {
      byAgent[agentName].outgoing_total++;
      if (c.status === 'answered') byAgent[agentName].outgoing_answered++;
    }
    if (c.status === 'missed' && c.called_back_at) byAgent[agentName].missed_returned++;
    if (c.duration_seconds && c.duration_seconds > 0) { byAgent[agentName].total_dur += c.duration_seconds; byAgent[agentName].dur_count++; }
    if (c.ticket_id) byAgent[agentName].tickets_opened++;

    const h = new Date(c.created_at).getHours();
    if (Number.isFinite(h)) byHour[h]++;
  }

  function finishAgent(a) {
    a.avg_handle_seconds = a.dur_count > 0 ? Math.round(a.total_dur / a.dur_count) : null;
    delete a.total_dur; delete a.dur_count;
    return a;
  }
  function finishDept(d) {
    d.answer_rate_pct = d.total > 0 ? Math.round((d.answered / d.total) * 100) : null;
    d.avg_handle_seconds = d.dur_count > 0 ? Math.round(d.total_dur / d.dur_count) : null;
    delete d.total_dur; delete d.dur_count;
    return d;
  }
  function finishAccount(a) {
    a.answer_rate_pct = a.total > 0 ? Math.round((a.answered / a.total) * 100) : null;
    return a;
  }

  return ok({
    range: { from, to },
    totals: {
      total, answered, missed, abandoned,
      answer_rate_pct: total > 0 ? Math.round((answered / total) * 100) : null,
      avg_duration_seconds: durCount > 0 ? Math.round(totalDur / durCount) : null,
    },
    daily: Object.values(daily).sort((a, b) => a.date.localeCompare(b.date)),
    by_direction: {
      incoming: { total: incoming_total, answered: incoming_answered, answer_rate_pct: incoming_total > 0 ? Math.round((incoming_answered / incoming_total) * 100) : null },
      outgoing: { total: outgoing_total, answered: outgoing_answered, answer_rate_pct: outgoing_total > 0 ? Math.round((outgoing_answered / outgoing_total) * 100) : null },
    },
    by_account:    Object.values(byAccount).map(finishAccount).sort((a, b) => b.total - a.total),
    by_department: Object.values(byDepartment).map(finishDept).sort((a, b) => b.total - a.total),
    by_agent:      Object.values(byAgent).map(finishAgent).sort((a, b) => b.answered_calls - a.answered_calls),
    hourly:        byHour.map((count, hour) => ({ hour, count })),
  });
}

async function getIssueCatalog(env) {
  const r = await sb(`/rest/v1/cs_issue_catalog?is_active=eq.true&select=category,subcategory,sort_order&order=sort_order.asc`, env);
  if (!r.ok) return err('failed to load catalog', 500);
  const byCat = [];
  const idx = {};
  for (const row of (r.data || [])) {
    if (idx[row.category] === undefined) { idx[row.category] = byCat.length; byCat.push({ category: row.category, subcategories: [] }); }
    byCat[idx[row.category]].subcategories.push(row.subcategory);
  }
  return ok({ categories: byCat });
}

async function getAgents(params, auth, env) {
  // Anyone with a cs_ticket_* perm can be an assignee
  const res = await sb(
    `/rest/v1/users_profile?active=eq.true&select=id,full_name,role&order=full_name.asc&limit=200`,
    env,
  );
  if (!res.ok) return err('Failed to fetch agents', 500);

  // Filter by roles that include cs_ticket_manage
  const rolesRes = await sb(`/rest/v1/roles?select=role_id,permissions`, env);
  const rolesMap = {};
  for (const r of (rolesRes.data || [])) rolesMap[r.role_id] = r.permissions || {};
  const eligible = (res.data || []).filter(u => rolesMap[u.role]?.cs_ticket_manage);

  return ok(eligible);
}

// CS-team-only assignee list (S162). getAgents/getDeptAgents return EVERY user with
// cs_ticket_manage — but the generic `admin`/`super_admin` roles carry that perm via
// the catch-all admin grant, so they flood any "assign to" picker with non-CS staff
// (production/floor admins). For the inbox assign dropdown we want the actual CS team:
// a CS-tier role (cs_agent / cs_lead) OR a CS-department membership. Admins can still
// self-claim a thread via the Claim button (myId), they're just not assignment targets.
async function getCsAgents(_params, _auth, env) {
  const u = await sb(
    `/rest/v1/users_profile?active=eq.true&select=id,full_name,role,cs_department_id&order=full_name.asc&limit=500`,
    env,
  );
  if (!u.ok) return err('failed to load agents', 500);
  const memRes = await sb(`/rest/v1/cs_user_departments?select=user_id`, env);
  const inCsDept = new Set((memRes.data || []).map(m => m.user_id));
  const CS_ROLES = new Set(['cs_agent', 'cs_lead']);
  const team = (u.data || [])
    .filter(p => CS_ROLES.has(p.role) || !!p.cs_department_id || inCsDept.has(p.id))
    .map(p => ({ id: p.id, full_name: p.full_name, role: p.role }));
  return ok(team);
}

// ── Agent presence + shift windows (Phase 1) ─────────────────────────────────
// Routing eligibility (Phase 2) = effective 'online' (status online + FRESH heartbeat)
// AND ( now within the agent's department shift window OR a manual 'Available'
// override, auto=false ). Effective status is computed live, so a stale 'online'
// (closed/forgotten tab) is never trusted and never routed — no reset cron needed.

const PRESENCE_FRESH_MS = 3 * 60 * 1000;   // heartbeat freshness (~3x the 60s client ping)

// Current IST wall-clock: minutes past midnight + ISO day-of-week (1=Mon..7=Sun).
function istNow() {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000);
  const min = d.getUTCHours() * 60 + d.getUTCMinutes();
  const dow0 = d.getUTCDay();                 // 0=Sun..6=Sat
  return { min, isoDow: dow0 === 0 ? 7 : dow0 };
}

function inShiftWindow(shift, nowParts) {
  if (!shift || shift.is_active === false) return false;
  const days = Array.isArray(shift.working_days) ? shift.working_days : [];
  if (!days.includes(nowParts.isoDow)) return false;
  const s = Number(shift.start_min), e = Number(shift.end_min);
  if (e >= s) return nowParts.min >= s && nowParts.min < e;
  return nowParts.min >= s || nowParts.min < e;   // overnight wrap
}

function effectivePresence(p, nowMs) {
  if (!p) return 'offline';
  if (p.status === 'online') {
    const fresh = p.last_seen_at && (nowMs - Date.parse(p.last_seen_at)) <= PRESENCE_FRESH_MS;
    return fresh ? 'online' : 'offline';
  }
  return p.status;   // a manual away/offline stands regardless of heartbeat
}

// Roster of CS agents with effective status, in-shift flag, and routing eligibility.
async function getPresence(_params, auth, env) {
  const g = require('cs_ticket_view', auth); if (g) return g;

  const u = await sb(
    `/rest/v1/users_profile?active=eq.true&select=id,full_name,role,cs_department_id&order=full_name.asc&limit=500`,
    env,
  );
  if (!u.ok) return err('failed to load roster', 500);

  const memRes = await sb(`/rest/v1/cs_user_departments?select=user_id,cs_department_id`, env);
  const inCsDept = new Set((memRes.data || []).map(m => m.user_id));
  const CS_ROLES = new Set(['cs_agent', 'cs_lead']);
  const team = (u.data || []).filter(
    p => CS_ROLES.has(p.role) || !!p.cs_department_id || inCsDept.has(p.id),
  );

  const presByUser = {};
  if (team.length) {
    const pr = await sb(
      `/rest/v1/cs_agent_presence?user_id=in.(${team.map(p => p.id).join(',')})&select=*`,
      env,
    );
    for (const row of (pr.data || [])) presByUser[row.user_id] = row;
  }

  const sh = await sb(`/rest/v1/cs_shifts?select=*`, env);
  const shiftByDept = {};
  for (const s of (sh.data || [])) shiftByDept[s.cs_department_id] = s;

  // Per-agent shift overrides (S164). A present + active row wins over the dept
  // window for that agent; an inactive/absent row falls back to the department.
  const ash = await sb(
    `/rest/v1/cs_agent_shifts?user_id=in.(${team.map(p => p.id).join(',') || '00000000-0000-0000-0000-000000000000'})&select=*`,
    env,
  );
  const agentShiftByUser = {};
  for (const s of (ash.data || [])) agentShiftByUser[s.user_id] = s;

  const nowParts = istNow();
  const nowMs = Date.now();
  const roster = team.map(p => {
    const pres = presByUser[p.id] || null;
    const eff = effectivePresence(pres, nowMs);
    const custom = agentShiftByUser[p.id] || null;
    const effShift = (custom && custom.is_active !== false) ? custom : shiftByDept[p.cs_department_id];
    const in_shift = inShiftWindow(effShift, nowParts);
    const override = !!pres && pres.auto === false && eff === 'online';
    return {
      user_id: p.id,
      full_name: p.full_name,
      role: p.role,
      cs_department_id: p.cs_department_id || null,
      status: eff,
      raw_status: pres?.status || 'offline',
      auto: pres ? pres.auto : true,
      last_seen_at: pres?.last_seen_at || null,
      in_shift,
      custom_shift: custom && { start_min: custom.start_min, end_min: custom.end_min, working_days: custom.working_days, is_active: custom.is_active },
      eligible: eff === 'online' && (in_shift || override),
    };
  });

  return ok({ roster, ist_now_min: nowParts.min, ist_dow: nowParts.isoDow });
}

// Per-department shift windows (joined to dept slug/name, dept sort order).
async function getShifts(_params, auth, env) {
  const g = require('cs_ticket_view', auth); if (g) return g;
  const r = await sb(
    `/rest/v1/cs_shifts?select=cs_department_id,start_min,end_min,working_days,is_active,updated_at,cs_departments(slug,name,sort_order)`,
    env,
  );
  if (!r.ok) return err('failed to load shifts', 500);
  const rows = (r.data || [])
    .map(s => ({
      cs_department_id: s.cs_department_id,
      slug: s.cs_departments?.slug || null,
      name: s.cs_departments?.name || null,
      sort_order: s.cs_departments?.sort_order ?? 999,
      start_min: s.start_min,
      end_min: s.end_min,
      working_days: s.working_days,
      is_active: s.is_active,
      updated_at: s.updated_at,
    }))
    .sort((a, b) => a.sort_order - b.sort_order);
  return ok({ shifts: rows });
}

// Set own availability. Manual toggle → auto=false; 'online' outside the window
// is the off-schedule 'Available' override. Any signed-in CS user sets their own.
async function setPresence(body, auth, env) {
  const g = require('cs_ticket_view', auth); if (g) return g;
  const status = String(body?.status || '');
  if (!['online', 'away', 'offline'].includes(status)) return err('invalid status');
  const nowIso = new Date().toISOString();
  const row = {
    user_id: auth.userId,
    status,
    status_since: nowIso,
    last_seen_at: nowIso,
    auto: false,
    updated_at: nowIso,
  };
  const r = await sb(`/rest/v1/cs_agent_presence?on_conflict=user_id`, env, {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: JSON.stringify(row),
  });
  if (!r.ok) return err('failed to set presence', 500);
  return ok({ status });
}

// Liveness ping (~60s, activity-gated client-side). One atomic RPC: promotes an
// auto-managed row to online + bumps last_seen; never clobbers a manual away/offline.
async function heartbeat(_body, auth, env) {
  const g = require('cs_ticket_view', auth); if (g) return g;
  const r = await sb(`/rest/v1/rpc/cs_heartbeat`, env, {
    method: 'POST',
    body: JSON.stringify({ p_user: auth.userId }),
  });
  if (!r.ok) return err('heartbeat failed', 500);
  const row = Array.isArray(r.data) ? r.data[0] : r.data;   // RPC returns the row composite
  return ok({ status: row?.status || 'online', auto: row?.auto ?? true, last_seen_at: row?.last_seen_at || null });
}

// Admin: set a department's shift window (upsert by cs_department_id).
async function setShift(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  const { cs_department_id, start_min, end_min, working_days, is_active } = body || {};
  if (!cs_department_id) return err('cs_department_id required');
  const sMin = Number(start_min), eMin = Number(end_min);
  if (!Number.isInteger(sMin) || sMin < 0 || sMin > 1440) return err('invalid start_min');
  if (!Number.isInteger(eMin) || eMin < 0 || eMin > 1440) return err('invalid end_min');
  const days = Array.isArray(working_days) ? [...new Set(working_days.map(Number))] : [];
  if (!days.length || days.some(d => !Number.isInteger(d) || d < 1 || d > 7))
    return err('working_days must be ISO day numbers 1-7');
  const row = {
    cs_department_id,
    start_min: sMin,
    end_min: eMin,
    working_days: days.sort((a, b) => a - b),
    is_active: is_active === undefined ? true : !!is_active,
    updated_at: new Date().toISOString(),
    updated_by_user_id: auth.userId,
  };
  const r = await sb(`/rest/v1/cs_shifts?on_conflict=cs_department_id`, env, {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: JSON.stringify(row),
  });
  if (!r.ok) return err('failed to save shift', 500);
  return ok({ shift: r.data?.[0] || row });
}

// Admin: set (or clear) a single agent's personal shift override (S164, Pruthvi).
// { user_id, start_min, end_min, working_days, is_active } upserts the override;
// { user_id, clear: true } removes it so the agent reverts to their dept window.
async function setAgentShift(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  const { user_id, clear, start_min, end_min, working_days, is_active } = body || {};
  if (!user_id) return err('user_id required');

  if (clear) {
    const d = await sb(`/rest/v1/cs_agent_shifts?user_id=eq.${encodeURIComponent(user_id)}`, env, { method: 'DELETE' });
    if (!d.ok) return err('failed to clear agent shift', 500);
    return ok({ cleared: true, user_id });
  }

  const sMin = Number(start_min), eMin = Number(end_min);
  if (!Number.isInteger(sMin) || sMin < 0 || sMin > 1440) return err('invalid start_min');
  if (!Number.isInteger(eMin) || eMin < 0 || eMin > 1440) return err('invalid end_min');
  const days = Array.isArray(working_days) ? [...new Set(working_days.map(Number))] : [];
  if (!days.length || days.some(d => !Number.isInteger(d) || d < 1 || d > 7))
    return err('working_days must be ISO day numbers 1-7');
  const row = {
    user_id,
    start_min: sMin,
    end_min: eMin,
    working_days: days.sort((a, b) => a - b),
    is_active: is_active === undefined ? true : !!is_active,
    updated_at: new Date().toISOString(),
    updated_by_user_id: auth.userId,
  };
  const r = await sb(`/rest/v1/cs_agent_shifts?on_conflict=user_id`, env, {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: JSON.stringify(row),
  });
  if (!r.ok) return err('failed to save agent shift', 500);
  return ok({ shift: r.data?.[0] || row });
}

// ── Thread work-queue state + routing config (Phase 2) ───────────────────────

// Mark a DM thread open / snoozed / closed (the inbox "Done"/"Reopen"/"Snooze").
// 'open' is also auto-set by the webhook on any new inbound (auto-reopen).
// Reopening a conversation must clear the ENTIRE closed/snoozed footprint, not just flip the
// state. There are four reopen sites (agent action, BiteSpeed inbound, Gmail inbound, Relay
// inbound, agent transfer) and each one re-deriving the list is how they drift: the Relay-inbound
// path shipped setting `thread_state='open'` alone, so from the support cutover every
// inbound-reopened thread carried a stale `closed_at` (17 rows, 7 of them on cutover day) — and a
// stale `snoozed_until` would re-hide an active conversation. One helper, one invariant.
// (`thread_state` is authoritative for open/closed; this keeps the other columns from contradicting it.)
function clearClosedFields(patch) {
  patch.thread_state = 'open';
  patch.closed_at = null;
  patch.closed_by_user_id = null;
  patch.snoozed_until = null;
  patch.closed_reason = null;
  patch.closed_note = null;
  return patch;
}

async function setThreadState(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { thread_id, state, snoozed_until, closed_reason, closed_note } = body || {};
  if (!thread_id) return err('thread_id required');
  if (!['open', 'snoozed', 'closed'].includes(state)) return err('invalid state');
  // The reason is OPTIONAL here on purpose: the UI is the only caller and always
  // sends one, but leaving it optional means the worker and the app can deploy in
  // either order without a window where closing a conversation 500s. A reasonless
  // close lands in the same "no reason recorded" bucket as pre-2026-07-28 history.
  if (state === 'closed' && closed_reason && !CONVO_CLOSE_REASONS.includes(closed_reason)) {
    return err(`invalid closed_reason (expected one of: ${CONVO_CLOSE_REASONS.join(', ')})`, 422);
  }
  const patch = { thread_state: state };
  if (state === 'closed') {
    patch.closed_at = new Date().toISOString();
    patch.closed_by_user_id = auth.userId;
    patch.snoozed_until = null;
    patch.closed_reason = closed_reason || null;
    patch.closed_note = (closed_note && String(closed_note).trim()) || null;
  } else if (state === 'snoozed') {
    patch.snoozed_until = snoozed_until || null;
    patch.closed_at = null; patch.closed_by_user_id = null;
    patch.closed_reason = null; patch.closed_note = null;
  } else {                                  // open
    // An OPEN conversation must not carry a closing outcome — it would show a stale
    // reason in the detail pane. (The report is safe either way: it filters on
    // thread_state='closed' before it ever reads closed_reason.)
    clearClosedFields(patch);
  }
  const r = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}`, env, {
    method: 'PATCH', body: JSON.stringify(patch),
  });
  if (!r.ok) return err('failed to set thread state', 500);

  // Auto-claim on Resolve/Close (Pruthvi, #bugs 2026-08-26). Closing an UNCLAIMED
  // conversation left no record of who actioned it — `closed_by_user_id` is set, but the
  // reports and the inbox both read `assigned_agent_id`, so the work showed against
  // "— unassigned —". This is the same rule replying already applies (auto-claim on first
  // reply, D4/S162), extended to the two buttons that also end a conversation.
  //
  // ⚠️ Scoped `assigned_agent_id=is.null` so the PATCH is the test — never read-then-write.
  // A conversation already assigned to someone else must keep its owner: the closer is not
  // necessarily the person who did the work, and stealing the name would corrupt exactly the
  // attribution this is meant to record.
  let claimed = false;
  if (state === 'closed') {
    const c = await sb(
      `/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&assigned_agent_id=is.null`,
      env,
      { method: 'PATCH',
        prefer: 'return=representation',
        body: JSON.stringify({
          assigned_agent_id: auth.userId,
          assigned_agent_name: auth.fullName || auth.name || auth.email || null,
          assigned_at: new Date().toISOString(),
        }) },
    ).catch(() => null);                       // a failed claim must never fail the close
    claimed = !!(c && c.ok && Array.isArray(c.data) && c.data.length);
  }
  return ok({ thread_state: state, closed_reason: patch.closed_reason ?? null, auto_claimed: claimed });
}

// Dismiss the collab pre-flag — "not a collab, stop showing this". Sticky: the
// dismissal survives later inbound messages, so a support conversation that keeps
// saying "charges" is only ever flagged once.
async function dismissCollabFlag(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { thread_id } = body || {};
  if (!thread_id) return err('thread_id required');
  const r = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}`, env, {
    method: 'PATCH',
    body: JSON.stringify({ collab_flagged: false, collab_dismissed: true }),
  });
  if (!r.ok) return err('failed to dismiss collab flag', 500);
  return ok({ collab_flagged: false, collab_dismissed: true });
}

// Mark a conversation read (S222, Pruthvi) — stamps last_read_at=now() so the generated
// has_unread_inbound flag clears. Team-global (Option A): opening it clears unread for
// everyone. No perm gate beyond a valid CS session (mirrors the read path getMessagingThreads
// — reading a thread is exactly what triggers this) so viewers can clear unread too.
async function markThreadRead(body, auth, env) {
  const { thread_id } = body || {};
  if (!thread_id) return err('thread_id required');
  const r = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}`, env, {
    method: 'PATCH', body: JSON.stringify({ last_read_at: new Date().toISOString() }),
  });
  if (!r.ok) return err('failed to mark read', 500);
  return ok({ thread_id, read: true });
}

async function getRoutingConfig(_params, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  const r = await sb(`/rest/v1/cs_routing_config?select=*&order=channel.asc`, env);
  if (!r.ok) return err('failed to load routing config', 500);
  // Participation roster per channel (S262, Pruthvi). Returned alongside the config so the
  // admin screen renders both halves off one call. An EMPTY array means "every eligible
  // agent" — the RPC's own convention; see the cs_routing_agents table comment.
  const m = await sb(`/rest/v1/cs_routing_agents?select=channel,user_id`, env);
  const agents = {};
  for (const row of (m.data || [])) (agents[row.channel] ||= []).push(row.user_id);
  return ok({ config: r.data || [], agents });
}

// Replace the participation roster for ONE channel (S262, Pruthvi). Whole-list replace,
// not add/remove: the UI is a set of tick boxes, so a diff would just be the same thing
// with more ways to desync. Delete-then-insert is safe here because the RPC treats a
// momentarily-empty list as "everyone" rather than "nobody" — the worst case for a request
// that dies between the two writes is a channel that routes wider than intended, never one
// that silently stops routing.
async function setRoutingAgents(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  const { channel, user_ids } = body || {};
  if (!['instagram', 'messenger', 'whatsapp'].includes(channel)) return err('invalid channel');
  if (!Array.isArray(user_ids)) return err('user_ids[] required');

  const del = await sb(`/rest/v1/cs_routing_agents?channel=eq.${encodeURIComponent(channel)}`, env, { method: 'DELETE' });
  if (!del.ok) return err('failed to clear routing agents', 500);
  if (user_ids.length) {
    const rows = user_ids.map(uid => ({ channel, user_id: uid, added_by_user_id: auth.userId }));
    const ins = await sb(`/rest/v1/cs_routing_agents`, env, { method: 'POST', body: JSON.stringify(rows) });
    if (!ins.ok) return err('failed to save routing agents', 500);
  }
  return ok({ channel, count: user_ids.length });
}

async function setRoutingConfig(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  const { channel, auto_assign_enabled, max_open_per_agent } = body || {};
  if (!['instagram', 'messenger', 'whatsapp'].includes(channel)) return err('invalid channel');
  const patch = { updated_at: new Date().toISOString(), updated_by_user_id: auth.userId };
  if (auto_assign_enabled !== undefined) patch.auto_assign_enabled = !!auto_assign_enabled;
  if (max_open_per_agent !== undefined) {
    const n = (max_open_per_agent === null || max_open_per_agent === '') ? null : Number(max_open_per_agent);
    if (n !== null && (!Number.isInteger(n) || n < 0)) return err('invalid max_open_per_agent');
    patch.max_open_per_agent = n;
  }
  const r = await sb(`/rest/v1/cs_routing_config?channel=eq.${encodeURIComponent(channel)}`, env, {
    method: 'PATCH', body: JSON.stringify(patch),
  });
  if (!r.ok) return err('failed to save routing config', 500);
  return ok({ channel });
}

// ── Tags (Phase 3) — one catalogue, shared across tickets + DM threads ────────
const TAG_COLORS = new Set(['slate', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink']);
const slugifyTag = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

// Batch-fetch tags for a set of parent ids → { parentId: [{id,name,color,slug}] }.
async function fetchTagsFor(kind, ids, env) {
  if (!ids.length) return {};
  const jt = kind === 'ticket' ? 'cs_ticket_tags' : 'cs_thread_tags';
  const col = kind === 'ticket' ? 'ticket_id' : 'thread_id';
  const r = await sb(`/rest/v1/${jt}?${col}=in.(${ids.join(',')})&select=${col},cs_tags(id,name,color,slug,is_active)`, env);
  const out = {};
  for (const row of (r.data || [])) {
    const t = row.cs_tags;
    if (!t || t.is_active === false) continue;
    (out[row[col]] ||= []).push({ id: t.id, name: t.name, color: t.color, slug: t.slug });
  }
  return out;
}

// Resolve the parent ids carrying a given tag (for the ?tag= list facet).
async function idsWithTag(kind, tagId, env) {
  const jt = kind === 'ticket' ? 'cs_ticket_tags' : 'cs_thread_tags';
  const col = kind === 'ticket' ? 'ticket_id' : 'thread_id';
  const r = await sb(`/rest/v1/${jt}?tag_id=eq.${encodeURIComponent(tagId)}&select=${col}&limit=10000`, env);
  return (r.data || []).map(x => x[col]);
}

async function getTags(params, auth, env) {
  const g = require('cs_ticket_view', auth); if (g) return g;
  const adminAll = params.get('all') === '1' && !!auth.permissions?.cs_ticket_admin;
  const q = `/rest/v1/cs_tags?select=id,name,slug,color,description,is_active,sort_order`
    + `${adminAll ? '' : '&is_active=eq.true'}&order=sort_order.asc,name.asc`;
  const r = await sb(q, env);
  if (!r.ok) return err('failed to load tags', 500);
  let tags = r.data || [];
  // Admin curation view: attach per-tag usage counts (drives the delete confirmation).
  if (adminAll && tags.length) {
    const u = await sb(`/rest/v1/rpc/cs_tag_usage`, env, { method: 'POST', body: '{}' });
    if (u.ok && Array.isArray(u.data)) {
      const byId = Object.fromEntries(u.data.map(row => [row.tag_id, row]));
      tags = tags.map(t => ({
        ...t,
        ticket_count: byId[t.id]?.ticket_count || 0,
        thread_count: byId[t.id]?.thread_count || 0,
      }));
    }
  }
  return ok({ tags });
}

async function createTag(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const name = String(body?.name || '').trim();
  const color = String(body?.color || 'slate');
  if (!name) return err('name required');
  if (!TAG_COLORS.has(color)) return err('invalid color');
  const slug = slugifyTag(name);
  if (!slug) return err('invalid name');
  const ex = await sb(`/rest/v1/cs_tags?slug=eq.${encodeURIComponent(slug)}&select=id,is_active&limit=1`, env);
  if (ex.data?.[0]) {
    if (ex.data[0].is_active === false) {     // reactivate an archived dupe rather than erroring
      const up = await sb(`/rest/v1/cs_tags?id=eq.${ex.data[0].id}`, env, {
        method: 'PATCH', body: JSON.stringify({ is_active: true, color, name, updated_at: new Date().toISOString() }),
      });
      return ok({ tag: up.data?.[0] || null, reactivated: true });
    }
    return err('a tag with that name already exists', 409);
  }
  const r = await sb(`/rest/v1/cs_tags`, env, {
    method: 'POST',
    body: JSON.stringify({ name, slug, color, description: body?.description || null, created_by_user_id: auth.userId }),
  });
  if (!r.ok) return err('failed to create tag', 500);
  return ok({ tag: r.data?.[0] || null });
}

async function updateTag(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;     // curation is lead/admin
  const { id, name, color, description, is_active, sort_order } = body || {};
  if (!id) return err('id required');
  const patch = { updated_at: new Date().toISOString() };
  if (name !== undefined) { const n = String(name).trim(); if (!n) return err('invalid name'); patch.name = n; patch.slug = slugifyTag(n); }
  if (color !== undefined) { if (!TAG_COLORS.has(color)) return err('invalid color'); patch.color = color; }
  if (description !== undefined) patch.description = description || null;
  if (is_active !== undefined) patch.is_active = !!is_active;
  if (sort_order !== undefined) patch.sort_order = Math.round(Number(sort_order) || 0);
  const r = await sb(`/rest/v1/cs_tags?id=eq.${encodeURIComponent(id)}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
  if (!r.ok) return err('failed to update tag', 500);
  return ok({ tag: r.data?.[0] || null });
}

// Hard-delete a tag. cs_ticket_tags / cs_thread_tags both FK it ON DELETE CASCADE,
// so this also strips the tag from every ticket + conversation it was on. Admin-only,
// confirmed in the UI (which shows the usage counts from getTags before deleting).
async function deleteTag(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  const id = body?.id;
  if (!id) return err('id required');
  const r = await sb(`/rest/v1/cs_tags?id=eq.${encodeURIComponent(id)}`, env, { method: 'DELETE' });
  if (!r.ok) return err('failed to delete tag', 500);
  if (!Array.isArray(r.data) || !r.data.length) return err('tag not found', 404);
  return ok({ deleted: true, id });
}

// Replace-set a ticket's / thread's tags (batched delete-not-in + insert-missing).
async function setTagsFor(kind, parentId, tagIds, auth, env) {
  const jt = kind === 'ticket' ? 'cs_ticket_tags' : 'cs_thread_tags';
  const col = kind === 'ticket' ? 'ticket_id' : 'thread_id';
  const notIn = tagIds.length ? `&tag_id=not.in.(${tagIds.join(',')})` : '';
  await sb(`/rest/v1/${jt}?${col}=eq.${encodeURIComponent(parentId)}${notIn}`, env, { method: 'DELETE', prefer: 'return=minimal' });
  if (tagIds.length) {
    const rows = tagIds.map(t => ({ [col]: parentId, tag_id: t, tagged_by_user_id: auth.userId }));
    await sb(`/rest/v1/${jt}?on_conflict=${col},tag_id`, env, {
      method: 'POST', prefer: 'resolution=ignore-duplicates,return=minimal', body: JSON.stringify(rows),
    });
  }
}

async function setTicketTags(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { ticket_id } = body || {};
  const tagIds = Array.isArray(body?.tag_ids) ? [...new Set(body.tag_ids)] : null;
  if (!ticket_id || !tagIds) return err('ticket_id and tag_ids required');
  await setTagsFor('ticket', ticket_id, tagIds, auth, env);
  await insertHistory(ticket_id, 'tags', null, tagIds.join(',') || '(none)', null, auth, env).catch(() => {});
  return ok({ ticket_id, tag_ids: tagIds });
}

async function setThreadTags(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { thread_id } = body || {};
  const tagIds = Array.isArray(body?.tag_ids) ? [...new Set(body.tag_ids)] : null;
  if (!thread_id || !tagIds) return err('thread_id and tag_ids required');
  await setTagsFor('thread', thread_id, tagIds, auth, env);
  return ok({ thread_id, tag_ids: tagIds });
}

// Sellable product catalogue for the New-ticket cascading dropdowns (Pruthvi #4).
// Active cars + drones from public.product_master; the UI derives product→model→
// colour→sku from the flat rows.
// The ticket form's product cascade. `puzzle` was NOT excluded on purpose — this filter
// predates L.O.T Build existing at all, so all 8 Build products (28 variants) were invisible
// and CS could not raise a ticket against one (Pruthvi 2026-08-20). Remotes stay out: a
// ticket is raised against the primary unit, same principle as RULE-009.
// `category` is selected so the caller can group/filter by it — the byte-exact three-value
// set of RULE-TAXONOMY-001, not a derived label.
async function getProductCatalog(_params, _auth, env) {
  const r = await sbPublic(
    `/rest/v1/product_master?is_active=eq.true&component_type=in.(car,drone,puzzle)&select=product,model,color,sku,category&order=product.asc,model.asc,color.asc`,
    env,
  );
  if (!r.ok) return err('failed to load product catalog', 500);
  return ok({ items: r.data || [] });
}

// ── Writes ───────────────────────────────────────────────────────────────────

async function insertHistory(ticket_id, field_name, old_value, new_value, note, auth, env) {
  return sb(`/rest/v1/cs_ticket_history`, env, {
    method: 'POST',
    body: JSON.stringify({
      ticket_id,
      changed_by_user_id: auth.userId,
      changed_by_name: auth.fullName,
      field_name,
      old_value: old_value == null ? null : String(old_value),
      new_value: new_value == null ? null : String(new_value),
      note: note || null,
    }),
    prefer: 'return=minimal',
  });
}


// ── Auto-link a ticket to its order ────────────────────────────────────────────────────────
// Only 13.8% of tickets carried an external_order_id (1,170 of 8,509; 4,000 unlinked in the
// last 30 days alone) — so the courier spine, the RTO banner and the delivery journeys all had
// nothing to key off, even when the agent could plainly see the order in the Shopify panel.
//
// Rule (Afshaan): link ONLY when the customer has exactly ONE order in the window. Zero is
// nothing to link; two or more is a guess, and guessing wrong attaches a ticket to the wrong
// parcel — worse than leaving it blank, because the spine would then confidently show the wrong
// delivery. Stored WITHOUT the '#', matching the dominant existing convention.
const AUTO_LINK_WINDOW_DAYS = 90;
function inferOrderLink(shop) {
  if (!shop?.found) return null;
  const cutoff = Date.now() - AUTO_LINK_WINDOW_DAYS * 86400000;
  const recent = (shop.recent_orders || []).filter((o) => {
    const t = Date.parse(o?.created_at || '');
    return Number.isFinite(t) && t >= cutoff;
  });
  if (recent.length !== 1) return null;
  const o = recent[0];
  if (!o.order_no) return null;
  return {
    external_order_id: String(o.order_no).replace(/^#/, ''),
    purchase_date: istDate(o.created_at),
    platform: 'website',
  };
}

async function createTicket(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;

  const {
    intake_channel, customer_name, customer_phone, customer_email, customer_address,
    platform, external_order_id, lot_unit_upc,
    product, product_sku, product_model, product_color,
    issue_category, issue_subcategory, issue_subcategory_custom, issue_description,
    disposition,
    assigned_agent_id,
    cs_department_id: bodyDeptId,
  } = body;

  if (!customer_name) return err('customer_name required');

  // If category or subcategory is 'Other', custom text is required
  if ((issue_category === 'Other' || issue_subcategory === 'Other') && !issue_subcategory_custom) {
    return err('issue_subcategory_custom required when category or subcategory is Other');
  }

  // Atomic sequence increment
  const year = String(new Date().getFullYear());
  const seqRes = await sb(`/rest/v1/rpc/next_cs_ticket_seq`, env, {
    method: 'POST',
    body: JSON.stringify({ p_year: year }),
  });
  if (!seqRes.ok) return err(`Failed to claim ticket number: ${JSON.stringify(seqRes.data)}`, 500);
  const seq = Number(seqRes.data);
  const ticket_no = `CS-${year}-${String(seq).padStart(5, '0')}`;

  // SLA computation — key on disposition; fallback to 7 days.
  // query / no_action are immediately resolved — SLA clock is meaningless, so null due_at.
  const finalDisposition = disposition || 'pending';
  const due_at = (finalDisposition === 'query' || finalDisposition === 'no_action')
    ? null
    : new Date(Date.now() + (SLA_DAYS[finalDisposition] ?? 7) * 24 * 60 * 60 * 1000).toISOString();

  // Normalise phone (strip non-digits, prefix +91 if 10 digits)
  let normPhone = customer_phone || null;
  if (normPhone) {
    const digits = String(normPhone).replace(/\D/g, '');
    normPhone = digits.length === 10 ? `+91${digits}` : (digits.startsWith('91') && digits.length === 12 ? `+${digits}` : (digits.startsWith('+') ? digits : `+${digits}`));
  }

  // Assignee defaults to creator
  const finalAssigneeId = assigned_agent_id || auth.userId;
  let assigneeName = auth.fullName;
  if (assigned_agent_id && assigned_agent_id !== auth.userId) {
    const aRes = await sb(`/rest/v1/users_profile?id=eq.${assigned_agent_id}&select=full_name&limit=1`, env);
    assigneeName = aRes.data?.[0]?.full_name || null;
  }

  // Default dept: explicit > creator's own dept > NULL
  const finalDeptId = bodyDeptId || auth.cs_department_id || null;

  // Auto-link the order when the agent did not name one and the customer has exactly one recent
  // order. Best-effort — a Shopify hiccup must never block ticket creation.
  let inferred = null;
  if (!external_order_id && (normPhone || customer_email)) {
    try { inferred = inferOrderLink(await shopifyLookup({ phone: normPhone, email: customer_email }, env)); }
    catch (e) { console.log('autolink_lookup_failed', e?.message || String(e)); }
  }

  const insertRes = await sb(`/rest/v1/cs_tickets`, env, {
    method: 'POST',
    body: JSON.stringify({
      ticket_no,
      cs_department_id: finalDeptId,
      created_by_user_id: auth.userId,
      created_by_name: auth.fullName,
      intake_channel: intake_channel || 'phone',
      customer_name,
      customer_phone: normPhone,
      customer_email: customer_email || null,
      customer_address: customer_address || null,
      platform: platform || null,
      // Agent-supplied wins; otherwise infer from the customer's orders (see inferOrderLink).
      external_order_id: external_order_id || inferred?.external_order_id || null,
      ...(!external_order_id && inferred?.purchase_date ? { purchase_date: inferred.purchase_date } : {}),
      lot_unit_upc: lot_unit_upc ? normalizeUpc(lot_unit_upc) : null,
      product: product || null,
      product_sku: product_sku || null,
      product_model: product_model || null,
      product_color: product_color || null,
      issue_category: issue_category || null,
      issue_subcategory: issue_subcategory || null,
      issue_subcategory_custom: issue_subcategory_custom || null,
      issue_description: issue_description || '',
      disposition: finalDisposition,
      assigned_agent_id: finalAssigneeId,
      assigned_agent_name: assigneeName,
      stage: 'intake',
      due_at,
    }),
  });
  if (!insertRes.ok) return err(`Failed to create ticket: ${JSON.stringify(insertRes.data)}`, insertRes.status);
  const ticket = insertRes.data?.[0];

  await insertHistory(ticket.id, 'ticket_created', null, ticket_no, null, auth, env);

  return ok({ ticket_no, id: ticket.id, due_at });
}

async function updateTicket(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { ticket_id, patch } = body;
  if (!ticket_id || !patch || typeof patch !== 'object') return err('ticket_id and patch required');

  // Stage-aware editable fields enforcement
  const tRes = await sb(`/rest/v1/cs_tickets?id=eq.${ticket_id}&select=*&limit=1`, env);
  const current = tRes.data?.[0];
  if (!current) return err('Ticket not found', 404);

  // Fields the user is NEVER allowed to patch directly (must go through
  // advanceStage / assignAgent / etc). assigned_agent_id is protected so the
  // cs_ticket_reassign gate in assignAgent can't be bypassed via updateTicket.
  const PROTECTED = new Set([
    'id', 'ticket_no', 'created_at', 'created_by_user_id', 'created_by_name',
    'stage', 'stage_changed_at', 'closed_at', 'closed_reason', 'closed_by_user_id',
    'updated_at',
    'assigned_agent_id', 'assigned_agent_name',
  ]);

  // Disposition re-triage lock: once past awaiting_evidence, only cs_ticket_admin may change disposition
  const TRIAGE_STAGES = new Set(['intake', 'awaiting_evidence']);
  if (patch.disposition !== undefined && patch.disposition !== current.disposition) {
    if (!TRIAGE_STAGES.has(current.stage)) {
      const g2 = require('cs_ticket_admin', auth);
      if (g2) return err('disposition can only be changed by an admin after awaiting_evidence', 403);
    }
  }

  const cleanPatch = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!PROTECTED.has(k)) cleanPatch[k] = v;
  }
  if (Object.keys(cleanPatch).length === 0) return err('Nothing to update');

  // Triage routing side-effects when disposition is being changed.
  // Track keys injected here so history logging can exclude them (Fix 2).
  // 'stage' is injected but IS logged (meaningful); the rest are suppressed.
  const newDisposition = cleanPatch.disposition;
  const now = new Date().toISOString();
  const injectedSystemKeys = new Set(); // populated below; excludes 'stage' (that stays logged)
  if (newDisposition && newDisposition !== current.disposition) {
    if (newDisposition === 'query') {
      cleanPatch.stage = 'closed';
      cleanPatch.stage_changed_at = now;   injectedSystemKeys.add('stage_changed_at');
      cleanPatch.closed_reason = 'resolved';  injectedSystemKeys.add('closed_reason');
      cleanPatch.closed_at = now;          injectedSystemKeys.add('closed_at');
      cleanPatch.closed_by_user_id = auth.userId; injectedSystemKeys.add('closed_by_user_id');
    } else if (newDisposition === 'no_action') {
      cleanPatch.stage = 'closed';
      cleanPatch.stage_changed_at = now;   injectedSystemKeys.add('stage_changed_at');
      cleanPatch.closed_reason = 'no_action'; injectedSystemKeys.add('closed_reason');
      cleanPatch.closed_at = now;          injectedSystemKeys.add('closed_at');
      cleanPatch.closed_by_user_id = auth.userId; injectedSystemKeys.add('closed_by_user_id');
    } else if (newDisposition === 'awaiting_info') {
      // Fix 3: reopen a ticket that was fast-closed by a prior query/no_action triage
      if (current.stage === 'closed') {
        cleanPatch.closed_at = null;         injectedSystemKeys.add('closed_at');
        cleanPatch.closed_reason = null;     injectedSystemKeys.add('closed_reason');
        cleanPatch.closed_by_user_id = null; injectedSystemKeys.add('closed_by_user_id');
        cleanPatch.stage = 'awaiting_evidence';
        cleanPatch.stage_changed_at = now;   injectedSystemKeys.add('stage_changed_at');
      } else {
        cleanPatch.stage = 'awaiting_evidence';
        cleanPatch.stage_changed_at = now;   injectedSystemKeys.add('stage_changed_at');
      }
    } else {
      // replacement | refund | repair | pending
      // Fix 3: reopen if ticket is currently closed (stranded after query/no_action fast-close)
      if (current.stage === 'closed') {
        cleanPatch.closed_at = null;         injectedSystemKeys.add('closed_at');
        cleanPatch.closed_reason = null;     injectedSystemKeys.add('closed_reason');
        cleanPatch.closed_by_user_id = null; injectedSystemKeys.add('closed_by_user_id');
        cleanPatch.stage = 'intake';
        cleanPatch.stage_changed_at = now;   injectedSystemKeys.add('stage_changed_at');
      }
      // non-closed tickets → leave stage as-is
    }
  }

  const upd = await sb(`/rest/v1/cs_tickets?id=eq.${ticket_id}`, env, {
    method: 'PATCH',
    body: JSON.stringify(cleanPatch),
  });
  if (!upd.ok) return err(`Update failed: ${JSON.stringify(upd.data)}`, upd.status);

  // History per changed field — log user-supplied fields + 'stage' + 'disposition',
  // but suppress injected system fields (stage_changed_at / closed_at / closed_reason /
  // closed_by_user_id) which are noise and expose raw UUIDs as human-facing values.
  await Promise.all(
    Object.entries(cleanPatch)
      .filter(([k]) => !injectedSystemKeys.has(k))
      .map(([k, v]) => insertHistory(ticket_id, k, current[k], v, null, auth, env))
  );

  return ok({ updated: cleanPatch });
}

// Switch a ticket's resolution path between Replacement and Refund (Pruthvi #bugs
// S181). Any cs_ticket_manage agent may switch — but ONLY while the ticket is still
// pre-resolution (in a SHARED_STAGE). Once a refund is initiated/completed or a
// replacement is dispatched (a BRANCH_STAGE), or the ticket is closed/side-exited,
// the resolution is in motion and the switch is blocked (cancel + reopen instead).
// Replacement and Refund share the same SHARED_STAGES, so the stage is preserved;
// only the disposition (+ recomputed SLA due_at) changes.
async function switchResolution(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { ticket_id, to_disposition, reason } = body;
  const SWITCHABLE = new Set(['replacement', 'refund']);
  if (!ticket_id || !SWITCHABLE.has(to_disposition)) {
    return err('ticket_id and to_disposition (replacement|refund) required', 422);
  }
  const tRes = await sb(`/rest/v1/cs_tickets?id=eq.${encodeURIComponent(ticket_id)}&select=*&limit=1`, env);
  const t = tRes.data?.[0];
  if (!t) return err('Ticket not found', 404);
  if (!SWITCHABLE.has(t.disposition)) {
    return err(`Only a Replacement or Refund ticket can be switched (this one is ${t.disposition || 'unset'}).`, 422);
  }
  if (t.disposition === to_disposition) return ok({ switched: false, disposition: t.disposition });
  // Pre-resolution gate — the stage must still be in the shared flow.
  if (!SHARED_STAGES.includes(t.stage)) {
    return err(`Can't switch — this ${t.disposition} is already in motion (stage: ${t.stage}). Cancel and reopen the ticket if it must change.`, 409);
  }

  const createdMs = new Date(t.created_at).getTime();
  const due_at = new Date((Number.isFinite(createdMs) ? createdMs : Date.now()) + (SLA_DAYS[to_disposition] ?? 7) * 24 * 60 * 60 * 1000).toISOString();

  const upd = await sb(`/rest/v1/cs_tickets?id=eq.${encodeURIComponent(ticket_id)}`, env, {
    method: 'PATCH',
    body: JSON.stringify({ disposition: to_disposition, due_at }),
  });
  if (!upd.ok) return err(`Switch failed: ${JSON.stringify(upd.data)}`, upd.status);

  await insertHistory(ticket_id, 'disposition', t.disposition, to_disposition,
    reason ? String(reason).slice(0, 200) : 'switched resolution path', auth, env);
  return ok({ switched: true, disposition: to_disposition, due_at });
}

async function advanceStage(body, auth, env, request) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { ticket_id, target_stage, patch = {} } = body;
  if (!ticket_id || !target_stage) return err('ticket_id and target_stage required');

  const tRes = await sb(`/rest/v1/cs_tickets?id=eq.${ticket_id}&select=*&limit=1`, env);
  const t = tRes.data?.[0];
  if (!t) return err('Ticket not found', 404);

  // Optimistic concurrency: If-Match: stage_changed_at
  const ifMatch = request.headers.get('If-Match');
  if (ifMatch && ifMatch !== t.stage_changed_at) {
    return err('Stale ticket — refresh and try again', 409);
  }

  // Check legal transition
  const allowed = allowedTransitions(t.stage, t.disposition);
  if (!allowed.includes(target_stage)) {
    return err(`Cannot advance ${t.stage} → ${target_stage} for ${t.disposition} ticket`, 422);
  }

  // Apply pre-advance patches (so gate check sees them)
  const cleanPatch = { ...patch };
  delete cleanPatch.stage; delete cleanPatch.stage_changed_at;
  delete cleanPatch.closed_at; delete cleanPatch.closed_reason;
  delete cleanPatch.ticket_no; delete cleanPatch.id;

  const merged = { ...t, ...cleanPatch };

  // Attachments count for awaiting_evidence → verified gate
  let attachCount = 0;
  if (target_stage === 'verified') {
    const aRes = await sb(`/rest/v1/cs_ticket_attachments?ticket_id=eq.${ticket_id}&select=id`, env);
    attachCount = (aRes.data || []).length;
  }

  // Gate check
  const gateErr = gateRequirements(t.stage, target_stage, t.disposition, merged, attachCount);
  if (gateErr) return err(gateErr, 422);

  // Build the update payload
  const update = { ...cleanPatch, stage: target_stage, stage_changed_at: new Date().toISOString() };

  if (target_stage === 'at_warehouse' && !merged.warehouse_received_at) {
    update.warehouse_received_at = new Date().toISOString();
  }
  let freeTextReason = null;
  if (['closed', 'cancelled', 'rejected'].includes(target_stage)) {
    update.closed_at = new Date().toISOString();
    update.closed_by_user_id = auth.userId;
    const fallback = target_stage === 'rejected' ? 'rejected'
                   : target_stage === 'cancelled' ? 'no_response'
                   : 'resolved';
    const raw = target_stage === 'rejected' ? 'rejected' : patch.closed_reason;
    if (raw && ALLOWED_CLOSED_REASONS.includes(raw)) {
      update.closed_reason = raw;
    } else {
      // Free text (e.g. "Test" from the cancel modal) can't go into the enum —
      // use the stage default and keep the note for the history trail.
      update.closed_reason = fallback;
      if (raw && String(raw).trim()) freeTextReason = String(raw).trim();
    }
  }

  const upd = await sb(`/rest/v1/cs_tickets?id=eq.${ticket_id}`, env, {
    method: 'PATCH',
    body: JSON.stringify(update),
  });
  if (!upd.ok) return err(`Advance failed: ${JSON.stringify(upd.data)}`, upd.status);

  // Auto-claim an UNASSIGNED ticket on close (Pruthvi, #bugs 2026-08-26) — the ticket half of
  // the same gap setThreadState now covers for conversations. `closed_by_user_id` was already
  // stamped, but every agent-facing surface reads `assigned_agent_name`, so a ticket closed by
  // someone who never claimed it reported against nobody.
  // ⚠️ Only on the three terminal stages, and only via the `assigned_agent_id=is.null` filter so
  // the PATCH itself is the test. A ticket already owned keeps its owner — the closer is not
  // necessarily who did the work.
  if (['closed', 'cancelled', 'rejected'].includes(target_stage)) {
    await sb(`/rest/v1/cs_tickets?id=eq.${ticket_id}&assigned_agent_id=is.null`, env, {
      method: 'PATCH',
      body: JSON.stringify({
        assigned_agent_id: auth.userId,
        assigned_agent_name: auth.fullName || auth.name || auth.email || null,
      }),
    }).catch(() => {});                    // a failed claim must never fail the close
  }

  // History: stage row + any field changes
  await insertHistory(ticket_id, 'stage', t.stage, target_stage, null, auth, env);
  for (const [k, v] of Object.entries(cleanPatch)) {
    await insertHistory(ticket_id, k, t[k], v, null, auth, env);
  }
  if (freeTextReason) {
    await insertHistory(ticket_id, 'close_note', null, freeTextReason.slice(0, 200), null, auth, env);
  }

  return ok({ new_stage: target_stage, ticket: upd.data?.[0] });
}

async function assignAgent(body, auth, env) {
  // Base gate: must at least be able to manage tickets
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { ticket_id, agent_id } = body;
  if (!ticket_id || !agent_id) return err('ticket_id and agent_id required');

  // Self-assign (claim from Unassigned) is open to any cs_ticket_manage holder.
  // Cross-user reassignment requires cs_ticket_reassign or cs_ticket_admin.
  const isSelfAssign = agent_id === auth.userId;
  if (!isSelfAssign) {
    const canReassign = !!auth?.permissions?.cs_ticket_reassign || !!auth?.permissions?.cs_ticket_admin;
    if (!canReassign) {
      return err('Forbidden — only Team Lead+ can reassign tickets to other agents (missing cs_ticket_reassign)', 403);
    }
  }

  const aRes = await sb(`/rest/v1/users_profile?id=eq.${agent_id}&select=id,full_name&limit=1`, env);
  const agent = aRes.data?.[0];
  if (!agent) return err('Agent not found', 404);

  const tRes = await sb(`/rest/v1/cs_tickets?id=eq.${ticket_id}&select=assigned_agent_id,assigned_agent_name&limit=1`, env);
  const t = tRes.data?.[0];
  if (!t) return err('Ticket not found', 404);

  const upd = await sb(`/rest/v1/cs_tickets?id=eq.${ticket_id}`, env, {
    method: 'PATCH',
    body: JSON.stringify({ assigned_agent_id: agent.id, assigned_agent_name: agent.full_name }),
  });
  if (!upd.ok) return err('Assign failed', 500);

  await insertHistory(
    ticket_id, 'assigned_agent_id',
    t.assigned_agent_id, agent.id,
    isSelfAssign ? 'self-claimed' : `→ ${agent.full_name}`,
    auth, env,
  );

  return ok({ assigned_to: agent.full_name, self_assigned: isSelfAssign });
}

async function addNote(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { ticket_id, body: noteBody, visibility } = body;
  if (!ticket_id || !noteBody) return err('ticket_id and body required');

  const res = await sb(`/rest/v1/cs_ticket_notes`, env, {
    method: 'POST',
    body: JSON.stringify({
      ticket_id,
      created_by_user_id: auth.userId,
      created_by_name: auth.fullName,
      visibility: visibility === 'customer_facing' ? 'customer_facing' : 'internal',
      body: noteBody,
    }),
  });
  if (!res.ok) return err('Failed to add note', 500);

  await insertHistory(ticket_id, 'note_added', null, noteBody.slice(0, 100), null, auth, env);

  return ok({ note: res.data?.[0] });
}

async function addAttachment(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { ticket_id, url, kind, label } = body;
  if (!ticket_id || !url) return err('ticket_id and url required');

  const res = await sb(`/rest/v1/cs_ticket_attachments`, env, {
    method: 'POST',
    body: JSON.stringify({
      ticket_id,
      added_by_user_id: auth.userId,
      added_by_name: auth.fullName,
      kind: kind || 'other',
      url,
      label: label || null,
    }),
  });
  if (!res.ok) return err('Failed to add attachment', 500);

  await insertHistory(ticket_id, 'attachment_added', null, label || url, null, auth, env);

  return ok({ attachment: res.data?.[0] });
}

async function linkTicket(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { ticket_id, related_ticket_id, relation_type } = body;
  if (!ticket_id || !related_ticket_id || !relation_type) return err('ticket_id, related_ticket_id, relation_type required');
  if (ticket_id === related_ticket_id) return err('Cannot link a ticket to itself');

  const res = await sb(`/rest/v1/cs_ticket_links`, env, {
    method: 'POST',
    body: JSON.stringify({
      ticket_id, related_ticket_id, relation_type,
      created_by_user_id: auth.userId,
    }),
  });
  if (!res.ok) return err(`Failed to link: ${JSON.stringify(res.data)}`, res.status);

  await insertHistory(ticket_id, 'link_added', null, `${relation_type} → ${related_ticket_id}`, null, auth, env);

  return ok({ link: res.data?.[0] });
}

async function cancelTicket(body, auth, env) {
  return advanceStage({ ticket_id: body.ticket_id, target_stage: 'cancelled', patch: { closed_reason: body.reason || 'no_response' } }, auth, env, new Request('https://x'));
}

async function escalateTicket(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { ticket_id, note } = body;
  if (!ticket_id) return err('ticket_id required');
  // Doesn't change stage; just flags via history. UI surfaces it.
  await insertHistory(ticket_id, 'escalated', null, 'true', note || null, auth, env);
  return ok({ escalated: true });
}

// ── Ticket closure approval (Pruthvi, 2026-08-18) ────────────────────────────
//
// An agent asks to close with a reason and a note; an admin decides. The ticket does NOT
// move while a request is pending — see the migration for why this is an annotation rather
// than a new `stage`.
//
// ⚠️ closeTicket() is deliberately UNCHANGED and still works for admins. This is an extra
// route for people who cannot close, not a gate bolted in front of the existing one: a
// terminal-stage close by someone with cs_ticket_manage is a normal, sanctioned action and
// making everyone queue behind an admin would be a worse system than the one being fixed.
async function requestTicketClosure(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { ticket_id, reason, note } = body || {};
  if (!ticket_id) return err('ticket_id required');
  if (!ALLOWED_CLOSED_REASONS.includes(reason)) {
    return err(`reason required (one of: ${ALLOWED_CLOSED_REASONS.join(', ')})`, 422);
  }
  // Pruthvi asked for the note to be mandatory, and that is the point of the whole feature:
  // the reason is a dropdown anyone can click, the note is what an approver actually reads.
  if (!String(note || '').trim()) return err('a note is required when requesting closure', 422);

  const tRes = await sb(`/rest/v1/cs_tickets?id=eq.${encodeURIComponent(ticket_id)}`
    + `&select=id,ticket_no,stage,closure_requested_at&limit=1`, env);
  const t = tRes.data?.[0];
  if (!t) return err('Ticket not found', 404);
  if (['closed', 'cancelled', 'rejected'].includes(t.stage)) return err('Ticket is already closed', 422);
  if (t.closure_requested_at) return err('A closure request is already pending on this ticket', 409);

  const r = await sb(`/rest/v1/cs_tickets?id=eq.${encodeURIComponent(ticket_id)}`, env, {
    method: 'PATCH',
    body: JSON.stringify({
      closure_requested_at: new Date().toISOString(),
      closure_requested_by_user_id: auth.userId,
      closure_requested_by_name: auth.fullName || auth.name || auth.email || null,
      closure_request_reason: reason,
      closure_request_note: String(note).trim(),
    }),
  });
  if (!r.ok) return err('Failed to request closure', r.status || 500);
  await insertHistory(ticket_id, 'closure_requested', null, reason, String(note).trim(), auth, env);
  return ok({ requested: true, ticket_no: t.ticket_no });
}

const CLOSURE_FIELDS_CLEARED = {
  closure_requested_at: null, closure_requested_by_user_id: null,
  closure_requested_by_name: null, closure_request_reason: null, closure_request_note: null,
};

async function approveTicketClosure(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  const { ticket_id } = body || {};
  if (!ticket_id) return err('ticket_id required');
  const tRes = await sb(`/rest/v1/cs_tickets?id=eq.${encodeURIComponent(ticket_id)}`
    + `&select=id,ticket_no,closure_requested_at,closure_request_reason,closure_requested_by_name&limit=1`, env);
  const t = tRes.data?.[0];
  if (!t) return err('Ticket not found', 404);
  if (!t.closure_requested_at) return err('No closure request is pending on this ticket', 409);

  // ⚠️ Clear the request BEFORE closing. advanceStage writes its own history and the two
  // must not race into a state where the ticket is closed and still shows as awaiting
  // approval — which would sit in the admin worklist forever with nothing to act on.
  await sb(`/rest/v1/cs_tickets?id=eq.${encodeURIComponent(ticket_id)}`, env, {
    method: 'PATCH', body: JSON.stringify(CLOSURE_FIELDS_CLEARED),
  });
  await insertHistory(ticket_id, 'closure_approved', t.closure_requested_by_name || null,
    t.closure_request_reason || null, `approved by ${auth.fullName || auth.email || 'admin'}`, auth, env);

  // Reuse the ONE close path rather than writing a second one. Everything it does — the
  // gate checks, closed_at/closed_by, the reason fallback, the history row — has to happen
  // here too, and a parallel implementation is how the two drift.
  return advanceStage(
    { ticket_id, target_stage: 'closed', patch: { closed_reason: t.closure_request_reason || 'resolved' } },
    auth, env, new Request('https://x'),
  );
}

async function rejectTicketClosure(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  const { ticket_id, note } = body || {};
  if (!ticket_id) return err('ticket_id required');
  const tRes = await sb(`/rest/v1/cs_tickets?id=eq.${encodeURIComponent(ticket_id)}`
    + `&select=id,ticket_no,closure_requested_at,closure_request_reason&limit=1`, env);
  const t = tRes.data?.[0];
  if (!t) return err('Ticket not found', 404);
  if (!t.closure_requested_at) return err('No closure request is pending on this ticket', 409);

  const r = await sb(`/rest/v1/cs_tickets?id=eq.${encodeURIComponent(ticket_id)}`, env, {
    method: 'PATCH', body: JSON.stringify(CLOSURE_FIELDS_CLEARED),
  });
  if (!r.ok) return err('Failed to reject closure', r.status || 500);
  // The ticket is left exactly where it was, still open and still assigned — a rejected
  // request is a "keep working on it", not a state change.
  await insertHistory(ticket_id, 'closure_rejected', t.closure_request_reason || null, null,
    String(note || '').trim() || null, auth, env);
  return ok({ rejected: true, ticket_no: t.ticket_no });
}

// The admin worklist. Visible to admins only, since only they can act on it.
async function getClosureRequests(params, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  const r = await sb(`/rest/v1/cs_tickets?closure_requested_at=not.is.null`
    + `&select=id,ticket_no,customer_name,customer_phone,stage,disposition,assigned_agent_name,`
    + `closure_requested_at,closure_requested_by_name,closure_request_reason,closure_request_note`
    + `&order=closure_requested_at.asc&limit=200`, env);
  if (!r.ok) return err('Failed to load closure requests', 500);
  return ok({ requests: r.data || [] });
}

async function closeTicket(body, auth, env) {
  const { ticket_id, reason } = body;
  if (!ticket_id) return err('ticket_id required');

  const tRes = await sb(`/rest/v1/cs_tickets?id=eq.${ticket_id}&select=stage,disposition&limit=1`, env);
  const t = tRes.data?.[0];
  if (!t) return err('Ticket not found', 404);

  // Terminal stages can be closed by anyone with manage
  const terminalReady = ['replacement_dispatched', 'refund_completed', 'repair_dispatched'];
  if (!terminalReady.includes(t.stage)) {
    // Mid-flight close requires admin perm + reason
    const g = require('cs_ticket_admin', auth); if (g) return g;
    if (!reason) return err(`reason required for mid-flight close (one of: ${ALLOWED_CLOSED_REASONS.join(', ')})`);
  } else {
    const g = require('cs_ticket_manage', auth); if (g) return g;
  }

  return advanceStage({ ticket_id, target_stage: 'closed', patch: { closed_reason: reason || 'resolved' } }, auth, env, new Request('https://x'));
}

// ── Telephony pipeline binding ───────────────────────────────────────────────
// Dependency injection rather than imports: sb / shopifyLookup / resolveAgentByEmail
// all live in this file, so call-pipeline.js importing them would be circular.
// Cheap to construct — it is a closure over `env`, not a connection.
function callPipeline(env) {
  return makeCallPipeline({
    env, sb, toE164, shopifyLookup, resolveAgentByEmail, inferOrderLink, SLA_DAYS,
  });
}

// ── MyOperator webhook ───────────────────────────────────────────────────────

// Resolve a MyOp account by slug. Returns null if not found or inactive.
async function resolveMyopAccount(slug, env) {
  const r = await sb(
    `/rest/v1/myop_accounts?slug=eq.${encodeURIComponent(slug)}&is_active=eq.true&select=*&limit=1`,
    env,
  );
  return r.data?.[0] || null;
}

// Per-slug webhook secret. Reads MYOP_WEBHOOK_SECRET_<UPPER_SLUG> first; falls
// back to legacy MYOP_WEBHOOK_SECRET only for slug='main' (back-compat with the
// existing live MyOperator configuration that posts to /webhooks/myoperator
// without an ?account= parameter).
function expectedSecretForSlug(slug, env) {
  const key = `MYOP_WEBHOOK_SECRET_${slug.toUpperCase().replace(/-/g, '_')}`;
  return env[key] || (slug === 'main' ? env.MYOP_WEBHOOK_SECRET : null);
}

async function handleMyOperatorWebhook(request, env) {
  const url = new URL(request.url);
  const slug = (url.searchParams.get('account') || 'main').toLowerCase();
  const account = await resolveMyopAccount(slug, env);
  if (!account) return err(`Unknown MyOp account slug: ${slug}`, 404);

  const expected = expectedSecretForSlug(slug, env);
  const provided = url.searchParams.get('token') || request.headers.get('X-Webhook-Token');
  if (!expected || provided !== expected) return err('Invalid webhook signature', 401);

  let body = {};
  try { body = await request.json(); } catch { return err('Bad JSON', 400); }
  const type = body.event_type;
  console.log(`[myop:${slug}] ${type} session=${body.session_id || '?'} dir=${body.direction || '?'}`);
  if (type === 'call.answered' || type === 'call.responded') return webhookCallAnswered(body, env, account);
  if (type === 'call.end' || type === 'call.ended')          return webhookCallEnd(body, env, account);
  if (type === 'call.summary')                                return webhookCallSummary(body, env, account);
  return json({ ok: true, ignored: type });
}
// MyOperator wraps the call details in a nested `payload` object; the envelope
// carries session_id / customer_identifier / system_identifier / direction /
// timestamp / event_type at the top level. Normalise both into one flat shape.
//
// `direction` is mapped by the shared normaliseDirection() rather than passed through
// raw: cs_calls.direction is CHECK-constrained to {'incoming','outgoing'}, and one
// unfamiliar vendor string would reject the INSERT and lose the call. That is the
// metaAttachmentKind failure class which silently dropped every shared Instagram reel.
// Live vocabulary as of 2026-08-04: 15,906 rows, only 'incoming'/'outgoing' — so this
// is a guard against future drift, not a bug being fixed.
function parseMyOp(body) {
  const p = (body && body.payload) || {};
  return {
    session_id: body.session_id || null,
    direction:  normaliseDirection(body.direction || p.direction, 'myop'),
    did:        body.system_identifier || p.did || null,
    phone:      body.customer_identifier || p.customer_number || null,
    timestamp:  body.timestamp || null,
    duration:   p.duration != null ? Number(p.duration) : null,
    recording_filename: p.recording_filename || null,
    client_ref_id: p.client_ref_id || null,
    status:     p.status || null,
    legs:       Array.isArray(p.legs) ? p.legs : [],
  };
}

// MyOperator's flat shape → the vendor-neutral NormalisedCall the pipeline consumes.
// MyOperator keeps its original identity: UNIQUE (myop_account_id, call_session_id),
// which ~20 existing call sites and that constraint both still depend on.
function myopNorm(c, account) {
  return {
    provider: 'myoperator',
    call_session_id: c.session_id,
    provider_call_sid: null,
    account_id: account?.id || null,
    department_id: account?.default_department_id || null,
    direction: c.direction,
    exophone: c.did,
    customer_phone: c.phone,
    started_at: c.timestamp || null,
    legs: c.legs,
    agent_ref: {},
  };
}
// Best-effort agent resolution by email via the GoTrue admin API. Never throws.
async function resolveAgentByEmail(email, env) {
  if (!email) return { id: null, name: null };
  try {
    const u = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`, {
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
    });
    if (!u.ok) return { id: null, name: null };
    const uj = await u.json().catch(() => null);
    const list = Array.isArray(uj?.users) ? uj.users : (Array.isArray(uj) ? uj : []);
    const match = list.find(x => (x.email || '').toLowerCase() === email.toLowerCase());
    const uid = match?.id || null;
    if (!uid) return { id: null, name: null };
    const p = await sb(`/rest/v1/users_profile?id=eq.${uid}&select=full_name&limit=1`, env);
    return { id: uid, name: p.data?.[0]?.full_name || null };
  } catch { return { id: null, name: null }; }
}

// insertHistorySystem() and upsertCsCall() moved to src/telephony/call-pipeline.js
// (S301) — they are vendor-neutral and Exotel needs them too. The INSERT-result check
// added there is the one behaviour change: it was silently dropping failed rows.


async function webhookCallAnswered(body, env, account) {
  const c = parseMyOp(body);
  if (!c.session_id) return err('missing session_id', 400);
  const norm = myopNorm(c, account);
  const pipe = callPipeline(env);

  // 1) cs_calls — record the answered state (idempotent)
  await pipe.upsertCall(norm, {
    status: 'answered',
    started_at: c.timestamp || new Date().toISOString(),
    raw_meta: { last_event: 'answered' },
  });

  // 2) cs_tickets — dedupe / coalesce (RULE-PITSTOP-018) / create
  const r = await pipe.ensureTicket(norm);
  if (!r.ok) return err(r.error, r.status || 500);
  if (r.deduped)        return json({ ok: true, deduped: true, ticket_no: r.ticket_no });
  if (r.coalesced_into) return json({ ok: true, coalesced_into: r.coalesced_into });
  return json({ ok: true, ticket_no: r.ticket_no });
}

async function webhookCallEnd(body, env, account) {
  const c = parseMyOp(body);
  if (!c.session_id) return err('missing session_id', 400);
  const norm = myopNorm(c, account);
  const pipe = callPipeline(env);

  const answered = Number(c.duration) > 0;
  const endedAt  = c.timestamp || new Date().toISOString();

  // 1) cs_calls — always patch/insert; status is 'answered' if duration>0, else 'missed'
  await pipe.upsertCall(norm, {
    status: answered ? 'answered' : 'missed',
    ended_at: endedAt,
    duration_seconds: c.duration,
    recording_filename: c.recording_filename,
    myop_client_ref_id: c.client_ref_id,
    raw_meta: { last_event: 'end' },
  });

  // 2) cs_tickets — patch if exists; create only if answered (out-of-order delivery)
  const ticketPatch = {
    call_ended_at: endedAt,
    call_duration_seconds: c.duration,
    call_recording_filename: c.recording_filename,
    myop_client_ref_id: c.client_ref_id,
  };
  const patched = await pipe.patchTicketCallFields(norm, ticketPatch);
  if (patched) return json({ ok: true, patched: true });

  // Missed call with no prior call.answered → cs_calls row stands alone, no ticket
  if (!answered) {
    return json({ ok: true, skipped: 'unanswered call — cs_calls row written, no ticket' });
  }
  // Out-of-order: an answered call whose call.end arrived before call.answered.
  // ⚠️ This upsert is NOT redundant with the one above. The original delegated to
  // webhookCallAnswered(), which stamped started_at and reset raw_meta.last_event to
  // 'answered' before creating the ticket. Dropping it left started_at NULL whenever
  // call.answered never followed — caught reviewing this extraction, not in testing,
  // because the MyOperator path has carried no traffic since 2026-08-19.
  await pipe.upsertCall(norm, {
    status: 'answered',
    started_at: c.timestamp || new Date().toISOString(),
    raw_meta: { last_event: 'answered' },
  });
  const created = await pipe.ensureTicket(norm);
  if (!created.ok) return err(created.error, created.status || 500);
  await pipe.patchTicketCallFields(norm, ticketPatch);
  if (created.coalesced_into) return json({ ok: true, coalesced_into: created.coalesced_into });
  return json({ ok: true, ticket_no: created.ticket_no });
}

// call.summary carries agent identity (legs[].agent.email) that call.answered
// lacks. Backfill the ticket's assignee when the summary arrives.
async function webhookCallSummary(body, env, account) {
  const c = parseMyOp(body);
  if (!c.session_id) return json({ ok: true, skipped: 'no session_id' });
  const norm = myopNorm(c, account);
  const pipe = callPipeline(env);
  const agentEmail = agentEmailFromLegs(c.legs);

  // Instrument (step 1): persist the raw legs so the next real routed call
  // confirms the per-leg shape (status/duration field names) and pickConnectedLeg
  // can be refined if needed. Captured even when no agent matches. (Pruthvi S144.)
  const callMeta = {
    last_event: 'summary',
    legs: Array.isArray(c.legs) ? c.legs : [],
    chosen_agent_email: agentEmail || null,
  };
  if (!agentEmail) {
    await pipe.attributeAgent(norm, { agent: null, callMeta });
    return json({ ok: true, skipped: 'no agent email in summary' });
  }
  const agent = await resolveAgentByEmail(agentEmail, env);
  if (!agent.id) {
    await pipe.attributeAgent(norm, { agent: null, callMeta });
    return json({ ok: true, skipped: 'agent email not matched: ' + agentEmail });
  }
  const r = await pipe.attributeAgent(norm, { agent, callMeta });
  return json({ ok: true, assigned: r.assigned });
}

/**
 * Resolve a PLAYABLE recording URL for one call.
 *
 * ⚠️ Exotel's RecordingUrl is PRE-SIGNED and EXPIRES (RecordingUrlValidity, 5-60 min).
 * A URL stored at poll time is dead by the time an agent clicks it, so playback must
 * resolve on demand and a stored URL must NEVER be treated as permanent. This is why
 * the player asks the worker for a link instead of rendering cs_calls.recording_url.
 *
 * Recordings have never once played in Pitstop: recording_url is NULL on all 17,705
 * MyOperator rows and the detail page rendered the filename as inert text. MyOperator
 * rows stay unplayable (we only ever received a filename, and that vendor's CDR API is
 * not wired) - they now say so plainly instead of showing a dead affordance.
 */
async function getCallRecording(params, auth, env) {
  const g = require('cs_ticket_view', auth); if (g) return g;
  const id = params.get('call_id');
  if (!id) return err('call_id required');

  const r = await sb(`/rest/v1/cs_calls?id=eq.${encodeURIComponent(id)}`
    + `&select=provider,provider_call_sid,recording_url,recording_filename,duration_seconds&limit=1`, env);
  const call = r.data?.[0];
  if (!call) return err('Call not found', 404);

  if (call.provider !== 'exotel') {
    return ok({
      playable: false,
      reason: 'MyOperator calls only ever gave us a filename, never a playable URL.',
      filename: call.recording_filename || null,
    });
  }
  if (!exotelConfigured(env)) return err('Exotel not configured', 503);
  if (!call.provider_call_sid) return ok({ playable: false, reason: 'No provider call id on this row.' });

  const client = makeExotelClient(env);
  const fresh = await client.getCallsBySid([call.provider_call_sid], { recordingValidityMinutes: 60 });
  if (!fresh.ok) return err(`Could not reach Exotel: ${fresh.error}`, 502);

  const url = fresh.calls?.[0]?.RecordingUrl || null;
  if (!url) {
    return ok({
      playable: false,
      reason: 'Exotel has no recording for this call (short or unanswered calls often have none).',
    });
  }
  // Cache the latest known URL so the list can show a recording EXISTS without a
  // per-row API call. It is deliberately not treated as playable on its own.
  await sb(`/rest/v1/cs_calls?id=eq.${encodeURIComponent(id)}`, env,
    { method: 'PATCH', body: JSON.stringify({ recording_url: url }) }).catch(() => {});

  return ok({ playable: true, url, expires_in_minutes: 60 });
}

// ── Exotel call-flow webhooks (Phase 4 — the screen-pop) ─────────────────────

/**
 * Constant-time-ish comparison of the shared secret. Not a timing-attack-proof
 * primitive, but it avoids the trivial early-exit of `!==` on a token in a query
 * string that lands in logs and referrers.
 */
/**
 * Run background work without blocking the response. Falls back to fire-and-forget if
 * ctx is somehow absent — the isolate may be torn down early, but a missing ctx must
 * never turn a webhook into a 500 while a customer is on the line.
 */
function background(ctx, promise) {
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(promise);
  else promise.catch(e => console.error('[bg] unsupervised task failed', e?.message || e));
}

function exotelWebhookAuthed(url, env) {
  const given = url.searchParams.get('token') || '';
  const want = env.EXOTEL_WEBHOOK_TOKEN || '';
  if (!want || given.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= given.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

/**
 * START-OF-FLOW hook. Exotel calls this the moment a call lands, before the greeting
 * finishes, so we have the greeting (~6s) plus the ring (up to 30s) to have the
 * customer's whole picture ready.
 *
 * ⚠️ RETURNS A BARE 200 IMMEDIATELY. Exotel is holding a live customer on the line
 * while it waits for this response — every lookup happens in ctx.waitUntil(). If this
 * ever blocks, a customer hears silence, which is far worse than a missing screen-pop.
 *
 * ⚠️ This is an ACCELERATOR, not a source of truth. The poller remains the completeness
 * guarantee (a caller who hangs up during the greeting may fire nothing at all), so
 * nothing downstream may assume this ran.
 */
async function handleExotelWarm(request, url, env, ctx) {
  if (!exotelWebhookAuthed(url, env)) return err('Unauthorized', 401);

  const sid   = url.searchParams.get('CallSid') || url.searchParams.get('sid');
  const from  = url.searchParams.get('CallFrom') || url.searchParams.get('From');
  const to    = url.searchParams.get('CallTo') || url.searchParams.get('To');
  const dir   = url.searchParams.get('Direction') || 'incoming';

  // Respond first, work after. Nothing below is allowed to delay the response.
  background(ctx, (async () => {
    try {
      const pipe = callPipeline(env);
      const context = makeCallContext({ env, sb, toE164, shopifyLookup });
      const phone = normaliseDirection(dir, 'exotel') === 'outgoing' ? to : from;

      // Create the row NOW so the agent's browser can see an in-flight call. status is
      // NOT NULL, so an in-flight call must be written as in_progress rather than blank.
      const norm = {
        provider: 'exotel',
        call_session_id: sid, provider_call_sid: sid,
        account_id: null, department_id: null,
        direction: normaliseDirection(dir, 'exotel'),
        exophone: url.searchParams.get('CallTo') || null,
        customer_phone: phone,
        started_at: new Date().toISOString(),
        legs: [], agent_ref: {},
      };
      const row = await pipe.upsertCall(norm, {
        status: 'in_progress',
        started_at: norm.started_at,
        raw_meta: { last_event: 'warm', provider: 'exotel' },
      });
      if (row?.id) await context.warm(row.id, phone);
      console.log(`[exotel:warm] sid=${sid} phone=${phone ? 'yes' : 'none'} warmed=${!!row?.id}`);
    } catch (e) {
      console.error(`[exotel:warm] failed sid=${sid}: ${e?.message || e}`);
    }
  })());

  return json({ ok: true });
}

/**
 * AGENT hook — Exotel's own `agent-passthru-url` on the Connect applet: "when dialling
 * multiple agents, we will pass the details of the currently active agent to this URL".
 *
 * This is what makes the pop land on the RIGHT agent's screen, and it doubles as the
 * live attribution fix. It is a notification, not a step in the call path, so it cannot
 * block the customer — which is why it is preferred over inserting a Passthru applet
 * ahead of Connect.
 */
async function handleExotelAgent(request, url, env, ctx) {
  if (!exotelWebhookAuthed(url, env)) return err('Unauthorized', 401);

  const sid = url.searchParams.get('CallSid') || url.searchParams.get('sid');
  // Exotel's parameter naming here is not pinned down in the docs, and the observed
  // call payload used `To` for the agent leg. Accept the plausible spellings rather
  // than guess one; unknown values simply fail to match the roster and get logged.
  const agentRef = url.searchParams.get('AgentId')
    || url.searchParams.get('AgentSipId')
    || url.searchParams.get('CurrentAgent')
    || url.searchParams.get('To')
    || url.searchParams.get('DialWhomNumber');

  const customerRaw = url.searchParams.get('CallFrom') || url.searchParams.get('From');
  const dirRaw = url.searchParams.get('Direction') || 'incoming';

  background(ctx, (async () => {
    try {
      // Log every parameter Exotel actually sends, once we have a sid. Their docs do
      // not pin this payload down, and the last two field-name assumptions here were
      // both wrong (To was the agent, AnsweredBy was "human"). Cheap, and it makes the
      // real shape evident from the logs instead of another reading of the docs.
      console.log(`[exotel:agent] sid=${sid} params=${JSON.stringify(
        Object.fromEntries([...url.searchParams.entries()].filter(([k]) => k !== 'token')))}`);
      if (!sid) return;

      const pipe = callPipeline(env);
      const direction = normaliseDirection(dirRaw, 'exotel') || 'incoming';

      // ⚠️ CREATE the row if it does not exist yet, do not merely PATCH.
      //
      // This hook is now the ONLY flow-side hook we ask for: adding a Passthru applet
      // at flow start would mean dropping it onto the slot that already holds the live
      // Greeting, which risks replacing a customer-facing prompt to buy ~6 seconds. The
      // ring gives us up to 30 seconds anyway. But that means the call row may not exist
      // yet when this fires (the poller runs every 2 min), so a bare PATCH would match
      // zero rows and silently do nothing.
      const norm = {
        provider: 'exotel',
        call_session_id: sid, provider_call_sid: sid,
        account_id: null, department_id: null,
        direction,
        exophone: url.searchParams.get('CallTo') || null,
        customer_phone: customerRaw || null,
        legs: [], agent_ref: {},
      };
      const row = await pipe.upsertCall(norm, {
        status: 'in_progress',
        started_at: new Date().toISOString(),
        raw_meta: { last_event: 'agent', provider: 'exotel' },
      });

      // Attribute, so the pop lands on the right agent's screen.
      let matched = null;
      if (agentRef) {
        const roster = await sb(`/rest/v1/cs_telephony_agents?is_active=is.true`
          + `&select=user_id,sip_id,agent_phone&limit=500`, env);
        const wantSip = String(agentRef).toLowerCase();
        const wantTel = toE164(agentRef);
        matched = (roster.data || []).find(a =>
          (a.sip_id && a.sip_id.toLowerCase() === wantSip) ||
          (a.agent_phone && wantTel && a.agent_phone === wantTel)) || null;
        if (!matched) console.log(`[exotel:agent] unmatched agent ref "${agentRef}" sid=${sid}`);
      }
      if (matched && row?.id) {
        const prof = await sb(`/rest/v1/users_profile?id=eq.${matched.user_id}&select=full_name&limit=1`, env);
        await sb(`/rest/v1/cs_calls?id=eq.${row.id}`, env, {
          method: 'PATCH',
          body: JSON.stringify({
            agent_user_id: matched.user_id,
            agent_name: prof.data?.[0]?.full_name || null,
            agent_sip_id: matched.sip_id || null,
          }),
        });
      }

      // Warm the context while the phone is still ringing. Skipped if a previous hook
      // already did it — the card is a snapshot, and re-assembling costs Shopify calls
      // for no gain.
      if (row?.id) {
        const phone = customerRaw || row.customer_phone;
        const existing = await sb(`/rest/v1/cs_calls?id=eq.${row.id}&select=context_warmed_at&limit=1`, env);
        if (phone && !existing.data?.[0]?.context_warmed_at) {
          const context = makeCallContext({ env, sb, toE164, shopifyLookup });
          await context.warm(row.id, phone);
        }
      }
      console.log(`[exotel:agent] sid=${sid} agent=${matched ? 'matched' : 'none'} row=${!!row?.id}`);
    } catch (e) {
      console.error(`[exotel:agent] failed sid=${sid}: ${e?.message || e}`);
    }
  })());

  return json({ ok: true });
}

/**
 * The screen-pop payload, for the browser.
 *
 * `mine=true` returns the caller's own in-flight call — that is what the CallBar polls
 * so a pop only ever lands on the agent actually on the call.
 */
async function getCallContext(params, auth, env) {
  const g = require('cs_ticket_view', auth); if (g) return g;
  const context = makeCallContext({ env, sb, toE164, shopifyLookup });

  const callId = params.get('call_id');
  const phone = params.get('phone');

  if (params.get('mine') === 'true') {
    // In-flight call assigned to me. Bounded to the last 30 min so a stuck
    // in_progress row cannot pop on someone's screen indefinitely.
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const r = await sb(`/rest/v1/cs_calls?status=eq.in_progress`
      + `&agent_user_id=eq.${auth.userId}`
      + `&started_at=gte.${encodeURIComponent(since)}`
      + `&select=id,provider_call_sid,customer_phone,direction,started_at,ticket_id,customer_context`
      + `&order=started_at.desc&limit=1`, env);
    const call = r.data?.[0];
    if (!call) return ok({ active: false });
    return ok({
      active: true,
      call: { id: call.id, phone: call.customer_phone, direction: call.direction,
              started_at: call.started_at, ticket_id: call.ticket_id },
      context: call.customer_context || await context.assemble({ phone: call.customer_phone, excludeCallId: call.id }),
    });
  }

  if (callId) {
    const r = await sb(`/rest/v1/cs_calls?id=eq.${encodeURIComponent(callId)}`
      + `&select=id,customer_phone,customer_context&limit=1`, env);
    const call = r.data?.[0];
    if (!call) return err('Call not found', 404);
    // Stored context is a snapshot of what the agent saw; fall back to live assembly
    // when the warm hook never ran (it is an accelerator, not a guarantee).
    return ok(call.customer_context
      || await context.assemble({ phone: call.customer_phone, excludeCallId: call.id }));
  }

  if (phone) return ok(await context.assemble({ phone }));
  return err('call_id, phone or mine=true required');
}

// ── Click-to-call (Phase 5) ──────────────────────────────────────────────────

const EXOPHONE_DEFAULT = '08044656833';   // the account's only ExoPhone

/**
 * Ring the agent, then the customer, and bridge them — all on the ExoPhone, so the
 * customer never sees a personal number and the agent never dials one.
 *
 * ⚠️ Gated on cs_ticket_manage, checked FIRST (RULE-011). Placing a call spends real
 * money and rings a real customer.
 */
async function placeCall(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  if (!exotelConfigured(env)) return err('Exotel not configured', 503);

  const to = toE164(body?.to);
  if (!to) return err('A valid customer number is required', 422);

  // Refuse to ring ourselves. Without this, a mistyped or mis-parsed number can put
  // the ExoPhone in a loop with itself.
  if (to === toE164(env.EXOTEL_EXOPHONE || EXOPHONE_DEFAULT)) {
    return err('That is our own number', 422);
  }

  const me = await sb(`/rest/v1/cs_telephony_agents?user_id=eq.${auth.userId}&is_active=is.true`
    + `&select=sip_id,agent_phone,device_preference&limit=1`, env);
  const agent = me.data?.[0];
  if (!agent) {
    return err('You have no telephony device set up. Ask an admin to add you on Admin → Telephony.', 409);
  }
  // Prefer the configured device, but fall back rather than fail: an agent whose SIP
  // is not registered can still take the call on their mobile.
  const from = (agent.device_preference === 'sip' && agent.sip_id)
    ? agent.sip_id
    : (agent.agent_phone || agent.sip_id);
  if (!from) return err('Your telephony device has no SIP id or phone number', 409);

  // ⚠️ CustomField is Exotel's ONLY carry-through to the callbacks, and it is capped at
  // 128 chars. This is what makes outbound attribution exact by construction instead of
  // inferred from a leg — so it is built compactly and asserted, never truncated blind.
  const custom = `u=${auth.userId}` + (body?.ticket_id ? `;t=${body.ticket_id}` : '');
  if (custom.length > 128) return err('Internal: CustomField too long', 500);

  const client = makeExotelClient(env);
  const statusCallback = env.EXOTEL_WEBHOOK_TOKEN
    ? `https://csops.afshaan.workers.dev/webhooks/exotel/status?token=${encodeURIComponent(env.EXOTEL_WEBHOOK_TOKEN)}`
    : undefined;

  const r = await client.connect({
    from, to,
    callerId: env.EXOTEL_EXOPHONE || EXOPHONE_DEFAULT,
    customField: custom,
    statusCallback,
    timeLimit: 3600,
    timeout: 30,
  });

  if (!r.ok) {
    // 429 is the shared 200/min account budget, not a per-agent limit — say so, or the
    // agent retries into the same wall.
    if (r.status === 429) return err('Exotel is rate-limiting the account — try again in a minute.', 429);
    return err(`Could not place the call: ${r.error}`, 502);
  }

  const placed = r.data?.Call || {};
  const sid = placed.Sid;

  // Write the row immediately as in_progress so the call appears in the log — and the
  // CallPop fires — the moment it starts, rather than up to 2 minutes later when the
  // poller catches up. status is NOT NULL, so there is no "pending" resting state.
  if (sid) {
    const pipe = callPipeline(env);
    await pipe.upsertCall({
      provider: 'exotel',
      call_session_id: sid, provider_call_sid: sid,
      account_id: null, department_id: null,
      direction: 'outgoing',
      exophone: env.EXOTEL_EXOPHONE || EXOPHONE_DEFAULT,
      customer_phone: to,
      legs: [], agent_ref: {},
    }, {
      status: 'in_progress',
      started_at: new Date().toISOString(),
      agent_user_id: auth.userId,
      agent_name: auth.fullName || null,
      agent_sip_id: from.startsWith('sip:') ? from : null,
      ticket_id: body?.ticket_id || null,
      raw_meta: { last_event: 'placed', provider: 'exotel' },
    });
  }
  console.log(`[exotel:place] sid=${sid} by=${auth.userId} device=${from.startsWith('sip:') ? 'sip' : 'tel'}`);
  return ok({ sid, status: placed.Status || 'in-progress', from_device: from.startsWith('sip:') ? 'sip' : 'tel' });
}

/**
 * StatusCallback for calls we placed. Gives the outbound leg its state in seconds
 * rather than waiting for the next poll.
 *
 * ⚠️ Still not a source of truth — the poller reconciles regardless. This only makes
 * the UI feel live.
 */
async function handleExotelStatus(request, url, env, ctx) {
  if (!exotelWebhookAuthed(url, env)) return err('Unauthorized', 401);
  const payload = await request.json().catch(() => null);

  background(ctx, (async () => {
    try {
      const call = payload?.Call || payload || {};
      const sid = call.Sid || call.CallSid;
      if (!sid) return;
      const talk = Number(call.Details?.ConversationDuration ?? call.ConversationDuration);
      const { status, dial_status } = mapExotelStatus(call.Status, talk);
      const patch = { status, dial_status, raw_meta: { last_event: 'status', provider: 'exotel' } };
      if (Number.isFinite(talk)) patch.talk_duration_seconds = talk;
      if (call.Duration != null) patch.duration_seconds = Number(call.Duration);
      if (call.EndTime) patch.ended_at = fromIstNaive(call.EndTime);
      if (call.RecordingUrl) patch.recording_url = call.RecordingUrl;

      await sb(`/rest/v1/cs_calls?provider=eq.exotel&provider_call_sid=eq.${encodeURIComponent(sid)}`, env,
        { method: 'PATCH', body: JSON.stringify(patch) });
      console.log(`[exotel:status] sid=${sid} -> ${status}`);
    } catch (e) {
      console.error('[exotel:status] failed', e?.message || e);
    }
  })());

  return json({ ok: true });
}

// ── Telephony roster (Phase 5) ───────────────────────────────────────────────

/**
 * Who can be dialled from, and on what device. This is what gates click-to-call
 * working for a given agent, so it needs to be visible and editable rather than a
 * table only SQL can reach.
 */
async function getTelephonyAgents(_params, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  const [agents, profiles] = await Promise.all([
    sb(`/rest/v1/cs_telephony_agents?select=*&order=created_at.asc`, env),
    sb(`/rest/v1/users_profile?active=is.true&select=id,full_name,role&order=full_name.asc`, env),
  ]);
  const byId = Object.fromEntries((agents.data || []).map(a => [a.user_id, a]));

  // Scope to people who could plausibly place a call, PLUS anyone already configured.
  //
  // The first version returned every active user so that "who cannot call" was visible.
  // In practice that is 77 rows, 71 of them `viewer` accounts that will never touch a
  // phone — which buries the one row that matters (a cs_agent with no device). Showing
  // everything and showing nothing fail the same way.
  const CALLING_ROLES = new Set(['cs_agent', 'cs_lead', 'admin', 'super_admin']);
  const users = (profiles.data || [])
    .filter(u => CALLING_ROLES.has(u.role) || byId[u.id])
    .map(u => ({
      user_id: u.id, full_name: u.full_name, role: u.role,
      telephony: byId[u.id] || null,
    }));

  return ok({
    users,
    // The number worth acting on: CS people who cannot currently place a call.
    needs_setup: users.filter(u => !u.telephony?.is_active).length,
    exophone: env.EXOTEL_EXOPHONE || EXOPHONE_DEFAULT,
  });
}

async function setTelephonyAgent(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  const { user_id, sip_id, agent_phone, device_preference, is_active } = body || {};
  if (!user_id) return err('user_id required');
  if (device_preference && !['sip', 'tel'].includes(device_preference)) {
    return err('device_preference must be sip or tel', 422);
  }
  const phone = agent_phone ? toE164(agent_phone) : null;
  // An agent's number must be stored in the same shape cs_calls uses, or attribution
  // silently never matches it — the exact class of bug that made every Exotel caller
  // read as "Unknown caller".
  const row = {
    user_id,
    provider: 'exotel',
    sip_id: sip_id || null,
    agent_phone: phone,
    device_preference: device_preference || (sip_id ? 'sip' : 'tel'),
    is_active: is_active !== false,
    last_synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const r = await sb(`/rest/v1/cs_telephony_agents?on_conflict=user_id`, env, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(row),
  });
  if (!r.ok) return err(`Save failed: ${JSON.stringify(r.data)}`, r.status);
  return ok({ agent: r.data?.[0] || row });
}

// ── Exotel operations ────────────────────────────────────────────────────────

/**
 * Live health probe for the Exotel integration.
 *
 * Exists because "the poller is running" and "the poller is working" look identical
 * from the outside when credentials are wrong — a 401 every two minutes reads as a
 * quiet day. This makes the failure legible, and later backs the /admin/telephony
 * status panel.
 *
 * Reads one call. Never returns the key or token.
 */
async function getExotelHealth(_params, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  if (!exotelConfigured(env)) {
    return ok({ configured: false, reason: 'EXOTEL_API_KEY / EXOTEL_API_TOKEN not set' });
  }
  const client = makeExotelClient(env);
  const started = Date.now();
  const r = await client.listCalls({ pageSize: 1, sortAsc: false, details: true });

  const [logged, latest] = await Promise.all([
    sb(`/rest/v1/cs_calls?provider=eq.exotel&select=id&limit=1`, env),
    sb(`/rest/v1/cs_calls?provider=eq.exotel&select=started_at,status,direction`
       + `&order=started_at.desc.nullslast&limit=1`, env),
  ]);

  const sample = r.calls?.[0] || null;
  return ok({
    configured: true,
    account_sid: client.accountSid,
    host: client.host,
    reachable: r.ok,
    error: r.ok ? null : r.error,
    http_status: r.status ?? null,
    latency_ms: Date.now() - started,
    // Field names, not values — enough to confirm the response shape without putting
    // a customer's number in an admin payload.
    sample_fields: sample ? Object.keys(sample) : [],
    sample_detail_fields: sample?.Details ? Object.keys(sample.Details) : [],
    sample_status: sample?.Status ?? null,
    sample_direction: sample?.Direction ?? null,
    rows_in_pitstop: (logged.data || []).length > 0,
    latest_logged: latest.data?.[0] || null,
  });
}

/**
 * One-shot backfill of the blind window (cutover 2026-08-19 18:08 IST → now).
 *
 * ⚠️ Creates NO tickets. Retro-firing ticket creation over days of calls would spray
 * hundreds of '[Pending — auto-created from call]' rows into a live queue and reset
 * every SLA clock. Rows land as call history; CS raises tickets by hand for anything
 * that needs one.
 * ⚠️ Snapshot store.safety_cs_calls_2026_08_20 was taken before this shipped.
 */
async function runExotelBackfill(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  if (!exotelConfigured(env)) return err('Exotel not configured', 503);

  const since = body?.since ? new Date(body.since) : new Date('2026-08-19T12:38:00Z'); // 18:08 IST
  const until = body?.until ? new Date(body.until) : new Date();
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) {
    return err('since/until must be ISO timestamps', 422);
  }
  if (since >= until) return err('since must be before until', 422);

  const r = await backfillExotelCalls(env, callPipeline(env), { since, until });
  console.log('[exotel] backfill', JSON.stringify(r));
  return ok(r);
}

// ── MyOp account registry ────────────────────────────────────────────────────

const SLUG_RE = /^[a-z][a-z0-9_-]{1,30}$/;

async function getMyopAccounts(_params, _auth, env) {
  const r = await sb(
    `/rest/v1/myop_accounts?select=*&order=created_at.asc`,
    env,
  );
  if (!r.ok) return err('Failed to load MyOp accounts', 500);
  return ok(r.data || []);
}

async function createMyopAccount(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  const { slug, name, did, owner_email, notes } = body;
  if (!slug || !SLUG_RE.test(slug)) {
    return err('slug required — lowercase letters, digits, dash/underscore; starts with a letter; 2-31 chars');
  }
  if (!name) return err('name required');
  const r = await sb(`/rest/v1/myop_accounts`, env, {
    method: 'POST',
    body: JSON.stringify({
      slug, name,
      did: did || null,
      owner_email: owner_email || null,
      notes: notes || null,
      is_active: true,
    }),
  });
  if (!r.ok) return err(`create failed: ${JSON.stringify(r.data)}`, r.status);
  return ok({ account: r.data?.[0] });
}

async function updateMyopAccount(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  const { id, patch } = body;
  if (!id || !patch || typeof patch !== 'object') return err('id and patch required');
  const ALLOWED = ['name', 'did', 'owner_email', 'notes', 'is_active', 'default_department_id'];
  const clean = {};
  for (const k of ALLOWED) if (k in patch) clean[k] = patch[k];
  if (Object.keys(clean).length === 0) return err('nothing to update');
  const r = await sb(`/rest/v1/myop_accounts?id=eq.${encodeURIComponent(id)}`, env, {
    method: 'PATCH',
    body: JSON.stringify(clean),
  });
  if (!r.ok) return err(`update failed: ${JSON.stringify(r.data)}`, r.status);
  return ok({ account: r.data?.[0] });
}

async function setMyopDefaultDepartment(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  const { id, department_id } = body;
  if (!id) return err('id required');
  const r = await sb(`/rest/v1/myop_accounts?id=eq.${encodeURIComponent(id)}`, env, {
    method: 'PATCH',
    body: JSON.stringify({ default_department_id: department_id || null }),
  });
  if (!r.ok) return err(`update failed: ${JSON.stringify(r.data)}`, r.status);
  return ok({ account: r.data?.[0] });
}

// ── Departments ──────────────────────────────────────────────────────────────

async function getDepartments(_params, _auth, env) {
  const r = await sb(`/rest/v1/cs_departments?select=*&order=sort_order.asc,name.asc`, env);
  if (!r.ok) return err('failed to load departments', 500);
  return ok(r.data || []);
}

// Lists agents with their dept assignment — used by /admin/departments to
// reassign users. Filters out inactive users.
async function getDeptAgents(_params, _auth, env) {
  const u = await sb(
    `/rest/v1/users_profile?active=eq.true&select=id,full_name,role,cs_department_id&order=full_name.asc&limit=500`,
    env,
  );
  if (!u.ok) return err('failed to load users', 500);

  // Only show users with cs_ticket_manage (these are the assignable agents).
  // We still return everyone for admin reassignment UX though — let the UI filter if needed.
  const rolesRes = await sb(`/rest/v1/roles?select=role_id,permissions`, env);
  const rolesMap = {};
  for (const r of (rolesRes.data || [])) rolesMap[r.role_id] = r.permissions || {};

  // Multi-department membership (#2): department_ids per user from the join table.
  const memRes = await sb(`/rest/v1/cs_user_departments?select=user_id,cs_department_id`, env);
  const deptsByUser = {};
  for (const m of (memRes.data || [])) {
    (deptsByUser[m.user_id] = deptsByUser[m.user_id] || []).push(m.cs_department_id);
  }

  const result = (u.data || []).map(p => ({
    ...p,
    has_cs_manage: !!rolesMap[p.role]?.cs_ticket_manage,
    has_cs_admin:  !!rolesMap[p.role]?.cs_ticket_admin,
    department_ids: deptsByUser[p.id] || (p.cs_department_id ? [p.cs_department_id] : []),
  }));
  return ok(result);
}

async function createDepartment(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  const { slug, name, sort_order } = body;
  if (!slug || !SLUG_RE.test(slug)) return err('slug required (lowercase, 2-31 chars)');
  if (!name) return err('name required');
  const r = await sb(`/rest/v1/cs_departments`, env, {
    method: 'POST',
    body: JSON.stringify({ slug, name, sort_order: sort_order ?? 100, is_active: true }),
  });
  if (!r.ok) return err(`create failed: ${JSON.stringify(r.data)}`, r.status);
  return ok({ department: r.data?.[0] });
}

async function updateDepartment(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  const { id, patch } = body;
  if (!id || !patch || typeof patch !== 'object') return err('id and patch required');
  const ALLOWED = ['name', 'sort_order', 'is_active'];
  const clean = {};
  for (const k of ALLOWED) if (k in patch) clean[k] = patch[k];
  if (Object.keys(clean).length === 0) return err('nothing to update');
  const r = await sb(`/rest/v1/cs_departments?id=eq.${encodeURIComponent(id)}`, env, {
    method: 'PATCH', body: JSON.stringify(clean),
  });
  if (!r.ok) return err(`update failed: ${JSON.stringify(r.data)}`, r.status);
  return ok({ department: r.data?.[0] });
}

async function assignUserDepartment(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  const { user_id, department_id } = body;
  if (!user_id) return err('user_id required');
  const r = await sb(`/rest/v1/users_profile?id=eq.${encodeURIComponent(user_id)}`, env, {
    method: 'PATCH',
    body: JSON.stringify({ cs_department_id: department_id || null }),
  });
  if (!r.ok) return err(`assign failed: ${JSON.stringify(r.data)}`, r.status);
  return ok({ user: r.data?.[0] });
}

// Set the full department membership for a user (#2 multi-department). Replaces
// the join-table set and keeps users_profile.cs_department_id as the primary
// (first by the given order, or null). Admin-gated.
async function setUserDepartments(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  const { user_id } = body;
  const department_ids = Array.isArray(body.department_ids) ? body.department_ids.filter(Boolean) : [];
  if (!user_id) return err('user_id required');

  // Replace the membership set.
  const del = await sb(`/rest/v1/cs_user_departments?user_id=eq.${encodeURIComponent(user_id)}`, env, {
    method: 'DELETE', prefer: 'return=minimal',
  });
  if (!del.ok) return err(`clear failed: ${JSON.stringify(del.data)}`, del.status);
  if (department_ids.length > 0) {
    const rows = department_ids.map(d => ({ user_id, cs_department_id: d }));
    const ins = await sb(`/rest/v1/cs_user_departments`, env, { method: 'POST', body: JSON.stringify(rows), prefer: 'return=minimal' });
    if (!ins.ok) return err(`assign failed: ${JSON.stringify(ins.data)}`, ins.status);
  }
  // Keep primary (home) dept in sync: first selected, or null.
  const primary = department_ids[0] || null;
  const up = await sb(`/rest/v1/users_profile?id=eq.${encodeURIComponent(user_id)}`, env, {
    method: 'PATCH', body: JSON.stringify({ cs_department_id: primary }), prefer: 'return=minimal',
  });
  if (!up.ok) return err(`primary update failed: ${JSON.stringify(up.data)}`, up.status);
  return ok({ user_id, department_ids });
}

// CS-tier roles a lead/admin may assign in-app. Deliberately EXCLUDES admin /
// super_admin / production_manager / store_head etc. — `users_profile.role` is
// the single GLOBAL cross-system role, so this control can NEVER set or overwrite
// a non-CS role (no privilege escalation outside CS). See systems/pitstop.md.
const CS_ROLE_TIERS = ['viewer', 'cs_agent', 'cs_lead'];

async function setCsRole(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;   // cs_lead + admin carry this
  const { user_id, role } = body;
  if (!user_id) return err('user_id required');
  if (!CS_ROLE_TIERS.includes(role)) return err('role must be one of: viewer, cs_agent, cs_lead', 400);
  if (user_id === auth.userId) return err('You cannot change your own role', 400);

  // Guardrail: only manage accounts that are already CS-tier (or unset). Refuse to
  // touch an account holding any other global role (admin/super_admin/etc.).
  const cur = await sb(`/rest/v1/users_profile?id=eq.${encodeURIComponent(user_id)}&select=role,full_name&limit=1`, env);
  if (!cur.ok || !cur.data?.[0]) return err('user not found', 404);
  const currentRole = cur.data[0].role || 'viewer';
  if (!CS_ROLE_TIERS.includes(currentRole)) {
    return err(`Cannot change ${cur.data[0].full_name || 'this user'} — they hold a non-CS role (${currentRole}). Change it in Garage.`, 409);
  }

  const r = await sb(`/rest/v1/users_profile?id=eq.${encodeURIComponent(user_id)}`, env, {
    method: 'PATCH',
    body: JSON.stringify({ role }),
  });
  if (!r.ok) return err(`role update failed: ${JSON.stringify(r.data)}`, r.status);
  return ok({ user: r.data?.[0] });
}

// ── Calls (list / detail / callback / convert-to-ticket) ─────────────────────

async function getCalls(params, auth, env) {
  const tab = params.get('tab') || 'all';
  const limit = Math.min(parseInt(params.get('limit') || '50'), 200);
  const offset = parseInt(params.get('offset') || '0');
  const direction = params.get('direction');
  const status = params.get('status');
  const account = params.get('account');   // slug
  const fromDate = params.get('from');
  const toDate = params.get('to');
  const search = (params.get('search') || '').trim();

  const filters = [];

  // Dept default-filter (admins can override via ?department=<slug>|all)
  const deptFilter = await resolveDeptFilter(params.get('department'), auth, env);
  if (!deptFilter) return err('Unknown department slug', 404);
  { const c = buildDeptFilter(deptFilter); if (c) filters.push(c); }

  // Open/Closed tabs distinguish active vs resolved CALL-LINKED tickets — they
  // require a linked ticket (inner join below) and filter on its closed_at.
  const ticketState = (tab === 'open' || tab === 'closed') ? tab : null;

  // tab presets
  if (tab === 'my')          filters.push(`agent_user_id=eq.${auth.userId}`);
  else if (tab === 'unassigned') filters.push(`agent_user_id=is.null`, `ticket_id=is.null`);
  else if (tab === 'missed') filters.push(`status=eq.missed`, `called_back_at=is.null`);
  // Abandoned is DISTINCT from missed and the split is the point: `missed` = nobody
  // picked up; `abandoned` = the caller hung up seconds in, having reached us. Merging
  // them hides both. 36 of 39 abandoned calls on the first live day lasted under 20s.
  else if (tab === 'abandoned') filters.push(`status=eq.abandoned`);
  // The callback worklist. Replaces nothing - every call still has its ticket; this is
  // the list of people who tried to reach us and did not.
  else if (tab === 'callback') filters.push(`needs_callback=is.true`, `called_back_at=is.null`);
  else if (ticketState === 'open')   filters.push(`ticket.closed_at=is.null`);
  else if (ticketState === 'closed') filters.push(`ticket.closed_at=not.is.null`);

  if (direction) filters.push(`direction=eq.${encodeURIComponent(direction)}`);
  if (status)    filters.push(`status=eq.${encodeURIComponent(status)}`);

  if (account) {
    // Resolve slug → id
    const a = await sb(`/rest/v1/myop_accounts?slug=eq.${encodeURIComponent(account)}&select=id&limit=1`, env);
    if (a.data?.[0]) filters.push(`myop_account_id=eq.${a.data[0].id}`);
  }
  if (fromDate) filters.push(`created_at=gte.${encodeURIComponent(fromDate)}`);
  if (toDate)   filters.push(`created_at=lte.${encodeURIComponent(toDate)}`);

  if (search) {
    const enc = encodeURIComponent(`*${search}*`);
    filters.push(`or=(customer_phone.ilike.${enc},customer_name.ilike.${enc},did.ilike.${enc})`);
  }

  // S301 additions: `provider` tells the UI which vendor a row came from;
  // `talk_duration_seconds` is the honest conversation length, while
  // `duration_seconds` keeps its original leg-time meaning so no existing metric
  // silently shifts; `dial_status` carries the granularity `status` discards.
  const select = 'id,myop_account_id,cs_department_id,call_session_id,direction,did,customer_phone,customer_name,agent_user_id,agent_name,status,duration_seconds,recording_filename,recording_url,started_at,ended_at,ticket_id,called_back_at,created_at,provider,provider_call_sid,talk_duration_seconds,dial_status,needs_callback,exophone';
  // Open/Closed tabs inner-join the ticket so a call with no ticket is excluded
  // and the closed_at filter on the embed can take effect.
  const ticketEmbed = ticketState ? 'ticket:ticket_id!inner(ticket_no,closed_at)' : 'ticket:ticket_id(ticket_no)';
  const path = `/rest/v1/cs_calls?select=${select},${ticketEmbed}&${filters.join('&')}&order=created_at.desc&limit=${limit}&offset=${offset}`;
  const r = await sb(path, env);
  if (!r.ok) return err(`Failed to fetch calls: ${JSON.stringify(r.data)}`, r.status);
  return ok({ calls: r.data || [], offset, limit });
}

async function getCall(params, auth, env) {
  const id = params.get('id');
  if (!id) return err('id required');
  const r = await sb(
    `/rest/v1/cs_calls?id=eq.${encodeURIComponent(id)}&select=*,ticket:ticket_id(ticket_no,customer_name,disposition,stage),myop_account:myop_account_id(slug,name),cs_department:cs_department_id(slug,name)&limit=1`,
    env,
  );
  if (!r.ok || !r.data?.[0]) return err('Call not found', 404);
  return ok({ call: r.data[0] });
}

async function getCallsKpis(_params, auth, env) {
  const startOfTodayIso = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();

  // Dept filter for non-admins
  const deptFilter = await resolveDeptFilter(null, auth, env);
  const deptClause = (() => { const c = buildDeptFilter(deptFilter); return c ? `&${c}` : ''; })();

  const day = `created_at=gte.${encodeURIComponent(startOfTodayIso)}`;
  const [today, answered, missed, abandoned, myOpen, awaitingCallback] = await Promise.all([
    sb(`/rest/v1/cs_calls?${day}${deptClause}&select=id&limit=5000`, env),
    sb(`/rest/v1/cs_calls?${day}&status=eq.answered${deptClause}&select=id&limit=5000`, env),
    sb(`/rest/v1/cs_calls?${day}&status=eq.missed${deptClause}&select=id&limit=5000`, env),
    sb(`/rest/v1/cs_calls?${day}&status=eq.abandoned${deptClause}&select=id&limit=5000`, env),
    sb(`/rest/v1/cs_calls?agent_user_id=eq.${auth.userId}&${day}${deptClause}&select=id&limit=5000`, env),
    sb(`/rest/v1/cs_calls?needs_callback=is.true&called_back_at=is.null${deptClause}&select=id&limit=5000`, env),
  ]);

  const total_today     = (today.data || []).length;
  const answered_today  = (answered.data || []).length;
  const missed_today    = (missed.data || []).length;
  const abandoned_today = (abandoned.data || []).length;

  // The denominator is calls that REACHED US, not every row. Dividing by total_today
  // counts outbound calls we placed ourselves as though they were inbound we answered,
  // which flatters the rate. Null rather than 0 when there is nothing to divide by -
  // 0% reads as a failure, where the truth is "no data yet".
  const reached = answered_today + missed_today + abandoned_today;
  const answer_rate_pct  = reached > 0 ? Math.round((answered_today  / reached) * 100) : null;
  const abandon_rate_pct = reached > 0 ? Math.round((abandoned_today / reached) * 100) : null;

  return ok({
    total_today, answered_today, missed_today, abandoned_today,
    answer_rate_pct, abandon_rate_pct,
    my_calls_today: (myOpen.data || []).length,
    unanswered_awaiting_callback: (awaitingCallback.data || []).length,
  });
}

async function markCalledBack(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { call_id, note } = body;
  if (!call_id) return err('call_id required');
  const r = await sb(`/rest/v1/cs_calls?id=eq.${encodeURIComponent(call_id)}`, env, {
    method: 'PATCH',
    body: JSON.stringify({
      called_back_at: new Date().toISOString(),
      called_back_by_user_id: auth.userId,
      called_back_note: note || null,
      // Clear the flag as well as stamping the time - the queue filters on
      // needs_callback, so leaving it set keeps a handled call in the worklist.
      needs_callback: false,
    }),
  });
  if (!r.ok) return err(`mark called-back failed: ${JSON.stringify(r.data)}`, r.status);
  return ok({ call: r.data?.[0] });
}

// Build a ticket from a missed-call row. Reuses createTicket() so all the
// validation + history + SLA + phone normalisation logic stays in one place.
async function createTicketFromCall(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { call_id, ...rest } = body;
  if (!call_id) return err('call_id required');

  const callRes = await sb(`/rest/v1/cs_calls?id=eq.${encodeURIComponent(call_id)}&select=*&limit=1`, env);
  const call = callRes.data?.[0];
  if (!call) return err('Call not found', 404);

  // Compose payload — agent-supplied fields override call-derived defaults
  const payload = {
    intake_channel: 'phone',
    customer_name:  rest.customer_name  || call.customer_name || (call.customer_phone ? `Caller ${call.customer_phone}` : 'Unknown caller'),
    customer_phone: rest.customer_phone || call.customer_phone,
    disposition:    rest.disposition    || 'pending',
    issue_description: rest.issue_description || '[Created from missed call]',
    cs_department_id: rest.cs_department_id || call.cs_department_id || null,
    ...rest,
  };

  const created = await createTicket(payload, auth, env);
  const createdData = await created.clone().json().catch(() => null);
  if (!createdData?.ok) return created;

  // Link cs_calls.ticket_id + call_session_id on the new ticket
  const ticketId = createdData?.data?.id;
  if (ticketId) {
    await sb(`/rest/v1/cs_calls?id=eq.${encodeURIComponent(call_id)}`, env, {
      method: 'PATCH', body: JSON.stringify({ ticket_id: ticketId, called_back_at: new Date().toISOString(), called_back_by_user_id: auth.userId }),
    });
    await sb(`/rest/v1/cs_tickets?id=eq.${ticketId}`, env, {
      method: 'PATCH', body: JSON.stringify({
        call_session_id: call.call_session_id,
        call_direction:  call.direction,
        call_did:        call.did,
        myop_account_id: call.myop_account_id,
      }),
    });
  }
  return created;
}

// ── WhatsApp (Phase C scaffold — data model + ticket UI; provider deferred) ──
//
// Phase C ships the data foundation (cs_wa_threads / cs_wa_messages /
// cs_wa_templates) and the ticket-detail panel so agents can see threads and
// queue outbound messages. Actual Meta/BSP send happens in Phase C2 once we
// pick a provider. Outbound rows here land with status='queued' and an
// explicit `provider_not_wired` status_error so they're easy to find later.

const WA_PROVIDER_NOT_WIRED_ERROR = 'provider_not_wired_phase_c2';

// 24h customer-initiated window — outside it, only utility templates may be sent.
function withinCustomerWindow(thread) {
  if (!thread?.customer_window_until) return false;
  return new Date(thread.customer_window_until).getTime() > Date.now();
}

// Find-or-create the thread for a given customer_phone. Phase C uses
// waba_phone_number_id=NULL (placeholder); Phase C2 will pass the real one and
// the unique constraint will split threads per WABA number.
async function findOrCreateWaThread(customer_phone, env, { create = true } = {}) {
  if (!customer_phone) return { thread: null, created: false };
  const norm = toE164(customer_phone);
  const r = await sb(
    `/rest/v1/cs_wa_threads?customer_phone=eq.${encodeURIComponent(norm)}&waba_phone_number_id=is.null&select=*&limit=1`,
    env,
  );
  if (r.data?.[0]) return { thread: r.data[0], created: false };
  // Find-only mode: read paths must NOT mint threads — getWaThread (the ticket WA tab)
  // was inserting a phone-only, message-less thread for every ticket opened whose customer
  // had no real WA conversation (~3.6k empty threads by 2026-07-22, Pruthvi). Threads are
  // created only on WRITE (send paths, inbound stub) — pass create:true there.
  if (!create) return { thread: null, created: false };
  const ins = await sb(`/rest/v1/cs_wa_threads`, env, {
    method: 'POST',
    body: JSON.stringify({ customer_phone: norm }),
  });
  return { thread: ins.data?.[0] || null, created: true };
}

async function getWaThread(params, auth, env) {
  const ticket_id = params.get('ticket_id');
  const ticket_no = params.get('ticket_no');
  if (!ticket_id && !ticket_no) return err('ticket_id or ticket_no required');

  // Resolve the ticket (we only need customer_phone)
  let tRes;
  if (ticket_id) {
    tRes = await sb(`/rest/v1/cs_tickets?id=eq.${ticket_id}&select=id,ticket_no,customer_phone&limit=1`, env);
  } else {
    tRes = await sb(`/rest/v1/cs_tickets?ticket_no=eq.${encodeURIComponent(ticket_no)}&select=id,ticket_no,customer_phone&limit=1`, env);
  }
  const t = tRes.data?.[0];
  if (!t) return err('Ticket not found', 404);
  if (!t.customer_phone) return ok({ thread: null, messages: [], reason: 'no_phone_on_ticket' });

  // Find-only: opening a ticket's WA tab must not create a thread (see findOrCreateWaThread).
  const { thread } = await findOrCreateWaThread(t.customer_phone, env, { create: false });
  if (!thread) return ok({ thread: null, messages: [], reason: 'no_thread_yet' });

  const msgsRes = await sb(
    `/rest/v1/cs_wa_messages?thread_id=eq.${thread.id}&select=*&order=created_at.asc&limit=500`,
    env,
  );

  return ok({
    thread,
    messages: msgsRes.data || [],
    within_customer_window: withinCustomerWindow(thread),
    provider_wired: false,   // flip to true in Phase C2
  });
}

async function getWaTemplates(_params, _auth, env) {
  const r = await sb(
    `/rest/v1/cs_wa_templates?is_active=eq.true&select=*&order=category.asc,name.asc`,
    env,
  );
  if (!r.ok) return err('failed to load WA templates', 500);
  return ok(r.data || []);
}

// ── Agent template send (S245, BiteSpeed exit) ───────────────────────────────
// THE CUTOVER BLOCKER THIS FIXES. A template is the ONLY way to speak to a customer once the
// 24h window has closed — and every window closes the moment a number migrates, because the
// window is keyed on (recipient, phone_number_id) and the phone_number_id changes. Until now
// the inbox told the agent "templates coming soon" and offered nothing, and the legacy
// sendWaMessage path only ever recorded a row (status_error = WA_PROVIDER_NOT_WIRED_ERROR) —
// it never called a provider, so nothing reached the customer.
//
// Source of truth is RELAY's comms.templates, NOT store.cs_wa_templates: the latter holds two
// local drafts that were never registered with Meta and therefore can never send. Restricted to
// APPROVED + active, since Meta refuses anything else at send time.
// getWaNumbers — which LOT WhatsApp numbers exist, keyed by the phone_number_id that lands on a
// thread. The inbox shows the agent WHICH of our numbers a conversation is on (Pruthvi: "display
// to which number the incoming WhatsApp message is coming to"), which matters because support,
// marketing and transactional read completely differently to a customer.
//
// Resolved from comms.sender_identities, NEVER hardcoded: a phone_number_id CHANGES every time a
// number is migrated between WABAs (support's changed on 2026-07-30), so a constant map would
// quietly mislabel the inbox the day after any migration — the same trap startWaConversation
// documents for the send path.
async function getWaNumbers(_params, auth, env) {
  const g = require('cs_ticket_view', auth); if (g) return g;
  const r = await sb('/rest/v1/sender_identities?channel=eq.whatsapp&select=address,purpose,status,metadata',
    env, { headers: { 'Accept-Profile': 'comms' } });
  if (!r.ok) return err('Failed to load WhatsApp numbers', 500);
  const out = [];
  for (const s of r.data || []) {
    const pid = s.metadata?.phone_number_id;
    if (!pid) continue;
    // Label with the NUMBER, not the purpose. The team refers to these by digits ("2323"), and
    // `purpose` would actively mislead here: the support number's purpose is `utility`, so a
    // purpose-labelled inbox would tag every support conversation "Utility". Purpose still rides
    // along for anyone who wants it. National digits only — the +91 is noise on every row.
    const addr = String(s.address || '');
    out.push({
      phone_number_id: String(pid),
      address: s.address || null,
      purpose: String(s.purpose || '').trim() || null,
      label: addr ? addr.replace(/^\+91/, '') : 'WhatsApp',
      active: s.status === 'active',
    });
  }
  return ok(out);
}

async function getWaSendTemplates(_params, auth, env) {
  const g = require('cs_ticket_view', auth); if (g) return g;
  const r = await sb(
    `/rest/v1/templates?channel=eq.whatsapp&approval_status=eq.APPROVED&status=eq.active`
    + `&select=id,name,variables,content&order=name.asc`,
    env, { headers: { 'Accept-Profile': 'comms' } });
  if (!r.ok) return err('Failed to load WhatsApp templates', 500);
  // Agent-facing set only. Journey templates (order placed, RTO, C2P…) are machine-triggered and
  // would be wrong — and often harmful — for a human to fire by hand from a support thread.
  const rows = (r.data || []).filter((t) => String(t.content?.meta_name || '').startsWith('lot_support'));
  return ok(rows.map((t) => {
    const bySource = new Map((Array.isArray(t.variables) ? t.variables : []).map((v) => [v.token, v]));
    // Ordered by `pos` because that is the {{n}} the body actually references — Meta binds
    // template parameters by position, so the agent's 1st input must line up with {{1}}.
    const mapping = (Array.isArray(t.content?.mapping) ? t.content.mapping : [])
      .slice().sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
    return {
      id: t.id,
      name: t.name,
      meta_name: t.content?.meta_name || null,
      // The approved body, placeholders intact, so the agent can see what they are sending
      // before they send it rather than trusting a template name.
      body: t.content?.body || null,
      fields: mapping.map((m) => ({
        pos: m.pos ?? 0,
        token: m.token,
        label: String(m.token || '').replace(/_/g, ' '),
        example: m.example || null,
        // `auto` = resolved server-side (first_name off the customer profile, with a "there"
        // fallback). Shown in the preview but never asked for, so a missing profile cannot
        // block a send and the agent isn't asked to retype something we already know.
        auto: (bySource.get(m.token)?.source || 'constant') !== 'constant',
      })),
    };
  }));
}

async function sendWaTemplateReply(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { thread_id, template_id, variables } = body;
  if (!thread_id || !template_id) return err('thread_id and template_id required');

  const tRes = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=*&limit=1`, env);
  const thread = tRes.data?.[0];
  if (!thread) return err('Thread not found', 404);
  if ((thread.channel || 'whatsapp') !== 'whatsapp') return err('Template send is WhatsApp-only', 422);
  if (!thread.customer_phone) return err('Thread has no customer phone', 422);
  // Deliberately NO window check — sending outside the window is the entire purpose.

  // Resolve the template up front: it validates that the agent picked something Meta will
  // actually accept, and gives us a real name for the recorded row (a bare uuid in the inbox
  // timeline tells the next agent nothing about what the customer was sent).
  const tpl = await sb(
    `/rest/v1/templates?id=eq.${encodeURIComponent(template_id)}&select=name,content,approval_status,status&limit=1`,
    env, { headers: { 'Accept-Profile': 'comms' } });
  const tplRow = tpl.data?.[0];
  if (!tplRow) return err('Template not found', 404);
  if (tplRow.approval_status !== 'APPROVED') return err(`Template is ${tplRow.approval_status} — Meta only accepts APPROVED templates`, 422);

  const consts = (variables && typeof variables === 'object') ? variables : {};
  let resp, data;
  try {
    resp = await callWorker(env.COMMSOPS, env, '/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.INGEST_TOKEN}` },
      body: JSON.stringify({
        channel: 'whatsapp', purpose: 'utility', to: thread.customer_phone,
        templateId: template_id,
        constants: consts,
        phoneNumberId: thread.waba_phone_number_id || undefined,   // reply on the same number
        dedupKey: `pitstop:tpl:${thread.id}:${Date.now()}`, source: 'pitstop_agent',
      }),
    });
    data = await resp.json().catch(() => ({}));
  } catch (e) { return err(`Relay send failed: ${e.message}`, 502); }
  if (!resp.ok || data?.ok === false)
    return err(`Relay send failed (${resp.status}): ${JSON.stringify(data)?.slice(0, 300)}`, resp.status || 502);

  const msg = data?.data || data?.message || data || {};
  // An unresolved variable or a Meta rejection comes back 200-with-status-failed. Surface it,
  // rather than showing the agent a message that never left.
  if (msg.status === 'failed' || msg.status === 'skipped')
    return err(`WhatsApp refused the template (${msg.reason || msg.status})`, 422);

  const pmid = msg.provider_message_id || msg.id || null;
  const now = new Date().toISOString();
  const senderName = auth.fullName || auth.name || auth.email || null;

  const threadPatch = { last_message_at: now };
  if (!thread.assigned_agent_id && !auth.viaIgnitionBridge) {
    threadPatch.assigned_agent_id = auth.userId;
    threadPatch.assigned_agent_name = senderName;
    threadPatch.assigned_at = now;
  }
  if (thread.thread_state && thread.thread_state !== 'open') clearClosedFields(threadPatch);
  await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, { method: 'PATCH', body: JSON.stringify(threadPatch) }).catch(() => {});

  const ticketId = auth.viaIgnitionBridge ? null : await assignLinkedTicketToReplier(thread.id, auth, env);
  const tplName = tplRow.content?.meta_name || tplRow.name || null;

  await sb(`/rest/v1/cs_wa_messages`, env, {
    method: 'POST',
    body: JSON.stringify({
      thread_id: thread.id, ticket_id: ticketId, direction: 'outbound', kind: 'template',
      waba_phone_number_id: thread.waba_phone_number_id || null,   // which LOT number this left from
      // Relay does not echo the rendered text back, so fall back to the friendly template name —
      // an empty bubble in the timeline reads as a failed send to the next agent.
      body: msg.rendered_text || tplRow.name || null, template_name: tplName,
      provider_message_id: pmid, status: msg.status || 'sent', is_internal: false,
      sent_by_user_id: auth.userId, sent_by_name: senderName, sent_at: now,
    }),
  }).catch((e) => console.error('[relay-wa] template insert failed', e?.message));

  if (ticketId) await insertHistory(ticketId, 'wa_message_sent', null, 'template', String(tplName || '').slice(0, 140), auth, env).catch(() => {});
  return ok({ message: { direction: 'outbound', kind: 'template', template_name: tplName, provider_message_id: pmid, status: msg.status || 'sent' }, via: 'relay' });
}

// POST startWaConversation — open a NEW WhatsApp conversation with a customer who has never
// written to us (or whose 24h window has closed). BiteSpeed's "Compose WhatsApp" equivalent.
//
// Pitstop had no way to do this at all: relayWaFindOrCreateThread was only ever reached from the
// INBOUND path, so a thread could only be BORN from a customer message. An agent holding a phone
// number and a reason to reach out had no entry point. That is a capability REGRESSION against
// BiteSpeed introduced by the support cutover, not a new feature request.
//
// WhatsApp permits a business-initiated message only via an approved TEMPLATE, so that is the only
// send mode here — but when a window IS open we refuse to burn one and hand the thread back
// instead: a session message is free, unconstrained, and reads far better mid-conversation.
async function startWaConversation(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { phone: rawPhone, template_id, variables } = body;
  if (!rawPhone) return err('phone required');

  // toE164 is deliberately permissive (it prefixes '+' to whatever digits it is handed), so the
  // SHAPE is validated here. Without this a fat-fingered number silently creates a junk thread
  // and then fails at Meta, leaving a dead conversation in the inbox that nobody can explain.
  const phone = toE164(rawPhone);
  if (!/^\+\d{10,15}$/.test(phone || '')) return err(`"${rawPhone}" is not a valid phone number`, 422);

  // Resolve the support number instead of hardcoding it: its phone_number_id CHANGES on every
  // WABA migration (it changed tonight), and a stale constant would quietly send from the wrong
  // number. Exactly one active utility WhatsApp sender is expected — anything else is ambiguous
  // and fails loudly rather than guessing and messaging customers from the marketing number.
  const sRes = await sb(
    '/rest/v1/sender_identities?channel=eq.whatsapp&purpose=eq.utility&status=eq.active&select=id,address,metadata',
    env, { headers: { 'Accept-Profile': 'comms' } });
  const senders = sRes.data || [];
  if (senders.length !== 1)
    return err(`Cannot resolve the support WhatsApp number — found ${senders.length} active utility senders, expected exactly 1`, 500);
  const supportPhoneId = senders[0].metadata?.phone_number_id || null;

  const thread = await relayWaFindOrCreateThread(phone, supportPhoneId, env);
  if (!thread) return err('Could not open a conversation for that number', 500);

  const openUntil = thread.customer_window_until ? new Date(thread.customer_window_until) : null;
  if (openUntil && openUntil > new Date())
    return ok({ thread_id: thread.id, sent: false, window_open: true,
      message: 'This customer already has an open 24-hour window — open the conversation and reply normally instead of spending a template.' });

  if (!template_id)
    return err('template_id required — there is no open 24-hour window, so WhatsApp only allows an approved template', 422);

  // Delegate the send. Template validation, the send gate, the cs_wa_messages row, ticket linking
  // and agent assignment all already live in sendWaTemplateReply; duplicating them here is exactly
  // how two send paths drift apart and one quietly stops recording messages.
  const resp = await sendWaTemplateReply({ thread_id: thread.id, template_id, variables }, auth, env);
  const j = await resp.json().catch(() => null);
  if (!resp.ok || j?.ok === false) return json(j || { ok: false, error: 'send_failed' }, resp.status || 502);
  return ok({ ...(j?.data || {}), thread_id: thread.id, sent: true });
}

// POST startEmailConversation — open a NEW email conversation with a customer who has not
// written in. The email twin of startWaConversation, and the one that will actually get used:
// email has no 24-hour window and no template requirement, so it is just To + Subject + Body.
async function startEmailConversation(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { to, subject, text, html, cc, bcc, name, attachments } = body;

  const addr = String(to || '').trim().toLowerCase();
  if (!addr) return err('to (email address) required');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) return err(`"${to}" is not a valid email address`, 422);
  // A REPLY can inherit the thread's subject; a new conversation has nothing to inherit, and a
  // blank-subject cold email is both worse for the customer and more likely to be filtered.
  if (!String(subject || '').trim()) return err('subject required for a new conversation', 422);
  if (!text && !html && !(Array.isArray(attachments) && attachments.length))
    return err('text, html, or an attachment required', 422);

  // Suppression is checked BEFORE creating anything. sendEmailReply would catch it too, but by
  // then we would have created an empty thread for someone we are never allowed to email —
  // permanent litter in the inbox that looks like a real conversation.
  const sup = await emailSuppressed(env, addr);
  if (sup.suppressed)
    return err(`${addr} is suppressed (${sup.reason}) — do not email. Reach out another way.`, 409);

  // Reuse the customer's ACTIVE email conversation when there is one, on the same 7-day rule the
  // inbound path uses to fold a customer's new mail into their existing thread. Without this an
  // agent composing to someone already being handled silently opens a SECOND conversation, and
  // two agents end up answering the same person from different threads.
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recent = await sb(
    `/rest/v1/cs_wa_threads?channel=eq.email&ignition_connect=is.false&external_user_id=eq.${encodeURIComponent(addr)}`
    + `&thread_state=in.(open,snoozed)&last_message_at=gte.${encodeURIComponent(since)}`
    + '&order=last_message_at.desc&select=*&limit=1', env);
  let thread = recent.data?.[0] || null;
  const reused = !!thread;

  if (!thread) {
    // No provider_thread_ref: there is no Gmail thread yet. sendEmailReply derives its
    // In-Reply-To/References from the latest INBOUND message, finds none, and correctly sends a
    // fresh mail rather than threading it onto something that does not exist.
    const ins = await sb('/rest/v1/cs_wa_threads', env, {
      method: 'POST',
      body: JSON.stringify({
        channel: 'email', external_user_id: addr,
        customer_handle: (name && String(name).trim()) || addr,
        subject: String(subject).trim(),
      }),
    });
    if (!ins.ok) return err(`Could not open an email conversation (${ins.status})`, 500);
    thread = ins.data?.[0];
  }
  if (!thread) return err('Could not open an email conversation', 500);

  // Delegate: recipient validation, suppression, threading headers, attachments, the outbound
  // message row and ticket linking all already live in sendEmailReply.
  const resp = await sendEmailReply(
    { thread_id: thread.id, text, html, cc, bcc, subject, attachments }, auth, env);
  const j = await resp.json().catch(() => null);
  if (!resp.ok || j?.ok === false) return json(j || { ok: false, error: 'send_failed' }, resp.status || 502);
  return ok({ ...(j?.data || {}), thread_id: thread.id, reused_existing_thread: reused, sent: true });
}

async function sendWaMessage(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const {
    ticket_id,
    kind,                              // 'text' | 'template' | 'image' | 'video' | 'audio' | 'document'
    body: msgBody,
    template_name,
    template_params,                   // [{ index: 1, value: 'https://...' }, ...] for templates
    media_url, media_filename, media_mime_type, media_size_bytes,
  } = body;
  if (!ticket_id) return err('ticket_id required');
  if (!kind)      return err('kind required');
  if (!['text','template','image','video','audio','document'].includes(kind)) return err('invalid kind');
  if (kind === 'template' && !template_name) return err('template_name required for template kind');
  if (['image','video','audio','document'].includes(kind) && !media_url) return err('media_url required for media kinds');

  const tRes = await sb(`/rest/v1/cs_tickets?id=eq.${ticket_id}&select=id,customer_phone&limit=1`, env);
  const t = tRes.data?.[0];
  if (!t) return err('Ticket not found', 404);
  if (!t.customer_phone) return err('Ticket has no customer_phone — cannot send WhatsApp', 422);

  const { thread } = await findOrCreateWaThread(t.customer_phone, env);
  if (!thread) return err('Failed to resolve thread', 500);

  // Meta utility-message-first rule: outside the 24h customer window, only
  // utility templates may be sent. Free-text replies are rejected here.
  if (kind !== 'template' && !withinCustomerWindow(thread)) {
    return err('Outside the 24h customer-initiated window — only utility templates may be sent until customer replies', 422);
  }

  // Resolve template body for the record (Phase C2 will pass params through to Meta)
  let resolvedBody = msgBody;
  if (kind === 'template') {
    const tplRes = await sb(`/rest/v1/cs_wa_templates?name=eq.${encodeURIComponent(template_name)}&is_active=eq.true&select=*&limit=1`, env);
    const tpl = tplRes.data?.[0];
    if (!tpl) return err(`Unknown or inactive template: ${template_name}`, 404);
    resolvedBody = tpl.body;
    // Substitute {{N}} placeholders with provided values
    const params = Array.isArray(template_params) ? template_params : [];
    for (const p of params) {
      const idx = Number(p?.index);
      if (Number.isFinite(idx) && p?.value != null) {
        resolvedBody = resolvedBody.split(`{{${idx}}}`).join(String(p.value));
      }
    }
  }

  const ins = await sb(`/rest/v1/cs_wa_messages`, env, {
    method: 'POST',
    body: JSON.stringify({
      thread_id: thread.id,
      ticket_id,
      direction: 'outbound',
      kind,
      body: resolvedBody || null,
      template_name: kind === 'template' ? template_name : null,
      media_url:        media_url || null,
      media_filename:   media_filename || null,
      media_mime_type:  media_mime_type || null,
      media_size_bytes: media_size_bytes || null,
      status: 'queued',
      status_error: WA_PROVIDER_NOT_WIRED_ERROR,   // Phase C2 will clear this and call Meta
      sent_by_user_id: auth.userId,
      sent_by_name: auth.fullName,
    }),
  });
  if (!ins.ok) return err(`Failed to record WA message: ${JSON.stringify(ins.data)}`, ins.status);

  // Bump thread.last_message_at for ordering in lists
  await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, {
    method: 'PATCH',
    body: JSON.stringify({ last_message_at: new Date().toISOString() }),
  });

  // History row on the linked ticket so agents see the activity in the timeline
  await insertHistory(ticket_id, 'wa_message_queued',
    null, (kind === 'template' ? `template:${template_name}` : kind),
    (resolvedBody || '').slice(0, 140), auth, env);

  return ok({
    message: ins.data?.[0],
    provider_wired: false,
    note: 'Recorded in Pitstop. Outbound delivery wires up in Phase C2 (Meta/BSP integration).',
  });
}

// ── Phase C2-B: two-way WhatsApp via the BiteSpeed (Chatwoot) Application API ──
//
// Interim path until the WABA migrates off BiteSpeed to direct Meta (Relay).
// KEY FACT: BiteSpeed's *webhook* only mirrors our OUTBOUND side (it never forwards
// customer replies — that's the documented "one-sided" limitation and why the local
// cs_wa_threads.customer_window_until column is always null). But the Chatwoot *API*
// returns the full two-way conversation, so we PULL it on demand to (a) show the
// customer's messages in Pitstop and (b) derive the real 24h window from the latest
// inbound. At WABA cutover these fetch()es swap to Meta Graph (like sendMetaMessage)
// and nothing else here changes.
function biteSpeedApiBase(env) {
  return (env.BITESPEED_API_BASE || 'https://chat.bitespeed.co').replace(/\/+$/, '');
}

// Pull the live Chatwoot conversation messages for a WA thread.
// Chatwoot's messages endpoint returns only the most recent page (~the latest
// messages). To show full scrollback we page BACKWARDS via ?before=<oldest id>:
// each call returns messages strictly older than that id, so we walk to the start
// of the conversation. Bounded by MAX_PAGES to respect the 50-subrequest Worker
// limit (this fn runs inside a single getWaConversation request).
async function chatwootGetMessages(thread, env, maxPages) {
  const base = `${biteSpeedApiBase(env)}/api/v1/accounts/${encodeURIComponent(thread.provider_account_id)}/conversations/${encodeURIComponent(thread.provider_thread_ref)}/messages`;
  // Page BACKWARDS via ?before=<oldest id>. Default 12 pages (~12 subrequests/open);
  // the inbox "Load older messages" button raises this on demand (Pruthvi #bugs
  // 2026-07-10: history stopped at ~60 msgs). Capped at 36 to stay well under the
  // 50-subrequest Worker limit (getWaConversation makes ~3 other subrequests).
  const MAX_PAGES = Math.min(Math.max(Number(maxPages) || 12, 12), 36);
  const all = [];
  const seen = new Set();
  let before = null;
  let reachedStart = false;   // true = we paged all the way to the conversation start

  for (let i = 0; i < MAX_PAGES; i++) {
    const url = before ? `${base}?before=${encodeURIComponent(before)}` : base;
    let r;
    try { r = await fetch(url, { headers: { 'api_access_token': env.BITESPEED_API_TOKEN } }); }
    catch (e) { return all.length ? { ok: true, raw: all, reachedStart } : { ok: false, status: 502, error: e.message }; }
    if (!r.ok) {
      if (all.length) break;   // keep whatever we already pulled
      const t = await r.text().catch(() => ''); return { ok: false, status: r.status, error: t.slice(0, 200) };
    }
    const d = await r.json().catch(() => ({}));
    const batch = Array.isArray(d?.payload) ? d.payload : (Array.isArray(d) ? d : []);
    if (!batch.length) { reachedStart = true; break; }  // reached the start of the conversation

    let added = 0, minId = null;
    for (const m of batch) {
      const id = m?.id != null ? String(m.id) : null;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      all.push(m);
      added++;
      const n = Number(m?.id);
      if (Number.isFinite(n) && (minId == null || n < minId)) minId = n;
    }
    // No progress (no new rows or oldest id didn't move back) → we're at the start.
    if (!added || minId == null || minId === before) { reachedStart = true; break; }
    before = minId;
  }
  return { ok: true, raw: all, reachedStart };
}

// Map a Chatwoot message → the shape the Pitstop inbox Bubble renders.
function mapChatwootMessage(m) {
  const typeNum = Number(m?.message_type);   // 0=in 1=out 2=activity 3=template
  if (typeNum === 2) return null;            // activity / system — skip
  const isInternal = m?.private === true;
  const direction = typeNum === 0 ? 'inbound' : 'outbound';
  const atts = Array.isArray(m?.attachments) ? m.attachments : [];
  let kind = 'text';
  if (isInternal) kind = 'note';
  else if (atts.length) kind = attachmentKindFromChatwoot(atts[0]?.file_type);
  else if (typeNum === 3) kind = 'template';
  const ts = m?.created_at != null
    ? (typeof m.created_at === 'number' ? new Date(m.created_at * 1000).toISOString() : new Date(m.created_at).toISOString())
    : null;
  return {
    id: m?.id != null ? String(m.id) : `${direction}-${ts}`,
    provider_message_id: m?.id != null ? String(m.id) : null,
    direction, kind, is_internal: isInternal,
    body: m?.content || null,
    template_name: typeNum === 3 ? (m?.content_attributes?.template_name || m?.content_attributes?.template?.name || null) : null,
    media_url: atts[0]?.data_url || atts[0]?.file_url || null,
    media_filename: atts[0]?.file_name || null,
    status: m?.status || (direction === 'outbound' ? 'sent' : null),
    sent_by_name: direction === 'outbound' ? (m?.sender?.name || m?.sender?.available_name || null) : null,
    received_at: direction === 'inbound' ? ts : null,
    sent_at: direction === 'outbound' ? ts : null,
    created_at: ts,
  };
}

// 24h Meta customer-initiated window, derived from the latest INBOUND message — the
// only authoritative source (the local column is fed by the one-way webhook, so dead).
function deriveWaWindow(mapped) {
  let latestInbound = 0;
  for (const m of mapped) {
    if (m.direction !== 'inbound') continue;
    const t = new Date(m.received_at || m.created_at).getTime();
    if (Number.isFinite(t) && t > latestInbound) latestInbound = t;
  }
  if (!latestInbound) return { open: false, until: null };
  const until = latestInbound + 24 * 60 * 60 * 1000;
  return { open: until > Date.now(), until: new Date(until).toISOString() };
}

async function loadWaLive(thread, env, maxPages) {
  const res = await chatwootGetMessages(thread, env, maxPages);
  if (!res.ok) return res;
  const messages = res.raw.map(mapChatwootMessage).filter(Boolean)
    .sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
  return { ok: true, messages, window: deriveWaWindow(messages), oldest_reached: res.reachedStart === true };
}

// GET getWaConversation — the live two-way WhatsApp thread pulled from Chatwoot.
async function getWaConversation(params, auth, env) {
  const g = require('cs_ticket_view', auth); if (g) return g;
  const thread_id = params.get('thread_id');
  if (!thread_id) return err('thread_id required');
  if (waTransport(env) !== 'relay' && !env.BITESPEED_API_TOKEN) return err('WhatsApp not configured (no BiteSpeed API token)', 503);

  const tRes = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=*&limit=1`, env);
  const thread = tRes.data?.[0];
  if (!thread) return err('Thread not found', 404);
  // WS-D: WhatsApp threads on the Relay transport read from local cs_wa_messages.
  if (isRelayThread(thread, env)) return getWaConversationLocal(thread, env);
  if (!thread.provider_account_id || !thread.provider_thread_ref) {
    return ok({ messages: [], within_customer_window: false, window_until: null, live: false,
                note: 'No BiteSpeed conversation reference on this thread yet.' });
  }

  const live = await loadWaLive(thread, env, params.get('pages'));
  if (!live.ok) return err(`Failed to load WhatsApp conversation from BiteSpeed (${live.status}): ${live.error}`, 502);

  // Agent-attribution overlay (Pruthvi #bugs 2026-07-10): the live BiteSpeed pull tags
  // every OUTGOING message with BiteSpeed's connected API-account name (shows as "Afshaan"),
  // not the agent who actually sent it. Our own sendWaReply stores the real agent in
  // cs_wa_messages.sent_by_name keyed by the BiteSpeed message id (provider_message_id ==
  // mapChatwootMessage's String(m.id)), so overlay ours onto the live rows. Replies sent
  // directly in the BiteSpeed UI (not via Pitstop) have no stored row → keep the live name.
  const attrRes = await sb(
    `/rest/v1/cs_wa_messages?thread_id=eq.${encodeURIComponent(thread.id)}&direction=eq.outbound&is_internal=eq.false&sent_by_name=not.is.null&provider_message_id=not.is.null&select=provider_message_id,sent_by_name&limit=400`,
    env,
  );
  const nameByPmid = {};
  for (const m of (attrRes.data || [])) {
    if (m.provider_message_id && m.sent_by_name) nameByPmid[String(m.provider_message_id)] = m.sent_by_name;
  }
  for (const m of live.messages) {
    if (m.direction === 'outbound' && m.provider_message_id && nameByPmid[m.provider_message_id]) {
      m.sent_by_name = nameByPmid[m.provider_message_id];
    }
  }

  // Internal notes live ONLY in our DB (Chatwoot never sees them), so merge the
  // local notes back into the live pull — otherwise notes added on a WA thread
  // vanish on the next re-pull.
  const notesRes = await sb(
    `/rest/v1/cs_wa_messages?thread_id=eq.${encodeURIComponent(thread.id)}&is_internal=eq.true&select=*&order=created_at.asc&limit=200`,
    env,
  );
  const tsOf = (m) => new Date(m.received_at || m.sent_at || m.created_at || 0).getTime();
  const messages = [...live.messages, ...(notesRes.data || [])].sort((a, b) => tsOf(a) - tsOf(b));

  return ok({
    messages,
    within_customer_window: live.window.open,
    window_until: live.window.until,
    live: true,
    oldest_reached: live.oldest_reached,   // false = more history available via ?pages=
  });
}

// Replying to a customer = taking ownership: assign the thread's linked ticket to
// the replying agent (overwrite if it was someone else's; no-op if already theirs).
// Shared by sendWaReply + sendMetaMessage. Best-effort — never blocks the send.
async function assignLinkedTicketToReplier(threadId, auth, env) {
  try {
    const r = await sb(
      `/rest/v1/cs_wa_messages?thread_id=eq.${encodeURIComponent(threadId)}&ticket_id=not.is.null&select=ticket_id&order=created_at.desc&limit=1`,
      env,
    );
    const ticketId = r.data?.[0]?.ticket_id;
    if (!ticketId) return null;
    const tRes = await sb(`/rest/v1/cs_tickets?id=eq.${ticketId}&select=assigned_agent_id&limit=1`, env);
    const t = tRes.data?.[0];
    if (!t || t.assigned_agent_id === auth.userId) return ticketId;   // none / already ours
    const name = auth.fullName || auth.name || auth.email || null;
    await sb(`/rest/v1/cs_tickets?id=eq.${ticketId}`, env, {
      method: 'PATCH', body: JSON.stringify({ assigned_agent_id: auth.userId, assigned_agent_name: name }),
    });
    await insertHistory(ticketId, 'assigned_agent_id', t.assigned_agent_id, auth.userId, 'auto-assigned on reply', auth, env);
    return ticketId;
  } catch (_) { return null; }
}

async function sendWaReply(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { thread_id, text } = body;
  if (!thread_id || !text || !String(text).trim()) return err('thread_id and text required');
  // BiteSpeed token only needed when NOT on the Relay transport (WS-D).
  if (waTransport(env) !== 'relay' && !env.BITESPEED_API_TOKEN) return err('WhatsApp send not configured (no BiteSpeed API token)', 503);

  const tRes = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=*&limit=1`, env);
  const thread = tRes.data?.[0];
  if (!thread) return err('Thread not found', 404);
  // Both WhatsApp and Web are Chatwoot conversations on BiteSpeed — same send path.
  const wchan = thread.channel || 'whatsapp';
  if (wchan !== 'whatsapp' && wchan !== 'web') return err('Not a WhatsApp/Web thread — use sendMetaMessage', 422);
  // WS-D: WhatsApp threads on the Relay transport send via Relay /send (no Chatwoot ref).
  if (isRelayThread(thread, env)) return sendWaReplyViaRelay(thread, text, auth, env);
  if (!thread.provider_account_id || !thread.provider_thread_ref) {
    return err('Thread has no BiteSpeed conversation reference yet', 422);
  }

  // Meta utility-message-first rule (RULE-PITSTOP-013): WhatsApp allows free-text only
  // inside the 24h window, derived LIVE from the latest inbound (the local column is
  // dead — one-way webhook). Web chat has NO such 24h restriction, so skip the gate.
  if (wchan === 'whatsapp') {
    const live = await loadWaLive(thread, env);
    if (!live.ok) return err(`Couldn't verify the customer window with BiteSpeed (${live.status}): ${live.error}`, 502);
    if (!live.window.open) {
      return err('Outside the 24h customer window — free-text replies are blocked until the customer messages again (templates coming soon)', 422);
    }
  }

  // Send through Chatwoot's Application API into the existing conversation. Chatwoot
  // then fires a message_created webhook → /webhooks/bitespeed, which mirrors this
  // outbound row into cs_wa_messages (deduped on the Chatwoot message id). So we do
  // NOT insert locally here; the UI re-pulls the live thread for instant display.
  const apiUrl = `${biteSpeedApiBase(env)}/api/v1/accounts/${encodeURIComponent(thread.provider_account_id)}/conversations/${encodeURIComponent(thread.provider_thread_ref)}/messages`;
  let resp, data;
  try {
    resp = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api_access_token': env.BITESPEED_API_TOKEN },
      body: JSON.stringify({ content: String(text), message_type: 'outgoing' }),
    });
    data = await resp.json().catch(() => ({}));
  } catch (e) {
    return err(`BiteSpeed send failed: ${e.message}`, 502);
  }
  if (!resp.ok) return err(`BiteSpeed send failed (${resp.status}): ${JSON.stringify(data)?.slice(0, 300)}`, resp.status);

  const now = new Date().toISOString();
  const threadPatch = { last_message_at: now };
  // Connect replies (via the Ignition bridge) must NOT auto-claim the thread into CS.
  if (!thread.assigned_agent_id && !auth.viaIgnitionBridge) {   // auto-claim on first reply (mirror sendMetaMessage)
    threadPatch.assigned_agent_id = auth.userId;
    threadPatch.assigned_agent_name = auth.fullName || auth.name || auth.email || null;
    threadPatch.assigned_at = now;
  }
  if (thread.thread_state && thread.thread_state !== 'open') clearClosedFields(threadPatch);
  await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, { method: 'PATCH', body: JSON.stringify(threadPatch) }).catch(() => {});

  const ticketId = auth.viaIgnitionBridge ? null : await assignLinkedTicketToReplier(thread.id, auth, env);

  // Agent attribution (Pruthvi #bugs 2026-07-14): the Chatwoot live pull + mirror webhook
  // tag every OUTGOING message with the connected API-account name (renders as "Afshaan"),
  // never the agent who actually replied. Pre-write the outbound row keyed by the Chatwoot
  // message id with the REAL sender so getWaConversation's overlay (which reads our local
  // sent_by_name by provider_message_id) shows the right person. Upsert with
  // merge-duplicates so we win regardless of webhook-vs-response race: if we land first the
  // webhook dedupes on the pmid; if the webhook lands first (with "Afshaan") the merge
  // overwrites its name with ours. Outbound WA history is written here too — the webhook's
  // history row is gated to inbound-only, so it's single + correctly attributed either way.
  const pmid = data?.id != null ? String(data.id) : null;
  if (pmid) {
    const senderName = auth.fullName || auth.name || auth.email || null;
    await sb(`/rest/v1/cs_wa_messages?on_conflict=provider_message_id`, env, {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: JSON.stringify({
        thread_id: thread.id,
        ticket_id: ticketId,
        direction: 'outbound',
        kind: 'text',
        body: String(text),
        provider_message_id: pmid,
        status: 'sent',
        is_internal: false,
        sent_by_user_id: auth.userId,
        sent_by_name: senderName,
        sent_at: now,
      }),
    }).catch(() => {});
    if (ticketId) {
      await sb(`/rest/v1/cs_ticket_history`, env, {
        method: 'POST', prefer: 'return=minimal',
        body: JSON.stringify({
          ticket_id: ticketId,
          field_name: 'wa_message_sent',
          old_value: null,
          new_value: 'text',
          note: String(text).slice(0, 140),
          changed_by_user_id: auth.userId,
          changed_by_name: senderName,
        }),
      }).catch(() => {});
    }
  }

  return ok({ sent: true, message_id: pmid, auto_claimed: !thread.assigned_agent_id && !auth.viaIgnitionBridge, ticket_assigned: ticketId });
}

// Send a media attachment (image / PDF) to a WhatsApp or Web thread through Chatwoot's
// Application API (Pruthvi #bugs 2026-06-26 — the composer paperclip was IG/FB/email-only).
// Unlike Meta (Graph URL, no caption field) Chatwoot takes a multipart POST with content +
// attachments[] in one call and HOSTS the media itself, so the live getWaConversation pull
// renders the file from Chatwoot's data_url — we don't pre-host on cs-inbox-media. We do
// pre-write an outbound row (kind + media meta + real sender) for the sent_by_name overlay,
// mirroring sendWaReply's attribution fix.
async function sendWaAttachment(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { thread_id, mime_type, data_base64, filename, caption } = body;
  if (!thread_id || !mime_type || !data_base64) return err('thread_id, mime_type and data_base64 required');
  const spec = ATTACH_MIME[mime_type];
  if (!spec) return err(`Unsupported file type: ${mime_type} (images + PDF only)`, 415);

  const dec = decodeAttachment(data_base64, spec, 'whatsapp');
  if (dec.error) return dec.error;
  const bytes = dec.bytes;
  // Release the ~2.67x-of-file base64 string before the upload: `body` is the only thing keeping it
  // alive, and the upload is the long-lived part of this request. Halves the peak while on the wire.
  body.data_base64 = null;

  if (waTransport(env) !== 'relay' && !env.BITESPEED_API_TOKEN) return err('WhatsApp send not configured (no BiteSpeed API token)', 503);
  const tRes = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=*&limit=1`, env);
  const thread = tRes.data?.[0];
  if (!thread) return err('Thread not found', 404);
  const wchan = thread.channel || 'whatsapp';
  if (wchan !== 'whatsapp' && wchan !== 'web') return err('Not a WhatsApp/Web thread — use sendMetaAttachment', 422);
  // WS-D Relay transport carries outbound media as of S245 (BiteSpeed exit — support agents send
  // shipment screenshots and PDFs, so a 501 here was a functional regression at cutover, not a
  // rough edge). Branch BEFORE the BiteSpeed-only provider-ref requirement below: a Relay thread
  // has no Chatwoot conversation and would fail that check.
  if (isRelayThread(thread, env))
    return sendWaAttachmentViaRelay(thread, { bytes, mime_type, filename, caption, spec }, auth, env);
  if (!thread.provider_account_id || !thread.provider_thread_ref) return err('Thread has no BiteSpeed conversation reference yet', 422);

  // 24h customer-window gate (whatsapp only; web has no window) — same as sendWaReply.
  if (wchan === 'whatsapp') {
    const live = await loadWaLive(thread, env);
    if (!live.ok) return err(`Couldn't verify the customer window with BiteSpeed (${live.status}): ${live.error}`, 502);
    if (!live.window.open) return err('Outside the 24h customer window — media replies are blocked until the customer messages again', 422);
  }

  // Multipart POST — Chatwoot hosts the file + fires message_created back to /webhooks/bitespeed.
  const apiUrl = `${biteSpeedApiBase(env)}/api/v1/accounts/${encodeURIComponent(thread.provider_account_id)}/conversations/${encodeURIComponent(thread.provider_thread_ref)}/messages`;
  const fd = new FormData();
  if (caption && String(caption).trim()) fd.append('content', String(caption).trim());
  fd.append('message_type', 'outgoing');
  fd.append('attachments[]', new Blob([bytes], { type: mime_type }), filename || `attachment.${spec.ext}`);
  let resp, data;
  try {
    resp = await fetch(apiUrl, { method: 'POST', headers: { 'api_access_token': env.BITESPEED_API_TOKEN }, body: fd });
    data = await resp.json().catch(() => ({}));
  } catch (e) {
    return err(`BiteSpeed media send failed: ${e.message}`, 502);
  }
  if (!resp.ok) return err(`BiteSpeed media send failed (${resp.status}): ${JSON.stringify(data)?.slice(0, 300)}`, resp.status);

  const now = new Date().toISOString();
  const senderName = auth.fullName || auth.name || auth.email || null;
  const threadPatch = { last_message_at: now };
  if (!thread.assigned_agent_id) {
    threadPatch.assigned_agent_id = auth.userId;
    threadPatch.assigned_agent_name = senderName;
    threadPatch.assigned_at = now;
  }
  if (thread.thread_state && thread.thread_state !== 'open') clearClosedFields(threadPatch);
  await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, { method: 'PATCH', body: JSON.stringify(threadPatch) }).catch(() => {});
  const ticketId = await assignLinkedTicketToReplier(thread.id, auth, env);

  // Attribution pre-write (media renders from the live Chatwoot pull; this row carries
  // the real sender for the getWaConversation overlay). Merge-duplicates vs the mirror.
  const pmid = data?.id != null ? String(data.id) : null;
  if (pmid) {
    await sb(`/rest/v1/cs_wa_messages?on_conflict=provider_message_id`, env, {
      method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
      body: JSON.stringify({
        thread_id: thread.id, ticket_id: ticketId, direction: 'outbound', kind: spec.kind,
        body: (caption && String(caption).trim()) || null,
        media_filename: filename || `attachment.${spec.ext}`, media_mime_type: mime_type, media_size_bytes: bytes.length,
        provider_message_id: pmid, status: 'sent', is_internal: false,
        sent_by_user_id: auth.userId, sent_by_name: senderName, sent_at: now,
      }),
    }).catch(() => {});
  }
  return ok({ sent: true, message_id: pmid, auto_claimed: !thread.assigned_agent_id, ticket_assigned: ticketId });
}

// Phase C admin-only: simulate an inbound message for testing the UI before
// the Meta webhook is wired. Useful for the team to validate the panel works
// against realistic data. NOT a public webhook — must be JWT-authed cs_ticket_admin.
async function recordInboundWaStub(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  const { customer_phone, ticket_id, kind = 'text', body: msgBody, media_url, media_filename, media_mime_type } = body;
  if (!customer_phone) return err('customer_phone required');
  if (!['text','image','video','audio','document'].includes(kind)) return err('invalid kind');

  const { thread } = await findOrCreateWaThread(customer_phone, env);
  if (!thread) return err('Failed to resolve thread', 500);

  const now = new Date().toISOString();
  const ins = await sb(`/rest/v1/cs_wa_messages`, env, {
    method: 'POST',
    body: JSON.stringify({
      thread_id: thread.id,
      ticket_id: ticket_id || null,
      direction: 'inbound',
      kind,
      body: msgBody || null,
      media_url: media_url || null,
      media_filename: media_filename || null,
      media_mime_type: media_mime_type || null,
      received_at: now,
    }),
  });
  if (!ins.ok) return err(`insert failed: ${JSON.stringify(ins.data)}`, ins.status);

  // Open / refresh the 24h customer-initiated window
  const windowClose = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, {
    method: 'PATCH',
    body: JSON.stringify({ last_message_at: now, last_inbound_at: now, customer_window_until: windowClose }),
  });

  return ok({ message: ins.data?.[0], thread_id: thread.id, customer_window_until: windowClose });
}

async function createWaTemplate(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  const { name, display_label, category, language, body: tplBody, placeholder_count, notes } = body;
  if (!name || !display_label || !category || !tplBody) {
    return err('name, display_label, category, body required');
  }
  if (!['utility','marketing','authentication'].includes(category)) return err('invalid category');

  // Validate placeholder count matches body
  const matches = String(tplBody).match(/\{\{\d+\}\}/g) || [];
  const detectedCount = new Set(matches).size;
  if (placeholder_count != null && Number(placeholder_count) !== detectedCount) {
    return err(`placeholder_count (${placeholder_count}) doesn't match {{N}} occurrences in body (${detectedCount})`);
  }

  const r = await sb(`/rest/v1/cs_wa_templates`, env, {
    method: 'POST',
    body: JSON.stringify({
      name, display_label, category,
      language: language || 'en',
      body: tplBody,
      placeholder_count: detectedCount,
      notes: notes || null,
      is_active: true,
    }),
  });
  if (!r.ok) return err(`create failed: ${JSON.stringify(r.data)}`, r.status);
  return ok({ template: r.data?.[0] });
}

async function updateWaTemplate(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  const { id, patch } = body;
  if (!id || !patch || typeof patch !== 'object') return err('id and patch required');
  const ALLOWED = ['display_label','category','language','body','is_active','notes'];
  const clean = {};
  for (const k of ALLOWED) if (k in patch) clean[k] = patch[k];
  if (Object.keys(clean).length === 0) return err('nothing to update');

  // If body changed, recompute placeholder_count
  if ('body' in clean) {
    const matches = String(clean.body).match(/\{\{\d+\}\}/g) || [];
    clean.placeholder_count = new Set(matches).size;
  }

  const r = await sb(`/rest/v1/cs_wa_templates?id=eq.${encodeURIComponent(id)}`, env, {
    method: 'PATCH', body: JSON.stringify(clean),
  });
  if (!r.ok) return err(`update failed: ${JSON.stringify(r.data)}`, r.status);
  return ok({ template: r.data?.[0] });
}

// ── BiteSpeed (Chatwoot) inbound webhook receiver ────────────────────────────
//
// BiteSpeed runs a white-labeled Chatwoot deployment at chat.bitespeed.co.
// We add Pitstop as a webhook subscriber on their Integrations page; they POST
// us standard Chatwoot events. Routing + payload spec:
//
//   URL:    POST /webhooks/bitespeed?token=<env.BITESPEED_WEBHOOK_SECRET>
//   Events: message_created, conversation_created, conversation_updated,
//           conversation_status_changed
//
// Chatwoot message_type integer mapping:
//   0 = incoming  (customer → agent)
//   1 = outgoing  (agent → customer)
//   2 = activity  (system note — assignment changes, status flips; ignored)
//   3 = template  (outbound template message)
//
// Phase C2-A is read-only: we mirror BiteSpeed conversations into Pitstop's
// cs_wa_threads + cs_wa_messages so agents can see the thread on the ticket.
// BiteSpeed agents still send replies from chat.bitespeed.co. Phase C2-B will
// flip sendWaMessage to call BiteSpeed's Application API for outbound.

function verifyBiteSpeedAuth(url, env) {
  const provided = url.searchParams.get('token');
  return !!env.BITESPEED_WEBHOOK_SECRET && provided === env.BITESPEED_WEBHOOK_SECRET;
}

// Pull a customer phone from any of the places Chatwoot tucks it (varies by
// payload type + Chatwoot version + inbox channel). Patterns observed in
// BiteSpeed/Chatwoot WhatsApp payloads:
//   - conversation_updated:           body.meta.sender.phone_number
//   - message_created (incoming):     body.sender.phone_number
//   - message_created (outgoing):     body.conversation.meta.sender.phone_number
//   - both:                           body.conversation.contact_inbox.source_id (WA-formatted ID fallback)
function extractPhoneFromChatwoot(body) {
  const candidates = [
    body?.contact?.phone_number,
    body?.contact?.identifier,
    body?.conversation?.meta?.sender?.phone_number,
    body?.conversation?.meta?.sender?.identifier,
    body?.meta?.sender?.phone_number,
    body?.meta?.sender?.identifier,
    body?.sender?.phone_number,
    body?.sender?.identifier,
    // Chatwoot's contact_inbox.source_id is the channel-specific identifier
    // (WA phone-formatted ID for WhatsApp inboxes — often "+91..." or "91...@s.whatsapp.net")
    body?.conversation?.contact_inbox?.source_id,
    body?.contact_inbox?.source_id,
  ];
  for (const c of candidates) {
    if (c && typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

// Meta (IG/Messenger) attachment.type → our `kind` enum.
//
// ⚠️ THIS MUST NEVER RETURN A VALUE OUTSIDE cs_wa_messages_kind_check. The original code
// passed Meta's type through verbatim (`kind = t || 'document'`), so a shared reel
// (attachment.type='ig_reel') failed the CHECK, the INSERT errored, and the handler
// returned — the customer's message was LOST ENTIRELY. No row, nothing in the inbox, and
// the only trace was a console.error nobody reads. That is the worst failure mode we have:
// a customer wrote to us and no one can ever know. Found 2026-08-04 (Pruthvi's IG reel
// report); the 21 Jul example thread holds the follow-up "Price" but no reel row at all.
//
// So the contract is: map what we know, and DEGRADE anything unknown to a storable kind.
// Losing fidelity is acceptable; losing the message is not.
const META_ATT_KIND = {
  image: 'image', video: 'video', audio: 'audio',
  file: 'document', document: 'document',
  // Shares — one kind on purpose; the precise Meta type stays in raw_meta and the inbox
  // renders them identically. A kind per vendor sub-type means a migration per Meta feature.
  ig_reel: 'share', reel: 'share', ig_post: 'share', post: 'share',
  share: 'share', media_share: 'share', story_mention: 'share',
  template: 'template',
  // Meta's own degraded shapes — storable, just not rich.
  fallback: 'text', location: 'text', like_heart: 'text', unsupported: 'text',
};
function metaAttachmentKind(type) {
  const k = META_ATT_KIND[String(type || '').toLowerCase()];
  if (k) return k;
  // Loud, because an unmapped type is how we find out Meta shipped something new —
  // and it is now a fidelity bug rather than a data-loss bug.
  console.log(`[meta] unmapped attachment type "${type}" — storing as document`);
  return 'document';
}

// Chatwoot attachment.file_type → our kind enum
function attachmentKindFromChatwoot(fileType) {
  switch ((fileType || '').toLowerCase()) {
    case 'image':    return 'image';
    case 'video':    return 'video';
    case 'audio':    return 'audio';
    case 'voice':    return 'audio';
    case 'file':     return 'document';
    case 'document': return 'document';
    default:         return 'document';
  }
}

// BiteSpeed/Chatwoot inbox id — the hard channel discriminator. Present on 100%
// of genuine BiteSpeed payloads (mirrored at conversation.inbox_id); channel_type
// is never sent. Known inboxes (confirmed from captured payloads, S182):
//   7625 "WA Support"    → WhatsApp CS (BiteSpeed IS our WA provider — KEEP)
//   7682 "WA Marketing"  → outbound campaign blasts — DROP (S182, not CS; Relay owns marcomms)
//   8001 "Email"         → carecrew@ — duplicate of the native Gmail channel (S178) — DROP
//   8114 "FB/IG Dms"     → duplicate of native Meta DM capture (S161) — DROP
//   7721 "L.O.T Web"     → website chat widget → channel='web' (its own Pitstop section, S182)
function bitespeedInboxId(body) {
  const id = body?.inbox?.id ?? body?.conversation?.inbox_id ?? body?.conversation?.inbox?.id ?? null;
  return id != null ? String(id) : null;
}

// Off-ramp (S182): silently drop the BiteSpeed inboxes that don't belong in the CS
// inbox — Email + FB/IG (duplicate native channels) and WA Marketing (outbound
// campaign blasts; CS has nothing to do with marcomms, Relay owns that). We still
// 200-ack every webhook (no retry storm, no signal to BiteSpeed we're off-ramping).
// Denylist: WA Support (7625) + the web widget (7721) + any other inbox keep flowing.
const BITESPEED_DROP_INBOX_IDS = new Set(['8001', '8114', '7682']);

// Explicit BiteSpeed inbox-id → our channel enum (authoritative; channel_type is never
// sent and inbox.name is a soft label). 7721 "L.O.T Web" → 'web' (its own inbox section,
// pulled from BiteSpeed like WhatsApp). Unmapped kept inboxes fall through to name/default.
const BITESPEED_INBOX_CHANNEL = { '7625': 'whatsapp', '7721': 'web' };

// Chatwoot inbox.channel_type (Ruby class name) → our channel enum.
// BiteSpeed omits channel_type but sends inbox.name — fall back to it.
function chatwootChannelFromPayload(body) {
  // Authoritative: explicit inbox-id → channel map (e.g. 7721 "L.O.T Web" → web).
  const inboxId = bitespeedInboxId(body);
  if (inboxId && BITESPEED_INBOX_CHANNEL[inboxId]) return BITESPEED_INBOX_CHANNEL[inboxId];

  const ct = (
    body?.inbox?.channel_type ||
    body?.conversation?.inbox?.channel_type ||
    ''
  ).toLowerCase();
  if (ct.includes('instagram')) return 'instagram';
  if (ct.includes('messenger') || ct.includes('facebook')) return 'messenger';
  if (ct.includes('email')) return 'email';
  if (ct) return 'whatsapp';

  // channel_type absent — use inbox.name (BiteSpeed sends this, not channel_type)
  const name = (
    body?.inbox?.name ||
    body?.conversation?.inbox?.name ||
    ''
  ).toLowerCase();
  if (name.includes('ig') || name.includes('instagram')) return 'instagram';
  if (name.includes('fb') || name.includes('facebook') || name.includes('messenger')) return 'messenger';
  if (name.includes('email')) return 'email';
  return 'whatsapp';
}

async function handleBiteSpeedWebhook(request, env) {
  const url = new URL(request.url);
  if (!verifyBiteSpeedAuth(url, env)) return err('Invalid webhook token', 401);

  let body = {};
  try { body = await request.json(); } catch { return err('Bad JSON', 400); }
  const event = body?.event;
  const convId = body?.conversation?.id || body?.id || '?';
  const phone = extractPhoneFromChatwoot(body);
  console.log(`[bitespeed] ${event} conv=${convId}${phone ? ' phone=' + phone : ''}`);

  // Off-ramp (S182): drop inboxes that now have a native Pitstop channel (Email,
  // FB/IG) so they stop duplicating into the CS inbox. Ack 200 + persist nothing.
  const inboxId = bitespeedInboxId(body);
  if (inboxId && BITESPEED_DROP_INBOX_IDS.has(inboxId)) {
    return json({ ok: true, dropped: `inbox_${inboxId}` });
  }

  // Always 200 quickly per Chatwoot best practice — process inline since
  // payloads are small + we're already on a Cloudflare Worker (cold start fine).
  try {
    if (event === 'message_created')             return await biteSpeedMessageCreated(body, env);
    if (event === 'conversation_created')        return await biteSpeedConversationUpserted(body, env);
    if (event === 'conversation_updated')        return await biteSpeedConversationUpserted(body, env);
    if (event === 'conversation_status_changed') return await biteSpeedConversationUpserted(body, env);
    // Other events (contact_created, contact_updated, webwidget_triggered, etc.) — ack + skip
    return json({ ok: true, ignored: event || 'unknown' });
  } catch (e) {
    console.error('[bitespeed] handler error', e);
    return json({ ok: true, error: String(e?.message || e) });  // ack to avoid retry storm
  }
}

// Find-or-create the WA thread for a Chatwoot-sourced conversation. Idempotent.
// `create:false` makes it find-only (returns {thread:null} instead of inserting) — used
// by conversation lifecycle events, which must NOT spawn message-less phantom threads.
async function biteSpeedFindOrCreateThread(payload, env, { create = true } = {}) {
  const conv = payload?.conversation || (payload?.event === 'conversation_created' ? payload : null) || payload;
  const convId = conv?.id ?? payload?.id ?? null;
  const phoneRaw = extractPhoneFromChatwoot(payload);
  // Capture Chatwoot account_id so deep-links from Pitstop UI can target the
  // exact conversation: chat.bitespeed.co/app/accounts/<id>/conversations/<conv>
  const accountId = (payload?.account?.id ?? payload?.conversation?.account_id ?? payload?.inbox?.account_id ?? null);
  const accountIdStr = accountId != null ? String(accountId) : null;
  const channel = chatwootChannelFromPayload(payload);
  if (!phoneRaw && !convId) return { thread: null, reason: 'no_phone_or_conv_id' };

  const phone = phoneRaw ? toE164(phoneRaw) : null;

  // First try: match an existing thread by provider_thread_ref (Chatwoot conv id) —
  // covers the case where the same phone has multiple Chatwoot conversations
  // (closed + reopened, or test conversations).
  if (convId != null) {
    const byRef = await sb(
      `/rest/v1/cs_wa_threads?provider_thread_ref=eq.${encodeURIComponent(String(convId))}&select=*&limit=1`,
      env,
    );
    if (byRef.data?.[0]) {
      // Backfill provider_account_id and channel if we now know them and the thread didn't
      const patch = {};
      if (accountIdStr && byRef.data[0].provider_account_id !== accountIdStr) patch.provider_account_id = accountIdStr;
      if ((byRef.data[0].channel || 'whatsapp') === 'whatsapp' && channel !== 'whatsapp') patch.channel = channel;
      if (Object.keys(patch).length) {
        await sb(`/rest/v1/cs_wa_threads?id=eq.${byRef.data[0].id}`, env, {
          method: 'PATCH', body: JSON.stringify(patch),
        }).catch(() => {});
        Object.assign(byRef.data[0], patch);
      }
      return { thread: byRef.data[0] };
    }
  }

  // Second try: match by phone (collapses to the Phase C placeholder thread
  // we may have already created with waba_phone_number_id=NULL).
  if (phone) {
    const byPhone = await sb(
      `/rest/v1/cs_wa_threads?customer_phone=eq.${encodeURIComponent(phone)}&waba_phone_number_id=is.null&select=*&limit=1`,
      env,
    );
    if (byPhone.data?.[0]) {
      // Backfill provider_thread_ref so future events route via the fast path
      if (convId != null && byPhone.data[0].provider_thread_ref !== String(convId)) {
        await sb(`/rest/v1/cs_wa_threads?id=eq.${byPhone.data[0].id}`, env, {
          method: 'PATCH',
          body: JSON.stringify({ provider_thread_ref: String(convId) }),
        });
      }
      return { thread: byPhone.data[0] };
    }
  }


  // Find-only mode (conversation lifecycle events): no existing thread → don't create.
  if (!create) return { thread: null, reason: 'not_found_no_create' };

  // No existing thread — create one
  const ins = await sb(`/rest/v1/cs_wa_threads`, env, {
    method: 'POST',
    body: JSON.stringify({
      customer_phone: phone,
      provider_thread_ref: convId != null ? String(convId) : null,
      provider_account_id: accountIdStr,
      channel,
    }),
  });
  if (!ins.ok) {
    console.error(`[bitespeed] cs_wa_threads INSERT failed status=${ins.status} body=${JSON.stringify(ins.data)?.slice(0, 300)}`);
  }
  return { thread: ins.data?.[0] || null };
}

// If `thread` exists but has no customer_phone, and the current payload
// surfaces one (e.g. a later conversation_updated carries phone where an
// earlier message_created didn't), patch the thread + retroactively link
// any orphan messages on it to whatever ticket is currently open for that phone.
async function maybeBackfillPhoneAndLinkTickets(thread, payload, env) {
  if (!thread || thread.customer_phone) return thread;
  const phoneRaw = extractPhoneFromChatwoot(payload);
  if (!phoneRaw) return thread;
  const phone = toE164(phoneRaw);
  if (!phone) return thread;

  // Patch the thread
  const upd = await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, {
    method: 'PATCH',
    body: JSON.stringify({ customer_phone: phone }),
  });
  if (upd.ok) thread.customer_phone = phone;

  // Phone-match: find the latest open cs_tickets row for this phone
  const tRes = await sb(
    `/rest/v1/cs_tickets?customer_phone=eq.${encodeURIComponent(phone)}&closed_at=is.null&select=id&order=created_at.desc&limit=1`,
    env,
  );
  const ticketId = tRes.data?.[0]?.id || null;
  if (ticketId) {
    // Retroactively link all messages on this thread that have no ticket_id yet
    await sb(`/rest/v1/cs_wa_messages?thread_id=eq.${thread.id}&ticket_id=is.null`, env, {
      method: 'PATCH',
      body: JSON.stringify({ ticket_id: ticketId }),
    }).catch(() => {});
  }
  return thread;
}

async function biteSpeedConversationUpserted(body, env) {
  // FIND-ONLY (S185): conversation lifecycle events (created/updated/status_changed) carry
  // no customer message, so creating a thread here spawned ~84 message-less "phantom" threads
  // per day (empty, often null provider_account_id → un-backfillable) that cluttered the inbox
  // + inflated unassigned counts. Threads are now created ONLY by a real message_created. We
  // still bump an EXISTING thread's sort timestamp; if no thread exists yet, do nothing.
  let { thread } = await biteSpeedFindOrCreateThread(body, env, { create: false });
  if (!thread) return json({ ok: true, skipped: 'no_thread_conv_event' });
  thread = await maybeBackfillPhoneAndLinkTickets(thread, body, env);
  await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, {
    method: 'PATCH',
    body: JSON.stringify({ last_message_at: new Date().toISOString() }),
  });
  return json({ ok: true, thread_id: thread.id, phone_backfilled: !!thread.customer_phone });
}

async function biteSpeedMessageCreated(body, env) {
  // Chatwoot wraps the message at the top level for message_created.
  // Chatwoot sends message_type as EITHER an int (0=in,1=out,2=activity,3=template)
  // OR a string ("incoming"/"outgoing"/"activity"/"template"). Normalise BOTH —
  // Number("incoming") is NaN, so the old `Number(mt)===0` test silently mislabelled
  // every string-typed inbound message as outbound (it rendered on the agent's side).
  const messageType = body?.message_type;
  const mtStr = String(messageType).toLowerCase();
  const isActivity = messageType === 2 || mtStr === '2' || mtStr === 'activity';
  const isIncoming = messageType === 0 || mtStr === '0' || mtStr === 'incoming';
  const isTemplate = messageType === 3 || mtStr === '3' || mtStr === 'template';
  if (isActivity) {
    return json({ ok: true, skipped: 'activity_message' });
  }
  if (body?.private === true) {
    return json({ ok: true, skipped: 'private_internal_note' });
  }

  // Resolve thread (creates one if needed). Chatwoot puts the conversation
  // nested under `conversation` on message_created.
  let { thread } = await biteSpeedFindOrCreateThread(body, env);
  if (!thread) return json({ ok: true, skipped: 'no_thread' });
  thread = await maybeBackfillPhoneAndLinkTickets(thread, body, env);

  const providerMessageId = body?.id != null ? String(body.id) : null;

  // Idempotency: skip if we've already recorded this message_id
  if (providerMessageId) {
    const existing = await sb(
      `/rest/v1/cs_wa_messages?provider_message_id=eq.${encodeURIComponent(providerMessageId)}&select=id&limit=1`,
      env,
    );
    if (existing.data?.[0]) return json({ ok: true, deduped: true });
  }

  // Resolve direction (string- and int-safe; see message_type note above)
  const direction = isIncoming ? 'inbound' : 'outbound';

  // Map kind from content + attachments
  const attachments = Array.isArray(body?.attachments) ? body.attachments : [];
  let kind = 'text';
  let mediaUrl = null, mediaFilename = null, mediaMime = null, mediaSize = null;
  if (attachments.length > 0) {
    const a = attachments[0];
    kind = attachmentKindFromChatwoot(a?.file_type);
    mediaUrl      = a?.data_url || a?.file_url || null;
    mediaFilename = a?.file_name || a?.file_type || null;
    mediaMime     = a?.file_content_type || null;
    mediaSize     = a?.file_size || null;
  } else if (isTemplate) {
    kind = 'template';
  }

  // Phone-match to the latest open cs_tickets row so the message attaches.
  // The user pattern: WA continues the conversation started on a call — we
  // join the WA thread to whichever ticket is currently active for the phone.
  let linkedTicketId = null;
  if (thread.customer_phone) {
    const tRes = await sb(
      `/rest/v1/cs_tickets?customer_phone=eq.${encodeURIComponent(thread.customer_phone)}&closed_at=is.null&select=id&order=created_at.desc&limit=1`,
      env,
    );
    linkedTicketId = tRes.data?.[0]?.id || null;
  }

  // Resolve content + timestamp
  const content = body?.content || null;
  const ts = body?.created_at
    ? (typeof body.created_at === 'number'
        ? new Date(body.created_at * 1000).toISOString()  // Chatwoot unix-secs
        : new Date(body.created_at).toISOString())
    : new Date().toISOString();

  // Template name extraction (Chatwoot stores it in content_attributes for template msgs)
  let templateName = null;
  if (isTemplate) {
    templateName = body?.content_attributes?.template_name
      || body?.content_attributes?.template?.name
      || null;
  }

  const ins = await sb(`/rest/v1/cs_wa_messages`, env, {
    method: 'POST',
    body: JSON.stringify({
      thread_id: thread.id,
      ticket_id: linkedTicketId,
      direction,
      kind,
      body: content,
      template_name: templateName,
      media_url: mediaUrl,
      media_filename: mediaFilename,
      media_mime_type: mediaMime,
      media_size_bytes: mediaSize,
      provider_message_id: providerMessageId,
      status: direction === 'outbound' ? 'sent' : null,
      sent_by_user_id: null,                              // Chatwoot agent id ≠ our auth.users id (Phase C2-B will reconcile)
      sent_by_name: body?.sender?.name || null,
      received_at: direction === 'inbound'  ? ts : null,
      sent_at:     direction === 'outbound' ? ts : null,
    }),
  });
  if (!ins.ok) {
    console.error(`[bitespeed] cs_wa_messages INSERT failed status=${ins.status} body=${JSON.stringify(ins.data)?.slice(0, 300)}`);
    return err(`insert failed: ${JSON.stringify(ins.data)}`, ins.status);
  }

  // Inbound message resets the 24h Meta customer window + bumps last_message_at
  const threadPatch = { last_message_at: ts };
  if (direction === 'inbound') {
    threadPatch.last_inbound_at = ts;   // unread watermark (team-global read state)
    threadPatch.customer_window_until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    // Reopen a closed/snoozed thread when the customer messages again (standard helpdesk
    // behaviour). Also makes the empty-phantom cleanup safe — any real message resurfaces
    // a previously-closed thread into the active inbox. (S185)
    if (thread.thread_state && thread.thread_state !== 'open') clearClosedFields(threadPatch);
  }
  await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, {
    method: 'PATCH',
    body: JSON.stringify(threadPatch),
  });

  // Activity row on the linked ticket so the message surfaces in the ticket's
  // history feed (without exposing message content to history rows — privacy).
  // INBOUND only: outbound WA history is written by sendWaReply with the real agent
  // (this webhook only knows the "Afshaan" API-account name), so writing it here too
  // would duplicate + mis-attribute. Direct-in-BiteSpeed outbound sends (not via
  // Pitstop) therefore get no history row — acceptable, they're outside our workflow.
  if (linkedTicketId && direction === 'inbound') {
    await sb(`/rest/v1/cs_ticket_history`, env, {
      method: 'POST',
      body: JSON.stringify({
        ticket_id: linkedTicketId,
        field_name: 'wa_message_received',
        old_value: null,
        new_value: kind === 'template' ? `template:${templateName}` : kind,
        note: (content || '').slice(0, 140),
        changed_by_user_id: null,
        changed_by_name: body?.sender?.name || 'BiteSpeed (auto)',
      }),
    }).catch(() => {});
  }

  return json({ ok: true, thread_id: thread.id, ticket_id: linkedTicketId, direction, kind });
}

// ════════════════════════════════════════════════════════════════════════════
// RELAY WhatsApp transport (WS-D — BiteSpeed exit). When a live WA number is
// migrated onto LOT's own Meta Cloud API (Relay/commsops), Relay forwards inbound
// customer messages to POST /webhooks/relay-wa and Pitstop sends agent replies back
// out through Relay /send — swapping ONLY the transport under the channel-agnostic
// inbox (cs_wa_threads/cs_wa_messages), exactly like the email channel did.
// Gated by WA_TRANSPORT (default 'bitespeed'); the receiver itself is inert until
// Relay actually forwards, which only happens after a live number is cut over (WS-C).
// channel='web' ALWAYS stays on Chatwoot — this path is WhatsApp-only.
// ════════════════════════════════════════════════════════════════════════════

// Which transport backs Pitstop's WhatsApp agent replies + reads. In practice
// per-support-number == the whole WA channel (the Pitstop inbox is fed by the
// support number 9880212323). Default 'bitespeed' → every existing path unchanged.
function waTransport(env) {
  return String(env.WA_TRANSPORT || 'bitespeed').toLowerCase() === 'relay' ? 'relay' : 'bitespeed';
}

// Is THIS thread a Relay thread, regardless of the worker-wide default?
//
// WA_TRANSPORT is a single global switch, which is the wrong granularity: numbers move to Relay
// ONE AT A TIME, so both transports are live at once for the whole migration. The marketing number
// has been on Relay since 21 Jul while the flag still says 'bitespeed', and the consequence was
// silent — 330 real customer replies landed in Pitstop, then every read fell through to the
// BiteSpeed branch, found no conversation ref and returned an EMPTY thread, and every reply 422'd.
// The messages were there; agents just could not see or answer them. (This is exactly the
// "redirect marketing/transactional replies to Support" ask — the redirect worked, the inbox
// half did not.)
//
// Discriminated on a POSITIVE marker rather than the absence of a Chatwoot ref:
// relayWaFindOrCreateThread always stamps waba_phone_number_id, and BiteSpeed threads never carry
// one. Testing only for a missing provider ref would also capture a BiteSpeed thread whose refs
// had not landed yet and wrongly answer it through Relay.
function isRelayThread(thread, env) {
  if ((thread?.channel || 'whatsapp') !== 'whatsapp') return false;   // web stays on Chatwoot
  return waTransport(env) === 'relay' || !!(thread?.waba_phone_number_id && !thread?.provider_thread_ref);
}

// Bearer match for Relay's forward (mirrors commsops CSOPS_WA_FORWARD_TOKEN).
function verifyRelayWaAuth(request, env) {
  const want = env.CSOPS_WA_FORWARD_TOKEN;
  if (!want) return false;
  const a = request.headers.get('Authorization') || '';
  const bearer = a.slice(0, 7).toLowerCase() === 'bearer ' ? a.slice(7).trim() : '';
  return bearer === want;
}

// WA message type → cs_wa_messages.kind. button/interactive/text all carry their
// text in .text (parseInbound already flattened it), so → 'text'.
function relayWaKind(type) {
  switch (String(type || 'text').toLowerCase()) {
    case 'image': return 'image';
    case 'video': return 'video';
    case 'audio': case 'voice': return 'audio';
    case 'document': case 'sticker': return 'document';
    default: return 'text';
  }
}

// Find-or-create the WhatsApp thread for a phone. Relay threads carry no Chatwoot
// provider refs; match an existing whatsapp thread by phone (continues a thread that
// may have started on BiteSpeed pre-cutover) else create a fresh one.
// `name` is the customer's WhatsApp profile name. commsops has always forwarded it
// (adapters/whatsapp.js `nameFor(m.from)` reads Meta's contacts[].profile.name) and this
// function simply threw it away — so ALL 9,680 WhatsApp threads showed a bare phone number and
// agents had no way to tell who they were talking to. Reported by Dhiraj at the cutover, but it
// was never a migration artifact: no WA thread has ever carried a name.
//
// Meta only sends the profile name ALONGSIDE a message, so historical threads cannot be
// backfilled from anywhere. Instead the name is filled in opportunistically on every inbound:
// each existing thread gains one the next time that customer writes in.
// A conversation is (customer, OUR NUMBER) — never the customer alone.
//
// This keyed on `customer_phone` + `channel` ALONE until 2026-07-30, and all three LOT numbers
// (marketing · transactional · support) funnel their inbound through this one function, so the
// most recently touched thread absorbed the next message from ANY of them: a customer's COD
// confirmation from the transactional number and their support query landed in one chat with no
// segregation (Pruthvi, cutover night). The merge was the visible half. The damaging half was the
// line below it, which re-stamped `waba_phone_number_id` to whatever number had just arrived —
// that column is what `sendWaReplyViaRelay` sends ON, so a thread's identity flipped to the
// customer's most recent touch and an agent answering a SUPPORT query could reply from the
// TRANSACTIONAL number. Templates are WABA-scoped too, so a `lot_support_*` send on a flipped
// thread fails closed. 38 of 355 active customers had touched more than one number.
//
// Resolution order, and each step earns its place:
//   1. exact (phone, channel, number)      — the correct thread, when one exists
//   2. a thread with NO number yet         — ADOPT it and stamp it. 9,365 legacy/BiteSpeed-era
//                                            threads carry NULL here and hold the 25k backfilled
//                                            inbound messages; keying strictly would orphan every
//                                            one and agents would lose all visible history.
//   3. otherwise                           — a genuinely new conversation for this number
// A thread already carrying a DIFFERENT non-null number is never re-pointed — that is the flip.
async function relayWaFindOrCreateThread(phone, phoneNumberId, env, name) {
  if (!phone) return null;
  const clean = name && String(name).trim() ? String(name).trim().slice(0, 120) : null;
  const base = `/rest/v1/cs_wa_threads?customer_phone=eq.${encodeURIComponent(phone)}&channel=eq.whatsapp`;
  const tail = '&select=*&order=last_message_at.desc.nullslast&limit=1';

  let t = null;
  if (phoneNumberId) {
    const exact = await sb(`${base}&waba_phone_number_id=eq.${encodeURIComponent(phoneNumberId)}${tail}`, env);
    t = exact.data?.[0] || null;
    if (!t) {
      const unclaimed = await sb(`${base}&waba_phone_number_id=is.null${tail}`, env);
      const cand = unclaimed.data?.[0] || null;
      // ADOPT a numberless thread only if it is not LIVE ON THE OTHER TRANSPORT. Claiming one is
      // how a customer's conversations on two different LOT numbers got welded into one: while a
      // number is still on BiteSpeed its threads arrive through the Chatwoot mirror carrying a
      // provider_thread_ref and NO number, so a Relay inbound on the support line would find one
      // seconds old and stamp it support. Anki (+919474213834) hit exactly that on 2026-07-31 —
      // the mirror created her transactional thread at 11:17:30, her support message landed at
      // 11:17:57, and the two streams merged; the agent then saw BiteSpeed's (correct, and correct
      // FOR THAT NUMBER) "this number is only for transactional updates" reply sitting inside what
      // the header called a support chat.
      //
      // Recency is the discriminator, NOT provider_thread_ref alone: every pre-cutover support
      // thread is ALSO Chatwoot-mirrored, and those must stay adoptable or ~6,800 conversations
      // lose their history the next time the customer writes. A thread Chatwoot touched moments
      // ago belongs to a number still on BiteSpeed; a dormant one is genuine pre-migration history.
      // Self-generalising, with no cutover date to maintain: as each remaining number migrates its
      // Chatwoot traffic stops, and its threads age past the window and become adoptable on their own.
      // 5 minutes, CENTRED ON MEASURED DATA rather than picked: across all 18 mirrored threads
      // ever stamped with the support number, the two genuine merge victims sat at 0.4 min while
      // the nearest legitimate adoption sat at 20.4 min (the rest ran 3.4h → 13 days). So the two
      // populations are ~50× apart and anything in 1–20 min separates them; 5 min takes ~10×
      // margin on both sides. Re-measure with that query before changing it.
      const HOT_MS = 5 * 60 * 1000;
      const hotOnChatwoot = !!cand?.provider_thread_ref
        && !!cand?.last_message_at
        && (Date.now() - new Date(cand.last_message_at).getTime()) < HOT_MS;
      t = hotOnChatwoot ? null : cand;
    }
  } else {
    // No number forwarded (older commsops payloads). Fall back to the pre-2026-07-30 behaviour
    // rather than minting a duplicate thread per message — a merge is recoverable, a split
    // inbox is not.
    const any = await sb(`${base}${tail}`, env);
    t = any.data?.[0] || null;
  }

  if (t) {
    const patch = {};
    // Stamp ONLY when the thread has no number yet (case 2). Never overwrite a different one.
    if (phoneNumberId && !t.waba_phone_number_id) patch.waba_phone_number_id = phoneNumberId;
    // Only fill a MISSING name. A customer can rename themselves on WhatsApp at any time, and
    // letting that overwrite a handle an agent may have corrected would make the inbox churn.
    if (clean && (!t.customer_handle || t.customer_handle === t.customer_phone)) patch.customer_handle = clean;
    if (Object.keys(patch).length) {
      await sb(`/rest/v1/cs_wa_threads?id=eq.${t.id}`, env,
        { method: 'PATCH', body: JSON.stringify(patch) }).catch(() => {});
      Object.assign(t, patch);
    }
    return t;
  }
  const ins = await sb(`/rest/v1/cs_wa_threads`, env, {
    method: 'POST',
    body: JSON.stringify({ customer_phone: phone, channel: 'whatsapp',
      waba_phone_number_id: phoneNumberId || null, customer_handle: clean }),
  });
  return ins.data?.[0] || null;
}

// Ingest ONE forwarded inbound WA message → cs_wa_threads/cs_wa_messages. Mirrors
// biteSpeedMessageCreated's INBOUND path: idempotent on the Meta wamid, phone-links to
// the open ticket, resets the local 24h window (now authoritative), reopens a closed
// thread. (Outbound is written by sendWaReplyViaRelay — Relay never forwards our own.)
// NB inbound media is Meta id-based (no hosted URL) — filename/mime captured; a
// media fetch-and-host is a documented follow-up (text is the CS 95% case).
async function relayWaIngestInbound(m, env) {
  const fromRaw = m?.from ? (String(m.from).startsWith('+') ? String(m.from) : `+${m.from}`) : null;
  const phone = fromRaw ? toE164(fromRaw) : null;
  if (!phone) return { skipped: 'no_phone' };
  const pmid = m?.provider_message_id ? String(m.provider_message_id) : null;

  if (pmid) {
    const ex = await sb(`/rest/v1/cs_wa_messages?provider_message_id=eq.${encodeURIComponent(pmid)}&select=id&limit=1`, env);
    if (ex.data?.[0]) return { deduped: true };
  }

  // m.name is Meta's contacts[].profile.name, forwarded by commsops and previously discarded.
  const thread = await relayWaFindOrCreateThread(phone, m?.phone_number_id, env, m?.name);
  if (!thread) return { skipped: 'no_thread' };

  const tRes = await sb(`/rest/v1/cs_tickets?customer_phone=eq.${encodeURIComponent(phone)}&closed_at=is.null&select=id&order=created_at.desc&limit=1`, env);
  const linkedTicketId = tRes.data?.[0]?.id || null;

  const kind = relayWaKind(m?.type);
  const media = m?.media || {};
  const ts = m?.ts || new Date().toISOString();
  const content = m?.text || null;

  const ins = await sb(`/rest/v1/cs_wa_messages`, env, {
    method: 'POST',
    body: JSON.stringify({
      thread_id: thread.id, ticket_id: linkedTicketId, direction: 'inbound', kind, body: content,
      // Which LOT number this arrived on. Recorded per MESSAGE, not just per thread, because the
      // threads that merged before 2026-07-30 cannot be un-picked — the rows carry no attribution
      // to split them by. Never let that be true again.
      waba_phone_number_id: m?.phone_number_id || thread.waba_phone_number_id || null,
      // media_url stays NULL: commsops parks inbound bytes on a PRIVATE bucket (customer-sent
      // files), so there is no durable public URL to store. getWaConversationLocal mints a
      // short-lived signed URL from storage_path at read time instead.
      media_url: null, media_filename: media.filename || media.id || null, media_mime_type: media.mime_type || null,
      media_size_bytes: Number.isFinite(media.size) ? media.size : null,
      raw_meta: media.storage_path
        ? { media_storage_bucket: media.storage_bucket || 'cs-wa-media', media_storage_path: media.storage_path }
        : (media.host_error ? { media_host_error: media.host_error } : null),
      provider_message_id: pmid, status: null, sent_by_user_id: null, sent_by_name: m?.name || null,
      received_at: ts,
    }),
  });
  if (!ins.ok) { console.error(`[relay-wa] cs_wa_messages insert failed ${ins.status} ${JSON.stringify(ins.data)?.slice(0, 200)}`); return { error: 'insert_failed' }; }

  const patch = { last_message_at: ts, last_inbound_at: ts, customer_window_until: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() };
  if (thread.thread_state && thread.thread_state !== 'open') clearClosedFields(patch);
  await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, { method: 'PATCH', body: JSON.stringify(patch) }).catch(() => {});

  // S245 — marketing/txn "wrong number" handling: send ONE redirect. Flag-gated and allow-listed
  // inside, so this is a no-op for support and while the switch is off. Wrapped: a failure here
  // must never lose the customer's message, which is already safely stored above.
  // ⚠️ TICKET-RAISING REMOVED 2026-08-24 (S305, Afshaan): these contacts END at the redirect —
  // do not re-add a ticket-creation step here. Rationale + measured queue cost inside
  // maybeWrongNumberRedirect (the old ensureTicketForThread helper is deleted).
  const effectiveTicketId = linkedTicketId;
  try {
    await maybeWrongNumberRedirect(thread, m, phone, linkedTicketId, env);
  } catch (e) { console.error('[relay-wa] wrong-number redirect failed', e?.message || e); }

  if (effectiveTicketId) {
    await sb(`/rest/v1/cs_ticket_history`, env, { method: 'POST', body: JSON.stringify({
      ticket_id: effectiveTicketId, field_name: 'wa_message_received', old_value: null,
      new_value: kind, note: (content || '').slice(0, 140), changed_by_user_id: null,
      changed_by_name: m?.name || 'Relay (auto)',
    }) }).catch(() => {});
  }
  return { thread_id: thread.id, ticket_id: effectiveTicketId };
}

// Numbers still served by BiteSpeed, as Meta phone_number_ids (comma-separated).
// THE DOUBLE-WRITE GUARD. Subscribing our app to a WABA is ADDITIVE — it does not unsubscribe
// TrustSignal — so during any window where BiteSpeed still delivers a number AND our app is
// subscribed to its WABA, every inbound message arrives twice: once via /webhooks/bitespeed and
// once via this forward. The two carry different provider_message_ids (Chatwoot's numeric id vs
// Meta's wamid), so message-level dedup cannot catch it.
//
// Deliberately a per-NUMBER blocklist and not a global `waTransport(env) !== 'relay'` gate: the
// marketing number is already cut over and its inbound is landing here today, so a global gate
// would silently drop live customer messages. Unset = allow everything = exactly today's
// behaviour. Set it before subscribing a WABA that BiteSpeed still serves; clear it at the flip.
function bitespeedHeldNumbers(env) {
  return String(env.BITESPEED_WA_PHONE_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// ════════════════════════════════════════════════════════════════════════════
// BITESPEED HISTORY BACKFILL (S245) — own the WhatsApp conversation history before
// the vendor account dies.
//
// WHY THIS EXISTS. The WhatsApp history shown in Pitstop is NOT stored: opening a
// thread calls Chatwoot's API live (getWaConversation → loadWaLive → chatwootGetMessages)
// and renders the result. What we hold locally is the thread record, our OUTBOUND
// messages, and 83 stray inbound rows in total. So the customer's half of 6,835
// conversations exists only inside BiteSpeed, and the moment that account lapses every
// one of those threads becomes our side talking to nobody.
//
// The fix needs no vendor cooperation and no manual export: the same token the inbox is
// using right now can page the full history, so we copy it into cs_wa_messages ourselves.
// TIME-BOXED BY THE VENDOR, not by us — it only works while that token authenticates.
//
// Idempotent: dedupes on Chatwoot's message id per thread, so it is safe to re-run, safe
// to run while agents work, and safe to resume after a stop.
//
// Media is RE-HOSTED, not just referenced: Chatwoot's data_url dies with the account, so a
// copied URL would be a dead link — and attachments (damage photos, invoices) are the least
// replaceable part of a support history. Re-hosted files land on the PRIVATE cs-wa-media
// bucket with media_url left NULL, which makes signInboundWaMedia mint a signed URL per
// read; if the copy fails we keep the original URL so the message still records that a file
// existed, plus the reason.
const BACKFILL_BUCKET = 'cs-wa-media';
const BACKFILL_MEDIA_MAX_BYTES = 16 * 1024 * 1024;

async function backfillRehostMedia(url, threadId, msgId, env) {
  try {
    // Chatwoot's data_url is usually directly fetchable; fall back to the API token.
    let r = await fetch(url);
    if (!r.ok) r = await fetch(url, { headers: { api_access_token: env.BITESPEED_API_TOKEN } });
    if (!r.ok) return { ok: false, error: `fetch_${r.status}` };
    const buf = await r.arrayBuffer();
    if (!buf?.byteLength) return { ok: false, error: 'empty' };
    if (buf.byteLength > BACKFILL_MEDIA_MAX_BYTES) return { ok: false, error: 'too_large' };
    const mime = (r.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    const ext = (url.split('?')[0].split('.').pop() || 'bin').slice(0, 5).replace(/[^a-z0-9]/gi, '') || 'bin';
    const path = `backfill/${threadId}/${msgId}.${ext}`;
    const up = await fetch(`${env.SUPABASE_URL}/storage/v1/object/${BACKFILL_BUCKET}/${path}`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': mime, 'x-upsert': 'true',
      },
      body: buf,
    });
    if (!up.ok) return { ok: false, error: `upload_${up.status}` };
    return { ok: true, path, mime, size: buf.byteLength };
  } catch (e) { return { ok: false, error: `error:${(e?.message || e).toString().slice(0, 50)}` }; }
}

async function backfillOneThread(thread, env, maxPages, doMedia) {
  const out = { messages: 0, media_ok: 0, media_failed: 0, reached_start: false };

  // What we already hold for this thread, so a re-run inserts nothing.
  const ex = await sb(
    `/rest/v1/cs_wa_messages?thread_id=eq.${encodeURIComponent(thread.id)}`
    + `&provider_message_id=not.is.null&select=provider_message_id&limit=3000`, env);
  const have = new Set((ex.data || []).map((r) => String(r.provider_message_id)));

  const res = await chatwootGetMessages(thread, env, maxPages);
  if (!res.ok) return { ...out, error: `chatwoot_${res.status}` };
  out.reached_start = res.reachedStart === true;

  const mapped = (res.raw || []).map(mapChatwootMessage).filter(Boolean)
    .filter((m) => m.provider_message_id && !have.has(String(m.provider_message_id)));
  if (!mapped.length) return out;

  const rows = [];
  for (const m of mapped) {
    let mediaUrl = m.media_url, rawMeta = null;
    if (doMedia && m.media_url) {
      const h = await backfillRehostMedia(m.media_url, thread.id, m.provider_message_id, env);
      if (h.ok) {
        mediaUrl = null;                                     // signer fills it from the path
        rawMeta = { media_storage_bucket: BACKFILL_BUCKET, media_storage_path: h.path, backfilled: true };
        out.media_ok++;
      } else {
        rawMeta = { media_host_error: h.error, media_source_url: m.media_url, backfilled: true };
        out.media_failed++;
      }
    }
    rows.push({
      thread_id: thread.id,
      // ticket_id deliberately NULL: the conversation view keys on thread_id, and guessing a
      // ticket for a months-old message would corrupt per-ticket reporting.
      ticket_id: null,
      direction: m.direction, kind: m.kind, body: m.body,
      template_name: m.template_name,
      media_url: mediaUrl, media_filename: m.media_filename,
      media_size_bytes: null,
      raw_meta: rawMeta,
      provider_message_id: m.provider_message_id,
      status: m.status, is_internal: m.is_internal,
      sent_by_user_id: null, sent_by_name: m.sent_by_name,
      received_at: m.received_at, sent_at: m.sent_at,
      // Explicit created_at — the whole point is preserving WHEN it was said.
      created_at: m.created_at,
    });
  }

  const ins = await sb(`/rest/v1/cs_wa_messages`, env, {
    method: 'POST', prefer: 'return=minimal', body: JSON.stringify(rows),
  });
  if (!ins.ok) return { ...out, error: `insert_${ins.status}:${JSON.stringify(ins.data)?.slice(0, 120)}` };
  out.messages = rows.length;
  return out;
}

// POST /internal/wa-history-backfill — token-gated, cursor-driven, resumable.
// Keyset on thread `id` ASC (a uuid, so it is stable): ordering on last_message_at would
// let a thread that receives a new message during the run jump the cursor and be skipped.
async function handleWaHistoryBackfill(request, env) {
  // Accept INGEST_TOKEN or WA_SYNC_TOKEN — both are internal service secrets, mirroring
  // commsops' /internal/backfill-last-order. Neither carries user credentials.
  const a = request.headers.get('Authorization') || '';
  const bearer = a.slice(0, 7).toLowerCase() === 'bearer ' ? a.slice(7).trim() : '';
  const okTok = bearer && ((env.INGEST_TOKEN && bearer === env.INGEST_TOKEN)
                        || (env.WA_SYNC_TOKEN && bearer === env.WA_SYNC_TOKEN));
  if (!okTok) return err('unauthorised', 401);
  if (!env.BITESPEED_API_TOKEN) return err('BITESPEED_API_TOKEN not set — nothing to pull from', 503);

  let b = {}; try { b = await request.json(); } catch {}
  const sinceDays = Number(b.sinceDays) > 0 ? Number(b.sinceDays) : 7;
  const since = b.since || new Date(Date.now() - sinceDays * 86400000).toISOString();
  const limit = Math.min(Math.max(Number(b.limit) || 20, 1), 40);
  const maxPages = Math.min(Math.max(Number(b.maxPages) || 12, 1), 36);
  const doMedia = b.media !== false;
  const cursor = b.cursor || '00000000-0000-0000-0000-000000000000';

  let q = `/rest/v1/cs_wa_threads?provider_thread_ref=not.is.null`
    + `&or=(channel.is.null,channel.eq.whatsapp)`
    + `&last_message_at=gte.${encodeURIComponent(since)}`
    + `&id=gt.${encodeURIComponent(cursor)}`
    + `&select=id,provider_account_id,provider_thread_ref,customer_phone,last_message_at`
    + `&order=id.asc&limit=${limit}`;
  const tRes = await sb(q, env);
  if (!tRes.ok) return err(`thread query failed: ${JSON.stringify(tRes.data)?.slice(0, 200)}`, 500);
  const threads = tRes.data || [];

  const totals = { threads: 0, messages: 0, media_ok: 0, media_failed: 0, errors: [] };
  let lastId = cursor;
  for (const t of threads) {
    const r = await backfillOneThread(t, env, maxPages, doMedia);
    totals.threads++;
    totals.messages += r.messages;
    totals.media_ok += r.media_ok;
    totals.media_failed += r.media_failed;
    if (r.error && totals.errors.length < 8) totals.errors.push({ thread: t.id, phone: t.customer_phone, error: r.error });
    lastId = t.id;
  }

  return json({
    ok: true, since, ...totals,
    next_cursor: lastId,
    done: threads.length < limit,   // a short page = the window is exhausted
  });
}

// ════════════════════════════════════════════════════════════════════════════
// "WRONG NUMBER" REDIRECT (S245) — replaces the BiteSpeed automation that stops at the support
// cutover ("Thank you for reaching out. This number is only used for transactional updates…",
// 445 sends/30d). Two jobs on a reply to the MARKETING or TRANSACTIONAL number:
//   1. raise a ticket, because until now these raised NONE — relayWaIngestInbound only LINKED to
//      an already-open ticket, so 219 of 232 such threads over 14 days sat in the inbox and in
//      nobody's worklist: no queue, no SLA, no reporting;
//   2. reply once, pointing the customer at the support line.
//
// WHY REDIRECT INSTEAD OF JUST ANSWERING (Afshaan): answering there invites a repeat conversation
// on a number that cannot sustain one. Templates are WABA-scoped, so the lot_support_* templates
// live ONLY on the support WABA — the moment the customer's 24h window on the marketing/txn number
// shuts, that thread can never be reopened. A structural dead end, so send them somewhere real.
//
// The reply is a plain session message (they just wrote, so the window is open) → no Meta template
// approval, and the copy is editable in Relay settings without a deploy.
const WRONG_NUMBER_TAG = 'wrong_number_redirect';   // stamped on template_name — also the 24h key
// Conservative: only unambiguous opt-out/opt-in keywords. optout.js in commsops owns the real
// handling; this exists purely so we never answer a withdrawal with marketing-adjacent chatter.
const OPTOUT_WORDS = new Set(['stop', 'unsubscribe', 'unsub', 'start', 'cancel subscription', 'opt out', 'optout']);

async function wrongNumberConfig(env) {
  const r = await sb(
    `/rest/v1/settings?id=eq.1&select=wrong_number_redirect_enabled,wrong_number_redirect_phone_ids,wrong_number_redirect_text&limit=1`,
    env, { headers: { 'Accept-Profile': 'comms' } });
  return r.ok ? (r.data?.[0] || null) : null;
}

// Is this customer mid-journey? A C2P customer may answer with FREE TEXT ("yes confirm") rather
// than tapping, so the button_id check alone is not enough — and cutting across a live money
// journey with "please use the support number" is the worst outcome this feature could produce.
async function hasActiveEnrolment(phone, env) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return false;
  const idr = await sb(
    `/rest/v1/identifiers?type=eq.phone&value=eq.${encodeURIComponent('+' + digits)}&select=profile_id&limit=1`,
    env, { headers: { 'Accept-Profile': 'comms' } });
  const pid = idr.ok ? idr.data?.[0]?.profile_id : null;
  if (!pid) return false;
  const en = await sb(`/rest/v1/enrolments?profile_id=eq.${pid}&status=eq.active&select=id&limit=1`,
    env, { headers: { 'Accept-Profile': 'comms' } });
  return !!(en.ok && en.data?.[0]);
}

async function maybeWrongNumberRedirect(thread, m, phone, ticketId, env) {
  const cfg = await wrongNumberConfig(env);
  if (!cfg?.wrong_number_redirect_enabled) return { skipped: 'disabled' };

  // ALLOW-LIST, never "everything except support": after migration support is itself a Relay
  // thread with a NEW phone_number_id, and an exclusion rule would start telling support
  // customers to go to support. Unknown id ⇒ never redirect.
  const ids = String(cfg.wrong_number_redirect_phone_ids || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!thread.waba_phone_number_id || !ids.includes(String(thread.waba_phone_number_id)))
    return { skipped: 'not_a_redirect_number' };

  // A conversation handed to Ignition stays in Ignition (Afshaan, 2026-08-24 S305): never cut
  // across the Influencer team's chat with a support redirect, and never raise CS paperwork on it.
  if (thread.ignition_connect) return { skipped: 'ignition_connect' };

  if (m?.button_id) return { skipped: 'button_tap' };                       // C2P / interactive reply
  const txt = String(m?.text || '').trim().toLowerCase();
  if (OPTOUT_WORDS.has(txt)) return { skipped: 'optout_keyword' };
  if (await hasActiveEnrolment(phone, env)) return { skipped: 'mid_journey' };

  // NO ticket is raised here — Afshaan, 2026-08-24 (S305), REVERSING the S245 "so it enters the
  // queue" behaviour: a customer reply to a marketing/utility send must END at the redirect below.
  // We do not want to encourage conversation on these numbers, and the queue cost was measured
  // before removal: 26–345 auto tickets/day (spiking with every campaign), almost all never
  // worked — 26/26 same-day open, 292 of 345 still open from the 15 Aug sale. If this phone
  // already HAS an open ticket, the caller's phone-match (ticketId) still links the redirect row
  // to it — linking to existing paperwork is fine; minting new paperwork is not.

  // Once per thread per 24h — a customer sending three messages gets one redirect, not three.
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const recent = await sb(
    `/rest/v1/cs_wa_messages?thread_id=eq.${encodeURIComponent(thread.id)}`
    + `&template_name=eq.${WRONG_NUMBER_TAG}&created_at=gte.${encodeURIComponent(since)}&select=id&limit=1`, env);
  if (recent.data?.[0]) return { skipped: 'already_sent_24h' };

  const text = cfg.wrong_number_redirect_text
    || 'For help with an order or other queries, message us on +91 98802 12323 — https://wa.me/919880212323';

  let resp, data;
  try {
    resp = await callWorker(env.COMMSOPS, env, '/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.INGEST_TOKEN}` },
      body: JSON.stringify({
        channel: 'whatsapp', purpose: 'utility', to: thread.customer_phone,
        phoneNumberId: thread.waba_phone_number_id,   // answer on the number they wrote to
        template: { content: { text_body: text } },
        dedupKey: `pitstop:wrongnum:${thread.id}:${Math.floor(Date.now() / 3600000)}`,
        source: 'pitstop_wrong_number_redirect',
      }),
    });
    data = await resp.json().catch(() => ({}));
  } catch (e) { return { error: `send_failed:${e.message}` }; }
  const msg = data?.data || data?.message || data || {};
  if (!resp.ok || data?.ok === false || msg.status === 'failed')
    return { error: `send_rejected:${msg.reason || resp.status}` };

  await sb(`/rest/v1/cs_wa_messages`, env, {
    method: 'POST', prefer: 'return=minimal',
    body: JSON.stringify({
      thread_id: thread.id, ticket_id: ticketId, direction: 'outbound', kind: 'text',
      waba_phone_number_id: thread.waba_phone_number_id || null,   // which LOT number this left from
      body: text, template_name: WRONG_NUMBER_TAG,
      provider_message_id: msg.provider_message_id || null, status: msg.status || 'sent',
      is_internal: false, sent_by_user_id: null, sent_by_name: 'Relay (auto)',
      sent_at: new Date().toISOString(),
    }),
  }).catch(() => {});
  return { sent: true };
}

async function handleRelayWaWebhook(request, env) {
  if (!verifyRelayWaAuth(request, env)) return err('Invalid forward token', 401);
  let body = {};
  try { body = await request.json(); } catch { return err('Bad JSON', 400); }
  const held = bitespeedHeldNumbers(env);
  const messages = (Array.isArray(body?.messages) ? body.messages : [])
    .filter((m) => !(m?.phone_number_id && held.includes(String(m.phone_number_id))));
  const results = [];
  for (const m of messages) {
    try { results.push(await relayWaIngestInbound(m, env)); }
    catch (e) { console.error('[relay-wa] ingest error', e); results.push({ error: String(e?.message || e) }); }
  }
  return json({ ok: true, processed: results.length });
}

// Agent reply on a Relay-transported WhatsApp thread → send via Relay /send (channel
// whatsapp, purpose utility → bypasses the marketing gate, still hits suppression +
// TEST MODE). Window is checked from the local authoritative customer_window_until
// (Relay writes it on every inbound). We insert the outbound row ourselves (there is
// no Chatwoot mirror-back on this transport).
async function sendWaReplyViaRelay(thread, text, auth, env) {
  const until = thread.customer_window_until ? new Date(thread.customer_window_until).getTime() : 0;
  if (!(until > Date.now()))
    return err('Outside the 24h customer window — free-text replies are blocked until the customer messages again (templates coming soon)', 422);

  let resp, data;
  try {
    resp = await callWorker(env.COMMSOPS, env, '/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.INGEST_TOKEN}` },
      body: JSON.stringify({
        channel: 'whatsapp', purpose: 'utility', to: thread.customer_phone,
        // Reply from the number the customer actually wrote to. Without this a reply to the
        // MARKETING or TRANSACTIONAL number resolves to the support sender by purpose, and the
        // 24h window (keyed on recipient + phone_number_id) is then closed → every reply refused.
        phoneNumberId: thread.waba_phone_number_id || undefined,
        template: { content: { text_body: String(text) } },
        dedupKey: `pitstop:reply:${thread.id}:${Date.now()}`, source: 'pitstop_agent',
      }),
    });
    data = await resp.json().catch(() => ({}));
  } catch (e) { return err(`Relay send failed: ${e.message}`, 502); }
  if (!resp.ok || data?.ok === false)
    return err(`Relay send failed (${resp.status}): ${JSON.stringify(data)?.slice(0, 300)}`, resp.status || 502);

  const msg = data?.data || data?.message || data || {};
  const pmid = msg.provider_message_id || msg.id || null;
  const now = new Date().toISOString();
  const senderName = auth.fullName || auth.name || auth.email || null;

  const threadPatch = { last_message_at: now };
  if (!thread.assigned_agent_id && !auth.viaIgnitionBridge) {
    threadPatch.assigned_agent_id = auth.userId;
    threadPatch.assigned_agent_name = senderName;
    threadPatch.assigned_at = now;
  }
  if (thread.thread_state && thread.thread_state !== 'open') clearClosedFields(threadPatch);
  await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, { method: 'PATCH', body: JSON.stringify(threadPatch) }).catch(() => {});

  const ticketId = auth.viaIgnitionBridge ? null : await assignLinkedTicketToReplier(thread.id, auth, env);

  await sb(`/rest/v1/cs_wa_messages`, env, {
    method: 'POST',
    body: JSON.stringify({
      thread_id: thread.id, ticket_id: ticketId, direction: 'outbound', kind: 'text', body: String(text),
      waba_phone_number_id: thread.waba_phone_number_id || null,   // which LOT number this left from
      provider_message_id: pmid, status: msg.status || 'sent', is_internal: false,
      sent_by_user_id: auth.userId, sent_by_name: senderName, sent_at: now,
    }),
  }).catch((e) => console.error('[relay-wa] outbound insert failed', e?.message));

  if (ticketId) await insertHistory(ticketId, 'wa_message_sent', null, 'text', String(text).slice(0, 140), auth, env).catch(() => {});
  return ok({ message: { direction: 'outbound', body: String(text), provider_message_id: pmid, status: msg.status || 'sent' }, via: 'relay' });
}

// Agent attachment on a Relay-transported WA thread (S245). Two hops by design:
// we host the bytes on the PUBLIC cs-inbox-media bucket (same bucket the IG/FB attachment path
// already uses for agent-authored files), then hand commsops the URL — commsops uploads it to
// Meta and sends by media ID. Passing a URL rather than base64 keeps the service-binding body
// small and reuses the upload+cache logic that already lives on the Relay side.
async function sendWaAttachmentViaRelay(thread, file, auth, env) {
  const { bytes, mime_type, filename, caption, spec } = file;
  // Media is a session message — same 24h rule as a free-text reply. Checked here so the agent
  // gets a clear error instead of burning an upload on a send the gate will refuse.
  const until = thread.customer_window_until ? new Date(thread.customer_window_until).getTime() : 0;
  if (!(until > Date.now()))
    return err('Outside the 24h customer window — attachments are blocked until the customer messages again', 422);

  const path = `${thread.id}/${crypto.randomUUID()}.${spec.ext}`;
  const up = await fetch(`${env.SUPABASE_URL}/storage/v1/object/cs-inbox-media/${path}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': mime_type, 'x-upsert': 'true',
    },
    body: bytes,
  });
  if (!up.ok) { const t = await up.text().catch(() => ''); return err(`Upload failed: ${t.slice(0, 200)}`, up.status || 500); }
  const publicUrl = `${env.SUPABASE_URL}/storage/v1/object/public/cs-inbox-media/${path}`;

  let resp, data;
  try {
    resp = await callWorker(env.COMMSOPS, env, '/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.INGEST_TOKEN}` },
      body: JSON.stringify({
        channel: 'whatsapp', purpose: 'utility', to: thread.customer_phone,
        phoneNumberId: thread.waba_phone_number_id || undefined,   // same-number reply — see sendWaReplyViaRelay
        template: { content: { media: { url: publicUrl, mime_type, filename: filename || null },
                               text_body: caption ? String(caption) : '' } },
        dedupKey: `pitstop:attach:${thread.id}:${Date.now()}`, source: 'pitstop_agent',
      }),
    });
    data = await resp.json().catch(() => ({}));
  } catch (e) { return err(`Relay send failed: ${e.message}`, 502); }
  if (!resp.ok || data?.ok === false)
    return err(`Relay send failed (${resp.status}): ${JSON.stringify(data)?.slice(0, 300)}`, resp.status || 502);

  // A media upload that Meta refused comes back 200-with-status-failed, not as an HTTP error —
  // surface it as a real failure so the agent retries rather than believing it sent.
  const msg = data?.data || data?.message || data || {};
  if (msg.status === 'failed' || msg.status === 'skipped')
    return err(`WhatsApp refused the attachment (${msg.reason || msg.status})`, 422);

  const pmid = msg.provider_message_id || msg.id || null;
  const now = new Date().toISOString();
  const senderName = auth.fullName || auth.name || auth.email || null;

  const threadPatch = { last_message_at: now };
  if (!thread.assigned_agent_id && !auth.viaIgnitionBridge) {
    threadPatch.assigned_agent_id = auth.userId;
    threadPatch.assigned_agent_name = senderName;
    threadPatch.assigned_at = now;
  }
  if (thread.thread_state && thread.thread_state !== 'open') clearClosedFields(threadPatch);
  await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, { method: 'PATCH', body: JSON.stringify(threadPatch) }).catch(() => {});

  const ticketId = auth.viaIgnitionBridge ? null : await assignLinkedTicketToReplier(thread.id, auth, env);

  await sb(`/rest/v1/cs_wa_messages`, env, {
    method: 'POST',
    body: JSON.stringify({
      thread_id: thread.id, ticket_id: ticketId, direction: 'outbound', kind: spec.kind,
      waba_phone_number_id: thread.waba_phone_number_id || null,   // which LOT number this left from
      body: caption ? String(caption) : null,
      media_url: publicUrl, media_filename: filename || null, media_mime_type: mime_type,
      media_size_bytes: bytes.length ?? bytes.byteLength ?? null,
      provider_message_id: pmid, status: msg.status || 'sent', is_internal: false,
      sent_by_user_id: auth.userId, sent_by_name: senderName, sent_at: now,
    }),
  }).catch((e) => console.error('[relay-wa] outbound media insert failed', e?.message));

  if (ticketId) await insertHistory(ticketId, 'wa_message_sent', null, spec.kind, String(filename || spec.kind).slice(0, 140), auth, env).catch(() => {});
  return ok({ message: { direction: 'outbound', kind: spec.kind, media_url: publicUrl, provider_message_id: pmid, status: msg.status || 'sent' }, via: 'relay' });
}

// Read a Relay-transported WA thread from LOCAL cs_wa_messages (Relay is the capture
// source → full local history; no Chatwoot pull, no attribution overlay). Window from
// the local authoritative column.
async function getWaConversationLocal(thread, env) {
  const r = await sb(`/rest/v1/cs_wa_messages?thread_id=eq.${encodeURIComponent(thread.id)}&select=*&order=created_at.asc&limit=1000`, env);
  const messages = r.data || [];
  await signInboundWaMedia(messages, env);
  const until = thread.customer_window_until || null;
  const open = until ? (new Date(until).getTime() > Date.now()) : false;
  return ok({ messages, within_customer_window: open, window_until: until, live: true, transport: 'relay' });
}

// Inbound attachments on the Relay transport live on a PRIVATE bucket (commsops parks them
// there — they are files customers sent us). The inbox bubble renders `media_url`, so mint a
// short-lived signed URL per read rather than persisting one: a stored URL would expire and
// leave the same dead chip this exists to prevent. Batched into ONE storage call.
const WA_MEDIA_SIGN_TTL = 3600;   // 1h — comfortably longer than an agent reads a thread

async function signInboundWaMedia(messages, env) {
  const targets = (messages || []).filter((m) => m?.raw_meta?.media_storage_path && !m.media_url);
  if (!targets.length) return;
  const bucket = targets[0].raw_meta.media_storage_bucket || 'cs-wa-media';
  try {
    const res = await fetch(`${env.SUPABASE_URL}/storage/v1/object/sign/${bucket}`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expiresIn: WA_MEDIA_SIGN_TTL, paths: targets.map((m) => m.raw_meta.media_storage_path) }),
    });
    if (!res.ok) return;   // unsigned → chip stays inert; never fail the whole conversation read
    const signed = await res.json().catch(() => []);
    const byPath = new Map((Array.isArray(signed) ? signed : []).map((s) => [s.path, s.signedURL || s.signedUrl]));
    for (const m of targets) {
      const rel = byPath.get(m.raw_meta.media_storage_path);
      if (rel) m.media_url = `${env.SUPABASE_URL}/storage/v1${rel}`;
    }
  } catch { /* leave media_url null — the message body still renders */ }
}

// ════════════════════════════════════════════════════════════════════════════
// META — Instagram + Facebook Messenger DMs, DIRECT via the Messenger Platform
// (independent of BiteSpeed/WhatsApp). Reuses cs_wa_threads/cs_wa_messages with
// channel='instagram'|'messenger'. Webhook envelope is the stable Graph shape:
//   { object:'instagram'|'page', entry:[{ id, messaging:[{ sender:{id},
//     recipient:{id}, timestamp, message:{ mid, text, attachments, is_echo } }] }] }
// Founder setup: Meta app + IG-professional/FB-Page, subscribe webhook → this URL
// with META_VERIFY_TOKEN, App Review (instagram_business_manage_messages /
// pages_messaging), then a long-lived Page access token. Secrets:
// META_VERIFY_TOKEN, META_APP_SECRET, META_PAGE_TOKEN. INERT until those are set.
// ════════════════════════════════════════════════════════════════════════════
const META_GRAPH = 'https://graph.facebook.com/v21.0';
// Token per channel: Instagram (IG-login path) uses its own user token; FB
// Messenger uses the Page token. IG falls back to the page token if linked.
// ⚠️ ASYNC as of S311. The Instagram token now lives in store.cs_meta_token_config so a
// cron can REFRESH it — an IGAA token caps at 60 days, nothing renewed it, and it died
// once already (Instagram down 20–24 Aug 2026). `igAccessToken` reads the stored token
// and falls back to the secret, so this keeps working if the row is empty or the DB
// blips. Messenger is unaffected: META_PAGE_TOKEN is a different credential that does
// not expire this way.
async function metaToken(channel, env) {
  return channel === 'instagram' ? await igAccessToken(env, sb) : env.META_PAGE_TOKEN;
}

// Instagram-Login (IGAA) tokens only work against graph.instagram.com; Messenger
// (Page) tokens use graph.facebook.com. Pick the right Graph host per channel.
function metaGraphBase(channel) {
  return channel === 'instagram' ? 'https://graph.instagram.com/v21.0' : META_GRAPH;
}

// Meta's raw error JSON is what the agent sees banner-width across the top of the inbox, and
// the one failure they hit routinely — replying past 24h — renders as an unreadable blob ending
// in an fbtrace_id (Pruthvi 2026-08-05). Translate the known cause; anything unrecognised still
// surfaces verbatim, since a swallowed error is worse than an ugly one.
// The cause: past the window we send tag:HUMAN_AGENT, which Meta gates behind the separate
// `human_agent` App Review permission (App Dashboard → App Review → Permissions & Features).
// It is NOT covered by instagram_business_manage_messages, which is what we hold.
function metaSendError(d, status) {
  const e = (d && d.error) || {};
  if (Number(e.code) === 10 && /human[_ ]agent/i.test(String(e.message || ''))) {
    return err('Meta refused this reply. Replying more than 24 hours after the customer wrote '
      + 'needs its Human Agent approval, which is still pending. The chat reopens if the customer messages again.', status);
  }
  // 190 = OAuthException, i.e. the stored access token has expired or been revoked. This is
  // NOT something an agent can act on, and the raw blob ("Session has expired on Thursday,
  // 20-Aug-26 09:36:15 PDT ... fbtrace_id") reads like a fault with the message they just
  // typed. It took ~2 days to be reported (Pruthvi 2026-08-21) while every Instagram reply
  // silently failed and the team fell back to the Instagram app. Say plainly who can fix it.
  if (Number(e.code) === 190) {
    return err('Instagram is disconnected — its access token has expired, so no reply can be '
      + 'sent from here until it is renewed. This is not a problem with your message. '
      + 'Tell Afshaan; replying from the Instagram app still works meanwhile.', status);
  }
  // 200 = "Permissions error". This is NOT the past-24h block (code 10) and NOT an expired
  // token (code 190) — it arrives on threads whose window is demonstrably open, while every
  // other Instagram reply that day sends fine (measured 2026-08-26: 114 sent that morning),
  // and every thread is on one provider_account_id. So it is refused per RECIPIENT.
  // ⚠️ We have NOT yet measured which recipient-side condition Meta means — run the
  // diagIgRecipient probe on a live instance of this before claiming one. The wording below
  // is therefore deliberately about what the agent should DO, not about the cause: the last
  // time an unread Meta error was paraphrased from documentation rather than measured, the
  // copy told agents a send would work while it was failing (S262/S263).
  if (Number(e.code) === 200) {
    return err('Instagram refused this reply for this chat. It is not your message, and it is '
      + 'not the 24-hour limit — other chats are sending normally. Try replying once from the '
      + 'Instagram app; if that also fails, send Afshaan this customer\'s name.', status);
  }
  return err(`Meta send failed: ${JSON.stringify(Object.keys(e).length ? e : d)}`, status);
}

function handleMetaVerify(url, env) {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  if (mode === 'subscribe' && env.META_VERIFY_TOKEN && token === env.META_VERIFY_TOKEN) {
    return new Response(challenge || '', { status: 200, headers: { ...CORS, 'Content-Type': 'text/plain' } });
  }
  return err('Verification failed', 403);
}

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function handleMetaWebhook(request, env) {
  // Accept either the FB app secret (Messenger) or the IG app secret (IG-login
  // path) — events from each product are signed with their own app secret.
  const secrets = [env.META_APP_SECRET, env.META_IG_APP_SECRET].filter(Boolean);
  if (!secrets.length) return json({ ok: true, skipped: 'meta_not_configured' });
  const raw = await request.text();
  // X-Hub-Signature-256 = 'sha256=' + HMAC-SHA256(rawBody, app_secret)
  const sigHeader = request.headers.get('x-hub-signature-256') || '';
  let validSig = false;
  for (const s of secrets) { if (sigHeader === 'sha256=' + await hmacSha256Hex(s, raw)) { validSig = true; break; } }
  if (!validSig) return err('Invalid signature', 401);

  let body = {};
  try { body = JSON.parse(raw); } catch { return err('Bad JSON', 400); }
  const channel = body?.object === 'instagram' ? 'instagram' : body?.object === 'page' ? 'messenger' : null;
  if (!channel) return json({ ok: true, ignored: body?.object || 'unknown' });

  try {
    for (const entry of (body.entry || [])) {
      for (const ev of (entry.messaging || entry.standby || [])) {
        if (ev.message) await metaHandleMessage(channel, ev, env);
      }
    }
  } catch (e) {
    console.error('[meta] handler error', e);
  }
  return json({ ok: true });   // always ack to avoid Meta retry storms
}

async function metaFindOrCreateThread(channel, extUserId, accountId, env) {
  const found = await sb(
    `/rest/v1/cs_wa_threads?channel=eq.${channel}&external_user_id=eq.${encodeURIComponent(extUserId)}&select=*&limit=1`, env);
  if (found.data?.[0]) return found.data[0];
  const ins = await sb(`/rest/v1/cs_wa_threads`, env, {
    method: 'POST',
    body: JSON.stringify({
      channel, external_user_id: extUserId, provider_thread_ref: extUserId,
      provider_account_id: accountId != null ? String(accountId) : null,
    }),
  });
  if (!ins.ok) console.error(`[meta] thread insert failed ${ins.status} ${JSON.stringify(ins.data)?.slice(0, 200)}`);
  return ins.data?.[0] || null;
}

// Best-effort IG-username / FB-name lookup for a scoped sender id (needs a token).
async function resolveMetaHandle(extUserId, channel, env) {
  const token = await metaToken(channel, env);
  if (!token) return null;
  try {
    const r = await fetch(`${metaGraphBase(channel)}/${encodeURIComponent(extUserId)}?fields=name,username&access_token=${token}`);
    const d = await r.json();
    return r.ok ? (d.username || d.name || null) : null;
  } catch { return null; }
}

// Collab pre-flag keywords (Pruthvi's list, #bugs 2026-07-27). Ordered most-specific
// first so the stored label names the strongest match ('paid collab' beats 'collab').
// Matched on WORD BOUNDARIES, never as bare substrings — 'fee' would otherwise hit
// "coffee" and every "free". Even so, 'fee'/'charges' will catch genuine support
// questions about delivery charges; that is tolerable precisely because this only
// RAISES A FLAG and never moves the conversation.
// The collab family is a PREFIX match so collab / collabs / collaboration(s) /
// collaborate / collaborating all land; the others are exact words + optional plural.
const COLLAB_KEYWORDS = [
  ['paid collab',   /(^|[^a-z0-9])paid\s+collab[a-z]*($|[^a-z0-9])/i],
  ['collaboration', /(^|[^a-z0-9])collaborat[a-z]*($|[^a-z0-9])/i],
  ['collab',        /(^|[^a-z0-9])collabs?($|[^a-z0-9])/i],
  ['charges',       /(^|[^a-z0-9])charges?($|[^a-z0-9])/i],
  ['fee',           /(^|[^a-z0-9])fees?($|[^a-z0-9])/i],
];
function collabKeywordHit(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  for (const [label, re] of COLLAB_KEYWORDS) if (re.test(t)) return label;
  return null;
}

async function metaHandleMessage(channel, ev, env) {
  const msg = ev.message || {};
  const mid = msg.mid != null ? String(msg.mid) : null;
  const isEcho = !!msg.is_echo;
  const direction = isEcho ? 'outbound' : 'inbound';
  // inbound: customer = sender.id, our acct = recipient.id · echo(outbound): swapped
  const extUserId = String(isEcho ? ev.recipient?.id : ev.sender?.id);
  const accountId = isEcho ? ev.sender?.id : ev.recipient?.id;
  if (!extUserId || extUserId === 'undefined') return;

  if (mid) {
    const exists = await sb(`/rest/v1/cs_wa_messages?provider_message_id=eq.${encodeURIComponent(mid)}&select=id&limit=1`, env);
    if (exists.data?.[0]) return;   // idempotent
  }

  const thread = await metaFindOrCreateThread(channel, extUserId, accountId, env);
  if (!thread) return;

  if (!thread.customer_handle) {
    const handle = await resolveMetaHandle(extUserId, channel, env);
    if (handle) {
      await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, { method: 'PATCH', body: JSON.stringify({ customer_handle: handle }) }).catch(() => {});
      thread.customer_handle = handle;
    }
  }

  const att = Array.isArray(msg.attachments) ? msg.attachments[0] : null;
  let kind = 'text', mediaUrl = null, attTitle = null;
  if (att) {
    kind = metaAttachmentKind(att.type);           // never Meta's raw type — see the map
    mediaUrl = att.payload?.url || null;
    // For a reel/post share Meta puts the caption in payload.title. The agent needs it to
    // know WHICH product the customer means, which is the entire point of the report —
    // falling back to it only when the customer sent no words of their own.
    attTitle = att.payload?.title || null;
  }
  const ts = ev.timestamp ? new Date(Number(ev.timestamp)).toISOString() : new Date().toISOString();

  const ins = await sb(`/rest/v1/cs_wa_messages`, env, {
    method: 'POST',
    body: JSON.stringify({
      thread_id: thread.id, channel, direction, kind,
      body: msg.text || attTitle || null, media_url: mediaUrl, provider_message_id: mid,
      status: direction === 'outbound' ? 'sent' : null,
      received_at: direction === 'inbound' ? ts : null,
      sent_at: direction === 'outbound' ? ts : null,
      raw_meta: ev,
    }),
  });
  // Name the kind in the error: the one time this fired in anger it was a CHECK violation
  // on `kind`, and the old message said only "insert failed" — which is why a customer
  // message going missing went unexplained for two weeks.
  if (!ins.ok) { console.error(`[meta] message insert failed ${ins.status} kind=${kind} att=${att?.type || 'none'} ${JSON.stringify(ins.data)?.slice(0, 200)}`); return; }

  const patch = { last_message_at: ts };
  if (direction === 'inbound') {
    patch.last_inbound_at = ts;   // unread watermark (team-global read state)
    patch.customer_window_until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    // Auto-reopen (Q1=B work-queue): any inbound makes the conversation active again,
    // clearing a prior Done/Snooze. The prior assignee (if any) is kept for continuity.
    if (thread.thread_state && thread.thread_state !== 'open') clearClosedFields(patch);
    // Collab pre-flag (Pruthvi, agreed shape 2026-07-27). Flag only — the
    // conversation is NOT moved, because the keyword is the CUSTOMER's wording and a
    // complaint that merely mentions a collab must not silently land with the
    // Influencer team. The agent sees the flag and clicks the existing transfer.
    // Not re-flagged once an agent has dismissed it.
    const hit = collabKeywordHit(msg.text);
    if (hit && !thread.collab_flagged && !thread.collab_dismissed && !thread.ignition_connect
        && (channel === 'instagram' || channel === 'messenger')) {
      patch.collab_flagged    = true;
      patch.collab_keyword    = hit;
      patch.collab_flagged_at = ts;
    }
  }
  await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, { method: 'PATCH', body: JSON.stringify(patch) }).catch(() => {});

  // Round-robin: auto-assign an unassigned inbound thread to the least-loaded eligible
  // agent. Config-gated per channel inside the RPC (WhatsApp seeded off). Best-effort.
  // Skip Ignition-transferred threads (S177) — they belong to the Influencer team now.
  if (direction === 'inbound' && !thread.assigned_agent_id && !thread.ignition_connect) {
    await sb(`/rest/v1/rpc/cs_autoassign_thread`, env, {
      method: 'POST', body: JSON.stringify({ p_thread_id: thread.id }),
    }).catch(() => {});
  }
}

// ⚠️ TEMPORARY DIAGNOSTIC (S263) — DELETE once the human_agent question is settled.
// Instagram DMs can be driven two ways: the Instagram-Login API we use (graph.instagram.com
// + IGAA token), where HUMAN_AGENT is a reviewed feature and is REFUSED for us (measured
// 2026-08-05: IGApiException code 10), or the Messenger Platform (graph.facebook.com + Page
// token), where HUMAN_AGENT is a native message tag. This sends ONE message on the second
// route and returns Meta's raw response so the answer is measured, not argued.
// Writes nothing to cs_wa_messages — it is a probe, not a send path.
// The Graph API Explorer could not do this test: its token helper still requests the
// long-dead `manage_pages` scope and dies before granting a Page token.
async function diagIgPageRoute(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  const { thread_id, text, probe, recipient_override } = body || {};

  // READ-ONLY probe: does the Page even see Instagram conversations? IG-scoped user ids are
  // PER-SURFACE — the id the Instagram-Login webhook gave us is not the id the Messenger
  // Platform knows that person by, so sending to it returns (#100) No matching user found
  // and never reaches the human_agent question. This lists ids valid on THIS route.
  if (probe === 'conversations') {
    if (!env.META_PAGE_TOKEN) return err('META_PAGE_TOKEN not set', 503);
    const q = `${META_GRAPH}/me/conversations?platform=instagram`
      + `&fields=participants,updated_time,message_count&limit=10&access_token=${env.META_PAGE_TOKEN}`;
    const r = await fetch(q);
    const d = await r.json().catch(() => ({}));
    return ok({ probe: 'conversations', http_status: r.status, ok: r.ok, meta_response: d });
  }

  if (!thread_id) return err('thread_id required');
  const tRes = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=*&limit=1`, env);
  const thread = tRes.data?.[0];
  if (!thread || !thread.external_user_id) return err('Thread not found or has no recipient', 404);
  if (!env.META_PAGE_TOKEN) return err('META_PAGE_TOKEN not set', 503);

  const payload = {
    recipient: { id: thread.external_user_id },
    message: { text: text || 'Human agent route test — please ignore' },
    messaging_type: 'MESSAGE_TAG',
    tag: 'HUMAN_AGENT',
  };
  const r = await fetch(`${META_GRAPH}/me/messages?access_token=${env.META_PAGE_TOKEN}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const d = await r.json().catch(() => ({}));
  return ok({
    route: 'graph.facebook.com + META_PAGE_TOKEN',
    http_status: r.status,
    ok: r.ok,
    recipient: thread.external_user_id,
    window_shut: !(thread.customer_window_until && new Date(thread.customer_window_until).getTime() > Date.now()),
    meta_response: d,
  });
}

// READ-ONLY probe for the recurring "Meta send failed ... code 200 Permissions error" report
// (Pruthvi 2026-08-26). That code is NOT the past-24h human_agent block (code 10) and NOT an
// expired token (code 190) — both of which metaSendError already names. It arrives on a thread
// whose window is demonstrably OPEN while every other Instagram reply that day sends fine, so
// the cause is per-RECIPIENT, not per-account. Nothing about a failed send is persisted
// (sendMetaMessage writes no row when Meta refuses), so after the fact there is nothing to read
// — hence this probe. Sends NOTHING; two GETs against the same token+host the real send uses.
async function diagIgRecipient(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  const { thread_id } = body || {};
  if (!thread_id) return err('thread_id required');
  const tRes = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=*&limit=1`, env);
  const thread = tRes.data?.[0];
  if (!thread || !thread.external_user_id) return err('Thread not found or has no recipient', 404);
  const token = await metaToken(thread.channel, env);
  if (!token) return err('Meta send not configured (no token for this channel)', 503);
  const base = metaGraphBase(thread.channel);

  const get = async (path) => {
    const r = await fetch(`${base}${path}${path.includes('?') ? '&' : '?'}access_token=${token}`);
    const d = await r.json().catch(() => ({}));
    return { http_status: r.status, ok: r.ok, body: d };
  };
  const [me, recipient] = await Promise.all([
    get('/me?fields=id,username'),
    get(`/${encodeURIComponent(thread.external_user_id)}?fields=id,username,name,is_verified_user,follower_count`),
  ]);

  return ok({
    thread_id,
    channel: thread.channel,
    graph_base: base,
    token_source: thread.channel === 'instagram' ? (env.META_IG_TOKEN ? 'META_IG_TOKEN' : 'META_PAGE_TOKEN(fallback)') : 'META_PAGE_TOKEN',
    provider_account_id: thread.provider_account_id,
    recipient_id: thread.external_user_id,
    window_open: !!(thread.customer_window_until && new Date(thread.customer_window_until).getTime() > Date.now()),
    customer_window_until: thread.customer_window_until,
    me,
    recipient,
  });
}

// Outbound send via Graph API. Inert without META_PAGE_TOKEN. Gated cs_ticket_manage.
async function sendMetaMessage(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { thread_id, text, tag } = body;
  if (!thread_id || !text) return err('thread_id and text required');

  const tRes = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=*&limit=1`, env);
  const thread = tRes.data?.[0];
  if (!thread || !thread.external_user_id) return err('Thread not found or has no recipient', 404);
  const token = await metaToken(thread.channel, env);
  if (!token) return err('Meta send not configured (no token for this channel)', 503);

  const withinWindow = thread.customer_window_until && new Date(thread.customer_window_until).getTime() > Date.now();
  const payload = {
    recipient: { id: thread.external_user_id },
    message: { text },
    messaging_type: withinWindow ? 'RESPONSE' : 'MESSAGE_TAG',
    ...(withinWindow ? {} : { tag: tag || 'HUMAN_AGENT' }),
  };
  const r = await fetch(`${metaGraphBase(thread.channel)}/me/messages?access_token=${token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    // Persist the failure. Until now a refused Meta send wrote NOTHING, so it existed only as
    // a banner the agent saw once — which is exactly why the 2026-08-26 report could not be
    // diagnosed after the fact (no row, no error, nothing to query). WhatsApp already uses
    // status='failed' and the inbox already renders it as a red "failed" marker beside the
    // timestamp, so this reuses a path the UI understands and cannot read as delivered.
    await sb(`/rest/v1/cs_wa_messages`, env, {
      method: 'POST',
      body: JSON.stringify({
        thread_id: thread.id, channel: thread.channel, direction: 'outbound', kind: 'text',
        body: text, status: 'failed',
        status_error: JSON.stringify((d && d.error) || d || {}).slice(0, 1000),
        sent_by_user_id: auth.userId, sent_by_name: auth.fullName || auth.name || auth.email || null,
        sent_at: new Date().toISOString(),
      }),
    }).catch(() => {});   // never let logging turn a refusal into a 500
    return metaSendError(d, r.status);
  }

  const mid = d?.message_id || null;
  await sb(`/rest/v1/cs_wa_messages`, env, {
    method: 'POST',
    body: JSON.stringify({
      thread_id: thread.id, channel: thread.channel, direction: 'outbound', kind: 'text',
      body: text, provider_message_id: mid, status: 'sent',
      sent_by_user_id: auth.userId, sent_by_name: auth.fullName || auth.name || auth.email || null,
      sent_at: new Date().toISOString(),
    }),
  });
  const threadPatch = { last_message_at: new Date().toISOString() };
  if (!thread.assigned_agent_id && !auth.viaIgnitionBridge) {   // auto-claim on first reply (D4, S162); skip for Connect replies
    threadPatch.assigned_agent_id = auth.userId;
    threadPatch.assigned_agent_name = auth.fullName || auth.name || auth.email || null;
    threadPatch.assigned_at = new Date().toISOString();
  }
  await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, { method: 'PATCH', body: JSON.stringify(threadPatch) }).catch(() => {});
  const ticketId = auth.viaIgnitionBridge ? null : await assignLinkedTicketToReplier(thread.id, auth, env);
  return ok({ sent: true, message_id: mid, auto_claimed: !thread.assigned_agent_id && !auth.viaIgnitionBridge, ticket_assigned: ticketId });
}

// ── Outbound media attachments (S162, Feature C) ─────────────────────────────
// Agents send instructional images ("do it like this") to IG/FB customers. Meta's
// send API needs a PUBLIC URL (IG has no multipart path), so we host on the public
// bucket cs-inbox-media (service_role upload) then pass the URL to Graph. Low-volume,
// outbound, agent-initiated, non-sensitive → public-read is fine.
const ATTACH_MIME = {
  'image/png':       { ext: 'png',  kind: 'image',    graph: 'image' },
  'image/jpeg':      { ext: 'jpg',  kind: 'image',    graph: 'image' },
  'image/webp':      { ext: 'webp', kind: 'image',    graph: 'image' },
  'image/gif':       { ext: 'gif',  kind: 'image',    graph: 'image' },
  'application/pdf': { ext: 'pdf',  kind: 'document', graph: 'file'  },
};
// Per-PLATFORM, per-KIND caps. A single flat 8 MB number (what this was until 2026-07-30) is wrong
// in BOTH directions at once: it let a 6 MB image through for Meta to reject with a cryptic error,
// while blocking a 10 MB PDF catalogue that WhatsApp would have accepted (Maria, cutover night).
// The real ceilings — WhatsApp Cloud API: image 5 MB, document 100 MB. Messenger/IG: image 8 MB.
// We do NOT go near 100 MB: the binding constraint is the Worker's 128 MB, not Meta's limit. The
// file arrives base64-in-JSON, so the parsed string alone costs ~2.67x the file (1.33x inflation,
// and JS strings are UTF-16), and the decoded array costs another 1x on top. 20 MB keeps the
// decode peak near ~75 MB with room for the request source string. Going meaningfully past that
// needs the transport to stop being base64-in-JSON, which is a client change, not a constant.
const ATTACH_MAX_BYTES = {
  whatsapp: { image: 5 * 1024 * 1024, document: 20 * 1024 * 1024 },
  meta:     { image: 8 * 1024 * 1024, document: 20 * 1024 * 1024 },
};
const MB = (n) => `${Math.round((n / (1024 * 1024)) * 10) / 10}MB`;

// Decode + size-gate an inbound base64 attachment. ONE home for the rule, because the size check
// is the memory guard and it MUST happen before the decode — the version this replaces decoded
// first and checked second, so an oversized payload was fully materialised in memory and only
// then rejected. The guard could not protect the thing it existed to protect.
// Returns { bytes } or { error } (an err() response).
function decodeAttachment(dataB64, spec, platform) {
  const cap = (ATTACH_MAX_BYTES[platform] || ATTACH_MAX_BYTES.whatsapp)[spec.kind]
    ?? ATTACH_MAX_BYTES.whatsapp.document;
  const raw = dataB64.includes(',') ? dataB64.split(',')[1] : dataB64;
  // Decoded size from the base64 length — O(1), no allocation. 4 base64 chars -> 3 bytes, minus padding.
  const approx = Math.floor((raw.length * 3) / 4) - (raw.endsWith('==') ? 2 : raw.endsWith('=') ? 1 : 0);
  if (approx > cap) {
    return { error: err(`File too large: ${MB(approx)} (max ${MB(cap)} for ${spec.kind === 'image' ? 'images' : 'documents'})`, 413) };
  }
  let bytes;
  try { bytes = b64ToBytes(raw); } catch { return { error: err('Invalid file data') }; }
  if (!bytes.length) return { error: err('Empty file') };
  // Belt-and-braces: `approx` is derived from the encoded length, so a malformed payload could
  // still decode larger than predicted. Cheap to re-assert now that it is a plain integer compare.
  if (bytes.length > cap) return { error: err(`File too large: ${MB(bytes.length)} (max ${MB(cap)})`, 413) };
  return { bytes };
}

// Decodes in CHUNKS. `atob` returns a binary STRING, and JS strings are UTF-16 — so decoding an
// N-byte file in one call transiently holds 2N bytes of string ALONGSIDE the N-byte output, on top
// of the ~2.67N base64 string still referenced by the request body. Slicing keeps that intermediate
// to one chunk and is what makes the raised document cap fit in the Worker's memory budget.
// The slice length is a multiple of 4 so no base64 quantum is split across chunks.
function b64ToBytes(b64) {
  let raw = b64.includes(',') ? b64.split(',')[1] : b64;
  // `atob` tolerates embedded whitespace across a WHOLE string, but slicing does not: a newline
  // inside the payload shifts every following quantum, so a 4-aligned cut would land mid-quantum
  // and throw. Some encoders wrap at 76 chars, so strip first — the test is allocation-free and
  // the copy only happens for payloads that actually contain whitespace.
  if (/\s/.test(raw)) raw = raw.replace(/\s+/g, '');
  const CHUNK = 32768;                       // 32K base64 chars -> 24KB out
  const parts = [];
  let total = 0;
  for (let off = 0; off < raw.length; off += CHUNK) {
    const bin = atob(raw.slice(off, off + CHUNK));
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    parts.push(buf);
    total += buf.length;
  }
  const bytes = new Uint8Array(total);
  let p = 0;
  for (const buf of parts) { bytes.set(buf, p); p += buf.length; }
  return bytes;
}

// ── Email attachments (S201) — real MIME attachment parts on the Gmail send, not a
// URL (unlike the Meta path). Broader allowlist than Meta (agents send invoices,
// labels, spreadsheets). Caps keep the request under Gmail's 25MB and the Worker's
// ~128MB memory budget (base64 inflates + is re-encoded for the raw send).
const EMAIL_ATTACH_MIME = {
  'application/pdf': 'pdf',
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'application/zip': 'zip',
};
const EMAIL_ATTACH_MAX_PER_FILE = 10 * 1024 * 1024;   // 10MB per file
const EMAIL_ATTACH_MAX_TOTAL    = 15 * 1024 * 1024;   // 15MB total (Gmail hard cap 25MB; kept low for Worker memory)
const EMAIL_ATTACH_MAX_COUNT    = 10;                 // subrequest-budget guard (one upload each)

// ── INBOUND email attachments (2026-07-25, Pruthvi #bugs) ────────────────────
// The inbox bubble already renders a chip per raw_meta.attachments entry and links
// it when the entry carries a url; outbound sends host their bytes on the PUBLIC
// cs-inbox-media bucket. Inbound stored filename/mime/size only, so every incoming
// attachment rendered as a dead "preview unavailable" chip and agents had to open
// Gmail. We now pull the bytes and host them — on a PRIVATE bucket, because these
// are files CUSTOMERS sent us (IDs, invoices, addresses), not files we authored.
// Only a storage_path is persisted; a signed URL is minted per click by
// getEmailAttachment (cs_ticket_view-gated, 120s TTL).
const EMAIL_INBOUND_BUCKET        = 'cs-email-attachments';
const EMAIL_INBOUND_MAX_PER_FILE  = 10 * 1024 * 1024;   // matches the bucket's file_size_limit
const EMAIL_INBOUND_MAX_TOTAL     = 20 * 1024 * 1024;   // per message (Worker memory: base64 inflates ~4/3)
const EMAIL_INBOUND_MAX_COUNT     = 10;                 // per message
const EMAIL_INBOUND_MAX_PER_RUN   = 24;                 // per sync tick, across all messages
// Types we let the browser render inline (previewed in a new tab). EVERYTHING else is
// force-downloaded via the signed URL's ?download= param, so a customer-sent .html/.svg
// can never execute in a browsing context. Deliberately NOT an upload allowlist — we
// host whatever arrived under the size cap, since refusing to store it just recreates
// the unopenable-chip bug (an iPhone HEIC, say) while adding no safety: the file is
// already in the mailbox and the agent's fallback is opening Gmail anyway.
// ⚠️ The test this list encodes is "can this EXECUTE in a browsing context?", not "is this an
// image?". A customer-sent .html/.svg must never render inline; inert media is fine and should
// open where the agent is already looking. Video was excluded only because the original list was
// written from the image cases to hand — 126 customer videos (97 mp4 + 29 quicktime, measured
// 2026-08-21) were force-downloading as a side effect, which for a damage-claim clip is exactly
// the wrong friction. `image/jpg` is the non-standard spelling some clients send; it is a JPEG.
// ⚠️ Deliberately NOT added: `image/heic` (10 stored) — inert, but only Safari renders it, so
// inline would give Chrome a blank tab instead of a usable file. Downloading is the better
// outcome there, and it is the case the note above this list already calls out.
// ⚠️ Deliberately NOT added: `application/octet-stream` — it is "unknown", not "safe", and the
// bytes behind it could be anything.
const EMAIL_INLINE_SAFE_MIME = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'application/pdf',
  'video/mp4', 'video/quicktime',
]);

// Supabase Storage with the service key (mirrors podiumops/snorkelops storageFetch).
async function csStorageFetch(path, env, opts = {}) {
  const r = await fetch(`${env.SUPABASE_URL}/storage/v1${path}`, {
    ...opts,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: r.ok, status: r.status, data };
}

// Fetch each Gmail attachment part and store it on the private bucket. Returns the
// raw_meta.attachments array to persist: the original metadata plus either a
// storage_path (fetchable) or a skipped reason (chip stays inert but HONEST about why
// — never silently dropped). Best-effort throughout: a failure on one file must not
// cost us the message itself.
async function storeInboundEmailAttachments(env, { threadId, gmailMessageId, attachments, budget }) {
  const out = [];
  let total = 0;
  for (let i = 0; i < attachments.length; i++) {
    const a = attachments[i];
    const base = { filename: a.filename, mime: a.mime, size: a.size, attachment_id: a.attachment_id };
    // Cheap guards first — each of these saves two subrequests.
    if (i >= EMAIL_INBOUND_MAX_COUNT)                { out.push({ ...base, skipped: 'too_many' }); continue; }
    if (!a.attachment_id)                            { out.push({ ...base, skipped: 'inline_part' }); continue; }
    if (Number(a.size || 0) > EMAIL_INBOUND_MAX_PER_FILE) { out.push({ ...base, skipped: 'too_large' }); continue; }
    if (total + Number(a.size || 0) > EMAIL_INBOUND_MAX_TOTAL) { out.push({ ...base, skipped: 'message_too_large' }); continue; }
    if (budget.left <= 0)                            { out.push({ ...base, skipped: 'run_budget' }); continue; }
    budget.left--;

    try {
      const att = await gmailFetch(env, `/messages/${encodeURIComponent(gmailMessageId)}/attachments/${encodeURIComponent(a.attachment_id)}`);
      if (!att.ok || !att.data?.data) {
        console.error('[email] attachment fetch failed', gmailMessageId, a.filename, att.status);
        out.push({ ...base, skipped: 'fetch_failed' }); continue;
      }
      const bytes = b64urlToBytes(att.data.data);
      if (bytes.length > EMAIL_INBOUND_MAX_PER_FILE) { out.push({ ...base, skipped: 'too_large' }); continue; }
      total += bytes.length;

      // Path is server-generated; nothing client-supplied reaches the bucket.
      const path = `${threadId}/${gmailMessageId}/${crypto.randomUUID()}${extFromFilename(a.filename)}`;
      const up = await csStorageFetch(`/object/${EMAIL_INBOUND_BUCKET}/${path}`, env, {
        method: 'POST',
        headers: { 'Content-Type': a.mime || 'application/octet-stream', 'x-upsert': 'true' },
        body: bytes,
      });
      if (!up.ok) {
        console.error('[email] attachment upload failed', a.filename, up.status, JSON.stringify(up.data)?.slice(0, 160));
        out.push({ ...base, skipped: 'upload_failed' }); continue;
      }
      out.push({ ...base, size: bytes.length, storage_path: path });
    } catch (e) {
      console.error('[email] attachment store error', a.filename, String(e?.message || e));
      out.push({ ...base, skipped: 'error' });
    }
  }
  return out;
}

// Write the stored-attachment array back onto a message row. `attachments_backfilled_at`
// is the drain marker: it means "we have tried every file on this message", so the
// backfill never re-walks a message whose files are genuinely unfetchable.
async function patchStoredAttachments(env, row, stored) {
  const withBytes = stored.filter(a => a.storage_path);
  const primary = withBytes.find(a => (a.mime || '').startsWith('image/')) || withBytes[0] || null;
  const patch = {
    raw_meta: { ...(row.raw_meta || {}), attachments: stored, attachments_backfilled_at: new Date().toISOString() },
    // Mirror the WA/outbound shape so any other reader sees a media message. The email
    // bubble reads raw_meta.attachments and is unaffected by kind; media_url stays NULL
    // because a private object has no durable URL — the path is the durable handle.
    kind: withBytes.length
      ? (withBytes.length === 1 && (primary?.mime || '').startsWith('image/') ? 'image' : 'document')
      : 'text',
    ...(primary ? { media_filename: primary.filename, media_mime_type: primary.mime, media_size_bytes: primary.size } : {}),
  };
  const r = await sb(`/rest/v1/cs_wa_messages?id=eq.${row.id}`, env, { method: 'PATCH', body: JSON.stringify(patch) })
    .catch(e => { console.error('[email] attachment meta patch failed', String(e?.message || e)); return { ok: false }; });
  return { ok: !!r?.ok, stored: withBytes.length, total: stored.length };
}

// Backfill the attachments of emails ingested BEFORE this feature existed (the ingest
// path only stores on insert, so ~468 messages back to 2026-06-26 had metadata but no
// bytes — including the ones in the original bug report). Gmail still holds the
// messages and we persisted each part's attachment_id, so the bytes are recoverable.
// Admin-gated, capped per call, newest-first, drains across repeated calls.
async function backfillEmailAttachments(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  if (!gmailConfigured(env)) return err('Gmail not configured', 503);
  const limit = Math.min(Math.max(Number(body?.limit) || 20, 1), 50);

  // Candidates: inbound email, has at least one attachment, never walked before.
  // The `<> '[]'` half matters: 2,754 of 3,224 rows carry an EMPTY attachments array
  // (a plain email still records the key). Excluding them in the QUERY, not in JS after
  // it, is what makes this drain — filtering post-query left the empty rows unmarked and
  // still matching, so every call would re-fetch the same page and report 0 processed.
  const ATT_FILTER = `channel=eq.email&direction=eq.inbound` +
    `&raw_meta->attachments=not.is.null&raw_meta->>attachments=neq.${encodeURIComponent('[]')}` +
    `&raw_meta->>attachments_backfilled_at=is.null`;
  const cRes = await sb(
    `/rest/v1/cs_wa_messages?${ATT_FILTER}` +
    `&select=id,thread_id,provider_message_id,raw_meta&order=received_at.desc&limit=${limit}`, env);
  if (!cRes.ok) return err(`candidate query failed: ${JSON.stringify(cRes.data)?.slice(0, 160)}`, 502);

  const rows = (cRes.data || []).filter(r => Array.isArray(r.raw_meta?.attachments) && r.raw_meta.attachments.length);
  const budget = { left: EMAIL_INBOUND_MAX_PER_RUN * 4 };   // a backfill call is allowed more than a cron tick
  let messages = 0, files = 0;
  for (const row of rows) {
    if (budget.left <= 0) break;
    if (!row.provider_message_id) {          // no Gmail id → nothing to fetch; mark so it stops surfacing
      await patchStoredAttachments(env, row, row.raw_meta.attachments.map(a => ({ ...a, skipped: 'no_gmail_id' })));
      messages++; continue;
    }
    const stored = await storeInboundEmailAttachments(env, {
      threadId: row.thread_id, gmailMessageId: row.provider_message_id,
      attachments: row.raw_meta.attachments, budget,
    });
    const res = await patchStoredAttachments(env, row, stored);
    messages++; files += res.stored;
  }

  // What's left (same filter) so the caller knows when to stop. Counted by returning the
  // ids and measuring the array — sb() surfaces only {ok,status,data}, so a count=exact
  // Prefer header would be read back as undefined and the row-length fallback would
  // report a constant 1. The set drains, so this stays a small single page.
  const remaining = await sb(`/rest/v1/cs_wa_messages?${ATT_FILTER}&select=id`, env);
  return ok({ messages_processed: messages, files_stored: files,
              remaining: Array.isArray(remaining.data) ? remaining.data.length : null,
              budget_left: budget.left, done: messages === 0 });
}

// NB attachment bodies are base64URL — decoded with the existing b64urlToBytes helper
// (declared with the other base64url utils below; atob's forgiving decode handles
// Gmail's unpadded output).
// Keep the original extension on the stored object (helps when a signed URL is opened
// directly). Whitelist-shaped so a filename can never inject path or query characters.
function extFromFilename(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
  return m ? `.${m[1].toLowerCase()}` : '';
}

// bytes -> standard base64 (NOT base64url), CRLF-wrapped at 76 cols per RFC 2045.
function bytesToB64Wrapped(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/(.{76})/g, '$1\r\n');
}
// A Content-Disposition-safe filename: strip CR/LF/quotes/backslash; RFC 2047
// encoded-word for any non-ASCII so mail clients render it correctly.
function mimeFilename(name) {
  const clean = String(name || 'attachment').replace(/[\r\n"\\]/g, '_').slice(0, 200);
  if (/^[\x20-\x7E]+$/.test(clean)) return clean;
  const bytes = new TextEncoder().encode(clean);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `=?UTF-8?B?${btoa(bin)}?=`;
}

async function sendMetaAttachment(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { thread_id, mime_type, data_base64, filename, caption } = body;
  if (!thread_id || !mime_type || !data_base64) return err('thread_id, mime_type and data_base64 required');
  const spec = ATTACH_MIME[mime_type];
  if (!spec) return err(`Unsupported file type: ${mime_type} (images + PDF only)`, 415);

  const dec = decodeAttachment(data_base64, spec, 'meta');
  if (dec.error) return dec.error;
  const bytes = dec.bytes;
  body.data_base64 = null;                   // see sendWaAttachment — free the base64 before the upload

  const tRes = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=*&limit=1`, env);
  const thread = tRes.data?.[0];
  if (!thread || !thread.external_user_id) return err('Thread not found or has no recipient', 404);
  const token = await metaToken(thread.channel, env);
  if (!token) return err('Meta send not configured (no token for this channel)', 503);

  // 1. Upload to the public bucket (service_role, bypasses RLS).
  const path = `${thread.id}/${crypto.randomUUID()}.${spec.ext}`;
  const up = await fetch(`${env.SUPABASE_URL}/storage/v1/object/cs-inbox-media/${path}`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': mime_type, 'x-upsert': 'true' },
    body: bytes,
  });
  if (!up.ok) { const t = await up.text().catch(() => ''); return err(`Upload failed: ${t.slice(0, 200)}`, up.status || 500); }
  const publicUrl = `${env.SUPABASE_URL}/storage/v1/object/public/cs-inbox-media/${path}`;

  // 2. Send via Graph (URL attachment — the IG+FB common path).
  const withinWindow = thread.customer_window_until && new Date(thread.customer_window_until).getTime() > Date.now();
  const tagFields = withinWindow ? { messaging_type: 'RESPONSE' } : { messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' };
  const r = await fetch(`${metaGraphBase(thread.channel)}/me/messages?access_token=${token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: thread.external_user_id },
      message: { attachment: { type: spec.graph, payload: { url: publicUrl, is_reusable: true } } },
      ...tagFields,
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return metaSendError(d, r.status);
  const mid = d?.message_id || null;

  const senderName = auth.fullName || auth.name || auth.email || null;
  await sb(`/rest/v1/cs_wa_messages`, env, {
    method: 'POST',
    body: JSON.stringify({
      thread_id: thread.id, channel: thread.channel, direction: 'outbound', kind: spec.kind,
      body: null, media_url: publicUrl, media_filename: filename || `attachment.${spec.ext}`,
      media_mime_type: mime_type, media_size_bytes: bytes.length,
      provider_message_id: mid, status: 'sent', sent_by_user_id: auth.userId, sent_by_name: senderName,
      sent_at: new Date().toISOString(),
    }),
  });

  // 3. Optional caption — delivered as a separate text message (Graph attachments
  // carry no caption field), best-effort + recorded as its own row.
  if (caption && caption.trim()) {
    const cr = await fetch(`${metaGraphBase(thread.channel)}/me/messages?access_token=${token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: thread.external_user_id }, message: { text: caption.trim() }, ...tagFields }),
    });
    const cd = await cr.json().catch(() => ({}));
    if (cr.ok) {
      await sb(`/rest/v1/cs_wa_messages`, env, {
        method: 'POST',
        body: JSON.stringify({
          thread_id: thread.id, channel: thread.channel, direction: 'outbound', kind: 'text',
          body: caption.trim(), provider_message_id: cd?.message_id || null, status: 'sent',
          sent_by_user_id: auth.userId, sent_by_name: senderName, sent_at: new Date().toISOString(),
        }),
      });
    }
  }

  const threadPatch = { last_message_at: new Date().toISOString() };
  if (!thread.assigned_agent_id) {
    threadPatch.assigned_agent_id = auth.userId;
    threadPatch.assigned_agent_name = senderName;
    threadPatch.assigned_at = new Date().toISOString();
  }
  await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, { method: 'PATCH', body: JSON.stringify(threadPatch) }).catch(() => {});
  return ok({ sent: true, message_id: mid, media_url: publicUrl });
}

// ═════════════════════════════════════════════════════════════════════════════
// EMAIL CHANNEL (carecrew@) — inbound + reply via the Gmail API (S175)
// ─────────────────────────────────────────────────────────────────────────────
// Email is just another channel on cs_wa_threads/cs_wa_messages (channel='email'),
// so it inherits the inbox/routing/presence/tags/priority machinery for free.
//   • thread key  = Gmail threadId        → provider_thread_ref (partial-unique)
//   • message key = Gmail message id       → provider_message_id (global-unique → idempotency)
//   • sender email = external_user_id ; sender name = customer_handle
//   • text body = body ; html = body_html ; RFC headers + addrs = raw_meta
// Identity is resolved through the LIVE Relay substrate (commsops POST /ingest →
// comms.resolve_identity) and the returned profile_id is stored on the thread.
// Replies go out Gmail-native (real carecrew@, perfect threading) and are mirrored
// to Relay as an `email_replied` event. See spec 2026-06-25-pitstop-inbound-email-design.md.
// ═════════════════════════════════════════════════════════════════════════════

function commsopsUrl(env) { return env.COMMSOPS_URL || 'https://commsops.afshaan.workers.dev'; }

// Call another LOT worker. MUST go over a service binding: a Worker cannot fetch() another
// Worker on the same workers.dev zone — Cloudflare returns error 1042 and the request 404s.
// The binding delivers straight to the target's fetch handler (the URL host is ignored, only
// the path matters), so the token gates on the far side still apply. Falls back to public HTTP
// when the binding is absent (local/dev), which is also exactly the path that 1042s in prod —
// so a missing binding fails loudly rather than silently taking a broken route.
async function callWorker(binding, env, path, init) {
  if (binding && typeof binding.fetch === 'function') {
    return binding.fetch(new Request(`https://internal${path}`, init));
  }
  return fetch(`${commsopsUrl(env)}${path}`, init);
}

function gmailMailbox(env) { return env.GMAIL_MAILBOX || 'carecrew@legendoftoys.com'; }
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
const MAX_NEW_EMAILS_PER_RUN = 6;             // paced per tick (Gmail API politeness); backlog drains across cron ticks

// base64url <-> bytes/strings ------------------------------------------------
function b64urlToBytes(data) {
  const b64 = String(data || '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function b64urlDecodeUtf8(data) {
  try { return new TextDecoder('utf-8').decode(b64urlToBytes(data)); } catch { return ''; }
}
function b64urlEncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlEncodeJson(obj) { return b64urlEncodeUtf8(JSON.stringify(obj)); }

// ── Gmail OAuth — service-account JWT (RS256), domain-wide-delegated to carecrew@.
// Reuses the shared GOOGLE_SA_JSON secret (the full SA key JSON, same convention as
// odoops/podiumops). That SA already has gmail.modify domain-wide-delegated.
let _gmailTok = { token: null, exp: 0 };
function gmailConfigured(env) { return !!env.GOOGLE_SA_JSON; }
async function gmailAccessToken(env) {
  if (_gmailTok.token && Date.now() < _gmailTok.exp - 60_000) return _gmailTok.token;
  if (!env.GOOGLE_SA_JSON) throw new Error('gmail_not_configured');
  const sa = JSON.parse(env.GOOGLE_SA_JSON);
  const clientEmail = sa.client_email;
  const pk = sa.private_key;                                  // PEM, already with real newlines
  if (!clientEmail || !pk) throw new Error('gmail_not_configured');

  const iat = Math.floor(Date.now() / 1000);
  const claim = {
    iss: clientEmail,
    sub: gmailMailbox(env),                                   // impersonate the mailbox
    scope: 'https://www.googleapis.com/auth/gmail.modify',
    aud: 'https://oauth2.googleapis.com/token',
    iat, exp: iat + 3600,
  };
  const signingInput = `${b64urlEncodeJson({ alg: 'RS256', typ: 'JWT' })}.${b64urlEncodeJson(claim)}`;

  const der = pk.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s/g, '');
  const keyBytes = Uint8Array.from(atob(der), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'pkcs8', keyBytes.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  let sigBin = '';
  const sigBytes = new Uint8Array(sigBuf);
  for (let i = 0; i < sigBytes.length; i++) sigBin += String.fromCharCode(sigBytes[i]);
  const assertion = `${signingInput}.${btoa(sigBin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(assertion)}`,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(`gmail_token_failed: ${JSON.stringify(d).slice(0, 200)}`);
  _gmailTok = { token: d.access_token, exp: Date.now() + (Number(d.expires_in || 3600) * 1000) };
  return _gmailTok.token;
}

async function gmailFetch(env, path, opts = {}) {
  const token = await gmailAccessToken(env);
  const mb = encodeURIComponent(gmailMailbox(env));
  const r = await fetch(`${GMAIL_API}/users/${mb}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: r.ok, status: r.status, data };
}

// ── MIME parse — walk a Gmail message payload into our fields -----------------
function hdr(headers, name) {
  const h = (headers || []).find(x => (x.name || '').toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}
function parseAddress(raw) {
  if (!raw) return { name: null, email: null };
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: (m[1] || '').trim() || null, email: m[2].trim().toLowerCase() };
  return { name: null, email: raw.trim().toLowerCase() };
}
function collectBodies(payload, acc) {
  if (!payload) return acc;
  const mime = (payload.mimeType || '').toLowerCase();
  if (payload.body?.data) {
    if (mime === 'text/plain' && acc.text == null) acc.text = b64urlDecodeUtf8(payload.body.data);
    else if (mime === 'text/html' && acc.html == null) acc.html = b64urlDecodeUtf8(payload.body.data);
  }
  if (payload.filename && payload.body?.attachmentId) {
    acc.attachments.push({ filename: payload.filename, mime: payload.mimeType, size: payload.body.size, attachment_id: payload.body.attachmentId });
  }
  for (const part of (payload.parts || [])) collectBodies(part, acc);
  return acc;
}
function parseGmailMessage(msg) {
  const headers = msg.payload?.headers || [];
  const from = parseAddress(hdr(headers, 'From'));
  const bodies = collectBodies(msg.payload, { text: null, html: null, attachments: [] });
  return {
    gmail_message_id: msg.id,
    gmail_thread_id: msg.threadId,
    rfc_message_id: hdr(headers, 'Message-ID') || hdr(headers, 'Message-Id'),
    in_reply_to: hdr(headers, 'In-Reply-To'),
    references: hdr(headers, 'References'),
    subject: hdr(headers, 'Subject') || '(no subject)',
    from_name: from.name,
    from_email: from.email,
    to: hdr(headers, 'To'),
    date: hdr(headers, 'Date'),
    snippet: msg.snippet || null,
    text: bodies.text,
    html: bodies.html,
    attachments: bodies.attachments,
    internal_date: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : new Date().toISOString(),
    label_ids: msg.labelIds || [],
  };
}

// ── Relay seams (commsops) — identity/events + suppression read ---------------
async function relayIngest(env, payload) {
  if (!env.INGEST_TOKEN) return { ok: false, skipped: 'no_ingest_token' };
  try {
    const r = await callWorker(env.COMMSOPS, env, '/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.INGEST_TOKEN}` },
      body: JSON.stringify(payload),
    });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok, data: d?.data || d };
  } catch (e) { console.error('[email] relayIngest error', e); return { ok: false }; }
}
// Hard-suppression check for an email (comms schema, direct service_role read).
// Returns { suppressed:boolean, reason } — fails OPEN (allows the support reply)
// on any infra error, since a CS reply is transactional. Only blocks on a real
// hard suppression row (bounce/complaint) for the email channel.
async function emailSuppressed(env, emailAddr) {
  if (!emailAddr) return { suppressed: false };
  try {
    const r = await fetch(
      `${env.SUPABASE_URL}/rest/v1/suppressions?channel=eq.email&value=eq.${encodeURIComponent(emailAddr.toLowerCase())}&select=reason&limit=1`,
      { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Accept-Profile': 'comms' } });
    if (!r.ok) return { suppressed: false };
    const d = await r.json().catch(() => []);
    if (Array.isArray(d) && d[0]) return { suppressed: true, reason: d[0].reason || 'suppressed' };
    return { suppressed: false };
  } catch { return { suppressed: false }; }
}

// ── Inbound sync — poll the carecrew@ mailbox, ingest new messages ------------
// Stateless + idempotent: list recent INBOX messages, skip any whose Gmail id is
// already stored (one batched check), fetch+parse+store only the new ones (capped
// per run; cron drains the backlog). Callable via cron (scheduled) or syncGmailNow.
async function syncGmail(env, { lookbackDays = 2 } = {}) {
  const list = await gmailFetch(env, `/messages?q=${encodeURIComponent(`in:inbox newer_than:${lookbackDays}d`)}&maxResults=25`);
  if (!list.ok) return { ok: false, error: `list_failed_${list.status}`, detail: list.data };
  const ids = (list.data?.messages || []).map(m => m.id);
  if (!ids.length) return { ok: true, fetched: 0, new: 0 };

  // Which Gmail ids are already stored? (provider_message_id = Gmail message id)
  const existRes = await sb(
    `/rest/v1/cs_wa_messages?channel=eq.email&provider_message_id=in.(${ids.map(encodeURIComponent).join(',')})&select=provider_message_id`, env);
  const have = new Set((existRes.data || []).map(x => x.provider_message_id));
  const fresh = ids.filter(id => !have.has(id)).slice(0, MAX_NEW_EMAILS_PER_RUN);
  if (!fresh.length) return { ok: true, fetched: ids.length, new: 0 };

  let created = 0;
  // Shared attachment budget for the whole tick (2 subrequests per file). The real
  // ceiling is 10,000/invocation so this is nowhere near it — it's a guard against one
  // pathological batch of attachment-heavy mail, not a plan-limit workaround.
  const budget = { left: EMAIL_INBOUND_MAX_PER_RUN };
  for (const id of fresh) {
    try {
      const gm = await gmailFetch(env, `/messages/${encodeURIComponent(id)}?format=full`);
      if (!gm.ok) { console.error('[email] get failed', id, gm.status); continue; }
      const parsed = parseGmailMessage(gm.data);
      const ok2 = await ingestInboundEmail(env, parsed, budget);
      if (ok2) created++;
    } catch (e) { console.error('[email] sync msg error', id, e); }
  }
  return { ok: true, fetched: ids.length, new: created, attachments_left: budget.left };
}

// Persist one inbound email: resolve profile via Relay, upsert thread, insert
// message, auto-reopen + round-robin assign. Mirrors metaHandleMessage.
async function ingestInboundEmail(env, p, budget = { left: EMAIL_INBOUND_MAX_PER_RUN }) {
  if (!p.from_email) return false;

  // 1. Identity via the Relay substrate (best-effort).
  let profileId = null;
  const ing = await relayIngest(env, {
    identifiers: [{ type: 'email', value: p.from_email }],
    name: 'email_received',
    occurred_at: p.internal_date,
    properties: { subject: p.subject, gmail_thread_id: p.gmail_thread_id, snippet: p.snippet },
    source: 'pitstop_email',
    idempotency_key: `gmail:${p.gmail_message_id}`,
  });
  if (ing.ok && ing.data?.profile_id) profileId = ing.data.profile_id;

  // 2. Find the thread. Primary key = Gmail threadId — true reply chains group here.
  const found = await sb(
    `/rest/v1/cs_wa_threads?channel=eq.email&provider_thread_ref=eq.${encodeURIComponent(p.gmail_thread_id)}&select=*&limit=1`, env);
  let thread = found.data?.[0];

  // Customer-window grouping (Pruthvi S185): a customer often sends a NEW email (not a
  // reply) about the same issue → a different Gmail threadId. Fold it into the customer's
  // existing ACTIVE email conversation if that had activity within the last 7 days, so
  // agents see one thread instead of many. Replies still target the customer's latest
  // inbound Gmail thread (see sendEmailReply), so outbound still lands correctly. Outside
  // the 7-day window, or no active thread → a fresh conversation.
  if (!thread && p.from_email) {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recent = await sb(
      `/rest/v1/cs_wa_threads?channel=eq.email&ignition_connect=is.false&external_user_id=eq.${encodeURIComponent(p.from_email)}&thread_state=in.(open,snoozed)&last_message_at=gte.${encodeURIComponent(since)}&order=last_message_at.desc&select=*&limit=1`, env);
    thread = recent.data?.[0] || null;
  }

  if (!thread) {
    const ins = await sb(`/rest/v1/cs_wa_threads`, env, {
      method: 'POST',
      body: JSON.stringify({
        channel: 'email', provider_thread_ref: p.gmail_thread_id,
        external_user_id: p.from_email, customer_handle: p.from_name || p.from_email,
        subject: p.subject, comms_profile_id: profileId,
      }),
    });
    if (!ins.ok) { console.error('[email] thread insert failed', ins.status, JSON.stringify(ins.data)?.slice(0, 200)); return false; }
    thread = ins.data?.[0];
  }
  if (!thread) return false;

  // 3. Insert the inbound message (idempotent via provider_message_id unique).
  const ins = await sb(`/rest/v1/cs_wa_messages`, env, {
    method: 'POST', prefer: 'resolution=ignore-duplicates,return=representation',
    body: JSON.stringify({
      thread_id: thread.id, channel: 'email', direction: 'inbound', kind: 'text',
      body: p.text || (p.html ? null : p.snippet), body_html: p.html,
      provider_message_id: p.gmail_message_id, received_at: p.internal_date,
      raw_meta: {
        gmail_message_id: p.gmail_message_id, gmail_thread_id: p.gmail_thread_id,
        rfc_message_id: p.rfc_message_id, in_reply_to: p.in_reply_to, references: p.references,
        from_name: p.from_name, from_email: p.from_email, to: p.to, subject: p.subject,
        date: p.date, attachments: p.attachments,
      },
    }),
  });
  if (!ins.ok) { console.error('[email] message insert failed', ins.status, JSON.stringify(ins.data)?.slice(0, 200)); return false; }

  // 3b. Pull the attachment bytes onto the private bucket and stamp the storage paths
  // back onto raw_meta (2026-07-25). Deliberately AFTER the insert and gated on the
  // insert having actually created a row: with resolution=ignore-duplicates a re-poll
  // of the same Gmail id returns [], so a message we already have costs zero Gmail
  // fetches and zero uploads here. Best-effort — the message is already safely stored,
  // so a storage failure only leaves the chips inert (with a reason), never loses mail.
  const inserted = ins.data?.[0] || null;
  if (inserted?.id && p.attachments?.length && budget.left > 0) {
    const stored = await storeInboundEmailAttachments(env, {
      threadId: thread.id, gmailMessageId: p.gmail_message_id, attachments: p.attachments, budget,
    });
    await patchStoredAttachments(env, inserted, stored);
  }

  // 4. Thread housekeeping: bump activity, backfill profile/subject, auto-reopen.
  const patch = { last_message_at: p.internal_date, last_inbound_at: p.internal_date };   // last_inbound_at = unread watermark
  if (!thread.comms_profile_id && profileId) patch.comms_profile_id = profileId;
  if (!thread.subject && p.subject) patch.subject = p.subject;
  if (thread.thread_state && thread.thread_state !== 'open') clearClosedFields(patch);
  await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, { method: 'PATCH', body: JSON.stringify(patch) }).catch(() => {});

  // 5. Round-robin assign an unassigned thread (config-gated per channel in the RPC).
  //    Skip Ignition-transferred threads (S177) — owned by the Influencer team now.
  if (!thread.assigned_agent_id && !thread.ignition_connect) {
    await sb(`/rest/v1/rpc/cs_autoassign_thread`, env, { method: 'POST', body: JSON.stringify({ p_thread_id: thread.id }) }).catch(() => {});
  }
  return true;
}

// Manual sync trigger (admin) — runs the same poll on demand. Useful before the
// cron is armed and for a parallel-run check.
async function syncGmailNow(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  try {
    const res = await syncGmail(env, { lookbackDays: Number(body?.lookbackDays) || 2 });
    return res.ok ? ok(res) : err(`Gmail sync failed: ${res.error || ''}`, 502);
  } catch (e) { return err(`Gmail sync error: ${String(e.message || e)}`, 502); }
}

// ── Inbound attachment download — mint a short-lived signed URL ---------------
// The bucket is private, so this is the ONLY way an agent reaches a customer-sent
// file. Two deliberate choices:
//  · The client sends message_id + idx, never a path. The path is read out of the
//    stored row, so no caller can walk the bucket or reach another bucket by
//    crafting input (the getProfiles/M9 oracle class of bug).
//  · Anything not in EMAIL_INLINE_SAFE_MIME gets ?download=, which makes Storage
//    send Content-Disposition: attachment — a customer-sent .html/.svg downloads
//    instead of executing in a browsing context.
async function getEmailAttachment(params, auth, env) {
  const g = require('cs_ticket_view', auth); if (g) return g;
  const message_id = params.get('message_id');
  const idx = Number(params.get('idx'));
  if (!message_id) return err('message_id required');
  if (!Number.isInteger(idx) || idx < 0) return err('idx must be a non-negative integer');

  const mRes = await sb(
    `/rest/v1/cs_wa_messages?id=eq.${encodeURIComponent(message_id)}&select=id,channel,raw_meta&limit=1`, env);
  const msg = mRes.data?.[0];
  if (!msg) return err('Message not found', 404);
  if (msg.channel !== 'email') return err('Not an email message', 400);

  const att = Array.isArray(msg.raw_meta?.attachments) ? msg.raw_meta.attachments[idx] : null;
  if (!att) return err('Attachment not found', 404);
  // Outbound sends already hosted their copy publicly — hand that back unchanged.
  if (att.url) return ok({ url: att.url, filename: att.filename || null, mime_type: att.mime || null, inline: true });
  if (!att.storage_path) return err(`Attachment unavailable${att.skipped ? ` (${att.skipped})` : ''}`, 409);

  const seg = String(att.storage_path).split('/').map(encodeURIComponent).join('/');
  const sr = await csStorageFetch(`/object/sign/${EMAIL_INBOUND_BUCKET}/${seg}`, env, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 120 }),
  });
  if (!sr.ok || !sr.data?.signedURL) return err(`sign_failed: ${JSON.stringify(sr.data)?.slice(0, 160)}`, 502);

  const inline = EMAIL_INLINE_SAFE_MIME.has(String(att.mime || '').toLowerCase());
  let url = `${env.SUPABASE_URL}/storage/v1${sr.data.signedURL}`;
  if (!inline) url += `${url.includes('?') ? '&' : '?'}download=${encodeURIComponent(att.filename || 'attachment')}`;
  return ok({ url, filename: att.filename || null, mime_type: att.mime || null, inline });
}

// ── Reply — Gmail-native send, in-thread, mirrored to Relay -------------------
async function sendEmailReply(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { thread_id, text, html, cc, bcc, subject: subjectOverride } = body;

  // Attachments (S201) — optional array of { mime_type, data_base64, filename }.
  // Validate + decode up front so a bad file fails before we send anything.
  const attIn = Array.isArray(body.attachments) ? body.attachments : [];
  if (attIn.length > EMAIL_ATTACH_MAX_COUNT) return err(`Too many attachments (max ${EMAIL_ATTACH_MAX_COUNT})`, 413);
  const atts = [];
  let attTotal = 0;
  for (const a of attIn) {
    const mt = a?.mime_type;
    const ext = EMAIL_ATTACH_MIME[mt];
    if (!ext) return err(`Unsupported attachment type: ${mt || '(none)'}`, 415);
    let bytes;
    try { bytes = b64ToBytes(a.data_base64); } catch { return err('Invalid attachment data'); }
    if (!bytes.length) return err(`Empty attachment: ${a.filename || mt}`);
    if (bytes.length > EMAIL_ATTACH_MAX_PER_FILE) return err(`Attachment too large: ${a.filename || mt} (max 10MB per file)`, 413);
    attTotal += bytes.length;
    if (attTotal > EMAIL_ATTACH_MAX_TOTAL) return err('Attachments too large (max 15MB total)', 413);
    atts.push({ bytes, mime: mt, ext, filename: a.filename || `attachment.${ext}` });
  }

  if (!thread_id || (!text && !html && !atts.length)) return err('thread_id and text, html, or an attachment required');

  const tRes = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=*&limit=1`, env);
  const thread = tRes.data?.[0];
  if (!thread || thread.channel !== 'email') return err('Email thread not found', 404);
  if (!thread.external_user_id) return err('Thread has no recipient address', 422);

  // Recipients: To defaults to the thread's customer; the agent may override To and
  // add Cc/Bcc (Pruthvi #bugs S181). parseAddrList accepts an array OR a
  // comma/semicolon-separated string, validates "x@y", dedups (case-insensitive).
  const toList  = parseAddrList(body.to, [thread.external_user_id]);
  const ccList  = parseAddrList(cc);
  const bccList = parseAddrList(bcc);
  if (!toList.length) return err('At least one valid To recipient is required', 422);
  for (const addr of [...body.to != null ? toList : [], ...ccList, ...bccList]) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) return err(`Invalid email address: ${addr}`, 422);
  }

  // Hard-suppression guard (bounce/complaint) — surface to the agent, don't send.
  // Check every To recipient (override may point somewhere new); Cc/Bcc are not
  // gated (an agent CC'ing a colleague/vendor shouldn't be blocked by a customer
  // suppression).
  for (const addr of toList) {
    const sup = await emailSuppressed(env, addr);
    if (sup.suppressed) return err(`Recipient ${addr} is suppressed (${sup.reason}) — do not email. Reach out another way.`, 409);
  }

  // Threading headers from the latest inbound message on this thread.
  const lastIn = await sb(
    `/rest/v1/cs_wa_messages?thread_id=eq.${encodeURIComponent(thread.id)}&direction=eq.inbound&select=raw_meta,provider_message_id&order=created_at.desc&limit=1`, env);
  const lastMeta = lastIn.data?.[0]?.raw_meta || {};
  const inReplyTo = lastMeta.rfc_message_id || null;
  const references = [lastMeta.references, lastMeta.rfc_message_id].filter(Boolean).join(' ') || null;

  // Subject: an explicit override is used verbatim (agent's intent); otherwise the
  // thread/last-inbound subject, prefixed Re: if not already.
  let subject;
  if (subjectOverride != null && String(subjectOverride).trim()) {
    subject = String(subjectOverride).trim();
  } else {
    const subjectRaw = thread.subject || lastMeta.subject || '(no subject)';
    subject = /^re:/i.test(subjectRaw) ? subjectRaw : `Re: ${subjectRaw}`;
  }
  const senderName = auth.fullName || auth.name || auth.email || 'LOT Care';
  const textBody = text || stripHtml(html);
  const htmlBody = html || `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;

  // Build the RFC822 message. Gmail honours a Bcc header on a raw send (delivers to
  // those recipients, strips the header from the stored msg). The body is always a
  // multipart/alternative (text + html); with attachments it's nested inside a
  // multipart/mixed alongside one attachment part per file (S201).
  const altB = `alt_${crypto.randomUUID().replace(/-/g, '')}`;
  const headerLines = [
    `To: ${toList.join(', ')}`,
  ];
  if (ccList.length)  headerLines.push(`Cc: ${ccList.join(', ')}`);
  if (bccList.length) headerLines.push(`Bcc: ${bccList.join(', ')}`);
  headerLines.push(
    `From: LOT Care <${gmailMailbox(env)}>`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
  );
  if (inReplyTo)  headerLines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headerLines.push(`References: ${references}`);

  const altBody =
    `--${altB}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${textBody}\r\n\r\n` +
    `--${altB}\r\nContent-Type: text/html; charset="UTF-8"\r\n\r\n${htmlBody}\r\n\r\n` +
    `--${altB}--`;

  let raw;
  if (atts.length) {
    const mixB = `mix_${crypto.randomUUID().replace(/-/g, '')}`;
    headerLines.push(`Content-Type: multipart/mixed; boundary="${mixB}"`);
    const attParts = atts.map(a =>
      `--${mixB}\r\n` +
      `Content-Type: ${a.mime}; name="${mimeFilename(a.filename)}"\r\n` +
      `Content-Disposition: attachment; filename="${mimeFilename(a.filename)}"\r\n` +
      `Content-Transfer-Encoding: base64\r\n\r\n` +
      `${bytesToB64Wrapped(a.bytes)}\r\n`
    ).join('');
    raw =
      headerLines.join('\r\n') + '\r\n\r\n' +
      `--${mixB}\r\nContent-Type: multipart/alternative; boundary="${altB}"\r\n\r\n` +
      altBody + '\r\n' +
      attParts +
      `--${mixB}--`;
  } else {
    headerLines.push(`Content-Type: multipart/alternative; boundary="${altB}"`);
    raw = headerLines.join('\r\n') + '\r\n\r\n' + altBody;
  }

  // Send into the customer's LATEST inbound Gmail thread (not necessarily the thread's
  // original ref) so a reply lands in their most recent email — required now that a
  // conversation may group multiple Gmail threads via customer-window grouping (S185).
  // The In-Reply-To/References above (from the same latest inbound) keep RFC threading aligned.
  const send = await gmailFetch(env, `/messages/send`, {
    method: 'POST', body: JSON.stringify({ raw: b64urlEncodeUtf8(raw), threadId: lastMeta.gmail_thread_id || thread.provider_thread_ref }),
  });
  if (!send.ok) return err(`Gmail send failed: ${JSON.stringify(send.data)?.slice(0, 200)}`, send.status || 502);
  const sentId = send.data?.id || null;

  // The customer already has the real attachments (inline in the sent email). Host a
  // copy of each on the public bucket so the sent bubble can show/download them too
  // (best-effort — a failed upload just leaves that attachment with a null url).
  const attMeta = [];
  for (const a of atts) {
    let url = null;
    try {
      const path = `${thread.id}/${crypto.randomUUID()}.${a.ext}`;
      const up = await fetch(`${env.SUPABASE_URL}/storage/v1/object/cs-inbox-media/${path}`, {
        method: 'POST',
        headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': a.mime, 'x-upsert': 'true' },
        body: a.bytes,
      });
      if (up.ok) url = `${env.SUPABASE_URL}/storage/v1/object/public/cs-inbox-media/${path}`;
      else console.error('[email] attachment upload failed', up.status);
    } catch (e) { console.error('[email] attachment upload error', String(e?.message || e)); }
    attMeta.push({ filename: a.filename, mime: a.mime, size: a.bytes.length, url });
  }
  const primary = attMeta.find(m => m.mime.startsWith('image/') && m.url) || attMeta.find(m => m.url) || attMeta[0];
  const kind = atts.length ? (atts.length === 1 && atts[0].mime.startsWith('image/') ? 'image' : 'document') : 'text';

  // Record the outbound message (idempotent on the Gmail message id).
  await sb(`/rest/v1/cs_wa_messages`, env, {
    method: 'POST',
    body: JSON.stringify({
      thread_id: thread.id, channel: 'email', direction: 'outbound', kind,
      body: textBody, body_html: htmlBody, provider_message_id: sentId, status: 'sent',
      sent_by_user_id: auth.userId, sent_by_name: senderName, sent_at: new Date().toISOString(),
      ...(attMeta.length ? {
        media_url: primary?.url || null, media_filename: primary?.filename || null,
        media_mime_type: primary?.mime || null, media_size_bytes: primary?.size || null,
      } : {}),
      raw_meta: {
        gmail_message_id: sentId, in_reply_to: inReplyTo, subject,
        to: toList, ...(ccList.length ? { cc: ccList } : {}), ...(bccList.length ? { bcc: bccList } : {}),
        ...(attMeta.length ? { attachments: attMeta } : {}),
      },
    }),
  });

  // Thread housekeeping: bump activity + auto-claim on first reply.
  const threadPatch = { last_message_at: new Date().toISOString() };
  if (!thread.assigned_agent_id && !auth.viaIgnitionBridge) {   // skip auto-claim for Connect replies (S177)
    threadPatch.assigned_agent_id = auth.userId;
    threadPatch.assigned_agent_name = senderName;
    threadPatch.assigned_at = new Date().toISOString();
  }
  await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, { method: 'PATCH', body: JSON.stringify(threadPatch) }).catch(() => {});

  // Mirror the interaction to the Relay substrate (best-effort).
  await relayIngest(env, {
    identifiers: [{ type: 'email', value: thread.external_user_id }],
    name: 'email_replied', occurred_at: new Date().toISOString(),
    properties: { thread_id: thread.id, channel: 'email', subject },
    source: 'pitstop_email', idempotency_key: sentId ? `gmail_out:${sentId}` : undefined,
  });

  const ticketId = auth.viaIgnitionBridge ? null : await assignLinkedTicketToReplier(thread.id, auth, env);
  return ok({ sent: true, message_id: sentId, attachments: attMeta.length, auto_claimed: !thread.assigned_agent_id && !auth.viaIgnitionBridge, ticket_assigned: ticketId });
}

// Normalize an address input (array OR comma/semicolon-separated string) → a
// deduped (case-insensitive) trimmed list. `fallback` is used when the input is
// empty/absent. Validation of the "x@y" shape is done by the caller.
function parseAddrList(input, fallback = []) {
  if (input == null || input === '') return [...fallback];
  const arr = Array.isArray(input) ? input : String(input).split(/[,;]/);
  const out = [], seen = new Set();
  for (const raw of arr) {
    const a = String(raw || '').trim();
    if (!a) continue;
    const k = a.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); out.push(a);
  }
  return out.length ? out : [...fallback];
}

function stripHtml(h) { return String(h || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function escapeHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ── Agent Inbox — cross-channel thread list + reader + ticket link ───────────
// Surfaces every cs_wa_threads conversation (whatsapp/instagram/messenger/email)
// for the Pitstop /inbox. Read-gated by handleGet's cs_ticket_view; replies go
// through sendMetaMessage (IG/FB) / sendEmailReply (email), gated cs_ticket_manage.
// WhatsApp stays read-only (BiteSpeed deep-link) until C2-B.
async function getMessagingThreads(params, auth, env) {
  const channel = params.get('channel');
  const tab = params.get('tab');              // mine | unassigned | all (assignment axis, S162)
  const limit = Math.min(Number(params.get('limit')) || 60, 1000);   // cap raised 300→1000 for list "Load more" (S202)
  // Sort axis (S164, Pruthvi): recent activity (default) | oldest-first | priority high→low.
  const sort = params.get('sort') || 'recent';
  const ORDERS = {
    recent:   'last_message_at.desc.nullslast',
    oldest:   'last_message_at.asc.nullsfirst',
    priority: 'priority_rank.asc,last_message_at.desc.nullslast',
  };
  const orderClause = ORDERS[sort] || ORDERS.recent;
  let q = `/rest/v1/cs_wa_threads?select=*&order=${orderClause}&limit=${limit}`;
  // Hide guaranteed-empty threads (S229, Pruthvi): a thread that never had a message
  // (last_message_at null) AND has no provider ref (nothing to live-pull from BiteSpeed)
  // renders permanently empty — pure clutter. Mostly legacy stubs minted by the old
  // create-on-read getWaThread path. Threads with a ref but no local mirror still show
  // (WA renders via live pull). Same filter applied to the tile counts (getMessagingStats).
  q += `&and=(or(last_message_at.not.is.null,provider_thread_ref.not.is.null))`;
  // Ignition handoff scope (S177): threads transferred to the Influencer team leave
  // the CS inbox entirely. Default = exclude them; scope=ignition = ONLY them (a
  // read-only oversight view for CS leads, since Pitstop still owns the channel).
  const scope = params.get('scope');
  if (scope === 'ignition') q += `&ignition_connect=is.true`;
  else q += `&ignition_connect=is.false`;
  const state = params.get('state') || 'active';   // active (open+snoozed) | closed | all (S163 work-queue)
  if (channel && channel !== 'all') q += `&channel=eq.${encodeURIComponent(channel)}`;
  if (tab === 'mine') q += `&assigned_agent_id=eq.${auth.userId}`;
  else if (tab === 'unassigned') q += `&assigned_agent_id=is.null`;
  else {
    // Explicit assigned-agent facet — managers filtering to one agent (S164). Only
    // meaningful on the "all" tab (mine/unassigned already pin the agent axis).
    const agent = params.get('agent');
    if (agent) q += `&assigned_agent_id=eq.${encodeURIComponent(agent)}`;
  }
  if (state === 'active') q += `&thread_state=in.(open,snoozed)`;
  else if (state === 'closed') q += `&thread_state=eq.closed`;
  // state === 'all' → no thread_state filter
  const priority = params.get('priority');         // urgent|high|normal|low facet (S164)
  if (priority) q += `&priority=eq.${encodeURIComponent(priority)}`;
  // Which LOT number the customer wrote to (Pruthvi 2026-07-31). He asked to "segregate
  // the WhatsApp inbox based on the numbers" so transactional/marketing threads can be
  // cleared in bulk without mixing into support. A FACET, not a separate inbox — Afshaan's
  // call that one inbox stays one inbox. Like agent/priority/tag it does not move the
  // segment counts, which stay whole-channel.
  const waba = params.get('waba');
  if (waba) q += `&waba_phone_number_id=eq.${encodeURIComponent(waba)}`;
  const since = params.get('since');               // ISO — last activity ≥ (S164 date filter)
  if (since) q += `&last_message_at=gte.${encodeURIComponent(since)}`;
  const until = params.get('until');               // ISO — last activity ≤ (S164 date filter)
  if (until) q += `&last_message_at=lte.${encodeURIComponent(until)}`;
  // Search box (S178, Pruthvi) — match by phone number (partial; +91 optional),
  // display name/IG handle (customer_handle), or the channel handle in external_user_id
  // (the EMAIL ADDRESS on email threads; IG/FB user id on Meta threads). Server-side so
  // it finds threads beyond the loaded window. Strip PostgREST or()-breaking chars.
  const search = (params.get('q') || '').replace(/[(),*]/g, '').trim().slice(0, 50);
  if (search) {
    const s = encodeURIComponent(search);
    q += `&or=(customer_phone.ilike.*${s}*,customer_handle.ilike.*${s}*,external_user_id.ilike.*${s}*)`;
  }
  const tagFilter = params.get('tag');             // tag facet (S163)
  if (tagFilter) {
    const tagged = await idsWithTag('thread', tagFilter, env);
    if (!tagged.length) return ok({ threads: [] });
    q += `&id=in.(${tagged.join(',')})`;
  }
  const tRes = await sb(q, env);
  const threads = tRes.data || [];
  if (!threads.length) return ok({ threads: [] });

  // One batched fetch of recent messages for these threads → last-message preview
  // + linked ticket per thread (avoids N+1; PostgREST has no "latest per group").
  const ids = threads.map(t => t.id);
  const mRes = await sb(
    `/rest/v1/cs_wa_messages?thread_id=in.(${ids.join(',')})&select=thread_id,body,kind,direction,ticket_id,is_internal,created_at&order=created_at.desc&limit=1500`,
    env,
  );
  const lastByThread = {};
  const ticketByThread = {};
  for (const m of (mRes.data || [])) {
    // Private notes never surface as the customer-facing preview line.
    if (!m.is_internal && !lastByThread[m.thread_id]) lastByThread[m.thread_id] = m;
    if (m.ticket_id && !ticketByThread[m.thread_id]) ticketByThread[m.thread_id] = m.ticket_id;
  }
  const ticketIds = [...new Set(Object.values(ticketByThread))];
  const ticketNoById = {};
  if (ticketIds.length) {
    const tkRes = await sb(`/rest/v1/cs_tickets?id=in.(${ticketIds.join(',')})&select=id,ticket_no`, env);
    for (const tk of (tkRes.data || [])) ticketNoById[tk.id] = tk.ticket_no;
  }
  const tagsByThread = await fetchTagsFor('thread', ids, env);
  const out = threads.map(t => {
    const lm = lastByThread[t.id] || null;
    const tid = ticketByThread[t.id] || null;
    return {
      ...t,
      last_message: lm ? { body: lm.body, kind: lm.kind, direction: lm.direction, created_at: lm.created_at } : null,
      linked_ticket_id: tid,
      linked_ticket_no: tid ? (ticketNoById[tid] || null) : null,
      within_customer_window: withinCustomerWindow(t),
      // Team-global unread: a customer message arrived after the thread was last opened,
      // and it isn't Done. `has_unread_inbound` is the DB-generated flag (last_inbound_at >
      // last_read_at); we AND in the open-state check here (S222, Pruthvi unread indicator).
      unread: !!t.has_unread_inbound && t.thread_state !== 'closed',
      tags: tagsByThread[t.id] || [],
    };
  });
  return ok({ threads: out });
}

// Header-tile stats. Per-channel total conversations + "awaiting reply" (last
// message inbound). Awaiting is computed only for the two-way channels
// (instagram/messenger — low volume, replied to HERE); WhatsApp is a read-only
// BiteSpeed mirror (replies happen there) so it gets an exact total only.
// Counts for ONE agent, shown beside the agent filter (Pruthvi, #bugs 2026-08-26).
//
// She asked for the channel counts to follow the agent filter; they deliberately do not
// (every facet leaves the segment counts whole-channel, and three incidents are on record
// from the counts and the list disagreeing — S184/S229/S245). Her own answer avoided the
// problem entirely: *"show the agent's name right next to the active on the left side and
// then show how many chats are active under the agent and how many are closed"*. So this
// is an ADDITIONAL, agent-scoped read — the segment counts are untouched.
//
// Scoped to the channel in view so it agrees with what the operator is looking at.
async function getAgentInboxCounts(params, auth, env) {
  const g = require('cs_ticket_view', auth); if (g) return g;
  const agent = params.get('agent');
  if (!agent) return err('agent required');
  const channel = params.get('channel');
  const chan = channel && channel !== 'all' ? `&channel=eq.${encodeURIComponent(channel)}` : '';
  // Same two qualifiers the list uses, so the numbers cannot disagree with it: exclude
  // Ignition-transferred threads and guaranteed-empty ones.
  const base = `&ignition_connect=is.false&and=(or(last_message_at.not.is.null,provider_thread_ref.not.is.null))`;
  const who = `&assigned_agent_id=eq.${encodeURIComponent(agent)}`;
  const [active, closed] = await Promise.all([
    sbCount(`/rest/v1/cs_wa_threads?thread_state=in.(open,snoozed)${who}${chan}${base}&select=id`, env),
    sbCount(`/rest/v1/cs_wa_threads?thread_state=eq.closed${who}${chan}${base}&select=id`, env),
  ]);
  return ok({ agent_id: agent, channel: channel || 'all', active, closed });
}

async function getMessagingStats(params, auth, env) {
  const stats = {
    instagram: { total: 0, awaiting: 0, mine: 0, unassigned: 0, closed: 0 },
    messenger: { total: 0, awaiting: 0, mine: 0, unassigned: 0, closed: 0 },
    // whatsapp.awaiting starts at 0, not null, so it accumulates below (S245 — it is a real
    // two-way channel now). email/web stay null: no per-thread awaiting is computed for them.
    whatsapp:  { total: 0, awaiting: 0, mine: 0, unassigned: 0, closed: 0 },
    email:     { total: 0, awaiting: null, mine: 0, unassigned: 0, closed: 0 },
    web:       { total: 0, awaiting: null, mine: 0, unassigned: 0, closed: 0 },
  };
  // Two-way channels: small volume → fetch threads + last-message direction.
  // Exclude Ignition-transferred threads (S177) — they're off the CS inbox.
  // NONEMPTY (S229): tile counts must match the list, which hides guaranteed-empty
  // threads (never messaged + no provider ref) — see getMessagingThreads.
  const NONEMPTY = `&and=(or(last_message_at.not.is.null,provider_thread_ref.not.is.null))`;
  // WhatsApp joined this set in S245. It was excluded as a "read-only BiteSpeed mirror" whose
  // awaiting was tracked in BiteSpeed — true until the Relay cutover, after which inbound lands
  // in cs_wa_messages and WhatsApp is fully two-way. Leaving it out meant the busiest channel
  // contributed NOTHING to "awaiting reply", so an agent had no signal that a customer was
  // waiting — the one number that matters on the night the inbox becomes the only place
  // customer messages exist.
  const twRes = await sb(`/rest/v1/cs_wa_threads?channel=in.(instagram,messenger,whatsapp)&ignition_connect=is.false&thread_state=in.(open,snoozed)${NONEMPTY}&select=id,channel,assigned_agent_id&limit=1500`, env);
  const tw = twRes.data || [];
  const chById = {};
  for (const t of tw) {
    chById[t.id] = t.channel;
    // WhatsApp's total/mine/unassigned come from the exact sbCount() calls further down;
    // incrementing them here as well would double every WhatsApp tile.
    if (t.channel === 'whatsapp') continue;
    const s = stats[t.channel];
    if (!s) continue;
    s.total += 1;
    if (t.assigned_agent_id === auth.userId) s.mine += 1;
    if (!t.assigned_agent_id) s.unassigned += 1;
  }
  if (tw.length) {
    // Exclude internal notes — "awaiting reply" means the customer's last message is unanswered.
    // CHUNKED, and that is not an optimisation — it is a correctness fix (S245). All the ids used
    // to go into ONE `thread_id=in.(…)` URL: at 571 open threads that is a ~21KB URL, and it grows
    // with the open-thread count. When such a request is refused the failure is SILENT — `data` is
    // empty, every `awaiting` computes 0, and the tile reports "nothing waiting", which is the
    // exact inverse of the truth on the channel agents now rely on. Chunking bounds each URL to
    // ~7KB regardless of volume.
    //
    // It also shrinks the pre-existing ordering caveat: `order=created_at.desc` is global, so a
    // long-idle but still-open thread could fall outside a single page and be under-counted.
    // Scoping each page to 200 threads makes that far less likely (a full RPC is the exact fix).
    const CHUNK = 200;
    const lastDir = {};
    for (let i = 0; i < tw.length; i += CHUNK) {
      const ids = tw.slice(i, i + CHUNK).map((t) => t.id).join(',');
      const mRes = await sb(
        `/rest/v1/cs_wa_messages?thread_id=in.(${ids})&is_internal=eq.false&select=thread_id,direction,created_at&order=created_at.desc&limit=2000`,
        env,
      );
      for (const m of (mRes.data || [])) if (!(m.thread_id in lastDir)) lastDir[m.thread_id] = m.direction;
    }
    for (const [tid, dir] of Object.entries(lastDir)) {
      if (dir === 'inbound' && stats[chById[tid]]) stats[chById[tid]].awaiting += 1;
    }
  }
  // Header tiles count the ACTIVE work-queue (open+snoozed) so they MATCH the default
  // inbox list, which filters state=active (getMessagingThreads). Without this, a CLOSED
  // unassigned thread inflated the "unassigned" tile but never appeared in the list →
  // "count says N, Unassigned tab shows none" (Pruthvi, S184, email channel). Closed
  // conversations are reachable via the Closed/All state filter, not the work-queue tiles.
  const ACTIVE = `&thread_state=in.(open,snoozed)`;
  // WhatsApp: exact counts only (read-only mirror — awaiting tracked in BiteSpeed).
  // All counts exclude Ignition-transferred threads (S177).
  stats.whatsapp.total = await sbCount(`/rest/v1/cs_wa_threads?channel=eq.whatsapp&ignition_connect=is.false${ACTIVE}${NONEMPTY}&select=id`, env);
  stats.whatsapp.mine = await sbCount(`/rest/v1/cs_wa_threads?channel=eq.whatsapp&ignition_connect=is.false&assigned_agent_id=eq.${auth.userId}${ACTIVE}${NONEMPTY}&select=id`, env);
  stats.whatsapp.unassigned = await sbCount(`/rest/v1/cs_wa_threads?channel=eq.whatsapp&ignition_connect=is.false&assigned_agent_id=is.null${ACTIVE}${NONEMPTY}&select=id`, env);
  // Email: exact counts (volume may grow → cheap counts, no per-thread awaiting v1).
  stats.email.total = await sbCount(`/rest/v1/cs_wa_threads?channel=eq.email&ignition_connect=is.false${ACTIVE}${NONEMPTY}&select=id`, env);
  stats.email.mine = await sbCount(`/rest/v1/cs_wa_threads?channel=eq.email&ignition_connect=is.false&assigned_agent_id=eq.${auth.userId}${ACTIVE}${NONEMPTY}&select=id`, env);
  stats.email.unassigned = await sbCount(`/rest/v1/cs_wa_threads?channel=eq.email&ignition_connect=is.false&assigned_agent_id=is.null${ACTIVE}${NONEMPTY}&select=id`, env);
  // Web (L.O.T Web widget via BiteSpeed, S182): exact counts only (read-mostly mirror).
  stats.web.total = await sbCount(`/rest/v1/cs_wa_threads?channel=eq.web&ignition_connect=is.false${ACTIVE}${NONEMPTY}&select=id`, env);
  stats.web.mine = await sbCount(`/rest/v1/cs_wa_threads?channel=eq.web&ignition_connect=is.false&assigned_agent_id=eq.${auth.userId}${ACTIVE}${NONEMPTY}&select=id`, env);
  stats.web.unassigned = await sbCount(`/rest/v1/cs_wa_threads?channel=eq.web&ignition_connect=is.false&assigned_agent_id=is.null${ACTIVE}${NONEMPTY}&select=id`, env);
  // Closed (resolved) count per channel — shown on each channel tile so the team has
  // quick visibility into resolved volume per channel (Pruthvi, S185). Excludes
  // Ignition-transferred threads, consistent with the active counts above.
  for (const ch of ['instagram', 'messenger', 'whatsapp', 'email', 'web']) {
    stats[ch].closed = await sbCount(`/rest/v1/cs_wa_threads?channel=eq.${ch}&ignition_connect=is.false&thread_state=eq.closed${NONEMPTY}&select=id`, env);
  }
  // Per-channel UNREAD count (S222, Pruthvi) — active threads with a customer message
  // that arrived after the thread was last opened. One set-based RPC over the generated
  // `has_unread_inbound` flag (open+snoozed, non-Ignition) → team-global unread badges.
  for (const ch of Object.keys(stats)) stats[ch].unread = 0;
  const uRes = await sb(`/rest/v1/rpc/cs_unread_counts_by_channel`, env, { method: 'POST', body: '{}' });
  for (const row of (uRes.data || [])) {
    if (stats[row.channel]) stats[row.channel].unread = Number(row.cnt) || 0;
  }
  return ok({ stats });
}

async function getMessagingThread(params, auth, env) {
  const thread_id = params.get('thread_id');
  if (!thread_id) return err('thread_id required');
  const tRes = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=*&limit=1`, env);
  const thread = tRes.data?.[0];
  if (!thread) return err('Thread not found', 404);
  const mRes = await sb(
    `/rest/v1/cs_wa_messages?thread_id=eq.${encodeURIComponent(thread_id)}&select=*&order=created_at.asc&limit=500`,
    env,
  );
  const messages = mRes.data || [];
  const linkedId = messages.find(m => m.ticket_id)?.ticket_id || null;
  let linked_ticket = null;
  if (linkedId) {
    const tk = await sb(`/rest/v1/cs_tickets?id=eq.${linkedId}&select=id,ticket_no,disposition,stage&limit=1`, env);
    linked_ticket = tk.data?.[0] || null;
  }
  const tagsByThread = await fetchTagsFor('thread', [thread.id], env);
  return ok({ thread, messages, linked_ticket, within_customer_window: withinCustomerWindow(thread), tags: tagsByThread[thread.id] || [] });
}

// Link every message on a thread to a ticket (cs_wa_messages.ticket_id). IG/FB
// threads have no phone to auto-match, so this is the manual bind from the inbox.
async function linkMessagingThread(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { thread_id, ticket_no } = body;
  if (!thread_id || !ticket_no) return err('thread_id and ticket_no required');
  // Same Ignition wall as createTicketFromThread (Afshaan, 2026-08-24 S305): a transferred
  // conversation may not be bound to Pitstop paperwork until it is returned.
  const thr = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=id,ignition_connect&limit=1`, env);
  if (!thr.data?.[0]) return err('Thread not found', 404);
  if (thr.data[0].ignition_connect) return err('This conversation is with the Influencer team (Ignition). Return it to Pitstop before linking a ticket.', 422);
  const tk = await sb(`/rest/v1/cs_tickets?ticket_no=eq.${encodeURIComponent(ticket_no)}&select=id,ticket_no&limit=1`, env);
  const ticket = tk.data?.[0];
  if (!ticket) return err('Ticket not found', 404);
  const upd = await sb(`/rest/v1/cs_wa_messages?thread_id=eq.${encodeURIComponent(thread_id)}`, env, {
    method: 'PATCH', body: JSON.stringify({ ticket_id: ticket.id }),
  });
  if (!upd.ok) return err('Failed to link thread', upd.status || 500);
  return ok({ linked: true, ticket_no: ticket.ticket_no, ticket_id: ticket.id });
}

// Assign / claim / release a DM thread to an agent (Feature A, S162). Mirrors the
// ticket assignAgent gate exactly: self-claim (or self-release) needs cs_ticket_manage;
// assigning to ANOTHER agent needs cs_ticket_reassign or cs_ticket_admin. agent_id null
// = unassign (return to the pool — open to managers, or to the current owner releasing self).
async function assignThread(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { thread_id, agent_id } = body;
  if (!thread_id) return err('thread_id required');

  const tRes = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=id,assigned_agent_id&limit=1`, env);
  const thread = tRes.data?.[0];
  if (!thread) return err('Thread not found', 404);

  const canReassign = !!auth?.permissions?.cs_ticket_reassign || !!auth?.permissions?.cs_ticket_admin;
  const isSelf = agent_id === auth.userId;
  // Releasing (agent_id null): allowed if you own it OR you can reassign.
  const isSelfRelease = !agent_id && thread.assigned_agent_id === auth.userId;
  if (!isSelf && !isSelfRelease && !canReassign) {
    return err('Forbidden — only Team Lead+ can assign threads to other agents (missing cs_ticket_reassign)', 403);
  }

  let name = null;
  if (agent_id) {
    const aRes = await sb(`/rest/v1/users_profile?id=eq.${agent_id}&select=id,full_name&limit=1`, env);
    const agent = aRes.data?.[0];
    if (!agent) return err('Agent not found', 404);
    name = agent.full_name;
  }

  const upd = await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, {
    method: 'PATCH',
    body: JSON.stringify({
      assigned_agent_id: agent_id || null,
      assigned_agent_name: name,
      assigned_at: agent_id ? new Date().toISOString() : null,
    }),
  });
  if (!upd.ok) return err('Assign failed', upd.status || 500);
  return ok({ assigned_agent_id: agent_id || null, assigned_agent_name: name });
}

// Bulk assign/claim/release many DM threads in ONE PATCH (S164, Pruthvi).
// Same permission split as assignThread: self-claim = cs_ticket_manage,
// assigning to another agent = cs_ticket_reassign/admin. A plain agent
// releasing (agent_id null) only ever clears their OWN threads (scoped filter).
// One subrequest regardless of count, so no Cloudflare subrequest-limit risk.
async function bulkAssignThreads(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { thread_ids, agent_id } = body;
  if (!Array.isArray(thread_ids) || thread_ids.length === 0) return err('thread_ids[] required');
  if (thread_ids.length > 200) return err('too many threads in one action (max 200)');

  const canReassign = !!auth?.permissions?.cs_ticket_reassign || !!auth?.permissions?.cs_ticket_admin;
  const isSelf = agent_id === auth.userId;

  let name = null;
  if (agent_id) {
    if (!isSelf && !canReassign) {
      return err('Forbidden — only Team Lead+ can assign threads to other agents (missing cs_ticket_reassign)', 403);
    }
    const aRes = await sb(`/rest/v1/users_profile?id=eq.${agent_id}&select=id,full_name&limit=1`, env);
    const agent = aRes.data?.[0];
    if (!agent) return err('Agent not found', 404);
    name = agent.full_name;
  }

  const idList = thread_ids.map(id => encodeURIComponent(id)).join(',');
  let path = `/rest/v1/cs_wa_threads?id=in.(${idList})`;
  // A plain agent releasing to the pool may only clear threads they own.
  if (!agent_id && !canReassign) path += `&assigned_agent_id=eq.${auth.userId}`;

  const upd = await sb(path, env, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      assigned_agent_id: agent_id || null,
      assigned_agent_name: name,
      assigned_at: agent_id ? new Date().toISOString() : null,
    }),
  });
  if (!upd.ok) return err('Bulk assign failed', upd.status || 500);
  return ok({ updated: (upd.data || []).length, assigned_agent_id: agent_id || null, assigned_agent_name: name });
}

// Bulk resolve/close conversations (Pruthvi 2026-07-31). Same multi-select the bulk
// assign uses; the missing half was an action other than "assign". The driver is the
// transactional/marketing inbox — a number the team never converses on still accrues
// threads, and closing them one at a time is the whole complaint.
//
// ADMIN-ONLY on purpose (`cs_ticket_admin`, Pruthvi's own ask): closing 200 conversations
// is unauditable in aggregate, and the per-thread Resolve button is unchanged for agents.
// A REASON IS STILL REQUIRED — the ask was to remove repetition, not the outcome record,
// so every row lands in the reports with a real closed_reason exactly like a single close.
async function bulkSetThreadState(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  const { thread_ids, state, closed_reason, closed_note } = body || {};
  if (!Array.isArray(thread_ids) || thread_ids.length === 0) return err('thread_ids[] required');
  if (thread_ids.length > 200) return err('too many conversations in one action (max 200)');
  if (!['open', 'closed'].includes(state)) return err('invalid state (open|closed)');
  // Unlike the single-thread path the reason is MANDATORY here. That handler leaves it
  // optional only so the worker and app can deploy in either order; this action is new
  // on both sides at once, so there is no such window to protect and no reason to allow
  // a 200-row reasonless close.
  if (state === 'closed' && !CONVO_CLOSE_REASONS.includes(closed_reason)) {
    return err(`closed_reason required (one of: ${CONVO_CLOSE_REASONS.join(', ')})`, 422);
  }

  const patch = { thread_state: state };
  if (state === 'closed') {
    patch.closed_at = new Date().toISOString();
    patch.closed_by_user_id = auth.userId;
    patch.snoozed_until = null;
    patch.closed_reason = closed_reason;
    patch.closed_note = (closed_note && String(closed_note).trim()) || null;
  } else {
    clearClosedFields(patch);
  }

  const idList = thread_ids.map(id => encodeURIComponent(id)).join(',');
  const upd = await sb(`/rest/v1/cs_wa_threads?id=in.(${idList})`, env, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  if (!upd.ok) return err('Bulk resolve failed', upd.status || 500);
  return ok({ updated: (upd.data || []).length, thread_state: state, closed_reason: patch.closed_reason ?? null });
}

// Set a DM thread's priority (S164, Pruthvi). Urgent/High/Normal/Low; sortable
// via the generated priority_rank column. Gate cs_ticket_manage (same as assign).
async function setThreadPriority(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { thread_id, priority } = body;
  if (!thread_id) return err('thread_id required');
  const ALLOWED = new Set(['urgent', 'high', 'normal', 'low']);
  if (!ALLOWED.has(priority)) return err('priority must be one of urgent|high|normal|low');
  const upd = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}`, env, {
    method: 'PATCH', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ priority, updated_at: new Date().toISOString() }),
  });
  if (!upd.ok || !upd.data?.[0]) return err('Failed to set priority', upd.status || 500);
  return ok({ thread_id, priority });
}

// Quick-create a ticket FROM a DM conversation and auto-link it (S164, Pruthvi).
// Mirrors createTicket's insert shape; prefills customer + channel from the thread.
// IG/FB have no phone → intake_channel='other', customer_name = handle. Idempotent:
// if the thread already links a ticket, returns it instead of minting a duplicate.
async function createTicketFromThread(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { thread_id } = body;
  if (!thread_id) return err('thread_id required');

  const tRes = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=*&limit=1`, env);
  const thread = tRes.data?.[0];
  if (!thread) return err('Thread not found', 404);

  // A conversation handed to Ignition stays in Ignition (Afshaan, 2026-08-24 S305): no Pitstop
  // ticket may be raised on it unless it is transferred back first (bridgeReturnConnect).
  if (thread.ignition_connect) return err('This conversation is with the Influencer team (Ignition). Return it to Pitstop before raising a ticket.', 422);

  // Already linked? Return that ticket (no dup).
  const linkRes = await sb(`/rest/v1/cs_wa_messages?thread_id=eq.${encodeURIComponent(thread_id)}&ticket_id=not.is.null&select=ticket_id&limit=1`, env);
  const existingId = linkRes.data?.[0]?.ticket_id;
  if (existingId) {
    const ex = await sb(`/rest/v1/cs_tickets?id=eq.${existingId}&select=id,ticket_no&limit=1`, env);
    const exTk = ex.data?.[0];
    if (exTk) return ok({ ticket_no: exTk.ticket_no, id: exTk.id, already_linked: true });
  }

  const year = String(new Date().getFullYear());
  const seqRes = await sb(`/rest/v1/rpc/next_cs_ticket_seq`, env, { method: 'POST', body: JSON.stringify({ p_year: year }) });
  if (!seqRes.ok) return err(`Failed to claim ticket number: ${JSON.stringify(seqRes.data)}`, 500);
  const ticket_no = `CS-${year}-${String(Number(seqRes.data)).padStart(5, '0')}`;

  const isWa = thread.channel === 'whatsapp';
  const customer_name = thread.customer_handle || thread.customer_phone || (isWa ? 'WhatsApp customer' : 'Social customer');
  const due_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // pending → 7d default SLA

  const insertRes = await sb(`/rest/v1/cs_tickets`, env, {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      ticket_no,
      cs_department_id: auth.cs_department_id || null,
      created_by_user_id: auth.userId,
      created_by_name: auth.fullName,
      intake_channel: isWa ? 'whatsapp' : 'other',
      customer_name,
      customer_phone: isWa ? (thread.customer_phone || null) : null,
      disposition: 'pending',
      assigned_agent_id: thread.assigned_agent_id || auth.userId,
      assigned_agent_name: thread.assigned_agent_name || auth.fullName,
      stage: 'intake',
      issue_description: '',
      due_at,
    }),
  });
  if (!insertRes.ok) return err(`Failed to create ticket: ${JSON.stringify(insertRes.data)}`, insertRes.status);
  const ticket = insertRes.data?.[0];
  await insertHistory(ticket.id, 'ticket_created', null, ticket_no, null, auth, env);

  // Auto-link the whole thread to the new ticket (mirror linkMessagingThread —
  // the link lives on the thread's cs_wa_messages rows).
  await sb(`/rest/v1/cs_wa_messages?thread_id=eq.${encodeURIComponent(thread_id)}`, env, {
    method: 'PATCH', body: JSON.stringify({ ticket_id: ticket.id }),
  }).catch(() => {});

  return ok({ ticket_no, id: ticket.id, linked: true });
}

// Add a private (internal) note to a DM thread (Feature B, S162). Agent-only —
// stored as a cs_wa_messages row with is_internal=true / kind='note', NEVER sent to
// Graph. Stamps updated_at (NOT last_message_at) so a note doesn't reorder the thread
// above customers genuinely awaiting a reply or flip "awaiting reply".
async function addThreadNote(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { thread_id, text } = body;
  if (!thread_id || !text || !text.trim()) return err('thread_id and text required');

  const tRes = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=id,channel&limit=1`, env);
  const thread = tRes.data?.[0];
  if (!thread) return err('Thread not found', 404);

  const ins = await sb(`/rest/v1/cs_wa_messages`, env, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      thread_id: thread.id, channel: thread.channel, direction: 'outbound', kind: 'note',
      is_internal: true, body: text.trim(), status: null,
      sent_by_user_id: auth.userId, sent_by_name: auth.fullName || auth.name || auth.email || null,
      sent_at: new Date().toISOString(),
    }),
  });
  if (!ins.ok) return err('Failed to add note', ins.status || 500);
  await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, {
    method: 'PATCH', body: JSON.stringify({ updated_at: new Date().toISOString() }),
  }).catch(() => {});
  return ok({ note: ins.data?.[0] || null });
}

// Transfer a thread to another agent + leave an internal handoff note (Pruthvi's ask).
// Any cs_ticket_manage agent can hand off a thread they own or that's unassigned; only
// Team Lead+ (cs_ticket_reassign/admin) can transfer a thread assigned to someone else.
async function transferThread(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { thread_id, to_agent_id, note } = body;
  if (!thread_id || !to_agent_id) return err('thread_id and to_agent_id required');

  const tRes = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=id,channel,assigned_agent_id,thread_state&limit=1`, env);
  const thread = tRes.data?.[0];
  if (!thread) return err('Thread not found', 404);

  const canReassign = !!auth?.permissions?.cs_ticket_reassign || !!auth?.permissions?.cs_ticket_admin;
  const ownsOrFree = !thread.assigned_agent_id || thread.assigned_agent_id === auth.userId;
  if (!canReassign && !ownsOrFree) {
    return err("Forbidden — you can only transfer a conversation you're handling (missing cs_ticket_reassign)", 403);
  }
  if (to_agent_id === thread.assigned_agent_id) return err('Conversation is already assigned to that agent', 422);

  const aRes = await sb(`/rest/v1/users_profile?id=eq.${encodeURIComponent(to_agent_id)}&select=id,full_name&limit=1`, env);
  const agent = aRes.data?.[0];
  if (!agent) return err('Target agent not found', 404);

  const now = new Date().toISOString();
  const patch = { assigned_agent_id: agent.id, assigned_agent_name: agent.full_name, assigned_at: now };
  if (thread.thread_state && thread.thread_state !== 'open') clearClosedFields(patch);   // a transfer = active work
  const upd = await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
  if (!upd.ok) return err('Transfer failed', upd.status || 500);

  // Internal handoff note (team-only; for WhatsApp it surfaces via getWaConversation's
  // note merge). Always records the handoff line; appends the agent's note if given.
  const fromName = auth.fullName || auth.name || auth.email || 'Agent';
  const noteText = (note && String(note).trim()) ? `\n${String(note).trim()}` : '';
  await sb(`/rest/v1/cs_wa_messages`, env, {
    method: 'POST',
    body: JSON.stringify({
      thread_id: thread.id, channel: thread.channel || 'whatsapp', direction: 'outbound',
      kind: 'note', is_internal: true, body: `↪ Transferred to ${agent.full_name}${noteText}`,
      status: null, sent_by_user_id: auth.userId, sent_by_name: fromName, sent_at: now,
    }),
  }).catch(() => {});
  await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, { method: 'PATCH', body: JSON.stringify({ updated_at: now }) }).catch(() => {});

  return ok({ transferred_to: agent.full_name, to_agent_id: agent.id });
}

// ── Ignition Connects bridge (S177) ──────────────────────────────────────────
// The Pitstop CS team transfers an IG/WhatsApp/email conversation to the Influencer
// team; Reann (+ Himani) work it inside Ignition. Pitstop stays the channel owner +
// single store — Ignition reads/replies through these endpoints, never the raw inbox.
// See spec 2026-06-26-ignition-pitstop-connects-transfer-design.md.

// CS-side action: hand a thread to the Influencer team. Full handoff — the
// ignition_connect flag excludes it from the CS inbox everywhere, and CS assignment
// is released. Same own/unassigned-vs-reassign gate as transferThread.
async function transferThreadToIgnition(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { thread_id, note } = body;
  if (!thread_id) return err('thread_id required');

  const tRes = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=id,channel,assigned_agent_id,ignition_connect&limit=1`, env);
  const thread = tRes.data?.[0];
  if (!thread) return err('Thread not found', 404);
  if (thread.ignition_connect) return err('Conversation is already with the Influencer team', 422);

  const canReassign = !!auth?.permissions?.cs_ticket_reassign || !!auth?.permissions?.cs_ticket_admin;
  const ownsOrFree = !thread.assigned_agent_id || thread.assigned_agent_id === auth.userId;
  if (!canReassign && !ownsOrFree) {
    return err("Forbidden — you can only transfer a conversation you're handling (missing cs_ticket_reassign)", 403);
  }

  const now = new Date().toISOString();
  const upd = await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, {
    method: 'PATCH',
    body: JSON.stringify({
      ignition_connect: true, ignition_transferred_at: now, ignition_transferred_by: auth.userId,
      assigned_agent_id: null, assigned_agent_name: null, assigned_at: null, updated_at: now,
    }),
  });
  if (!upd.ok) return err('Transfer failed', upd.status || 500);

  // Internal handoff note — the snapshot the Influencer team sees + a CS audit line.
  const fromName = auth.fullName || auth.name || auth.email || 'Agent';
  const noteText = (note && String(note).trim()) ? `: ${String(note).trim()}` : '';
  await sb(`/rest/v1/cs_wa_messages`, env, {
    method: 'POST',
    body: JSON.stringify({
      thread_id: thread.id, channel: thread.channel || 'whatsapp', direction: 'outbound',
      kind: 'note', is_internal: true, body: `↪ Transferred to Influencer team (Ignition)${noteText}`,
      status: null, sent_by_user_id: auth.userId, sent_by_name: fromName, sent_at: now,
    }),
  }).catch(() => {});

  return ok({ transferred: true, thread_id: thread.id });
}

// Bridge router — token-authed (NOT a user JWT), routed before the JWT gate. Every
// handler hard-scopes to ignition_connect=true so Ignition is structurally walled
// off from general channel traffic even if its UI had a bug.
async function handleIgnitionBridge(request, env) {
  if (!env.IGNITION_BRIDGE_TOKEN) return err('Ignition bridge not configured', 503);
  if (request.headers.get('X-Ignition-Bridge-Token') !== env.IGNITION_BRIDGE_TOKEN) return err('Unauthorized', 401);
  let body = {};
  try { body = await request.json(); } catch {}
  switch (body.action) {
    case 'getIgnitionConnects':    return bridgeGetConnects(body, env);
    case 'getIgnitionThread':      return bridgeGetThread(body, env);
    case 'sendConnectReply':       return bridgeSendReply(body, env);
    case 'returnConnectToPitstop': return bridgeReturnConnect(body, env);
    case 'createTicketFromIgnition': return bridgeCreateTicket(body, env);
    default: return err(`Unknown bridge action: ${body.action}`, 404);
  }
}

// List every transferred thread + a batched last-message preview + awaiting-reply flag.
async function bridgeGetConnects(body, env) {
  const limit = Math.min(Number(body.limit) || 200, 400);
  const channel = body.channel;
  let q = `/rest/v1/cs_wa_threads?ignition_connect=is.true&select=*&order=last_message_at.desc.nullslast&limit=${limit}`;
  if (channel && channel !== 'all') q += `&channel=eq.${encodeURIComponent(channel)}`;
  const tRes = await sb(q, env);
  const threads = tRes.data || [];
  if (!threads.length) return ok({ threads: [] });

  const ids = threads.map(t => t.id);
  const mRes = await sb(
    `/rest/v1/cs_wa_messages?thread_id=in.(${ids.join(',')})&is_internal=eq.false&select=thread_id,body,kind,direction,created_at&order=created_at.desc&limit=1500`,
    env,
  );
  const lastByThread = {};
  for (const m of (mRes.data || [])) if (!lastByThread[m.thread_id]) lastByThread[m.thread_id] = m;
  const out = threads.map(t => {
    const lm = lastByThread[t.id] || null;
    return {
      ...t,
      last_message: lm ? { body: lm.body, kind: lm.kind, direction: lm.direction, created_at: lm.created_at } : null,
      awaiting_reply: lm ? lm.direction === 'inbound' : false,
      within_customer_window: withinCustomerWindow(t),
    };
  });
  return ok({ threads: out });
}

// One transferred thread's full message history. 403 if not an Ignition connect.
async function bridgeGetThread(body, env) {
  const { thread_id } = body;
  if (!thread_id) return err('thread_id required');
  const tRes = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=*&limit=1`, env);
  const thread = tRes.data?.[0];
  if (!thread) return err('Thread not found', 404);
  if (!thread.ignition_connect) return err('Not an Ignition connect', 403);
  const mRes = await sb(
    `/rest/v1/cs_wa_messages?thread_id=eq.${encodeURIComponent(thread_id)}&select=*&order=created_at.asc&limit=500`, env);
  return ok({ thread, messages: mRes.data || [], within_customer_window: withinCustomerWindow(thread) });
}

// Reply on a transferred thread → existing provider send path by channel, scope-
// checked, stamped to the acting Ignition user, with NO CS auto-claim (viaIgnitionBridge).
async function bridgeSendReply(body, env) {
  const { thread_id, text, html, actor } = body;
  if (!thread_id || (!text && !html)) return err('thread_id and text required');
  const tRes = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=id,channel,ignition_connect&limit=1`, env);
  const thread = tRes.data?.[0];
  if (!thread) return err('Thread not found', 404);
  if (!thread.ignition_connect) return err('Not an Ignition connect', 403);

  const synthAuth = {
    userId: actor?.id || null,
    fullName: actor?.name || null,
    name: actor?.name || null,
    email: actor?.email || null,
    permissions: { cs_ticket_manage: true },
    viaIgnitionBridge: true,
  };
  const channel = thread.channel || 'whatsapp';
  if (channel === 'whatsapp' || channel === 'web') return sendWaReply({ thread_id, text }, synthAuth, env);
  if (channel === 'instagram' || channel === 'messenger') return sendMetaMessage({ thread_id, text }, synthAuth, env);
  if (channel === 'email') return sendEmailReply({ thread_id, text, html }, synthAuth, env);
  return err(`Unsupported channel: ${channel}`, 422);
}

// Open a Pitstop ticket for an Ignition damaged-shipment flag (RULE-IGN-004).
// Token-authed sibling call, so it runs under a synth-auth (cs_ticket_manage) —
// the Ignition user has no CS permission of their own. The ticket lands UNASSIGNED
// (synthAuth.userId = null → createTicket leaves assignee null) so the CS team
// triages it; the flagging influencer-team member is preserved as created_by_name.
async function bridgeCreateTicket(body, env) {
  const t = body.ticket || {};
  if (!t.customer_name) return err('customer_name required');
  const synthAuth = {
    userId: null,                         // → Unassigned queue (no auto-assign to a non-CS user)
    fullName: body.actor?.name || 'Ignition',
    name: body.actor?.name || 'Ignition',
    email: body.actor?.email || null,
    cs_department_id: null,
    permissions: { cs_ticket_manage: true },
    viaIgnitionBridge: true,
  };
  return createTicket(t, synthAuth, env);
}

// Return a transferred connect back to Pitstop CS (reclaim). Clears the
// ignition_connect gate → the thread reappears in the CS inbox (Unassigned, since
// transfer released its agent); leaves an internal note. Scope-checked.
async function bridgeReturnConnect(body, env) {
  const { thread_id, actor } = body;
  if (!thread_id) return err('thread_id required');
  const tRes = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=id,channel,ignition_connect&limit=1`, env);
  const thread = tRes.data?.[0];
  if (!thread) return err('Thread not found', 404);
  if (!thread.ignition_connect) return err('Not an Ignition connect', 403);
  const now = new Date().toISOString();
  const upd = await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, {
    method: 'PATCH',
    body: JSON.stringify({ ignition_connect: false, ignition_transferred_at: null, ignition_transferred_by: null, updated_at: now }),
  });
  if (!upd.ok) return err('Return failed', upd.status || 500);
  await sb(`/rest/v1/cs_wa_messages`, env, {
    method: 'POST',
    body: JSON.stringify({
      thread_id: thread.id, channel: thread.channel || 'whatsapp', direction: 'outbound',
      kind: 'note', is_internal: true,
      body: `↩ Returned to Pitstop CS from the Influencer team${actor?.name ? ' by ' + actor.name : ''}.`,
      status: null, sent_by_user_id: actor?.id || null, sent_by_name: actor?.name || null, sent_at: now,
    }),
  }).catch(() => {});
  return ok({ returned: true, thread_id: thread.id });
}

// ── Canned responses (S162) — agent-managed quick replies for the composer ───
async function getCannedResponses(params, auth, env) {
  const g = require('cs_ticket_view', auth); if (g) return g;
  // `all=1` includes archived rows — the Setup screen needs them to un-archive, while the
  // composer must keep seeing only live ones. Same shape as getTags. Deleting is soft
  // (is_active=false), so without this an archived response is unreachable forever.
  const all = params?.get?.('all') === '1';
  const r = await sb(
    `/rest/v1/cs_canned_responses?${all ? '' : 'is_active=eq.true&'}select=*&order=sort_order.asc,title.asc`,
    env);
  if (!r.ok) return err('failed to load canned responses', 500);
  return ok(r.data || []);
}
async function createCannedResponse(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { title, body: text, sort_order } = body;
  if (!title?.trim() || !text?.trim()) return err('title and body required');
  const r = await sb(`/rest/v1/cs_canned_responses`, env, {
    method: 'POST',
    body: JSON.stringify({
      title: title.trim(), body: text.trim(), sort_order: Math.round(Number(sort_order) || 0),
      created_by_user_id: auth.userId, created_by_name: auth.fullName || auth.name || auth.email || null,
    }),
  });
  if (!r.ok) return err('failed to create canned response', r.status || 500);
  return ok({ canned: r.data?.[0] || null });
}
async function updateCannedResponse(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { id, title, body: text, is_active, sort_order } = body;
  if (!id) return err('id required');
  const patch = { updated_at: new Date().toISOString() };
  if (title != null) patch.title = String(title).trim();
  if (text != null) patch.body = String(text).trim();
  if (is_active != null) patch.is_active = !!is_active;       // is_active=false = archive (soft delete)
  if (sort_order != null) patch.sort_order = Math.round(Number(sort_order) || 0);
  const r = await sb(`/rest/v1/cs_canned_responses?id=eq.${encodeURIComponent(id)}`, env, {
    method: 'PATCH', body: JSON.stringify(patch),
  });
  if (!r.ok) return err('failed to update canned response', r.status || 500);
  return ok({ canned: r.data?.[0] || null });
}
