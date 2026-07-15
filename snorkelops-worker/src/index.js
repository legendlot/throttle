// ============================================================
// SNORKEL OPS — LOT Procurement system Cloudflare Worker
// ------------------------------------------------------------
// Own worker, isolated blast radius. Reads/writes the SAME Supabase `store`
// schema tables as lotopsproxy (no migration) via service_role — POs, vendors,
// forwarders, vendor_supplied_items, company_addresses, reorder_requests,
// hsn_gst_rates — plus the shared masters Snorkel consumes (stock_ledger,
// material_current, bom_*, public.product_master). Handlers are ported verbatim
// from lotopsproxy worker.js so behaviour stays identical at parity.
// ============================================================

const SUPABASE_URL = 'https://jkxcnjabmrkteanzoofj.supabase.co';
const SUPABASE_KEY = 'sb_publishable_1Dd-r3h9Mou2Wqgn6t24Dw_lmWdBtLh'; // publishable (public) — same as lotopsproxy
let SUPABASE_SERVICE_KEY = ''; // loaded from env on each invocation

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, apikey, Authorization',
};

async function logActivity(actor, actorRole, action, entityType, entityId, summary, metadata = {}) {
  try {
    await insert('activity_log', {
      actor, actor_role: actorRole, action,
      entity_type: entityType, entity_id: entityId || null,
      summary, metadata,
    });
  } catch(e) {
    console.error('Activity log failed:', e);
  }
}

// ── Permission gates — SNORKEL-ONLY permission layer (keys in store.snorkel_roles,
//    resolved per-user via store.snorkel_user_roles; NOT the shared store.roles). ──
const canView            = p => !!p.procurement_view;     // see PO/vendor/forwarder workspace
const canRaisePO         = p => !!p.po_create;            // create / amend / cancel POs, status moves
const canManageVendors   = p => !!p.vendor_manage;        // vendors / forwarders / supplied-items
const canManageAddresses = p => !!p.company_address_manage;
const canRaiseChinaPO    = p => !!p.po_china;             // China POs + product registration
const canViewChina       = p => !!p.po_china;             // China financial visibility (strip when false)
const canAcceptPO        = p => !!p.po_request_accept;    // Draft → Accepted (flips linked request → approved)
const canFinalApprove    = p => !!p.po_approve;           // Accepted → Approved (final sign-off)
const canRoutePayment    = p => !!p.payment_route;        // route payment + mark paid
const canSnorkelAdmin    = p => !!p.snorkel_admin;        // manage Snorkel roles / assign users
const canWrite           = p => !!p.procurement_view;     // reorder-request create (any procurement viewer)
const canViewAssets      = p => !!p.asset_view || !!p.asset_manage; // read the asset register
const canManageAssets    = p => !!p.asset_manage;         // create/edit/retire assets + manage cats/locations
// Offline Sales (GT/MT) — own keys; any sales key grants read.
const canSalesView    = p => !!p.sales_view || !!p.sales_order_manage || !!p.sales_order_confirm || !!p.sales_payment_manage || !!p.sales_partner_manage;
const canSalesManage  = p => !!p.sales_order_manage;   // create/edit/cancel draft + generate invoice
const canSalesConfirm = p => !!p.sales_order_confirm;  // confirm → auto-create dispatch shipment
const canSalesPayment = p => !!p.sales_payment_manage; // record/delete collection receipts
const canSalesPartner = p => !!p.sales_partner_manage; // partner master + sales channels
const canSalesCreditNote = p => !!p.sales_credit_note; // raise/edit/issue/cancel credit notes

// Strip financial fields from a China PO read when caller lacks po_china.
function stripChinaPOHeader(row) {
  if (!row) return row;
  const { po_value, currency, payment_terms, invoice_value, invoice_number,
          total_qty_ordered: _t1, total_qty_received: _t2, invoice_mismatch: _m, ...rest } = row;
  return { ...rest, total_qty_ordered: _t1, total_qty_received: _t2 };
}
function stripChinaPOLine(line) {
  if (!line) return line;
  const { unit_price, total_value, ...rest } = line;
  return rest;
}

// Resolve a user's SNORKEL permissions: snorkel_user_roles(user) → role_key →
// snorkel_roles.permissions. Returns {} when the user has no Snorkel role (they can
// still file requests — request creation needs no permission key).
async function getSnorkelPerms(userId) {
  const ur = await sb(`/rest/v1/snorkel_user_roles?user_id=eq.${userId}&select=role_key&limit=1`);
  if (!ur.ok || !ur.data[0]) return { __role: null, perms: {} };
  const roleKey = ur.data[0].role_key;
  const r = await sb(`/rest/v1/snorkel_roles?role_key=eq.${encodeURIComponent(roleKey)}&select=permissions&limit=1`);
  return { __role: roleKey, perms: (r.ok && r.data[0]?.permissions) || {} };
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
  const profileRes = await sb(`/rest/v1/users_profile?id=eq.${user.id}&select=role,full_name,must_change_password,active&limit=1`);
  if (!profileRes.ok || !profileRes.data[0]) return null;
  const profile = profileRes.data[0];
  if (!profile.active) return null;
  // Snorkel permissions come from the Snorkel-only layer, NOT the user's global role.
  const sp = await getSnorkelPerms(user.id);
  return {
    userId: user.id, email: user.email, role: profile.role,
    fullName: profile.full_name, mustChangePwd: profile.must_change_password,
    snorkelRole: sp.__role,
    permissions: sp.perms,
  };
}

const COUNTRY_ISO = {
  'China':'CN','India':'IN','USA':'US','Germany':'DE','Taiwan':'TW',
  'Vietnam':'VN','Bangladesh':'BD','Japan':'JP','South Korea':'KR',
  'UK':'GB','Italy':'IT','Turkey':'TR','Other':'XX',
};
function countryToISO(country) { return COUNTRY_ISO[country] || 'XX'; }

// ── Store schema helper ────────────────────────────────────────
// NOTE: service-role calls send the secret key as BOTH apikey and Authorization.
// This is the canonical modern pattern and works with new `sb_secret_…` keys
// (which are NOT JWTs, so they can't grant service_role via Bearer alone — the
// gateway resolves the role from the apikey header). Only the auth endpoint in
// verifyJWT uses the publishable key + the user's JWT.
async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type':   'application/json',
      'apikey':         SUPABASE_SERVICE_KEY,
      'Authorization':  `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Accept-Profile': 'store',
      'Content-Profile':'store',
      'Prefer':         opts.prefer || '',
      ...opts.headers,
    },
  });
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
  catch(e) { return { ok: res.ok, status: res.status, data: text }; }
}

// ── Public schema helper ───────────────────────────────────────
async function sbPublic(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Prefer':        opts.prefer || '',
      ...opts.headers,
    },
  });
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
  catch(e) { return { ok: res.ok, status: res.status, data: text }; }
}

async function query(table, params = '') {
  return sb(`/rest/v1/${table}${params}`);
}
async function queryPublic(table, params = '') {
  return sbPublic(`/rest/v1/${table}${params}`);
}
async function insert(table, body, single = false) {
  return sb(`/rest/v1/${table}`, {
    method: 'POST', body: JSON.stringify(body),
    prefer: single ? 'return=representation,resolution=merge-duplicates' : 'return=representation',
  });
}
async function update(table, body, filter) {
  return sb(`/rest/v1/${table}?${filter}`, {
    method: 'PATCH', body: JSON.stringify(body), prefer: 'return=representation',
  });
}
async function rpc(fn, body) {
  return sb(`/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(body) });
}
// Address master: flip a mutually-exclusive flag so exactly one row holds it.
async function setExclusiveAddressFlag(flag, id) {
  await update('company_addresses', { [flag]: false }, `${flag}=eq.true`);
  return update('company_addresses', { [flag]: true, updated_at: new Date().toISOString() }, `id=eq.${id}`);
}

async function nextSeq(name, prefix) {
  const r = await rpc('next_seq', { seq_name: name });
  if (!r.ok) throw new Error('Sequence error: ' + JSON.stringify(r.data));
  return prefix + String(r.data).padStart(3, '0');
}

// ── Offline Sales helpers ──────────────────────────────────────
// Pad-4 code minter (SP-/SO-). next_seq is UPDATE-only; rows seeded in migration.
async function nextSeq4(name, prefix) {
  const r = await rpc('next_seq', { seq_name: name });
  if (!r.ok || r.data == null) throw new Error('Sequence error: ' + JSON.stringify(r.data));
  return prefix + String(r.data).padStart(4, '0');
}
// Indian FY label: 2026-04..2027-03 → "26-27".
function fyLabel(dateISO) {
  const d = new Date(dateISO + 'T00:00:00Z');
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  const start = m >= 4 ? y : y - 1;
  return String(start % 100).padStart(2, '0') + '-' + String((start + 1) % 100).padStart(2, '0');
}
// GST-continuous invoice no per FY: LOT/SL/<fy>/NNNN. Lazily creates the seq row
// (plain insert, ignore conflict — never merge-duplicates, which would zero an existing counter).
async function nextInvoiceNo(dateISO) {
  const fy = fyLabel(dateISO);
  const key = 'sales_invoice_' + fy;
  await sb('/rest/v1/sequences', {
    method: 'POST', body: JSON.stringify({ name: key, current_val: 0 }),
    prefer: 'return=minimal',
  }); // 409 on existing row is fine — we ignore it and increment below.
  const r = await rpc('next_seq', { seq_name: key });
  if (!r.ok || r.data == null) throw new Error('Invoice seq error: ' + JSON.stringify(r.data));
  return `LOT/SL/${fy}/${String(r.data).padStart(4, '0')}`;
}
// GST-continuous credit-note no per FY: LOT/CN/<fy>/NNNN (same lazy-seq pattern as nextInvoiceNo).
async function nextCreditNoteNo(dateISO) {
  const fy = fyLabel(dateISO);
  const key = 'sales_credit_note_' + fy;
  await sb('/rest/v1/sequences', {
    method: 'POST', body: JSON.stringify({ name: key, current_val: 0 }), prefer: 'return=minimal',
  });
  const r = await rpc('next_seq', { seq_name: key });
  if (!r.ok || r.data == null) throw new Error('Credit-note seq error: ' + JSON.stringify(r.data));
  return `LOT/CN/${fy}/${String(r.data).padStart(4, '0')}`;
}
// Roll up ISSUED credit notes onto the order, then net the payment status.
async function recomputeOrderCredit(orderId) {
  const [oR, cR, pR] = await Promise.all([
    query('sales_orders', `?id=eq.${encodeURIComponent(orderId)}&select=grand_total&limit=1`),
    query('sales_credit_notes', `?order_id=eq.${encodeURIComponent(orderId)}&status=eq.issued&select=grand_total`),
    query('sales_payments', `?order_id=eq.${encodeURIComponent(orderId)}&select=amount`),
  ]);
  const grand  = oR.ok ? Number(oR.data?.[0]?.grand_total) || 0 : 0;
  const credit = cR.ok ? (cR.data || []).reduce((s, c) => s + (Number(c.grand_total) || 0), 0) : 0;
  const recv   = pR.ok ? (pR.data || []).reduce((s, p) => s + (Number(p.amount) || 0), 0) : 0;
  const net    = +(grand - credit).toFixed(2);
  const status = (recv > 0 && recv >= net - 0.005) ? 'paid' : recv > 0 ? 'partial' : 'unpaid';
  await update('sales_orders',
    { credit_total: +credit.toFixed(2), amount_received: +recv.toFixed(2),
      payment_status: status, updated_at: new Date().toISOString() },
    `id=eq.${encodeURIComponent(orderId)}`);
}
// Per-line GST split for intra vs inter (same logic getSalesInvoiceData uses).
function splitGstLine(l, intra) {
  const gstAmt = Number(l.gst_amount) || 0, gstPct = Number(l.gst_pct) || 0;
  return { ...l,
    cgst_pct: intra ? gstPct / 2 : 0, sgst_pct: intra ? gstPct / 2 : 0, igst_pct: intra ? 0 : gstPct,
    cgst_amount: intra ? +(gstAmt / 2).toFixed(2) : 0,
    sgst_amount: intra ? +(gstAmt / 2).toFixed(2) : 0,
    igst_amount: intra ? 0 : +gstAmt.toFixed(2) };
}
// Build CN header totals + line rows from incoming lines (reuses computeSalesLine math).
function buildCreditNote(linesIn) {
  const lines = (linesIn || []).map(computeSalesLine);
  const subtotal    = +lines.reduce((s, l) => s + l.taxable_value, 0).toFixed(2);
  const tax_total   = +lines.reduce((s, l) => s + l.gst_amount, 0).toFixed(2);
  const grand_total = +(subtotal + tax_total).toFixed(2);
  return { lines, subtotal, tax_total, grand_total };
}
// Cap check: existing (draft+issued, optionally excluding self) credit + this ≤ invoice grand_total.
async function creditCapRemaining(orderId, excludeCnId) {
  const oR = await query('sales_orders', `?id=eq.${encodeURIComponent(orderId)}&select=grand_total&limit=1`);
  const grand = oR.ok ? Number(oR.data?.[0]?.grand_total) || 0 : 0;
  const cR = await query('sales_credit_notes', `?order_id=eq.${encodeURIComponent(orderId)}&status=in.(draft,issued)&select=grand_total`);
  let used = cR.ok ? (cR.data || []).reduce((s, c) => s + (Number(c.grand_total) || 0), 0) : 0;
  if (excludeCnId) {
    const selfR = await query('sales_credit_notes', `?id=eq.${encodeURIComponent(excludeCnId)}&select=grand_total,status&limit=1`);
    const self = selfR.ok ? selfR.data?.[0] : null;
    if (self && ['draft','issued'].includes(self.status)) used -= Number(self.grand_total) || 0;
  }
  return +(grand - used).toFixed(2);
}
// Line math (PostgREST returns numerics as strings → Number()).
function computeSalesLine(l) {
  const qty  = Math.round(Number(l.qty) || 0);
  const rate = Number(l.rate) || 0;
  const disc = Number(l.discount_pct) || 0;
  const gst  = Number(l.gst_pct) || 0;
  const taxable = +(qty * rate * (1 - disc / 100)).toFixed(2);
  const gstAmt  = +(taxable * gst / 100).toFixed(2);
  return {
    product: l.product || null, model: l.model || null, color: l.color || null,
    sku: l.sku || null, hsn_code: l.hsn_code || null, description: l.description || null,
    qty, rate, discount_pct: disc, gst_pct: gst,
    taxable_value: taxable, gst_amount: gstAmt, line_total: +(taxable + gstAmt).toFixed(2),
    sort_order: Math.round(Number(l.sort_order) || 0),
  };
}
// Map shipment.status → sales-facing fulfilment label.
function fulfilmentFromShipment(sh) {
  if (!sh) return 'not_dispatched';
  if (sh.status === 'shipped')   return 'fulfilled';
  if (sh.status === 'cancelled') return 'cancelled';
  if (sh.status === 'packing' || sh.status === 'ready') return 'in_progress';
  return 'pending'; // draft
}
function addDays(dateISO, days) {
  if (!dateISO) return null;
  const d = new Date(dateISO + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + (days || 0));
  return d.toISOString().split('T')[0];
}
// Attach payment/due fields to an order given its fulfilment anchor (latest-shipped child).
// Fulfilment status itself comes from deriveFulfilment() (request-based) — merged by the read handlers.
function decorateSalesOrder(o, anchor) {
  const a = anchor || { dispatch_date: null, delivery_date: null, anchor_date: null };
  const due_date = addDays(a.anchor_date, Number(o.credit_days) || 0);
  const net_due = +(Number(o.grand_total) - (Number(o.credit_total) || 0)).toFixed(2);
  const balance = +(net_due - Number(o.amount_received)).toFixed(2);
  const overdue = balance > 0.005 && !!due_date && due_date < todayISO();
  return { ...o, dispatch_date: a.dispatch_date, delivery_date: a.delivery_date, due_date, net_due, balance, overdue };
}

// ── Fulfilment (request → shipments) — derived, read-only (RULE-SNORKEL-004 #4 extended) ──
// Latest-shipped child anchors the order's due-date + list dispatch/delivery display.
function fulfilmentAnchor(shipments) {
  const shipped = (shipments || []).filter(s => s.status === 'shipped');
  if (!shipped.length) return { dispatch_date: null, delivery_date: null, anchor_date: null };
  const keyed = shipped.map(s => {
    const disp = s.shipped_at ? String(s.shipped_at).slice(0, 10) : null;
    return { disp, deliv: s.delivery_date || null, k: s.delivery_date || disp || '0000-00-00' };
  }).sort((x, y) => String(x.k).localeCompare(String(y.k)));
  const last = keyed[keyed.length - 1];
  return { dispatch_date: last.disp, delivery_date: last.deliv, anchor_date: last.deliv || last.disp };
}
// Derived fulfilment status for one order from its request + child shipments.
function deriveFulfilment(request, shipments) {
  if (!request) return { fulfilment_status: 'not_submitted', shipped_units: 0, requested_units: 0 };
  const requested_units = Math.round(Number(request.requested_units)) || 0;
  if (request.status === 'rejected')  return { fulfilment_status: 'rejected', shipped_units: 0, requested_units };
  if (request.status === 'cancelled') return { fulfilment_status: 'cancelled', shipped_units: 0, requested_units };
  if (request.status === 'pending')   return { fulfilment_status: 'awaiting_acceptance', shipped_units: 0, requested_units };
  const live = (shipments || []).filter(s => s.status !== 'cancelled');
  const open = live.filter(s => s.status !== 'shipped');
  const shipped_units = live.filter(s => s.status === 'shipped').reduce((sum, s) => sum + (s._shipped_units || 0), 0);
  if (open.length) return { fulfilment_status: 'in_fulfilment', shipped_units, requested_units };
  if (shipped_units === 0) return { fulfilment_status: 'not_fulfilled', shipped_units, requested_units };
  return { fulfilment_status: shipped_units >= requested_units ? 'fully_fulfilled' : 'partially_fulfilled', shipped_units, requested_units };
}
// Batched loader: orders[] → { [sales_order_id]: { request, shipments:[{...,_shipped_units}], legacyShipment } }.
// New orders link via a fulfilment request; legacy (pre-cutover) orders link via the single
// sales_orders.dispatch_shipment_id — both paths resolved here so historical orders keep their dates/status.
async function loadFulfilment(orders) {
  const list = (orders || []).filter(Boolean);
  if (!list.length) return {};
  const ids = [...new Set(list.map(o => o.id).filter(Boolean))];
  const reqR = await queryPublic('dispatch_fulfilment_requests',
    `?sales_order_id=in.(${ids.map(encodeURIComponent).join(',')})&select=*`);
  const requests = reqR.ok ? reqR.data : [];
  const reqByOrder = {}; requests.forEach(r => { reqByOrder[r.sales_order_id] = r; });
  const reqIds = requests.map(r => r.id);
  let shipments = [];
  if (reqIds.length) {
    const shR = await queryPublic('dispatch_shipments',
      `?fulfilment_request_id=in.(${reqIds.map(encodeURIComponent).join(',')})&select=id,shipment_no,status,scheduled_date,shipped_at,delivery_date,expected_delivery_date,courier_partner,tracking_number,tracking_link,tracking_status,tracking_stage_label,tracking_checkpoints,tracking_synced_at,fulfilment_request_id`);
    shipments = shR.ok ? shR.data : [];
    const shIds = shipments.map(s => s.id);
    if (shIds.length) {
      const lnR = await queryPublic('dispatch_shipment_lines',
        `?shipment_id=in.(${shIds.map(encodeURIComponent).join(',')})&select=shipment_id,target_qty`);
      const byShip = {};
      (lnR.ok ? lnR.data : []).forEach(l => { byShip[l.shipment_id] = (byShip[l.shipment_id] || 0) + (Math.round(Number(l.target_qty)) || 0); });
      shipments.forEach(s => { s._shipped_units = byShip[s.id] || 0; });
    }
  }
  // Legacy fallback: orders with no request but a linked single shipment (pre-cutover GT/MT).
  const legacyIds = [...new Set(list.filter(o => !reqByOrder[o.id] && o.dispatch_shipment_id).map(o => o.dispatch_shipment_id))];
  const legacyMap = {};
  if (legacyIds.length) {
    const lsR = await queryPublic('dispatch_shipments',
      `?id=in.(${legacyIds.map(encodeURIComponent).join(',')})&select=id,shipment_no,status,shipped_at,delivery_date`);
    (lsR.ok ? lsR.data : []).forEach(s => { legacyMap[s.id] = s; });
  }
  const out = {};
  list.forEach(o => {
    const request = reqByOrder[o.id] || null;
    out[o.id] = request
      ? { request, shipments: shipments.filter(s => s.fulfilment_request_id === request.id), legacyShipment: null }
      : { request: null, shipments: [], legacyShipment: o.dispatch_shipment_id ? (legacyMap[o.dispatch_shipment_id] || null) : null };
  });
  return out;
}
// Resolve derived fulfilment + due-date anchor for one order (request path, legacy path, or none).
function resolveFulfilment(f) {
  if (f?.request) return { der: deriveFulfilment(f.request, f.shipments), anchor: fulfilmentAnchor(f.shipments) };
  if (f?.legacyShipment) {
    const sh = f.legacyShipment;
    const disp = sh.shipped_at ? String(sh.shipped_at).slice(0, 10) : null;
    return {
      der: { fulfilment_status: fulfilmentFromShipment(sh), shipped_units: 0, requested_units: 0 },
      anchor: { dispatch_date: disp, delivery_date: sh.delivery_date || null, anchor_date: sh.delivery_date || disp || null },
    };
  }
  return { der: { fulfilment_status: 'not_submitted', shipped_units: 0, requested_units: 0 }, anchor: null };
}
// Reconcile reject→cancel: snorkelops is the only writer of sales_orders.status.
async function reconcileRejections(list) {
  for (const { o, reason } of (list || [])) {
    const now = new Date().toISOString();
    await update('sales_orders',
      { status: 'cancelled', cancelled_at: now, cancel_reason: 'Fulfilment rejected: ' + (reason || ''), updated_at: now },
      `id=eq.${encodeURIComponent(o.id)}`);
  }
}
// Writable partner columns (code/id/audit excluded). Used by create + update.
const SALES_PARTNER_FIELDS = ['name','channel_key','partner_type','gstin','state','city','pincode',
  'billing_address','shipping_address','contact_person','phone','email','default_credit_days','is_active','notes'];
function normSalesPartner(field, v) {
  if (field === 'default_credit_days') { const n = Math.round(Number(v)); return Number.isNaN(n) ? 45 : n; }
  if (field === 'is_active') return v !== false;
  if (v === '' || v === undefined) return null;
  return v;
}
// Recompute an order's amount_received + payment_status from its receipts.
async function recomputeSalesPayment(orderId) {
  const [oR, pR] = await Promise.all([
    query('sales_orders', `?id=eq.${encodeURIComponent(orderId)}&select=grand_total,credit_total&limit=1`),
    query('sales_payments', `?order_id=eq.${encodeURIComponent(orderId)}&select=amount`),
  ]);
  const grand  = oR.ok ? Number(oR.data?.[0]?.grand_total) || 0 : 0;
  const credit = oR.ok ? Number(oR.data?.[0]?.credit_total) || 0 : 0;
  const net    = +(grand - credit).toFixed(2);
  const recv   = pR.ok ? (pR.data || []).reduce((s, p) => s + (Number(p.amount) || 0), 0) : 0;
  const status = (recv > 0 && recv >= net - 0.005) ? 'paid' : recv > 0 ? 'partial' : 'unpaid';
  await update('sales_orders',
    { amount_received: +recv.toFixed(2), payment_status: status, updated_at: new Date().toISOString() },
    `id=eq.${encodeURIComponent(orderId)}`);
}

// ── Storage REST (private bucket snorkel-asset-docs). service_role only. ──
// Same auth posture as sb(): the sb_secret key sent as apikey + Bearer.
const ASSET_BUCKET = 'snorkel-asset-docs';
async function storageFetch(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1${path}`, {
    ...opts,
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}
function assetSafeSeg(s) { return String(s || '').replace(/[^\w.\-]+/g, '_'); }

// Append an asset_history row (best-effort; never blocks the main mutation).
async function logAssetHistory(assetId, eventType, fromVal, toVal, note, auth) {
  try {
    await insert('asset_history', {
      asset_id: assetId, event_type: eventType,
      from_value: fromVal != null ? String(fromVal) : null,
      to_value:   toVal   != null ? String(toVal)   : null,
      note: note || null,
      changed_by: auth?.userId || null, changed_by_name: auth?.fullName || null,
    });
  } catch (e) { console.error('asset_history log failed:', e); }
}

// Writable asset columns (code/id/audit excluded). Used by create + update.
const ASSET_WRITE_FIELDS = [
  'name','description','category_id','status','acquisition_type','location_id',
  'custodian_user_id','custodian_name','serial_no','model_no','secondary_ref',
  'vendor_code','vendor_name','source_po_number','purchase_cost','currency',
  'acquired_date','rental_cost','rental_period','rental_start_date','rental_end_date',
  'warranty_expiry','amc_renewal',
];
const ASSET_INT_FIELDS = new Set(['category_id','location_id']);
const ASSET_NUM_FIELDS = new Set(['purchase_cost','rental_cost']);
// Coerce empty strings to NULL (date/uuid/numeric cols reject ''), numbers to numbers.
function normAsset(field, v) {
  if (v === '' || v === null || v === undefined) return null;
  if (ASSET_INT_FIELDS.has(field)) { const n = Math.round(Number(v)); return Number.isNaN(n) ? null : n; }
  if (ASSET_NUM_FIELDS.has(field)) { const n = Number(v); return Number.isNaN(n) ? null : n; }
  return v;
}

function todayISO() { return new Date().toISOString().split('T')[0]; }
function ok(data, status = 200) {
  return new Response(JSON.stringify({ ok: true, data }),
    { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
function err(msg, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: msg }),
    { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

export default {
  async fetch(request, env) {
    SUPABASE_SERVICE_KEY = env.SUPABASE_SERVICE_KEY || '';
    if (request.method === 'OPTIONS')
      return new Response(null, { headers: CORS });

    const url    = new URL(request.url);
    const action = url.searchParams.get('action');

    const authResult = await verifyJWT(request.headers.get('Authorization'));
    const role   = authResult?.role   || null;
    const userId = authResult?.userId || null;
    const P      = authResult?.permissions || {};

    try {
      if (request.method === 'GET') {
        if (!role) return err('Unauthorised', 401);

        switch (action) {

          // ── Session identity (AuthProvider pingAction="getMe") ──
          case 'getMe':
          case 'ping':
            return ok({
              id: userId, userId, email: authResult.email,
              role, full_name: authResult.fullName, fullName: authResult.fullName,
              must_change_password: authResult.mustChangePwd,
              permissions: authResult.permissions,
            });

          // ── Shared masters Snorkel consumes (owned by Garage/Redline) ──
          case 'getStock': {
            const [stockR, mmR, bomR] = await Promise.all([
              query('stock_ledger', '?order=product.asc,part_code.asc&select=*'),
              query('material_current', '?select=part_code,part_name,part_category,part_type'),
              query('bom_register', '?is_active=eq.true&select=part_code,part_name,part_category,part_type'),
            ]);
            if (!stockR.ok) return err(stockR.data);
            const matMap = {};
            if (mmR.ok) mmR.data.forEach(r => {
              matMap[r.part_code] = {
                part_name: r.part_name || null,
                part_type: r.part_type || null,
                category:  r.part_category || null,
              };
            });
            if (bomR.ok) bomR.data.forEach(r => {
              if (!matMap[r.part_code]) {
                matMap[r.part_code] = {
                  part_name: r.part_name || null,
                  part_type: r.part_type || null,
                  category:  r.part_category || null,
                };
              }
            });
            const merged = stockR.data.map(r => ({
              ...r,
              part_name: matMap[r.part_code]?.part_name || r.part_name,
              part_type: matMap[r.part_code]?.part_type ?? null,
              category:  matMap[r.part_code]?.category  ?? null,
            }));
            return ok(role === 'store' ? merged.map(({ unit_cost, ...rest }) => rest) : merged);
          }

          case 'getMaterials': {
            const r = await query('material_current', '?order=product.asc,part_code.asc&select=*');
            if (!r.ok) return err(r.data);
            return ok(role === 'store' ? r.data.map(({ unit_cost, ...rest }) => rest) : r.data);
          }

          // ── Mould master (Snorkel mould procurement): order-by-mould / receive-by-part ──
          case 'getMoulds': {
            if (!canView(P)) return err('No permission', 403);
            const r = await query('moulds', '?order=mould_no.asc');
            if (!r.ok) return err(r.data);
            const cR = await query('mould_parts', '?select=mould_no');
            const counts = {};
            if (cR.ok) for (const x of cR.data) counts[x.mould_no] = (counts[x.mould_no] || 0) + 1;
            return ok(r.data.map(m => ({ ...m, parts_count: counts[m.mould_no] || 0 })));
          }

          case 'getMould': {
            if (!canView(P)) return err('No permission', 403);
            const mn = url.searchParams.get('mould_no');
            if (!mn) return err('mould_no required');
            const [mR, pR] = await Promise.all([
              query('moulds', `?mould_no=eq.${encodeURIComponent(mn)}&limit=1`),
              query('mould_parts', `?mould_no=eq.${encodeURIComponent(mn)}&select=id,part_code,qty_per_shot&order=part_code.asc`),
            ]);
            if (!mR.ok || !mR.data[0]) return err('Mould not found', 404);
            const parts = pR.ok ? pR.data : [];
            const codes = [...new Set(parts.map(x => x.part_code))];
            const names = {};
            if (codes.length) {
              const mmR = await query('material_current',
                `?part_code=in.(${codes.map(c => `"${c}"`).join(',')})&select=part_code,part_name`);
              if (mmR.ok) for (const x of mmR.data) names[x.part_code] = x.part_name;
            }
            return ok({ ...mR.data[0], parts: parts.map(x => ({ ...x, part_name: names[x.part_code] || x.part_code })) });
          }

          case 'getBOM': {
            const product = url.searchParams.get('product');
            if (!product) return err('product required');
            const r = await query('bom_current',
              `?product=eq.${encodeURIComponent(product)}&order=common_variant.asc,variant_model.asc`);
            if (!r.ok) return err(r.data);
            const partCodes = [...new Set((r.data || []).map(b => b.part_code).filter(Boolean))];
            const hsnMap = {}, imgMap = {};
            if (partCodes.length) {
              const inList = partCodes.map(encodeURIComponent).join(',');
              const [hsnR, imgR] = await Promise.all([
                query('bom_register',    `?part_code=in.(${inList})&select=part_code,hsn_code`),
                query('material_master', `?part_code=in.(${inList})&select=part_code,image_url`),
              ]);
              if (hsnR.ok) for (const row of hsnR.data) if (row.hsn_code)  hsnMap[row.part_code] = row.hsn_code;
              if (imgR.ok) for (const row of imgR.data) if (row.image_url) imgMap[row.part_code] = row.image_url;
            }
            return ok((r.data || []).map(row => ({
              ...row,
              hsn_code:  hsnMap[row.part_code] || null,
              image_url: imgMap[row.part_code] || null,
            })));
          }

          case 'getProductCatalogue': {
            const metaR = await queryPublic('product_master',
              '?is_active=eq.true&component_type=not.in.(remote)&select=product,model,color,has_remote,receive_format&order=product.asc,model.asc,color.asc&limit=5000');
            if (!metaR.ok) return err('product_master fetch failed: ' + JSON.stringify(metaR.data));
            const variantSets   = {};
            const hasRemote     = {};
            const colorsMap     = {};
            const receiveFormat = {};
            for (const row of (metaR.data || [])) {
              if (!row.model) continue;
              if (!variantSets[row.product]) variantSets[row.product] = new Set();
              variantSets[row.product].add(row.model);
              hasRemote[row.product] = row.has_remote === true;
              if (!receiveFormat[row.product] && row.receive_format) {
                receiveFormat[row.product] = row.receive_format;
              }
              if (row.color) {
                if (!colorsMap[row.product]) colorsMap[row.product] = {};
                if (!colorsMap[row.product][row.model]) colorsMap[row.product][row.model] = [];
                colorsMap[row.product][row.model].push(row.color);
              }
            }
            const variantMap = {};
            for (const [product, modelSet] of Object.entries(variantSets)) {
              variantMap[product] = [...modelSet].sort();
            }
            const products = Object.keys(variantMap).sort();
            return ok({ products, variants: variantMap, has_remote: hasRemote, colors: colorsMap, receive_format: receiveFormat });
          }

          case 'getProductFamilies': {
            if (!canRaiseChinaPO(P)) return err('Restricted', 403);
            const r = await queryPublic('product_master',
              `?is_active=eq.true&select=product,model,color,product_code,component_type,has_remote,receive_format&order=product.asc,model.asc,color.asc`);
            if (!r.ok) return err('Failed to fetch product families: ' + JSON.stringify(r.data));
            const grouped = {};
            (r.data || []).forEach(row => {
              const fam = row.product;
              if (!grouped[fam]) grouped[fam] = { product: fam, variants: [], has_remote: false };
              if (row.component_type === 'remote') {
                grouped[fam].remote = row;
              } else {
                grouped[fam].variants.push(row);
              }
              if (row.has_remote) grouped[fam].has_remote = true;
            });
            return ok(Object.values(grouped));
          }

          case 'getEanPoolStatus': {
            if (!canRaiseChinaPO(P)) return err('Restricted', 403);
            const avail = await sbPublic(`/rest/v1/ean_pool?status=eq.available&select=ean`, {
              headers: { 'Prefer': 'count=exact' }
            });
            const recent = await queryPublic('ean_pool',
              `?status=eq.assigned&order=assigned_at.desc&limit=20&select=ean,assigned_product_code,assigned_at`);
            return ok({
              available_count: Array.isArray(avail.data) ? avail.data.length : 0,
              recent_assignments: recent.ok ? (recent.data || []) : [],
            });
          }

          case 'getPendingInward': {
            const r = await query('po_pending_inward', '?limit=50');
            if (!r.ok) return err(r.data);
            return ok(r.data);
          }

          // ── Procurement domain reads ──
          case 'getProcurementParts': {
            const r = await query('bom_register',
              `?is_active=eq.true&select=part_code,part_name,part_category,issue_uom,hsn_code&order=part_code.asc`);
            if (!r.ok) return err(r.data);
            const seen = new Map();
            for (const row of r.data) seen.set(row.part_code, row);
            return ok([...seen.values()]);
          }

          case 'getHsnRates': {
            const r = await query('hsn_gst_rates',
              `?select=hsn_code,description,gst_percent&order=hsn_code.asc`);
            if (!r.ok) return err(r.data);
            return ok(r.data);
          }

          case 'getForwarders': {
            const r = await query('forwarders', `?active=eq.true&order=company_name.asc`);
            if (!r.ok) return err(r.data);
            return ok(r.data);
          }

          case 'getForwarder': {
            const code = url.searchParams.get('forwarder_code');
            if (!code) return err('forwarder_code required');
            const r = await query('forwarders', `?forwarder_code=eq.${encodeURIComponent(code)}&limit=1`);
            if (!r.ok || !r.data[0]) return err('Forwarder not found');
            return ok(r.data[0]);
          }

          case 'getVendors': {
            const active = url.searchParams.get('active') || 'true';
            const country = url.searchParams.get('source_country') || '';
            const countryNot = url.searchParams.get('source_country_not') || '';
            let filter = `?active=eq.${active}&order=vendor_name.asc`;
            if (country) filter += `&source_country=eq.${encodeURIComponent(country)}`;
            if (countryNot) filter += `&source_country=neq.${encodeURIComponent(countryNot)}`;
            const r = await query('vendors', filter);
            if (!r.ok) return err(r.data);
            return ok(r.data);
          }

          case 'getVendor': {
            const id = url.searchParams.get('vendor_code');
            if (!id) return err('vendor_code required');
            const r = await query('vendors', `?vendor_code=eq.${encodeURIComponent(id)}&limit=1`);
            if (!r.ok || !r.data[0]) return err('Vendor not found');
            return ok(r.data[0]);
          }

          case 'getCompanyAddresses': {
            const r = await query('company_addresses', `?active=eq.true&order=id.asc`);
            if (!r.ok) return err('Failed to fetch company addresses: ' + JSON.stringify(r.data));
            return ok(r.data);
          }

          case 'listCompanyAddresses': {
            if (!canManageAddresses(P)) return err('Forbidden', 403);
            const r = await query('company_addresses', `?order=id.asc`);
            if (!r.ok) return err('Failed to fetch company addresses: ' + JSON.stringify(r.data));
            return ok(r.data);
          }

          case 'getVendorSuppliedItems': {
            const vendorCode = url.searchParams.get('vendor_code');
            if (!vendorCode) return err('vendor_code required');
            const r = await query('vendor_supplied_items',
              `?vendor_code=eq.${encodeURIComponent(vendorCode)}&order=po_category.asc,product.asc`);
            if (!r.ok) return err('Fetch failed');
            return ok(r.data || []);
          }

          case 'getVendorsForProduct': {
            const cat      = url.searchParams.get('po_category') || '';
            const product  = url.searchParams.get('product')     || '';
            const partCode = url.searchParams.get('part_code')   || '';
            if (!cat) return err('po_category required');
            const conditions = [`supply_type.eq.category,reference.eq.${encodeURIComponent(cat)}`];
            if (product)  conditions.push(`supply_type.eq.product,reference.eq.${encodeURIComponent(product)}`);
            if (partCode) conditions.push(`supply_type.eq.part,reference.eq.${encodeURIComponent(partCode)}`);
            const siR = await query('vendor_supplied_items',
              `?or=(${conditions.map(c => `and(${c})`).join(',')})&select=vendor_code`);
            if (!siR.ok || !siR.data.length) return ok([]);
            const codes = [...new Set(siR.data.map(i => i.vendor_code))];
            const inF   = codes.map(c => `vendor_code.eq.${encodeURIComponent(c)}`).join(',');
            const vR = await query('vendors',
              `?or=(${inF})&active=eq.true&select=vendor_code,vendor_name,source_country,currency,payment_terms,lead_time_days`);
            return ok(vR.ok ? (vR.data || []) : []);
          }

          case 'getPOs': {
            const status = url.searchParams.get('status')     || '';
            const source = url.searchParams.get('source')     || '';
            const type   = url.searchParams.get('order_type') || '';
            let filter = '?order=created_at.desc&limit=500';
            if (status) filter += `&status=eq.${encodeURIComponent(status)}`;
            if (source) filter += `&source=eq.${encodeURIComponent(source)}`;
            if (type)   filter += `&order_type=eq.${encodeURIComponent(type)}`;
            const r = await query('po_summary', filter);
            if (!r.ok) return err(r.data);
            const canChina = canViewChina(P);
            const filteredRows = (r.data || []).filter(row =>
              !(row.status === 'Soft' && !canChina)
            ).map(row =>
              (row.source === 'China' && !canChina) ? stripChinaPOHeader(row) : row
            );
            const userIds = [...new Set(
              filteredRows.map(row => row.raised_by_user_id).filter(Boolean)
            )];
            const nameMap = {};
            if (userIds.length) {
              const idsCsv = userIds.map(id => `"${id}"`).join(',');
              const usersR = await query('users_profile',
                `?id=in.(${idsCsv})&select=id,full_name`);
              if (usersR.ok) (usersR.data || []).forEach(u => { nameMap[u.id] = u.full_name; });
            }
            const rows = filteredRows.map(row => ({
              ...row,
              raised_by_name: row.raised_by_user_id ? (nameMap[row.raised_by_user_id] || null) : null,
            }));
            return ok(rows);
          }

          case 'getPO': {
            const po = url.searchParams.get('po_number');
            if (!po) return err('po_number required');
            const [header, lines, revisions] = await Promise.all([
              query('purchase_orders', `?po_number=eq.${encodeURIComponent(po)}&limit=1`),
              query('po_lines', `?po_number=eq.${encodeURIComponent(po)}&order=line_no.asc`),
              query('po_revisions', `?po_number=eq.${encodeURIComponent(po)}&order=revision.desc`),
            ]);
            if (!header.ok || !header.data[0]) return err('PO not found');
            const poRow = header.data[0];
            const canChina = canViewChina(P);
            if (poRow.status === 'Soft' && !canChina) return err('PO not found');
            let vendor = null;
            if (poRow.vendor_code) {
              const vR = await query('vendors',
                `?vendor_code=eq.${encodeURIComponent(poRow.vendor_code)}&limit=1`);
              vendor = vR.data?.[0] || null;
            }
            if (!vendor && poRow.vendor_name) {
              const vR = await query('vendors',
                `?vendor_name=ilike.${encodeURIComponent(poRow.vendor_name)}&limit=1`);
              vendor = vR.data?.[0] || null;
            }
            if (poRow.source === 'China' && !canChina) {
              return ok({
                po: stripChinaPOHeader(poRow),
                vendor,
                lines: (lines.data || []).map(stripChinaPOLine),
                revisions: [],
                _china_restricted: true,
              });
            }
            return ok({ po: poRow, vendor, lines: lines.data||[], revisions: revisions.data||[] });
          }

          case 'getPrintPOData': {
            const po = url.searchParams.get('po_number');
            if (!po) return err('po_number required');
            const [headerR, linesR, regR] = await Promise.all([
              query('purchase_orders', `?po_number=eq.${encodeURIComponent(po)}&limit=1`),
              query('po_lines', `?po_number=eq.${encodeURIComponent(po)}&order=line_no.asc`),
              query('company_addresses', `?is_registered_office=eq.true&limit=1`),
            ]);
            if (!headerR.ok || !headerR.data[0]) return err('PO not found');
            const poRow  = headerR.data[0];
            const company = regR.data?.[0] || null;
            let vendor = null;
            if (poRow.vendor_code) {
              const vR = await query('vendors',
                `?vendor_code=eq.${encodeURIComponent(poRow.vendor_code)}&limit=1`);
              vendor = vR.data?.[0] || null;
            }
            if (!vendor && poRow.vendor_name) {
              const vR = await query('vendors',
                `?vendor_name=ilike.${encodeURIComponent(poRow.vendor_name)}&limit=1`);
              vendor = vR.data?.[0] || null;
            }
            let deliveryAddress = null;
            if (poRow.delivery_address_id) {
              const daR = await query('company_addresses',
                `?id=eq.${poRow.delivery_address_id}&limit=1`);
              deliveryAddress = daR.data?.[0] || null;
            }
            if (!deliveryAddress) deliveryAddress = company;
            let preparedByName = poRow.raised_by || null;
            if (poRow.raised_by_user_id) {
              const upR = await query('users_profile',
                `?id=eq.${encodeURIComponent(poRow.raised_by_user_id)}&select=full_name&limit=1`);
              if (upR.ok && upR.data?.[0]?.full_name) preparedByName = upR.data[0].full_name;
            }
            const canChina = canViewChina(P);
            if (poRow.status === 'Soft' && !canChina) return err('PO not found');
            if (poRow.source === 'China' && !canChina) {
              return ok({
                po: stripChinaPOHeader(poRow),
                vendor, company, deliveryAddress,
                lines: (linesR.data || []).map(stripChinaPOLine),
                prepared_by_name: preparedByName,
                _china_restricted: true,
              });
            }
            return ok({ po: poRow, vendor, company, deliveryAddress, lines: linesR.data || [], prepared_by_name: preparedByName });
          }

          case 'getReorderRequests': {
            const status  = url.searchParams.get('status')  || '';
            const urgency = url.searchParams.get('urgency') || '';
            let filter = '?order=created_at.desc&limit=200';
            if (status)  filter += `&status=eq.${encodeURIComponent(status)}`;
            if (urgency) filter += `&urgency=eq.${encodeURIComponent(urgency)}`;
            const r = await query('reorder_requests', filter);
            if (!r.ok) return err(r.data);
            return ok(r.data);
          }

          // ── PO Requests (free-form front door — any authed user) ──
          case 'getRequests': {
            // Internal procurement tool — any authenticated LOT user sees the queue.
            const status = url.searchParams.get('status') || '';
            const mine   = url.searchParams.get('mine');
            let filter = '?order=created_at.desc&limit=300';
            if (status) filter += `&status=eq.${encodeURIComponent(status)}`;
            if (mine === '1' && userId) filter += `&requested_by_user_id=eq.${userId}`;
            const r = await query('po_requests', filter);
            if (!r.ok) return err(r.data);
            return ok(r.data);
          }

          case 'getRequest': {
            const no = url.searchParams.get('request_no');
            if (!no) return err('request_no required');
            const r = await query('po_requests', `?request_no=eq.${encodeURIComponent(no)}&limit=1`);
            if (!r.ok || !r.data[0]) return err('Request not found');
            let linkedPo = null;
            if (r.data[0].linked_po_number) {
              const pr = await query('purchase_orders',
                `?po_number=eq.${encodeURIComponent(r.data[0].linked_po_number)}&select=po_number,status,vendor_name&limit=1`);
              linkedPo = pr.data?.[0] || null;
            }
            return ok({ request: r.data[0], linked_po: linkedPo });
          }

          // ── Payment queue (Approved POs to route / mark paid) ──
          case 'getPaymentQueue': {
            if (!canRoutePayment(P) && !canView(P)) return err('Forbidden', 403);
            // Approved POs awaiting payment routing PLUS any PO whose payment has been
            // routed/paid — so a PO that later moves to Sent/Closed doesn't drop out of
            // the queue (gives a paid-history view, not just the open queue).
            const r = await query('purchase_orders',
              `?or=(status.eq.Approved,payment_status.in.(requested,paid))&select=po_number,vendor_name,currency,invoice_value,status,payment_status,payment_routed_to,payment_requested_by,payment_requested_at,paid_by,paid_at,source_request_no,approved_at,approved_by&order=approved_at.desc&limit=200`);
            if (!r.ok) return err(r.data);
            return ok(r.data);
          }

          // ── Snorkel permission admin (roles are world-readable for the admin UI;
          //    user list + writes are gated by snorkel_admin) ──
          case 'getSnorkelRoles': {
            const r = await query('snorkel_roles', '?order=role_key.asc');
            if (!r.ok) return err(r.data);
            return ok(r.data);
          }

          case 'getSnorkelUsers': {
            if (!canSnorkelAdmin(P)) return err('Admin only', 403);
            const r = await query('users_profile', '?order=full_name.asc&select=id,full_name,role,active');
            if (!r.ok) return err(r.data);
            const ur = await query('snorkel_user_roles', '?select=user_id,role_key');
            const roleMap = {};
            if (ur.ok) (ur.data || []).forEach(x => { roleMap[x.user_id] = x.role_key; });
            const authUsers = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1000`, {
              headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
            });
            const authData = authUsers.ok ? await authUsers.json() : { users: [] };
            const emailMap = {};
            (authData.users || []).forEach(u => { emailMap[u.id] = u.email; });
            return ok(r.data.map(u => ({ ...u, email: emailMap[u.id] || '', snorkel_role: roleMap[u.id] || null })));
          }

          // ── ASSET REGISTER (reads) ───────────────────────────────────
          case 'getAssets': {
            if (!canViewAssets(P)) return err('No permission', 403);
            let params = '?select=*,asset_categories(name),asset_locations(name)&order=created_at.desc';
            const st  = url.searchParams.get('status');
            const cat = url.searchParams.get('category_id');
            const loc = url.searchParams.get('location_id');
            const acq = url.searchParams.get('acquisition_type');
            if (st)  params += `&status=eq.${encodeURIComponent(st)}`;
            if (cat) params += `&category_id=eq.${encodeURIComponent(cat)}`;
            if (loc) params += `&location_id=eq.${encodeURIComponent(loc)}`;
            if (acq) params += `&acquisition_type=eq.${encodeURIComponent(acq)}`;
            const r = await query('assets', params);
            if (!r.ok) return err(r.data);
            // Document counts (one query, counted in-worker — avoids N subrequests).
            const dcRes = await query('asset_documents', '?select=asset_id');
            const dc = {};
            if (dcRes.ok) (dcRes.data || []).forEach(d => { dc[d.asset_id] = (dc[d.asset_id] || 0) + 1; });
            const rows = (r.data || []).map(a => ({
              ...a,
              category_name: a.asset_categories?.name || null,
              location_name: a.asset_locations?.name || null,
              doc_count: dc[a.id] || 0,
              asset_categories: undefined, asset_locations: undefined,
            }));
            return ok(rows);
          }

          case 'getAsset': {
            if (!canViewAssets(P)) return err('No permission', 403);
            const id = url.searchParams.get('id');
            if (!id) return err('id required');
            const r = await query('assets', `?id=eq.${encodeURIComponent(id)}&select=*,asset_categories(name),asset_locations(name)&limit=1`);
            if (!r.ok) return err(r.data);
            const a = r.data?.[0];
            if (!a) return err('Asset not found', 404);
            const asset = {
              ...a,
              category_name: a.asset_categories?.name || null,
              location_name: a.asset_locations?.name || null,
              asset_categories: undefined, asset_locations: undefined,
            };
            const hist = await query('asset_history', `?asset_id=eq.${encodeURIComponent(id)}&order=created_at.desc`);
            const docs = await query('asset_documents', `?asset_id=eq.${encodeURIComponent(id)}&order=created_at.desc`);
            return ok({ asset, history: hist.ok ? hist.data : [], documents: docs.ok ? docs.data : [] });
          }

          case 'getAssetCategories': {
            if (!canViewAssets(P)) return err('No permission', 403);
            const all = url.searchParams.get('all') === '1';
            const r = await query('asset_categories', `${all ? '?' : '?is_active=eq.true&'}order=sort_order.asc,name.asc`);
            if (!r.ok) return err(r.data);
            return ok(r.data);
          }

          case 'getAssetLocations': {
            if (!canViewAssets(P)) return err('No permission', 403);
            const all = url.searchParams.get('all') === '1';
            const r = await query('asset_locations', `${all ? '?' : '?is_active=eq.true&'}order=sort_order.asc,name.asc`);
            if (!r.ok) return err(r.data);
            return ok(r.data);
          }

          case 'getAssetUsers': {
            // Custodian picker (manage forms only). Active LOT users, id + name.
            if (!canManageAssets(P)) return err('No permission', 403);
            const r = await query('users_profile', '?active=eq.true&order=full_name.asc&select=id,full_name');
            if (!r.ok) return err(r.data);
            return ok(r.data);
          }

          case 'getAssetDocumentDownloadUrl': {
            if (!canViewAssets(P)) return err('No permission', 403);
            const docId = url.searchParams.get('document_id');
            if (!docId) return err('document_id required');
            const dr = await query('asset_documents', `?id=eq.${encodeURIComponent(docId)}&select=*&limit=1`);
            if (!dr.ok) return err(dr.data);
            const doc = dr.data?.[0];
            if (!doc) return err('Document not found', 404);
            const seg = String(doc.storage_path).split('/').map(encodeURIComponent).join('/');
            const sr = await storageFetch(`/object/sign/${ASSET_BUCKET}/${seg}`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ expiresIn: 120 }),
            });
            if (!sr.ok || !sr.data?.signedURL) return err(`sign_failed: ${JSON.stringify(sr.data)}`, 502);
            return ok({ url: `${SUPABASE_URL}/storage/v1${sr.data.signedURL}`, file_name: doc.file_name, mime_type: doc.mime_type });
          }

          // ── OFFLINE SALES (reads) ────────────────────────────────────
          case 'getSalesChannels': {
            if (!canSalesView(P)) return err('No permission', 403);
            const all = url.searchParams.get('all') === '1';
            const r = await query('sales_channels', `${all ? '?' : '?is_active=eq.true&'}order=sort_order.asc`);
            if (!r.ok) return err(r.data);
            return ok(r.data);
          }

          case 'getDispatchChannels': {
            if (!canSalesView(P)) return err('No permission', 403);
            const r = await queryPublic('dispatch_channels', '?is_active=eq.true&order=name.asc&select=id,name,type,fulfillment_model');
            if (!r.ok) return err(r.data);
            return ok(r.data);
          }

          case 'getSalesPartners': {
            if (!canSalesView(P)) return err('No permission', 403);
            let params = '?order=name.asc&select=*';
            if (url.searchParams.get('active') === '1') params += '&is_active=eq.true';
            const ch = url.searchParams.get('channel_key');
            if (ch) params += `&channel_key=eq.${encodeURIComponent(ch)}`;
            const r = await query('sales_partners', params);
            if (!r.ok) return err(r.data);
            return ok(r.data);
          }

          case 'getSalesPartner': {
            if (!canSalesView(P)) return err('No permission', 403);
            const id = url.searchParams.get('id');
            if (!id) return err('id required');
            const r = await query('sales_partners', `?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
            if (!r.ok) return err(r.data);
            if (!r.data?.[0]) return err('Partner not found', 404);
            return ok(r.data[0]);
          }

          case 'getSalesOrders': {
            if (!canSalesView(P)) return err('No permission', 403);
            let params = '?order=created_at.desc&select=*,sales_partners(name,state,channel_key)';
            const st = url.searchParams.get('status');
            const ch = url.searchParams.get('channel_key');
            const pid = url.searchParams.get('partner_id');
            if (st)  params += `&status=eq.${encodeURIComponent(st)}`;
            if (ch)  params += `&channel_key=eq.${encodeURIComponent(ch)}`;
            if (pid) params += `&partner_id=eq.${encodeURIComponent(pid)}`;
            const r = await query('sales_orders', params);
            if (!r.ok) return err(r.data);
            const orders = r.data || [];
            const ful = await loadFulfilment(orders);
            const toCancel = [];
            const rows = orders.map(o => {
              const f = ful[o.id];
              const { der, anchor } = resolveFulfilment(f);
              if (der.fulfilment_status === 'rejected' && o.status !== 'cancelled')
                toCancel.push({ o, reason: f.request.reject_reason });
              const dec = decorateSalesOrder(o, anchor);
              return { ...dec, ...der, partner_name: o.sales_partners?.name || null,
                       partner_state: o.sales_partners?.state || null, sales_partners: undefined };
            });
            await reconcileRejections(toCancel);
            return ok(rows);
          }

          case 'getSalesOrder': {
            if (!canSalesView(P)) return err('No permission', 403);
            const id = url.searchParams.get('id');
            if (!id) return err('id required');
            const r = await query('sales_orders', `?id=eq.${encodeURIComponent(id)}&select=*,sales_partners(*)&limit=1`);
            if (!r.ok) return err(r.data);
            const o = r.data?.[0];
            if (!o) return err('Order not found', 404);
            const partner = o.sales_partners || null;
            const [linesR, paysR] = await Promise.all([
              query('sales_order_lines', `?order_id=eq.${encodeURIComponent(id)}&order=sort_order.asc`),
              query('sales_payments', `?order_id=eq.${encodeURIComponent(id)}&order=received_date.desc,created_at.desc`),
            ]);
            const f = (await loadFulfilment([o]))[o.id];
            const { der, anchor } = resolveFulfilment(f);
            if (der.fulfilment_status === 'rejected' && o.status !== 'cancelled')
              await reconcileRejections([{ o, reason: f.request.reject_reason }]);
            const dec = decorateSalesOrder({ ...o, sales_partners: undefined }, anchor);
            return ok({ ...dec, ...der, partner, request: f?.request || null,
              shipments: f?.shipments?.length ? f.shipments : (f?.legacyShipment ? [f.legacyShipment] : []),
              lines: linesR.ok ? linesR.data : [], payments: paysR.ok ? paysR.data : [] });
          }

          case 'getSalesCollections': {
            if (!canSalesView(P)) return err('No permission', 403);
            const r = await query('sales_orders',
              `?status=eq.confirmed&invoice_generated=eq.true&select=*,sales_partners(name)`);
            if (!r.ok) return err(r.data);
            const orders = r.data || [];
            const ful = await loadFulfilment(orders);
            const toCancel = [];
            const rows = orders
              .map(o => {
                const f = ful[o.id];
                const { der, anchor } = resolveFulfilment(f);
                if (der.fulfilment_status === 'rejected' && o.status !== 'cancelled')
                  toCancel.push({ o, reason: f.request.reject_reason });
                return { ...decorateSalesOrder(o, anchor), ...der,
                         partner_name: o.sales_partners?.name || null, sales_partners: undefined };
              })
              .filter(o => o.balance > 0.005)
              .sort((a, b) => {
                if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
                return String(a.due_date || '9999').localeCompare(String(b.due_date || '9999'));
              });
            await reconcileRejections(toCancel);
            return ok(rows);
          }

          case 'getSalesInvoiceData': {
            if (!canSalesView(P)) return err('No permission', 403);
            const id = url.searchParams.get('id');
            if (!id) return err('id required');
            const r = await query('sales_orders', `?id=eq.${encodeURIComponent(id)}&select=*,sales_partners(*)&limit=1`);
            if (!r.ok) return err(r.data);
            const o = r.data?.[0];
            if (!o) return err('Order not found', 404);
            const linesR = await query('sales_order_lines', `?order_id=eq.${encodeURIComponent(id)}&order=sort_order.asc`);
            const sellerR = await query('company_addresses', '?is_registered_office=eq.true&active=eq.true&select=*&limit=1');
            const seller = sellerR.ok ? sellerR.data?.[0] || null : null;
            const placeOfSupply = o.place_of_supply || o.sales_partners?.state || null;
            const intra = !!(seller?.state && placeOfSupply &&
                           seller.state.trim().toLowerCase() === placeOfSupply.trim().toLowerCase());
            const lines = (linesR.ok ? linesR.data : []).map(l => {
              const gstAmt = Number(l.gst_amount) || 0, gstPct = Number(l.gst_pct) || 0;
              return { ...l,
                cgst_pct: intra ? gstPct / 2 : 0, sgst_pct: intra ? gstPct / 2 : 0, igst_pct: intra ? 0 : gstPct,
                cgst_amount: intra ? +(gstAmt / 2).toFixed(2) : 0,
                sgst_amount: intra ? +(gstAmt / 2).toFixed(2) : 0,
                igst_amount: intra ? 0 : +gstAmt.toFixed(2) };
            });
            return ok({ order: { ...o, sales_partners: undefined }, partner: o.sales_partners || null,
              seller, place_of_supply: placeOfSupply, intra, lines });
          }

          case 'getCreditNotes': {
            if (!canSalesView(P)) return err('No permission', 403);
            let params = '?order=created_at.desc&select=*,sales_partners(name)';
            const st = url.searchParams.get('status');
            const pid = url.searchParams.get('partner_id');
            const oid = url.searchParams.get('order_id');
            if (st)  params += `&status=eq.${encodeURIComponent(st)}`;
            if (pid) params += `&partner_id=eq.${encodeURIComponent(pid)}`;
            if (oid) params += `&order_id=eq.${encodeURIComponent(oid)}`;
            const r = await query('sales_credit_notes', params);
            if (!r.ok) return err(r.data);
            const rows = (r.data || []).map(c => ({ ...c, partner_name: c.sales_partners?.name || null, sales_partners: undefined }));
            return ok(rows);
          }

          case 'getCreditNote': {
            if (!canSalesView(P)) return err('No permission', 403);
            const id = url.searchParams.get('id');
            if (!id) return err('id required');
            const r = await query('sales_credit_notes', `?id=eq.${encodeURIComponent(id)}&select=*,sales_partners(*)&limit=1`);
            if (!r.ok) return err(r.data);
            const cn = r.data?.[0];
            if (!cn) return err('Credit note not found', 404);
            const [linesR, orderR, sellerR] = await Promise.all([
              query('sales_credit_note_lines', `?credit_note_id=eq.${encodeURIComponent(id)}&order=sort_order.asc`),
              query('sales_orders', `?id=eq.${encodeURIComponent(cn.order_id)}&select=order_no,grand_total,credit_total,amount_received&limit=1`),
              query('company_addresses', '?is_registered_office=eq.true&active=eq.true&select=*&limit=1'),
            ]);
            const seller = sellerR.ok ? sellerR.data?.[0] || null : null;
            const intra = !!(seller?.state && cn.place_of_supply &&
                           seller.state.trim().toLowerCase() === cn.place_of_supply.trim().toLowerCase());
            const lines = (linesR.ok ? linesR.data : []).map(l => splitGstLine(l, intra));
            return ok({ cn: { ...cn, sales_partners: undefined }, partner: cn.sales_partners || null,
              order: orderR.ok ? orderR.data?.[0] || null : null, seller, intra, lines });
          }

          case 'getOrderForCreditNote': {
            if (!canSalesView(P)) return err('No permission', 403);
            const id = url.searchParams.get('order_id');
            if (!id) return err('order_id required');
            const r = await query('sales_orders', `?id=eq.${encodeURIComponent(id)}&select=*,sales_partners(*)&limit=1`);
            if (!r.ok) return err(r.data);
            const o = r.data?.[0];
            if (!o) return err('Order not found', 404);
            if (!o.invoice_generated) return err('Order has no invoice — cannot raise a credit note', 422);
            const [linesR, cnR] = await Promise.all([
              query('sales_order_lines', `?order_id=eq.${encodeURIComponent(id)}&order=sort_order.asc`),
              query('sales_credit_notes', `?order_id=eq.${encodeURIComponent(id)}&status=in.(draft,issued)&select=id,grand_total`),
            ]);
            const cnIds = (cnR.ok ? cnR.data : []).map(c => c.id);
            const creditedByLine = {};
            if (cnIds.length) {
              const clR = await query('sales_credit_note_lines',
                `?credit_note_id=in.(${cnIds.map(encodeURIComponent).join(',')})&select=order_line_id,qty`);
              (clR.ok ? clR.data : []).forEach(cl => {
                if (cl.order_line_id) creditedByLine[cl.order_line_id] = (creditedByLine[cl.order_line_id] || 0) + (Number(cl.qty) || 0);
              });
            }
            const existingCredit = (cnR.ok ? cnR.data : []).reduce((s, c) => s + (Number(c.grand_total) || 0), 0);
            const lines = (linesR.ok ? linesR.data : []).map(l => ({
              ...l, credited_qty: creditedByLine[l.id] || 0,
              remaining_qty: Math.max(0, (Number(l.qty) || 0) - (creditedByLine[l.id] || 0)),
            }));
            return ok({ order: { ...o, sales_partners: undefined }, partner: o.sales_partners || null,
              lines, existing_credit_total: +existingCredit.toFixed(2),
              remaining_value: +(Number(o.grand_total || 0) - existingCredit).toFixed(2) });
          }

          default:
            return err('Unknown action: ' + action, 400);
        }
      }

      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch(e) { return err('Invalid JSON'); }
        const postRole = role;
        if (!postRole) return err('Unauthorised', 401);

        switch (body.action) {

          case 'postForwarder': {
            if (!canManageVendors(P)) return err('No permission', 403);
            const d = body.data;
            if (!d.company_name) return err('company_name required');
            const iso  = countryToISO(d.country||'Other');
            const seq  = await nextSeq('fwd','');
            const code = `FWD-${iso}-${String(seq).padStart(3,'0')}`;
            const r = await insert('forwarders', {
              forwarder_code: code, company_name: d.company_name, country: d.country||'India',
              country_iso: iso, location: d.location||null, modes_supported: d.modes_supported||[],
              sea_days: d.sea_days||null, air_days: d.air_days||null, land_days: d.land_days||null,
              iata_code: d.iata_code||null, scac_code: d.scac_code||null,
              tracking_url: d.tracking_url||null, contact_name: d.contact_name||null,
              contact_phone: d.contact_phone||null, contact_email: d.contact_email||null,
              notes: d.notes||null, active: true, created_by: postRole,
            });
            if (!r.ok) return err('Forwarder insert failed: '+JSON.stringify(r.data));
            return ok({ forwarder_code: code });
          }

          case 'updateForwarder': {
            if (!canManageVendors(P)) return err('No permission', 403);
            const d = body.data;
            if (!d.forwarder_code) return err('forwarder_code required');
            const fields = ['company_name','country','location','modes_supported','sea_days',
              'air_days','land_days','iata_code','scac_code','tracking_url',
              'contact_name','contact_phone','contact_email','notes','active'];
            const updates = { updated_at: new Date().toISOString() };
            fields.forEach(f => { if (d[f]!==undefined) updates[f]=d[f]; });
            if (d.country) updates.country_iso = countryToISO(d.country);
            const r = await update('forwarders', updates, `forwarder_code=eq.${encodeURIComponent(d.forwarder_code)}`);
            if (!r.ok) return err('Update failed');
            return ok({ updated: d.forwarder_code });
          }

          case 'postVendor': {
            if (!canManageVendors(P)) return err('No permission to add vendors', 403);
            const d = body.data;
            if (!d.vendor_name) return err('vendor_name required');
            const iso  = countryToISO(d.source_country||'Other');
            // Derive next number from actual data (bulk imports bypass the
            // sequences counter), partitioned by country prefix.
            const prefix = `${iso}-VND-`;
            const maxR = await query('vendors',
              `?vendor_code=like.${encodeURIComponent(prefix)}*&order=vendor_code.desc&limit=1&select=vendor_code`);
            if (!maxR.ok) return err('Vendor max lookup failed: '+JSON.stringify(maxR.data));
            const lastCode = maxR.data?.[0]?.vendor_code || '';
            const lastNum  = parseInt(lastCode.slice(prefix.length), 10) || 0;
            const seq      = lastNum + 1;
            const code = `${prefix}${String(seq).padStart(3,'0')}`;
            const r = await insert('vendors', {
              vendor_code: code, vendor_name: d.vendor_name, category: d.category||null,
              source_country: d.source_country||'India', country_iso: iso,
              location: d.location||null, contact_name: d.contact_name||null,
              contact_phone: d.contact_phone||null, contact_email: d.contact_email||null,
              address: d.address||null, payment_terms: d.payment_terms||null,
              currency: d.currency||'INR', lead_time_days: d.lead_time_days||null,
              notes: d.notes||null, active: true, created_by: postRole,
            });
            if (!r.ok) return err('Vendor insert failed: '+JSON.stringify(r.data));
            return ok({ vendor_code: code });
          }

          case 'updateVendor': {
            if (!canManageVendors(P)) return err('No permission', 403);
            const d = body.data;
            if (!d.vendor_code) return err('vendor_code required');
            const fields = ['vendor_name','category','source_country','location','contact_name',
              'contact_phone','contact_email','address','payment_terms','currency','lead_time_days','notes','active'];
            const updates = { updated_at: new Date().toISOString() };
            fields.forEach(f => { if (d[f]!==undefined) updates[f]=d[f]; });
            if (d.source_country) updates.country_iso = countryToISO(d.source_country);
            const r = await update('vendors', updates, `vendor_code=eq.${encodeURIComponent(d.vendor_code)}`);
            if (!r.ok) return err('Update failed');
            return ok({ updated: d.vendor_code });
          }

          case 'createCompanyAddress': {
            if (!canManageAddresses(P)) return err('No permission', 403);
            const d = body.data || {};
            for (const f of ['label','legal_name','line1','city','state','pincode']) {
              if (!d[f] || !String(d[f]).trim()) return err(`${f} required`, 400);
            }
            if (!/^\d{6}$/.test(String(d.pincode).trim())) return err('Pincode must be 6 digits', 400);
            const row = {
              label:        d.label.trim(),
              legal_name:   d.legal_name.trim(),
              line1:        d.line1.trim(),
              line2:        d.line2?.trim() || null,
              city:         d.city.trim(),
              state:        d.state.trim(),
              pincode:      String(d.pincode).trim(),
              country:      d.country?.trim() || 'India',
              gstin:        d.gstin?.trim() || null,
              phone:        d.phone?.trim() || null,
              email:        d.email?.trim() || null,
              is_registered_office: false,
              is_default_delivery:  false,
              active:       true,
            };
            const r = await insert('company_addresses', row);
            if (!r.ok) return err('Insert failed: ' + JSON.stringify(r.data));
            const newId = r.data[0]?.id;
            if (d.is_registered_office === true) await setExclusiveAddressFlag('is_registered_office', newId);
            if (d.is_default_delivery  === true) await setExclusiveAddressFlag('is_default_delivery',  newId);
            return ok({ id: newId });
          }

          case 'updateCompanyAddress': {
            if (!canManageAddresses(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.id) return err('id required', 400);
            if (d.active === false) {
              const cur = await query('company_addresses',
                `?id=eq.${d.id}&select=is_registered_office,is_default_delivery&limit=1`);
              const row = cur.data?.[0];
              if (row && (row.is_registered_office || row.is_default_delivery))
                return err('Cannot deactivate the registered office or default delivery address — reassign that role to another address first.', 400);
            }
            if (d.pincode !== undefined && !/^\d{6}$/.test(String(d.pincode).trim()))
              return err('Pincode must be 6 digits', 400);
            const updates = { updated_at: new Date().toISOString() };
            ['label','legal_name','line1','line2','city','state','pincode','gstin','phone','email'].forEach(f => {
              if (d[f] !== undefined) updates[f] = (typeof d[f] === 'string' ? (d[f].trim() || null) : d[f]);
            });
            if (d.country !== undefined) updates.country = d.country?.trim() || 'India';
            if (d.active  !== undefined) updates.active = !!d.active;
            for (const f of ['label','legal_name','line1','city','state','pincode']) {
              if (updates[f] !== undefined && !updates[f]) return err(`${f} cannot be blank`, 400);
            }
            const r = await update('company_addresses', updates, `id=eq.${d.id}`);
            if (!r.ok) return err('Update failed: ' + JSON.stringify(r.data));
            return ok({ updated: d.id });
          }

          case 'setDefaultDeliveryAddress': {
            if (!canManageAddresses(P)) return err('No permission', 403);
            const id = body.data?.id;
            if (!id) return err('id required', 400);
            const cur = await query('company_addresses', `?id=eq.${id}&select=active&limit=1`);
            if (!cur.data?.[0]) return err('Address not found', 404);
            if (!cur.data[0].active) return err('Cannot set an inactive address as default delivery', 400);
            const r = await setExclusiveAddressFlag('is_default_delivery', id);
            if (!r.ok) return err('Update failed: ' + JSON.stringify(r.data));
            return ok({ default_delivery: id });
          }

          case 'setRegisteredOffice': {
            if (!canManageAddresses(P)) return err('No permission', 403);
            const id = body.data?.id;
            if (!id) return err('id required', 400);
            const cur = await query('company_addresses', `?id=eq.${id}&select=active&limit=1`);
            if (!cur.data?.[0]) return err('Address not found', 404);
            if (!cur.data[0].active) return err('Cannot set an inactive address as registered office', 400);
            const r = await setExclusiveAddressFlag('is_registered_office', id);
            if (!r.ok) return err('Update failed: ' + JSON.stringify(r.data));
            return ok({ registered_office: id });
          }

          case 'postVendorSuppliedItem': {
            if (!canManageVendors(P)) return err('No permission', 403);
            const d = body.data;
            if (!d.vendor_code || !d.supply_type || !d.reference) return err('vendor_code, supply_type, reference required');
            const r = await insert('vendor_supplied_items', {
              vendor_code:   d.vendor_code,
              supply_type:   d.supply_type,
              reference:     d.reference,
              display_label: d.display_label || d.reference,
              po_category:   d.po_category || null,
              notes:         d.notes || null,
            });
            if (!r.ok) return err('Insert failed: ' + JSON.stringify(r.data));
            return ok({ id: r.data[0]?.id });
          }

          case 'deleteVendorSuppliedItem': {
            if (!canManageVendors(P)) return err('No permission', 403);
            const d = body.data;
            if (!d.id) return err('id required');
            await sb(`/rest/v1/vendor_supplied_items?id=eq.${d.id}`, { method: 'DELETE' });
            return ok({ deleted: d.id });
          }

          // ── Mould master writes (Snorkel mould procurement) — gated po_create ──
          case 'createMould': {
            if (!canRaisePO(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.mould_no) return err('mould_no required');
            const r = await insert('moulds', {
              mould_no: String(d.mould_no).trim(), description: d.description || null,
              vendor_code: d.vendor_code || null, hsn_code: d.hsn_code || null,
              gst_percent: d.gst_percent != null ? parseFloat(d.gst_percent) : null,
              default_shot_rate: d.default_shot_rate != null ? parseFloat(d.default_shot_rate) : null,
              is_active: d.is_active !== false, notes: d.notes || null,
            });
            if (!r.ok) return err('Mould insert failed: ' + JSON.stringify(r.data));
            await logActivity(authResult?.fullName || postRole, postRole, 'MOULD_CREATED', 'MOULD', d.mould_no, `Mould ${d.mould_no} created`, {});
            return ok({ mould_no: String(d.mould_no).trim() });
          }

          case 'updateMould': {
            if (!canRaisePO(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.mould_no) return err('mould_no required');
            const u = { updated_at: new Date().toISOString() };
            ['description', 'vendor_code', 'hsn_code', 'gst_percent', 'default_shot_rate', 'is_active', 'notes']
              .forEach(f => { if (d[f] !== undefined) u[f] = d[f]; });
            await update('moulds', u, `mould_no=eq.${encodeURIComponent(d.mould_no)}`);
            await logActivity(authResult?.fullName || postRole, postRole, 'MOULD_UPDATED', 'MOULD', d.mould_no, `Mould ${d.mould_no} updated`, {});
            return ok({ mould_no: d.mould_no });
          }

          case 'setMouldParts': {   // replace the full part map for a mould
            if (!canRaisePO(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.mould_no || !Array.isArray(d.parts)) return err('mould_no and parts[] required');
            await sb(`/rest/v1/mould_parts?mould_no=eq.${encodeURIComponent(d.mould_no)}`, { method: 'DELETE' });
            const rows = d.parts.filter(p => p.part_code).map(p => ({
              mould_no: d.mould_no, part_code: p.part_code, qty_per_shot: parseFloat(p.qty_per_shot) || 1,
            }));
            if (rows.length) {
              const r = await insert('mould_parts', rows);
              if (!r.ok) return err('Mould parts insert failed: ' + JSON.stringify(r.data));
            }
            await logActivity(authResult?.fullName || postRole, postRole, 'MOULD_PARTS_SET', 'MOULD', d.mould_no, `Mould ${d.mould_no} map set (${rows.length} parts)`, {});
            return ok({ mould_no: d.mould_no, count: rows.length });
          }

          case 'postPO': {
            if (!canRaisePO(P)) return err('No permission to raise POs', 403);
            const d = body.data;
            if (!d.vendor_name||!d.source||!d.order_type) return err('vendor_name, source, order_type required');
            const isChina = d.source === 'China';
            const isSoft = d.status === 'Soft';
            if (isChina && !canRaiseChinaPO(P)) return err('China POs require po_china permission', 403);
            if (isSoft && !isChina) return err("Soft status is only valid for China POs", 400);
            if (isSoft && !canRaiseChinaPO(P)) return err('Soft POs require po_china permission', 403);
            const srcCode  = countryToISO(d.source||'Other');
            const typeCode = {'Product':'PRD','Packaging':'PKG','Para':'PRA','Consumable':'CSM','Component':'CMP','Tools':'TLS','Machines':'MCH'}[d.order_type]||'OTH';
            const seq      = await nextSeq('po','');
            const poNumber = `${srcCode}-${typeCode}-${String(seq).padStart(4,'0')}`;
            let vendorCode = d.vendor_code || null;
            if (!vendorCode && d.vendor_name) {
              const vR = await query('vendors',
                `?vendor_name=ilike.${encodeURIComponent(d.vendor_name)}&select=vendor_code&limit=1`);
              if (vR.ok && vR.data?.[0]?.vendor_code) vendorCode = vR.data[0].vendor_code;
            }
            const r = await insert('purchase_orders', {
              po_number: poNumber, revision: 0, status: isSoft ? 'Soft' : 'Draft',
              source: d.source, order_type: d.order_type, vendor_name: d.vendor_name,
              vendor_code: vendorCode,
              po_category: d.po_category || null,
              currency: d.currency||'INR', payment_terms: d.payment_terms||null,
              incoterms: d.incoterms||null, expected_delivery: d.expected_delivery||null,
              lead_time_days: d.lead_time_days||null, port_of_loading: d.port_of_loading||null,
              freight_forwarder: d.freight_forwarder||null, order_placed_date: todayISO(),
              expected_ready_date: d.expected_ready_date||null, shipping_date: d.shipping_date||null,
              shipping_mode: d.shipping_mode||null, forwarder_code: d.forwarder_code||null,
              transit_days: d.transit_days||null, actual_arrival_date: null,
              raised_by: postRole, raised_by_user_id: userId, raised_date: todayISO(),
              notes: d.notes||null,
              delivery_address_id: d.delivery_address_id ?? null,
              source_request_no: d.source_request_no || null,
            });
            if (!r.ok) return err('PO insert failed: '+JSON.stringify(r.data));
            const lines = Array.isArray(d.lines) ? d.lines : [];
            if (lines.length>0) {
              const lineRows = lines.map((l,i) => ({
                po_number: poNumber, line_no: i+1, product: l.product||null, variant: l.variant||null,
                item_type: l.item_type||'Other', description: l.description||null, part_code: l.part_code||null,
                qty_ordered: parseFloat(l.qty_ordered)||0, qty_received: 0, unit: l.unit||'pcs',
                unit_price: parseFloat(l.unit_price)||null, color: l.color||null,
                component_type: l.component_type||null,
                receive_format: l.receive_format || null,
                remote_qty: parseInt(l.remote_qty) || 0,
                hsn_code: l.hsn_code || null,
                gst_percent: l.gst_percent != null ? parseFloat(l.gst_percent) : null,
                mould_no: l.mould_no || null,
              }));
              const lr = await insert('po_lines', lineRows);
              if (!lr.ok) return err('PO lines insert failed: '+JSON.stringify(lr.data));
            }
            await insert('po_revisions', {
              po_number: poNumber, revision: 0, changed_by: postRole,
              change_summary: isSoft ? 'Soft PO created' : 'PO created',
              snapshot: JSON.stringify({ ...d, po_number: poNumber }),
            });
            await logActivity(authResult?.fullName||postRole, postRole,
              isSoft ? 'PO_SOFT_CREATED' : 'PO_CREATED', 'PO', poNumber,
              `PO ${poNumber} ${isSoft?'(Soft) ':''}created — ${d.vendor_name||''} · ${d.source||''} · ${lines.length} lines`,
              { vendor: d.vendor_name, source: d.source, soft: isSoft });
            return ok({ po_number: poNumber, status: isSoft ? 'Soft' : 'Draft' });
          }

          // Draft → Accepted. This is the proc-manager's "accept" — it ALSO flips the
          // linked PO request (if any) to `approved`. Final sign-off is finalApprovePO.
          case 'acceptPO': {
            if (!canAcceptPO(P)) return err('No permission to accept POs', 403);
            const d = body.data;
            if (!d.po_number) return err('po_number required');
            const existing = await query('purchase_orders', `?po_number=eq.${encodeURIComponent(d.po_number)}&limit=1`);
            if (!existing.ok||!existing.data[0]) return err('PO not found');
            const po = existing.data[0];
            if (po.status !== 'Draft') return err('Only Draft POs can be accepted');
            const now = new Date().toISOString();
            await update('purchase_orders',
              { status: 'Accepted', accepted_by: postRole, accepted_at: now, updated_at: now },
              `po_number=eq.${encodeURIComponent(d.po_number)}`);
            await insert('po_revisions', {
              po_number: d.po_number, revision: po.revision, changed_by: postRole, change_summary: 'PO accepted',
            });
            if (po.source_request_no) {
              await update('po_requests',
                { status: 'approved', accepted_by: postRole, accepted_at: now, linked_po_number: d.po_number, updated_at: now },
                `request_no=eq.${encodeURIComponent(po.source_request_no)}`);
            }
            await logActivity(authResult?.fullName||postRole, postRole, 'PO_ACCEPTED', 'PO', d.po_number,
              `PO ${d.po_number} accepted${po.source_request_no ? ` (request ${po.source_request_no} approved)` : ''}`, {});
            return ok({ po_number: d.po_number, status: 'Accepted' });
          }

          // Accepted → Approved. Final sign-off (Vinay/Afshaan). China four-eyes kept.
          case 'finalApprovePO': {
            if (!canFinalApprove(P)) return err('No permission for final approval', 403);
            const d = body.data;
            if (!d.po_number) return err('po_number required');
            const existing = await query('purchase_orders', `?po_number=eq.${encodeURIComponent(d.po_number)}&limit=1`);
            if (!existing.ok||!existing.data[0]) return err('PO not found');
            const po = existing.data[0];
            if (po.status !== 'Accepted') return err('Only Accepted POs can be approved');
            if (po.source === 'China' && po.raised_by_user_id && po.raised_by_user_id === userId) {
              return err('Four-eyes required: approver cannot be the person who raised this China PO', 403);
            }
            const now = new Date().toISOString();
            await update('purchase_orders',
              { status: 'Approved', approved_by: postRole, approved_at: now, updated_at: now },
              `po_number=eq.${encodeURIComponent(d.po_number)}`);
            await insert('po_revisions', {
              po_number: d.po_number, revision: po.revision, changed_by: postRole, change_summary: 'PO final-approved',
            });
            await logActivity(authResult?.fullName||postRole, postRole, 'PO_APPROVED', 'PO', d.po_number, `PO ${d.po_number} approved (final)`, {});
            return ok({ po_number: d.po_number, status: 'Approved' });
          }

          case 'updatePOStatus': {
            const d = body.data;
            if (!d.po_number||!d.status) return err('po_number and status required');
            const existing = await query('purchase_orders', `?po_number=eq.${encodeURIComponent(d.po_number)}&limit=1`);
            if (!existing.ok||!existing.data[0]) return err('PO not found');
            const po = existing.data[0];
            if (d.status === 'Accepted' || d.status === 'Approved') {
              return err('Use the Accept / Final Approve actions for those transitions', 400);
            }
            if (po.source === 'China' && !canRaiseChinaPO(P)) {
              return err('China PO status changes require po_china permission', 403);
            }
            if (po.source !== 'China' && !canRaisePO(P)) {
              return err('No permission to change PO status', 403);
            }
            await update('purchase_orders',
              { status: d.status, updated_at: new Date().toISOString() },
              `po_number=eq.${encodeURIComponent(d.po_number)}`);
            await insert('po_revisions', {
              po_number: d.po_number, revision: po.revision,
              changed_by: postRole, change_summary: `Status → ${d.status}`,
            });
            await logActivity(authResult?.fullName||postRole, postRole, 'PO_STATUS_UPDATED', 'PO', d.po_number,
              `PO ${d.po_number} → ${d.status}`, { status: d.status });
            return ok({ po_number: d.po_number, status: d.status });
          }

          case 'amendPO': {
            if (!canRaisePO(P)) return err('No permission to amend POs', 403);
            const d = body.data;
            if (!d.po_number) return err('po_number required');
            const existing = await query('purchase_orders', `?po_number=eq.${encodeURIComponent(d.po_number)}&limit=1`);
            if (!existing.ok||!existing.data[0]) return err('PO not found');
            const po = existing.data[0];
            if (po.source === 'China' && !canRaiseChinaPO(P)) {
              return err('China PO amend requires po_china permission', 403);
            }
            const newRev = po.revision+1;
            const linesR = await query('po_lines', `?po_number=eq.${encodeURIComponent(d.po_number)}&order=line_no.asc`);
            await insert('po_revisions', {
              po_number: d.po_number, revision: po.revision, changed_by: postRole,
              change_summary: d.change_summary||`Amendment to Rev ${newRev}`,
              snapshot: JSON.stringify({ header: po, lines: linesR.data||[] }),
            });
            const updates = { revision: newRev, updated_at: new Date().toISOString() };
            ['vendor_name','vendor_code','currency','payment_terms','incoterms','expected_delivery','lead_time_days',
              'port_of_loading','freight_forwarder','forwarder_code','expected_ready_date','shipping_date',
              'shipping_mode','transit_days','actual_arrival_date','invoice_number','invoice_value',
              'quality_hold','notes','delivery_address_id','po_category'].forEach(f => { if (d[f]!==undefined) updates[f]=d[f]; });
            await update('purchase_orders', updates, `po_number=eq.${encodeURIComponent(d.po_number)}`);
            if (Array.isArray(d.lines)&&d.lines.length>0) {
              await sb(`/rest/v1/po_lines?po_number=eq.${encodeURIComponent(d.po_number)}`, { method: 'DELETE' });
              const lineRows = d.lines.map((l,i) => ({
                po_number: d.po_number, line_no: i+1, product: l.product||null, variant: l.variant||null,
                item_type: l.item_type||'Other', description: l.description||null, part_code: l.part_code||null,
                qty_ordered: parseFloat(l.qty_ordered)||0, qty_received: parseFloat(l.qty_received)||0,
                unit: l.unit||'pcs', unit_price: parseFloat(l.unit_price)||null, color: l.color||null,
                component_type: l.component_type||null,
                receive_format: l.receive_format || null,
                remote_qty: parseInt(l.remote_qty) || 0,
                hsn_code: l.hsn_code || null,
                gst_percent: l.gst_percent != null ? parseFloat(l.gst_percent) : null,
                mould_no: l.mould_no || null,
              }));
              await insert('po_lines', lineRows);
            }
            return ok({ po_number: d.po_number, revision: newRev });
          }

          case 'cancelPO': {
            if (!canRaisePO(P)) return err('No permission to cancel POs', 403);
            const d = body.data;
            if (!d.po_number||!d.reason) return err('po_number and reason required');
            const existing = await query('purchase_orders', `?po_number=eq.${encodeURIComponent(d.po_number)}&limit=1`);
            if (!existing.ok||!existing.data[0]) return err('PO not found');
            const po = existing.data[0];
            if (po.source === 'China' && !canRaiseChinaPO(P)) {
              return err('China PO cancel requires po_china permission', 403);
            }
            await update('purchase_orders',
              { status: 'Cancelled', cancellation_reason: d.reason, updated_at: new Date().toISOString() },
              `po_number=eq.${encodeURIComponent(d.po_number)}`);
            await insert('po_revisions', {
              po_number: d.po_number, revision: po.revision, changed_by: postRole,
              change_summary: `Cancelled: ${d.reason}`,
            });
            await logActivity(authResult?.fullName||postRole, postRole, 'PO_CANCELLED', 'PO', d.po_number,
              `PO ${d.po_number} cancelled — ${d.reason||'no reason given'}`, { reason: d.reason });
            return ok({ po_number: d.po_number, status: 'Cancelled' });
          }

          case 'promoteSoftPO': {
            if (!canRaiseChinaPO(P)) return err('Restricted to po_china', 403);
            const d = body.data;
            if (!d.po_number) return err('po_number required');
            if (!Array.isArray(d.line_links)) return err('line_links array required');
            const existing = await query('purchase_orders', `?po_number=eq.${encodeURIComponent(d.po_number)}&limit=1`);
            if (!existing.ok || !existing.data[0]) return err('PO not found');
            const po = existing.data[0];
            if (po.status !== 'Soft') return err('Only Soft POs can be promoted');
            const eans = d.line_links.map(l => l.ean).filter(Boolean);
            if (!eans.length) return err('At least one line_link with ean required');
            const pmR = await queryPublic('product_master',
              `?ean=in.(${eans.map(encodeURIComponent).join(',')})&select=ean,product,product_code,component_type`);
            if (!pmR.ok) return err('Failed to resolve products: ' + JSON.stringify(pmR.data));
            const byEan = {};
            (pmR.data || []).forEach(r => { byEan[r.ean] = r; });
            for (const link of d.line_links) {
              if (!link.line_no || !link.ean) continue;
              const pm = byEan[link.ean];
              if (!pm) return err(`EAN ${link.ean} not found in product_master`);
              await update('po_lines',
                { product: pm.product, part_code: pm.product_code || null, component_type: pm.component_type, updated_at: new Date().toISOString() },
                `po_number=eq.${encodeURIComponent(d.po_number)}&line_no=eq.${link.line_no}`);
            }
            await update('purchase_orders',
              { status: 'Draft', updated_at: new Date().toISOString() },
              `po_number=eq.${encodeURIComponent(d.po_number)}`);
            await insert('po_revisions', {
              po_number: d.po_number, revision: po.revision, changed_by: postRole,
              change_summary: `Promoted from Soft → Draft (linked ${d.line_links.length} lines)`,
            });
            await logActivity(authResult?.fullName||postRole, postRole, 'PO_PROMOTED', 'PO', d.po_number,
              `Soft PO ${d.po_number} promoted to Draft — ${d.line_links.length} lines linked`, {});
            return ok({ po_number: d.po_number, status: 'Draft', linked_count: d.line_links.length });
          }

          case 'registerProductFamily': {
            if (!canRaiseChinaPO(P)) return err('Restricted to po_china', 403);
            const d = body.data || {};
            const payload = { ...d, mode: d.mode || 'new' };
            const r = await rpc('register_product_family', { p_payload: payload, p_user_id: userId });
            if (!r.ok) return err('Registration failed: ' + JSON.stringify(r.data));
            await logActivity(authResult?.fullName||postRole, postRole, 'PRODUCT_REGISTERED', 'product',
              payload.base?.product || '',
              `New product family registered: ${payload.base?.product} (${(payload.variants||[]).length} variants, has_remote=${!!payload.base?.has_remote})`,
              { mode: payload.mode });
            return ok(r.data);
          }

          case 'addProductVariants': {
            if (!canRaiseChinaPO(P)) return err('Restricted to po_china', 403);
            const d = body.data || {};
            const payload = { ...d, mode: 'extend' };
            const r = await rpc('register_product_family', { p_payload: payload, p_user_id: userId });
            if (!r.ok) return err('Add-variants failed: ' + JSON.stringify(r.data));
            await logActivity(authResult?.fullName||postRole, postRole, 'PRODUCT_VARIANTS_ADDED', 'product',
              payload.base?.product || '',
              `Added ${(payload.variants||[]).length} variants to ${payload.base?.product}`, {});
            return ok(r.data);
          }

          case 'updatePOLineReceived': {
            if (!canRaisePO(P)) return err('Procurement permission required', 403);
            const d = body.data;
            if (!d.po_number||!d.line_no||d.qty_received===undefined) return err('po_number, line_no, qty_received required');
            await update('po_lines',
              { qty_received: d.qty_received, updated_at: new Date().toISOString() },
              `po_number=eq.${encodeURIComponent(d.po_number)}&line_no=eq.${d.line_no}`);
            const linesR = await query('po_lines', `?po_number=eq.${encodeURIComponent(d.po_number)}`);
            if (linesR.ok&&linesR.data.length) {
              const allDone = linesR.data.every(l => (l.qty_received||0)>=(l.qty_ordered||0));
              const anyDone = linesR.data.some(l  => (l.qty_received||0)>0);
              const newStatus = allDone ? 'Closed' : anyDone ? 'Partially Received' : null;
              if (newStatus) {
                await update('purchase_orders',
                  { status: newStatus, updated_at: new Date().toISOString() },
                  `po_number=eq.${encodeURIComponent(d.po_number)}`);
              }
            }
            return ok({ updated: d.po_number });
          }

          case 'postReorderRequest': {
            if (!canWrite(P)) return err('Write permission required', 403);
            const d = body.data;
            if (!d.part_code && !d.product) return err('part_code or product required');
            if (!d.requested_qty) return err('requested_qty required');
            const seq = await nextSeq('rr', '');
            const reqId = 'RR-' + String(seq).padStart(4, '0');
            const r = await insert('reorder_requests', {
              request_id:        reqId,
              request_type:      d.request_type || 'part',
              part_code:         d.part_code    || null,
              product:           d.product      || null,
              variant:           d.variant      || null,
              color:             d.color        || null,
              part_name:         d.part_name    || null,
              requested_qty:     parseFloat(d.requested_qty),
              unit:              d.unit         || 'pcs',
              urgency:           d.urgency      || 'Normal',
              notes:             d.notes        || null,
              requested_by:      authResult?.userId || postRole,
              requested_by_name: authResult?.fullName || postRole,
              status:            'Pending',
            });
            if (!r.ok) return err('Insert failed: ' + JSON.stringify(r.data));
            return ok({ request_id: reqId });
          }

          case 'updateReorderRequest': {
            if (!canRaisePO(P)) return err('Procurement permission required', 403);
            const d = body.data;
            if (!d.request_id || !d.action) return err('request_id and action required');
            if (d.action === 'reject') {
              if (!d.rejection_note) return err('rejection_note required');
              await update('reorder_requests',
                { status: 'Rejected', rejection_note: d.rejection_note, updated_at: new Date().toISOString() },
                `request_id=eq.${encodeURIComponent(d.request_id)}`);
              return ok({ request_id: d.request_id, status: 'Rejected' });
            }
            if (d.action === 'convert') {
              if (!d.po_number) return err('po_number required for convert');
              await update('reorder_requests',
                { status: 'Converted', converted_po_id: d.po_number, updated_at: new Date().toISOString() },
                `request_id=eq.${encodeURIComponent(d.request_id)}`);
              return ok({ request_id: d.request_id, status: 'Converted' });
            }
            return err('Unknown action');
          }

          // ══════════════════════════════════════════════════
          // PO REQUESTS — free-form front door (any authed user)
          // ══════════════════════════════════════════════════
          case 'postRequest': {
            // No permission key — anyone with a @legendoftoys.com login may file a request.
            const d = body.data || {};
            if (!d.title || !d.details) return err('title and details required');
            const reqNo = await nextSeq('po_request', 'PR-');
            const r = await insert('po_requests', {
              request_no: reqNo,
              title: d.title, details: d.details,
              category: d.category || null,
              suggested_vendor: d.suggested_vendor || null,
              estimated_cost: d.estimated_cost != null && d.estimated_cost !== '' ? Number(d.estimated_cost) : null,
              currency: d.currency || 'INR',
              urgency: d.urgency || 'Normal',
              needed_by: d.needed_by || null,
              notes: d.notes || null,
              status: 'pending',
              requested_by_user_id: userId,
              requested_by_name: authResult?.fullName || postRole,
              requested_by_email: authResult?.email || null,
            });
            if (!r.ok) return err('Request insert failed: ' + JSON.stringify(r.data));
            await logActivity(authResult?.fullName||postRole, postRole, 'PO_REQUEST_CREATED', 'po_request', reqNo,
              `PO request ${reqNo} filed — ${d.title}`, { urgency: d.urgency || 'Normal' });
            return ok({ request_no: reqNo });
          }

          case 'cancelRequest': {
            const d = body.data || {};
            if (!d.request_no) return err('request_no required');
            const ex = await query('po_requests', `?request_no=eq.${encodeURIComponent(d.request_no)}&limit=1`);
            if (!ex.ok || !ex.data[0]) return err('Request not found');
            const req = ex.data[0];
            if (req.requested_by_user_id !== userId && !canSnorkelAdmin(P))
              return err('Only the requester or an admin can cancel a request', 403);
            if (req.status !== 'pending') return err('Only pending requests can be cancelled');
            await update('po_requests', { status: 'cancelled', updated_at: new Date().toISOString() },
              `request_no=eq.${encodeURIComponent(d.request_no)}`);
            return ok({ request_no: d.request_no, status: 'cancelled' });
          }

          case 'rejectRequest': {
            if (!canAcceptPO(P)) return err('No permission to reject requests', 403);
            const d = body.data || {};
            if (!d.request_no || !d.rejection_note) return err('request_no and rejection_note required');
            await update('po_requests',
              { status: 'rejected', rejected_by: postRole, rejection_note: d.rejection_note, updated_at: new Date().toISOString() },
              `request_no=eq.${encodeURIComponent(d.request_no)}`);
            await logActivity(authResult?.fullName||postRole, postRole, 'PO_REQUEST_REJECTED', 'po_request', d.request_no,
              `PO request ${d.request_no} rejected`, { note: d.rejection_note });
            return ok({ request_no: d.request_no, status: 'rejected' });
          }

          // ══════════════════════════════════════════════════
          // PAYMENT ROUTING (after final approval)
          // ══════════════════════════════════════════════════
          case 'routePayment': {
            if (!canRoutePayment(P)) return err('No permission to route payment', 403);
            const d = body.data || {};
            if (!d.po_number || !d.route_to) return err('po_number and route_to required');
            if (!['finance','requester'].includes(d.route_to)) return err('route_to must be finance or requester');
            const ex = await query('purchase_orders', `?po_number=eq.${encodeURIComponent(d.po_number)}&select=status&limit=1`);
            if (!ex.ok || !ex.data[0]) return err('PO not found');
            if (ex.data[0].status !== 'Approved') return err('Only Approved POs can be routed for payment');
            const now = new Date().toISOString();
            await update('purchase_orders',
              { payment_routed_to: d.route_to, payment_status: 'requested', payment_requested_by: postRole,
                payment_requested_at: now, payment_note: d.note || null, updated_at: now },
              `po_number=eq.${encodeURIComponent(d.po_number)}`);
            await logActivity(authResult?.fullName||postRole, postRole, 'PO_PAYMENT_ROUTED', 'PO', d.po_number,
              `PO ${d.po_number} payment requested from ${d.route_to}`, { route_to: d.route_to });
            return ok({ po_number: d.po_number, payment_routed_to: d.route_to, payment_status: 'requested' });
          }

          case 'markPaid': {
            if (!canRoutePayment(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.po_number) return err('po_number required');
            const now = new Date().toISOString();
            const patch = { payment_status: 'paid', paid_by: postRole, paid_at: now, updated_at: now };
            if (d.note) patch.payment_note = d.note;
            await update('purchase_orders', patch, `po_number=eq.${encodeURIComponent(d.po_number)}`);
            await logActivity(authResult?.fullName||postRole, postRole, 'PO_PAID', 'PO', d.po_number, `PO ${d.po_number} marked paid`, {});
            return ok({ po_number: d.po_number, payment_status: 'paid' });
          }

          // ══════════════════════════════════════════════════
          // SNORKEL PERMISSION ADMIN (snorkel_admin)
          // ══════════════════════════════════════════════════
          case 'createSnorkelRole': {
            if (!canSnorkelAdmin(P)) return err('Admin only', 403);
            const d = body.data || {};
            if (!d.role_key || !d.label) return err('role_key and label required');
            const key = String(d.role_key).trim().toLowerCase().replace(/\s+/g, '_');
            const r = await insert('snorkel_roles', {
              role_key: key, label: d.label, description: d.description || null,
              permissions: d.permissions || {}, is_system: false,
            });
            if (!r.ok) return err('Create failed: ' + JSON.stringify(r.data));
            return ok({ role_key: key });
          }

          case 'updateSnorkelRole': {
            if (!canSnorkelAdmin(P)) return err('Admin only', 403);
            const d = body.data || {};
            if (!d.role_key) return err('role_key required');
            const updates = { updated_at: new Date().toISOString() };
            if (d.label !== undefined)       updates.label = d.label;
            if (d.description !== undefined) updates.description = d.description;
            if (d.permissions !== undefined) updates.permissions = d.permissions;
            const r = await update('snorkel_roles', updates, `role_key=eq.${encodeURIComponent(d.role_key)}`);
            if (!r.ok) return err('Update failed: ' + JSON.stringify(r.data));
            return ok({ updated: d.role_key });
          }

          case 'deleteSnorkelRole': {
            if (!canSnorkelAdmin(P)) return err('Admin only', 403);
            const d = body.data || {};
            if (!d.role_key) return err('role_key required');
            const chk = await query('snorkel_roles', `?role_key=eq.${encodeURIComponent(d.role_key)}&limit=1`);
            if (chk.ok && chk.data[0]?.is_system) return err('Cannot delete a system role');
            const assigned = await query('snorkel_user_roles', `?role_key=eq.${encodeURIComponent(d.role_key)}&limit=1`);
            if (assigned.ok && assigned.data.length) return err('Cannot delete a role with assigned users');
            await sb(`/rest/v1/snorkel_roles?role_key=eq.${encodeURIComponent(d.role_key)}`, { method: 'DELETE' });
            return ok({ deleted: d.role_key });
          }

          case 'assignSnorkelRole': {
            if (!canSnorkelAdmin(P)) return err('Admin only', 403);
            const d = body.data || {};
            if (!d.user_id) return err('user_id required');
            // Empty role_key → unassign (user falls back to no Snorkel perms = requester).
            if (!d.role_key) {
              await sb(`/rest/v1/snorkel_user_roles?user_id=eq.${encodeURIComponent(d.user_id)}`, { method: 'DELETE' });
              return ok({ user_id: d.user_id, role_key: null });
            }
            const r = await insert('snorkel_user_roles',
              { user_id: d.user_id, role_key: d.role_key, assigned_by: userId, assigned_at: new Date().toISOString() }, true);
            if (!r.ok) return err('Assign failed: ' + JSON.stringify(r.data));
            return ok({ user_id: d.user_id, role_key: d.role_key });
          }

          // ── ASSET REGISTER (writes) ──────────────────────────────────
          case 'createAsset': {
            if (!canManageAssets(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.name) return err('name required');
            const sres = await rpc('next_seq', { seq_name: 'asset' });
            if (!sres.ok) return err('Sequence error: ' + JSON.stringify(sres.data));
            const asset_code = 'AST-' + String(sres.data).padStart(4, '0');
            const row = { asset_code, created_by: userId, created_by_name: authResult.fullName };
            ASSET_WRITE_FIELDS.forEach(f => { if (d[f] !== undefined) row[f] = normAsset(f, d[f]); });
            const r = await insert('assets', row, false);
            if (!r.ok) return err('Asset insert failed: ' + JSON.stringify(r.data));
            const created = Array.isArray(r.data) ? r.data[0] : r.data;
            await logAssetHistory(created.id, 'created', null, asset_code, d.name, authResult);
            return ok({ id: created.id, asset_code });
          }

          case 'updateAsset': {
            if (!canManageAssets(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.id) return err('id required');
            const cur = await query('assets', `?id=eq.${encodeURIComponent(d.id)}&limit=1`);
            if (!cur.ok || !cur.data[0]) return err('Asset not found', 404);
            const prev = cur.data[0];
            const updates = { updated_at: new Date().toISOString() };
            ASSET_WRITE_FIELDS.forEach(f => { if (d[f] !== undefined) updates[f] = normAsset(f, d[f]); });
            const r = await update('assets', updates, `id=eq.${encodeURIComponent(d.id)}`);
            if (!r.ok) return err('Update failed: ' + JSON.stringify(r.data));
            // Diff-aware history.
            let logged = false;
            if (updates.status !== undefined && updates.status !== prev.status) {
              await logAssetHistory(d.id, 'status_change', prev.status, updates.status, null, authResult); logged = true;
            }
            const custChanged = (updates.custodian_user_id !== undefined && updates.custodian_user_id !== prev.custodian_user_id)
                             || (updates.custodian_name !== undefined && updates.custodian_name !== prev.custodian_name);
            if (custChanged) {
              await logAssetHistory(d.id, 'custody_transfer', prev.custodian_name, updates.custodian_name ?? prev.custodian_name, null, authResult); logged = true;
            }
            if (updates.location_id !== undefined && updates.location_id !== prev.location_id) {
              await logAssetHistory(d.id, 'location_change', prev.location_id, updates.location_id, null, authResult); logged = true;
            }
            if (!logged) await logAssetHistory(d.id, 'updated', null, null, null, authResult);
            return ok({ updated: d.id });
          }

          case 'retireAsset': {
            if (!canManageAssets(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.id) return err('id required');
            const cur = await query('assets', `?id=eq.${encodeURIComponent(d.id)}&select=status&limit=1`);
            if (!cur.ok || !cur.data[0]) return err('Asset not found', 404);
            const r = await update('assets', {
              status: 'retired', retired_at: new Date().toISOString(),
              retired_reason: d.reason || null, updated_at: new Date().toISOString(),
            }, `id=eq.${encodeURIComponent(d.id)}`);
            if (!r.ok) return err('Retire failed: ' + JSON.stringify(r.data));
            await logAssetHistory(d.id, 'retired', cur.data[0].status, 'retired', d.reason || null, authResult);
            return ok({ retired: d.id });
          }

          case 'createAssetDocumentUploadUrl': {
            if (!canManageAssets(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.asset_id) return err('asset_id required');
            if (!d.file_name) return err('file_name required');
            const docType = d.doc_type || 'other';
            const path = `${d.asset_id}/${assetSafeSeg(docType)}/${Date.now()}_${assetSafeSeg(d.file_name)}`;
            const sr = await storageFetch(`/object/upload/sign/${ASSET_BUCKET}/${path}`, { method: 'POST' });
            if (!sr.ok || !sr.data?.url) return err(`sign_failed: ${JSON.stringify(sr.data)}`, 502);
            const tokenMatch = String(sr.data.url).match(/token=([^&]+)/);
            return ok({ storage_path: path, token: tokenMatch ? decodeURIComponent(tokenMatch[1]) : null, signed_url: sr.data.url });
          }

          case 'recordAssetDocument': {
            if (!canManageAssets(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.asset_id) return err('asset_id required');
            if (!d.storage_path) return err('storage_path required');
            const r = await insert('asset_documents', {
              asset_id: d.asset_id, doc_type: d.doc_type || 'other',
              file_name: d.file_name || null, storage_path: d.storage_path,
              mime_type: d.mime_type || null,
              uploaded_by: userId, uploaded_by_name: authResult.fullName,
            }, false);
            if (!r.ok) return err('Document record failed: ' + JSON.stringify(r.data));
            await logAssetHistory(d.asset_id, 'document_added', null, d.doc_type || 'other', d.file_name || null, authResult);
            return ok(Array.isArray(r.data) ? r.data[0] : r.data);
          }

          case 'deleteAssetDocument': {
            if (!canManageAssets(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.document_id) return err('document_id required');
            const dr = await query('asset_documents', `?id=eq.${encodeURIComponent(d.document_id)}&select=asset_id,storage_path,file_name&limit=1`);
            const doc = dr.ok ? dr.data?.[0] : null;
            const del = await sb(`/rest/v1/asset_documents?id=eq.${encodeURIComponent(d.document_id)}`, { method: 'DELETE', prefer: 'return=minimal' });
            if (!del.ok) return err('Delete failed: ' + JSON.stringify(del.data));
            if (doc?.storage_path) {
              const seg = String(doc.storage_path).split('/').map(encodeURIComponent).join('/');
              await storageFetch(`/object/${ASSET_BUCKET}/${seg}`, { method: 'DELETE' });
              await logAssetHistory(doc.asset_id, 'document_removed', doc.file_name || null, null, null, authResult);
            }
            return ok({ deleted: d.document_id });
          }

          case 'createAssetCategory':
          case 'createAssetLocation': {
            if (!canManageAssets(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.name) return err('name required');
            const tbl = body.action === 'createAssetCategory' ? 'asset_categories' : 'asset_locations';
            const r = await insert(tbl, {
              name: d.name, sort_order: d.sort_order != null ? Math.round(Number(d.sort_order)) : 0,
              is_active: d.is_active !== false,
            }, false);
            if (!r.ok) return err('Insert failed: ' + JSON.stringify(r.data));
            return ok(Array.isArray(r.data) ? r.data[0] : r.data);
          }

          case 'updateAssetCategory':
          case 'updateAssetLocation': {
            if (!canManageAssets(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.id) return err('id required');
            const tbl = body.action === 'updateAssetCategory' ? 'asset_categories' : 'asset_locations';
            const updates = {};
            if (d.name !== undefined)       updates.name = d.name;
            if (d.is_active !== undefined)  updates.is_active = !!d.is_active;
            if (d.sort_order !== undefined) updates.sort_order = Math.round(Number(d.sort_order));
            if (!Object.keys(updates).length) return err('nothing to update');
            const r = await update(tbl, updates, `id=eq.${encodeURIComponent(d.id)}`);
            if (!r.ok) return err('Update failed: ' + JSON.stringify(r.data));
            return ok({ updated: d.id });
          }

          // ══════════════════════════════════════════════════
          // OFFLINE SALES (writes)
          // ══════════════════════════════════════════════════
          case 'createSalesPartner': {
            if (!canSalesPartner(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.name) return err('name required');
            const partner_code = await nextSeq4('sales_partner', 'SP-');
            const row = { partner_code, created_by: userId };
            SALES_PARTNER_FIELDS.forEach(f => { if (d[f] !== undefined) row[f] = normSalesPartner(f, d[f]); });
            const r = await insert('sales_partners', row, false);
            if (!r.ok) return err('Partner insert failed: ' + JSON.stringify(r.data));
            const created = Array.isArray(r.data) ? r.data[0] : r.data;
            return ok({ id: created.id, partner_code });
          }

          case 'updateSalesPartner': {
            if (!canSalesPartner(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.id) return err('id required');
            const updates = { updated_at: new Date().toISOString() };
            SALES_PARTNER_FIELDS.forEach(f => { if (d[f] !== undefined) updates[f] = normSalesPartner(f, d[f]); });
            const r = await update('sales_partners', updates, `id=eq.${encodeURIComponent(d.id)}`);
            if (!r.ok) return err('Update failed: ' + JSON.stringify(r.data));
            return ok({ updated: d.id });
          }

          case 'createSalesChannel': {
            if (!canSalesPartner(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.channel_key || !d.label) return err('channel_key and label required');
            const r = await insert('sales_channels', {
              channel_key: String(d.channel_key).trim().toUpperCase(),
              label: d.label, dispatch_channel_id: d.dispatch_channel_id || null,
              is_active: d.is_active !== false, sort_order: Math.round(Number(d.sort_order) || 0),
              channel_type: d.channel_type || null,
              collection_type: (d.collection_type === 'manual' ? 'manual' : 'auto'),
              collection_period_days: d.collection_period_days != null ? Math.round(Number(d.collection_period_days)) : null,
              feeds_odo_sellout: !!d.feeds_odo_sellout,
            }, false);
            if (!r.ok) return err('Create failed: ' + JSON.stringify(r.data));
            return ok(Array.isArray(r.data) ? r.data[0] : r.data);
          }

          case 'updateSalesChannel': {
            if (!canSalesPartner(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.id) return err('id required');
            const updates = { updated_at: new Date().toISOString() };
            if (d.label !== undefined)               updates.label = d.label;
            if (d.dispatch_channel_id !== undefined) updates.dispatch_channel_id = d.dispatch_channel_id || null;
            if (d.is_active !== undefined)           updates.is_active = !!d.is_active;
            if (d.sort_order !== undefined)          updates.sort_order = Math.round(Number(d.sort_order) || 0);
            if (d.channel_type !== undefined)        updates.channel_type = d.channel_type || null;
            if (d.collection_type !== undefined)     updates.collection_type = (d.collection_type === 'manual' ? 'manual' : 'auto');
            if (d.collection_period_days !== undefined) updates.collection_period_days = d.collection_period_days === null ? null : Math.round(Number(d.collection_period_days));
            if (d.feeds_odo_sellout !== undefined)   updates.feeds_odo_sellout = !!d.feeds_odo_sellout;
            const r = await update('sales_channels', updates, `id=eq.${encodeURIComponent(d.id)}`);
            if (!r.ok) return err('Update failed: ' + JSON.stringify(r.data));
            return ok({ updated: d.id });
          }

          case 'createSalesOrder': {
            if (!canSalesManage(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.partner_id) return err('partner_id required');
            if (!d.lines?.length) return err('At least one order line required');
            const pr = await query('sales_partners', `?id=eq.${encodeURIComponent(d.partner_id)}&select=channel_key,default_credit_days&limit=1`);
            if (!pr.ok || !pr.data[0]) return err('Partner not found', 404);
            const partner = pr.data[0];
            const order_no = await nextSeq4('sales_order', 'SO-');
            const lines = d.lines.map(computeSalesLine);
            const subtotal    = +lines.reduce((s, l) => s + l.taxable_value, 0).toFixed(2);
            const tax_total   = +lines.reduce((s, l) => s + l.gst_amount, 0).toFixed(2);
            const grand_total = +(subtotal + tax_total).toFixed(2);
            const orderRow = {
              order_no, partner_id: d.partner_id,
              channel_key: d.channel_key || partner.channel_key || null,
              order_date: d.order_date || todayISO(),
              credit_days: d.credit_days != null ? Math.round(Number(d.credit_days)) : (partner.default_credit_days ?? 45),
              partner_po_ref: d.partner_po_ref || null,
              expected_dispatch_date: d.expected_dispatch_date || null,
              destination_warehouse: d.destination_warehouse || null,
              notes: d.notes || null,
              subtotal, tax_total, grand_total, created_by: userId,
            };
            const r = await insert('sales_orders', orderRow, false);
            if (!r.ok) return err('Order insert failed: ' + JSON.stringify(r.data));
            const order = Array.isArray(r.data) ? r.data[0] : r.data;
            const lineRows = lines.map((l, i) => ({ ...l, order_id: order.id, sort_order: l.sort_order || i }));
            const li = await insert('sales_order_lines', lineRows, false);
            if (!li.ok) return err('Line insert failed: ' + JSON.stringify(li.data));
            return ok({ id: order.id, order_no });
          }

          case 'updateSalesOrder': {
            if (!canSalesManage(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.id) return err('id required');
            const cur = await query('sales_orders', `?id=eq.${encodeURIComponent(d.id)}&select=status,invoice_generated&limit=1`);
            if (!cur.ok || !cur.data[0]) return err('Order not found', 404);
            if (cur.data[0].status !== 'draft' || cur.data[0].invoice_generated)
              return err('Only draft, un-invoiced orders can be edited', 422);
            const updates = { updated_at: new Date().toISOString() };
            ['channel_key','order_date','partner_po_ref','expected_dispatch_date','destination_warehouse','notes'].forEach(f => {
              if (d[f] !== undefined) updates[f] = d[f] || null;
            });
            if (d.credit_days !== undefined) updates.credit_days = Math.round(Number(d.credit_days) || 0);
            if (Array.isArray(d.lines)) {
              const lines = d.lines.map(computeSalesLine);
              updates.subtotal    = +lines.reduce((s, l) => s + l.taxable_value, 0).toFixed(2);
              updates.tax_total   = +lines.reduce((s, l) => s + l.gst_amount, 0).toFixed(2);
              updates.grand_total = +(updates.subtotal + updates.tax_total).toFixed(2);
              await sb(`/rest/v1/sales_order_lines?order_id=eq.${encodeURIComponent(d.id)}`, { method: 'DELETE', prefer: 'return=minimal' });
              const lineRows = lines.map((l, i) => ({ ...l, order_id: d.id, sort_order: l.sort_order || i }));
              const li = await insert('sales_order_lines', lineRows, false);
              if (!li.ok) return err('Line update failed: ' + JSON.stringify(li.data));
            }
            const r = await update('sales_orders', updates, `id=eq.${encodeURIComponent(d.id)}`);
            if (!r.ok) return err('Update failed: ' + JSON.stringify(r.data));
            return ok({ updated: d.id });
          }

          case 'cancelOrder': {
            if (!canSalesManage(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.id) return err('id required');
            if (!d.reason) return err('reason required');
            const cur = await query('sales_orders', `?id=eq.${encodeURIComponent(d.id)}&select=status,dispatch_shipment_id&limit=1`);
            if (!cur.ok || !cur.data[0]) return err('Order not found', 404);
            const o = cur.data[0];
            if (!['draft', 'confirmed'].includes(o.status)) return err('Only draft/confirmed orders can be cancelled', 422);
            // Legacy single-shipment orders (pre-fulfilment-flow).
            if (o.dispatch_shipment_id) {
              const shR = await queryPublic('dispatch_shipments', `?id=eq.${encodeURIComponent(o.dispatch_shipment_id)}&select=status&limit=1`);
              const shStatus = shR.ok ? shR.data?.[0]?.status : null;
              if (shStatus === 'shipped') return err('Goods already dispatched — handle as a return, not a cancel', 422);
              if (['draft', 'packing'].includes(shStatus))
                await sbPublic(`/rest/v1/dispatch_shipments?id=eq.${encodeURIComponent(o.dispatch_shipment_id)}`,
                  { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }), headers: { Prefer: 'return=minimal' } });
            }
            // New fulfilment-flow orders: cancel the request + its non-shipped child shipments.
            const fr = (await loadFulfilment([d.id]))[d.id];
            if (fr?.request) {
              if ((fr.shipments || []).some(s => s.status === 'shipped'))
                return err('Goods already dispatched — handle as a return, not a cancel', 422);
              if (['pending', 'accepted'].includes(fr.request.status))
                await sbPublic(`/rest/v1/dispatch_fulfilment_requests?id=eq.${encodeURIComponent(fr.request.id)}`,
                  { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }), headers: { Prefer: 'return=minimal' } });
              const openShipIds = (fr.shipments || []).filter(s => s.status !== 'shipped' && s.status !== 'cancelled').map(s => s.id);
              if (openShipIds.length)
                await sbPublic(`/rest/v1/dispatch_shipments?id=in.(${openShipIds.map(encodeURIComponent).join(',')})`,
                  { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }), headers: { Prefer: 'return=minimal' } });
            }
            const now = new Date().toISOString();
            const r = await update('sales_orders',
              { status: 'cancelled', cancelled_by: userId, cancelled_at: now, cancel_reason: d.reason, updated_at: now },
              `id=eq.${encodeURIComponent(d.id)}`);
            if (!r.ok) return err('Cancel failed: ' + JSON.stringify(r.data));
            return ok({ cancelled: d.id });
          }

          case 'confirmOrder': {
            if (!canSalesConfirm(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.id) return err('id required');
            const cur = await query('sales_orders', `?id=eq.${encodeURIComponent(d.id)}&select=*,sales_partners(name)&limit=1`);
            if (!cur.ok || !cur.data[0]) return err('Order not found', 404);
            const o = cur.data[0];
            if (o.status !== 'draft') return err('Only draft orders can be confirmed', 422);
            const linesR = await query('sales_order_lines', `?order_id=eq.${encodeURIComponent(d.id)}&order=sort_order.asc`);
            const lines = linesR.ok ? linesR.data : [];
            if (!lines.length) return err('Order has no lines', 422);
            // Resolve the dispatch channel + collection config for this sales channel.
            const chR = await query('sales_channels',
              `?channel_key=eq.${encodeURIComponent(o.channel_key || '')}&select=dispatch_channel_id,collection_type,collection_period_days&limit=1`);
            const ch = chR.ok ? chR.data?.[0] : null;
            const dispatchChannelId = ch?.dispatch_channel_id || null;
            if (!dispatchChannelId) return err('No dispatch channel mapped for this sales channel — set it in Sales → Settings', 422);
            const partnerName = o.sales_partners?.name || '';
            const requested_units = lines.reduce((s, l) => s + (Math.round(Number(l.qty)) || 0), 0);
            const title = [partnerName, o.destination_warehouse, o.order_no].filter(Boolean).join(' · ');
            // One-time fulfilment-request insert into public (Depot owns the lifecycle thereafter).
            const frRes = await sbPublic('/rest/v1/dispatch_fulfilment_requests', {
              method: 'POST', prefer: 'return=representation',
              body: JSON.stringify({
                sales_order_id: o.id, sales_order_no: o.order_no, channel_id: dispatchChannelId,
                destination_warehouse: o.destination_warehouse || null, partner_po_ref: o.partner_po_ref || null,
                partner_name: partnerName, title, requested_units, status: 'pending',
              }),
            });
            if (!frRes.ok || !frRes.data?.[0]) return err('Fulfilment request create failed: ' + JSON.stringify(frRes.data), 502);
            const requestId = frRes.data[0].id;
            const frLines = lines.map((l, i) => ({
              request_id: requestId, product: l.product, model: l.model || null, color: l.color || null,
              sku: l.sku || null, qty: Math.round(Number(l.qty)) || 0, sort_order: l.sort_order ?? i,
            }));
            const frlRes = await sbPublic('/rest/v1/dispatch_fulfilment_request_lines', {
              method: 'POST', body: JSON.stringify(frLines), headers: { Prefer: 'return=minimal' },
            });
            if (!frlRes.ok) return err('Request lines failed: ' + JSON.stringify(frlRes.data), 502);
            // credit_days: channel auto-period wins; else the order keeps its existing (partner-default) value.
            const now = new Date().toISOString();
            const confUpdates = { status: 'confirmed', confirmed_by: userId, confirmed_at: now, updated_at: now };
            if (ch?.collection_type === 'auto' && ch.collection_period_days != null)
              confUpdates.credit_days = Math.round(Number(ch.collection_period_days));
            await update('sales_orders', confUpdates, `id=eq.${encodeURIComponent(d.id)}`);
            return ok({ confirmed: d.id, request_no: frRes.data[0].request_no });
          }

          case 'generateInvoice': {
            if (!canSalesManage(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.id) return err('id required');
            const cur = await query('sales_orders', `?id=eq.${encodeURIComponent(d.id)}&select=*,sales_partners(state)&limit=1`);
            if (!cur.ok || !cur.data[0]) return err('Order not found', 404);
            const o = cur.data[0];
            if (o.status !== 'confirmed') return err('Order must be confirmed before invoicing', 422);
            if (o.invoice_generated) return err('Invoice already generated', 422);
            const linesR = await query('sales_order_lines', `?order_id=eq.${encodeURIComponent(d.id)}&select=hsn_code`);
            const missing = (linesR.ok ? linesR.data : []).filter(l => !l.hsn_code || !String(l.hsn_code).trim());
            if (missing.length) return err(`HSN code required on every line before invoicing (${missing.length} missing)`, 422);
            const date = todayISO();
            const invoice_no = await nextInvoiceNo(date);
            const r = await update('sales_orders',
              { invoice_no, invoice_date: date, invoice_generated: true,
                place_of_supply: o.sales_partners?.state || null, updated_at: new Date().toISOString() },
              `id=eq.${encodeURIComponent(d.id)}`);
            if (!r.ok) return err('Invoice failed: ' + JSON.stringify(r.data));
            return ok({ invoice_no, invoice_date: date });
          }

          case 'recordSalesPayment': {
            if (!canSalesPayment(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.order_id) return err('order_id required');
            const amt = Number(d.amount);
            if (!(amt > 0)) return err('amount must be greater than 0', 422);
            const ins = await insert('sales_payments', {
              order_id: d.order_id, amount: +amt.toFixed(2),
              received_date: d.received_date || todayISO(), mode: d.mode || 'bank',
              reference: d.reference || null, note: d.note || null,
              recorded_by: userId, recorded_by_name: authResult.fullName,
            }, false);
            if (!ins.ok) return err('Payment insert failed: ' + JSON.stringify(ins.data));
            await recomputeSalesPayment(d.order_id);
            return ok({ recorded: true });
          }

          case 'deleteSalesPayment': {
            if (!canSalesPayment(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.id) return err('id required');
            const pr = await query('sales_payments', `?id=eq.${encodeURIComponent(d.id)}&select=order_id&limit=1`);
            const orderId = pr.ok ? pr.data?.[0]?.order_id : null;
            const del = await sb(`/rest/v1/sales_payments?id=eq.${encodeURIComponent(d.id)}`, { method: 'DELETE', prefer: 'return=minimal' });
            if (!del.ok) return err('Delete failed: ' + JSON.stringify(del.data));
            if (orderId) await recomputeSalesPayment(orderId);
            return ok({ deleted: d.id });
          }

          case 'createCreditNote': {
            if (!canSalesCreditNote(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.order_id) return err('order_id required');
            if (!d.reason) return err('reason required');
            if (!d.lines?.length) return err('At least one credit line required');
            const oR = await query('sales_orders',
              `?id=eq.${encodeURIComponent(d.order_id)}&select=*,sales_partners(id,state)&limit=1`);
            if (!oR.ok || !oR.data[0]) return err('Order not found', 404);
            const o = oR.data[0];
            if (!o.invoice_generated) return err('Order has no invoice — cannot raise a credit note', 422);
            const { lines, subtotal, tax_total, grand_total } = buildCreditNote(d.lines);
            if (!(grand_total > 0)) return err('Credit value must be greater than 0', 422);
            const remaining = await creditCapRemaining(d.order_id, null);
            if (grand_total > remaining + 0.005)
              return err(`Credit ${grand_total} exceeds remaining invoice value ${remaining}`, 422);
            const hdr = await insert('sales_credit_notes', {
              order_id: d.order_id, partner_id: o.partner_id, invoice_no: o.invoice_no,
              invoice_date: o.invoice_date, cn_date: d.cn_date || todayISO(),
              reason: d.reason, reason_note: d.reason_note || null, status: 'draft',
              place_of_supply: o.place_of_supply || o.sales_partners?.state || null,
              subtotal, tax_total, grand_total, created_by: userId,
            }, false);
            if (!hdr.ok) return err('Credit note insert failed: ' + JSON.stringify(hdr.data));
            const cn = Array.isArray(hdr.data) ? hdr.data[0] : hdr.data;
            const lineRows = lines.map((l, i) => ({
              ...l, credit_note_id: cn.id,
              order_line_id: d.lines[i]?.order_line_id || null, sort_order: l.sort_order || i,
            }));
            const li = await insert('sales_credit_note_lines', lineRows, false);
            if (!li.ok) return err('Credit line insert failed: ' + JSON.stringify(li.data));
            return ok({ id: cn.id });
          }

          case 'updateCreditNote': {
            if (!canSalesCreditNote(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.id) return err('id required');
            const cur = await query('sales_credit_notes', `?id=eq.${encodeURIComponent(d.id)}&select=status,order_id&limit=1`);
            if (!cur.ok || !cur.data[0]) return err('Credit note not found', 404);
            if (cur.data[0].status !== 'draft') return err('Only draft credit notes can be edited', 422);
            const updates = { updated_at: new Date().toISOString() };
            if (d.reason !== undefined) updates.reason = d.reason;
            if (d.reason_note !== undefined) updates.reason_note = d.reason_note || null;
            if (d.cn_date !== undefined) updates.cn_date = d.cn_date || todayISO();
            if (Array.isArray(d.lines)) {
              const { lines, subtotal, tax_total, grand_total } = buildCreditNote(d.lines);
              if (!(grand_total > 0)) return err('Credit value must be greater than 0', 422);
              const remaining = await creditCapRemaining(cur.data[0].order_id, d.id);
              if (grand_total > remaining + 0.005)
                return err(`Credit ${grand_total} exceeds remaining invoice value ${remaining}`, 422);
              updates.subtotal = subtotal; updates.tax_total = tax_total; updates.grand_total = grand_total;
              await sb(`/rest/v1/sales_credit_note_lines?credit_note_id=eq.${encodeURIComponent(d.id)}`, { method: 'DELETE', prefer: 'return=minimal' });
              const lineRows = lines.map((l, i) => ({ ...l, credit_note_id: d.id, order_line_id: d.lines[i]?.order_line_id || null, sort_order: l.sort_order || i }));
              const li = await insert('sales_credit_note_lines', lineRows, false);
              if (!li.ok) return err('Credit line update failed: ' + JSON.stringify(li.data));
            }
            const r = await update('sales_credit_notes', updates, `id=eq.${encodeURIComponent(d.id)}`);
            if (!r.ok) return err('Update failed: ' + JSON.stringify(r.data));
            return ok({ updated: d.id });
          }

          case 'issueCreditNote': {
            if (!canSalesCreditNote(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.id) return err('id required');
            const cur = await query('sales_credit_notes', `?id=eq.${encodeURIComponent(d.id)}&select=*&limit=1`);
            if (!cur.ok || !cur.data[0]) return err('Credit note not found', 404);
            const cn = cur.data[0];
            if (cn.status !== 'draft') return err('Only draft credit notes can be issued', 422);
            const remaining = await creditCapRemaining(cn.order_id, cn.id);
            if (Number(cn.grand_total) > remaining + 0.005)
              return err(`Credit ${cn.grand_total} exceeds remaining invoice value ${remaining}`, 422);
            const date = cn.cn_date || todayISO();
            const cn_no = await nextCreditNoteNo(date);
            const now = new Date().toISOString();
            const r = await update('sales_credit_notes',
              { cn_no, status: 'issued', cn_date: date, issued_by: userId, issued_at: now, updated_at: now },
              `id=eq.${encodeURIComponent(d.id)}`);
            if (!r.ok) return err('Issue failed: ' + JSON.stringify(r.data));
            await recomputeOrderCredit(cn.order_id);
            return ok({ cn_no });
          }

          case 'cancelCreditNote': {
            if (!canSalesCreditNote(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.id) return err('id required');
            if (!d.reason) return err('reason required');
            const cur = await query('sales_credit_notes', `?id=eq.${encodeURIComponent(d.id)}&select=status,order_id&limit=1`);
            if (!cur.ok || !cur.data[0]) return err('Credit note not found', 404);
            if (!['draft','issued'].includes(cur.data[0].status)) return err('Only draft/issued credit notes can be cancelled', 422);
            const now = new Date().toISOString();
            const r = await update('sales_credit_notes',
              { status: 'cancelled', cancelled_by: userId, cancelled_at: now, cancel_reason: d.reason, updated_at: now },
              `id=eq.${encodeURIComponent(d.id)}`);
            if (!r.ok) return err('Cancel failed: ' + JSON.stringify(r.data));
            await recomputeOrderCredit(cur.data[0].order_id);
            return ok({ cancelled: d.id });
          }

          case 'deleteCreditNote': {
            if (!canSalesCreditNote(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.id) return err('id required');
            const cur = await query('sales_credit_notes', `?id=eq.${encodeURIComponent(d.id)}&select=status&limit=1`);
            if (!cur.ok || !cur.data[0]) return err('Credit note not found', 404);
            if (cur.data[0].status !== 'draft') return err('Only draft credit notes can be deleted', 422);
            const del = await sb(`/rest/v1/sales_credit_notes?id=eq.${encodeURIComponent(d.id)}`, { method: 'DELETE', prefer: 'return=minimal' });
            if (!del.ok) return err('Delete failed: ' + JSON.stringify(del.data));
            return ok({ deleted: d.id });
          }

          default:
            return err('Unknown action: ' + body.action, 400);
        }
      }

      return err('Method not allowed', 405);
    } catch (e) {
      console.error('snorkelops error:', e);
      return err('Server error: ' + (e?.message || String(e)), 500);
    }
  },
};
