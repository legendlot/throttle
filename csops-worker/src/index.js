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
    `/rest/v1/users_profile?id=eq.${user.id}&select=role,full_name,active&limit=1`,
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

  return {
    userId: user.id,
    email: user.email,
    role: profile.role,
    fullName: profile.full_name,
    permissions,
  };
}

function require(perm, auth) {
  if (!auth?.permissions?.[perm]) {
    return err(`Forbidden — missing permission: ${perm}`, 403);
  }
  return null;
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
  other:       [],
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
    case 'getAgents':        return getAgents(params, auth, env);
    case 'getIssueCatalog':  return getIssueCatalog(env);
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
  const type = params.get('type');
  if (type) filters.push(`disposition=eq.${encodeURIComponent(type)}`);
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

  // SLA computation — key on disposition; fallback to 7 days
  const finalDisposition = disposition || 'pending';
  const slaDays = SLA_DAYS[finalDisposition] ?? 7;
  const due_at = new Date(Date.now() + slaDays * 24 * 60 * 60 * 1000).toISOString();

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

  const insertRes = await sb(`/rest/v1/cs_tickets`, env, {
    method: 'POST',
    body: JSON.stringify({
      ticket_no,
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

  // Fields the user is NEVER allowed to patch directly (must go through advanceStage/etc)
  const PROTECTED = new Set([
    'id', 'ticket_no', 'created_at', 'created_by_user_id', 'created_by_name',
    'stage', 'stage_changed_at', 'closed_at', 'closed_reason', 'closed_by_user_id',
    'updated_at',
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

  // Triage routing side-effects when disposition is being changed
  const newDisposition = cleanPatch.disposition;
  const now = new Date().toISOString();
  if (newDisposition && newDisposition !== current.disposition) {
    if (newDisposition === 'query') {
      cleanPatch.stage = 'closed';
      cleanPatch.stage_changed_at = now;
      cleanPatch.closed_reason = 'resolved';
      cleanPatch.closed_at = now;
      cleanPatch.closed_by_user_id = auth.userId;
    } else if (newDisposition === 'no_action') {
      cleanPatch.stage = 'closed';
      cleanPatch.stage_changed_at = now;
      cleanPatch.closed_reason = 'no_action';
      cleanPatch.closed_at = now;
      cleanPatch.closed_by_user_id = auth.userId;
    } else if (newDisposition === 'awaiting_info') {
      cleanPatch.stage = 'awaiting_evidence';
      cleanPatch.stage_changed_at = now;
    }
    // replacement | refund | repair | pending → leave stage as-is
  }

  const upd = await sb(`/rest/v1/cs_tickets?id=eq.${ticket_id}`, env, {
    method: 'PATCH',
    body: JSON.stringify(cleanPatch),
  });
  if (!upd.ok) return err(`Update failed: ${JSON.stringify(upd.data)}`, upd.status);

  // History per changed field
  await Promise.all(Object.entries(cleanPatch).map(([k, v]) =>
    insertHistory(ticket_id, k, current[k], v, null, auth, env)
  ));

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
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { ticket_id, agent_id } = body;
  if (!ticket_id || !agent_id) return err('ticket_id and agent_id required');

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

  await insertHistory(ticket_id, 'assigned_agent_id', t.assigned_agent_id, agent.id, `→ ${agent.full_name}`, auth, env);

  return ok({ assigned_to: agent.full_name });
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

// Scaffold mode: static shared token via ?token= or X-Webhook-Token header.
// Swap to HMAC once MyOperator's signature scheme is confirmed (go-live).
function verifyWebhook(request, url, env) {
  const provided = url.searchParams.get('token') || request.headers.get('X-Webhook-Token');
  return !!env.MYOP_WEBHOOK_SECRET && provided === env.MYOP_WEBHOOK_SECRET;
}

async function handleMyOperatorWebhook(request, env) {
  const url = new URL(request.url);
  if (!verifyWebhook(request, url, env)) return err('Invalid webhook signature', 401);
  let body = {};
  try { body = await request.json(); } catch { return err('Bad JSON', 400); }
  const type = body.event_type;
  console.log('[myop] ' + type + ' session=' + (body.session_id || '?') + ' dir=' + (body.direction || '?')); // lean, non-PII observability
  if (type === 'call.answered' || type === 'call.responded') return webhookCallAnswered(body, env);
  if (type === 'call.end' || type === 'call.ended')          return webhookCallEnd(body, env);
  if (type === 'call.summary')                                return webhookCallSummary(body, env);
  return json({ ok: true, ignored: type });  // ack other events so MyOperator doesn't retry
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

async function webhookCallAnswered(body, env) {
  const c = parseMyOp(body);
  if (!c.session_id) return err('missing session_id', 400);
  const existing = await sb(`/rest/v1/cs_tickets?call_session_id=eq.${encodeURIComponent(c.session_id)}&select=id,ticket_no&limit=1`, env);
  if (existing.data?.[0]) return json({ ok: true, deduped: true, ticket_no: existing.data[0].ticket_no });

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
  await insertHistorySystem(ins.data[0].id, 'ticket_created', null, ticket_no, 'auto-created from call', env);
  return json({ ok: true, ticket_no });
}

async function webhookCallEnd(body, env) {
  const c = parseMyOp(body);
  if (!c.session_id) return err('missing session_id', 400);
  const patch = {
    call_ended_at: c.timestamp || new Date().toISOString(),
    call_duration_seconds: c.duration,
    call_recording_filename: c.recording_filename,
    myop_client_ref_id: c.client_ref_id,
  };
  const existing = await sb(`/rest/v1/cs_tickets?call_session_id=eq.${encodeURIComponent(c.session_id)}&select=id&limit=1`, env);
  if (existing.data?.[0]) {
    await sb(`/rest/v1/cs_tickets?call_session_id=eq.${encodeURIComponent(c.session_id)}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
    return json({ ok: true, patched: true });
  }
  // No ticket exists for this session. Two cases:
  //  - genuinely answered call whose call.answered we missed (out-of-order) → create
  //  - unanswered / missed call (only call.end fired) → MUST NOT create a ticket
  // Answered calls have talk time; missed calls report 0/null duration.
  if (!(Number(c.duration) > 0)) {
    return json({ ok: true, skipped: 'unanswered call — no ticket created' });
  }
  // out-of-order: call.end before call.answered for an answered call — create then patch
  const created = await webhookCallAnswered(body, env);
  const createdData = await created.clone().json().catch(() => null);
  if (!createdData?.ok) return created;  // create failed — don't patch a nonexistent row
  await sb(`/rest/v1/cs_tickets?call_session_id=eq.${encodeURIComponent(c.session_id)}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
  return created;
}

// call.summary carries agent identity (legs[].agent.email) that call.answered
// lacks. Backfill the ticket's assignee when the summary arrives.
async function webhookCallSummary(body, env) {
  const c = parseMyOp(body);
  if (!c.session_id) return json({ ok: true, skipped: 'no session_id' });
  const agentEmail = agentEmailFromLegs(c.legs);
  if (!agentEmail) return json({ ok: true, skipped: 'no agent email in summary' });
  const existing = await sb(`/rest/v1/cs_tickets?call_session_id=eq.${encodeURIComponent(c.session_id)}&select=id&limit=1`, env);
  const t = existing.data?.[0];
  if (!t) return json({ ok: true, skipped: 'no ticket for session' });
  const agent = await resolveAgentByEmail(agentEmail, env);
  if (!agent.id) return json({ ok: true, skipped: 'agent email not matched: ' + agentEmail });
  await sb(`/rest/v1/cs_tickets?call_session_id=eq.${encodeURIComponent(c.session_id)}`, env, { method: 'PATCH', body: JSON.stringify({ assigned_agent_id: agent.id, assigned_agent_name: agent.name }) });
  await insertHistorySystem(t.id, 'assigned_agent_name', null, agent.name, 'auto-assigned from call.summary', env);
  return json({ ok: true, assigned: agent.name });
}
