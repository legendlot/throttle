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
    const rows = []; let after = null, hasNext = true, subreqs = 0, maxUpdated = since, partial = false;
    const gql = `query($q:String!,$after:String){ orders(first:50, query:$q, sortKey:UPDATED_AT, after:$after){ pageInfo{ hasNextPage endCursor } edges{ node{ id name createdAt updatedAt cancelledAt displayFinancialStatus currencyCode lineItems(first:100){ edges{ node{ id title quantity sku variantTitle originalTotalSet{ shopMoney{ amount currencyCode } } } } } } } } }`;
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
        const cancelled = !!o.cancelledAt || fin === 'REFUNDED' || fin === 'VOIDED';
        for (const le of (o.lineItems?.edges || [])) {
          const l = le.node;
          rows.push({
            source_line_id: l.id, source_order_id: o.id, order_name: o.name,
            channel_sku: l.sku || l.variantTitle || l.title, variant_title: l.variantTitle || null, title: l.title || null,
            qty: num(l.quantity), gross_value: num(l.originalTotalSet?.shopMoney?.amount),
            occurred_at: o.createdAt, sale_date: istDate(o.createdAt),
            order_status: o.displayFinancialStatus || null, is_cancelled: cancelled, raw: l,
          });
        }
      }
      hasNext = !!conn?.pageInfo?.hasNextPage; after = conn?.pageInfo?.endCursor || null;
    }
    return { rows, cursorAfter: maxUpdated, subreqs, partial };
  },
  async stage(rows, runId, channelId) {
    if (!rows.length) return;
    const body = rows.map(r => ({
      run_id: runId, channel_id: channelId, source_order_id: r.source_order_id, order_name: r.order_name,
      source_line_id: r.source_line_id, occurred_at: r.occurred_at, sale_date: r.sale_date,
      channel_sku: r.channel_sku, variant_title: r.variant_title, title: r.title,
      qty: Math.round(r.qty), gross_value: r.gross_value, order_status: r.order_status, is_cancelled: r.is_cancelled, raw: r.raw,
    }));
    await sbSales('/rest/v1/stg_shopify', { method: 'POST', body: JSON.stringify(body), prefer: 'return=minimal,resolution=merge-duplicates' });
  },
};

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

const ADAPTERS = { shopify: shopifyAdapter, snorkel_internal: snorkelAdapter, qc_upload: qcAdapter };

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
  const stg = await sbSales(`/rest/v1/${stgTable}?channel_id=eq.${channelId}&sale_date=in.${dl}&is_cancelled=is.false&select=channel_sku,title,qty,gross_value`);
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
    const { rows, cursorAfter, subreqs, partial } = await adapter.fetch({ env, channelId: cfg.channel_id, channelName: cname, cursor, windowTo: nowISO(), budget });
    await adapter.stage(rows, runId, cfg.channel_id);
    const dates = distinctDates(rows);
    const res = dates.length ? await mapAndUpsert(cfg.channel_id, dates, runId, adapter.stgTable, cfg.started_by) : { mapped: 0, unmapped: 0, factsUpserted: 0 };
    await finishRun(runId, { status: partial ? 'partial' : 'ok', rows_fetched: rows.length, rows_mapped: res.mapped, rows_unmapped: res.unmapped, facts_upserted: res.factsUpserted, subrequests_used: subreqs, cursor_after: cursorAfter });
    // advance the live cursor only on a clean (non-partial) success
    if (!partial && cursorAfter) await sbSales(`/rest/v1/connector_config?channel_id=eq.${cfg.channel_id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ cursor: cursorAfter, last_ok_at: nowISO(), last_error: null }) });
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
  if (grid.length < 2) throw new Error('Empty or header-only file');
  const header = grid[0].map(h => String(h).trim());
  const idx = name => header.findIndex(h => h.toLowerCase() === String(name || '').toLowerCase());
  const ci = { sku: idx(cm.sku), title: idx(cm.title), units: idx(cm.units), gross: idx(cm.gross), date: idx(cm.date) };
  if (ci.sku < 0 || ci.units < 0) throw new Error('column_map must map at least sku + units to existing columns');
  const rows = [];
  for (let r = 1; r < grid.length; r++) {
    const line = grid[r];
    const sku = String(line[ci.sku] ?? '').trim(); if (!sku) continue;
    const dateRaw = ci.date >= 0 ? String(line[ci.date] ?? '').trim() : '';
    const sale_date = (dateRaw && /^\d{4}-\d{2}-\d{2}/.test(dateRaw)) ? dateRaw.slice(0, 10) : (batch.report_period_to || batch.report_period_from || todayISO());
    rows.push({ row_no: r, channel_sku: sku, title: ci.title >= 0 ? String(line[ci.title] ?? '').trim() : null, qty: num(line[ci.units]), gross_value: ci.gross >= 0 ? num(line[ci.gross]) : 0, sale_date, raw: { line } });
  }
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
            const lastByChannel = {}; runs.forEach(r => { if (!lastByChannel[r.channel_id]) lastByChannel[r.channel_id] = r; });
            const cfgByChannel = {}; cfgs.forEach(c => { cfgByChannel[c.channel_id] = c; });
            return ok({
              secrets: { shopify: !!env.SHOPIFY_CLIENT_ID, amazon: !!env.AMAZON_LWA_CLIENT_ID, flipkart: !!env.FLIPKART_CLIENT_ID },
              connectors: channels.map(c => ({ channel_id: c.id, name: c.name, adapter_kind: cfgByChannel[c.id]?.adapter_kind || null, enabled: !!cfgByChannel[c.id]?.enabled, cursor: cfgByChannel[c.id]?.cursor || null, last_ok_at: cfgByChannel[c.id]?.last_ok_at || null, last_error: cfgByChannel[c.id]?.last_error || null, last_run: lastByChannel[c.id] || null })),
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
