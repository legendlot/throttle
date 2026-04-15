/**
 * Throttle — Cloudflare Worker
 * throttleops.afshaan.workers.dev
 *
 * Handles all writes, JWT validation, role enforcement, Slack dispatch.
 * Reads go directly from the client via Supabase anon key + RLS.
 *
 * Pattern: POST /?action=<actionName>
 *          Authorization: Bearer <supabase_jwt>
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

function requireRole(ctx, ...roles) {
  if (!roles.includes(ctx.role)) {
    return err(`Requires role: ${roles.join(' or ')}`, 403);
  }
  return null;
}

async function getAuthUser(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: env.SUPABASE_ANON_KEY,
    },
  });
  if (!res.ok) return null;
  return res.json();
}

async function getBrandUser(userId, env) {
  const path = `users?id=eq.${userId}&select=*`;
  const fullUrl = `${env.SUPABASE_URL}/rest/v1/${path}`;
  const res = await sbFetch(path, { method: 'GET' }, env);
  console.log(`[getBrandUser] GET ${fullUrl} → ${res.status}`);
  if (!res.ok) {
    const body = await res.text();
    console.log(`[getBrandUser] error body: ${body.slice(0, 500)}`);
    return null;
  }
  const rows = await res.json();
  console.log(`[getBrandUser] rows returned: ${rows.length}`);
  return rows[0] || null;
}

function sbFetch(path, options = {}, env) {
  const url = `${env.SUPABASE_URL}/rest/v1/${path}`;
  // Allow callers to override the Prefer header via options.prefer
  // (e.g. 'return=minimal' for writes whose response body isn't read).
  const preferHeader = options.prefer || 'return=representation';
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Accept-Profile': 'brand',
      'Content-Profile': 'brand',
      Prefer: preferHeader,
      ...(options.headers || {}),
    },
  });
}

async function slackNotify(message, env) {
  if (!env.SLACK_WEBHOOK_URL) return;
  await fetch(env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    if (action === 'health') {
      return json({ ok: true, service: 'throttleops', ts: new Date().toISOString() });
    }

    if (!action) return err('Missing action parameter', 400);

    const authUser = await getAuthUser(request, env);
    if (!authUser) return err('Unauthorized', 401);

    const brandUser = await getBrandUser(authUser.id, env);
    if (!brandUser) return err('User not found — contact admin to get access', 403);

    const ctx = {
      authUser,
      brandUser,
      role: brandUser.role,
      userId: brandUser.id,
    };

    let body = {};
    if (request.method === 'POST') {
      try { body = await request.json(); } catch {}
    }

    switch (action) {
      case 'getMe':               return handleGetMe(body, ctx, env);
      case 'updateUserRole':      return handleUpdateUserRole(body, ctx, env);
      case 'updateUserProfile':   return handleUpdateUserProfile(body, ctx, env);
      case 'submitRequest':       return handleSubmitRequest(body, ctx, env);
      case 'approveRequest':      return handleApproveRequest(body, ctx, env);
      case 'rejectRequest':       return handleRejectRequest(body, ctx, env);
      case 'requestMoreInfo':     return handleRequestMoreInfo(body, ctx, env);
      case 'createTask':          return handleCreateTask(body, ctx, env);
      case 'updateTaskStage':     return handleUpdateTaskStage(body, ctx, env);
      case 'updateTaskPriority':  return handleUpdateTaskPriority(body, ctx, env);
      case 'assignTask':          return handleAssignTask(body, ctx, env);
      case 'abandonTask':         return handleAbandonTask(body, ctx, env);
      case 'flagExtBlocked':      return handleFlagExtBlocked(body, ctx, env);
      case 'createSprint':        return handleCreateSprint(body, ctx, env);
      case 'closeSprint':         return handleCloseSprint(body, ctx, env);
      case 'addTaskToSprint':     return handleAddTaskToSprint(body, ctx, env);
      case 'submitForReview':     return handleSubmitForReview(body, ctx, env);
      case 'approveWork':         return handleApproveWork(body, ctx, env);
      case 'rejectWork':          return handleRejectWork(body, ctx, env);
      default:
        return err(`Unknown action: ${action}`, 404);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSprintClose(env));
  },
};

// Returns the full brand.users row for the calling user.
// Uses service role (bypasses RLS) so client doesn't need direct brand-schema access.
async function handleGetMe(body, ctx, env) {
  const res = await sbFetch(
    `users?id=eq.${ctx.userId}&select=*`,
    { method: 'GET' },
    env
  );
  if (!res.ok) return err('Failed to fetch user record', res.status);
  const rows = await res.json();
  if (!rows[0]) return err('User not found', 404);
  return json(rows[0]);
}

// Placeholder handlers — implemented phase by phase
async function handleUpdateUserRole(body, ctx, env) {
  const g = requireRole(ctx, 'admin'); if (g) return g;
  return err('Not implemented yet', 501);
}
async function handleUpdateUserProfile(body, ctx, env) {
  return err('Not implemented yet', 501);
}
async function handleSubmitRequest(body, ctx, env) {
  const { type, title, template_data, is_product_scoped, products } = body;

  if (!type || !title) return err('type and title are required');

  const validTypes = ['social','campaign','design','copy','photo_video','3d','deck','ad'];
  if (!validTypes.includes(type)) return err('Invalid request type');

  // INSERT request
  const reqRes = await sbFetch('requests', {
    method: 'POST',
    body: JSON.stringify({
      type,
      title,
      template_data: template_data || {},
      is_product_scoped: !!is_product_scoped,
      status: 'pending',
      requester_id: ctx.userId,
    }),
  }, env);

  if (!reqRes.ok) {
    const e = await reqRes.json();
    return err(`Failed to create request: ${e.message || reqRes.status}`);
  }

  const [request] = await reqRes.json();

  // INSERT request_products if product scoped
  if (is_product_scoped && products?.length > 0) {
    const productRows = products.map(p => ({
      request_id: request.id,
      product_code: p.product_name, // using product name as code since selector uses names
      product_notes: p.notes || null,
    }));

    const rpRes = await sbFetch('request_products', {
      method: 'POST',
      body: JSON.stringify(productRows),
      prefer: 'return=minimal',
    }, env);

    if (!rpRes.ok) {
      console.error('[submitRequest] Failed to insert request_products:', await rpRes.text());
    }
  }

  // Slack placeholder
  console.log(`[Slack] New request submitted: "${title}" (${type}) by ${ctx.brandUser.name}`);

  return json({ ok: true, request_id: request.id });
}

async function handleApproveRequest(body, ctx, env) {
  const g = requireRole(ctx, 'admin', 'lead'); if (g) return g;
  const { request_id, note } = body;
  if (!request_id) return err('request_id is required');

  // Fetch request to confirm it exists and is pending
  const fetchRes = await sbFetch(`requests?id=eq.${request_id}&select=*`, { method: 'GET' }, env);
  if (!fetchRes.ok) return err('Request not found');
  const [request] = await fetchRes.json();
  if (!request) return err('Request not found');
  if (request.status !== 'pending') return err(`Request is already ${request.status}`);

  // UPDATE request status
  const updateRes = await sbFetch(`requests?id=eq.${request_id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'approved',
      reviewer_id: ctx.userId,
      review_note: note || null,
      reviewed_at: new Date().toISOString(),
    }),
    prefer: 'return=minimal',
  }, env);

  if (!updateRes.ok) return err('Failed to update request');

  // Batch create tasks — one per product if product scoped, otherwise one task
  const rpRes = await sbFetch(`request_products?request_id=eq.${request_id}&select=*`, { method: 'GET' }, env);
  const requestProducts = rpRes.ok ? await rpRes.json() : [];

  const taskBase = {
    request_id,
    type: request.type,
    deliverable_type: 'other', // Admin/Lead sets correct type when assigning
    stage: 'backlog',
    priority: 'medium',
    is_spillover: false,
    spillover_count: 0,
  };

  let tasksToCreate = [];

  if (request.is_product_scoped && requestProducts.length > 0) {
    // Generate batch_id to group these tasks
    const batchId = crypto.randomUUID();
    tasksToCreate = requestProducts.map(rp => ({
      ...taskBase,
      product_code: rp.product_code,
      batch_id: batchId,
      title: `${request.title} — ${rp.product_code}`,
      notes: rp.product_notes || null,
    }));
  } else {
    tasksToCreate = [{
      ...taskBase,
      title: request.title,
      notes: note || null,
    }];
  }

  const taskRes = await sbFetch('tasks', {
    method: 'POST',
    body: JSON.stringify(tasksToCreate),
  }, env);

  if (!taskRes.ok) {
    console.error('[approveRequest] Failed to create tasks:', await taskRes.text());
  }

  // Slack placeholder
  console.log(`[Slack] Request approved: "${request.title}" by ${ctx.brandUser.name}. ${tasksToCreate.length} task(s) created.`);

  return json({ ok: true, tasks_created: tasksToCreate.length });
}

async function handleRejectRequest(body, ctx, env) {
  const g = requireRole(ctx, 'admin', 'lead'); if (g) return g;
  const { request_id, note } = body;
  if (!request_id) return err('request_id is required');
  if (!note?.trim()) return err('A rejection reason is required');

  const fetchRes = await sbFetch(`requests?id=eq.${request_id}&select=id,status,title`, { method: 'GET' }, env);
  if (!fetchRes.ok) return err('Request not found');
  const [request] = await fetchRes.json();
  if (!request) return err('Request not found');
  if (request.status !== 'pending') return err(`Request is already ${request.status}`);

  const updateRes = await sbFetch(`requests?id=eq.${request_id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'rejected',
      reviewer_id: ctx.userId,
      review_note: note.trim(),
      reviewed_at: new Date().toISOString(),
    }),
    prefer: 'return=minimal',
  }, env);

  if (!updateRes.ok) return err('Failed to update request');

  // Slack placeholder
  console.log(`[Slack] Request rejected: "${request.title}" by ${ctx.brandUser.name}. Reason: ${note}`);

  return json({ ok: true });
}

async function handleRequestMoreInfo(body, ctx, env) {
  const g = requireRole(ctx, 'admin', 'lead'); if (g) return g;
  const { request_id, note } = body;
  if (!request_id) return err('request_id is required');
  if (!note?.trim()) return err('A note explaining what information is needed is required');

  const fetchRes = await sbFetch(`requests?id=eq.${request_id}&select=id,status,title`, { method: 'GET' }, env);
  if (!fetchRes.ok) return err('Request not found');
  const [request] = await fetchRes.json();
  if (!request) return err('Request not found');
  if (request.status !== 'pending') return err(`Request is already ${request.status}`);

  const updateRes = await sbFetch(`requests?id=eq.${request_id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'info_needed',
      reviewer_id: ctx.userId,
      review_note: note.trim(),
      reviewed_at: new Date().toISOString(),
    }),
    prefer: 'return=minimal',
  }, env);

  if (!updateRes.ok) return err('Failed to update request');

  // Slack placeholder
  console.log(`[Slack] More info requested on: "${request.title}" by ${ctx.brandUser.name}. Note: ${note}`);

  return json({ ok: true });
}
async function handleCreateTask(body, ctx, env) {
  const g = requireRole(ctx, 'admin', 'lead'); if (g) return g;
  return err('Not implemented yet', 501);
}
async function handleUpdateTaskStage(body, ctx, env) {
  return err('Not implemented yet', 501);
}
async function handleUpdateTaskPriority(body, ctx, env) {
  const g = requireRole(ctx, 'admin', 'lead'); if (g) return g;
  return err('Not implemented yet', 501);
}
async function handleAssignTask(body, ctx, env) {
  const g = requireRole(ctx, 'admin', 'lead'); if (g) return g;
  return err('Not implemented yet', 501);
}
async function handleAbandonTask(body, ctx, env) {
  const g = requireRole(ctx, 'admin', 'lead'); if (g) return g;
  return err('Not implemented yet', 501);
}
async function handleFlagExtBlocked(body, ctx, env) {
  return err('Not implemented yet', 501);
}
async function handleCreateSprint(body, ctx, env) {
  const g = requireRole(ctx, 'admin', 'lead'); if (g) return g;
  return err('Not implemented yet', 501);
}
async function handleCloseSprint(body, ctx, env) {
  const g = requireRole(ctx, 'admin', 'lead'); if (g) return g;
  return err('Not implemented yet', 501);
}
async function handleAddTaskToSprint(body, ctx, env) {
  const g = requireRole(ctx, 'admin', 'lead'); if (g) return g;
  return err('Not implemented yet', 501);
}
async function handleSubmitForReview(body, ctx, env) {
  return err('Not implemented yet', 501);
}
async function handleApproveWork(body, ctx, env) {
  const g = requireRole(ctx, 'admin', 'lead'); if (g) return g;
  return err('Not implemented yet', 501);
}
async function handleRejectWork(body, ctx, env) {
  const g = requireRole(ctx, 'admin', 'lead'); if (g) return g;
  return err('Not implemented yet', 501);
}
async function runSprintClose(env) {
  console.log('Sprint close cron fired — implemented in Phase 4');
}
