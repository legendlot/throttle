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
// Walk posted-date windows forward (oldest→now) within a per-tick subrequest budget, draining
// each window fully (paging the NextToken). fin_cursor advances only past windows that fully
// drained, so a page-capped window is retried next tick (idempotent upsert). Returns accumulated
// events + the furthest fully-drained window end. PostedBefore must be ≥2min ago.
async function fetchAmazonFinance(host, H, cfg, nowMs) {
  let cursorISO = cfg.fin_cursor || cfg.backfill_start || BACKFILL_START;
  const events = []; let subreqs = 0, advancedTo = null, partial = false;
  while (subreqs < AMZ_FIN_SUBREQ_BUDGET) {
    const startMs = Date.parse(cursorISO) || nowMs;
    if (startMs >= nowMs - 120_000) break;                                 // caught up to ~now
    const endISO = new Date(Math.min(startMs + AMZ_FIN_WINDOW_MS, nowMs - 120_000)).toISOString();
    let nextToken = null, pages = 0, windowDone = true;
    do {
      const qs = nextToken
        ? `MaxResultsPerPage=100&NextToken=${encodeURIComponent(nextToken)}`
        : `MaxResultsPerPage=100&PostedAfter=${encodeURIComponent(cursorISO)}&PostedBefore=${encodeURIComponent(endISO)}`;
      const r = await fetch(`${host}/finances/v0/financialEvents?${qs}`, { headers: H }); subreqs++;
      if (r.status === 429) { windowDone = false; break; }                 // throttled → retry window next tick
      if (!r.ok) throw new Error(`Amazon finances ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}`);
      const j = await r.json();
      events.push(...parseAmazonFinance(j.payload?.FinancialEvents || {}));
      nextToken = j.payload?.NextToken || null; pages++;
      if (nextToken && (pages >= AMZ_FIN_MAX_PAGES || subreqs >= AMZ_FIN_SUBREQ_BUDGET)) { windowDone = false; break; }
    } while (nextToken);
    if (!windowDone) { partial = true; break; }                            // window not fully drained → don't advance past it
    advancedTo = endISO; cursorISO = endISO;                               // fully drained (incl. empty) → advance + continue
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
    // Persist report + finance + returns config in ONE write (avoids clobbering pending ids).
    await patchConnectorConfig(channelId, cfg, configAfter);
    return { rows: rep.rows, cursorAfter: rep.cursorAfter, subreqs: rep.subreqs + finSub + retSub, partial: rep.partial, finance, returns };
  },
  async stage(rows, runId, channelId, fetched) {
    if (rows.length) {
      const from = rows.reduce((m, x) => x.sale_date < m ? x.sale_date : m, rows[0].sale_date);
      const to   = rows.reduce((m, x) => x.sale_date > m ? x.sale_date : m, rows[0].sale_date);
      // stg_amazon has no stable source line id (flat file) → supersede by date range, like the gsheet adapter.
      await sbSales(`/rest/v1/stg_amazon?channel_id=eq.${channelId}&sale_date=gte.${from}&sale_date=lte.${to}`, { method: 'DELETE', prefer: 'return=minimal' });
      const body = rows.map(r => ({
        run_id: runId, channel_id: channelId, source_order_id: r.source_order_id || null, sale_date: r.sale_date,
        channel_sku: r.channel_sku, title: r.title, qty: Math.round(r.qty), gross_value: r.gross_value,
        discount_value: r.discount_value || 0, tax_value: r.tax_value || 0, row_type: 'sale',
        order_status: r.order_status || null, is_cancelled: !!r.is_cancelled,
        ship_state: r.ship_state || null, ship_city: r.ship_city || null, raw: r.raw,
      }));
      await sbInsertChunked('/rest/v1/stg_amazon', body, 'return=minimal');
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
    const rid = await createAdsReport(host, H, adProduct, reportTypeId, startStr, endStr, ['campaign'], cols); subreqs++;
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
const uniwareAdapter = {
  kind: 'uniware', stgTable: 'stg_uniware', sourceKind: 'uniware',
  async fetch({ env, cursor, config, budget }) {
    const cfg = config || {};
    const uchan = cfg.uniware_channel;
    if (!uchan) throw new Error('uniware config missing uniware_channel');
    const base = `https://${env.UNIWARE_TENANT}.unicommerce.com`;
    const token = await getUniwareToken(env);
    const H = { Authorization: `bearer ${token}`, 'Content-Type': 'application/json' };
    const winMs = (cfg.window_days || UNI_WINDOW_DAYS_DEFAULT) * 24 * 3600 * 1000;
    const maxGets = Math.min(cfg.max_gets || UNI_MAX_GETS_DEFAULT, Math.max(1, budget - 6));
    const MAX_WINDOWS = cfg.max_windows || 25;   // empty windows to skip-scan per run (cheap search-only)
    const PAGE = 100;
    const now = Date.now();
    let winStart = uniMs(cursor || cfg.backfill_start || BACKFILL_START);
    let subreqs = 1; // token
    const rows = [], orderRows = [];
    let cursorAfter = uniISO(winStart), partial = false, scanned = 0;

    // Walk forward in ≤14-day windows. EMPTY windows are skipped cheaply within this run (one search
    // each) — so backfilling from a far-back cursor through order-less history doesn't crawl one window
    // per cron tick. Stop at the FIRST window that has target orders, process it (bounded gets), and
    // resume next run. Budget-guarded so we never approach the 50-subrequest cap.
    while (true) {
      if (winStart >= now) { cursorAfter = uniISO(now); partial = false; break; }                 // caught up to live
      // Stop scanning when out of windows or low on budget. We do NOT reserve maxGets here — empty
      // windows cost only a search, so skipping must be free to use most of the budget; gets are
      // separately bounded below by the remaining budget when a data window is found.
      if (scanned >= MAX_WINDOWS || subreqs >= budget - 3) { cursorAfter = uniISO(winStart); partial = true; break; }
      const winEnd = Math.min(winStart + winMs, now);
      // page this window's target-channel order codes (UPDATED)
      const codes = []; let start = 0;
      while (subreqs < budget - 3) {
        const r = await fetch(`${base}/services/rest/v1/oms/saleOrder/search`, { method: 'POST', headers: H, body: JSON.stringify({ channel: uchan, fromDate: uniISO(winStart), toDate: uniISO(winEnd), dateType: 'UPDATED', searchOptions: { displayStart: start, displayLength: PAGE } }) }); subreqs++;
        const j = await r.json().catch(() => ({}));
        if (!j.successful) throw new Error('Uniware search: ' + JSON.stringify(j.errors || j).slice(0, 160));
        const els = j.elements || [];
        // Type-guard: the search `channel` filter is a channel-NAME match and an UNRECOGNISED value
        // silently returns ALL channels — keep only elements whose result channel matches the target.
        for (const e of els) {
          if (String(e.channel || '').toUpperCase() === uchan.toUpperCase()) codes.push({ code: e.code, updated: Number(e.updated) || Number(e.created) || winEnd });
        }
        if (els.length < PAGE) break;
        start += PAGE;
      }
      scanned++;
      if (!codes.length) { winStart = winEnd; continue; }   // empty window → skip forward, keep scanning
      // window has data → get each (bounded), then stop and resume next run
      codes.sort((a, b) => a.updated - b.updated);
      let processed = 0, lastUpdated = winStart, drained = true;
      for (const c of codes) {
        if (processed >= maxGets || subreqs >= budget - 1) { drained = false; break; }
        const gr = await fetch(`${base}/services/rest/v1/oms/saleorder/get`, { method: 'POST', headers: H, body: JSON.stringify({ code: c.code }) }); subreqs++; processed++;
        const gj = await gr.json().catch(() => ({}));
        const so = gj.saleOrderDTO; if (!so) continue;
        const m = uniMapOrder(so); rows.push(...m.lines); orderRows.push(m.order);
        if (c.updated > lastUpdated) lastUpdated = c.updated;
      }
      if (drained) { cursorAfter = uniISO(winEnd); partial = winEnd < now; }   // window done; more history if < now
      else { cursorAfter = uniISO(lastUpdated); partial = true; }              // window not drained → resume mid-window
      break;
    }
    return { rows, orderRows, cursorAfter, subreqs, partial };
  },
  async stage(rows, runId, channelId, fetched) {
    if (rows.length) {
      const body = rows.map(r => ({
        run_id: runId, channel_id: channelId, source_order_id: r.source_order_id, source_line_id: r.source_line_id,
        occurred_at: r.occurred_at, sale_date: r.sale_date, channel_sku: r.channel_sku, title: r.title,
        qty: Math.round(r.qty), gross_value: r.gross_value, discount_value: r.discount_value || 0, tax_value: r.tax_value || 0,
        row_type: r.row_type || 'sale', order_status: r.order_status, is_cancelled: r.is_cancelled, raw: r.raw,
      }));
      await sbInsertChunked('/rest/v1/stg_uniware?on_conflict=source_line_id', body, 'return=minimal,resolution=merge-duplicates');
    }
    await stageOrders((fetched && fetched.orderRows) || [], runId, channelId);
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

const ADAPTERS = { shopify: shopifyAdapter, snorkel_internal: snorkelAdapter, qc_upload: qcAdapter, qc_gsheet: gsheetAdapter, amazon_spapi: amazonAdapter, amazon_ads: amazonAdsAdapter, amazon_ads_product: amazonAdsProductAdapter, meta_ads: metaAdsAdapter, google_ads: googleAdsAdapter, ga4: ga4Adapter, uniware: uniwareAdapter, razorpay_payments: razorpayPaymentsAdapter };

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
        ? await adapter.recompute({ channelId: cfg.channel_id, dates, runId })
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
    for (let i = 0; i < MAX_WINDOWS; i++) {
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
      const r = await sbSales('/rest/v1/connector_config?enabled=eq.true&select=channel_id');
      for (const cfg of (r.ok ? r.data : [])) {
        try { await startConnectorWf(env, cfg.channel_id, 'cron', null); }
        catch (e) { console.error('odoops producer: failed to start', cfg.channel_id, e?.message || e); }
      }
    } catch (e) { console.error('odoops cron (producer) failed:', e?.message || e); }
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
          default: return err('Unknown action: ' + act, 400);
        }
      }

      return err('Method not allowed', 405);
    } catch (e) {
      return err('Server error: ' + String(e?.message || e), 500);
    }
  },
};
