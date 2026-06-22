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

// Exact row count for a `store` query via Content-Range (sb() drops headers).
// Returns 0 on any parse failure. Used where a full row fetch is too large.
async function sbCount(path, env) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${env.SUPABASE_URL}${path}${sep}limit=1`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Accept-Profile': 'store',
      Prefer: 'count=exact',
      Range: '0-0',
    },
  });
  const cr = res.headers.get('content-range') || '';
  const n = Number(cr.split('/')[1]);
  return Number.isFinite(n) ? n : 0;
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
    id displayName email phone numberOfOrders createdAt
    amountSpent{ amount currencyCode }
    defaultAddress{ city province country }
    orders(first:10, sortKey: CREATED_AT, reverse:true){ edges{ node{
      name createdAt displayFulfillmentStatus displayFinancialStatus
      currentTotalPriceSet{ shopMoney{ amount currencyCode } }
      subtotalPriceSet{ shopMoney{ amount } }
      totalShippingPriceSet{ shopMoney{ amount } }
      shippingAddress{ city province country }
      fulfillments(first:5){ status trackingInfo{ number company url } }
      lineItems(first:25){ edges{ node{ title quantity sku variantTitle
        originalTotalSet{ shopMoney{ amount currencyCode } } } } }
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
  const addr = a => a ? [a.city, a.province, a.country].filter(Boolean).join(', ') : null;
  const customer = {
    id: node.id, name: node.displayName, email: node.email, phone: node.phone,
    orders_count: node.numberOfOrders, total_spent: node.amountSpent?.amount, currency: node.amountSpent?.currencyCode,
    since: node.createdAt, location: addr(node.defaultAddress),
  };
  const recent_orders = (node.orders?.edges || []).map(e => {
    const o = e.node;
    const tracking = [];
    for (const f of (o.fulfillments || [])) {
      for (const ti of (f.trackingInfo || [])) {
        if (ti.number || ti.url) tracking.push({ number: ti.number, company: ti.company, url: ti.url });
      }
    }
    return {
      order_no: o.name, created_at: o.createdAt,
      fulfillment: o.displayFulfillmentStatus, financial: o.displayFinancialStatus,
      total: o.currentTotalPriceSet?.shopMoney?.amount, currency: o.currentTotalPriceSet?.shopMoney?.currencyCode,
      subtotal: o.subtotalPriceSet?.shopMoney?.amount,
      shipping: o.totalShippingPriceSet?.shopMoney?.amount,
      ship_to: addr(o.shippingAddress),
      tracking,
      line_items: (o.lineItems?.edges || []).map(li => ({
        title: li.node.title, quantity: li.node.quantity, variant: li.node.variantTitle, sku: li.node.sku,
        amount: li.node.originalTotalSet?.shopMoney?.amount,
      })),
    };
  });
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

// Resolve the effective department filter. Admins may override via
// ?department=<slug> (or `all` to disable). Non-admins are locked to the
// departments they belong to — the union of store.cs_user_departments and their
// primary users_profile.cs_department_id (#2 multi-department, S138).
// Returns { mode: 'none' | 'id' | 'ids', id?, ids? } or null if a requested
// admin slug isn't found.
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
  // Non-admin: union of all departments the user belongs to.
  const r = await sb(
    `/rest/v1/cs_user_departments?user_id=eq.${auth.userId}&select=cs_department_id`,
    env,
  );
  const ids = new Set((r.data || []).map(x => x.cs_department_id).filter(Boolean));
  if (auth?.cs_department_id) ids.add(auth.cs_department_id);   // primary, back-compat
  const arr = [...ids];
  if (arr.length === 0) return { mode: 'none' };
  if (arr.length === 1) return { mode: 'id', id: arr[0] };
  return { mode: 'ids', ids: arr };
}

// PostgREST filter fragment for a resolved dept filter ('' when unfiltered).
function buildDeptFilter(df) {
  if (!df) return '';
  if (df.mode === 'id') return `cs_department_id=eq.${df.id}`;
  if (df.mode === 'ids') return `cs_department_id=in.(${df.ids.join(',')})`;
  return '';
}

// ── Visibility scope (agent-only dashboard, Pruthvi S144) ─────────────────────
// The operator tier — a role with cs_ticket_manage but WITHOUT cs_ticket_reassign
// or cs_ticket_admin (i.e. cs_agent) — is restricted to its OWN tickets: assigned
// to them, created by them, or still unassigned (so they can self-claim from the
// pool). Leads/admins are unaffected — they keep the full department view + the
// agent filter. Mirrors the oversight gating already used for the agent dropdown.
function isOperatorScope(auth) {
  const p = auth?.permissions || {};
  return !!p.cs_ticket_manage && !p.cs_ticket_reassign && !p.cs_ticket_admin;
}

// PostgREST filter fragments scoping a ticket list/count to what `auth` may see:
// the existing dept filter, plus the operator self-scope when applicable. Returns
// null when the requested department slug is unknown (caller should 404).
async function visibilityFilters(params, auth, env) {
  const out = [];
  const deptFilter = await resolveDeptFilter(params.get('department'), auth, env);
  if (!deptFilter) return null;
  const dc = buildDeptFilter(deptFilter);
  if (dc) out.push(dc);
  if (isOperatorScope(auth)) {
    out.push(`or=(assigned_agent_id.eq.${auth.userId},created_by_user_id.eq.${auth.userId},assigned_agent_id.is.null)`);
  }
  return out;
}

// ── Domain constants ─────────────────────────────────────────────────────────

const SLA_DAYS = { pending: 7, query: 1, no_action: 1, awaiting_info: 7, replacement: 5, refund: 7, repair: 14 };
// Coalesce window for repeat calls (RULE-PITSTOP-018): a new answered call from a
// phone that already has an OPEN ticket in the same department created within this
// window attaches to that ticket instead of spawning a duplicate. Every call is
// still logged independently in cs_calls. 24h captures dropped-call + callback +
// same-day follow-up bursts without merging genuinely-separate later interactions.
const COALESCE_WINDOW_MS = 24 * 60 * 60 * 1000;

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
// closed_reason is a constrained enum (cs_tickets_closed_reason_check). Free-text
// reasons (e.g. the cancel modal's note) must never be written into it — they get
// coerced to the stage default and preserved as a history note instead.
const ALLOWED_CLOSED_REASONS = ['resolved', 'duplicate', 'no_response', 'wrong_system', 'goodwill', 'rejected', 'no_action', 'historical_import'];

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
      // replacement_unit_upc is now OPTIONAL (the replacement process doesn't require
      // entering the new unit's UPC at creation). replacement_order_id is mandatory.
      if (!ticket.replacement_order_id || !ticket.replacement_awb) {
        return 'replacement_order_id and replacement_awb required.';
      }
      return null;
    case 'refund_initiated':
      if (ticket.refund_amount_inr == null) {
        return 'refund_amount_inr required.';
      }
      return null;
    case 'refund_completed':
      // refund_reference (UTR / payment ref) is now OPTIONAL (Pruthvi, S149) —
      // a refund can be marked completed before the UTR/payment ref is captured.
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
    // Meta (Instagram + Facebook Messenger DMs) — GET verify handshake + POST events.
    if (url.pathname === '/webhooks/meta') {
      if (request.method === 'GET')  return handleMetaVerify(url, env);
      if (request.method === 'POST') return handleMetaWebhook(request, env);
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
    case 'getOverviewSummary': return getOverviewSummary(params, auth, env);
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
    case 'getTicketHistory': {
      const g2 = require('cs_reports_view', auth); if (g2) return g2;
      return getTicketHistory(params, auth, env);
    }
    case 'getAgents':        return getAgents(params, auth, env);
    case 'getIssueCatalog':  return getIssueCatalog(env);
    case 'getDepartments':   return getDepartments(params, auth, env);
    case 'getDeptAgents':    return getDeptAgents(params, auth, env);
    case 'getProductCatalog': return getProductCatalog(params, auth, env);
    case 'getCsAgents':      return getCsAgents(params, auth, env);
    case 'getMyopAccounts':  return getMyopAccounts(params, auth, env);
    case 'getCalls':         return getCalls(params, auth, env);
    case 'getCall':          return getCall(params, auth, env);
    case 'getCallsKpis':     return getCallsKpis(params, auth, env);
    case 'getWaThread':      return getWaThread(params, auth, env);
    case 'getWaTemplates':   return getWaTemplates(params, auth, env);
    case 'getMessagingThreads': return getMessagingThreads(params, auth, env);
    case 'getMessagingThread':  return getMessagingThread(params, auth, env);
    case 'getMessagingStats':   return getMessagingStats(params, auth, env);
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
    case 'setUserDepartments':   return setUserDepartments(body, auth, env);
    case 'setCsRole':            return setCsRole(body, auth, env);
    case 'setMyopDefaultDepartment': return setMyopDefaultDepartment(body, auth, env);
    case 'markCalledBack':           return markCalledBack(body, auth, env);
    case 'createTicketFromCall':     return createTicketFromCall(body, auth, env);
    case 'sendWaMessage':            return sendWaMessage(body, auth, env);
    case 'sendMetaMessage':          return sendMetaMessage(body, auth, env);
    case 'linkMessagingThread':      return linkMessagingThread(body, auth, env);
    case 'assignThread':             return assignThread(body, auth, env);
    case 'addThreadNote':            return addThreadNote(body, auth, env);
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

  // Visibility scope: dept default-filter (admins override via ?department=<slug>|all)
  // + operator self-scope (own + unassigned). 404 on unknown slug.
  const scope = await visibilityFilters(params, auth, env);
  if (!scope) return err(`Unknown department slug`, 404);
  filters.push(...scope);

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
  const createdBy = params.get('created_by');
  if (createdBy) filters.push(`created_by_user_id=eq.${encodeURIComponent(createdBy)}`);

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
  // Scope counts to what the caller may see, so tab badges match the list.
  const scope = await visibilityFilters(params, auth, env);
  if (!scope) return err(`Unknown department slug`, 404);
  const scopeQs = scope.length ? `&${scope.join('&')}` : '';
  // Optional assigned-agent filter — keeps the tab badges in lock-step with the
  // agent-filtered list (getTickets ?agent=). Skipped for the 'my' tab, which is
  // always the viewer's own queue.
  const agent = params.get('agent');
  const agentQs = agent ? `&assigned_agent_id=eq.${encodeURIComponent(agent)}` : '';
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
  const responses = await Promise.all(entries.map(([k, qs]) =>
    sb(`/rest/v1/cs_tickets${qs}${scopeQs}${k === 'my' ? '' : agentQs}&limit=5000`, env, {
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

  // Scope tiles to what the caller may see (dept + operator self-scope), so an
  // operator's Overdue / Awaiting / Closed counts reflect only their own tickets.
  const scope = await visibilityFilters(params, auth, env);
  if (!scope) return err(`Unknown department slug`, 404);
  const scopeQs = scope.length ? `&${scope.join('&')}` : '';

  const [myOpen, overdue, awaitingOld, closedToday, mtdClosed] = await Promise.all([
    sb(`/rest/v1/cs_tickets?assigned_agent_id=eq.${auth.userId}&closed_at=is.null&select=id&limit=5000`, env),
    sb(`/rest/v1/cs_tickets?closed_at=is.null&due_at=lt.${encodeURIComponent(nowIso)}&select=id&limit=5000${scopeQs}`, env),
    sb(`/rest/v1/cs_tickets?stage=eq.awaiting_evidence&closed_at=is.null&stage_changed_at=lt.${encodeURIComponent(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString())}&select=id&limit=5000${scopeQs}`, env),
    sb(`/rest/v1/cs_tickets?closed_at=gte.${encodeURIComponent(startOfTodayIso)}&select=id&limit=5000${scopeQs}`, env),
    sb(`/rest/v1/cs_tickets?closed_at=gte.${encodeURIComponent(startOfMonth.toISOString())}&select=created_at,closed_at&limit=5000${scopeQs}`, env),
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

// getOverviewSummary — the CS lead's "what needs me now" command view in ONE
// dept-scoped, server-computed call. Returns the point-in-time KPI/exception
// counts (open / SLA breached / evidence aging / unassigned / refunds pending)
// + EXACT per-agent open load (grouped over the whole dept, not a client
// sample). Calls KPIs stay in getCallsKpis; ranged calls/resolved stay in
// getReports/getCallReports. Scope = the same dept + operator self-scope as
// getKpis/getTickets (so an operator sees only their own slice).
async function getOverviewSummary(params, auth, env) {
  const nowIso = new Date().toISOString();
  // IST start-of-day for "resolved today"
  const istMidnight = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  istMidnight.setHours(0, 0, 0, 0);
  const startOfTodayIso = istMidnight.toISOString();
  const agingIso = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

  const scope = await visibilityFilters(params, auth, env);
  if (!scope) return err('Unknown department slug', 404);
  const scopeQs = scope.length ? `&${scope.join('&')}` : '';

  const [openR, slaR, awaitingR, resolvedR, unassignedR, refundsR, agentRowsR, rosterR, rolesR, createdTodayR] = await Promise.all([
    sb(`/rest/v1/cs_tickets?closed_at=is.null&select=id&limit=5000${scopeQs}`, env),
    sb(`/rest/v1/cs_tickets?closed_at=is.null&due_at=lt.${encodeURIComponent(nowIso)}&select=created_at&order=created_at.asc&limit=5000${scopeQs}`, env),
    sb(`/rest/v1/cs_tickets?stage=eq.awaiting_evidence&closed_at=is.null&stage_changed_at=lt.${encodeURIComponent(agingIso)}&select=id&limit=5000${scopeQs}`, env),
    sb(`/rest/v1/cs_tickets?closed_at=gte.${encodeURIComponent(startOfTodayIso)}&select=id&limit=5000${scopeQs}`, env),
    sb(`/rest/v1/cs_tickets?closed_at=is.null&assigned_agent_id=is.null&select=auto_created&limit=5000${scopeQs}`, env),
    sb(`/rest/v1/cs_tickets?closed_at=is.null&disposition=eq.refund&stage=eq.inspected&select=refund_amount_inr&limit=5000${scopeQs}`, env),
    sb(`/rest/v1/cs_tickets?closed_at=is.null&assigned_agent_id=not.is.null&select=assigned_agent_id,assigned_agent_name&limit=5000${scopeQs}`, env),
    sb(`/rest/v1/users_profile?active=eq.true&select=id,full_name,role&order=full_name.asc&limit=500`, env),
    sb(`/rest/v1/roles?select=role_id,permissions`, env),
    sb(`/rest/v1/cs_tickets?created_at=gte.${encodeURIComponent(startOfTodayIso)}&select=created_at&limit=5000${scopeQs}`, env),
  ]);

  // Tickets created per IST hour today (0-23) — for the Overview hourly chart.
  const hourBuckets = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }));
  for (const t of (createdTodayR.data || [])) {
    if (!t.created_at) continue;
    const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }).format(new Date(t.created_at))) % 24;
    if (h >= 0 && h < 24) hourBuckets[h].count += 1;
  }

  const sla = slaR.data || [];
  const slaOldestDays = sla.length
    ? Math.floor((Date.now() - new Date(sla[0].created_at).getTime()) / (24 * 60 * 60 * 1000))
    : 0;

  const unassignedRows = unassignedR.data || [];
  const refunds = refundsR.data || [];
  const refundsTotal = refunds.reduce((s, r) => s + (Number(r.refund_amount_inr) || 0), 0);

  // EXACT per-agent open load — seed from the cs_ticket_manage roster (so idle
  // agents show at 0) then add the grouped open counts.
  const rolesMap = {};
  for (const r of (rolesR.data || [])) rolesMap[r.role_id] = r.permissions || {};
  const agentMap = {};
  for (const u of (rosterR.data || [])) {
    if (rolesMap[u.role]?.cs_ticket_manage) agentMap[u.id] = { user_id: u.id, name: u.full_name || '—', open: 0 };
  }
  for (const t of (agentRowsR.data || [])) {
    const id = t.assigned_agent_id;
    if (!id) continue;
    if (!agentMap[id]) agentMap[id] = { user_id: id, name: t.assigned_agent_name || '—', open: 0 };
    agentMap[id].open += 1;
  }
  const agents = Object.values(agentMap).sort((a, b) => b.open - a.open);

  return ok({
    open: (openR.data || []).length,
    sla_breached: sla.length,
    sla_oldest_days: slaOldestDays,
    awaiting_evidence: (awaitingR.data || []).length,
    resolved_today: (resolvedR.data || []).length,
    unassigned: unassignedRows.length,
    unassigned_from_calls: unassignedRows.filter(t => t.auto_created).length,
    refunds_pending: refunds.length,
    refunds_total_inr: refundsTotal,
    agents,
    created_today_hourly: hourBuckets,
  });
}

// getTicketHistory — ticket-creation time series for the History page.
// Buckets cs_tickets.created_at by day / week (ISO, Mon-start) / month over
// [from,to], split into auto-created (call requests) vs manual. Dept-scoped
// (mirrors getReports — dept filter only, gated by cs_reports_view in the
// dispatcher). Bucketed in-worker (current volume is well under the row cap).
async function getTicketHistory(params, auth, env) {
  const granularity = ['day', 'week', 'month'].includes(params.get('granularity')) ? params.get('granularity') : 'day';
  const to = params.get('to') ? new Date(params.get('to')) : new Date();
  const from = params.get('from') ? new Date(params.get('from')) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const deptFilter = await resolveDeptFilter(params.get('department'), auth, env);
  if (!deptFilter) return err('Unknown department slug', 404);
  const deptClause = (() => { const c = buildDeptFilter(deptFilter); return c ? `&${c}` : ''; })();

  const path = `/rest/v1/cs_tickets?created_at=gte.${encodeURIComponent(from.toISOString())}&created_at=lt.${encodeURIComponent(to.toISOString())}&select=created_at,auto_created&order=created_at.asc&limit=10000${deptClause}`;
  const res = await sb(path, env);
  if (!res.ok) return err(`Failed to load ticket history: ${JSON.stringify(res.data)}`, res.status);

  // IST-anchored bucket key.
  const istParts = (iso) => {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
    const g = (t) => p.find(x => x.type === t)?.value;
    return { y: Number(g('year')), m: Number(g('month')), d: Number(g('day')) };
  };
  const bucketKey = (iso) => {
    const { y, m, d } = istParts(iso);
    if (granularity === 'month') return `${y}-${String(m).padStart(2, '0')}`;
    if (granularity === 'week') {
      // ISO week start (Monday), computed on the IST calendar date.
      const dt = new Date(Date.UTC(y, m - 1, d));
      const dow = (dt.getUTCDay() + 6) % 7; // 0=Mon
      dt.setUTCDate(dt.getUTCDate() - dow);
      return dt.toISOString().slice(0, 10);
    }
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };

  const map = {};
  for (const t of (res.data || [])) {
    if (!t.created_at) continue;
    const k = bucketKey(t.created_at);
    if (!map[k]) map[k] = { bucket: k, total: 0, auto: 0, manual: 0 };
    map[k].total += 1;
    if (t.auto_created) map[k].auto += 1; else map[k].manual += 1;
  }
  const series = Object.values(map).sort((a, b) => (a.bucket < b.bucket ? -1 : 1));
  return ok({ granularity, from: from.toISOString(), to: to.toISOString(), total: (res.data || []).length, series });
}

// Normalize a scanned/typed/spoken UPC to the canonical LOT-XXXXXXXX form.
// The unit's QR encodes "LOT-00081760"; the printed human-readable is
// "<product_code><serial>" e.g. "SHAK00081760" (Redline apps/redline .../upc/page.js).
// Agents or customers may read out the human-readable or bare digits, so resolve
// LOT-00081760 / lot-81760 / 00081760 / 81760 / SHAK00081760 → LOT-<8-pad>.
// No trailing digits → returned unchanged (exact-match fallback).
function normalizeUpc(raw) {
  const s = String(raw || '').trim();
  if (!s) return s;
  const m = s.match(/(\d+)\s*$/);   // trailing run of digits = the serial
  return (m && m[1]) ? 'LOT-' + m[1].padStart(8, '0') : s;
}

async function lookupByUpc(params, auth, env) {
  const raw = params.get('upc');
  if (!raw) return err('upc required');
  const info = await fetchDispatchInfo(normalizeUpc(raw), env);
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
  const deptClause = (() => { const c = buildDeptFilter(deptFilter); return c ? `&${c}` : ''; })();

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

// CS-team-only assignee list (S162). getAgents/getDeptAgents return EVERY user with
// cs_ticket_manage — but the generic `admin`/`super_admin` roles carry that perm via
// the catch-all admin grant, so they flood any "assign to" picker with non-CS staff
// (production/floor admins). For the inbox assign dropdown we want the actual CS team:
// a CS-tier role (cs_agent / cs_lead) OR a CS-department membership. Admins can still
// self-claim a thread via the Claim button (myId), they're just not assignment targets.
async function getCsAgents(_params, _auth, env) {
  const u = await sb(
    `/rest/v1/users_profile?active=eq.true&select=id,full_name,role,cs_department_id&order=full_name.asc&limit=500`,
    env,
  );
  if (!u.ok) return err('failed to load agents', 500);
  const memRes = await sb(`/rest/v1/cs_user_departments?select=user_id`, env);
  const inCsDept = new Set((memRes.data || []).map(m => m.user_id));
  const CS_ROLES = new Set(['cs_agent', 'cs_lead']);
  const team = (u.data || [])
    .filter(p => CS_ROLES.has(p.role) || !!p.cs_department_id || inCsDept.has(p.id))
    .map(p => ({ id: p.id, full_name: p.full_name, role: p.role }));
  return ok(team);
}

// Sellable product catalogue for the New-ticket cascading dropdowns (Pruthvi #4).
// Active cars + drones from public.product_master; the UI derives product→model→
// colour→sku from the flat rows.
async function getProductCatalog(_params, _auth, env) {
  const r = await sbPublic(
    `/rest/v1/product_master?is_active=eq.true&component_type=in.(car,drone)&select=product,model,color,sku&order=product.asc,model.asc,color.asc`,
    env,
  );
  if (!r.ok) return err('failed to load product catalog', 500);
  return ok({ items: r.data || [] });
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
  let freeTextReason = null;
  if (['closed', 'cancelled', 'rejected'].includes(target_stage)) {
    update.closed_at = new Date().toISOString();
    update.closed_by_user_id = auth.userId;
    const fallback = target_stage === 'rejected' ? 'rejected'
                   : target_stage === 'cancelled' ? 'no_response'
                   : 'resolved';
    const raw = target_stage === 'rejected' ? 'rejected' : patch.closed_reason;
    if (raw && ALLOWED_CLOSED_REASONS.includes(raw)) {
      update.closed_reason = raw;
    } else {
      // Free text (e.g. "Test" from the cancel modal) can't go into the enum —
      // use the stage default and keep the note for the history trail.
      update.closed_reason = fallback;
      if (raw && String(raw).trim()) freeTextReason = String(raw).trim();
    }
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
  if (freeTextReason) {
    await insertHistory(ticket_id, 'close_note', null, freeTextReason.slice(0, 200), null, auth, env);
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

// MyOperator delivers one leg per routing hop. On a ROUTED call (first agent
// misses → it rings the next, who answers) the FIRST agent leg is the one who
// did NOT take the call; the agent who actually connected is the answered /
// positive-duration leg, typically the terminal hop. Pick that one — not the
// first. Falls back to the last agent-bearing leg, then the first, so a plain
// single-agent call is unchanged. (Pruthvi S144 — Maria missed → Sunitha
// answered, but the ticket was being attributed to Maria.)
function pickConnectedLeg(legs) {
  const arr = (Array.isArray(legs) ? legs : []).filter(l => l && l.agent && l.agent.email);
  if (!arr.length) return null;
  // status field name varies; treat as connected only when it positively says so
  const isConnected = (l) => {
    const s = String(l.status || l.leg_status || l.disposition || l.call_status || '').toLowerCase();
    if (!s) return null; // no status signal
    if (/no.?answer|missed|fail|reject|cancel|abandon|busy|unanswer/.test(s)) return false;
    return /answer|connect|complet|success|talk|bridge/.test(s);
  };
  const dur = (l) => Number(l.duration ?? l.duration_seconds ?? l.billsec ?? l.talk_time ?? 0) || 0;
  // 1) explicit connected leg → prefer the terminal one
  const connected = arr.filter(l => isConnected(l) === true);
  if (connected.length) return connected[connected.length - 1];
  // 2) positive-duration leg → prefer the terminal one
  const talked = arr.filter(l => dur(l) > 0);
  if (talked.length) return talked[talked.length - 1];
  // 3) no status/duration signal → the LAST agent leg beats the first for routed calls
  return arr[arr.length - 1];
}

function agentEmailFromLegs(legs) {
  const l = pickConnectedLeg(legs);
  return (l && l.agent && l.agent.email) || null;
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

  // Coalesce repeat calls (RULE-PITSTOP-018): if this phone already has an OPEN
  // ticket in the same department created within COALESCE_WINDOW_MS, attach this
  // call to it (cs_calls.ticket_id + a history note) rather than spawning a
  // duplicate. A customer who calls several times — dropped + callback + same-day
  // follow-up — stays on one ticket; every call is still its own cs_calls row.
  if (phone) {
    const sinceIso = new Date(Date.now() - COALESCE_WINDOW_MS).toISOString();
    const dept = account?.default_department_id || null;
    const deptFilter = dept ? `&cs_department_id=eq.${dept}` : `&cs_department_id=is.null`;
    const open = await sb(
      `/rest/v1/cs_tickets?customer_phone=eq.${encodeURIComponent(phone)}`
      + `&stage=not.in.(closed,cancelled,rejected)`
      + `&created_at=gte.${encodeURIComponent(sinceIso)}`
      + deptFilter
      + `&select=id,ticket_no&order=created_at.desc&limit=1`, env);
    if (open.data?.[0]) {
      const keep = open.data[0];
      await sb(`/rest/v1/cs_calls?myop_account_id=eq.${account.id}&call_session_id=eq.${encodeURIComponent(c.session_id)}`, env, {
        method: 'PATCH', body: JSON.stringify({ ticket_id: keep.id }),
      });
      await insertHistorySystem(keep.id, 'call_coalesced', null, c.session_id,
        `repeat call coalesced into this ticket (session ${c.session_id}${c.direction ? ', ' + c.direction : ''}) — see call log`, env);
      return json({ ok: true, coalesced_into: keep.ticket_no });
    }
  }

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

  // Instrument (step 1): persist the raw legs so the next real routed call
  // confirms the per-leg shape (status/duration field names) and pickConnectedLeg
  // can be refined if needed. Captured even when no agent matches. (Pruthvi S144.)
  const callMeta = {
    last_event: 'summary',
    legs: Array.isArray(c.legs) ? c.legs : [],
    chosen_agent_email: agentEmail || null,
  };
  const callQ = `/rest/v1/cs_calls?myop_account_id=eq.${account.id}&call_session_id=eq.${encodeURIComponent(c.session_id)}`;

  if (!agentEmail) {
    await sb(callQ, env, { method: 'PATCH', body: JSON.stringify({ raw_meta: callMeta }) });
    return json({ ok: true, skipped: 'no agent email in summary' });
  }
  const agent = await resolveAgentByEmail(agentEmail, env);
  if (!agent.id) {
    await sb(callQ, env, { method: 'PATCH', body: JSON.stringify({ raw_meta: callMeta }) });
    return json({ ok: true, skipped: 'agent email not matched: ' + agentEmail });
  }

  // cs_calls — always backfill (works for both answered and missed calls)
  await sb(callQ, env, {
    method: 'PATCH',
    body: JSON.stringify({ agent_user_id: agent.id, agent_name: agent.name, raw_meta: callMeta }),
  });

  // cs_tickets — reassign ownership to the agent who actually handled the call.
  // A call's OWN ticket is found by its session_id (the creating call). A
  // COALESCED repeat call (RULE-PITSTOP-018) has no ticket of its own, so fall
  // back to the ticket it was attached to (cs_calls.ticket_id). Ownership rule
  // (Pruthvi S156): an INCOMING answered call always takes the ticket — the
  // agent who handled the support call owns it, even when the ticket was
  // auto-created by an earlier OUTGOING (e.g. COD-confirmation) call. An OUTGOING
  // call never steals a ticket it merely coalesced into. Before this, the summary
  // keyed only on the new call's session_id, so a coalesced incoming call never
  // found the ticket and the outgoing-call agent kept the credit.
  const existing = await sb(`/rest/v1/cs_tickets?call_session_id=eq.${encodeURIComponent(c.session_id)}&select=id&limit=1`, env);
  let ticketId = existing.data?.[0]?.id || null;
  if (!ticketId && c.direction === 'incoming') {
    const callRow = await sb(`${callQ}&select=ticket_id`, env);
    ticketId = callRow.data?.[0]?.ticket_id || null;
  }
  if (ticketId) {
    await sb(`/rest/v1/cs_tickets?id=eq.${ticketId}`, env, {
      method: 'PATCH',
      body: JSON.stringify({ assigned_agent_id: agent.id, assigned_agent_name: agent.name }),
    });
    await insertHistorySystem(ticketId, 'assigned_agent_name', null, agent.name, 'auto-assigned from call.summary', env);
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

  // Multi-department membership (#2): department_ids per user from the join table.
  const memRes = await sb(`/rest/v1/cs_user_departments?select=user_id,cs_department_id`, env);
  const deptsByUser = {};
  for (const m of (memRes.data || [])) {
    (deptsByUser[m.user_id] = deptsByUser[m.user_id] || []).push(m.cs_department_id);
  }

  const result = (u.data || []).map(p => ({
    ...p,
    has_cs_manage: !!rolesMap[p.role]?.cs_ticket_manage,
    has_cs_admin:  !!rolesMap[p.role]?.cs_ticket_admin,
    department_ids: deptsByUser[p.id] || (p.cs_department_id ? [p.cs_department_id] : []),
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

// Set the full department membership for a user (#2 multi-department). Replaces
// the join-table set and keeps users_profile.cs_department_id as the primary
// (first by the given order, or null). Admin-gated.
async function setUserDepartments(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  const { user_id } = body;
  const department_ids = Array.isArray(body.department_ids) ? body.department_ids.filter(Boolean) : [];
  if (!user_id) return err('user_id required');

  // Replace the membership set.
  const del = await sb(`/rest/v1/cs_user_departments?user_id=eq.${encodeURIComponent(user_id)}`, env, {
    method: 'DELETE', prefer: 'return=minimal',
  });
  if (!del.ok) return err(`clear failed: ${JSON.stringify(del.data)}`, del.status);
  if (department_ids.length > 0) {
    const rows = department_ids.map(d => ({ user_id, cs_department_id: d }));
    const ins = await sb(`/rest/v1/cs_user_departments`, env, { method: 'POST', body: JSON.stringify(rows), prefer: 'return=minimal' });
    if (!ins.ok) return err(`assign failed: ${JSON.stringify(ins.data)}`, ins.status);
  }
  // Keep primary (home) dept in sync: first selected, or null.
  const primary = department_ids[0] || null;
  const up = await sb(`/rest/v1/users_profile?id=eq.${encodeURIComponent(user_id)}`, env, {
    method: 'PATCH', body: JSON.stringify({ cs_department_id: primary }), prefer: 'return=minimal',
  });
  if (!up.ok) return err(`primary update failed: ${JSON.stringify(up.data)}`, up.status);
  return ok({ user_id, department_ids });
}

// CS-tier roles a lead/admin may assign in-app. Deliberately EXCLUDES admin /
// super_admin / production_manager / store_head etc. — `users_profile.role` is
// the single GLOBAL cross-system role, so this control can NEVER set or overwrite
// a non-CS role (no privilege escalation outside CS). See systems/pitstop.md.
const CS_ROLE_TIERS = ['viewer', 'cs_agent', 'cs_lead'];

async function setCsRole(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;   // cs_lead + admin carry this
  const { user_id, role } = body;
  if (!user_id) return err('user_id required');
  if (!CS_ROLE_TIERS.includes(role)) return err('role must be one of: viewer, cs_agent, cs_lead', 400);
  if (user_id === auth.userId) return err('You cannot change your own role', 400);

  // Guardrail: only manage accounts that are already CS-tier (or unset). Refuse to
  // touch an account holding any other global role (admin/super_admin/etc.).
  const cur = await sb(`/rest/v1/users_profile?id=eq.${encodeURIComponent(user_id)}&select=role,full_name&limit=1`, env);
  if (!cur.ok || !cur.data?.[0]) return err('user not found', 404);
  const currentRole = cur.data[0].role || 'viewer';
  if (!CS_ROLE_TIERS.includes(currentRole)) {
    return err(`Cannot change ${cur.data[0].full_name || 'this user'} — they hold a non-CS role (${currentRole}). Change it in Garage.`, 409);
  }

  const r = await sb(`/rest/v1/users_profile?id=eq.${encodeURIComponent(user_id)}`, env, {
    method: 'PATCH',
    body: JSON.stringify({ role }),
  });
  if (!r.ok) return err(`role update failed: ${JSON.stringify(r.data)}`, r.status);
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
  { const c = buildDeptFilter(deptFilter); if (c) filters.push(c); }

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
  const deptClause = (() => { const c = buildDeptFilter(deptFilter); return c ? `&${c}` : ''; })();

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
  // Capture Chatwoot account_id so deep-links from Pitstop UI can target the
  // exact conversation: chat.bitespeed.co/app/accounts/<id>/conversations/<conv>
  const accountId = (payload?.account?.id ?? payload?.conversation?.account_id ?? payload?.inbox?.account_id ?? null);
  const accountIdStr = accountId != null ? String(accountId) : null;
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
    if (byRef.data?.[0]) {
      // Backfill provider_account_id if we now know it and the thread didn't
      if (accountIdStr && byRef.data[0].provider_account_id !== accountIdStr) {
        await sb(`/rest/v1/cs_wa_threads?id=eq.${byRef.data[0].id}`, env, {
          method: 'PATCH', body: JSON.stringify({ provider_account_id: accountIdStr }),
        }).catch(() => {});
        byRef.data[0].provider_account_id = accountIdStr;
      }
      return { thread: byRef.data[0] };
    }
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
      provider_account_id: accountIdStr,
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

// ════════════════════════════════════════════════════════════════════════════
// META — Instagram + Facebook Messenger DMs, DIRECT via the Messenger Platform
// (independent of BiteSpeed/WhatsApp). Reuses cs_wa_threads/cs_wa_messages with
// channel='instagram'|'messenger'. Webhook envelope is the stable Graph shape:
//   { object:'instagram'|'page', entry:[{ id, messaging:[{ sender:{id},
//     recipient:{id}, timestamp, message:{ mid, text, attachments, is_echo } }] }] }
// Founder setup: Meta app + IG-professional/FB-Page, subscribe webhook → this URL
// with META_VERIFY_TOKEN, App Review (instagram_business_manage_messages /
// pages_messaging), then a long-lived Page access token. Secrets:
// META_VERIFY_TOKEN, META_APP_SECRET, META_PAGE_TOKEN. INERT until those are set.
// ════════════════════════════════════════════════════════════════════════════
const META_GRAPH = 'https://graph.facebook.com/v21.0';
// Token per channel: Instagram (IG-login path) uses its own user token; FB
// Messenger uses the Page token. IG falls back to the page token if linked.
function metaToken(channel, env) {
  return channel === 'instagram' ? (env.META_IG_TOKEN || env.META_PAGE_TOKEN) : env.META_PAGE_TOKEN;
}

// Instagram-Login (IGAA) tokens only work against graph.instagram.com; Messenger
// (Page) tokens use graph.facebook.com. Pick the right Graph host per channel.
function metaGraphBase(channel) {
  return channel === 'instagram' ? 'https://graph.instagram.com/v21.0' : META_GRAPH;
}

function handleMetaVerify(url, env) {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  if (mode === 'subscribe' && env.META_VERIFY_TOKEN && token === env.META_VERIFY_TOKEN) {
    return new Response(challenge || '', { status: 200, headers: { ...CORS, 'Content-Type': 'text/plain' } });
  }
  return err('Verification failed', 403);
}

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function handleMetaWebhook(request, env) {
  // Accept either the FB app secret (Messenger) or the IG app secret (IG-login
  // path) — events from each product are signed with their own app secret.
  const secrets = [env.META_APP_SECRET, env.META_IG_APP_SECRET].filter(Boolean);
  if (!secrets.length) return json({ ok: true, skipped: 'meta_not_configured' });
  const raw = await request.text();
  // X-Hub-Signature-256 = 'sha256=' + HMAC-SHA256(rawBody, app_secret)
  const sigHeader = request.headers.get('x-hub-signature-256') || '';
  let validSig = false;
  for (const s of secrets) { if (sigHeader === 'sha256=' + await hmacSha256Hex(s, raw)) { validSig = true; break; } }
  if (!validSig) return err('Invalid signature', 401);

  let body = {};
  try { body = JSON.parse(raw); } catch { return err('Bad JSON', 400); }
  const channel = body?.object === 'instagram' ? 'instagram' : body?.object === 'page' ? 'messenger' : null;
  if (!channel) return json({ ok: true, ignored: body?.object || 'unknown' });

  try {
    for (const entry of (body.entry || [])) {
      for (const ev of (entry.messaging || entry.standby || [])) {
        if (ev.message) await metaHandleMessage(channel, ev, env);
      }
    }
  } catch (e) {
    console.error('[meta] handler error', e);
  }
  return json({ ok: true });   // always ack to avoid Meta retry storms
}

async function metaFindOrCreateThread(channel, extUserId, accountId, env) {
  const found = await sb(
    `/rest/v1/cs_wa_threads?channel=eq.${channel}&external_user_id=eq.${encodeURIComponent(extUserId)}&select=*&limit=1`, env);
  if (found.data?.[0]) return found.data[0];
  const ins = await sb(`/rest/v1/cs_wa_threads`, env, {
    method: 'POST',
    body: JSON.stringify({
      channel, external_user_id: extUserId, provider_thread_ref: extUserId,
      provider_account_id: accountId != null ? String(accountId) : null,
    }),
  });
  if (!ins.ok) console.error(`[meta] thread insert failed ${ins.status} ${JSON.stringify(ins.data)?.slice(0, 200)}`);
  return ins.data?.[0] || null;
}

// Best-effort IG-username / FB-name lookup for a scoped sender id (needs a token).
async function resolveMetaHandle(extUserId, channel, env) {
  const token = metaToken(channel, env);
  if (!token) return null;
  try {
    const r = await fetch(`${metaGraphBase(channel)}/${encodeURIComponent(extUserId)}?fields=name,username&access_token=${token}`);
    const d = await r.json();
    return r.ok ? (d.username || d.name || null) : null;
  } catch { return null; }
}

async function metaHandleMessage(channel, ev, env) {
  const msg = ev.message || {};
  const mid = msg.mid != null ? String(msg.mid) : null;
  const isEcho = !!msg.is_echo;
  const direction = isEcho ? 'outbound' : 'inbound';
  // inbound: customer = sender.id, our acct = recipient.id · echo(outbound): swapped
  const extUserId = String(isEcho ? ev.recipient?.id : ev.sender?.id);
  const accountId = isEcho ? ev.sender?.id : ev.recipient?.id;
  if (!extUserId || extUserId === 'undefined') return;

  if (mid) {
    const exists = await sb(`/rest/v1/cs_wa_messages?provider_message_id=eq.${encodeURIComponent(mid)}&select=id&limit=1`, env);
    if (exists.data?.[0]) return;   // idempotent
  }

  const thread = await metaFindOrCreateThread(channel, extUserId, accountId, env);
  if (!thread) return;

  if (!thread.customer_handle) {
    const handle = await resolveMetaHandle(extUserId, channel, env);
    if (handle) {
      await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, { method: 'PATCH', body: JSON.stringify({ customer_handle: handle }) }).catch(() => {});
      thread.customer_handle = handle;
    }
  }

  const att = Array.isArray(msg.attachments) ? msg.attachments[0] : null;
  let kind = 'text', mediaUrl = null;
  if (att) {
    const t = (att.type || '').toLowerCase();
    kind = ['image', 'video', 'audio'].includes(t) ? t : t === 'file' ? 'document' : (t || 'document');
    mediaUrl = att.payload?.url || null;
  }
  const ts = ev.timestamp ? new Date(Number(ev.timestamp)).toISOString() : new Date().toISOString();

  const ins = await sb(`/rest/v1/cs_wa_messages`, env, {
    method: 'POST',
    body: JSON.stringify({
      thread_id: thread.id, channel, direction, kind,
      body: msg.text || null, media_url: mediaUrl, provider_message_id: mid,
      status: direction === 'outbound' ? 'sent' : null,
      received_at: direction === 'inbound' ? ts : null,
      sent_at: direction === 'outbound' ? ts : null,
      raw_meta: ev,
    }),
  });
  if (!ins.ok) { console.error(`[meta] message insert failed ${ins.status} ${JSON.stringify(ins.data)?.slice(0, 200)}`); return; }

  const patch = { last_message_at: ts };
  if (direction === 'inbound') patch.customer_window_until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, { method: 'PATCH', body: JSON.stringify(patch) }).catch(() => {});
}

// Outbound send via Graph API. Inert without META_PAGE_TOKEN. Gated cs_ticket_manage.
async function sendMetaMessage(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { thread_id, text, tag } = body;
  if (!thread_id || !text) return err('thread_id and text required');

  const tRes = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=*&limit=1`, env);
  const thread = tRes.data?.[0];
  if (!thread || !thread.external_user_id) return err('Thread not found or has no recipient', 404);
  const token = metaToken(thread.channel, env);
  if (!token) return err('Meta send not configured (no token for this channel)', 503);

  const withinWindow = thread.customer_window_until && new Date(thread.customer_window_until).getTime() > Date.now();
  const payload = {
    recipient: { id: thread.external_user_id },
    message: { text },
    messaging_type: withinWindow ? 'RESPONSE' : 'MESSAGE_TAG',
    ...(withinWindow ? {} : { tag: tag || 'HUMAN_AGENT' }),
  };
  const r = await fetch(`${metaGraphBase(thread.channel)}/me/messages?access_token=${token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return err(`Meta send failed: ${JSON.stringify(d?.error || d)}`, r.status);

  const mid = d?.message_id || null;
  await sb(`/rest/v1/cs_wa_messages`, env, {
    method: 'POST',
    body: JSON.stringify({
      thread_id: thread.id, channel: thread.channel, direction: 'outbound', kind: 'text',
      body: text, provider_message_id: mid, status: 'sent',
      sent_by_user_id: auth.userId, sent_by_name: auth.fullName || auth.name || auth.email || null,
      sent_at: new Date().toISOString(),
    }),
  });
  const threadPatch = { last_message_at: new Date().toISOString() };
  if (!thread.assigned_agent_id) {                 // auto-claim on first reply (D4, S162)
    threadPatch.assigned_agent_id = auth.userId;
    threadPatch.assigned_agent_name = auth.fullName || auth.name || auth.email || null;
    threadPatch.assigned_at = new Date().toISOString();
  }
  await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, { method: 'PATCH', body: JSON.stringify(threadPatch) }).catch(() => {});
  return ok({ sent: true, message_id: mid, auto_claimed: !thread.assigned_agent_id });
}

// ── Agent Inbox — cross-channel thread list + reader + ticket link ───────────
// Surfaces every cs_wa_threads conversation (whatsapp/instagram/messenger) for
// the Pitstop /inbox. Read-gated by handleGet's cs_ticket_view; replies go
// through sendMetaMessage (IG/FB, gated cs_ticket_manage). WhatsApp stays
// read-only (BiteSpeed deep-link) until C2-B.
async function getMessagingThreads(params, auth, env) {
  const channel = params.get('channel');
  const tab = params.get('tab');              // mine | unassigned | all (assignment axis, S162)
  const limit = Math.min(Number(params.get('limit')) || 60, 300);
  let q = `/rest/v1/cs_wa_threads?select=*&order=last_message_at.desc.nullslast&limit=${limit}`;
  if (channel && channel !== 'all') q += `&channel=eq.${encodeURIComponent(channel)}`;
  if (tab === 'mine') q += `&assigned_agent_id=eq.${auth.userId}`;
  else if (tab === 'unassigned') q += `&assigned_agent_id=is.null`;
  const tRes = await sb(q, env);
  const threads = tRes.data || [];
  if (!threads.length) return ok({ threads: [] });

  // One batched fetch of recent messages for these threads → last-message preview
  // + linked ticket per thread (avoids N+1; PostgREST has no "latest per group").
  const ids = threads.map(t => t.id);
  const mRes = await sb(
    `/rest/v1/cs_wa_messages?thread_id=in.(${ids.join(',')})&select=thread_id,body,kind,direction,ticket_id,is_internal,created_at&order=created_at.desc&limit=1500`,
    env,
  );
  const lastByThread = {};
  const ticketByThread = {};
  for (const m of (mRes.data || [])) {
    // Private notes never surface as the customer-facing preview line.
    if (!m.is_internal && !lastByThread[m.thread_id]) lastByThread[m.thread_id] = m;
    if (m.ticket_id && !ticketByThread[m.thread_id]) ticketByThread[m.thread_id] = m.ticket_id;
  }
  const ticketIds = [...new Set(Object.values(ticketByThread))];
  const ticketNoById = {};
  if (ticketIds.length) {
    const tkRes = await sb(`/rest/v1/cs_tickets?id=in.(${ticketIds.join(',')})&select=id,ticket_no`, env);
    for (const tk of (tkRes.data || [])) ticketNoById[tk.id] = tk.ticket_no;
  }
  const out = threads.map(t => {
    const lm = lastByThread[t.id] || null;
    const tid = ticketByThread[t.id] || null;
    return {
      ...t,
      last_message: lm ? { body: lm.body, kind: lm.kind, direction: lm.direction, created_at: lm.created_at } : null,
      linked_ticket_id: tid,
      linked_ticket_no: tid ? (ticketNoById[tid] || null) : null,
      within_customer_window: withinCustomerWindow(t),
    };
  });
  return ok({ threads: out });
}

// Header-tile stats. Per-channel total conversations + "awaiting reply" (last
// message inbound). Awaiting is computed only for the two-way channels
// (instagram/messenger — low volume, replied to HERE); WhatsApp is a read-only
// BiteSpeed mirror (replies happen there) so it gets an exact total only.
async function getMessagingStats(params, auth, env) {
  const stats = {
    instagram: { total: 0, awaiting: 0, mine: 0, unassigned: 0 },
    messenger: { total: 0, awaiting: 0, mine: 0, unassigned: 0 },
    whatsapp:  { total: 0, awaiting: null, mine: 0, unassigned: 0 },
  };
  // Two-way channels: small volume → fetch threads + last-message direction.
  const twRes = await sb(`/rest/v1/cs_wa_threads?channel=in.(instagram,messenger)&select=id,channel,assigned_agent_id&limit=1000`, env);
  const tw = twRes.data || [];
  const chById = {};
  for (const t of tw) {
    chById[t.id] = t.channel;
    const s = stats[t.channel];
    if (!s) continue;
    s.total += 1;
    if (t.assigned_agent_id === auth.userId) s.mine += 1;
    if (!t.assigned_agent_id) s.unassigned += 1;
  }
  if (tw.length) {
    // Exclude internal notes — "awaiting reply" means the customer's last message is unanswered.
    const mRes = await sb(
      `/rest/v1/cs_wa_messages?thread_id=in.(${tw.map(t => t.id).join(',')})&is_internal=eq.false&select=thread_id,direction,created_at&order=created_at.desc&limit=3000`,
      env,
    );
    const lastDir = {};
    for (const m of (mRes.data || [])) if (!(m.thread_id in lastDir)) lastDir[m.thread_id] = m.direction;
    for (const [tid, dir] of Object.entries(lastDir)) {
      if (dir === 'inbound' && stats[chById[tid]]) stats[chById[tid]].awaiting += 1;
    }
  }
  // WhatsApp: exact counts only (read-only mirror — awaiting tracked in BiteSpeed).
  stats.whatsapp.total = await sbCount(`/rest/v1/cs_wa_threads?channel=eq.whatsapp&select=id`, env);
  stats.whatsapp.mine = await sbCount(`/rest/v1/cs_wa_threads?channel=eq.whatsapp&assigned_agent_id=eq.${auth.userId}&select=id`, env);
  stats.whatsapp.unassigned = await sbCount(`/rest/v1/cs_wa_threads?channel=eq.whatsapp&assigned_agent_id=is.null&select=id`, env);
  return ok({ stats });
}

async function getMessagingThread(params, auth, env) {
  const thread_id = params.get('thread_id');
  if (!thread_id) return err('thread_id required');
  const tRes = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=*&limit=1`, env);
  const thread = tRes.data?.[0];
  if (!thread) return err('Thread not found', 404);
  const mRes = await sb(
    `/rest/v1/cs_wa_messages?thread_id=eq.${encodeURIComponent(thread_id)}&select=*&order=created_at.asc&limit=500`,
    env,
  );
  const messages = mRes.data || [];
  const linkedId = messages.find(m => m.ticket_id)?.ticket_id || null;
  let linked_ticket = null;
  if (linkedId) {
    const tk = await sb(`/rest/v1/cs_tickets?id=eq.${linkedId}&select=id,ticket_no,disposition,stage&limit=1`, env);
    linked_ticket = tk.data?.[0] || null;
  }
  return ok({ thread, messages, linked_ticket, within_customer_window: withinCustomerWindow(thread) });
}

// Link every message on a thread to a ticket (cs_wa_messages.ticket_id). IG/FB
// threads have no phone to auto-match, so this is the manual bind from the inbox.
async function linkMessagingThread(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { thread_id, ticket_no } = body;
  if (!thread_id || !ticket_no) return err('thread_id and ticket_no required');
  const tk = await sb(`/rest/v1/cs_tickets?ticket_no=eq.${encodeURIComponent(ticket_no)}&select=id,ticket_no&limit=1`, env);
  const ticket = tk.data?.[0];
  if (!ticket) return err('Ticket not found', 404);
  const upd = await sb(`/rest/v1/cs_wa_messages?thread_id=eq.${encodeURIComponent(thread_id)}`, env, {
    method: 'PATCH', body: JSON.stringify({ ticket_id: ticket.id }),
  });
  if (!upd.ok) return err('Failed to link thread', upd.status || 500);
  return ok({ linked: true, ticket_no: ticket.ticket_no, ticket_id: ticket.id });
}

// Assign / claim / release a DM thread to an agent (Feature A, S162). Mirrors the
// ticket assignAgent gate exactly: self-claim (or self-release) needs cs_ticket_manage;
// assigning to ANOTHER agent needs cs_ticket_reassign or cs_ticket_admin. agent_id null
// = unassign (return to the pool — open to managers, or to the current owner releasing self).
async function assignThread(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { thread_id, agent_id } = body;
  if (!thread_id) return err('thread_id required');

  const tRes = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=id,assigned_agent_id&limit=1`, env);
  const thread = tRes.data?.[0];
  if (!thread) return err('Thread not found', 404);

  const canReassign = !!auth?.permissions?.cs_ticket_reassign || !!auth?.permissions?.cs_ticket_admin;
  const isSelf = agent_id === auth.userId;
  // Releasing (agent_id null): allowed if you own it OR you can reassign.
  const isSelfRelease = !agent_id && thread.assigned_agent_id === auth.userId;
  if (!isSelf && !isSelfRelease && !canReassign) {
    return err('Forbidden — only Team Lead+ can assign threads to other agents (missing cs_ticket_reassign)', 403);
  }

  let name = null;
  if (agent_id) {
    const aRes = await sb(`/rest/v1/users_profile?id=eq.${agent_id}&select=id,full_name&limit=1`, env);
    const agent = aRes.data?.[0];
    if (!agent) return err('Agent not found', 404);
    name = agent.full_name;
  }

  const upd = await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, {
    method: 'PATCH',
    body: JSON.stringify({
      assigned_agent_id: agent_id || null,
      assigned_agent_name: name,
      assigned_at: agent_id ? new Date().toISOString() : null,
    }),
  });
  if (!upd.ok) return err('Assign failed', upd.status || 500);
  return ok({ assigned_agent_id: agent_id || null, assigned_agent_name: name });
}

// Add a private (internal) note to a DM thread (Feature B, S162). Agent-only —
// stored as a cs_wa_messages row with is_internal=true / kind='note', NEVER sent to
// Graph. Stamps updated_at (NOT last_message_at) so a note doesn't reorder the thread
// above customers genuinely awaiting a reply or flip "awaiting reply".
async function addThreadNote(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { thread_id, text } = body;
  if (!thread_id || !text || !text.trim()) return err('thread_id and text required');

  const tRes = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=id,channel&limit=1`, env);
  const thread = tRes.data?.[0];
  if (!thread) return err('Thread not found', 404);

  const ins = await sb(`/rest/v1/cs_wa_messages`, env, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      thread_id: thread.id, channel: thread.channel, direction: 'outbound', kind: 'note',
      is_internal: true, body: text.trim(), status: null,
      sent_by_user_id: auth.userId, sent_by_name: auth.fullName || auth.name || auth.email || null,
      sent_at: new Date().toISOString(),
    }),
  });
  if (!ins.ok) return err('Failed to add note', ins.status || 500);
  await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, {
    method: 'PATCH', body: JSON.stringify({ updated_at: new Date().toISOString() }),
  }).catch(() => {});
  return ok({ note: ins.data?.[0] || null });
}
