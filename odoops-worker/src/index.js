// ============================================================
// ODO — LOT consolidated cross-channel sales dashboard Worker (odoops)
// ------------------------------------------------------------
// Odo (odo.legendoftoys.com). Own worker, isolated blast radius. service_role on the
// SAME Supabase project as lotopsproxy/snorkelops/manifestops. Owns the `sales` schema
// (sales_fact, staging, sku_map, connector_*, upload_batch).
// NB: the DB schema (`sales`) + permission tables (`store.salesops_roles`) keep their
// build-time identifiers — internal/invisible; the product is "Odo" everywhere user-facing.
//
// Connector framework: per-channel adapters (fetch + stage) feed a shared
// normalize→map→upsert tail into sales.sales_fact. Hourly cron iterates enabled
// sales.connector_config adapters with a global subrequest budget; QC uses the
// same tail via file upload. Permission layer = store.salesops_roles/_user_roles.
//
// Cross-schema READS: store.sales_orders/_lines (GT/MT), store.users_profile +
// salesops_* (auth/perms), public.dispatch_channels + product_master. No writes
// outside `sales` (+ the salesops perm tables on grant). No cross-worker calls.
// ============================================================

import { WorkflowEntrypoint } from 'cloudflare:workers';
// Max windows a single ConnectorWorkflow instance pulls before ending (a still-backfilling
// connector simply continues on the next cron tick). Bounds instance lifetime.
const MAX_WINDOWS = 24;

const SUPABASE_URL = 'https://jkxcnjabmrkteanzoofj.supabase.co';
const SUPABASE_KEY = 'sb_publishable_1Dd-r3h9Mou2Wqgn6t24Dw_lmWdBtLh'; // publishable — auth verify only
let SUPABASE_SERVICE_KEY = ''; // loaded from env each invocation

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, apikey, Authorization',
};

// Initial history window when a channel has no cursor yet (current FY 2026-27 + prior FY).
const BACKFILL_START = '2025-04-01T00:00:00Z';
// Global subrequest budget per cron tick (Cloudflare hard cap is 50; stay well under).
const CRON_BUDGET = 45;

// ── Permission gates (keys in store.salesops_roles.permissions) ──
const canView            = p => !!p.sales_view;
const canRefresh         = p => !!p.sales_refresh        || !!p.salesops_admin;
const canUpload          = p => !!p.sales_upload         || !!p.salesops_admin;
const canMapping         = p => !!p.sales_mapping_manage || !!p.salesops_admin;
const canConnector       = p => !!p.sales_connector_manage || !!p.salesops_admin;
const canAdmin           = p => !!p.salesops_admin;
const canSuperAdmin      = p => !!p.salesops_super_admin;
const canAdsWrite        = p => !!p.sales_ads_write       || !!p.salesops_admin;   // Phase 2: create/manage Meta ads
const canAdsApprove      = p => !!p.sales_ads_approve     || !!p.salesops_admin;   // approve a launch plan (spend gate)

// ── DB helpers ─────────────────────────────────────────────────
// service-role: secret sent as BOTH apikey and Authorization (sb_secret keys are not JWTs).
async function sbProfiled(path, profile, opts = {}) {
  const headers = {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Prefer':        opts.prefer || '',
    ...opts.headers,
  };
  if (profile) { headers['Accept-Profile'] = profile; headers['Content-Profile'] = profile; }
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...opts, headers });
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, data: text }; }
}
const sbSales  = (path, opts = {}) => sbProfiled(path, 'sales',  opts);
const sbStore  = (path, opts = {}) => sbProfiled(path, 'store',  opts);
const sbPublic = (path, opts = {}) => sbProfiled(path, null,     opts); // public schema

async function rpcSales(fn, body) {
  return sbSales(`/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(body) });
}

// Chunked INSERT that THROWS on any failed chunk. A single large array POST (e.g. a wide
// Shopify re-pull whose line rows each carry the full `raw` JSON) can exceed the request-body
// limit and fail — and a plain sbSales POST whose result is ignored drops the whole batch
// SILENTLY. Chunk it (default 200 rows) and surface failures so a run errors loudly instead.
const _sleep = ms => new Promise(r => setTimeout(r, ms));
// Transient Postgres errors worth retrying: statement_timeout, serialization, deadlock,
// lock-not-available, too-many-connections. Since the connector cron now fans out many
// connectors concurrently (Workflows), a heavy write can briefly block on a lock and trip the
// 2-min statement_timeout; idempotent staging makes a retry safe.
const TRANSIENT_PG = new Set(['57014', '40001', '40P01', '55P03', '53300', '53400']);
async function sbInsertChunked(path, rows, prefer = 'return=minimal', chunkSize = 200) {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const slice = rows.slice(i, i + chunkSize);
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await sbSales(path, { method: 'POST', prefer, body: JSON.stringify(slice) });
      if (r.ok) { lastErr = null; break; }
      const code = (r.data && typeof r.data === 'object') ? r.data.code : null;
      lastErr = `insert ${path.split('?')[0].split('/').pop()} [${i}..${i + chunkSize}) failed (${r.status}${code ? ' ' + code : ''}): ${JSON.stringify(r.data).slice(0, 160)}`;
      if (!code || !TRANSIENT_PG.has(code)) break;        // non-transient → fail loudly now
      await _sleep(400 * (attempt + 1) * (attempt + 1));   // 400ms · 1.6s · 3.6s backoff
    }
    if (lastErr) throw new Error(lastErr);
  }
}

// ── utils ───────────────────────────────────────────────────────
function ok(payload, status = 200) {
  return new Response(JSON.stringify({ ok: true, data: payload }), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
function err(msg, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: msg }), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
const nowISO   = () => new Date().toISOString();
const todayISO = () => new Date().toISOString().slice(0, 10);
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
// IST calendar day for a UTC timestamp (a 23:30 IST order lands on the local day, not the UTC day).
function istDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return String(iso).slice(0, 10);
  return new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}
const uniq = arr => [...new Set(arr.filter(Boolean))];
const inList = arr => `(${uniq(arr).map(x => `"${String(x).replace(/"/g, '')}"`).join(',')})`; // PostgREST in.(...)

// ── auth ─────────────────────────────────────────────────────────
async function getSalesPerms(userId) {
  const ur = await sbStore(`/rest/v1/salesops_user_roles?user_id=eq.${userId}&active=is.true&select=role_key&limit=1`);
  if (!ur.ok || !ur.data[0]) return { roleKey: null, perms: {} };
  const roleKey = ur.data[0].role_key;
  const r = await sbStore(`/rest/v1/salesops_roles?role_key=eq.${encodeURIComponent(roleKey)}&select=permissions&limit=1`);
  return { roleKey, perms: (r.ok && r.data[0]) ? (r.data[0].permissions || {}) : {} };
}
async function verifyJWT(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const user = await res.json();
  if (!user?.id) return null;
  const pr = await sbStore(`/rest/v1/users_profile?id=eq.${user.id}&select=role,full_name,active&limit=1`);
  if (!pr.ok || !pr.data[0] || !pr.data[0].active) return null;
  const sp = await getSalesPerms(user.id);
  if (!sp.roleKey) return null;                            // no salesops role → denied
  return { userId: user.id, email: user.email, role: pr.data[0].role, fullName: pr.data[0].full_name, roleKey: sp.roleKey, permissions: sp.perms };
}
// Users whose ACTIVE role carries salesops_super_admin — backs the last-super-admin guards.
async function activeSuperAdminUserIds() {
  const rr = await sbStore('/rest/v1/salesops_roles?select=role_key,permissions');
  const superKeys = new Set((rr.ok ? rr.data : []).filter(r => r.permissions?.salesops_super_admin).map(r => r.role_key));
  if (!superKeys.size) return [];
  const ur = await sbStore('/rest/v1/salesops_user_roles?active=is.true&select=user_id,role_key');
  return (ur.ok ? ur.data : []).filter(u => superKeys.has(u.role_key)).map(u => u.user_id);
}
async function resolveAuthUserId(email) {
  const r = await sbStore('/rest/v1/rpc/user_id_by_email', { method: 'POST', body: JSON.stringify({ p_email: email }) });
  if (!r.ok || r.data == null) return null;
  const v = r.data;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : (v[0]?.user_id_by_email || null);
  return v.user_id_by_email || null;
}

// ── channel cache (dispatch_channels is the canonical registry) ──
let _channels = null;
async function getChannels() {
  if (_channels) return _channels;
  const r = await sbPublic('/rest/v1/dispatch_channels?is_sale=eq.true&select=id,name,type&order=name.asc');
  _channels = r.ok ? r.data : [];
  return _channels;
}
async function channelName(id) { return (await getChannels()).find(c => c.id === id)?.name || null; }

// ── P&L channel families (mirror apps/odo/src/lib/families.js) + ad-platform attribution ──
const PNL_FAMILIES = [
  { key: 'website',  label: 'Website',          match: /website|shopify|web/i,                   ads: ['meta', 'google'] },
  { key: 'amazon',   label: 'Amazon',           match: /amazon/i,                                ads: ['amazon'] },
  { key: 'flipkart', label: 'Flipkart',         match: /flipkart/i,                              ads: [] },
  { key: 'quickcom', label: 'Quick-comm',       match: /blinkit|zepto|instamart|swiggy|quick/i,  ads: [] },
  { key: 'gtmt',     label: 'GT / MT',          match: /^(gt|mt)$|general trade|modern trade/i,  ads: [] },
  { key: 'longtail', label: 'Long-tail',        match: /cred|firstcry|peeko/i,                   ads: [] },
  { key: 'other',    label: 'Other / Internal', match: null,                                     ads: [] },
];
function pnlFamilyOf(name) {
  const n = name || '';
  for (const f of PNL_FAMILIES) { if (f.key === 'other') continue; if (f.match.test(n)) return f.key; }
  return 'other';
}

// ============================================================
// ADAPTERS — each implements fetch() + stage(); registered by adapter_kind.
// fetch({ env, channelId, channelName, cursor, windowTo, budget })
//   → { rows: NormLine[], cursorAfter, subreqs, partial }
// NormLine = { source_line_id, source_order_id, order_name, channel_sku, variant_title,
//              title, qty, gross_value, occurred_at, sale_date, order_status, is_cancelled, raw }
// ============================================================

// ── Shopify (Website) ──────────────────────────────────────────
const SHOPIFY_API_VERSION_DEFAULT = '2026-04';
let _shopToken = null, _shopTokenExp = 0;
async function getShopifyToken(env, force = false) {
  // Custom app (Admin → Develop apps): a static Admin API access token (shpat_…). Use it directly.
  if (env.SHOPIFY_ACCESS_TOKEN) return env.SHOPIFY_ACCESS_TOKEN;
  // Otherwise (Dev Dashboard app, as csops/ignition use): mint via the client-credentials grant.
  const now = Date.now();
  if (!force && _shopToken && now < _shopTokenExp - 60_000) return _shopToken;
  const res = await fetch(`https://${env.SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.SHOPIFY_CLIENT_ID, client_secret: env.SHOPIFY_CLIENT_SECRET }),
  }).catch(() => null);
  if (!res || !res.ok) { _shopToken = null; _shopTokenExp = 0; return null; }
  const data = await res.json().catch(() => null);
  if (!data?.access_token) { _shopToken = null; _shopTokenExp = 0; return null; }
  _shopToken = data.access_token; _shopTokenExp = now + (Number(data.expires_in) || 86399) * 1000;
  return _shopToken;
}
const shopifyAdapter = {
  kind: 'shopify', stgTable: 'stg_shopify', sourceKind: 'shopify',
  async fetch({ env, channelId, cursor, budget }) {
    if (!env.SHOPIFY_STORE_DOMAIN || !env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) throw new Error('Shopify not configured (set SHOPIFY_* secrets)');
    const ver = env.SHOPIFY_API_VERSION || SHOPIFY_API_VERSION_DEFAULT;
    const since = cursor || BACKFILL_START;
    const rows = [], orderRows = []; let after = null, hasNext = true, subreqs = 0, maxUpdated = since, partial = false;
    const gql = `query($q:String!,$after:String){ orders(first:50, query:$q, sortKey:UPDATED_AT, after:$after){ pageInfo{ hasNextPage endCursor } edges{ node{ id name createdAt updatedAt cancelledAt displayFinancialStatus currencyCode tags totalPriceSet{ shopMoney{ amount } } totalDiscountsSet{ shopMoney{ amount } } totalTaxSet{ shopMoney{ amount } } lineItems(first:100){ edges{ node{ id title quantity sku variantTitle originalTotalSet{ shopMoney{ amount currencyCode } } discountedTotalSet{ shopMoney{ amount } } taxLines{ priceSet{ shopMoney{ amount } } } } } } refunds{ id createdAt totalRefundedSet{ shopMoney{ amount } } refundLineItems(first:50){ edges{ node{ quantity subtotalSet{ shopMoney{ amount } } totalTaxSet{ shopMoney{ amount } } lineItem{ id sku title variantTitle } } } } } } } } }`;
    let token = await getShopifyToken(env); subreqs++;
    if (!token) throw new Error('Shopify auth failed (client credentials)');
    // Cap pages per run at 12 (~600 orders): the chunked staging inserts that follow each cost a
    // subrequest, so leaving headroom keeps pages+inserts under Cloudflare's 50-subrequest cap (and
    // the heavy widened query under the wall-clock). The cursor advances, so the next run continues.
    while (hasNext) {
      if (subreqs >= Math.min(budget, 12)) { partial = true; break; }
      const run = (tok) => fetch(`https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${ver}/graphql.json`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': tok },
        body: JSON.stringify({ query: gql, variables: { q: `updated_at:>='${since}'`, after } }),
      });
      let res = await run(token).catch(() => null); subreqs++;
      if (res && res.status === 401) { token = await getShopifyToken(env, true); subreqs++; if (!token) throw new Error('Shopify auth lost'); res = await run(token).catch(() => null); subreqs++; }
      if (!res || !res.ok) throw new Error(`Shopify ${res ? res.status : 'network'}`);
      const data = await res.json().catch(() => null);
      if (data?.errors?.length) throw new Error('Shopify GQL: ' + data.errors[0].message);
      const conn = data?.data?.orders;
      for (const oe of (conn?.edges || [])) {
        const o = oe.node;
        if (o.updatedAt && o.updatedAt > maxUpdated) maxUpdated = o.updatedAt;
        const fin = (o.displayFinancialStatus || '').toUpperCase();
        // CANCELLATION vs RETURN are distinct: cancelled = order voided (cancelledAt/VOIDED);
        // a refund on a NON-cancelled order is a return (captured below). REFUNDED no longer
        // marks the order cancelled — that would double-count against the returns it produces.
        const cancelled = !!o.cancelledAt || fin === 'VOIDED';
        const occurred = o.createdAt, saleDate = istDate(o.createdAt), cur = o.currencyCode || null;
        let oGross = 0;
        for (const le of (o.lineItems?.edges || [])) {
          const l = le.node;
          const gross = num(l.originalTotalSet?.shopMoney?.amount);              // pre-discount, tax-incl (IN store)
          const disc  = Math.max(0, gross - num(l.discountedTotalSet?.shopMoney?.amount));
          const tax   = (l.taxLines || []).reduce((a, t) => a + num(t.priceSet?.shopMoney?.amount), 0);
          oGross += gross;
          rows.push({
            source_line_id: l.id, source_order_id: o.id, order_name: o.name,
            channel_sku: l.sku || l.variantTitle || l.title, variant_title: l.variantTitle || null, title: l.title || null,
            qty: num(l.quantity), gross_value: gross, discount_value: disc, tax_value: tax, row_type: 'sale',
            occurred_at: occurred, sale_date: saleDate,
            order_status: o.displayFinancialStatus || null, is_cancelled: cancelled, raw: l,
          });
        }
        // order-grain row: gross = line-sum merchandise (pre-discount, reconciles to sales_fact);
        // discount/tax = ORDER-level totals (authoritative — order-level discount codes aren't
        // reflected in per-line discountedTotalSet, which undercounts; per-line stays for sales_fact).
        orderRows.push({
          source_order_id: o.id, refund_id: '', row_kind: 'order', sale_date: saleDate, order_name: o.name,
          gross: oGross, discount: num(o.totalDiscountsSet?.shopMoney?.amount), tax: num(o.totalTaxSet?.shopMoney?.amount),
          currency: cur, is_cancelled: cancelled, returned_value: 0,
          tags: Array.isArray(o.tags) ? o.tags : [], raw: { financial: o.displayFinancialStatus, total: o.totalPriceSet?.shopMoney?.amount },
        });
        // refunds → returns (skip on cancelled orders — the whole order is already excluded)
        if (!cancelled) {
          for (const rf of (o.refunds || [])) {
            const rDate = istDate(rf.createdAt || o.createdAt);
            orderRows.push({
              source_order_id: o.id, refund_id: rf.id, row_kind: 'return', sale_date: rDate, order_name: o.name,
              gross: 0, discount: 0, tax: 0, currency: cur, is_cancelled: false,
              returned_value: num(rf.totalRefundedSet?.shopMoney?.amount), tags: [], raw: { refund: rf.id },
            });
            let ri = 0;
            for (const rle of (rf.refundLineItems?.edges || [])) {
              const rl = rle.node, li = rl.lineItem || {};
              const amt = num(rl.subtotalSet?.shopMoney?.amount) + num(rl.totalTaxSet?.shopMoney?.amount);
              rows.push({
                source_line_id: `${rf.id}:${li.id || 'L'}:${ri++}`, source_order_id: o.id, order_name: o.name,
                channel_sku: li.sku || li.variantTitle || li.title, variant_title: li.variantTitle || null, title: li.title || null,
                qty: num(rl.quantity), gross_value: amt, discount_value: 0, tax_value: num(rl.totalTaxSet?.shopMoney?.amount), row_type: 'return',
                occurred_at: rf.createdAt || occurred, sale_date: rDate,
                order_status: 'REFUND', is_cancelled: false, raw: rl,
              });
            }
          }
        }
      }
      hasNext = !!conn?.pageInfo?.hasNextPage; after = conn?.pageInfo?.endCursor || null;
    }
    return { rows, orderRows, cursorAfter: maxUpdated, subreqs, partial };
  },
  async stage(rows, runId, channelId, fetched) {
    if (rows.length) {
      const body = rows.map(r => ({
        run_id: runId, channel_id: channelId, source_order_id: r.source_order_id, order_name: r.order_name,
        source_line_id: r.source_line_id, occurred_at: r.occurred_at, sale_date: r.sale_date,
        channel_sku: r.channel_sku, variant_title: r.variant_title, title: r.title,
        qty: Math.round(r.qty), gross_value: r.gross_value,
        discount_value: r.discount_value || 0, tax_value: r.tax_value || 0, row_type: r.row_type || 'sale',
        order_status: r.order_status, is_cancelled: r.is_cancelled, raw: r.raw,
      }));
      await sbInsertChunked('/rest/v1/stg_shopify?on_conflict=source_line_id', body, 'return=minimal,resolution=merge-duplicates');
    }
    await stageOrders((fetched && fetched.orderRows) || [], runId, channelId);
  },
};

// Order/return-grain staging (drives f_order_rollup). Shared by every order-grain adapter
// (Shopify now; Amazon/Snorkel later). Upserts on the (channel, order, kind, refund) unique index.
async function stageOrders(orderRows, runId, channelId) {
  if (!orderRows.length) return;
  const body = orderRows.map(o => ({
    run_id: runId, channel_id: channelId, source_order_id: o.source_order_id, refund_id: o.refund_id || '',
    row_kind: o.row_kind || 'order', sale_date: o.sale_date, order_name: o.order_name || null,
    gross: o.gross || 0, discount: o.discount || 0, tax: o.tax || 0, currency: o.currency || null,
    is_cancelled: !!o.is_cancelled, returned_value: o.returned_value || 0,
    tags: Array.isArray(o.tags) ? o.tags : [], raw: o.raw || null,
  }));
  await sbInsertChunked('/rest/v1/stg_orders?on_conflict=channel_id,source_order_id,row_kind,refund_id', body, 'return=minimal,resolution=merge-duplicates');
}

// ── GT/MT (reads Snorkel confirmed sales orders) ───────────────
const snorkelAdapter = {
  kind: 'snorkel_internal', stgTable: 'stg_snorkel', sourceKind: 'snorkel',
  async fetch({ channelId, channelName: cname, cursor }) {
    const sinceDate = (cursor || BACKFILL_START).slice(0, 10);
    // Sell-out guard (spec §10 / RULE-SALES-001): the snorkel adapter ingests ONLY channels
    // flagged feeds_odo_sellout (GT/MT) — where the Snorkel order is our sell-out signal.
    // QC/marketplace Snorkel orders are PRIMARY/sell-in (the platform's PO) and must NOT feed
    // Odo, else they double-count with the QC seller-report (secondary-sale) path.
    const cfgR = await sbStore(`/rest/v1/sales_channels?channel_key=eq.${encodeURIComponent(cname)}&select=feeds_odo_sellout&limit=1`);
    if (!(cfgR.ok && cfgR.data?.[0]?.feeds_odo_sellout)) return { rows: [], cursorAfter: sinceDate, subreqs: 1, partial: false };
    // confirmed + cancelled (cancelled nets out on recompute). channel_key = GT|MT.
    const sel = 'id,order_no,order_date,channel_key,status,confirmed_at,sales_order_lines(id,product,model,color,sku,qty,rate,discount_pct,gst_pct,taxable_value,gst_amount,line_total)';
    const r = await sbStore(`/rest/v1/sales_orders?status=in.(confirmed,cancelled)&channel_key=eq.${encodeURIComponent(cname)}&order_date=gte.${sinceDate}&select=${sel}&order=order_date.asc`);
    if (!r.ok) throw new Error('Snorkel read failed: ' + JSON.stringify(r.data));
    const rows = [], orderRows = []; let maxDate = sinceDate;
    for (const o of (r.data || [])) {
      if (o.order_date && o.order_date > maxDate) maxDate = o.order_date;
      const cancelled = o.status === 'cancelled';
      // Normalize to Shopify's basis: gross = PRE-discount, TAX-INCLUSIVE (taxable rate is ex-GST →
      // ×(1+gst%)); discount = the cut, also tax-incl; tax = the invoice GST (gst_amount). So
      // gross − discount ≈ line_total and gross − discount − tax ≈ taxable_value (ex-GST net).
      let og = 0, od = 0, ot = 0;
      for (const l of (o.sales_order_lines || [])) {
        const gpf = 1 + num(l.gst_pct) / 100;
        const base = num(l.qty) * num(l.rate);                          // pre-discount ex-GST
        const disc = base * (num(l.discount_pct) / 100);                // discount ex-GST
        const gross = base * gpf;                                       // pre-discount tax-incl
        const discIncl = disc * gpf;                                    // discount tax-incl
        const tax = num(l.gst_amount);                                  // GST on post-discount taxable
        og += gross; od += discIncl; ot += tax;
        rows.push({
          source_line_id: String(l.id), source_order_id: o.order_no,
          channel_sku: l.sku || [l.product, l.model, l.color].filter(Boolean).join(' '),
          title: [l.product, l.model, l.color].filter(Boolean).join(' '),
          qty: num(l.qty), gross_value: gross, discount_value: discIncl, tax_value: tax,
          occurred_at: o.order_date, sale_date: o.order_date, order_status: o.status, is_cancelled: cancelled, raw: l,
        });
      }
      orderRows.push({
        source_order_id: o.order_no, refund_id: '', row_kind: 'order', sale_date: o.order_date, order_name: o.order_no,
        gross: og, discount: od, tax: ot, currency: 'INR', is_cancelled: cancelled, returned_value: 0, tags: [],
      });
    }
    return { rows, orderRows, cursorAfter: maxDate, subreqs: 1, partial: false };
  },
  async stage(rows, runId, channelId, fetched) {
    if (rows.length) {
      const body = rows.map(r => ({
        run_id: runId, channel_id: channelId, source_order_id: r.source_order_id, source_line_id: r.source_line_id,
        sale_date: r.sale_date, channel_sku: r.channel_sku, title: r.title,
        qty: Math.round(r.qty), gross_value: r.gross_value, discount_value: r.discount_value || 0, tax_value: r.tax_value || 0, row_type: 'sale',
        order_status: r.order_status, is_cancelled: r.is_cancelled, raw: r.raw,
      }));
      await sbInsertChunked('/rest/v1/stg_snorkel?on_conflict=source_line_id', body, 'return=minimal,resolution=merge-duplicates');
    }
    await stageOrders((fetched && fetched.orderRows) || [], runId, channelId);
  },
};

// ── QC (file upload; cron no-op — ingestion is via uploadReport) ──
const qcAdapter = {
  kind: 'qc_upload', stgTable: 'stg_qc', sourceKind: 'qc',
  async fetch() { return { rows: [], cursorAfter: null, subreqs: 0, partial: false }; },
};

// ── QC via Google Sheet (service-account read; reuses the QC stg_qc tail) ──
// Reads a private sheet the team maintains daily. The SA (GOOGLE_SA_JSON) must be shared
// (Viewer) on the sheet. Per-channel config in connector_config.config:
//   { spreadsheet_id, tab, columns: { date, sku, title, units, gross } }  (column = header text)
function _b64urlBytes(buf) {
  let s = ''; const a = new Uint8Array(buf);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const _b64urlStr = (str) => _b64urlBytes(new TextEncoder().encode(str));
function _pemToPkcs8(pem) {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s+/g, '');
  const bin = atob(body); const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
let _gTokById = {};   // scope → { token, exp } — one cached token per scope
async function googleToken(env, scope) {
  if (!env.GOOGLE_SA_JSON) throw new Error('Google not configured (set GOOGLE_SA_JSON secret)');
  const now = Math.floor(Date.now() / 1000);
  const c = _gTokById[scope];
  if (c && now < c.exp - 60) return c.token;
  const sa = JSON.parse(env.GOOGLE_SA_JSON);
  const header = _b64urlStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = _b64urlStr(JSON.stringify({
    iss: sa.client_email, scope,
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const signingInput = `${header}.${claim}`;
  const key = await crypto.subtle.importKey('pkcs8', _pemToPkcs8(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${signingInput}.${_b64urlBytes(sig)}` }),
  });
  const t = await res.json().catch(() => ({}));
  if (!t.access_token) throw new Error('Google token failed: ' + JSON.stringify(t).slice(0, 160));
  _gTokById[scope] = { token: t.access_token, exp: now + (Number(t.expires_in) || 3600) };
  return t.access_token;
}
const googleSheetsToken = (env) => googleToken(env, 'https://www.googleapis.com/auth/spreadsheets.readonly');
const gsheetAdapter = {
  kind: 'qc_gsheet', stgTable: 'stg_qc', sourceKind: 'qc',
  async fetch({ env, config }) {
    const cfg = config || {};
    if (!cfg.spreadsheet_id || !cfg.tab) throw new Error('gsheet config missing spreadsheet_id/tab (set connector_config.config)');
    if (!cfg.columns || !cfg.columns.sku || !cfg.columns.units) throw new Error('gsheet config.columns must map at least sku + units');
    const token = await googleSheetsToken(env);
    // Resolve the configured tab against the sheet's ACTUAL tab titles (ignoring case/spaces/punct), so
    // config drift (e.g. "InstamartData" vs the real "Instamart Data") can't break the pull, and use the
    // real title SINGLE-QUOTED so a space in the name doesn't break A1-range parsing ("Unable to parse range").
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const metaR = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${cfg.spreadsheet_id}?fields=sheets.properties.title`, { headers: { Authorization: `Bearer ${token}` } });
    if (!metaR.ok) throw new Error(`Sheets meta ${metaR.status}: ${(await metaR.text().catch(() => '')).slice(0, 160)}`);
    const titles = ((await metaR.json()).sheets || []).map(s => s.properties && s.properties.title).filter(Boolean);
    const tab = titles.find(t => norm(t) === norm(cfg.tab));
    if (!tab) throw new Error(`gsheet tab "${cfg.tab}" not found in sheet — available tabs: ${titles.join(' | ')}`);
    const range = encodeURIComponent(`'${tab.replace(/'/g, "''")}'!A:ZZ`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${cfg.spreadsheet_id}/values/${range}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Sheets API ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}`);
    const j = await r.json();
    const grid = (j.values || []).map(row => row.map(c => (c == null ? '' : String(c))));
    const rows = gridToQcRows(grid, cfg.columns, todayISO());
    return { rows, cursorAfter: null, subreqs: 3, partial: false };
  },
  async stage(rows, runId, channelId) {
    if (!rows.length) return;
    const from = rows.reduce((m, x) => x.sale_date < m ? x.sale_date : m, rows[0].sale_date);
    const to   = rows.reduce((m, x) => x.sale_date > m ? x.sale_date : m, rows[0].sale_date);
    const b = await sbSales('/rest/v1/upload_batch', {
      method: 'POST', prefer: 'return=representation',
      body: JSON.stringify({ channel_id: channelId, storage_path: 'gsheet', file_name: 'google-sheet', report_period_from: from, report_period_to: to, status: 'parsed' }),
    });
    const batchId = (b.ok && b.data[0]) ? b.data[0].id : null;
    // supersede the channel's staged rows over the pulled range (the sheet is the source of truth)
    await sbSales(`/rest/v1/stg_qc?channel_id=eq.${channelId}&sale_date=gte.${from}&sale_date=lte.${to}`, { method: 'DELETE', prefer: 'return=minimal' });
    const body = rows.map(r => ({ channel_id: channelId, upload_batch_id: batchId, row_no: r.row_no, sale_date: r.sale_date, channel_sku: r.channel_sku, title: r.title, qty: Math.round(r.qty), gross_value: r.gross_value, is_cancelled: false, raw: r.raw }));
    await sbInsertChunked('/rest/v1/stg_qc?on_conflict=upload_batch_id,row_no', body, 'return=minimal,resolution=merge-duplicates');
  },
};

// ── Amazon (SP-API · LWA-only · Reports API) ───────────────────
// Auth = LWA refresh-token grant (AWS SigV4 dropped Oct 2023). Data via the Reports API
// (NOT Orders — getOrders is ~1/min + N+1 getOrderItems → blows the 50-subrequest cap).
// One GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL report = order-line history over a
// window. Async: create → poll → ingest, carried ACROSS cron ticks via connector_config.config:
//   { region_host, marketplace_id, backfill_start, columns, pending_report_id, pending_through }
let _amzToken = null, _amzTokenExp = 0;
async function getAmazonToken(env) {
  if (!env.AMAZON_SP_REFRESH_TOKEN || !env.AMAZON_LWA_CLIENT_ID || !env.AMAZON_LWA_CLIENT_SECRET)
    throw new Error('Amazon not configured (set AMAZON_SP_REFRESH_TOKEN + AMAZON_LWA_CLIENT_ID/SECRET)');
  const now = Date.now();
  if (_amzToken && now < _amzTokenExp - 60_000) return _amzToken;
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: env.AMAZON_SP_REFRESH_TOKEN, client_id: env.AMAZON_LWA_CLIENT_ID, client_secret: env.AMAZON_LWA_CLIENT_SECRET }),
  });
  const t = await res.json().catch(() => ({}));
  if (!t.access_token) throw new Error('Amazon token failed: ' + JSON.stringify(t).slice(0, 160));
  _amzToken = t.access_token; _amzTokenExp = now + (Number(t.expires_in) || 3600) * 1000;
  return _amzToken;
}
// Merge-write the pending state into connector_config.config (the whole jsonb is replaced, so merge first).
async function patchConnectorConfig(channelId, config, patch) {
  const next = { ...(config || {}), ...patch };
  await sbSales(`/rest/v1/connector_config?channel_id=eq.${channelId}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ config: next }) });
}
// Download a report document (pre-signed URL), gunzipping if GZIP-compressed → text.
async function fetchAmazonDoc(doc) {
  const res = await fetch(doc.url);
  if (!res.ok) throw new Error('Amazon doc download ' + res.status);
  if (String(doc.compressionAlgorithm || '').toUpperCase() === 'GZIP') {
    const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).text();
  }
  return await res.text();
}
// item-price is tax-INCLUSIVE for the IN marketplace (confirmed empirically S164: per-unit gross
// runs ~8% below Website on high-volume SKUs, not the ~15% an ex-tax basis would show) → same basis
// as Shopify's originalTotalSet. item-tax = the GST within it; item-promotion-discount = the discount.
const AMZ_COLUMNS_DEFAULT = { date: 'purchase-date', sku: 'sku', title: 'product-name', units: 'quantity', gross: 'item-price', tax: 'item-tax', discount: 'item-promotion-discount', status: 'order-status', order_id: 'amazon-order-id' };
const AMZ_REPORT_TYPE = 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL';
// HARD LIMIT: this report can only be requested for ≤30 days per call ("Date range exceeded"
// otherwise). So we chunk: one ≤30-day window per report, walking the cursor forward.
const AMZ_WINDOW_MS = 30 * 24 * 3600 * 1000;
async function createAmazonReport(host, H, mkt, startISO, endISO, reportType = AMZ_REPORT_TYPE) {
  const cr = await fetch(`${host}/reports/2021-06-30/reports`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ reportType, marketplaceIds: [mkt], dataStartTime: startISO, dataEndTime: endISO }),
  });
  if (!cr.ok) throw new Error(`Amazon createReport ${cr.status}: ${(await cr.text().catch(() => '')).slice(0, 200)}`);
  const cj = await cr.json();
  if (!cj.reportId) throw new Error('Amazon createReport: no reportId — ' + JSON.stringify(cj).slice(0, 160));
  return cj.reportId;
}
// ── Amazon Finances (SP-API listFinancialEvents) → discount/GST/returns ────────
// The all-orders report carries gross+units+cancellations but the IN marketplace ships
// item-tax/promotion BLANK. The Finances API exposes Principal/Tax/Promotion per order-item
// (+ refund events). Stored in stg_amazon_fin; surfaced via the v_staged amazon_fin branch.
// Own posted-date cursor (config.fin_cursor) — independent of the report cursor.
const AMZ_FIN_WINDOW_MS = 5 * 24 * 3600 * 1000;   // posted-date windows
const AMZ_FIN_MAX_PAGES = 15;                      // per window — financialEvents pages ALL event types, not just ours
const AMZ_FIN_SUBREQ_BUDGET = 30;                  // finance budget/tick (report uses ~5; total stays <45). Loops windows to drain backfill.
const AMZ_FIN_TRAILING_MS = 60 * 24 * 3600 * 1000; // always re-sweep the last 60d each tick (refunds/returns post weeks after the sale)
const AMZ_FIN_MIN_WINDOW_MS = 24 * 3600 * 1000;    // shrink floor — a dense window halves down to 1 day so it can drain under the page cap
function amzCharge(list, type) { let s = 0; for (const c of (list || [])) if (c.ChargeType === type) s += num(c.ChargeAmount?.CurrencyAmount); return s; }
function amzPromo(list) { let s = 0; for (const p of (list || [])) s += num(p.PromotionAmount?.CurrencyAmount); return s; }
// One financialEvents payload → flat finance rows (aggregated by stageAmazonFinance).
function parseAmazonFinance(fe) {
  const out = [];
  for (const ev of (fe?.ShipmentEventList || [])) {
    const oid = ev.AmazonOrderId, pd = ev.PostedDate ? istDate(ev.PostedDate) : null;
    if (!oid || !pd) continue;
    for (const it of (ev.ShipmentItemList || [])) {
      const sku = it.SellerSKU; if (!sku) continue;
      out.push({ amazon_order_id: oid, seller_sku: sku, event_type: 'shipment', posted_date: pd,
        qty: Math.abs(num(it.QuantityShipped)),
        principal: amzCharge(it.ItemChargeList, 'Principal'), tax: amzCharge(it.ItemChargeList, 'Tax'),
        promo: Math.abs(amzPromo(it.PromotionList)), raw: it });
    }
  }
  for (const ev of (fe?.RefundEventList || [])) {
    const oid = ev.AmazonOrderId, pd = ev.PostedDate ? istDate(ev.PostedDate) : null;
    if (!oid || !pd) continue;
    for (const it of (ev.ShipmentItemAdjustmentList || [])) {
      const sku = it.SellerSKU; if (!sku) continue;
      out.push({ amazon_order_id: oid, seller_sku: sku, event_type: 'refund', posted_date: pd,
        qty: Math.abs(num(it.QuantityShipped)),
        principal: Math.abs(amzCharge(it.ItemChargeAdjustmentList, 'Principal')),
        tax: Math.abs(amzCharge(it.ItemChargeAdjustmentList, 'Tax')),
        promo: Math.abs(amzPromo(it.PromotionAdjustmentList)), raw: it });
    }
  }
  return out;
}
// Page ONE posted-date window fully (following NextToken), pushing parsed events into `out`.
// Returns { done, subreqs, reason }: done=true only when the window fully drained. reason
// 'pagecap' = hit AMZ_FIN_MAX_PAGES (caller should shrink + retry the same start); 'budget' = ran
// out of the tick's subreq allowance; 'throttled' = 429. A capped window is NOT complete — its
// cursor must not advance past it (retried next tick; upsert makes the overlap idempotent).
async function drainFinanceWindow(host, H, startISO, endISO, out, budget) {
  let nextToken = null, pages = 0, subreqs = 0;
  do {
    if (subreqs >= budget) return { done: false, subreqs, reason: 'budget' };
    const qs = nextToken
      ? `MaxResultsPerPage=100&NextToken=${encodeURIComponent(nextToken)}`
      : `MaxResultsPerPage=100&PostedAfter=${encodeURIComponent(startISO)}&PostedBefore=${encodeURIComponent(endISO)}`;
    const r = await fetch(`${host}/finances/v0/financialEvents?${qs}`, { headers: H }); subreqs++;
    if (r.status === 429) return { done: false, subreqs, reason: 'throttled' };  // retry the window next tick
    if (!r.ok) throw new Error(`Amazon finances ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}`);
    const j = await r.json();
    out.push(...parseAmazonFinance(j.payload?.FinancialEvents || {}));
    nextToken = j.payload?.NextToken || null; pages++;
    if (nextToken && pages >= AMZ_FIN_MAX_PAGES) return { done: false, subreqs, reason: 'pagecap' };
  } while (nextToken);
  return { done: true, subreqs, reason: 'drained' };
}

// Drain [fromISO, toISO] into `out`, walking AMZ_FIN_WINDOW_MS windows and HALVING a window (down to
// AMZ_FIN_MIN_WINDOW_MS) when it can't page within AMZ_FIN_MAX_PAGES — this breaks the dense-window
// "poison" that wedged fin_cursor at 2025-07 (a 5-day window there needs ≥15 pages, so it never
// drained and the cursor never advanced). Only a fully-drained window's rows are committed; a
// re-drained overlap is idempotent (caller upserts). Returns { throughISO (furthest drained end, or
// null), subreqs, complete (whole range drained within budget) }.
async function drainFinanceRange(host, H, fromISO, toISO, out, budget) {
  let cursorMs = Date.parse(fromISO) || 0; const toMs = Date.parse(toISO) || 0;
  let subreqs = 0, throughISO = null;
  while (cursorMs < toMs) {
    if (subreqs >= budget) return { throughISO, subreqs, complete: false };
    let winMs = AMZ_FIN_WINDOW_MS, drained = false, wEndMs = 0;
    for (;;) {
      wEndMs = Math.min(cursorMs + winMs, toMs);
      const trial = [];
      const w = await drainFinanceWindow(host, H, new Date(cursorMs).toISOString(), new Date(wEndMs).toISOString(), trial, budget - subreqs);
      subreqs += w.subreqs;
      if (w.done) { out.push(...trial); drained = true; break; }
      if (w.reason !== 'pagecap' || winMs <= AMZ_FIN_MIN_WINDOW_MS || subreqs >= budget) break;  // can't shrink / out of budget
      winMs = Math.max(AMZ_FIN_MIN_WINDOW_MS, Math.floor(winMs / 2));                             // halve + retry same start
    }
    if (!drained) return { throughISO, subreqs, complete: false };
    throughISO = new Date(wEndMs).toISOString(); cursorMs = wEndMs;
  }
  return { throughISO, subreqs, complete: true };
}

// Two passes, sharing the per-tick budget. (1) TRAILING — always re-sweep the last AMZ_FIN_TRAILING_MS
// days so recent refunds/returns land promptly (they post weeks after the sale), INDEPENDENT of how far
// the deep backfill has crawled. (2) BACKFILL — walk fin_cursor forward up to the trailing edge, with
// adaptive shrink. Only pass 2 advances fin_cursor; pass 1 relies on idempotent upserts. PostedBefore
// must be ≥2min ago.
async function fetchAmazonFinance(host, H, cfg, nowMs) {
  const events = []; let subreqs = 0, advancedTo = null, partial = false;
  const endCap = nowMs - 120_000;
  const trailStartMs = endCap - AMZ_FIN_TRAILING_MS;
  // Pass 1 — trailing recent sweep (every tick).
  const t = await drainFinanceRange(host, H, new Date(trailStartMs).toISOString(), new Date(endCap).toISOString(), events, AMZ_FIN_SUBREQ_BUDGET - subreqs);
  subreqs += t.subreqs; if (!t.complete) partial = true;
  // Pass 2 — historical backfill from fin_cursor up to the trailing edge (only with leftover budget).
  const cursorISO = cfg.fin_cursor || cfg.backfill_start || BACKFILL_START;
  if (subreqs < AMZ_FIN_SUBREQ_BUDGET && (Date.parse(cursorISO) || nowMs) < trailStartMs) {
    const b = await drainFinanceRange(host, H, cursorISO, new Date(trailStartMs).toISOString(), events, AMZ_FIN_SUBREQ_BUDGET - subreqs);
    subreqs += b.subreqs; if (b.throughISO) advancedTo = b.throughISO; if (!b.complete) partial = true;
  }
  return { events, finCursorAfter: advancedTo, partial, subreqs };
}

// Report state machine (create→poll→ingest, one ≤30-day window/tick). Returns the rows for this
// window + the config it should persist (configAfter) so the caller can merge fin_cursor in one write.
async function amazonReportPhase(host, H, mkt, columns, cfg, channelId, nowMs, cursor) {
  let subreqs = 1; // token (fetched by caller; counted here for parity with prior logs)
  if (cfg.pending_report_id) {
    const pr = await fetch(`${host}/reports/2021-06-30/reports/${cfg.pending_report_id}`, { headers: H }); subreqs++;
    if (!pr.ok) throw new Error(`Amazon getReport ${pr.status}: ${(await pr.text().catch(() => '')).slice(0, 160)}`);
    const rep = await pr.json();
    const st = rep.processingStatus;
    if (st === 'IN_QUEUE' || st === 'IN_PROGRESS') return { rows: [], cursorAfter: null, subreqs, partial: true, configAfter: cfg };
    if (st === 'CANCELLED' || st === 'FATAL') { await patchConnectorConfig(channelId, cfg, { pending_report_id: null, pending_through: null }); throw new Error(`Amazon report ${st}`); }
    const dr = await fetch(`${host}/reports/2021-06-30/documents/${rep.reportDocumentId}`, { headers: H }); subreqs++;
    if (!dr.ok) throw new Error(`Amazon getDocument ${dr.status}`);
    const doc = await dr.json();
    const text = await fetchAmazonDoc(doc); subreqs++;
    if (/date range exceeded/i.test(text)) throw new Error('Amazon: ' + text.trim().slice(0, 120));
    const grid = text.split(/\r?\n/).filter(l => l.length).map(l => l.split('\t'));
    const rows = grid.length >= 2 ? gridToQcRows(grid, columns, todayISO()) : [];
    const windowEnd = cfg.pending_through;
    const endMs = Date.parse(windowEnd || '') || 0;
    let partial = false, next = { pending_report_id: null, pending_through: null };
    if (endMs && endMs < nowMs - 60_000) {
      const nextEnd = new Date(Math.min(endMs + AMZ_WINDOW_MS, nowMs)).toISOString();
      try { const rid = await createAmazonReport(host, H, mkt, windowEnd, nextEnd); subreqs++; next = { pending_report_id: rid, pending_through: nextEnd }; partial = true; }
      catch (_) { /* leave pending cleared — next tick re-creates from the advanced cursor */ }
    }
    return { rows, cursorAfter: windowEnd, subreqs, partial, configAfter: { ...cfg, ...next } };
  }
  const startISO = cursor || cfg.backfill_start || BACKFILL_START;
  const startMs = Date.parse(startISO) || nowMs;
  const endISO = new Date(Math.min(startMs + AMZ_WINDOW_MS, nowMs)).toISOString();
  const rid = await createAmazonReport(host, H, mkt, startISO, endISO); subreqs++;
  return { rows: [], cursorAfter: null, subreqs, partial: true, configAfter: { ...cfg, pending_report_id: rid, pending_through: endISO } };
}

// ── Amazon FBA customer-returns report → stg_amazon_returns (the RTV classification source) ──
// Async report (create→poll→download), own cursor in config (returns_cursor / returns_pending_*),
// independent of the orders + finance phases. Low volume → walks one ≤30-day window per cron tick;
// it does NOT drive the workflow loop (returns « orders). After staging, the refund events are
// (re)classified rto/rtv via sales.classify_amazon_returns.
const AMZ_RETURNS_REPORT_TYPE = 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA';
const AMZ_RETURNS_WINDOW_MS = 30 * 24 * 3600 * 1000;
function gridToReturnRows(grid) {
  if (!grid || grid.length < 2) return [];
  const header = grid[0].map(h => String(h).trim());
  const idx = n => header.findIndex(h => h.toLowerCase() === n.toLowerCase());
  const ci = { date: idx('return-date'), order: idx('order-id'), sku: idx('sku'), asin: idx('asin'), qty: idx('quantity'), disp: idx('detailed-disposition'), reason: idx('reason'), status: idx('status') };
  if (ci.order < 0 || ci.sku < 0) return [];               // unexpected shape → skip safely
  const rows = [];
  for (let r = 1; r < grid.length; r++) {
    const line = grid[r]; const oid = String(line[ci.order] ?? '').trim(); if (!oid) continue;
    const rd = ci.date >= 0 ? String(line[ci.date] ?? '').trim() : '';
    rows.push({
      source_order_id: oid,
      channel_sku: ci.sku >= 0 ? (String(line[ci.sku] ?? '').trim() || null) : null,
      asin: ci.asin >= 0 ? (String(line[ci.asin] ?? '').trim() || null) : null,
      return_date: rd ? (rd.includes('T') ? istDate(rd) : parseSheetDate(rd)) : null,
      qty: ci.qty >= 0 ? Math.round(num(line[ci.qty])) : 0,
      disposition: ci.disp >= 0 ? (String(line[ci.disp] ?? '').trim() || null) : null,
      reason: ci.reason >= 0 ? (String(line[ci.reason] ?? '').trim() || null) : null,
      status: ci.status >= 0 ? (String(line[ci.status] ?? '').trim() || null) : null,
      raw: { line },
    });
  }
  return rows;
}
// One returns window: create→poll→download, advancing returns_cursor. NEVER throws (returns are
// auxiliary — a failure must not break the sell-out pipeline); errors return the cfg unchanged.
async function amazonReturnsPhase(host, H, mkt, cfg, nowMs) {
  let subreqs = 0;
  try {
    if (cfg.returns_pending_report_id) {
      const pr = await fetch(`${host}/reports/2021-06-30/reports/${cfg.returns_pending_report_id}`, { headers: H }); subreqs++;
      const rep = await pr.json().catch(() => ({}));
      const st = rep.processingStatus;
      if (st === 'IN_QUEUE' || st === 'IN_PROGRESS') return { rows: [], subreqs, configAfter: cfg };
      const through = cfg.returns_pending_through || null;
      if (st !== 'DONE' || !rep.reportDocumentId) {        // CANCELLED/FATAL → skip the window, advance
        return { rows: [], subreqs, configAfter: { ...cfg, returns_pending_report_id: null, returns_window_from: null, returns_pending_through: null, returns_cursor: through || cfg.returns_cursor } };
      }
      const dr = await fetch(`${host}/reports/2021-06-30/documents/${rep.reportDocumentId}`, { headers: H }); subreqs++;
      const doc = await dr.json().catch(() => ({}));
      const text = await fetchAmazonDoc(doc); subreqs++;
      const grid = text.split(/\r?\n/).filter(l => l.length).map(l => l.split('\t'));
      const rows = gridToReturnRows(grid);
      // queue the next window if not caught up to ~now
      let next = { returns_pending_report_id: null, returns_window_from: null, returns_pending_through: null, returns_cursor: through || cfg.returns_cursor };
      const ns = Date.parse(through || cfg.returns_cursor || cfg.backfill_start || BACKFILL_START);
      if (ns && ns < nowMs - 120000) {
        const nsISO = new Date(ns).toISOString();
        const neISO = new Date(Math.min(ns + AMZ_RETURNS_WINDOW_MS, nowMs - 120000)).toISOString();
        const rid = await createAmazonReport(host, H, mkt, nsISO, neISO, AMZ_RETURNS_REPORT_TYPE); subreqs++;
        next = { returns_pending_report_id: rid, returns_window_from: nsISO, returns_pending_through: neISO, returns_cursor: through || cfg.returns_cursor };
      }
      return { rows, subreqs, configAfter: { ...cfg, ...next } };
    }
    // no pending → create the next window from returns_cursor
    const startISO = cfg.returns_cursor || cfg.backfill_start || BACKFILL_START;
    const startMs = Date.parse(startISO);
    if (!startMs || startMs >= nowMs - 120000) return { rows: [], subreqs, configAfter: cfg };   // caught up
    const endISO = new Date(Math.min(startMs + AMZ_RETURNS_WINDOW_MS, nowMs - 120000)).toISOString();
    const rid = await createAmazonReport(host, H, mkt, startISO, endISO, AMZ_RETURNS_REPORT_TYPE); subreqs++;
    return { rows: [], subreqs, configAfter: { ...cfg, returns_pending_report_id: rid, returns_window_from: startISO, returns_pending_through: endISO } };
  } catch (e) {
    return { rows: [], subreqs, configAfter: cfg, error: String(e?.message || e) };
  }
}

// ── Amazon settlement report (GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2) → fees + true payout ──
// SCHEDULED reports — Amazon auto-generates one per disbursement (~14d). We LIST DONE reports and
// download NEW ones (tracked by reportId in config.settlement_seen), not create→poll. Each file's
// rows go to stg_amazon_settlement; recompute_settlement builds the per-(settlement,date,product)
// fact (true net payout + fee decomposition). Reconciliation-grade; never breaks the sell-out pipeline.
const AMZ_SETTLEMENT_REPORT_TYPE = 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2';
const AMZ_SETTLEMENT_MAX_PER_TICK = 2;            // download ≤2 new settlements/tick (backfill walks chronologically)
// Settlement dates come as "dd.MM.yyyy HH:mm:ss UTC" (IN format) OR "yyyy-MM-dd…". Parse the
// CALENDAR DATE robustly and VALIDATE it — a bad date must return null, never a malformed string
// (istDate's fallback slices a bad "dd.MM.yyyy" to "31.12.2025" → Postgres 22008 on insert).
function parseSettleDate(s) {
  const v = String(s || '').trim(); if (!v) return null;
  let iso = null;
  const dm = v.match(/^(\d{2})\.(\d{2})\.(\d{4})/);            // dd.MM.yyyy (with/without trailing time)
  if (dm) iso = `${dm[3]}-${dm[2]}-${dm[1]}`;
  else if (/^\d{4}-\d{2}-\d{2}/.test(v)) iso = v.slice(0, 10); // yyyy-MM-dd[…]
  else { try { const d = new Date(v.replace(' UTC', 'Z').replace(' ', 'T')); if (!isNaN(d)) iso = d.toISOString().slice(0, 10); } catch {} }
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const dt = new Date(iso + 'T00:00:00Z');                    // reject out-of-range (month 13 / day 32 …)
  if (isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}
function gridToSettlementRows(grid) {
  if (!grid || grid.length < 2) return [];
  const header = grid[0].map(h => String(h).trim().toLowerCase());
  const ix = n => header.indexOf(n);
  const c = { sid: ix('settlement-id'), dep: ix('deposit-date'), tot: ix('total-amount'),
    txn: ix('transaction-type'), oid: ix('order-id'), sku: ix('sku'), at: ix('amount-type'),
    ad: ix('amount-description'), amt: ix('amount'), qty: ix('quantity-purchased'), pd: ix('posted-date') };
  if (c.sid < 0 || c.amt < 0) return [];                       // unexpected shape → skip safely
  const rows = [];
  for (let r = 1; r < grid.length; r++) {
    const L = grid[r];
    const sid = String(L[c.sid] ?? '').trim(); if (!sid) continue;
    const txn = c.txn >= 0 ? String(L[c.txn] ?? '').trim() : '';
    const oid = c.oid >= 0 ? String(L[c.oid] ?? '').trim() : '';
    const isHeader = !txn && !oid;                              // settlement summary row (carries total-amount/deposit)
    rows.push({
      settlement_id: sid, line_no: r,
      posted_date: c.pd >= 0 ? parseSettleDate(L[c.pd]) : null,
      deposit_date: c.dep >= 0 ? parseSettleDate(L[c.dep]) : null,
      transaction_type: isHeader ? '--settlement--' : (txn || null),
      order_id: oid || null,
      sku: c.sku >= 0 ? (String(L[c.sku] ?? '').trim() || null) : null,
      amount_type: c.at >= 0 ? (String(L[c.at] ?? '').trim() || null) : null,
      amount_description: c.ad >= 0 ? (String(L[c.ad] ?? '').trim() || null) : null,
      amount: isHeader && c.tot >= 0 ? num(L[c.tot]) : num(L[c.amt]),
      quantity: c.qty >= 0 ? Math.round(num(L[c.qty])) : 0,
      raw: { line: L },
    });
  }
  return rows;
}
async function amazonSettlementPhase(host, H, cfg, nowMs) {
  let subreqs = 0;
  try {
    const seen = new Set(cfg.settlement_seen || []);
    const lr = await fetch(`${host}/reports/2021-06-30/reports?reportTypes=${AMZ_SETTLEMENT_REPORT_TYPE}&processingStatuses=DONE&pageSize=100`, { headers: H }); subreqs++;
    if (!lr.ok) return { settlements: [], subreqs, configAfter: cfg, error: `listReports ${lr.status}: ${(await lr.text().catch(() => '')).slice(0, 120)}` };
    const lj = await lr.json().catch(() => ({}));
    const fresh = (lj.reports || []).filter(r => r.reportDocumentId && !seen.has(r.reportId))
      .sort((a, b) => String(a.dataEndTime || '').localeCompare(String(b.dataEndTime || '')));   // oldest first
    const settlements = [];
    for (const rep of fresh.slice(0, AMZ_SETTLEMENT_MAX_PER_TICK)) {
      if (subreqs >= 40) break;
      const dr = await fetch(`${host}/reports/2021-06-30/documents/${rep.reportDocumentId}`, { headers: H }); subreqs++;
      if (!dr.ok) continue;                                     // leave unseen → retry next tick
      const doc = await dr.json().catch(() => ({}));
      const text = await fetchAmazonDoc(doc); subreqs++;
      const grid = text.split(/\r?\n/).filter(l => l.length).map(l => l.split('\t'));
      const rows = gridToSettlementRows(grid);
      const sid = rows.length ? rows[0].settlement_id : rep.reportId;
      settlements.push({ settlement_id: sid, report_id: rep.reportId, rows });
    }
    // NB: settlement_seen is marked in stage() AFTER a successful insert+recompute, NOT here — a
    // staging failure must leave the report unseen so it's retried next tick (no silent data loss).
    return { settlements, subreqs, configAfter: cfg };
  } catch (e) {
    return { settlements: [], subreqs, configAfter: cfg, error: String(e?.message || e) };
  }
}
// Per settlement: idempotent supersede in staging + recompute its fact rows. A settlement is marked
// SEEN only after it succeeds — a failure leaves it unseen so the next tick retries it (no data loss).
async function stageAmazonSettlement(settlements, runId, channelId) {
  const ok = [];
  for (const st of (settlements || [])) {
    try {
      if (st.rows && st.rows.length) {
        await sbSales(`/rest/v1/stg_amazon_settlement?settlement_id=eq.${encodeURIComponent(st.settlement_id)}`, { method: 'DELETE', prefer: 'return=minimal' });
        const body = st.rows.map(r => ({ run_id: runId, channel_id: channelId, settlement_id: r.settlement_id, line_no: r.line_no,
          posted_date: r.posted_date, deposit_date: r.deposit_date, transaction_type: r.transaction_type, order_id: r.order_id,
          sku: r.sku, amount_type: r.amount_type, amount_description: r.amount_description, amount: r.amount, quantity: r.quantity, raw: r.raw }));
        await sbInsertChunked('/rest/v1/stg_amazon_settlement', body, 'return=minimal');
        await rpcSales('recompute_settlement', { p_settlement_id: st.settlement_id });
      }
      if (st.report_id) ok.push(st.report_id);                 // success (incl. an empty file) → mark seen
    } catch (_) { /* leave unseen → retried next tick */ }
  }
  if (ok.length) {
    const cur = await sbSales(`/rest/v1/connector_config?channel_id=eq.${channelId}&select=config`);
    const cfg = (cur.ok && cur.data && cur.data[0] && cur.data[0].config) || {};
    await patchConnectorConfig(channelId, cfg, { settlement_seen: [...new Set([...(cfg.settlement_seen || []), ...ok])] });
  }
}

const amazonAdapter = {
  kind: 'amazon_spapi', stgTable: 'stg_amazon', sourceKind: 'amazon',
  async fetch({ env, channelId, cursor, config }) {
    const cfg = config || {};
    const host = cfg.region_host || 'https://sellingpartnerapi-eu.amazon.com'; // India (A21TJRUUN4KGV) = eu host
    const mkt = cfg.marketplace_id;
    if (!mkt) throw new Error('amazon config missing marketplace_id (set connector_config.config)');
    const columns = cfg.columns || AMZ_COLUMNS_DEFAULT;
    const token = await getAmazonToken(env);
    const H = { Authorization: `Bearer ${token}`, 'x-amz-access-token': token, 'Content-Type': 'application/json' };
    const nowMs = Date.now();
    const rep = await amazonReportPhase(host, H, mkt, columns, cfg, channelId, nowMs, cursor);
    // Finance phase — cheap (≤AMZ_FIN_MAX_PAGES pages). Must never break the orders pipeline.
    let finance = { events: [] }, finSub = 0, configAfter = rep.configAfter;
    try {
      const fw = await fetchAmazonFinance(host, H, configAfter, nowMs);
      finSub = fw.subreqs; finance = { events: fw.events };
      if (fw.finCursorAfter) configAfter = { ...configAfter, fin_cursor: fw.finCursorAfter };
    } catch (e) { finance = { events: [], error: String(e?.message || e) }; }
    // Returns phase (FBA customer returns → RTV source). Auxiliary; never breaks the pipeline.
    let returns = { rows: [] }, retSub = 0;
    try { const rw = await amazonReturnsPhase(host, H, mkt, configAfter, nowMs); retSub = rw.subreqs; returns = { rows: rw.rows }; configAfter = rw.configAfter; }
    catch (e) { returns = { rows: [], error: String(e?.message || e) }; }
    // Settlement phase (true payout + fees → margin). Reconciliation-grade; never breaks the pipeline.
    let settlement = { settlements: [] }, setSub = 0;
    try { const sw = await amazonSettlementPhase(host, H, configAfter, nowMs); setSub = sw.subreqs; settlement = { settlements: sw.settlements }; configAfter = sw.configAfter; }
    catch (e) { settlement = { settlements: [], error: String(e?.message || e) }; }
    // Persist report + finance + returns + settlement config in ONE write (avoids clobbering pending ids).
    await patchConnectorConfig(channelId, cfg, configAfter);
    return { rows: rep.rows, cursorAfter: rep.cursorAfter, subreqs: rep.subreqs + finSub + retSub + setSub, partial: rep.partial, finance, returns, settlement };
  },
  async stage(rows, runId, channelId, fetched) {
    if (rows.length) {
      // UPSERT by (channel_id, source_order_id, channel_sku) — NOT supersede-by-date. The old
      // delete-by-day + insert was only safe when a report window carried a WHOLE day of orders.
      // Once the backfill caught up to real-time, each window shrank to an intra-day sliver, so
      // every tick deleted the day and reinserted only its few orders → sales_fact under-counted
      // Amazon for weeks (S192). The all-orders flat file is order-item grain → aggregate lines by
      // (order, sku) first (a payload can't carry two rows sharing the on_conflict key), then upsert.
      // Idempotent under re-pull, in both wide backfill windows and steady-state slivers.
      const bySku = {};
      for (const r of rows) {
        const oid = r.source_order_id || null;
        const k = `${oid || ''}|${r.channel_sku}`;
        const a = (bySku[k] = bySku[k] || {
          source_order_id: oid, channel_sku: r.channel_sku, sale_date: r.sale_date, title: r.title || null,
          qty: 0, gross_value: 0, discount_value: 0, tax_value: 0,
          order_status: r.order_status || null, is_cancelled: false,
          ship_state: r.ship_state || null, ship_city: r.ship_city || null, raw: r.raw,
        });
        a.qty += num(r.qty); a.gross_value += num(r.gross_value);
        a.discount_value += num(r.discount_value || 0); a.tax_value += num(r.tax_value || 0);
        if (r.is_cancelled) a.is_cancelled = true;
        if (r.sale_date && r.sale_date < a.sale_date) a.sale_date = r.sale_date;
        if (r.title && !a.title) a.title = r.title;
        if (r.order_status && !a.order_status) a.order_status = r.order_status;
      }
      const body = Object.values(bySku).map(a => ({
        run_id: runId, channel_id: channelId, source_order_id: a.source_order_id, sale_date: a.sale_date,
        channel_sku: a.channel_sku, title: a.title, qty: Math.round(a.qty), gross_value: a.gross_value,
        discount_value: a.discount_value, tax_value: a.tax_value, row_type: 'sale',
        order_status: a.order_status, is_cancelled: a.is_cancelled,
        ship_state: a.ship_state, ship_city: a.ship_city, raw: a.raw,
      }));
      await sbInsertChunked('/rest/v1/stg_amazon?on_conflict=channel_id,source_order_id,channel_sku', body, 'return=minimal,resolution=merge-duplicates');
      // Order-grain rows (drives f_order_rollup: Total Orders / AOV / cancel rate). The all-orders
      // report is item-grain → aggregate item lines by amazon-order-id. Cancellations from order-status;
      // discount/tax/returns come from the Finances feed (stageAmazonFinance), not this report.
      const byOrder = {};
      for (const r of rows) {
        const oid = r.source_order_id; if (!oid) continue;
        const o = (byOrder[oid] = byOrder[oid] || { source_order_id: oid, refund_id: '', row_kind: 'order', sale_date: r.sale_date, order_name: oid, gross: 0, discount: 0, tax: 0, currency: 'INR', is_cancelled: false, returned_value: 0, tags: [] });
        o.gross += num(r.gross_value); o.discount += num(r.discount_value); o.tax += num(r.tax_value);
        if (r.is_cancelled) o.is_cancelled = true;
        if (r.sale_date && r.sale_date < o.sale_date) o.sale_date = r.sale_date;
      }
      await stageOrders(Object.values(byOrder), runId, channelId);
    }
    // Finance: stg_amazon_fin (+ order-grain return rows) and record the dates recompute must touch.
    const ev = (fetched && fetched.finance && fetched.finance.events) || [];
    const affected = await stageAmazonFinance(ev, runId, channelId);
    if (fetched && fetched.finance) fetched.finance.affectedDates = affected;
    // FBA customer returns → stg_amazon_returns (supersede the window by actual return-date range,
    // robust whether or not the report honours dataStart/EndTime), then (re)classify refund return_kind.
    const retRows = (fetched && fetched.returns && fetched.returns.rows) || [];
    if (retRows.length) {
      const rds = retRows.map(r => r.return_date).filter(Boolean).sort();
      if (rds.length) await sbSales(`/rest/v1/stg_amazon_returns?channel_id=eq.${channelId}&return_date=gte.${rds[0]}&return_date=lte.${rds[rds.length - 1]}`, { method: 'DELETE', prefer: 'return=minimal' });
      const rbody = retRows.map(r => ({ run_id: runId, channel_id: channelId, source_order_id: r.source_order_id, channel_sku: r.channel_sku, asin: r.asin, return_date: r.return_date, qty: r.qty, disposition: r.disposition, reason: r.reason, status: r.status, raw: r.raw }));
      await sbInsertChunked('/rest/v1/stg_amazon_returns', rbody, 'return=minimal');
    }
    // Reclassify refund return_kind across history (cheap + idempotent) whenever finance or returns moved.
    if (ev.length || retRows.length) await rpcSales('classify_amazon_returns', { p_channel: channelId, p_from: '2024-01-01', p_to: todayISO() });
    // Settlement → stg_amazon_settlement + recompute_settlement (per new disbursement file).
    const setts = (fetched && fetched.settlement && fetched.settlement.settlements) || [];
    if (setts.length) await stageAmazonSettlement(setts, runId, channelId);
  },
  datesOf(rows, fetched) {
    const ds = new Set(distinctDates(rows));
    for (const d of ((fetched && fetched.finance && fetched.finance.affectedDates) || [])) ds.add(d);
    return [...ds];
  },
};

// Stage finance events: aggregate by the unique key (split shipments → multiple events/order/sku/date),
// upsert into stg_amazon_fin, write order-grain RETURN rows into stg_orders, and return the set of
// dates recompute_facts must touch (shipment → the order's purchase date; refund → posted_date).
async function stageAmazonFinance(events, runId, channelId) {
  if (!events.length) return [];
  const agg = {};
  for (const e of events) {
    const k = `${e.amazon_order_id}|${e.seller_sku}|${e.event_type}|${e.posted_date}`;
    const a = (agg[k] = agg[k] || { amazon_order_id: e.amazon_order_id, seller_sku: e.seller_sku, event_type: e.event_type, posted_date: e.posted_date, qty: 0, principal: 0, tax: 0, promo: 0, raw: e.raw });
    a.qty += e.qty; a.principal += e.principal; a.tax += e.tax; a.promo += e.promo;
  }
  const all = Object.values(agg);
  const body = all.map(a => ({ run_id: runId, channel_id: channelId, amazon_order_id: a.amazon_order_id, seller_sku: a.seller_sku, event_type: a.event_type, posted_date: a.posted_date, qty: Math.round(a.qty), principal: a.principal, tax: a.tax, promo: a.promo, raw: a.raw }));
  await sbInsertChunked('/rest/v1/stg_amazon_fin?on_conflict=channel_id,amazon_order_id,seller_sku,event_type,posted_date', body, 'return=minimal,resolution=merge-duplicates');
  // Order-grain returns → stg_orders (mirrors Shopify; distinct refund_id so the orders report never wipes them).
  const refundRows = {};
  for (const a of all) {
    if (a.event_type !== 'refund') continue;
    const k = `${a.amazon_order_id}|${a.posted_date}`;
    const o = (refundRows[k] = refundRows[k] || { source_order_id: a.amazon_order_id, refund_id: `fin:${a.posted_date}`, row_kind: 'return', sale_date: a.posted_date, order_name: a.amazon_order_id, gross: 0, discount: 0, tax: 0, currency: 'INR', is_cancelled: false, returned_value: 0, tags: [] });
    o.returned_value += a.principal + a.tax;
  }
  await stageOrders(Object.values(refundRows), runId, channelId);
  // Recompute dates: shipment discount/tax land on the order's PURCHASE date (v_staged maps it
  // exactly via stg_amazon), refunds on posted_date. The purchase→post gap can be weeks (Amazon
  // posts the financial event when shipped/settled — observed up to ~31d), so recompute the span
  // [min posted − 60d .. max posted] — a safe superset of purchase+refund dates (idempotent).
  const ds = all.map(a => a.posted_date).sort();
  const startD = Date.parse(ds[0]) - 60 * 86400000, endD = Date.parse(ds[ds.length - 1]);
  const out = [];
  for (let t = startD; t <= endD; t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

// ── Amazon Ads (Advertising API v3 · LWA refresh-token · async reporting) → mkt_fact ──
// SEPARATE LWA app from SP-API (AMAZON_ADS_*). India = EU host. Profile discovered once + cached.
// Async report: create → poll → ingest carried ACROSS cron ticks via connector_config.config:
//   { region_host, ad_product, profile_id, backfill_start, pending_report_id, pending_through }
let _amzAdsToken = null, _amzAdsTokenExp = 0;
// LWA token endpoints: the global host handles token ops for all regions. The EU host has been
// seen to 500 intermittently on refresh grants, so try global first, then EU; retry once on 5xx;
// a 4xx (invalid_grant/invalid_client) is definitive → fail fast.
const AMZ_ADS_TOKEN_ENDPOINTS = ['https://api.amazon.com/auth/o2/token', 'https://api.amazon.co.uk/auth/o2/token'];
async function getAmazonAdsToken(env) {
  if (!env.AMAZON_ADS_REFRESH_TOKEN || !env.AMAZON_ADS_CLIENT_ID || !env.AMAZON_ADS_CLIENT_SECRET)
    throw new Error('Amazon Ads not configured (set AMAZON_ADS_REFRESH_TOKEN + AMAZON_ADS_CLIENT_ID/SECRET)');
  const now = Date.now();
  if (_amzAdsToken && now < _amzAdsTokenExp - 60_000) return _amzAdsToken;
  // .trim() each credential — a trailing newline/space from a `wrangler secret put` paste makes the
  // LWA token endpoint 500 (malformed token) instead of returning a clean 4xx.
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: (env.AMAZON_ADS_REFRESH_TOKEN || '').trim(), client_id: (env.AMAZON_ADS_CLIENT_ID || '').trim(), client_secret: (env.AMAZON_ADS_CLIENT_SECRET || '').trim() });
  let last = 'no response';
  for (const ep of AMZ_ADS_TOKEN_ENDPOINTS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }).catch(() => null);
      const t = res ? await res.json().catch(() => ({})) : {};
      if (t.access_token) { _amzAdsToken = t.access_token; _amzAdsTokenExp = now + (Number(t.expires_in) || 3600) * 1000; return _amzAdsToken; }
      const status = res ? res.status : 0;
      last = `${status} ${t.error || ''}: ${t.error_description || JSON.stringify(t).slice(0, 300)}`;
      if (status >= 400 && status < 500) throw new Error('Amazon Ads token failed (' + last + ')'); // definitive — don't retry/fallback
    }
  }
  throw new Error('Amazon Ads token failed (' + last + ')');
}
const AMZ_ADS_WINDOW_MS = 30 * 24 * 3600 * 1000;            // ≤30-day report windows
const AMZ_ADS_COLUMNS = ['date', 'campaignId', 'campaignName', 'impressions', 'clicks', 'cost', 'purchases14d', 'sales14d'];
// SB/SD v3 campaign reports use plain purchases/sales (not the SP 14d-suffixed columns).
const AMZ_ADS_COLUMNS_SBSD = ['date', 'campaignId', 'campaignName', 'impressions', 'clicks', 'cost', 'purchases', 'sales'];
const amzAdsDay = ms => new Date(ms).toISOString().slice(0, 10);
async function createAdsReport(host, H, adProduct, reportTypeId, startDate, endDate, groupBy = ['campaign'], columns = AMZ_ADS_COLUMNS) {
  const cr = await fetch(`${host}/reporting/reports`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      name: `odo-${reportTypeId}-${startDate}-${endDate}`, startDate, endDate,
      configuration: { adProduct, groupBy, columns, reportTypeId, timeUnit: 'DAILY', format: 'GZIP_JSON' },
    }),
  });
  if (!cr.ok) throw new Error(`Amazon Ads createReport ${cr.status}: ${(await cr.text().catch(() => '')).slice(0, 200)}`);
  const cj = await cr.json();
  if (!cj.reportId) throw new Error('Amazon Ads createReport: no reportId — ' + JSON.stringify(cj).slice(0, 160));
  return cj.reportId;
}
const amazonAdsAdapter = {
  kind: 'amazon_ads', stgTable: 'stg_amazon_ads',
  datesOf(rows) { return [...new Set(rows.map(r => r.the_date))].sort(); },
  async fetch({ env, channelId, cursor, config }) {
    const cfg = config || {};
    const host = cfg.region_host || 'https://advertising-api-eu.amazon.com';
    const adProduct = cfg.ad_product || 'SPONSORED_PRODUCTS';
    const reportTypeId = adProduct === 'SPONSORED_BRANDS' ? 'sbCampaigns' : (adProduct === 'SPONSORED_DISPLAY' ? 'sdCampaigns' : 'spCampaigns');
    const isSP = adProduct === 'SPONSORED_PRODUCTS';
    const cols = isSP ? AMZ_ADS_COLUMNS : AMZ_ADS_COLUMNS_SBSD;
    const token = await getAmazonAdsToken(env);
    let subreqs = 1;

    // profile discovery (once) — India profile, cached into config
    let profileId = cfg.profile_id;
    if (!profileId) {
      const pr = await fetch(`${host}/v2/profiles`, { headers: { 'Amazon-Advertising-API-ClientId': env.AMAZON_ADS_CLIENT_ID, Authorization: `Bearer ${token}` } }); subreqs++;
      if (!pr.ok) throw new Error(`Amazon Ads /v2/profiles ${pr.status}: ${(await pr.text().catch(() => '')).slice(0, 160)}`);
      const profiles = await pr.json();
      const pick = (profiles || []).find(p => p.countryCode === 'IN') || (profiles || [])[0];
      if (!pick) throw new Error('Amazon Ads: no profiles on this login (no Ads account linked?)');
      profileId = String(pick.profileId);
      await patchConnectorConfig(channelId, cfg, { profile_id: profileId }); cfg.profile_id = profileId;
    }
    const H = { 'Amazon-Advertising-API-ClientId': env.AMAZON_ADS_CLIENT_ID, 'Amazon-Advertising-API-Scope': profileId, Authorization: `Bearer ${token}`, 'Content-Type': 'application/vnd.createasyncreportrequest.v3+json' };
    const nowMs = Date.now();

    // ── pending report → poll ──
    if (cfg.pending_report_id) {
      const pr = await fetch(`${host}/reporting/reports/${cfg.pending_report_id}`, { headers: H }); subreqs++;
      if (!pr.ok) throw new Error(`Amazon Ads getReport ${pr.status}: ${(await pr.text().catch(() => '')).slice(0, 160)}`);
      const rep = await pr.json();
      const st = (rep.status || '').toUpperCase();
      if (st === 'PENDING' || st === 'PROCESSING') return { rows: [], cursorAfter: null, subreqs, partial: true };
      if (st !== 'COMPLETED') { await patchConnectorConfig(channelId, cfg, { pending_report_id: null, pending_through: null }); throw new Error(`Amazon Ads report ${st}: ${(rep.failureReason || '').slice(0, 120)}`); }
      let rows = [];
      if (rep.url) {
        const dl = await fetch(rep.url); subreqs++;                       // presigned S3 — no auth headers
        if (!dl.ok) throw new Error('Amazon Ads doc download ' + dl.status);
        const text = await new Response(dl.body.pipeThrough(new DecompressionStream('gzip'))).text();
        let arr = []; try { arr = JSON.parse(text); } catch { arr = []; }
        rows = (Array.isArray(arr) ? arr : []).map(d => ({
          channel_id: channelId, ad_account_id: profileId, campaign_id: String(d.campaignId ?? ''),
          campaign_name: d.campaignName || null, the_date: d.date,
          spend: num(d.cost), impressions: num(d.impressions), clicks: num(d.clicks),
          conversions: num(isSP ? d.purchases14d : d.purchases), conv_value: num(isSP ? d.sales14d : d.sales), raw: d,
        })).filter(r => r.the_date);
      }
      const windowEnd = cfg.pending_through;
      const endMs = Date.parse((windowEnd || '') + 'T00:00:00Z') || 0;
      // Walk forward: queue the next window if this one ended >~10h before now (more history to cover).
      let partial = false, next = { pending_report_id: null, pending_through: null };
      if (endMs && endMs < nowMs - 36_000_000) {
        const nextStart = amzAdsDay(endMs + 86400000);
        const nextEnd = amzAdsDay(Math.min(endMs + AMZ_ADS_WINDOW_MS, nowMs));
        try { const rid = await createAdsReport(host, H, adProduct, reportTypeId, nextStart, nextEnd, ['campaign'], cols); subreqs++; next = { pending_report_id: rid, pending_through: nextEnd }; partial = true; }
        catch (_) { /* leave cleared — next tick re-creates from the advanced cursor */ }
      }
      await patchConnectorConfig(channelId, cfg, next);
      return { rows, cursorAfter: windowEnd, subreqs, partial };
    }

    // ── no pending → create the next window. Floor the start at today-30 so steady-state always
    //    refreshes the trailing 30 days (Amazon attributes conversions over a 14-day window). ──
    let startStr = (cursor || cfg.backfill_start || amzAdsDay(nowMs - AMZ_ADS_WINDOW_MS)).slice(0, 10);
    const trailingStart = amzAdsDay(nowMs - AMZ_ADS_WINDOW_MS);
    if (startStr > trailingStart) startStr = trailingStart;
    // SB/SD reports retain only ~60-65 days (SP is longer) — clamp the backfill floor so a far-back
    // backfill_start doesn't 400 on retention; 55d stays safely inside as the edge advances daily.
    if (!isSP) { const sbsdFloor = amzAdsDay(nowMs - 55 * 86400000); if (startStr < sbsdFloor) startStr = sbsdFloor; }
    const startMs = Date.parse(startStr + 'T00:00:00Z') || nowMs;
    const endStr = amzAdsDay(Math.min(startMs + AMZ_ADS_WINDOW_MS, nowMs));
    let rid;
    try {
      rid = await createAdsReport(host, H, adProduct, reportTypeId, startStr, endStr, ['campaign'], cols); subreqs++;
    } catch (e) {
      // The v3 reporting createReport endpoint is rate-limited and SHARED across the SP/SB/SD ad
      // connectors, so transient 429 "Throttled" is expected under contention (esp. Sponsored Brands).
      // Don't hard-error (red status) — retry next tick; the report lands within a tick or two (the run
      // history confirms it self-heals). Same graceful handling as the queue-next-window createReport
      // above. Non-throttle errors (retention 400 / auth) still surface.
      if (/\b429\b|throttl/i.test(String(e?.message || e))) return { rows: [], cursorAfter: null, subreqs, partial: true };
      throw e;
    }
    await patchConnectorConfig(channelId, cfg, { pending_report_id: rid, pending_through: endStr });
    return { rows: [], cursorAfter: null, subreqs, partial: true };
  },
  async stage(rows, runId, channelId) {
    if (!rows.length) return;
    const from = rows.reduce((m, x) => x.the_date < m ? x.the_date : m, rows[0].the_date);
    const to   = rows.reduce((m, x) => x.the_date > m ? x.the_date : m, rows[0].the_date);
    await sbSales(`/rest/v1/stg_amazon_ads?channel_id=eq.${channelId}&the_date=gte.${from}&the_date=lte.${to}`, { method: 'DELETE', prefer: 'return=minimal' });
    const body = rows.map(r => ({ run_id: runId, channel_id: channelId, ad_account_id: r.ad_account_id, campaign_id: r.campaign_id, campaign_name: r.campaign_name, the_date: r.the_date, spend: r.spend, impressions: Math.round(r.impressions), clicks: Math.round(r.clicks), conversions: r.conversions, conv_value: r.conv_value, raw: r.raw }));
    await sbInsertChunked('/rest/v1/stg_amazon_ads', body, 'return=minimal');
  },
  async recompute({ channelId, dates, runId }) {
    const f = await rpcSales('recompute_amzn_ads', { p_channel: channelId, p_dates: dates, p_run_id: runId });
    return { mapped: 0, unmapped: 0, factsUpserted: (f.ok ? Number(f.data) : 0) };
  },
};

// ── Meta Ads (Marketing API insights) — domain: marketing → mkt_fact ──────
const META_API_VER = 'v21.0';
const metaAdsAdapter = {
  kind: 'meta_ads', stgTable: 'stg_meta',
  datesOf(rows, fetched) { const ad = (fetched && fetched.adRows) || []; return [...new Set([...rows, ...ad].map(r => r.the_date))].sort(); },
  async fetch({ env, channelId, cursor, budget, config }) {
    if (!env.META_SYSTEM_USER_TOKEN) throw new Error('Meta not configured (set META_SYSTEM_USER_TOKEN)');
    const accounts = (config && config.accounts) || [];
    if (!accounts.length) throw new Error('Meta config.accounts empty');
    const backfillStart = ((config && config.backfill_start) || BACKFILL_START).slice(0, 10);
    const today = istDate(nowISO());
    const WIN = 90;   // measured: a 30d window = ~2 subreqs/5s, so 90d (~6 subreqs/~15s) stays well under wall-clock
    const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
    // ONE window per run (the full-range pull blew the Worker wall-clock). Walk BACKWARD from today
    // so recent spend lands on the first run; cursor = earliest date fetched so far.
    const earliest = cursor ? String(cursor).slice(0, 10) : null;
    let winEnd, winStart, mode;
    if (earliest === null) { mode = 'initial'; winEnd = today; winStart = addDays(today, -(WIN - 1)); }
    else if (earliest > backfillStart) { mode = 'backfill'; winEnd = addDays(earliest, -1); winStart = addDays(winEnd, -(WIN - 1)); }
    else { mode = 'steady'; winEnd = today; winStart = addDays(today, -(WIN - 1)); }
    if (winStart < backfillStart) winStart = backfillStart;
    const rows = []; let subreqs = 0, partial = false;
    for (const acct of accounts) {
      let url = `https://graph.facebook.com/${META_API_VER}/act_${acct}/insights`
        + `?level=campaign&time_increment=1`
        + `&fields=campaign_id,campaign_name,spend,impressions,clicks,actions,action_values`
        + `&time_range=${encodeURIComponent(JSON.stringify({ since: winStart, until: winEnd }))}`
        + `&limit=200&access_token=${env.META_SYSTEM_USER_TOKEN}`;
      while (url) {
        if (subreqs >= budget) { partial = true; break; }
        const res = await fetch(url).catch(() => null); subreqs++;
        if (!res || !res.ok) { const b = res ? await res.text().catch(() => '') : ''; throw new Error(`Meta ${res ? res.status : 'network'} act_${acct}: ${b.slice(0, 160)}`); }
        const j = await res.json();
        for (const d of (j.data || [])) {
          const purch = (d.actions || []).find(a => a.action_type === 'omni_purchase' || a.action_type === 'purchase');
          const purchVal = (d.action_values || []).find(a => a.action_type === 'omni_purchase' || a.action_type === 'purchase');
          rows.push({
            channel_id: channelId, ad_account_id: acct, campaign_id: d.campaign_id, campaign_name: d.campaign_name || null, the_date: d.date_start,
            spend: num(d.spend), impressions: num(d.impressions), clicks: num(d.clicks),
            conversions: purch ? num(purch.value) : 0, conv_value: purchVal ? num(purchVal.value) : 0, raw: d,
          });
        }
        url = (j.paging && j.paging.next) || null;
      }
      if (partial) break;
    }
    // Advance cursor to the new earliest while backfilling; once backfilled, hold at backfillStart
    // so steady-state runs keep refreshing only the most-recent window.
    const cursorAfter = (mode === 'steady') ? backfillStart : winStart;
    if (mode !== 'steady') partial = partial || (winStart > backfillStart);

    // ── Ad-level (level=ad) — BEST-EFFORT recent window for creative-level ROAS (→ mkt_fact_ad).
    // Decoupled from the campaign cursor/backfill above: fixed last-~14d window, re-pulled every
    // run (self-healing), uses only LEFTOVER subrequest budget, and NEVER sets `partial` or throws,
    // so it can never disturb the campaign ingestion the business depends on.
    const adRows = [];
    try {
      const adStart = addDays(today, -13);
      for (const acct of accounts) {
        let aurl = `https://graph.facebook.com/${META_API_VER}/act_${acct}/insights`
          + `?level=ad&time_increment=1`
          + `&fields=campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,clicks,actions,action_values`
          + `&time_range=${encodeURIComponent(JSON.stringify({ since: adStart, until: today }))}`
          + `&limit=300&access_token=${env.META_SYSTEM_USER_TOKEN}`;
        while (aurl) {
          if (subreqs >= budget) break;                 // out of budget → stop (no partial; next run re-pulls)
          const res = await fetch(aurl).catch(() => null); subreqs++;
          if (!res || !res.ok) break;                   // give up on ad-level for this acct; keep campaign data
          const j = await res.json();
          for (const d of (j.data || [])) {
            const purch = (d.actions || []).find(a => a.action_type === 'omni_purchase' || a.action_type === 'purchase');
            const purchVal = (d.action_values || []).find(a => a.action_type === 'omni_purchase' || a.action_type === 'purchase');
            adRows.push({
              channel_id: channelId, ad_account_id: acct, campaign_id: d.campaign_id, campaign_name: d.campaign_name || null,
              adset_id: d.adset_id, adset_name: d.adset_name || null, ad_id: d.ad_id, ad_name: d.ad_name || null, the_date: d.date_start,
              spend: num(d.spend), impressions: num(d.impressions), clicks: num(d.clicks),
              conversions: purch ? num(purch.value) : 0, conv_value: purchVal ? num(purchVal.value) : 0, raw: d,
            });
          }
          aurl = (j.paging && j.paging.next) || null;
        }
      }
    } catch { /* best-effort; campaign rows already captured above */ }

    return { rows, adRows, cursorAfter, subreqs, partial };
  },
  async stage(rows, runId, channelId, fetched) {
    if (rows.length) {
      const body = rows.map(r => ({
        run_id: runId, channel_id: channelId, ad_account_id: r.ad_account_id, campaign_id: r.campaign_id,
        campaign_name: r.campaign_name, the_date: r.the_date, spend: r.spend, impressions: Math.round(r.impressions),
        clicks: Math.round(r.clicks), conversions: r.conversions, conv_value: r.conv_value, raw: r.raw,
      }));
      await sbInsertChunked('/rest/v1/stg_meta?on_conflict=channel_id,ad_account_id,campaign_id,the_date', body, 'return=minimal,resolution=merge-duplicates');
    }
    // Ad-level → stg_meta_ad (best-effort: must never break the campaign staging above).
    const adRows = (fetched && fetched.adRows) || [];
    if (adRows.length) {
      try {
        const adBody = adRows.map(r => ({
          run_id: runId, channel_id: channelId, ad_account_id: r.ad_account_id, campaign_id: r.campaign_id, campaign_name: r.campaign_name,
          adset_id: r.adset_id, adset_name: r.adset_name, ad_id: r.ad_id, ad_name: r.ad_name, the_date: r.the_date,
          spend: r.spend, impressions: Math.round(r.impressions), clicks: Math.round(r.clicks),
          conversions: r.conversions, conv_value: r.conv_value, raw: r.raw,
        }));
        await sbInsertChunked('/rest/v1/stg_meta_ad?on_conflict=channel_id,ad_account_id,ad_id,the_date', adBody, 'return=minimal,resolution=merge-duplicates');
      } catch { /* ad-level staging is best-effort */ }
    }
  },
  async recompute({ channelId, dates, runId }) {
    const f = await rpcSales('recompute_mkt', { p_channel: channelId, p_dates: dates, p_run_id: runId });
    // Ad-level fact refresh (best-effort; rpcSales never throws, a non-ok is simply ignored).
    await rpcSales('recompute_mkt_ad', { p_channel: channelId, p_dates: dates, p_run_id: runId });
    return { mapped: 0, unmapped: 0, factsUpserted: (f.ok ? Number(f.data) : 0) };
  },
};

// ── Google Ads (Google Ads API searchStream) — domain: marketing → mkt_fact ──
const GADS_API_VER = 'v23';
async function getGoogleAdsToken(env) {
  // OAuth2 refresh-token grant → short-lived access token (one per run).
  const body = new URLSearchParams({
    client_id: env.GOOGLE_ADS_CLIENT_ID, client_secret: env.GOOGLE_ADS_CLIENT_SECRET,
    refresh_token: env.GOOGLE_ADS_REFRESH_TOKEN, grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error('Google Ads token ' + r.status + ': ' + (await r.text().catch(() => '')).slice(0, 160));
  const j = await r.json();
  if (!j.access_token) throw new Error('Google Ads token: no access_token');
  return j.access_token;
}
const googleAdsAdapter = {
  kind: 'google_ads', stgTable: 'stg_google_ads',
  datesOf(rows) { return [...new Set(rows.map(r => r.the_date))].sort(); },
  async fetch({ env, channelId, cursor, budget, config }) {
    if (!env.GOOGLE_ADS_DEVELOPER_TOKEN || !env.GOOGLE_ADS_REFRESH_TOKEN) throw new Error('Google Ads not configured (set GOOGLE_ADS_* secrets)');
    const cfg = config || {};
    const customers = (cfg.customer_ids || []).map(c => String(c).replace(/[^0-9]/g, '')).filter(Boolean);
    if (!customers.length) throw new Error('Google Ads config.customer_ids empty');
    const loginCid = String(cfg.login_customer_id || '').replace(/[^0-9]/g, '');
    const backfillStart = (cfg.backfill_start || BACKFILL_START).slice(0, 10);
    const today = istDate(nowISO());
    const WIN = 90;   // mirror Meta: one window/run, walk BACKWARD from today; cursor = earliest date fetched.
    const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
    const earliest = cursor ? String(cursor).slice(0, 10) : null;
    let winEnd, winStart, mode;
    if (earliest === null) { mode = 'initial'; winEnd = today; winStart = addDays(today, -(WIN - 1)); }
    else if (earliest > backfillStart) { mode = 'backfill'; winEnd = addDays(earliest, -1); winStart = addDays(winEnd, -(WIN - 1)); }
    else { mode = 'steady'; winEnd = today; winStart = addDays(today, -(WIN - 1)); }
    if (winStart < backfillStart) winStart = backfillStart;
    const token = await getGoogleAdsToken(env);
    const H = { 'developer-token': env.GOOGLE_ADS_DEVELOPER_TOKEN, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    if (loginCid) H['login-customer-id'] = loginCid;
    const query = `SELECT campaign.id, campaign.name, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '${winStart}' AND '${winEnd}'`;
    const rows = []; let subreqs = 1, partial = false;   // +1 for the token call
    for (const cid of customers) {
      if (subreqs >= budget) { partial = true; break; }
      const res = await fetch(`https://googleads.googleapis.com/${GADS_API_VER}/customers/${cid}/googleAds:searchStream`, { method: 'POST', headers: H, body: JSON.stringify({ query }) }).catch(() => null); subreqs++;
      if (!res || !res.ok) { const b = res ? await res.text().catch(() => '') : ''; throw new Error(`Google Ads ${res ? res.status : 'network'} cust ${cid}: ${b.slice(0, 200)}`); }
      const batches = await res.json();   // searchStream → array of { results: [...] }
      for (const batch of (Array.isArray(batches) ? batches : [])) {
        for (const r of (batch.results || [])) {
          const m = r.metrics || {}, camp = r.campaign || {}, seg = r.segments || {};
          rows.push({
            channel_id: channelId, ad_account_id: cid, campaign_id: String(camp.id ?? ''),
            campaign_name: camp.name || null, the_date: seg.date,
            spend: num(m.costMicros) / 1e6, impressions: num(m.impressions), clicks: num(m.clicks),
            conversions: num(m.conversions), conv_value: num(m.conversionsValue), raw: r,
          });
        }
      }
    }
    const cursorAfter = (mode === 'steady') ? backfillStart : winStart;
    if (mode !== 'steady') partial = partial || (winStart > backfillStart);
    return { rows: rows.filter(r => r.the_date), cursorAfter, subreqs, partial };
  },
  async stage(rows, runId, channelId) {
    if (!rows.length) return;
    const body = rows.map(r => ({
      run_id: runId, channel_id: channelId, ad_account_id: r.ad_account_id, campaign_id: r.campaign_id,
      campaign_name: r.campaign_name, the_date: r.the_date, spend: r.spend, impressions: Math.round(r.impressions),
      clicks: Math.round(r.clicks), conversions: r.conversions, conv_value: r.conv_value, raw: r.raw,
    }));
    await sbInsertChunked('/rest/v1/stg_google_ads?on_conflict=channel_id,ad_account_id,campaign_id,the_date', body, 'return=minimal,resolution=merge-duplicates');
  },
  async recompute({ channelId, dates, runId }) {
    const f = await rpcSales('recompute_google_ads', { p_channel: channelId, p_dates: dates, p_run_id: runId });
    return { mapped: 0, unmapped: 0, factsUpserted: (f.ok ? Number(f.data) : 0) };
  },
};

// ── GA4 (Analytics Data API runReport) — domain: traffic → traffic_fact ───
const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const ga4Adapter = {
  kind: 'ga4', stgTable: 'stg_ga4',
  datesOf(rows) { return [...new Set(rows.map(r => r.the_date))].sort(); },
  async fetch({ env, channelId, cursor, budget, config }) {
    const prop = config && config.property_id;
    if (!prop) throw new Error('GA4 config.property_id missing');
    const startDate = (cursor || (config && config.backfill_start) || BACKFILL_START).slice(0, 10);
    const endDate = istDate(nowISO());
    const token = await googleToken(env, GA4_SCOPE);
    const rows = []; let subreqs = 0, partial = false, maxDate = startDate, offset = 0;
    const LIMIT = 100000;
    while (true) {
      if (subreqs >= budget) { partial = true; break; }
      const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${prop}:runReport`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dateRanges: [{ startDate, endDate }],
          dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }],
          metrics: [{ name: 'sessions' }, { name: 'addToCarts' }, { name: 'checkouts' }, { name: 'ecommercePurchases' }, { name: 'purchaseRevenue' }],
          limit: LIMIT, offset, keepEmptyRows: false,
        }),
      }).catch(() => null);
      subreqs++;
      if (!res || !res.ok) { const b = res ? await res.text().catch(() => '') : ''; throw new Error(`GA4 ${res ? res.status : 'network'}: ${b.slice(0, 200)}`); }
      const j = await res.json();
      for (const row of (j.rows || [])) {
        const dv = row.dimensionValues, mv = row.metricValues;
        const ymd = dv[0].value;
        const the_date = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
        if (the_date > maxDate) maxDate = the_date;
        rows.push({
          channel_id: channelId, the_date, src_group: dv[1].value || '(none)',
          sessions: num(mv[0].value), add_to_carts: num(mv[1].value), checkouts: num(mv[2].value),
          purchases: num(mv[3].value), conv_value: num(mv[4].value), raw: row,
        });
      }
      const total = Number(j.rowCount || 0);
      offset += LIMIT;
      if (offset >= total || !(j.rows || []).length) break;
    }
    return { rows, cursorAfter: maxDate, subreqs, partial };
  },
  async stage(rows, runId, channelId) {
    if (!rows.length) return;
    const body = rows.map(r => ({
      run_id: runId, channel_id: channelId, the_date: r.the_date, src_group: r.src_group,
      sessions: Math.round(r.sessions), add_to_carts: Math.round(r.add_to_carts), checkouts: Math.round(r.checkouts),
      purchases: Math.round(r.purchases), conv_value: r.conv_value, raw: r.raw,
    }));
    await sbInsertChunked('/rest/v1/stg_ga4?on_conflict=channel_id,the_date,src_group', body, 'return=minimal,resolution=merge-duplicates');
  },
  async recompute({ channelId, dates, runId }) {
    const f = await rpcSales('recompute_traffic', { p_channel: channelId, p_dates: dates, p_run_id: runId });
    return { mapped: 0, unmapped: 0, factsUpserted: (f.ok ? Number(f.data) : 0) };
  },
};

// ── Unicommerce (Uniware) — Flipkart + long-tail via the OMS sale-order API ──
// Fallback aggregator for channels with no usable direct API (Flipkart has none while Unicommerce
// sits on the account). search() returns metadata only → financials need a per-order get (N+1), but
// target channels are a small slice of volume, so a bounded batch of gets/run stays under the
// 50-subrequest cap. Forward-walking ≤30-day UPDATED windows (mirrors the Amazon adapter).
// connector_config.config = { uniware_channel, backfill_start?, window_days?, max_gets? }.
// Keep windows bounded: a too-wide saleOrder/search (40+ days) times out server-side and returns
// an empty result (silently), so we walk ≤14-day windows.
const UNI_WINDOW_DAYS_DEFAULT = 14;
const UNI_MAX_GETS_DEFAULT = 40;
const uniMs = (iso) => Date.parse(iso);
const uniISO = (ms) => new Date(Number(ms)).toISOString();           // → "yyyy-MM-ddTHH:mm:ss.SSSZ" (uniware-accepted)
// Uniware's saleOrder/search element `updated`/`created` is an epoch in SECONDS (~1.78e9), not ms —
// reading it raw as ms lands in 1970, so an UPDATED watermark could never advance past a 2026 cursor
// (the bug that froze the old per-channel pulls). Normalise: seconds→ms (any epoch < 1e12 is seconds),
// pass ms through, Date.parse an ISO string, else fall back. Used for the aggregator cursor watermark.
const uniUpdatedMs = (v, fb) => {
  if (v == null || v === '') return fb;
  const n = Number(v);
  if (!Number.isNaN(n)) return (n > 0 && n < 1e12) ? n * 1000 : n;   // epoch seconds → ms
  const d = Date.parse(v);
  return Number.isNaN(d) ? fb : d;
};
let _uniTok = null, _uniTokExp = 0;
async function getUniwareToken(env) {
  if (!env.UNIWARE_TENANT || !env.UNIWARE_USERNAME || !env.UNIWARE_PASSWORD)
    throw new Error('Uniware not configured (set UNIWARE_TENANT/UNIWARE_USERNAME/UNIWARE_PASSWORD)');
  const now = Date.now();
  if (_uniTok && now < _uniTokExp - 60_000) return _uniTok;
  const qs = new URLSearchParams({ grant_type: 'password', client_id: 'my-trusted-client', username: env.UNIWARE_USERNAME, password: env.UNIWARE_PASSWORD });
  const res = await fetch(`https://${env.UNIWARE_TENANT}.unicommerce.com/oauth/token?${qs}`, { headers: { 'Content-Type': 'application/json' } });
  const t = await res.json().catch(() => ({}));
  if (!t.access_token) throw new Error('Uniware token failed: ' + JSON.stringify(t).slice(0, 160));
  _uniTok = t.access_token; _uniTokExp = now + (Number(t.expires_in) || 40000) * 1000;
  return _uniTok;
}
// Map one Unicommerce saleOrderDTO → { lines[], order } for staging.
function uniMapOrder(so) {
  const status = String(so.status || '').toUpperCase();
  const cancelledOrder = status === 'CANCELLED';
  const occurred = uniISO(so.displayOrderDateTime || so.created || Date.now());
  const saleDate = istDate(occurred);
  const lines = []; let oGross = 0, oDisc = 0, oTax = 0;
  for (const it of (so.saleOrderItems || [])) {
    const itemCancelled = cancelledOrder || String(it.statusCode || '').toUpperCase() === 'CANCELLED' || !!it.cancelledBySeller;
    const gross = num(it.sellingPrice);
    const disc  = num(it.discount);
    const tax   = num(it.totalIntegratedGst) + num(it.totalStateGst) + num(it.totalCentralGst) + num(it.totalUnionTerritoryGst);
    // include in order-grain gross: cancelled order → all items (= cancelled value); live order → live items only
    if (cancelledOrder || !itemCancelled) { oGross += gross; oDisc += disc; oTax += tax; }
    lines.push({
      source_line_id: `${so.code}:${it.code || it.id}`, source_order_id: so.code,
      // EAN first: LOT controls EANs and product_master.ean is populated, so resolveSkus auto-maps
      // by ean (the fk-/lotcars- itemSku/sellerSkuCode don't match product_master.sku). Fallback to
      // the channel SKU when a line carries no EAN (→ unmapped queue, mapped once).
      channel_sku: it.ean || it.itemSku || it.sellerSkuCode || null, title: it.itemName || null,
      qty: 1, gross_value: gross, discount_value: disc, tax_value: tax, row_type: 'sale',
      occurred_at: occurred, sale_date: saleDate, order_status: status, is_cancelled: itemCancelled,
      raw: { ean: it.ean, sellerSku: it.sellerSkuCode, fsn: it.channelProductId, statusCode: it.statusCode },
    });
  }
  const order = {
    source_order_id: so.code, refund_id: '', row_kind: 'order', sale_date: saleDate,
    order_name: so.displayOrderCode || so.code, gross: oGross, discount: oDisc, tax: oTax,
    currency: so.currencyCode || 'INR', is_cancelled: cancelledOrder, returned_value: 0, tags: [],
    raw: { channel: so.channel, status: so.status },
  };
  return { lines, order };
}
// LEGACY per-channel `uniware` adapter — RETIRED (S187). Uniware does NOT honour the
// saleOrder/search `channel` value as a server-side filter (it returns ALL channels), so a
// per-channel pull paged the whole all-channels result and exhausted the 50-subreq budget
// before the per-order gets, freezing the cursor (CRED stuck at 2026-04-22, Flipkart 2026-04-27).
// Replaced by ONE `uniware_agg` aggregator (below). This stub stays registered so a stray manual
// refresh / an in-flight member ConnectorWorkflow at deploy time ends cleanly instead of crashing
// on an unknown adapter. Member rows keep adapter_kind='uniware' purely as the map/fact-target
// source; the cron producer skips them. Spec 2026-07-01-odo-uniware-channel-agnostic-aggregator.
const uniwareAdapter = {
  kind: 'uniware', stgTable: 'stg_uniware', sourceKind: 'uniware',
  async fetch() { return { rows: [], orderRows: [], cursorAfter: null, subreqs: 0, partial: false }; },
  async stage() { /* fed by uniware_agg */ },
};

// ── Uniware AGGREGATOR (S187) — pull all-channels once, fan out to member channels ──
// One connector owns the Uniware pull + a single cursor. It pulls each UPDATED window ONCE (no
// channel filter, since Uniware ignores it), keeps only orders whose channel is in the member
// allow-list (the connector_config rows still tagged adapter_kind='uniware', each carrying
// config.uniware_channel), fetches their details, and stages each to the CORRECT member channel_id.
// This kills the per-channel budget-starvation AND the 3× redundant all-channels paging.
const UNI_AGG_WINDOW_DAYS = 7;     // default UPDATED window; adaptively shrinks if too dense to scan
const UNI_AGG_MIN_WINDOW_MS = 24 * 3600 * 1000;   // shrink floor (1 day)
const uniwareAggAdapter = {
  kind: 'uniware_agg', stgTable: 'stg_uniware', sourceKind: 'uniware',
  // Build { UNIWARE_CHANNEL_UPPER → odo channel_id } from the member connector rows.
  async memberMap() {
    const mr = await sbSales('/rest/v1/connector_config?adapter_kind=eq.uniware&select=channel_id,config');
    const map = {};
    for (const m of (mr.ok ? mr.data : [])) {
      const u = String((m.config && m.config.uniware_channel) || '').toUpperCase();
      if (u) map[u] = m.channel_id;
    }
    return map;
  },
  async fetch({ env, cursor, config, budget }) {
    const cfg = config || {};
    const base = `https://${env.UNIWARE_TENANT}.unicommerce.com`;
    const map = await this.memberMap();
    if (!Object.keys(map).length) throw new Error('uniware_agg: no member channels (need connector_config adapter_kind=uniware with config.uniware_channel)');
    const token = await getUniwareToken(env);
    const H = { Authorization: `bearer ${token}`, 'Content-Type': 'application/json' };
    const PAGE = 100;
    const baseWinMs = (cfg.window_days || UNI_AGG_WINDOW_DAYS) * 24 * 3600 * 1000;
    const MAX_WINDOWS = cfg.max_windows || 25;   // empty windows to skip-scan per run (search-only)
    const now = Date.now();
    let winStart = uniMs(cursor || cfg.backfill_start || BACKFILL_START);
    let subreqs = 1; // token
    const rows = [], orderRows = [], byChannel = {};
    let cursorAfter = uniISO(winStart), partial = false, scanned = 0;

    const addByChannel = (chId, date) => { (byChannel[chId] = byChannel[chId] || new Set()).add(date); };

    while (true) {
      if (winStart >= now) { cursorAfter = uniISO(now); partial = false; break; }                 // caught up to live
      if (scanned >= MAX_WINDOWS || subreqs >= budget - 4) { cursorAfter = uniISO(winStart); partial = true; break; }

      // ── Scan the window FULLY (collect member order codes). Density is read CHEAPLY from page 1's
      // `totalRecords`, so when a window is too dense to page within budget we shrink it (halve, floor
      // 1 day) at the cost of ONE search — not a full over-scan. A fully-covered window lets the cursor
      // advance by winEnd. Volume-proof: at the 1-day floor an (essentially impossible) still-too-dense
      // window scans what it can and advances anyway, so the walk never stalls.
      let winMs = baseWinMs, winEnd, codes = [], fullyScanned = false, denseFloor = false;
      const collect = (els, wEnd) => { for (const e of (els || [])) { const ch = String(e.channel || '').toUpperCase(); if (map[ch]) codes.push({ code: e.code, channel_id: map[ch], updated: uniUpdatedMs(e.updated != null ? e.updated : e.created, wEnd) }); } };
      const doSearch = async (wEnd, displayStart) => {
        const r = await fetch(`${base}/services/rest/v1/oms/saleOrder/search`, { method: 'POST', headers: H, body: JSON.stringify({ fromDate: uniISO(winStart), toDate: uniISO(wEnd), dateType: 'UPDATED', searchOptions: { displayStart, displayLength: PAGE } }) }); subreqs++;
        const j = await r.json().catch(() => ({}));
        if (!j.successful) throw new Error('Uniware search: ' + JSON.stringify(j.errors || j).slice(0, 160));
        return j;
      };
      while (true) {
        if (subreqs >= budget - 6) { fullyScanned = false; break; }          // no budget to even probe → resume next run
        winEnd = Math.min(winStart + winMs, now);
        const j0 = await doSearch(winEnd, 0);                                 // page 1 → density (totalRecords)
        const total = Number(j0.totalRecords) || (j0.elements || []).length;
        const pagesNeeded = Math.ceil(total / PAGE);
        const scanBudget = Math.max(1, budget - subreqs - 6);                 // pages still affordable (keep ≥6 for gets)
        if (pagesNeeded > scanBudget && winMs > UNI_AGG_MIN_WINDOW_MS) {
          winMs = Math.max(UNI_AGG_MIN_WINDOW_MS, Math.floor(winMs / 2));     // too dense → shrink + retry (only 1 search spent)
          continue;
        }
        codes = []; collect(j0.elements, winEnd);
        let start = PAGE, done = (j0.elements || []).length < PAGE || total <= PAGE;
        while (!done && subreqs < budget - 6) {
          const j = await doSearch(winEnd, start);
          collect(j.elements, winEnd);
          start += PAGE;
          if ((j.elements || []).length < PAGE || start >= total) done = true;
        }
        denseFloor = pagesNeeded > scanBudget && !done;                       // 1-day window still over budget (extreme)
        fullyScanned = done || denseFloor;                                    // denseFloor → accept partial + advance (never stall)
        if (denseFloor) console.warn(`uniware_agg: dense window ${uniISO(winStart)}..${uniISO(winEnd)} (${total} orders) scanned partial — advancing`);
        break;
      }
      scanned++;
      if (!fullyScanned) { cursorAfter = uniISO(winStart); partial = true; break; }   // out of budget mid-scan → resume here next run
      if (!codes.length) { winStart = winEnd; continue; }                              // no member orders → skip forward

      // ── Window fully scanned → drain member orders. Uniware's `updated` is SECOND-resolution and
      // bulk operations stamp many orders at one exact second; when such a same-second pile exceeds a
      // run's get-budget, a time-based cursor can't step over it. So SKIP orders already staged, then
      // get the rest: each run drains a fresh slice of the pile (staging is idempotent), and once the
      // whole window is staged we advance by winEnd — no dependence on the cursor clearing the second.
      codes.sort((a, b) => a.updated - b.updated);
      const allIds = uniq(codes.map(c => c.code));
      const already = new Set();
      if (allIds.length) {
        const sr = await sbSales(`/rest/v1/stg_uniware?source_order_id=in.${inList(allIds)}&select=source_order_id`); subreqs++;
        if (sr.ok) for (const x of sr.data) already.add(x.source_order_id);
      }
      const toGet = codes.filter(c => !already.has(c.code));
      if (!toGet.length) { cursorAfter = uniISO(winEnd); partial = winEnd < now; break; }   // every member already staged → step the window
      let drained = true, lastGot = winStart;
      for (const c of toGet) {
        if (subreqs >= budget - 1) { drained = false; break; }
        const gr = await fetch(`${base}/services/rest/v1/oms/saleorder/get`, { method: 'POST', headers: H, body: JSON.stringify({ code: c.code }) }); subreqs++;
        const gj = await gr.json().catch(() => ({}));
        const so = gj.saleOrderDTO; if (!so) continue;
        const m = uniMapOrder(so);
        for (const ln of m.lines) { ln._channel_id = c.channel_id; rows.push(ln); addByChannel(c.channel_id, ln.sale_date); }
        m.order._channel_id = c.channel_id; orderRows.push(m.order); addByChannel(c.channel_id, m.order.sale_date);
        if (c.updated > lastGot) lastGot = c.updated;
      }
      // Drained this slice → if it advanced the watermark, resume there; else hold the window so the
      // next run skips the now-staged slice and gets the remainder (the same-second-pile drain path).
      if (drained) { cursorAfter = uniISO(winEnd); partial = winEnd < now; }
      else { cursorAfter = uniISO(lastGot > winStart ? lastGot : winStart); partial = true; }
      break;
    }

    const byChannelArr = {}; for (const k in byChannel) byChannelArr[k] = [...byChannel[k]];
    return { rows, orderRows, cursorAfter, subreqs, partial, byChannel: byChannelArr };
  },
  // Fan out staging by each row's resolved member channel_id.
  async stage(rows, runId, _aggChannelId, fetched) {
    const byCh = {};
    for (const r of rows) (byCh[r._channel_id] = byCh[r._channel_id] || []).push(r);
    for (const [chId, rs] of Object.entries(byCh)) {
      const body = rs.map(r => ({
        run_id: runId, channel_id: chId, source_order_id: r.source_order_id, source_line_id: r.source_line_id,
        occurred_at: r.occurred_at, sale_date: r.sale_date, channel_sku: r.channel_sku, title: r.title,
        qty: Math.round(r.qty), gross_value: r.gross_value, discount_value: r.discount_value || 0, tax_value: r.tax_value || 0,
        row_type: r.row_type || 'sale', order_status: r.order_status, is_cancelled: r.is_cancelled, raw: r.raw,
      }));
      await sbInsertChunked('/rest/v1/stg_uniware?on_conflict=source_line_id', body, 'return=minimal,resolution=merge-duplicates');
    }
    const ordByCh = {};
    for (const o of ((fetched && fetched.orderRows) || [])) (ordByCh[o._channel_id] = ordByCh[o._channel_id] || []).push(o);
    for (const [chId, os] of Object.entries(ordByCh)) await stageOrders(os, runId, chId);
  },
  // recompute_facts + sku resolution PER member channel (executeRun passes `fetched`).
  async recompute({ runId, fetched }) {
    const byChannel = (fetched && fetched.byChannel) || {};
    let mapped = 0, unmapped = 0, factsUpserted = 0;
    for (const [chId, dates] of Object.entries(byChannel)) {
      if (!dates.length) continue;
      const r = await resolveSkus(chId, dates, 'stg_uniware', null);
      const f = await rpcSales('recompute_facts', { p_channel: chId, p_dates: dates, p_run_id: runId });
      mapped += r.mapped; unmapped += r.unmapped; factsUpserted += (f.ok ? Number(f.data) : 0);
      // Stamp the member connector so the Connectors page shows it Active + fresh.
      await sbSales(`/rest/v1/connector_config?channel_id=eq.${chId}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ last_ok_at: nowISO(), last_error: null }) });
    }
    return { mapped, unmapped, factsUpserted };
  },
};

// ── Amazon Ads — advertised-product (SP) report → product-grain mkt_product_fact (S185) ──
// Mirrors amazonAdsAdapter's create→poll→walk state machine; differs only in report type (groupBy
// 'advertiser'), columns (advertised SKU/ASIN), staging table, and recompute RPC. Intentionally a
// separate adapter (not a refactor of amazonAdsAdapter) to keep zero blast-radius on the live
// campaign connector — both ride the generic ConnectorWorkflow, each with its own instance.
const AMZ_ADS_PRODUCT_COLUMNS = ['date', 'campaignId', 'campaignName', 'advertisedSku', 'advertisedAsin', 'impressions', 'clicks', 'cost', 'purchases14d', 'sales14d'];
const amazonAdsProductAdapter = {
  kind: 'amazon_ads_product', stgTable: 'stg_amazon_ads_product',
  datesOf(rows) { return [...new Set(rows.map(r => r.the_date))].sort(); },
  async fetch({ env, channelId, cursor, config }) {
    const cfg = config || {};
    const host = cfg.region_host || 'https://advertising-api-eu.amazon.com';
    const adProduct = cfg.ad_product || 'SPONSORED_PRODUCTS';
    const reportTypeId = 'spAdvertisedProduct';
    const groupBy = ['advertiser'];
    const token = await getAmazonAdsToken(env);
    let subreqs = 1;

    let profileId = cfg.profile_id;
    if (!profileId) {
      const pr = await fetch(`${host}/v2/profiles`, { headers: { 'Amazon-Advertising-API-ClientId': env.AMAZON_ADS_CLIENT_ID, Authorization: `Bearer ${token}` } }); subreqs++;
      if (!pr.ok) throw new Error(`Amazon Ads /v2/profiles ${pr.status}: ${(await pr.text().catch(() => '')).slice(0, 160)}`);
      const profiles = await pr.json();
      const pick = (profiles || []).find(p => p.countryCode === 'IN') || (profiles || [])[0];
      if (!pick) throw new Error('Amazon Ads: no profiles on this login (no Ads account linked?)');
      profileId = String(pick.profileId);
      await patchConnectorConfig(channelId, cfg, { profile_id: profileId }); cfg.profile_id = profileId;
    }
    const H = { 'Amazon-Advertising-API-ClientId': env.AMAZON_ADS_CLIENT_ID, 'Amazon-Advertising-API-Scope': profileId, Authorization: `Bearer ${token}`, 'Content-Type': 'application/vnd.createasyncreportrequest.v3+json' };
    const nowMs = Date.now();

    // ── pending report → poll ──
    if (cfg.pending_report_id) {
      const pr = await fetch(`${host}/reporting/reports/${cfg.pending_report_id}`, { headers: H }); subreqs++;
      if (!pr.ok) throw new Error(`Amazon Ads getReport ${pr.status}: ${(await pr.text().catch(() => '')).slice(0, 160)}`);
      const rep = await pr.json();
      const st = (rep.status || '').toUpperCase();
      if (st === 'PENDING' || st === 'PROCESSING') return { rows: [], cursorAfter: null, subreqs, partial: true };
      if (st !== 'COMPLETED') { await patchConnectorConfig(channelId, cfg, { pending_report_id: null, pending_through: null }); throw new Error(`Amazon Ads report ${st}: ${(rep.failureReason || '').slice(0, 120)}`); }
      let rows = [];
      if (rep.url) {
        const dl = await fetch(rep.url); subreqs++;
        if (!dl.ok) throw new Error('Amazon Ads doc download ' + dl.status);
        const text = await new Response(dl.body.pipeThrough(new DecompressionStream('gzip'))).text();
        let arr = []; try { arr = JSON.parse(text); } catch { arr = []; }
        rows = (Array.isArray(arr) ? arr : []).map(d => ({
          channel_id: channelId, ad_account_id: profileId, campaign_id: String(d.campaignId ?? ''),
          campaign_name: d.campaignName || null, advertised_sku: d.advertisedSku || null, advertised_asin: d.advertisedAsin || null,
          the_date: d.date,
          spend: num(d.cost), impressions: num(d.impressions), clicks: num(d.clicks),
          conversions: num(d.purchases14d), conv_value: num(d.sales14d), raw: d,
        })).filter(r => r.the_date);
      }
      const windowEnd = cfg.pending_through;
      const endMs = Date.parse((windowEnd || '') + 'T00:00:00Z') || 0;
      let partial = false, next = { pending_report_id: null, pending_through: null };
      if (endMs && endMs < nowMs - 36_000_000) {
        const nextStart = amzAdsDay(endMs + 86400000);
        const nextEnd = amzAdsDay(Math.min(endMs + AMZ_ADS_WINDOW_MS, nowMs));
        try { const rid = await createAdsReport(host, H, adProduct, reportTypeId, nextStart, nextEnd, groupBy, AMZ_ADS_PRODUCT_COLUMNS); subreqs++; next = { pending_report_id: rid, pending_through: nextEnd }; partial = true; }
        catch (_) { /* leave cleared — next tick re-creates from the advanced cursor */ }
      }
      await patchConnectorConfig(channelId, cfg, next);
      return { rows, cursorAfter: windowEnd, subreqs, partial };
    }

    // ── no pending → create the next window (trailing-30d floor for steady state) ──
    let startStr = (cursor || cfg.backfill_start || amzAdsDay(nowMs - AMZ_ADS_WINDOW_MS)).slice(0, 10);
    const trailingStart = amzAdsDay(nowMs - AMZ_ADS_WINDOW_MS);
    if (startStr > trailingStart) startStr = trailingStart;
    // spAdvertisedProduct retains only ~95 days — Amazon 400s on any older startDate. Clamp the
    // backfill floor (there is no advertised-product data older than this anyway). 90d is safely
    // inside the ~95d window even as the retention edge advances daily.
    const retentionStart = amzAdsDay(nowMs - 90 * 86400000);
    if (startStr < retentionStart) startStr = retentionStart;
    const startMs = Date.parse(startStr + 'T00:00:00Z') || nowMs;
    const endStr = amzAdsDay(Math.min(startMs + AMZ_ADS_WINDOW_MS, nowMs));
    const rid = await createAdsReport(host, H, adProduct, reportTypeId, startStr, endStr, groupBy, AMZ_ADS_PRODUCT_COLUMNS); subreqs++;
    await patchConnectorConfig(channelId, cfg, { pending_report_id: rid, pending_through: endStr });
    return { rows: [], cursorAfter: null, subreqs, partial: true };
  },
  async stage(rows, runId, channelId) {
    if (!rows.length) return;
    const from = rows.reduce((m, x) => x.the_date < m ? x.the_date : m, rows[0].the_date);
    const to   = rows.reduce((m, x) => x.the_date > m ? x.the_date : m, rows[0].the_date);
    await sbSales(`/rest/v1/stg_amazon_ads_product?channel_id=eq.${channelId}&the_date=gte.${from}&the_date=lte.${to}`, { method: 'DELETE', prefer: 'return=minimal' });
    const body = rows.map(r => ({ run_id: runId, channel_id: channelId, ad_account_id: r.ad_account_id, campaign_id: r.campaign_id, campaign_name: r.campaign_name, advertised_sku: r.advertised_sku, advertised_asin: r.advertised_asin, the_date: r.the_date, spend: r.spend, impressions: Math.round(r.impressions), clicks: Math.round(r.clicks), conversions: r.conversions, conv_value: r.conv_value, raw: r.raw }));
    await sbInsertChunked('/rest/v1/stg_amazon_ads_product', body, 'return=minimal');
  },
  async recompute({ channelId, dates, runId }) {
    const f = await rpcSales('recompute_amzn_ads_product', { p_channel: channelId, p_dates: dates, p_run_id: runId });
    return { mapped: 0, unmapped: 0, factsUpserted: (f.ok ? Number(f.data) : 0) };
  },
};

// ── Razorpay payments → payment funnel (S185) ────────────────────────────────
// Provider-agnostic payment staging: this API adapter (backfill + reconciliation) and the
// /webhook/razorpay route (real-time) both upsert into sales.stg_payments on
// (provider, provider_payment_id). f_payment_funnel reads staging directly (no fact recompute).
const RAZORPAY_CHANNEL_ID = '00000000-0000-4000-a000-0000000000a8';
const RZP_TRAIL_S = 7 * 86400;   // steady-state: always re-pull the trailing 7 days (status changes)
function mapRazorpayPayment(p, channelId) {
  return {
    channel_id: channelId, provider: 'razorpay',
    provider_payment_id: p.id, order_ref: p.order_id || null,
    status: p.status || null, method: p.method || null,
    error_code: p.error_code || null,
    error_reason: p.error_reason || p.error_description || null,
    amount: (Number(p.amount) || 0) / 100, currency: p.currency || 'INR',
    created_at: p.created_at ? new Date(Number(p.created_at) * 1000).toISOString() : null,
    raw: p,
  };
}
async function verifyRazorpaySig(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  if (hex.length !== signature.length) return false;
  let diff = 0; for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
const razorpayPaymentsAdapter = {
  kind: 'razorpay_payments', stgTable: 'stg_payments',
  datesOf() { return []; },   // stage-only — f_payment_funnel reads staging directly
  async fetch({ env, channelId, cursor, config, budget }) {
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) throw new Error('Razorpay not configured (set RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET)');
    const cfg = config || {};
    const H = { Authorization: 'Basic ' + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`) };
    const winS = (cfg.window_days || 7) * 86400;
    const nowS = Math.floor(Date.now() / 1000);
    let startS = Math.floor(Date.parse(cursor || cfg.backfill_start || new Date((nowS - RZP_TRAIL_S) * 1000).toISOString()) / 1000);
    if (!Number.isFinite(startS)) startS = nowS - RZP_TRAIL_S;
    const trailStartS = nowS - RZP_TRAIL_S;
    if (startS > trailStartS) startS = trailStartS;        // caught up → re-pull trailing 7d for status changes
    const endS = Math.min(startS + winS, nowS);
    let subreqs = 0, skip = 0; const rows = [];
    while (subreqs < budget - 2) {
      const r = await fetch(`https://api.razorpay.com/v1/payments?from=${startS}&to=${endS}&count=100&skip=${skip}`, { headers: H }); subreqs++;
      if (!r.ok) throw new Error(`Razorpay payments ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}`);
      const j = await r.json().catch(() => ({}));
      const items = j.items || [];
      for (const p of items) rows.push(mapRazorpayPayment(p, channelId));
      if (items.length < 100) break;
      skip += 100;
    }
    const cursorAfter = new Date(endS * 1000).toISOString();
    return { rows, cursorAfter, subreqs, partial: endS < nowS };   // partial while still backfilling forward
  },
  async stage(rows, runId, channelId) {
    if (!rows.length) return;
    // Dedupe by provider_payment_id within the batch — Razorpay skip-pagination can return the same
    // payment twice, and ON CONFLICT can't update one conflict key twice in a single statement (PG 21000).
    const seen = new Map();
    for (const r of rows) if (r.provider_payment_id) seen.set(r.provider_payment_id, r);
    const body = [...seen.values()].map(r => ({ run_id: runId, ...r }));
    await sbInsertChunked('/rest/v1/stg_payments?on_conflict=provider,provider_payment_id', body, 'return=minimal,resolution=merge-duplicates');
  },
};

// ── Meta entity status (campaign/adset/ad effective_status) → mkt_entity_status (S185) ──
// Powers the Live/Paused marker on the Marketing tables. Pulls the MANAGEMENT API (separate from the
// insights our metrics come from), filtered to non-archived entities, upserts current status. Stage-only.
const metaStatusAdapter = {
  kind: 'meta_status', stgTable: 'mkt_entity_status',
  datesOf() { return []; },
  async fetch({ env, config, budget }) {
    if (!env.META_SYSTEM_USER_TOKEN) throw new Error('Meta not configured (set META_SYSTEM_USER_TOKEN)');
    const accounts = (config && config.accounts) || [];
    if (!accounts.length) throw new Error('meta_status config.accounts empty');
    const BASE_ST = ['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'IN_PROCESS', 'WITH_ISSUES', 'PENDING_REVIEW'];
    // Campaigns are few → also pull ARCHIVED so the full-history campaign table gets a marker on every
    // row; ads/adsets are numerous → keep them non-archived to bound volume (recent rows match anyway).
    const filtFor = (lvl) => encodeURIComponent(JSON.stringify([{ field: 'effective_status', operator: 'IN', value: lvl === 'campaign' ? [...BASE_ST, 'ARCHIVED'] : BASE_ST }]));
    const levels = [['campaigns', 'campaign', 8], ['adsets', 'adset', 5], ['ads', 'ad', 10]];   // [edge, level, maxPages]
    const rows = []; let subreqs = 0;
    for (const acct of accounts) {
      for (const [edge, level, maxPages] of levels) {
        let url = `https://graph.facebook.com/${META_API_VER}/act_${acct}/${edge}?fields=id,name,effective_status&filtering=${filtFor(level)}&limit=500&access_token=${env.META_SYSTEM_USER_TOKEN}`;
        let pages = 0;
        while (url && subreqs < budget - 2 && pages < maxPages) {
          const res = await fetch(url); subreqs++; pages++;
          const j = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(`Meta ${res.status} ${edge} act_${acct}: ${JSON.stringify(j).slice(0, 160)}`);
          for (const e of (j.data || [])) rows.push({ platform: 'meta', level, entity_id: String(e.id), status: e.effective_status || null, is_live: e.effective_status === 'ACTIVE', name: e.name || null });
          url = j.paging && j.paging.next ? j.paging.next : null;
        }
      }
    }
    return { rows, cursorAfter: null, subreqs, partial: false };
  },
  async stage(rows) {
    if (!rows.length) return;
    const seen = new Map();
    for (const r of rows) seen.set(r.level + '|' + r.entity_id, r);   // dedupe before upsert (PG 21000)
    const body = [...seen.values()].map(r => ({ ...r, updated_at: nowISO() }));
    await sbInsertChunked('/rest/v1/mkt_entity_status?on_conflict=platform,level,entity_id', body, 'return=minimal,resolution=merge-duplicates');
  },
};

// ════════════════════════════════════════════════════════════════════════════
// Phase 2 — Meta WRITE (the LOT Ad Engine's "hands"). Create + manage ads via the
// Marketing API behind hard guardrails. Invariants enforced HERE, not by convention:
//   • Master kill-switch: nothing writes unless settings.ads_write_enabled = 'true'.
//   • Approved-plan gate: a launch can only run from an ads_plan in status 'approved'.
//   • Hard daily ceiling: any spend-raising call checks committed+delta ≤ ads_max_daily_spend_inr.
//   • Audit: every write call appends an ads_ledger row (who/what/payload/Meta response).
//   • Auto-pause is FREE (only lowers spend); auto-SCALE is gated to canAdsApprove.
// See migration 0010 + strategy/meta-automation-spec.md.
// ════════════════════════════════════════════════════════════════════════════
async function adsSetting(key, fallback = null) {
  const r = await sbSales(`/rest/v1/settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`);
  return (r.ok && r.data[0]) ? r.data[0].value : fallback;
}
const adsWriteEnabled = async () => String(await adsSetting('ads_write_enabled', 'false')) === 'true';
const adsCeilingInr   = async () => num(await adsSetting('ads_max_daily_spend_inr', '0'));
const inrToMinor = inr => Math.round(num(inr) * 100);   // INR is a 2-decimal currency on Meta → paise

// Append-only audit. Best-effort: an audit-write failure must not mask the real result.
async function ledgerWrite(row) {
  try {
    const r = await sbSales('/rest/v1/ads_ledger', { method: 'POST', prefer: 'return=representation',
      body: JSON.stringify({ created_at: nowISO(), ...row }) });
    return (r.ok && Array.isArray(r.data) && r.data[0]) ? r.data[0].id : null;
  } catch { return null; }
}
async function managedUpsert(row) {
  await sbSales('/rest/v1/ads_managed?on_conflict=entity_type,meta_id', { method: 'POST',
    prefer: 'return=minimal,resolution=merge-duplicates', body: JSON.stringify({ ...row, updated_at: nowISO() }) });
}
async function managedGet(entityType, metaId) {
  const r = await sbSales(`/rest/v1/ads_managed?entity_type=eq.${entityType}&meta_id=eq.${encodeURIComponent(metaId)}&select=*&limit=1`);
  return (r.ok && r.data[0]) ? r.data[0] : null;
}
// PATCH (not upsert) for status/budget changes — a merge-duplicates upsert would reset the
// row's other columns (parent_id, daily_budget_inr…) to defaults. Partial update only.
async function managedPatch(entityType, metaId, patch) {
  await sbSales(`/rest/v1/ads_managed?entity_type=eq.${entityType}&meta_id=eq.${encodeURIComponent(metaId)}`,
    { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ ...patch, updated_at: nowISO() }) });
}

// Current committed daily budget across ACTIVE engine adsets (the ceiling base).
async function adsCommittedDailyInr() { const r = await rpcSales('f_ads_committed_daily', {}); return r.ok ? num(r.data) : 0; }
// Throws (→ surfaced as a 4xx) if committing addDailyInr more would breach the hard ceiling.
// replaceCurrentInr nets out an existing adset's budget when CHANGING (not adding) a budget.
async function assertCeiling(addDailyInr, replaceCurrentInr = 0) {
  const ceiling = await adsCeilingInr();
  if (!ceiling || ceiling <= 0) throw new Error('ads_max_daily_spend_inr is unset — refusing to commit spend');
  const committed = await adsCommittedDailyInr();
  const after = committed - num(replaceCurrentInr) + num(addDailyInr);
  if (after > ceiling) throw new Error(`Daily ceiling breach: ₹${committed} committed + ₹${addDailyInr} → ₹${after} > ceiling ₹${ceiling}`);
  return { ceiling, committed, after };
}

// Graph API. Writes = POST form-encoded (token in body); reads = GET (token in query).
async function metaPost(env, path, params) {
  if (!env.META_SYSTEM_USER_TOKEN) throw new Error('Meta not configured (set META_SYSTEM_USER_TOKEN)');
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) { if (v === undefined || v === null) continue; form.set(k, (typeof v === 'object') ? JSON.stringify(v) : String(v)); }
  form.set('access_token', env.META_SYSTEM_USER_TOKEN);
  const res = await fetch(`https://graph.facebook.com/${META_API_VER}/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Meta ${res.status} POST ${path}: ${JSON.stringify(j.error || j).slice(0, 240)}`);
  return j;
}
async function metaGet(env, path, qs = '') {
  if (!env.META_SYSTEM_USER_TOKEN) throw new Error('Meta not configured (set META_SYSTEM_USER_TOKEN)');
  const res = await fetch(`https://graph.facebook.com/${META_API_VER}/${path}?${qs}${qs ? '&' : ''}access_token=${env.META_SYSTEM_USER_TOKEN}`);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Meta ${res.status} GET ${path}: ${JSON.stringify(j.error || j).slice(0, 240)}`);
  return j;
}

// The Meta ad account id (act_<id>) the engine operates on — read from the meta_ads connector config.
async function metaAdAccount(planAcct) {
  if (planAcct) return String(planAcct);
  const r = await sbSales(`/rest/v1/connector_config?adapter_kind=eq.meta_ads&select=config&limit=1`);
  const accts = (r.ok && r.data[0]?.config?.accounts) || [];
  if (!accts.length) throw new Error('No Meta ad account configured (connector_config.config.accounts is empty)');
  return String(accts[0]);
}
async function adsLoadPlan(planId, requireStatus = null) {
  const r = await sbSales(`/rest/v1/ads_plan?id=eq.${planId}&select=*&limit=1`);
  const plan = (r.ok && r.data[0]) ? r.data[0] : null;
  if (!plan) throw new Error(`Plan ${planId} not found`);
  if (requireStatus && plan.status !== requireStatus) throw new Error(`Plan ${planId} is '${plan.status}', need '${requireStatus}'`);
  return plan;
}

// Wraps a Meta write: enforce the kill-switch, run fn (does the Graph calls + ceiling checks),
// then audit success/failure. fn returns { entity_type, entity_id, meta_response, daily_delta_inr }.
async function adsGuardedWrite({ userId, action, planId = null, request, fn }) {
  if (!(await adsWriteEnabled())) {
    await ledgerWrite({ actor_user_id: userId, action, plan_id: planId, request, status: 'blocked', error: 'ads_write_enabled is false' });
    throw new Error('Ad-engine WRITE is disabled (settings.ads_write_enabled = false). Flip it on, then retry.');
  }
  try {
    const out = await fn();
    await ledgerWrite({ actor_user_id: userId, action, plan_id: planId, daily_delta_inr: out.daily_delta_inr || 0,
      entity_type: out.entity_type || null, entity_id: out.entity_id || null, request, meta_response: out.meta_response || null, status: 'ok' });
    return out;
  } catch (e) {
    await ledgerWrite({ actor_user_id: userId, action, plan_id: planId, request, status: 'error', error: String(e?.message || e) });
    throw e;
  }
}

// Cron: pause engine-managed ADS whose lifetime spend ≥ kill gate AND ROAS < floor. Auto-pause
// only LOWERS spend → no approval needed (gated only by the master kill-switch). Best-effort:
// never throws into the cron. Reads creative-grain perf from the Phase-1 f_mkt_ad_rollup.
async function adsAutoPause(env) {
  try {
    if (!(await adsWriteEnabled())) return;
    const killRoas  = num(await adsSetting('ads_kill_roas', '2'));
    const killAfter = num(await adsSetting('ads_kill_after_inr', '6500'));
    const mr = await sbSales('/rest/v1/ads_managed?entity_type=eq.ad&status=eq.active&select=meta_id,plan_id');
    const ads = mr.ok ? mr.data : [];
    if (!ads.length) return;
    const roll = await rpcSales('f_mkt_ad_rollup', { p_from: '2025-04-01', p_to: todayISO(), p_group: 'ad' });
    const perf = {}; for (const r of (roll.ok ? roll.data : [])) perf[r.ad_id] = r;
    for (const a of ads) {
      const p = perf[a.meta_id]; if (!p) continue;
      const spend = num(p.spend), roas = spend > 0 ? num(p.conv_value) / spend : 0;
      if (spend >= killAfter && roas < killRoas) {
        try {
          await metaPost(env, `${a.meta_id}`, { status: 'PAUSED' });
          await managedPatch('ad', a.meta_id, { status: 'paused' });
          await ledgerWrite({ actor_user_id: null, action: 'autoPauseAd', plan_id: a.plan_id, entity_type: 'ad', entity_id: a.meta_id, status: 'ok',
            meta_response: { reason: `ROAS ${roas.toFixed(2)} < ${killRoas} after ₹${spend.toFixed(0)} ≥ ₹${killAfter}` } });
        } catch (e) { await ledgerWrite({ actor_user_id: null, action: 'autoPauseAd', plan_id: a.plan_id, entity_type: 'ad', entity_id: a.meta_id, status: 'error', error: String(e?.message || e) }); }
      }
    }
  } catch (e) { console.error('adsAutoPause failed:', e?.message || e); }
}

const ADAPTERS = { shopify: shopifyAdapter, snorkel_internal: snorkelAdapter, qc_upload: qcAdapter, qc_gsheet: gsheetAdapter, amazon_spapi: amazonAdapter, amazon_ads: amazonAdsAdapter, amazon_ads_product: amazonAdsProductAdapter, meta_ads: metaAdsAdapter, meta_status: metaStatusAdapter, google_ads: googleAdsAdapter, ga4: ga4Adapter, uniware: uniwareAdapter, uniware_agg: uniwareAggAdapter, razorpay_payments: razorpayPaymentsAdapter };

// minimal RFC-4180-ish CSV parser (handles quoted fields, commas, newlines)
function parseCSV(text) {
  const rows = []; let row = [], field = '', i = 0, q = false;
  while (i < text.length) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else {
      if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
    i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length && r.some(x => String(x).trim() !== ''));
}

// Parse a sheet/CSV date cell → 'YYYY-MM-DD' (IST calendar). Handles ISO, DD/MM/YYYY,
// DD-MM-YYYY, DD-Mon-YYYY. Indian sheets are day-first, so slash dates assume DD/MM unless
// the first part is clearly a month-impossible >12 the other way. Returns null if unparseable.
const _MON = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
function parseSheetDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);                          // ISO
  let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);                      // DD/MM/YYYY (day-first)
  if (m) {
    let [, a, b, y] = m; a = +a; b = +b; y = +y; if (y < 100) y += 2000;
    let day = a, mon = b; if (a > 12 && b <= 12) { day = a; mon = b; } else if (b > 12 && a <= 12) { day = b; mon = a; }
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) return `${y}-${String(mon).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  }
  m = s.match(/^(\d{1,2})[\-\s]([A-Za-z]{3})[A-Za-z]*[\-\s](\d{2,4})/);               // DD-Mon-YYYY
  if (m) { let [, d, mon, y] = m; const mm = _MON[mon.toLowerCase()]; y = +y; if (y < 100) y += 2000; if (mm) return `${y}-${String(mm).padStart(2,'0')}-${String(+d).padStart(2,'0')}`; }
  return null;
}

// Shared parser: a grid (header row + data rows) + a column map {date,sku,title,units,gross}
// (values = header text) → QC NormLine rows. Used by both the CSV upload and the Sheet adapter.
function gridToQcRows(grid, cm, fallbackDate) {
  if (!grid || grid.length < 2) throw new Error('Empty or header-only data');
  // Header isn't always row 1 (some tabs have title/blank rows above it). Find the first row
  // (within the first 20) that contains BOTH the configured sku + units header labels.
  const want = [String(cm.sku || '').toLowerCase(), String(cm.units || '').toLowerCase()];
  let hr = 0;
  for (let i = 0; i < Math.min(grid.length, 20); i++) {
    const cells = grid[i].map(c => String(c).trim().toLowerCase());
    if (want.every(w => w && cells.includes(w))) { hr = i; break; }
  }
  const header = grid[hr].map(h => String(h).trim());
  const idx = name => header.findIndex(h => h.toLowerCase() === String(name || '').toLowerCase());
  // status/order_id/discount/tax are optional (Amazon flat-file carries them; QC sheets don't).
  const ci = { sku: idx(cm.sku), title: idx(cm.title), units: idx(cm.units), gross: idx(cm.gross), date: idx(cm.date), status: idx(cm.status), order_id: idx(cm.order_id), discount: idx(cm.discount), tax: idx(cm.tax), ship_state: idx('ship-state'), ship_city: idx('ship-city') };
  if (ci.sku < 0 || ci.units < 0) throw new Error(`column_map needs sku + units to match real headers. Found header row: [${header.join(', ')}]`);
  const rows = [];
  for (let r = hr + 1; r < grid.length; r++) {
    const line = grid[r];
    const sku = String(line[ci.sku] ?? '').trim(); if (!sku) continue;
    // A full ISO datetime (Amazon purchase-date) → IST calendar day; a plain date string → parseSheetDate.
    let sale_date = null;
    if (ci.date >= 0) { const dc = String(line[ci.date] ?? '').trim(); sale_date = dc.includes('T') ? istDate(dc) : parseSheetDate(dc); }
    sale_date = sale_date || fallbackDate;
    const statusCell = ci.status >= 0 ? String(line[ci.status] ?? '').trim() : '';
    rows.push({
      row_no: r, channel_sku: sku,
      title: ci.title >= 0 ? String(line[ci.title] ?? '').trim() : null,
      qty: num(line[ci.units]), gross_value: ci.gross >= 0 ? num(line[ci.gross]) : 0, sale_date,
      discount_value: ci.discount >= 0 ? Math.abs(num(line[ci.discount])) : 0,   // promo-discount (positive amount)
      tax_value: ci.tax >= 0 ? num(line[ci.tax]) : 0,                            // GST within the tax-incl gross
      source_order_id: ci.order_id >= 0 ? (String(line[ci.order_id] ?? '').trim() || null) : null,
      order_status: statusCell || null, is_cancelled: /cancel/i.test(statusCell),
      ship_state: ci.ship_state >= 0 ? (String(line[ci.ship_state] ?? '').trim() || null) : null,
      ship_city:  ci.ship_city  >= 0 ? (String(line[ci.ship_city]  ?? '').trim() || null) : null,
      raw: { line },
    });
  }
  return rows;
}

// ============================================================
// PIPELINE — run log + sku resolution + fact upsert + per-channel executor
// ============================================================
async function startRun(cfg, trigger, userId, cursorBefore) {
  const r = await sbSales('/rest/v1/connector_runs', {
    method: 'POST', prefer: 'return=representation',
    body: JSON.stringify({ channel_id: cfg.channel_id, adapter_kind: cfg.adapter_kind, trigger, cursor_before: cursorBefore || cfg.cursor || null, status: 'running', started_by: userId || null }),
  });
  return (r.ok && r.data[0]) ? r.data[0].id : null;
}
async function finishRun(runId, patch) {
  if (!runId) return;
  await sbSales(`/rest/v1/connector_runs?id=eq.${runId}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ ...patch, finished_at: nowISO() }) });
}

// Resolve channel_skus present in staging for (channel, dates) → sku_map; misses → unmapped queue.
async function resolveSkus(channelId, dates, stgTable, userId) {
  if (!dates.length) return { mapped: 0, unmapped: 0 };
  const dl = inList(dates);
  const stg = await sbSales(`/rest/v1/${stgTable}?channel_id=eq.${channelId}&sale_date=in.${dl}&is_cancelled=is.false&row_type=eq.sale&select=channel_sku,title,qty,gross_value`);
  const agg = {};
  for (const r of (stg.ok ? stg.data : [])) {
    const k = r.channel_sku; if (!k) continue;
    (agg[k] = agg[k] || { units: 0, gross: 0, title: r.title }).units += num(r.qty);
    agg[k].gross += num(r.gross_value);
  }
  const skus = Object.keys(agg);
  if (!skus.length) return { mapped: 0, unmapped: 0 };
  const existing = await sbSales(`/rest/v1/sku_map?channel_id=eq.${channelId}&channel_sku=in.${inList(skus)}&select=channel_sku`);
  const mapped = new Set((existing.ok ? existing.data : []).map(x => x.channel_sku));
  const unknown = skus.filter(s => !mapped.has(s));
  if (!unknown.length) return { mapped: skus.length, unmapped: 0 };
  // one product_master fetch; match by sku → ean → product_code
  const pm = await sbPublic('/rest/v1/product_master?is_active=eq.true&select=product_code,sku,ean');
  const bySku = {}, byEan = {}, byCode = {};
  for (const p of (pm.ok ? pm.data : [])) { if (p.sku) bySku[p.sku] = p.product_code; if (p.ean) byEan[p.ean] = p.product_code; byCode[p.product_code] = p.product_code; }
  const mapInserts = [], unmappedRows = [];
  for (const s of unknown) {
    const code = bySku[s] || byEan[s] || byCode[s] || null;
    if (code) mapInserts.push({ channel_id: channelId, channel_sku: s, product_code: code, match_on: bySku[s] ? 'sku' : (byEan[s] ? 'ean' : 'product_code'), created_by: userId || null });
    else unmappedRows.push({ channel_id: channelId, channel_sku: s, sample_title: agg[s].title || null, last_seen: nowISO(), pending_units: Math.round(agg[s].units), pending_gross: agg[s].gross, status: 'open' });
  }
  if (mapInserts.length) await sbSales('/rest/v1/sku_map', { method: 'POST', prefer: 'return=minimal,resolution=merge-duplicates', body: JSON.stringify(mapInserts) });
  if (unmappedRows.length) await sbSales('/rest/v1/unmapped_sku', { method: 'POST', prefer: 'return=minimal,resolution=merge-duplicates', body: JSON.stringify(unmappedRows) });
  return { mapped: skus.length - unmappedRows.length, unmapped: unmappedRows.length };
}
async function mapAndUpsert(channelId, dates, runId, stgTable, userId) {
  const r = await resolveSkus(channelId, dates, stgTable, userId);
  const f = await rpcSales('recompute_facts', { p_channel: channelId, p_dates: dates, p_run_id: runId });
  return { ...r, factsUpserted: (f.ok ? Number(f.data) : 0) };
}
const distinctDates = rows => uniq(rows.map(r => r.sale_date));

// Execute one channel end-to-end. budget = subrequest allowance for this run.
async function executeRun(cfg, runId, env, { budget = CRON_BUDGET, cursorOverride } = {}) {
  const adapter = ADAPTERS[cfg.adapter_kind];
  if (!adapter) { await finishRun(runId, { status: 'error', error: `Unknown adapter ${cfg.adapter_kind}` }); return { subreqs: 0 }; }
  try {
    const cname = await channelName(cfg.channel_id);
    const cursor = cursorOverride !== undefined ? cursorOverride : cfg.cursor;
    const fetched = await adapter.fetch({ env, channelId: cfg.channel_id, channelName: cname, cursor, windowTo: nowISO(), budget, config: cfg.config });
    const { rows, cursorAfter, subreqs, partial } = fetched;
    await adapter.stage(rows, runId, cfg.channel_id, fetched);
    // Sales adapters use sale_date + the SKU-mapping tail (default). Non-sales domains
    // (marketing/traffic) supply their own date field (datesOf) + their own recompute.
    const dates = adapter.datesOf ? adapter.datesOf(rows, fetched) : distinctDates(rows);
    let res = { mapped: 0, unmapped: 0, factsUpserted: 0 };
    if (dates.length) {
      res = adapter.recompute
        ? await adapter.recompute({ channelId: cfg.channel_id, dates, runId, fetched })
        : await mapAndUpsert(cfg.channel_id, dates, runId, adapter.stgTable, cfg.started_by);
    }
    await finishRun(runId, { status: partial ? 'partial' : 'ok', rows_fetched: rows.length, rows_mapped: res.mapped, rows_unmapped: res.unmapped, facts_upserted: res.factsUpserted, subrequests_used: subreqs, cursor_after: cursorAfter });
    // Advance the live cursor whenever we have a watermark — INCLUDING partial pulls.
    // Adapters page strictly forward (Shopify by ascending updated_at), so on a budget-capped
    // partial we've fully ingested everything ≤ cursorAfter; advancing lets the next run continue
    // forward instead of re-pulling the same oldest window forever (the "stuck at Nov 2025" bug).
    // Always stamp success (clears any stale last_error + sets last_ok_at), even for adapters that
    // return no cursor (gsheet/qc) — otherwise a prior error lingers forever after a clean run.
    const okPatch = { last_ok_at: nowISO(), last_error: null };
    if (cursorAfter) okPatch.cursor = cursorAfter;
    await sbSales(`/rest/v1/connector_config?channel_id=eq.${cfg.channel_id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(okPatch) });
    // Workflow loop hints (small, serializable — never return row arrays):
    //  partial → more work remains for this connector (another window, or a pending report)
    //  waitMs  → an async report is still processing (partial + no rows + no cursor advance);
    //            the workflow step.sleeps this long instead of hot-looping. 0 = continue now.
    const waitMs = (partial && rows.length === 0 && !cursorAfter) ? 10 * 60 * 1000 : 0;
    return { subreqs, partial: !!partial, cursorAfter: cursorAfter || null, status: partial ? 'partial' : 'ok', rows: rows.length, waitMs };
  } catch (e) {
    await finishRun(runId, { status: 'error', error: String(e?.message || e) });
    await sbSales(`/rest/v1/connector_config?channel_id=eq.${cfg.channel_id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ last_error: String(e?.message || e) }) });
    return { subreqs: 0, partial: false, cursorAfter: null, status: 'error', rows: 0, waitMs: 0, error: String(e?.message || e) };
  }
}
async function runChannel(cfg, trigger, env, userId, opts = {}) {
  const runId = await startRun(cfg, trigger, userId);
  return executeRun({ ...cfg, started_by: userId }, runId, env, opts);
}

// Load one connector's live config row (fresh — picks up a cursor advanced by a prior step).
async function loadConnectorCfg(channelId) {
  const r = await sbSales(`/rest/v1/connector_config?channel_id=eq.${channelId}&select=*`);
  return (r.ok && r.data[0]) ? r.data[0] : null;
}
// Spawn a ConnectorWorkflow instance for one connector. SINGLE-FLIGHT for ALL spawn paths
// (cron, manual refresh, backfill): if an instance is already in flight for this connector, do
// NOT start a second — return the running id. Two concurrent instances for one connector double-
// pull and collide on that connector's staging writes (the stg_amazon_fin lock-timeout incident).
async function startConnectorWf(env, channelId, trigger, cursorOverride) {
  const cur = await sbSales(`/rest/v1/connector_config?channel_id=eq.${channelId}&select=wf_instance_id`);
  const existing = (cur.ok && cur.data[0]) ? cur.data[0].wf_instance_id : null;
  if (existing) {
    try {
      const st = await (await env.CONNECTOR_WF.get(existing)).status();
      if (['queued', 'running', 'waiting', 'paused'].includes(st?.status)) return existing; // already in flight
    } catch { /* unknown/expired id → safe to start a new one */ }
  }
  const id = `${channelId}-${Date.now()}`;
  await env.CONNECTOR_WF.create({ id, params: { channelId, trigger, cursorOverride: cursorOverride || null } });
  await sbSales(`/rest/v1/connector_config?channel_id=eq.${channelId}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ wf_instance_id: id }) });
  return id;
}

// QC report ingest — download file from Storage, parse, supersede, stage, map.
async function ingestUpload(batch, env) {
  const cm = batch.column_map || {};
  let text;
  if (batch.csv_text != null) {
    text = String(batch.csv_text);                 // inline upload (frontend sent the CSV body)
  } else {
    const dl = await fetch(`${SUPABASE_URL}/storage/v1/object/salesops-uploads/${batch.storage_path}`, { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } });
    if (!dl.ok) throw new Error('File download failed (' + dl.status + ')');
    text = await dl.text();
  }
  const grid = parseCSV(text);
  const rows = gridToQcRows(grid, cm, batch.report_period_to || batch.report_period_from || todayISO());
  // supersede prior staged rows for this channel over the report period
  const from = batch.report_period_from || rows.reduce((m, x) => x.sale_date < m ? x.sale_date : m, rows[0]?.sale_date || todayISO());
  const to   = batch.report_period_to   || rows.reduce((m, x) => x.sale_date > m ? x.sale_date : m, rows[0]?.sale_date || todayISO());
  await sbSales(`/rest/v1/stg_qc?channel_id=eq.${batch.channel_id}&sale_date=gte.${from}&sale_date=lte.${to}`, { method: 'DELETE', prefer: 'return=minimal' });
  if (rows.length) {
    const body = rows.map(r => ({ channel_id: batch.channel_id, upload_batch_id: batch.id, row_no: r.row_no, sale_date: r.sale_date, channel_sku: r.channel_sku, title: r.title, qty: Math.round(r.qty), gross_value: r.gross_value, is_cancelled: false, raw: r.raw }));
    await sbInsertChunked('/rest/v1/stg_qc?on_conflict=upload_batch_id,row_no', body, 'return=minimal,resolution=merge-duplicates');
  }
  const dates = distinctDates(rows);
  const res = dates.length ? await mapAndUpsert(batch.channel_id, dates, null, 'stg_qc', batch.uploaded_by) : { mapped: 0, unmapped: 0, factsUpserted: 0 };
  await sbSales(`/rest/v1/upload_batch?id=eq.${batch.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'mapped', rows_total: rows.length, rows_mapped: res.mapped, rows_unmapped: res.unmapped, parsed_at: nowISO() }) });
  return { rows_total: rows.length, ...res };
}

// ============================================================
// One instance per connector. Each step.do() is a fresh execution with its own 50-subreq
// budget; the loop drains windows until the adapter reports no more work (partial=false),
// sleeping when an async report is still processing (waitMs>0). executeRun is idempotent,
// so any step retry is safe.
export class ConnectorWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    SUPABASE_SERVICE_KEY = this.env.SUPABASE_SERVICE_KEY || '';
    _channels = null;
    const { channelId, trigger = 'cron', cursorOverride = null } = event.payload || {};
    // Per-connector window cap (default MAX_WINDOWS). A deep one-time backfill — e.g. the Uniware
    // aggregator walking ~70 daily windows — can set config.wf_max_windows higher so one instance
    // finishes in a single pass instead of resuming across many cron ticks. Read once (durable step).
    const maxW = await step.do('window-cap', async () => {
      SUPABASE_SERVICE_KEY = this.env.SUPABASE_SERVICE_KEY || '';
      const c0 = await loadConnectorCfg(channelId);
      return Math.min(Number(c0?.config?.wf_max_windows) || MAX_WINDOWS, 500);
    });
    for (let i = 0; i < maxW; i++) {
      const res = await step.do(
        `window-${i}`,
        { retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' }, timeout: '5 minutes' },
        async () => {
          SUPABASE_SERVICE_KEY = this.env.SUPABASE_SERVICE_KEY || '';
          _channels = null;
          const cfg = await loadConnectorCfg(channelId);
          if (!cfg || !cfg.enabled) return { partial: false, status: 'skipped', rows: 0, waitMs: 0, subreqs: 0, cursorAfter: null };
          const ov = (i === 0 && cursorOverride) ? cursorOverride : undefined;
          const runId = await startRun(cfg, trigger, null, ov);
          return await executeRun({ ...cfg, started_by: null }, runId, this.env, { budget: 50, cursorOverride: ov });
        }
      );
      if (!res || !res.partial) break;
      if (res.waitMs) await step.sleep(`wait-${i}`, res.waitMs);
    }
    return { channelId, windows: 'done' };
  }
}

// ── Conversion-tracking layer (b): website-changes stream (change-log.ndjson) ──
// PULL, not POST: odoops fetches the canonical change-log from the PRIVATE legendoftoys-website repo
// via the GitHub Contents API (base64 content) using a read-only fine-grained PAT (GITHUB_WEBSITE_PAT),
// and upserts ON CONFLICT(id) so edits (result pending→+0.4pp, status shipped→reverted) propagate each
// tick. The file stays the single source of truth; change_events is a read-replica. Generic `stream`
// column so stock-events + future streams share the table.
function ghDecodeBase64(b64) {
  const bin = atob(String(b64 || '').replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);   // UTF-8 so arrows (→ ↑) in hypotheses survive
}
async function syncChangeEvents(env) {
  if (!env.GITHUB_WEBSITE_PAT) return { skipped: 'GITHUB_WEBSITE_PAT not set' };
  const repo = env.GITHUB_WEBSITE_REPO || 'legendlot/legendoftoys-website';
  const path = env.GITHUB_CHANGELOG_PATH || 'analytics/change-log.ndjson';
  const ref = env.GITHUB_WEBSITE_BRANCH || 'main';
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`, {
    headers: { Authorization: `Bearer ${env.GITHUB_WEBSITE_PAT}`, Accept: 'application/vnd.github+json', 'User-Agent': 'odoops-worker', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!r.ok) throw new Error(`GitHub contents ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}`);
  const j = await r.json();
  const text = j.encoding === 'base64' ? ghDecodeBase64(j.content) : String(j.content || '');
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim(); if (!s) continue;
    let o; try { o = JSON.parse(s); } catch { continue; }
    if (!o || o._meta || !o.id || !o.date) continue;     // skip the _meta header + invalid lines
    rows.push({
      id: String(o.id), stream: o.stream || 'website', the_date: o.date,
      workstream: o.workstream || null, surface: o.surface || null, title: o.title || null,
      hypothesis: o.hypothesis || null, change_type: o.change_type || null,
      files: o.files != null ? JSON.stringify(o.files) : null, metric: o.metric || null,
      status: o.status || null, result: o.result || null, raw: o, synced_at: new Date().toISOString(),
    });
  }
  if (rows.length) await sbInsertChunked('/rest/v1/change_events?on_conflict=id', rows, 'return=minimal,resolution=merge-duplicates');
  return { count: rows.length, repo, path };
}

// ── Stock in/out stream (S189 — conversion-tracking layer c) ──────
// Snapshot native Shopify inventory (variant grain) daily → diff vs each SKU's prior snapshot →
// emit sales.change_events (stream='stock'). "Purchasable" (buyable on the site today) = ACTIVE
// product AND (untracked OR inventoryPolicy CONTINUE OR qty>0). Shopify has NO historical
// inventory API → forward-only (no backfill); the CR spine keeps history, stock markers start now.
async function syncInventorySnapshot(env) {
  if (!env.SHOPIFY_STORE_DOMAIN || !env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) return { skipped: 'Shopify not configured' };
  const ver = env.SHOPIFY_API_VERSION || SHOPIFY_API_VERSION_DEFAULT;
  // Website channel + its sku_map (channel_sku → product_code), so stock events key on product_code.
  const cc = await sbSales('/rest/v1/connector_config?adapter_kind=eq.shopify&select=channel_id&limit=1');
  const webId = (cc.ok && cc.data[0]) ? cc.data[0].channel_id : null;
  const skuMap = new Map();
  if (webId) {
    const mm = await sbSales(`/rest/v1/sku_map?channel_id=eq.${webId}&select=channel_sku,product_code`);
    for (const r of (mm.ok ? mm.data : [])) skuMap.set(String(r.channel_sku), r.product_code);
  }
  const gql = `query($after:String){ productVariants(first:250, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ sku inventoryQuantity inventoryPolicy inventoryItem{ tracked } product{ title status } } } }`;
  let token = await getShopifyToken(env);
  if (!token) throw new Error('Shopify auth failed (client credentials)');
  const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const bySku = new Map(); let after = null, hasNext = true, pages = 0;
  while (hasNext && pages < 8) {
    pages++;
    const run = (tok) => fetch(`https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${ver}/graphql.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': tok },
      body: JSON.stringify({ query: gql, variables: { after } }),
    });
    let res = await run(token).catch(() => null);
    if (res && res.status === 401) { token = await getShopifyToken(env, true); if (!token) throw new Error('Shopify auth lost'); res = await run(token).catch(() => null); }
    if (!res || !res.ok) throw new Error(`Shopify inventory ${res ? res.status : 'network'}`);
    const data = await res.json().catch(() => null);
    if (data?.errors?.length) throw new Error('Shopify GQL: ' + data.errors[0].message);
    const conn = data?.data?.productVariants;
    for (const v of (conn?.nodes || [])) {
      const sku = v.sku && String(v.sku).trim();
      if (!sku) continue;   // can't key an inventory row without a SKU
      const active = (v.product?.status || '').toUpperCase() === 'ACTIVE';
      const tracked = v.inventoryItem?.tracked !== false;      // treat unknown as tracked
      const policy = (v.inventoryPolicy || '').toUpperCase();
      const qty = num(v.inventoryQuantity);
      const purchasable = active && (!tracked || policy === 'CONTINUE' || qty > 0);
      bySku.set(sku, { the_date: today, sku, product_code: skuMap.get(sku) || null,
        product_title: v.product?.title || null, available_qty: Math.round(qty), purchasable,
        captured_at: new Date().toISOString() });   // last variant wins if a SKU repeats (rare)
    }
    hasNext = conn?.pageInfo?.hasNextPage; after = conn?.pageInfo?.endCursor;
  }
  const rows = [...bySku.values()];
  if (rows.length) await sbInsertChunked('/rest/v1/inventory_snapshot?on_conflict=the_date,sku', rows, 'return=minimal,resolution=merge-duplicates');
  const rc = await rpcSales('recompute_stock_events', { p_date: today });
  return { date: today, variants: rows.length, mapped: rows.filter(r => r.product_code).length, flips: (rc.ok ? rc.data : null) };
}

export default {
  async scheduled(event, env, ctx) {
    SUPABASE_SERVICE_KEY = env.SUPABASE_SERVICE_KEY || '';
    _channels = null;
    try {
      // PRODUCER: spawn one ConnectorWorkflow per enabled connector. Single-flight — skip a
      // connector whose previous instance is still in flight (long backfill), so we never run two
      // instances for the same connector concurrently. Each instance gets its own per-step subrequest
      // budget, so connectors no longer compete for one shared 45-subreq tick budget (the starvation
      // that left daily sell-out connectors stale since S166/S168 — see the Workflows design spec).
      // startConnectorWf is single-flight (skips a connector already in flight), so the producer
      // just asks for each enabled connector.
      const r = await sbSales('/rest/v1/connector_config?enabled=eq.true&select=channel_id,adapter_kind');
      for (const cfg of (r.ok ? r.data : [])) {
        // Member channels (adapter_kind='uniware') are fed by the uniware_agg aggregator, not run
        // independently — skip them so we don't re-spawn the retired per-channel pull (S187).
        if (cfg.adapter_kind === 'uniware') continue;
        try { await startConnectorWf(env, cfg.channel_id, 'cron', null); }
        catch (e) { console.error('odoops producer: failed to start', cfg.channel_id, e?.message || e); }
      }
    } catch (e) { console.error('odoops cron (producer) failed:', e?.message || e); }
    // Phase 2: auto-pause engine ads past the kill gate (free — only lowers spend; no-op while
    // ads_write_enabled is false). Self-contained + best-effort; never disturbs the producer above.
    try { await adsAutoPause(env); } catch (e) { console.error('odoops cron (auto-pause) failed:', e?.message || e); }
    // Daily conversion-funnel snapshot: refresh the trailing window from traffic_fact (GA4 keeps
    // revising recent days; older days stay frozen at their last value). The audit spine for the
    // /funnel Conversion-history page. Cheap (one RPC); best-effort.
    try {
      const istMs = Date.now() + 5.5 * 3600 * 1000;
      const to = new Date(istMs).toISOString().slice(0, 10);
      const from = new Date(istMs - 8 * 86400000).toISOString().slice(0, 10);
      await rpcSales('recompute_conversion_snapshot', { p_from: from, p_to: to });
    } catch (e) { console.error('odoops cron (conversion snapshot) failed:', e?.message || e); }
    // Website-changes stream: pull change-log.ndjson from the Website repo + upsert change_events
    // (no-op until GITHUB_WEBSITE_PAT is set). Best-effort; never disturbs the rest of the cron.
    try { await syncChangeEvents(env); } catch (e) { console.error('odoops cron (change events) failed:', e?.message || e); }
    // Stock in/out stream (layer c): snapshot native Shopify inventory + diff → stock change_events.
    // Best-effort; never disturbs the rest of the cron.
    try { await syncInventorySnapshot(env); } catch (e) { console.error('odoops cron (inventory snapshot) failed:', e?.message || e); }
    // L142: full-staging unmapped-SKU sweep — keeps the /mapping queue complete for SKUs that
    // fell outside per-window resolveSkus. One set-based RPC; best-effort.
    try { await rpcSales('reconcile_unmapped_sku', {}); } catch (e) { console.error('odoops cron (reconcile unmapped) failed:', e?.message || e); }
  },

  async fetch(request, env, ctx) {
    SUPABASE_SERVICE_KEY = env.SUPABASE_SERVICE_KEY || '';
    _channels = null;
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    // ── Razorpay payment webhook (S185) — no JWT; verified by HMAC signature ──
    if (request.method === 'POST' && url.pathname === '/webhook/razorpay') {
      const raw = await request.text();
      const okSig = await verifyRazorpaySig(raw, request.headers.get('X-Razorpay-Signature') || '', env.RAZORPAY_WEBHOOK_SECRET || '');
      if (!okSig) return new Response('invalid signature', { status: 401 });
      let body = {}; try { body = JSON.parse(raw); } catch { /* ignore */ }
      if (String(body.event || '').startsWith('payment.')) {
        const p = body.payload?.payment?.entity;
        if (p && p.id) {
          try { await sbInsertChunked('/rest/v1/stg_payments?on_conflict=provider,provider_payment_id', [{ run_id: null, ...mapRazorpayPayment(p, RAZORPAY_CHANNEL_ID) }], 'return=minimal,resolution=merge-duplicates'); }
          catch (_) { /* 200 anyway — Razorpay retries are fine; the API pull reconciles */ }
        }
      }
      return new Response('ok', { status: 200 });   // 200 fast; non-payment events ignored
    }

    const auth = await verifyJWT(request.headers.get('Authorization'));
    const userId = auth?.userId || null;
    const P = auth?.permissions || {};

    try {
      // ───────────────────────── GET ─────────────────────────
      if (request.method === 'GET') {
        if (!auth) return err('Unauthorised', 401);
        const qp = k => url.searchParams.get(k);
        switch (action) {
          case 'getMe':
          case 'ping':
            // Shape consumed by @throttle/auth AuthProvider.loadIdentity — identity fields MUST be top-level of `data`.
            return ok({ id: userId, email: auth.email, full_name: auth.fullName, role: auth.role, role_key: auth.roleKey, permissions: P });

          case 'getBootstrap': {
            const channels = await getChannels();
            const [cfgR, runR, unmR, setR] = await Promise.all([
              sbSales('/rest/v1/connector_config?select=*'),
              sbSales('/rest/v1/connector_runs?order=started_at.desc&limit=60&select=*'),
              sbSales('/rest/v1/unmapped_sku?status=eq.open&select=id'),
              sbSales('/rest/v1/settings?key=eq.drr_window_days&select=value'),
            ]);
            const drrWindowDays = Number((setR.ok && setR.data[0]) ? setR.data[0].value : 7) || 7;
            const cfgs = cfgR.ok ? cfgR.data : [];
            const runs = runR.ok ? runR.data : [];
            const lastByChannel = {}; runs.forEach(r => { if (!lastByChannel[r.channel_id]) lastByChannel[r.channel_id] = r; });
            const cfgByChannel = {}; cfgs.forEach(c => { cfgByChannel[c.channel_id] = c; });
            const connectors = channels.map(c => ({
              channel_id: c.id, name: c.name, type: c.type,
              adapter_kind: cfgByChannel[c.id]?.adapter_kind || null,
              enabled: !!cfgByChannel[c.id]?.enabled,
              cursor: cfgByChannel[c.id]?.cursor || null,
              last_ok_at: cfgByChannel[c.id]?.last_ok_at || null,
              last_error: cfgByChannel[c.id]?.last_error || null,
              last_run: lastByChannel[c.id] || null,
            }));
            let roles = [], accessUsers = [];
            if (canSuperAdmin(P)) {
              const [rolesR, urR, profR] = await Promise.all([
                sbStore('/rest/v1/salesops_roles?order=role_key.asc&select=*'),
                sbStore('/rest/v1/salesops_user_roles?select=user_id,role_key,active,disabled_at'),
                sbStore('/rest/v1/users_profile?select=id,full_name,active&order=full_name.asc'),
              ]);
              roles = rolesR.ok ? rolesR.data : [];
              const roleMeta = {}; roles.forEach(r => { roleMeta[r.role_key] = r; });
              const profById = {}; (profR.ok ? profR.data : []).forEach(u => { profById[u.id] = u; });
              accessUsers = (urR.ok ? urR.data : []).map(u => ({
                user_id: u.user_id, full_name: profById[u.user_id]?.full_name || '—', role_key: u.role_key,
                role_label: roleMeta[u.role_key]?.label || u.role_key, active: u.active !== false, disabled_at: u.disabled_at || null,
              })).sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
            }
            return ok({
              me: { id: userId, email: auth.email, full_name: auth.fullName, role_key: auth.roleKey, permissions: P },
              channels, connectors, unmapped_count: (unmR.ok ? unmR.data.length : 0), roles, accessUsers,
              drr_window_days: drrWindowDays,
            });
          }

          case 'wfProbe': {
            if (!canConnector(P)) return err('No permission', 403);
            const cid = qp('channel_id');
            if (!cid) return err('channel_id required');
            const cfgR = await sbSales(`/rest/v1/connector_config?channel_id=eq.${cid}&select=wf_instance_id,cursor,last_ok_at,last_error`);
            const cfg = (cfgR.ok && cfgR.data[0]) ? cfgR.data[0] : null;
            let status = null;
            if (cfg?.wf_instance_id) {
              try { status = await (await env.CONNECTOR_WF.get(cfg.wf_instance_id)).status(); }
              catch (e) { status = { error: String(e?.message || e) }; }
            }
            return ok({ channel_id: cid, wf_instance_id: cfg?.wf_instance_id || null, cursor: cfg?.cursor || null, last_ok_at: cfg?.last_ok_at || null, last_error: cfg?.last_error || null, status });
          }
          case 'getAmazonGeo': {
            if (!canView(P)) return err('No permission', 403);
            const r = await rpcSales('f_amazon_geo_rollup', { p_from: qp('from') || todayISO(), p_to: qp('to') || todayISO() });
            if (!r.ok) return err('Geo rollup failed: ' + JSON.stringify(r.data), 502);
            return ok({ rows: r.data || [] });
          }
          case 'getAmazonReturns': {
            if (!canView(P)) return err('No permission', 403);
            const r = await rpcSales('f_amazon_returns_rollup', { p_from: qp('from') || todayISO(), p_to: qp('to') || todayISO(), p_group: qp('group') || 'overall' });
            if (!r.ok) return err('Returns rollup failed: ' + JSON.stringify(r.data), 502);
            return ok({ rows: r.data || [] });
          }
          case 'getProductDrr': {
            if (!canView(P)) return err('No permission', 403);
            const w = qp('window');
            const r = await rpcSales('f_product_drr', { p_window: w ? Number(w) : null, p_ref_date: qp('ref_date') || null });
            if (!r.ok) return err('DRR failed: ' + JSON.stringify(r.data), 502);
            return ok({ rows: r.data || [] });
          }
          case 'getSales': {
            const chans = (qp('channel_id') || '').split(',').map(s => s.trim()).filter(Boolean);
            const r = await rpcSales('f_sales_rollup', {
              p_from: qp('from') || todayISO(), p_to: qp('to') || todayISO(),
              p_channels: chans.length ? chans : null, p_product_code: qp('product_code') || null, p_group: qp('group') || 'variant',
            });
            if (!r.ok) return err('Rollup failed: ' + JSON.stringify(r.data), 502);
            return ok({ rows: r.data || [] });
          }

          case 'getMarketing': {
            const r = await rpcSales('f_mkt_rollup', { p_from: qp('from') || todayISO(), p_to: qp('to') || todayISO(), p_group: qp('group') || 'platform' });
            if (!r.ok) return err('Marketing rollup failed: ' + JSON.stringify(r.data), 502);
            return ok({ rows: r.data || [] });
          }

          case 'getAdMetrics': {   // 2026-06-29 — ad-level (creative) ROAS for the LOT Ad Engine (Meta)
            if (!canView(P)) return err('No permission', 403);
            const r = await rpcSales('f_mkt_ad_rollup', { p_from: qp('from') || todayISO(), p_to: qp('to') || todayISO(), p_group: qp('group') || 'ad' });
            if (!r.ok) return err('Ad-metrics rollup failed: ' + JSON.stringify(r.data), 502);
            return ok({ rows: r.data || [] });
          }

          // ── Phase 2 (Ad Engine WRITE) — reads ──
          case 'adsGetPlans': {
            if (!canView(P)) return err('No permission', 403);
            const st = qp('status');
            const r = await sbSales(`/rest/v1/ads_plan?select=*${st ? `&status=eq.${encodeURIComponent(st)}` : ''}&order=created_at.desc&limit=50`);
            if (!r.ok) return err('Plans read failed: ' + JSON.stringify(r.data), 502);
            return ok({ rows: r.data || [] });
          }
          case 'adsGetLedger': {
            if (!canView(P)) return err('No permission', 403);
            const r = await sbSales(`/rest/v1/ads_ledger?select=*&order=created_at.desc&limit=${Math.min(Number(qp('limit')) || 100, 500)}`);
            if (!r.ok) return err('Ledger read failed: ' + JSON.stringify(r.data), 502);
            return ok({ rows: r.data || [] });
          }
          case 'adsGetManaged': {
            if (!canView(P)) return err('No permission', 403);
            const r = await sbSales(`/rest/v1/ads_managed?select=*&order=created_at.desc&limit=500`);
            if (!r.ok) return err('Managed read failed: ' + JSON.stringify(r.data), 502);
            const committed = await adsCommittedDailyInr();
            return ok({ rows: r.data || [], committed_daily_inr: committed, ceiling_inr: await adsCeilingInr(), write_enabled: await adsWriteEnabled() });
          }
          case 'getDynoBoard': {   // Dyno — creative testing-grounds live board (one row per variant + windowed Meta results + computed status)
            if (!canView(P)) return err('No permission', 403);
            const recentDays = Math.min(Math.max(Number(qp('recent_days')) || 3, 1), 30);
            const r = await rpcSales('f_dyno_board', {
              p_filter: qp('filter') || 'active', p_product: qp('product') || null,
              p_angle: qp('angle') || null, p_recent_days: recentDays });
            if (!r.ok) return err('Dyno board failed: ' + JSON.stringify(r.data), 502);
            return ok({ rows: r.data || [], recent_days: recentDays,
              committed_daily_inr: await adsCommittedDailyInr(), ceiling_inr: await adsCeilingInr(),
              write_enabled: await adsWriteEnabled() });
          }
          case 'getSegmentMap': {   // Dyno Matrix — raw audience_segment → canonical column map (Kidult/Parent/Family/Gifter)
            if (!canView(P)) return err('No permission', 403);
            const r = await sbSales('/rest/v1/lab_segment_map?select=raw,canonical');
            if (!r.ok) return err('Segment map read failed: ' + JSON.stringify(r.data), 502);
            return ok({ map: r.data || [], segments: ['Kidult', 'Parent', 'Family', 'Gifter'] });
          }
          case 'metaWriteProbe': {   // diagnostic: self-discover Page/Pixel ids + confirm ads_management scope (NO writes)
            if (!canAdsWrite(P)) return err('No permission', 403);
            const acct = await metaAdAccount(qp('account')).catch(e => { throw e; });
            const probe = {};
            const sub = async (key, fn) => { try { probe[key] = { ok: true, data: await fn() }; } catch (e) { probe[key] = { ok: false, error: String(e?.message || e) }; } };
            await sub('me',          () => metaGet(env, 'me', 'fields=id,name'));
            await sub('ad_account',  () => metaGet(env, `act_${acct}`, 'fields=id,name,account_status,currency,timezone_name,disable_reason'));
            await sub('pixels',      () => metaGet(env, `act_${acct}/adspixels`, 'fields=id,name,last_fired_time'));
            await sub('pages',       () => metaGet(env, 'me/accounts', 'fields=id,name,tasks&limit=50'));
            await sub('token',       () => metaGet(env, 'debug_token', `input_token=${env.META_SYSTEM_USER_TOKEN}`));
            const scopes = probe.token?.data?.data?.scopes || [];
            return ok({
              ad_account_id: acct, probe,
              scopes, has_ads_management: scopes.includes('ads_management'),
              write_enabled: await adsWriteEnabled(), ceiling_inr: await adsCeilingInr(),
              hint: 'Pixel id → probe.pixels.data[].id · Page id → probe.pages.data[].id · ads_management must be true to launch.',
            });
          }

          case 'getAdProduct': {   // S185 — product-grain Amazon ad metrics for the /amazon sellers table
            if (!canView(P)) return err('No permission', 403);
            const r = await rpcSales('f_mkt_product_rollup', { p_from: qp('from') || todayISO(), p_to: qp('to') || todayISO(), p_platform: qp('platform') || null });
            if (!r.ok) return err('Ad-product rollup failed: ' + JSON.stringify(r.data), 502);
            return ok({ rows: r.data || [] });
          }

          case 'getPaymentFunnel': {   // S185 — checkout payment funnel + tri-source reconciliation
            if (!canView(P)) return err('No permission', 403);
            const from = qp('from') || todayISO(), to = qp('to') || todayISO();
            const [fr, rc] = await Promise.all([
              rpcSales('f_payment_funnel', { p_from: from, p_to: to, p_provider: qp('provider') || 'razorpay' }),
              rpcSales('f_payment_recon', { p_from: from, p_to: to }),
            ]);
            if (!fr.ok) return err('Payment funnel failed: ' + JSON.stringify(fr.data), 502);
            return ok({ funnel: (fr.data && fr.data[0]) || {}, recon: (rc.ok && rc.data && rc.data[0]) || {} });
          }

          case 'getSettlement': {   // S186 — Amazon payout & fees (margin lens) for /amazon
            if (!canView(P)) return err('No permission', 403);
            const from = qp('from') || todayISO(), to = qp('to') || todayISO();
            const [byDate, byProd, recon] = await Promise.all([
              rpcSales('f_settlement_rollup', { p_from: from, p_to: to, p_group: 'date' }),
              rpcSales('f_settlement_rollup', { p_from: from, p_to: to, p_group: 'product' }),
              rpcSales('f_settlement_recon', { p_from: from, p_to: to }),
            ]);
            if (!byDate.ok) return err('Settlement rollup failed: ' + JSON.stringify(byDate.data), 502);
            return ok({ by_date: byDate.data || [], by_product: byProd.data || [], recon: recon.ok ? (recon.data || []) : [] });
          }
          case 'getConversionHistory': {   // S186 — daily website funnel (GA4 snapshot) for /funnel history
            if (!canView(P)) return err('No permission', 403);
            const r = await rpcSales('f_conversion_history', { p_from: qp('from') || todayISO(), p_to: qp('to') || todayISO() });
            if (!r.ok) return err('Conversion history failed: ' + JSON.stringify(r.data), 502);
            return ok({ rows: r.data || [] });
          }
          case 'getChangeEvents': {   // S186 — website-changes stream (annotations on the conversion timeline)
            if (!canView(P)) return err('No permission', 403);
            const from = qp('from') || todayISO(), to = qp('to') || todayISO();
            const streamF = qp('stream') ? `&stream=eq.${encodeURIComponent(qp('stream'))}` : '';
            const r = await sbSales(`/rest/v1/change_events?the_date=gte.${from}&the_date=lte.${to}${streamF}&order=the_date.asc&select=*`);
            if (!r.ok) return err('Change events read failed: ' + JSON.stringify(r.data), 502);
            return ok({ rows: r.data || [] });
          }
          case 'getPnl': {   // S189 — channel-wise P&L: master (all channels) + per-channel-family tables
            if (!canView(P)) return err('No permission', 403);
            const from = qp('from') || todayISO(), to = qp('to') || todayISO();
            const chans = await getChannels();   // is_sale channels {id,name}
            const byFam = {};
            for (const c of chans) { const k = pnlFamilyOf(c.name); (byFam[k] = byFam[k] || []).push(c.id); }
            const fams = PNL_FAMILIES.filter(f => (byFam[f.key] || []).length);
            const famResults = await Promise.all(fams.map(f =>
              rpcSales('f_pnl', { p_from: from, p_to: to, p_channels: byFam[f.key], p_ad_platforms: f.ads, p_channel_key: f.key })
                .then(r => ({ key: f.key, label: f.label, rows: (r.ok ? (r.data || []) : []) }))));
            const [companyR, sgaR] = await Promise.all([
              rpcSales('f_pnl', { p_from: from, p_to: to, p_channels: [], p_ad_platforms: [], p_channel_key: 'all' }),   // company-level manual (brand)
              rpcSales('f_pnl_sga', { p_from: from, p_to: to }),                                                          // SG&A seam (Podium later)
            ]);
            const company = companyR.ok ? (companyR.data || []) : [];
            const sga = {}; for (const r of (sgaR.ok ? (sgaR.data || []) : [])) sga[r.month] = Number(r.sga) || 0;
            const brand = {}; for (const r of company) brand[r.month] = Number(r.brand_marketing) || 0;
            const monthsSet = new Set(); famResults.forEach(f => f.rows.forEach(r => monthsSet.add(r.month))); company.forEach(r => monthsSet.add(r.month));
            const months = [...monthsSet].sort();
            const SUM = ['gmv', 'rto', 'refund', 'taxes', 'cogs', 'logistics', 'platform_fee', 'cac'];
            const master = months.map(m => {
              const row = { month: m }; for (const L of SUM) row[L] = 0;
              for (const f of famResults) { const fr = f.rows.find(x => x.month === m); if (fr) for (const L of SUM) row[L] += Number(fr[L]) || 0; }
              row.brand_marketing = brand[m] || 0; row.sga = sga[m] || 0;
              return row;
            });
            const channels = {}; for (const f of famResults) channels[f.key] = f.rows;
            return ok({ months, master, channels, families: famResults.map(f => ({ key: f.key, label: f.label })) });
          }
          case 'getPnlByProduct': {   // S189 — per-product P&L (through GM), all channels
            if (!canView(P)) return err('No permission', 403);
            const r = await rpcSales('f_pnl_by_product', { p_from: qp('from') || todayISO(), p_to: qp('to') || todayISO() });
            if (!r.ok) return err('Product P&L failed: ' + JSON.stringify(r.data), 502);
            return ok({ rows: r.data || [] });
          }
          case 'getProductCosts': {   // S189 — active SKUs + latest standard COGS (for the /pnl cost editor)
            if (!canView(P)) return err('No permission', 403);
            const [pm, pc] = await Promise.all([
              sbPublic('/rest/v1/product_master?is_active=eq.true&component_type=neq.remote&select=product_code,product,model,color&order=product.asc,model.asc,color.asc'),
              sbSales('/rest/v1/product_cost?select=product_code,cogs_inr,effective_from&order=effective_from.desc'),
            ]);
            const latest = {};
            for (const r of (pc.ok ? pc.data : [])) if (!(r.product_code in latest)) latest[r.product_code] = r;   // desc → first is latest
            const rows = (pm.ok ? pm.data : []).map(p => ({ ...p, cogs_inr: latest[p.product_code]?.cogs_inr ?? null, effective_from: latest[p.product_code]?.effective_from ?? null }));
            return ok({ rows });
          }
          case 'getPnlManual': {   // S189 — manual P&L lines in range (for the /pnl editable cells)
            if (!canView(P)) return err('No permission', 403);
            let q = '/rest/v1/pnl_manual?select=month,line_key,amount_inr,note&order=month.asc';
            if (qp('from')) q += `&month=gte.${qp('from')}`;
            if (qp('to')) q += `&month=lte.${qp('to')}`;
            const r = await sbSales(q);
            if (!r.ok) return err('Read failed: ' + JSON.stringify(r.data), 502);
            return ok({ rows: r.data || [] });
          }
          case 'getConversionDrivers': {   // S189 — attribution: notable CR days + nearby driver events (layer d)
            if (!canView(P)) return err('No permission', 403);
            const from = qp('from') || todayISO(), to = qp('to') || todayISO();
            const s = await sbSales('/rest/v1/settings?key=in.(cr_notable_pct,cr_driver_window_days,cr_impact_window_days)&select=key,value');
            const sm = {}; for (const r of (s.ok ? s.data : [])) sm[r.key] = Number(r.value);
            const notable = Number.isFinite(sm.cr_notable_pct) ? sm.cr_notable_pct : 15;
            const win = Number.isFinite(sm.cr_driver_window_days) ? sm.cr_driver_window_days : 2;
            const imp = Number.isFinite(sm.cr_impact_window_days) ? sm.cr_impact_window_days : 3;
            const [d, lib] = await Promise.all([
              rpcSales('f_conversion_drivers', { p_from: from, p_to: to, p_notable_pct: notable, p_window: win, p_impact: imp }),
              rpcSales('f_event_impacts', { p_from: from, p_to: to, p_impact: imp }),
            ]);
            if (!d.ok) return err('Conversion drivers failed: ' + JSON.stringify(d.data), 502);
            return ok({ days: d.data || [], library: (lib.ok ? lib.data : []), settings: { notable_pct: notable, window_days: win, impact_days: imp } });
          }
          case 'syncInventorySnapshotNow': {   // manual snapshot + diff (super-admin) — layer c test trigger
            if (!canSuperAdmin(P)) return err('No permission', 403);
            try { const res = await syncInventorySnapshot(env); return ok(res); }
            catch (e) { return err('Inventory snapshot failed: ' + String(e?.message || e), 502); }
          }
          case 'syncChangeEventsNow': {   // manual pull + diagnostic (super-admin)
            if (!canSuperAdmin(P)) return err('No permission', 403);
            try { const res = await syncChangeEvents(env); return ok(res); }
            catch (e) { return err('Change-events sync failed: ' + String(e?.message || e), 502); }
          }
          case 'settlementProbe': {   // diagnostic: does the account expose settlement reports + what's ingested
            if (!canSuperAdmin(P)) return err('No permission', 403);
            const ch = await sbSales(`/rest/v1/connector_config?adapter_kind=eq.amazon_spapi&select=channel_id,config&limit=1`);
            const cfg = (ch.ok && ch.data && ch.data[0] && ch.data[0].config) || {};
            const host = cfg.region_host || 'https://sellingpartnerapi-eu.amazon.com';
            const token = await getAmazonToken(env).catch(e => { throw e; });
            const H = { Authorization: `Bearer ${token}`, 'x-amz-access-token': token, 'Content-Type': 'application/json' };
            const lr = await fetch(`${host}/reports/2021-06-30/reports?reportTypes=${AMZ_SETTLEMENT_REPORT_TYPE}&processingStatuses=DONE&pageSize=100`, { headers: H });
            const lj = await lr.json().catch(() => ({}));
            const reports = (lj.reports || []).map(r => ({ reportId: r.reportId, hasDoc: !!r.reportDocumentId, dataStartTime: r.dataStartTime, dataEndTime: r.dataEndTime }));
            const seen = (cfg.settlement_seen || []).length;
            const cnt = await sbSales(`/rest/v1/stg_amazon_settlement?select=settlement_id`).catch(() => ({ data: [] }));
            const distinctSettlements = new Set((cnt.data || []).map(x => x.settlement_id)).size;
            return ok({ list_status: lr.status, available_done_reports: reports.length, reports: reports.slice(0, 20), ingested_report_ids: seen, distinct_settlements_staged: distinctSettlements });
          }
          case 'searchUsers': {   // S185 — searchable LOT-user directory for the access-control grant dropdown
            if (!canSuperAdmin(P)) return err('No permission', 403);
            const r = await sbStore('/rest/v1/rpc/search_lot_users', { method: 'POST', body: JSON.stringify({ p_q: qp('q') || '' }) });
            return r.ok ? ok({ rows: r.data || [] }) : err('User search failed: ' + JSON.stringify(r.data), 502);
          }

          case 'getTraffic': {
            const r = await rpcSales('f_traffic_rollup', { p_from: qp('from') || todayISO(), p_to: qp('to') || todayISO(), p_group: qp('group') || 'src' });
            if (!r.ok) return err('Traffic rollup failed: ' + JSON.stringify(r.data), 502);
            return ok({ rows: r.data || [] });
          }

          // Sales-value segregation (order-grain): gross/cancellations/discounts/returns/GST +
          // order-type counts, per (sale_date, channel). Populated for channels with order-grain
          // staging (Shopify now; Amazon/GT-MT later) — others simply have no rows here.
          case 'getSegregation': {
            const chans = (qp('channel_id') || '').split(',').map(s => s.trim()).filter(Boolean);
            const r = await rpcSales('f_order_rollup', {
              p_from: qp('from') || todayISO(), p_to: qp('to') || todayISO(),
              p_channels: chans.length ? chans : null,
            });
            if (!r.ok) return err('Segregation rollup failed: ' + JSON.stringify(r.data), 502);
            return ok({ rows: r.data || [], channels: await getChannels() });
          }

          case 'getSalesExport': {
            const chans = (qp('channel_id') || '').split(',').map(s => s.trim()).filter(Boolean);
            const r = await rpcSales('f_sales_rollup', {
              p_from: qp('from') || todayISO(), p_to: qp('to') || todayISO(),
              p_channels: chans.length ? chans : null, p_product_code: qp('product_code') || null, p_group: qp('group') || 'variant',
            });
            if (!r.ok) return err('Export failed: ' + JSON.stringify(r.data), 502);
            const chById = {}; (await getChannels()).forEach(c => { chById[c.id] = c.name; });
            const rows = (r.data || []).map(x => ({ sale_date: x.sale_date, channel: chById[x.channel_id] || x.channel_id, product_code: x.product_code, variant: x.grp_label, units: Number(x.units), gross_value: Number(x.gross_value) }));
            return ok({ rows });
          }

          case 'getConnectorStatus': {
            const channels = await getChannels();
            const [cfgR, runR] = await Promise.all([
              sbSales('/rest/v1/connector_config?select=*'),
              sbSales('/rest/v1/connector_runs?order=started_at.desc&limit=120&select=*'),
            ]);
            const cfgs = cfgR.ok ? cfgR.data : []; const runs = runR.ok ? runR.data : [];
            // Platform connectors (Meta Ads / GA4) are is_sale=false, so getChannels() excludes them.
            // Fetch their names directly so they still appear as manageable connector cards.
            const have = new Set(channels.map(c => c.id));
            const extraIds = [...new Set(cfgs.map(c => c.channel_id).filter(id => !have.has(id)))];
            let extra = [];
            if (extraIds.length) {
              const er = await sbPublic(`/rest/v1/dispatch_channels?id=in.(${extraIds.join(',')})&select=id,name,type`);
              extra = er.ok ? er.data : [];
            }
            const allCh = [...channels, ...extra];
            const lastByChannel = {}; runs.forEach(r => { if (!lastByChannel[r.channel_id]) lastByChannel[r.channel_id] = r; });
            const cfgByChannel = {}; cfgs.forEach(c => { cfgByChannel[c.channel_id] = c; });
            return ok({
              secrets: { shopify: !!(env.SHOPIFY_ACCESS_TOKEN || env.SHOPIFY_CLIENT_ID), amazon: !!env.AMAZON_LWA_CLIENT_ID, amazon_ads: !!env.AMAZON_ADS_CLIENT_ID, flipkart: !!env.FLIPKART_CLIENT_ID, google: !!env.GOOGLE_SA_JSON, meta: !!env.META_SYSTEM_USER_TOKEN, google_ads: !!(env.GOOGLE_ADS_DEVELOPER_TOKEN && env.GOOGLE_ADS_REFRESH_TOKEN), uniware: !!(env.UNIWARE_TENANT && env.UNIWARE_USERNAME && env.UNIWARE_PASSWORD) },
              connectors: allCh.map(c => ({ channel_id: c.id, name: c.name, adapter_kind: cfgByChannel[c.id]?.adapter_kind || null, enabled: !!cfgByChannel[c.id]?.enabled, cursor: cfgByChannel[c.id]?.cursor || null, last_ok_at: cfgByChannel[c.id]?.last_ok_at || null, last_error: cfgByChannel[c.id]?.last_error || null, last_run: lastByChannel[c.id] || null })),
            });
          }

          case 'getRuns': {
            const ch = qp('channel_id'); const f = ch ? `channel_id=eq.${ch}&` : '';
            const r = await sbSales(`/rest/v1/connector_runs?${f}order=started_at.desc&limit=200&select=*`);
            return ok({ runs: r.ok ? r.data : [] });
          }
          case 'getSkuMap': {
            const ch = qp('channel_id'); const f = ch ? `channel_id=eq.${ch}&` : '';
            const r = await sbSales(`/rest/v1/sku_map?${f}order=created_at.desc&limit=2000&select=*`);
            return ok({ rows: r.ok ? r.data : [] });
          }
          case 'getUnmapped': {
            const r = await sbSales('/rest/v1/unmapped_sku?status=eq.open&order=pending_units.desc&select=*');
            return ok({ rows: r.ok ? r.data : [] });
          }
          case 'getUploadBatches': {
            const r = await sbSales('/rest/v1/upload_batch?order=uploaded_at.desc&limit=100&select=*');
            return ok({ rows: r.ok ? r.data : [] });
          }
          case 'getVariants': {  // for the mapping picker
            const r = await sbPublic('/rest/v1/product_master?is_active=eq.true&select=product_code,product,model,color,sku,ean&order=product.asc');
            return ok({ rows: r.ok ? r.data : [] });
          }
          case 'amazonPeek': {  // diagnostic: inspect a report's status + raw document head (real headers / row count)
            if (!canConnector(P)) return err('No permission', 403);
            const rid = qp('report_id'); if (!rid) return err('report_id required');
            let token; try { token = await getAmazonToken(env); } catch (e) { return err(String(e?.message || e), 400); }
            const host = qp('host') || 'https://sellingpartnerapi-eu.amazon.com';
            const H = { Authorization: `Bearer ${token}`, 'x-amz-access-token': token };
            const pr = await fetch(`${host}/reports/2021-06-30/reports/${rid}`, { headers: H });
            const rep = await pr.json().catch(() => ({}));
            const info = { reportStatus: pr.status, processingStatus: rep.processingStatus, reportType: rep.reportType, dataStartTime: rep.dataStartTime, dataEndTime: rep.dataEndTime, reportDocumentId: rep.reportDocumentId, errors: rep.errors };
            if (rep.processingStatus !== 'DONE' || !rep.reportDocumentId) return ok(info);
            const dr = await fetch(`${host}/reports/2021-06-30/documents/${rep.reportDocumentId}`, { headers: H });
            const doc = await dr.json().catch(() => ({}));
            let text = '';
            try { text = await fetchAmazonDoc(doc); } catch (e) { return ok({ ...info, docStatus: dr.status, compression: doc.compressionAlgorithm || null, docError: String(e?.message || e) }); }
            const lines = text.split(/\r?\n/);
            return ok({ ...info, docStatus: dr.status, compression: doc.compressionAlgorithm || null, textLength: text.length, lineCount: lines.length, head: text.slice(0, 2000) });
          }
          case 'amazonProbe': {  // diagnostic: which marketplaces does the LWA token actually cover? (NA/EU/FE)
            if (!canConnector(P)) return err('No permission', 403);
            let token;
            try { token = await getAmazonToken(env); } catch (e) { return err(String(e?.message || e), 400); }
            const H = { Authorization: `Bearer ${token}`, 'x-amz-access-token': token };
            const hosts = { na: 'https://sellingpartnerapi-na.amazon.com', eu: 'https://sellingpartnerapi-eu.amazon.com', fe: 'https://sellingpartnerapi-fe.amazon.com' };
            const out = {};
            for (const [k, host] of Object.entries(hosts)) {
              try {
                const r = await fetch(`${host}/sellers/v1/marketplaceParticipations`, { headers: H });
                const j = await r.json().catch(() => ({}));
                out[k] = { host, status: r.status,
                  marketplaces: (j.payload || []).map(p => ({ id: p.marketplace?.id, name: p.marketplace?.name, country: p.marketplace?.countryCode, participating: p.participation?.isParticipating })),
                  error: j.errors ? (j.errors[0]?.message || JSON.stringify(j.errors)) : undefined };
              } catch (e) { out[k] = { host, error: String(e?.message || e) }; }
            }
            return ok(out);
          }
          case 'financeProbe': {  // diagnostic: parse one Finances window (no staging) — verify the mapping
            if (!canConnector(P)) return err('No permission', 403);
            let token; try { token = await getAmazonToken(env); } catch (e) { return err(String(e?.message || e), 400); }
            const host = qp('host') || 'https://sellingpartnerapi-eu.amazon.com';
            const H = { Authorization: `Bearer ${token}`, 'x-amz-access-token': token, 'Content-Type': 'application/json' };
            const after = qp('after'); const before = qp('before');
            if (!after || !before) return err('after + before (ISO) required');
            const r = await fetch(`${host}/finances/v0/financialEvents?MaxResultsPerPage=100&PostedAfter=${encodeURIComponent(after)}&PostedBefore=${encodeURIComponent(before)}`, { headers: H });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) return err(`finances ${r.status}: ${JSON.stringify(j).slice(0, 200)}`, 400);
            const fe = j.payload?.FinancialEvents || {};
            const ev = parseAmazonFinance(fe);
            const ship = ev.filter(e => e.event_type === 'shipment'), ref = ev.filter(e => e.event_type === 'refund');
            return ok({ status: r.status, hasNextToken: !!j.payload?.NextToken,
              shipmentItems: ship.length, refundItems: ref.length,
              shipTotals: { principal: ship.reduce((s, e) => s + e.principal, 0), tax: ship.reduce((s, e) => s + e.tax, 0), promo: ship.reduce((s, e) => s + e.promo, 0) },
              sampleShipment: ship[0] || null, sampleRefund: ref[0] || null });
          }
          case 'salesTrafficProbe': {  // diagnostic (S185): SP-API Sales & Traffic report = the 3P Amazon funnel (sessions→units per ASIN)
            if (!canConnector(P)) return err('No permission', 403);
            let token; try { token = await getAmazonToken(env); } catch (e) { return err(String(e?.message || e), 400); }
            const host = qp('host') || 'https://sellingpartnerapi-eu.amazon.com';
            const mkt = qp('mkt') || 'A21TJRUUN4KGV';   // India
            const H = { Authorization: `Bearer ${token}`, 'x-amz-access-token': token, 'Content-Type': 'application/json' };
            const rid = qp('report_id');
            if (!rid) {
              const day = qp('day') || new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
              const body = { reportType: 'GET_SALES_AND_TRAFFIC_REPORT', marketplaceIds: [mkt], dataStartTime: day + 'T00:00:00Z', dataEndTime: day + 'T23:59:59Z', reportOptions: { dateGranularity: 'DAY', asinGranularity: 'CHILD' } };
              const cr = await fetch(`${host}/reports/2021-06-30/reports`, { method: 'POST', headers: H, body: JSON.stringify(body) });
              const cj = await cr.json().catch(() => ({}));
              if (!cr.ok) return err(`createReport ${cr.status}: ${JSON.stringify(cj).slice(0, 240)}`, cr.status);
              return ok({ created: cj.reportId, day, note: 'poll again: &action=salesTrafficProbe&report_id=' + cj.reportId });
            }
            const pr = await fetch(`${host}/reports/2021-06-30/reports/${rid}`, { headers: H });
            const rep = await pr.json().catch(() => ({}));
            if (rep.processingStatus !== 'DONE' || !rep.reportDocumentId) return ok({ processingStatus: rep.processingStatus, errors: rep.errors });
            const dr = await fetch(`${host}/reports/2021-06-30/documents/${rep.reportDocumentId}`, { headers: H });
            const doc = await dr.json().catch(() => ({}));
            let text = ''; try { text = await fetchAmazonDoc(doc); } catch (e) { return ok({ docError: String(e?.message || e) }); }
            let j = {}; try { j = JSON.parse(text); } catch { /* not json */ }
            const byDate = j.salesAndTrafficByDate || [], byAsin = j.salesAndTrafficByAsin || [];
            return ok({ topKeys: Object.keys(j), byDateCount: byDate.length, byAsinCount: byAsin.length, sampleByDate: byDate[0] || null, sampleByAsin: byAsin[0] || null });
          }
          case 'dspGateProbe': {  // diagnostic (S185): does the CURRENT Ads token already reach Amazon DSP? (200 = yes; 401/403 = needs entitlement)
            if (!canConnector(P)) return err('No permission', 403);
            let token; try { token = await getAmazonAdsToken(env); } catch (e) { return err(String(e?.message || e), 400); }
            const host = 'https://advertising-api-eu.amazon.com';
            const profileId = qp('profile') || '202246193452230';
            const H = { 'Amazon-Advertising-API-ClientId': env.AMAZON_ADS_CLIENT_ID, 'Amazon-Advertising-API-Scope': profileId, Authorization: `Bearer ${token}` };
            const out = {};
            for (const [k, path] of Object.entries({ dsp_advertisers: '/dsp/advertisers?count=10', dsp_v3_reports: '/dsp/reports' })) {
              try { const r = await fetch(`${host}${path}`, { headers: H }); out[k] = { status: r.status, body: (await r.text().catch(() => '')).slice(0, 240) }; }
              catch (e) { out[k] = { error: String(e?.message || e) }; }
            }
            return ok({ profileId, note: '200 = DSP reachable now; 401/403 = needs entitlement', ...out });
          }
          case 'searchTermProbe': {  // diagnostic (S185): Ads API search-term report (Nikhil P2 — keyword winners/leaks)
            if (!canConnector(P)) return err('No permission', 403);
            const host = 'https://advertising-api-eu.amazon.com', profileId = qp('profile') || '202246193452230';
            let token; try { token = await getAmazonAdsToken(env); } catch (e) { return err(String(e?.message || e), 400); }
            const H = { 'Amazon-Advertising-API-ClientId': env.AMAZON_ADS_CLIENT_ID, 'Amazon-Advertising-API-Scope': profileId, Authorization: `Bearer ${token}`, 'Content-Type': 'application/vnd.createasyncreportrequest.v3+json' };
            const rid = qp('report_id');
            if (!rid) {
              const end = amzAdsDay(Date.now() - 2 * 86400000), start = amzAdsDay(Date.now() - 5 * 86400000);
              const cols = ['date', 'campaignId', 'adGroupId', 'keyword', 'searchTerm', 'matchType', 'impressions', 'clicks', 'cost', 'purchases14d', 'sales14d'];
              try { const id = await createAdsReport(host, H, 'SPONSORED_PRODUCTS', 'spSearchTerm', start, end, ['searchTerm'], cols); return ok({ created: id, note: 'poll: &action=searchTermProbe&report_id=' + id }); }
              catch (e) { return err(String(e?.message || e), 502); }
            }
            const pr = await fetch(`${host}/reporting/reports/${rid}`, { headers: H });
            const rep = await pr.json().catch(() => ({}));
            const st = (rep.status || '').toUpperCase();
            if (st !== 'COMPLETED') return ok({ status: st, failureReason: rep.failureReason || null });
            let sample = [], count = 0, keys = [];
            if (rep.url) { const dl = await fetch(rep.url); const text = await new Response(dl.body.pipeThrough(new DecompressionStream('gzip'))).text(); let arr = []; try { arr = JSON.parse(text); } catch { } count = arr.length; sample = arr.slice(0, 3); keys = sample[0] ? Object.keys(sample[0]) : []; }
            return ok({ status: st, count, keys, sample });
          }
          case 'uniwareProbe': {  // diagnostic: auth + which channels are flowing (last N days, default 14)
            if (!canConnector(P)) return err('No permission', 403);
            let token;
            try { token = await getUniwareToken(env); } catch (e) { return err(String(e?.message || e), 400); }
            const base = `https://${env.UNIWARE_TENANT}.unicommerce.com`;
            const H = { Authorization: `bearer ${token}`, 'Content-Type': 'application/json' };
            const days = Math.min(Number(qp('days')) || 14, 60);
            const fromISO = uniISO(Date.now() - days * 24 * 3600 * 1000);
            const counts = {}; let start = 0, total = 0;
            for (let p = 0; p < 5; p++) {
              const r = await fetch(`${base}/services/rest/v1/oms/saleOrder/search`, {
                method: 'POST', headers: H,
                body: JSON.stringify({ fromDate: fromISO, toDate: uniISO(Date.now()), dateType: 'CREATED', searchOptions: { displayStart: start, displayLength: 100 } }),
              });
              const j = await r.json().catch(() => ({}));
              if (!j.successful) return err('Uniware search: ' + JSON.stringify(j.errors || j).slice(0, 200), 502);
              for (const e of (j.elements || [])) counts[e.channel] = (counts[e.channel] || 0) + 1;
              total = j.totalRecords || total;
              if ((j.elements || []).length < 100) break;
              start += 100;
            }
            return ok({ days, total_records: total, channels_sampled: counts, note: 'LEGEND_OF_TOYS = website (source SHOPIFY) — excluded from ingestion' });
          }
          case 'adProductProbe': {  // diagnostic (S185): create OR poll an advertised-product report; confirm columns
            if (!canConnector(P)) return err('No permission', 403);
            const host = 'https://advertising-api-eu.amazon.com';
            const profileId = '202246193452230';
            let token; try { token = await getAmazonAdsToken(env); } catch (e) { return err(String(e?.message || e), 400); }
            const H = { 'Amazon-Advertising-API-ClientId': env.AMAZON_ADS_CLIENT_ID, 'Amazon-Advertising-API-Scope': profileId, Authorization: `Bearer ${token}`, 'Content-Type': 'application/vnd.createasyncreportrequest.v3+json' };
            const rid = qp('report_id');
            if (!rid) {
              const end = amzAdsDay(Date.now() - 2 * 86400000), start = amzAdsDay(Date.now() - 5 * 86400000);
              try { const id = await createAdsReport(host, H, 'SPONSORED_PRODUCTS', 'spAdvertisedProduct', start, end, ['advertiser'], AMZ_ADS_PRODUCT_COLUMNS); return ok({ created: id, start, end, note: 'poll again: &action=adProductProbe&report_id=' + id }); }
              catch (e) { return err(String(e?.message || e), 502); }
            }
            const pr = await fetch(`${host}/reporting/reports/${rid}`, { headers: H });
            const rep = await pr.json().catch(() => ({}));
            const st = (rep.status || '').toUpperCase();
            if (st !== 'COMPLETED') return ok({ status: st, failureReason: rep.failureReason || null });
            let sample = [], count = 0, keys = [];
            if (rep.url) { const dl = await fetch(rep.url); const text = await new Response(dl.body.pipeThrough(new DecompressionStream('gzip'))).text(); let arr = []; try { arr = JSON.parse(text); } catch {} count = (arr || []).length; sample = (arr || []).slice(0, 3); keys = sample[0] ? Object.keys(sample[0]) : []; }
            return ok({ status: st, count, keys, sample });
          }
          case 'razorpayProbe': {   // diagnostic (S185): confirm Live keys work + payment field names
            if (!canConnector(P)) return err('No permission', 403);
            if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) return err('Razorpay not configured', 400);
            const days = Math.min(Number(qp('days')) || 7, 90);
            const nowS = Math.floor(Date.now() / 1000), fromS = nowS - days * 86400;
            const r = await fetch(`https://api.razorpay.com/v1/payments?from=${fromS}&to=${nowS}&count=10`, { headers: { Authorization: 'Basic ' + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`) } });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) return err(`Razorpay ${r.status}: ${JSON.stringify(j).slice(0, 200)}`, 502);
            const items = j.items || [];
            return ok({ count: j.count ?? items.length, keys: items[0] ? Object.keys(items[0]) : [], statuses: [...new Set(items.map(p => p.status))], methods: [...new Set(items.map(p => p.method))], sample: items.slice(0, 2).map(p => ({ id: p.id, status: p.status, method: p.method, amount: p.amount, error_reason: p.error_reason })) });
          }
          default: return err('Unknown action: ' + action, 400);
        }
      }

      // ───────────────────────── POST ─────────────────────────
      if (request.method === 'POST') {
        if (!auth) return err('Unauthorised', 401);
        const body = await request.json().catch(() => ({}));
        const act = body.action || action;
        const d = body.data || {};
        switch (act) {
          case 'refreshNow': {
            if (!canRefresh(P)) return err('No permission', 403);
            const one = d.channel_id;
            const cfgR = await sbSales(`/rest/v1/connector_config?enabled=eq.true${one ? `&channel_id=eq.${one}` : ''}&select=channel_id`);
            const cfgs = cfgR.ok ? cfgR.data : [];
            if (!cfgs.length) return err('No enabled connector for that channel', 404);
            const ids = [];
            for (const c of cfgs) ids.push(await startConnectorWf(env, c.channel_id, 'manual', null));
            return ok({ instances: ids, started: cfgs.length });
          }
          case 'backfill': {
            if (!canConnector(P)) return err('No permission', 403);
            if (!d.channel_id) return err('channel_id required');
            const cfgR = await sbSales(`/rest/v1/connector_config?channel_id=eq.${d.channel_id}&select=channel_id`);
            if (!cfgR.ok || !cfgR.data[0]) return err('Connector not found', 404);
            const cursorOverride = d.from ? (d.from.length === 10 ? d.from + 'T00:00:00Z' : d.from) : BACKFILL_START;
            const instance = await startConnectorWf(env, d.channel_id, 'backfill', cursorOverride);
            return ok({ instance });
          }
          case 'uploadReport': {
            if (!canUpload(P)) return err('No permission', 403);
            if (!d.channel_id || (!d.storage_path && !d.csv_text)) return err('channel_id and (storage_path or csv_text) required');
            const ins = await sbSales('/rest/v1/upload_batch', {
              method: 'POST', prefer: 'return=representation',
              body: JSON.stringify({ channel_id: d.channel_id, storage_path: d.storage_path || 'inline', file_name: d.file_name || null, mime_type: d.mime_type || null, report_period_from: d.report_period_from || null, report_period_to: d.report_period_to || null, status: 'uploaded', uploaded_by: userId }),
            });
            if (!ins.ok || !ins.data[0]) return err('Upload record failed: ' + JSON.stringify(ins.data), 502);
            const batch = { ...ins.data[0], column_map: d.column_map || {}, csv_text: d.csv_text };
            try { const res = await ingestUpload(batch, env); return ok({ batch_id: batch.id, ...res }); }
            catch (e) { await sbSales(`/rest/v1/upload_batch?id=eq.${batch.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'error', error: String(e?.message || e) }) }); return err('Parse failed: ' + String(e?.message || e), 422); }
          }
          case 'setDrrWindow': {
            if (!canAdmin(P)) return err('No permission', 403);
            const days = Math.round(Number(d.days));
            if (!Number.isFinite(days) || days < 1 || days > 365) return err('days must be 1–365');
            const r = await sbSales('/rest/v1/settings?on_conflict=key', { method: 'POST', prefer: 'return=minimal,resolution=merge-duplicates', body: JSON.stringify({ key: 'drr_window_days', value: String(days), updated_at: nowISO(), updated_by: userId }) });
            if (!r.ok) return err('Save failed: ' + JSON.stringify(r.data), 502);
            return ok({ drr_window_days: days });
          }
          case 'setProductCost': {   // S189 — upsert a per-SKU standard COGS (effective-dated)
            if (!canAdmin(P)) return err('No permission', 403);
            const code = String(d.product_code || '').trim();
            const cost = Number(d.cogs_inr);
            if (!code) return err('product_code required');
            if (!Number.isFinite(cost) || cost < 0) return err('cogs_inr must be ≥ 0');
            const eff = d.effective_from || todayISO();
            const r = await sbSales('/rest/v1/product_cost?on_conflict=product_code,effective_from', { method: 'POST', prefer: 'return=minimal,resolution=merge-duplicates', body: JSON.stringify({ product_code: code, effective_from: eff, cogs_inr: cost, note: d.note || null, updated_by: userId, updated_at: nowISO() }) });
            if (!r.ok) return err('Save failed: ' + JSON.stringify(r.data), 502);
            return ok({ product_code: code, cogs_inr: cost, effective_from: eff });
          }
          case 'setPnlManual': {   // S189 — upsert a manual P&L line for a month × channel
            if (!canAdmin(P)) return err('No permission', 403);
            const MANUAL_KEYS = ['rto', 'logistics', 'platform_fee', 'brand_marketing', 'sga'];
            const FAM_KEYS = ['all', 'website', 'amazon', 'flipkart', 'quickcom', 'gtmt', 'longtail', 'other'];
            const month = String(d.month || '').slice(0, 7);
            const chKey = d.channel_key || 'all';
            if (!/^\d{4}-\d{2}$/.test(month)) return err('month must be YYYY-MM');
            if (!MANUAL_KEYS.includes(d.line_key)) return err('invalid line_key');
            if (!FAM_KEYS.includes(chKey)) return err('invalid channel_key');
            const amt = Number(d.amount_inr);
            if (!Number.isFinite(amt)) return err('amount_inr must be a number');
            const r = await sbSales('/rest/v1/pnl_manual?on_conflict=month,channel_key,line_key', { method: 'POST', prefer: 'return=minimal,resolution=merge-duplicates', body: JSON.stringify({ month: month + '-01', channel_key: chKey, line_key: d.line_key, amount_inr: amt, note: d.note || null, updated_by: userId, updated_at: nowISO() }) });
            if (!r.ok) return err('Save failed: ' + JSON.stringify(r.data), 502);
            return ok({ month: month + '-01', channel_key: chKey, line_key: d.line_key, amount_inr: amt });
          }
          case 'createSkuMap':
          case 'updateSkuMap': {
            if (!canMapping(P)) return err('No permission', 403);
            if (!d.channel_id || !d.channel_sku || !d.product_code) return err('channel_id, channel_sku, product_code required');
            const r = await sbSales('/rest/v1/sku_map', { method: 'POST', prefer: 'return=representation,resolution=merge-duplicates', body: JSON.stringify({ channel_id: d.channel_id, channel_sku: d.channel_sku, product_code: d.product_code, match_on: 'manual', created_by: userId }) });
            if (!r.ok) return err('Save failed: ' + JSON.stringify(r.data), 502);
            return ok(Array.isArray(r.data) ? r.data[0] : r.data);
          }
          case 'deleteSkuMap': {
            if (!canMapping(P)) return err('No permission', 403);
            if (!d.id) return err('id required');
            await sbSales(`/rest/v1/sku_map?id=eq.${d.id}`, { method: 'DELETE', prefer: 'return=minimal' });
            return ok({ id: d.id, deleted: true });
          }
          case 'resolveUnmapped': {
            if (!canMapping(P)) return err('No permission', 403);
            if (!d.id || !d.product_code) return err('id and product_code required');
            const uR = await sbSales(`/rest/v1/unmapped_sku?id=eq.${d.id}&select=*&limit=1`);
            if (!uR.ok || !uR.data[0]) return err('Unmapped row not found', 404);
            const u = uR.data[0];
            await sbSales('/rest/v1/sku_map', { method: 'POST', prefer: 'return=minimal,resolution=merge-duplicates', body: JSON.stringify({ channel_id: u.channel_id, channel_sku: u.channel_sku, product_code: d.product_code, match_on: 'manual', created_by: userId }) });
            await sbSales(`/rest/v1/unmapped_sku?id=eq.${d.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'resolved', resolved_product_code: d.product_code, resolved_by: userId, resolved_at: nowISO() }) });
            // backfill: recompute every staged date that carried this channel_sku
            const adapterCfg = await sbSales(`/rest/v1/connector_config?channel_id=eq.${u.channel_id}&select=adapter_kind`);
            const kind = adapterCfg.ok && adapterCfg.data[0] ? adapterCfg.data[0].adapter_kind : null;
            const stg = ADAPTERS[kind]?.stgTable || 'stg_qc';
            const dR = await sbSales(`/rest/v1/${stg}?channel_id=eq.${u.channel_id}&channel_sku=eq.${encodeURIComponent(u.channel_sku)}&select=sale_date`);
            const dates = uniq((dR.ok ? dR.data : []).map(x => x.sale_date));
            const facts = dates.length ? await rpcSales('recompute_facts', { p_channel: u.channel_id, p_dates: dates, p_run_id: null }) : { data: 0 };
            return ok({ id: d.id, resolved: true, dates: dates.length, facts: facts.ok ? Number(facts.data) : 0 });
          }
          case 'reconcileUnmapped': {
            // L142: full-staging sweep — enqueue every unmapped sale SKU into the queue (auto-map
            // any that now match product_master). Complements per-window resolveSkus; idempotent.
            if (!canMapping(P)) return err('No permission', 403);
            const rc = await rpcSales('reconcile_unmapped_sku', {});
            if (!rc.ok) return err('Reconcile failed: ' + JSON.stringify(rc.data), 502);
            return ok(rc.data);
          }
          case 'setConnectorEnabled': {
            if (!canConnector(P)) return err('No permission', 403);
            if (!d.channel_id) return err('channel_id required');
            const r = await sbSales(`/rest/v1/connector_config?channel_id=eq.${d.channel_id}`, { method: 'PATCH', prefer: 'return=representation', body: JSON.stringify({ enabled: d.enabled !== false }) });
            if (!r.ok) return err('Update failed: ' + JSON.stringify(r.data), 502);
            return ok(Array.isArray(r.data) ? r.data[0] : r.data);
          }

          // ── Admin · governance (super admin only) ──
          case 'saveRole': {
            if (!canSuperAdmin(P)) return err('No permission', 403);
            if (!d.role_key) return err('role_key required');
            const exR = await sbStore(`/rest/v1/salesops_roles?role_key=eq.${encodeURIComponent(d.role_key)}&select=is_system&limit=1`);
            if (exR.ok && exR.data[0] && exR.data[0].is_system) return err('System roles are locked', 403);
            const row = { role_key: d.role_key, label: d.label || d.role_key, description: d.description || null, permissions: d.permissions || {} };
            const r = await sbStore('/rest/v1/salesops_roles', { method: 'POST', prefer: 'return=representation,resolution=merge-duplicates', body: JSON.stringify(row) });
            if (!r.ok) return err('Role save failed: ' + JSON.stringify(r.data), 502);
            return ok(Array.isArray(r.data) ? r.data[0] : r.data);
          }
          case 'deleteRole': {
            if (!canSuperAdmin(P)) return err('No permission', 403);
            if (!d.role_key) return err('role_key required');
            const exR = await sbStore(`/rest/v1/salesops_roles?role_key=eq.${encodeURIComponent(d.role_key)}&select=is_system&limit=1`);
            if (!exR.ok || !exR.data[0]) return err('Role not found', 404);
            if (exR.data[0].is_system) return err('System roles cannot be deleted', 403);
            const inUse = await sbStore(`/rest/v1/salesops_user_roles?role_key=eq.${encodeURIComponent(d.role_key)}&select=user_id`);
            if (inUse.ok && inUse.data.length) return err(`Role is assigned to ${inUse.data.length} user(s) — reassign them first`, 409);
            await sbStore(`/rest/v1/salesops_roles?role_key=eq.${encodeURIComponent(d.role_key)}`, { method: 'DELETE', prefer: 'return=minimal' });
            return ok({ role_key: d.role_key, deleted: true });
          }
          case 'setUserActive': {
            if (!canSuperAdmin(P)) return err('No permission', 403);
            if (!d.user_id) return err('user_id required');
            const active = d.active !== false;
            if (!active) {
              if (d.user_id === userId) return err('You cannot disable your own access', 409);
              const supers = await activeSuperAdminUserIds();
              if (supers.length === 1 && supers[0] === d.user_id) return err('Cannot disable the last super admin', 409);
            }
            const patch = active ? { active: true, disabled_at: null, disabled_by: null } : { active: false, disabled_at: nowISO(), disabled_by: userId };
            const r = await sbStore(`/rest/v1/salesops_user_roles?user_id=eq.${encodeURIComponent(d.user_id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(patch) });
            if (!r.ok) return err('Update failed: ' + JSON.stringify(r.data), 502);
            return ok({ user_id: d.user_id, active });
          }
          case 'grantAccess': {
            if (!canSuperAdmin(P)) return err('No permission', 403);
            if (!d.email || !d.role_key) return err('email and role_key required');
            const resolvedId = await resolveAuthUserId(d.email);
            if (!resolvedId) return err('No auth user for that email yet — ask them to sign in once first, then retry', 422);
            const profR = await sbStore(`/rest/v1/users_profile?id=eq.${resolvedId}&select=id&limit=1`);
            if (!(profR.ok && profR.data[0])) await sbStore('/rest/v1/users_profile', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify({ id: resolvedId, full_name: d.full_name || d.email, role: 'staff', active: true }) });
            else await sbStore('/rest/v1/users_profile', { method: 'POST', prefer: 'return=minimal,resolution=merge-duplicates', body: JSON.stringify({ id: resolvedId, active: true }) });
            const g = await sbStore('/rest/v1/salesops_user_roles', { method: 'POST', prefer: 'return=minimal,resolution=merge-duplicates', body: JSON.stringify({ user_id: resolvedId, role_key: d.role_key, active: true, assigned_by: userId, assigned_at: nowISO() }) });
            if (!g.ok) return err('Grant failed: ' + JSON.stringify(g.data), 502);
            return ok({ user_id: resolvedId, email: d.email, role_key: d.role_key });
          }

          // ════════ Phase 2 — Ad Engine WRITE (gated; see migration 0010) ════════
          case 'adsSavePlan': {   // draft/update a launch plan (the engine's "brain" submits this)
            if (!canAdsWrite(P)) return err('No permission', 403);
            const planRow = {
              product: d.product || null, batch: d.batch || null,
              channel_id: d.channel_id || null, ad_account_id: d.ad_account_id || null,
              daily_budget_total_inr: num(d.daily_budget_total_inr),
              plan: d.plan || {}, notes: d.notes || null, updated_at: nowISO(),
            };
            let r;
            if (d.plan_id) {
              r = await sbSales(`/rest/v1/ads_plan?id=eq.${d.plan_id}&status=eq.draft`, { method: 'PATCH', prefer: 'return=representation', body: JSON.stringify(planRow) });
              if (r.ok && (!Array.isArray(r.data) || !r.data[0])) return err('Plan not found or not editable (only a draft can be edited)', 409);
            } else {
              r = await sbSales('/rest/v1/ads_plan', { method: 'POST', prefer: 'return=representation', body: JSON.stringify({ ...planRow, status: 'draft', created_by: userId }) });
            }
            if (!r.ok) return err('Plan save failed: ' + JSON.stringify(r.data), 502);
            return ok(Array.isArray(r.data) ? r.data[0] : r.data);
          }
          case 'adsApprovePlan': {   // Afshaan's spend gate — only an approved plan can launch
            if (!canAdsApprove(P)) return err('No permission', 403);
            if (!d.plan_id) return err('plan_id required');
            const planR = await sbSales(`/rest/v1/ads_plan?id=eq.${d.plan_id}&select=*&limit=1`);
            const plan = planR.ok && planR.data[0] ? planR.data[0] : null;
            if (!plan) return err('Plan not found', 404);
            if (plan.status !== 'draft') return err(`Plan is '${plan.status}', only a draft can be approved`, 409);
            const ceiling = await adsCeilingInr();
            if (ceiling > 0 && num(plan.daily_budget_total_inr) > ceiling) return err(`Plan daily total ₹${plan.daily_budget_total_inr} exceeds ceiling ₹${ceiling}`, 409);
            const r = await sbSales(`/rest/v1/ads_plan?id=eq.${d.plan_id}`, { method: 'PATCH', prefer: 'return=representation', body: JSON.stringify({ status: 'approved', approved_by: userId, approved_at: nowISO(), updated_at: nowISO() }) });
            if (!r.ok) return err('Approve failed: ' + JSON.stringify(r.data), 502);
            return ok(Array.isArray(r.data) ? r.data[0] : r.data);
          }
          case 'adsSetVerdict': {   // Dyno — record a variant verdict + reason (writer; no spend impact)
            if (!canAdsWrite(P)) return err('No permission', 403);
            if (!d.meta_id) return err('meta_id required');
            const VERDICTS = ['winner', 'promising', 'killed', 'inconclusive', 'paused'];
            if (!VERDICTS.includes(d.verdict)) return err(`verdict must be one of: ${VERDICTS.join(', ')}`);
            const existing = await managedGet('ad', d.meta_id);
            if (!existing) return err('Variant (ad) not found', 404);
            await managedPatch('ad', d.meta_id, { verdict: d.verdict, verdict_reason: d.reason || null });
            await ledgerWrite({ actor_user_id: userId, action: 'adsSetVerdict', entity_type: 'ad', entity_id: d.meta_id, daily_delta_inr: 0, request: d, status: 'ok' });
            return ok(await managedGet('ad', d.meta_id));
          }
          case 'metaCreateCampaign': {   // creates PAUSED (no budget at campaign level in ABO)
            if (!canAdsWrite(P)) return err('No permission', 403);
            if (!d.plan_id) return err('plan_id required');
            try {
              const out = await adsGuardedWrite({ userId, action: 'metaCreateCampaign', planId: d.plan_id, request: d, fn: async () => {
                const ex = await sbSales(`/rest/v1/ads_managed?entity_type=eq.campaign&plan_id=eq.${d.plan_id}&status=neq.deleted&select=meta_id&limit=1`);
                if (ex.ok && ex.data[0]) return { entity_type: 'campaign', entity_id: ex.data[0].meta_id, meta_response: { reused: true } };  // resumable
                const plan = await adsLoadPlan(d.plan_id, 'approved');
                const acct = await metaAdAccount(plan.ad_account_id);
                const name = d.name || plan.plan?.campaign?.name || `LOT | PROSPECT | ${plan.product || 'Batch'}`;
                const res = await metaPost(env, `act_${acct}/campaigns`, { name, objective: 'OUTCOME_SALES', buying_type: 'AUCTION', special_ad_categories: '[]', is_adset_budget_sharing_enabled: 'false', status: 'PAUSED' });
                await managedUpsert({ entity_type: 'campaign', meta_id: res.id, parent_id: null, plan_id: d.plan_id, channel_id: plan.channel_id, ad_account_id: acct, name, daily_budget_inr: 0, status: 'paused' });
                return { entity_type: 'campaign', entity_id: res.id, meta_response: res };
              }});
              return ok({ campaign_id: out.entity_id });
            } catch (e) { return err(String(e?.message || e), 422); }
          }
          case 'metaCreateAdSet': {   // creates PAUSED; daily budget committed only on activation
            if (!canAdsWrite(P)) return err('No permission', 403);
            if (!d.plan_id || !d.campaign_id) return err('plan_id and campaign_id required');
            const a = d.adset || {};
            if (!a.pixel_id) return err('adset.pixel_id required (purchase optimization)', 422);
            const budgetInr = num(a.daily_budget_inr);
            if (budgetInr <= 0) return err('adset.daily_budget_inr must be > 0', 422);
            try {
              const out = await adsGuardedWrite({ userId, action: 'metaCreateAdSet', planId: d.plan_id, request: d, fn: async () => {
                if (a.name) {
                  const exA = await sbSales(`/rest/v1/ads_managed?entity_type=eq.adset&plan_id=eq.${d.plan_id}&name=eq.${encodeURIComponent(a.name)}&status=neq.deleted&select=meta_id&limit=1`);
                  if (exA.ok && exA.data[0]) return { entity_type: 'adset', entity_id: exA.data[0].meta_id, meta_response: { reused: true } };  // resumable
                }
                const plan = await adsLoadPlan(d.plan_id, 'approved');
                const acct = await metaAdAccount(plan.ad_account_id);
                const targeting = a.targeting || { geo_locations: { countries: ['IN'] } };   // all-India broad default
                const res = await metaPost(env, `act_${acct}/adsets`, {
                  name: a.name || `${plan.product || 'Batch'} — adset`, campaign_id: d.campaign_id,
                  daily_budget: inrToMinor(budgetInr), billing_event: 'IMPRESSIONS', optimization_goal: 'OFFSITE_CONVERSIONS',
                  bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
                  promoted_object: { pixel_id: a.pixel_id, custom_event_type: 'PURCHASE' }, targeting, status: 'PAUSED',
                });
                await managedUpsert({ entity_type: 'adset', meta_id: res.id, parent_id: d.campaign_id, plan_id: d.plan_id, channel_id: plan.channel_id, ad_account_id: acct, name: a.name || null, daily_budget_inr: budgetInr, status: 'paused' });
                return { entity_type: 'adset', entity_id: res.id, meta_response: res };
              }});
              return ok({ adset_id: out.entity_id, daily_budget_inr: budgetInr, status: 'PAUSED' });
            } catch (e) { return err(String(e?.message || e), 422); }
          }
          case 'metaCreateAd': {   // single-image OR carousel: upload image(s) → adcreative → ad (all PAUSED)
            if (!canAdsWrite(P)) return err('No permission', 403);
            if (!d.plan_id || !d.adset_id) return err('plan_id and adset_id required');
            const ad = d.ad || {};
            if (!ad.page_id) return err('ad.page_id required', 422);
            if (!ad.link) return err('ad.link required', 422);
            // Carousel = presence of ad.cards[] (2–10). Absent → single-image path (unchanged).
            const isCarousel = Array.isArray(ad.cards);
            if (isCarousel) {
              if (ad.cards.length < 2 || ad.cards.length > 10) return err('carousel needs 2–10 cards', 422);
              for (let i = 0; i < ad.cards.length; i++) {
                const c = ad.cards[i] || {};
                if (!c.image_base64 && !c.image_hash) return err(`card ${i + 1}: image_base64 or image_hash required`, 422);
              }
            } else if (!ad.image_base64 && !ad.image_hash) {
              return err('ad.image_base64 or ad.image_hash required', 422);
            }
            // Redact raw base64 out of the ledger request (per-card for carousel).
            const redactAd = isCarousel
              ? { ...ad, cards: ad.cards.map(c => ({ ...c, image_base64: c.image_base64 ? `[${c.image_base64.length} chars]` : undefined })) }
              : { ...ad, image_base64: ad.image_base64 ? `[${ad.image_base64.length} chars]` : undefined };
            const redacted = { ...d, ad: redactAd };
            // Dyno (0011_dyno_v1) reads these off the ads_managed row — persist at launch so the
            // board/matrix tag the variant. format is derived; the rest ride in on the ad payload.
            const dynoMeta = {
              format: isCarousel ? 'carousel' : (ad.format || 'static-image'),
              angle: ad.angle || null,
              audience_segment: ad.audience_segment || null,
              psychology_pillar: ad.psychology_pillar || null,
              headline: ad.headline || null,
              primary_text: ad.primary_text || null,
              utm_content: ad.utm_content || null,
              parent_meta_id: ad.parent_meta_id || null,   // creative lineage (distinct from parent_id = Meta hierarchy)
            };
            try {
              const out = await adsGuardedWrite({ userId, action: 'metaCreateAd', planId: d.plan_id, request: redacted, fn: async () => {
                if (ad.name) {
                  const exD = await sbSales(`/rest/v1/ads_managed?entity_type=eq.ad&plan_id=eq.${d.plan_id}&name=eq.${encodeURIComponent(ad.name)}&status=neq.deleted&select=meta_id&limit=1`);
                  if (exD.ok && exD.data[0]) return { entity_type: 'ad', entity_id: exD.data[0].meta_id, meta_response: { ad_id: exD.data[0].meta_id, creative_id: null, image_hash: null, reused: true } };  // resumable
                }
                const plan = await adsLoadPlan(d.plan_id, 'approved');
                const acct = await metaAdAccount(plan.ad_account_id);
                // Upload one image → hash (same helper the single + carousel paths share).
                const uploadHash = async (b64) => {
                  const up = await metaPost(env, `act_${acct}/adimages`, { bytes: b64 });
                  const h = Object.values(up.images || {})[0]?.hash;
                  if (!h) throw new Error('adimages upload returned no hash: ' + JSON.stringify(up).slice(0, 160));
                  return h;
                };
                let cre, imageHash = null;
                if (isCarousel) {
                  // Resolve each card's hash (sequential — each upload is a subrequest), then build
                  // child_attachments. A mid-loop failure creates no ad; a retry re-uploads (Meta
                  // adimages is content-addressed → same bytes = same hash, no dupes).
                  const child_attachments = [];
                  for (const c of ad.cards) {
                    const hash = c.image_hash || await uploadHash(c.image_base64);
                    child_attachments.push({
                      link: c.link || ad.link,
                      image_hash: hash,
                      ...(c.headline ? { name: c.headline } : {}),
                      ...(c.description ? { description: c.description } : {}),
                      call_to_action: { type: ad.cta || 'SHOP_NOW', value: { link: c.link || ad.link } },
                    });
                  }
                  cre = await metaPost(env, `act_${acct}/adcreatives`, {
                    name: ad.name ? `${ad.name} — creative` : 'LOT creative',
                    object_story_spec: { page_id: ad.page_id, link_data: {
                      link: ad.link, message: ad.primary_text || '',
                      multi_share_optimized: ad.multi_share_optimized ?? false,   // keep our card order (narrative)
                      multi_share_end_card:  ad.multi_share_end_card  ?? false,   // frame N is our CTA — no Meta end card
                      child_attachments } },
                    url_tags: ad.url_tags || undefined,
                  });
                } else {
                  imageHash = ad.image_hash || await uploadHash(ad.image_base64);
                  cre = await metaPost(env, `act_${acct}/adcreatives`, {
                    name: ad.name ? `${ad.name} — creative` : 'LOT creative',
                    object_story_spec: { page_id: ad.page_id, link_data: {
                      image_hash: imageHash, link: ad.link, message: ad.primary_text || '', name: ad.headline || '',
                      call_to_action: { type: ad.cta || 'SHOP_NOW', value: { link: ad.link } } } },
                    url_tags: ad.url_tags || undefined,   // UTM string Meta appends to the click (+ resolves {{macros}})
                  });
                }
                const res = await metaPost(env, `act_${acct}/ads`, { name: ad.name || 'LOT ad', adset_id: d.adset_id, creative: { creative_id: cre.id }, status: 'PAUSED' });
                await managedUpsert({ entity_type: 'ad', meta_id: res.id, parent_id: d.adset_id, plan_id: d.plan_id, channel_id: plan.channel_id, ad_account_id: acct, name: ad.name || null, daily_budget_inr: 0, status: 'paused', ...dynoMeta });
                return { entity_type: 'ad', entity_id: res.id, meta_response: { ad_id: res.id, creative_id: cre.id, image_hash: imageHash, cards: isCarousel ? ad.cards.length : null } };
              }});
              return ok({ ad_id: out.entity_id, creative_id: out.meta_response.creative_id, image_hash: out.meta_response.image_hash, cards: out.meta_response.cards });
            } catch (e) { return err(String(e?.message || e), 422); }
          }
          case 'metaSetStatus': {   // activate (ceiling-checked for adsets) or pause (free)
            if (!canAdsWrite(P)) return err('No permission', 403);
            const et = d.entity_type, mid = d.meta_id, status = String(d.status || '').toUpperCase();
            if (!['campaign', 'adset', 'ad'].includes(et)) return err("entity_type must be 'campaign', 'adset' or 'ad'", 422);
            if (!mid) return err('meta_id required', 422);
            if (!['ACTIVE', 'PAUSED'].includes(status)) return err('status must be ACTIVE or PAUSED', 422);
            try {
              const out = await adsGuardedWrite({ userId, action: 'metaSetStatus', planId: d.plan_id || null, request: d, fn: async () => {
                const m = await managedGet(et, mid);
                let delta = 0;
                // Only an adset commits budget, and only when flipping paused→active (idempotent re-activate adds nothing).
                if (status === 'ACTIVE' && et === 'adset' && (!m || m.status !== 'active')) { const budget = m ? num(m.daily_budget_inr) : 0; await assertCeiling(budget); delta = budget; }
                const res = await metaPost(env, `${mid}`, { status });
                if (m) await managedPatch(et, mid, { status: status === 'ACTIVE' ? 'active' : 'paused' });
                return { entity_type: et, entity_id: mid, meta_response: res, daily_delta_inr: delta };
              }});
              return ok({ entity_type: et, meta_id: mid, status });
            } catch (e) { return err(String(e?.message || e), 422); }
          }
          case 'metaSetAdSetBudget': {   // scale up = gated to approvers; scale down = free
            if (!canAdsWrite(P)) return err('No permission', 403);
            const adsetId = d.adset_id, newInr = num(d.daily_budget_inr);
            if (!adsetId) return err('adset_id required', 422);
            if (newInr <= 0) return err('daily_budget_inr must be > 0', 422);
            try {
              const m = await managedGet('adset', adsetId);
              const curInr = m ? num(m.daily_budget_inr) : 0;
              if (newInr > curInr && !canAdsApprove(P)) return err('Budget increase requires approval (auto-scale is gated)', 403);
              const out = await adsGuardedWrite({ userId, action: 'metaSetAdSetBudget', planId: m?.plan_id || null, request: d, fn: async () => {
                if (m && m.status === 'active') await assertCeiling(newInr, curInr);
                const res = await metaPost(env, `${adsetId}`, { daily_budget: inrToMinor(newInr) });
                await managedPatch('adset', adsetId, { daily_budget_inr: newInr });
                return { entity_type: 'adset', entity_id: adsetId, meta_response: res, daily_delta_inr: newInr - curInr };
              }});
              return ok({ adset_id: adsetId, daily_budget_inr: newInr });
            } catch (e) { return err(String(e?.message || e), 422); }
          }
          case 'metaSetName': {   // rename a campaign/adset/ad (no spend impact — free)
            if (!canAdsWrite(P)) return err('No permission', 403);
            const et = d.entity_type, mid = d.meta_id, name = String(d.name || '').trim();
            if (!['campaign', 'adset', 'ad'].includes(et)) return err("entity_type must be 'campaign', 'adset' or 'ad'", 422);
            if (!mid) return err('meta_id required', 422);
            if (!name) return err('name required', 422);
            try {
              const res = await metaPost(env, `${mid}`, { name });
              const m = await managedGet(et, mid);
              if (m) await managedPatch(et, mid, { name });
              return ok({ entity_type: et, meta_id: mid, name, meta_response: res });
            } catch (e) { return err(String(e?.message || e), 422); }
          }

          default: return err('Unknown action: ' + act, 400);
        }
      }

      return err('Method not allowed', 405);
    } catch (e) {
      return err('Server error: ' + String(e?.message || e), 500);
    }
  },
};
