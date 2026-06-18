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
const canUpdateOrder     = p => !!p.order_manage || !!p.sf_order_update || !!p.sf_po_manage;       // SF may move status/tracking
const canManageShipments = p => !!p.shipment_manage || !!p.sf_order_update || !!p.sf_po_manage;    // SF updates milestones
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
const canSuperAdmin      = p => !!p.manifest_super_admin;   // governs access + roles (Afshaan/Vinay)
const canViewCost        = p => !!p.cost_view;   // v2 landed-CPU / margin lens (SF lacks it)
// SF lifecycle ownership (Phase 1, 2026-06-17). LOT manifest_admin always overrides so admins can drive/test.
const canSfPoManage      = p => !!p.sf_po_manage     || !!p.manifest_admin;                        // convert/edit/place/advance/ship/pay/cancel
const canSfInvoice       = p => !!p.sf_invoice_create || !!p.manifest_admin || !!p.payment_record; // invoice/close (LOT finance/admin override)

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
  const ur = await sb(`/rest/v1/manifest_user_roles?user_id=eq.${userId}&active=is.true&select=role_key&limit=1`);
  if (!ur.ok || !ur.data[0]) return { roleKey: null, party: null, perms: {} };
  const roleKey = ur.data[0].role_key;
  const r = await sb(`/rest/v1/manifest_roles?role_key=eq.${encodeURIComponent(roleKey)}&select=permissions,party&limit=1`);
  if (!r.ok || !r.data[0]) return { roleKey, party: null, perms: {} };
  return { roleKey, party: r.data[0].party || null, perms: r.data[0].permissions || {} };
}

// Count users whose ACTIVE role carries manifest_super_admin. Backs the last-super-admin guards.
async function activeSuperAdminUserIds() {
  const rolesR = await sb('/rest/v1/manifest_roles?select=role_key,permissions');
  const superKeys = new Set((rolesR.ok ? rolesR.data : [])
    .filter(r => r.permissions && r.permissions.manifest_super_admin)
    .map(r => r.role_key));
  if (!superKeys.size) return [];
  const urR = await sb('/rest/v1/manifest_user_roles?active=is.true&select=user_id,role_key');
  return (urR.ok ? urR.data : []).filter(u => superKeys.has(u.role_key)).map(u => u.user_id);
}

// Resolve an auth user id by email via a SECURITY DEFINER RPC. The GoTrue admin
// `/admin/users?email=` filter is UNRELIABLE (it ignores the filter and returns the
// first user in the list) — do not use it for email lookups.
async function resolveAuthUserId(email) {
  const r = await sb('/rest/v1/rpc/user_id_by_email', { method: 'POST', body: JSON.stringify({ p_email: email }) });
  if (!r.ok || r.data == null) return null;
  const v = r.data;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : (v[0]?.user_id_by_email || null);
  return v.user_id_by_email || null;
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

// SF invoice number — derived from the existing VWINV series, never fed manually.
// Format: VWINV-<FY><runningN>, FY = Indian financial year (Apr–Mar) as 4 digits
// e.g. FY2026-27 → "2627"; tail = literal "00" + plain integer (3→…→18 today).
// So VWINV-2627003 … VWINV-26270018; next = max(N)+1 within the current FY.
function invoiceFyCode(iso) {
  const [y, m] = String(iso || todayISO()).split('-').map(Number);
  const start = m >= 4 ? y : y - 1;                  // FY starts in April
  return String(start % 100).padStart(2, '0') + String((start + 1) % 100).padStart(2, '0');
}
async function nextInvoiceNo() {
  const fy = invoiceFyCode(todayISO());
  const prefix = `VWINV-${fy}`;                       // e.g. VWINV-2627
  const r = await query('sf_invoices', '?select=invoice_no');
  let maxN = 0;
  (r.ok ? r.data : []).forEach((row) => {
    const no = String(row.invoice_no || '');
    if (!no.startsWith(prefix)) return;
    const n = parseInt(no.slice(prefix.length), 10);  // "003"→3, "0018"→18
    if (!isNaN(n) && n > maxN) maxN = n;
  });
  return `${prefix}00${maxN + 1}`;                    // VWINV-2627 + "00" + N
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

// Append a stage-transition event to the timeline log.
async function logStageEvent(auth, { entity, order_id, shipment_id, stage, from_stage, note }) {
  try {
    await insert('stage_events', {
      entity, order_id: order_id || null, shipment_id: shipment_id || null,
      stage, from_stage: from_stage || null, note: note || null,
      actor: auth?.userId || null, actor_name: auth?.fullName || null, party: auth?.party || null,
    }, 'return=minimal');
  } catch (e) { console.error('stage event log failed:', e); }
}
// Distinct shipment legs (+status) carrying a given order.
async function orderLegs(orderId) {
  const r = await query('shipment_lines', `?select=shipment_id,shipments(shipment_no,status),order_lines!inner(order_id)&order_lines.order_id=eq.${encodeURIComponent(orderId)}`);
  if (!r.ok) return [];
  const seen = {};
  (r.data || []).forEach(l => { if (l.shipment_id && !seen[l.shipment_id]) seen[l.shipment_id] = l.shipments || {}; });
  return Object.entries(seen).map(([id, s]) => ({ shipment_id: Number(id), shipment_no: s.shipment_no, status: s.status }));
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
const ORDER_COST_FIELDS = ['qty','per_unit_rmb','purchase_inr','shipping_inr','customs_inr','gst_percent','order_label','billing_subentity','invoice_date'];
const LINE_FIELDS  = ['line_no','product','variant','color','item_type','part_code','description','qty','unit',
  'unit_price_rmb','hsn_code','gst_percent','component_type','receive_format','remote_qty','weight_kg','cbm',
  'vendor_item_code','lot_product_code'];
const SHIPMENT_FIELDS = ['shipment_no','mode','container_type','container_no','bl_awb_no','forwarder_code','forwarder_name',
  'status','etd','eta','loading_date','unloading_date','port_arrival_date','customs_entry_date','clearance_date',
  'local_dispatch_date','warehouse_delivery_date','notes','cost_notes',
  'last_mile_forwarder_code','last_mile_forwarder_name','last_mile_vehicle_no'];
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

// ── order lifecycle: stages + shipment milestone mapping ──────────
const ORDER_PROD_STAGES = ['draft', 'placed', 'confirmed', 'produced', 'picked_up'];
const SHIP_STAGES = ['planned', 'loaded', 'sailing', 'docked', 'cleared', 'local_transport', 'received'];
const SHIP_DATE_COL = {
  loaded: 'loading_date', sailing: 'etd', docked: 'port_arrival_date',
  cleared: 'clearance_date', local_transport: 'local_dispatch_date', received: 'warehouse_delivery_date',
};
// recompute order INR cost rollup from its components (base = purchase+shipping+customs; +GST)
function recomputeOrderCost(o) {
  const purchase = Number(o.purchase_inr) || 0, shipping = Number(o.shipping_inr) || 0, customs = Number(o.customs_inr) || 0;
  const base = purchase + shipping + customs;
  const gstPct = o.gst_percent != null ? Number(o.gst_percent) : 18;
  const gst = +(base * gstPct / 100).toFixed(2);
  return { base_inr: +base.toFixed(2), gst_inr: gst, total_inr: +(base + gst).toFixed(2) };
}
// Effective (display) stage: production stages pass through; a 'shipped' order
// refines to its least-advanced leg's shipping stage; all-legs-received → received.
function effStage(status, legs) {
  if (status !== 'shipped') return status;
  if (!legs.length) return 'shipped';
  if (legs.every(l => l.status === 'received')) return 'received';
  const idx = legs.map(l => SHIP_STAGES.indexOf(l.status)).filter(i => i >= 0);
  return idx.length ? SHIP_STAGES[Math.min(...idx)] : 'shipped';
}
const orderEditable = (o) => o.cost_state !== 'invoiced' && o.status !== 'cancelled';

// full 10-step pipeline for schedule "due-stage reached" comparison
const MONEY_PIPELINE = ['draft', 'placed', 'confirmed', 'produced', 'picked_up', 'loaded', 'sailing', 'docked', 'cleared', 'local_transport', 'received'];
// per-PO money: allocated (Σ allocations), balance due (landed − allocated), scheduled-due-now (reached milestones − allocated)
function computePoMoney(order, allocations, schedule, eff) {
  const total = Number(order.total_inr) || 0;
  const allocated = (allocations || []).reduce((s, a) => s + (Number(a.amount_inr) || 0), 0);
  const ei = MONEY_PIPELINE.indexOf(eff);
  let reached = 0;
  (schedule || []).forEach((m) => {
    const due = m.amount_inr != null ? Number(m.amount_inr) : (m.pct != null ? total * Number(m.pct) / 100 : 0);
    if (ei >= 0 && MONEY_PIPELINE.indexOf(m.due_stage) <= ei) reached += due;
  });
  return { allocated: +allocated.toFixed(2), balanceDue: +(total - allocated).toFixed(2), scheduledDueNow: Math.max(0, +(reached - allocated).toFixed(2)) };
}

// ── shipment modes (Air vs Sea) — labels + per-mode timeline pre-fill (Phase 5, 2026-06-17) ──
// Underlying status keys are shared; mode only relabels (Decision A). Land falls back to sea.
const MODE_STAGE_LABELS = {
  sea: { loaded: 'Loaded', sailing: 'Sailing', docked: 'Docked', cleared: 'Cleared', local_transport: 'Local transport', received: 'Received' },
  air: { loaded: 'Loaded', sailing: 'In Flight', docked: 'Landed', cleared: 'Cleared', local_transport: 'Local transport', received: 'Received' },
};
const modeLabels = (mode) => MODE_STAGE_LABELS[mode] || MODE_STAGE_LABELS.sea;
const blAwbLabel = (mode) => (mode === 'air' ? 'Air Waybill (AWB)' : 'Bill of Lading (BL)');
// stage → the shipment date column the pre-fill writes (estimate cols)
const PREFILL_DATE_COL = {
  loaded: 'loading_date', sailing: 'etd', docked: 'eta',
  cleared: 'clearance_date', local_transport: 'local_dispatch_date', received: 'warehouse_delivery_date',
};
function addDays(iso, n) { const dt = new Date(iso + 'T00:00:00Z'); dt.setUTCDate(dt.getUTCDate() + n); return dt.toISOString().split('T')[0]; }
// Build a {date col → ISO} patch by walking the editable stage_defaults offsets, anchored off the
// real dates the user gave at creation. If sailing (etd) is known → only the downstream legs
// (docked→received) are suggested forward from it; if only loading is known → from sailing onward;
// if neither → from today (loaded onward). Explicit dates are preserved by the caller (fill-if-blank).
async function prefillShipmentDates(mode, opts = {}) {
  const r = await query('stage_defaults', `?mode=eq.${encodeURIComponent(mode)}&select=stage,offset_days`);
  if (!r.ok || !r.data.length) return {};
  const off = {}; r.data.forEach(x => { off[x.stage] = Number(x.offset_days) || 0; });
  let cur, startAfter;
  if (opts.etd)               { cur = opts.etd;          startAfter = 'sailing'; }
  else if (opts.loading_date) { cur = opts.loading_date; startAfter = 'loaded'; }
  else                        { cur = opts.anchor || todayISO(); startAfter = null; }
  const patch = {};
  let started = startAfter == null;
  for (const stage of SHIP_STAGES) {              // planned skipped (no offset/date col)
    if (!started) { if (stage === startAfter) started = true; continue; }  // skip up to & incl. the known stage
    if (off[stage] == null) continue;
    cur = addDays(cur, off[stage]);
    if (PREFILL_DATE_COL[stage]) patch[PREFILL_DATE_COL[stage]] = cur;
  }
  return patch;
}
// charge_type (UI) → charges.category (existing enum). Logistics costs map onto existing categories — no new enum.
const SHIPMENT_COST_CATEGORY = { shipping: 'intl_freight', customs: 'customs_duty', other_fees: 'clearing', last_mile: 'local_freight' };
// PI (+ future) doc types → an order-timeline milestone event.
const DOC_TYPE_MILESTONE = { pi: 'pi_attached' };
// Current pool net (running_account final balance) — drives the pool-sufficiency nudge.
async function getPoolNet() {
  const r = await query('running_account', '?select=signed_inr');
  if (!r.ok) return null;
  return +(r.data || []).reduce((s, e) => s + (Number(e.signed_inr) || 0), 0).toFixed(2);
}

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
            // order → shipment legs (for effective stage)
            const slAll = await query('shipment_lines', '?select=shipment_id,shipments(status),order_lines!inner(order_id)');
            const legsByOrder = {};
            (slAll.ok ? slAll.data : []).forEach(l => {
              const oid = l.order_lines?.order_id; if (!oid) return;
              legsByOrder[oid] = legsByOrder[oid] || [];
              if (!legsByOrder[oid].some(x => x.shipment_id === l.shipment_id)) legsByOrder[oid].push({ shipment_id: l.shipment_id, status: l.shipments?.status });
            });
            // per-order allocated total (for balance-due column)
            const allocAll = await query('po_allocations', '?select=order_id,amount_inr');
            const allocByOrder = {};
            (allocAll.ok ? allocAll.data : []).forEach(a => { allocByOrder[a.order_id] = (allocByOrder[a.order_id] || 0) + (Number(a.amount_inr) || 0); });

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
              effectiveStage: effStage(o.status, legsByOrder[o.id] || []),
              allocated: +(allocByOrder[o.id] || 0).toFixed(2),
              balanceDue: +((Number(o.total_inr) || 0) - (allocByOrder[o.id] || 0)).toFixed(2),
              label: o.order_label, invoiceNo: o.invoice_no, date: fmtDay(o.invoice_date || o.created_at),
            }, P));

            // ── payments / drawdowns / shipments / fx / docs / activity ──
            const payments = (pmR.ok ? pmR.data : []).map(p => ({
              ref: p.payment_no, date: fmtDay(p.paid_date), inr: Number(p.amount_inr) || 0,
              rmb: p.amount_rmb != null ? Number(p.amount_rmb) : null, rate: p.fx_rate_used != null ? Number(p.fx_rate_used) : null,
              method: p.method || 'Bank', against: p.subentity_code || (p.drawdown_id ? 'Draw-down' : 'Advance'),
              utr: p.utr || null, status: 'cleared',
            }));
            const drawdowns = (ddR.ok ? ddR.data : []).map(d => ({
              no: d.drawdown_no, phase: d.phase, order: d.order_id ? (orderNoById[d.order_id] || null) : null,
              estInr: Number(d.est_amount_inr) || 0, rate: d.est_fx_rate != null ? Number(d.est_fx_rate) : null,
              by: d.requested_by_name || '—', date: fmtDay(d.requested_at), status: d.status,
            }));
            const shipments = (shR.ok ? shR.data : []).map(s => ({
              id: s.id, no: s.shipment_no, mode: s.mode || '—', blAwb: s.bl_awb_no || '—',
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

            // ── governance payload (super admin only) ──
            let roles = [], accessUsers = [];
            if (canSuperAdmin(P)) {
              const [rolesR, urR, profR] = await Promise.all([
                query('manifest_roles', '?order=party.asc,role_key.asc&select=*'),
                query('manifest_user_roles', '?select=user_id,role_key,active,disabled_at'),
                queryStore('users_profile', '?select=id,full_name,active&order=full_name.asc'),
              ]);
              roles = rolesR.ok ? rolesR.data : [];
              const roleMeta = {}; roles.forEach(r => { roleMeta[r.role_key] = r; });
              const profById = {}; (profR.ok ? profR.data : []).forEach(u => { profById[u.id] = u; });
              accessUsers = (urR.ok ? urR.data : []).map(u => {
                const rm = roleMeta[u.role_key]; const pf = profById[u.user_id] || {};
                return { user_id: u.user_id, full_name: pf.full_name || '—', role_key: u.role_key,
                         role_label: rm ? (rm.label || u.role_key) : u.role_key, party: rm ? rm.party : 'LOT',
                         active: u.active !== false, disabled_at: u.disabled_at || null };
              }).sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
            }

            return ok({
              me: { id: userId, email: auth.email, role: auth.role, full_name: auth.fullName, manifest_role: auth.manifestRole, party, permissions: P },
              summary, ledger, orders, payments, drawdowns, shipments, fx, documents, activity,
              subentities: subR.ok ? subR.data : [], roles, accessUsers,
            });
          }

          // ── Masters (store) ──
          case 'getVendors': {
            const r = await queryStore('vendors', '?order=vendor_name.asc&select=vendor_code,vendor_name,source_country,currency,active');
            if (!r.ok) return err(r.data);
            return ok(r.data);
          }
          case 'getForwarders': {
            const r = await queryStore('forwarders', '?active=eq.true&order=company_name.asc&select=forwarder_code,company_name,country,country_iso,modes_supported,sea_days,air_days,land_days,iata_code,scac_code,tracking_url');
            if (!r.ok) return err(r.data);
            return ok(r.data);
          }
          case 'getAddresses': {
            const r = await queryStore('company_addresses', '?active=eq.true&order=label.asc');
            if (!r.ok) return err(r.data);
            return ok(r.data);
          }
          // ── Shipment-defaults config (editable per-mode timelines; suggest-not-lock) ──
          case 'getStageDefaults': {
            const r = await query('stage_defaults', '?order=mode.asc,stage.asc&select=*');
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
            // timeline: order production events + per-leg shipment events
            const legs = await orderLegs(id);
            const oEvR = await query('stage_events', `?entity=eq.order&order_id=eq.${encodeURIComponent(id)}&order=occurred_at.asc&select=stage,from_stage,note,actor_name,party,occurred_at`);
            const legEvents = {};
            if (legs.length) {
              const ids = legs.map(l => l.shipment_id).join(',');
              const seR = await query('stage_events', `?entity=eq.shipment&shipment_id=in.(${ids})&order=occurred_at.asc&select=shipment_id,stage,from_stage,note,actor_name,party,occurred_at`);
              (seR.ok ? seR.data : []).forEach(e => { (legEvents[e.shipment_id] = legEvents[e.shipment_id] || []).push(e); });
            }
            const eff = effStage(o.status, legs);
            // per-PO money: schedule + allocations + computed balance
            const [allocR, schedR] = await Promise.all([
              query('po_allocations', `?order_id=eq.${encodeURIComponent(id)}&order=allocated_date.desc,created_at.desc&select=*`),
              query('po_payment_schedule', `?order_id=eq.${encodeURIComponent(id)}&order=seq.asc&select=*`),
            ]);
            const allocations = allocR.ok ? allocR.data : [];
            const schedule = schedR.ok ? schedR.data : [];
            const money = stripCost(computePoMoney(o, allocations, schedule, eff), P);
            // auto invoice number preview (read-only in the UI; never typed)
            const suggestedInvoiceNo = o.cost_state === 'invoiced' ? null : await nextInvoiceNo();
            return ok({
              order: stripCost(o, P),
              suggestedInvoiceNo,
              lines: (lR.ok ? lR.data : []).map(l => stripCost(l, P)),
              documents: dR.ok ? dR.data : [],
              costRows: stripCost({ rows: costRows }, P).rows || costRows,
              landed: Number(o.total_inr) || 0,
              commission,
              drawdown: dd ? { no: dd.drawdown_no, amt: Number(dd.est_amount_inr) || 0, status: dd.status } : null,
              effectiveStage: eff,
              editable: orderEditable(o),
              orderEvents: oEvR.ok ? oEvR.data : [],
              legs: legs.map(l => ({ ...l, events: legEvents[l.shipment_id] || [] })),
              schedule, allocations, money,
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
            const [sR, slR, dR, evR] = await Promise.all([
              query('shipments', `?id=eq.${encodeURIComponent(id)}&select=*&limit=1`),
              query('shipment_lines', `?shipment_id=eq.${encodeURIComponent(id)}&select=*,order_lines(*,orders(order_no,title,vendor_name))`),
              query('documents', `?shipment_id=eq.${encodeURIComponent(id)}&order=created_at.desc&select=*`),
              query('stage_events', `?entity=eq.shipment&shipment_id=eq.${encodeURIComponent(id)}&order=occurred_at.asc&select=stage,from_stage,note,actor_name,party,occurred_at`),
            ]);
            if (!sR.ok || !sR.data[0]) return err('Shipment not found', 404);
            const sh = sR.data[0];
            return ok({
              shipment: sh,
              stageLabels: modeLabels(sh.mode), blAwbLabel: blAwbLabel(sh.mode),
              lines: (slR.ok ? slR.data : []).map(l => ({ ...l, order_lines: stripCost(l.order_lines, P) })),
              documents: dR.ok ? dR.data : [],
              events: evR.ok ? evR.data : [],
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
            if (!canSuperAdmin(P)) return err('No permission', 403);
            const r = await query('manifest_roles', '?order=party.asc,role_key.asc&select=*');
            if (!r.ok) return err(r.data);
            return ok(r.data);
          }
          case 'getUsers': {
            if (!canSuperAdmin(P)) return err('No permission', 403);
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
              status: d.status || 'draft',
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
            const curR = await query('orders', `?id=eq.${encodeURIComponent(d.id)}&select=*&limit=1`);
            if (!curR.ok || !curR.data[0]) return err('Order not found', 404);
            const cur = curR.data[0];
            if (!orderEditable(cur)) return err('Order is invoiced or cancelled — edits are locked', 422);
            const patch = { ...pick(d, ORDER_FIELDS), ...pick(d, ORDER_COST_FIELDS), updated_at: nowISO() };
            Object.assign(patch, recomputeOrderCost({ ...cur, ...patch }));
            const r = await update('orders', patch, `id=eq.${encodeURIComponent(d.id)}`);
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
            const lockR = await query('orders', `?id=eq.${encodeURIComponent(d.order_id)}&select=cost_state,status&limit=1`);
            if (lockR.ok && lockR.data[0] && !orderEditable(lockR.data[0])) return err('Order is invoiced or cancelled — line edits are locked', 422);
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
          case 'advanceOrderStage': {
            // Production-half stages (placed/confirmed/produced/picked_up) + cancel. LOT or SF.
            if (!canUpdateOrder(P)) return err('No permission', 403);
            if (!d.order_id || !d.stage) return err('order_id and stage required');
            const target = d.stage;
            if (!ORDER_PROD_STAGES.includes(target) && target !== 'cancelled') return err('Invalid order stage: ' + target, 422);
            const oR = await query('orders', `?id=eq.${encodeURIComponent(d.order_id)}&select=status&limit=1`);
            if (!oR.ok || !oR.data[0]) return err('Order not found', 404);
            const from = oR.data[0].status;
            if (from === 'cancelled') return err('Order is cancelled', 422);
            if (target === 'cancelled' && !['requested','draft','placed','confirmed','produced'].includes(from))
              return err('Cannot cancel after pickup — goods are paid for and in transit', 409);
            if (['shipped', 'received'].includes(from) && target !== 'cancelled') return err('Order is in shipping — advance its shipment legs instead', 422);
            if (target === 'placed') {
              const lc = await query('order_lines', `?order_id=eq.${encodeURIComponent(d.order_id)}&select=id&limit=1`);
              if (!lc.ok || !lc.data[0]) return err('Add at least one line item before placing the order', 422);
            }
            const r = await update('orders', { status: target, updated_at: nowISO() }, `id=eq.${encodeURIComponent(d.order_id)}`);
            if (!r.ok) return err('Stage update failed: ' + JSON.stringify(r.data), 502);
            await logStageEvent(auth, { entity: 'order', order_id: d.order_id, stage: target, from_stage: from, note: d.note });
            await logActivity(auth, 'order_stage', { scope: 'order', order_id: d.order_id, detail: target });
            return ok({ order_id: d.order_id, status: target });
          }
          case 'convertToPo': {
            // SF claims a LOT request and opens it as an editable PO draft. requested → draft.
            if (!canSfPoManage(P)) return err('No permission (SF PO management)', 403);
            if (!d.order_id) return err('order_id required');
            const oR = await query('orders', `?id=eq.${encodeURIComponent(d.order_id)}&select=status&limit=1`);
            if (!oR.ok || !oR.data[0]) return err('Order not found', 404);
            if (oR.data[0].status !== 'requested') return err('Only a requested order can be converted to a PO', 422);
            const r = await update('orders', { status: 'draft', placed_via: 'SF', updated_at: nowISO() }, `id=eq.${encodeURIComponent(d.order_id)}`);
            if (!r.ok) return err('Convert failed: ' + JSON.stringify(r.data), 502);
            await logStageEvent(auth, { entity: 'order', order_id: d.order_id, stage: 'draft', from_stage: 'requested', note: 'Converted to PO' });
            await logActivity(auth, 'order_converted', { scope: 'order', order_id: d.order_id });
            return ok(Array.isArray(r.data) ? r.data[0] : r.data);
          }
          case 'cancelOrder': {
            // Cancellable only up to & including 'produced' (never after pickup). Reason required. No payment auto-reversal.
            if (!canSfPoManage(P)) return err('No permission', 403);
            if (!d.order_id) return err('order_id required');
            if (!d.reason || !String(d.reason).trim()) return err('A cancellation reason is required', 400);
            const oR = await query('orders', `?id=eq.${encodeURIComponent(d.order_id)}&select=status&limit=1`);
            if (!oR.ok || !oR.data[0]) return err('Order not found', 404);
            const from = oR.data[0].status;
            if (!['requested','draft','placed','confirmed','produced'].includes(from))
              return err('Cannot cancel after pickup — goods are paid for and in transit', 409);
            const r = await update('orders', { status: 'cancelled', cost_state: 'cancelled', updated_at: nowISO() }, `id=eq.${encodeURIComponent(d.order_id)}`);
            if (!r.ok) return err('Cancel failed: ' + JSON.stringify(r.data), 502);
            await logStageEvent(auth, { entity: 'order', order_id: d.order_id, stage: 'cancelled', from_stage: from, note: d.reason });
            await logActivity(auth, 'order_cancelled', { scope: 'order', order_id: d.order_id, detail: d.reason });
            return ok({ order_id: d.order_id, status: 'cancelled' });
          }
          case 'invoiceOrder': {
            // SF closes an order out with a RECORD — partial allowed, per-line GST, optional 2.5% commission.
            // Pool impact = COMMISSION ONLY (goods/logistics already debited via payments §6); GST is a document figure.
            if (!canSfInvoice(P)) return err('No permission (invoice/close)', 403);
            if (!d.order_id) return err('order_id required');
            const oR = await query('orders', `?id=eq.${encodeURIComponent(d.order_id)}&select=*&limit=1`);
            if (!oR.ok || !oR.data[0]) return err('Order not found', 404);
            const o = oR.data[0];
            if (o.status === 'cancelled') return err('Order is cancelled', 422);
            if (o.cost_state === 'invoiced') return err('Order already fully invoiced', 422);
            // billable = goods lines not yet stamped with an invoice_no; restrict to line_ids if given.
            const lR = await query('order_lines', `?order_id=eq.${encodeURIComponent(d.order_id)}&order=line_no.asc&select=*`);
            const allLines = lR.ok ? lR.data : [];
            const wantIds = Array.isArray(d.line_ids) && d.line_ids.length ? d.line_ids.map(String) : null;
            const billable = allLines.filter(l => !l.invoice_no && (!wantIds || wantIds.includes(String(l.id))));
            if (!billable.length) return err('No billable (un-invoiced) lines selected', 422);
            // value each billed line in INR via FX at invoice date (RMB price × qty × rate). [valuation flagged for reseed]
            const invDate = d.invoice_date || todayISO();
            const fx = await fxForDate(invDate) || 0;
            const gstBy = d.gst_by_line || {};
            // header-fallback: lines with no per-unit ¥ (lump/historical orders) bill the order's
            // stored INR base, split across such lines — so a lump order is still closeable.
            const orderBase = Number(o.base_inr) || ((Number(o.purchase_inr) || 0) + (Number(o.shipping_inr) || 0) + (Number(o.customs_inr) || 0));
            const zeroValLines = billable.filter((l) => !(Number(l.qty || 0) * Number(l.unit_price_rmb || 0) * fx));
            const fallbackEach = zeroValLines.length ? +(orderBase / zeroValLines.length).toFixed(2) : 0;
            let goodsInr = 0, gstInr = 0; const stamped = [];
            for (const l of billable) {
              let lineInr = +(Number(l.qty || 0) * Number(l.unit_price_rmb || 0) * fx).toFixed(2);
              if (!lineInr) lineInr = fallbackEach;
              const gstPct = gstBy[l.id] != null ? Number(gstBy[l.id]) : (l.gst_percent != null ? Number(l.gst_percent) : 18);
              goodsInr += lineInr; gstInr += +(lineInr * gstPct / 100).toFixed(2);
              stamped.push({ id: l.id, gstPct });
            }
            goodsInr = +goodsInr.toFixed(2); gstInr = +gstInr.toFixed(2);
            const includeComm = !!d.include_commission;
            const subtotal = +(goodsInr + gstInr).toFixed(2);
            const commission = includeComm ? +(subtotal * 0.025).toFixed(2) : 0;
            const invoiceTotal = +(subtotal + commission).toFixed(2);
            const invoice_no = (d.invoice_no && String(d.invoice_no).trim()) || await nextInvoiceNo();
            // 1) stamp each billed line (bills once)
            for (const s of stamped) await update('order_lines', { invoice_no, gst_percent: s.gstPct }, `id=eq.${s.id}`);
            // 2) all goods lines billed now? → invoiced, else partially_invoiced
            const remaining = allLines.filter(l => !l.invoice_no && !stamped.some(s => String(s.id) === String(l.id)));
            const newCostState = remaining.length ? 'partially_invoiced' : 'invoiced';
            await update('orders', { invoice_no, invoice_date: invDate, cost_state: newCostState, updated_at: nowISO() }, `id=eq.${encodeURIComponent(d.order_id)}`);
            // 3) (re)write the sf_invoices row — commission is the only pool impact (via running_account)
            const fy = invoiceFyCode(invDate);
            const period = d.period || `FY20${fy.slice(0, 2)}-${fy.slice(2)}`;
            const exist = await query('sf_invoices', `?invoice_no=eq.${encodeURIComponent(invoice_no)}&select=id&limit=1`);
            const invRow = { period, invoice_date: invDate, billing_subentity: o.billing_subentity || null,
              total_inr: invoiceTotal, commission_rate: includeComm ? 2.5 : 0, commission_inr: commission, status: 'received' };
            if (exist.ok && exist.data[0]) await update('sf_invoices', invRow, `invoice_no=eq.${encodeURIComponent(invoice_no)}`);
            else await insert('sf_invoices', { invoice_no, ...invRow, notes: d.notes || null, created_by: userId }, 'return=minimal');
            await logStageEvent(auth, { entity: 'order', order_id: d.order_id, stage: newCostState, note: invoice_no });
            await logActivity(auth, 'order_invoiced', { scope: 'order', order_id: d.order_id, detail: `${invoice_no} (${newCostState})` });
            return ok({ order_id: d.order_id, invoice_no, cost_state: newCostState, goods_inr: goodsInr, gst_inr: gstInr, commission_inr: commission, invoice_total_inr: invoiceTotal, lines_billed: stamped.length });
          }

          // ── PO money layer: per-PO allocations + schedule + container move ──
          case 'allocateToPo': {
            if (!canRecordPayment(P)) return err('No permission', 403);
            const amt = num(d.amount_inr);
            if (!d.order_id || !(amt > 0)) return err('order_id and amount_inr > 0 required', 422);
            const row = { order_id: d.order_id, amount_inr: +amt.toFixed(2), payment_id: d.payment_id || null,
              allocated_date: d.allocated_date || todayISO(), note: d.note || null, created_by: userId, created_by_name: auth.fullName };
            const r = await insert('po_allocations', row);
            if (!r.ok) return err('Allocation failed: ' + JSON.stringify(r.data), 502);
            await logActivity(auth, 'po_allocation', { scope: 'order', order_id: d.order_id, detail: `₹${amt}` });
            return ok(Array.isArray(r.data) ? r.data[0] : r.data);
          }
          case 'deleteAllocation': {
            if (!canRecordPayment(P)) return err('No permission', 403);
            if (!d.id) return err('id required');
            const r = await del('po_allocations', `id=eq.${encodeURIComponent(d.id)}`);
            if (!r.ok) return err('Delete failed: ' + JSON.stringify(r.data), 502);
            return ok({ deleted: d.id });
          }
          case 'setPoSchedule': {
            if (!canManageOrders(P) && !canRecordPayment(P)) return err('No permission', 403);
            if (!d.order_id) return err('order_id required');
            await del('po_payment_schedule', `order_id=eq.${encodeURIComponent(d.order_id)}`);
            const ms = Array.isArray(d.milestones) ? d.milestones : [];
            if (ms.length) {
              const rows = ms.map((m, i) => ({ order_id: d.order_id, seq: m.seq || i + 1, label: m.label || `Milestone ${i + 1}`,
                pct: (m.pct != null && m.pct !== '') ? num(m.pct) : null,
                amount_inr: (m.amount_inr != null && m.amount_inr !== '') ? num(m.amount_inr) : null,
                due_stage: m.due_stage || 'placed' }));
              const r = await insert('po_payment_schedule', rows, 'return=minimal');
              if (!r.ok) return err('Schedule save failed: ' + JSON.stringify(r.data), 502);
            }
            await logActivity(auth, 'po_schedule_set', { scope: 'order', order_id: d.order_id });
            return ok({ saved: ms.length });
          }
          case 'moveOrderToShipment': {
            // container reassignment: re-point this order's shipment_lines to to_shipment_id (or detach if absent)
            if (!canManageShipments(P)) return err('No permission', 403);
            if (!d.order_id) return err('order_id required');
            const slR = await query('shipment_lines', `?select=id,order_lines!inner(order_id)&order_lines.order_id=eq.${encodeURIComponent(d.order_id)}`);
            const rows = slR.ok ? slR.data : [];
            if (d.to_shipment_id) {
              for (const sl of rows) await update('shipment_lines', { shipment_id: d.to_shipment_id }, `id=eq.${sl.id}`);
              await update('orders', { status: 'shipped', updated_at: nowISO() }, `id=eq.${encodeURIComponent(d.order_id)}`);
              await logStageEvent(auth, { entity: 'order', order_id: d.order_id, stage: 'shipped', from_stage: 'shipped', note: 'Moved to shipment ' + d.to_shipment_id });
            } else {
              for (const sl of rows) await del('shipment_lines', `id=eq.${sl.id}`);
              await update('orders', { status: 'picked_up', updated_at: nowISO() }, `id=eq.${encodeURIComponent(d.order_id)}`);
              await logStageEvent(auth, { entity: 'order', order_id: d.order_id, stage: 'picked_up', from_stage: 'shipped', note: 'Detached from shipment' });
            }
            await logActivity(auth, 'order_container_moved', { scope: 'order', order_id: d.order_id, detail: d.to_shipment_id ? '→ ' + d.to_shipment_id : 'detached' });
            return ok({ order_id: d.order_id, moved: rows.length, to_shipment_id: d.to_shipment_id || null });
          }

          // ── Shipments + consolidation ──
          case 'createShipment': {
            if (!canManageShipments(P)) return err('No permission', 403);
            const mode = d.mode;
            if (!mode || !['sea', 'air', 'land'].includes(mode)) return err('mode required (sea | air)', 422);
            const shipment_no = await nextSeq('mf_shipment', 'SHM-');
            const fields = pick(d, SHIPMENT_FIELDS);
            // pre-fill expected milestone dates from the editable per-mode stage_defaults (suggest, not lock).
            // SF-supplied dates win — only fill the cols SF left blank.
            const prefill = await prefillShipmentDates(mode, { anchor: d.anchor_date, loading_date: fields.loading_date, etd: fields.etd });
            for (const [col, val] of Object.entries(prefill)) if (fields[col] == null) fields[col] = val;
            const row = { ...fields, mode, shipment_no, status: fields.status || 'planned', created_by: userId };
            const r = await insert('shipments', row);
            if (!r.ok) return err('Shipment create failed: ' + JSON.stringify(r.data), 502);
            const sh = Array.isArray(r.data) ? r.data[0] : r.data;
            // immutable original plan = the first dates_planned event (append-only history).
            await logStageEvent(auth, { entity: 'shipment', shipment_id: sh.id, stage: 'dates_planned', note: JSON.stringify(prefill) });
            await logActivity(auth, 'shipment_created', { scope: 'shipment', shipment_id: sh.id, detail: `${shipment_no} (${mode})` });
            return ok(sh);
          }
          case 'updateShipment': {
            if (!canManageShipments(P)) return err('No permission', 403);
            if (!d.id) return err('id required');
            const enc = encodeURIComponent(d.id);
            const curR = await query('shipments', `?id=eq.${enc}&select=*&limit=1`);
            if (!curR.ok || !curR.data[0]) return err('Shipment not found', 404);
            const cur = curR.data[0];
            const patch = pick(d, SHIPMENT_FIELDS);
            // mode is locked once the shipment has loaded (it never changes mid-journey).
            if (patch.mode && patch.mode !== cur.mode && cur.status !== 'planned')
              return err('Mode is locked once a shipment is loaded', 422);
            // log a dates_revised event if any expected milestone date changed (the original plan stays the first event).
            const DATE_COLS = ['etd','eta','loading_date','unloading_date','port_arrival_date','customs_entry_date','clearance_date','local_dispatch_date','warehouse_delivery_date'];
            const changed = {};
            DATE_COLS.forEach(c => { if (patch[c] !== undefined && String(patch[c] || '') !== String(cur[c] || '')) changed[c] = { from: cur[c] || null, to: patch[c] || null }; });
            const r = await update('shipments', { ...patch, updated_at: nowISO() }, `id=eq.${enc}`);
            if (!r.ok) return err('Update failed: ' + JSON.stringify(r.data), 502);
            if (Object.keys(changed).length) await logStageEvent(auth, { entity: 'shipment', shipment_id: d.id, stage: 'dates_revised', note: JSON.stringify(changed) });
            await logActivity(auth, 'shipment_updated', { scope: 'shipment', shipment_id: d.id });
            return ok(Array.isArray(r.data) ? r.data[0] : r.data);
          }
          case 'setShipmentLines': {
            // Replace which order lines (+ qty) ride this shipment.
            if (!canManageShipments(P)) return err('No permission', 403);
            if (!d.shipment_id) return err('shipment_id required');
            // departure-lock: a shipment's manifest freezes once it sails / takes off (status='sailing'+).
            const slockR = await query('shipments', `?id=eq.${encodeURIComponent(d.shipment_id)}&select=status&limit=1`);
            if (slockR.ok && slockR.data[0] && !['planned', 'loaded'].includes(slockR.data[0].status))
              return err('Shipment has departed — its contents are locked', 422);
            await del('shipment_lines', `shipment_id=eq.${encodeURIComponent(d.shipment_id)}`);
            const lines = Array.isArray(d.lines) ? d.lines : [];
            if (lines.length) {
              const rows = lines.map(l => ({ shipment_id: d.shipment_id, order_line_id: l.order_line_id, qty_in_shipment: num(l.qty_in_shipment) || 0 }));
              const r = await insert('shipment_lines', rows, 'return=minimal');
              if (!r.ok) return err('Shipment lines failed: ' + JSON.stringify(r.data), 502);
              // hand the linked orders from production → shipping
              const olIds = [...new Set(lines.map(l => l.order_line_id).filter(Boolean))];
              if (olIds.length) {
                const olR = await query('order_lines', `?id=in.(${olIds.join(',')})&select=order_id`);
                const orderIds = [...new Set((olR.ok ? olR.data : []).map(x => x.order_id).filter(Boolean))];
                for (const oid of orderIds) {
                  const oR = await query('orders', `?id=eq.${oid}&select=status&limit=1`);
                  const st = oR.ok && oR.data[0] ? oR.data[0].status : null;
                  if (st && ORDER_PROD_STAGES.includes(st)) {
                    await update('orders', { status: 'shipped', updated_at: nowISO() }, `id=eq.${oid}`);
                    await logStageEvent(auth, { entity: 'order', order_id: oid, stage: 'shipped', from_stage: st, note: 'Attached to shipment ' + (d.shipment_id) });
                  }
                }
              }
            }
            await logActivity(auth, 'shipment_lines_set', { scope: 'shipment', shipment_id: d.shipment_id });
            return ok({ saved: lines.length });
          }
          case 'allocateItemsToShipment': {
            // Add specific order lines (+ qty) to a shipment (additive). Departure-lock guarded.
            if (!canManageShipments(P)) return err('No permission', 403);
            if (!d.shipment_id || !Array.isArray(d.items) || !d.items.length) return err('shipment_id and items[] required', 422);
            const enc = encodeURIComponent(d.shipment_id);
            const sR = await query('shipments', `?id=eq.${enc}&select=status&limit=1`);
            if (!sR.ok || !sR.data[0]) return err('Shipment not found', 404);
            if (!['planned', 'loaded'].includes(sR.data[0].status)) return err('Shipment has departed — its contents are locked', 422);
            const rows = d.items.filter(i => i.order_line_id).map(i => ({ shipment_id: d.shipment_id, order_line_id: i.order_line_id, qty_in_shipment: num(i.qty) || 0 }));
            if (!rows.length) return err('no valid items', 422);
            const ins = await insert('shipment_lines', rows, 'return=minimal');
            if (!ins.ok) return err('Allocate failed: ' + JSON.stringify(ins.data), 502);
            // hand the linked orders production → shipping
            const olR = await query('order_lines', `?id=in.(${rows.map(r => r.order_line_id).join(',')})&select=order_id`);
            const orderIds = [...new Set((olR.ok ? olR.data : []).map(x => x.order_id).filter(Boolean))];
            for (const oid of orderIds) {
              const oR = await query('orders', `?id=eq.${oid}&select=status&limit=1`);
              const st = oR.ok && oR.data[0] ? oR.data[0].status : null;
              if (st && ORDER_PROD_STAGES.includes(st)) {
                await update('orders', { status: 'shipped', updated_at: nowISO() }, `id=eq.${oid}`);
                await logStageEvent(auth, { entity: 'order', order_id: oid, stage: 'shipped', from_stage: st, note: 'Allocated to shipment ' + d.shipment_id });
              }
            }
            await logStageEvent(auth, { entity: 'shipment', shipment_id: d.shipment_id, stage: 'items_allocated', note: `${rows.length} line(s)` });
            await logActivity(auth, 'shipment_items_allocated', { scope: 'shipment', shipment_id: d.shipment_id, detail: `${rows.length} line(s)` });
            return ok({ shipment_id: d.shipment_id, allocated: rows.length });
          }
          case 'moveItemsBetweenShipments': {
            // Move specific order lines from one shipment to another. Both must be pre-departure.
            if (!canManageShipments(P)) return err('No permission', 403);
            if (!d.from_shipment_id || !d.to_shipment_id || !Array.isArray(d.items) || !d.items.length) return err('from_shipment_id, to_shipment_id and items[] required', 422);
            for (const sid of [d.from_shipment_id, d.to_shipment_id]) {
              const sR = await query('shipments', `?id=eq.${encodeURIComponent(sid)}&select=status&limit=1`);
              if (!sR.ok || !sR.data[0]) return err('Shipment not found: ' + sid, 404);
              if (!['planned', 'loaded'].includes(sR.data[0].status)) return err('A shipment has departed — its contents are locked', 422);
            }
            const olIds = d.items.map(i => i.order_line_id).filter(Boolean);
            if (!olIds.length) return err('no valid items', 422);
            await update('shipment_lines', { shipment_id: d.to_shipment_id },
              `shipment_id=eq.${encodeURIComponent(d.from_shipment_id)}&order_line_id=in.(${olIds.join(',')})`);
            await logStageEvent(auth, { entity: 'shipment', shipment_id: d.from_shipment_id, stage: 'items_moved_out', note: `→ ${d.to_shipment_id}` });
            await logStageEvent(auth, { entity: 'shipment', shipment_id: d.to_shipment_id, stage: 'items_moved_in', note: `← ${d.from_shipment_id}` });
            await logActivity(auth, 'shipment_items_moved', { scope: 'shipment', shipment_id: d.to_shipment_id, detail: `${olIds.length} line(s)` });
            return ok({ moved: olIds.length, to_shipment_id: d.to_shipment_id });
          }
          case 'advanceShipmentStage': {
            // Shipping-half stages; stamps the matching milestone date; rolls up to orders on 'received'.
            if (!canManageShipments(P)) return err('No permission', 403);
            if (!d.shipment_id || !d.stage) return err('shipment_id and stage required');
            const target = d.stage;
            if (!SHIP_STAGES.includes(target) && target !== 'cancelled') return err('Invalid shipment stage: ' + target, 422);
            const enc = encodeURIComponent(d.shipment_id);
            const sR = await query('shipments', `?id=eq.${enc}&select=status&limit=1`);
            if (!sR.ok || !sR.data[0]) return err('Shipment not found', 404);
            const from = sR.data[0].status;
            const patch = { status: target, updated_at: nowISO() };
            if (SHIP_DATE_COL[target]) patch[SHIP_DATE_COL[target]] = d.date || todayISO();
            const r = await update('shipments', patch, `id=eq.${enc}`);
            if (!r.ok) return err('Shipment stage update failed: ' + JSON.stringify(r.data), 502);
            await logStageEvent(auth, { entity: 'shipment', shipment_id: d.shipment_id, stage: target, from_stage: from, note: d.note });
            if (target === 'received') {
              const slR = await query('shipment_lines', `?shipment_id=eq.${enc}&select=order_lines!inner(order_id)`);
              const orderIds = [...new Set((slR.ok ? slR.data : []).map(l => l.order_lines?.order_id).filter(Boolean))];
              for (const oid of orderIds) {
                const legs = await orderLegs(oid);
                if (legs.length && legs.every(l => l.status === 'received')) {
                  const p2 = { status: 'received', updated_at: nowISO() };
                  const oc = await query('orders', `?id=eq.${oid}&select=cost_state&limit=1`);
                  if (oc.ok && oc.data[0]?.cost_state === 'in_flight') p2.cost_state = 'delivered';
                  await update('orders', p2, `id=eq.${oid}`);
                  await logStageEvent(auth, { entity: 'order', order_id: oid, stage: 'received', from_stage: 'shipped', note: 'All shipment legs received' });
                }
              }
            }
            await logActivity(auth, 'shipment_stage', { scope: 'shipment', shipment_id: d.shipment_id, detail: target });
            return ok({ shipment_id: d.shipment_id, status: target });
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
              subentity_code: d.subentity_code || null, utr: (d.utr && String(d.utr).trim()) || null,
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
            const ptype = d.payment_type && ['advance','pickup_balance','other'].includes(d.payment_type) ? d.payment_type : null;
            const vp_no = await nextSeq('mf_vpay', 'VP-');
            const row = {
              vp_no, vendor_code: d.vendor_code || null, vendor_name: d.vendor_name || null,
              order_id: d.order_id || null, payment_type: ptype, amount_rmb: rmb, amount_inr_debited: +inr.toFixed(2),
              actual_bank_rate: +(inr / rmb).toFixed(6), payment_date: d.payment_date || todayISO(),
              recorded_by: userId, recorded_by_name: auth.fullName, note: d.note || null,
            };
            const r = await insert('vendor_payments', row);
            if (!r.ok) return err('Vendor payment failed: ' + JSON.stringify(r.data), 502);
            // payment-driven: this debits the pool via the running_account view. Log + report pool sufficiency.
            if (d.order_id) await logStageEvent(auth, { entity: 'order', order_id: d.order_id, stage: 'payment', note: `${ptype || 'vendor'} ¥${rmb} = ₹${inr.toFixed(0)}` });
            await logActivity(auth, 'vendor_payment_recorded', { scope: 'vendor_payment', order_id: d.order_id, detail: `${vp_no} ¥${rmb} @ ${(inr / rmb).toFixed(3)}` });
            const pool_after = await getPoolNet();
            return ok({ ...(Array.isArray(r.data) ? r.data[0] : r.data), pool_after, shortfall: (pool_after != null && pool_after < 0) ? +(-pool_after).toFixed(2) : 0 });
          }
          case 'recordShipmentCost': {
            // SF records + pays a logistics cost against a shipment (shipping/customs/other/last-mile).
            // Posts a FINAL (non-estimate) charge → debits the pool immediately via running_account.
            if (!canSfPoManage(P)) return err('No permission', 403);
            if (!d.shipment_id || !d.charge_type) return err('shipment_id and charge_type required', 422);
            const category = SHIPMENT_COST_CATEGORY[d.charge_type];
            if (!category) return err('Invalid charge_type (shipping | customs | other_fees | last_mile)', 422);
            const amount = num(d.amount_inr);
            if (!(amount > 0)) return err('amount_inr must be > 0', 422);
            const charge_no = await nextSeq('mf_charge', 'CHG-');
            const row = {
              charge_no, scope: 'shipment', shipment_id: d.shipment_id, order_id: d.order_id || null,
              category, description: d.notes || d.charge_type, amount, currency: 'INR',
              is_estimate: false, amount_inr: +amount.toFixed(2), due_stage: d.due_stage || null,
              incurred_date: d.incurred_date || todayISO(), source_party: party,
              created_by: userId, created_by_name: auth.fullName,
            };
            const r = await insert('charges', row);
            if (!r.ok) return err('Shipment cost failed: ' + JSON.stringify(r.data), 502);
            await logStageEvent(auth, { entity: 'shipment', shipment_id: d.shipment_id, stage: 'payment', note: `${d.charge_type} ₹${amount.toFixed(0)}` });
            await logActivity(auth, 'shipment_cost_recorded', { scope: 'shipment', shipment_id: d.shipment_id, detail: `${d.charge_type} ${charge_no}` });
            const pool_after = await getPoolNet();
            return ok({ ...(Array.isArray(r.data) ? r.data[0] : r.data), pool_after, shortfall: (pool_after != null && pool_after < 0) ? +(-pool_after).toFixed(2) : 0 });
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
            // milestone doc types (PI, …) also stamp a timestamped event on the order timeline.
            if (DOC_TYPE_MILESTONE[d.doc_type] && d.order_id)
              await logStageEvent(auth, { entity: 'order', order_id: d.order_id, stage: DOC_TYPE_MILESTONE[d.doc_type], note: d.file_name || d.doc_type });
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
            // PARKED (spec §2, 2026-06-17): Manifest POs are raised in the vendor's product codes
            // (e.g. Flare='820D'), not LOT product_master codes — so they can't be auto-projected.
            // A vendor_code→LOT product_code connector (separate spec) must land first. Until then,
            // projection is disabled to keep half-mapped China POs out of Snorkel.
            if (!d.force_projection_connector_built)
              return err('Snorkel projection is parked — Manifest POs use vendor product codes; a vendor_code→LOT product_code connector is required first (spec §2).', 422);
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

          // ── Shipment-defaults config (editable per-mode timelines; suggest, not lock; no audit) ──
          case 'setStageDefaults': {
            if (!canAdmin(P) && !canSfPoManage(P)) return err('No permission', 403);
            const rows = Array.isArray(d.rows) ? d.rows : [];
            if (!rows.length) return err('rows[] required', 422);
            const clean = rows.filter(r => ['sea','air','land'].includes(r.mode) && SHIP_STAGES.includes(r.stage))
              .map(r => ({ mode: r.mode, stage: r.stage, offset_days: Math.round(num(r.offset_days) || 0), updated_at: nowISO() }));
            if (!clean.length) return err('no valid rows', 422);
            const r = await sb('/rest/v1/stage_defaults', { method: 'POST', body: JSON.stringify(clean), prefer: 'return=minimal,resolution=merge-duplicates' });
            if (!r.ok) return err('Save failed: ' + JSON.stringify(r.data), 502);
            return ok({ saved: clean.length });
          }
          // ── Forwarder master inline-create (cross-schema write into store.forwarders; no free-text partners) ──
          case 'createForwarder': {
            if (!canSfPoManage(P) && !canManageShipments(P)) return err('No permission', 403);
            if (!d.company_name || !d.country || !d.country_iso) return err('company_name, country, country_iso required', 422);
            let modes = Array.isArray(d.modes_supported) ? d.modes_supported : [];
            const CAP = { sea: 'Sea', air: 'Air', land: 'Land' };   // normalize to the master's vocabulary
            modes = [...new Set(modes.map(m => CAP[String(m).toLowerCase()] || m).filter(Boolean))];
            if (!modes.length) return err('modes_supported required (Sea/Air/Land)', 422);
            // mint FWD-<ISO>-NNN from the max existing for that country (the 'fwd' seq is stale; compute from codes).
            const iso = String(d.country_iso).toUpperCase().slice(0, 2);
            const ex = await queryStore('forwarders', `?forwarder_code=like.FWD-${iso}-*&select=forwarder_code`);
            let maxN = 0; (ex.ok ? ex.data : []).forEach(f => { const m = String(f.forwarder_code).match(/-(\d+)$/); if (m) maxN = Math.max(maxN, parseInt(m[1], 10)); });
            const forwarder_code = `FWD-${iso}-${String(maxN + 1).padStart(3, '0')}`;
            const row = {
              forwarder_code, company_name: d.company_name, country: d.country, country_iso: iso,
              location: d.location || null, modes_supported: modes,
              iata_code: d.iata_code || null, scac_code: d.scac_code || null, tracking_url: d.tracking_url || null,
              contact_name: d.contact_name || null, contact_phone: d.contact_phone || null, contact_email: d.contact_email || null,
              notes: d.notes || null, active: true, created_by: auth.fullName || 'manifest',
            };
            const r = await sbStore('/rest/v1/forwarders', { method: 'POST', body: JSON.stringify(row), prefer: 'return=representation' });
            if (!r.ok) return err('Forwarder create failed: ' + JSON.stringify(r.data), 502);
            await logActivity(auth, 'forwarder_created', { detail: forwarder_code });
            return ok(Array.isArray(r.data) ? r.data[0] : r.data);
          }

          // ── Admin · governance (super admin only) ──
          case 'saveRole': {
            if (!canSuperAdmin(P)) return err('No permission', 403);
            if (!d.role_key) return err('role_key required');
            const existR = await sb(`/rest/v1/manifest_roles?role_key=eq.${encodeURIComponent(d.role_key)}&select=is_system,party&limit=1`);
            const exist = existR.ok && existR.data[0] ? existR.data[0] : null;
            if (exist && exist.is_system) return err('System roles are locked', 403);
            // Party is immutable after create.
            const party = exist ? exist.party : (d.party === 'SF' ? 'SF' : 'LOT');
            let permissions = { ...(d.permissions || {}) };
            // SF roles may hold ONLY the SF key set + manifest_view — strip LOT-only keys.
            if (party === 'SF') {
              const SF_ALLOWED = new Set(['manifest_view', 'sf_order_update', 'sf_evidence_upload', 'sf_drawdown_raise', 'sf_vendor_payment_record', 'sf_running_account_view', 'sf_po_manage', 'sf_invoice_create']);
              permissions = Object.fromEntries(Object.entries(permissions).filter(([k, v]) => v && SF_ALLOWED.has(k)));
            }
            // Guard: don't strip the last super admin's governance via a role edit.
            if (exist && exist.is_system === false && !permissions.manifest_super_admin) {
              const supers = await activeSuperAdminUserIds();
              const holders = await sb(`/rest/v1/manifest_user_roles?role_key=eq.${encodeURIComponent(d.role_key)}&active=is.true&select=user_id`);
              const heldBy = new Set((holders.ok ? holders.data : []).map(u => u.user_id));
              if (supers.length && supers.every(id => heldBy.has(id))) return err('Would remove the last super admin', 409);
            }
            const row = { role_key: d.role_key, label: d.label || d.role_key, description: d.description || null, party, permissions };
            const r = await sb('/rest/v1/manifest_roles', {
              method: 'POST', body: JSON.stringify(row), prefer: 'return=representation,resolution=merge-duplicates',
            });
            if (!r.ok) return err('Role save failed: ' + JSON.stringify(r.data), 502);
            await logActivity(auth, 'role_saved', { detail: d.role_key });
            return ok(Array.isArray(r.data) ? r.data[0] : r.data);
          }
          case 'deleteRole': {
            if (!canSuperAdmin(P)) return err('No permission', 403);
            if (!d.role_key) return err('role_key required');
            const exR = await sb(`/rest/v1/manifest_roles?role_key=eq.${encodeURIComponent(d.role_key)}&select=is_system&limit=1`);
            if (!exR.ok || !exR.data[0]) return err('Role not found', 404);
            if (exR.data[0].is_system) return err('System roles cannot be deleted', 403);
            const inUse = await sb(`/rest/v1/manifest_user_roles?role_key=eq.${encodeURIComponent(d.role_key)}&select=user_id`);
            if (inUse.ok && inUse.data.length) return err(`Role is assigned to ${inUse.data.length} user(s) — reassign them first`, 409);
            const r = await del('manifest_roles', `role_key=eq.${encodeURIComponent(d.role_key)}`);
            if (!r.ok) return err('Delete failed: ' + JSON.stringify(r.data), 502);
            await logActivity(auth, 'role_deleted', { detail: d.role_key });
            return ok({ role_key: d.role_key, deleted: true });
          }
          case 'setUserRole': {
            if (!canSuperAdmin(P)) return err('No permission', 403);
            if (!d.user_id) return err('user_id required');
            // Last-super-admin guard.
            {
              const supers = await activeSuperAdminUserIds();
              const isLastSuper = supers.length === 1 && supers[0] === d.user_id;
              if (isLastSuper) {
                if (d.role_key === null || d.role_key === '') return err('Cannot remove the last super admin', 409);
                const tgt = await sb(`/rest/v1/manifest_roles?role_key=eq.${encodeURIComponent(d.role_key)}&select=permissions&limit=1`);
                const keepsSuper = tgt.ok && tgt.data[0] && tgt.data[0].permissions && tgt.data[0].permissions.manifest_super_admin;
                if (!keepsSuper) return err('Cannot demote the last super admin', 409);
              }
            }
            if (d.role_key === null || d.role_key === '') {
              await del('manifest_user_roles', `user_id=eq.${encodeURIComponent(d.user_id)}`);
              await logActivity(auth, 'access_removed', { detail: d.user_id });
              return ok({ user_id: d.user_id, role_key: null });
            }
            const r = await sb('/rest/v1/manifest_user_roles', {
              method: 'POST', body: JSON.stringify({ user_id: d.user_id, role_key: d.role_key, active: true, assigned_by: userId, assigned_at: nowISO() }),
              prefer: 'return=representation,resolution=merge-duplicates',
            });
            if (!r.ok) return err('Assign failed: ' + JSON.stringify(r.data), 502);
            await logActivity(auth, 'role_assigned', { detail: `${d.user_id} → ${d.role_key}` });
            return ok(Array.isArray(r.data) ? r.data[0] : r.data);
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
            const patch = active
              ? { active: true, disabled_at: null, disabled_by: null }
              : { active: false, disabled_at: nowISO(), disabled_by: userId };
            const r = await update('manifest_user_roles', patch, `user_id=eq.${encodeURIComponent(d.user_id)}`);
            if (!r.ok) return err('Update failed: ' + JSON.stringify(r.data), 502);
            await logActivity(auth, active ? 'access_enabled' : 'access_disabled', { detail: d.user_id });
            return ok({ user_id: d.user_id, active });
          }
          case 'grantAccess': {
            // Generalizes onboardSfUser: grant Manifest access by email to LOT or SF users.
            // The auth user must already exist (Google sign-in for LOT, email link for SF).
            if (!canSuperAdmin(P)) return err('No permission', 403);
            if (!d.email || !d.role_key) return err('email and role_key required');
            const resolvedId = await resolveAuthUserId(d.email);
            if (!resolvedId) return err('No auth user for that email yet — ask them to sign in once first, then retry', 422);
            const authUser = { id: resolvedId };
            const roleR = await sb(`/rest/v1/manifest_roles?role_key=eq.${encodeURIComponent(d.role_key)}&select=party&limit=1`);
            if (!(roleR.ok && roleR.data[0])) return err('Unknown role_key', 400);
            const party = roleR.data[0].party;
            // Ensure a users_profile exists WITHOUT clobbering an existing one.
            const profR = await sbStore(`/rest/v1/users_profile?id=eq.${authUser.id}&select=id&limit=1`);
            if (!(profR.ok && profR.data[0])) {
              await sbStore('/rest/v1/users_profile', {
                method: 'POST',
                body: JSON.stringify({ id: authUser.id, full_name: d.full_name || d.email, role: party === 'SF' ? 'sf_partner' : 'staff', active: true }),
                prefer: 'return=minimal',
              });
            } else {
              await sbStore('/rest/v1/users_profile', {
                method: 'POST',
                body: JSON.stringify({ id: authUser.id, active: true }),
                prefer: 'return=minimal,resolution=merge-duplicates',
              });
            }
            const grantR = await sb('/rest/v1/manifest_user_roles', {
              method: 'POST',
              body: JSON.stringify({ user_id: authUser.id, role_key: d.role_key, active: true, assigned_by: userId, assigned_at: nowISO() }),
              prefer: 'return=minimal,resolution=merge-duplicates',
            });
            if (!grantR.ok) return err('Grant failed: ' + JSON.stringify(grantR.data), 502);
            await logActivity(auth, 'access_granted', { detail: `${d.email} → ${d.role_key}` });
            return ok({ user_id: authUser.id, email: d.email, role_key: d.role_key });
          }
          case 'onboardSfUser': {
            // Back-compat alias → grantAccess with the sf_owner default.
            if (!canSuperAdmin(P)) return err('No permission', 403);
            if (!d.email) return err('email required');
            const sfId = await resolveAuthUserId(d.email);
            if (!sfId) return err('No auth user for that email yet — ask them to request a login link first, then retry', 422);
            const authUser = { id: sfId };
            await sbStore('/rest/v1/users_profile', {
              method: 'POST',
              body: JSON.stringify({ id: authUser.id, full_name: d.full_name || d.email, role: 'sf_partner', active: true }),
              prefer: 'return=minimal,resolution=merge-duplicates',
            });
            await sb('/rest/v1/manifest_user_roles', {
              method: 'POST', body: JSON.stringify({ user_id: authUser.id, role_key: d.role_key || 'sf_owner', active: true, assigned_by: userId }),
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
