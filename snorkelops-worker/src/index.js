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
// Payment Requests (replaces the #payments Slack channel). `payment_request` is broad — every
// human role carries it. The other three are named-individual authority over money and arrive
// from store.payment_grants, not from the role.
const canPayRequest    = p => !!p.payment_request;
const canPayApprove    = p => !!p.payment_approve;
const canPayExecute    = p => !!p.payment_execute;
const canPaySuperAdmin = p => !!p.payment_super_admin;
const canPayBankView   = p => !!p.payment_bank_view;
const canPayPayeeManage = p => !!p.payment_payee_manage || !!p.payment_request;

// Bank details are read-gated. A requester may WRITE them when creating a payee (they already
// paste them into Slack today) but may never read one back — everyone without payment_bank_view
// sees the account masked to the last 4. Gate at the query, never in the UI.
// In-app notification fan-out. Deliberately best-effort: a notification that fails to write must
// never fail the payment action that caused it — the money workflow is the product, the bell is not.
async function notify(rows) {
  const list = (rows || []).filter(r => r && r.user_id);
  if (!list.length) return;
  try { await insert('payment_notifications', list); } catch { /* never block the caller */ }
}
// Everyone currently holding a live payment grant of a given kind.
async function grantHolders(grantKey) {
  const r = await sb(`/rest/v1/payment_grants?grant_key=eq.${grantKey}&active=is.true&select=user_id`);
  return (r.ok ? r.data : []).map(x => x.user_id);
}

function maskBank(row, allowed) {
  if (!row) return row;
  if (allowed) return row;
  const acc = String(row.account_number || '');
  return {
    ...row,
    account_number: acc ? '••••' + acc.slice(-4) : null,
    ifsc: row.ifsc ? String(row.ifsc).slice(0, 4) + '••••' : null,
    upi_id: row.upi_id ? '••••' : null,
    masked: true,
  };
}

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
  const [ur, gr] = await Promise.all([
    sb(`/rest/v1/snorkel_user_roles?user_id=eq.${userId}&select=role_key&limit=1`),
    // Named money authority. NOT a role permission: snorkel_user_roles is PK(user_id) — one
    // role per user — so an approver cannot also be an admin, and putting payment_approve on
    // the `admin` role would hand it to every admin holder. See store.payment_grants.
    sb(`/rest/v1/payment_grants?user_id=eq.${userId}&active=is.true&select=grant_key`),
  ]);
  const grants = {};
  if (gr.ok) for (const g of gr.data || []) {
    if (g.grant_key === 'approve')     grants.payment_approve     = true;
    if (g.grant_key === 'execute')     grants.payment_execute     = true;
    if (g.grant_key === 'super_admin') grants.payment_super_admin = true;
  }
  if (!ur.ok || !ur.data[0]) return { __role: null, perms: { ...grants } };
  const roleKey = ur.data[0].role_key;
  const r = await sb(`/rest/v1/snorkel_roles?role_key=eq.${encodeURIComponent(roleKey)}&select=permissions&limit=1`);
  return { __role: roleKey, perms: { ...((r.ok && r.data[0]?.permissions) || {}), ...grants } };
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
// ── HSN: default from the product master, and sync corrections back ────────────────
// (Afshaan 2026-07-27.) Nobody should be typing a tax code from memory — 50 live
// un-invoiced lines had none at all. So lines default their HSN + GST% from
// public.product_master, the team confirms or corrects on the order, and a correction
// flows BACK onto the master.
//
// Write-back is per product FAMILY, not per variant: 1,140 invoiced lines show exactly
// ONE distinct HSN per product, so updating a single variant would leave its siblings
// stale and silently wrong on the next order.
const normHsn = v => String(v ?? '').replace(/\s+/g, '').trim();
const isPlausibleHsn = v => /^\d{4,8}$/.test(normHsn(v));

// One cheap read of the whole active master (~146 rows) — avoids per-product lookups
// and any PostgREST in.() quoting trouble with names like "HP desk standee".
async function hsnMasterAll() {
  const out = new Map();
  const pmR = await queryPublic('product_master', '?is_active=eq.true&select=product,hsn_code&limit=5000');
  const rows = (pmR.ok && Array.isArray(pmR.data)) ? pmR.data : [];
  const codes = new Set();
  for (const r of rows) {
    if (!r.hsn_code || out.has(r.product)) continue;
    const h = normHsn(r.hsn_code);
    out.set(r.product, { hsn: h, gst: null });
    codes.add(h);
  }
  if (codes.size) {
    const rR = await query('hsn_gst_rates', `?hsn_code=in.(${[...codes].join(',')})&select=hsn_code,gst_percent`);
    const gst = new Map(((rR.ok && Array.isArray(rR.data)) ? rR.data : [])
      .map(r => [normHsn(r.hsn_code), Number(r.gst_percent)]));
    for (const [p, v] of out) if (gst.has(v.hsn)) v.gst = gst.get(v.hsn);
  }
  return out;
}

// Fill ONLY what the user left blank — never overwrite a code they actually typed.
function applyHsnDefaults(lines, master) {
  return (lines || []).map(l => {
    const m = master.get(l.product);
    if (!m) return l;
    const out = { ...l };
    if (!normHsn(out.hsn_code)) out.hsn_code = m.hsn;
    const gstBlank = out.gst_pct === undefined || out.gst_pct === null || out.gst_pct === '';
    if (gstBlank && m.gst != null) out.gst_pct = m.gst;
    return out;
  });
}

// Products the HSN master cannot answer for. applyHsnDefaults silently no-ops on
// these, so the line keeps the form's 18% default — indistinguishable from a real
// 18% rate. SO-0431 (2026-08-22) invoiced a 5% product at 18% exactly this way.
// Never guess the rate here; name the gap so the caller can surface it loudly.
function hsnGaps(lines, master) {
  const gaps = new Set();
  for (const l of (lines || [])) {
    if (!l.product) continue;
    const m = master.get(l.product);
    if (!m || !m.hsn || m.gst == null) gaps.add(l.product);
  }
  return [...gaps];
}

// One PO line per mould, enforced at every line-write. Receiving explodes each
// mould line into the mould's FULL part list, so a second line for the same mould
// tells the store to expect every part twice — the SHP-219/221 double-count
// (2026-08-24). The two-lines-for-two-rates workaround is exactly the harmful
// case; split-colour pricing is the pending shot-group change, not a second line.
function duplicateMould(lines, existing) {
  const seen = new Set((existing || []).map(l => String(l.mould_no || '').trim()).filter(Boolean));
  for (const l of (lines || [])) {
    const m = String(l.mould_no || '').trim();
    if (!m) continue;
    if (seen.has(m)) return m;
    seen.add(m);
  }
  return null;
}

// Push corrected codes back onto every active variant of the family. Guarded so a
// blank or a typo can never wipe/corrupt the master, and every write is logged.
async function syncHsnToMaster(lines, master, actor, actorRole, orderNo) {
  const changes = new Map();
  for (const l of (lines || [])) {
    const v = normHsn(l.hsn_code);
    if (!v || !isPlausibleHsn(v)) continue;          // never blank the master, never store junk
    const cur = master.get(l.product)?.hsn || null;
    if (cur === v) continue;
    changes.set(l.product, { from: cur, to: v });
  }
  const applied = [];
  for (const [product, ch] of changes) {             // at most a few products per order
    const r = await sbPublic(
      `/rest/v1/product_master?product=eq.${encodeURIComponent(product)}&is_active=eq.true`,
      { method: 'PATCH', body: JSON.stringify({ hsn_code: ch.to }), prefer: 'return=representation' });
    if (!r.ok) continue;                             // never fail the order over the master sync
    const n = Array.isArray(r.data) ? r.data.length : 0;
    applied.push({ product, from: ch.from, to: ch.to, variants: n });
    await logActivity(actor, actorRole, 'HSN_MASTER_SYNC', 'PRODUCT', product,
      `HSN ${ch.from || '(none)'} → ${ch.to} for ${product} (${n} variant${n === 1 ? '' : 's'})${orderNo ? ` from ${orderNo}` : ''}`,
      { product, from: ch.from, to: ch.to, variants: n, order_no: orderNo || null });
  }
  return applied;
}

// ── The same HSN contract for PARTS / POs (Afshaan 2026-07-27) ────────────────────
// The PO form already pre-filled HSN (BOM-add, mould-add, part picker) and already
// derived GST% from HSN — but every path read bom_register.hsn_code, which is EMPTY
// for all 1,447 active parts, so the pre-fill always produced a blank. That is why
// ~401 of 472 non-cancelled INR PO lines carry no HSN despite RULE-PO-001.
// store.material_master.hsn_code is now the master (one row per part_code, vs
// bom_register's one row per product+part which can disagree across products).
async function partHsnMasterAll() {
  const out = new Map();
  const r = await query('material_master',
    '?is_active=eq.true&hsn_code=not.is.null&select=part_code,hsn_code&limit=5000');
  const rows = (r.ok && Array.isArray(r.data)) ? r.data : [];
  const codes = new Set();
  for (const row of rows) {
    if (!row.hsn_code || out.has(row.part_code)) continue;
    const h = normHsn(row.hsn_code);
    out.set(row.part_code, { hsn: h, gst: null });
    codes.add(h);
  }
  if (codes.size) {
    const rr = await query('hsn_gst_rates', `?hsn_code=in.(${[...codes].join(',')})&select=hsn_code,gst_percent`);
    const gst = new Map(((rr.ok && Array.isArray(rr.data)) ? rr.data : [])
      .map(x => [normHsn(x.hsn_code), Number(x.gst_percent)]));
    for (const [, v] of out) if (gst.has(v.hsn)) v.gst = gst.get(v.hsn);
  }
  return out;
}

function applyPartHsnDefaults(lines, master) {
  return (lines || []).map(l => {
    const m = l.part_code ? master.get(l.part_code) : null;
    if (!m) return l;
    const out = { ...l };
    if (!normHsn(out.hsn_code)) out.hsn_code = m.hsn;
    const gstBlank = out.gst_percent === undefined || out.gst_percent === null || out.gst_percent === '';
    if (gstBlank && m.gst != null) out.gst_percent = m.gst;
    return out;
  });
}

// Corrections flow back onto the part. Keyed on part_code, so — unlike the product
// side — this touches exactly one row and no family fan-out is involved.
async function syncPartHsnToMaster(lines, master, actor, actorRole, poNumber) {
  const changes = new Map();
  for (const l of (lines || [])) {
    if (!l.part_code) continue;
    const v = normHsn(l.hsn_code);
    if (!v || !isPlausibleHsn(v)) continue;        // never blank the master, never store junk
    const cur = master.get(l.part_code)?.hsn || null;
    if (cur === v) continue;
    changes.set(l.part_code, { from: cur, to: v });
  }
  const applied = [];
  for (const [part_code, ch] of changes) {
    const r = await update('material_master', { hsn_code: ch.to, updated_at: new Date().toISOString() },
      `part_code=eq.${encodeURIComponent(part_code)}`);
    if (!r.ok) continue;                            // never fail the PO over the master sync
    applied.push({ part_code, from: ch.from, to: ch.to });
    await logActivity(actor, actorRole, 'HSN_MASTER_SYNC', 'PART', part_code,
      `HSN ${ch.from || '(none)'} → ${ch.to} for ${part_code}${poNumber ? ` from ${poNumber}` : ''}`,
      { part_code, from: ch.from, to: ch.to, po_number: poNumber || null });
  }
  return applied;
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
// Per-LINE fulfilment for one order (Ram, #bugs 2026-08-28: "when an order is partially
// fulfilled it is not reflected onto Snorkel to see what has been fulfilled and what is
// pending"). The order-level `partially_fulfilled` pill already existed; what sales and
// finance could not see was WHICH items were short — SO-0410 read "partially fulfilled"
// with no way to learn that the three outstanding items were Flare LE Race Black, Knox
// Explorer Black and Knox Adventure Red.
//
// ⚠️ `packed_qty`, NOT `target_qty`. The order-level roll-up above sums target_qty, which is
// what the manifest PLANNED — fine for "is there a shipment", wrong for "what actually went".
// A line packed short would report as fully sent, which is precisely the follow-up this is
// meant to support.
// ⚠️ Cancelled shipments are excluded; a cancelled shipment sent nothing.
// ⚠️ Matched on product+model+colour because dispatch lines carry no sales-order line id.
// Colour/model are compared as ''-normalised strings so a NULL on one side does not silently
// fail to match a '' on the other and report a shipped line as pending.
async function withLineFulfilment(lines, f) {
  const rows = Array.isArray(lines) ? lines : [];
  // ⚠️ MUST mirror getSalesOrder's own `shipments` fallback. A pre-cutover order has NO
  // fulfilment request — it links to a single shipment via sales_orders.dispatch_shipment_id —
  // so reading `f.shipments` alone returns [], the early return fires, and every line reports
  // "Sent 0 / Pending all" on an order that has ALREADY SHIPPED. Caught by hostile review
  // before it reached anyone: 4 confirmed legacy orders, all 4 shipped, 9 lines, and this is
  // the very screen sales and finance were told to chase outstanding items from — so the
  // failure direction is "go chase a delivered order", the worst one available.
  const all = (f?.shipments?.length ? f.shipments : (f?.legacyShipment ? [f.legacyShipment] : []));
  const shipments = all.filter(s => s.status !== 'cancelled');
  if (!rows.length || !shipments.length) {
    // Genuinely nothing dispatched: everything is honestly outstanding, and saying so beats
    // omitting the fields and leaving the UI unable to tell "nothing sent" from "unknown".
    return rows.map(l => ({ ...l, shipped_qty: 0, packed_qty: 0, pending_qty: Math.round(Number(l.qty)) || 0 }));
  }
  const shIds = shipments.map(s => s.id);
  const shipped = new Set(shipments.filter(s => s.status === 'shipped').map(s => s.id));
  const lnR = await queryPublic('dispatch_shipment_lines',
    `?shipment_id=in.(${shIds.map(encodeURIComponent).join(',')})&select=shipment_id,product,model,color,target_qty,packed_qty`);
  // ⚠️ WHITESPACE-INSENSITIVE, not just trimmed. `store.sales_order_lines` holds one line
  // spelled "Mc Cloud" while every dispatch line says "McCloud" (RULE-NAME-001's canonical
  // form) — a trim-and-lowercase key leaves those unequal, so that shipped line would read as
  // pending forever. Verified safe before widening: squashing whitespace across every distinct
  // variant in BOTH tables produces exactly ONE collision, and it is those two spellings of the
  // same product — zero genuinely different variants collide (measured 2026-08-28). The data
  // row is corrected separately; this makes the next drift harmless rather than silent.
  const key = (p, m, c) => [p, m, c]
    .map(x => String(x ?? '').toLowerCase().replace(/\s+/g, ''))
    .join('|');
  const sentBy = {};   // packed AND despatched
  const packedBy = {}; // packed but NOT yet despatched — the two buckets are disjoint, so
                       // the pools below can be drained independently without double-counting
                       // a unit as both sent and waiting.
  for (const dl of (lnR.ok && Array.isArray(lnR.data) ? lnR.data : [])) {
    const k = key(dl.product, dl.model, dl.color);
    const q = Math.round(Number(dl.packed_qty)) || 0;
    if (shipped.has(dl.shipment_id)) sentBy[k] = (sentBy[k] || 0) + q;
    else packedBy[k] = (packedBy[k] || 0) + q;
  }
  // ⚠️ ALLOCATE across lines, never look up per line. Dispatch lines carry no sales-order
  // line id, so the match is on variant — and duplicate-variant lines are common: 179
  // duplicated variant GROUPS across 140 of 504 orders, i.e. 28% of orders (re-measured
  // 2026-08-28 by hostile review; this line first said "179 orders", which was the group
  // count wearing the wrong denominator). A plain per-line lookup would hand each of
  // them the SAME shipped figure, so a 2×1-unit order with 1 unit sent would read as 2
  // shipped and 0 pending: an order still owing a unit would look complete. Drain a shared
  // pool in sort order instead, filling each line up to its own ordered qty.
  const sentPool = { ...sentBy };
  const packedPool = { ...packedBy };
  const take = (pool, k, want) => {
    const got = Math.min(pool[k] || 0, want);
    pool[k] = (pool[k] || 0) - got;
    return got;
  };
  return rows.map(l => {
    const k = key(l.product, l.model, l.color);
    const ordered = Math.round(Number(l.qty)) || 0;
    const sent = take(sentPool, k, ordered);
    // Packed but not yet gone — shown separately so "3 pending" never quietly includes
    // items already boxed and waiting on the van.
    const packedStill = take(packedPool, k, Math.max(0, ordered - sent));
    return { ...l, shipped_qty: sent, packed_qty: packedStill, pending_qty: Math.max(0, ordered - sent) };
  });
}

// Batched loader: orders[] → { [sales_order_id]: { request, shipments:[{...,_shipped_units}], legacyShipment } }.
// New orders link via a fulfilment request; legacy (pre-cutover) orders link via the single
// sales_orders.dispatch_shipment_id — both paths resolved here so historical orders keep their dates/status.
// Accepts order OBJECTS (the normal case) or bare id strings.
// ⚠️ A bare string used to map to `undefined`, so `ids` came back empty and the whole
// helper silently returned {} — no error, no log, indistinguishable from "this order has
// no fulfilment request". That is exactly how cancelOrder's fulfilment-cancellation AND
// its already-dispatched guard sat dead (S308). Normalise here so the class cannot recur
// at a future call site; object callers are unchanged.
async function loadFulfilment(orders) {
  const list = (orders || []).filter(Boolean).map(o => (typeof o === 'string' ? { id: o } : o));
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
const PAYMENT_BUCKET = 'payment-docs';
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

// Vendor creation, extracted S328 so there is exactly ONE minting path. Called by the
// `postVendor` action (a Snorkel user) AND by the /bridge/vendor hop (lotopsproxy's Direct
// Issuance form). ⛔ Do NOT reimplement this anywhere: two code paths minting vendor codes is the
// duplicate-path class that keeps biting this codebase, and this one derives max+1 from LIVE DATA
// precisely because bulk imports bypass the sequences counter.
async function createVendorRow(d, createdBy) {
  if (!d || !d.vendor_name) return { ok: false, error: 'vendor_name required' };
  const iso    = countryToISO(d.source_country || 'Other');
  const prefix = `${iso}-VND-`;
  const maxR = await query('vendors',
    `?vendor_code=like.${encodeURIComponent(prefix)}*&order=vendor_code.desc&limit=1&select=vendor_code`);
  if (!maxR.ok) return { ok: false, error: 'Vendor max lookup failed: ' + JSON.stringify(maxR.data) };
  const lastCode = maxR.data?.[0]?.vendor_code || '';
  const lastNum  = parseInt(lastCode.slice(prefix.length), 10) || 0;
  const code     = `${prefix}${String(lastNum + 1).padStart(3, '0')}`;
  const r = await insert('vendors', {
    vendor_code: code, vendor_name: d.vendor_name, category: d.category || null,
    source_country: d.source_country || 'India', country_iso: iso,
    location: d.location || null, contact_name: d.contact_name || null,
    contact_phone: d.contact_phone || null, contact_email: d.contact_email || null,
    address: d.address || null, payment_terms: d.payment_terms || null,
    currency: d.currency || 'INR', lead_time_days: d.lead_time_days || null,
    notes: d.notes || null, active: true, created_by: createdBy,
  });
  if (!r.ok) return { ok: false, error: 'Vendor insert failed: ' + JSON.stringify(r.data) };
  return { ok: true, vendor_code: code };
}

export default {
  async fetch(request, env) {
    SUPABASE_SERVICE_KEY = env.SUPABASE_SERVICE_KEY || '';
    if (request.method === 'OPTIONS')
      return new Response(null, { headers: CORS });

    // ── Internal bridge: vendor create for lotopsproxy's Direct Issuance form (S328) ──
    // MUST sit ahead of verifyJWT: this is a worker-to-worker call over a [[services]] binding
    // and carries NO user JWT. The caller has already gated on the LOTOPS permission layer
    // (direct_issuance_request via store.roles), which this worker cannot see — the two systems
    // run different permission layers by design (CORE.md).
    // ⛔ Scope-limited to ONE action on purpose. Do not grow this into a general proxy.
    {
      const bridgeUrl = new URL(request.url);
      if (bridgeUrl.pathname === '/bridge/vendor' && request.method === 'POST') {
        const tok = env.SNORKELOPS_BRIDGE_TOKEN || '';
        const got = request.headers.get('x-bridge-token') || '';
        // Fail CLOSED when the secret is unset — an absent token must never mean "allow".
        if (!tok || got !== tok) return err('Unauthorised', 401);
        let bd = {};
        try { bd = await request.json(); } catch { return err('Bad JSON'); }
        const out = await createVendorRow(bd.data || bd, bd.created_by || 'lotops-di-bridge');
        if (!out.ok) return err(out.error);
        return ok({ vendor_code: out.vendor_code });
      }
    }

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

          // ══════════════════════════════════════════════════
          // PAYMENT REQUESTS
          // ══════════════════════════════════════════════════
          case 'getPaymentBootstrap': {
            if (!canPayRequest(P)) return err('No permission', 403);
            const [cats, settings, payees] = await Promise.all([
              query('payment_categories', '?is_active=is.true&order=sort_order.asc&select=*'),
              query('payment_settings', '?id=eq.1&limit=1&select=*'),
              query('payment_payees', '?is_active=is.true&order=name.asc&select=id,payee_code,name,payee_type,gstin,linked_vendor_code'),
            ]);
            return ok({
              categories: cats.ok ? cats.data : [],
              settings:   settings.ok ? (settings.data[0] || null) : null,
              payees:     payees.ok ? payees.data : [],
              can: {
                request: canPayRequest(P), approve: canPayApprove(P), execute: canPayExecute(P),
                super_admin: canPaySuperAdmin(P), bank_view: canPayBankView(P),
                payee_manage: canPayPayeeManage(P),
              },
            });
          }

          case 'getPaymentRequests': {
            if (!canPayRequest(P)) return err('No permission', 403);
            const scope  = url.searchParams.get('scope') || 'mine';
            const status = url.searchParams.get('status') || '';
            let q = '?select=*,payee:payment_payees(id,payee_code,name,payee_type)&order=requested_at.desc&limit=400';
            // A plain requester sees only their own. Approver/executor/super-admin see the queues.
            const privileged = canPayApprove(P) || canPayExecute(P) || canPaySuperAdmin(P);
            if (scope === 'mine' || !privileged) q += `&requested_by_user_id=eq.${userId}`;
            // ⚠️ `scope` PINS a status. An explicit `status=` used to be ANDed on top of that pin,
            // emitting TWO contradictory `status=eq.` filters — PostgREST ANDs them into an
            // always-false predicate and returns an empty list with HTTP 200 and no error. A silent
            // lie is worse than a rejection, so the two are now mutually exclusive: say which you mean.
            // (No caller sent both — the UI passes `scope` only — so this was a trap for the next one.)
            const pinned = scope === 'approvals' ? 'pending_approval'
                         : scope === 'finance'   ? 'approved'
                         : null;
            if (pinned && status && status !== pinned) {
              return err(`scope=${scope} already filters status=${pinned}; drop the explicit status= or use scope=mine`, 400);
            }
            if (pinned) q += `&status=eq.${pinned}`;
            else if (status) q += `&status=eq.${encodeURIComponent(status)}`;
            const r = await query('payment_requests', q);
            if (!r.ok) return err(r.data);
            return ok({ requests: r.data, scope, privileged });
          }

          case 'getPaymentRequest': {
            if (!canPayRequest(P)) return err('No permission', 403);
            const id = url.searchParams.get('id');
            if (!id) return err('id required');
            const r = await query('payment_requests',
              `?id=eq.${encodeURIComponent(id)}&select=*,payee:payment_payees(*)&limit=1`);
            if (!r.ok || !r.data[0]) return err('Not found', 404);
            const req = r.data[0];
            const privileged = canPayApprove(P) || canPayExecute(P) || canPaySuperAdmin(P);
            if (req.requested_by_user_id !== userId && !privileged) return err('Not found', 404);
            const [docs, banks] = await Promise.all([
              query('payment_request_documents', `?request_id=eq.${encodeURIComponent(id)}&order=uploaded_at.asc&select=*`),
              query('payment_payee_banks', `?payee_id=eq.${req.payee_id}&is_active=is.true&select=*`),
            ]);
            // Running total already requested against this (payee, invoice_no) — drives the
            // part-payment balance line and the duplicate warning.
            let related = [];
            if (req.invoice_no) {
              const rel = await query('payment_requests',
                `?payee_id=eq.${req.payee_id}&invoice_no=eq.${encodeURIComponent(req.invoice_no)}` +
                `&status=neq.rejected&id=neq.${encodeURIComponent(id)}&select=request_no,status,amount_to_pay,requested_at,requested_by_name`);
              if (rel.ok) related = rel.data;
            }
            return ok({
              request: req,
              documents: docs.ok ? docs.data : [],
              banks: (banks.ok ? banks.data : []).map(b => maskBank(b, canPayBankView(P))),
              related,
            });
          }

          // The finance worklist. Deliberately ONE call that carries everything needed to actually
          // pay: amount, payee, the default bank account, and the invoice doc ids. Without the bank
          // details on screen, finance has to open every request one at a time, which is the
          // Slack workflow again with extra steps.
          case 'getFinanceQueue': {
            if (!canPayExecute(P) && !canPaySuperAdmin(P)) return err('No permission', 403);
            const r = await query('payment_requests',
              '?status=eq.approved&select=*,payee:payment_payees(id,payee_code,name,payee_type)' +
              '&order=is_urgent.desc,needed_by.asc,requested_at.asc&limit=300');
            if (!r.ok) return err(r.data);
            const rows = r.data || [];
            if (!rows.length) return ok({ requests: [], banks: {}, documents: {} });

            const payeeIds = [...new Set(rows.map(x => x.payee_id).filter(Boolean))];
            const reqIds   = rows.map(x => x.id);
            // batched, never a lookup per row
            const [bk, dz] = await Promise.all([
              payeeIds.length
                ? query('payment_payee_banks',
                    `?payee_id=in.(${payeeIds.join(',')})&is_active=is.true&select=*`)
                : { ok: true, data: [] },
              query('payment_request_documents',
                `?request_id=in.(${reqIds.join(',')})&select=id,request_id,doc_kind,file_name`),
            ]);
            const banks = {};
            if (bk.ok) for (const b of bk.data) {
              // default first, so the UI can take banks[payee][0] safely
              (banks[b.payee_id] ||= []).push(maskBank(b, canPayBankView(P) || canPayExecute(P)));
              banks[b.payee_id].sort((x, y) => (y.is_default === true) - (x.is_default === true));
            }
            const documents = {};
            if (dz.ok) for (const d of dz.data) (documents[d.request_id] ||= []).push(d);
            return ok({ requests: rows, banks, documents });
          }

          case 'getPaymentNotifications': {
            if (!canPayRequest(P)) return err('No permission', 403);
            const r = await query('payment_notifications',
              `?user_id=eq.${userId}&order=created_at.desc&limit=50&select=*`);
            if (!r.ok) return err(r.data);
            const rows = r.data || [];
            return ok({ notifications: rows, unread: rows.filter(n => !n.read_at).length });
          }

          case 'getPaymentPayees': {
            if (!canPayRequest(P)) return err('No permission', 403);
            const r = await query('payment_payees', '?order=name.asc&select=*');
            if (!r.ok) return err(r.data);
            return ok({ payees: r.data });
          }

          case 'getPaymentPayeeBanks': {
            if (!canPayRequest(P)) return err('No permission', 403);
            const pid = url.searchParams.get('payee_id');
            if (!pid) return err('payee_id required');
            const r = await query('payment_payee_banks',
              `?payee_id=eq.${encodeURIComponent(pid)}&is_active=is.true&order=is_default.desc&select=*`);
            if (!r.ok) return err(r.data);
            return ok({ banks: r.data.map(b => maskBank(b, canPayBankView(P))) });
          }

          case 'getPaymentDocUrl': {
            if (!canPayRequest(P)) return err('No permission', 403);
            const docId = url.searchParams.get('doc_id');
            if (!docId) return err('doc_id required');
            const d = await query('payment_request_documents', `?id=eq.${encodeURIComponent(docId)}&select=*&limit=1`);
            if (!d.ok || !d.data[0]) return err('Not found', 404);
            const doc = d.data[0];
            const req = await query('payment_requests', `?id=eq.${doc.request_id}&select=requested_by_user_id&limit=1`);
            const privileged = canPayApprove(P) || canPayExecute(P) || canPaySuperAdmin(P);
            if (!req.ok || !req.data[0]) return err('Not found', 404);
            if (req.data[0].requested_by_user_id !== userId && !privileged) return err('Not found', 404);
            const sr = await storageFetch(`/object/sign/${PAYMENT_BUCKET}/${doc.file_path}`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ expiresIn: 3600 }),
            });
            if (!sr.ok || !sr.data?.signedURL) return err('sign_failed', 502);
            return ok({ url: `${SUPABASE_URL}/storage/v1${sr.data.signedURL}`, file_name: doc.file_name, mime: doc.mime });
          }

          case 'getPaymentAdmin': {
            if (!canPaySuperAdmin(P)) return err('Super admin only', 403);
            const [settings, cats, grants] = await Promise.all([
              query('payment_settings', '?id=eq.1&limit=1&select=*'),
              query('payment_categories', '?order=sort_order.asc&select=*'),
              query('payment_grants', '?order=grant_key.asc&select=*'),
            ]);
            const ids = [...new Set((grants.ok ? grants.data : []).map(g => g.user_id))];
            let names = {};
            if (ids.length) {
              const up = await query('users_profile', `?id=in.(${ids.join(',')})&select=id,full_name`);
              if (up.ok) up.data.forEach(u => { names[u.id] = u.full_name; });
            }
            return ok({
              settings: settings.ok ? (settings.data[0] || null) : null,
              categories: cats.ok ? cats.data : [],
              grants: (grants.ok ? grants.data : []).map(g => ({ ...g, full_name: names[g.user_id] || null })),
            });
          }

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
            // Manual PO-line part picker source. Sourced from the FULL active catalogue
            // (material_current = material_master WHERE is_active), enriched with
            // issue_uom / hsn_code from bom_register where the part is on a BOM. Was
            // previously bom_register-only, which hid catalogue parts that aren't on any
            // BOM — raw materials, consumables, freshly-created codes — so they couldn't
            // be ordered on a manual line (Siddhanth: LB-WD-PINE-3 raw material → "No
            // matches"). Manual lines must be able to order any catalogued part.
            const [matR, bomR] = await Promise.all([
              query('material_current',
                `?select=part_code,part_name,product,part_category,part_type,hsn_code&order=part_code.asc`),
              query('bom_register',
                `?is_active=eq.true&select=part_code,part_name,issue_uom,hsn_code`),
            ]);
            if (!matR.ok) return err(matR.data);
            const bomMeta = new Map();
            for (const b of (bomR.ok ? bomR.data : [])) {
              if (!bomMeta.has(b.part_code)) bomMeta.set(b.part_code, b);
            }
            const seen = new Map();
            for (const row of matR.data) {
              if (seen.has(row.part_code)) continue;
              const meta = bomMeta.get(row.part_code) || {};
              seen.set(row.part_code, {
                part_code:     row.part_code,
                part_name:     row.part_name,
                product:       row.product || null,
                part_category: row.part_category || null,
                part_type:     row.part_type || null,
                issue_uom:     meta.issue_uom || null,
                // material_master is the HSN master now — bom_register.hsn_code is
                // empty for all 1,447 active parts, which is exactly why the PO form's
                // pre-fill always produced a blank. Kept as a fallback for safety.
                hsn_code:      row.hsn_code || meta.hsn_code || null,
              });
            }
            // Defensive: keep any bom_register-only codes with no catalogue row
            // (preserves prior orderability of a BOM code lacking a material_master row).
            for (const b of (bomR.ok ? bomR.data : [])) {
              if (!seen.has(b.part_code)) {
                seen.set(b.part_code, {
                  part_code:     b.part_code,
                  part_name:     b.part_name || b.part_code,
                  product:       null,
                  part_category: null,
                  part_type:     null,
                  issue_uom:     b.issue_uom || null,
                  hsn_code:      b.hsn_code || null,
                });
              }
            }
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
            // ⚠️ Was `limit=500`, raised 2026-08-28 (S321 hostile review). 500 was not a
            // distant ceiling: 384 POs exist and 145 were raised in the last 30 days
            // (~4.8/day, both measured that day), so the cap was about **24 days** away —
            // and the PO list silently truncates past it, as does the Export button shipped
            // the same day. A truncated list looks short; a truncated SPREADSHEET gets
            // totalled and looks authoritative.
            // 2000 is chosen against the real constraint, not plucked: PostgREST clamps every
            // response to the project's `db-max-rows` (5,000 — CORE.md), so anything above
            // that is fiction, and 2000 is ~4 years of headroom at the measured rate while
            // staying well clear. ⚠️ This is a REPRIEVE, NOT the fix — the read still has no
            // total and still cannot say it was cut. Real paging is tracked in BACKLOG
            // [snorkel]; do not close that item on the strength of this line.
            let filter = '?order=created_at.desc&limit=2000';
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
          // product → HSN + GST%, so the order form can pre-fill both the moment a
          // product is picked and the team just confirms. Deliberately a snorkelops
          // action rather than extending lotopsproxy's getProductCatalogue — that
          // worker serves Garage + Redline + Scanner + Depot and is not worth a
          // 4-system deploy for a dropdown default.
          case 'getProductHsnMap': {
            if (!canSalesView(P)) return err('No permission', 403);
            const m = await hsnMasterAll();
            return ok([...m.entries()].map(([product, v]) => ({
              product, hsn_code: v.hsn, gst_pct: v.gst,
            })));
          }
          // part → HSN + GST% for the PO form. The form's existing pre-fill paths read
          // bom_register.hsn_code, which is empty for every part; this is the real source.
          case 'getPartHsnMap': {
            if (!canView(P)) return err('No permission', 403);
            const m = await partHsnMasterAll();
            return ok([...m.entries()].map(([part_code, v]) => ({
              part_code, hsn_code: v.hsn, gst_percent: v.gst,
            })));
          }
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
            const lines = await withLineFulfilment(linesR.ok ? linesR.data : [], f);
            return ok({ ...dec, ...der, partner, request: f?.request || null,
              shipments: f?.shipments?.length ? f.shipments : (f?.legacyShipment ? [f.legacyShipment] : []),
              lines, payments: paysR.ok ? paysR.data : [] });
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
            // Bank block for the printed documents (order confirmation + invoice).
            // Data-driven like the seller address — never hardcode banking detail
            // into the app (RULE-GP-001 #7). Null when unseeded, and every consumer
            // renders the block only when this is non-null, so an unseeded table
            // simply omits the section rather than printing empty labels.
            const bankR = await query('company_bank_accounts', '?is_default=eq.true&active=eq.true&select=*&limit=1');
            const bank = bankR.ok ? bankR.data?.[0] || null : null;
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
              seller, bank, place_of_supply: placeOfSupply, intra, lines });
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
            const out = await createVendorRow(body.data, postRole);
            if (!out.ok) return err(out.error);
            return ok({ vendor_code: out.vendor_code });
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
            const dupMouldC = duplicateMould(d.lines);
            if (dupMouldC) return err('Mould ' + dupMouldC + ' is on more than one line — one PO line per mould. Each mould line brings its full part list into receiving, so a second line doubles every expected quantity (the SHP-219/221 incident). For split-colour rates, use one line at the blended rate until per-shot pricing is built.', 422);
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
            const rawLines = Array.isArray(d.lines) ? d.lines : [];
            // HSN/GST default in from the part master; corrections sync back out below.
            const partHsnMaster = rawLines.length ? await partHsnMasterAll() : new Map();
            const lines = applyPartHsnDefaults(rawLines, partHsnMaster);
            if (lines.length>0) {
              const lineRows = lines.map((l,i) => ({
                po_number: poNumber, line_no: i+1, product: l.product||null, variant: l.variant||null,
                item_type: l.item_type||'Other', description: l.description||null, part_code: l.part_code||null,
                qty_ordered: parseFloat(l.qty_ordered)||0, qty_received: 0, unit: String(l.unit||'').trim()||'pcs',
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
              await syncPartHsnToMaster(lines, partHsnMaster,
                authResult?.fullName || postRole, postRole, poNumber);
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
            // STRICT (2026-07-20, Afshaan): an issued PO is a commercial document — every
            // amendment must carry a reason, bump the revision, snapshot the prior state and
            // land in the activity log. Reason was previously enforced in the UI only.
            if (!d.change_summary || !String(d.change_summary).trim()) {
              return err('change_summary required — an amendment must record what changed and why');
            }
            const existing = await query('purchase_orders', `?po_number=eq.${encodeURIComponent(d.po_number)}&limit=1`);
            if (!existing.ok||!existing.data[0]) return err('PO not found');
            const po = existing.data[0];
            if (po.source === 'China' && !canRaiseChinaPO(P)) {
              return err('China PO amend requires po_china permission', 403);
            }
            if (['Cancelled','Closed'].includes(po.status)) {
              return err(`A ${po.status} PO cannot be amended`, 400);
            }
            if (po.status === 'Soft') {
              return err('Soft POs are promoted, not amended — use Promote', 400);
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
              // GUARD (2026-07-20): this path DELETEs every line and re-inserts from the client
              // payload — it renumbers line_no and rewrites qty_received. On a PO with goods
              // already booked against it that silently destroys the receiving reconciliation.
              // No UI sends `lines` today (the Amend modal is header-only); to APPEND a line use
              // the additive `addPOLines` action instead. Refuse the full replace once anything
              // has been received.
              const received = (linesR.data||[]).some(l => (parseFloat(l.qty_received)||0) > 0);
              if (received) {
                return err('This PO already has received quantities — a full line replace would rewrite that history. Use Add Line to append instead.', 409);
              }
              const dupMouldA = duplicateMould(d.lines);
              if (dupMouldA) return err('Mould ' + dupMouldA + ' is on more than one line — one PO line per mould (a second line doubles every expected receiving quantity).', 422);
              await sb(`/rest/v1/po_lines?po_number=eq.${encodeURIComponent(d.po_number)}`, { method: 'DELETE' });
              const partHsnMasterA = await partHsnMasterAll();
              const aLines = applyPartHsnDefaults(d.lines, partHsnMasterA);
              const lineRows = aLines.map((l,i) => ({
                po_number: d.po_number, line_no: i+1, product: l.product||null, variant: l.variant||null,
                item_type: l.item_type||'Other', description: l.description||null, part_code: l.part_code||null,
                qty_ordered: parseFloat(l.qty_ordered)||0, qty_received: parseFloat(l.qty_received)||0,
                unit: String(l.unit||'').trim()||'pcs', unit_price: parseFloat(l.unit_price)||null, color: l.color||null,
                component_type: l.component_type||null,
                receive_format: l.receive_format || null,
                remote_qty: parseInt(l.remote_qty) || 0,
                hsn_code: l.hsn_code || null,
                gst_percent: l.gst_percent != null ? parseFloat(l.gst_percent) : null,
                mould_no: l.mould_no || null,
              }));
              await insert('po_lines', lineRows);
              await syncPartHsnToMaster(aLines, partHsnMasterA,
                authResult?.fullName || postRole, postRole, d.po_number);
            }
            await logActivity(authResult?.fullName||postRole, postRole, 'PO_AMENDED', 'PO', d.po_number,
              `PO ${d.po_number} amended to rev ${newRev} — ${String(d.change_summary).trim()}`,
              { revision: newRev, change_summary: String(d.change_summary).trim() });
            return ok({ po_number: d.po_number, revision: newRev });
          }

          // Additive line append on an already-raised PO (2026-07-20). The legitimate case behind
          // the recurring "add this part to SHP-NNN + its PO" tickets: the supplier ships something
          // that was never on the PO. Receiving stays PO-driven (the PO-mandatory rule, 2026-07-15)
          // — this makes the PO catch up quickly instead of people wanting to bypass it.
          // Strict, same contract as amendPO: reason required, revision bumped, prior state
          // snapshotted into po_revisions, activity logged. NEVER touches existing lines.
          case 'addPOLines': {
            if (!canRaisePO(P)) return err('No permission to amend POs', 403);
            const d = body.data;
            if (!d.po_number) return err('po_number required');
            if (!d.change_summary || !String(d.change_summary).trim()) {
              return err('change_summary required — an amendment must record what changed and why');
            }
            const newLines = Array.isArray(d.lines) ? d.lines.filter(l => l && (l.part_code || l.description)) : [];
            if (!newLines.length) return err('At least one line with a part code or description is required');
            const existing = await query('purchase_orders', `?po_number=eq.${encodeURIComponent(d.po_number)}&limit=1`);
            if (!existing.ok||!existing.data[0]) return err('PO not found');
            const po = existing.data[0];
            if (po.source === 'China' && !canRaiseChinaPO(P)) {
              return err('China PO amend requires po_china permission', 403);
            }
            if (['Cancelled','Closed'].includes(po.status)) {
              return err(`A ${po.status} PO cannot be amended`, 400);
            }
            if (po.status === 'Soft') {
              return err('Soft POs are promoted, not amended — use Promote', 400);
            }
            const curR = await query('po_lines', `?po_number=eq.${encodeURIComponent(d.po_number)}&order=line_no.asc`);
            const curLines = curR.data || [];
            // Snapshot the PRE-amendment state against the OLD revision (same shape as amendPO).
            const dupMouldL = duplicateMould(newLines, curLines);
            if (dupMouldL) return err('Mould ' + dupMouldL + ' is already on this PO — one line per mould (a second line doubles every expected receiving quantity). Amend the existing line instead.', 422);
            const newRev = po.revision + 1;
            await insert('po_revisions', {
              po_number: d.po_number, revision: po.revision, changed_by: postRole,
              change_summary: `Rev ${newRev}: added ${newLines.length} line${newLines.length===1?'':'s'} — ${String(d.change_summary).trim()}`,
              snapshot: JSON.stringify({ header: po, lines: curLines }),
            });
            // Append above the current highest line_no — never renumber what's there.
            const maxLineNo = curLines.reduce((m,l) => Math.max(m, parseInt(l.line_no)||0), 0);
            const partHsnMasterL = await partHsnMasterAll();
            const newLinesH = applyPartHsnDefaults(newLines, partHsnMasterL);
            const lineRows = newLinesH.map((l,i) => ({
              po_number: d.po_number, line_no: maxLineNo + i + 1,
              product: l.product||null, variant: l.variant||null,
              item_type: l.item_type||'Part', description: l.description||null, part_code: l.part_code||null,
              qty_ordered: parseFloat(l.qty_ordered)||0, qty_received: 0, unit: String(l.unit||'').trim()||'pcs',
              unit_price: l.unit_price != null && l.unit_price !== '' ? parseFloat(l.unit_price) : null,
              color: l.color||null, component_type: l.component_type||null,
              receive_format: l.receive_format || null,
              remote_qty: parseInt(l.remote_qty) || 0,
              hsn_code: l.hsn_code || null,
              gst_percent: l.gst_percent != null && l.gst_percent !== '' ? parseFloat(l.gst_percent) : null,
              mould_no: l.mould_no || null,
            }));
            const lr = await insert('po_lines', lineRows);
            if (!lr.ok) return err('PO line insert failed: '+JSON.stringify(lr.data));
            await syncPartHsnToMaster(newLinesH, partHsnMasterL,
              authResult?.fullName || postRole, postRole, d.po_number);
            await update('purchase_orders',
              { revision: newRev, updated_at: new Date().toISOString() },
              `po_number=eq.${encodeURIComponent(d.po_number)}`);
            const added = lineRows.map(l => `${l.part_code||l.description} ×${l.qty_ordered}`).join(', ');
            await logActivity(authResult?.fullName||postRole, postRole, 'PO_LINES_ADDED', 'PO', d.po_number,
              `PO ${d.po_number} → rev ${newRev}: added ${added} — ${String(d.change_summary).trim()}`,
              { revision: newRev, lines_added: lineRows.length, parts: lineRows.map(l => l.part_code).filter(Boolean),
                change_summary: String(d.change_summary).trim() });
            return ok({ po_number: d.po_number, revision: newRev, lines_added: lineRows.length });
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
              // Uppercase+trim on write (Afshaan 2026-08-16) — deliberately NOT validated
              // against bom_register: a request naming a not-yet-created part is legitimate.
              part_code:         d.part_code ? (String(d.part_code).trim().toUpperCase() || null) : null,
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
          // PAYMENT REQUESTS (replaces the #payments Slack channel)
          // ══════════════════════════════════════════════════
          case 'createPaymentPayee': {
            if (!canPayPayeeManage(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.name) return err('name required');
            const payee_code = await nextSeq4('payee', 'PAY-');
            const r = await insert('payment_payees', {
              payee_code, name: String(d.name).trim(), payee_type: d.payee_type || 'other',
              linked_vendor_code: d.linked_vendor_code || null, gstin: d.gstin || null,
              pan: d.pan || null, email: d.email || null, phone: d.phone || null,
              notes: d.notes || null, created_by: userId,
            });
            if (!r.ok) return err('Create failed: ' + JSON.stringify(r.data));
            const payee = Array.isArray(r.data) ? r.data[0] : r.data;
            // A requester MAY submit bank details on create (they have them; that is what they
            // paste into Slack today). They can never read them back — see maskBank().
            if (payee && (d.account_number || d.upi_id)) {
              await insert('payment_payee_banks', {
                payee_id: payee.id, account_name: d.account_name || d.name,
                account_number: d.account_number || null, ifsc: d.ifsc || null,
                bank_name: d.bank_name || null, branch: d.branch || null,
                upi_id: d.upi_id || null, is_default: true, created_by: userId,
              });
            }
            await logActivity(authResult?.fullName || postRole, postRole, 'PAYEE_CREATED', 'Payee',
              payee_code, `Payee ${payee_code} — ${d.name}`, {});
            return ok({ id: payee?.id, payee_code });
          }

          case 'addPaymentPayeeBank': {
            if (!canPayPayeeManage(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.payee_id) return err('payee_id required');
            if (!d.account_number && !d.upi_id) return err('account_number or upi_id required');
            if (d.is_default) {
              await update('payment_payee_banks', { is_default: false },
                `payee_id=eq.${encodeURIComponent(d.payee_id)}`);
            }
            const r = await insert('payment_payee_banks', {
              payee_id: d.payee_id, account_name: d.account_name || null,
              account_number: d.account_number || null, ifsc: d.ifsc || null,
              bank_name: d.bank_name || null, branch: d.branch || null,
              upi_id: d.upi_id || null, is_default: !!d.is_default, created_by: userId,
            });
            if (!r.ok) return err('Create failed: ' + JSON.stringify(r.data));
            return ok({ added: true });
          }

          case 'createPaymentRequest': {
            if (!canPayRequest(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.payee_id)  return err('payee_id required');
            if (!d.purpose)   return err('purpose required');
            if (!d.category_key) return err('category_key required');
            const type = d.request_type || 'payment';
            if (!['payment','credit_note','debit_note'].includes(type)) return err('bad request_type');

            const amount = type === 'payment' ? Number(d.amount_to_pay || 0) : Number(d.invoice_total || 0);
            if (type === 'payment' && !(amount > 0)) return err('amount_to_pay must be greater than zero');

            // PO gate — category-driven (Piyush's escalation, closed by construction rather than
            // by reminder). Only categories flagged po_required demand one.
            const cat = await query('payment_categories',
              `?category_key=eq.${encodeURIComponent(d.category_key)}&limit=1&select=*`);
            if (!cat.ok || !cat.data[0]) return err('Unknown category');
            let po_warning = null, po_overdrawn = null;
            if (cat.data[0].po_required && type === 'payment') {
              if (!d.linked_po_number) {
                return err(`A PO is required for ${cat.data[0].label}. Raise one under Procurement → POs, or pick a different category.`);
              }
              const poRef = encodeURIComponent(d.linked_po_number);
              const po = await query('purchase_orders',
                `?po_number=eq.${poRef}&select=po_number,status,currency&limit=1`);
              if (!po.ok || !po.data[0]) return err(`PO ${d.linked_po_number} not found`);

              // ⛔ EXISTENCE WAS THE ONLY CHECK until 2026-09-02 (S332) — `select=po_number` did not
              // even fetch the status, so a **Cancelled** PO passed the gate and a payment could be
              // raised against a PO that commercially does not exist. Cancelled is now refused.
              // Soft and Closed only WARN: a Soft PO can still be promoted, and a Closed one can
              // legitimately carry a final payment. Do not harden those into blocks.
              const poStatus = po.data[0].status;
              if (poStatus === 'Cancelled') {
                return err(`PO ${d.linked_po_number} is Cancelled and cannot carry a payment. Link a live PO, or pick a category that does not require one.`);
              }
              if (poStatus === 'Soft' || poStatus === 'Closed') {
                po_warning = `PO ${d.linked_po_number} is ${poStatus}.`;
              }

              // Over-consumption WARNING, never a block — same rule as the duplicate-invoice warning
              // below. Part-payments, advances and genuine vendor over-billing all legitimately push
              // the total past the PO value; the spec asked to surface it, not to police it.
              // ⚠️ Skipped when the PO and the request are in different currencies — there is no FX
              // rate in this schema (see the threshold note below) and a cross-currency comparison
              // would fire a confidently wrong warning. Silence beats a false alarm here.
              const poCur  = (po.data[0].currency || 'INR').toUpperCase();
              const reqCur = (d.currency || 'INR').toUpperCase();
              if (poCur === reqCur) {
                const [lines, prior] = await Promise.all([
                  query('po_lines', `?po_number=eq.${poRef}&select=total_value`),
                  // ⚠️ BOTH `rejected` AND `cancelled` are excluded, and the pair is the whole point:
                  // neither is a commitment against the PO, so counting one would inflate consumption
                  // and fire the warning on a PO with budget left. (`neq.rejected` alone was the first
                  // draft — caught in this session's hostile review; `PAY-0001`, the only row in the
                  // table, is cancelled, so the very first real use would have over-counted.)
                  // `pending_approval`, `approved`, `submitted` and `paid` all DO count — an
                  // in-flight request is money already spoken for.
                  query('payment_requests',
                    `?linked_po_number=eq.${poRef}&status=not.in.(rejected,cancelled)&request_type=eq.payment&select=request_no,amount_to_pay`),
                ]);
                const poValue   = lines.ok ? lines.data.reduce((s, l) => s + Number(l.total_value || 0), 0) : 0;
                const priorPaid = prior.ok ? prior.data.reduce((s, p) => s + Number(p.amount_to_pay || 0), 0) : 0;
                if (poValue > 0 && priorPaid + amount > poValue) {
                  po_overdrawn = {
                    po_number: d.linked_po_number, po_value: poValue,
                    already_requested: priorPaid, this_request: amount,
                    prior_requests: prior.ok ? prior.data.map(p => p.request_no) : [],
                  };
                }
              }
            }

            // Threshold IN FORCE AT SUBMIT, stamped on the row. Editing the threshold later must
            // never retroactively reinterpret a request that has already been decided.
            const st = await query('payment_settings', '?id=eq.1&limit=1&select=approval_threshold_inr');
            const threshold = Number(st.ok && st.data[0]?.approval_threshold_inr) || 100000;
            // ⚠️ The threshold is `approval_threshold_inr` — an INR figure. Comparing a foreign
            // amount against it silently under-reads: USD 2,000 (~Rs1.7L) would score 2000 < 100000
            // and auto-approve. There is no FX rate in this schema for arbitrary currencies and
            // inventing one would be worse, so a NON-INR request ALWAYS goes for approval.
            // Do not "optimise" this into a conversion without a real rate source.
            const isInr = (d.currency || 'INR').toUpperCase() === 'INR';
            const needsApproval = type === 'payment' && (!isInr || amount >= threshold);

            const request_no = await nextSeq4('pay_request', 'PAY-');
            const now = new Date().toISOString();
            const r = await insert('payment_requests', {
              request_no, request_type: type, category_key: d.category_key,
              payee_id: d.payee_id, purpose: String(d.purpose).trim(),
              invoice_no: d.invoice_no || null, invoice_date: d.invoice_date || null,
              invoice_total: d.invoice_total != null ? Number(d.invoice_total) : null,
              amount_to_pay: type === 'payment' ? amount : null,
              currency: d.currency || 'INR',
              needed_by: d.needed_by || null,
              is_urgent: !!d.is_urgent, urgency_reason: d.urgency_reason || null,
              linked_po_number: d.linked_po_number || null,
              status: needsApproval ? 'pending_approval' : (type === 'payment' ? 'approved' : 'submitted'),
              threshold_at_submit: threshold,
              // never stamp a real approver on something nobody looked at
              auto_approved: type === 'payment' && !needsApproval,
              requested_by_user_id: userId, requested_by_name: authResult?.fullName || null,
              requested_at: now,
            });
            if (!r.ok) return err('Create failed: ' + JSON.stringify(r.data));
            const created = Array.isArray(r.data) ? r.data[0] : r.data;

            // Duplicate warning — never a block. Genuine re-bills and part-payments legitimately
            // share an invoice number (evidence: `invoice 100.pdf` submitted twice in #payments).
            let duplicate_of = null;
            if (d.invoice_no) {
              const dup = await query('payment_requests',
                `?payee_id=eq.${d.payee_id}&invoice_no=eq.${encodeURIComponent(d.invoice_no)}` +
                `&status=neq.rejected&id=neq.${created?.id}&select=request_no,amount_to_pay,requested_by_name,requested_at&limit=5`);
              if (dup.ok && dup.data.length) duplicate_of = dup.data;
            }
            // tell whoever it now sits with — approvers if it needs approval, finance if not
            const payeeRow = await query('payment_payees', `?id=eq.${d.payee_id}&select=name&limit=1`);
            const payeeName = (payeeRow.ok && payeeRow.data[0]?.name) || 'a payee';
            const who = await grantHolders(needsApproval ? 'approve' : 'execute');
            await notify(who.map(uid => ({
              user_id: uid, request_id: created?.id,
              kind: needsApproval ? 'approval_needed' : 'payment_needed',
              title: needsApproval
                ? `${request_no} needs your approval`
                : `${request_no} is ready to pay`,
              body: `${payeeName} — ${d.currency || 'INR'} ${amount.toLocaleString('en-IN')} · ${d.purpose}`,
            })));
            await logActivity(authResult?.fullName || postRole, postRole, 'PAYMENT_REQUESTED', 'Payment',
              request_no, `${request_no} — ${d.purpose}`, { amount, needs_approval: needsApproval });
            return ok({
              id: created?.id, request_no, status: created?.status,
              needs_approval: needsApproval, threshold, duplicate_of,
              po_warning, po_overdrawn,
            });
          }

          case 'approvePaymentRequests': {
            if (!canPayApprove(P)) return err('No permission to approve', 403);
            const d = body.data || {};
            const ids = Array.isArray(d.ids) ? d.ids : (d.id ? [d.id] : []);
            if (!ids.length) return err('ids required');
            const now = new Date().toISOString();
            // Only pending_approval may move — an already-approved or paid row must not be
            // re-stamped by a bulk action that swept it up.
            const r = await update('payment_requests', {
              status: 'approved', approved_by_user_id: userId,
              approved_by_name: authResult?.fullName || null, approved_at: now, updated_at: now,
            }, `id=in.(${ids.map(encodeURIComponent).join(',')})&status=eq.pending_approval`);
            if (!r.ok) return err('Approve failed: ' + JSON.stringify(r.data));
            const movedRows = Array.isArray(r.data) ? r.data : [];
            const moved = movedRows.length;
            const financeIds = moved ? await grantHolders('execute') : [];
            await notify([
              ...movedRows.map(row => ({
                user_id: row.requested_by_user_id, request_id: row.id, kind: 'approved',
                title: `${row.request_no} approved`,
                body: `Approved by ${authResult?.fullName || 'an approver'} — now with Finance.`,
              })),
              ...movedRows.flatMap(row => financeIds.map(uid => ({
                user_id: uid, request_id: row.id, kind: 'payment_needed',
                title: `${row.request_no} is ready to pay`,
                body: `${row.currency || 'INR'} ${Number(row.amount_to_pay || 0).toLocaleString('en-IN')} · ${row.purpose}`,
              }))),
            ]);
            await logActivity(authResult?.fullName || postRole, postRole, 'PAYMENT_APPROVED', 'Payment',
              ids.join(','), `${moved} request(s) approved`, {});
            return ok({ approved: moved, requested: ids.length });
          }

          case 'rejectPaymentRequest': {
            if (!canPayApprove(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.id) return err('id required');
            if (!d.rejection_note) return err('A reason is required to reject');
            const now = new Date().toISOString();
            const r = await update('payment_requests', {
              status: 'rejected', rejected_by_user_id: userId,
              rejected_by_name: authResult?.fullName || null, rejected_at: now,
              rejection_note: d.rejection_note, updated_at: now,
            }, `id=eq.${encodeURIComponent(d.id)}&status=in.(submitted,pending_approval,approved)`);
            if (!r.ok) return err('Reject failed: ' + JSON.stringify(r.data));
            const rej = (Array.isArray(r.data) ? r.data : [])[0];
            if (rej) await notify([{
              user_id: rej.requested_by_user_id, request_id: rej.id, kind: 'rejected',
              title: `${rej.request_no} was rejected`,
              body: d.rejection_note,   // the reason IS the notification; a bare "rejected" is useless
            }]);
            return ok({ rejected: d.id });
          }

          case 'markPaymentPaid': {
            if (!canPayExecute(P)) return err('No permission to mark paid', 403);
            const d = body.data || {};
            const ids = Array.isArray(d.ids) ? d.ids : (d.id ? [d.id] : []);
            if (!ids.length) return err('ids required');
            const now = new Date().toISOString();
            const patch = {
              status: 'paid', paid_by_user_id: userId, paid_by_name: authResult?.fullName || null,
              paid_at: now, updated_at: now,
            };
            if (d.payment_ref)   patch.payment_ref   = d.payment_ref;
            if (d.payment_mode)  patch.payment_mode  = d.payment_mode;
            if (d.payment_note)  patch.payment_note  = d.payment_note;
            if (d.paid_amount != null) patch.paid_amount = Number(d.paid_amount);
            if (d.payee_bank_id) patch.payee_bank_id = d.payee_bank_id;
            const r = await update('payment_requests', patch,
              `id=in.(${ids.map(encodeURIComponent).join(',')})&status=eq.approved`);
            if (!r.ok) return err('Mark paid failed: ' + JSON.stringify(r.data));
            const moved = Array.isArray(r.data) ? r.data : [];
            // Keep the PO-side mirror truthful so procurement's own screens agree.
            // ONE batched write — never a loop of awaits per row (CORE.md global invariant).
            const poNumbers = [...new Set(moved.map(x => x.linked_po_number).filter(Boolean))];
            if (poNumbers.length) {
              const inList = poNumbers.map(n => `"${String(n).replace(/"/g, '""')}"`).join(',');
              await update('purchase_orders', {
                payment_status: 'paid', paid_by: postRole, paid_at: now, updated_at: now,
              }, `po_number=in.(${encodeURIComponent(inList)})`);
            }
            await notify(moved.map(row => ({
              user_id: row.requested_by_user_id, request_id: row.id, kind: 'paid',
              title: `${row.request_no} has been paid`,
              body: [`${row.currency || 'INR'} ${Number(row.paid_amount ?? row.amount_to_pay ?? 0).toLocaleString('en-IN')}`,
                     row.payment_ref ? `UTR ${row.payment_ref}` : null].filter(Boolean).join(' · '),
            })));
            await logActivity(authResult?.fullName || postRole, postRole, 'PAYMENT_PAID', 'Payment',
              ids.join(','), `${moved.length} payment(s) marked paid`, { ref: d.payment_ref || null });
            return ok({ paid: moved.length, requested: ids.length });
          }

          case 'cancelPaymentRequest': {
            if (!canPayRequest(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.id) return err('id required');
            const ex = await query('payment_requests', `?id=eq.${encodeURIComponent(d.id)}&select=requested_by_user_id,status&limit=1`);
            if (!ex.ok || !ex.data[0]) return err('Not found', 404);
            if (ex.data[0].requested_by_user_id !== userId && !canPaySuperAdmin(P))
              return err('Only the requester can cancel this', 403);
            if (ex.data[0].status === 'paid') return err('A paid request cannot be cancelled');
            const now = new Date().toISOString();
            await update('payment_requests', { status: 'cancelled', updated_at: now },
              `id=eq.${encodeURIComponent(d.id)}`);
            return ok({ cancelled: d.id });
          }

          case 'markPaymentNotificationsRead': {
            if (!canPayRequest(P)) return err('No permission', 403);
            const d = body.data || {};
            // scoped to the caller's own rows — a stray id can never clear someone else's bell
            let filter = `user_id=eq.${userId}&read_at=is.null`;
            if (Array.isArray(d.ids) && d.ids.length) {
              filter += `&id=in.(${d.ids.map(encodeURIComponent).join(',')})`;
            }
            const r = await update('payment_notifications', { read_at: new Date().toISOString() }, filter);
            if (!r.ok) return err('Failed: ' + JSON.stringify(r.data));
            return ok({ marked: Array.isArray(r.data) ? r.data.length : 0 });
          }

          case 'createPaymentDocUploadUrl': {
            if (!canPayRequest(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.file_name) return err('file_name required');
            const kind = d.doc_kind || 'invoice';
            if (kind === 'payment_proof' && !canPayExecute(P)) return err('No permission', 403);
            const bucketDir = d.request_id ? String(d.request_id) : `draft/${userId}`;
            const path = `${assetSafeSeg(bucketDir)}/${assetSafeSeg(kind)}/${Date.now()}_${assetSafeSeg(d.file_name)}`;
            const sr = await storageFetch(`/object/upload/sign/${PAYMENT_BUCKET}/${path}`, { method: 'POST' });
            if (!sr.ok || !sr.data?.url) return err(`sign_failed: ${JSON.stringify(sr.data)}`, 502);
            const tokenMatch = String(sr.data.url).match(/token=([^&]+)/);
            return ok({ storage_path: path, token: tokenMatch ? decodeURIComponent(tokenMatch[1]) : null, signed_url: sr.data.url });
          }

          case 'recordPaymentDocument': {
            if (!canPayRequest(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.request_id)   return err('request_id required');
            if (!d.storage_path) return err('storage_path required');
            const kind = d.doc_kind || 'invoice';
            if (kind === 'payment_proof' && !canPayExecute(P)) return err('No permission', 403);
            const r = await insert('payment_request_documents', {
              request_id: d.request_id, doc_kind: kind, file_path: d.storage_path,
              file_name: d.file_name || null, mime: d.mime || null,
              size_bytes: d.size_bytes != null ? Number(d.size_bytes) : null, uploaded_by: userId,
            });
            if (!r.ok) return err('Record failed: ' + JSON.stringify(r.data));
            return ok({ recorded: true });
          }

          // ── admin (super admin only) ──
          case 'updatePaymentSettings': {
            if (!canPaySuperAdmin(P)) return err('Super admin only', 403);
            const d = body.data || {};
            const patch = { updated_by: userId, updated_at: new Date().toISOString() };
            if (d.approval_threshold_inr != null) {
              const t = Number(d.approval_threshold_inr);
              if (!(t >= 0)) return err('threshold must be zero or more');
              patch.approval_threshold_inr = t;
            }
            if (d.default_currency) patch.default_currency = String(d.default_currency).toUpperCase();
            const r = await update('payment_settings', patch, 'id=eq.1');
            if (!r.ok) return err('Update failed: ' + JSON.stringify(r.data));
            await logActivity(authResult?.fullName || postRole, postRole, 'PAYMENT_SETTINGS_UPDATED',
              'Payment', 'settings', `threshold → ${patch.approval_threshold_inr ?? '(unchanged)'}`, {});
            return ok({ updated: true });
          }

          case 'upsertPaymentCategory': {
            if (!canPaySuperAdmin(P)) return err('Super admin only', 403);
            const d = body.data || {};
            if (!d.category_key) return err('category_key required');
            const patch = { updated_at: new Date().toISOString() };
            if (d.label != null)       patch.label = d.label;
            if (d.po_required != null) patch.po_required = !!d.po_required;
            if (d.is_active != null)   patch.is_active = !!d.is_active;
            if (d.sort_order != null)  patch.sort_order = Number(d.sort_order);
            const ex = await query('payment_categories', `?category_key=eq.${encodeURIComponent(d.category_key)}&limit=1`);
            if (ex.ok && ex.data[0]) {
              await update('payment_categories', patch, `category_key=eq.${encodeURIComponent(d.category_key)}`);
            } else {
              if (!d.label) return err('label required for a new category');
              await insert('payment_categories', { category_key: d.category_key, ...patch });
            }
            return ok({ category_key: d.category_key });
          }

          case 'setPaymentGrant': {
            if (!canPaySuperAdmin(P)) return err('Super admin only', 403);
            const d = body.data || {};
            if (!d.user_id || !d.grant_key) return err('user_id and grant_key required');
            if (!['approve','execute','super_admin'].includes(d.grant_key)) return err('bad grant_key');
            const active = d.active !== false;
            const ex = await query('payment_grants',
              `?user_id=eq.${encodeURIComponent(d.user_id)}&grant_key=eq.${encodeURIComponent(d.grant_key)}&limit=1`);
            if (ex.ok && ex.data[0]) {
              await update('payment_grants', { active },
                `user_id=eq.${encodeURIComponent(d.user_id)}&grant_key=eq.${encodeURIComponent(d.grant_key)}`);
            } else {
              await insert('payment_grants', { user_id: d.user_id, grant_key: d.grant_key, active, granted_by: userId });
            }
            await logActivity(authResult?.fullName || postRole, postRole, 'PAYMENT_GRANT_SET', 'Payment',
              d.grant_key, `${d.grant_key} ${active ? 'granted to' : 'revoked from'} ${d.user_id}`, {});
            return ok({ user_id: d.user_id, grant_key: d.grant_key, active });
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
            // HSN/GST default in from the product master, corrections sync back out.
            const hsnMaster = await hsnMasterAll();
            const lines = applyHsnDefaults(d.lines, hsnMaster).map(computeSalesLine);
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
            const hsnSynced = await syncHsnToMaster(lines, hsnMaster,
              authResult?.fullName || postRole, postRole, order_no);
            return ok({ id: order.id, order_no, hsn_synced: hsnSynced, hsn_gaps: hsnGaps(lines, hsnMaster) });
          }

          case 'updateSalesOrder': {
            if (!canSalesManage(P)) return err('No permission', 403);
            const d = body.data || {};
            if (!d.id) return err('id required');
            const cur = await query('sales_orders', `?id=eq.${encodeURIComponent(d.id)}&select=status,invoice_generated&limit=1`);
            if (!cur.ok || !cur.data[0]) return err('Order not found', 404);
            const curO = cur.data[0];
            if (curO.invoice_generated) return err('Invoiced orders cannot be edited', 422);
            const isDraftEdit = curO.status === 'draft';
            // S229 (Afshaan): CONFIRMED un-invoiced orders allow METADATA-ONLY edits
            // (order_date / partner_po_ref / expected_dispatch_date / notes) — a date
            // correction pre-invoice is legitimate (Tanya's Blinkit SOs). Lines, channel,
            // warehouse and credit terms stay locked post-confirm (they drive fulfilment,
            // Odo staging and collections).
            if (!isDraftEdit && curO.status !== 'confirmed')
              return err('Only draft or confirmed (un-invoiced) orders can be edited', 422);
            if (!isDraftEdit) {
              const blocked = ['channel_key','destination_warehouse','credit_days'].filter(f => d[f] !== undefined);
              if (blocked.length) return err(`Locked after confirmation: ${blocked.join(', ')}`, 422);
            }
            const updates = { updated_at: new Date().toISOString() };
            const editable = isDraftEdit
              ? ['channel_key','order_date','partner_po_ref','expected_dispatch_date','destination_warehouse','notes']
              : ['order_date','partner_po_ref','expected_dispatch_date','notes'];
            editable.forEach(f => {
              if (d[f] !== undefined) updates[f] = d[f] || null;
            });
            if (isDraftEdit && d.credit_days !== undefined) updates.credit_days = Math.round(Number(d.credit_days) || 0);

            // ── Line edits on a CONFIRMED, un-invoiced order (Ram #bugs 2026-07-27) ──
            // Requirements and fillability change after a partner PO lands but before it
            // ships. Two field classes with very different blast radius:
            //   · invoice-only (hsn_code/description/rate/discount_pct/gst_pct) — dispatch
            //     never reads these, so they stay editable right up to invoicing. 50 live
            //     lines across 21 un-invoiced orders had NO hsn at all, two of them on
            //     orders already fully packed, so they could not be invoiced correctly.
            //   · dispatch keys (product/model/color/sku/qty) — PACK matches manifest lines
            //     on EXACT product+model+colour, so changing one without propagating is
            //     precisely what broke Blinkit DSO-0258 (RULE-TAXONOMY-001, S231
            //     "NOT IN MANIFEST"). Allowed only while nothing is packed, and always
            //     propagated to the fulfilment-request + shipment lines in the same call.
            // Edits are applied IN PLACE via upsert-on-id, never the draft path's
            // delete-and-reinsert: sales_order_lines.id is Odo's source line id for
            // stg_snorkel, so minting new ids would restage every line and double-count
            // sales_fact (RULE-SALES-001).
            let frToSync = null, shipmentToSync = null, mergedLines = null, hsnSyncedOnEdit = null;
            if (!isDraftEdit && Array.isArray(d.lines)) {
              const exR = await query('sales_order_lines',
                `?order_id=eq.${encodeURIComponent(d.id)}&select=*&order=sort_order.asc`);
              if (!exR.ok) return err('Could not load existing lines', 500);
              const existing = exR.data || [];
              const byId = new Map(existing.map(l => [l.id, l]));
              if (d.lines.some(l => !l.id || !byId.has(l.id)) || d.lines.length !== existing.length)
                return err('Lines cannot be added or removed after confirmation — edit the existing lines, or cancel and re-raise the order', 422);

              const norm = v => (v === undefined || v === null || v === '') ? null
                              : (typeof v === 'string' ? v.trim() : v);
              const asQty = v => Math.round(Number(v) || 0);
              const dispatchChanged = d.lines.some(l => {
                const ex = byId.get(l.id);
                return ['product','model','color','sku','qty'].some(k => {
                  if (l[k] === undefined) return false;
                  return k === 'qty' ? asQty(l[k]) !== asQty(ex[k]) : norm(l[k]) !== norm(ex[k]);
                });
              });

              if (dispatchChanged) {
                const frR = await queryPublic('dispatch_fulfilment_requests',
                  `?sales_order_id=eq.${encodeURIComponent(d.id)}&select=id,status&order=created_at.desc&limit=1`);
                const fr = frR.ok ? frR.data?.[0] : null;
                if (fr && fr.status === 'accepted') {
                  const shR = await queryPublic('dispatch_shipments',
                    `?fulfilment_request_id=eq.${encodeURIComponent(fr.id)}&select=id,status`);
                  const shipments = (shR.ok && Array.isArray(shR.data)) ? shR.data : [];
                  if (shipments.some(s => s.status === 'shipped'))
                    return err('Already dispatched — handle as a return, not an edit', 422);
                  if (shipments.length) {
                    const slR = await queryPublic('dispatch_shipment_lines',
                      `?shipment_id=in.(${shipments.map(s => s.id).join(',')})&select=packed_qty`);
                    const packed = ((slR.ok && Array.isArray(slR.data)) ? slR.data : [])
                      .reduce((s, x) => s + (Number(x.packed_qty) || 0), 0);
                    if (packed > 0)
                      return err('Units are already packed against this order — product, model, colour and quantity are locked. Ask dispatch to unpack first, or cancel and re-raise.', 422);
                  }
                  // A split was allocated by dispatch across N shipments; re-deriving that
                  // allocation from changed lines would be guesswork, so refuse loudly.
                  if (shipments.length > 1)
                    return err('This order was split across more than one shipment — dispatch must redo the split before the items can change', 422);
                  frToSync = fr; shipmentToSync = shipments[0]?.id || null;
                } else if (fr && fr.status === 'pending') {
                  frToSync = fr;   // not accepted yet — only the request lines need re-deriving
                }
              }

              // Same HSN contract as order-create: blanks fill from the master, and a
              // correction typed here syncs back out to the family.
              const hsnMasterU = await hsnMasterAll();
              mergedLines = applyHsnDefaults(
                existing.map(ex => {
                  const inc = d.lines.find(l => l.id === ex.id);
                  return { ...ex, ...(inc || {}) };
                }), hsnMasterU
              ).map(m => ({ id: m.id, ...computeSalesLine(m), order_id: d.id }));
              hsnSyncedOnEdit = { master: hsnMasterU };
              updates.subtotal    = +mergedLines.reduce((s, l) => s + l.taxable_value, 0).toFixed(2);
              updates.tax_total   = +mergedLines.reduce((s, l) => s + l.gst_amount, 0).toFixed(2);
              updates.grand_total = +(updates.subtotal + updates.tax_total).toFixed(2);
              // Upsert on the PK — one subrequest, ids preserved.
              const up = await insert('sales_order_lines', mergedLines, true);
              if (!up.ok) return err('Line update failed: ' + JSON.stringify(up.data), 500);
            }

            if (isDraftEdit && Array.isArray(d.lines)) {
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

            // Propagate the new dispatch keys downstream. Only reached when a dispatch key
            // actually changed AND nothing is packed, so replacing these rows is safe —
            // they carry no packed state to lose. Without this the manifest keeps the OLD
            // product/model/colour and PACK rejects the physical unit as NOT IN MANIFEST.
            if (frToSync) {
              const frLines = mergedLines.map((l, i) => ({
                request_id: frToSync.id, product: l.product, model: l.model || null,
                color: l.color || null, sku: l.sku || null,
                qty: Math.round(Number(l.qty)) || 0, sort_order: l.sort_order ?? i,
              }));
              const requested_units = frLines.reduce((s, l) => s + l.qty, 0);
              await sbPublic(`/rest/v1/dispatch_fulfilment_request_lines?request_id=eq.${encodeURIComponent(frToSync.id)}`,
                { method: 'DELETE', prefer: 'return=minimal' });
              const frl = await sbPublic('/rest/v1/dispatch_fulfilment_request_lines',
                { method: 'POST', body: JSON.stringify(frLines), headers: { Prefer: 'return=minimal' } });
              if (!frl.ok) return err('Order saved, but the dispatch request lines could not be updated — tell dispatch before they pack: ' + JSON.stringify(frl.data), 502);
              await sbPublic(`/rest/v1/dispatch_fulfilment_requests?id=eq.${encodeURIComponent(frToSync.id)}`,
                { method: 'PATCH', body: JSON.stringify({ requested_units }), prefer: 'return=minimal' });

              if (shipmentToSync) {
                // Collapse to product+model+colour: the manifest is keyed on the physical
                // variant, and two order lines can legitimately name the same one.
                const byVariant = new Map();
                for (const l of frLines) {
                  const k = `${l.product}|${l.model || ''}|${l.color || ''}`;
                  byVariant.set(k, (byVariant.get(k) || 0) + l.qty);
                }
                const shipLines = [...byVariant.entries()].map(([k, qty]) => {
                  const [product, model, color] = k.split('|');
                  return { shipment_id: shipmentToSync, product, model: model || null,
                           color: color || null, target_qty: qty, packed_qty: 0 };
                });
                await sbPublic(`/rest/v1/dispatch_shipment_lines?shipment_id=eq.${encodeURIComponent(shipmentToSync)}`,
                  { method: 'DELETE', prefer: 'return=minimal' });
                const sl = await sbPublic('/rest/v1/dispatch_shipment_lines',
                  { method: 'POST', body: JSON.stringify(shipLines), headers: { Prefer: 'return=minimal' } });
                if (!sl.ok) return err('Order saved, but the dispatch manifest could not be updated — tell dispatch before they pack: ' + JSON.stringify(sl.data), 502);
              }
            }
            const hsnSyncedU = hsnSyncedOnEdit
              ? await syncHsnToMaster(mergedLines, hsnSyncedOnEdit.master,
                  authResult?.fullName || postRole, postRole, null)
              : [];
            return ok({ updated: d.id, dispatch_synced: !!frToSync,
                        manifest_synced: !!shipmentToSync, hsn_synced: hsnSyncedU,
                        hsn_gaps: hsnSyncedOnEdit ? hsnGaps(mergedLines, hsnSyncedOnEdit.master) : [] });
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
            const fr = (await loadFulfilment([{ id: d.id, dispatch_shipment_id: o.dispatch_shipment_id }]))[d.id];
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
            // Warn (not block) on products the HSN master cannot answer for — their GST
            // is the form's 18% default wearing the costume of a real rate. Blocking here
            // would freeze ordering for every SKU still awaiting a code from finance, so
            // the gap is surfaced loudly instead and generateInvoice stays the hard gate.
            let confirmGaps = [];
            try { confirmGaps = hsnGaps(lines, await hsnMasterAll()); } catch (_) { /* warning only — the confirm already landed */ }
            return ok({ confirmed: d.id, request_no: frRes.data[0].request_no, hsn_gaps: confirmGaps });
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
