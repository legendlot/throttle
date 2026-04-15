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
      case 'removeTaskFromSprint':return handleRemoveTaskFromSprint(body, ctx, env);
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

  const { user_id, role, discipline } = body;
  if (!user_id) return err('user_id is required');

  // Prevent admin from changing their own role
  if (user_id === ctx.userId && role) {
    return err('You cannot change your own role');
  }

  const validRoles = ['admin', 'lead', 'member', 'requester'];
  const validDisciplines = ['designer', '3d', 'copywriter', 'photo_video', 'lead', null];

  if (role && !validRoles.includes(role)) return err('Invalid role');
  if (discipline !== undefined && !validDisciplines.includes(discipline)) return err('Invalid discipline');

  const update = {};
  if (role !== undefined) update.role = role;
  if (discipline !== undefined) update.discipline = discipline;

  if (Object.keys(update).length === 0) return err('Nothing to update');

  const updateRes = await sbFetch(`users?id=eq.${user_id}`, {
    method: 'PATCH',
    body: JSON.stringify(update),
    prefer: 'return=minimal',
  }, env);

  if (!updateRes.ok) return err('Failed to update user');

  return json({ ok: true });
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
  const { task_id, stage, blocked_reason } = body;
  if (!task_id || !stage) return err('task_id and stage are required');

  const validStages = ['backlog','in_sprint','in_progress','ext_blocked','in_review','approved','done','abandoned'];
  if (!validStages.includes(stage)) return err('Invalid stage');

  // Fetch current task
  const fetchRes = await sbFetch(`tasks?id=eq.${task_id}&select=id,stage,title,request_id`, { method: 'GET' }, env);
  if (!fetchRes.ok) return err('Task not found');
  const [task] = await fetchRes.json();
  if (!task) return err('Task not found');

  // Validate transition
  const memberTransitions = {
    in_sprint: ['in_progress'],
    in_progress: ['in_review', 'ext_blocked'],
    ext_blocked: ['in_progress'],
  };
  const adminLeadTransitions = {
    backlog: ['in_sprint', 'abandoned'],
    in_sprint: ['in_progress', 'backlog', 'abandoned'],
    in_progress: ['in_review', 'ext_blocked', 'in_sprint', 'abandoned'],
    ext_blocked: ['in_progress', 'abandoned'],
    in_review: ['approved', 'in_progress', 'abandoned'],
    approved: ['done', 'in_review', 'abandoned'],
  };

  const transitions = ['admin','lead'].includes(ctx.role)
    ? adminLeadTransitions
    : memberTransitions;

  const allowed = transitions[task.stage] || [];
  if (!allowed.includes(stage)) {
    return err(`Cannot move from ${task.stage} to ${stage} as ${ctx.role}`);
  }

  // Require blocked_reason for ext_blocked and abandoned
  if ((stage === 'ext_blocked' || stage === 'abandoned') && !blocked_reason?.trim()) {
    return err(`A reason is required when setting stage to ${stage}`);
  }

  // Build update payload
  const update = {
    stage,
    blocked_reason: (stage === 'ext_blocked' || stage === 'abandoned')
      ? blocked_reason.trim()
      : null,
    updated_at: new Date().toISOString(),
  };

  if (stage === 'done') update.completed_at = new Date().toISOString();
  if (stage === 'abandoned') update.abandoned_at = new Date().toISOString();

  const updateRes = await sbFetch(`tasks?id=eq.${task_id}`, {
    method: 'PATCH',
    body: JSON.stringify(update),
    prefer: 'return=minimal',
  }, env);

  if (!updateRes.ok) return err('Failed to update task stage');

  // Log activity
  await logActivity(task_id, ctx.userId, 'stage_change', {
    from: task.stage,
    to: stage,
    reason: blocked_reason || null,
  }, env);

  console.log(`[Slack] Task "${task.title}" moved ${task.stage} → ${stage} by ${ctx.brandUser.name}`);

  return json({ ok: true });
}

async function handleUpdateTaskPriority(body, ctx, env) {
  const { task_id, priority } = body;
  if (!task_id || !priority) return err('task_id and priority are required');

  const validPriorities = ['urgent', 'high', 'medium', 'low'];
  if (!validPriorities.includes(priority)) return err('Invalid priority');

  const g = requireRole(ctx, 'admin', 'lead'); if (g) return g;

  const fetchRes = await sbFetch(`tasks?id=eq.${task_id}&select=id,title,priority`, { method: 'GET' }, env);
  if (!fetchRes.ok) return err('Task not found');
  const [task] = await fetchRes.json();
  if (!task) return err('Task not found');

  const updateRes = await sbFetch(`tasks?id=eq.${task_id}`, {
    method: 'PATCH',
    body: JSON.stringify({ priority, updated_at: new Date().toISOString() }),
    prefer: 'return=minimal',
  }, env);

  if (!updateRes.ok) return err('Failed to update priority');

  await logActivity(task_id, ctx.userId, 'priority_change', {
    from: task.priority,
    to: priority,
  }, env);

  return json({ ok: true });
}

async function handleAssignTask(body, ctx, env) {
  const { task_id, user_ids } = body;
  if (!task_id || !user_ids?.length) return err('task_id and user_ids are required');

  const g = requireRole(ctx, 'admin', 'lead'); if (g) return g;

  // Delete existing assignees
  await sbFetch(`task_assignees?task_id=eq.${task_id}`, {
    method: 'DELETE',
    prefer: 'return=minimal',
  }, env);

  // Insert new assignees
  const rows = user_ids.map(uid => ({
    task_id,
    user_id: uid,
    assigned_by: ctx.userId,
  }));

  const insertRes = await sbFetch('task_assignees', {
    method: 'POST',
    body: JSON.stringify(rows),
    prefer: 'return=minimal',
  }, env);

  if (!insertRes.ok) return err('Failed to assign task');

  await logActivity(task_id, ctx.userId, 'assignment', {
    assigned_to: user_ids,
  }, env);

  console.log(`[Slack] Task ${task_id} assigned to ${user_ids.length} user(s) by ${ctx.brandUser.name}`);

  return json({ ok: true });
}

async function handleAbandonTask(body, ctx, env) {
  const { task_id, reason } = body;
  if (!task_id) return err('task_id is required');
  if (!reason?.trim()) return err('A reason is required to abandon a task');

  const g = requireRole(ctx, 'admin', 'lead'); if (g) return g;

  const fetchRes = await sbFetch(`tasks?id=eq.${task_id}&select=id,title,stage`, { method: 'GET' }, env);
  if (!fetchRes.ok) return err('Task not found');
  const [task] = await fetchRes.json();
  if (!task) return err('Task not found');
  if (['done', 'abandoned'].includes(task.stage)) {
    return err(`Task is already ${task.stage}`);
  }

  const updateRes = await sbFetch(`tasks?id=eq.${task_id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      stage: 'abandoned',
      blocked_reason: reason.trim(),
      abandoned_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
    prefer: 'return=minimal',
  }, env);

  if (!updateRes.ok) return err('Failed to abandon task');

  await logActivity(task_id, ctx.userId, 'abandonment', { reason: reason.trim() }, env);

  console.log(`[Slack] Task "${task.title}" abandoned by ${ctx.brandUser.name}. Reason: ${reason}`);

  return json({ ok: true });
}

async function handleFlagExtBlocked(body, ctx, env) {
  const { task_id, reason } = body;
  if (!task_id) return err('task_id is required');
  if (!reason?.trim()) return err('A reason is required when flagging external block');

  const fetchRes = await sbFetch(`tasks?id=eq.${task_id}&select=id,title,stage`, { method: 'GET' }, env);
  if (!fetchRes.ok) return err('Task not found');
  const [task] = await fetchRes.json();
  if (!task) return err('Task not found');

  // Check assignee or admin/lead
  if (!['admin', 'lead'].includes(ctx.role)) {
    const assigneeRes = await sbFetch(
      `task_assignees?task_id=eq.${task_id}&user_id=eq.${ctx.userId}&select=task_id`,
      { method: 'GET' }, env
    );
    const assignees = assigneeRes.ok ? await assigneeRes.json() : [];
    if (!assignees.length) return err('You are not assigned to this task');
  }

  const updateRes = await sbFetch(`tasks?id=eq.${task_id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      stage: 'ext_blocked',
      blocked_reason: reason.trim(),
      updated_at: new Date().toISOString(),
    }),
    prefer: 'return=minimal',
  }, env);

  if (!updateRes.ok) return err('Failed to flag task');

  await logActivity(task_id, ctx.userId, 'flag', {
    type: 'ext_blocked',
    reason: reason.trim(),
  }, env);

  console.log(`[Slack] Task "${task.title}" flagged ext_blocked by ${ctx.brandUser.name}. Reason: ${reason}`);

  return json({ ok: true });
}

// activity_log writer — columns: id, task_id, user_id, event_type, payload, created_at
// (id + created_at are DB-populated). Call-site passes (action, metadata) → map to
// (event_type, payload). Wrapped in try/catch so audit insert failures don't break
// the task operation they're logging.
async function logActivity(task_id, user_id, action, metadata, env) {
  try {
    const res = await sbFetch('activity_log', {
      method: 'POST',
      body: JSON.stringify({
        task_id,
        user_id,
        event_type: action,
        payload: metadata,
      }),
      prefer: 'return=minimal',
    }, env);
    if (!res.ok) {
      console.error('[logActivity] insert failed:', res.status, await res.text());
    }
  } catch (e) {
    console.error('[logActivity] threw:', e?.message || e);
  }
}
async function handleCreateSprint(body, ctx, env) {
  const g = requireRole(ctx, 'admin', 'lead'); if (g) return g;

  const { start_date, name } = body;
  if (!start_date) return err('start_date is required (YYYY-MM-DD)');

  // Validate Thursday
  const startDay = new Date(start_date).getDay();
  if (startDay !== 4) return err('Sprint must start on a Thursday');

  // Calculate end date (6 days after start = Wednesday)
  const startD = new Date(start_date);
  const endD = new Date(startD);
  endD.setDate(endD.getDate() + 6);
  const end_date = endD.toISOString().split('T')[0];

  // Count existing sprints for auto-naming
  const countRes = await sbFetch('sprints?select=id', { method: 'GET' }, env);
  const existing = countRes.ok ? await countRes.json() : [];
  const sprintNumber = existing.length + 1;

  const sprintName = name || `Sprint ${sprintNumber} — ${formatDateShort(startD)} to ${formatDateShort(endD)}`;

  // Check no active sprint overlaps (prevent duplicates)
  const activeRes = await sbFetch(
    `sprints?status=eq.active&select=id,name`,
    { method: 'GET' }, env
  );
  const activeSprints = activeRes.ok ? await activeRes.json() : [];
  if (activeSprints.length > 0) {
    return err(`Cannot create sprint — "${activeSprints[0].name}" is still active. Close it first.`);
  }

  const insertRes = await sbFetch('sprints', {
    method: 'POST',
    body: JSON.stringify({
      name: sprintName,
      start_date,
      end_date,
      status: 'active',
      created_by: ctx.userId,
    }),
  }, env);

  if (!insertRes.ok) {
    const e = await insertRes.json();
    return err(`Failed to create sprint: ${e.message || insertRes.status}`);
  }

  const [sprint] = await insertRes.json();

  console.log(`[Slack] Sprint created: "${sprintName}" by ${ctx.brandUser.name}`);

  return json({ ok: true, sprint });
}

async function handleCloseSprint(body, ctx, env) {
  const g = requireRole(ctx, 'admin', 'lead'); if (g) return g;
  const { sprint_id } = body;
  if (!sprint_id) return err('sprint_id is required');

  const result = await closeSprintById(sprint_id, ctx.userId, env);
  if (result.error) return err(result.error);

  return json({ ok: true, ...result });
}

async function handleAddTaskToSprint(body, ctx, env) {
  const g = requireRole(ctx, 'admin', 'lead'); if (g) return g;

  const { task_id, sprint_id, due_date } = body;
  if (!task_id || !sprint_id) return err('task_id and sprint_id are required');

  // Verify sprint exists and is active or planning
  const sprintRes = await sbFetch(`sprints?id=eq.${sprint_id}&select=id,name,status`, { method: 'GET' }, env);
  if (!sprintRes.ok) return err('Sprint not found');
  const [sprint] = await sprintRes.json();
  if (!sprint) return err('Sprint not found');
  if (sprint.status === 'closed') return err('Cannot add tasks to a closed sprint');

  // Verify task exists and is in backlog
  const taskRes = await sbFetch(`tasks?id=eq.${task_id}&select=id,title,stage`, { method: 'GET' }, env);
  if (!taskRes.ok) return err('Task not found');
  const [task] = await taskRes.json();
  if (!task) return err('Task not found');

  const update = {
    sprint_id,
    stage: 'in_sprint',
    updated_at: new Date().toISOString(),
  };
  if (due_date) update.due_date = due_date;

  const updateRes = await sbFetch(`tasks?id=eq.${task_id}`, {
    method: 'PATCH',
    body: JSON.stringify(update),
    prefer: 'return=minimal',
  }, env);

  if (!updateRes.ok) return err('Failed to add task to sprint');

  await logActivity(task_id, ctx.userId, 'stage_change', {
    from: task.stage,
    to: 'in_sprint',
    sprint_id,
  }, env);

  return json({ ok: true });
}

async function handleRemoveTaskFromSprint(body, ctx, env) {
  const g = requireRole(ctx, 'admin', 'lead'); if (g) return g;
  const { task_id } = body;
  if (!task_id) return err('task_id is required');

  const updateRes = await sbFetch(`tasks?id=eq.${task_id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      sprint_id: null,
      stage: 'backlog',
      due_date: null,
      updated_at: new Date().toISOString(),
    }),
    prefer: 'return=minimal',
  }, env);

  if (!updateRes.ok) return err('Failed to remove task from sprint');

  return json({ ok: true });
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
// ── Core sprint close logic — used by both manual close and cron ─────────────

async function closeSprintById(sprintId, closedByUserId, env) {
  // Fetch sprint
  const sprintRes = await sbFetch(`sprints?id=eq.${sprintId}&select=*`, { method: 'GET' }, env);
  if (!sprintRes.ok) return { error: 'Sprint not found' };
  const [sprint] = await sprintRes.json();
  if (!sprint) return { error: 'Sprint not found' };
  if (sprint.status === 'closed') return { error: 'Sprint is already closed' };

  // Fetch all tasks in this sprint
  const tasksRes = await sbFetch(
    `tasks?sprint_id=eq.${sprintId}&select=id,title,stage,spillover_count,is_spillover`,
    { method: 'GET' }, env
  );
  const allTasks = tasksRes.ok ? await tasksRes.json() : [];

  const doneTasks      = allTasks.filter(t => t.stage === 'done');
  const abandonedTasks = allTasks.filter(t => t.stage === 'abandoned');
  const spilloverTasks = allTasks.filter(t => !['done', 'abandoned'].includes(t.stage));

  // Calculate health score
  const total = allTasks.length;
  const eligible = allTasks.length - abandonedTasks.length; // denominator excludes abandoned
  const healthScore = {
    total_tasks: total,
    done_count: doneTasks.length,
    spillover_count: spilloverTasks.length,
    abandoned_count: abandonedTasks.length,
    completion_rate: eligible > 0 ? Math.round((doneTasks.length / eligible) * 100) : 0,
    spillover_rate: eligible > 0 ? Math.round((spilloverTasks.length / eligible) * 100) : 0,
  };

  // Update sprint to closed with health score
  await sbFetch(`sprints?id=eq.${sprintId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'closed',
      health_score: healthScore,
    }),
    prefer: 'return=minimal',
  }, env);

  // Flag spillover tasks — increment spillover_count, set is_spillover
  if (spilloverTasks.length > 0) {
    // Batch update — use IN filter
    const spilloverIds = spilloverTasks.map(t => t.id);

    // Cloudflare 50-subrequest limit — batch max 40 per call
    // For typical sprint sizes this is one call
    for (let i = 0; i < spilloverIds.length; i += 40) {
      const batch = spilloverIds.slice(i, i + 40);
      const inFilter = `(${batch.join(',')})`;
      await sbFetch(`tasks?id=in.${inFilter}`, {
        method: 'PATCH',
        body: JSON.stringify({
          is_spillover: true,
          sprint_id: null, // remove from closed sprint — will be added to new sprint below
          stage: 'backlog', // reset to backlog, re-added to new sprint
          updated_at: new Date().toISOString(),
        }),
        prefer: 'return=minimal',
      }, env);
    }

    // Flag escalations (spillover_count was already >= 1 before this sprint)
    const escalations = spilloverTasks.filter(t => t.spillover_count >= 1);

    // Increment spillover_count individually (no bulk increment in PostgREST without RPC)
    // Use an RPC for this — see note below
    // For now: update each task's spillover_count
    // CLOUDFLARE LIMIT: if > 40 spillovers, this could hit the 50-subrequest limit
    // Mitigation: sprint sizes are typically small (< 30 tasks)
    for (const task of spilloverTasks) {
      await sbFetch(`tasks?id=eq.${task.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          spillover_count: (task.spillover_count || 0) + 1,
        }),
        prefer: 'return=minimal',
      }, env);
    }

    healthScore.escalation_count = escalations.length;
  }

  // Create next sprint automatically
  const nextThursday = getNextThursdayAfter(sprint.end_date);
  const nextWednesday = new Date(nextThursday);
  nextWednesday.setDate(nextWednesday.getDate() + 6);

  const nextStartStr = nextThursday.toISOString().split('T')[0];
  const nextEndStr = nextWednesday.toISOString().split('T')[0];

  // Count sprints for number
  const countRes = await sbFetch('sprints?select=id', { method: 'GET' }, env);
  const allSprints = countRes.ok ? await countRes.json() : [];
  const nextNumber = allSprints.length + 1;

  const nextName = `Sprint ${nextNumber} — ${formatDateShort(nextThursday)} to ${formatDateShort(nextWednesday)}`;

  const newSprintRes = await sbFetch('sprints', {
    method: 'POST',
    body: JSON.stringify({
      name: nextName,
      start_date: nextStartStr,
      end_date: nextEndStr,
      status: 'active',
      created_by: closedByUserId || null,
    }),
  }, env);

  let newSprint = null;
  if (newSprintRes.ok) {
    const [ns] = await newSprintRes.json();
    newSprint = ns;

    // Add spillover tasks to new sprint as in_sprint
    if (spilloverTasks.length > 0) {
      const spilloverIds = spilloverTasks.map(t => t.id);
      for (let i = 0; i < spilloverIds.length; i += 40) {
        const batch = spilloverIds.slice(i, i + 40);
        const inFilter = `(${batch.join(',')})`;
        await sbFetch(`tasks?id=in.${inFilter}`, {
          method: 'PATCH',
          body: JSON.stringify({
            sprint_id: ns.id,
            stage: 'in_sprint',
            updated_at: new Date().toISOString(),
          }),
          prefer: 'return=minimal',
        }, env);
      }
    }
  }

  // Slack summary
  const summary = [
    `Sprint closed: "${sprint.name}"`,
    `✅ Done: ${doneTasks.length}`,
    `↩ Spillover: ${spilloverTasks.length}`,
    `🚫 Abandoned: ${abandonedTasks.length}`,
    `📊 Completion: ${healthScore.completion_rate}%`,
    newSprint ? `🆕 New sprint created: "${nextName}"` : '⚠️ Failed to create next sprint',
  ].join('\n');

  console.log(`[Slack] ${summary}`);

  return {
    closed_sprint: sprint.name,
    health_score: healthScore,
    new_sprint: newSprint,
    spillovers_carried: spilloverTasks.length,
  };
}

// ── Auto sprint close — runs on Cloudflare Cron ──────────────────────────────

async function runSprintClose(env) {
  console.log('[throttleops] Auto sprint close cron fired');

  // Guard: find active sprint(s)
  const activeRes = await sbFetch('sprints?status=eq.active&select=*', { method: 'GET' }, env);
  if (!activeRes.ok) {
    console.error('[sprintClose] Failed to fetch active sprints');
    return;
  }
  const activeSprints = await activeRes.json();

  if (activeSprints.length === 0) {
    console.log('[sprintClose] No active sprint found — nothing to close');
    return;
  }

  if (activeSprints.length > 1) {
    console.error(`[sprintClose] GUARD: ${activeSprints.length} active sprints found — aborting to prevent data corruption. Fix manually.`);
    return;
  }

  const sprint = activeSprints[0];

  // Verify sprint end_date is today or past
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endDate = new Date(sprint.end_date);
  endDate.setHours(0, 0, 0, 0);

  if (endDate > today) {
    console.log(`[sprintClose] Sprint "${sprint.name}" end date is ${sprint.end_date} — not closing yet`);
    return;
  }

  console.log(`[sprintClose] Closing sprint: "${sprint.name}"`);

  const result = await closeSprintById(sprint.id, null, env);

  if (result.error) {
    console.error(`[sprintClose] Error: ${result.error}`);
    return;
  }

  console.log(`[sprintClose] Done. Completion: ${result.health_score.completion_rate}%, Spillovers: ${result.spillovers_carried}`);
}

// ── Helper functions ──────────────────────────────────────────────────────────

function formatDateShort(date) {
  return new Date(date).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short'
  });
}

function getNextThursdayAfter(dateString) {
  const d = new Date(dateString);
  d.setDate(d.getDate() + 1); // day after end (Thursday after Wednesday)
  // Should already be Thursday — but verify
  while (d.getDay() !== 4) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}
