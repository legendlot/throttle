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
    // Ignition bridge — sibling-worker (ignitionops) read/reply on transferred
    // "Connect" threads. Token-authed (NOT a user JWT), placed BEFORE the JWT gate
    // like the webhooks. Every handler hard-scopes to ignition_connect=true, so
    // Ignition can never reach general channel traffic. See the Ignition Connects spec.
    if (url.pathname === '/bridge/ignition' && request.method === 'POST') {
      return handleIgnitionBridge(request, env);
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

  // Cron: poll carecrew@ for new inbound email (Pitstop email channel, S175).
  // Armed via wrangler.toml [triggers] crons. Inert (no-op) until the Gmail SA
  // secrets are set. Idempotent — provider_message_id unique dedupes redelivery.
  async scheduled(_event, env, ctx) {
    if (!gmailConfigured(env)) return;   // not configured yet (no GOOGLE_SA_JSON)
    ctx.waitUntil(syncGmail(env).then(
      r => console.log('[email] cron sync', JSON.stringify(r)),
      e => console.error('[email] cron sync error', e),
    ));
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
    case 'getPresence':      return getPresence(params, auth, env);
    case 'getShifts':        return getShifts(params, auth, env);
    case 'getRoutingConfig': return getRoutingConfig(params, auth, env);
    case 'getTags':          return getTags(params, auth, env);
    case 'getCannedResponses': return getCannedResponses(params, auth, env);
    case 'getMyopAccounts':  return getMyopAccounts(params, auth, env);
    case 'getCalls':         return getCalls(params, auth, env);
    case 'getCall':          return getCall(params, auth, env);
    case 'getCallsKpis':     return getCallsKpis(params, auth, env);
    case 'getWaThread':      return getWaThread(params, auth, env);
    case 'getWaTemplates':   return getWaTemplates(params, auth, env);
    case 'getMessagingThreads': return getMessagingThreads(params, auth, env);
    case 'getMessagingThread':  return getMessagingThread(params, auth, env);
    case 'getWaConversation':   return getWaConversation(params, auth, env);
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
    case 'switchResolution': return switchResolution(body, auth, env);
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
    case 'setPresence':          return setPresence(body, auth, env);
    case 'heartbeat':            return heartbeat(body, auth, env);
    case 'setShift':             return setShift(body, auth, env);
    case 'setAgentShift':        return setAgentShift(body, auth, env);
    case 'setThreadState':       return setThreadState(body, auth, env);
    case 'setRoutingConfig':     return setRoutingConfig(body, auth, env);
    case 'createTag':            return createTag(body, auth, env);
    case 'updateTag':            return updateTag(body, auth, env);
    case 'setTicketTags':        return setTicketTags(body, auth, env);
    case 'setThreadTags':        return setThreadTags(body, auth, env);
    case 'setMyopDefaultDepartment': return setMyopDefaultDepartment(body, auth, env);
    case 'markCalledBack':           return markCalledBack(body, auth, env);
    case 'createTicketFromCall':     return createTicketFromCall(body, auth, env);
    case 'sendWaMessage':            return sendWaMessage(body, auth, env);
    case 'sendWaReply':              return sendWaReply(body, auth, env);
    case 'sendMetaMessage':          return sendMetaMessage(body, auth, env);
    case 'sendMetaAttachment':       return sendMetaAttachment(body, auth, env);
    case 'sendEmailReply':           return sendEmailReply(body, auth, env);
    case 'syncGmailNow':             return syncGmailNow(body, auth, env);
    case 'linkMessagingThread':      return linkMessagingThread(body, auth, env);
    case 'assignThread':             return assignThread(body, auth, env);
    case 'transferThread':           return transferThread(body, auth, env);
    case 'transferThreadToIgnition': return transferThreadToIgnition(body, auth, env);
    case 'bulkAssignThreads':        return bulkAssignThreads(body, auth, env);
    case 'setThreadPriority':        return setThreadPriority(body, auth, env);
    case 'createTicketFromThread':   return createTicketFromThread(body, auth, env);
    case 'addThreadNote':            return addThreadNote(body, auth, env);
    case 'createCannedResponse':     return createCannedResponse(body, auth, env);
    case 'updateCannedResponse':     return updateCannedResponse(body, auth, env);
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
  const tagFilter = params.get('tag');                       // tag facet (S163)
  if (tagFilter) {
    const tagged = await idsWithTag('ticket', tagFilter, env);
    if (!tagged.length) return ok({ tickets: [], offset, limit });
    filters.push(`id=in.(${tagged.join(',')})`);
  }

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

  const tickets = res.data || [];
  const tagsByTicket = await fetchTagsFor('ticket', tickets.map(t => t.id), env);
  return ok({ tickets: tickets.map(t => ({ ...t, tags: tagsByTicket[t.id] || [] })), offset, limit });
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

  const tagsByTicket = await fetchTagsFor('ticket', [ticket.id], env);
  return ok({
    ticket: updatedTicket,
    history: historyRes.data || [],
    attachments: attachRes.data || [],
    notes: notesRes.data || [],
    links: linksRes.data || [],
    dispatch_info: dispatchInfo,
    past_cases: pastCases,
    repair_run: repairRun?.data?.[0] || null,
    tags: tagsByTicket[ticket.id] || [],
  });
}

async function fetchDispatchInfo(upc, env) {
  // unit → product_master, dispatch_allocations, dispatch_shipments
  const [unitRes, allocRes] = await Promise.all([
    sbPublic(`/rest/v1/units?upc=eq.${encodeURIComponent(upc)}&select=upc,product,model,color,sku,current_status,production_run_id&limit=1`, env),
    sbPublic(`/rest/v1/dispatch_allocations?unit_upc=eq.${encodeURIComponent(upc)}&select=*&order=allocated_at.desc&limit=1`, env),
  ]);
  if (!unitRes.ok || !unitRes.data?.[0]) return null;
  const unit = unitRes.data[0];
  let shipment = null;
  const alloc = allocRes.data?.[0];
  if (alloc?.shipment_id) {
    const shipRes = await sbPublic(`/rest/v1/dispatch_shipments?id=eq.${alloc.shipment_id}&select=*&limit=1`, env);
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

  const [openR, slaR, awaitingR, resolvedR, unassignedR, refundsR, agentRowsR, rosterR, membersR, createdTodayR] = await Promise.all([
    sb(`/rest/v1/cs_tickets?closed_at=is.null&select=id&limit=5000${scopeQs}`, env),
    sb(`/rest/v1/cs_tickets?closed_at=is.null&due_at=lt.${encodeURIComponent(nowIso)}&select=created_at&order=created_at.asc&limit=5000${scopeQs}`, env),
    sb(`/rest/v1/cs_tickets?stage=eq.awaiting_evidence&closed_at=is.null&stage_changed_at=lt.${encodeURIComponent(agingIso)}&select=id&limit=5000${scopeQs}`, env),
    sb(`/rest/v1/cs_tickets?closed_at=gte.${encodeURIComponent(startOfTodayIso)}&select=id&limit=5000${scopeQs}`, env),
    sb(`/rest/v1/cs_tickets?closed_at=is.null&assigned_agent_id=is.null&select=auto_created&limit=5000${scopeQs}`, env),
    sb(`/rest/v1/cs_tickets?closed_at=is.null&disposition=eq.refund&stage=eq.inspected&select=refund_amount_inr&limit=5000${scopeQs}`, env),
    sb(`/rest/v1/cs_tickets?closed_at=is.null&assigned_agent_id=not.is.null&select=assigned_agent_id,assigned_agent_name&limit=5000${scopeQs}`, env),
    sb(`/rest/v1/users_profile?active=eq.true&select=id,full_name,role,cs_department_id&order=full_name.asc&limit=500`, env),
    sb(`/rest/v1/cs_user_departments?select=user_id`, env),
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

  // EXACT per-agent open load — seed from the CS-TEAM roster (so idle agents show
  // at 0) then add the grouped open counts. NOT every cs_ticket_manage holder: the
  // generic admin/super_admin roles carry that perm via the catch-all grant, which
  // floods the widget with non-CS org users. CS-team = a CS-tier role OR a CS-dept
  // member (mirrors getCsAgents, S162/S163).
  const CS_ROLES = new Set(['cs_agent', 'cs_lead']);
  const inCsDept = new Set((membersR.data || []).map(m => m.user_id));
  const agentMap = {};
  for (const u of (rosterR.data || [])) {
    if (CS_ROLES.has(u.role) || !!u.cs_department_id || inCsDept.has(u.id)) {
      agentMap[u.id] = { user_id: u.id, name: u.full_name || '—', open: 0 };
    }
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

// ── Agent presence + shift windows (Phase 1) ─────────────────────────────────
// Routing eligibility (Phase 2) = effective 'online' (status online + FRESH heartbeat)
// AND ( now within the agent's department shift window OR a manual 'Available'
// override, auto=false ). Effective status is computed live, so a stale 'online'
// (closed/forgotten tab) is never trusted and never routed — no reset cron needed.

const PRESENCE_FRESH_MS = 3 * 60 * 1000;   // heartbeat freshness (~3x the 60s client ping)

// Current IST wall-clock: minutes past midnight + ISO day-of-week (1=Mon..7=Sun).
function istNow() {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000);
  const min = d.getUTCHours() * 60 + d.getUTCMinutes();
  const dow0 = d.getUTCDay();                 // 0=Sun..6=Sat
  return { min, isoDow: dow0 === 0 ? 7 : dow0 };
}

function inShiftWindow(shift, nowParts) {
  if (!shift || shift.is_active === false) return false;
  const days = Array.isArray(shift.working_days) ? shift.working_days : [];
  if (!days.includes(nowParts.isoDow)) return false;
  const s = Number(shift.start_min), e = Number(shift.end_min);
  if (e >= s) return nowParts.min >= s && nowParts.min < e;
  return nowParts.min >= s || nowParts.min < e;   // overnight wrap
}

function effectivePresence(p, nowMs) {
  if (!p) return 'offline';
  if (p.status === 'online') {
    const fresh = p.last_seen_at && (nowMs - Date.parse(p.last_seen_at)) <= PRESENCE_FRESH_MS;
    return fresh ? 'online' : 'offline';
  }
  return p.status;   // a manual away/offline stands regardless of heartbeat
}

// Roster of CS agents with effective status, in-shift flag, and routing eligibility.
async function getPresence(_params, auth, env) {
  const g = require('cs_ticket_view', auth); if (g) return g;

  const u = await sb(
    `/rest/v1/users_profile?active=eq.true&select=id,full_name,role,cs_department_id&order=full_name.asc&limit=500`,
    env,
  );
  if (!u.ok) return err('failed to load roster', 500);

  const memRes = await sb(`/rest/v1/cs_user_departments?select=user_id,cs_department_id`, env);
  const inCsDept = new Set((memRes.data || []).map(m => m.user_id));
  const CS_ROLES = new Set(['cs_agent', 'cs_lead']);
  const team = (u.data || []).filter(
    p => CS_ROLES.has(p.role) || !!p.cs_department_id || inCsDept.has(p.id),
  );

  const presByUser = {};
  if (team.length) {
    const pr = await sb(
      `/rest/v1/cs_agent_presence?user_id=in.(${team.map(p => p.id).join(',')})&select=*`,
      env,
    );
    for (const row of (pr.data || [])) presByUser[row.user_id] = row;
  }

  const sh = await sb(`/rest/v1/cs_shifts?select=*`, env);
  const shiftByDept = {};
  for (const s of (sh.data || [])) shiftByDept[s.cs_department_id] = s;

  // Per-agent shift overrides (S164). A present + active row wins over the dept
  // window for that agent; an inactive/absent row falls back to the department.
  const ash = await sb(
    `/rest/v1/cs_agent_shifts?user_id=in.(${team.map(p => p.id).join(',') || '00000000-0000-0000-0000-000000000000'})&select=*`,
    env,
  );
  const agentShiftByUser = {};
  for (const s of (ash.data || [])) agentShiftByUser[s.user_id] = s;

  const nowParts = istNow();
  const nowMs = Date.now();
  const roster = team.map(p => {
    const pres = presByUser[p.id] || null;
    const eff = effectivePresence(pres, nowMs);
    const custom = agentShiftByUser[p.id] || null;
    const effShift = (custom && custom.is_active !== false) ? custom : shiftByDept[p.cs_department_id];
    const in_shift = inShiftWindow(effShift, nowParts);
    const override = !!pres && pres.auto === false && eff === 'online';
    return {
      user_id: p.id,
      full_name: p.full_name,
      role: p.role,
      cs_department_id: p.cs_department_id || null,
      status: eff,
      raw_status: pres?.status || 'offline',
      auto: pres ? pres.auto : true,
      last_seen_at: pres?.last_seen_at || null,
      in_shift,
      custom_shift: custom && { start_min: custom.start_min, end_min: custom.end_min, working_days: custom.working_days, is_active: custom.is_active },
      eligible: eff === 'online' && (in_shift || override),
    };
  });

  return ok({ roster, ist_now_min: nowParts.min, ist_dow: nowParts.isoDow });
}

// Per-department shift windows (joined to dept slug/name, dept sort order).
async function getShifts(_params, auth, env) {
  const g = require('cs_ticket_view', auth); if (g) return g;
  const r = await sb(
    `/rest/v1/cs_shifts?select=cs_department_id,start_min,end_min,working_days,is_active,updated_at,cs_departments(slug,name,sort_order)`,
    env,
  );
  if (!r.ok) return err('failed to load shifts', 500);
  const rows = (r.data || [])
    .map(s => ({
      cs_department_id: s.cs_department_id,
      slug: s.cs_departments?.slug || null,
      name: s.cs_departments?.name || null,
      sort_order: s.cs_departments?.sort_order ?? 999,
      start_min: s.start_min,
      end_min: s.end_min,
      working_days: s.working_days,
      is_active: s.is_active,
      updated_at: s.updated_at,
    }))
    .sort((a, b) => a.sort_order - b.sort_order);
  return ok({ shifts: rows });
}

// Set own availability. Manual toggle → auto=false; 'online' outside the window
// is the off-schedule 'Available' override. Any signed-in CS user sets their own.
async function setPresence(body, auth, env) {
  const g = require('cs_ticket_view', auth); if (g) return g;
  const status = String(body?.status || '');
  if (!['online', 'away', 'offline'].includes(status)) return err('invalid status');
  const nowIso = new Date().toISOString();
  const row = {
    user_id: auth.userId,
    status,
    status_since: nowIso,
    last_seen_at: nowIso,
    auto: false,
    updated_at: nowIso,
  };
  const r = await sb(`/rest/v1/cs_agent_presence?on_conflict=user_id`, env, {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: JSON.stringify(row),
  });
  if (!r.ok) return err('failed to set presence', 500);
  return ok({ status });
}

// Liveness ping (~60s, activity-gated client-side). One atomic RPC: promotes an
// auto-managed row to online + bumps last_seen; never clobbers a manual away/offline.
async function heartbeat(_body, auth, env) {
  const g = require('cs_ticket_view', auth); if (g) return g;
  const r = await sb(`/rest/v1/rpc/cs_heartbeat`, env, {
    method: 'POST',
    body: JSON.stringify({ p_user: auth.userId }),
  });
  if (!r.ok) return err('heartbeat failed', 500);
  const row = Array.isArray(r.data) ? r.data[0] : r.data;   // RPC returns the row composite
  return ok({ status: row?.status || 'online', auto: row?.auto ?? true, last_seen_at: row?.last_seen_at || null });
}

// Admin: set a department's shift window (upsert by cs_department_id).
async function setShift(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  const { cs_department_id, start_min, end_min, working_days, is_active } = body || {};
  if (!cs_department_id) return err('cs_department_id required');
  const sMin = Number(start_min), eMin = Number(end_min);
  if (!Number.isInteger(sMin) || sMin < 0 || sMin > 1440) return err('invalid start_min');
  if (!Number.isInteger(eMin) || eMin < 0 || eMin > 1440) return err('invalid end_min');
  const days = Array.isArray(working_days) ? [...new Set(working_days.map(Number))] : [];
  if (!days.length || days.some(d => !Number.isInteger(d) || d < 1 || d > 7))
    return err('working_days must be ISO day numbers 1-7');
  const row = {
    cs_department_id,
    start_min: sMin,
    end_min: eMin,
    working_days: days.sort((a, b) => a - b),
    is_active: is_active === undefined ? true : !!is_active,
    updated_at: new Date().toISOString(),
    updated_by_user_id: auth.userId,
  };
  const r = await sb(`/rest/v1/cs_shifts?on_conflict=cs_department_id`, env, {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: JSON.stringify(row),
  });
  if (!r.ok) return err('failed to save shift', 500);
  return ok({ shift: r.data?.[0] || row });
}

// Admin: set (or clear) a single agent's personal shift override (S164, Pruthvi).
// { user_id, start_min, end_min, working_days, is_active } upserts the override;
// { user_id, clear: true } removes it so the agent reverts to their dept window.
async function setAgentShift(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  const { user_id, clear, start_min, end_min, working_days, is_active } = body || {};
  if (!user_id) return err('user_id required');

  if (clear) {
    const d = await sb(`/rest/v1/cs_agent_shifts?user_id=eq.${encodeURIComponent(user_id)}`, env, { method: 'DELETE' });
    if (!d.ok) return err('failed to clear agent shift', 500);
    return ok({ cleared: true, user_id });
  }

  const sMin = Number(start_min), eMin = Number(end_min);
  if (!Number.isInteger(sMin) || sMin < 0 || sMin > 1440) return err('invalid start_min');
  if (!Number.isInteger(eMin) || eMin < 0 || eMin > 1440) return err('invalid end_min');
  const days = Array.isArray(working_days) ? [...new Set(working_days.map(Number))] : [];
  if (!days.length || days.some(d => !Number.isInteger(d) || d < 1 || d > 7))
    return err('working_days must be ISO day numbers 1-7');
  const row = {
    user_id,
    start_min: sMin,
    end_min: eMin,
    working_days: days.sort((a, b) => a - b),
    is_active: is_active === undefined ? true : !!is_active,
    updated_at: new Date().toISOString(),
    updated_by_user_id: auth.userId,
  };
  const r = await sb(`/rest/v1/cs_agent_shifts?on_conflict=user_id`, env, {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: JSON.stringify(row),
  });
  if (!r.ok) return err('failed to save agent shift', 500);
  return ok({ shift: r.data?.[0] || row });
}

// ── Thread work-queue state + routing config (Phase 2) ───────────────────────

// Mark a DM thread open / snoozed / closed (the inbox "Done"/"Reopen"/"Snooze").
// 'open' is also auto-set by the webhook on any new inbound (auto-reopen).
async function setThreadState(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { thread_id, state, snoozed_until } = body || {};
  if (!thread_id) return err('thread_id required');
  if (!['open', 'snoozed', 'closed'].includes(state)) return err('invalid state');
  const patch = { thread_state: state };
  if (state === 'closed') {
    patch.closed_at = new Date().toISOString();
    patch.closed_by_user_id = auth.userId;
    patch.snoozed_until = null;
  } else if (state === 'snoozed') {
    patch.snoozed_until = snoozed_until || null;
    patch.closed_at = null; patch.closed_by_user_id = null;
  } else {                                  // open
    patch.closed_at = null; patch.closed_by_user_id = null; patch.snoozed_until = null;
  }
  const r = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}`, env, {
    method: 'PATCH', body: JSON.stringify(patch),
  });
  if (!r.ok) return err('failed to set thread state', 500);
  return ok({ thread_state: state });
}

async function getRoutingConfig(_params, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  const r = await sb(`/rest/v1/cs_routing_config?select=*&order=channel.asc`, env);
  if (!r.ok) return err('failed to load routing config', 500);
  return ok({ config: r.data || [] });
}

async function setRoutingConfig(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  const { channel, auto_assign_enabled, max_open_per_agent } = body || {};
  if (!['instagram', 'messenger', 'whatsapp'].includes(channel)) return err('invalid channel');
  const patch = { updated_at: new Date().toISOString(), updated_by_user_id: auth.userId };
  if (auto_assign_enabled !== undefined) patch.auto_assign_enabled = !!auto_assign_enabled;
  if (max_open_per_agent !== undefined) {
    const n = (max_open_per_agent === null || max_open_per_agent === '') ? null : Number(max_open_per_agent);
    if (n !== null && (!Number.isInteger(n) || n < 0)) return err('invalid max_open_per_agent');
    patch.max_open_per_agent = n;
  }
  const r = await sb(`/rest/v1/cs_routing_config?channel=eq.${encodeURIComponent(channel)}`, env, {
    method: 'PATCH', body: JSON.stringify(patch),
  });
  if (!r.ok) return err('failed to save routing config', 500);
  return ok({ channel });
}

// ── Tags (Phase 3) — one catalogue, shared across tickets + DM threads ────────
const TAG_COLORS = new Set(['slate', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink']);
const slugifyTag = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

// Batch-fetch tags for a set of parent ids → { parentId: [{id,name,color,slug}] }.
async function fetchTagsFor(kind, ids, env) {
  if (!ids.length) return {};
  const jt = kind === 'ticket' ? 'cs_ticket_tags' : 'cs_thread_tags';
  const col = kind === 'ticket' ? 'ticket_id' : 'thread_id';
  const r = await sb(`/rest/v1/${jt}?${col}=in.(${ids.join(',')})&select=${col},cs_tags(id,name,color,slug,is_active)`, env);
  const out = {};
  for (const row of (r.data || [])) {
    const t = row.cs_tags;
    if (!t || t.is_active === false) continue;
    (out[row[col]] ||= []).push({ id: t.id, name: t.name, color: t.color, slug: t.slug });
  }
  return out;
}

// Resolve the parent ids carrying a given tag (for the ?tag= list facet).
async function idsWithTag(kind, tagId, env) {
  const jt = kind === 'ticket' ? 'cs_ticket_tags' : 'cs_thread_tags';
  const col = kind === 'ticket' ? 'ticket_id' : 'thread_id';
  const r = await sb(`/rest/v1/${jt}?tag_id=eq.${encodeURIComponent(tagId)}&select=${col}&limit=10000`, env);
  return (r.data || []).map(x => x[col]);
}

async function getTags(params, auth, env) {
  const g = require('cs_ticket_view', auth); if (g) return g;
  const includeArchived = params.get('all') === '1' && !!auth.permissions?.cs_ticket_admin;
  const q = `/rest/v1/cs_tags?select=id,name,slug,color,description,is_active,sort_order`
    + `${includeArchived ? '' : '&is_active=eq.true'}&order=sort_order.asc,name.asc`;
  const r = await sb(q, env);
  if (!r.ok) return err('failed to load tags', 500);
  return ok({ tags: r.data || [] });
}

async function createTag(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const name = String(body?.name || '').trim();
  const color = String(body?.color || 'slate');
  if (!name) return err('name required');
  if (!TAG_COLORS.has(color)) return err('invalid color');
  const slug = slugifyTag(name);
  if (!slug) return err('invalid name');
  const ex = await sb(`/rest/v1/cs_tags?slug=eq.${encodeURIComponent(slug)}&select=id,is_active&limit=1`, env);
  if (ex.data?.[0]) {
    if (ex.data[0].is_active === false) {     // reactivate an archived dupe rather than erroring
      const up = await sb(`/rest/v1/cs_tags?id=eq.${ex.data[0].id}`, env, {
        method: 'PATCH', body: JSON.stringify({ is_active: true, color, name, updated_at: new Date().toISOString() }),
      });
      return ok({ tag: up.data?.[0] || null, reactivated: true });
    }
    return err('a tag with that name already exists', 409);
  }
  const r = await sb(`/rest/v1/cs_tags`, env, {
    method: 'POST',
    body: JSON.stringify({ name, slug, color, description: body?.description || null, created_by_user_id: auth.userId }),
  });
  if (!r.ok) return err('failed to create tag', 500);
  return ok({ tag: r.data?.[0] || null });
}

async function updateTag(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;     // curation is lead/admin
  const { id, name, color, description, is_active, sort_order } = body || {};
  if (!id) return err('id required');
  const patch = { updated_at: new Date().toISOString() };
  if (name !== undefined) { const n = String(name).trim(); if (!n) return err('invalid name'); patch.name = n; patch.slug = slugifyTag(n); }
  if (color !== undefined) { if (!TAG_COLORS.has(color)) return err('invalid color'); patch.color = color; }
  if (description !== undefined) patch.description = description || null;
  if (is_active !== undefined) patch.is_active = !!is_active;
  if (sort_order !== undefined) patch.sort_order = Math.round(Number(sort_order) || 0);
  const r = await sb(`/rest/v1/cs_tags?id=eq.${encodeURIComponent(id)}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
  if (!r.ok) return err('failed to update tag', 500);
  return ok({ tag: r.data?.[0] || null });
}

// Replace-set a ticket's / thread's tags (batched delete-not-in + insert-missing).
async function setTagsFor(kind, parentId, tagIds, auth, env) {
  const jt = kind === 'ticket' ? 'cs_ticket_tags' : 'cs_thread_tags';
  const col = kind === 'ticket' ? 'ticket_id' : 'thread_id';
  const notIn = tagIds.length ? `&tag_id=not.in.(${tagIds.join(',')})` : '';
  await sb(`/rest/v1/${jt}?${col}=eq.${encodeURIComponent(parentId)}${notIn}`, env, { method: 'DELETE', prefer: 'return=minimal' });
  if (tagIds.length) {
    const rows = tagIds.map(t => ({ [col]: parentId, tag_id: t, tagged_by_user_id: auth.userId }));
    await sb(`/rest/v1/${jt}?on_conflict=${col},tag_id`, env, {
      method: 'POST', prefer: 'resolution=ignore-duplicates,return=minimal', body: JSON.stringify(rows),
    });
  }
}

async function setTicketTags(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { ticket_id } = body || {};
  const tagIds = Array.isArray(body?.tag_ids) ? [...new Set(body.tag_ids)] : null;
  if (!ticket_id || !tagIds) return err('ticket_id and tag_ids required');
  await setTagsFor('ticket', ticket_id, tagIds, auth, env);
  await insertHistory(ticket_id, 'tags', null, tagIds.join(',') || '(none)', null, auth, env).catch(() => {});
  return ok({ ticket_id, tag_ids: tagIds });
}

async function setThreadTags(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { thread_id } = body || {};
  const tagIds = Array.isArray(body?.tag_ids) ? [...new Set(body.tag_ids)] : null;
  if (!thread_id || !tagIds) return err('thread_id and tag_ids required');
  await setTagsFor('thread', thread_id, tagIds, auth, env);
  return ok({ thread_id, tag_ids: tagIds });
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
      lot_unit_upc: lot_unit_upc ? normalizeUpc(lot_unit_upc) : null,
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

// Switch a ticket's resolution path between Replacement and Refund (Pruthvi #bugs
// S181). Any cs_ticket_manage agent may switch — but ONLY while the ticket is still
// pre-resolution (in a SHARED_STAGE). Once a refund is initiated/completed or a
// replacement is dispatched (a BRANCH_STAGE), or the ticket is closed/side-exited,
// the resolution is in motion and the switch is blocked (cancel + reopen instead).
// Replacement and Refund share the same SHARED_STAGES, so the stage is preserved;
// only the disposition (+ recomputed SLA due_at) changes.
async function switchResolution(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { ticket_id, to_disposition, reason } = body;
  const SWITCHABLE = new Set(['replacement', 'refund']);
  if (!ticket_id || !SWITCHABLE.has(to_disposition)) {
    return err('ticket_id and to_disposition (replacement|refund) required', 422);
  }
  const tRes = await sb(`/rest/v1/cs_tickets?id=eq.${encodeURIComponent(ticket_id)}&select=*&limit=1`, env);
  const t = tRes.data?.[0];
  if (!t) return err('Ticket not found', 404);
  if (!SWITCHABLE.has(t.disposition)) {
    return err(`Only a Replacement or Refund ticket can be switched (this one is ${t.disposition || 'unset'}).`, 422);
  }
  if (t.disposition === to_disposition) return ok({ switched: false, disposition: t.disposition });
  // Pre-resolution gate — the stage must still be in the shared flow.
  if (!SHARED_STAGES.includes(t.stage)) {
    return err(`Can't switch — this ${t.disposition} is already in motion (stage: ${t.stage}). Cancel and reopen the ticket if it must change.`, 409);
  }

  const createdMs = new Date(t.created_at).getTime();
  const due_at = new Date((Number.isFinite(createdMs) ? createdMs : Date.now()) + (SLA_DAYS[to_disposition] ?? 7) * 24 * 60 * 60 * 1000).toISOString();

  const upd = await sb(`/rest/v1/cs_tickets?id=eq.${encodeURIComponent(ticket_id)}`, env, {
    method: 'PATCH',
    body: JSON.stringify({ disposition: to_disposition, due_at }),
  });
  if (!upd.ok) return err(`Switch failed: ${JSON.stringify(upd.data)}`, upd.status);

  await insertHistory(ticket_id, 'disposition', t.disposition, to_disposition,
    reason ? String(reason).slice(0, 200) : 'switched resolution path', auth, env);
  return ok({ switched: true, disposition: to_disposition, due_at });
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

  // Open/Closed tabs distinguish active vs resolved CALL-LINKED tickets — they
  // require a linked ticket (inner join below) and filter on its closed_at.
  const ticketState = (tab === 'open' || tab === 'closed') ? tab : null;

  // tab presets
  if (tab === 'my')          filters.push(`agent_user_id=eq.${auth.userId}`);
  else if (tab === 'unassigned') filters.push(`agent_user_id=is.null`, `ticket_id=is.null`);
  else if (tab === 'missed') filters.push(`status=eq.missed`, `called_back_at=is.null`);
  else if (ticketState === 'open')   filters.push(`ticket.closed_at=is.null`);
  else if (ticketState === 'closed') filters.push(`ticket.closed_at=not.is.null`);

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
  // Open/Closed tabs inner-join the ticket so a call with no ticket is excluded
  // and the closed_at filter on the embed can take effect.
  const ticketEmbed = ticketState ? 'ticket:ticket_id!inner(ticket_no,closed_at)' : 'ticket:ticket_id(ticket_no)';
  const path = `/rest/v1/cs_calls?select=${select},${ticketEmbed}&${filters.join('&')}&order=created_at.desc&limit=${limit}&offset=${offset}`;
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

// ── Phase C2-B: two-way WhatsApp via the BiteSpeed (Chatwoot) Application API ──
//
// Interim path until the WABA migrates off BiteSpeed to direct Meta (Relay).
// KEY FACT: BiteSpeed's *webhook* only mirrors our OUTBOUND side (it never forwards
// customer replies — that's the documented "one-sided" limitation and why the local
// cs_wa_threads.customer_window_until column is always null). But the Chatwoot *API*
// returns the full two-way conversation, so we PULL it on demand to (a) show the
// customer's messages in Pitstop and (b) derive the real 24h window from the latest
// inbound. At WABA cutover these fetch()es swap to Meta Graph (like sendMetaMessage)
// and nothing else here changes.
function biteSpeedApiBase(env) {
  return (env.BITESPEED_API_BASE || 'https://chat.bitespeed.co').replace(/\/+$/, '');
}

// Pull the live Chatwoot conversation messages for a WA thread.
// Chatwoot's messages endpoint returns only the most recent page (~the latest
// messages). To show full scrollback we page BACKWARDS via ?before=<oldest id>:
// each call returns messages strictly older than that id, so we walk to the start
// of the conversation. Bounded by MAX_PAGES to respect the 50-subrequest Worker
// limit (this fn runs inside a single getWaConversation request).
async function chatwootGetMessages(thread, env) {
  const base = `${biteSpeedApiBase(env)}/api/v1/accounts/${encodeURIComponent(thread.provider_account_id)}/conversations/${encodeURIComponent(thread.provider_thread_ref)}/messages`;
  // 12 pages (~12 subrequests/open) — interim deepening of in-thread scrollback
  // (Pruthvi #bugs 2026-07-10: history stopped at ~60 msgs). Still well under the
  // 50-subrequest limit. Full frontend infinite-scroll is the open follow-up.
  const MAX_PAGES = 12;
  const all = [];
  const seen = new Set();
  let before = null;

  for (let i = 0; i < MAX_PAGES; i++) {
    const url = before ? `${base}?before=${encodeURIComponent(before)}` : base;
    let r;
    try { r = await fetch(url, { headers: { 'api_access_token': env.BITESPEED_API_TOKEN } }); }
    catch (e) { return all.length ? { ok: true, raw: all } : { ok: false, status: 502, error: e.message }; }
    if (!r.ok) {
      if (all.length) break;   // keep whatever we already pulled
      const t = await r.text().catch(() => ''); return { ok: false, status: r.status, error: t.slice(0, 200) };
    }
    const d = await r.json().catch(() => ({}));
    const batch = Array.isArray(d?.payload) ? d.payload : (Array.isArray(d) ? d : []);
    if (!batch.length) break;  // reached the start of the conversation

    let added = 0, minId = null;
    for (const m of batch) {
      const id = m?.id != null ? String(m.id) : null;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      all.push(m);
      added++;
      const n = Number(m?.id);
      if (Number.isFinite(n) && (minId == null || n < minId)) minId = n;
    }
    // No progress (no new rows or oldest id didn't move back) → stop.
    if (!added || minId == null || minId === before) break;
    before = minId;
  }
  return { ok: true, raw: all };
}

// Map a Chatwoot message → the shape the Pitstop inbox Bubble renders.
function mapChatwootMessage(m) {
  const typeNum = Number(m?.message_type);   // 0=in 1=out 2=activity 3=template
  if (typeNum === 2) return null;            // activity / system — skip
  const isInternal = m?.private === true;
  const direction = typeNum === 0 ? 'inbound' : 'outbound';
  const atts = Array.isArray(m?.attachments) ? m.attachments : [];
  let kind = 'text';
  if (isInternal) kind = 'note';
  else if (atts.length) kind = attachmentKindFromChatwoot(atts[0]?.file_type);
  else if (typeNum === 3) kind = 'template';
  const ts = m?.created_at != null
    ? (typeof m.created_at === 'number' ? new Date(m.created_at * 1000).toISOString() : new Date(m.created_at).toISOString())
    : null;
  return {
    id: m?.id != null ? String(m.id) : `${direction}-${ts}`,
    provider_message_id: m?.id != null ? String(m.id) : null,
    direction, kind, is_internal: isInternal,
    body: m?.content || null,
    template_name: typeNum === 3 ? (m?.content_attributes?.template_name || m?.content_attributes?.template?.name || null) : null,
    media_url: atts[0]?.data_url || atts[0]?.file_url || null,
    media_filename: atts[0]?.file_name || null,
    status: m?.status || (direction === 'outbound' ? 'sent' : null),
    sent_by_name: direction === 'outbound' ? (m?.sender?.name || m?.sender?.available_name || null) : null,
    received_at: direction === 'inbound' ? ts : null,
    sent_at: direction === 'outbound' ? ts : null,
    created_at: ts,
  };
}

// 24h Meta customer-initiated window, derived from the latest INBOUND message — the
// only authoritative source (the local column is fed by the one-way webhook, so dead).
function deriveWaWindow(mapped) {
  let latestInbound = 0;
  for (const m of mapped) {
    if (m.direction !== 'inbound') continue;
    const t = new Date(m.received_at || m.created_at).getTime();
    if (Number.isFinite(t) && t > latestInbound) latestInbound = t;
  }
  if (!latestInbound) return { open: false, until: null };
  const until = latestInbound + 24 * 60 * 60 * 1000;
  return { open: until > Date.now(), until: new Date(until).toISOString() };
}

async function loadWaLive(thread, env) {
  const res = await chatwootGetMessages(thread, env);
  if (!res.ok) return res;
  const messages = res.raw.map(mapChatwootMessage).filter(Boolean)
    .sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
  return { ok: true, messages, window: deriveWaWindow(messages) };
}

// GET getWaConversation — the live two-way WhatsApp thread pulled from Chatwoot.
async function getWaConversation(params, auth, env) {
  const g = require('cs_ticket_view', auth); if (g) return g;
  const thread_id = params.get('thread_id');
  if (!thread_id) return err('thread_id required');
  if (!env.BITESPEED_API_TOKEN) return err('WhatsApp not configured (no BiteSpeed API token)', 503);

  const tRes = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=*&limit=1`, env);
  const thread = tRes.data?.[0];
  if (!thread) return err('Thread not found', 404);
  if (!thread.provider_account_id || !thread.provider_thread_ref) {
    return ok({ messages: [], within_customer_window: false, window_until: null, live: false,
                note: 'No BiteSpeed conversation reference on this thread yet.' });
  }

  const live = await loadWaLive(thread, env);
  if (!live.ok) return err(`Failed to load WhatsApp conversation from BiteSpeed (${live.status}): ${live.error}`, 502);

  // Agent-attribution overlay (Pruthvi #bugs 2026-07-10): the live BiteSpeed pull tags
  // every OUTGOING message with BiteSpeed's connected API-account name (shows as "Afshaan"),
  // not the agent who actually sent it. Our own sendWaReply stores the real agent in
  // cs_wa_messages.sent_by_name keyed by the BiteSpeed message id (provider_message_id ==
  // mapChatwootMessage's String(m.id)), so overlay ours onto the live rows. Replies sent
  // directly in the BiteSpeed UI (not via Pitstop) have no stored row → keep the live name.
  const attrRes = await sb(
    `/rest/v1/cs_wa_messages?thread_id=eq.${encodeURIComponent(thread.id)}&direction=eq.outbound&is_internal=eq.false&sent_by_name=not.is.null&provider_message_id=not.is.null&select=provider_message_id,sent_by_name&limit=400`,
    env,
  );
  const nameByPmid = {};
  for (const m of (attrRes.data || [])) {
    if (m.provider_message_id && m.sent_by_name) nameByPmid[String(m.provider_message_id)] = m.sent_by_name;
  }
  for (const m of live.messages) {
    if (m.direction === 'outbound' && m.provider_message_id && nameByPmid[m.provider_message_id]) {
      m.sent_by_name = nameByPmid[m.provider_message_id];
    }
  }

  // Internal notes live ONLY in our DB (Chatwoot never sees them), so merge the
  // local notes back into the live pull — otherwise notes added on a WA thread
  // vanish on the next re-pull.
  const notesRes = await sb(
    `/rest/v1/cs_wa_messages?thread_id=eq.${encodeURIComponent(thread.id)}&is_internal=eq.true&select=*&order=created_at.asc&limit=200`,
    env,
  );
  const tsOf = (m) => new Date(m.received_at || m.sent_at || m.created_at || 0).getTime();
  const messages = [...live.messages, ...(notesRes.data || [])].sort((a, b) => tsOf(a) - tsOf(b));

  return ok({
    messages,
    within_customer_window: live.window.open,
    window_until: live.window.until,
    live: true,
  });
}

// Replying to a customer = taking ownership: assign the thread's linked ticket to
// the replying agent (overwrite if it was someone else's; no-op if already theirs).
// Shared by sendWaReply + sendMetaMessage. Best-effort — never blocks the send.
async function assignLinkedTicketToReplier(threadId, auth, env) {
  try {
    const r = await sb(
      `/rest/v1/cs_wa_messages?thread_id=eq.${encodeURIComponent(threadId)}&ticket_id=not.is.null&select=ticket_id&order=created_at.desc&limit=1`,
      env,
    );
    const ticketId = r.data?.[0]?.ticket_id;
    if (!ticketId) return null;
    const tRes = await sb(`/rest/v1/cs_tickets?id=eq.${ticketId}&select=assigned_agent_id&limit=1`, env);
    const t = tRes.data?.[0];
    if (!t || t.assigned_agent_id === auth.userId) return ticketId;   // none / already ours
    const name = auth.fullName || auth.name || auth.email || null;
    await sb(`/rest/v1/cs_tickets?id=eq.${ticketId}`, env, {
      method: 'PATCH', body: JSON.stringify({ assigned_agent_id: auth.userId, assigned_agent_name: name }),
    });
    await insertHistory(ticketId, 'assigned_agent_id', t.assigned_agent_id, auth.userId, 'auto-assigned on reply', auth, env);
    return ticketId;
  } catch (_) { return null; }
}

async function sendWaReply(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { thread_id, text } = body;
  if (!thread_id || !text || !String(text).trim()) return err('thread_id and text required');
  if (!env.BITESPEED_API_TOKEN) return err('WhatsApp send not configured (no BiteSpeed API token)', 503);

  const tRes = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=*&limit=1`, env);
  const thread = tRes.data?.[0];
  if (!thread) return err('Thread not found', 404);
  // Both WhatsApp and Web are Chatwoot conversations on BiteSpeed — same send path.
  const wchan = thread.channel || 'whatsapp';
  if (wchan !== 'whatsapp' && wchan !== 'web') return err('Not a WhatsApp/Web thread — use sendMetaMessage', 422);
  if (!thread.provider_account_id || !thread.provider_thread_ref) {
    return err('Thread has no BiteSpeed conversation reference yet', 422);
  }

  // Meta utility-message-first rule (RULE-PITSTOP-013): WhatsApp allows free-text only
  // inside the 24h window, derived LIVE from the latest inbound (the local column is
  // dead — one-way webhook). Web chat has NO such 24h restriction, so skip the gate.
  if (wchan === 'whatsapp') {
    const live = await loadWaLive(thread, env);
    if (!live.ok) return err(`Couldn't verify the customer window with BiteSpeed (${live.status}): ${live.error}`, 502);
    if (!live.window.open) {
      return err('Outside the 24h customer window — free-text replies are blocked until the customer messages again (templates coming soon)', 422);
    }
  }

  // Send through Chatwoot's Application API into the existing conversation. Chatwoot
  // then fires a message_created webhook → /webhooks/bitespeed, which mirrors this
  // outbound row into cs_wa_messages (deduped on the Chatwoot message id). So we do
  // NOT insert locally here; the UI re-pulls the live thread for instant display.
  const apiUrl = `${biteSpeedApiBase(env)}/api/v1/accounts/${encodeURIComponent(thread.provider_account_id)}/conversations/${encodeURIComponent(thread.provider_thread_ref)}/messages`;
  let resp, data;
  try {
    resp = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api_access_token': env.BITESPEED_API_TOKEN },
      body: JSON.stringify({ content: String(text), message_type: 'outgoing' }),
    });
    data = await resp.json().catch(() => ({}));
  } catch (e) {
    return err(`BiteSpeed send failed: ${e.message}`, 502);
  }
  if (!resp.ok) return err(`BiteSpeed send failed (${resp.status}): ${JSON.stringify(data)?.slice(0, 300)}`, resp.status);

  const now = new Date().toISOString();
  const threadPatch = { last_message_at: now };
  // Connect replies (via the Ignition bridge) must NOT auto-claim the thread into CS.
  if (!thread.assigned_agent_id && !auth.viaIgnitionBridge) {   // auto-claim on first reply (mirror sendMetaMessage)
    threadPatch.assigned_agent_id = auth.userId;
    threadPatch.assigned_agent_name = auth.fullName || auth.name || auth.email || null;
    threadPatch.assigned_at = now;
  }
  if (thread.thread_state && thread.thread_state !== 'open') threadPatch.thread_state = 'open';
  await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, { method: 'PATCH', body: JSON.stringify(threadPatch) }).catch(() => {});

  const ticketId = auth.viaIgnitionBridge ? null : await assignLinkedTicketToReplier(thread.id, auth, env);
  return ok({ sent: true, message_id: data?.id != null ? String(data.id) : null, auto_claimed: !thread.assigned_agent_id && !auth.viaIgnitionBridge, ticket_assigned: ticketId });
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

// BiteSpeed/Chatwoot inbox id — the hard channel discriminator. Present on 100%
// of genuine BiteSpeed payloads (mirrored at conversation.inbox_id); channel_type
// is never sent. Known inboxes (confirmed from captured payloads, S182):
//   7625 "WA Support"    → WhatsApp CS (BiteSpeed IS our WA provider — KEEP)
//   7682 "WA Marketing"  → outbound campaign blasts — DROP (S182, not CS; Relay owns marcomms)
//   8001 "Email"         → carecrew@ — duplicate of the native Gmail channel (S178) — DROP
//   8114 "FB/IG Dms"     → duplicate of native Meta DM capture (S161) — DROP
//   7721 "L.O.T Web"     → website chat widget → channel='web' (its own Pitstop section, S182)
function bitespeedInboxId(body) {
  const id = body?.inbox?.id ?? body?.conversation?.inbox_id ?? body?.conversation?.inbox?.id ?? null;
  return id != null ? String(id) : null;
}

// Off-ramp (S182): silently drop the BiteSpeed inboxes that don't belong in the CS
// inbox — Email + FB/IG (duplicate native channels) and WA Marketing (outbound
// campaign blasts; CS has nothing to do with marcomms, Relay owns that). We still
// 200-ack every webhook (no retry storm, no signal to BiteSpeed we're off-ramping).
// Denylist: WA Support (7625) + the web widget (7721) + any other inbox keep flowing.
const BITESPEED_DROP_INBOX_IDS = new Set(['8001', '8114', '7682']);

// Explicit BiteSpeed inbox-id → our channel enum (authoritative; channel_type is never
// sent and inbox.name is a soft label). 7721 "L.O.T Web" → 'web' (its own inbox section,
// pulled from BiteSpeed like WhatsApp). Unmapped kept inboxes fall through to name/default.
const BITESPEED_INBOX_CHANNEL = { '7625': 'whatsapp', '7721': 'web' };

// Chatwoot inbox.channel_type (Ruby class name) → our channel enum.
// BiteSpeed omits channel_type but sends inbox.name — fall back to it.
function chatwootChannelFromPayload(body) {
  // Authoritative: explicit inbox-id → channel map (e.g. 7721 "L.O.T Web" → web).
  const inboxId = bitespeedInboxId(body);
  if (inboxId && BITESPEED_INBOX_CHANNEL[inboxId]) return BITESPEED_INBOX_CHANNEL[inboxId];

  const ct = (
    body?.inbox?.channel_type ||
    body?.conversation?.inbox?.channel_type ||
    ''
  ).toLowerCase();
  if (ct.includes('instagram')) return 'instagram';
  if (ct.includes('messenger') || ct.includes('facebook')) return 'messenger';
  if (ct.includes('email')) return 'email';
  if (ct) return 'whatsapp';

  // channel_type absent — use inbox.name (BiteSpeed sends this, not channel_type)
  const name = (
    body?.inbox?.name ||
    body?.conversation?.inbox?.name ||
    ''
  ).toLowerCase();
  if (name.includes('ig') || name.includes('instagram')) return 'instagram';
  if (name.includes('fb') || name.includes('facebook') || name.includes('messenger')) return 'messenger';
  if (name.includes('email')) return 'email';
  return 'whatsapp';
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

  // Off-ramp (S182): drop inboxes that now have a native Pitstop channel (Email,
  // FB/IG) so they stop duplicating into the CS inbox. Ack 200 + persist nothing.
  const inboxId = bitespeedInboxId(body);
  if (inboxId && BITESPEED_DROP_INBOX_IDS.has(inboxId)) {
    return json({ ok: true, dropped: `inbox_${inboxId}` });
  }

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
// `create:false` makes it find-only (returns {thread:null} instead of inserting) — used
// by conversation lifecycle events, which must NOT spawn message-less phantom threads.
async function biteSpeedFindOrCreateThread(payload, env, { create = true } = {}) {
  const conv = payload?.conversation || (payload?.event === 'conversation_created' ? payload : null) || payload;
  const convId = conv?.id ?? payload?.id ?? null;
  const phoneRaw = extractPhoneFromChatwoot(payload);
  // Capture Chatwoot account_id so deep-links from Pitstop UI can target the
  // exact conversation: chat.bitespeed.co/app/accounts/<id>/conversations/<conv>
  const accountId = (payload?.account?.id ?? payload?.conversation?.account_id ?? payload?.inbox?.account_id ?? null);
  const accountIdStr = accountId != null ? String(accountId) : null;
  const channel = chatwootChannelFromPayload(payload);
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
      // Backfill provider_account_id and channel if we now know them and the thread didn't
      const patch = {};
      if (accountIdStr && byRef.data[0].provider_account_id !== accountIdStr) patch.provider_account_id = accountIdStr;
      if ((byRef.data[0].channel || 'whatsapp') === 'whatsapp' && channel !== 'whatsapp') patch.channel = channel;
      if (Object.keys(patch).length) {
        await sb(`/rest/v1/cs_wa_threads?id=eq.${byRef.data[0].id}`, env, {
          method: 'PATCH', body: JSON.stringify(patch),
        }).catch(() => {});
        Object.assign(byRef.data[0], patch);
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


  // Find-only mode (conversation lifecycle events): no existing thread → don't create.
  if (!create) return { thread: null, reason: 'not_found_no_create' };

  // No existing thread — create one
  const ins = await sb(`/rest/v1/cs_wa_threads`, env, {
    method: 'POST',
    body: JSON.stringify({
      customer_phone: phone,
      provider_thread_ref: convId != null ? String(convId) : null,
      provider_account_id: accountIdStr,
      channel,
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
  // FIND-ONLY (S185): conversation lifecycle events (created/updated/status_changed) carry
  // no customer message, so creating a thread here spawned ~84 message-less "phantom" threads
  // per day (empty, often null provider_account_id → un-backfillable) that cluttered the inbox
  // + inflated unassigned counts. Threads are now created ONLY by a real message_created. We
  // still bump an EXISTING thread's sort timestamp; if no thread exists yet, do nothing.
  let { thread } = await biteSpeedFindOrCreateThread(body, env, { create: false });
  if (!thread) return json({ ok: true, skipped: 'no_thread_conv_event' });
  thread = await maybeBackfillPhoneAndLinkTickets(thread, body, env);
  await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, {
    method: 'PATCH',
    body: JSON.stringify({ last_message_at: new Date().toISOString() }),
  });
  return json({ ok: true, thread_id: thread.id, phone_backfilled: !!thread.customer_phone });
}

async function biteSpeedMessageCreated(body, env) {
  // Chatwoot wraps the message at the top level for message_created.
  // Chatwoot sends message_type as EITHER an int (0=in,1=out,2=activity,3=template)
  // OR a string ("incoming"/"outgoing"/"activity"/"template"). Normalise BOTH —
  // Number("incoming") is NaN, so the old `Number(mt)===0` test silently mislabelled
  // every string-typed inbound message as outbound (it rendered on the agent's side).
  const messageType = body?.message_type;
  const mtStr = String(messageType).toLowerCase();
  const isActivity = messageType === 2 || mtStr === '2' || mtStr === 'activity';
  const isIncoming = messageType === 0 || mtStr === '0' || mtStr === 'incoming';
  const isTemplate = messageType === 3 || mtStr === '3' || mtStr === 'template';
  if (isActivity) {
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

  // Resolve direction (string- and int-safe; see message_type note above)
  const direction = isIncoming ? 'inbound' : 'outbound';

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
  } else if (isTemplate) {
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
  if (isTemplate) {
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
    // Reopen a closed/snoozed thread when the customer messages again (standard helpdesk
    // behaviour). Also makes the empty-phantom cleanup safe — any real message resurfaces
    // a previously-closed thread into the active inbox. (S185)
    if (thread.thread_state && thread.thread_state !== 'open') threadPatch.thread_state = 'open';
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
  if (direction === 'inbound') {
    patch.customer_window_until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    // Auto-reopen (Q1=B work-queue): any inbound makes the conversation active again,
    // clearing a prior Done/Snooze. The prior assignee (if any) is kept for continuity.
    if (thread.thread_state && thread.thread_state !== 'open') {
      patch.thread_state = 'open';
      patch.closed_at = null;
      patch.closed_by_user_id = null;
      patch.snoozed_until = null;
    }
  }
  await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, { method: 'PATCH', body: JSON.stringify(patch) }).catch(() => {});

  // Round-robin: auto-assign an unassigned inbound thread to the least-loaded eligible
  // agent. Config-gated per channel inside the RPC (WhatsApp seeded off). Best-effort.
  // Skip Ignition-transferred threads (S177) — they belong to the Influencer team now.
  if (direction === 'inbound' && !thread.assigned_agent_id && !thread.ignition_connect) {
    await sb(`/rest/v1/rpc/cs_autoassign_thread`, env, {
      method: 'POST', body: JSON.stringify({ p_thread_id: thread.id }),
    }).catch(() => {});
  }
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
  if (!thread.assigned_agent_id && !auth.viaIgnitionBridge) {   // auto-claim on first reply (D4, S162); skip for Connect replies
    threadPatch.assigned_agent_id = auth.userId;
    threadPatch.assigned_agent_name = auth.fullName || auth.name || auth.email || null;
    threadPatch.assigned_at = new Date().toISOString();
  }
  await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, { method: 'PATCH', body: JSON.stringify(threadPatch) }).catch(() => {});
  const ticketId = auth.viaIgnitionBridge ? null : await assignLinkedTicketToReplier(thread.id, auth, env);
  return ok({ sent: true, message_id: mid, auto_claimed: !thread.assigned_agent_id && !auth.viaIgnitionBridge, ticket_assigned: ticketId });
}

// ── Outbound media attachments (S162, Feature C) ─────────────────────────────
// Agents send instructional images ("do it like this") to IG/FB customers. Meta's
// send API needs a PUBLIC URL (IG has no multipart path), so we host on the public
// bucket cs-inbox-media (service_role upload) then pass the URL to Graph. Low-volume,
// outbound, agent-initiated, non-sensitive → public-read is fine.
const ATTACH_MIME = {
  'image/png':       { ext: 'png',  kind: 'image',    graph: 'image' },
  'image/jpeg':      { ext: 'jpg',  kind: 'image',    graph: 'image' },
  'image/webp':      { ext: 'webp', kind: 'image',    graph: 'image' },
  'image/gif':       { ext: 'gif',  kind: 'image',    graph: 'image' },
  'application/pdf': { ext: 'pdf',  kind: 'document', graph: 'file'  },
};
const ATTACH_MAX_BYTES = 8 * 1024 * 1024;

function b64ToBytes(b64) {
  const bin = atob(b64.includes(',') ? b64.split(',')[1] : b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ── Email attachments (S201) — real MIME attachment parts on the Gmail send, not a
// URL (unlike the Meta path). Broader allowlist than Meta (agents send invoices,
// labels, spreadsheets). Caps keep the request under Gmail's 25MB and the Worker's
// ~128MB memory budget (base64 inflates + is re-encoded for the raw send).
const EMAIL_ATTACH_MIME = {
  'application/pdf': 'pdf',
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'application/zip': 'zip',
};
const EMAIL_ATTACH_MAX_PER_FILE = 10 * 1024 * 1024;   // 10MB per file
const EMAIL_ATTACH_MAX_TOTAL    = 15 * 1024 * 1024;   // 15MB total (Gmail hard cap 25MB; kept low for Worker memory)
const EMAIL_ATTACH_MAX_COUNT    = 10;                 // subrequest-budget guard (one upload each)

// bytes -> standard base64 (NOT base64url), CRLF-wrapped at 76 cols per RFC 2045.
function bytesToB64Wrapped(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/(.{76})/g, '$1\r\n');
}
// A Content-Disposition-safe filename: strip CR/LF/quotes/backslash; RFC 2047
// encoded-word for any non-ASCII so mail clients render it correctly.
function mimeFilename(name) {
  const clean = String(name || 'attachment').replace(/[\r\n"\\]/g, '_').slice(0, 200);
  if (/^[\x20-\x7E]+$/.test(clean)) return clean;
  const bytes = new TextEncoder().encode(clean);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `=?UTF-8?B?${btoa(bin)}?=`;
}

async function sendMetaAttachment(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { thread_id, mime_type, data_base64, filename, caption } = body;
  if (!thread_id || !mime_type || !data_base64) return err('thread_id, mime_type and data_base64 required');
  const spec = ATTACH_MIME[mime_type];
  if (!spec) return err(`Unsupported file type: ${mime_type} (images + PDF only)`, 415);

  let bytes;
  try { bytes = b64ToBytes(data_base64); } catch { return err('Invalid file data'); }
  if (!bytes.length) return err('Empty file');
  if (bytes.length > ATTACH_MAX_BYTES) return err('File too large (max 8MB)', 413);

  const tRes = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=*&limit=1`, env);
  const thread = tRes.data?.[0];
  if (!thread || !thread.external_user_id) return err('Thread not found or has no recipient', 404);
  const token = metaToken(thread.channel, env);
  if (!token) return err('Meta send not configured (no token for this channel)', 503);

  // 1. Upload to the public bucket (service_role, bypasses RLS).
  const path = `${thread.id}/${crypto.randomUUID()}.${spec.ext}`;
  const up = await fetch(`${env.SUPABASE_URL}/storage/v1/object/cs-inbox-media/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': mime_type, 'x-upsert': 'true' },
    body: bytes,
  });
  if (!up.ok) { const t = await up.text().catch(() => ''); return err(`Upload failed: ${t.slice(0, 200)}`, up.status || 500); }
  const publicUrl = `${env.SUPABASE_URL}/storage/v1/object/public/cs-inbox-media/${path}`;

  // 2. Send via Graph (URL attachment — the IG+FB common path).
  const withinWindow = thread.customer_window_until && new Date(thread.customer_window_until).getTime() > Date.now();
  const tagFields = withinWindow ? { messaging_type: 'RESPONSE' } : { messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' };
  const r = await fetch(`${metaGraphBase(thread.channel)}/me/messages?access_token=${token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: thread.external_user_id },
      message: { attachment: { type: spec.graph, payload: { url: publicUrl, is_reusable: true } } },
      ...tagFields,
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return err(`Meta send failed: ${JSON.stringify(d?.error || d)}`, r.status);
  const mid = d?.message_id || null;

  const senderName = auth.fullName || auth.name || auth.email || null;
  await sb(`/rest/v1/cs_wa_messages`, env, {
    method: 'POST',
    body: JSON.stringify({
      thread_id: thread.id, channel: thread.channel, direction: 'outbound', kind: spec.kind,
      body: null, media_url: publicUrl, media_filename: filename || `attachment.${spec.ext}`,
      media_mime_type: mime_type, media_size_bytes: bytes.length,
      provider_message_id: mid, status: 'sent', sent_by_user_id: auth.userId, sent_by_name: senderName,
      sent_at: new Date().toISOString(),
    }),
  });

  // 3. Optional caption — delivered as a separate text message (Graph attachments
  // carry no caption field), best-effort + recorded as its own row.
  if (caption && caption.trim()) {
    const cr = await fetch(`${metaGraphBase(thread.channel)}/me/messages?access_token=${token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: thread.external_user_id }, message: { text: caption.trim() }, ...tagFields }),
    });
    const cd = await cr.json().catch(() => ({}));
    if (cr.ok) {
      await sb(`/rest/v1/cs_wa_messages`, env, {
        method: 'POST',
        body: JSON.stringify({
          thread_id: thread.id, channel: thread.channel, direction: 'outbound', kind: 'text',
          body: caption.trim(), provider_message_id: cd?.message_id || null, status: 'sent',
          sent_by_user_id: auth.userId, sent_by_name: senderName, sent_at: new Date().toISOString(),
        }),
      });
    }
  }

  const threadPatch = { last_message_at: new Date().toISOString() };
  if (!thread.assigned_agent_id) {
    threadPatch.assigned_agent_id = auth.userId;
    threadPatch.assigned_agent_name = senderName;
    threadPatch.assigned_at = new Date().toISOString();
  }
  await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, { method: 'PATCH', body: JSON.stringify(threadPatch) }).catch(() => {});
  return ok({ sent: true, message_id: mid, media_url: publicUrl });
}

// ═════════════════════════════════════════════════════════════════════════════
// EMAIL CHANNEL (carecrew@) — inbound + reply via the Gmail API (S175)
// ─────────────────────────────────────────────────────────────────────────────
// Email is just another channel on cs_wa_threads/cs_wa_messages (channel='email'),
// so it inherits the inbox/routing/presence/tags/priority machinery for free.
//   • thread key  = Gmail threadId        → provider_thread_ref (partial-unique)
//   • message key = Gmail message id       → provider_message_id (global-unique → idempotency)
//   • sender email = external_user_id ; sender name = customer_handle
//   • text body = body ; html = body_html ; RFC headers + addrs = raw_meta
// Identity is resolved through the LIVE Relay substrate (commsops POST /ingest →
// comms.resolve_identity) and the returned profile_id is stored on the thread.
// Replies go out Gmail-native (real carecrew@, perfect threading) and are mirrored
// to Relay as an `email_replied` event. See spec 2026-06-25-pitstop-inbound-email-design.md.
// ═════════════════════════════════════════════════════════════════════════════

function commsopsUrl(env) { return env.COMMSOPS_URL || 'https://commsops.afshaan.workers.dev'; }
function gmailMailbox(env) { return env.GMAIL_MAILBOX || 'carecrew@legendoftoys.com'; }
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
const MAX_NEW_EMAILS_PER_RUN = 6;             // subrequest budget (≤50/invocation) — backlog drains across cron ticks

// base64url <-> bytes/strings ------------------------------------------------
function b64urlToBytes(data) {
  const b64 = String(data || '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function b64urlDecodeUtf8(data) {
  try { return new TextDecoder('utf-8').decode(b64urlToBytes(data)); } catch { return ''; }
}
function b64urlEncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlEncodeJson(obj) { return b64urlEncodeUtf8(JSON.stringify(obj)); }

// ── Gmail OAuth — service-account JWT (RS256), domain-wide-delegated to carecrew@.
// Reuses the shared GOOGLE_SA_JSON secret (the full SA key JSON, same convention as
// odoops/podiumops). That SA already has gmail.modify domain-wide-delegated.
let _gmailTok = { token: null, exp: 0 };
function gmailConfigured(env) { return !!env.GOOGLE_SA_JSON; }
async function gmailAccessToken(env) {
  if (_gmailTok.token && Date.now() < _gmailTok.exp - 60_000) return _gmailTok.token;
  if (!env.GOOGLE_SA_JSON) throw new Error('gmail_not_configured');
  const sa = JSON.parse(env.GOOGLE_SA_JSON);
  const clientEmail = sa.client_email;
  const pk = sa.private_key;                                  // PEM, already with real newlines
  if (!clientEmail || !pk) throw new Error('gmail_not_configured');

  const iat = Math.floor(Date.now() / 1000);
  const claim = {
    iss: clientEmail,
    sub: gmailMailbox(env),                                   // impersonate the mailbox
    scope: 'https://www.googleapis.com/auth/gmail.modify',
    aud: 'https://oauth2.googleapis.com/token',
    iat, exp: iat + 3600,
  };
  const signingInput = `${b64urlEncodeJson({ alg: 'RS256', typ: 'JWT' })}.${b64urlEncodeJson(claim)}`;

  const der = pk.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s/g, '');
  const keyBytes = Uint8Array.from(atob(der), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'pkcs8', keyBytes.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  let sigBin = '';
  const sigBytes = new Uint8Array(sigBuf);
  for (let i = 0; i < sigBytes.length; i++) sigBin += String.fromCharCode(sigBytes[i]);
  const assertion = `${signingInput}.${btoa(sigBin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(assertion)}`,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(`gmail_token_failed: ${JSON.stringify(d).slice(0, 200)}`);
  _gmailTok = { token: d.access_token, exp: Date.now() + (Number(d.expires_in || 3600) * 1000) };
  return _gmailTok.token;
}

async function gmailFetch(env, path, opts = {}) {
  const token = await gmailAccessToken(env);
  const mb = encodeURIComponent(gmailMailbox(env));
  const r = await fetch(`${GMAIL_API}/users/${mb}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: r.ok, status: r.status, data };
}

// ── MIME parse — walk a Gmail message payload into our fields -----------------
function hdr(headers, name) {
  const h = (headers || []).find(x => (x.name || '').toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}
function parseAddress(raw) {
  if (!raw) return { name: null, email: null };
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: (m[1] || '').trim() || null, email: m[2].trim().toLowerCase() };
  return { name: null, email: raw.trim().toLowerCase() };
}
function collectBodies(payload, acc) {
  if (!payload) return acc;
  const mime = (payload.mimeType || '').toLowerCase();
  if (payload.body?.data) {
    if (mime === 'text/plain' && acc.text == null) acc.text = b64urlDecodeUtf8(payload.body.data);
    else if (mime === 'text/html' && acc.html == null) acc.html = b64urlDecodeUtf8(payload.body.data);
  }
  if (payload.filename && payload.body?.attachmentId) {
    acc.attachments.push({ filename: payload.filename, mime: payload.mimeType, size: payload.body.size, attachment_id: payload.body.attachmentId });
  }
  for (const part of (payload.parts || [])) collectBodies(part, acc);
  return acc;
}
function parseGmailMessage(msg) {
  const headers = msg.payload?.headers || [];
  const from = parseAddress(hdr(headers, 'From'));
  const bodies = collectBodies(msg.payload, { text: null, html: null, attachments: [] });
  return {
    gmail_message_id: msg.id,
    gmail_thread_id: msg.threadId,
    rfc_message_id: hdr(headers, 'Message-ID') || hdr(headers, 'Message-Id'),
    in_reply_to: hdr(headers, 'In-Reply-To'),
    references: hdr(headers, 'References'),
    subject: hdr(headers, 'Subject') || '(no subject)',
    from_name: from.name,
    from_email: from.email,
    to: hdr(headers, 'To'),
    date: hdr(headers, 'Date'),
    snippet: msg.snippet || null,
    text: bodies.text,
    html: bodies.html,
    attachments: bodies.attachments,
    internal_date: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : new Date().toISOString(),
    label_ids: msg.labelIds || [],
  };
}

// ── Relay seams (commsops) — identity/events + suppression read ---------------
async function relayIngest(env, payload) {
  if (!env.INGEST_TOKEN) return { ok: false, skipped: 'no_ingest_token' };
  try {
    const r = await fetch(`${commsopsUrl(env)}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.INGEST_TOKEN}` },
      body: JSON.stringify(payload),
    });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok, data: d?.data || d };
  } catch (e) { console.error('[email] relayIngest error', e); return { ok: false }; }
}
// Hard-suppression check for an email (comms schema, direct service_role read).
// Returns { suppressed:boolean, reason } — fails OPEN (allows the support reply)
// on any infra error, since a CS reply is transactional. Only blocks on a real
// hard suppression row (bounce/complaint) for the email channel.
async function emailSuppressed(env, emailAddr) {
  if (!emailAddr) return { suppressed: false };
  try {
    const r = await fetch(
      `${env.SUPABASE_URL}/rest/v1/suppressions?channel=eq.email&value=eq.${encodeURIComponent(emailAddr.toLowerCase())}&select=reason&limit=1`,
      { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Accept-Profile': 'comms' } });
    if (!r.ok) return { suppressed: false };
    const d = await r.json().catch(() => []);
    if (Array.isArray(d) && d[0]) return { suppressed: true, reason: d[0].reason || 'suppressed' };
    return { suppressed: false };
  } catch { return { suppressed: false }; }
}

// ── Inbound sync — poll the carecrew@ mailbox, ingest new messages ------------
// Stateless + idempotent: list recent INBOX messages, skip any whose Gmail id is
// already stored (one batched check), fetch+parse+store only the new ones (capped
// per run; cron drains the backlog). Callable via cron (scheduled) or syncGmailNow.
async function syncGmail(env, { lookbackDays = 2 } = {}) {
  const list = await gmailFetch(env, `/messages?q=${encodeURIComponent(`in:inbox newer_than:${lookbackDays}d`)}&maxResults=25`);
  if (!list.ok) return { ok: false, error: `list_failed_${list.status}`, detail: list.data };
  const ids = (list.data?.messages || []).map(m => m.id);
  if (!ids.length) return { ok: true, fetched: 0, new: 0 };

  // Which Gmail ids are already stored? (provider_message_id = Gmail message id)
  const existRes = await sb(
    `/rest/v1/cs_wa_messages?channel=eq.email&provider_message_id=in.(${ids.map(encodeURIComponent).join(',')})&select=provider_message_id`, env);
  const have = new Set((existRes.data || []).map(x => x.provider_message_id));
  const fresh = ids.filter(id => !have.has(id)).slice(0, MAX_NEW_EMAILS_PER_RUN);
  if (!fresh.length) return { ok: true, fetched: ids.length, new: 0 };

  let created = 0;
  for (const id of fresh) {
    try {
      const gm = await gmailFetch(env, `/messages/${encodeURIComponent(id)}?format=full`);
      if (!gm.ok) { console.error('[email] get failed', id, gm.status); continue; }
      const parsed = parseGmailMessage(gm.data);
      const ok2 = await ingestInboundEmail(env, parsed);
      if (ok2) created++;
    } catch (e) { console.error('[email] sync msg error', id, e); }
  }
  return { ok: true, fetched: ids.length, new: created };
}

// Persist one inbound email: resolve profile via Relay, upsert thread, insert
// message, auto-reopen + round-robin assign. Mirrors metaHandleMessage.
async function ingestInboundEmail(env, p) {
  if (!p.from_email) return false;

  // 1. Identity via the Relay substrate (best-effort).
  let profileId = null;
  const ing = await relayIngest(env, {
    identifiers: [{ type: 'email', value: p.from_email }],
    name: 'email_received',
    occurred_at: p.internal_date,
    properties: { subject: p.subject, gmail_thread_id: p.gmail_thread_id, snippet: p.snippet },
    source: 'pitstop_email',
    idempotency_key: `gmail:${p.gmail_message_id}`,
  });
  if (ing.ok && ing.data?.profile_id) profileId = ing.data.profile_id;

  // 2. Find the thread. Primary key = Gmail threadId — true reply chains group here.
  const found = await sb(
    `/rest/v1/cs_wa_threads?channel=eq.email&provider_thread_ref=eq.${encodeURIComponent(p.gmail_thread_id)}&select=*&limit=1`, env);
  let thread = found.data?.[0];

  // Customer-window grouping (Pruthvi S185): a customer often sends a NEW email (not a
  // reply) about the same issue → a different Gmail threadId. Fold it into the customer's
  // existing ACTIVE email conversation if that had activity within the last 7 days, so
  // agents see one thread instead of many. Replies still target the customer's latest
  // inbound Gmail thread (see sendEmailReply), so outbound still lands correctly. Outside
  // the 7-day window, or no active thread → a fresh conversation.
  if (!thread && p.from_email) {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recent = await sb(
      `/rest/v1/cs_wa_threads?channel=eq.email&ignition_connect=is.false&external_user_id=eq.${encodeURIComponent(p.from_email)}&thread_state=in.(open,snoozed)&last_message_at=gte.${encodeURIComponent(since)}&order=last_message_at.desc&select=*&limit=1`, env);
    thread = recent.data?.[0] || null;
  }

  if (!thread) {
    const ins = await sb(`/rest/v1/cs_wa_threads`, env, {
      method: 'POST',
      body: JSON.stringify({
        channel: 'email', provider_thread_ref: p.gmail_thread_id,
        external_user_id: p.from_email, customer_handle: p.from_name || p.from_email,
        subject: p.subject, comms_profile_id: profileId,
      }),
    });
    if (!ins.ok) { console.error('[email] thread insert failed', ins.status, JSON.stringify(ins.data)?.slice(0, 200)); return false; }
    thread = ins.data?.[0];
  }
  if (!thread) return false;

  // 3. Insert the inbound message (idempotent via provider_message_id unique).
  const ins = await sb(`/rest/v1/cs_wa_messages`, env, {
    method: 'POST', prefer: 'resolution=ignore-duplicates,return=representation',
    body: JSON.stringify({
      thread_id: thread.id, channel: 'email', direction: 'inbound', kind: 'text',
      body: p.text || (p.html ? null : p.snippet), body_html: p.html,
      provider_message_id: p.gmail_message_id, received_at: p.internal_date,
      raw_meta: {
        gmail_message_id: p.gmail_message_id, gmail_thread_id: p.gmail_thread_id,
        rfc_message_id: p.rfc_message_id, in_reply_to: p.in_reply_to, references: p.references,
        from_name: p.from_name, from_email: p.from_email, to: p.to, subject: p.subject,
        date: p.date, attachments: p.attachments,
      },
    }),
  });
  if (!ins.ok) { console.error('[email] message insert failed', ins.status, JSON.stringify(ins.data)?.slice(0, 200)); return false; }

  // 4. Thread housekeeping: bump activity, backfill profile/subject, auto-reopen.
  const patch = { last_message_at: p.internal_date };
  if (!thread.comms_profile_id && profileId) patch.comms_profile_id = profileId;
  if (!thread.subject && p.subject) patch.subject = p.subject;
  if (thread.thread_state && thread.thread_state !== 'open') {
    patch.thread_state = 'open'; patch.closed_at = null; patch.closed_by_user_id = null; patch.snoozed_until = null;
  }
  await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, { method: 'PATCH', body: JSON.stringify(patch) }).catch(() => {});

  // 5. Round-robin assign an unassigned thread (config-gated per channel in the RPC).
  //    Skip Ignition-transferred threads (S177) — owned by the Influencer team now.
  if (!thread.assigned_agent_id && !thread.ignition_connect) {
    await sb(`/rest/v1/rpc/cs_autoassign_thread`, env, { method: 'POST', body: JSON.stringify({ p_thread_id: thread.id }) }).catch(() => {});
  }
  return true;
}

// Manual sync trigger (admin) — runs the same poll on demand. Useful before the
// cron is armed and for a parallel-run check.
async function syncGmailNow(body, auth, env) {
  const g = require('cs_ticket_admin', auth); if (g) return g;
  try {
    const res = await syncGmail(env, { lookbackDays: Number(body?.lookbackDays) || 2 });
    return res.ok ? ok(res) : err(`Gmail sync failed: ${res.error || ''}`, 502);
  } catch (e) { return err(`Gmail sync error: ${String(e.message || e)}`, 502); }
}

// ── Reply — Gmail-native send, in-thread, mirrored to Relay -------------------
async function sendEmailReply(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { thread_id, text, html, cc, bcc, subject: subjectOverride } = body;

  // Attachments (S201) — optional array of { mime_type, data_base64, filename }.
  // Validate + decode up front so a bad file fails before we send anything.
  const attIn = Array.isArray(body.attachments) ? body.attachments : [];
  if (attIn.length > EMAIL_ATTACH_MAX_COUNT) return err(`Too many attachments (max ${EMAIL_ATTACH_MAX_COUNT})`, 413);
  const atts = [];
  let attTotal = 0;
  for (const a of attIn) {
    const mt = a?.mime_type;
    const ext = EMAIL_ATTACH_MIME[mt];
    if (!ext) return err(`Unsupported attachment type: ${mt || '(none)'}`, 415);
    let bytes;
    try { bytes = b64ToBytes(a.data_base64); } catch { return err('Invalid attachment data'); }
    if (!bytes.length) return err(`Empty attachment: ${a.filename || mt}`);
    if (bytes.length > EMAIL_ATTACH_MAX_PER_FILE) return err(`Attachment too large: ${a.filename || mt} (max 10MB per file)`, 413);
    attTotal += bytes.length;
    if (attTotal > EMAIL_ATTACH_MAX_TOTAL) return err('Attachments too large (max 15MB total)', 413);
    atts.push({ bytes, mime: mt, ext, filename: a.filename || `attachment.${ext}` });
  }

  if (!thread_id || (!text && !html && !atts.length)) return err('thread_id and text, html, or an attachment required');

  const tRes = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=*&limit=1`, env);
  const thread = tRes.data?.[0];
  if (!thread || thread.channel !== 'email') return err('Email thread not found', 404);
  if (!thread.external_user_id) return err('Thread has no recipient address', 422);

  // Recipients: To defaults to the thread's customer; the agent may override To and
  // add Cc/Bcc (Pruthvi #bugs S181). parseAddrList accepts an array OR a
  // comma/semicolon-separated string, validates "x@y", dedups (case-insensitive).
  const toList  = parseAddrList(body.to, [thread.external_user_id]);
  const ccList  = parseAddrList(cc);
  const bccList = parseAddrList(bcc);
  if (!toList.length) return err('At least one valid To recipient is required', 422);
  for (const addr of [...body.to != null ? toList : [], ...ccList, ...bccList]) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) return err(`Invalid email address: ${addr}`, 422);
  }

  // Hard-suppression guard (bounce/complaint) — surface to the agent, don't send.
  // Check every To recipient (override may point somewhere new); Cc/Bcc are not
  // gated (an agent CC'ing a colleague/vendor shouldn't be blocked by a customer
  // suppression).
  for (const addr of toList) {
    const sup = await emailSuppressed(env, addr);
    if (sup.suppressed) return err(`Recipient ${addr} is suppressed (${sup.reason}) — do not email. Reach out another way.`, 409);
  }

  // Threading headers from the latest inbound message on this thread.
  const lastIn = await sb(
    `/rest/v1/cs_wa_messages?thread_id=eq.${encodeURIComponent(thread.id)}&direction=eq.inbound&select=raw_meta,provider_message_id&order=created_at.desc&limit=1`, env);
  const lastMeta = lastIn.data?.[0]?.raw_meta || {};
  const inReplyTo = lastMeta.rfc_message_id || null;
  const references = [lastMeta.references, lastMeta.rfc_message_id].filter(Boolean).join(' ') || null;

  // Subject: an explicit override is used verbatim (agent's intent); otherwise the
  // thread/last-inbound subject, prefixed Re: if not already.
  let subject;
  if (subjectOverride != null && String(subjectOverride).trim()) {
    subject = String(subjectOverride).trim();
  } else {
    const subjectRaw = thread.subject || lastMeta.subject || '(no subject)';
    subject = /^re:/i.test(subjectRaw) ? subjectRaw : `Re: ${subjectRaw}`;
  }
  const senderName = auth.fullName || auth.name || auth.email || 'LOT Care';
  const textBody = text || stripHtml(html);
  const htmlBody = html || `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;

  // Build the RFC822 message. Gmail honours a Bcc header on a raw send (delivers to
  // those recipients, strips the header from the stored msg). The body is always a
  // multipart/alternative (text + html); with attachments it's nested inside a
  // multipart/mixed alongside one attachment part per file (S201).
  const altB = `alt_${crypto.randomUUID().replace(/-/g, '')}`;
  const headerLines = [
    `To: ${toList.join(', ')}`,
  ];
  if (ccList.length)  headerLines.push(`Cc: ${ccList.join(', ')}`);
  if (bccList.length) headerLines.push(`Bcc: ${bccList.join(', ')}`);
  headerLines.push(
    `From: LOT Care <${gmailMailbox(env)}>`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
  );
  if (inReplyTo)  headerLines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headerLines.push(`References: ${references}`);

  const altBody =
    `--${altB}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${textBody}\r\n\r\n` +
    `--${altB}\r\nContent-Type: text/html; charset="UTF-8"\r\n\r\n${htmlBody}\r\n\r\n` +
    `--${altB}--`;

  let raw;
  if (atts.length) {
    const mixB = `mix_${crypto.randomUUID().replace(/-/g, '')}`;
    headerLines.push(`Content-Type: multipart/mixed; boundary="${mixB}"`);
    const attParts = atts.map(a =>
      `--${mixB}\r\n` +
      `Content-Type: ${a.mime}; name="${mimeFilename(a.filename)}"\r\n` +
      `Content-Disposition: attachment; filename="${mimeFilename(a.filename)}"\r\n` +
      `Content-Transfer-Encoding: base64\r\n\r\n` +
      `${bytesToB64Wrapped(a.bytes)}\r\n`
    ).join('');
    raw =
      headerLines.join('\r\n') + '\r\n\r\n' +
      `--${mixB}\r\nContent-Type: multipart/alternative; boundary="${altB}"\r\n\r\n` +
      altBody + '\r\n' +
      attParts +
      `--${mixB}--`;
  } else {
    headerLines.push(`Content-Type: multipart/alternative; boundary="${altB}"`);
    raw = headerLines.join('\r\n') + '\r\n\r\n' + altBody;
  }

  // Send into the customer's LATEST inbound Gmail thread (not necessarily the thread's
  // original ref) so a reply lands in their most recent email — required now that a
  // conversation may group multiple Gmail threads via customer-window grouping (S185).
  // The In-Reply-To/References above (from the same latest inbound) keep RFC threading aligned.
  const send = await gmailFetch(env, `/messages/send`, {
    method: 'POST', body: JSON.stringify({ raw: b64urlEncodeUtf8(raw), threadId: lastMeta.gmail_thread_id || thread.provider_thread_ref }),
  });
  if (!send.ok) return err(`Gmail send failed: ${JSON.stringify(send.data)?.slice(0, 200)}`, send.status || 502);
  const sentId = send.data?.id || null;

  // The customer already has the real attachments (inline in the sent email). Host a
  // copy of each on the public bucket so the sent bubble can show/download them too
  // (best-effort — a failed upload just leaves that attachment with a null url).
  const attMeta = [];
  for (const a of atts) {
    let url = null;
    try {
      const path = `${thread.id}/${crypto.randomUUID()}.${a.ext}`;
      const up = await fetch(`${env.SUPABASE_URL}/storage/v1/object/cs-inbox-media/${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': a.mime, 'x-upsert': 'true' },
        body: a.bytes,
      });
      if (up.ok) url = `${env.SUPABASE_URL}/storage/v1/object/public/cs-inbox-media/${path}`;
      else console.error('[email] attachment upload failed', up.status);
    } catch (e) { console.error('[email] attachment upload error', String(e?.message || e)); }
    attMeta.push({ filename: a.filename, mime: a.mime, size: a.bytes.length, url });
  }
  const primary = attMeta.find(m => m.mime.startsWith('image/') && m.url) || attMeta.find(m => m.url) || attMeta[0];
  const kind = atts.length ? (atts.length === 1 && atts[0].mime.startsWith('image/') ? 'image' : 'document') : 'text';

  // Record the outbound message (idempotent on the Gmail message id).
  await sb(`/rest/v1/cs_wa_messages`, env, {
    method: 'POST',
    body: JSON.stringify({
      thread_id: thread.id, channel: 'email', direction: 'outbound', kind,
      body: textBody, body_html: htmlBody, provider_message_id: sentId, status: 'sent',
      sent_by_user_id: auth.userId, sent_by_name: senderName, sent_at: new Date().toISOString(),
      ...(attMeta.length ? {
        media_url: primary?.url || null, media_filename: primary?.filename || null,
        media_mime_type: primary?.mime || null, media_size_bytes: primary?.size || null,
      } : {}),
      raw_meta: {
        gmail_message_id: sentId, in_reply_to: inReplyTo, subject,
        to: toList, ...(ccList.length ? { cc: ccList } : {}), ...(bccList.length ? { bcc: bccList } : {}),
        ...(attMeta.length ? { attachments: attMeta } : {}),
      },
    }),
  });

  // Thread housekeeping: bump activity + auto-claim on first reply.
  const threadPatch = { last_message_at: new Date().toISOString() };
  if (!thread.assigned_agent_id && !auth.viaIgnitionBridge) {   // skip auto-claim for Connect replies (S177)
    threadPatch.assigned_agent_id = auth.userId;
    threadPatch.assigned_agent_name = senderName;
    threadPatch.assigned_at = new Date().toISOString();
  }
  await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, { method: 'PATCH', body: JSON.stringify(threadPatch) }).catch(() => {});

  // Mirror the interaction to the Relay substrate (best-effort).
  await relayIngest(env, {
    identifiers: [{ type: 'email', value: thread.external_user_id }],
    name: 'email_replied', occurred_at: new Date().toISOString(),
    properties: { thread_id: thread.id, channel: 'email', subject },
    source: 'pitstop_email', idempotency_key: sentId ? `gmail_out:${sentId}` : undefined,
  });

  const ticketId = auth.viaIgnitionBridge ? null : await assignLinkedTicketToReplier(thread.id, auth, env);
  return ok({ sent: true, message_id: sentId, attachments: attMeta.length, auto_claimed: !thread.assigned_agent_id && !auth.viaIgnitionBridge, ticket_assigned: ticketId });
}

// Normalize an address input (array OR comma/semicolon-separated string) → a
// deduped (case-insensitive) trimmed list. `fallback` is used when the input is
// empty/absent. Validation of the "x@y" shape is done by the caller.
function parseAddrList(input, fallback = []) {
  if (input == null || input === '') return [...fallback];
  const arr = Array.isArray(input) ? input : String(input).split(/[,;]/);
  const out = [], seen = new Set();
  for (const raw of arr) {
    const a = String(raw || '').trim();
    if (!a) continue;
    const k = a.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); out.push(a);
  }
  return out.length ? out : [...fallback];
}

function stripHtml(h) { return String(h || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function escapeHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ── Agent Inbox — cross-channel thread list + reader + ticket link ───────────
// Surfaces every cs_wa_threads conversation (whatsapp/instagram/messenger/email)
// for the Pitstop /inbox. Read-gated by handleGet's cs_ticket_view; replies go
// through sendMetaMessage (IG/FB) / sendEmailReply (email), gated cs_ticket_manage.
// WhatsApp stays read-only (BiteSpeed deep-link) until C2-B.
async function getMessagingThreads(params, auth, env) {
  const channel = params.get('channel');
  const tab = params.get('tab');              // mine | unassigned | all (assignment axis, S162)
  const limit = Math.min(Number(params.get('limit')) || 60, 1000);   // cap raised 300→1000 for list "Load more" (S202)
  // Sort axis (S164, Pruthvi): recent activity (default) | oldest-first | priority high→low.
  const sort = params.get('sort') || 'recent';
  const ORDERS = {
    recent:   'last_message_at.desc.nullslast',
    oldest:   'last_message_at.asc.nullsfirst',
    priority: 'priority_rank.asc,last_message_at.desc.nullslast',
  };
  const orderClause = ORDERS[sort] || ORDERS.recent;
  let q = `/rest/v1/cs_wa_threads?select=*&order=${orderClause}&limit=${limit}`;
  // Ignition handoff scope (S177): threads transferred to the Influencer team leave
  // the CS inbox entirely. Default = exclude them; scope=ignition = ONLY them (a
  // read-only oversight view for CS leads, since Pitstop still owns the channel).
  const scope = params.get('scope');
  if (scope === 'ignition') q += `&ignition_connect=is.true`;
  else q += `&ignition_connect=is.false`;
  const state = params.get('state') || 'active';   // active (open+snoozed) | closed | all (S163 work-queue)
  if (channel && channel !== 'all') q += `&channel=eq.${encodeURIComponent(channel)}`;
  if (tab === 'mine') q += `&assigned_agent_id=eq.${auth.userId}`;
  else if (tab === 'unassigned') q += `&assigned_agent_id=is.null`;
  else {
    // Explicit assigned-agent facet — managers filtering to one agent (S164). Only
    // meaningful on the "all" tab (mine/unassigned already pin the agent axis).
    const agent = params.get('agent');
    if (agent) q += `&assigned_agent_id=eq.${encodeURIComponent(agent)}`;
  }
  if (state === 'active') q += `&thread_state=in.(open,snoozed)`;
  else if (state === 'closed') q += `&thread_state=eq.closed`;
  // state === 'all' → no thread_state filter
  const priority = params.get('priority');         // urgent|high|normal|low facet (S164)
  if (priority) q += `&priority=eq.${encodeURIComponent(priority)}`;
  const since = params.get('since');               // ISO — last activity ≥ (S164 date filter)
  if (since) q += `&last_message_at=gte.${encodeURIComponent(since)}`;
  const until = params.get('until');               // ISO — last activity ≤ (S164 date filter)
  if (until) q += `&last_message_at=lte.${encodeURIComponent(until)}`;
  // Search box (S178, Pruthvi) — match by phone number (partial; +91 optional),
  // display name/IG handle (customer_handle), or the channel handle in external_user_id
  // (the EMAIL ADDRESS on email threads; IG/FB user id on Meta threads). Server-side so
  // it finds threads beyond the loaded window. Strip PostgREST or()-breaking chars.
  const search = (params.get('q') || '').replace(/[(),*]/g, '').trim().slice(0, 50);
  if (search) {
    const s = encodeURIComponent(search);
    q += `&or=(customer_phone.ilike.*${s}*,customer_handle.ilike.*${s}*,external_user_id.ilike.*${s}*)`;
  }
  const tagFilter = params.get('tag');             // tag facet (S163)
  if (tagFilter) {
    const tagged = await idsWithTag('thread', tagFilter, env);
    if (!tagged.length) return ok({ threads: [] });
    q += `&id=in.(${tagged.join(',')})`;
  }
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
  const tagsByThread = await fetchTagsFor('thread', ids, env);
  const out = threads.map(t => {
    const lm = lastByThread[t.id] || null;
    const tid = ticketByThread[t.id] || null;
    return {
      ...t,
      last_message: lm ? { body: lm.body, kind: lm.kind, direction: lm.direction, created_at: lm.created_at } : null,
      linked_ticket_id: tid,
      linked_ticket_no: tid ? (ticketNoById[tid] || null) : null,
      within_customer_window: withinCustomerWindow(t),
      tags: tagsByThread[t.id] || [],
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
    instagram: { total: 0, awaiting: 0, mine: 0, unassigned: 0, closed: 0 },
    messenger: { total: 0, awaiting: 0, mine: 0, unassigned: 0, closed: 0 },
    whatsapp:  { total: 0, awaiting: null, mine: 0, unassigned: 0, closed: 0 },
    email:     { total: 0, awaiting: null, mine: 0, unassigned: 0, closed: 0 },
    web:       { total: 0, awaiting: null, mine: 0, unassigned: 0, closed: 0 },
  };
  // Two-way channels: small volume → fetch threads + last-message direction.
  // Exclude Ignition-transferred threads (S177) — they're off the CS inbox.
  const twRes = await sb(`/rest/v1/cs_wa_threads?channel=in.(instagram,messenger)&ignition_connect=is.false&thread_state=in.(open,snoozed)&select=id,channel,assigned_agent_id&limit=1000`, env);
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
  // Header tiles count the ACTIVE work-queue (open+snoozed) so they MATCH the default
  // inbox list, which filters state=active (getMessagingThreads). Without this, a CLOSED
  // unassigned thread inflated the "unassigned" tile but never appeared in the list →
  // "count says N, Unassigned tab shows none" (Pruthvi, S184, email channel). Closed
  // conversations are reachable via the Closed/All state filter, not the work-queue tiles.
  const ACTIVE = `&thread_state=in.(open,snoozed)`;
  // WhatsApp: exact counts only (read-only mirror — awaiting tracked in BiteSpeed).
  // All counts exclude Ignition-transferred threads (S177).
  stats.whatsapp.total = await sbCount(`/rest/v1/cs_wa_threads?channel=eq.whatsapp&ignition_connect=is.false${ACTIVE}&select=id`, env);
  stats.whatsapp.mine = await sbCount(`/rest/v1/cs_wa_threads?channel=eq.whatsapp&ignition_connect=is.false&assigned_agent_id=eq.${auth.userId}${ACTIVE}&select=id`, env);
  stats.whatsapp.unassigned = await sbCount(`/rest/v1/cs_wa_threads?channel=eq.whatsapp&ignition_connect=is.false&assigned_agent_id=is.null${ACTIVE}&select=id`, env);
  // Email: exact counts (volume may grow → cheap counts, no per-thread awaiting v1).
  stats.email.total = await sbCount(`/rest/v1/cs_wa_threads?channel=eq.email&ignition_connect=is.false${ACTIVE}&select=id`, env);
  stats.email.mine = await sbCount(`/rest/v1/cs_wa_threads?channel=eq.email&ignition_connect=is.false&assigned_agent_id=eq.${auth.userId}${ACTIVE}&select=id`, env);
  stats.email.unassigned = await sbCount(`/rest/v1/cs_wa_threads?channel=eq.email&ignition_connect=is.false&assigned_agent_id=is.null${ACTIVE}&select=id`, env);
  // Web (L.O.T Web widget via BiteSpeed, S182): exact counts only (read-mostly mirror).
  stats.web.total = await sbCount(`/rest/v1/cs_wa_threads?channel=eq.web&ignition_connect=is.false${ACTIVE}&select=id`, env);
  stats.web.mine = await sbCount(`/rest/v1/cs_wa_threads?channel=eq.web&ignition_connect=is.false&assigned_agent_id=eq.${auth.userId}${ACTIVE}&select=id`, env);
  stats.web.unassigned = await sbCount(`/rest/v1/cs_wa_threads?channel=eq.web&ignition_connect=is.false&assigned_agent_id=is.null${ACTIVE}&select=id`, env);
  // Closed (resolved) count per channel — shown on each channel tile so the team has
  // quick visibility into resolved volume per channel (Pruthvi, S185). Excludes
  // Ignition-transferred threads, consistent with the active counts above.
  for (const ch of ['instagram', 'messenger', 'whatsapp', 'email', 'web']) {
    stats[ch].closed = await sbCount(`/rest/v1/cs_wa_threads?channel=eq.${ch}&ignition_connect=is.false&thread_state=eq.closed&select=id`, env);
  }
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
  const tagsByThread = await fetchTagsFor('thread', [thread.id], env);
  return ok({ thread, messages, linked_ticket, within_customer_window: withinCustomerWindow(thread), tags: tagsByThread[thread.id] || [] });
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

// Bulk assign/claim/release many DM threads in ONE PATCH (S164, Pruthvi).
// Same permission split as assignThread: self-claim = cs_ticket_manage,
// assigning to another agent = cs_ticket_reassign/admin. A plain agent
// releasing (agent_id null) only ever clears their OWN threads (scoped filter).
// One subrequest regardless of count, so no Cloudflare subrequest-limit risk.
async function bulkAssignThreads(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { thread_ids, agent_id } = body;
  if (!Array.isArray(thread_ids) || thread_ids.length === 0) return err('thread_ids[] required');
  if (thread_ids.length > 200) return err('too many threads in one action (max 200)');

  const canReassign = !!auth?.permissions?.cs_ticket_reassign || !!auth?.permissions?.cs_ticket_admin;
  const isSelf = agent_id === auth.userId;

  let name = null;
  if (agent_id) {
    if (!isSelf && !canReassign) {
      return err('Forbidden — only Team Lead+ can assign threads to other agents (missing cs_ticket_reassign)', 403);
    }
    const aRes = await sb(`/rest/v1/users_profile?id=eq.${agent_id}&select=id,full_name&limit=1`, env);
    const agent = aRes.data?.[0];
    if (!agent) return err('Agent not found', 404);
    name = agent.full_name;
  }

  const idList = thread_ids.map(id => encodeURIComponent(id)).join(',');
  let path = `/rest/v1/cs_wa_threads?id=in.(${idList})`;
  // A plain agent releasing to the pool may only clear threads they own.
  if (!agent_id && !canReassign) path += `&assigned_agent_id=eq.${auth.userId}`;

  const upd = await sb(path, env, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      assigned_agent_id: agent_id || null,
      assigned_agent_name: name,
      assigned_at: agent_id ? new Date().toISOString() : null,
    }),
  });
  if (!upd.ok) return err('Bulk assign failed', upd.status || 500);
  return ok({ updated: (upd.data || []).length, assigned_agent_id: agent_id || null, assigned_agent_name: name });
}

// Set a DM thread's priority (S164, Pruthvi). Urgent/High/Normal/Low; sortable
// via the generated priority_rank column. Gate cs_ticket_manage (same as assign).
async function setThreadPriority(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { thread_id, priority } = body;
  if (!thread_id) return err('thread_id required');
  const ALLOWED = new Set(['urgent', 'high', 'normal', 'low']);
  if (!ALLOWED.has(priority)) return err('priority must be one of urgent|high|normal|low');
  const upd = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}`, env, {
    method: 'PATCH', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ priority, updated_at: new Date().toISOString() }),
  });
  if (!upd.ok || !upd.data?.[0]) return err('Failed to set priority', upd.status || 500);
  return ok({ thread_id, priority });
}

// Quick-create a ticket FROM a DM conversation and auto-link it (S164, Pruthvi).
// Mirrors createTicket's insert shape; prefills customer + channel from the thread.
// IG/FB have no phone → intake_channel='other', customer_name = handle. Idempotent:
// if the thread already links a ticket, returns it instead of minting a duplicate.
async function createTicketFromThread(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { thread_id } = body;
  if (!thread_id) return err('thread_id required');

  const tRes = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=*&limit=1`, env);
  const thread = tRes.data?.[0];
  if (!thread) return err('Thread not found', 404);

  // Already linked? Return that ticket (no dup).
  const linkRes = await sb(`/rest/v1/cs_wa_messages?thread_id=eq.${encodeURIComponent(thread_id)}&ticket_id=not.is.null&select=ticket_id&limit=1`, env);
  const existingId = linkRes.data?.[0]?.ticket_id;
  if (existingId) {
    const ex = await sb(`/rest/v1/cs_tickets?id=eq.${existingId}&select=id,ticket_no&limit=1`, env);
    const exTk = ex.data?.[0];
    if (exTk) return ok({ ticket_no: exTk.ticket_no, id: exTk.id, already_linked: true });
  }

  const year = String(new Date().getFullYear());
  const seqRes = await sb(`/rest/v1/rpc/next_cs_ticket_seq`, env, { method: 'POST', body: JSON.stringify({ p_year: year }) });
  if (!seqRes.ok) return err(`Failed to claim ticket number: ${JSON.stringify(seqRes.data)}`, 500);
  const ticket_no = `CS-${year}-${String(Number(seqRes.data)).padStart(5, '0')}`;

  const isWa = thread.channel === 'whatsapp';
  const customer_name = thread.customer_handle || thread.customer_phone || (isWa ? 'WhatsApp customer' : 'Social customer');
  const due_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // pending → 7d default SLA

  const insertRes = await sb(`/rest/v1/cs_tickets`, env, {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      ticket_no,
      cs_department_id: auth.cs_department_id || null,
      created_by_user_id: auth.userId,
      created_by_name: auth.fullName,
      intake_channel: isWa ? 'whatsapp' : 'other',
      customer_name,
      customer_phone: isWa ? (thread.customer_phone || null) : null,
      disposition: 'pending',
      assigned_agent_id: thread.assigned_agent_id || auth.userId,
      assigned_agent_name: thread.assigned_agent_name || auth.fullName,
      stage: 'intake',
      issue_description: '',
      due_at,
    }),
  });
  if (!insertRes.ok) return err(`Failed to create ticket: ${JSON.stringify(insertRes.data)}`, insertRes.status);
  const ticket = insertRes.data?.[0];
  await insertHistory(ticket.id, 'ticket_created', null, ticket_no, null, auth, env);

  // Auto-link the whole thread to the new ticket (mirror linkMessagingThread —
  // the link lives on the thread's cs_wa_messages rows).
  await sb(`/rest/v1/cs_wa_messages?thread_id=eq.${encodeURIComponent(thread_id)}`, env, {
    method: 'PATCH', body: JSON.stringify({ ticket_id: ticket.id }),
  }).catch(() => {});

  return ok({ ticket_no, id: ticket.id, linked: true });
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

// Transfer a thread to another agent + leave an internal handoff note (Pruthvi's ask).
// Any cs_ticket_manage agent can hand off a thread they own or that's unassigned; only
// Team Lead+ (cs_ticket_reassign/admin) can transfer a thread assigned to someone else.
async function transferThread(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { thread_id, to_agent_id, note } = body;
  if (!thread_id || !to_agent_id) return err('thread_id and to_agent_id required');

  const tRes = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=id,channel,assigned_agent_id,thread_state&limit=1`, env);
  const thread = tRes.data?.[0];
  if (!thread) return err('Thread not found', 404);

  const canReassign = !!auth?.permissions?.cs_ticket_reassign || !!auth?.permissions?.cs_ticket_admin;
  const ownsOrFree = !thread.assigned_agent_id || thread.assigned_agent_id === auth.userId;
  if (!canReassign && !ownsOrFree) {
    return err("Forbidden — you can only transfer a conversation you're handling (missing cs_ticket_reassign)", 403);
  }
  if (to_agent_id === thread.assigned_agent_id) return err('Conversation is already assigned to that agent', 422);

  const aRes = await sb(`/rest/v1/users_profile?id=eq.${encodeURIComponent(to_agent_id)}&select=id,full_name&limit=1`, env);
  const agent = aRes.data?.[0];
  if (!agent) return err('Target agent not found', 404);

  const now = new Date().toISOString();
  const patch = { assigned_agent_id: agent.id, assigned_agent_name: agent.full_name, assigned_at: now };
  if (thread.thread_state && thread.thread_state !== 'open') patch.thread_state = 'open';   // a transfer = active work
  const upd = await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
  if (!upd.ok) return err('Transfer failed', upd.status || 500);

  // Internal handoff note (team-only; for WhatsApp it surfaces via getWaConversation's
  // note merge). Always records the handoff line; appends the agent's note if given.
  const fromName = auth.fullName || auth.name || auth.email || 'Agent';
  const noteText = (note && String(note).trim()) ? `\n${String(note).trim()}` : '';
  await sb(`/rest/v1/cs_wa_messages`, env, {
    method: 'POST',
    body: JSON.stringify({
      thread_id: thread.id, channel: thread.channel || 'whatsapp', direction: 'outbound',
      kind: 'note', is_internal: true, body: `↪ Transferred to ${agent.full_name}${noteText}`,
      status: null, sent_by_user_id: auth.userId, sent_by_name: fromName, sent_at: now,
    }),
  }).catch(() => {});
  await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, { method: 'PATCH', body: JSON.stringify({ updated_at: now }) }).catch(() => {});

  return ok({ transferred_to: agent.full_name, to_agent_id: agent.id });
}

// ── Ignition Connects bridge (S177) ──────────────────────────────────────────
// The Pitstop CS team transfers an IG/WhatsApp/email conversation to the Influencer
// team; Reann (+ Himani) work it inside Ignition. Pitstop stays the channel owner +
// single store — Ignition reads/replies through these endpoints, never the raw inbox.
// See spec 2026-06-26-ignition-pitstop-connects-transfer-design.md.

// CS-side action: hand a thread to the Influencer team. Full handoff — the
// ignition_connect flag excludes it from the CS inbox everywhere, and CS assignment
// is released. Same own/unassigned-vs-reassign gate as transferThread.
async function transferThreadToIgnition(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { thread_id, note } = body;
  if (!thread_id) return err('thread_id required');

  const tRes = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=id,channel,assigned_agent_id,ignition_connect&limit=1`, env);
  const thread = tRes.data?.[0];
  if (!thread) return err('Thread not found', 404);
  if (thread.ignition_connect) return err('Conversation is already with the Influencer team', 422);

  const canReassign = !!auth?.permissions?.cs_ticket_reassign || !!auth?.permissions?.cs_ticket_admin;
  const ownsOrFree = !thread.assigned_agent_id || thread.assigned_agent_id === auth.userId;
  if (!canReassign && !ownsOrFree) {
    return err("Forbidden — you can only transfer a conversation you're handling (missing cs_ticket_reassign)", 403);
  }

  const now = new Date().toISOString();
  const upd = await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, {
    method: 'PATCH',
    body: JSON.stringify({
      ignition_connect: true, ignition_transferred_at: now, ignition_transferred_by: auth.userId,
      assigned_agent_id: null, assigned_agent_name: null, assigned_at: null, updated_at: now,
    }),
  });
  if (!upd.ok) return err('Transfer failed', upd.status || 500);

  // Internal handoff note — the snapshot the Influencer team sees + a CS audit line.
  const fromName = auth.fullName || auth.name || auth.email || 'Agent';
  const noteText = (note && String(note).trim()) ? `: ${String(note).trim()}` : '';
  await sb(`/rest/v1/cs_wa_messages`, env, {
    method: 'POST',
    body: JSON.stringify({
      thread_id: thread.id, channel: thread.channel || 'whatsapp', direction: 'outbound',
      kind: 'note', is_internal: true, body: `↪ Transferred to Influencer team (Ignition)${noteText}`,
      status: null, sent_by_user_id: auth.userId, sent_by_name: fromName, sent_at: now,
    }),
  }).catch(() => {});

  return ok({ transferred: true, thread_id: thread.id });
}

// Bridge router — token-authed (NOT a user JWT), routed before the JWT gate. Every
// handler hard-scopes to ignition_connect=true so Ignition is structurally walled
// off from general channel traffic even if its UI had a bug.
async function handleIgnitionBridge(request, env) {
  if (!env.IGNITION_BRIDGE_TOKEN) return err('Ignition bridge not configured', 503);
  if (request.headers.get('X-Ignition-Bridge-Token') !== env.IGNITION_BRIDGE_TOKEN) return err('Unauthorized', 401);
  let body = {};
  try { body = await request.json(); } catch {}
  switch (body.action) {
    case 'getIgnitionConnects':    return bridgeGetConnects(body, env);
    case 'getIgnitionThread':      return bridgeGetThread(body, env);
    case 'sendConnectReply':       return bridgeSendReply(body, env);
    case 'returnConnectToPitstop': return bridgeReturnConnect(body, env);
    case 'createTicketFromIgnition': return bridgeCreateTicket(body, env);
    default: return err(`Unknown bridge action: ${body.action}`, 404);
  }
}

// List every transferred thread + a batched last-message preview + awaiting-reply flag.
async function bridgeGetConnects(body, env) {
  const limit = Math.min(Number(body.limit) || 200, 400);
  const channel = body.channel;
  let q = `/rest/v1/cs_wa_threads?ignition_connect=is.true&select=*&order=last_message_at.desc.nullslast&limit=${limit}`;
  if (channel && channel !== 'all') q += `&channel=eq.${encodeURIComponent(channel)}`;
  const tRes = await sb(q, env);
  const threads = tRes.data || [];
  if (!threads.length) return ok({ threads: [] });

  const ids = threads.map(t => t.id);
  const mRes = await sb(
    `/rest/v1/cs_wa_messages?thread_id=in.(${ids.join(',')})&is_internal=eq.false&select=thread_id,body,kind,direction,created_at&order=created_at.desc&limit=1500`,
    env,
  );
  const lastByThread = {};
  for (const m of (mRes.data || [])) if (!lastByThread[m.thread_id]) lastByThread[m.thread_id] = m;
  const out = threads.map(t => {
    const lm = lastByThread[t.id] || null;
    return {
      ...t,
      last_message: lm ? { body: lm.body, kind: lm.kind, direction: lm.direction, created_at: lm.created_at } : null,
      awaiting_reply: lm ? lm.direction === 'inbound' : false,
      within_customer_window: withinCustomerWindow(t),
    };
  });
  return ok({ threads: out });
}

// One transferred thread's full message history. 403 if not an Ignition connect.
async function bridgeGetThread(body, env) {
  const { thread_id } = body;
  if (!thread_id) return err('thread_id required');
  const tRes = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=*&limit=1`, env);
  const thread = tRes.data?.[0];
  if (!thread) return err('Thread not found', 404);
  if (!thread.ignition_connect) return err('Not an Ignition connect', 403);
  const mRes = await sb(
    `/rest/v1/cs_wa_messages?thread_id=eq.${encodeURIComponent(thread_id)}&select=*&order=created_at.asc&limit=500`, env);
  return ok({ thread, messages: mRes.data || [], within_customer_window: withinCustomerWindow(thread) });
}

// Reply on a transferred thread → existing provider send path by channel, scope-
// checked, stamped to the acting Ignition user, with NO CS auto-claim (viaIgnitionBridge).
async function bridgeSendReply(body, env) {
  const { thread_id, text, html, actor } = body;
  if (!thread_id || (!text && !html)) return err('thread_id and text required');
  const tRes = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=id,channel,ignition_connect&limit=1`, env);
  const thread = tRes.data?.[0];
  if (!thread) return err('Thread not found', 404);
  if (!thread.ignition_connect) return err('Not an Ignition connect', 403);

  const synthAuth = {
    userId: actor?.id || null,
    fullName: actor?.name || null,
    name: actor?.name || null,
    email: actor?.email || null,
    permissions: { cs_ticket_manage: true },
    viaIgnitionBridge: true,
  };
  const channel = thread.channel || 'whatsapp';
  if (channel === 'whatsapp' || channel === 'web') return sendWaReply({ thread_id, text }, synthAuth, env);
  if (channel === 'instagram' || channel === 'messenger') return sendMetaMessage({ thread_id, text }, synthAuth, env);
  if (channel === 'email') return sendEmailReply({ thread_id, text, html }, synthAuth, env);
  return err(`Unsupported channel: ${channel}`, 422);
}

// Open a Pitstop ticket for an Ignition damaged-shipment flag (RULE-IGN-004).
// Token-authed sibling call, so it runs under a synth-auth (cs_ticket_manage) —
// the Ignition user has no CS permission of their own. The ticket lands UNASSIGNED
// (synthAuth.userId = null → createTicket leaves assignee null) so the CS team
// triages it; the flagging influencer-team member is preserved as created_by_name.
async function bridgeCreateTicket(body, env) {
  const t = body.ticket || {};
  if (!t.customer_name) return err('customer_name required');
  const synthAuth = {
    userId: null,                         // → Unassigned queue (no auto-assign to a non-CS user)
    fullName: body.actor?.name || 'Ignition',
    name: body.actor?.name || 'Ignition',
    email: body.actor?.email || null,
    cs_department_id: null,
    permissions: { cs_ticket_manage: true },
    viaIgnitionBridge: true,
  };
  return createTicket(t, synthAuth, env);
}

// Return a transferred connect back to Pitstop CS (reclaim). Clears the
// ignition_connect gate → the thread reappears in the CS inbox (Unassigned, since
// transfer released its agent); leaves an internal note. Scope-checked.
async function bridgeReturnConnect(body, env) {
  const { thread_id, actor } = body;
  if (!thread_id) return err('thread_id required');
  const tRes = await sb(`/rest/v1/cs_wa_threads?id=eq.${encodeURIComponent(thread_id)}&select=id,channel,ignition_connect&limit=1`, env);
  const thread = tRes.data?.[0];
  if (!thread) return err('Thread not found', 404);
  if (!thread.ignition_connect) return err('Not an Ignition connect', 403);
  const now = new Date().toISOString();
  const upd = await sb(`/rest/v1/cs_wa_threads?id=eq.${thread.id}`, env, {
    method: 'PATCH',
    body: JSON.stringify({ ignition_connect: false, ignition_transferred_at: null, ignition_transferred_by: null, updated_at: now }),
  });
  if (!upd.ok) return err('Return failed', upd.status || 500);
  await sb(`/rest/v1/cs_wa_messages`, env, {
    method: 'POST',
    body: JSON.stringify({
      thread_id: thread.id, channel: thread.channel || 'whatsapp', direction: 'outbound',
      kind: 'note', is_internal: true,
      body: `↩ Returned to Pitstop CS from the Influencer team${actor?.name ? ' by ' + actor.name : ''}.`,
      status: null, sent_by_user_id: actor?.id || null, sent_by_name: actor?.name || null, sent_at: now,
    }),
  }).catch(() => {});
  return ok({ returned: true, thread_id: thread.id });
}

// ── Canned responses (S162) — agent-managed quick replies for the composer ───
async function getCannedResponses(_params, auth, env) {
  const g = require('cs_ticket_view', auth); if (g) return g;
  const r = await sb(`/rest/v1/cs_canned_responses?is_active=eq.true&select=*&order=sort_order.asc,title.asc`, env);
  if (!r.ok) return err('failed to load canned responses', 500);
  return ok(r.data || []);
}
async function createCannedResponse(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { title, body: text, sort_order } = body;
  if (!title?.trim() || !text?.trim()) return err('title and body required');
  const r = await sb(`/rest/v1/cs_canned_responses`, env, {
    method: 'POST',
    body: JSON.stringify({
      title: title.trim(), body: text.trim(), sort_order: Math.round(Number(sort_order) || 0),
      created_by_user_id: auth.userId, created_by_name: auth.fullName || auth.name || auth.email || null,
    }),
  });
  if (!r.ok) return err('failed to create canned response', r.status || 500);
  return ok({ canned: r.data?.[0] || null });
}
async function updateCannedResponse(body, auth, env) {
  const g = require('cs_ticket_manage', auth); if (g) return g;
  const { id, title, body: text, is_active, sort_order } = body;
  if (!id) return err('id required');
  const patch = { updated_at: new Date().toISOString() };
  if (title != null) patch.title = String(title).trim();
  if (text != null) patch.body = String(text).trim();
  if (is_active != null) patch.is_active = !!is_active;       // is_active=false = archive (soft delete)
  if (sort_order != null) patch.sort_order = Math.round(Number(sort_order) || 0);
  const r = await sb(`/rest/v1/cs_canned_responses?id=eq.${encodeURIComponent(id)}`, env, {
    method: 'PATCH', body: JSON.stringify(patch),
  });
  if (!r.ok) return err('failed to update canned response', r.status || 500);
  return ok({ canned: r.data?.[0] || null });
}
