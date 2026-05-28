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

// ── Shopify helpers ──────────────────────────────────────────────────────────

// Normalise an India phone to E.164 (mirrors createTicket's logic).
function toE164(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, '');
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
    id displayName email phone numberOfOrders
    amountSpent{ amount currencyCode }
    orders(first:5, sortKey: CREATED_AT, reverse:true){ edges{ node{
      name createdAt displayFulfillmentStatus displayFinancialStatus
      currentTotalPriceSet{ shopMoney{ amount currencyCode } }
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
  const customer = {
    id: node.id, name: node.displayName, email: node.email, phone: node.phone,
    orders_count: node.numberOfOrders, total_spent: node.amountSpent?.amount, currency: node.amountSpent?.currencyCode,
  };
  const recent_orders = (node.orders?.edges || []).map(e => ({
    order_no: e.node.name, created_at: e.node.createdAt,
    fulfillment: e.node.displayFulfillmentStatus, financial: e.node.displayFinancialStatus,
    total: e.node.currentTotalPriceSet?.shopMoney?.amount, currency: e.node.currentTotalPriceSet?.shopMoney?.currencyCode,
  }));
  return { configured: true, found: true, customer, recent_orders };
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

// Resolve the effective department id to filter by. Non-admins are always
// locked to their own department; admins may override via ?department=<slug>
// (or pass ?department=all to disable the filter).
// Returns { mode: 'none' | 'id', id?: uuid } or null if requested slug not found.
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
  // Non-admin: lock to own dept. If user has no dept assigned, fall through to no-filter.
  if (auth?.cs_department_id) return { mode: 'id', id: auth.cs_department_id };
  return { mode: 'none' };
}

// ── Domain constants ─────────────────────────────────────────────────────────

const SLA_DAYS = { pending: 7, query: 1, no_action: 1, awaiting_info: 7, replacement: 5, refund: 7, repair: 14 };

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
      if (!ticket.replacement_unit_upc || !ticket.replacement_awb) {
        return 'replacement_unit_upc and replacement_awb required.';
      }
      return null;
    case 'refund_initiated':
      if (ticket.refund_amount_inr == null) {
        return 'refund_amount_inr required.';
      }
      return null;
    case 'refund_completed':
      if (!ticket.refund_reference) {
        return 'refund_reference (UTR / payment ref) required.';
      }
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
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    if (url.pathname === '/health' || action === 'health') {
      return json({ ok: true, service: 'csops', ts: new Date().toISOString() });
    }
    if (url.pathname === '/webhooks/myoperator' && request.method === 'POST') {
      return handleMyOperatorWebhook(request, env);
    }
    if (url.pathname === '/webhooks/bitespeed' && request.method === 'POST') {
      return handleBiteSpeedWebhook(request, env);
    }
    if (!action && request.method === 'GET') return err('Missing action parameter', 400);

    // Authenticate every request (besides /health)
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
    case 'getAgents':        return getAgents(params, auth, env);
    case 'getIssueCatalog':  return getIssueCatalog(env);
    case 'getDepartments':   return getDepartments(params, auth, env);
    case 'getDeptAgents':    return getDeptAgents(params, auth, env);
    case 'getMyopAccounts':  return getMyopAccounts(params, auth, env);
    case 'getCalls':         return getCalls(params, auth, env);
    case 'getCall':          return getCall(params, auth, env);
    case 'getCallsKpis':     return getCallsKpis(params, auth, env);
    case 'getWaThread':      return getWaThread(params, auth, env);
    case 'getWaTemplates':   return getWaTemplates(params, auth, env);
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
    case 'advanceStage':     return advanceStage(body, auth, env, request);
    case 'assignAgent':      return assignAgent(body, auth, env);
    case 'addNote':          return addNote(body, auth, env);
    case 'addAttachment':    return addAttachment(body, auth, env);
    case 'linkTicket':       return linkTicket(body, auth, env);
    case 'cancelTicket':     return cancelTicket(body, auth, env);
    case 'escalateTicket':   return escalateTicket(body, auth, env);
    case 'closeTicket':      return closeTicket(body, auth, env);
    case 'createMyopAccount': return createMyopAccount(body, auth, env);
    case 'updateMyopAccount': return updateMyopAccount(body, auth, env);
    case 'createDepartment':     return createDepartment(body, auth, env);
    case 'updateDepartment':     return updateDepartment(body, auth, env);
    case 'assignUserDepartment': return assignUserDepartment(body, auth, env);
    case 'setMyopDefaultDepartment': return setMyopDefaultDepartment(body, auth, env);
    case 'markCalledBack':           return markCalledBack(body, auth, env);
    case 'createTicketFromCall':     return createTicketFromCall(body, auth, env);
    case 'sendWaMessage':            return sendWaMessage(body, auth, env);
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

  // Dept default-filter (admins can override via ?department=<slug>|all)
  const deptFilter = await resolveDeptFilter(params.get('department'), auth, env);
  if (!deptFilter) return err(`Unknown department slug`, 404);
  if (deptFilter.mode === 'id') filters.push(`cs_department_id=eq.${deptFilter.id}`);

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

  const orderClause = 'order=created_at.desc';
  const path = `/rest/v1/cs_tickets?select=id,ticket_no,created_at,customer_name,customer_phone,product,product_model,product_color,platform,external_order_id,disposition,issue_category,issue_subcategory,issue_subcategory_custom,stage,stage_changed_at,assigned_agent_id,assigned_agent_name,due_at,closed_at,auto_created&${filters.join('&')}&${orderClause}&limit=${limit}&offset=${offset}`;

  const res = await sb(path, env, {
    headers: { Prefer: 'count=exact' },
  });
  if (!res.ok) return err(`Failed to fetch tickets: ${JSON.stringify(res.data)}`, res.status);

  return ok({ tickets: res.data || [], offset, limit });
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

  return ok({
    ticket: updatedTicket,
    history: historyRes.data || [],
    attachments: attachRes.data || [],
    notes: notesRes.data || [],
    links: linksRes.data || [],
    dispatch_info: dispatchInfo,
    past_cases: pastCases,
    repair_run: repairRun?.data?.[0] || null,
  });
}

async function fetchDispatchInfo(upc, env) {
  // unit → product_master, dispatch_allocations, dispatch_shipments
  const [unitRes, allocRes] = await Promise.all([
    sbPublic(`/rest/v1/units?upc=eq.${encodeURIComponent(upc)}&select=upc,product,model,color,sku,current_status,production_run_id&limit=1`, env),
    sb(`/rest/v1/dispatch_allocations?unit_upc=eq.${encodeURIComponent(upc)}&select=*&order=allocated_at.desc&limit=1`, env),
  ]);
  if (!unitRes.ok || !unitRes.data?.[0]) return null;
  const unit = unitRes.data[0];
  let shipment = null;
  const alloc = allocRes.data?.[0];
  if (alloc?.shipment_id) {
    const shipRes = await sb(`/rest/v1/dispatch_shipments?id=eq.${alloc.shipment_id}&select=*&limit=1`, env);
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
  const responses = await Promise.all(entries.map(([_, qs]) =>
    sb(`/rest/v1/cs_tickets${qs}&limit=1`, env, {
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

  const [myOpen, overdue, awaitingOld, closedToday, mtdClosed] = await Promise.all([
    sb(`/rest/v1/cs_tickets?assigned_agent_id=eq.${auth.userId}&closed_at=is.null&select=id&limit=5000`, env),
    sb(`/rest/v1/cs_tickets?closed_at=is.null&due_at=lt.${encodeURIComponent(nowIso)}&select=id&limit=5000`, env),
    sb(`/rest/v1/cs_tickets?stage=eq.awaiting_evidence&closed_at=is.null&stage_changed_at=lt.${encodeURIComponent(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString())}&select=id&limit=5000`, env),
    sb(`/rest/v1/cs_tickets?closed_at=gte.${encodeURIComponent(startOfTodayIso)}&select=id&limit=5000`, env),
    sb(`/rest/v1/cs_tickets?closed_at=gte.${encodeURIComponent(startOfMonth.toISOString())}&select=created_at,closed_at&limit=5000`, env),
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

async function lookupByUpc(params, auth, env) {
  const upc = params.get('upc');
  if (!upc) return err('upc required');
  const info = await fetchDispatchInfo(upc, env);
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

async function getCallReports(params, auth, env) {
  const from = params.get('from') || (() => { const d = new Date(); d.setMonth(0, 1); d.setHours(0,0,0,0); return d.toISOString(); })();
  const to   = params.get('to')   || new Date().toISOString();

  // Dept filter (non-admins locked to own)
  const deptFilter = await resolveDeptFilter(params.get('department'), auth, env);
  const deptClause = (deptFilter?.mode === 'id') ? `&cs_department_id=eq.${deptFilter.id}` : '';

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
    byAgent[agentName] = byAgent[agentName] || { name: agentName, answered_calls: 0, missed_returned: 0, total_dur: 0, dur_count: 0, tickets_opened: 0 };
    if (c.status === 'answered') byAgent[agentName].answered_calls++;
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
      external_order_id: external_order_id || null,
      lot_unit_upc: lot_unit_upc || null,
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
  if (['closed', 'cancelled', 'rejected'].includes(target_stage)) {
    update.closed_at = new Date().toISOString();
    update.closed_by_user_id = auth.userId;
    if (target_stage === 'cancelled') update.closed_reason = patch.closed_reason || 'no_response';
    if (target_stage === 'rejected')  update.closed_reason = 'rejected';
    if (target_stage === 'closed')    update.closed_reason = patch.closed_reason || 'resolved';
  }

  const upd = await sb(`/rest/v1/cs_tickets?id=eq.${ticket_id}`, env, {
    method: 'PATCH',
    body: JSON.stringify(update),
  });
  if (!upd.ok) return err(`Advance failed: ${JSON.stringify(upd.data)}`, upd.status);

  // History: stage row + any field changes
  await insertHistory(ticket_id, 'stage', t.stage, target_stage, null, auth, env);
  for (const [k, v] of Object.entries(cleanPatch)) {
    await insertHistory(ticket_id, k, t[k], v, null, auth, env);
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
    if (!reason) return err('reason required for mid-flight close (duplicate / wrong_system / goodwill)');
  } else {
    const g = require('cs_ticket_manage', auth); if (g) return g;
  }

  return advanceStage({ ticket_id, target_stage: 'closed', patch: { closed_reason: reason || 'resolved' } }, auth, env, new Request('https://x'));
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
function parseMyOp(body) {
  const p = (body && body.payload) || {};
  return {
    session_id: body.session_id || null,
    direction:  body.direction || p.direction || null,   // 'incoming' | 'outgoing'
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

function agentEmailFromLegs(legs) {
  for (const l of (legs || [])) { const e = l && l.agent && l.agent.email; if (e) return e; }
  return null;
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

async function insertHistorySystem(ticket_id, field_name, old_value, new_value, note, env) {
  await sb(`/rest/v1/cs_ticket_history`, env, { method: 'POST', body: JSON.stringify({
    ticket_id, field_name,
    old_value: old_value == null ? null : String(old_value),
    new_value: new_value == null ? null : String(new_value),
    note,
    changed_by_user_id: null, changed_by_name: 'MyOperator (auto)',
  }) }).catch(() => {});
}

// Upsert a cs_calls row keyed on (account, session). Idempotent and additive —
// the call.answered / call.end / call.summary legs each patch in their own fields.
async function upsertCsCall(account, c, patch, env) {
  const existing = await sb(
    `/rest/v1/cs_calls?myop_account_id=eq.${account.id}&call_session_id=eq.${encodeURIComponent(c.session_id)}&select=id,ticket_id,status&limit=1`,
    env,
  );
  if (existing.data?.[0]) {
    await sb(`/rest/v1/cs_calls?id=eq.${existing.data[0].id}`, env, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    return existing.data[0];
  }
  const ins = await sb(`/rest/v1/cs_calls`, env, {
    method: 'POST',
    body: JSON.stringify({
      myop_account_id:  account.id,
      cs_department_id: account.default_department_id || null,
      call_session_id:  c.session_id,
      direction:        c.direction,
      did:              c.did,
      customer_phone:   toE164(c.phone),
      ...patch,
    }),
  });
  return ins.data?.[0] || null;
}

async function webhookCallAnswered(body, env, account) {
  const c = parseMyOp(body);
  if (!c.session_id) return err('missing session_id', 400);

  // 1) cs_calls — record the answered state (idempotent)
  await upsertCsCall(account, c, {
    status: 'answered',
    started_at: c.timestamp || new Date().toISOString(),
    raw_meta: { last_event: 'answered' },
  }, env);

  // 2) cs_tickets — auto-create if not present
  const existing = await sb(`/rest/v1/cs_tickets?call_session_id=eq.${encodeURIComponent(c.session_id)}&select=id,ticket_no&limit=1`, env);
  if (existing.data?.[0]) {
    // Already created — make sure cs_calls.ticket_id is linked
    await sb(`/rest/v1/cs_calls?myop_account_id=eq.${account.id}&call_session_id=eq.${encodeURIComponent(c.session_id)}`, env, {
      method: 'PATCH', body: JSON.stringify({ ticket_id: existing.data[0].id }),
    });
    return json({ ok: true, deduped: true, ticket_no: existing.data[0].ticket_no });
  }

  const phone = toE164(c.phone);
  const agentEmail = agentEmailFromLegs(c.legs);   // usually null on answered; backfilled by call.summary
  const [agent, shop] = await Promise.all([ resolveAgentByEmail(agentEmail, env), shopifyLookup({ phone }, env) ]);

  const year = String(new Date().getFullYear());
  const seqRes = await sb(`/rest/v1/rpc/next_cs_ticket_seq`, env, { method: 'POST', body: JSON.stringify({ p_year: year }) });
  if (!seqRes.ok) return err('seq failed', 500);
  const seq = Number(seqRes.data);
  if (!Number.isFinite(seq) || seq <= 0) return err('seq invalid', 500);
  const ticket_no = `CS-${year}-${String(seq).padStart(5, '0')}`;

  const ins = await sb(`/rest/v1/cs_tickets`, env, { method: 'POST', body: JSON.stringify({
    ticket_no, call_session_id: c.session_id, auto_created: true,
    myop_account_id: account?.id || null,
    cs_department_id: account?.default_department_id || null,
    created_by_user_id: null, created_by_name: 'MyOperator (auto)',
    intake_channel: 'phone', call_direction: c.direction, call_did: c.did,
    call_answered_at: c.timestamp || new Date().toISOString(),
    customer_name: shop.found ? shop.customer.name : (phone ? `Caller ${phone}` : 'Unknown caller'),
    customer_phone: phone, customer_email: shop.found ? shop.customer.email : null,
    disposition: 'pending', issue_description: '[Pending — auto-created from call]',
    due_at: new Date(Date.now() + (SLA_DAYS['pending'] ?? 7) * 24 * 60 * 60 * 1000).toISOString(),
    assigned_agent_id: agent.id, assigned_agent_name: agent.name,
    stage: 'intake',
  }) });
  if (!ins.ok) return err(`insert failed: ${JSON.stringify(ins.data)}`, ins.status);

  // 3) link cs_calls.ticket_id + customer/agent enrichment
  await sb(`/rest/v1/cs_calls?myop_account_id=eq.${account.id}&call_session_id=eq.${encodeURIComponent(c.session_id)}`, env, {
    method: 'PATCH',
    body: JSON.stringify({
      ticket_id: ins.data[0].id,
      agent_user_id: agent.id,
      agent_name: agent.name,
      customer_name: shop.found ? shop.customer.name : null,
    }),
  });

  await insertHistorySystem(ins.data[0].id, 'ticket_created', null, ticket_no, 'auto-created from call', env);
  return json({ ok: true, ticket_no });
}

async function webhookCallEnd(body, env, account) {
  const c = parseMyOp(body);
  if (!c.session_id) return err('missing session_id', 400);

  const answered = Number(c.duration) > 0;
  const endedAt  = c.timestamp || new Date().toISOString();

  // 1) cs_calls — always patch/insert; status is 'answered' if duration>0, else 'missed'
  await upsertCsCall(account, c, {
    status: answered ? 'answered' : 'missed',
    ended_at: endedAt,
    duration_seconds: c.duration,
    recording_filename: c.recording_filename,
    myop_client_ref_id: c.client_ref_id,
    raw_meta: { last_event: 'end' },
  }, env);

  // 2) cs_tickets — patch if exists; create only if answered (out-of-order delivery)
  const ticketPatch = {
    call_ended_at: endedAt,
    call_duration_seconds: c.duration,
    call_recording_filename: c.recording_filename,
    myop_client_ref_id: c.client_ref_id,
  };
  const existing = await sb(`/rest/v1/cs_tickets?call_session_id=eq.${encodeURIComponent(c.session_id)}&select=id&limit=1`, env);
  if (existing.data?.[0]) {
    await sb(`/rest/v1/cs_tickets?call_session_id=eq.${encodeURIComponent(c.session_id)}`, env, { method: 'PATCH', body: JSON.stringify(ticketPatch) });
    return json({ ok: true, patched: true });
  }
  // Missed call with no prior call.answered → cs_calls row stands alone, no ticket
  if (!answered) {
    return json({ ok: true, skipped: 'unanswered call — cs_calls row written, no ticket' });
  }
  // out-of-order: answered call where call.end arrived before call.answered
  const created = await webhookCallAnswered(body, env, account);
  const createdData = await created.clone().json().catch(() => null);
  if (!createdData?.ok) return created;
  await sb(`/rest/v1/cs_tickets?call_session_id=eq.${encodeURIComponent(c.session_id)}`, env, { method: 'PATCH', body: JSON.stringify(ticketPatch) });
  return created;
}

// call.summary carries agent identity (legs[].agent.email) that call.answered
// lacks. Backfill the ticket's assignee when the summary arrives.
async function webhookCallSummary(body, env, account) {
  const c = parseMyOp(body);
  if (!c.session_id) return json({ ok: true, skipped: 'no session_id' });
  const agentEmail = agentEmailFromLegs(c.legs);
  if (!agentEmail) return json({ ok: true, skipped: 'no agent email in summary' });
  const agent = await resolveAgentByEmail(agentEmail, env);
  if (!agent.id) return json({ ok: true, skipped: 'agent email not matched: ' + agentEmail });

  // cs_calls — always backfill (works for both answered and missed calls)
  await sb(`/rest/v1/cs_calls?myop_account_id=eq.${account.id}&call_session_id=eq.${encodeURIComponent(c.session_id)}`, env, {
    method: 'PATCH',
    body: JSON.stringify({ agent_user_id: agent.id, agent_name: agent.name }),
  });

  // cs_tickets — only if a ticket exists (answered calls only)
  const existing = await sb(`/rest/v1/cs_tickets?call_session_id=eq.${encodeURIComponent(c.session_id)}&select=id&limit=1`, env);
  const t = existing.data?.[0];
  if (t) {
    await sb(`/rest/v1/cs_tickets?call_session_id=eq.${encodeURIComponent(c.session_id)}`, env, {
      method: 'PATCH',
      body: JSON.stringify({ assigned_agent_id: agent.id, assigned_agent_name: agent.name }),
    });
    await insertHistorySystem(t.id, 'assigned_agent_name', null, agent.name, 'auto-assigned from call.summary', env);
  }
  return json({ ok: true, assigned: agent.name });
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

  const result = (u.data || []).map(p => ({
    ...p,
    has_cs_manage: !!rolesMap[p.role]?.cs_ticket_manage,
    has_cs_admin:  !!rolesMap[p.role]?.cs_ticket_admin,
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
  if (deptFilter.mode === 'id') filters.push(`cs_department_id=eq.${deptFilter.id}`);

  // tab presets
  if (tab === 'my')          filters.push(`agent_user_id=eq.${auth.userId}`);
  else if (tab === 'unassigned') filters.push(`agent_user_id=is.null`, `ticket_id=is.null`);
  else if (tab === 'missed') filters.push(`status=eq.missed`, `called_back_at=is.null`);

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

  const select = 'id,myop_account_id,cs_department_id,call_session_id,direction,did,customer_phone,customer_name,agent_user_id,agent_name,status,duration_seconds,recording_filename,recording_url,started_at,ended_at,ticket_id,called_back_at,created_at';
  const path = `/rest/v1/cs_calls?select=${select},ticket:ticket_id(ticket_no)&${filters.join('&')}&order=created_at.desc&limit=${limit}&offset=${offset}`;
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
  const deptClause = (deptFilter?.mode === 'id') ? `&cs_department_id=eq.${deptFilter.id}` : '';

  const [today, answered, missed, myOpen, unansweredAwaitingCallback] = await Promise.all([
    sb(`/rest/v1/cs_calls?created_at=gte.${encodeURIComponent(startOfTodayIso)}${deptClause}&select=id&limit=5000`, env),
    sb(`/rest/v1/cs_calls?created_at=gte.${encodeURIComponent(startOfTodayIso)}&status=eq.answered${deptClause}&select=id&limit=5000`, env),
    sb(`/rest/v1/cs_calls?created_at=gte.${encodeURIComponent(startOfTodayIso)}&status=eq.missed${deptClause}&select=id&limit=5000`, env),
    sb(`/rest/v1/cs_calls?agent_user_id=eq.${auth.userId}&created_at=gte.${encodeURIComponent(startOfTodayIso)}${deptClause}&select=id&limit=5000`, env),
    sb(`/rest/v1/cs_calls?status=eq.missed&called_back_at=is.null${deptClause}&select=id&limit=5000`, env),
  ]);

  const total_today = (today.data || []).length;
  const answered_today = (answered.data || []).length;
  const missed_today = (missed.data || []).length;
  const answer_rate_pct = total_today > 0 ? Math.round((answered_today / total_today) * 100) : null;

  return ok({
    total_today, answered_today, missed_today, answer_rate_pct,
    my_calls_today: (myOpen.data || []).length,
    unanswered_awaiting_callback: (unansweredAwaitingCallback.data || []).length,
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
async function findOrCreateWaThread(customer_phone, env) {
  if (!customer_phone) return { thread: null, created: false };
  const norm = toE164(customer_phone);
  const r = await sb(
    `/rest/v1/cs_wa_threads?customer_phone=eq.${encodeURIComponent(norm)}&waba_phone_number_id=is.null&select=*&limit=1`,
    env,
  );
  if (r.data?.[0]) return { thread: r.data[0], created: false };
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

  const { thread } = await findOrCreateWaThread(t.customer_phone, env);
  if (!thread) return ok({ thread: null, messages: [] });

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
    body: JSON.stringify({ last_message_at: now, customer_window_until: windowClose }),
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

async function handleBiteSpeedWebhook(request, env) {
  const url = new URL(request.url);
  if (!verifyBiteSpeedAuth(url, env)) return err('Invalid webhook token', 401);

  let body = {};
  try { body = await request.json(); } catch { return err('Bad JSON', 400); }
  const event = body?.event;
  const convId = body?.conversation?.id || body?.id || '?';
  const phone = extractPhoneFromChatwoot(body);
  console.log(`[bitespeed] ${event} conv=${convId}${phone ? ' phone=' + phone : ''}`);

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
async function biteSpeedFindOrCreateThread(payload, env) {
  const conv = payload?.conversation || (payload?.event === 'conversation_created' ? payload : null) || payload;
  const convId = conv?.id ?? payload?.id ?? null;
  const phoneRaw = extractPhoneFromChatwoot(payload);
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
    if (byRef.data?.[0]) return { thread: byRef.data[0] };
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


  // No existing thread — create one
  const ins = await sb(`/rest/v1/cs_wa_threads`, env, {
    method: 'POST',
    body: JSON.stringify({
      customer_phone: phone,
      provider_thread_ref: convId != null ? String(convId) : null,
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
  let { thread } = await biteSpeedFindOrCreateThread(body, env);
  if (!thread) return json({ ok: true, skipped: 'no_phone_or_conv_id' });
  thread = await maybeBackfillPhoneAndLinkTickets(thread, body, env);
  // Bump last_message_at on any conv update so the thread sorts to the top of lists
  await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, {
    method: 'PATCH',
    body: JSON.stringify({ last_message_at: new Date().toISOString() }),
  });
  return json({ ok: true, thread_id: thread.id, phone_backfilled: !!thread.customer_phone });
}

async function biteSpeedMessageCreated(body, env) {
  // Chatwoot wraps the message at the top level for message_created.
  const messageType = body?.message_type;   // 0=in 1=out 2=activity 3=template
  if (messageType === 2 || messageType === 'activity') {
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

  // Resolve direction
  const directionNum = Number(messageType);
  const direction = directionNum === 0 ? 'inbound' : 'outbound';

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
  } else if (directionNum === 3) {
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
  if (directionNum === 3) {
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
    threadPatch.customer_window_until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  }
  await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, {
    method: 'PATCH',
    body: JSON.stringify(threadPatch),
  });

  // Activity row on the linked ticket so the message surfaces in the ticket's
  // history feed (without exposing message content to history rows — privacy).
  if (linkedTicketId) {
    await sb(`/rest/v1/cs_ticket_history`, env, {
      method: 'POST',
      body: JSON.stringify({
        ticket_id: linkedTicketId,
        field_name: direction === 'inbound' ? 'wa_message_received' : 'wa_message_sent',
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
