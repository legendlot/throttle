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

// ── Launch Pack items — duplicated from app/src/lib/requestTypes.js ──────────
// Worker needs this for approveRequest task generation
const LAUNCH_PACK_ITEMS = [
  { id: 'listing_images',  label: 'Listing Images',      discipline: 'designer',    deliverable_type: 'listing_image' },
  { id: 'aplus',           label: 'A+ / EBC Content',    discipline: 'designer',    deliverable_type: 'graphic' },
  { id: 'comic_graphics',  label: 'Comic (Graphics)',     discipline: 'designer',    deliverable_type: 'graphic' },
  { id: 'comic_script',    label: 'Comic (Script)',       discipline: 'copywriter',  deliverable_type: 'copy' },
  { id: 'box_sticker',     label: 'Box Sticker',          discipline: 'designer',    deliverable_type: 'graphic' },
  { id: 'manual',          label: 'Product Manual',       discipline: 'designer',    deliverable_type: 'graphic' },
  { id: 'packaging',       label: 'Packaging',            discipline: 'designer',    deliverable_type: 'graphic' },
  { id: 'pdp_video',       label: 'PDP Video',            discipline: 'photo_video', deliverable_type: 'video' },
  { id: 'tutorial_video',  label: 'Tutorial Video',       discipline: 'photo_video', deliverable_type: 'video' },
];

// ── Sale Event items — duplicated from app/src/lib/requestTypes.js ───────────
const SALE_EVENT_ITEMS = [
  { id: 'website_banner',   label: 'Website Banner',      discipline: 'designer',    deliverable_type: 'graphic'      },
  { id: 'social_static',    label: 'Social Static Post',  discipline: 'designer',    deliverable_type: 'social_post'  },
  { id: 'social_story',     label: 'Social Story',        discipline: 'designer',    deliverable_type: 'graphic'      },
  { id: 'reel',             label: 'Reel / Video',        discipline: 'photo_video', deliverable_type: 'video'        },
  { id: 'meta_ad_static',   label: 'Meta Ad (Static)',    discipline: 'designer',    deliverable_type: 'ad_creative'  },
  { id: 'meta_ad_video',    label: 'Meta Ad (Video)',     discipline: 'photo_video', deliverable_type: 'ad_creative'  },
  { id: 'google_display',   label: 'Google Display Ad',   discipline: 'designer',    deliverable_type: 'ad_creative'  },
  { id: 'email_header',     label: 'Email Header',        discipline: 'designer',    deliverable_type: 'graphic'      },
  { id: 'whatsapp_graphic', label: 'WhatsApp Graphic',    discipline: 'designer',    deliverable_type: 'graphic'      },
  { id: 'pdp_refresh',      label: 'PDP Refresh (Website)', discipline: 'designer',  deliverable_type: 'graphic'      },
  { id: 'homepage_changes', label: 'Homepage Changes',    discipline: 'designer',    deliverable_type: 'graphic'      },
  { id: 'layout_changes',   label: 'Layout Changes',      discipline: 'designer',    deliverable_type: 'graphic'      },
];

function deriveDeliverableType(requestType, templateData) {
  switch (requestType) {
    case 'product_creative':
      if (['PDP Video','Tutorial Video'].includes(templateData.asset_type)) return 'video'
      if (templateData.asset_type === 'Listing Images') return 'listing_image'
      if (templateData.asset_type === 'Comic') return 'graphic'
      return 'graphic'
    case 'social_media':
      if (['Reel','Video'].includes(templateData.format)) return 'video'
      if (templateData.format === 'Caption Only') return 'copy'
      return 'social_post'
    case 'advertising':
      if (templateData.ad_format === 'Video') return 'video'
      return 'ad_creative'
    case 'copy_script':
      return 'copy'
    case 'design_brand':
      if (templateData.asset_type === 'Presentation / Deck') return 'deck'
      return 'graphic'
    case '3d_motion':
      if (['Animation','3D for Social','AI Video'].includes(templateData.project_type)) return 'video'
      return '3d_render'
    default:
      return 'other'
  }
}

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

// ── Slack notification helpers ────────────────────────────────────────────────

/**
 * Send to #throttle-ops — admin/management events
 * New requests, approvals, sprint summaries, blockers, overdue
 */
async function slackOps(message, env) {
  if (!env.SLACK_WEBHOOK_OPS) {
    console.log('[Slack:ops]', message);
    return;
  }
  try {
    await fetch(env.SLACK_WEBHOOK_OPS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
    });
  } catch (e) {
    console.error('[Slack:ops] Failed to send:', e.message);
  }
}

/**
 * Send to #throttle-team — personal events for team members
 * Task assigned, work approved/rejected, request status updates
 */
async function slackTeam(message, env) {
  if (!env.SLACK_WEBHOOK_TEAM) {
    console.log('[Slack:team]', message);
    return;
  }
  try {
    await fetch(env.SLACK_WEBHOOK_TEAM, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
    });
  } catch (e) {
    console.error('[Slack:team] Failed to send:', e.message);
  }
}

/**
 * Send to both channels
 */
async function slackBoth(message, env) {
  await Promise.all([slackOps(message, env), slackTeam(message, env)]);
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

    let brandUser = await getBrandUser(authUser.id, env);
    if (!brandUser) {
      // First-time Throttle login self-heal: staff already exist in auth.users
      // from Garage/Redline, so on_auth_user_created never fires for them.
      // Provision a default 'requester' row now so they aren't locked out.
      const name = authUser.user_metadata?.full_name
        || authUser.email?.split('@')[0]
        || 'Unknown';
      const insertRes = await sbFetch('users', {
        method: 'POST',
        body: JSON.stringify({
          id: authUser.id,
          name,
          email: authUser.email,
          role: 'requester',
        }),
      }, env);
      if (insertRes.ok) {
        const rows = await insertRes.json();
        brandUser = rows[0] || null;
        console.log(`[autoCreateBrandUser] provisioned ${authUser.email} as requester (id=${authUser.id})`);
      } else {
        const body = await insertRes.text();
        console.warn(`[autoCreateBrandUser] insert ${insertRes.status}: ${body.slice(0, 200)} — refetching`);
        brandUser = await getBrandUser(authUser.id, env);
      }
      if (!brandUser) return err('Failed to auto-provision user account', 500);
    }

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

    try {
    // return AWAIT the dispatch (via an IIFE) so async handler rejections are
    // caught here — `case X: return handleX(...)` returns the promise unawaited,
    // so a rejection would otherwise escape this try/catch as a CORS-less 500.
    return await (async () => {
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
      case 'getDashboardStats':   return handleGetDashboardStats(body, ctx, env);
      case 'getDeliverablesReport': return handleGetDeliverablesReport(body, ctx, env);
      case 'getTeamWorkload':     return handleGetTeamWorkload(body, ctx, env);
      case 'getTasksInBucket':    return handleGetTasksInBucket(body, ctx, env);
      case 'updateRequest':       return handleUpdateRequest(body, ctx, env);
      case 'getTaskActivity':     return handleGetTaskActivity(body, ctx, env);
      case 'getRecentActivity':   return handleGetRecentActivity(body, ctx, env);
      case 'addComment':          return handleAddComment(body, ctx, env);
      case 'getTeamMembers':      return handleGetTeamMembers(body, ctx, env);
      case 'updateTaskMeta':     return handleUpdateTaskMeta(body, ctx, env);
      case 'getProducts':        return handleGetProducts(body, ctx, env);
      case 'migrateOwners':     return handleMigrateOwners(body, ctx, env);
      case 'deliverTask':           return handleDeliverTask(body, ctx, env);
      case 'submitBatchFeedback':   return handleSubmitBatchFeedback(body, ctx, env);
      case 'markTaskDone':          return handleMarkTaskDone(body, ctx, env);
      case 'getRequestDelivery':    return handleGetRequestDelivery(body, ctx, env);
      case 'getAgeingConfig':       return handleGetAgeingConfig(body, ctx, env);
      case 'updateAgeingConfig':    return handleUpdateAgeingConfig(body, ctx, env);
      // ── Social Media Management ──────────────────────────────────────────
      case 'getChannels':           return handleGetChannels(body, ctx, env);
      case 'getCampaigns':          return handleGetCampaigns(body, ctx, env);
      case 'createCampaign':        return handleCreateCampaign(body, ctx, env);
      case 'getSocialFeed':         return handleGetSocialFeed(body, ctx, env);
      case 'getSocialPost':         return handleGetSocialPost(body, ctx, env);
      case 'createSocialPost':      return handleCreateSocialPost(body, ctx, env);
      case 'updateSocialPost':      return handleUpdateSocialPost(body, ctx, env);
      case 'deleteSocialPost':      return handleDeleteSocialPost(body, ctx, env);
      case 'publishVariant':        return handlePublishVariant(body, ctx, env);
      case 'updatePostStatus':      return handleUpdatePostStatus(body, ctx, env);
      case 'linkTaskToPost':        return handleLinkTaskToPost(body, ctx, env);
      case 'updateCampaign':        return handleUpdateCampaign(body, ctx, env);
      case 'searchTasksForSocial':  return handleSearchTasksForSocial(body, ctx, env);
      case 'getSocialMonitoring':   return handleGetSocialMonitoring(body, ctx, env);
      case 'syncSocialInsights':    return handleSyncSocialInsights(body, ctx, env);
      case 'getSocialAnalytics':    return handleGetSocialAnalytics(body, ctx, env);
      case 'getIgComments':         return handleGetIgComments(body, ctx, env);
      case 'replyIgComment':        return handleReplyIgComment(body, ctx, env);
      default:
        return err(`Unknown action: ${action}`, 404);
    }
    })();
    } catch (e) {
      console.error('[throttleops] handler error', action, e?.stack || e);
      return err(`${action} failed: ${e?.message || e}`, 500);
    }
  },

  async scheduled(event, env, ctx) {
    // Two crons (wrangler.toml): "29 18 * * 3" = weekly sprint close (Wed);
    // "30 20 * * *" = daily social-analytics snapshot. Sprint close must fire
    // ONLY on the Wed tick — without this gate the daily cron would close
    // sprints every night.
    if (event.cron === '29 18 * * 3') ctx.waitUntil(runSprintClose(env));
    // Social sync runs on every tick (weekly Wed + the daily 02:00 IST snapshot)
    // so follower_count + reach accumulate one row per day for trend/gain math.
    ctx.waitUntil(runSocialSync(env).catch(e => console.error('[socialSync]', e)));
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
  const validDisciplines = ['designer', '3d', 'copywriter', 'photo_video', 'social_media', 'lead', null];

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

  const validTypes = ['social','campaign','design','copy','photo_video','3d','deck','ad',
    'launch_pack','product_creative','social_media','advertising','photo_video_new',
    'copy_script','design_brand','3d_motion','brand_initiative','sale_event'];
  if (!validTypes.includes(type)) return err('Invalid request type');

  // INSERT request
  const reqRes = await sbFetch('requests', {
    method: 'POST',
    body: JSON.stringify({
      type,
      title,
      template_data: template_data || {},
      is_product_scoped: !!is_product_scoped,
      brand_team_only: type === 'brand_initiative',
      status: 'pending',
      requester_id: ctx.userId,
      required_by: template_data?.deadline || null,
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

  await slackOps(`📥 *New request submitted*\n*"${title}"* (${type})\nSubmitted by: ${ctx.brandUser.name}\nProducts: ${is_product_scoped ? products.map(p => p.product_name).join(', ') : 'N/A'}`, env);

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

  // Fetch linked products
  const rpRes = await sbFetch(`request_products?request_id=eq.${request_id}&select=*`, { method: 'GET' }, env);
  const requestProducts = rpRes.ok ? await rpRes.json() : [];

  const approveNote = note || '';
  const templateData = request.template_data || {};
  const isProductScoped = request.is_product_scoped;
  let tasksCreated = 0;

  // Helper: insert a single task row and log activity
  async function createTask(overrides) {
    const taskRow = {
      request_id,
      stage: 'backlog',
      priority: 'medium',
      is_spillover: false,
      spillover_count: 0,
      ...overrides,
    };
    const res = await sbFetch('tasks', { method: 'POST', body: JSON.stringify(taskRow) }, env);
    if (!res.ok) {
      const errorBody = await res.text();
      console.error('[approveRequest] Failed to create task:', errorBody);
      throw new Error(`Task INSERT failed: ${errorBody}`);
    }
    const [created] = await res.json();
    tasksCreated++;
    return created;
  }

  // ── Type-specific task creation ────────────────────────────────────────────
  try {

  if (request.type === 'launch_pack') {
    // One task per checked launch pack item, for the single product
    const product = requestProducts[0];
    const checkedItems = templateData.checklist || [];
    const batchId = crypto.randomUUID();

    for (const itemId of checkedItems) {
      const item = LAUNCH_PACK_ITEMS.find(i => i.id === itemId);
      if (!item) continue;
      await createTask({
        product_code: product?.product_code || null,
        batch_id: batchId,
        title: `${item.label} — ${product?.product_code || 'Unknown'}`,
        type: 'launch_pack',
        deliverable_type: item.deliverable_type,
        is_revision: false,
        due_date: templateData.deadline || null,
        notes: `Launch pack item. Assign to: ${item.discipline}. ${approveNote}`.trim(),
      });
    }

  } else if (request.type === 'photo_video_new') {
    // Two tasks per product: shoot + edit (if edit_required = 'Yes')
    const editRequired = templateData.edit_required === 'Yes';
    const targetProducts = isProductScoped && requestProducts.length > 0 ? requestProducts : [null];

    for (const product of targetProducts) {
      const batchId = crypto.randomUUID();
      const productSuffix = product ? ` — ${product.product_code}` : '';
      const pvChannelNote = templateData.channel?.length
        ? `Channel: ${Array.isArray(templateData.channel) ? templateData.channel.join(', ') : templateData.channel}.`
        : '';
      const pvRefNote = templateData.reference?.length
        ? `Refs: ${Array.isArray(templateData.reference) ? templateData.reference.join(' | ') : templateData.reference}.`
        : '';

      await createTask({
        product_code: product?.product_code || null,
        batch_id: batchId,
        title: `${request.title} — Shoot${productSuffix}`,
        type: 'photo_video_new',
        deliverable_type: templateData.delivery_format?.includes('MP4') || templateData.delivery_format?.includes('MOV') ? 'video' : 'photo',
        is_revision: false,
        notes: [pvChannelNote, pvRefNote, approveNote].filter(Boolean).join(' '),
      });

      if (editRequired) {
        await createTask({
          product_code: product?.product_code || null,
          batch_id: batchId,
          title: `${request.title} — Edit${productSuffix}`,
          type: 'photo_video_new',
          deliverable_type: 'video',
          is_revision: false,
          notes: [`Requires shoot task to be completed first.`, pvChannelNote, pvRefNote, approveNote].filter(Boolean).join(' '),
        });
      }
    }

  } else if (request.type === 'brand_initiative') {
    // Parse deliverables (one per line) and create one task per line
    const deliverableLines = (templateData.deliverables || '')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
    const batchId = deliverableLines.length > 1 ? crypto.randomUUID() : null;

    for (const deliverable of deliverableLines) {
      await createTask({
        product_code: null,
        batch_id: batchId,
        title: `${request.title}: ${deliverable}`,
        type: 'brand_initiative',
        deliverable_type: 'other',
        is_revision: false,
        notes: `Initiative: ${templateData.initiative_name}. ${approveNote}`.trim(),
      });
    }

  } else if (request.type === 'sale_event') {
    // One task per checked deliverable item
    // Products are informational context — tasks are not multiplied per product
    const checkedItems = templateData.checklist || [];
    const saleName = templateData.sale_name || request.title;
    const batchId = checkedItems.length > 1 ? crypto.randomUUID() : null;

    for (const itemId of checkedItems) {
      const item = SALE_EVENT_ITEMS.find(i => i.id === itemId);
      if (!item) continue;
      await createTask({
        product_code: null,
        batch_id: batchId,
        title: `${saleName}: ${item.label}`,
        type: 'sale_event',
        deliverable_type: item.deliverable_type,
        is_revision: false,
        notes: [
          templateData.scope ? `Scope: ${templateData.scope}` : '',
          templateData.channels?.length ? `Channels: ${templateData.channels.join(', ')}` : '',
          templateData.offline_scope ? `Offline scope: ${templateData.offline_scope}` : '',
          templateData.sale_start ? `Sale live: ${templateData.sale_start}` : '',
          templateData.sale_end ? `Sale ends: ${templateData.sale_end}` : '',
          approveNote,
        ].filter(Boolean).join('. '),
      });
    }

  } else {
    // All other types: one task per product (or one if not product-scoped)
    const isRevision = templateData.is_revision === 'Revision';
    const targetProducts = isProductScoped && requestProducts.length > 0 ? requestProducts : [null];
    const batchId = targetProducts.length > 1 ? crypto.randomUUID() : null;

    for (const product of targetProducts) {
      const productSuffix = product ? ` — ${product.product_code}` : '';
      const channelNote = templateData.channel?.length
        ? `Channel: ${Array.isArray(templateData.channel) ? templateData.channel.join(', ') : templateData.channel}.`
        : '';
      const refNote = templateData.reference?.length
        ? `Refs: ${Array.isArray(templateData.reference) ? templateData.reference.join(' | ') : templateData.reference}.`
        : '';
      await createTask({
        product_code: product?.product_code || null,
        batch_id: batchId,
        title: `${request.title}${productSuffix}`,
        type: request.type,
        deliverable_type: deriveDeliverableType(request.type, templateData),
        is_revision: isRevision,
        notes: [channelNote, refNote, approveNote].filter(Boolean).join(' '),
      });
    }
  }

  } catch (taskErr) {
    console.error('[approveRequest] Task creation aborted:', taskErr.message);
    return err(`Approval succeeded but task creation failed: ${taskErr.message}`);
  }

  await slackOps(`✅ *Request approved*\n*"${request.title}"*\nApproved by: ${ctx.brandUser.name}\n${tasksCreated} task(s) created in backlog`, env);
  await slackTeam(`✅ *Request approved: "${request.title}"*\n${tasksCreated} task(s) created and ready for sprint planning`, env);

  return json({ ok: true, tasks_created: tasksCreated });
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

  await slackTeam(`❌ *Request rejected: "${request.title}"*\nRejected by: ${ctx.brandUser.name}\nReason: ${note}`, env);

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

  await slackTeam(`ℹ️ *More info needed: "${request.title}"*\nFrom: ${ctx.brandUser.name}\nNote: ${note}`, env);

  return json({ ok: true });
}
async function handleCreateTask(body, ctx, env) {
  const g = requireRole(ctx, 'admin', 'lead'); if (g) return g;
  return err('Not implemented yet', 501);
}
async function handleUpdateTaskStage(body, ctx, env) {
  const { task_id, stage, blocked_reason } = body;
  if (!task_id || !stage) return err('task_id and stage are required');

  const validStages = ['backlog','in_sprint','in_progress','ext_blocked','in_review','approved','delivered','done','abandoned'];
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
    approved: ['delivered', 'done', 'in_review', 'abandoned'],
    delivered: ['done', 'in_progress', 'abandoned'],
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

  const now = new Date().toISOString();
  if (stage === 'in_progress') update.in_progress_at = now;
  if (stage === 'in_review')   update.in_review_at   = now;
  if (stage === 'approved')    update.approved_at    = now;
  if (stage === 'done')        { update.completed_at = now; update.auto_close_at = null; }
  if (stage === 'abandoned')   update.abandoned_at   = now;

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

  // Only notify on significant moves — not every in_progress update
  const notifyStages = ['in_review', 'approved', 'done', 'abandoned', 'ext_blocked'];
  if (notifyStages.includes(stage)) {
    if (stage === 'ext_blocked') {
      await slackOps(`⚠️ *Task externally blocked*\n*"${task.title}"*\nBlocked by: ${ctx.brandUser.name}\nReason: ${blocked_reason}`, env);
    } else if (stage === 'in_review') {
      await slackOps(`👀 *Work submitted for review*\n*"${task.title}"*\nSubmitted by: ${ctx.brandUser.name}`, env);
    } else if (stage === 'done') {
      await slackTeam(`🎉 *Task completed: "${task.title}"*`, env);
    } else if (stage === 'abandoned') {
      await slackOps(`🚫 *Task abandoned: "${task.title}"*\nBy: ${ctx.brandUser.name}\nReason: ${blocked_reason}`, env);
    }
  }

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
  const { taskId, userId, action: assignAction } = body;
  // Also support legacy field names for backward compat during deploy
  const tId = taskId || body.task_id;
  const act = assignAction || null;

  if (!tId || !act) return err('taskId and action are required');

  // ── SELF ASSIGN AS OWNER ──────────────────────────────────────────────────
  if (act === 'self_assign_owner') {
    // Check if task already has an owner
    const ownerRes = await sbFetch(`task_assignees?task_id=eq.${tId}&is_owner=eq.true&select=id`, { method: 'GET' }, env);
    const owners = ownerRes.ok ? await ownerRes.json() : [];
    if (owners.length > 0) return err('Task already has an owner. Only admin or lead can reassign.', 403);

    // Remove any existing non-owner entry for this user
    await sbFetch(`task_assignees?task_id=eq.${tId}&user_id=eq.${ctx.userId}`, { method: 'DELETE', prefer: 'return=minimal' }, env);

    await sbFetch('task_assignees', {
      method: 'POST',
      body: JSON.stringify([{ task_id: tId, user_id: ctx.userId, is_owner: true, assigned_by: ctx.userId }]),
      prefer: 'return=minimal',
    }, env);

    await logActivity(tId, ctx.userId, 'assignment', { assignee_id: ctx.userId, assignee_name: ctx.brandUser?.name || 'Unknown', role: 'owner', action: 'self_assigned_owner' }, env);
    return json({ ok: true });
  }

  // ── SELF ADD AS COLLABORATOR ──────────────────────────────────────────────
  if (act === 'self_add_collaborator') {
    const existRes = await sbFetch(`task_assignees?task_id=eq.${tId}&user_id=eq.${ctx.userId}&select=id`, { method: 'GET' }, env);
    const existing = existRes.ok ? await existRes.json() : [];
    if (existing.length > 0) return err('You are already assigned to this task', 400);

    await sbFetch('task_assignees', {
      method: 'POST',
      body: JSON.stringify([{ task_id: tId, user_id: ctx.userId, is_owner: false, assigned_by: ctx.userId }]),
      prefer: 'return=minimal',
    }, env);

    await logActivity(tId, ctx.userId, 'assignment', { assignee_id: ctx.userId, assignee_name: ctx.brandUser?.name || 'Unknown', role: 'collaborator', action: 'self_added_collaborator' }, env);
    return json({ ok: true });
  }

  // ── REMOVE SELF ───────────────────────────────────────────────────────────
  if (act === 'remove_self') {
    await sbFetch(`task_assignees?task_id=eq.${tId}&user_id=eq.${ctx.userId}`, { method: 'DELETE', prefer: 'return=minimal' }, env);
    await logActivity(tId, ctx.userId, 'assignment', { assignee_id: ctx.userId, assignee_name: ctx.brandUser?.name || 'Unknown', action: 'removed_self' }, env);
    return json({ ok: true });
  }

  // ── ADD COLLABORATOR (any user) — member, lead, admin ─────────────────────
  if (act === 'add_collaborator') {
    if (!userId) return err('userId is required');
    const existRes = await sbFetch(`task_assignees?task_id=eq.${tId}&user_id=eq.${userId}&select=id`, { method: 'GET' }, env);
    const existing = existRes.ok ? await existRes.json() : [];
    if (existing.length > 0) return err('User already assigned to this task', 400);

    // Fetch assignee name
    const nameRes = await sbFetch(`users?id=eq.${userId}&select=name`, { method: 'GET' }, env);
    const nameRows = nameRes.ok ? await nameRes.json() : [];
    const assigneeName = nameRows[0]?.name || 'Unknown';

    await sbFetch('task_assignees', {
      method: 'POST',
      body: JSON.stringify([{ task_id: tId, user_id: userId, is_owner: false, assigned_by: ctx.userId }]),
      prefer: 'return=minimal',
    }, env);

    await logActivity(tId, ctx.userId, 'assignment', { assignee_id: userId, assignee_name: assigneeName, role: 'collaborator', action: 'added_collaborator' }, env);
    return json({ ok: true });
  }

  // ── SET OWNER — admin/lead only ───────────────────────────────────────────
  if (act === 'set_owner') {
    const g = requireRole(ctx, 'admin', 'lead'); if (g) return g;
    if (!userId) return err('userId is required');

    const nameRes = await sbFetch(`users?id=eq.${userId}&select=name`, { method: 'GET' }, env);
    const nameRows = nameRes.ok ? await nameRes.json() : [];
    const assigneeName = nameRows[0]?.name || 'Unknown';

    // Remove existing owner
    await sbFetch(`task_assignees?task_id=eq.${tId}&is_owner=eq.true`, { method: 'DELETE', prefer: 'return=minimal' }, env);
    // Remove this user's collaborator entry if present
    await sbFetch(`task_assignees?task_id=eq.${tId}&user_id=eq.${userId}`, { method: 'DELETE', prefer: 'return=minimal' }, env);

    await sbFetch('task_assignees', {
      method: 'POST',
      body: JSON.stringify([{ task_id: tId, user_id: userId, is_owner: true, assigned_by: ctx.userId }]),
      prefer: 'return=minimal',
    }, env);

    await logActivity(tId, ctx.userId, 'assignment', { assignee_id: userId, assignee_name: assigneeName, role: 'owner', action: 'set_owner' }, env);
    await slackTeam(`📋 *${assigneeName}* assigned as owner of a task by ${ctx.brandUser.name}`, env);
    return json({ ok: true });
  }

  // ── REMOVE ASSIGNEE — admin/lead only ────────────────────────────────────
  if (act === 'remove_assignee') {
    const g = requireRole(ctx, 'admin', 'lead'); if (g) return g;
    if (!userId) return err('userId is required');

    const nameRes = await sbFetch(`users?id=eq.${userId}&select=name`, { method: 'GET' }, env);
    const nameRows = nameRes.ok ? await nameRes.json() : [];

    await sbFetch(`task_assignees?task_id=eq.${tId}&user_id=eq.${userId}`, { method: 'DELETE', prefer: 'return=minimal' }, env);
    await logActivity(tId, ctx.userId, 'assignment', { assignee_id: userId, assignee_name: nameRows[0]?.name || 'Unknown', action: 'removed_by_admin' }, env);
    return json({ ok: true });
  }

  return err('Invalid assignment action', 400);
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

  await slackOps(`🚫 *Task abandoned: "${task.title}"*\nBy: ${ctx.brandUser.name}\nReason: ${reason}`, env);

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

  await slackOps(`⚠️ *External blocker flagged*\n*"${task.title}"*\nBy: ${ctx.brandUser.name}\nBlocker: ${reason}`, env);

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

  await slackOps(`🆕 *Sprint created*\n*"${sprintName}"*\nCreated by: ${ctx.brandUser.name}`, env);

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
  const { task_id, attachment_url, attachment_label } = body;
  if (!task_id) return err('task_id is required');
  if (!attachment_url) return err('A deliverable link or file URL is required to submit for review');

  // Verify task exists and assignee is submitting
  const fetchRes = await sbFetch(
    `tasks?id=eq.${task_id}&select=id,title,stage,type,deliverable_type`,
    { method: 'GET' }, env
  );
  if (!fetchRes.ok) return err('Task not found');
  const [task] = await fetchRes.json();
  if (!task) return err('Task not found');

  if (task.stage === 'done' || task.stage === 'abandoned') {
    return err(`Task is already ${task.stage}`);
  }

  // Check assignee (unless admin/lead)
  if (!['admin', 'lead'].includes(ctx.role)) {
    const assigneeRes = await sbFetch(
      `task_assignees?task_id=eq.${task_id}&user_id=eq.${ctx.userId}&select=task_id`,
      { method: 'GET' }, env
    );
    const rows = assigneeRes.ok ? await assigneeRes.json() : [];
    if (!rows.length) return err('You are not assigned to this task');
  }

  // Add attachment
  if (attachment_url) {
    await sbFetch('task_attachments', {
      method: 'POST',
      body: JSON.stringify({
        task_id,
        type: 'link',
        url: attachment_url,
        label: attachment_label || 'Deliverable',
        uploaded_by: ctx.userId,
      }),
      prefer: 'return=minimal',
    }, env);
  }

  // Move to in_review
  await sbFetch(`tasks?id=eq.${task_id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      stage: 'in_review',
      updated_at: new Date().toISOString(),
    }),
    prefer: 'return=minimal',
  }, env);

  await logActivity(task_id, ctx.userId, 'stage_change', {
    from: task.stage,
    to: 'in_review',
    attachment_url,
  }, env);

  await slackOps(`👀 *Work submitted for review*\n*"${task.title}"*\nSubmitted by: ${ctx.brandUser.name}\nDeliverable: ${attachment_url}`, env);

  return json({ ok: true });
}

async function handleApproveWork(body, ctx, env) {
  const g = requireRole(ctx, 'admin', 'lead'); if (g) return g;

  const { task_id, feedback } = body;
  if (!task_id) return err('task_id is required');

  const fetchRes = await sbFetch(
    `tasks?id=eq.${task_id}&select=id,title,stage,request_id`,
    { method: 'GET' }, env
  );
  if (!fetchRes.ok) return err('Task not found');
  const [task] = await fetchRes.json();
  if (!task) return err('Task not found');
  if (task.stage !== 'in_review') return err('Task is not in review');

  // INSERT approval record
  await sbFetch('approvals', {
    method: 'POST',
    body: JSON.stringify({
      task_id,
      reviewer_id: ctx.userId,
      decision: 'approved',
      feedback: feedback || null,
    }),
    prefer: 'return=minimal',
  }, env);

  // Move to approved — assignee then delivers to requester
  const nowApproved = new Date().toISOString();
  await sbFetch(`tasks?id=eq.${task_id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      stage: 'approved',
      approved_at: nowApproved,
      updated_at: nowApproved,
    }),
    prefer: 'return=minimal',
  }, env);

  await logActivity(task_id, ctx.userId, 'approval', {
    decision: 'approved',
    feedback: feedback || null,
  }, env);

  await slackTeam(`✅ *Work approved internally: "${task.title}"*\nApproved by: ${ctx.brandUser?.name || ctx.name}${feedback ? `\nNote: ${feedback}` : ''}\nTask is now ready to deliver to the requester.`, env);

  return json({ ok: true });
}

async function handleRejectWork(body, ctx, env) {
  const g = requireRole(ctx, 'admin', 'lead'); if (g) return g;

  const { task_id, feedback } = body;
  if (!task_id) return err('task_id is required');
  if (!feedback?.trim()) return err('Feedback is required when rejecting work');

  const fetchRes = await sbFetch(
    `tasks?id=eq.${task_id}&select=id,title,stage`,
    { method: 'GET' }, env
  );
  if (!fetchRes.ok) return err('Task not found');
  const [task] = await fetchRes.json();
  if (!task) return err('Task not found');
  if (task.stage !== 'in_review') return err('Task is not in review');

  // INSERT approval record
  await sbFetch('approvals', {
    method: 'POST',
    body: JSON.stringify({
      task_id,
      reviewer_id: ctx.userId,
      decision: 'rejected',
      feedback: feedback.trim(),
    }),
    prefer: 'return=minimal',
  }, env);

  // Move back to in_progress
  await sbFetch(`tasks?id=eq.${task_id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      stage: 'in_progress',
      updated_at: new Date().toISOString(),
    }),
    prefer: 'return=minimal',
  }, env);

  await logActivity(task_id, ctx.userId, 'approval', {
    decision: 'rejected',
    feedback: feedback.trim(),
  }, env);

  await slackTeam(`🔄 *Work needs revision: "${task.title}"*\nReviewed by: ${ctx.brandUser.name}\nFeedback: ${feedback}`, env);

  return json({ ok: true });
}
// ── Phase 9: Request Resubmit, Activity Feed, Person Filter ─────────────────

async function handleUpdateRequest(body, ctx, env) {
  const { requestId, title, templateData, is_product_scoped, products } = body;
  if (!requestId) return err('requestId is required');

  // Fetch the request
  const fetchRes = await sbFetch(`requests?id=eq.${requestId}&select=*`, { method: 'GET' }, env);
  if (!fetchRes.ok) return err('Request not found', 404);
  const [req] = await fetchRes.json();
  if (!req) return err('Request not found', 404);

  // Only the requester can update
  if (req.requester_id !== ctx.userId) return err('Forbidden', 403);

  // The requester may edit their own request while it is still pending or
  // awaiting more info — not once it has been approved / rejected / actioned.
  if (req.status !== 'info_needed' && req.status !== 'pending') {
    return err('Only a pending or info-needed request can be edited', 400);
  }

  // Build PATCH body — only include fields that were sent
  const patch = {
    template_data: templateData,
    status: 'pending',
    review_note: null,
    reviewer_id: null,
    reviewed_at: null,
  };
  if (typeof title === 'string') {
    const trimmed = title.trim();
    if (!trimmed) return err('Title cannot be empty');
    patch.title = trimmed;
  }
  if (typeof is_product_scoped === 'boolean') {
    patch.is_product_scoped = is_product_scoped;
  }

  const updateRes = await sbFetch(`requests?id=eq.${requestId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
    prefer: 'return=minimal',
  }, env);

  if (!updateRes.ok) return err('Failed to update request');

  // If products array was sent, replace request_products rows
  // (caller is authoritative — delete existing, insert fresh)
  if (Array.isArray(products)) {
    const delRes = await sbFetch(
      `request_products?request_id=eq.${requestId}`,
      { method: 'DELETE', prefer: 'return=minimal' },
      env
    );
    if (!delRes.ok) {
      console.error('[updateRequest] Failed to delete old request_products:', await delRes.text());
    }

    const shouldInsert = (is_product_scoped !== false) && products.length > 0;
    if (shouldInsert) {
      const productRows = products.map(p => ({
        request_id: requestId,
        product_code: p.product_name, // mirrors submitRequest — selector keys on name
        product_notes: p.notes || null,
      }));

      const rpRes = await sbFetch('request_products', {
        method: 'POST',
        body: JSON.stringify(productRows),
        prefer: 'return=minimal',
      }, env);
      if (!rpRes.ok) {
        console.error('[updateRequest] Failed to insert request_products:', await rpRes.text());
      }
    }
  }

  const finalTitle = patch.title || req.title;
  await slackOps(`📋 *Request Updated* — "${finalTitle}" has been updated and is back in the approval queue.`, env);

  return json({ ok: true });
}

async function handleGetTaskActivity(body, ctx, env) {
  const { taskId } = body;
  if (!taskId) return err('taskId is required');

  // Members can only view activity on tasks they're assigned to
  if (ctx.role === 'member') {
    const assigneeRes = await sbFetch(
      `task_assignees?task_id=eq.${taskId}&user_id=eq.${ctx.userId}&select=task_id`,
      { method: 'GET' }, env
    );
    const rows = assigneeRes.ok ? await assigneeRes.json() : [];
    if (!rows.length) return err('Forbidden', 403);
  }

  // Fetch activity log entries
  const actRes = await sbFetch(
    `activity_log?task_id=eq.${taskId}&select=*&order=created_at.asc`,
    { method: 'GET' }, env
  );
  const activity = actRes.ok ? await actRes.json() : [];

  // Fetch user names for all entries
  const userIds = [...new Set(activity.map(a => a.user_id).filter(Boolean))];
  let usersMap = {};
  if (userIds.length > 0) {
    const usersRes = await sbFetch(
      `users?id=in.(${userIds.join(',')})&select=id,name,role`,
      { method: 'GET' }, env
    );
    const users = usersRes.ok ? await usersRes.json() : [];
    users.forEach(u => { usersMap[u.id] = u; });
  }

  // Attach user info
  const enriched = activity.map(a => ({
    ...a,
    user: usersMap[a.user_id] || null,
  }));

  return json({ activity: enriched });
}

// Recent activity across all tasks — powers the Dashboard activity feed.
// admin/lead see the whole org; members are scoped to their assigned tasks;
// requesters get nothing. Joins user names + task titles/product.
async function handleGetRecentActivity(body, ctx, env) {
  const limit = Math.min(Number(body.limit) || 12, 40);
  if (ctx.role === 'requester') return json({ activity: [] });

  let taskFilter = '';
  if (ctx.role === 'member') {
    const aRes = await sbFetch(
      `task_assignees?user_id=eq.${ctx.userId}&select=task_id`, { method: 'GET' }, env
    );
    const rows = aRes.ok ? await aRes.json() : [];
    const ids = [...new Set(rows.map(r => r.task_id).filter(Boolean))];
    if (!ids.length) return json({ activity: [] });
    taskFilter = `&task_id=in.(${ids.join(',')})`;
  }

  const actRes = await sbFetch(
    `activity_log?select=id,task_id,user_id,event_type,payload,created_at&order=created_at.desc&limit=${limit}${taskFilter}`,
    { method: 'GET' }, env
  );
  const activity = actRes.ok ? await actRes.json() : [];

  const userIds = [...new Set(activity.map(a => a.user_id).filter(Boolean))];
  const taskIds = [...new Set(activity.map(a => a.task_id).filter(Boolean))];
  let usersMap = {}, tasksMap = {};
  if (userIds.length > 0) {
    const r = await sbFetch(`users?id=in.(${userIds.join(',')})&select=id,name,role`, { method: 'GET' }, env);
    const u = r.ok ? await r.json() : [];
    u.forEach(x => { usersMap[x.id] = x; });
  }
  if (taskIds.length > 0) {
    const r = await sbFetch(`tasks?id=in.(${taskIds.join(',')})&select=id,title,task_number,product_code`, { method: 'GET' }, env);
    const t = r.ok ? await r.json() : [];
    t.forEach(x => { tasksMap[x.id] = x; });
  }

  const enriched = activity.map(a => ({
    ...a,
    user: usersMap[a.user_id] || null,
    task: tasksMap[a.task_id] || null,
  }));
  return json({ activity: enriched });
}

async function handleAddComment(body, ctx, env) {
  const { taskId, comment } = body;
  if (!taskId) return err('taskId is required');
  if (!comment?.trim()) return err('Comment cannot be empty', 400);

  // Members can only comment on tasks they're assigned to
  if (ctx.role === 'member') {
    const assigneeRes = await sbFetch(
      `task_assignees?task_id=eq.${taskId}&user_id=eq.${ctx.userId}&select=task_id`,
      { method: 'GET' }, env
    );
    const rows = assigneeRes.ok ? await assigneeRes.json() : [];
    if (!rows.length) return err('Forbidden', 403);
  }

  const insertRes = await sbFetch('activity_log', {
    method: 'POST',
    body: JSON.stringify({
      task_id: taskId,
      user_id: ctx.userId,
      event_type: 'comment',
      payload: { comment: comment.trim() },
    }),
    prefer: 'return=minimal',
  }, env);

  if (!insertRes.ok) return err('Failed to add comment');

  return json({ ok: true });
}

async function handleGetTeamMembers(body, ctx, env) {
  const g = requireRole(ctx, 'admin', 'lead', 'member'); if (g) return g;

  const res = await sbFetch(
    `users?role=in.(member,lead)&select=id,name,discipline,role&order=name.asc`,
    { method: 'GET' }, env
  );
  const members = res.ok ? await res.json() : [];
  return json({ members });
}

// ── Phase 11a: Migration ─────────────────────────────────────────────────────

async function handleMigrateOwners(body, ctx, env) {
  const g = requireRole(ctx, 'admin'); if (g) return g;

  // Fetch all task_assignees
  const res = await sbFetch('task_assignees?select=task_id,user_id,is_owner', { method: 'GET' }, env);
  const allRows = res.ok ? await res.json() : [];

  // Group by task_id
  const taskMap = {};
  for (const row of allRows) {
    if (!taskMap[row.task_id]) taskMap[row.task_id] = [];
    taskMap[row.task_id].push(row);
  }

  let migrated = 0;
  for (const [taskId, assignees] of Object.entries(taskMap)) {
    // Skip if already has an owner
    if (assignees.some(a => a.is_owner)) continue;

    // Promote first assignee to owner
    if (assignees.length > 0) {
      await sbFetch(`task_assignees?task_id=eq.${taskId}&user_id=eq.${assignees[0].user_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_owner: true }),
        prefer: 'return=minimal',
      }, env);
      migrated++;
    }
  }

  return json({ ok: true, migrated, total_tasks: Object.keys(taskMap).length });
}

// ── Phase 10: Task meta edit + Products ──────────────────────────────────────

async function handleUpdateTaskMeta(body, ctx, env) {
  const g = requireRole(ctx, 'admin', 'lead'); if (g) return g;

  const { taskId, title, dueDate } = body;
  if (!taskId) return err('taskId is required');

  const updates = {};
  if (title !== undefined) {
    if (!title.trim()) return err('Title cannot be empty');
    updates.title = title.trim();
  }
  if (dueDate !== undefined) updates.due_date = dueDate || null;
  updates.updated_at = new Date().toISOString();

  const updateRes = await sbFetch(`tasks?id=eq.${taskId}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
    prefer: 'return=minimal',
  }, env);

  if (!updateRes.ok) return err('Failed to update task');

  await logActivity(taskId, ctx.userId, 'meta_update', {
    fields: Object.keys(updates).filter(k => k !== 'updated_at'),
    title: updates.title,
    due_date: updates.due_date,
  }, env);

  return json({ ok: true });
}

async function handleGetProducts(body, ctx, env) {
  // Any authenticated user can fetch products (needed for intake form)
  // Override schema to public for product_master query
  const url = `${env.SUPABASE_URL}/rest/v1/product_master?is_active=eq.true&select=product_code,product,sku,is_active&order=product.asc`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Accept-Profile': 'public',
    },
  });
  const products = res.ok ? await res.json() : [];
  return json({ products });
}

// ── Phase 6: Dashboard + Reporting actions ───────────────────────────────────

async function handleGetDashboardStats(body, ctx, env) {
  const g = requireRole(ctx, 'admin', 'lead'); if (g) return g;

  let sprintId = body.sprintId;

  // Default to active sprint, or most recently closed
  if (!sprintId) {
    const activeRes = await sbFetch('sprints?status=eq.active&select=id,name&limit=1', { method: 'GET' }, env);
    const activeSprints = activeRes.ok ? await activeRes.json() : [];
    if (activeSprints.length > 0) {
      sprintId = activeSprints[0].id;
    } else {
      const closedRes = await sbFetch('sprints?status=eq.closed&select=id,name&order=end_date.desc&limit=1', { method: 'GET' }, env);
      const closedSprints = closedRes.ok ? await closedRes.json() : [];
      if (closedSprints.length > 0) {
        sprintId = closedSprints[0].id;
      } else {
        return json({ sprintId: null, sprintName: null, inReview: 0, overdue: 0, extBlocked: 0, abandoned: 0, completionRate: 0, spillovers: 0, doneCount: 0, totalEligible: 0 });
      }
    }
  }

  // Fetch sprint row
  const sprintRes = await sbFetch(`sprints?id=eq.${sprintId}&select=id,name`, { method: 'GET' }, env);
  if (!sprintRes.ok) return err('Sprint not found');
  const [sprint] = await sprintRes.json();
  if (!sprint) return err('Sprint not found');

  // Optional person filter
  const personId = body.personId;
  let personTaskIds = null;
  if (personId) {
    const assignRes = await sbFetch(
      `task_assignees?user_id=eq.${personId}&select=task_id`,
      { method: 'GET' }, env
    );
    const assigns = assignRes.ok ? await assignRes.json() : [];
    personTaskIds = new Set(assigns.map(a => a.task_id));
  }

  // Fetch all tasks in sprint
  const tasksRes = await sbFetch(
    `tasks?sprint_id=eq.${sprintId}&select=id,stage,due_date,is_spillover,task_number`,
    { method: 'GET' }, env
  );
  let tasks = tasksRes.ok ? await tasksRes.json() : [];

  // Filter by person if specified
  if (personTaskIds) {
    tasks = tasks.filter(t => personTaskIds.has(t.id));
  }

  const today = new Date().toISOString().split('T')[0];

  // IN REVIEW and EXT. BLOCKED always show across all sprints —
  // these stages require action regardless of sprint membership.
  const allInReviewRes = await sbFetch(
    'tasks?stage=eq.in_review&select=id',
    { method: 'GET' }, env
  );
  const allInReview = allInReviewRes.ok ? await allInReviewRes.json() : [];

  const allExtBlockedRes = await sbFetch(
    'tasks?stage=eq.ext_blocked&select=id',
    { method: 'GET' }, env
  );
  const allExtBlocked = allExtBlockedRes.ok ? await allExtBlockedRes.json() : [];

  const inReview = personTaskIds
    ? allInReview.filter(t => personTaskIds.has(t.id)).length
    : allInReview.length;
  const extBlocked = personTaskIds
    ? allExtBlocked.filter(t => personTaskIds.has(t.id)).length
    : allExtBlocked.length;

  const overdue     = tasks.filter(t => !['done','abandoned'].includes(t.stage) && t.due_date && t.due_date < today).length;
  const abandoned   = tasks.filter(t => t.stage === 'abandoned').length;
  const doneCount   = tasks.filter(t => t.stage === 'done').length;
  const totalEligible = tasks.filter(t => t.stage !== 'abandoned').length;
  const completionRate = totalEligible > 0 ? Math.round((doneCount / totalEligible) * 1000) / 10 : 0;
  const spillovers  = tasks.filter(t => t.is_spillover && !['done','abandoned'].includes(t.stage)).length;

  return json({
    sprintId: sprint.id,
    sprintName: sprint.name,
    inReview,
    overdue,
    extBlocked,
    abandoned,
    completionRate,
    spillovers,
    doneCount,
    totalEligible,
  });
}

async function handleGetDeliverablesReport(body, ctx, env) {
  const g = requireRole(ctx, 'admin', 'lead'); if (g) return g;

  const { startDate, endDate } = body;
  if (!startDate || !endDate) return err('startDate and endDate are required');

  // Validate date range <= 90 days
  const start = new Date(startDate);
  const end = new Date(endDate);
  const diffDays = Math.round((end - start) / (1000 * 60 * 60 * 24));
  if (diffDays > 90) return err('Date range cannot exceed 90 days', 400);
  if (diffDays < 0) return err('startDate must be before endDate', 400);

  // Use PostgREST to query tasks joined with assignees
  // We need tasks that are done and completed_at falls within the date range
  // PostgREST doesn't support DATE() AT TIME ZONE casts, so fetch completed tasks
  // in a wider window and filter on the client side
  const tasksRes = await sbFetch(
    `tasks?stage=eq.done&completed_at=gte.${startDate}T00:00:00.000+05:30&completed_at=lte.${endDate}T23:59:59.999+05:30&select=id,title,deliverable_type,completed_at`,
    { method: 'GET' }, env
  );
  const tasks = tasksRes.ok ? await tasksRes.json() : [];

  if (tasks.length === 0) {
    return json({ rows: [], startDate, endDate });
  }

  // Fetch assignees for these tasks (include is_owner)
  const taskIds = tasks.map(t => t.id);
  let allAssignees = [];
  for (let i = 0; i < taskIds.length; i += 40) {
    const batch = taskIds.slice(i, i + 40);
    const inFilter = `(${batch.join(',')})`;
    const assigneeRes = await sbFetch(
      `task_assignees?task_id=in.${inFilter}&select=task_id,user_id,is_owner`,
      { method: 'GET' }, env
    );
    if (assigneeRes.ok) {
      const rows = await assigneeRes.json();
      allAssignees = allAssignees.concat(rows);
    }
  }

  // Get unique user IDs and fetch user details
  const userIds = [...new Set(allAssignees.map(a => a.user_id))];
  let usersMap = {};
  if (userIds.length > 0) {
    const usersRes = await sbFetch(
      `users?id=in.(${userIds.join(',')})&select=id,name,discipline`,
      { method: 'GET' }, env
    );
    const users = usersRes.ok ? await usersRes.json() : [];
    users.forEach(u => { usersMap[u.id] = u; });
  }

  // Build rows: owner only gets credit (one row per task)
  const rows = [];
  const collaborations = [];

  for (const task of tasks) {
    const taskAssignees = allAssignees.filter(a => a.task_id === task.id);
    const completedDate = new Date(task.completed_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const owner = taskAssignees.find(a => a.is_owner);
    const collabs = taskAssignees.filter(a => !a.is_owner);

    // Owner row (or unassigned if no owner)
    if (owner) {
      const user = usersMap[owner.user_id] || {};
      rows.push({
        id: task.id, title: task.title, deliverable_type: task.deliverable_type,
        completed_date: completedDate, assignee_id: owner.user_id,
        assignee_name: user.name || 'Unknown', discipline: user.discipline || null,
      });
    } else {
      rows.push({
        id: task.id, title: task.title, deliverable_type: task.deliverable_type,
        completed_date: completedDate, assignee_id: null,
        assignee_name: 'Unassigned', discipline: null,
      });
    }

    // Collaborator footnote data
    if (collabs.length > 0) {
      collaborations.push({
        id: task.id, title: task.title, deliverable_type: task.deliverable_type,
        completed_date: completedDate,
        collaborators: collabs.map(c => {
          const u = usersMap[c.user_id] || {};
          return { user_id: c.user_id, name: u.name || 'Unknown', discipline: u.discipline || null };
        }),
      });
    }
  }

  rows.sort((a, b) => {
    if (a.completed_date !== b.completed_date) return b.completed_date.localeCompare(a.completed_date);
    return (a.assignee_name || '').localeCompare(b.assignee_name || '');
  });

  return json({ rows, collaborations, startDate, endDate });
}

async function handleGetTeamWorkload(body, ctx, env) {
  const g = requireRole(ctx, 'admin', 'lead'); if (g) return g;

  let sprintId = body.sprintId;

  // Default to active sprint, or most recently closed
  if (!sprintId) {
    const activeRes = await sbFetch('sprints?status=eq.active&select=id&limit=1', { method: 'GET' }, env);
    const activeSprints = activeRes.ok ? await activeRes.json() : [];
    if (activeSprints.length > 0) {
      sprintId = activeSprints[0].id;
    } else {
      const closedRes = await sbFetch('sprints?status=eq.closed&select=id&order=end_date.desc&limit=1', { method: 'GET' }, env);
      const closedSprints = closedRes.ok ? await closedRes.json() : [];
      if (closedSprints.length > 0) {
        sprintId = closedSprints[0].id;
      } else {
        return json({ sprintId: null, rows: [] });
      }
    }
  }

  // Fetch tasks in sprint
  const tasksRes = await sbFetch(
    `tasks?sprint_id=eq.${sprintId}&select=id,stage,priority`,
    { method: 'GET' }, env
  );
  const tasks = tasksRes.ok ? await tasksRes.json() : [];

  if (tasks.length === 0) {
    return json({ sprintId, rows: [] });
  }

  // Fetch assignees
  const taskIds = tasks.map(t => t.id);
  let allAssignees = [];
  for (let i = 0; i < taskIds.length; i += 40) {
    const batch = taskIds.slice(i, i + 40);
    const inFilter = `(${batch.join(',')})`;
    const assigneeRes = await sbFetch(
      `task_assignees?task_id=in.${inFilter}&select=task_id,user_id,is_owner`,
      { method: 'GET' }, env
    );
    if (assigneeRes.ok) {
      const rows = await assigneeRes.json();
      allAssignees = allAssignees.concat(rows);
    }
  }

  // Map task_id → task for quick lookup
  const taskMap = {};
  tasks.forEach(t => { taskMap[t.id] = t; });

  // Get unique user IDs
  const userIds = [...new Set(allAssignees.map(a => a.user_id))];
  let usersMap = {};
  if (userIds.length > 0) {
    const usersRes = await sbFetch(
      `users?id=in.(${userIds.join(',')})&select=id,name,discipline`,
      { method: 'GET' }, env
    );
    const users = usersRes.ok ? await usersRes.json() : [];
    users.forEach(u => { usersMap[u.id] = u; });
  }

  // Build grouped rows: user × stage × priority → count
  const groupKey = (userId, stage, priority) => `${userId}|${stage}|${priority}`;
  const groups = {};

  for (const ta of allAssignees) {
    const task = taskMap[ta.task_id];
    if (!task) continue;
    const key = groupKey(ta.user_id, task.stage, task.priority);
    if (!groups[key]) {
      const user = usersMap[ta.user_id] || {};
      groups[key] = {
        id: ta.user_id,
        name: user.name || 'Unknown',
        discipline: user.discipline || null,
        stage: task.stage,
        priority: task.priority,
        task_count: 0,
      };
    }
    groups[key].task_count++;
  }

  const rows = Object.values(groups).sort((a, b) => {
    if (a.name !== b.name) return a.name.localeCompare(b.name);
    return a.stage.localeCompare(b.stage);
  });

  return json({ sprintId, rows });
}

async function handleGetTasksInBucket(body, ctx, env) {
  const g = requireRole(ctx, 'admin', 'lead'); if (g) return g;

  const { bucket, sprintId, personId } = body;
  if (!bucket) return err('bucket is required');

  const validBuckets = ['in_review', 'overdue', 'ext_blocked', 'abandoned', 'spillovers'];
  if (!validBuckets.includes(bucket)) return err('Invalid bucket');

  // Default sprint
  let sid = sprintId;
  if (!sid) {
    const activeRes = await sbFetch('sprints?status=eq.active&select=id&limit=1', { method: 'GET' }, env);
    const activeSprints = activeRes.ok ? await activeRes.json() : [];
    if (activeSprints.length > 0) {
      sid = activeSprints[0].id;
    } else {
      const closedRes = await sbFetch('sprints?status=eq.closed&select=id&order=end_date.desc&limit=1', { method: 'GET' }, env);
      const closedSprints = closedRes.ok ? await closedRes.json() : [];
      if (closedSprints.length > 0) sid = closedSprints[0].id;
      else return json({ bucket, tasks: [] });
    }
  }

  // Build query filter based on bucket. in_review and ext_blocked
  // span all sprints — these stages need attention regardless of
  // which sprint the task belongs to.
  const today = new Date().toISOString().split('T')[0];
  let filter;
  if (bucket === 'in_review' || bucket === 'ext_blocked') {
    filter = `stage=eq.${bucket}`;
  } else {
    filter = `sprint_id=eq.${sid}`;
    switch (bucket) {
      case 'overdue':
        filter += `&stage=not.in.(done,abandoned)&due_date=lt.${today}`;
        break;
      case 'abandoned':
        filter += '&stage=eq.abandoned';
        break;
      case 'spillovers':
        filter += '&is_spillover=eq.true&stage=not.in.(done,abandoned)';
        break;
    }
  }

  const tasksRes = await sbFetch(
    `tasks?${filter}&select=id,title,type,deliverable_type,stage,priority,due_date,blocked_reason,task_number`,
    { method: 'GET' }, env
  );
  let tasks = tasksRes.ok ? await tasksRes.json() : [];

  // Optional person filter
  if (personId && tasks.length > 0) {
    const personAssignRes = await sbFetch(
      `task_assignees?user_id=eq.${personId}&select=task_id`,
      { method: 'GET' }, env
    );
    const personAssigns = personAssignRes.ok ? await personAssignRes.json() : [];
    const personTaskIds = new Set(personAssigns.map(a => a.task_id));
    tasks = tasks.filter(t => personTaskIds.has(t.id));
  }

  // Fetch assignees for these tasks
  if (tasks.length > 0) {
    const taskIds = tasks.map(t => t.id);
    let allAssignees = [];
    for (let i = 0; i < taskIds.length; i += 40) {
      const batch = taskIds.slice(i, i + 40);
      const inFilter = `(${batch.join(',')})`;
      const assigneeRes = await sbFetch(
        `task_assignees?task_id=in.${inFilter}&select=task_id,user_id,is_owner`,
        { method: 'GET' }, env
      );
      if (assigneeRes.ok) {
        const rows = await assigneeRes.json();
        allAssignees = allAssignees.concat(rows);
      }
    }

    // Fetch user names
    const userIds = [...new Set(allAssignees.map(a => a.user_id))];
    let usersMap = {};
    if (userIds.length > 0) {
      const usersRes = await sbFetch(
        `users?id=in.(${userIds.join(',')})&select=id,name`,
        { method: 'GET' }, env
      );
      const users = usersRes.ok ? await usersRes.json() : [];
      users.forEach(u => { usersMap[u.id] = u; });
    }

    // Attach assignees to tasks
    for (const task of tasks) {
      task.assignees = allAssignees
        .filter(a => a.task_id === task.id)
        .map(a => ({ id: a.user_id, name: (usersMap[a.user_id] || {}).name || 'Unknown', is_owner: a.is_owner || false }));
    }
  }

  return json({ bucket, tasks });
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

  // Flag spillover tasks — increment spillover_count (is_spillover is set below when re-attaching to new sprint)
  if (spilloverTasks.length > 0) {
    const spilloverIds = spilloverTasks.map(t => t.id);

    // Flag escalations (spillover_count was already >= 1 before this sprint)
    const escalations = spilloverTasks.filter(t => t.spillover_count >= 1);

    // Increment spillover_count via RPC (single call, no subrequest limit concern)
    await sbFetch('rpc/increment_spillover_count', {
      method: 'POST',
      body: JSON.stringify({ task_ids: spilloverIds }),
      prefer: 'return=minimal',
    }, env);

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

    // Add spillover tasks to new sprint — preserve stage for in-flight tasks
    if (spilloverTasks.length > 0) {
      // Tasks in backlog/in_sprint → reset stage to in_sprint in new sprint
      const resetIds = spilloverTasks
        .filter(t => t.stage === 'backlog' || t.stage === 'in_sprint')
        .map(t => t.id);
      for (let i = 0; i < resetIds.length; i += 40) {
        const batch = resetIds.slice(i, i + 40);
        const inFilter = `(${batch.join(',')})`;
        await sbFetch(`tasks?id=in.${inFilter}`, {
          method: 'PATCH',
          body: JSON.stringify({
            sprint_id: ns.id,
            stage: 'in_sprint',
            is_spillover: true,
            updated_at: new Date().toISOString(),
          }),
          prefer: 'return=minimal',
        }, env);
      }

      // In-flight tasks (in_progress, in_review, ext_blocked, approved, delivered) → preserve stage
      const preserveIds = spilloverTasks
        .filter(t => t.stage !== 'backlog' && t.stage !== 'in_sprint')
        .map(t => t.id);
      for (let i = 0; i < preserveIds.length; i += 40) {
        const batch = preserveIds.slice(i, i + 40);
        const inFilter = `(${batch.join(',')})`;
        await sbFetch(`tasks?id=in.${inFilter}`, {
          method: 'PATCH',
          body: JSON.stringify({
            sprint_id: ns.id,
            is_spillover: true,
            updated_at: new Date().toISOString(),
          }),
          prefer: 'return=minimal',
        }, env);
      }
    }
  }

  await slackOps(`📊 *Sprint closed: "${sprint.name}"*\n✅ Done: ${doneTasks.length}\n↩ Spillover: ${spilloverTasks.length}\n🚫 Abandoned: ${abandonedTasks.length}\n📈 Completion: ${healthScore.completion_rate}%${newSprint ? `\n🆕 New sprint: "${nextName}"` : '\n⚠️ Failed to create next sprint'}`, env);

  return {
    closed_sprint: sprint.name,
    health_score: healthScore,
    new_sprint: newSprint,
    spillovers_carried: spilloverTasks.length,
  };
}

// ── Auto sprint close — runs on Cloudflare Cron ──────────────────────────────

// Thursday (DOW 4) of the current sprint week — the most recent Thursday on/before
// today. Sprints are Thu→Wed, enforced by a DB CHECK (start DOW=4, end-start=6).
function currentWeekThursday() {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const diff = (d.getDay() - 4 + 7) % 7; // days since the week's Thursday
  d.setDate(d.getDate() - diff);
  return d;
}

// Re-seed an active sprint when none exists (bootstrap gap — see runSprintClose).
// Creates THIS week's Thu→Wed sprint; idempotent (bails if a sprint already exists
// for the same start_date, whatever its status). Returns the sprint row or {error}.
async function bootstrapActiveSprint(env) {
  const thu = currentWeekThursday();
  const wed = new Date(thu); wed.setDate(wed.getDate() + 6);
  const start_date = thu.toISOString().split('T')[0];
  const end_date = wed.toISOString().split('T')[0];

  const existsRes = await sbFetch(`sprints?start_date=eq.${start_date}&select=id,name,status`, { method: 'GET' }, env);
  const existing = existsRes.ok ? await existsRes.json() : [];
  if (existing.length > 0) {
    // A sprint for this week already exists (e.g. closed early) — do NOT force it
    // active; report it so we don't create a duplicate / fight a deliberate close.
    console.log(`[bootstrapActiveSprint] Sprint for week of ${start_date} already exists (${existing[0].status}); not creating`);
    return existing[0];
  }

  const countRes = await sbFetch('sprints?select=id', { method: 'GET' }, env);
  const count = countRes.ok ? (await countRes.json()).length : 0;
  const name = `Sprint ${count + 1} — ${formatDateShort(thu)} to ${formatDateShort(wed)}`;

  const insertRes = await sbFetch('sprints', {
    method: 'POST',
    body: JSON.stringify({ name, start_date, end_date, status: 'active', created_by: null }),
  }, env);
  if (!insertRes.ok) {
    const e = await insertRes.text();
    return { error: `insert ${insertRes.status}: ${e.slice(0, 200)}` };
  }
  const [sprint] = await insertRes.json();
  await slackOps(`🆕 *Sprint auto-bootstrapped* — *"${name}"* (no active sprint existed; chain re-seeded)`, env);
  return sprint;
}

async function runSprintClose(env) {
  console.log('[throttleops] Auto sprint close cron fired');

  // Auto-close delivered tasks past their feedback window
  await autoCloseStaleTasks(env);

  // Guard: find active sprint(s)
  const activeRes = await sbFetch('sprints?status=eq.active&select=*', { method: 'GET' }, env);
  if (!activeRes.ok) {
    console.error('[sprintClose] Failed to fetch active sprints');
    return;
  }
  const activeSprints = await activeRes.json();

  if (activeSprints.length === 0) {
    // Self-bootstrap: the cron creates the next sprint only as a side-effect of
    // CLOSING an active one, so a single failed create-next (or any gap) would
    // otherwise stall the chain forever (S191 — Sprint 5 closed 10 Jun → 3 dead
    // weeks). Re-seed this week's active sprint so the chain resumes.
    console.log('[sprintClose] No active sprint found — bootstrapping this week\'s sprint to re-seed the chain');
    const created = await bootstrapActiveSprint(env);
    if (created?.error) {
      await slackOps(`⚠️ *Sprint chain stalled* — no active sprint and auto-bootstrap failed: ${created.error}. Create one manually in the planner.`, env);
      console.error('[sprintClose] bootstrap failed:', created.error);
    } else if (created) {
      console.log(`[sprintClose] Bootstrapped "${created.name || created.id}"`);
    }
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

// ── DELIVER TASK ──────────────────────────────────────────────────────────────
async function handleDeliverTask(body, ctx, env) {
  const { task_id, message, attachment_url, attachment_label } = body;
  if (!task_id) return err('task_id is required');

  const tRes = await sbFetch(`tasks?id=eq.${task_id}&select=id,title,stage,request_id`, { method: 'GET' }, env);
  if (!tRes.ok) return err('Task not found', 404);
  const [task] = await tRes.json();
  if (!task) return err('Task not found', 404);
  if (task.stage !== 'approved') return err('Task must be in approved stage to deliver');

  // Assignee or admin/lead can deliver
  if (!['admin', 'lead'].includes(ctx.role)) {
    const aRes = await sbFetch(
      `task_assignees?task_id=eq.${task_id}&user_id=eq.${ctx.userId}&select=task_id`,
      { method: 'GET' }, env
    );
    const rows = aRes.ok ? await aRes.json() : [];
    if (!rows.length) return err('You are not assigned to this task', 403);
  }

  // Get auto_close_hours from ageing config
  const cfgRes = await sbFetch(`ageing_config?stage=eq.delivered&select=auto_close_hours`, { method: 'GET' }, env);
  const cfgRows = cfgRes.ok ? await cfgRes.json() : [];
  const autoCloseHours = cfgRows[0]?.auto_close_hours ?? 72;
  const now = new Date().toISOString();
  const autoCloseAt = new Date(Date.now() + autoCloseHours * 60 * 60 * 1000).toISOString();

  await sbFetch(`tasks?id=eq.${task_id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      stage: 'delivered',
      delivered_at: now,
      auto_close_at: autoCloseAt,
      delivery_message: message || null,
      updated_at: now,
    }),
    prefer: 'return=minimal',
  }, env);

  if (attachment_url) {
    await sbFetch('task_attachments', {
      method: 'POST',
      body: JSON.stringify({
        task_id,
        type: 'link',
        url: attachment_url,
        label: attachment_label || 'Delivery',
        uploaded_by: ctx.userId,
      }),
      prefer: 'return=minimal',
    }, env);
  }

  await logActivity(task_id, ctx.userId, 'delivery', {
    message: message || null,
    attachment_url: attachment_url || null,
    auto_close_at: autoCloseAt,
  }, env);

  // Notify requester via Slack if slack_id exists
  if (task.request_id) {
    const reqRes = await sbFetch(
      `requests?id=eq.${task.request_id}&select=title,requester_id`,
      { method: 'GET' }, env
    );
    const [request] = reqRes.ok ? await reqRes.json() : [null];
    if (request?.requester_id) {
      const userRes = await sbFetch(
        `users?id=eq.${request.requester_id}&select=name,slack_id`,
        { method: 'GET' }, env
      );
      const [requester] = userRes.ok ? await userRes.json() : [null];
      const mention = requester?.slack_id ? `<@${requester.slack_id}>` : (requester?.name || 'Requester');
      await slackTeam(
        `📦 *Delivery ready: "${task.title}"*\n${mention} — your deliverable is ready for review.\nYou have ${autoCloseHours}h to submit feedback before it auto-accepts.\nReview at: https://throttle.legendoftoys.com/requests/`,
        env
      );
    }
  }

  await slackOps(
    `📦 *Task delivered to requester*\n*"${task.title}"*\nDelivered by: ${ctx.brandUser?.name || ctx.name}\nFeedback window: ${autoCloseHours}h`,
    env
  );

  return json({ ok: true, auto_close_at: autoCloseAt });
}

// ── SUBMIT BATCH FEEDBACK ─────────────────────────────────────────────────────
async function handleSubmitBatchFeedback(body, ctx, env) {
  const { request_id, feedback_items } = body;
  // feedback_items: [{ task_id, verdict ('accepted'|'iteration_requested'), comment, reference_links }]
  if (!request_id) return err('request_id is required');
  if (!Array.isArray(feedback_items) || feedback_items.length === 0) return err('feedback_items is required');

  // Only the requester can submit feedback on their own request
  const reqRes = await sbFetch(
    `requests?id=eq.${request_id}&select=id,title,requester_id`,
    { method: 'GET' }, env
  );
  const [request] = reqRes.ok ? await reqRes.json() : [null];
  if (!request) return err('Request not found', 404);
  if (request.requester_id !== ctx.userId) return err('Forbidden', 403);

  // Verify all tasks belong to this request
  const taskIds = feedback_items.map(f => f.task_id);
  const tasksRes = await sbFetch(
    `tasks?id=in.(${taskIds.join(',')})&request_id=eq.${request_id}&select=id,title,stage,iteration_count`,
    { method: 'GET' }, env
  );
  const tasks = tasksRes.ok ? await tasksRes.json() : [];
  const taskMap = Object.fromEntries(tasks.map(t => [t.id, t]));

  const batchId = crypto.randomUUID();
  const now = new Date().toISOString();
  const results = { accepted: [], iterations: [], errors: [] };

  for (const item of feedback_items) {
    const task = taskMap[item.task_id];
    if (!task) {
      results.errors.push({ task_id: item.task_id, error: 'Task not found in this request' });
      continue;
    }
    if (task.stage !== 'delivered') {
      results.errors.push({ task_id: item.task_id, error: `Task is in '${task.stage}', not delivered` });
      continue;
    }

    await sbFetch('task_feedback', {
      method: 'POST',
      body: JSON.stringify({
        task_id: item.task_id,
        batch_id: batchId,
        submitted_by: ctx.userId,
        verdict: item.verdict,
        comment: item.comment || null,
        reference_links: item.reference_links || [],
      }),
      prefer: 'return=minimal',
    }, env);

    if (item.verdict === 'accepted') {
      await sbFetch(`tasks?id=eq.${item.task_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ stage: 'done', completed_at: now, auto_close_at: null, updated_at: now }),
        prefer: 'return=minimal',
      }, env);
      await logActivity(item.task_id, ctx.userId, 'completion', { source: 'requester_accepted', batch_id: batchId }, env);
      results.accepted.push(item.task_id);
    } else {
      // iteration_requested — send back to in_progress
      const newIterCount = (task.iteration_count || 0) + 1;
      await sbFetch(`tasks?id=eq.${item.task_id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          stage: 'in_progress',
          iteration_count: newIterCount,
          auto_close_at: null,
          delivered_at: null,
          delivery_message: null,
          in_progress_at: now,
          updated_at: now,
        }),
        prefer: 'return=minimal',
      }, env);
      await logActivity(item.task_id, ctx.userId, 'iteration', {
        iteration_number: newIterCount,
        comment: item.comment || null,
        reference_links: item.reference_links || [],
        batch_id: batchId,
      }, env);
      results.iterations.push(item.task_id);
    }
  }

  // Notify brand team
  if (results.iterations.length > 0) {
    await slackOps(
      `🔄 *Iteration requested on "${request.title}"*\n✅ Accepted: ${results.accepted.length}\n↩ Needs revision: ${results.iterations.length}\nFrom: ${ctx.brandUser?.name || ctx.name}`,
      env
    );
    // DM the owners of iteration tasks
    const ownersRes = await sbFetch(
      `task_assignees?task_id=in.(${results.iterations.join(',')})&is_owner=eq.true&select=user_id`,
      { method: 'GET' }, env
    );
    const ownerRows = ownersRes.ok ? await ownersRes.json() : [];
    const ownerIds = [...new Set(ownerRows.map(r => r.user_id))];
    if (ownerIds.length > 0) {
      const usersRes = await sbFetch(`users?id=in.(${ownerIds.join(',')})&select=name,slack_id`, { method: 'GET' }, env);
      const owners = usersRes.ok ? await usersRes.json() : [];
      const mentions = owners.map(o => o.slack_id ? `<@${o.slack_id}>` : o.name).join(', ');
      await slackTeam(
        `🔄 ${mentions} — ${results.iterations.length} task(s) on *"${request.title}"* need a revision. Check the board.`,
        env
      );
    }
  } else {
    await slackTeam(
      `✅ *All tasks accepted on "${request.title}"* by ${ctx.brandUser?.name || ctx.name}`,
      env
    );
  }

  return json({ ok: true, batch_id: batchId, accepted: results.accepted.length, iterations: results.iterations.length, errors: results.errors });
}

// ── MARK TASK DONE — lead/admin override ──────────────────────────────────────
async function handleMarkTaskDone(body, ctx, env) {
  const g = requireRole(ctx, 'admin', 'lead'); if (g) return g;
  const { task_id, reason } = body;
  if (!task_id) return err('task_id is required');

  const tRes = await sbFetch(`tasks?id=eq.${task_id}&select=id,title,stage`, { method: 'GET' }, env);
  const [task] = tRes.ok ? await tRes.json() : [null];
  if (!task) return err('Task not found', 404);
  if (['done', 'abandoned'].includes(task.stage)) return err(`Task is already ${task.stage}`);

  const now = new Date().toISOString();
  await sbFetch(`tasks?id=eq.${task_id}`, {
    method: 'PATCH',
    body: JSON.stringify({ stage: 'done', completed_at: now, auto_close_at: null, updated_at: now }),
    prefer: 'return=minimal',
  }, env);

  await logActivity(task_id, ctx.userId, 'completion', { source: 'admin_override', reason: reason || null }, env);
  await slackTeam(
    `✅ *Task marked done by ${ctx.brandUser?.name || ctx.name}: "${task.title}"*${reason ? `\nReason: ${reason}` : ''}`,
    env
  );
  return json({ ok: true });
}

// ── GET REQUEST DELIVERY — requester feedback UI ──────────────────────────────
async function handleGetRequestDelivery(body, ctx, env) {
  const { request_id } = body;
  if (!request_id) return err('request_id is required');

  const reqRes = await sbFetch(
    `requests?id=eq.${request_id}&select=id,title,requester_id,required_by,status`,
    { method: 'GET' }, env
  );
  const [request] = reqRes.ok ? await reqRes.json() : [null];
  if (!request) return err('Request not found', 404);

  // Requester can only fetch their own; brand team can fetch any
  if (!['admin', 'lead', 'member'].includes(ctx.role) && request.requester_id !== ctx.userId) {
    return err('Forbidden', 403);
  }

  const tasksRes = await sbFetch(
    `tasks?request_id=eq.${request_id}&stage=neq.abandoned&select=id,title,stage,deliverable_type,delivery_message,delivered_at,auto_close_at,iteration_count,completed_at,task_number`,
    { method: 'GET' }, env
  );
  const tasks = tasksRes.ok ? await tasksRes.json() : [];
  if (tasks.length === 0) return json({ request, tasks: [] });

  const taskIds = tasks.map(t => t.id);

  // Attachments
  const attRes = await sbFetch(
    `task_attachments?task_id=in.(${taskIds.join(',')})&select=task_id,url,label,type,created_at&order=created_at.desc`,
    { method: 'GET' }, env
  );
  const attachments = attRes.ok ? await attRes.json() : [];
  const attByTask = {};
  for (const a of attachments) {
    if (!attByTask[a.task_id]) attByTask[a.task_id] = [];
    attByTask[a.task_id].push(a);
  }

  // Latest feedback per task
  const fbRes = await sbFetch(
    `task_feedback?task_id=in.(${taskIds.join(',')})&select=task_id,verdict,comment,reference_links,created_at&order=created_at.desc`,
    { method: 'GET' }, env
  );
  const feedbackRows = fbRes.ok ? await fbRes.json() : [];
  const latestFbByTask = {};
  for (const f of feedbackRows) {
    if (!latestFbByTask[f.task_id]) latestFbByTask[f.task_id] = f;
  }

  const enriched = tasks.map(t => ({
    ...t,
    attachments: attByTask[t.id] || [],
    latest_feedback: latestFbByTask[t.id] || null,
  }));

  return json({ request, tasks: enriched });
}

// ── AGEING CONFIG ─────────────────────────────────────────────────────────────
async function handleGetAgeingConfig(body, ctx, env) {
  const res = await sbFetch('ageing_config?select=*&order=stage.asc', { method: 'GET' }, env);
  const rows = res.ok ? await res.json() : [];
  return json({ config: rows });
}

async function handleUpdateAgeingConfig(body, ctx, env) {
  const g = requireRole(ctx, 'admin'); if (g) return g;
  const { updates } = body;
  if (!Array.isArray(updates) || updates.length === 0) return err('updates array required');

  const now = new Date().toISOString();
  for (const u of updates) {
    if (!u.stage) continue;
    const patch = { updated_by: ctx.userId, updated_at: now };
    if (typeof u.warning_hours  === 'number') patch.warning_hours  = u.warning_hours;
    if (typeof u.critical_hours === 'number') patch.critical_hours = u.critical_hours;
    if ('auto_close_hours' in u) patch.auto_close_hours = u.auto_close_hours;
    await sbFetch(`ageing_config?stage=eq.${u.stage}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
      prefer: 'return=minimal',
    }, env);
  }
  return json({ ok: true });
}

// ── AUTO-CLOSE STALE DELIVERED TASKS ─────────────────────────────────────────
async function autoCloseStaleTasks(env) {
  const now = new Date().toISOString();

  const res = await sbFetch(
    `tasks?stage=eq.delivered&auto_close_at=lte.${now}&select=id,title,request_id`,
    { method: 'GET' }, env
  );
  if (!res.ok) { console.error('[autoClose] Failed to fetch stale delivered tasks'); return; }
  const staleTasks = await res.json();
  if (!staleTasks.length) { console.log('[autoClose] No stale delivered tasks'); return; }

  for (const task of staleTasks) {
    await sbFetch(`tasks?id=eq.${task.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ stage: 'done', completed_at: now, auto_close_at: null, updated_at: now }),
      prefer: 'return=minimal',
    }, env);
    await logActivity(task.id, null, 'completion', { source: 'auto_close', reason: 'Feedback window expired — auto-accepted' }, env);
    await slackOps(`⏱ *Auto-accepted: "${task.title}"* — feedback window expired, task marked done.`, env);
  }

  console.log(`[autoClose] Auto-closed ${staleTasks.length} task(s)`);
}

// ── Social Media Management ──────────────────────────────────────────────────

const VALID_CONTENT_TYPES = {
  instagram: ['photo', 'carousel', 'reel', 'story'],
  linkedin:  ['post', 'article', 'video'],
  youtube:   ['video', 'short'],
};

async function handleGetChannels(body, ctx, env) {
  const res = await sbFetch(
    'social_channels?is_active=eq.true&order=name.asc',
    { method: 'GET' },
    env,
  );
  if (!res.ok) return err('Failed to load channels', res.status);
  const rows = await res.json();
  return json({ channels: rows });
}

async function handleGetCampaigns(body, ctx, env) {
  const res = await sbFetch(
    'social_campaigns?status=neq.archived&order=created_at.desc&limit=50',
    { method: 'GET' },
    env,
  );
  if (!res.ok) return err('Failed to load campaigns', res.status);
  const rows = await res.json();
  return json({ campaigns: rows });
}

async function handleCreateCampaign(body, ctx, env) {
  const g = requireRole(ctx, 'member', 'lead', 'admin'); if (g) return g;
  const { name, description, start_date, end_date } = body;
  if (!name?.trim()) return err('name is required');

  const res = await sbFetch('social_campaigns', {
    method: 'POST',
    body: JSON.stringify({
      name: name.trim(),
      description: description ?? null,
      start_date: start_date ?? null,
      end_date:   end_date   ?? null,
      created_by: ctx.userId,
    }),
  }, env);
  if (!res.ok) {
    const e = await res.text();
    return err(`Failed to create campaign: ${e.slice(0, 200)}`, res.status);
  }
  const [campaign] = await res.json();
  return json({ ok: true, campaign });
}

async function handleGetSocialFeed(body, ctx, env) {
  const { from_date, to_date } = body;
  if (!from_date || !to_date) return err('from_date and to_date are required');

  const postsRes = await sbFetch(
    `social_posts?scheduled_date=gte.${from_date}&scheduled_date=lte.${to_date}` +
    `&order=scheduled_date.asc,scheduled_time.asc`,
    { method: 'GET' }, env,
  );
  if (!postsRes.ok) return err('Failed to load posts', postsRes.status);
  const posts = await postsRes.json();
  if (posts.length === 0) return json({ feed: [] });

  const postIds = posts.map(p => p.id);
  const taskIds = [...new Set(posts.map(p => p.task_id).filter(Boolean))];

  const [variantsRes, channelsRes, tasksRes] = await Promise.all([
    sbFetch(
      `social_post_channels?post_id=in.(${postIds.join(',')})&order=created_at.asc`,
      { method: 'GET' }, env,
    ),
    sbFetch('social_channels?is_active=eq.true', { method: 'GET' }, env),
    taskIds.length > 0
      ? sbFetch(`tasks?id=in.(${taskIds.join(',')})&select=id,title,stage`, { method: 'GET' }, env)
      : Promise.resolve({ ok: true, json: async () => [] }),
  ]);

  if (!variantsRes.ok || !channelsRes.ok || !tasksRes.ok) {
    return err('Failed to load feed details');
  }

  const variants = await variantsRes.json();
  const channels = await channelsRes.json();
  const tasks    = await tasksRes.json();

  const channelMap = Object.fromEntries(channels.map(c => [c.id, c]));
  const taskMap    = Object.fromEntries(tasks.map(t => [t.id, t]));
  const variantsByPost = {};
  for (const v of variants) {
    if (!variantsByPost[v.post_id]) variantsByPost[v.post_id] = [];
    variantsByPost[v.post_id].push({ ...v, channel: channelMap[v.channel_id] ?? null });
  }

  const feed = posts.map(p => ({
    ...p,
    variants:    variantsByPost[p.id] ?? [],
    linked_task: p.task_id ? (taskMap[p.task_id] ?? null) : null,
  }));

  return json({ feed });
}

async function handleGetSocialPost(body, ctx, env) {
  const { post_id } = body;
  if (!post_id) return err('post_id is required');

  const [postRes, variantsRes, channelsRes] = await Promise.all([
    sbFetch(`social_posts?id=eq.${post_id}&limit=1`, { method: 'GET' }, env),
    sbFetch(`social_post_channels?post_id=eq.${post_id}&order=created_at.asc`, { method: 'GET' }, env),
    sbFetch('social_channels?is_active=eq.true', { method: 'GET' }, env),
  ]);
  if (!postRes.ok || !variantsRes.ok || !channelsRes.ok) {
    return err('Failed to load post');
  }
  const [post]   = await postRes.json();
  if (!post) return err('Post not found', 404);
  const variantsRaw = await variantsRes.json();
  const channels    = await channelsRes.json();

  const channelMap = Object.fromEntries(channels.map(c => [c.id, c]));
  const variants = variantsRaw.map(v => ({ ...v, channel: channelMap[v.channel_id] ?? null }));

  let linked_task = null;
  if (post.task_id) {
    const taskRes = await sbFetch(
      `tasks?id=eq.${post.task_id}&select=id,title,stage&limit=1`,
      { method: 'GET' }, env,
    );
    if (taskRes.ok) {
      const [t] = await taskRes.json();
      linked_task = t ?? null;
    }
  }

  return json({ post: { ...post, variants, linked_task } });
}

async function validateVariantContentTypes(variants, env) {
  const channelIds = [...new Set(variants.map(v => v.channel_id).filter(Boolean))];
  if (channelIds.length === 0) return { error: err('variant.channel_id is required') };
  const chRes = await sbFetch(
    `social_channels?id=in.(${channelIds.join(',')})`,
    { method: 'GET' }, env,
  );
  if (!chRes.ok) return { error: err('Failed to validate channels') };
  const channels = await chRes.json();
  const channelMap = Object.fromEntries(channels.map(c => [c.id, c]));

  for (const v of variants) {
    if (v.content_type === undefined) continue;
    const ch = channelMap[v.channel_id];
    if (!ch) return { error: err(`Channel ${v.channel_id} not found`, 404) };
    const allowed = VALID_CONTENT_TYPES[ch.platform] ?? [];
    if (!allowed.includes(v.content_type)) {
      return { error: err(
        `content_type '${v.content_type}' is not valid for ${ch.platform}. Allowed: ${allowed.join(', ')}`,
      ) };
    }
  }
  return { ok: true };
}

async function handleCreateSocialPost(body, ctx, env) {
  const g = requireRole(ctx, 'member', 'lead', 'admin'); if (g) return g;
  const {
    title, scheduled_date, scheduled_time, notes, status,
    campaign_id, task_id, product_code, variants,
  } = body;

  if (!title?.trim())  return err('title is required');
  if (!scheduled_date) return err('scheduled_date is required');
  if (!Array.isArray(variants) || variants.length === 0) {
    return err('at least one variant is required');
  }

  const validation = await validateVariantContentTypes(variants, env);
  if (validation.error) return validation.error;

  const postRes = await sbFetch('social_posts', {
    method: 'POST',
    body: JSON.stringify({
      title:          title.trim(),
      scheduled_date,
      scheduled_time: scheduled_time ?? null,
      notes:          notes          ?? null,
      status:         status         ?? 'draft',
      campaign_id:    campaign_id    ?? null,
      task_id:        task_id        ?? null,
      product_code:   product_code   ?? null,
      created_by:     ctx.userId,
    }),
  }, env);
  if (!postRes.ok) {
    const e = await postRes.text();
    return err(`Failed to create post: ${e.slice(0, 200)}`, postRes.status);
  }
  const [post] = await postRes.json();

  const variantRows = variants.map(v => ({
    post_id:       post.id,
    channel_id:    v.channel_id,
    content_type:  v.content_type,
    caption_draft: v.caption_draft ?? null,
    asset_url:     v.asset_url     ?? null,
    status:        'draft',
  }));
  const varRes = await sbFetch('social_post_channels', {
    method: 'POST',
    body: JSON.stringify(variantRows),
  }, env);
  if (!varRes.ok) {
    const e = await varRes.text();
    return err(
      `Post ${post.id} created but variants failed: ${e.slice(0, 200)}. Roll back or retry.`,
      varRes.status,
    );
  }
  const variantsOut = await varRes.json();
  return json({ ok: true, post: { ...post, variants: variantsOut } });
}

async function handleUpdateSocialPost(body, ctx, env) {
  const g = requireRole(ctx, 'member', 'lead', 'admin'); if (g) return g;
  const { post_id, variants, ...fields } = body;
  if (!post_id) return err('post_id is required');

  const UPDATE_ALLOWED = [
    'title', 'scheduled_date', 'scheduled_time', 'notes', 'status',
    'campaign_id', 'task_id', 'product_code',
  ];
  const postPatch = {};
  for (const k of UPDATE_ALLOWED) {
    if (k in fields) postPatch[k] = fields[k];
  }
  postPatch.updated_at = new Date().toISOString();

  const postRes = await sbFetch(`social_posts?id=eq.${post_id}`, {
    method: 'PATCH',
    body: JSON.stringify(postPatch),
    prefer: 'return=minimal',
  }, env);
  if (!postRes.ok) return err('Failed to update post', postRes.status);

  if (Array.isArray(variants) && variants.length > 0) {
    const validation = await validateVariantContentTypes(variants, env);
    if (validation.error) return validation.error;

    const delRes = await sbFetch(`social_post_channels?post_id=eq.${post_id}`, {
      method: 'DELETE',
      prefer: 'return=minimal',
    }, env);
    if (!delRes.ok) return err('Failed to clear existing variants', delRes.status);

    const insertRows = variants.map(v => ({
      post_id,
      channel_id:    v.channel_id,
      content_type:  v.content_type,
      caption_draft: v.caption_draft ?? null,
      asset_url:     v.asset_url     ?? null,
      status:        v.status        ?? 'draft',
    }));
    const varRes = await sbFetch('social_post_channels', {
      method: 'POST',
      body: JSON.stringify(insertRows),
      prefer: 'return=minimal',
    }, env);
    if (!varRes.ok) {
      const e = await varRes.text();
      return err(`Failed to update variants: ${e.slice(0, 200)}`, varRes.status);
    }
  }

  return json({ ok: true, post_id });
}

async function handleDeleteSocialPost(body, ctx, env) {
  const g = requireRole(ctx, 'lead', 'admin'); if (g) return g;
  const { post_id } = body;
  if (!post_id) return err('post_id is required');

  const res = await sbFetch(`social_posts?id=eq.${post_id}`, {
    method: 'DELETE',
    prefer: 'return=minimal',
  }, env);
  if (!res.ok) return err('Failed to delete post', res.status);
  return json({ ok: true, post_id });
}

async function handlePublishVariant(body, ctx, env) {
  const g = requireRole(ctx, 'member', 'lead', 'admin'); if (g) return g;
  const { variant_id } = body;
  if (!variant_id) return err('variant_id is required');

  const res = await sbFetch(`social_post_channels?id=eq.${variant_id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'published',
      published_at: new Date().toISOString(),
    }),
    prefer: 'return=minimal',
  }, env);
  if (!res.ok) return err('Failed to publish variant', res.status);
  return json({ ok: true, variant_id });
}

async function handleUpdatePostStatus(body, ctx, env) {
  const g = requireRole(ctx, 'member', 'lead', 'admin'); if (g) return g;
  const { post_id, status } = body;
  if (!post_id) return err('post_id is required');

  const VALID = ['idea', 'draft', 'approved', 'published', 'cancelled'];
  if (!VALID.includes(status)) {
    return err(`status must be one of: ${VALID.join(', ')}`);
  }
  if (status === 'approved' && !['lead', 'admin'].includes(ctx.role)) {
    return err('Only lead or admin can approve posts', 403);
  }

  const res = await sbFetch(`social_posts?id=eq.${post_id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
    prefer: 'return=minimal',
  }, env);
  if (!res.ok) return err('Failed to update post status', res.status);
  return json({ ok: true, post_id, status });
}

async function handleLinkTaskToPost(body, ctx, env) {
  const g = requireRole(ctx, 'member', 'lead', 'admin'); if (g) return g;
  const { post_id, task_id } = body;
  if (!post_id) return err('post_id is required');

  const res = await sbFetch(`social_posts?id=eq.${post_id}`, {
    method: 'PATCH',
    body: JSON.stringify({ task_id: task_id ?? null, updated_at: new Date().toISOString() }),
    prefer: 'return=minimal',
  }, env);
  if (!res.ok) return err('Failed to link task', res.status);
  return json({ ok: true, post_id, task_id: task_id ?? null });
}

async function handleUpdateCampaign(body, ctx, env) {
  const g = requireRole(ctx, 'member', 'lead', 'admin'); if (g) return g;
  const { campaign_id, name, description, start_date, end_date, status } = body;
  if (!campaign_id) return err('campaign_id is required');

  const patch = {};
  if (name !== undefined)        patch.name        = name;
  if (description !== undefined) patch.description = description;
  if (start_date !== undefined)  patch.start_date  = start_date;
  if (end_date !== undefined)    patch.end_date    = end_date;
  if (status !== undefined) {
    const valid = ['active', 'completed', 'archived'];
    if (!valid.includes(status)) return err('Invalid status');
    patch.status = status;
  }
  if (Object.keys(patch).length === 0) return err('No fields to update');

  const res = await sbFetch(`social_campaigns?id=eq.${campaign_id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
    prefer: 'return=minimal',
  }, env);
  if (!res.ok) return err('Failed to update campaign', res.status);
  return json({ ok: true, campaign_id });
}

async function handleSearchTasksForSocial(body, ctx, env) {
  const g = requireRole(ctx, 'member', 'lead', 'admin'); if (g) return g;
  const { query, task_id, limit = 10 } = body;

  // Pre-populate path: single task lookup by id
  if (task_id) {
    const res = await sbFetch(
      `tasks?id=eq.${task_id}&select=id,task_number,title,stage,product_code&limit=1`,
      { method: 'GET' }, env,
    );
    if (!res.ok) return err('Failed to fetch task', res.status);
    const data = await res.json();
    return json({ tasks: Array.isArray(data) ? data : [] });
  }

  if (!query || query.trim().length === 0) return json({ tasks: [] });

  const q = query.trim();
  const cap = Math.min(Number(limit) || 10, 20);

  // Title search
  const titleRes = await sbFetch(
    `tasks?title=ilike.*${encodeURIComponent(q)}*&stage=not.in.(done,abandoned)` +
    `&select=id,task_number,title,stage,product_code&order=task_number.desc&limit=${cap}`,
    { method: 'GET' }, env,
  );
  if (!titleRes.ok) return err('Failed to search tasks', titleRes.status);
  const byTitle = (await titleRes.json()) || [];

  // If query is numeric, also search by task_number exact match
  let byNumber = [];
  if (/^\d+$/.test(q)) {
    const numRes = await sbFetch(
      `tasks?task_number=eq.${q}&stage=not.in.(done,abandoned)` +
      `&select=id,task_number,title,stage,product_code&limit=1`,
      { method: 'GET' }, env,
    );
    if (numRes.ok) byNumber = (await numRes.json()) || [];
  }

  // Merge, dedupe by id (number match first so it appears at top)
  const seen = new Set();
  const tasks = [];
  for (const t of [...byNumber, ...byTitle]) {
    if (!seen.has(t.id)) { seen.add(t.id); tasks.push(t); }
  }

  return json({ tasks: tasks.slice(0, cap) });
}

async function handleGetSocialMonitoring(body, ctx, env) {
  const g = requireRole(ctx, 'member', 'lead', 'admin'); if (g) return g;

  // ── Date anchors (IST) ──────────────────────────────────────────────────
  const now = new Date();
  const todayIST = new Date(now.toLocaleString('en-CA', { timeZone: 'Asia/Kolkata' }));
  const today = todayIST.toISOString().slice(0, 10);
  const tomorrow = new Date(todayIST);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  const eightWeeksAgo = new Date(todayIST);
  eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 56);
  const eightWeeksAgoStr = eightWeeksAgo.toISOString().slice(0, 10);

  // ── At-risk posts (non-finished, due ≤ tomorrow) + their variants ──────
  const atRiskRes = await sbFetch(
    `social_posts?status=not.in.(published,cancelled)&scheduled_date=lte.${tomorrowStr}` +
    `&select=id,title,scheduled_date,status,campaign_id,task_id,social_post_channels(id,channel_id,asset_url,status)` +
    `&order=scheduled_date.asc`,
    { method: 'GET' }, env,
  );
  if (!atRiskRes.ok) return err('Failed to load at-risk posts', atRiskRes.status);
  const allPosts = (await atRiskRes.json()) || [];

  const atRisk = allPosts.map(post => {
    const variants = post.social_post_channels || [];
    const hasAnyAsset = variants.some(v => v.asset_url);
    const isOverdue = post.scheduled_date < today;
    const isMissingAsset = !hasAnyAsset && post.scheduled_date <= tomorrowStr;
    const { social_post_channels, ...rest } = post;
    return {
      ...rest,
      variants,
      is_overdue: isOverdue,
      is_missing_asset: isMissingAsset,
    };
  }).filter(p => p.is_overdue || p.is_missing_asset);

  // ── Cadence — last 8 weeks of published variants ───────────────────────
  const cadenceRes = await sbFetch(
    `social_post_channels?status=eq.published&published_at=gte.${eightWeeksAgoStr}` +
    `&select=id,channel_id,published_at,social_channels(id,name,platform,color)` +
    `&order=published_at.asc`,
    { method: 'GET' }, env,
  );
  if (!cadenceRes.ok) return err('Failed to load cadence', cadenceRes.status);
  const published = (await cadenceRes.json()) || [];

  // Build 8 week-start dates (Sundays, IST), oldest → newest
  const weeks = [];
  const weekStart = new Date(todayIST);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // rewind to Sunday
  for (let i = 7; i >= 0; i--) {
    const w = new Date(weekStart);
    w.setDate(w.getDate() - i * 7);
    weeks.push(w.toISOString().slice(0, 10));
  }

  const cadenceMap = {};   // { channel_id: { weekStartIso: count } }
  const channelMeta = {};
  for (const v of published) {
    const ch = v.social_channels;
    if (!ch) continue;
    if (!channelMeta[v.channel_id]) channelMeta[v.channel_id] = ch;
    const pubDate = new Date(v.published_at)
      .toLocaleString('en-CA', { timeZone: 'Asia/Kolkata' })
      .slice(0, 10);
    // Find bucket: latest week start ≤ pubDate
    let wk = weeks[0];
    for (let i = weeks.length - 1; i >= 0; i--) {
      if (pubDate >= weeks[i]) { wk = weeks[i]; break; }
    }
    if (!cadenceMap[v.channel_id]) cadenceMap[v.channel_id] = {};
    cadenceMap[v.channel_id][wk] = (cadenceMap[v.channel_id][wk] || 0) + 1;
  }

  const cadence = Object.entries(channelMeta).map(([channel_id, meta]) => ({
    channel_id,
    channel_name: meta.name,
    platform: meta.platform,
    color: meta.color,
    weeks: weeks.map(w => ({ week: w, count: cadenceMap[channel_id]?.[w] || 0 })),
  }));

  // Add zero-activity channels
  const chRes = await sbFetch(
    `social_channels?is_active=eq.true&order=name.asc`,
    { method: 'GET' }, env,
  );
  if (chRes.ok) {
    const allChannels = (await chRes.json()) || [];
    for (const ch of allChannels) {
      if (!channelMeta[ch.id]) {
        cadence.push({
          channel_id: ch.id,
          channel_name: ch.name,
          platform: ch.platform,
          color: ch.color,
          weeks: weeks.map(w => ({ week: w, count: 0 })),
        });
      }
    }
  }
  cadence.sort((a, b) => a.channel_name.localeCompare(b.channel_name));

  return json({ at_risk: atRisk, cadence, weeks });
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

// ════════════════════════════════════════════════════════════════════════════
//  Social analytics (Tier 1) — pull published IG media + insights into `brand`,
//  reconcile against planned posts. Read-only IG use of META_IG_TOKEN (IGAA →
//  graph.instagram.com). See docs/superpowers/specs/2026-06-21-throttle-social-analytics-tier1.md
// ════════════════════════════════════════════════════════════════════════════
const IG_GRAPH = 'https://graph.instagram.com/v21.0';

async function igGet(pathAndQuery, env) {
  if (!env.META_IG_TOKEN) return { ok: false, status: 503, data: { error: 'no_ig_token' } };
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  try {
    const res = await fetch(`${IG_GRAPH}/${pathAndQuery}${sep}access_token=${env.META_IG_TOKEN}`);
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: String(e) } };
  }
}

// ── Tier 2: comments (read + reply) ─────────────────────────────────────────
// Same IGAA token as Tier 1. The Pitstop-messaging app carries
// `instagram_business_manage_comments` (verified in the Meta App Dashboard
// 2026-07-31, use case "Manage messaging & content on Instagram", step 1 green).
//
// ⚠️ App-level permission ≠ token scope. Meta bakes scopes into a token AT MINT
// TIME, and META_IG_TOKEN was minted in S161 for DMs. If the comments permission
// was added to the app afterwards, this token does not carry it and every call
// here 400s until the token is RE-MINTED (self-serve, App Dashboard → API setup
// with Instagram login → Generate access tokens — no App Review). That is why
// igScopeError() below exists: a missing scope must read as "re-mint the token",
// never as "this post has no comments", which is what an unclassified empty
// result would look like.
async function igPost(pathAndQuery, form, env) {
  if (!env.META_IG_TOKEN) return { ok: false, status: 503, data: { error: 'no_ig_token' } };
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const bodyParams = new URLSearchParams(form || {});
  try {
    const res = await fetch(`${IG_GRAPH}/${pathAndQuery}${sep}access_token=${env.META_IG_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: bodyParams.toString(),
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: String(e) } };
  }
}

// Turn a Meta OAuth/permission failure into an actionable message. Meta reports a
// missing scope as an OAuthException (code 190/200/10, or a message naming the
// permission) — indistinguishable from other auth failures unless inspected.
function igScopeError(r) {
  const e = r?.data?.error;
  if (!e) return null;
  const msg = String(e.message || e || '');
  const looksScope = /permission|scope|instagram_business_manage_comments|OAuthException/i.test(msg)
    || [190, 200, 10, 3].includes(Number(e.code));
  if (!looksScope) return null;
  return `Instagram refused the comment call — this is almost certainly a TOKEN SCOPE problem, not an empty result. `
    + `The app has instagram_business_manage_comments, but META_IG_TOKEN was minted for DMs (S161) and a Meta token `
    + `only carries the scopes it was granted at mint time. Re-mint it: App Dashboard → Pitstop messaging → `
    + `Instagram API → API setup with Instagram login → Generate access tokens, then wrangler secret put `
    + `META_IG_TOKEN on throttleops. No App Review needed. Meta said: ${msg}`;
}

// Map an insights `data` array → { metricName: latestValue }.
function igMetricMap(data) {
  const out = {};
  for (const m of (data?.data || [])) {
    const vals = m.values || [];
    const last = vals[vals.length - 1];
    if (last && last.value != null) out[m.name] = Number(last.value);
  }
  return out;
}

// The active Instagram channel row (Throttle's social_channels registry).
async function igChannel(env) {
  const res = await sbFetch('social_channels?platform=eq.instagram&is_active=eq.true&limit=1', { method: 'GET' }, env);
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

// Core sync — no auth (called by the manual action AND the cron). Returns a summary.
async function runSocialSync(env) {
  if (!env.META_IG_TOKEN) return { ok: false, reason: 'no_ig_token' };
  const channel = await igChannel(env);
  if (!channel) return { ok: false, reason: 'no_instagram_channel' };
  const summary = { media_upserted: 0, insights_synced: 0, account_days: 0, reconciled: 0 };

  // 1) Account daily insights → social_account_metrics (upsert by channel+date).
  // NB: follower_count is deliberately NOT requested here — the insights
  // `follower_count` metric is unreliable/empty and would overwrite real days
  // with 0, poisoning follower-gain math. Step 1b is the sole follower writer
  // (authoritative profile count, stamped on today's row only).
  const acc = await igGet('me/insights?metric=reach,profile_views&period=day', env);
  if (acc.ok) {
    const byDate = {};
    for (const m of (acc.data?.data || [])) {
      for (const v of (m.values || [])) {
        const d = (v.end_time || '').slice(0, 10);
        if (!d) continue;
        (byDate[d] = byDate[d] || { channel_id: channel.id, metric_date: d })[m.name === 'profile_views' ? 'profile_views' : m.name] = Number(v.value);
      }
    }
    const rows = Object.values(byDate);
    if (rows.length) {
      await sbFetch('social_account_metrics?on_conflict=channel_id,metric_date',
        { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: JSON.stringify(rows) }, env);
      summary.account_days = rows.length;
    }
  }

  // 1b) Authoritative follower count from the profile endpoint — the insights
  // `follower_count` metric is unreliable / often empty, so stamp today's row
  // from /me?fields=followers_count (merge keeps the day's reach).
  const prof = await igGet('me?fields=followers_count', env);
  if (prof.ok && prof.data?.followers_count != null) {
    // IST calendar date without locale-string parsing (en-CA → comma'd string
    // is unparseable by new Date() → RangeError on toISOString).
    const todayIST = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    await sbFetch('social_account_metrics?on_conflict=channel_id,metric_date',
      { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
        body: JSON.stringify([{ channel_id: channel.id, metric_date: todayIST, follower_count: Number(prof.data.followers_count) }]) }, env);
    summary.followers = Number(prof.data.followers_count);
  }

  // 2) Published media list → social_media (basic fields; merge keeps metrics).
  const mediaFields = 'id,caption,media_type,permalink,timestamp,like_count,comments_count';
  let media = [];
  let next = `me/media?fields=${mediaFields}&limit=100`;
  for (let page = 0; page < 2 && next; page++) {
    const r = await igGet(next, env);
    if (!r.ok) break;
    media = media.concat(r.data?.data || []);
    const nx = r.data?.paging?.next;
    next = nx ? nx.replace(`${IG_GRAPH}/`, '').replace(/&?access_token=[^&]*/, '') : null;
  }
  if (media.length) {
    const rows = media.map(m => ({
      ig_media_id: String(m.id), channel_id: channel.id, media_type: m.media_type,
      permalink: m.permalink, caption: m.caption || null,
      published_at: m.timestamp || null,
      like_count: Number(m.like_count || 0), comments_count: Number(m.comments_count || 0),
      last_synced_at: new Date().toISOString(),
    }));
    await sbFetch('social_media?on_conflict=ig_media_id',
      { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: JSON.stringify(rows) }, env);
    summary.media_upserted = rows.length;
  }

  // 3) Per-media insights for the newest 20 (subrequest budget) → merge metrics.
  const newest = media.slice(0, 20);
  const insightRows = [];
  for (const m of newest) {
    const isVideo = (m.media_type || '').toUpperCase() === 'VIDEO';
    const metrics = isVideo
      ? 'reach,saved,shares,total_interactions,views'
      : 'reach,saved,shares,total_interactions';
    const r = await igGet(`${m.id}/insights?metric=${metrics}`, env);
    if (!r.ok) continue;
    const mm = igMetricMap(r.data);
    insightRows.push({
      ig_media_id: String(m.id), channel_id: channel.id,
      reach: mm.reach ?? null, saved: mm.saved ?? null, shares: mm.shares ?? null,
      total_interactions: mm.total_interactions ?? null, views: mm.views ?? null,
      metrics_raw: mm, last_synced_at: new Date().toISOString(),
    });
  }
  if (insightRows.length) {
    await sbFetch('social_media?on_conflict=ig_media_id',
      { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: JSON.stringify(insightRows) }, env);
    summary.insights_synced = insightRows.length;
  }

  // 4) Reconcile unmatched media → planned posts (±6h, nearest), mark published.
  summary.reconciled = await reconcilePublished(channel, env);
  return { ok: true, ...summary };
}

// Match published IG media to planned social_posts (Instagram variant, unmatched,
// within ±6h of scheduled date+time). Sets the links + flips status to published.
async function reconcilePublished(channel, env) {
  const SIX_H = 6 * 3600 * 1000;
  const umRes = await sbFetch(
    `social_media?channel_id=eq.${channel.id}&matched_post_id=is.null&select=ig_media_id,published_at&order=published_at.desc&limit=200`,
    { method: 'GET' }, env);
  if (!umRes.ok) return 0;
  const unmatched = (await umRes.json()).filter(m => m.published_at);
  if (!unmatched.length) return 0;

  // Open Instagram variants (no external_media_id yet) + their posts' schedule.
  const vRes = await sbFetch(
    `social_post_channels?channel_id=eq.${channel.id}&external_media_id=is.null&select=id,post_id`,
    { method: 'GET' }, env);
  if (!vRes.ok) return 0;
  const variants = await vRes.json();
  if (!variants.length) return 0;
  const postIds = [...new Set(variants.map(v => v.post_id))];
  const pRes = await sbFetch(
    `social_posts?id=in.(${postIds.join(',')})&status=not.in.(cancelled)&select=id,scheduled_date,scheduled_time`,
    { method: 'GET' }, env);
  if (!pRes.ok) return 0;
  const posts = Object.fromEntries((await pRes.json()).map(p => [p.id, p]));

  const candidates = variants
    .map(v => {
      const p = posts[v.post_id];
      if (!p || !p.scheduled_date) return null;
      const t = new Date(`${p.scheduled_date}T${p.scheduled_time || '12:00:00'}+05:30`).getTime();
      return { variant_id: v.id, post_id: v.post_id, when: t, taken: false };
    })
    .filter(Boolean);
  if (!candidates.length) return 0;

  let n = 0;
  for (const m of unmatched) {
    const mt = new Date(m.published_at).getTime();
    let best = null, bestGap = SIX_H + 1;
    for (const c of candidates) {
      if (c.taken) continue;
      const gap = Math.abs(c.when - mt);
      if (gap <= SIX_H && gap < bestGap) { best = c; bestGap = gap; }
    }
    if (!best) continue;
    best.taken = true;
    const stamp = new Date(m.published_at).toISOString();
    await sbFetch(`social_media?ig_media_id=eq.${encodeURIComponent(m.ig_media_id)}`,
      { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ matched_post_id: best.post_id }) }, env);
    await sbFetch(`social_post_channels?id=eq.${best.variant_id}`,
      { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ external_media_id: m.ig_media_id, status: 'published', published_at: stamp }) }, env);
    await sbFetch(`social_posts?id=eq.${best.post_id}`,
      { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'published' }) }, env);
    n++;
  }
  return n;
}

async function handleSyncSocialInsights(body, ctx, env) {
  const g = requireRole(ctx, 'lead', 'admin'); if (g) return g;
  try {
    const result = await runSocialSync(env);
    if (!result.ok) return err(`Sync skipped: ${result.reason}`, result.reason === 'no_ig_token' ? 503 : 400);
    return json(result);
  } catch (e) {
    console.error('[syncSocialInsights]', e?.stack || e);
    return err(`Sync failed: ${e?.message || e}`, 500);   // always a CORS response
  }
}

// Tier 2 — read the comment thread on one published IG post.
// Read-only, and deliberately does NOT cache into Postgres: comments live on Meta
// permanently and are re-fetchable, so a local copy would only add a staleness
// problem and a moderation-lag bug (a comment deleted on IG would linger here).
async function handleGetIgComments(body, ctx, env) {
  const g = requireRole(ctx, 'member', 'lead', 'admin'); if (g) return g;
  const mediaId = String(body?.ig_media_id || '').trim();
  if (!mediaId) return err('ig_media_id required', 400);
  if (!/^\d+$/.test(mediaId)) return err('ig_media_id must be numeric', 400);
  if (!env.META_IG_TOKEN) return err('META_IG_TOKEN is not set on throttleops', 503);

  // replies{} is a nested edge — one call returns the whole thread.
  const fields = 'id,text,username,timestamp,like_count,hidden,replies{id,text,username,timestamp,like_count}';
  const r = await igGet(`${encodeURIComponent(mediaId)}/comments?fields=${encodeURIComponent(fields)}&limit=100`, env);
  if (!r.ok) {
    const scope = igScopeError(r);
    if (scope) return err(scope, 403);
    return err(`Instagram comment read failed (${r.status}): ${JSON.stringify(r.data?.error || r.data)}`, 502);
  }
  const comments = (r.data?.data || []).map(c => ({
    id: c.id, text: c.text || '', username: c.username || null,
    timestamp: c.timestamp || null, like_count: Number(c.like_count || 0),
    hidden: !!c.hidden,
    replies: (c.replies?.data || []).map(x => ({
      id: x.id, text: x.text || '', username: x.username || null,
      timestamp: x.timestamp || null, like_count: Number(x.like_count || 0),
    })),
  }));
  return json({ ig_media_id: mediaId, count: comments.length, comments });
}

// Tier 2 — reply to a comment. POST /{ig-comment-id}/replies, NOT the messages
// endpoint: a comment reply is a different object from a DM, and sending via
// messages would open a private thread instead of replying publicly.
async function handleReplyIgComment(body, ctx, env) {
  // Replying is public brand speech, so it is lead/admin — not `member`, which can
  // read the thread above. Deliberately narrower than the read gate.
  const g = requireRole(ctx, 'lead', 'admin'); if (g) return g;
  const commentId = String(body?.comment_id || '').trim();
  const message = String(body?.message || '').trim();
  if (!commentId) return err('comment_id required', 400);
  if (!/^\d+$/.test(commentId)) return err('comment_id must be numeric', 400);
  if (!message) return err('message required', 400);
  if (message.length > 2200) return err('message too long (IG caps a comment at 2,200 characters)', 400);
  if (!env.META_IG_TOKEN) return err('META_IG_TOKEN is not set on throttleops', 503);

  const r = await igPost(`${encodeURIComponent(commentId)}/replies`, { message }, env);
  if (!r.ok) {
    const scope = igScopeError(r);
    if (scope) return err(scope, 403);
    return err(`Instagram reply failed (${r.status}): ${JSON.stringify(r.data?.error || r.data)}`, 502);
  }
  return json({ comment_id: commentId, reply_id: r.data?.id || null, message });
}

async function handleGetSocialAnalytics(body, ctx, env) {
  const g = requireRole(ctx, 'member', 'lead', 'admin'); if (g) return g;
  const channel = await igChannel(env);
  if (!channel) return json({ channel: null, account_series: [], top_posts: [], totals: {} });

  const [accRes, mediaRes] = await Promise.all([
    sbFetch(`social_account_metrics?channel_id=eq.${channel.id}&order=metric_date.asc`, { method: 'GET' }, env),
    sbFetch(`social_media?channel_id=eq.${channel.id}&select=ig_media_id,permalink,caption,media_type,published_at,like_count,comments_count,reach,total_interactions,matched_post_id&order=published_at.desc&limit=300`, { method: 'GET' }, env),
  ]);
  const account_series = accRes.ok ? (await accRes.json()).map(r => ({
    // reach kept null (not coerced to 0) so the chart skips a day with no
    // finalized reach yet — e.g. today, which IG hasn't closed out — instead
    // of drawing a false drop to zero. follower_count: 0 means "no snapshot".
    date: r.metric_date,
    reach: r.reach == null ? null : Number(r.reach),
    profile_views: r.profile_views == null ? null : Number(r.profile_views),
    follower_count: Number(r.follower_count || 0),
  })) : [];
  const media = mediaRes.ok ? await mediaRes.json() : [];

  const totals = {
    posts: media.length,
    matched: media.filter(m => m.matched_post_id).length,
    likes: media.reduce((s, m) => s + Number(m.like_count || 0), 0),
    comments: media.reduce((s, m) => s + Number(m.comments_count || 0), 0),
    reach_30d: media.filter(m => m.published_at && (Date.now() - new Date(m.published_at).getTime()) < 30 * 864e5)
      .reduce((s, m) => s + Number(m.reach || 0), 0),
    // latest day that actually has a follower count (a fresh reach-only day is null)
    followers: ([...account_series].reverse().find(r => Number(r.follower_count) > 0)?.follower_count) ?? null,
  };
  const top_posts = [...media]
    .sort((a, b) => Number(b.reach || 0) - Number(a.reach || 0))
    .slice(0, 10);

  return json({ channel: { id: channel.id, handle: channel.handle, name: channel.name }, account_series, top_posts, totals });
}
