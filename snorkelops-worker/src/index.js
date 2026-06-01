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

// ── Permission gates (procurement subset, copied from lotopsproxy) ──
const canWrite           = p => p.grn === 'write' || p.stock_issue === 'write' || p.receiving === 'write';
const canRaisePO         = p => !!p.procurement_raise;
const canApprovePO       = p => !!p.procurement_approve;
const canManageAddresses = p => !!p.company_address_manage;
// China PO gating: procurement_china = create/amend/view-financials on China POs
// + register products + see Soft POs. procurement_china_approve = approve China
// POs (four-eyes enforced: approver != raiser).
const canRaiseChinaPO    = p => !!p.procurement_china;
const canApproveChinaPO  = p => !!p.procurement_china_approve;
const canViewChina       = p => !!p.procurement_china;

// Strip financial fields from a China PO read when caller lacks procurement_china.
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

async function getRolePermissions(roleId) {
  const r = await sb(`/rest/v1/roles?role_id=eq.${encodeURIComponent(roleId)}&select=permissions&limit=1`);
  if (!r.ok || !r.data[0]) return null;
  return r.data[0].permissions || {};
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
  const permissions = await getRolePermissions(profile.role) || {};
  return {
    userId: user.id, email: user.email, role: profile.role,
    fullName: profile.full_name, mustChangePwd: profile.must_change_password,
    permissions,
  };
}

const COUNTRY_ISO = {
  'China':'CN','India':'IN','USA':'US','Germany':'DE','Taiwan':'TW',
  'Vietnam':'VN','Bangladesh':'BD','Japan':'JP','South Korea':'KR',
  'UK':'GB','Italy':'IT','Turkey':'TR','Other':'XX',
};
function countryToISO(country) { return COUNTRY_ISO[country] || 'XX'; }

// ── Store schema helper ────────────────────────────────────────
async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type':   'application/json',
      'apikey':         SUPABASE_KEY,
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
      'apikey':        SUPABASE_KEY,
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
            let filter = '?order=created_at.desc&limit=100';
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
            if (!canRaisePO(P)) return err('No permission', 403);
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
            if (!canRaisePO(P)) return err('No permission', 403);
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
            if (!canRaisePO(P)) return err('No permission to add vendors', 403);
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
            if (!canRaisePO(P)) return err('No permission', 403);
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
            if (!canRaisePO(P)) return err('No permission', 403);
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
            if (!canRaisePO(P)) return err('No permission', 403);
            const d = body.data;
            if (!d.id) return err('id required');
            await sb(`/rest/v1/vendor_supplied_items?id=eq.${d.id}`, { method: 'DELETE' });
            return ok({ deleted: d.id });
          }

          case 'postPO': {
            if (!canRaisePO(P)) return err('No permission to raise POs', 403);
            const d = body.data;
            if (!d.vendor_name||!d.source||!d.order_type) return err('vendor_name, source, order_type required');
            const isChina = d.source === 'China';
            const isSoft = d.status === 'Soft';
            if (isChina && !canRaiseChinaPO(P)) return err('China POs require procurement_china permission', 403);
            if (isSoft && !isChina) return err("Soft status is only valid for China POs", 400);
            if (isSoft && !canRaiseChinaPO(P)) return err('Soft POs require procurement_china permission', 403);
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

          case 'approvePO': {
            const d = body.data;
            if (!d.po_number) return err('po_number required');
            const existing = await query('purchase_orders', `?po_number=eq.${encodeURIComponent(d.po_number)}&limit=1`);
            if (!existing.ok||!existing.data[0]) return err('PO not found');
            const po = existing.data[0];
            if (po.status!=='Draft') return err('Only Draft POs can be approved');
            if (po.source === 'China') {
              if (!canApproveChinaPO(P)) return err('China POs require procurement_china_approve permission', 403);
              if (po.raised_by_user_id && po.raised_by_user_id === userId) {
                return err('Four-eyes required: approver cannot be the same person who raised this China PO', 403);
              }
            } else {
              if (!canApprovePO(P)) return err('No permission to approve POs', 403);
            }
            await update('purchase_orders',
              { status: 'Approved', approved_by: postRole, approved_at: new Date().toISOString(), updated_at: new Date().toISOString() },
              `po_number=eq.${encodeURIComponent(d.po_number)}`);
            await insert('po_revisions', {
              po_number: d.po_number, revision: po.revision,
              changed_by: postRole, change_summary: 'PO approved',
            });
            await logActivity(authResult?.fullName||postRole, postRole, 'PO_APPROVED', 'PO', d.po_number, `PO ${d.po_number} approved`, {});
            return ok({ po_number: d.po_number, status: 'Approved' });
          }

          case 'updatePOStatus': {
            const d = body.data;
            if (!d.po_number||!d.status) return err('po_number and status required');
            const existing = await query('purchase_orders', `?po_number=eq.${encodeURIComponent(d.po_number)}&limit=1`);
            if (!existing.ok||!existing.data[0]) return err('PO not found');
            const po = existing.data[0];
            if (d.status === 'Approved') {
              return err('Use approvePO action to approve a PO', 400);
            }
            if (po.source === 'China' && !canRaiseChinaPO(P)) {
              return err('China PO status changes require procurement_china permission', 403);
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
              return err('China PO amend requires procurement_china permission', 403);
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
              return err('China PO cancel requires procurement_china permission', 403);
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
            if (!canRaiseChinaPO(P)) return err('Restricted to procurement_china', 403);
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
            if (!canRaiseChinaPO(P)) return err('Restricted to procurement_china', 403);
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
            if (!canRaiseChinaPO(P)) return err('Restricted to procurement_china', 403);
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
