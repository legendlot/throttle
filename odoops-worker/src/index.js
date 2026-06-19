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
    while (hasNext) {
      if (subreqs >= budget) { partial = true; break; }
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
      await sbSales('/rest/v1/stg_shopify', { method: 'POST', body: JSON.stringify(body), prefer: 'return=minimal,resolution=merge-duplicates' });
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
  await sbSales('/rest/v1/stg_orders?on_conflict=channel_id,source_order_id,row_kind,refund_id',
    { method: 'POST', body: JSON.stringify(body), prefer: 'return=minimal,resolution=merge-duplicates' });
}

// ── GT/MT (reads Snorkel confirmed sales orders) ───────────────
const snorkelAdapter = {
  kind: 'snorkel_internal', stgTable: 'stg_snorkel', sourceKind: 'snorkel',
  async fetch({ channelId, channelName: cname, cursor }) {
    const sinceDate = (cursor || BACKFILL_START).slice(0, 10);
    // confirmed + cancelled (cancelled nets out on recompute). channel_key = GT|MT.
    const sel = 'id,order_no,order_date,channel_key,status,confirmed_at,sales_order_lines(id,product,model,color,sku,qty,taxable_value)';
    const r = await sbStore(`/rest/v1/sales_orders?status=in.(confirmed,cancelled)&channel_key=eq.${encodeURIComponent(cname)}&order_date=gte.${sinceDate}&select=${sel}&order=order_date.asc`);
    if (!r.ok) throw new Error('Snorkel read failed: ' + JSON.stringify(r.data));
    const rows = []; let maxDate = sinceDate;
    for (const o of (r.data || [])) {
      if (o.order_date && o.order_date > maxDate) maxDate = o.order_date;
      const cancelled = o.status === 'cancelled';
      for (const l of (o.sales_order_lines || [])) {
        rows.push({
          source_line_id: String(l.id), source_order_id: o.order_no,
          channel_sku: l.sku || [l.product, l.model, l.color].filter(Boolean).join(' '),
          title: [l.product, l.model, l.color].filter(Boolean).join(' '),
          qty: num(l.qty), gross_value: num(l.taxable_value),
          occurred_at: o.order_date, sale_date: o.order_date, order_status: o.status, is_cancelled: cancelled, raw: l,
        });
      }
    }
    return { rows, cursorAfter: maxDate, subreqs: 1, partial: false };
  },
  async stage(rows, runId, channelId) {
    if (!rows.length) return;
    const body = rows.map(r => ({
      run_id: runId, channel_id: channelId, source_order_id: r.source_order_id, source_line_id: r.source_line_id,
      sale_date: r.sale_date, channel_sku: r.channel_sku, title: r.title,
      qty: Math.round(r.qty), gross_value: r.gross_value, order_status: r.order_status, is_cancelled: r.is_cancelled, raw: r.raw,
    }));
    await sbSales('/rest/v1/stg_snorkel', { method: 'POST', body: JSON.stringify(body), prefer: 'return=minimal,resolution=merge-duplicates' });
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
    const range = encodeURIComponent(`${cfg.tab}!A:ZZ`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${cfg.spreadsheet_id}/values/${range}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Sheets API ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}`);
    const j = await r.json();
    const grid = (j.values || []).map(row => row.map(c => (c == null ? '' : String(c))));
    const rows = gridToQcRows(grid, cfg.columns, todayISO());
    return { rows, cursorAfter: null, subreqs: 2, partial: false };
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
    await sbSales('/rest/v1/stg_qc', { method: 'POST', prefer: 'return=minimal,resolution=merge-duplicates', body: JSON.stringify(body) });
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
const AMZ_COLUMNS_DEFAULT = { date: 'purchase-date', sku: 'sku', title: 'product-name', units: 'quantity', gross: 'item-price', status: 'order-status', order_id: 'amazon-order-id' };
const AMZ_REPORT_TYPE = 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL';
// HARD LIMIT: this report can only be requested for ≤30 days per call ("Date range exceeded"
// otherwise). So we chunk: one ≤30-day window per report, walking the cursor forward.
const AMZ_WINDOW_MS = 30 * 24 * 3600 * 1000;
async function createAmazonReport(host, H, mkt, startISO, endISO) {
  const cr = await fetch(`${host}/reports/2021-06-30/reports`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ reportType: AMZ_REPORT_TYPE, marketplaceIds: [mkt], dataStartTime: startISO, dataEndTime: endISO }),
  });
  if (!cr.ok) throw new Error(`Amazon createReport ${cr.status}: ${(await cr.text().catch(() => '')).slice(0, 200)}`);
  const cj = await cr.json();
  if (!cj.reportId) throw new Error('Amazon createReport: no reportId — ' + JSON.stringify(cj).slice(0, 160));
  return cj.reportId;
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
    let subreqs = 1; // token

    // ── A pending report is in flight → poll it ──
    if (cfg.pending_report_id) {
      const pr = await fetch(`${host}/reports/2021-06-30/reports/${cfg.pending_report_id}`, { headers: H }); subreqs++;
      if (!pr.ok) throw new Error(`Amazon getReport ${pr.status}: ${(await pr.text().catch(() => '')).slice(0, 160)}`);
      const rep = await pr.json();
      const st = rep.processingStatus;
      if (st === 'IN_QUEUE' || st === 'IN_PROGRESS') return { rows: [], cursorAfter: null, subreqs, partial: true }; // still cooking; keep pending, next tick re-polls
      if (st === 'CANCELLED' || st === 'FATAL') { await patchConnectorConfig(channelId, cfg, { pending_report_id: null, pending_through: null }); throw new Error(`Amazon report ${st}`); }
      // DONE → fetch the document, gunzip, parse the TSV grid
      const dr = await fetch(`${host}/reports/2021-06-30/documents/${rep.reportDocumentId}`, { headers: H }); subreqs++;
      if (!dr.ok) throw new Error(`Amazon getDocument ${dr.status}`);
      const doc = await dr.json();
      const text = await fetchAmazonDoc(doc); subreqs++;
      if (/date range exceeded/i.test(text)) throw new Error('Amazon: ' + text.trim().slice(0, 120)); // defensive — window too wide
      const grid = text.split(/\r?\n/).filter(l => l.length).map(l => l.split('\t'));
      const rows = grid.length >= 2 ? gridToQcRows(grid, columns, todayISO()) : [];
      const windowEnd = cfg.pending_through;
      // Walk forward: if history remains beyond this window, immediately queue the NEXT ≤30-day
      // report (so each tick ingests one window AND queues the next — backfill self-walks).
      const endMs = Date.parse(windowEnd || '') || 0;
      let partial = false, next = { pending_report_id: null, pending_through: null };
      if (endMs && endMs < nowMs - 60_000) {
        const nextEnd = new Date(Math.min(endMs + AMZ_WINDOW_MS, nowMs)).toISOString();
        try { const rid = await createAmazonReport(host, H, mkt, windowEnd, nextEnd); subreqs++; next = { pending_report_id: rid, pending_through: nextEnd }; partial = true; }
        catch (_) { /* leave pending cleared — next tick re-creates from the advanced cursor */ }
      }
      await patchConnectorConfig(channelId, cfg, next);
      return { rows, cursorAfter: windowEnd, subreqs, partial }; // cursor advances to this window's end
    }

    // ── No pending → create the first/next ≤30-day report from the cursor ──
    const startISO = cursor || cfg.backfill_start || BACKFILL_START;
    const startMs = Date.parse(startISO) || nowMs;
    const endISO = new Date(Math.min(startMs + AMZ_WINDOW_MS, nowMs)).toISOString();
    const rid = await createAmazonReport(host, H, mkt, startISO, endISO); subreqs++;
    await patchConnectorConfig(channelId, cfg, { pending_report_id: rid, pending_through: endISO });
    return { rows: [], cursorAfter: null, subreqs, partial: true }; // report queued; next tick ingests
  },
  async stage(rows, runId, channelId) {
    if (!rows.length) return;
    const from = rows.reduce((m, x) => x.sale_date < m ? x.sale_date : m, rows[0].sale_date);
    const to   = rows.reduce((m, x) => x.sale_date > m ? x.sale_date : m, rows[0].sale_date);
    // stg_amazon has no stable source line id (flat file) → supersede by date range, like the gsheet adapter.
    await sbSales(`/rest/v1/stg_amazon?channel_id=eq.${channelId}&sale_date=gte.${from}&sale_date=lte.${to}`, { method: 'DELETE', prefer: 'return=minimal' });
    const body = rows.map(r => ({
      run_id: runId, channel_id: channelId, source_order_id: r.source_order_id || null, sale_date: r.sale_date,
      channel_sku: r.channel_sku, title: r.title, qty: Math.round(r.qty), gross_value: r.gross_value,
      order_status: r.order_status || null, is_cancelled: !!r.is_cancelled, raw: r.raw,
    }));
    await sbSales('/rest/v1/stg_amazon', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(body) });
  },
};

// ── Amazon Ads (Advertising API v3 · LWA refresh-token · async reporting) → mkt_fact ──
// SEPARATE LWA app from SP-API (AMAZON_ADS_*). India = EU host. Profile discovered once + cached.
// Async report: create → poll → ingest carried ACROSS cron ticks via connector_config.config:
//   { region_host, ad_product, profile_id, backfill_start, pending_report_id, pending_through }
let _amzAdsToken = null, _amzAdsTokenExp = 0;
async function getAmazonAdsToken(env) {
  if (!env.AMAZON_ADS_REFRESH_TOKEN || !env.AMAZON_ADS_CLIENT_ID || !env.AMAZON_ADS_CLIENT_SECRET)
    throw new Error('Amazon Ads not configured (set AMAZON_ADS_REFRESH_TOKEN + AMAZON_ADS_CLIENT_ID/SECRET)');
  const now = Date.now();
  if (_amzAdsToken && now < _amzAdsTokenExp - 60_000) return _amzAdsToken;
  const res = await fetch('https://api.amazon.co.uk/auth/o2/token', {   // EU LWA token endpoint
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: env.AMAZON_ADS_REFRESH_TOKEN, client_id: env.AMAZON_ADS_CLIENT_ID, client_secret: env.AMAZON_ADS_CLIENT_SECRET }),
  });
  const t = await res.json().catch(() => ({}));
  if (!t.access_token) throw new Error('Amazon Ads token failed: ' + JSON.stringify(t).slice(0, 160));
  _amzAdsToken = t.access_token; _amzAdsTokenExp = now + (Number(t.expires_in) || 3600) * 1000;
  return _amzAdsToken;
}
const AMZ_ADS_WINDOW_MS = 30 * 24 * 3600 * 1000;            // ≤30-day report windows
const AMZ_ADS_COLUMNS = ['date', 'campaignId', 'campaignName', 'impressions', 'clicks', 'cost', 'purchases14d', 'sales14d'];
const amzAdsDay = ms => new Date(ms).toISOString().slice(0, 10);
async function createAdsReport(host, H, adProduct, reportTypeId, startDate, endDate) {
  const cr = await fetch(`${host}/reporting/reports`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      name: `odo-${reportTypeId}-${startDate}-${endDate}`, startDate, endDate,
      configuration: { adProduct, groupBy: ['campaign'], columns: AMZ_ADS_COLUMNS, reportTypeId, timeUnit: 'DAILY', format: 'GZIP_JSON' },
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
          conversions: num(d.purchases14d), conv_value: num(d.sales14d), raw: d,
        })).filter(r => r.the_date);
      }
      const windowEnd = cfg.pending_through;
      const endMs = Date.parse((windowEnd || '') + 'T00:00:00Z') || 0;
      // Walk forward: queue the next window if this one ended >~10h before now (more history to cover).
      let partial = false, next = { pending_report_id: null, pending_through: null };
      if (endMs && endMs < nowMs - 36_000_000) {
        const nextStart = amzAdsDay(endMs + 86400000);
        const nextEnd = amzAdsDay(Math.min(endMs + AMZ_ADS_WINDOW_MS, nowMs));
        try { const rid = await createAdsReport(host, H, adProduct, reportTypeId, nextStart, nextEnd); subreqs++; next = { pending_report_id: rid, pending_through: nextEnd }; partial = true; }
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
    const startMs = Date.parse(startStr + 'T00:00:00Z') || nowMs;
    const endStr = amzAdsDay(Math.min(startMs + AMZ_ADS_WINDOW_MS, nowMs));
    const rid = await createAdsReport(host, H, adProduct, reportTypeId, startStr, endStr); subreqs++;
    await patchConnectorConfig(channelId, cfg, { pending_report_id: rid, pending_through: endStr });
    return { rows: [], cursorAfter: null, subreqs, partial: true };
  },
  async stage(rows, runId, channelId) {
    if (!rows.length) return;
    const from = rows.reduce((m, x) => x.the_date < m ? x.the_date : m, rows[0].the_date);
    const to   = rows.reduce((m, x) => x.the_date > m ? x.the_date : m, rows[0].the_date);
    await sbSales(`/rest/v1/stg_amazon_ads?channel_id=eq.${channelId}&the_date=gte.${from}&the_date=lte.${to}`, { method: 'DELETE', prefer: 'return=minimal' });
    const body = rows.map(r => ({ run_id: runId, channel_id: channelId, ad_account_id: r.ad_account_id, campaign_id: r.campaign_id, campaign_name: r.campaign_name, the_date: r.the_date, spend: r.spend, impressions: Math.round(r.impressions), clicks: Math.round(r.clicks), conversions: r.conversions, conv_value: r.conv_value, raw: r.raw }));
    await sbSales('/rest/v1/stg_amazon_ads', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(body) });
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
  datesOf(rows) { return [...new Set(rows.map(r => r.the_date))].sort(); },
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
    return { rows, cursorAfter, subreqs, partial };
  },
  async stage(rows, runId, channelId) {
    if (!rows.length) return;
    const body = rows.map(r => ({
      run_id: runId, channel_id: channelId, ad_account_id: r.ad_account_id, campaign_id: r.campaign_id,
      campaign_name: r.campaign_name, the_date: r.the_date, spend: r.spend, impressions: Math.round(r.impressions),
      clicks: Math.round(r.clicks), conversions: r.conversions, conv_value: r.conv_value, raw: r.raw,
    }));
    await sbSales('/rest/v1/stg_meta', { method: 'POST', body: JSON.stringify(body), prefer: 'return=minimal,resolution=merge-duplicates' });
  },
  async recompute({ channelId, dates, runId }) {
    const f = await rpcSales('recompute_mkt', { p_channel: channelId, p_dates: dates, p_run_id: runId });
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
    await sbSales('/rest/v1/stg_ga4', { method: 'POST', body: JSON.stringify(body), prefer: 'return=minimal,resolution=merge-duplicates' });
  },
  async recompute({ channelId, dates, runId }) {
    const f = await rpcSales('recompute_traffic', { p_channel: channelId, p_dates: dates, p_run_id: runId });
    return { mapped: 0, unmapped: 0, factsUpserted: (f.ok ? Number(f.data) : 0) };
  },
};

const ADAPTERS = { shopify: shopifyAdapter, snorkel_internal: snorkelAdapter, qc_upload: qcAdapter, qc_gsheet: gsheetAdapter, amazon_spapi: amazonAdapter, amazon_ads: amazonAdsAdapter, meta_ads: metaAdsAdapter, ga4: ga4Adapter };

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
  // status/order_id are optional (Amazon flat-file carries them; QC sheets don't).
  const ci = { sku: idx(cm.sku), title: idx(cm.title), units: idx(cm.units), gross: idx(cm.gross), date: idx(cm.date), status: idx(cm.status), order_id: idx(cm.order_id) };
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
      source_order_id: ci.order_id >= 0 ? (String(line[ci.order_id] ?? '').trim() || null) : null,
      order_status: statusCell || null, is_cancelled: /cancel/i.test(statusCell),
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
    const dates = adapter.datesOf ? adapter.datesOf(rows) : distinctDates(rows);
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
    if (cursorAfter) await sbSales(`/rest/v1/connector_config?channel_id=eq.${cfg.channel_id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ cursor: cursorAfter, last_ok_at: nowISO(), last_error: null }) });
    return { subreqs };
  } catch (e) {
    await finishRun(runId, { status: 'error', error: String(e?.message || e) });
    await sbSales(`/rest/v1/connector_config?channel_id=eq.${cfg.channel_id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ last_error: String(e?.message || e) }) });
    return { subreqs: 0 };
  }
}
async function runChannel(cfg, trigger, env, userId, opts = {}) {
  const runId = await startRun(cfg, trigger, userId);
  return executeRun({ ...cfg, started_by: userId }, runId, env, opts);
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
    await sbSales('/rest/v1/stg_qc', { method: 'POST', prefer: 'return=minimal,resolution=merge-duplicates', body: JSON.stringify(body) });
  }
  const dates = distinctDates(rows);
  const res = dates.length ? await mapAndUpsert(batch.channel_id, dates, null, 'stg_qc', batch.uploaded_by) : { mapped: 0, unmapped: 0, factsUpserted: 0 };
  await sbSales(`/rest/v1/upload_batch?id=eq.${batch.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'mapped', rows_total: rows.length, rows_mapped: res.mapped, rows_unmapped: res.unmapped, parsed_at: nowISO() }) });
  return { rows_total: rows.length, ...res };
}

// ============================================================
export default {
  async scheduled(event, env, ctx) {
    SUPABASE_SERVICE_KEY = env.SUPABASE_SERVICE_KEY || '';
    _channels = null;
    try {
      const r = await sbSales('/rest/v1/connector_config?enabled=eq.true&select=*');
      let budget = CRON_BUDGET;
      for (const cfg of (r.ok ? r.data : [])) {
        if (budget < 8) break;                       // defer remaining channels to next hour
        const runId = await startRun(cfg, 'cron', null);
        const { subreqs } = await executeRun(cfg, runId, env, { budget });
        budget -= (subreqs || 1);
      }
    } catch (e) { console.error('salesops cron failed:', e?.message || e); }
  },

  async fetch(request, env, ctx) {
    SUPABASE_SERVICE_KEY = env.SUPABASE_SERVICE_KEY || '';
    _channels = null;
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const action = url.searchParams.get('action');
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
            const [cfgR, runR, unmR] = await Promise.all([
              sbSales('/rest/v1/connector_config?select=*'),
              sbSales('/rest/v1/connector_runs?order=started_at.desc&limit=60&select=*'),
              sbSales('/rest/v1/unmapped_sku?status=eq.open&select=id'),
            ]);
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
            });
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

          case 'getTraffic': {
            const r = await rpcSales('f_traffic_rollup', { p_from: qp('from') || todayISO(), p_to: qp('to') || todayISO() });
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
              secrets: { shopify: !!(env.SHOPIFY_ACCESS_TOKEN || env.SHOPIFY_CLIENT_ID), amazon: !!env.AMAZON_LWA_CLIENT_ID, amazon_ads: !!env.AMAZON_ADS_CLIENT_ID, flipkart: !!env.FLIPKART_CLIENT_ID, google: !!env.GOOGLE_SA_JSON, meta: !!env.META_SYSTEM_USER_TOKEN },
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
            const channels = d.channel_id ? [d.channel_id] : null;
            const cfgR = await sbSales(`/rest/v1/connector_config?enabled=eq.true${channels ? `&channel_id=eq.${channels[0]}` : ''}&select=*`);
            const cfgs = cfgR.ok ? cfgR.data : [];
            if (!cfgs.length) return err('No enabled connector for that channel', 404);
            const ids = [];
            for (const cfg of cfgs) { const runId = await startRun(cfg, 'manual', userId); ids.push(runId); ctx.waitUntil(executeRun({ ...cfg, started_by: userId }, runId, env, { budget: CRON_BUDGET })); }
            return ok({ run_ids: ids, started: cfgs.length });
          }
          case 'backfill': {
            if (!canConnector(P)) return err('No permission', 403);
            if (!d.channel_id) return err('channel_id required');
            const cfgR = await sbSales(`/rest/v1/connector_config?channel_id=eq.${d.channel_id}&select=*`);
            if (!cfgR.ok || !cfgR.data[0]) return err('Connector not found', 404);
            const cfg = cfgR.data[0];
            const cursorOverride = d.from ? (d.from.length === 10 ? d.from + 'T00:00:00Z' : d.from) : BACKFILL_START;
            const runId = await startRun(cfg, 'backfill', userId, cursorOverride);
            ctx.waitUntil(executeRun({ ...cfg, started_by: userId }, runId, env, { budget: CRON_BUDGET, cursorOverride }));
            return ok({ run_id: runId });
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
