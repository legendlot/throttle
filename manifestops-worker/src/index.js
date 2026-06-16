// ============================================================
// MANIFEST OPS — LOT ↔ Solve Factory China-import system Worker
// ------------------------------------------------------------
// Own worker, isolated blast radius. service_role on the SAME Supabase project
// as lotopsproxy/snorkelops. Owns the `manifest` schema. The ONLY cross-schema
// WRITE is the Snorkel projection into store.purchase_orders + store.po_lines
// (source='China'); cross-schema READS are the store masters (vendors,
// forwarders, company_addresses) + store.next_seq. No cross-worker calls.
//
// Permission layer is Manifest-only (manifest.manifest_roles / manifest_user_roles)
// with a hard LOT|SF party tag. External SF owners log in via email OTP (no domain
// lock); access still requires an active users_profile row + a manifest role.
// ============================================================

const SUPABASE_URL = 'https://jkxcnjabmrkteanzoofj.supabase.co';
const SUPABASE_KEY = 'sb_publishable_1Dd-r3h9Mou2Wqgn6t24Dw_lmWdBtLh'; // publishable — for auth verify only
let SUPABASE_SERVICE_KEY = ''; // loaded from env each invocation

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, apikey, Authorization',
};

// ── Permission gates (keys in manifest.manifest_roles.permissions) ──
const canView            = p => !!p.manifest_view;
const canManageOrders    = p => !!p.order_manage;
const canUpdateOrder     = p => !!p.order_manage || !!p.sf_order_update;       // SF may move status/tracking
const canManageShipments = p => !!p.shipment_manage || !!p.sf_order_update;    // SF updates milestones
const canManageCharges   = p => !!p.charge_manage || !!p.sf_vendor_payment_record; // SF inputs cost lines
const canFinalizeCharge  = p => !!p.charge_manage;                             // flip is_estimate=false: LOT only
const canRecordPayment   = p => !!p.payment_record;                           // LOT → SF payments: LOT only
const canManageDrawdowns = p => !!p.drawdown_manage;                          // status moves: LOT only
const canRaiseDrawdown   = p => !!p.drawdown_manage || !!p.sf_drawdown_raise;  // SF raises requests
const canRecordVendorPay = p => !!p.sf_vendor_payment_record || !!p.payment_record;
const canManageFx        = p => !!p.fx_manage;
const canManageDocs      = p => !!p.doc_manage || !!p.sf_evidence_upload;
const canProjectSnorkel  = p => !!p.china_po_sync;
const canAdmin           = p => !!p.manifest_admin;
const canViewCost        = p => !!p.cost_view;   // v2 landed-CPU / margin lens (SF lacks it)

// Strip LOT-only cost/margin fields from a read when the caller lacks cost_view.
// v1 has no margin/CPU columns yet; the lens is here so v2 fields are never leaked to SF.
const COST_ONLY_FIELDS = ['landed_cpu', 'landed_total_inr', 'margin', 'margin_pct', 'selling_price', 'std_cost', 'viable'];
function stripCost(row, P) {
  if (canViewCost(P) || !row) return row;
  const out = { ...row };
  for (const f of COST_ONLY_FIELDS) delete out[f];
  return out;
}

// Resolve Manifest permissions + party: manifest_user_roles(user) → role_key → manifest_roles.
async function getManifestRole(userId) {
  const ur = await sb(`/rest/v1/manifest_user_roles?user_id=eq.${userId}&select=role_key&limit=1`);
  if (!ur.ok || !ur.data[0]) return { roleKey: null, party: null, perms: {} };
  const roleKey = ur.data[0].role_key;
  const r = await sb(`/rest/v1/manifest_roles?role_key=eq.${encodeURIComponent(roleKey)}&select=permissions,party&limit=1`);
  if (!r.ok || !r.data[0]) return { roleKey, party: null, perms: {} };
  return { roleKey, party: r.data[0].party || null, perms: r.data[0].permissions || {} };
}

async function verifyJWT(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  if (!user?.id) return null;
  const profileRes = await sbStore(`/rest/v1/users_profile?id=eq.${user.id}&select=role,full_name,active&limit=1`);
  if (!profileRes.ok || !profileRes.data[0]) return null;       // no profile → denied (incl. random OTP signups)
  const profile = profileRes.data[0];
  if (!profile.active) return null;
  const mr = await getManifestRole(user.id);
  if (!mr.roleKey) return null;                                 // no manifest role → denied
  return {
    userId: user.id, email: user.email, role: profile.role, fullName: profile.full_name,
    manifestRole: mr.roleKey, party: mr.party, permissions: mr.perms,
  };
}

// ── DB helpers ─────────────────────────────────────────────────
// service-role: secret sent as BOTH apikey and Authorization (sb_secret keys are
// not JWTs). manifest profile = the `manifest` schema; store profile = `store`.
async function sbProfiled(path, profile, opts = {}) {
  const headers = {
    'Content-Type':   'application/json',
    'apikey':         SUPABASE_SERVICE_KEY,
    'Authorization':  `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Prefer':         opts.prefer || '',
    ...opts.headers,
  };
  if (profile) { headers['Accept-Profile'] = profile; headers['Content-Profile'] = profile; }
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...opts, headers });
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, data: text }; }
}
const sb        = (path, opts = {}) => sbProfiled(path, 'manifest', opts);  // manifest schema
const sbStore   = (path, opts = {}) => sbProfiled(path, 'store',    opts);  // store schema (masters, projection, next_seq)

async function query(table, params = '')  { return sb(`/rest/v1/${table}${params}`); }
async function queryStore(table, params = '') { return sbStore(`/rest/v1/${table}${params}`); }
async function insert(table, body, prefer = 'return=representation') {
  return sb(`/rest/v1/${table}`, { method: 'POST', body: JSON.stringify(body), prefer });
}
async function update(table, body, filter) {
  return sb(`/rest/v1/${table}?${filter}`, { method: 'PATCH', body: JSON.stringify(body), prefer: 'return=representation' });
}
async function del(table, filter) {
  return sb(`/rest/v1/${table}?${filter}`, { method: 'DELETE', prefer: 'return=minimal' });
}
// store.next_seq is UPDATE-only (rows seeded in migration). Called via the store profile.
async function nextSeq(name, prefix, pad = 4) {
  const r = await sbStore('/rest/v1/rpc/next_seq', { method: 'POST', body: JSON.stringify({ seq_name: name }) });
  if (!r.ok || r.data == null) throw new Error('Sequence error: ' + JSON.stringify(r.data));
  return prefix + String(r.data).padStart(pad, '0');
}

// ── FX helpers ─────────────────────────────────────────────────
async function fxForDate(dateISO) {
  const d = dateISO || todayISO();
  const m = await sb(`/rest/v1/fx_rates?base=eq.CNY&quote=eq.INR&source=eq.manual&rate_date=eq.${d}&select=rate&limit=1`);
  if (m.ok && m.data[0]) return Number(m.data[0].rate);
  const a = await sb(`/rest/v1/fx_rates?base=eq.CNY&quote=eq.INR&rate_date=lte.${d}&select=rate&order=rate_date.desc&limit=1`);
  if (a.ok && a.data[0]) return Number(a.data[0].rate);
  return null;
}
async function fetchAndStoreFxRate() {
  const res = await fetch('https://open.er-api.com/v6/latest/CNY');
  if (!res.ok) throw new Error('FX API ' + res.status);
  const j = await res.json();
  const rate = j?.rates?.INR;
  if (!rate) throw new Error('No INR rate in FX response');
  await sb('/rest/v1/fx_rates', {
    method: 'POST',
    body: JSON.stringify({ base: 'CNY', quote: 'INR', rate, rate_date: todayISO(), source: 'auto' }),
    prefer: 'return=minimal,resolution=merge-duplicates',
  });
  return rate;
}

// ── Storage (private bucket manifest-docs) ─────────────────────
const DOC_BUCKET = 'manifest-docs';
async function storageFetch(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1${path}`, {
    ...opts,
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, ...(opts.headers || {}) },
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}
function safeSeg(s) { return String(s || '').replace(/[^\w.\-]+/g, '_'); }

// Best-effort activity feed.
async function logActivity(auth, event, { scope, order_id, shipment_id, detail, metadata } = {}) {
  try {
    await insert('activity', {
      actor: auth?.userId || null, actor_name: auth?.fullName || null, party: auth?.party || null,
      event, scope: scope || null, order_id: order_id || null, shipment_id: shipment_id || null,
      detail: detail || null, metadata: metadata || {},
    }, 'return=minimal');
  } catch (e) { console.error('activity log failed:', e); }
}

// Category → Snorkel PO order_type + po_number type code.
const CATEGORY_TO_PO = {
  product:   { order_type: 'Product',   code: 'PRD' },
  part:      { order_type: 'Component', code: 'CMP' },
  sub_part:  { order_type: 'Component', code: 'CMP' },
  mould:     { order_type: 'Tools',     code: 'TLS' },
  equipment: { order_type: 'Machines',  code: 'MCH' },
  sample:    { order_type: 'Product',   code: 'OTH' },
  other:     { order_type: 'Component', code: 'OTH' },
};

function todayISO() { return new Date().toISOString().split('T')[0]; }
function nowISO()   { return new Date().toISOString(); }
function ok(data, status = 200) {
  return new Response(JSON.stringify({ ok: true, data }), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
function err(msg, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: msg }), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// Writable order columns (code/audit/link excluded).
const ORDER_FIELDS = ['title','category','vendor_code','vendor_name','placed_via','currency','est_value_rmb','incoterms','notes'];
const LINE_FIELDS  = ['line_no','product','variant','color','item_type','part_code','description','qty','unit',
  'unit_price_rmb','hsn_code','gst_percent','component_type','receive_format','remote_qty','weight_kg','cbm'];
const SHIPMENT_FIELDS = ['shipment_no','mode','container_type','container_no','bl_awb_no','forwarder_code','forwarder_name',
  'status','etd','eta','loading_date','unloading_date','port_arrival_date','customs_entry_date','clearance_date',
  'local_dispatch_date','warehouse_delivery_date','notes'];
function pick(src, fields) {
  const out = {};
  for (const f of fields) if (src[f] !== undefined) out[f] = (src[f] === '' ? null : src[f]);
  return out;
}

// ── display formatters for the Pit Wall UI ─────────────────────────
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtDay(iso) {
  if (!iso) return '—';
  const d = new Date(iso); if (isNaN(d)) return String(iso);
  return String(d.getUTCDate()).padStart(2, '0') + ' ' + MON[d.getUTCMonth()];
}
function relTime(iso) {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return Math.max(1, Math.floor(s / 60)) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
const activityTone = (ev) => {
  const e = (ev || '').toLowerCase();
  if (e.includes('payment')) return 'green';
  if (e.includes('drawdown')) return 'yellow';
  if (e.includes('order') || e.includes('shipment') || e.includes('projected')) return 'blue';
  return 'gray';
};

// ============================================================
export default {
  async scheduled(event, env, ctx) {
    SUPABASE_SERVICE_KEY = env.SUPABASE_SERVICE_KEY || '';
    try { const r = await fetchAndStoreFxRate(); console.log('FX auto rate CNY→INR:', r); }
    catch (e) { console.error('FX cron failed:', e?.message || e); }
  },

  async fetch(request, env) {
    SUPABASE_SERVICE_KEY = env.SUPABASE_SERVICE_KEY || '';
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url    = new URL(request.url);
    const action = url.searchParams.get('action');
    const auth   = await verifyJWT(request.headers.get('Authorization'));
    const userId = auth?.userId || null;
    const P      = auth?.permissions || {};
    const party  = auth?.party || null;

    try {
      // ───────────────────────── GET (reads) ─────────────────────────
      if (request.method === 'GET') {
        if (!auth) return err('Unauthorised', 401);
        const qp = k => url.searchParams.get(k);

        switch (action) {
          case 'getMe':
          case 'ping':
            return ok({
              id: userId, userId, email: auth.email, role: auth.role,
              full_name: auth.fullName, fullName: auth.fullName,
              manifest_role: auth.manifestRole, party, permissions: P,
            });

          // ── Bootstrap: one round-trip powering the whole SPA ──
          case 'getBootstrap': {
            const [oR, raR, ddR, pmR, shR, fxR, docR, actR, invR, subR] = await Promise.all([
              query('orders', '?order=invoice_date.desc.nullslast,created_at.desc&select=*'),
              query('running_account', '?select=*'),
              query('drawdowns', '?order=requested_at.desc&select=*'),
              query('payments', '?order=paid_date.desc.nullslast,created_at.desc&select=*'),
              query('shipments', '?order=created_at.desc&select=*'),
              query('fx_rates', '?order=rate_date.desc,source.asc&limit=120&select=*'),
              query('documents', '?order=created_at.desc&limit=500&select=*'),
              query('activity', '?order=created_at.desc&limit=40&select=*'),
              query('sf_invoices', '?select=invoice_no,commission_inr,total_inr'),
              query('sf_subentities', '?order=sort_order.asc&select=*'),
            ]);

            // order_no → number map for FK display
            const orderRows = oR.ok ? oR.data : [];
            const orderNoById = {}; orderRows.forEach(o => { orderNoById[o.id] = o.order_no; });

            // ── ledger (running_account view), chronological ──
            const led = (raR.ok ? raR.data : []).slice().sort((a, b) =>
              String(a.entry_date || a.created_at).localeCompare(String(b.entry_date || b.created_at)) ||
              String(a.created_at).localeCompare(String(b.created_at)));
            const ledger = led.map(e => ({
              date: e.entry_date, kind: e.kind, ref: e.ref_no, desc: e.description,
              amt: Number(e.signed_inr) || 0, balance: Number(e.running_balance) || 0,
            }));
            const sumKind = (k) => led.filter(e => e.kind === k).reduce((s, e) => s + (Number(e.signed_inr) || 0), 0);
            const net = ledger.length ? ledger[ledger.length - 1].balance : 0;
            const credits = sumKind('payment');
            const debits = -(sumKind('order_cost') + sumKind('commission') + sumKind('charge'));
            const reservedLien = -sumKind('reserved_lien');
            const commissionPayable = -(sumKind('commission') + sumKind('commission_base'));
            const openingBalance = sumKind('opening_balance');
            const peak = ledger.reduce((m, r) => Math.max(m, r.balance), net);
            const openDd = (ddR.ok ? ddR.data : []).filter(d => ['requested', 'partially_paid'].includes(d.status));
            const openDrawdowns = openDd.reduce((s, d) => s + (Number(d.est_amount_inr) || 0), 0);
            const counts = {
              total: orderRows.length,
              inFlight: orderRows.filter(o => o.cost_state === 'in_flight').length,
              invoiced: orderRows.filter(o => o.cost_state === 'invoiced').length,
              delivered: orderRows.filter(o => o.cost_state === 'delivered').length,
            };
            const shipmentsInTransit = (shR.ok ? shR.data : []).filter(s => s.status === 'in_transit').length;

            const summary = stripCost({
              net, owes: net < 0, gross: net + reservedLien,
              reservedLien, commissionPayable, openingBalance,
              credits, debits, bufferPct: credits ? Math.round((debits / credits) * 100) : 0,
              openDrawdowns, openDrawCount: openDd.length, peak, counts, shipmentsInTransit,
            }, P);

            // ── orders (UI shape) ──
            const orders = orderRows.map(o => stripCost({
              id: o.id, no: o.order_no, title: o.title, category: o.category,
              valueRmb: (o.qty != null && o.per_unit_rmb != null) ? Math.round(Number(o.qty) * Number(o.per_unit_rmb)) : null,
              totalInr: Number(o.total_inr) || 0, purchaseInr: Number(o.purchase_inr) || 0,
              recognized: Number(o.recognized_cost_inr) || 0,
              po: o.linked_po_number || null, status: o.status, costState: o.cost_state,
              label: o.order_label, invoiceNo: o.invoice_no, date: fmtDay(o.invoice_date || o.created_at),
            }, P));

            // ── payments / drawdowns / shipments / fx / docs / activity ──
            const payments = (pmR.ok ? pmR.data : []).map(p => ({
              ref: p.payment_no, date: fmtDay(p.paid_date), inr: Number(p.amount_inr) || 0,
              rmb: p.amount_rmb != null ? Number(p.amount_rmb) : null, rate: p.fx_rate_used != null ? Number(p.fx_rate_used) : null,
              method: p.method || 'Bank', against: p.subentity_code || (p.drawdown_id ? 'Draw-down' : 'Advance'), status: 'cleared',
            }));
            const drawdowns = (ddR.ok ? ddR.data : []).map(d => ({
              no: d.drawdown_no, phase: d.phase, order: d.order_id ? (orderNoById[d.order_id] || null) : null,
              estInr: Number(d.est_amount_inr) || 0, rate: d.est_fx_rate != null ? Number(d.est_fx_rate) : null,
              by: d.requested_by_name || '—', date: fmtDay(d.requested_at), status: d.status,
            }));
            const shipments = (shR.ok ? shR.data : []).map(s => ({
              no: s.shipment_no, mode: s.mode || '—', blAwb: s.bl_awb_no || '—',
              eta: fmtDay(s.eta), status: s.status, order: s.notes || '—',
            }));
            const fxRows = (fxR.ok ? fxR.data : []);
            const fxChrono = fxRows.slice().sort((a, b) => String(a.rate_date).localeCompare(String(b.rate_date)));
            const fxHistory = fxRows.map((r, i) => {
              const prevSameOlder = fxRows.find((x, j) => j > i && Number(x.rate) !== Number(r.rate));
              const delta = prevSameOlder ? +(Number(r.rate) - Number(prevSameOlder.rate)).toFixed(2) : null;
              return { date: fmtDay(r.rate_date), rate: Number(r.rate), delta, by: r.source === 'manual' ? 'Manual' : 'Auto', applied: r.note || '—' };
            });
            const fxCurrent = await fxForDate(todayISO());
            const fx = { current: fxCurrent, spark: fxChrono.slice(-10).map(r => Number(r.rate)), history: fxHistory };
            const documents = (docR.ok ? docR.data : []).map(d => ({
              filename: d.file_name || d.storage_path, type: d.doc_type, ref: d.order_id ? orderNoById[d.order_id] : (d.shipment_id || '—'),
              date: fmtDay(d.created_at), size: d.mime_type || '', storage_path: d.storage_path,
            }));
            const activity = (actR.ok ? actR.data : []).map(a => ({
              event: (a.event || '').replace(/_/g, ' '), detail: a.detail || '', who: a.actor_name || a.party || '—',
              when: relTime(a.created_at), tone: activityTone(a.event),
            }));

            // ── admin org groups (admin only) ──
            let orgGroups = [];
            if (canAdmin(P)) {
              const [urR, rolesR, profR] = await Promise.all([
                query('manifest_user_roles', '?select=user_id,role_key'),
                query('manifest_roles', '?select=role_key,label,party'),
                queryStore('users_profile', '?select=id,full_name,active&order=full_name.asc'),
              ]);
              const roleMeta = {}; (rolesR.ok ? rolesR.data : []).forEach(r => { roleMeta[r.role_key] = r; });
              const urByUser = {}; (urR.ok ? urR.data : []).forEach(u => { urByUser[u.user_id] = u.role_key; });
              const lot = [], sf = [];
              (profR.ok ? profR.data : []).forEach(u => {
                const rk = urByUser[u.id]; if (!rk) return; const rm = roleMeta[rk]; if (!rm) return;
                const m = { name: u.full_name || '—', email: '', role: rm.label || rk, last: u.active ? 'active' : '—', status: u.active ? 'active' : 'invited' };
                (rm.party === 'SF' ? sf : lot).push(m);
              });
              orgGroups = [
                { org: 'Legend of Toys', tag: 'L', tagTone: 'yellow', members: lot },
                { org: 'Solve Factory', tag: 'S', tagTone: 'blue', members: sf },
              ];
            }

            return ok({
              me: { id: userId, email: auth.email, role: auth.role, full_name: auth.fullName, manifest_role: auth.manifestRole, party, permissions: P },
              summary, ledger, orders, payments, drawdowns, shipments, fx, documents, activity,
              subentities: subR.ok ? subR.data : [], orgGroups,
            });
          }

          // ── Masters (store) ──
          case 'getVendors': {
            const r = await queryStore('vendors', '?order=vendor_name.asc&select=vendor_code,vendor_name,source_country,currency,active');
            if (!r.ok) return err(r.data);
            return ok(r.data);
          }
          case 'getForwarders': {
            const r = await queryStore('forwarders', '?active=eq.true&order=company_name.asc&select=forwarder_code,company_name,country,modes_supported,sea_days,air_days');
            if (!r.ok) return err(r.data);
            return ok(r.data);
          }
          case 'getAddresses': {
            const r = await queryStore('company_addresses', '?active=eq.true&order=label.asc');
            if (!r.ok) return err(r.data);
            return ok(r.data);
          }

          // ── Orders ──
          case 'getOrders': {
            const r = await query('orders', '?order=created_at.desc&select=*');
            if (!r.ok) return err(r.data);
            return ok(r.data.map(o => stripCost(o, P)));
          }
          case 'getOrder': {
            const id = qp('id'); if (!id) return err('id required');
            const [oR, lR, dR, ddR] = await Promise.all([
              query('orders', `?id=eq.${encodeURIComponent(id)}&select=*&limit=1`),
              query('order_lines', `?order_id=eq.${encodeURIComponent(id)}&order=line_no.asc&select=*`),
              query('documents', `?order_id=eq.${encodeURIComponent(id)}&order=created_at.desc&select=*`),
              query('drawdowns', `?order_id=eq.${encodeURIComponent(id)}&order=requested_at.desc&select=*&limit=1`),
            ]);
            if (!oR.ok || !oR.data[0]) return err('Order not found', 404);
            const o = oR.data[0];
            // commission for this order's invoice (2.5% of the invoice total)
            let commission = null;
            if (o.invoice_no) {
              const inv = await query('sf_invoices', `?invoice_no=eq.${encodeURIComponent(o.invoice_no)}&select=commission_rate,commission_inr&limit=1`);
              if (inv.ok && inv.data[0]) commission = { rate: Number(inv.data[0].commission_rate), inr: Number(inv.data[0].commission_inr) };
            }
            const costRows = [
              { label: 'Goods value', amt: Number(o.purchase_inr) || 0 },
              { label: 'Shipping', amt: Number(o.shipping_inr) || 0 },
              { label: 'Customs', amt: Number(o.customs_inr) || 0 },
              ...(commission ? [{ label: `SF commission · ${commission.rate}%`, amt: commission.inr }] : []),
              { label: 'GST', amt: Number(o.gst_inr) || 0 },
            ].filter(r => r.amt > 0);
            const dd = (ddR.ok && ddR.data[0]) ? ddR.data[0] : null;
            return ok({
              order: stripCost(o, P),
              lines: (lR.ok ? lR.data : []).map(l => stripCost(l, P)),
              documents: dR.ok ? dR.data : [],
              costRows: stripCost({ rows: costRows }, P).rows || costRows,
              landed: Number(o.total_inr) || 0,
              commission,
              drawdown: dd ? { no: dd.drawdown_no, amt: Number(dd.est_amount_inr) || 0, status: dd.status } : null,
            });
          }

          // ── Shipments ──
          case 'getShipments': {
            const r = await query('shipments', '?order=created_at.desc&select=*');
            if (!r.ok) return err(r.data);
            return ok(r.data);
          }
          case 'getShipment': {
            const id = qp('id'); if (!id) return err('id required');
            const [sR, slR, dR] = await Promise.all([
              query('shipments', `?id=eq.${encodeURIComponent(id)}&select=*&limit=1`),
              query('shipment_lines', `?shipment_id=eq.${encodeURIComponent(id)}&select=*,order_lines(*,orders(order_no,title,vendor_name))`),
              query('documents', `?shipment_id=eq.${encodeURIComponent(id)}&order=created_at.desc&select=*`),
            ]);
            if (!sR.ok || !sR.data[0]) return err('Shipment not found', 404);
            return ok({
              shipment: sR.data[0],
              lines: (slR.ok ? slR.data : []).map(l => ({ ...l, order_lines: stripCost(l.order_lines, P) })),
              documents: dR.ok ? dR.data : [],
            });
          }

          // ── Charges ──
          case 'getCharges': {
            const ord = qp('order_id'), shp = qp('shipment_id');
            let f = '?order=incurred_date.desc.nullslast,created_at.desc&select=*';
            if (ord) f = `?order_id=eq.${encodeURIComponent(ord)}&order=created_at.desc&select=*`;
            else if (shp) f = `?shipment_id=eq.${encodeURIComponent(shp)}&order=created_at.desc&select=*`;
            const r = await query('charges', f);
            if (!r.ok) return err(r.data);
            return ok(r.data);
          }

          // ── Money engine ──
          case 'getDrawdowns': {
            const r = await query('drawdowns', '?order=requested_at.desc&select=*');
            if (!r.ok) return err(r.data);
            return ok(r.data);
          }
          case 'getPayments': {
            const r = await query('payments', '?order=paid_date.desc.nullslast,created_at.desc&select=*');
            if (!r.ok) return err(r.data);
            return ok(r.data);
          }
          case 'getVendorPayments': {
            const r = await query('vendor_payments', '?order=payment_date.desc.nullslast,created_at.desc&select=*');
            if (!r.ok) return err(r.data);
            return ok(r.data);
          }
          case 'getRunningAccount': {
            const r = await query('running_account', '?order=running_balance.asc&select=*'); // ordered by entry/created in the view
            if (!r.ok) return err(r.data);
            // recompute display order by the view's own ordering (entry_date, created_at)
            const rows = (r.data || []).slice().sort((a, b) =>
              String(a.entry_date || a.created_at).localeCompare(String(b.entry_date || b.created_at)) ||
              String(a.created_at).localeCompare(String(b.created_at)));
            const balance = rows.length ? Number(rows[rows.length - 1].running_balance) : 0;
            return ok({ entries: rows, balance });
          }
          case 'getMoneyDue': {
            // Actual ledger balance + provisional overlay (open drawdowns + estimate charges).
            const [raR, ddR, chR] = await Promise.all([
              query('running_account', '?select=signed_inr'),
              query('drawdowns', '?status=in.(requested,partially_paid)&select=est_amount_inr'),
              query('charges', '?is_estimate=eq.true&select=amount_inr,amount,currency'),
            ]);
            const actualBalance = (raR.ok ? raR.data : []).reduce((s, e) => s + (Number(e.signed_inr) || 0), 0);
            const openDrawdowns = (ddR.ok ? ddR.data : []).reduce((s, d) => s + (Number(d.est_amount_inr) || 0), 0);
            const estCharges    = (chR.ok ? chR.data : []).reduce((s, c) => s + (Number(c.amount_inr) || 0), 0);
            // balance > 0 → SF holds LOT funds (advance); < 0 → LOT owes SF.
            return ok({
              actual_balance: +actualBalance.toFixed(2),
              open_drawdowns: +openDrawdowns.toFixed(2),
              estimate_charges: +estCharges.toFixed(2),
              // forecast pool position once estimated costs land
              provisional_balance: +(actualBalance - estCharges).toFixed(2),
              position: actualBalance >= 0 ? 'sf_holds_lot_funds' : 'lot_owes_sf',
            });
          }
          case 'getSfInvoices': {
            const r = await query('sf_invoices', '?order=created_at.desc&select=*');
            if (!r.ok) return err(r.data);
            return ok(r.data);
          }

          // ── FX ──
          case 'getFxRates': {
            const r = await query('fx_rates', '?order=rate_date.desc,source.asc&limit=120&select=*');
            if (!r.ok) return err(r.data);
            const latest = await fxForDate(todayISO());
            return ok({ rates: r.data, latest });
          }
          case 'getFxRate': {
            const rate = await fxForDate(qp('date') || todayISO());
            return ok({ date: qp('date') || todayISO(), rate });
          }

          // ── Documents ──
          case 'getDocuments': {
            const r = await query('documents', '?order=created_at.desc&limit=500&select=*');
            if (!r.ok) return err(r.data);
            return ok(r.data);
          }
          case 'getDocumentDownloadUrl': {
            const path = qp('storage_path'); if (!path) return err('storage_path required');
            const seg = path.split('/').map(encodeURIComponent).join('/');
            const sr = await storageFetch(`/object/sign/${DOC_BUCKET}/${seg}`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 120 }),
            });
            if (!sr.ok || !sr.data?.signedURL) return err('sign_failed: ' + JSON.stringify(sr.data), 502);
            return ok({ url: `${SUPABASE_URL}/storage/v1${sr.data.signedURL}` });
          }

          // ── Activity feed ──
          case 'getActivity': {
            const r = await query('activity', '?order=created_at.desc&limit=100&select=*');
            if (!r.ok) return err(r.data);
            return ok(r.data);
          }

          // ── Admin ──
          case 'getRoles': {
            if (!canAdmin(P)) return err('No permission', 403);
            const r = await query('manifest_roles', '?order=party.asc,role_key.asc&select=*');
            if (!r.ok) return err(r.data);
            return ok(r.data);
          }
          case 'getUsers': {
            if (!canAdmin(P)) return err('No permission', 403);
            const [urR, profR] = await Promise.all([
              query('manifest_user_roles', '?select=*'),
              queryStore('users_profile', '?select=id,full_name,role,active&order=full_name.asc'),
            ]);
            const roleByUser = {};
            (urR.ok ? urR.data : []).forEach(u => { roleByUser[u.user_id] = u.role_key; });
            const users = (profR.ok ? profR.data : []).map(u => ({ ...u, manifest_role: roleByUser[u.id] || null }));
            return ok(users);
          }

          default:
            return err('Unknown action: ' + action, 400);
        }
      }

      // ───────────────────────── POST (writes) ─────────────────────────
      if (request.method === 'POST') {
        if (!auth) return err('Unauthorised', 401);
        const body = await request.json();
        const d = body.data || {};

        switch (body.action) {

          // ── Orders ──
          case 'createOrder': {
            if (!canManageOrders(P)) return err('No permission', 403);
            if (!d.category) return err('category required');
            const order_no = await nextSeq('mf_order', 'MF-');
            const row = {
              ...pick(d, ORDER_FIELDS), order_no,
              status: d.status || 'intent',
              created_by: userId, created_by_name: auth.fullName, created_party: party,
            };
            const r = await insert('orders', row);
            if (!r.ok) return err('Order create failed: ' + JSON.stringify(r.data), 502);
            const order = Array.isArray(r.data) ? r.data[0] : r.data;
            const lines = Array.isArray(d.lines) ? d.lines : [];
            if (lines.length) {
              const lineRows = lines.map((l, i) => ({ ...pick(l, LINE_FIELDS), order_id: order.id, line_no: l.line_no || i + 1 }));
              const lr = await insert('order_lines', lineRows, 'return=minimal');
              if (!lr.ok) return err('Order lines failed: ' + JSON.stringify(lr.data), 502);
            }
            await logActivity(auth, 'order_created', { scope: 'order', order_id: order.id, detail: order_no });
            return ok(order);
          }
          case 'updateOrder': {
            if (!canManageOrders(P)) return err('No permission', 403);
            if (!d.id) return err('id required');
            const r = await update('orders', { ...pick(d, ORDER_FIELDS), updated_at: nowISO() }, `id=eq.${encodeURIComponent(d.id)}`);
            if (!r.ok) return err('Update failed: ' + JSON.stringify(r.data), 502);
            await logActivity(auth, 'order_updated', { scope: 'order', order_id: d.id });
            return ok(Array.isArray(r.data) ? r.data[0] : r.data);
          }
          case 'setOrderStatus': {
            if (!canUpdateOrder(P)) return err('No permission', 403);
            if (!d.id || !d.status) return err('id and status required');
            const r = await update('orders', { status: d.status, updated_at: nowISO() }, `id=eq.${encodeURIComponent(d.id)}`);
            if (!r.ok) return err('Status update failed: ' + JSON.stringify(r.data), 502);
            await logActivity(auth, 'order_status', { scope: 'order', order_id: d.id, detail: d.status });
            return ok(Array.isArray(r.data) ? r.data[0] : r.data);
          }
          case 'saveOrderLines': {
            // Replace the order's lines (full set) — LOT edit.
            if (!canManageOrders(P)) return err('No permission', 403);
            if (!d.order_id) return err('order_id required');
            await del('order_lines', `order_id=eq.${encodeURIComponent(d.order_id)}`);
            const lines = Array.isArray(d.lines) ? d.lines : [];
            if (lines.length) {
              const rows = lines.map((l, i) => ({ ...pick(l, LINE_FIELDS), order_id: d.order_id, line_no: l.line_no || i + 1 }));
              const r = await insert('order_lines', rows, 'return=minimal');
              if (!r.ok) return err('Lines save failed: ' + JSON.stringify(r.data), 502);
            }
            await logActivity(auth, 'order_lines_saved', { scope: 'order', order_id: d.order_id });
            return ok({ saved: lines.length });
          }
          case 'deleteOrder': {
            if (!canManageOrders(P)) return err('No permission', 403);
            if (!d.id) return err('id required');
            const oR = await query('orders', `?id=eq.${encodeURIComponent(d.id)}&select=linked_po_number&limit=1`);
            if (oR.ok && oR.data[0]?.linked_po_number) return err('Order is projected to Snorkel — cancel there first', 422);
            const r = await del('orders', `id=eq.${encodeURIComponent(d.id)}`);
            if (!r.ok) return err('Delete failed: ' + JSON.stringify(r.data), 502);
            await logActivity(auth, 'order_deleted', { detail: String(d.id) });
            return ok({ deleted: d.id });
          }

          // ── Shipments + consolidation ──
          case 'createShipment': {
            if (!canManageShipments(P)) return err('No permission', 403);
            const shipment_no = await nextSeq('mf_shipment', 'SHM-');
            const row = { ...pick(d, SHIPMENT_FIELDS), shipment_no, created_by: userId };
            const r = await insert('shipments', row);
            if (!r.ok) return err('Shipment create failed: ' + JSON.stringify(r.data), 502);
            const sh = Array.isArray(r.data) ? r.data[0] : r.data;
            await logActivity(auth, 'shipment_created', { scope: 'shipment', shipment_id: sh.id, detail: shipment_no });
            return ok(sh);
          }
          case 'updateShipment': {
            if (!canManageShipments(P)) return err('No permission', 403);
            if (!d.id) return err('id required');
            const r = await update('shipments', { ...pick(d, SHIPMENT_FIELDS), updated_at: nowISO() }, `id=eq.${encodeURIComponent(d.id)}`);
            if (!r.ok) return err('Update failed: ' + JSON.stringify(r.data), 502);
            await logActivity(auth, 'shipment_updated', { scope: 'shipment', shipment_id: d.id });
            return ok(Array.isArray(r.data) ? r.data[0] : r.data);
          }
          case 'setShipmentLines': {
            // Replace which order lines (+ qty) ride this shipment.
            if (!canManageShipments(P)) return err('No permission', 403);
            if (!d.shipment_id) return err('shipment_id required');
            await del('shipment_lines', `shipment_id=eq.${encodeURIComponent(d.shipment_id)}`);
            const lines = Array.isArray(d.lines) ? d.lines : [];
            if (lines.length) {
              const rows = lines.map(l => ({ shipment_id: d.shipment_id, order_line_id: l.order_line_id, qty_in_shipment: num(l.qty_in_shipment) || 0 }));
              const r = await insert('shipment_lines', rows, 'return=minimal');
              if (!r.ok) return err('Shipment lines failed: ' + JSON.stringify(r.data), 502);
            }
            await logActivity(auth, 'shipment_lines_set', { scope: 'shipment', shipment_id: d.shipment_id });
            return ok({ saved: lines.length });
          }

          // ── Charges (non-goods cost lines) ──
          case 'createCharge': {
            if (!canManageCharges(P)) return err('No permission', 403);
            if (!d.category) return err('category required');
            if (d.is_estimate === false && !canFinalizeCharge(P)) return err('Only LOT finance can post a final (actual) charge', 403);
            const charge_no = await nextSeq('mf_charge', 'CHG-');
            const currency = d.currency || 'INR';
            const amount = num(d.amount) || 0;
            let fx = num(d.fx_rate_used);
            if (currency !== 'INR' && fx == null) fx = await fxForDate(d.incurred_date);
            const amount_inr = currency === 'INR' ? amount : (fx ? +(amount * fx).toFixed(2) : null);
            const row = {
              charge_no, scope: d.scope || 'order', order_id: d.order_id || null, shipment_id: d.shipment_id || null,
              category: d.category, description: d.description || null, amount, currency,
              is_estimate: d.is_estimate !== false, fx_rate_used: fx, amount_inr,
              incurred_date: d.incurred_date || null, source_party: party,
              created_by: userId, created_by_name: auth.fullName,
            };
            const r = await insert('charges', row);
            if (!r.ok) return err('Charge create failed: ' + JSON.stringify(r.data), 502);
            await logActivity(auth, 'charge_created', { scope: 'charge', order_id: d.order_id, shipment_id: d.shipment_id, detail: `${d.category} ${charge_no}` });
            return ok(Array.isArray(r.data) ? r.data[0] : r.data);
          }
          case 'updateCharge': {
            if (!canManageCharges(P)) return err('No permission', 403);
            if (!d.id) return err('id required');
            if (d.is_estimate === false && !canFinalizeCharge(P)) return err('Only LOT finance can finalize a charge', 403);
            const patch = {};
            for (const f of ['scope','order_id','shipment_id','category','description','amount','currency','is_estimate','fx_rate_used','incurred_date']) {
              if (d[f] !== undefined) patch[f] = d[f] === '' ? null : d[f];
            }
            if (patch.amount !== undefined || patch.currency !== undefined || patch.fx_rate_used !== undefined) {
              const cur = await query('charges', `?id=eq.${encodeURIComponent(d.id)}&select=amount,currency,fx_rate_used,incurred_date&limit=1`);
              const c0 = cur.ok ? cur.data[0] : {};
              const currency = patch.currency ?? c0.currency ?? 'INR';
              const amount = num(patch.amount ?? c0.amount) || 0;
              let fx = num(patch.fx_rate_used ?? c0.fx_rate_used);
              if (currency !== 'INR' && fx == null) fx = await fxForDate(patch.incurred_date ?? c0.incurred_date);
              patch.fx_rate_used = fx;
              patch.amount_inr = currency === 'INR' ? amount : (fx ? +(amount * fx).toFixed(2) : null);
            }
            patch.updated_at = nowISO();
            const r = await update('charges', patch, `id=eq.${encodeURIComponent(d.id)}`);
            if (!r.ok) return err('Update failed: ' + JSON.stringify(r.data), 502);
            return ok(Array.isArray(r.data) ? r.data[0] : r.data);
          }
          case 'deleteCharge': {
            if (!canManageCharges(P)) return err('No permission', 403);
            if (!d.id) return err('id required');
            const r = await del('charges', `id=eq.${encodeURIComponent(d.id)}`);
            if (!r.ok) return err('Delete failed: ' + JSON.stringify(r.data), 502);
            return ok({ deleted: d.id });
          }

          // ── Draw-downs (SF raises; LOT moves status) ──
          case 'createDrawdown': {
            if (!canRaiseDrawdown(P)) return err('No permission', 403);
            if (!d.phase) return err('phase required');
            const drawdown_no = await nextSeq('mf_drawdown', 'DD-');
            let estFx = num(d.est_fx_rate);
            if (estFx == null) estFx = await fxForDate(todayISO());
            const row = {
              drawdown_no, phase: d.phase, scope: d.scope || 'general',
              order_id: d.order_id || null, shipment_id: d.shipment_id || null,
              est_amount_inr: num(d.est_amount_inr) || 0, est_fx_rate: estFx,
              requested_by: userId, requested_by_name: auth.fullName, note: d.note || null,
            };
            const r = await insert('drawdowns', row);
            if (!r.ok) return err('Drawdown create failed: ' + JSON.stringify(r.data), 502);
            await logActivity(auth, 'drawdown_raised', { scope: 'drawdown', order_id: d.order_id, detail: drawdown_no });
            return ok(Array.isArray(r.data) ? r.data[0] : r.data);
          }
          case 'setDrawdownStatus': {
            if (!canManageDrawdowns(P)) return err('No permission', 403);
            if (!d.id || !d.status) return err('id and status required');
            const r = await update('drawdowns', { status: d.status, updated_at: nowISO() }, `id=eq.${encodeURIComponent(d.id)}`);
            if (!r.ok) return err('Update failed: ' + JSON.stringify(r.data), 502);
            return ok(Array.isArray(r.data) ? r.data[0] : r.data);
          }

          // ── Payments (LOT → SF, pool credit) ──
          case 'recordPayment': {
            if (!canRecordPayment(P)) return err('No permission', 403);
            const amt = num(d.amount_inr);
            if (!(amt > 0)) return err('amount_inr must be > 0', 422);
            const payment_no = await nextSeq('mf_payment', 'PMT-');
            const row = {
              payment_no, amount_inr: +amt.toFixed(2), paid_date: d.paid_date || todayISO(),
              method: d.method || null, fx_rate_used: num(d.fx_rate_used), drawdown_id: d.drawdown_id || null,
              note: d.note || null, recorded_by: userId, recorded_by_name: auth.fullName,
            };
            const r = await insert('payments', row);
            if (!r.ok) return err('Payment record failed: ' + JSON.stringify(r.data), 502);
            await logActivity(auth, 'payment_recorded', { scope: 'payment', detail: `${payment_no} ₹${amt}` });
            return ok(Array.isArray(r.data) ? r.data[0] : r.data);
          }
          case 'deletePayment': {
            if (!canRecordPayment(P)) return err('No permission', 403);
            if (!d.id) return err('id required');
            const r = await del('payments', `id=eq.${encodeURIComponent(d.id)}`);
            if (!r.ok) return err('Delete failed: ' + JSON.stringify(r.data), 502);
            return ok({ deleted: d.id });
          }

          // ── Vendor payments (SF → vendor, actual-FX cost anchor) ──
          case 'recordVendorPayment': {
            if (!canRecordVendorPay(P)) return err('No permission', 403);
            const rmb = num(d.amount_rmb), inr = num(d.amount_inr_debited);
            if (!(rmb > 0) || !(inr > 0)) return err('amount_rmb and amount_inr_debited must be > 0', 422);
            const vp_no = await nextSeq('mf_vpay', 'VP-');
            const row = {
              vp_no, vendor_code: d.vendor_code || null, vendor_name: d.vendor_name || null,
              order_id: d.order_id || null, amount_rmb: rmb, amount_inr_debited: +inr.toFixed(2),
              actual_bank_rate: +(inr / rmb).toFixed(6), payment_date: d.payment_date || todayISO(),
              recorded_by: userId, recorded_by_name: auth.fullName, note: d.note || null,
            };
            const r = await insert('vendor_payments', row);
            if (!r.ok) return err('Vendor payment failed: ' + JSON.stringify(r.data), 502);
            await logActivity(auth, 'vendor_payment_recorded', { scope: 'vendor_payment', order_id: d.order_id, detail: `${vp_no} ¥${rmb} @ ${(inr / rmb).toFixed(3)}` });
            return ok(Array.isArray(r.data) ? r.data[0] : r.data);
          }
          case 'deleteVendorPayment': {
            if (!canRecordVendorPay(P)) return err('No permission', 403);
            if (!d.id) return err('id required');
            const r = await del('vendor_payments', `id=eq.${encodeURIComponent(d.id)}`);
            if (!r.ok) return err('Delete failed: ' + JSON.stringify(r.data), 502);
            return ok({ deleted: d.id });
          }

          // ── Manual ledger entry (opening balance / reallocation / settlement) ──
          case 'addLedgerEntry': {
            if (!canRecordPayment(P)) return err('No permission', 403);
            if (!d.type || d.amount_inr == null) return err('type and amount_inr required');
            const row = {
              entry_date: d.entry_date || todayISO(), type: d.type, subtype: d.subtype || 'manual',
              amount_inr: num(d.amount_inr), order_id: d.order_id || null, description: d.description || null,
              created_by: userId, created_by_name: auth.fullName,
            };
            const r = await insert('ledger_entries', row);
            if (!r.ok) return err('Ledger entry failed: ' + JSON.stringify(r.data), 502);
            await logActivity(auth, 'ledger_entry', { detail: `${d.type} ${d.amount_inr}` });
            return ok(Array.isArray(r.data) ? r.data[0] : r.data);
          }

          // ── SF invoices ──
          case 'createSfInvoice': {
            if (!canRecordPayment(P) && !canManageCharges(P)) return err('No permission', 403);
            if (!d.invoice_no) return err('invoice_no required');
            const row = {
              invoice_no: d.invoice_no, period: d.period || null, total_inr: num(d.total_inr) || 0,
              status: d.status || 'received', notes: d.notes || null, created_by: userId,
            };
            const r = await insert('sf_invoices', row);
            if (!r.ok) return err('SF invoice failed: ' + JSON.stringify(r.data), 502);
            return ok(Array.isArray(r.data) ? r.data[0] : r.data);
          }

          // ── FX (manual override / on-demand auto refresh) ──
          case 'setManualFxRate': {
            if (!canManageFx(P)) return err('No permission', 403);
            const rate = num(d.rate);
            if (!(rate > 0)) return err('rate must be > 0', 422);
            const row = { base: 'CNY', quote: 'INR', rate, rate_date: d.rate_date || todayISO(), source: 'manual', note: d.note || null };
            const r = await sb('/rest/v1/fx_rates', {
              method: 'POST', body: JSON.stringify(row), prefer: 'return=representation,resolution=merge-duplicates',
            });
            if (!r.ok) return err('FX set failed: ' + JSON.stringify(r.data), 502);
            return ok(Array.isArray(r.data) ? r.data[0] : r.data);
          }
          case 'refreshFxRate': {
            if (!canManageFx(P)) return err('No permission', 403);
            const rate = await fetchAndStoreFxRate();
            return ok({ rate, date: todayISO() });
          }

          // ── Documents (signed upload + record) ──
          case 'createDocumentUploadUrl': {
            if (!canManageDocs(P)) return err('No permission', 403);
            if (!d.file_name) return err('file_name required');
            const scope = d.scope || 'general';
            const path = `${scope}/${safeSeg(d.doc_type || 'other')}/${Date.now()}_${safeSeg(d.file_name)}`;
            const sr = await storageFetch(`/object/upload/sign/${DOC_BUCKET}/${path}`, { method: 'POST' });
            if (!sr.ok || !sr.data?.url) return err('sign_failed: ' + JSON.stringify(sr.data), 502);
            const m = String(sr.data.url).match(/token=([^&]+)/);
            return ok({ storage_path: path, token: m ? decodeURIComponent(m[1]) : null, signed_url: sr.data.url });
          }
          case 'recordDocument': {
            if (!canManageDocs(P)) return err('No permission', 403);
            if (!d.storage_path || !d.doc_type) return err('storage_path and doc_type required');
            const row = {
              scope: d.scope || null, order_id: d.order_id || null, shipment_id: d.shipment_id || null,
              payment_id: d.payment_id || null, drawdown_id: d.drawdown_id || null, charge_id: d.charge_id || null,
              vendor_payment_id: d.vendor_payment_id || null, sf_invoice_id: d.sf_invoice_id || null,
              doc_type: d.doc_type, file_name: d.file_name || null, storage_path: d.storage_path,
              mime_type: d.mime_type || null, uploaded_by: userId, uploaded_by_name: auth.fullName, uploaded_party: party,
            };
            const r = await insert('documents', row);
            if (!r.ok) return err('Doc record failed: ' + JSON.stringify(r.data), 502);
            await logActivity(auth, 'document_added', { scope: 'document', order_id: d.order_id, shipment_id: d.shipment_id, detail: d.doc_type });
            return ok(Array.isArray(r.data) ? r.data[0] : r.data);
          }
          case 'deleteDocument': {
            if (!canManageDocs(P)) return err('No permission', 403);
            if (!d.id) return err('id required');
            const dr = await query('documents', `?id=eq.${encodeURIComponent(d.id)}&select=storage_path&limit=1`);
            const path = dr.ok ? dr.data?.[0]?.storage_path : null;
            const r = await del('documents', `id=eq.${encodeURIComponent(d.id)}`);
            if (!r.ok) return err('Delete failed: ' + JSON.stringify(r.data), 502);
            if (path) { const seg = path.split('/').map(encodeURIComponent).join('/'); await storageFetch(`/object/${DOC_BUCKET}/${seg}`, { method: 'DELETE' }); }
            return ok({ deleted: d.id });
          }

          // ── Snorkel China-PO projection ──
          case 'projectToSnorkel': {
            if (!canProjectSnorkel(P)) return err('No permission', 403);
            if (!d.order_id) return err('order_id required');
            const [oR, lR] = await Promise.all([
              query('orders', `?id=eq.${encodeURIComponent(d.order_id)}&select=*&limit=1`),
              query('order_lines', `?order_id=eq.${encodeURIComponent(d.order_id)}&order=line_no.asc&select=*`),
            ]);
            if (!oR.ok || !oR.data[0]) return err('Order not found', 404);
            const o = oR.data[0];
            const lines = lR.ok ? lR.data : [];
            if (!lines.length) return err('Order has no lines to project', 422);
            const map = CATEGORY_TO_PO[o.category] || CATEGORY_TO_PO.other;

            // Build PO line rows (store.po_lines column contract).
            const poLine = (l, i) => ({
              line_no: l.line_no || i + 1, product: l.product || null, variant: l.variant || null,
              color: l.color || null, item_type: l.item_type || 'Other', description: l.description || null,
              part_code: l.part_code || null, qty_ordered: num(l.qty) || 0, qty_received: 0, unit: l.unit || 'pcs',
              unit_price: num(l.unit_price_rmb), component_type: l.component_type || null,
              receive_format: l.receive_format || null, remote_qty: Math.round(num(l.remote_qty) || 0),
              hsn_code: l.hsn_code || null, gst_percent: num(l.gst_percent),
            });

            let po_number = o.linked_po_number;
            if (po_number) {
              // Re-sync: bump revision, replace lines.
              await sbStore(`/rest/v1/purchase_orders?po_number=eq.${encodeURIComponent(po_number)}`, {
                method: 'PATCH', body: JSON.stringify({
                  vendor_name: o.vendor_name || 'Solve Factory', vendor_code: o.vendor_code || null,
                  order_type: map.order_type, currency: o.currency || 'CNY', notes: o.notes || null, updated_at: nowISO(),
                }), prefer: 'return=minimal',
              });
              await sbStore(`/rest/v1/po_lines?po_number=eq.${encodeURIComponent(po_number)}`, { method: 'DELETE', prefer: 'return=minimal' });
            } else {
              po_number = await nextSeq('po', `CN-${map.code}-`);
              const poRow = {
                po_number, revision: 0, status: 'Soft', source: 'China', order_type: map.order_type,
                vendor_name: o.vendor_name || 'Solve Factory', vendor_code: o.vendor_code || null,
                currency: o.currency || 'CNY', raised_by: 'manifest', raised_by_user_id: userId,
                raised_date: todayISO(), order_placed_date: todayISO(), notes: o.notes || null,
              };
              const pr = await sbStore('/rest/v1/purchase_orders', { method: 'POST', body: JSON.stringify(poRow), prefer: 'return=minimal' });
              if (!pr.ok) return err('PO header create failed: ' + JSON.stringify(pr.data), 502);
            }

            const poLines = lines.map((l, i) => { const r = poLine(l, i); delete r.color_; return { ...r, po_number }; });
            const plr = await sbStore('/rest/v1/po_lines', { method: 'POST', body: JSON.stringify(poLines), prefer: 'return=minimal' });
            if (!plr.ok) return err('PO lines create failed: ' + JSON.stringify(plr.data), 502);

            await update('orders', { linked_po_number: po_number, linked_at: nowISO(),
              status: ['intent','quoted'].includes(o.status) ? 'placed' : o.status, updated_at: nowISO() },
              `id=eq.${encodeURIComponent(o.id)}`);
            await logActivity(auth, 'projected_to_snorkel', { scope: 'order', order_id: o.id, detail: po_number });
            return ok({ po_number, lines: poLines.length });
          }

          // ── Admin ──
          case 'saveRole': {
            if (!canAdmin(P)) return err('No permission', 403);
            if (!d.role_key) return err('role_key required');
            const row = {
              role_key: d.role_key, label: d.label || d.role_key, description: d.description || null,
              party: d.party === 'SF' ? 'SF' : 'LOT', permissions: d.permissions || {},
            };
            const r = await sb('/rest/v1/manifest_roles', {
              method: 'POST', body: JSON.stringify(row), prefer: 'return=representation,resolution=merge-duplicates',
            });
            if (!r.ok) return err('Role save failed: ' + JSON.stringify(r.data), 502);
            return ok(Array.isArray(r.data) ? r.data[0] : r.data);
          }
          case 'setUserRole': {
            if (!canAdmin(P)) return err('No permission', 403);
            if (!d.user_id) return err('user_id required');
            if (d.role_key === null || d.role_key === '') {
              await del('manifest_user_roles', `user_id=eq.${encodeURIComponent(d.user_id)}`);
              return ok({ user_id: d.user_id, role_key: null });
            }
            const r = await sb('/rest/v1/manifest_user_roles', {
              method: 'POST', body: JSON.stringify({ user_id: d.user_id, role_key: d.role_key, assigned_by: userId, assigned_at: nowISO() }),
              prefer: 'return=representation,resolution=merge-duplicates',
            });
            if (!r.ok) return err('Assign failed: ' + JSON.stringify(r.data), 502);
            return ok(Array.isArray(r.data) ? r.data[0] : r.data);
          }
          case 'onboardSfUser': {
            // Create/activate a users_profile row for an external SF owner + assign sf_owner.
            // The auth user must already exist (created when they first request an OTP).
            if (!canAdmin(P)) return err('No permission', 403);
            if (!d.email) return err('email required');
            // auth schema isn't PostgREST-exposed → resolve the auth user via the admin API.
            const adminR = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(d.email)}`, {
              headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
            });
            let authUser = null;
            if (adminR.ok) { const j = await adminR.json(); authUser = (j.users || j)[0] || (Array.isArray(j) ? j[0] : null) || (j.id ? j : null); }
            if (!authUser?.id) return err('No auth user for that email yet — ask them to request a login link first, then retry', 422);
            await sbStore('/rest/v1/users_profile', {
              method: 'POST',
              body: JSON.stringify({ id: authUser.id, full_name: d.full_name || d.email, role: 'sf_partner', active: true }),
              prefer: 'return=minimal,resolution=merge-duplicates',
            });
            await sb('/rest/v1/manifest_user_roles', {
              method: 'POST', body: JSON.stringify({ user_id: authUser.id, role_key: d.role_key || 'sf_owner', assigned_by: userId }),
              prefer: 'return=minimal,resolution=merge-duplicates',
            });
            await logActivity(auth, 'sf_user_onboarded', { detail: d.email });
            return ok({ user_id: authUser.id, email: d.email, role_key: d.role_key || 'sf_owner' });
          }

          default:
            return err('Unknown action: ' + body.action, 400);
        }
      }

      return err('Method not allowed', 405);
    } catch (e) {
      console.error('manifestops error:', e);
      return err('Server error: ' + (e?.message || String(e)), 500);
    }
  },
};
