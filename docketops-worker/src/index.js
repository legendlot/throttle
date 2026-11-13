/**
 * Docket — docketops Cloudflare Worker
 * docketops.afshaan.workers.dev
 *
 * API for the LOT org task manager at docket.legendoftoys.com.
 * Sibling to lotopsproxy, throttleops, csops, ignitionops, snorkelops, podiumops.
 *
 * Pattern: GET  /?action=<actionName>            (reads)
 *          POST /  body: { action, ...params }   (writes, JWT-authenticated)
 *
 * The worker (service_role, BYPASSRLS) is the SOLE DB client; RLS-on/no-anon-grants
 * is the backstop (RULE-RLS-001). Permissions come from Docket's OWN layer
 * (store.docket_user_roles → docket_roles.permissions), isolated from store.roles
 * (mirrors Podium RULE-PODIUM-006 / Snorkel RULE-SNORKEL-002):
 *   - docket_admin    : role/user mgmt + see all + edit/abandon any task
 *   - docket_view_all : org-wide task visibility + review dashboard
 *   - docket_plan_admin : SUPER ADMIN (F9) — the plan register (themes, milestones, targets) and every
 *                       plan action; implies docket_admin + docket_view_all. Only a super admin can
 *                       grant, edit or revoke a role carrying it (spec §5.1 A5). Never implied BY admin.
 *   - docket_review   : FOUNDERS' ASSOCIATE (F9 R6c, spec §5.3 level R) — the plan register at level R
 *                       (every unrestricted item in full, never target_text / a restricted subtree) and
 *                       the review pack for any team; NOTHING about tasks (task visibility stays baseline).
 *                       Not implied by admin; guarded like docket_plan_admin (A5).
 *   (dashboard is ALSO shareable independently of view_all: a persistent
 *    docket.settings.dashboard_public flag + per-person docket.dashboard_viewers
 *    grants — admin-managed in /admin/roles. RULE-DOCKET-006.)
 *   - (no role)       : baseline — create tasks; see own + collaborator + own-dept;
 *                       edit/status/abandon tasks they own/are assigned/created.
 * People + departments are read live from podium.employees / podium.departments.
 *
 * Spec: docs/superpowers/specs/2026-06-03-docket-design.md ; systems/docket.md
 */
import { istDateStr, isExpired, isDueOn, istHM, lateFlag, buildRegister } from './register-core.mjs';
import { recordProgress, progressLabel, flattenTemplate, snapshotRows, templateDiff, itemStatePatch, itemEvent, suggestTick,
  linkAllowed, templateItemsDiff, searchTerm, unarchivedStatus, RECORD_STATUSES, RECORD_TITLE_MAX, ITEM_TITLE_MAX } from './records-core.mjs';
import { isUuid, validatePlanFields, validateActPayload, planErrStatus, PLAN_ACT_ACTIONS,
  linkError, effectiveLink, taskPlan, planLinkLabel, planDbError,
  validateSplitPayload, validateProposal, validateDecision, PROPOSAL_MAX } from './plan-core.mjs';
import { normalizeMeasure, publicMetrics, metricByKey } from './plan-metrics.mjs';
import { trendWeeksParam, trendWeekEnds, trendModel, replanMonth, weekEndsIn, readiness, REPLAN_RISK_DAYS, REPLAN_ACTION_DAYS } from './rhythm-core.mjs';
import { buildTree, treeTaskItemIds, TREE_LEVELS } from './tree-core.mjs';
import { templateListRow, templateNodesFor } from './template-core.mjs';
import { slackEvents, slackSignatureOk, parseForm, parseCommand, proposalFrom, parseQuickAdd, USAGE, UNLINKED, taskLink,
  friendlyError, slackApi, slackRespond, resolveSlackPerson, slackEmployee, slackUserEmail, addReply, routeInteraction, taskModal, moveModal, commentModal, messageModal,
  validateTaskSubmission, validateMoveSubmission, validateCommentSubmission, deadlineIso, mineMessage, planOptions,
  lookupEmail } from './slack-core.mjs';
import { WEEK_KEYS, normalizeWeekSettings, resolveWeekFilter, matchesWeek, planWindow, istMidnight, staleCutoff,
  buildPlanWeeks, ROWS_BY, istDate, isDateStr, weekEndOf, effectiveDue, isWorkingDay } from './weeks-core.mjs';
import { SLOT_KEYS, parseReminderSettings, dueSlots, gateRecipients, workingDayAfter, ownerDailySections, ownerDailyMessage,
  chaseTasks, chaseMessage, founderChaseLine, reviewTomorrowMessage, reviewPackMessage, catchupMessage, safeCode, identityTtlMs, lookupOutcome } from './reminders-core.mjs';
import { buildReviewTeams, lastWorkingDay, packToSlack, reprojectPack, packTaskIds, finalSnapshotPack, scoreBlock,
  handoffBucket, foundersHandoffs, isHandoff,
  validateFocusItems, buildAsks, foundersToSlack, noDataSource } from './review-core.mjs';


// ── CORS ──────────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, If-Match',
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
function err(message, status = 400) { return json({ ok: false, error: message }, status); }
function ok(data) { return json({ ok: true, data }); }
function nowIso() { return new Date().toISOString(); }

// ── Supabase REST helpers (one per schema profile) ──────────────────────────
function sbProfile(profile) {
  return async function (path, env, opts = {}) {
    const res = await fetch(`${env.SUPABASE_URL}${path}`, {
      ...opts,
      headers: {
        'Content-Type':    'application/json',
        'apikey':          env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization':   `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Accept-Profile':  profile,
        'Content-Profile': profile,
        'Prefer':          opts.prefer || 'return=representation',
        ...(opts.headers || {}),
      },
    });
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    // contentRange: "0-0/280" when the caller asked for Prefer: count=exact.
    return { ok: res.ok, status: res.status, data, contentRange: res.headers.get('content-range') };
  };
}
const sbDocket = sbProfile('docket');
const sbStore  = sbProfile('store');
const sbPodium = sbProfile('podium');

const enc = encodeURIComponent;
function inList(arr) { return `(${arr.map(enc).join(',')})`; }
function uniq(arr) { return [...new Set(arr.filter(Boolean))]; }
// An `in.(…)` read over many ids, chunked: a few hundred inline UUIDs overflow the URL
// (a 414 whose text body then breaks a caller's .forEach). `build(list)` → the path for one
// chunk; same { ok, status, data } back, data merged. A failing chunk is returned as is.
async function sbIn(sb, ids, build, env, size = 150) {
  if (!ids.length) return { ok: true, status: 200, data: [] };
  const parts = [];
  for (let i = 0; i < ids.length; i += size) parts.push(ids.slice(i, i + size));
  if (parts.length === 1) return sb(build(inList(parts[0])), env);
  const res = await Promise.all(parts.map(p => sb(build(inList(p)), env)));
  const bad = res.find(r => !r.ok);
  if (bad) return bad;
  return { ok: true, status: 200, data: res.flatMap(r => (Array.isArray(r.data) ? r.data : [])) };
}

// Read every row of a GET, a page at a time — PostgREST's max-rows would silently clip one big read
// (a 30-item chart over 30 days is already ~900 ticks).
async function sbAll(sb, path, env, page = 1000) {
  const out = [];
  for (let off = 0; ; off += page) {
    const r = await sb(`${path}&limit=${page}&offset=${off}`, env);
    if (!r.ok) return r;
    const rows = Array.isArray(r.data) ? r.data : [];
    out.push(...rows);
    if (rows.length < page) return { ok: true, status: 200, data: out };
  }
}

// ── Auth ────────────────────────────────────────────────────────────────────
async function verifyJWT(authHeader, env) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  if (!user?.id) return null;

  const profileRes = await sbStore(
    `/rest/v1/users_profile?id=eq.${user.id}&select=role,full_name,active&limit=1`, env);
  let profile = (profileRes.ok && profileRes.data?.[0]) || null;

  // Durable self-provision (2026-06-13): a valid @legendoftoys.com Google login with no
  // users_profile row used to make this return null → Docket hung forever at "Loading"
  // (every new hire who opened Docket before being set up in Garage /users — happened to
  // Chiragh/Nitesh/Rayn/Prarthi/Aakash). Instead, auto-create a least-privilege baseline
  // identity (viewer) so Docket's "no role = baseline" tier works immediately. Domain is
  // already enforced at Google OAuth (RULE-010); re-checked here defensively. Upsert
  // (merge-duplicates) is race-safe for a brand-new user's first concurrent calls. An
  // admin can elevate/deactivate the role later in Garage /users.
  if (!profile) {
    const email = (user.email || '').toLowerCase();
    if (!email.endsWith('@legendoftoys.com')) return null;
    const fname = user.user_metadata?.full_name || user.user_metadata?.name || user.email;
    const ins = await sbStore('/rest/v1/users_profile', env, {
      method: 'POST',
      prefer: 'return=representation,resolution=merge-duplicates',
      body:   JSON.stringify({ id: user.id, full_name: fname, role: 'viewer', active: true }),
    });
    profile = (ins.ok && ins.data?.[0]) || { role: 'viewer', full_name: fname, active: true };
  }
  const auth = await authForUser(user.id, user.email, env, { profile });
  if (auth) auth.bearer = token;
  return auth;
}

// A Supabase auth user → Docket's `auth` object (profile → Docket role → podium employee). Shared by verifyJWT
// (after its /auth/v1/user call + self-provision) and the Slack path (F9 R7a), which calls it directly with
// NO self-provision: a login with no users_profile row, or an inactive one, is refused (null).
async function authForUser(userId, email, env, { profile } = {}) {
  if (!isUuid(userId)) return null;
  if (profile === undefined) {
    const profileRes = await sbStore(
      `/rest/v1/users_profile?id=eq.${userId}&select=role,full_name,active&limit=1`, env);
    profile = (profileRes.ok && profileRes.data?.[0]) || null;
  }
  if (!profile || !profile.active) return null;

  // Permissions from Docket's own layer (RULE-DOCKET-002). No role → {} → baseline.
  const urRes = await sbStore(
    `/rest/v1/docket_user_roles?user_id=eq.${userId}&select=role_key&limit=1`, env);
  const docketRole = (urRes.ok && urRes.data?.[0]?.role_key) || null;
  let permissions = {};
  if (docketRole) {
    const prRes = await sbStore(
      `/rest/v1/docket_roles?role_key=eq.${enc(docketRole)}&select=permissions&limit=1`, env);
    // Normalised here so the implications (plan_admin → admin → view_all) hold on every path,
    // getMe included — the app reads perms straight from getMe.
    permissions = normalizeDocketPerms((prRes.ok && prRes.data?.[0]?.permissions) || {});
  }

  // Resolve the caller's podium employee (for default owner + department scoping).
  const empRes = await sbPodium(
    `/rest/v1/employees?auth_user_id=eq.${userId}&select=id,full_name,department_id,status&limit=1`, env);
  const emp = (empRes.ok && empRes.data?.[0]) || null;

  return {
    userId, email, role: profile.role,
    fullName: profile.full_name, permissions, docketRole,
    employeeId: emp?.id || null, departmentId: emp?.department_id || null,
    employeeActive: emp ? emp.status !== 'exited' : null,
  };
}

// ── Permission helpers ──────────────────────────────────────────────────────
const DOCKET_PERM_KEYS = ['docket_plan_admin', 'docket_admin', 'docket_view_all', 'docket_review'];
function normalizeDocketPerms(permissions) {
  const out = {};
  for (const k of DOCKET_PERM_KEYS) if (permissions && permissions[k]) out[k] = true;
  if (out.docket_plan_admin) out.docket_admin = true; // super admin implies admin
  if (out.docket_admin) out.docket_view_all = true; // footgun guard
  return out;
}
function isPlanAdmin(auth) { return !!auth.permissions?.docket_plan_admin; }
// Level R (F9 R6c): a Founders' Associate who is not also a plan admin (a plan admin is F, which covers R).
function isReviewer(auth) { return !!auth.permissions?.docket_review && !isPlanAdmin(auth); }
function isAdmin(auth)    { return !!auth.permissions?.docket_admin; }
function canViewAll(auth) { return !!(auth.permissions?.docket_admin || auth.permissions?.docket_view_all); }
function requireAdmin(auth) { return isAdmin(auth) ? null : err('forbidden_docket_admin', 403); }

// ── Dashboard sharing (RULE-DOCKET-006) ─────────────────────────────────────
// Dashboard visibility is decoupled from docket_view_all: a persistent global flag
// (docket.settings.dashboard_public) + per-person grants (docket.dashboard_viewers,
// keyed on auth user_id). canViewDashboard = view_all OR public OR granted.
async function dashboardPublic(env) {
  const r = await sbDocket(`/rest/v1/settings?key=eq.dashboard_public&select=value&limit=1`, env);
  return !!(r.ok && r.data?.[0]?.value === true);
}
async function isDashboardViewer(userId, env) {
  if (!userId) return false;
  const r = await sbDocket(`/rest/v1/dashboard_viewers?user_id=eq.${enc(userId)}&select=user_id&limit=1`, env);
  return !!(r.ok && r.data?.length);
}
async function canViewDashboard(auth, env) {
  if (canViewAll(auth)) return true;
  if (await dashboardPublic(env)) return true;
  return isDashboardViewer(auth.userId, env);
}

// Edit a task's core fields: creator, owner or assignee — widened by the task's SPACE (spec §5.1 P0-a):
// in General a docket_admin edits any task; in a PRIVATE space docket_admin adds nothing (RULE-DOCKET-003,
// the gate beats admin) and the space's OWNER edits every task in it (members keep the baseline). The
// space row comes from loadTaskFor / keepAccessible / knowSpaces (spaceOf); an unknown space widens
// nothing — it is never taken for General.
function canEditTask(auth, task) {
  const space = spaceOf(auth, task);
  if (space && space.is_default && isAdmin(auth)) return true;
  if (space && !space.is_default && space.owner_user_id && space.owner_user_id === auth.userId) return true;
  if (space && space.is_founders && isPlanAdmin(auth)) return true;   // both founders, not just its owner
  return task.created_by_user_id === auth.userId
    || (auth.employeeId && task.owner_employee_id === auth.employeeId)
    || (auth.employeeId && task.assignee_employee_id === auth.employeeId);
}
// F9 R8 (spec §4.6): a hand-off's receiving side — the named receiver, or anyone in the receiving department —
// never its owner (the giver can't receive, so can't accept, their own hand-off). Also the accept right.
function isHandoffReceiver(auth, task) {
  return !!task?.handoff_to_department_id && !(auth.employeeId && task.owner_employee_id === auth.employeeId) && (
    (!!auth.employeeId && task.handoff_to_employee_id === auth.employeeId) ||
    (!!auth.departmentId && task.handoff_to_department_id === auth.departmentId));
}
// …which widens VISIBILITY in every space except the Founders' space (P3a, Afshaan 2026-11-13: involvement opens
// the TASK — not its space — and the Founders' space stays sealed). The task's space row must be known
// (loadTaskFor / keepAccessible / knowSpaces); an unknown space widens nothing. Used by canSeeTask and the two
// batched baselines (visibleTaskRows, the stale sweep's parent crumbs). Every private-space row reaches those
// through keepAccessible / loadTaskFor first, which is where involvement opens a space you can't access (the stale
// sweep itself reads your own tasks in any space and gates them there); the SQL list / search / card functions
// carry the same clause since 0037.
function receiverSees(auth, task) { const sp = spaceOf(auth, task); return !!sp && !sp.is_founders && isHandoffReceiver(auth, task); }
// P3a: "involved" in a task = its owner, its assignee, a hand-off receiver (isHandoffReceiver) or a collaborator.
// In any space but the Founders' space that opens THAT task by id and in lists, without space access; edit rights
// stay canEditTask's. The direct part reads the row's own fields — a row read without them is simply not involved
// (fail closed); the collaborator part is one read (isInvolved) or one batched read (keepAccessible).
function involvedDirect(auth, task) {
  return (!!auth.employeeId && (task.owner_employee_id === auth.employeeId || task.assignee_employee_id === auth.employeeId))
    || isHandoffReceiver(auth, task);
}
async function isInvolved(auth, task, env) {
  if (involvedDirect(auth, task)) return true;
  if (!auth.employeeId) return false;
  const c = await sbDocket(
    `/rest/v1/task_collaborators?task_id=eq.${enc(task.id)}&employee_id=eq.${enc(auth.employeeId)}&select=task_id&limit=1`, env);
  return !!(c.ok && c.data?.length);
}
// See a task: view-all, the above, own department, a hand-off's receiving side (General), or a collaborator.
async function canSeeTask(auth, task, env) {
  if (canViewAll(auth) || canEditTask(auth, task)) return true;
  if (auth.departmentId && task.department_id === auth.departmentId) return true;
  if (receiverSees(auth, task)) return true;
  if (!auth.employeeId) return false;
  const c = await sbDocket(
    `/rest/v1/task_collaborators?task_id=eq.${task.id}&employee_id=eq.${auth.employeeId}&select=task_id&limit=1`, env);
  return !!(c.ok && c.data?.length);
}

// `auth` = the request's identity: the actor, and (F9 R6a, §8.3) `source` — 'connector' when the call came
// through the MCP gateway (X-LOT-Source), else 'app' — so a connector update counts but is shown as such.
async function logHistory(env, taskId, auth, eventType, extra = {}) {
  await sbDocket(`/rest/v1/task_history`, env, {
    method: 'POST', prefer: 'return=minimal',
    body: JSON.stringify({
      task_id: taskId, actor_user_id: auth.userId, event_type: eventType,
      field: extra.field || null, old_value: extra.old != null ? String(extra.old) : null,
      new_value: extra.new != null ? String(extra.new) : null, note: extra.note || null,
      source: auth.source || 'app',
    }),
  });
}
// Batched history insert — one POST for N rows (used by bulk update; respects the
// 50-subrequest limit instead of one logHistory await per task). `rows` items take the
// same {task_id, event_type, field, old, new, note} shape as logHistory's args.
async function logHistoryBatch(env, auth, rows) {
  if (!rows.length) return;
  await sbDocket(`/rest/v1/task_history`, env, {
    method: 'POST', prefer: 'return=minimal',
    body: JSON.stringify(rows.map(r => ({
      task_id: r.task_id, actor_user_id: auth.userId, event_type: r.event_type,
      field: r.field || null, old_value: r.old != null ? String(r.old) : null,
      new_value: r.new != null ? String(r.new) : null, note: r.note || null,
      source: auth.source || 'app',
    }))),
  });
}
// F9 R5: EVERY deadline write goes through docket.task_set_deadline — the task and its history row in one
// transaction (the AFTER trigger writes the row), and the week-cohort trigger sees it (spec §8.2). Tasks
// with no deadline at all get the FIRST (immutable) one; the rest are revised, reason required. Migration
// 0023's guard refuses any other UPDATE of tasks.deadline / revised_deadline. Callers check edit rights.
// → { first: [ids], revised: [ids] } | { error: Response }
async function setDeadline(ids, value, reason, auth, env) {
  const r = await sbDocket(`/rest/v1/rpc/task_set_deadline`, env, { method: 'POST', body: JSON.stringify({
    p_actor: auth.userId, p_ids: ids, p_value: value, p_reason: reason == null ? null : String(reason),
    p_source: auth.source || 'app' }) });
  if (!r.ok) {
    const msg = String(r.data?.message || '');
    if (/reason_required/.test(msg)) return { error: err('reason required', 400) };
    if (/reason_too_long/.test(msg)) return { error: err('reason_too_long', 400) };
    return { error: err('update_failed: ' + JSON.stringify(r.data), 400) };
  }
  return { first: r.data?.first || [], revised: r.data?.revised || [] };
}
const hasDeadline = (t) => !!(t.deadline || t.revised_deadline);
const isIsoTime = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && Number.isFinite(Date.parse(v));

// Abandoned tasks are read-only (decisions §[docket] abandoned read-only, functionality F1/G3): every
// single-task write refuses them except changeStatus, which is the Reactivate path.
const abandonedRO = () => err('abandoned_read_only: reactivate the task first', 422);

async function loadTask(id, env) {
  const r = await sbDocket(`/rest/v1/tasks?id=eq.${enc(id)}&select=*&limit=1`, env);
  return (r.ok && r.data?.[0]) || null;
}
// A task the CALLER may act on by id: null (→ 404, no existence leak) when it lives in a private space
// they are not the owner or a member of. RULE-DOCKET-003: the space gate beats docket_admin — before
// 2026-11-11 every write handler took any id, so an admin (or anyone) holding a private task's id (it is
// in every Docket link pasted to Slack) could edit, move, comment on or re-parent it. General-space
// rules (canSeeTask / canEditTask) still apply on top, in each handler.
// P3a: a task the caller is involved in (isInvolved) but whose space they can't access still loads — except in the
// Founders' space — and is marked INVOLVED_ONLY: it opens that task only (never its space, its siblings, a move
// into or out of it). getTask's hydration and moveTask / bulkMoveTasks read the mark.
const TASK_SPACE = new WeakMap();   // task row (from loadTaskFor) → its space row
const INVOLVED_ONLY = new WeakSet(); // task rows (loadTaskFor / keepAccessible) open through involvement alone
async function loadTaskFor(id, auth, env) {
  const task = await loadTask(id, env);
  if (!task) return null;
  const space = await loadSpace(task.space_id, env);
  if (!space) return null;
  if (!(await canAccessSpace(auth, space, env))) {
    if (space.is_founders || !(await isInvolved(auth, task, env))) return null;
    INVOLVED_ONLY.add(task);
  }
  TASK_SPACE.set(task, space);
  noteSpaces(auth, [space]);
  return task;
}
// "Can see" for a task that came through loadTaskFor: General = the V1 baseline (canSeeTask); a private
// space is FLAT — every member sees every task (RULE-DOCKET-003), and loadTaskFor already proved access
// (space access, or involvement — P3a).
async function seesTask(auth, task, env) {
  if (INVOLVED_ONLY.has(task)) return true;
  const space = TASK_SPACE.get(task);
  return space && !space.is_default ? true : canSeeTask(auth, task, env);
}
// Bulk equivalent: drop rows in private spaces the caller doesn't own or belong to (counted "skipped"), but keep
// (P3a) a TASK row the caller is involved in outside the Founders' space, marked INVOLVED_ONLY. Archived spaces
// included, matching loadTaskFor (canAccessSpace ignores archived_at). `involvement: false` for rows that are not
// tasks (checklist records carry owner_employee_id too, and a record never opens through it).
async function keepAccessible(auth, tasks, env, { involvement = true } = {}) {
  if (!tasks.length) return tasks;
  const spaceIds = uniq(tasks.map(t => t.space_id));
  const [sr, mr, team] = await Promise.all([
    sbDocket(`/rest/v1/spaces?id=in.${inList(spaceIds)}&select=${SPACE_COLS}`, env),
    sbDocket(`/rest/v1/space_members?space_id=in.${inList(spaceIds)}&user_id=eq.${enc(auth.userId)}&select=space_id`, env),
    teamSpaceSet(auth, env),
  ]);
  if (!sr.ok || !mr.ok) return [];   // fail closed
  noteSpaces(auth, sr.data || []);
  const member = new Set((mr.data || []).map(m => m.space_id));
  const ok = new Set((sr.data || []).filter(sp => sp.is_default || sp.owner_user_id === auth.userId || member.has(sp.id) || (team.has(sp.id) && !sp.is_founders)
    || planAdminSpace(auth, sp) || viewAllSpace(auth, sp)).map(sp => sp.id));
  if (!involvement) return tasks.filter(t => ok.has(t.space_id));
  // Involvement: only rows read WITH the involvement fields, in a known space that isn't the Founders' space.
  const sealed = new Set((sr.data || []).filter(sp => sp.is_founders).map(sp => sp.id));
  const known = new Set((sr.data || []).map(sp => sp.id));
  const cand = tasks.filter(t => !ok.has(t.space_id) && known.has(t.space_id) && !sealed.has(t.space_id) && 'owner_employee_id' in t);
  const candRows = new Set(cand);
  const involved = new Set(cand.filter(t => involvedDirect(auth, t)).map(t => t.id));
  const needCollab = cand.filter(t => !involved.has(t.id)).map(t => t.id);
  if (needCollab.length && auth.employeeId) {
    const c = await sbIn(sbDocket, needCollab, l => `/rest/v1/task_collaborators?task_id=in.${l}&employee_id=eq.${enc(auth.employeeId)}&select=task_id`, env);
    if (c.ok) (c.data || []).forEach(x => involved.add(x.task_id));   // a failed read adds no one (fail closed)
  }
  return tasks.filter(t => {
    if (ok.has(t.space_id)) return true;
    if (!candRows.has(t) || !involved.has(t.id)) return false;
    INVOLVED_ONLY.add(t);
    return true;
  });
}
// The space rows this request has already read, by id (canEditTask needs a task's space — spec §5.1
// P0-a). Fed by loadTaskFor, keepAccessible and knowSpaces; one Map per request, on the auth object.
const SPACE_COLS = 'id,name,is_default,is_private,owner_user_id,is_founders,is_personal,archived_at';   // archived_at: planAdminSpace
function noteSpaces(auth, rows) {
  const m = auth._spaceRows || (auth._spaceRows = new Map());
  for (const s of rows || []) if (s && s.id) m.set(s.id, s);
}
function spaceOf(auth, task) {
  return (task && (TASK_SPACE.get(task) || auth._spaceRows?.get(task.space_id))) || null;
}
// Read (once, batched) the spaces of these task rows that this request hasn't seen yet.
async function knowSpaces(auth, tasks, env) {
  const known = auth._spaceRows || new Map();
  const ids = uniq((tasks || []).map(t => t.space_id)).filter(id => !known.has(id));
  if (!ids.length) return;
  const r = await sbIn(sbDocket, ids, l => `/rest/v1/spaces?id=in.${l}&select=${SPACE_COLS}`, env);
  if (r.ok) noteSpaces(auth, r.data || []);
}
function isHttpUrl(u) { return typeof u === 'string' && /^https?:\/\//i.test(u.trim()); }

// ── Presence: stamp last_seen_at (app load via getMe + every mutation). ───────
// No login log exists otherwise; this drives the Dashboard's "last seen" column.
async function touchActivity(auth, env) {
  if (!auth?.userId) return;
  try {
    await sbDocket(`/rest/v1/user_activity?on_conflict=user_id`, env, {
      method: 'POST', prefer: 'return=minimal,resolution=merge-duplicates',
      body: JSON.stringify({ user_id: auth.userId, last_seen_at: nowIso() }),
    });
  } catch { /* presence is best-effort — never block the request */ }
}

// ── Checklists / recurring tasks (RULE-DOCKET-008) ───────────────────────────
// A recurring task is a docket.tasks row (is_recurring=true + recurrence jsonb); per-day
// completion lives in docket.checklist_completions. All date math is IST (Asia/Kolkata).
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
function validateRecurrence(rec) {
  if (!rec || typeof rec !== 'object') return 'recurrence required';
  if (!['daily', 'weekly', 'monthly'].includes(rec.freq)) return 'invalid freq';
  if (!TIME_RE.test(rec.time || '')) return 'invalid time (HH:MM)';
  if (rec.freq === 'weekly') {
    if (!Array.isArray(rec.days_of_week) || !rec.days_of_week.length) return 'weekly needs days_of_week';
    if (rec.days_of_week.some(x => !Number.isInteger(Number(x)) || x < 0 || x > 6)) return 'days_of_week must be 0..6';
  }
  if (rec.freq === 'monthly') {
    const dom = Number(rec.day_of_month);
    if (!Number.isInteger(dom) || dom < 1 || dom > 31) return 'day_of_month must be 1..31';
  }
  if (rec.until != null && rec.until !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rec.until) || isNaN(new Date(`${rec.until}T00:00:00Z`))) return 'invalid until (YYYY-MM-DD)';
  }
  return null;
}
function normalizeRecurrence(rec) {
  const out = { freq: rec.freq, time: rec.time };
  if (rec.freq === 'weekly') out.days_of_week = uniq(rec.days_of_week.map(Number)).sort((a, b) => a - b);
  if (rec.freq === 'monthly') out.day_of_month = Number(rec.day_of_month);
  if (rec.until) out.until = rec.until;                   // optional expiry (IST date); omitted = never expires
  return out;
}
// ── Register helpers (F8 P1) ──
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// A real calendar date ('2026-00-01' / '2026-02-30' pass the regex but are not dates — review #8).
function isValidDate(s) { if (!DATE_RE.test(s || '')) return false; const d = new Date(`${s}T12:00:00Z`); return !isNaN(d) && d.toISOString().slice(0, 10) === s; }
// Recurring tasks in a private space the caller can't open stay hidden (review #1) — your own always show.
// P3a involvement beyond ownership deliberately not applied: a recurring checklist is its owner's (RULE-DOCKET-008).
async function visibleRecurring(tasks, auth, env) {
  if (!tasks.some(t => t.space_id && t.owner_employee_id !== auth.employeeId)) return tasks;
  auth._scopeP = auth._scopeP || programScopeArgs(auth, env);
  const { memberSpaceIds, defaultId } = await auth._scopeP;
  const ok = new Set([defaultId, ...(memberSpaceIds || [])]);
  return tasks.filter(t => t.owner_employee_id === auth.employeeId || !t.space_id || ok.has(t.space_id));
}
function addDays(dateStr, n) { const d = new Date(`${dateStr}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function datesBetween(from, to) { const out = []; for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d); return out; }
// A tick is recorded for today or a past date only (S250 / F8 C2): a future tick would make adherence unauditable.
function futureDateErr(date) { return date > istDateStr() ? err('future_date', 422) : null; }
// Person-level checklist visibility: view_all, self, or same department (mirrors task baseline).
function canViewChecklistOf(auth, targetEmp) {
  if (canViewAll(auth)) return true;
  if (auth.employeeId && targetEmp.id === auth.employeeId) return true;
  if (auth.departmentId && targetEmp.department_id && targetEmp.department_id === auth.departmentId) return true;
  return false;
}

// ── Checklist TEMPLATES (structured, role-linked SOPs). RULE-DOCKET-009. ─────
// A template (docket.checklist_templates) has sections → items, is assigned to people
// (checklist_assignments), and runs per its own recurrence (no single time — times live
// on sections). A "run" for (template, person, date) is DERIVED from item completions +
// section comments. Templates are NOT docket.tasks → off the board + dashboard.
const CHECKLIST_TAGS = ['Critical', 'QC', 'Deadline', 'Ongoing'];

// Template recurrence is like a task recurrence but WITHOUT `time` (sections carry times).
function validateTemplateRecurrence(rec) {
  if (!rec || typeof rec !== 'object') return 'recurrence required';
  if (!['daily', 'weekly', 'monthly'].includes(rec.freq)) return 'invalid freq';
  if (rec.freq === 'weekly') {
    if (!Array.isArray(rec.days_of_week) || !rec.days_of_week.length) return 'weekly needs days_of_week';
    if (rec.days_of_week.some(x => !Number.isInteger(Number(x)) || x < 0 || x > 6)) return 'days_of_week must be 0..6';
  }
  if (rec.freq === 'monthly') {
    const dom = Number(rec.day_of_month);
    if (!Number.isInteger(dom) || dom < 1 || dom > 31) return 'day_of_month must be 1..31';
  }
  if (rec.until != null && rec.until !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rec.until)) return 'invalid until (YYYY-MM-DD)';
  }
  return null;
}
function normalizeTemplateRecurrence(rec) {
  const out = { freq: rec.freq };
  if (rec.freq === 'weekly') out.days_of_week = uniq(rec.days_of_week.map(Number)).sort((a, b) => a - b);
  if (rec.freq === 'monthly') out.day_of_month = Number(rec.day_of_month);
  if (rec.until) out.until = rec.until;
  return out;
}
function sanitizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return uniq(tags.filter(t => CHECKLIST_TAGS.includes(t)));
}
function canEditTemplate(auth, tmpl) {
  return isAdmin(auth) || tmpl.created_by_user_id === auth.userId;
}
async function loadTemplate(id, env) {
  const r = await sbDocket(`/rest/v1/checklist_templates?id=eq.${enc(id)}&select=*&limit=1`, env);
  return (r.ok && r.data?.[0]) || null;
}
// F8 P2: 'routine' (S127 / P1 — recurring, assigned, ticked per date) or 'record' (copied per subject, ticked once).
const TEMPLATE_KINDS = ['routine', 'record'];
const RECORD_RECURRENCE = { freq: 'none' };   // isDueOn → never due; record templates are never assigned
// A template's sections, each with its items (paged reads, not one per section) — for snapshots, pulls and the
// version diff. null when either read fails: a half-read template must never become a record or a diff.
async function templateSections(templateId, env) {
  const sr = await sbAll(sbDocket, `/rest/v1/checklist_template_sections?template_id=eq.${enc(templateId)}&select=id,title,sort_order&order=sort_order.asc,id.asc`, env);
  if (!sr.ok) return null;
  const secs = sr.data || [];
  const ir = await sbInAll(sbDocket, secs.map(x => x.id), l => `/rest/v1/checklist_template_items?section_id=in.${l}&select=id,section_id,title,help_text,sort_order&order=sort_order.asc,id.asc`, env);
  if (!ir.ok) return null;
  const bySec = {}; (ir.data || []).forEach(i => { (bySec[i.section_id] ||= []).push(i); });
  return secs.map(x => ({ ...x, items: bySec[x.id] || [] }));
}
// The set of employee_ids a caller may MONITOR (Oversight scope, R1):
// view_all → everyone; else direct reports ∪ people I assigned a template/recurring task to.
async function peopleInScope(auth, env) {
  if (canViewAll(auth)) {
    const r = await sbPodium(`/rest/v1/employees?status=eq.active&select=id`, env);
    return new Set((r.ok ? r.data : []).map(e => e.id));
  }
  const ids = new Set();
  const [rep, ta, rt] = await Promise.all([
    auth.employeeId
      ? sbPodium(`/rest/v1/employees?status=eq.active&manager_id=eq.${enc(auth.employeeId)}&select=id`, env)
      : Promise.resolve({ ok: true, data: [] }),
    sbDocket(`/rest/v1/checklist_assignments?assigned_by_user_id=eq.${enc(auth.userId)}&unassigned_at=is.null&select=employee_id`, env),
    sbDocket(`/rest/v1/tasks?is_recurring=eq.true&status=neq.abandoned&created_by_user_id=eq.${enc(auth.userId)}&select=owner_employee_id`, env),
  ]);
  (rep.ok ? rep.data : []).forEach(e => ids.add(e.id));
  (ta.ok ? ta.data : []).forEach(a => ids.add(a.employee_id));
  (rt.ok ? rt.data : []).forEach(t => { if (t.owner_employee_id && t.owner_employee_id !== auth.employeeId) ids.add(t.owner_employee_id); });
  return ids;
}

// ── Space helpers (RULE-DOCKET-003) ─────────────────────────────────────────
async function loadSpace(id, env) {
  const r = await sbDocket(`/rest/v1/spaces?id=eq.${enc(id)}&select=*&limit=1`, env);
  return (r.ok && r.data?.[0]) || null;
}
// Create / owner defaults (Afshaan 2026-11-13). Both are best-effort: a failed read leaves the field blank
// (as it was before the default existed) and never fails the write.
// A task's team defaults to its owner's team.
async function employeeDept(empId, env) {
  if (!empId || !isUuid(String(empId))) return null;
  const r = await sbPodium(`/rest/v1/employees?id=eq.${enc(empId)}&select=department_id&limit=1`, env);
  return (r.ok && r.data?.[0]?.department_id) || null;
}
// A personal space: private, not the Founders' space, live, and nobody in it but the caller (as owner and/or
// the only member). A new top-level task there defaults to the caller as owner. A shared private space doesn't.
async function isPersonalSpace(space, auth, env) {
  if (!space?.is_private || space.is_founders || space.archived_at || !auth.employeeId) return false;
  if (space.is_personal) return space.owner_user_id === auth.userId;   // P2 (0036): THE personal space
  if (space.owner_user_id && space.owner_user_id !== auth.userId) return false;
  const [r, tr] = await Promise.all([
    sbDocket(`/rest/v1/space_members?space_id=eq.${enc(space.id)}&select=user_id`, env),
    sbDocket(`/rest/v1/space_teams?space_id=eq.${enc(space.id)}&select=department_id&limit=1`, env),
  ]);
  if (!r.ok || !tr.ok || (tr.data || []).length) return false;   // shared with a team → not personal
  const ids = (r.data || []).map(m => m.user_id);
  return (space.owner_user_id === auth.userId || ids.includes(auth.userId)) && ids.every(u => u === auth.userId);
}
async function defaultSpaceId(env) {
  const r = await sbDocket(`/rest/v1/spaces?is_default=eq.true&select=id&limit=1`, env);
  return (r.ok && r.data?.[0]?.id) || null;
}
// P2 (0036): the caller's personal space id — created on first use. Once per request; null on failure.
function personalSpaceId(auth, env) {
  if (!auth._personalP) {
    auth._personalP = sbDocket(`/rest/v1/rpc/ensure_personal_space`, env, { method: 'POST', body: JSON.stringify({ p_user: auth.userId }) })
      .then(r => (r.ok && typeof r.data === 'string' && isUuid(r.data)) ? r.data : null, () => null);
  }
  return auth._personalP;
}
// P3b (0038): a team's home space (spaces.home_department_id) if the caller can open it, else null. A failed read
// (e.g. before 0038) is null too — the caller then falls back to Personal, never to a space it can't open.
async function homeSpaceFor(auth, deptId, env) {
  if (!deptId || !isUuid(String(deptId))) return null;
  const r = await sbDocket(`/rest/v1/spaces?home_department_id=eq.${deptId}&archived_at=is.null&select=${SPACE_COLS}&limit=1`, env);
  const sp = r.ok ? r.data?.[0] : null;
  return sp && await canWriteSpace(auth, sp, env) ? sp.id : null;
}
// Where work lands when the caller names no space — that team's home space, else the caller's Personal space.
// Null only if both fail (the caller errors).
async function defaultTargetSpace(auth, deptId, env) {
  return (await homeSpaceFor(auth, deptId, env)) || personalSpaceId(auth, env);
}
// A task row that only its caller needs to see (P2): owned by the caller (never ownerless — that belongs in
// The Grid), no other team, no hand-off, no plan / program link, not a checklist task, no collaborators. Only
// such a task may be MOVED into a personal space (a personal space hides it from the team, view_all and admins;
// its owner / receivers / collaborators still see it — P3a). A create with no space lands there only when its
// team has no home space the caller can open (defaultTargetSpace, P3b).
function isJustMine(t, auth) {
  if (!auth.employeeId || !t.owner_employee_id || lcId(t.owner_employee_id) !== lcId(auth.employeeId)) return false;
  if (t.department_id && lcId(t.department_id) !== lcId(auth.departmentId || '')) return false;
  if (t.handoff_to_department_id || t.handoff_to_employee_id) return false;
  if (t.plan_item_id || t.program_id || t.is_recurring) return false;
  return true;
}
// Which of these top-level task ids can't move into a personal space: the task or any sub-task isn't just the
// caller's, or anyone collaborates on them. Fails closed (a failed read blocks them all).
async function personalMoveBlocks(auth, ids, env) {
  if (!ids.length) return new Set();
  const fr = await sbDocket(`/rest/v1/tasks?or=(id.in.${inList(ids)},parent_task_id.in.${inList(ids)})&select=id,parent_task_id,owner_employee_id,department_id,handoff_to_department_id,handoff_to_employee_id,plan_item_id,program_id,is_recurring`, env);
  if (!fr.ok) return new Set(ids);
  const rows = fr.data || [];
  const famOf = (r) => r.parent_task_id || r.id;
  const cr = rows.length ? await sbDocket(`/rest/v1/task_collaborators?task_id=in.${inList(rows.map(r => r.id))}&select=task_id`, env) : { ok: true, data: [] };
  if (!cr.ok) return new Set(ids);
  const collab = new Set((cr.data || []).map(c => c.task_id));
  const blocked = new Set();
  for (const r of rows) if (!isJustMine(r, auth) || collab.has(r.id)) blocked.add(famOf(r));
  return blocked;
}
async function isSpaceMember(spaceId, userId, env) {
  const r = await sbDocket(`/rest/v1/space_members?space_id=eq.${enc(spaceId)}&user_id=eq.${enc(userId)}&select=user_id&limit=1`, env);
  return !!(r.ok && r.data?.length);
}
// Team shares (P1, migration 0034): a private space shared with a team is open to every live member of
// that team, exactly like a named member. The caller's team = their linked Podium employee's department,
// and an exited employee has none. Read once per request; a failed read grants nothing (fail closed).
function callerTeam(auth) { return (auth.employeeActive === false) ? null : (auth.departmentId || null); }
function teamSpaceSet(auth, env) {
  if (!auth._teamSpacesP) {
    const team = callerTeam(auth);
    auth._teamSpacesP = !team ? Promise.resolve(new Set())
      : sbDocket(`/rest/v1/space_teams?department_id=eq.${enc(team)}&select=space_id`, env)
          .then(r => new Set(r.ok ? (r.data || []).map(x => x.space_id) : []), () => new Set());
  }
  return auth._teamSpacesP;
}
// P3a (Afshaan 2026-11-13): the founders — plan admins — see every live TEAM space: any private, non-archived space
// that is not someone's personal space (spaces.is_personal), the Founders' space included. Never a personal or an
// archived space; a row read without is_personal / archived_at opens nothing (fail closed). SEE, not edit: the
// docket_admin overrides (comments, records) need real rights in the space — adminActsIn.
function planAdminSpace(auth, space) {
  return isPlanAdmin(auth) && !!space && !!space.is_private && !space.is_default && space.is_personal === false
    && 'archived_at' in space && !space.archived_at;
}
// P3b (Afshaan 2026-11-13): docket_view_all / docket_admin holders keep seeing every team's work once General's tasks
// move into team spaces — READ every live team space, never a personal one or the Founders' space. Read only: they
// can't add, move or apply into it (canWriteSpace), and edits stay canEditTask's (the space adds nothing).
function viewAllSpace(auth, space) {
  return canViewAll(auth) && !!space && !!space.is_private && !space.is_default && space.is_personal === false
    && space.is_founders === false && 'archived_at' in space && !space.archived_at;
}
// Can the caller READ a space at all? General = everyone; private = owner, member, or a member of a team
// it is shared with; a plan admin, any team space (planAdminSpace). (docket_admin is NOT special here — strict
// separation — unless they've broken-glass in.)
async function canAccessSpace(auth, space, env) {
  return planAdminSpace(auth, space) || viewAllSpace(auth, space) || canAccessSpaceDirect(auth, space, env);
}
// May the caller PUT work in this space (create, move in, apply a template, a new record)? As canAccessSpace, less
// the view-all read (viewAllSpace).
async function canWriteSpace(auth, space, env) {
  return planAdminSpace(auth, space) || canAccessSpaceDirect(auth, space, env);
}
// The same rule WITHOUT planAdminSpace: real rights in the space (owner, member, team share), for what a plan admin's
// "see every team space" must not widen.
async function canAccessSpaceDirect(auth, space, env) {
  if (!space) return false;
  if (space.is_default) return true;
  if (space.owner_user_id === auth.userId) return true;
  if (await isSpaceMember(space.id, auth.userId, env)) return true;
  // A team share never opens the Founders' space (refused at share time and by the 0035 trigger; this is the
  // read-side belt for a stray row).
  return !space.is_founders && (await teamSpaceSet(auth, env)).has(space.id);
}
// P3a: does a docket_admin's override (edit someone's comment / record) apply in this space? Only in General, in the
// Founders' space for a plan admin, or where the admin has real rights (canAccessSpaceDirect) — never through
// planAdminSpace alone (founders SEE every team space; they don't edit others' work in it).
async function adminActsIn(auth, space, env) {
  if (!isAdmin(auth) || !space) return false;
  if (space.is_default || (space.is_founders && isPlanAdmin(auth))) return true;
  return canAccessSpaceDirect(auth, space, env);
}
// Batched for a list: the ids of these space rows (accessibleSpaces' shape or SPACE_COLS) where adminActsIn holds.
async function adminSpaceIds(auth, spaces, env) {
  if (!isAdmin(auth) || !spaces.length) return new Set();
  const [mr, team] = await Promise.all([
    sbDocket(`/rest/v1/space_members?user_id=eq.${enc(auth.userId)}&select=space_id`, env), teamSpaceSet(auth, env)]);
  const member = new Set(mr.ok ? (mr.data || []).map(m => m.space_id) : []);   // a failed read grants nothing
  return new Set(spaces.filter(s => s.is_default || s.is_private === false || (s.is_founders && isPlanAdmin(auth))
    || s.is_owner === true || s.owner_user_id === auth.userId || member.has(s.id) || (team.has(s.id) && !s.is_founders)).map(s => s.id));
}
function isSpaceOwner(auth, space) { return !!space && space.owner_user_id === auth.userId; }
async function logSpace(env, spaceId, actor, action, note = null) {
  await sbDocket(`/rest/v1/space_history`, env, { method: 'POST', prefer: 'return=minimal',
    body: JSON.stringify({ space_id: spaceId, actor_user_id: actor, action, note }) });
}
// Accessible spaces for the sidebar: General + owned / member / team-shared private spaces (non-archived); a plan
// admin also every live team space (planAdminSpace — never a personal one). A task open through involvement alone
// (P3a) never puts its space here.
async function accessibleSpaces(auth, env) {
  const [defRes, memberRes, team] = await Promise.all([
    sbDocket(`/rest/v1/spaces?is_default=eq.true&archived_at=is.null&select=id,name,is_private,owner_user_id,is_founders&limit=1`, env),
    sbDocket(`/rest/v1/space_members?user_id=eq.${enc(auth.userId)}&select=space_id`, env),
    teamSpaceSet(auth, env),
  ]);
  const directIds = (memberRes.ok ? memberRes.data : []).map(m => m.space_id);
  const memberIds = uniq([...directIds, ...team]);
  const direct = new Set(directIds);
  const orParts = [`owner_user_id.eq.${auth.userId}`];
  if (memberIds.length) orParts.push(`id.in.${inList(memberIds)}`);
  if (isPlanAdmin(auth) || canViewAll(auth)) orParts.push('is_personal.is.false');   // every team space (is_private=eq.true below)
  const ownedRes = await sbDocket(
    `/rest/v1/spaces?is_private=eq.true&archived_at=is.null&or=(${orParts.join(',')})&select=id,name,is_private,owner_user_id,is_founders,is_personal,archived_at,home_department_id&order=name.asc`, env);
  const general = (defRes.ok && defRes.data) || [];
  // A Founders' space reached only through a team share is dropped (see canAccessSpace).
  const privates = ((ownedRes.ok && ownedRes.data) || []).filter(s => !s.is_founders || s.owner_user_id === auth.userId || direct.has(s.id) || planAdminSpace(auth, s));
  // (viewAllSpace never opens the Founders' space; the filter above already drops it for a non-member.)
  return [...general, ...privates].map(s => ({ id: s.id, name: s.name, is_private: s.is_private, is_owner: s.owner_user_id === auth.userId,
    ...(s.is_founders ? { is_founders: true } : {}), ...(s.is_personal ? { is_personal: true } : {}),
    ...(s.home_department_id ? { home_department_id: s.home_department_id } : {}) }));
}

// ════════════════════════════════════════════════════════════════════════════
// GET handlers
// ════════════════════════════════════════════════════════════════════════════
async function getMe(url, auth, env) {
  let [spaces, can_view_dashboard] = await Promise.all([
    accessibleSpaces(auth, env),
    canViewDashboard(auth, env),
    touchActivity(auth, env),   // app-load presence ping (RULE-DOCKET-008 / last-seen)
  ]);
  // P2: everyone has a personal space — made on the first app load that finds none (one extra read, once).
  if (!spaces.some(s => s.is_personal && s.is_owner) && await personalSpaceId(auth, env)) spaces = await accessibleSpaces(auth, env);
  // Programs sidebar (cross-space): only programs the caller has >=1 visible task in, with counts.
  const memberSpaceIds = spaces.filter(s => s.is_private).map(s => s.id);
  const defaultId = (spaces.find(s => !s.is_private) || {}).id || await defaultSpaceId(env);
  // Space badges (S309) run alongside the programs call, not after it — both are
  // independent reads and getMe is on the app-load path.
  const [programs, spaceCounts] = await Promise.all([
    programsForUser(auth, memberSpaceIds, defaultId, env),
    spaceCountsForUser(auth, spaces.map(s => s.id), env),
  ]);
  // A space with no open work is ABSENT from the RPC result and is left without a
  // task_count entirely, so the sidebar renders no badge rather than a "0" — a zero
  // badge reads as a broken counter, not as an empty space.
  const countBySpace = Object.create(null);
  for (const c of spaceCounts) countBySpace[c.space_id] = Number(c.task_count) || 0;
  return ok({
    id: auth.userId, email: auth.email, role: auth.role, full_name: auth.fullName,
    permissions: auth.permissions || {}, employee_id: auth.employeeId, department_id: auth.departmentId,
    spaces: spaces.map(s => (countBySpace[s.id] ? { ...s, task_count: countBySpace[s.id] } : s)),
    programs, can_view_dashboard,
  });
}
// Cross-space program scope: the caller's accessible private spaces (owned+member) + General id.
async function programScopeArgs(auth, env) {
  const spaces = await accessibleSpaces(auth, env);
  const memberSpaceIds = spaces.filter(s => s.is_private).map(s => s.id);
  const defaultId = (spaces.find(s => !s.is_private) || {}).id || await defaultSpaceId(env);
  return { memberSpaceIds, defaultId };
}
async function programsForUser(auth, memberSpaceIds, defaultId, env) {
  const r = await sbDocket(`/rest/v1/rpc/programs_for_user`, env, { method: 'POST', body: JSON.stringify({
    p_user: auth.userId, p_employee: auth.employeeId, p_dept: auth.departmentId,
    p_view_all: canViewAll(auth), p_member_space_ids: memberSpaceIds, p_default_space_id: defaultId,
  }) });
  return (r.ok && r.data) || [];
}
// Sidebar space badges (S309). Counts OPEN, non-recurring, TOP-LEVEL tasks only —
// see migration 0011 for why, and note it deliberately will NOT equal the row count
// on the board you land on (the board applies no status filter and nests sub-tasks).
// Visibility inside the RPC mirrors list_tasks, so General is narrowed to the
// caller's own relation unless they hold view-all; passing the space ids alone
// would otherwise leak the SIZE of everyone's work in General.
async function spaceCountsForUser(auth, spaceIds, env) {
  if (!spaceIds.length) return [];
  const r = await sbDocket(`/rest/v1/rpc/space_counts_for_user`, env, { method: 'POST', body: JSON.stringify({
    p_user: auth.userId, p_employee: auth.employeeId, p_dept: auth.departmentId,
    p_view_all: canViewAll(auth), p_space_ids: spaceIds,
  }) });
  return (r.ok && r.data) || [];
}
async function getDepartments(url, auth, env) {
  const r = await sbPodium(`/rest/v1/departments?select=id,name,active&order=name.asc`, env);
  if (!r.ok) return err('db_error', 500);
  return ok(r.data || []);
}
async function getEmployees(url, auth, env) {
  // auth_user_id is needed by the space-member picker (membership keys on user_id).
  const r = await sbPodium(
    `/rest/v1/employees?status=eq.active&select=id,full_name,department_id,auth_user_id&order=full_name.asc`, env);
  if (!r.ok) return err('db_error', 500);
  return ok(r.data || []);
}
async function getPrograms(url, auth, env) {
  const r = await sbDocket(`/rest/v1/programs?archived_at=is.null&select=id,name,color&order=name.asc`, env);
  if (!r.ok) return err('db_error', 500);
  return ok(r.data || []);
}
async function getSpaces(url, auth, env) { return ok(await accessibleSpaces(auth, env)); }
async function getSpaceMembers(url, auth, env) {
  const spaceId = url.searchParams.get('space_id');
  if (!spaceId) return err('space_id required', 400);
  const space = await loadSpace(spaceId, env);
  if (!space) return err('space_not_found', 404);
  // Members and the owner only (spec §5.1 P0-a): a non-member admin gets counts from getAllSpaces, never names.
  if (!(await canAccessSpace(auth, space, env))) return err('forbidden_space', 403);
  const mr = await sbDocket(`/rest/v1/space_members?space_id=eq.${enc(spaceId)}&select=user_id,added_at&order=added_at.asc`, env);
  const ids = uniq((mr.data || []).map(m => m.user_id));
  const up = ids.length ? await sbStore(`/rest/v1/users_profile?id=in.${inList(ids)}&select=id,full_name`, env) : { data: [] };
  const name = {}; (up.data || []).forEach(u => { name[u.id] = u.full_name; });
  return ok((mr.data || []).map(m => ({ user_id: m.user_id, full_name: name[m.user_id] || null, is_owner: m.user_id === space.owner_user_id })));
}
// The teams a space is shared with (P1, 0034) — same gate as getSpaceMembers.
async function getSpaceTeams(url, auth, env) {
  const spaceId = url.searchParams.get('space_id');
  if (!spaceId) return err('space_id required', 400);
  const space = await loadSpace(spaceId, env);
  if (!space) return err('space_not_found', 404);
  if (!(await canAccessSpace(auth, space, env))) return err('forbidden_space', 403);
  const tr = await sbDocket(`/rest/v1/space_teams?space_id=eq.${enc(spaceId)}&select=department_id,added_at&order=added_at.asc`, env);
  if (!tr.ok) return err('db_error', 500);
  const ids = uniq((tr.data || []).map(t => t.department_id));
  const dr = ids.length ? await sbPodium(`/rest/v1/departments?id=in.${inList(ids)}&select=id,name`, env) : { ok: true, data: [] };
  if (!dr.ok) return err('db_error', 500);
  const name = {}; (dr.data || []).forEach(d => { name[d.id] = d.name; });
  return ok((tr.data || []).map(t => ({ department_id: t.department_id, name: name[t.department_id] || null })));
}
// Admin break-glass list — metadata only (names/owner/counts), never task contents.
async function getAllSpaces(url, auth, env) {
  const gate = requireAdmin(auth); if (gate) return gate;
  const [spaces, members, teams] = await Promise.all([
    sbDocket(`/rest/v1/spaces?select=*&order=is_default.desc,name.asc`, env),
    sbDocket(`/rest/v1/space_members?select=space_id`, env),
    sbDocket(`/rest/v1/space_teams?select=space_id`, env),
  ]);
  if (!spaces.ok) return err('db_error', 500);
  const mCount = {}; (members.data || []).forEach(m => { mCount[m.space_id] = (mCount[m.space_id] || 0) + 1; });
  const tCount = {}; (teams.data || []).forEach(t => { tCount[t.space_id] = (tCount[t.space_id] || 0) + 1; });
  const ownerIds = uniq((spaces.data || []).map(s => s.owner_user_id));
  const up = ownerIds.length ? await sbStore(`/rest/v1/users_profile?id=in.${inList(ownerIds)}&select=id,full_name`, env) : { data: [] };
  const oName = {}; (up.data || []).forEach(u => { oName[u.id] = u.full_name; });
  return ok((spaces.data || []).map(s => ({ ...s, owner_name: oName[s.owner_user_id] || null, member_count: mCount[s.id] || 0, team_count: tCount[s.id] || 0 })));
}

// ── F7 dependencies (migration 0013, spec 2026-11-11-docket-dependencies.md §7) ─────────────
// task_links_for returns raw ids + the other end's status (open counts only, never sent for a hidden
// task); task_cards applies getTask's gate and nulls everything about a task the caller can't open.
const isOpenStatus = s => s !== 'done' && s !== 'abandoned';
// The app sends force: true; the MCP gateway's boolean params arrive as the string 'true'.
const isForce = v => v === true || v === 'true';
async function rawLinks(taskIds, env) {
  if (!taskIds.length) return [];
  const r = await sbDocket(`/rest/v1/rpc/task_links_for`, env, { method: 'POST', body: JSON.stringify({ p_task_ids: taskIds }) });
  return (r.ok && Array.isArray(r.data)) ? r.data : [];
}
function linkCounts(raw) {
  const m = {};
  raw.forEach(l => {
    const c = m[l.task_id] = m[l.task_id] || { waiting_open: 0, waiting_total: 0, blocking_open: 0, related_count: 0 };
    if (l.direction === 'waiting_on') { c.waiting_total++; if (isOpenStatus(l.other_status)) c.waiting_open++; }
    else if (l.direction === 'blocking') { if (isOpenStatus(l.other_status)) c.blocking_open++; }
    else c.related_count++;
  });
  return m;
}
async function taskCards(ids, auth, env) {
  const out = {};
  if (!ids.length) return out;
  // One accessibleSpaces read per request, however many card lookups it makes (hostile review #8).
  auth._scopeP = auth._scopeP || programScopeArgs(auth, env);
  const { memberSpaceIds, defaultId } = await auth._scopeP;
  const r = await sbDocket(`/rest/v1/rpc/task_cards`, env, { method: 'POST', body: JSON.stringify({
    p_ids: ids, p_user: auth.userId, p_employee: auth.employeeId, p_dept: auth.departmentId,
    p_view_all: canViewAll(auth), p_member_space_ids: memberSpaceIds, p_default_space_id: defaultId,
  }) });
  (r.ok && Array.isArray(r.data) ? r.data : []).forEach(c => { out[c.id] = c; });
  return out;
}
const cardLabel = c => (c && c.visible) ? `${c.task_no} · ${c.title}` : 'a task you can’t see';
async function buildLinks(taskId, auth, env) {
  const mine = (await rawLinks([taskId], env)).filter(l => l.task_id === taskId);
  // hidden_links carries ids only, so a link to a task the caller can no longer open can still be removed
  // from the end they CAN edit (hostile review #4) — no title, number or status of the hidden task.
  const out = { waiting_on: [], blocking: [], related: [], hidden: { waiting_on: 0, blocking: 0, related: 0 }, hidden_links: [], waiting_open: 0, blocking_open: 0 };
  if (!mine.length) return out;
  const cards = await taskCards(uniq(mine.map(l => l.other_id)), auth, env);
  const empIds = uniq(Object.values(cards).filter(c => c.visible).map(c => c.owner_employee_id));
  const empRes = empIds.length ? await sbPodium(`/rest/v1/employees?id=in.${inList(empIds)}&select=id,full_name`, env) : { data: [] };
  const empName = {}; (empRes.data || []).forEach(e => { empName[e.id] = e.full_name; });
  mine.forEach(l => {
    if (l.direction === 'waiting_on' && isOpenStatus(l.other_status)) out.waiting_open++;
    if (l.direction === 'blocking' && isOpenStatus(l.other_status)) out.blocking_open++;
    const c = cards[l.other_id];
    if (!c || !c.visible) { out.hidden[l.direction]++; out.hidden_links.push({ link_id: l.link_id, direction: l.direction }); return; }
    out[l.direction].push({
      link_id: l.link_id, kind: l.kind, id: c.id, task_no: c.task_no, title: c.title, status: c.status,
      owner_name: empName[c.owner_employee_id] || null, due: c.due, space_name: c.space_name, cleared: !isOpenStatus(c.status),
    });
  });
  const ord = (a, b) => (a.cleared - b.cleared) || String(a.task_no).localeCompare(String(b.task_no), undefined, { numeric: true });
  out.waiting_on.sort(ord); out.blocking.sort(ord); out.related.sort(ord);
  return out;
}
// deps=waiting | deps=blocking list filter (after hydrateTasks, which adds the counts).
function depsFilter(rows, deps) {
  if (deps === 'waiting') return rows.filter(t => (t.waiting_open || 0) > 0);
  if (deps === 'blocking') return rows.filter(t => (t.blocking_open || 0) > 0);
  return rows;
}
// After tasks go done/abandoned: an 'unblocked' history row on every task whose LAST open blocker that was.
async function logUnblocked(ids, auth, env) {
  if (!ids.length) return;
  await sbDocket(`/rest/v1/rpc/log_unblocked`, env, { method: 'POST', body: JSON.stringify({ p_closed_ids: ids, p_actor: auth.userId, p_source: auth.source || 'app' }) });
}

// P3a: the involvement fields a sub-task read carries, so an involvement-only viewer's counts can be narrowed.
const KID_COLS = 'id,parent_task_id,status,owner_employee_id,assignee_employee_id,handoff_to_department_id,handoff_to_employee_id';
// Of these sub-task rows (read with KID_COLS or wider), the ids this viewer is involved in (one batched collaborator
// read; a failed read adds no one).
async function involvedIds(auth, kids, env) {
  const seen = new Set(kids.filter(c => involvedDirect(auth, c)).map(c => c.id));
  const rest = kids.filter(c => !seen.has(c.id)).map(c => c.id);
  if (rest.length && auth.employeeId) {
    const cr = await sbIn(sbDocket, rest, l => `/rest/v1/task_collaborators?task_id=in.${l}&employee_id=eq.${enc(auth.employeeId)}&select=task_id`, env);
    if (cr.ok) (cr.data || []).forEach(x => seen.add(x.task_id));
  }
  return seen;
}
// The ids of these task rows the viewer sees through involvement alone: marked by loadTaskFor / keepAccessible, or
// (rows from the 0037 SQL lists) in a private space outside the caller's accessible spaces. Space rows must be known
// (knowSpaces); an accessible ARCHIVED space reads as outside here, which only narrows a count (fail closed).
async function involvementOnlyIds(auth, rows, env) {
  const out = new Set(rows.filter(t => INVOLVED_ONLY.has(t)).map(t => t.id));
  const maybe = rows.filter(t => !out.has(t.id) && spaceOf(auth, t) && !spaceOf(auth, t).is_default);
  if (!maybe.length) return out;
  auth._scopeP = auth._scopeP || programScopeArgs(auth, env);
  const { memberSpaceIds } = await auth._scopeP;
  const open = new Set(memberSpaceIds || []);
  maybe.forEach(t => { if (!open.has(t.space_id)) out.add(t.id); });
  return out;
}
async function hydrateTasks(rows, auth, env) {
  if (!rows.length) return rows;
  const deptIds = uniq(rows.flatMap(t => [t.department_id, t.handoff_to_department_id]));
  const taskIds = uniq(rows.map(t => t.id));
  const userIds = uniq(rows.flatMap(t => [t.created_by_user_id, t.handoff_accepted_by]));
  // Every id list goes through sbIn (≤150 per request) — a big list would overflow the URL.
  // F9 R2: the plan link (one batched projection call) and the rows' spaces (canEditTask) ride along.
  const [deptRes, childRes, collabRes, docRes, commRes, creatorRes, linkRaw, planCtx] = await Promise.all([
    sbIn(sbPodium, deptIds, l => `/rest/v1/departments?id=in.${l}&select=id,name`, env),
    sbIn(sbDocket, taskIds, l => `/rest/v1/tasks?parent_task_id=in.${l}&select=${KID_COLS}`, env),
    sbIn(sbDocket, taskIds, l => `/rest/v1/task_collaborators?task_id=in.${l}&select=task_id,employee_id`, env),
    sbIn(sbDocket, taskIds, l => `/rest/v1/task_documents?task_id=in.${l}&select=task_id`, env),
    sbIn(sbDocket, taskIds, l => `/rest/v1/task_comments?task_id=in.${l}&deleted_at=is.null&select=task_id`, env),
    sbIn(sbStore, userIds, l => `/rest/v1/users_profile?id=in.${l}&select=id,full_name`, env),
    rawLinks(taskIds, env),
    planContext(rows, auth, env),
    knowSpaces(auth, rows, env),
  ]);
  const linkN = linkCounts(linkRaw);
  // Employee names: owners + every collaborator (collaborator ids are only known after collabRes).
  const empIds = uniq([...rows.flatMap(t => [t.owner_employee_id, t.handoff_to_employee_id]), ...(collabRes.data || []).map(c => c.employee_id)]);
  const empRes = await sbIn(sbPodium, empIds, l => `/rest/v1/employees?id=in.${l}&select=id,full_name`, env);
  const progIds = uniq(rows.map(t => t.program_id));
  const progRes = await sbIn(sbDocket, progIds, l => `/rest/v1/programs?id=in.${l}&select=id,name,color`, env);
  const progMap = {}; (progRes.data || []).forEach(p => { progMap[p.id] = p; });
  const deptName = {}; (deptRes.data || []).forEach(d => { deptName[d.id] = d.name; });
  const empName  = {}; (empRes.data  || []).forEach(e => { empName[e.id] = e.full_name; });
  const creatorName = {}; (creatorRes.data || []).forEach(u => { creatorName[u.id] = u.full_name; });
  const childCount = {}, childDone = {};
  // P3a: under a row this viewer opens through involvement alone, only the sub-tasks they are involved in count
  const kids = Array.isArray(childRes.data) ? childRes.data : [];
  const narrow = await involvementOnlyIds(auth, rows, env);
  const kidOk = narrow.size ? await involvedIds(auth, kids.filter(c => narrow.has(c.parent_task_id)), env) : new Set();
  kids.filter(c => !narrow.has(c.parent_task_id) || kidOk.has(c.id)).forEach(c => {
    childCount[c.parent_task_id] = (childCount[c.parent_task_id] || 0) + 1;
    if (c.status === 'done') childDone[c.parent_task_id] = (childDone[c.parent_task_id] || 0) + 1;
  });
  const collabByTask = {};
  (collabRes.data || []).forEach(c => {
    (collabByTask[c.task_id] = collabByTask[c.task_id] || []).push({ id: c.employee_id, full_name: empName[c.employee_id] || null });
  });
  const tally = (res) => { const m = {}; (res.data || []).forEach(r => { m[r.task_id] = (m[r.task_id] || 0) + 1; }); return m; };
  const docs = tally(docRes), comm = tally(commRes);
  return rows.map(t => ({
    ...withPlan(t, planCtx),
    department_name: deptName[t.department_id] || null,
    owner_name: empName[t.owner_employee_id] || null,
    creator_name: creatorName[t.created_by_user_id] || null,
    program: progMap[t.program_id] || null,
    collaborators: collabByTask[t.id] || [],
    child_count: childCount[t.id] || 0, child_done: childDone[t.id] || 0,
    collab_count: (collabByTask[t.id] || []).length, doc_count: docs[t.id] || 0, comment_count: comm[t.id] || 0,
    waiting_open: linkN[t.id]?.waiting_open || 0, waiting_total: linkN[t.id]?.waiting_total || 0,
    blocking_open: linkN[t.id]?.blocking_open || 0, related_count: linkN[t.id]?.related_count || 0,
    ...handoffNames(t, deptName, empName, creatorName),
    _can_edit: canEditTask(auth, t),
  }));
}
// F9 R8: the receiving side's names on every task payload (ids stay; handoff_accepted_by is an auth user id).
function handoffNames(t, deptName, empName, userName) {
  return { handoff_to_department_name: t.handoff_to_department_id ? (deptName[t.handoff_to_department_id] || null) : null,
    handoff_to_employee_name: t.handoff_to_employee_id ? (empName[t.handoff_to_employee_id] || null) : null,
    handoff_accepted_by_name: t.handoff_accepted_by ? (userName[t.handoff_accepted_by] || null) : null };
}
const handoffOpen = (t) => isOpenStatus(t.status) && !t.archived_at;

// F9 R4 — weeks (spec §6). The week settings (docket.settings week_end_dow / working_days / holidays,
// migration 0020), normalised; a failed read falls back to the defaults (Sunday, Mon–Sat, no holidays).
async function weekSettings(env) {
  const r = await sbDocket(`/rest/v1/settings?key=in.${inList(WEEK_KEYS)}&select=key,value`, env);
  return normalizeWeekSettings(r.ok && Array.isArray(r.data) ? r.data : []);
}
// The Week filter (?week=this|next|overdue|none|YYYY-MM-DD → that date's week) on the three task lists.
// `overdue` IS the existing p_overdue (one meaning of overdue, in the RPC); the rest filter the RPC's rows
// here, before hydration — every row, sub-tasks included, exactly as p_overdue does. null → bad value.
async function weekFilterFor(q, env) {
  const w = q.get('week');
  if (!w) return { test: () => true, overdue: false };
  if (w === 'overdue') return { test: () => true, overdue: true };
  const s = await weekSettings(env);
  const now = Date.now();
  const r = resolveWeekFilter(w, s.week_end_dow, now);
  return r ? { test: (t) => matchesWeek(t, r, s.week_end_dow, now), overdue: false } : null;
}

async function getTasks(url, auth, env) {
  const q = url.searchParams;
  const wf = await weekFilterFor(q, env);
  if (!wf) return err('bad_week', 400);
  const spaceId = q.get('space_id') || await defaultSpaceId(env);
  const space = await loadSpace(spaceId, env);
  if (!space) return err('space_not_found', 404);
  if (!(await canAccessSpace(auth, space, env))) return err('forbidden_space', 403);
  const params = {
    p_user: auth.userId, p_employee: auth.employeeId, p_dept: auth.departmentId,
    p_view_all: canViewAll(auth), p_space_id: spaceId,
    p_status: q.get('status') || null,
    p_department_id: q.get('department_id') || null,
    p_employee_filter: q.get('employee_id') || null,
    p_priority: q.get('priority') || null,
    p_overdue: q.get('overdue') === '1' || q.get('overdue') === 'true' || wf.overdue,
    p_revised: q.get('revised') === '1' || q.get('revised') === 'true',
    p_parent_id: q.get('parent_id') || null,
    p_mine: q.get('lens') === 'mine',
    p_q: q.get('q') || null,
    p_program_id: q.get('program_id') || null,
  };
  const r = await sbDocket(`/rest/v1/rpc/list_tasks`, env, { method: 'POST', body: JSON.stringify(params) });
  if (!r.ok) return err('db_error: ' + JSON.stringify(r.data), 500);
  const rows = await hydrateTasks((r.data || []).filter(wf.test), auth, env);
  return ok(depsFilter(rows, q.get('deps')));
}

// Cross-space program view: every visible top-level task tagged to a program, across all
// accessible spaces (membership-respecting). Hydrated like getTasks + a per-row space_name.
async function getProgramTasks(url, auth, env) {
  const q = url.searchParams;
  const programId = q.get('program_id');
  if (!programId) return err('program_id required', 400);
  const wf = await weekFilterFor(q, env);
  if (!wf) return err('bad_week', 400);
  const { memberSpaceIds, defaultId } = await programScopeArgs(auth, env);
  const params = {
    p_user: auth.userId, p_employee: auth.employeeId, p_dept: auth.departmentId,
    p_view_all: canViewAll(auth), p_member_space_ids: memberSpaceIds, p_default_space_id: defaultId,
    p_program_id: programId,
    p_status: q.get('status') || null,
    p_department_id: q.get('department_id') || null,
    p_employee_filter: q.get('employee_id') || null,
    p_priority: q.get('priority') || null,
    p_overdue: q.get('overdue') === '1' || q.get('overdue') === 'true' || wf.overdue,
    p_revised: q.get('revised') === '1' || q.get('revised') === 'true',
    p_mine: q.get('lens') === 'mine',
    p_q: q.get('q') || null,
  };
  const r = await sbDocket(`/rest/v1/rpc/list_tasks_by_program`, env, { method: 'POST', body: JSON.stringify(params) });
  if (!r.ok) return err('db_error: ' + JSON.stringify(r.data), 500);
  let rows = await hydrateTasks((r.data || []).filter(wf.test), auth, env);
  const spaceIds = uniq(rows.map(t => t.space_id));
  if (spaceIds.length) {
    const sr = await sbDocket(`/rest/v1/spaces?id=in.${inList(spaceIds)}&select=id,name`, env);
    const sName = {}; (sr.ok ? sr.data : []).forEach(s => { sName[s.id] = s.name; });
    rows = rows.map(t => ({ ...t, space_name: sName[t.space_id] || null }));
  }
  return ok(depsFilter(rows, q.get('deps')));
}

// Cross-space "My tasks": every non-recurring task the caller OWNS or COLLABORATES on,
// across all accessible spaces. Hydrated like getProgramTasks (+ space_name) and annotated
// with _relation ('owner' | 'collaborator') so the page splits them into two sections.
async function getMyTasks(url, auth, env) {
  const q = url.searchParams;
  const wf = await weekFilterFor(q, env);
  if (!wf) return err('bad_week', 400);
  const { memberSpaceIds, defaultId } = await programScopeArgs(auth, env);
  const params = {
    p_user: auth.userId, p_employee: auth.employeeId,
    p_view_all: canViewAll(auth), p_member_space_ids: memberSpaceIds, p_default_space_id: defaultId,
    p_status: q.get('status') || null,
    p_department_id: q.get('department_id') || null,
    p_priority: q.get('priority') || null,
    p_overdue: q.get('overdue') === '1' || q.get('overdue') === 'true' || wf.overdue,
    p_revised: q.get('revised') === '1' || q.get('revised') === 'true',
    p_program_id: q.get('program_id') || null,
    p_q: q.get('q') || null,
  };
  const r = await sbDocket(`/rest/v1/rpc/list_my_tasks`, env, { method: 'POST', body: JSON.stringify(params) });
  if (!r.ok) return err('db_error: ' + JSON.stringify(r.data), 500);
  let rows = await hydrateTasks((r.data || []).filter(wf.test), auth, env);
  const spaceIds = uniq(rows.map(t => t.space_id));
  if (spaceIds.length) {
    const sr = await sbDocket(`/rest/v1/spaces?id=in.${inList(spaceIds)}&select=id,name`, env);
    const sName = {}; (sr.ok ? sr.data : []).forEach(s => { sName[s.id] = s.name; });
    rows = rows.map(t => ({ ...t, space_name: sName[t.space_id] || null }));
  }
  // Three-way relation, checked most-specific first. 'creator' is the S153 addition: a task
  // you raised and handed to someone else, which list_my_tasks used to omit entirely (246
  // such tasks live, 138 open, 25 creators). Ownership wins over collaboration, and both win
  // over authorship, so a task never shows up in two sections.
  rows = rows.map(t => {
    let _relation = 'creator';
    if (auth.employeeId && t.owner_employee_id === auth.employeeId) _relation = 'owner';
    else if (auth.employeeId && (t.collaborators || []).some(c => c.id === auth.employeeId)) _relation = 'collaborator';
    return { ...t, _relation };
  });
  return ok(depsFilter(rows, q.get('deps')));
}

// F4 "Clean up" — the stale-work sweep. Pull-only (decisions §S309: nothing is sent).
// Stale = open (not done/abandoned), non-recurring, unarchived, top-level OR sub-task, and
// (a) effective deadline coalesce(revised_deadline, deadline) older than now − 30d, or
// (b) updated_at older than now − 60d. Each row carries stale_reasons ⊆ ['overdue30','untouched60'].
//
// Visibility — every row returned passes getTask's own gate, so this can't show anything
// the task itself wouldn't open for:
//   · space: ALWAYS the caller's accessible spaces (General + owned/member private, non-
//     archived) — view_all included, exactly RULE-DOCKET-003 (a private space needs
//     membership, admins too). Narrower than list_my_tasks, whose p_view_all skips it.
//   · default scope: owner_employee_id = the caller (own tasks → canSeeTask in General). P3a: an owner is involved,
//     so their own stale tasks in ANY live space count — read by owner with no space filter, then gated through
//     keepAccessible (never a Founders' space they're not in, never an archived space).
//   · scope=all: docket_view_all / admin only (else 403) — every owner, optional owner=<id>.
// ?count_only=1 → { total } (select=id + count=exact, no hydration) for My tasks' "Clean up N".
// "Last touched" = updated_at, or created_at for a task never edited since creation
// (updated_at is NULL there — those are the longest-sitting ones, so they must count).
const STALE_OVERDUE_DAYS = 30, STALE_UNTOUCHED_DAYS = 60, STALE_CAP = 300, STALE_PAGE = 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function getStaleTasks(url, auth, env) {
  const q = url.searchParams;
  const scopeAll = q.get('scope') === 'all';
  if (scopeAll && !canViewAll(auth)) return err('forbidden', 403);
  const owner = scopeAll ? (q.get('owner') || null) : auth.employeeId;
  if (owner && !UUID_RE.test(owner)) return err('invalid owner', 400);
  const countOnly = q.get('count_only') === '1';
  const empty = countOnly ? { total: 0 } : { tasks: [], total: 0, truncated: false };
  if (!scopeAll && !auth.employeeId) return ok(empty);     // no employee row → owns nothing
  const spaces = await accessibleSpaces(auth, env);
  if (!spaces.length) return ok(empty);

  const now = Date.now();
  const cutOverdue = new Date(now - STALE_OVERDUE_DAYS * 864e5).toISOString();
  const cutUntouched = new Date(now - STALE_UNTOUCHED_DAYS * 864e5).toISOString();
  const ownScope = !scopeAll;   // P3a: by owner, any space, gated after the read
  const filters = [
    'status=not.in.(done,abandoned)', 'is_recurring=eq.false', 'archived_at=is.null',
    ...(ownScope ? [] : [`space_id=in.${inList(spaces.map(s => s.id))}`]),
    `or=(revised_deadline.lt.${cutOverdue},and(revised_deadline.is.null,deadline.lt.${cutOverdue}),` +
      `updated_at.lt.${cutUntouched},and(updated_at.is.null,created_at.lt.${cutUntouched}))`,
  ];
  if (owner) filters.push(`owner_employee_id=eq.${enc(owner)}`);
  const base = `/rest/v1/tasks?${filters.join('&')}`;

  if (countOnly && !ownScope) {
    const c = await sbDocket(`${base}&select=id&limit=1`, env, { prefer: 'count=exact' });
    if (!c.ok) return err('db_error: ' + JSON.stringify(c.data), 500);
    const total = Number(String(c.contentRange || '').split('/')[1]);
    return ok({ total: Number.isFinite(total) ? total : (c.data || []).length });
  }
  // Read every match, a page at a time (PostgREST's max-rows would silently clip one big
  // read), then sort here — PostgREST can't order by coalesce(revised_deadline, deadline).
  let all = [];
  // Advance by what actually came back (PostgREST's max-rows may be below STALE_PAGE) and
  // stop only on an empty page; order=id keeps offset paging stable. 50 pages = runaway guard.
  let exactTotal = null;
  const cols = countOnly ? 'id,space_id,owner_employee_id,assignee_employee_id,handoff_to_department_id,handoff_to_employee_id' : '*';
  for (let off = 0, n = 0; n < 50; n++) {
    const r = await sbDocket(`${base}&select=${cols}&order=id.asc&limit=${STALE_PAGE}&offset=${off}`, env,
      off === 0 ? { prefer: 'count=exact' } : undefined);
    if (!r.ok) return err('db_error: ' + JSON.stringify(r.data), 500);
    if (off === 0) { const t = Number(String(r.contentRange || '').split('/')[1]); if (Number.isFinite(t)) exactTotal = t; }
    const page = Array.isArray(r.data) ? r.data : [];
    if (!page.length) break;
    all.push(...page);
    off += page.length;
    if (exactTotal != null && all.length >= exactTotal) break;
  }
  if (ownScope) {   // P3a: the space gate after the read — involvement (they own these) or access; live spaces only
    all = (await keepAccessible(auth, all, env)).filter(t => !spaceOf(auth, t)?.archived_at);
    exactTotal = null;   // the header counted the ungated rows
    if (countOnly) return ok({ total: all.length });
  }

  // Times as numbers: PostgREST's '+00:00' / microsecond strings don't string-compare with toISOString's 'Z'.
  const ms = (v) => (v ? Date.parse(v) : NaN);
  const eff = (t) => ms(t.revised_deadline || t.deadline);
  const touched = (t) => ms(t.updated_at || t.created_at);
  all.sort((a, b) => {
    const ea = eff(a), eb = eff(b);
    if (!isNaN(ea) && !isNaN(eb) && ea !== eb) return ea - eb;
    if (isNaN(ea) !== isNaN(eb)) return isNaN(ea) ? 1 : -1;   // no deadline last
    return (touched(a) || 0) - (touched(b) || 0);              // then longest untouched first
  });
  const truncated = all.length > STALE_CAP;
  let rows = await hydrateTasks(all.slice(0, STALE_CAP), auth, env);
  const sName = {}; spaces.forEach(s => { sName[s.id] = s.name; });
  (auth._spaceRows || new Map()).forEach((sp, id) => { if (!sName[id]) sName[id] = sp.name; });   // P3a: involvement-only spaces
  const parentIds = uniq(rows.map(t => t.parent_task_id));
  // Parent crumb only where the caller could open the parent itself (canSeeTask's gate,
  // batched: the collaborator check is one in.() read, not one per parent). Otherwise null.
  // P3a: first the space gate (keepAccessible); a parent open through involvement alone shows (it is theirs), one
  // in a space they can't access and aren't involved in never does — not even on a team match.
  const pr = await sbIn(sbDocket, parentIds, l => `/rest/v1/tasks?id=in.${l}&select=*`, env);
  const parents = await keepAccessible(auth, (pr.ok && Array.isArray(pr.data)) ? pr.data : [], env);
  await knowSpaces(auth, parents, env);   // canEditTask reads the parent's space (no-op: same spaces as the rows)
  const quick = (p) => INVOLVED_ONLY.has(p) || canViewAll(auth) || canEditTask(auth, p) || (auth.departmentId && p.department_id === auth.departmentId) || receiverSees(auth, p);
  const needCollab = parents.filter(p => !quick(p)).map(p => p.id);
  const collabOk = new Set();
  if (needCollab.length && auth.employeeId) {
    const c = await sbIn(sbDocket, needCollab, l => `/rest/v1/task_collaborators?task_id=in.${l}&employee_id=eq.${enc(auth.employeeId)}&select=task_id`, env);
    ((c.ok && c.data) || []).forEach(x => collabOk.add(x.task_id));
  }
  const parent = {};
  parents.forEach(p => { if (quick(p) || collabOk.has(p.id)) parent[p.id] = { id: p.id, task_no: p.task_no, title: p.title }; });
  const odCut = Date.parse(cutOverdue), unCut = Date.parse(cutUntouched);
  rows = rows.map(t => {
    const stale_reasons = [];
    if (eff(t) < odCut) stale_reasons.push('overdue30');        // NaN (no deadline) → false
    if (touched(t) < unCut) stale_reasons.push('untouched60');
    return { ...t, space_name: sName[t.space_id] || null, parent: parent[t.parent_task_id] || null, stale_reasons };
  });
  return ok({ tasks: rows, total: exactTotal ?? all.length, truncated: truncated || (exactTotal != null && exactTotal > all.length) });
}

// F5 — cross-space search for ⌘K. One RPC (migration 0012 search_tasks) over every space the
// caller can open: General through canSeeTask, private spaces through ownership/membership
// (accessibleSpaces — RULE-DOCKET-003, view_all doesn't widen it) or, since 0037 (P3a), involvement in the task. Title + DKT number; terms in
// any order; a typo fallback only when nothing matched exactly. ≤20 rows, + owner_name.
// Queries under 2 characters return [] unless they are a DKT number ("7", "dkt-7").
const SEARCH_MAX_Q = 100;
async function searchTasks(url, auth, env) {
  const q = String(url.searchParams.get('q') || '').trim().slice(0, SEARCH_MAX_Q);
  const m = /^(?:dkt[-\s]?)?#?(\d{1,7})$/i.exec(q);
  const num = m ? m[1].replace(/^0+(?=\d)/, '') : null;
  if (!num && q.length < 2) return ok([]);
  const spaces = await accessibleSpaces(auth, env);
  if (!spaces.length) return ok([]);
  const general = spaces.find(s => !s.is_private);
  const r = await sbDocket(`/rest/v1/rpc/search_tasks`, env, { method: 'POST', body: JSON.stringify({
    p_user: auth.userId, p_employee: auth.employeeId, p_dept: auth.departmentId,
    p_view_all: canViewAll(auth),
    p_member_space_ids: spaces.filter(s => s.is_private).map(s => s.id),
    // No General row (archived) → no General results; never fall back to a space id the caller wasn't given.
    p_default_space_id: general ? general.id : null,
    p_q: q, p_num: num, p_limit: 20,
  }) });
  if (!r.ok) return err('db_error: ' + JSON.stringify(r.data), 500);
  const rows = r.data || [];
  const empIds = uniq(rows.map(t => t.owner_employee_id));
  const [empRes, planned] = await Promise.all([
    sbIn(sbPodium, empIds, l => `/rest/v1/employees?id=in.${l}&select=id,full_name`, env),
    hydratePlan(rows, auth, env),   // F9 R2: the plan chip, through the projection
  ]);
  const name = {}; (empRes.data || []).forEach(e => { name[e.id] = e.full_name; });
  return ok(planned.map(t => ({ ...t, owner_name: name[t.owner_employee_id] || null })));
}

// `involvedOnly` (P3a): the viewer opened the task through involvement alone, so the parent shows only when they
// are involved in it too (the space isn't theirs, and it is never the Founders' space here).
async function parentCrumb(p, space, auth, env, involvedOnly = false) {
  if (!p) return null;
  if (involvedOnly ? !(await isInvolved(auth, p, env)) : (space.is_default && !(await canSeeTask(auth, p, env)))) return null;
  return { id: p.id, task_no: p.task_no, title: p.title, status: p.status };
}
async function getTask(url, auth, env) {
  const id = url.searchParams.get('id');
  if (!id) return err('id required', 400);
  const task = await loadTaskFor(id, auth, env);
  if (!task) return err('not_found', 404);
  // Space gate: General falls back to the V1 baseline (own/collab/dept/view-all);
  // a private space requires membership (admins included — RULE-DOCKET-003) or, P3a, involvement in this task
  // (loadTaskFor proved it and marked the row INVOLVED_ONLY).
  const space = await loadSpace(task.space_id, env);
  if (!space) return err('space_not_found', 404);
  const involvedOnly = INVOLVED_ONLY.has(task);
  if (space.is_default) { if (!(await canSeeTask(auth, task, env))) return err('forbidden', 403); }
  else if (!involvedOnly) { if (!(await canAccessSpace(auth, space, env))) return err('forbidden_space', 403); }

  // The parent crumb {task_no, title} only when the caller could open the parent itself: same space
  // always (setParent / moveTask keep it so); private = flat, General = canSeeTask on the parent — the
  // stale sweep's crumb gate. A sub-task can be visible (own / dept / collaborator) under a parent that isn't.
  // Involvement-only (P3a): the parent and the sub-tasks show only where the viewer is involved in them too —
  // the rest of that space is not theirs (the child read then carries the involvement fields).
  const childCols = 'id,task_no,title,status,priority,owner_employee_id,deadline,revised_deadline'
    + (involvedOnly ? ',assignee_employee_id,handoff_to_department_id,handoff_to_employee_id' : '');   // involvedIds reads these
  const [parentRes, childRes, collabRes, docRes, commRes, histRes] = await Promise.all([
    task.parent_task_id
      ? sbDocket(`/rest/v1/tasks?id=eq.${enc(task.parent_task_id)}&space_id=eq.${enc(task.space_id)}&select=*&limit=1`, env)
      : { data: [] },
    sbDocket(`/rest/v1/tasks?parent_task_id=eq.${enc(id)}&space_id=eq.${enc(task.space_id)}&select=${childCols}&order=created_at.asc`, env),
    sbDocket(`/rest/v1/task_collaborators?task_id=eq.${enc(id)}&select=employee_id,added_at`, env),
    sbDocket(`/rest/v1/task_documents?task_id=eq.${enc(id)}&select=*&order=added_at.asc`, env),
    sbDocket(`/rest/v1/task_comments?task_id=eq.${enc(id)}&deleted_at=is.null&select=*&order=created_at.asc`, env),
    sbDocket(`/rest/v1/task_history?task_id=eq.${enc(id)}&select=*&order=created_at.asc`, env),
  ]);

  // Resolve all employee names referenced (owner/assignee/collaborators/children-assignees) in one read.
  // R8: hand-off history rows carry ids (new/old_value = department, note = receiver) — named here.
  if (involvedOnly) {   // P3a: only the sub-tasks this viewer is involved in (a failed collaborator read adds none)
    const kids = Array.isArray(childRes.data) ? childRes.data : [];
    const seen = await involvedIds(auth, kids, env);
    childRes.data = kids.filter(c => seen.has(c.id));
  }
  const hoHist = (histRes.data || []).filter(h => h.field === 'handoff');
  const empIds = uniq([
    task.owner_employee_id, task.handoff_to_employee_id,
    ...(collabRes.data || []).map(c => c.employee_id),
    ...(childRes.data || []).map(c => c.owner_employee_id),
    ...hoHist.map(h => h.note).filter(v => isUuid(v || '')),
  ]);
  const deptRes = await sbIn(sbPodium, uniq([task.department_id, task.handoff_to_department_id,
    ...hoHist.flatMap(h => [h.old_value, h.new_value]).filter(v => isUuid(v || ''))]), l => `/rest/v1/departments?id=in.${l}&select=id,name`, env);
  const deptName = {}; (deptRes.data || []).forEach(x => { deptName[x.id] = x.name; });
  const empRes = empIds.length
    ? await sbPodium(`/rest/v1/employees?id=in.${inList(empIds)}&select=id,full_name`, env) : { data: [] };
  const empName = {}; (empRes.data || []).forEach(e => { empName[e.id] = e.full_name; });

  // Resolve LOT user names for the creator + comment authors + history actors (store.users_profile).
  const userIds = uniq([
    task.created_by_user_id, task.handoff_accepted_by,
    ...(commRes.data || []).map(c => c.author_user_id),
    ...(histRes.data || []).map(h => h.actor_user_id),
  ]);
  const upRes = userIds.length
    ? await sbStore(`/rest/v1/users_profile?id=in.${inList(userIds)}&select=id,full_name`, env) : { data: [] };
  const userName = {}; (upRes.data || []).forEach(u => { userName[u.id] = u.full_name; });

  const children = (childRes.data || []).map(c => ({ ...c, owner_name: empName[c.owner_employee_id] || null }));
  // F7: dependency links, and history rows whose value is a linked task's id rendered behind the gate.
  const depHist = (histRes.data || []).filter(h => h.field === 'dependency');
  const depIds = uniq(depHist.flatMap(h => [h.new_value, h.old_value]).filter(v => /^[0-9a-f-]{36}$/i.test(v || '')));
  // F9 R2: the task's plan link and every plan id in its history, through ONE projection call. History
  // stores the item id only (never a title); it is rendered here at the viewer's level.
  const planHistIds = uniq((histRes.data || []).filter(h => h.field === 'plan_item_id')
    .flatMap(h => [h.old_value, h.new_value]).filter(v => isUuid(v || '')));
  // F8 P2: linked records (one you can't open is a count only) and the records named in checklist_linked /
  // _unlinked history rows (id only → the title when visible, else "a checklist you can't see").
  const clHistIds = uniq((histRes.data || []).filter(h => h.field === 'checklist').flatMap(h => [h.old_value, h.new_value]).filter(v => isUuid(v || '')));
  const [links, depCards, planCtx, cls, clLabels] = await Promise.all([
    buildLinks(task.id, auth, env), taskCards(depIds, auth, env), planContext([task], auth, env, planHistIds),
    taskChecklists(task.id, auth, env), checklistLabels(clHistIds, auth, env),
  ]);
  // A failed checklist read never fails the task: the strip shows nothing and says it couldn't load.
  const clsOk = !cls.error;
  const clLabel = v => (isUuid(v || '') ? (clLabels[v] || 'a checklist you can’t see') : v);
  const depLabel = v => (v && /^[0-9a-f-]{36}$/i.test(v)) ? cardLabel(depCards[v]) : v;
  const planLabel = v => (isUuid(v || '') ? planLinkLabel(taskPlan(planCtx.links[v])) : null);
  const planned = withPlan(task, planCtx);
  // A sub-task shows its parent's link, so a top-level task's children all carry this one, inherited.
  const childPlan = planned.plan && !planned.plan.inherited ? { ...planned.plan, inherited: true } : null;
  const prog = task.program_id
    ? (await sbDocket(`/rest/v1/programs?id=eq.${enc(task.program_id)}&select=id,name,color&limit=1`, env)).data?.[0]
    : null;
  return ok({
    ...planned,
    department_name: deptName[task.department_id] || null,
    owner_name: empName[task.owner_employee_id] || null,
    creator_name: userName[task.created_by_user_id] || null,
    ...handoffNames(task, deptName, empName, userName),
    can_accept_handoff: isHandoffReceiver(auth, task) && handoffOpen(task) && !task.handoff_accepted_at && !space.archived_at,
    space: { id: space.id, name: space.name, is_private: space.is_private, is_founders: !!space.is_founders },
    program: prog || null,
    parent: await parentCrumb(parentRes.data?.[0], space, auth, env, involvedOnly),
    children: children.map(c => ({ ...c, plan: childPlan })),
    child_count: children.length,
    child_done: children.filter(c => c.status === 'done').length,
    collaborators: (collabRes.data || []).map(c => ({ ...c, full_name: empName[c.employee_id] || null })),
    documents: docRes.data || [],
    comments: (commRes.data || []).map(c => ({ ...c, author_name: userName[c.author_user_id] || null })),
    // A plan-link row whose both sides project to nothing for this viewer never existed for them (§5.3 none).
    history: (histRes.data || []).filter(h => h.field !== 'plan_item_id' || planLabel(h.old_value) || planLabel(h.new_value)).map(h => ({
      ...h, actor_name: userName[h.actor_user_id] || null,
      ...(h.field === 'dependency' ? { old_value: depLabel(h.old_value), new_value: depLabel(h.new_value) } : {}),
      ...(h.field === 'plan_item_id' ? { old_value: planLabel(h.old_value), new_value: planLabel(h.new_value) } : {}),
      ...(h.field === 'checklist' ? { old_value: clLabel(h.old_value), new_value: clLabel(h.new_value) } : {}),
      ...(h.field === 'handoff' ? { old_value: deptName[h.old_value] || (h.old_value ? 'a team' : null), new_value: deptName[h.new_value] || (h.new_value ? 'a team' : null),
        note: isUuid(h.note || '') ? (empName[h.note] || 'someone') : h.note } : {}),
      // done-vs-abandoned of a blocker you can't open is not yours to know (hostile review #5).
      ...(h.event_type === 'unblocked' && !depCards[h.new_value]?.visible ? { note: null } : {}),
    })),
    links,
    checklists: clsOk ? cls.list : [],
    checklists_hidden: clsOk ? cls.hidden : 0,
    ...(clsOk ? {} : { checklists_failed: true }),
    _can_edit: canEditTask(auth, task),
  });
}

// F7: just the links (row/card popover). Same gate as getTask.
async function getTaskLinks(url, auth, env) {
  const id = url.searchParams.get('id');
  if (!id) return err('id required', 400);
  const task = await loadTaskFor(id, auth, env);
  if (!task) return err('not_found', 404);
  const space = await loadSpace(task.space_id, env);
  if (!space) return err('space_not_found', 404);
  if (space.is_default) { if (!(await canSeeTask(auth, task, env))) return err('forbidden', 403); }
  else if (!INVOLVED_ONLY.has(task)) { if (!(await canAccessSpace(auth, space, env))) return err('forbidden_space', 403); }
  return ok(await buildLinks(task.id, auth, env));   // the links object only (spec §7)
}

// F7: add a dependency / related link. kind is from `id`'s point of view: waiting_on | blocks | relates.
// The caller must be able to EDIT `id` and OPEN both tasks (an admin's edit right alone doesn't reach a
// private space it isn't in). Everything about the tasks themselves is re-checked in add_task_link.
async function addTaskLink(body, auth, env) {
  const d = body.data || body;
  if (!d.id || !d.other_id || !d.kind) return err('id, other_id and kind required', 400);
  if (!['waiting_on', 'blocks', 'relates'].includes(d.kind)) return err('bad_kind', 400);
  if (!UUID_RE.test(String(d.id)) || !UUID_RE.test(String(d.other_id))) return err('invalid id', 400);
  if (d.id === d.other_id) return err('self_link', 422);
  const task = await loadTaskFor(d.id, auth, env);
  if (!task) return err('not_found', 404);
  const cards = await taskCards([d.id, d.other_id], auth, env);
  if (!canEditTask(auth, task) || !cards[d.id]?.visible) return err('forbidden', 403);
  if (task.status === 'abandoned') return err('abandoned_read_only', 422);
  if (!cards[d.other_id]) return err('not_found', 404);
  if (!cards[d.other_id].visible) return err('forbidden_other', 403);
  const r = await sbDocket(`/rest/v1/rpc/add_task_link`, env, { method: 'POST', body: JSON.stringify({
    p_task: d.id, p_other: d.other_id, p_kind: d.kind, p_user: auth.userId, p_source: auth.source || 'app' }) });
  if (!r.ok) return err('db_error: ' + JSON.stringify(r.data), 500);
  const res = r.data || {};
  if (!res.ok) return err(res.code || 'link_failed', res.code === 'not_found' ? 404 : 422);
  return ok({ link_id: res.link_id });
}

// F7: remove a link. Needs edit rights on an end that is not abandoned and that the caller can open.
async function removeTaskLink(body, auth, env) {
  const d = body.data || body;
  if (!d.link_id) return err('link_id required', 400);
  const lr = await sbDocket(`/rest/v1/task_links?id=eq.${enc(d.link_id)}&select=from_task_id,to_task_id&limit=1`, env);
  const link = lr.ok && lr.data?.[0];
  if (!link) return err('not_found', 404);
  const tr = await sbDocket(`/rest/v1/tasks?id=in.${inList([link.from_task_id, link.to_task_id])}&select=*`, env);
  const ends = tr.ok ? (tr.data || []) : [];
  await knowSpaces(auth, ends, env);   // canEditTask reads each end's space
  const cards = await taskCards(ends.map(t => t.id), auth, env);
  if (!ends.some(t => t.status !== 'abandoned' && canEditTask(auth, t) && cards[t.id]?.visible)) return err('forbidden', 403);
  const r = await sbDocket(`/rest/v1/rpc/remove_task_link`, env, { method: 'POST', body: JSON.stringify({ p_link_id: d.link_id, p_user: auth.userId, p_source: auth.source || 'app' }) });
  if (!r.ok) return err('db_error: ' + JSON.stringify(r.data), 500);
  if (!r.data?.ok) return err(r.data?.code || 'not_found', 404);
  return ok({ removed: true });
}

async function getDashboard(url, auth, env) {
  const spaceId = url.searchParams.get('space_id') || await defaultSpaceId(env);
  const space = await loadSpace(spaceId, env);
  if (!space) return err('space_not_found', 404);
  // General dashboard is org-wide → shareable (view_all, or the dashboard_public flag, or a
  // per-person grant — RULE-DOCKET-006); a private space's dashboard is open to its members.
  if (space.is_default) { if (!(await canViewDashboard(auth, env))) return err('forbidden_dashboard', 403); }
  else { if (!(await canAccessSpace(auth, space, env))) return err('forbidden_space', 403); }
  const r = await sbDocket(`/rest/v1/rpc/dashboard_stats`, env, { method: 'POST', body: JSON.stringify({ p_space_id: spaceId }) });
  if (!r.ok) return err('db_error: ' + JSON.stringify(r.data), 500);
  const stats = r.data || {};
  // Attach each person's "last seen" (presence) to the by_person rows: emp → auth user → last_seen_at.
  const people = Array.isArray(stats.by_person) ? stats.by_person : [];
  if (people.length) {
    const empIds = uniq(people.map(p => p.emp_id));
    const [empRes, actRes] = await Promise.all([
      empIds.length ? sbPodium(`/rest/v1/employees?id=in.${inList(empIds)}&select=id,auth_user_id`, env) : { data: [] },
      sbDocket(`/rest/v1/user_activity?select=user_id,last_seen_at`, env),
    ]);
    const empAuth = {}; (empRes.data || []).forEach(e => { empAuth[e.id] = e.auth_user_id; });
    const seen = {}; (actRes.data || []).forEach(a => { seen[a.user_id] = a.last_seen_at; });
    stats.by_person = people.map(p => ({ ...p, last_seen: empAuth[p.emp_id] ? (seen[empAuth[p.emp_id]] || null) : null }));
  }
  return ok(stats);
}

// Per-person checklist for a date: flat personal recurring items + assigned template runs.
// ?employee_id= optional (default = caller). ?date= optional (default IST today). RULE-DOCKET-008/009.
async function getChecklist(url, auth, env) {
  const targetId = url.searchParams.get('employee_id') || auth.employeeId;
  if (!targetId) return err('no_employee', 400);
  const date = url.searchParams.get('date') || istDateStr();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return err('invalid date', 400);
  const empRes = await sbPodium(
    `/rest/v1/employees?id=eq.${enc(targetId)}&select=id,full_name,department_id&limit=1`, env);
  const target = empRes.ok && empRes.data?.[0];
  if (!target) return err('employee_not_found', 404);
  // View gate: the existing rule, OR (R1) the caller monitors this person.
  let allowed = canViewChecklistOf(auth, target);
  if (!allowed) allowed = (await peopleInScope(auth, env)).has(targetId);
  if (!allowed) return err('forbidden', 403);
  const isOwn = auth.employeeId && targetId === auth.employeeId;

  // ── Flat personal recurring tasks (RULE-DOCKET-008), now with completion timestamps. ──
  const tRes = await sbDocket(
    `/rest/v1/tasks?is_recurring=eq.true&owner_employee_id=eq.${enc(targetId)}&status=neq.abandoned&select=*&order=created_at.asc`, env);
  if (!tRes.ok) return err('db_error', 500);
  const live = (await visibleRecurring(tRes.data || [], auth, env)).filter(t => !isExpired(t.recurrence, date));
  const recRows = await hydrateTasks(live, auth, env);
  const recIds = recRows.map(t => t.id);
  const complMap = {};
  if (recIds.length) {
    const cRes = await sbDocket(
      `/rest/v1/checklist_completions?task_id=in.${inList(recIds)}&occurrence_date=eq.${date}&select=task_id,completed_at,completed_by_user_id`, env);
    (cRes.ok ? cRes.data : []).forEach(c => { complMap[c.task_id] = c; });
  }
  let allCompleterIds = uniq(Object.values(complMap).map(c => c.completed_by_user_id));
  const recurring_items = recRows.map(t => {
    const c = complMap[t.id];
    return {
      ...t,
      due_today: isDueOn(t.recurrence, date),
      completed_today: !!c,
      completed_at: c?.completed_at || null,
      completed_by_user_id: c?.completed_by_user_id || null,
      late: c ? lateFlag(c.completed_at, t.recurrence?.time) : false,
      _can_complete: isOwn,   // you complete your own checklist only
    };
  });

  // ── Assigned template runs due on `date`. ──
  const asgRes = await sbDocket(
    `/rest/v1/checklist_assignments?employee_id=eq.${enc(targetId)}&unassigned_at=is.null&select=template_id`, env);
  const tmplIds = uniq((asgRes.data || []).map(a => a.template_id));
  let template_runs = [];
  if (tmplIds.length) {
    const tmplRes = await sbDocket(
      `/rest/v1/checklist_templates?id=in.${inList(tmplIds)}&archived_at=is.null&is_active=eq.true&select=*`, env);
    const dueTmpls = (tmplRes.data || []).filter(t => isDueOn(t.recurrence, date) && !isExpired(t.recurrence, date));
    if (dueTmpls.length) {
      const dueIds = dueTmpls.map(t => t.id);
      const [secRes, deptRes] = await Promise.all([
        sbDocket(`/rest/v1/checklist_template_sections?template_id=in.${inList(dueIds)}&select=*&order=sort_order.asc`, env),
        sbPodium(`/rest/v1/departments?select=id,name`, env),
      ]);
      const sections = secRes.data || [];
      const secIds = sections.map(s => s.id);
      const [itemRes, secCommRes] = await Promise.all([
        secIds.length ? sbDocket(`/rest/v1/checklist_template_items?section_id=in.${inList(secIds)}&select=*&order=sort_order.asc`, env) : Promise.resolve({ data: [] }),
        secIds.length ? sbDocket(`/rest/v1/checklist_section_comments?section_id=in.${inList(secIds)}&employee_id=eq.${enc(targetId)}&occurrence_date=eq.${date}&select=section_id,body`, env) : Promise.resolve({ data: [] }),
      ]);
      const items = itemRes.data || [];
      const itemIds = items.map(i => i.id);
      // F8 C1: a shared template's tick counts whoever made it; a per-person one only the target's own.
      const sharedTmpl = new Set(dueTmpls.filter(t => t.run_scope === 'shared').map(t => t.id));
      const tmplOfSec = {}; sections.forEach(s => { tmplOfSec[s.id] = s.template_id; });
      const sharedItem = new Set(items.filter(i => sharedTmpl.has(tmplOfSec[i.section_id])).map(i => i.id));
      const itemComplRes = itemIds.length
        ? await sbDocket(`/rest/v1/checklist_item_completions?template_item_id=in.${inList(itemIds)}&occurrence_date=eq.${date}&select=template_item_id,employee_id,completed_at,completed_by_user_id,done_by_note&order=completed_at.asc`, env)
        : { data: [] };
      const itemCompl = {}; (itemComplRes.data || []).forEach(c => {
        if (itemCompl[c.template_item_id]) return;   // first tick wins
        if (sharedItem.has(c.template_item_id) || c.employee_id === targetId) itemCompl[c.template_item_id] = c;
      });
      allCompleterIds = uniq([...allCompleterIds, ...Object.values(itemCompl).map(c => c.completed_by_user_id)]);
      const commBySec = {}; (secCommRes.data || []).forEach(c => { commBySec[c.section_id] = c.body || ''; });
      const itemsBySec = {}; items.forEach(i => { (itemsBySec[i.section_id] ||= []).push(i); });
      const deptName = {}; (deptRes.data || []).forEach(d => { deptName[d.id] = d.name; });
      const secByT = {}; sections.forEach(s => { (secByT[s.template_id] ||= []).push(s); });
      template_runs = dueTmpls.map(t => ({
        template: { id: t.id, name: t.name, role_label: t.role_label, run_scope: t.run_scope || 'per_person', department_name: deptName[t.department_id] || null },
        _can_complete: isOwn,
        sections: (secByT[t.id] || []).map(s => ({
          id: s.id, title: s.title, subtitle: s.subtitle, due_time: s.due_time,
          comment: commBySec[s.id] || '',
          items: (itemsBySec[s.id] || []).map(it => {
            const c = itemCompl[it.id];
            return {
              id: it.id, title: it.title, help_text: it.help_text, tags: it.tags || [],
              completed: !!c, completed_at: c?.completed_at || null,
              completed_by_user_id: c?.completed_by_user_id || null,
              done_by_note: c?.done_by_note || null,
              late: c ? lateFlag(c.completed_at, s.due_time) : false,
            };
          }),
        })),
      }));
    }
  }

  // Completer names (both models).
  let completerName = {};
  if (allCompleterIds.length) {
    const up = await sbStore(`/rest/v1/users_profile?id=in.${inList(allCompleterIds)}&select=id,full_name`, env);
    (up.ok ? up.data : []).forEach(u => { completerName[u.id] = u.full_name; });
  }
  recurring_items.forEach(r => { r.completed_by = r.completed_by_user_id ? (completerName[r.completed_by_user_id] || null) : null; });
  template_runs.forEach(run => run.sections.forEach(s => s.items.forEach(it => {
    it.completed_by = it.completed_by_user_id ? (completerName[it.completed_by_user_id] || null) : null;
  })));

  return ok({
    owner: { id: target.id, full_name: target.full_name, department_id: target.department_id },
    date, recurring_items, template_runs,
  });
}

// ── F8 P1 — the checklist REGISTER: rows × occurrence dates, with adherence ──────────────────────
// Three shapes (spec 2026-11-11-docket-checklists-v2.md §3.1):
//   ?employee_id=                → that person's flat recurring tasks (rows = tasks)
//   ?template_id=&employee_id=   → a per_person template's chart for that assignee
//   ?template_id=                → a shared template's one chart
// Window from..to (IST dates; `to` clamped to today; ≤ 92 days; default the 14 days ending today).
// Columns = dates in the window where at least one row is due. A row is due on a date when its
// recurrence says so, the date is on/after the row's start (task created / assigned), and not past
// `until`. Adherence counts a due date only once it is over — today counts only if already ticked.
async function checklistPersonGate(auth, targetId, env) {
  const empRes = await sbPodium(`/rest/v1/employees?id=eq.${enc(targetId)}&select=id,full_name,department_id&limit=1`, env);
  const target = empRes.ok && empRes.data?.[0];
  if (!target) return { error: err('employee_not_found', 404) };
  if (canViewChecklistOf(auth, target) || (await peopleInScope(auth, env)).has(targetId)) return { target };
  return { error: err('forbidden', 403) };
}
async function getChecklistRegister(url, auth, env) {
  const today = istDateStr();
  let to = url.searchParams.get('to') || today;
  if (!isValidDate(to)) return err('invalid date', 400);
  if (to > today) to = today;
  const from = url.searchParams.get('from') || addDays(to, -13);
  if (!isValidDate(from)) return err('invalid date', 400);
  if (from > to) return err('invalid_range', 400);
  const days = datesBetween(from, to);
  if (days.length > 92) return err('range_too_long (max 92 days)', 400);
  const templateId = url.searchParams.get('template_id');
  const employeeId = url.searchParams.get('employee_id');

  let rows = [], ticks = [], canTick = false, canClearAny = false, owner = null, template = null, templates = [];
  if (!templateId) {
    // Flat recurring tasks of one person (RULE-DOCKET-008).
    if (!employeeId) return err('employee_id or template_id required', 400);
    const g = await checklistPersonGate(auth, employeeId, env); if (g.error) return g.error;
    owner = { id: g.target.id, full_name: g.target.full_name };
    const tRes = await sbDocket(
      `/rest/v1/tasks?is_recurring=eq.true&owner_employee_id=eq.${enc(employeeId)}&status=neq.abandoned&archived_at=is.null&select=id,task_no,title,recurrence,created_at,space_id,owner_employee_id&order=created_at.asc`, env);
    if (!tRes.ok) return err('db_error', 500);
    rows = (await visibleRecurring(tRes.data || [], auth, env)).map(t => ({
      id: t.id, kind: 'task', task_no: t.task_no, title: t.title, section: null,
      due_time: t.recurrence?.time || null, rec: t.recurrence, start: istDateStr(new Date(t.created_at)), spans: null,
    }));
    if (rows.length) {
      const c = await sbAll(sbDocket, `/rest/v1/checklist_completions?task_id=in.${inList(rows.map(r => r.id))}&occurrence_date=gte.${from}&occurrence_date=lte.${to}&select=task_id,occurrence_date,completed_at,completed_by_user_id&order=completed_at.asc,id.asc`, env);
      ticks = (c.ok ? c.data : []).map(x => ({ row: x.task_id, date: x.occurrence_date, at: x.completed_at, by: x.completed_by_user_id, note: null }));
    }
    canTick = !!auth.employeeId && auth.employeeId === employeeId;   // you complete your own (as Today)
    // The person's active template assignments, so the page can fetch each template's register.
    const aRes = await sbDocket(`/rest/v1/checklist_assignments?employee_id=eq.${enc(employeeId)}&unassigned_at=is.null&select=template_id`, env);
    const tIds = uniq((aRes.ok ? aRes.data : []).map(a => a.template_id));
    if (tIds.length) {
      const tr = await sbDocket(`/rest/v1/checklist_templates?id=in.${inList(tIds)}&archived_at=is.null&is_active=eq.true&select=id,name,run_scope&order=name.asc`, env);
      templates = (tr.ok ? tr.data : []).map(t => ({ id: t.id, name: t.name, run_scope: t.run_scope || 'per_person' }));
    }
  } else {
    const tmpl = await loadTemplate(templateId, env);
    if (!tmpl) return err('not_found', 404);
    const shared = tmpl.run_scope === 'shared';
    template = { id: tmpl.id, name: tmpl.name, run_scope: tmpl.run_scope || 'per_person' };
    const asgRes = await sbDocket(`/rest/v1/checklist_assignments?template_id=eq.${enc(templateId)}&select=employee_id,assigned_at,unassigned_at&order=assigned_at.asc`, env);
    const asg = asgRes.ok ? asgRes.data : [];
    // Spans the template counted for this chart: [from, until) date pairs. Inactive / archived
    // templates stop generating due dates the day they were switched off (review #6).
    const offDate = tmpl.archived_at ? istDateStr(new Date(tmpl.archived_at))
      : (tmpl.is_active === false ? istDateStr(new Date(tmpl.updated_at || tmpl.created_at)) : null);
    const live = !offDate;
    let spans;
    if (shared) {
      const amAssignee = await isAssignee(auth, templateId, env);
      let allowed = amAssignee || canViewAll(auth) || canEditTemplate(auth, tmpl);
      const activeIds = uniq(asg.filter(a => !a.unassigned_at).map(a => a.employee_id));
      if (!allowed && activeIds.length) {
        // Same reach as Today: anyone who may view an assignee's checklist sees the shared chart (review #7).
        const er = await sbPodium(`/rest/v1/employees?id=in.${inList(activeIds)}&select=id,department_id`, env);
        allowed = (er.ok ? er.data : []).some(e => canViewChecklistOf(auth, e));
        if (!allowed) { const scope = await peopleInScope(auth, env); allowed = activeIds.some(id => scope.has(id)); }
      }
      if (!allowed) return err('forbidden', 403);
      canTick = amAssignee && live && !!auth.employeeId;   // toggleChecklistItem needs an employee (review #10)
      canClearAny = isAdmin(auth) || canEditTemplate(auth, tmpl);
      // Due only while someone was assigned — the union of every assignment period (review #2b).
      spans = asg.map(a => [istDateStr(new Date(a.assigned_at)), a.unassigned_at ? istDateStr(new Date(a.unassigned_at)) : '9999-12-31'])
        .map(([a, b]) => [a, offDate && offDate < b ? offDate : b]);
    } else {
      if (!employeeId) return err('employee_id required for a per-person checklist', 400);
      const mine = asg.filter(a => a.employee_id === employeeId);
      if (!mine.length) return err('not_assigned', 404);
      const g = await checklistPersonGate(auth, employeeId, env); if (g.error) return g.error;
      owner = { id: g.target.id, full_name: g.target.full_name };
      canTick = live && !!auth.employeeId && auth.employeeId === employeeId && mine.some(a => !a.unassigned_at);
      // Only the days this person was actually assigned count (review #4).
      spans = mine.map(a => [istDateStr(new Date(a.assigned_at)), a.unassigned_at ? istDateStr(new Date(a.unassigned_at)) : '9999-12-31'])
        .map(([a, b]) => [a, offDate && offDate < b ? offDate : b]);
    }
    const secRes = await sbDocket(`/rest/v1/checklist_template_sections?template_id=eq.${enc(templateId)}&select=id,title,due_time&order=sort_order.asc`, env);
    const sections = secRes.data || [];
    const itemRes = sections.length
      ? await sbDocket(`/rest/v1/checklist_template_items?section_id=in.${inList(sections.map(x => x.id))}&select=id,section_id,title,sort_order,created_at&order=sort_order.asc`, env)
      : { data: [] };
    const itemsBySec = {}; (itemRes.data || []).forEach(i => { (itemsBySec[i.section_id] ||= []).push(i); });
    rows = sections.flatMap(sec => (itemsBySec[sec.id] || []).map(i => ({
      // An item added later is not "missed" before it existed (review #5).
      id: i.id, kind: 'item', title: i.title, section: sec.title, due_time: sec.due_time || null, rec: tmpl.recurrence,
      start: i.created_at ? istDateStr(new Date(i.created_at)) : '0000-01-01', spans,
    })));
    if (rows.length) {
      const c = await sbAll(sbDocket, `/rest/v1/checklist_item_completions?template_item_id=in.${inList(rows.map(r => r.id))}&occurrence_date=gte.${from}&occurrence_date=lte.${to}${shared ? '' : `&employee_id=eq.${enc(employeeId)}`}&select=template_item_id,occurrence_date,completed_at,completed_by_user_id,done_by_note&order=completed_at.asc,id.asc`, env);
      ticks = (c.ok ? c.data : []).map(x => ({ row: x.template_item_id, date: x.occurrence_date, at: x.completed_at, by: x.completed_by_user_id, note: x.done_by_note || null }));
    }
  }

  const names = {};
  const byIds = uniq(ticks.map(t => t.by));
  if (byIds.length) {
    const up = await sbStore(`/rest/v1/users_profile?id=in.${inList(byIds)}&select=id,full_name`, env);
    (up.ok ? up.data : []).forEach(u => { names[u.id] = u.full_name; });
  }
  const reg = buildRegister({ rows, ticks, days, today, names, userId: auth.userId });
  return ok({
    from, to, today, kind: templateId ? 'template' : 'recurring', template, templates, owner,
    can_tick: canTick, can_clear_any: canClearAny, ...reg,
  });
}

// Templates the caller can see for the Manage tab: active, non-archived. (Authoring is open;
// edit is gated per-template via _can_edit.) Returns counts, not full nested structure.
async function getChecklistTemplates(url, auth, env) {
  const tRes = await sbDocket(
    `/rest/v1/checklist_templates?archived_at=is.null&select=*&order=name.asc`, env);
  if (!tRes.ok) return err('db_error', 500);
  const tmpls = tRes.data || [];
  if (!tmpls.length) return ok([]);
  const ids = tmpls.map(t => t.id);
  const [secRes, asgRes, deptRes] = await Promise.all([
    sbDocket(`/rest/v1/checklist_template_sections?template_id=in.${inList(ids)}&select=id,template_id`, env),
    sbDocket(`/rest/v1/checklist_assignments?template_id=in.${inList(ids)}&unassigned_at=is.null&select=template_id,employee_id`, env),
    sbPodium(`/rest/v1/departments?select=id,name`, env),
  ]);
  const secByT = {}; (secRes.data || []).forEach(s => { (secByT[s.template_id] ||= []).push(s.id); });
  const secIds = (secRes.data || []).map(s => s.id);
  const itemRes = secIds.length
    ? await sbDocket(`/rest/v1/checklist_template_items?section_id=in.${inList(secIds)}&select=section_id`, env)
    : { data: [] };
  const itemBySec = {}; (itemRes.data || []).forEach(i => { itemBySec[i.section_id] = (itemBySec[i.section_id] || 0) + 1; });
  const asgCount = {}; (asgRes.data || []).forEach(a => { asgCount[a.template_id] = (asgCount[a.template_id] || 0) + 1; });
  const deptName = {}; (deptRes.data || []).forEach(d => { deptName[d.id] = d.name; });
  return ok(tmpls.map(t => {
    const sIds = secByT[t.id] || [];
    return {
      ...t,
      department_name: deptName[t.department_id] || null,
      section_count: sIds.length,
      item_count: sIds.reduce((n, sid) => n + (itemBySec[sid] || 0), 0),
      assignee_count: asgCount[t.id] || 0,
      _can_edit: canEditTemplate(auth, t),
    };
  }));
}

// Full nested template (sections → items) + active assignees, for the editor.
async function getChecklistTemplate(url, auth, env) {
  const id = url.searchParams.get('id');
  if (!id) return err('id required', 400);
  const tmpl = await loadTemplate(id, env);
  if (!tmpl) return err('not_found', 404);
  const secRes = await sbDocket(
    `/rest/v1/checklist_template_sections?template_id=eq.${enc(id)}&select=*&order=sort_order.asc`, env);
  const sections = secRes.data || [];
  const secIds = sections.map(s => s.id);
  const itemRes = secIds.length
    ? await sbDocket(`/rest/v1/checklist_template_items?section_id=in.${inList(secIds)}&select=*&order=sort_order.asc`, env)
    : { data: [] };
  const itemsBySec = {}; (itemRes.data || []).forEach(i => { (itemsBySec[i.section_id] ||= []).push(i); });
  const asgRes = await sbDocket(
    `/rest/v1/checklist_assignments?template_id=eq.${enc(id)}&unassigned_at=is.null&select=employee_id&order=assigned_at.asc`, env);
  const empIds = uniq((asgRes.data || []).map(a => a.employee_id));
  const empRes = empIds.length
    ? await sbPodium(`/rest/v1/employees?id=in.${inList(empIds)}&select=id,full_name`, env) : { data: [] };
  const empName = {}; (empRes.data || []).forEach(e => { empName[e.id] = e.full_name; });
  return ok({
    ...tmpl,
    sections: sections.map(s => ({ ...s, items: itemsBySec[s.id] || [] })),
    assignees: empIds.map(eid => ({ employee_id: eid, full_name: empName[eid] || null })),
    _can_edit: canEditTemplate(auth, tmpl),
  });
}

// Oversight (R1): per-person adherence for a date, scoped to people the caller may monitor.
async function getChecklistOversight(url, auth, env) {
  const date = url.searchParams.get('date') || istDateStr();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return err('invalid date', 400);
  const scope = await peopleInScope(auth, env);
  const ids = [...scope];
  if (!ids.length) return ok({ date, people: [] });

  const [empRes, deptRes] = await Promise.all([
    sbPodium(`/rest/v1/employees?id=in.${inList(ids)}&status=eq.active&select=id,full_name,department_id&order=full_name.asc`, env),
    sbPodium(`/rest/v1/departments?select=id,name`, env),
  ]);
  const emps = empRes.data || [];
  const deptName = {}; (deptRes.data || []).forEach(d => { deptName[d.id] = d.name; });

  // Flat recurring tasks for everyone in scope (one read), then completions for the date.
  const recRes = await sbDocket(
    `/rest/v1/tasks?is_recurring=eq.true&status=neq.abandoned&owner_employee_id=in.${inList(ids)}&select=id,owner_employee_id,recurrence`, env);
  const recByEmp = {}; (recRes.data || []).forEach(t => {
    if (isDueOn(t.recurrence, date) && !isExpired(t.recurrence, date)) (recByEmp[t.owner_employee_id] ||= []).push(t.id);
  });
  const allRecIds = Object.values(recByEmp).flat();
  const recDone = new Set();
  if (allRecIds.length) {
    const cRes = await sbDocket(`/rest/v1/checklist_completions?task_id=in.${inList(allRecIds)}&occurrence_date=eq.${date}&select=task_id`, env);
    (cRes.ok ? cRes.data : []).forEach(c => recDone.add(c.task_id));
  }

  // Assignments → templates due today → items; completions for the date.
  const asgRes = await sbDocket(
    `/rest/v1/checklist_assignments?employee_id=in.${inList(ids)}&unassigned_at=is.null&select=template_id,employee_id`, env);
  const asg = asgRes.data || [];
  const tmplIds = uniq(asg.map(a => a.template_id));
  const tmplRes = tmplIds.length
    ? await sbDocket(`/rest/v1/checklist_templates?id=in.${inList(tmplIds)}&archived_at=is.null&is_active=eq.true&select=id,name,recurrence,run_scope`, env)
    : { data: [] };
  const tmplById = {}; (tmplRes.data || []).forEach(t => { tmplById[t.id] = t; });
  const dueTmplIds = (tmplRes.data || []).filter(t => isDueOn(t.recurrence, date) && !isExpired(t.recurrence, date)).map(t => t.id);
  const secRes = dueTmplIds.length
    ? await sbDocket(`/rest/v1/checklist_template_sections?template_id=in.${inList(dueTmplIds)}&select=id,template_id,title&order=sort_order.asc`, env)
    : { data: [] };
  const sections = secRes.data || [];
  const secIds = sections.map(s => s.id);
  const itemRes = secIds.length
    ? await sbDocket(`/rest/v1/checklist_template_items?section_id=in.${inList(secIds)}&select=id,section_id`, env)
    : { data: [] };
  const items = itemRes.data || [];
  const itemIds = items.map(i => i.id);
  // Completions across ALL people in scope for the date (one read), keyed by item+employee.
  const itemComplRes = itemIds.length
    ? await sbDocket(`/rest/v1/checklist_item_completions?template_item_id=in.${inList(itemIds)}&occurrence_date=eq.${date}&select=template_item_id,employee_id`, env)
    : { data: [] };
  const doneByEmpItem = new Set((itemComplRes.data || []).map(c => `${c.employee_id}|${c.template_item_id}`));
  const doneAnyItem = new Set((itemComplRes.data || []).map(c => c.template_item_id));   // shared templates (F8 C1)

  const itemsBySec = {}; items.forEach(i => { (itemsBySec[i.section_id] ||= []).push(i.id); });
  const secByTmpl = {}; sections.forEach(s => { (secByTmpl[s.template_id] ||= []).push(s); });
  const tmplsByEmp = {}; asg.forEach(a => { if (tmplById[a.template_id]) (tmplsByEmp[a.employee_id] ||= []).push(a.template_id); });

  const people = emps.map(e => {
    const recIds = recByEmp[e.id] || [];
    const recurring = { done: recIds.filter(id => recDone.has(id)).length, total: recIds.length };
    const templates = (tmplsByEmp[e.id] || []).filter(tid => dueTmplIds.includes(tid)).map(tid => {
      const secs = secByTmpl[tid] || [];
      const shared = tmplById[tid].run_scope === 'shared';
      let done = 0, total = 0; const incompleteSections = [];
      for (const s of secs) {
        const sItemIds = itemsBySec[s.id] || [];
        const sDone = sItemIds.filter(iid => shared ? doneAnyItem.has(iid) : doneByEmpItem.has(`${e.id}|${iid}`)).length;
        done += sDone; total += sItemIds.length;
        if (sItemIds.length && sDone < sItemIds.length) incompleteSections.push(s.title);
      }
      return { template_id: tid, name: tmplById[tid].name, done, total, incomplete_sections: incompleteSections };
    });
    return {
      employee_id: e.id, full_name: e.full_name, department_name: deptName[e.department_id] || null,
      recurring, templates,
    };
  });
  // Only surface people who actually have something scheduled today.
  return ok({ date, people: people.filter(p => p.recurring.total > 0 || p.templates.length > 0) });
}

async function getDocketRoles(url, auth, env) {
  const r = await sbStore(`/rest/v1/docket_roles?select=*&order=is_system.desc,label.asc`, env);
  if (!r.ok) return err('db_error', 500);
  return ok(r.data || []);
}
async function getDocketUsers(url, auth, env) {
  const gate = requireAdmin(auth); if (gate) return gate;
  const [up, ur] = await Promise.all([
    sbStore(`/rest/v1/users_profile?select=id,full_name,role,active&active=eq.true&order=full_name.asc`, env),
    sbStore(`/rest/v1/docket_user_roles?select=user_id,role_key`, env),
  ]);
  if (!up.ok) return err('db_error', 500);
  const roleMap = {}; if (ur.ok) (ur.data || []).forEach(x => { roleMap[x.user_id] = x.role_key; });
  const authUsers = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users?per_page=1000`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
  });
  const authData = authUsers.ok ? await authUsers.json() : { users: [] };
  const emailMap = {}; (authData.users || []).forEach(u => { emailMap[u.id] = u.email; });
  return ok((up.data || []).map(u => ({ ...u, email: emailMap[u.id] || '', docket_role: roleMap[u.id] || null })));
}

// Dashboard sharing config (RULE-DOCKET-006) — admin only.
async function getDashboardSharing(url, auth, env) {
  const gate = requireAdmin(auth); if (gate) return gate;
  const [pub, viewers] = await Promise.all([
    dashboardPublic(env),
    sbDocket(`/rest/v1/dashboard_viewers?select=user_id&order=granted_at.asc`, env),
  ]);
  const ids = (viewers.ok ? viewers.data : []).map(v => v.user_id);
  let nameMap = {};
  if (ids.length) {
    const up = await sbStore(`/rest/v1/users_profile?select=id,full_name&id=in.${inList(ids)}`, env);
    if (up.ok) (up.data || []).forEach(u => { nameMap[u.id] = u.full_name; });
  }
  return ok({ public: pub, viewers: ids.map(id => ({ user_id: id, full_name: nameMap[id] || '' })) });
}

// ════════════════════════════════════════════════════════════════════════════
// POST handlers
// ════════════════════════════════════════════════════════════════════════════
async function mintTaskNo(env) {
  const r = await sbDocket(`/rest/v1/rpc/next_task_seq`, env, { method: 'POST', body: '{}' });
  if (!r.ok) throw new Error('seq_failed: ' + JSON.stringify(r.data));
  return r.data; // 'DKT-N'
}

// F9 R8 (spec §4.6) — the hand-off fields a create / update asks for, validated against the task they land on.
// `cur` = the task's current hand-off and own side { dept, emp, own, owner } (create: {}); `next` = its own side
// AFTER the write { own: department, owner: owner employee }. Body keys: handoff_to_department_id /
// handoff_to_employee_id — undefined = untouched, null / '' = clear; ids are lowercased before any comparison
// (PostgREST stores them lowercase, so 'D2' ≠ 'd2' would slip past the same-team check). Clearing the department
// clears all four (the 0027 trigger nulls the rest). A receiver with no department → the receiver's department;
// a receiver from another department → handoff_receiver_team; an exited one → handoff_receiver_inactive (checked
// only when the receiving side CHANGES, so an edit that touches nothing else never fails on a receiver who has
// since left). A changed department with no receiver given drops the old receiver (they were the old team's).
// The giving side is the task's department, else its OWNER's department; it must differ from the receiving one
// (handoff_same_team) — re-checked when only the own side moves, with the named receiver left alone. The owner
// can't be the named receiver. handoff_accepted_at / _by are NEVER taken from a body — only acceptHandoff
// writes them (and the trigger voids them when the receiver changes).
// → { none: true } (not touched) | { fields: { handoff_to_department_id, handoff_to_employee_id } } | { error }
const HANDOFF_KEYS = ['handoff_to_department_id', 'handoff_to_employee_id'];
const lcId = (v) => (v == null || v === '' ? null : String(v).toLowerCase());
async function resolveHandoff(d, cur, next, isSub, env) {
  const has = (k) => d[k] !== undefined;
  for (const k of HANDOFF_KEYS) if (has(k) && lcId(d[k]) !== null && !isUuid(String(d[k]))) return { error: err('bad_handoff', 400) };
  const curDept = lcId(cur.dept), curEmp = lcId(cur.emp), own = lcId(next.own), owner = lcId(next.owner);
  let dept = has('handoff_to_department_id') ? lcId(d.handoff_to_department_id) : curDept;
  const emp = has('handoff_to_employee_id') ? lcId(d.handoff_to_employee_id)
    : (has('handoff_to_department_id') && dept !== curDept ? null : curEmp);
  if (has('handoff_to_department_id') && dept === null) return { fields: { handoff_to_department_id: null, handoff_to_employee_id: null } };
  const recvChanged = dept !== curDept || emp !== curEmp;
  // The owner counts as the own side when the task has no department (it gives from the owner's team) AND when a
  // receiver is named (the owner can't be them) — bulk owner changes apply the same two checks.
  const ownMoved = cur.own !== undefined && (own !== lcId(cur.own) || ((!own || !!curEmp) && owner !== lcId(cur.owner)));
  if (!recvChanged && !(ownMoved && curDept)) return { none: true };
  // One read for the new receiver and (no task department) the owner, whose department is the giving side.
  const ids = uniq([recvChanged ? emp : null, own ? null : owner]);
  const er = ids.length ? await sbPodium(`/rest/v1/employees?id=in.${inList(ids)}&select=id,department_id,status`, env) : { ok: true, data: [] };
  if (!er.ok) return { error: err('db_error', 500) };
  const empRow = (id) => (er.data || []).find(x => lcId(x.id) === id) || null;
  if (emp && recvChanged) {
    const e = empRow(emp);
    if (!e) return { error: err('bad_handoff', 400) };
    if (!dept) dept = lcId(e.department_id);
    if (!dept) return { error: err('bad_handoff', 400) };            // a receiver with no team names no receiving side
    if (lcId(e.department_id) !== dept) return { error: err('handoff_receiver_team', 400) };
    if (e.status !== 'active') return { error: err('handoff_receiver_inactive', 400) };
  } else if (dept && dept !== curDept) {
    const dr = await sbPodium(`/rest/v1/departments?id=eq.${enc(dept)}&select=id&limit=1`, env);
    if (!dr.ok) return { error: err('db_error', 500) };
    if (!dr.data?.[0]) return { error: err('bad_handoff', 400) };
  }
  if (!dept) return { fields: { handoff_to_department_id: null, handoff_to_employee_id: null } };
  if (isSub) return { error: err('handoff_top_level', 400) };
  const giving = own || lcId(empRow(owner)?.department_id);
  if ((giving && giving === dept) || (emp && owner && emp === owner)) return { error: err('handoff_same_team', 400) };
  return { fields: { handoff_to_department_id: dept, handoff_to_employee_id: emp } };
}
// The history row for a hand-off change (ids only; getTask names them): handoff_set / handoff_cleared.
function handoffHistory(before, after) {
  if ((before.dept || null) === (after.handoff_to_department_id || null) && (before.emp || null) === (after.handoff_to_employee_id || null)) return null;
  if (!after.handoff_to_department_id) return ['handoff_cleared', { field: 'handoff', old: before.dept }];
  return ['handoff_set', { field: 'handoff', old: before.dept || null, new: after.handoff_to_department_id, note: after.handoff_to_employee_id || null }];
}
async function createTaskCore(d, auth, env) {
  // Quick-capture: only a title is required. Everything else (team/owner/assignee/
  // deadline) is optional and enriched later — the task lands in "The Grid" until it
  // has both an owner and a deadline. (RULE-DOCKET-001, V2.)
  if (!d.title || !String(d.title).trim()) return err('title required', 400);
  if (d.program_id === '') d.program_id = null;   // '' = "No program" (an explicit choice, never inherited)
  // Optional initial status (a status-group "+ Add task"), so it is one write + one history row.
  if (d.status != null && d.status !== '' && !d.is_recurring) {
    if (d.status === 'abandoned') return err('use abandonTask to abandon (reason required)', 422);
    if (!['not_started', 'in_progress', 'done', 'blocked'].includes(d.status)) return err('invalid status', 400);
  }
  const initStatus = d.is_recurring ? 'in_progress' : (d.status || 'not_started');

  // Recurring (checklist) task: validate the rule, force top-level, default owner = caller.
  const isRecurring = !!d.is_recurring;
  if (isRecurring) {
    const e = validateRecurrence(d.recurrence);
    if (e) return err(e, 400);
    d.recurrence = normalizeRecurrence(d.recurrence);
    d.parent_task_id = null;                                  // recurring tasks are top-level (v1)
    if (d.owner_employee_id == null) d.owner_employee_id = auth.employeeId || null; // "create for myself"
  }

  // "Add to my list" (My-tasks quick-capture) — default owner to the caller.
  if (d.assign_self && d.owner_employee_id == null) d.owner_employee_id = auth.employeeId || null;

  let parentId = d.parent_task_id || null;
  let spaceId = d.space_id || null;
  // F9 R2: an optional plan link — top-level only (a sub-task follows its parent's).
  const planItemId = d.plan_item_id || null;
  if (planItemId && parentId) return planErr('subtask_follows_parent');
  if (parentId) {
    const parent = await loadTaskFor(parentId, auth, env);
    if (!parent || !(await seesTask(auth, parent, env))) return err('parent_not_found', 404);
    if (parent.parent_task_id) return err('one_level_only: parent is already a sub-task', 422);
    if (parent.status === 'abandoned') return abandonedRO();
    spaceId = parent.space_id; // a sub-task always lives in its parent's space
    // A sub-task inherits owner / program / team from its parent unless the caller
    // explicitly set them (speed-create passes title only — these fill in from the parent).
    // The program inherits only when OMITTED: an explicit null ("No program") stays null.
    if (d.owner_employee_id == null) d.owner_employee_id = parent.owner_employee_id || null;
    if (d.program_id === undefined)  d.program_id        = parent.program_id || null;
    if (d.department_id == null)     d.department_id     = parent.department_id || null;
  }
  // P3b: no space named → the task's team's home space (its team, or its owner's), else the caller's Personal.
  // A task filed for ANOTHER team (an explicit team that isn't yours) whose space you can't open is refused, not
  // dropped into your Personal space where that team would never see it (hostile review P3b #4) — hand it off.
  if (!spaceId) {
    const team = d.department_id || (d.owner_employee_id ? await employeeDept(d.owner_employee_id, env) : null);
    const home = await homeSpaceFor(auth, team, env);
    if (!home && d.department_id && lcId(d.department_id) !== lcId(auth.departmentId || '')) return err('team_space_closed', 422);
    spaceId = home || await personalSpaceId(auth, env);
    if (!spaceId) return err('no_default_space', 500);
  }
  const space = await loadSpace(spaceId, env);
  if (!space) return err('space_not_found', 404);
  if (!(await canWriteSpace(auth, space, env))) return err('forbidden_space', 403);
  // Defaults — explicit values always win: a top-level task in your personal space is yours; a task with an
  // owner and no team takes the owner's team (a sub-task takes its parent's first, above). On create, null / ''
  // mean "not chosen" (forms send '' for an untouched field); there is nothing to clear yet.
  if (!parentId && !d.owner_employee_id && await isPersonalSpace(space, auth, env)) d.owner_employee_id = auth.employeeId;
  if (!d.department_id && d.owner_employee_id) d.department_id = await employeeDept(d.owner_employee_id, env);
  if (planItemId) { const c = await checkLinkTarget(auth, planItemId, space, env); if (c.error) return c.error; }
  // R8: an optional hand-off (validated; never an acceptance — that is acceptHandoff's alone).
  const ho = await resolveHandoff(d, {}, { own: d.department_id || null, owner: d.owner_employee_id || null }, !!parentId, env);
  if (ho.error) return ho.error;
  const hoFields = ho.fields && ho.fields.handoff_to_department_id ? ho.fields : null;
  const task_no = await mintTaskNo(env);
  const ins = await sbDocket(`/rest/v1/tasks`, env, {
    method: 'POST',
    body: JSON.stringify([{
      task_no, title: String(d.title).trim(), description: d.description || null,
      department_id: d.department_id || null, owner_employee_id: d.owner_employee_id || null,
      status: initStatus, priority: d.priority || 'P2',
      completed_at: initStatus === 'done' ? nowIso() : null,
      parent_task_id: parentId, created_by_user_id: auth.userId,
      deadline: d.deadline || null, custom_fields: d.custom_fields || {},
      space_id: spaceId, program_id: d.program_id || null, plan_item_id: planItemId,
      is_recurring: isRecurring, recurrence: isRecurring ? d.recurrence : null,
      handoff_to_department_id: hoFields ? hoFields.handoff_to_department_id : null,
      handoff_to_employee_id: hoFields ? hoFields.handoff_to_employee_id : null,
    }]),
  });
  if (!ins.ok || !ins.data?.[0]) return taskWriteErr('create_failed: ', ins);
  const task = ins.data[0];

  if (Array.isArray(d.collaborators) && d.collaborators.length) {
    const rows = uniq(d.collaborators).map(eid => ({ task_id: task.id, employee_id: eid, added_by: auth.userId }));
    await sbDocket(`/rest/v1/task_collaborators`, env, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(rows) });
  }
  if (Array.isArray(d.documents) && d.documents.length) {
    const rows = d.documents.filter(x => isHttpUrl(x.url))
      .map(x => ({ task_id: task.id, title: x.title || null, url: x.url.trim(), added_by: auth.userId }));
    if (rows.length) await sbDocket(`/rest/v1/task_documents`, env, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(rows) });
  }
  await logHistory(env, task.id, auth, 'created',
    { note: parentId ? 'sub-task' : null, ...(initStatus !== 'not_started' && !isRecurring ? { field: 'status', new: initStatus } : {}) });
  // A deadline given at create is the immutable original (RULE-DOCKET-001) — log it like
  // updateTask's first set, so the activity feed and "deadline_set" counts see it (F2 quick-add).
  if (d.deadline && !isRecurring) await logHistory(env, task.id, auth, 'deadline_set', { field: 'deadline', new: d.deadline });
  // The link's history row stores the item id only (rendered through the projection at read time).
  if (planItemId) await logHistory(env, task.id, auth, 'plan_item_id_changed', { field: 'plan_item_id', new: planItemId });
  if (hoFields) await logHistory(env, task.id, auth, ...handoffHistory({}, hoFields));
  return ok({ id: task.id, task_no: task.task_no, owner_employee_id: task.owner_employee_id || null, department_id: task.department_id || null,
    space_id: task.space_id || spaceId, space_name: space.name, space_is_personal: !!space.is_personal });
}
async function createTask(body, auth, env)    { return createTaskCore(body.data || body, auth, env); }
async function createSubtask(body, auth, env) {
  const d = body.data || body;
  if (!d.parent_task_id) return err('parent_task_id required', 400);
  return createTaskCore(d, auth, env);
}
// A recurring (checklist) task — owner = the assignee (defaults to the caller). RULE-DOCKET-008.
async function createRecurringTask(body, auth, env) {
  const d = body.data || body;
  d.is_recurring = true;
  return createTaskCore(d, auth, env);
}
async function updateRecurrence(body, auth, env) {
  const d = body.data || body;
  if (!d.id) return err('id required', 400);
  const e = validateRecurrence(d.recurrence); if (e) return err(e, 400);
  const task = await loadTaskFor(d.id, auth, env);
  if (!task) return err('not_found', 404);
  if (!task.is_recurring) return err('not_a_recurring_task', 422);
  if (!canEditTask(auth, task)) return err('forbidden', 403);
  if (task.status === 'abandoned') return abandonedRO();
  const rec = normalizeRecurrence(d.recurrence);
  const r = await sbDocket(`/rest/v1/tasks?id=eq.${enc(d.id)}`, env, {
    method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({ recurrence: rec, updated_by: auth.userId, updated_at: nowIso() }) });
  if (!r.ok) return err('update_failed: ' + JSON.stringify(r.data), 400);
  await logHistory(env, task.id, auth, 'recurrence_changed',
    { field: 'recurrence', old: JSON.stringify(task.recurrence), new: JSON.stringify(rec) });
  return ok({ id: task.id, recurrence: rec });
}
// Check/uncheck one occurrence (date defaults to IST today). The completion row IS the audit.
async function toggleChecklistOccurrence(body, auth, env) {
  const d = body.data || body;
  if (!d.id) return err('id required', 400);
  const task = await loadTaskFor(d.id, auth, env);
  if (!task) return err('not_found', 404);
  if (!task.is_recurring) return err('not_a_recurring_task', 422);
  if (!canEditTask(auth, task)) return err('forbidden', 403);
  if (task.status === 'abandoned') return abandonedRO();
  const date = d.date || istDateStr();
  if (!isValidDate(date)) return err('invalid date', 400);
  const fut = futureDateErr(date); if (fut) return fut;
  const completed = d.completed === true || d.completed === 'true';
  if (completed && !isDueOn(task.recurrence, date)) return err('not_due', 422);
  if (completed) {
    const r = await sbDocket(`/rest/v1/checklist_completions?on_conflict=task_id,occurrence_date`, env, {
      method: 'POST', prefer: 'return=minimal,resolution=ignore-duplicates',
      body: JSON.stringify({ task_id: d.id, occurrence_date: date, completed_by_user_id: auth.userId }) });
    if (!r.ok) return err('complete_failed: ' + JSON.stringify(r.data), 400);
  } else {
    await sbDocket(`/rest/v1/checklist_completions?task_id=eq.${enc(d.id)}&occurrence_date=eq.${date}`, env,
      { method: 'DELETE', prefer: 'return=minimal' });
  }
  return ok({ id: d.id, date, completed });
}

// ── Checklist template CRUD (RULE-DOCKET-009) ───────────────────────────────
// Create or update a template + its sections/items in one call (diff-upsert).
// Author = any authenticated user; edit of an existing template = creator or admin.
async function saveChecklistTemplate(body, auth, env) {
  const d = body.data || body;
  if (!d.name || !String(d.name).trim()) return err('name required', 400);
  if (d.kind !== undefined && !TEMPLATE_KINDS.includes(d.kind)) return err('bad_kind', 400);
  const sectionsIn = Array.isArray(d.sections) ? d.sections : [];

  let template, before = [], curSecs = [];
  if (d.id) {
    template = await loadTemplate(d.id, env);
    if (!template) return err('not_found', 404);
    if (!canEditTemplate(auth, template)) return err('forbidden', 403);
    // F8 P2: a template's kind is fixed at creation (records snapshot a record template; routines carry ticks).
    if (d.kind !== undefined && d.kind !== (template.kind || 'routine')) return err('kind_locked', 422);
    const secs = await templateSections(d.id, env);
    if (!secs) return err('db_error: template', 500);   // the version diff must see the whole template
    before = flattenTemplate(secs);
    curSecs = secs;
  }
  // Only this template's sections and items are written (an editor of A must not rewrite B's rows by id) —
  // refused before anything is written.
  const existSecIds = curSecs.map(x => x.id);
  const ownItemIds = new Set(curSecs.flatMap(x => x.items.map(i => i.id)));
  if (sectionsIn.some(x => x.id && !existSecIds.includes(x.id))) return err('section_not_in_template', 422);
  const payloadItemIds = new Set(sectionsIn.flatMap(x => (Array.isArray(x.items) ? x.items : []).map(i => i.id).filter(Boolean)));
  if ([...payloadItemIds].some(id => !ownItemIds.has(id))) return err('item_not_in_template', 422);
  const kind = template ? (template.kind || 'routine') : (d.kind || 'routine');
  // A record template has no cadence (C3: copied per subject, ticked once) — it stores the inert { freq: 'none' }.
  let rec = RECORD_RECURRENCE;
  if (kind === 'routine') {
    const recErr = validateTemplateRecurrence(d.recurrence); if (recErr) return err(recErr, 400);
    rec = normalizeTemplateRecurrence(d.recurrence);
  }
  const diff = templateItemsDiff(before, sectionsIn);

  if (d.id) {
    const upd = {
      name: String(d.name).trim(), role_label: d.role_label || null,
      department_id: d.department_id || null, description: d.description || null,
      recurrence: rec, is_active: d.is_active !== false,
      updated_at: nowIso(), updated_by_user_id: auth.userId,
    };
    if (d.run_scope !== undefined && kind === 'routine') {
      const want = d.run_scope === 'shared' ? 'shared' : 'per_person';
      if (want !== (template.run_scope || 'per_person')) {
        // Switching chart type would re-read every past tick differently — locked once anything is ticked.
        const secs = await sbDocket(`/rest/v1/checklist_template_sections?template_id=eq.${enc(d.id)}&select=id`, env);
        const secIds = (secs.ok ? secs.data : []).map(x => x.id);
        const its = secIds.length ? await sbDocket(`/rest/v1/checklist_template_items?section_id=in.${inList(secIds)}&select=id`, env) : { data: [] };
        const itIds = (its.data || []).map(x => x.id);
        const ticked = itIds.length ? await sbDocket(`/rest/v1/checklist_item_completions?template_item_id=in.${inList(itIds)}&select=id&limit=1`, env) : { data: [] };
        if (ticked.data?.length) return err('run_scope_locked: this checklist already has ticks', 422);
      }
      upd.run_scope = want;
    }
    const r = await sbDocket(`/rest/v1/checklist_templates?id=eq.${enc(d.id)}`, env, {
      method: 'PATCH', prefer: 'return=representation', body: JSON.stringify(upd) });
    if (!r.ok || !r.data?.[0]) return err('update_failed: ' + JSON.stringify(r.data), 400);
    template = r.data[0];
  } else {
    const r = await sbDocket(`/rest/v1/checklist_templates`, env, {
      method: 'POST', body: JSON.stringify([{
        name: String(d.name).trim(), role_label: d.role_label || null,
        department_id: d.department_id || null, description: d.description || null,
        recurrence: rec, created_by_user_id: auth.userId,
        run_scope: kind === 'routine' && d.run_scope === 'shared' ? 'shared' : 'per_person',
        kind, version: 1,
      }]) });
    if (!r.ok || !r.data?.[0]) return err('create_failed: ' + JSON.stringify(r.data), 400);
    template = r.data[0];
  }

  // Diff-upsert sections + items. Moves are written BEFORE anything is dropped: an item is deleted only when its
  // id is nowhere in the payload (one DELETE after the loop), and dropped sections go last, so their CASCADE takes
  // only items that left the template (and their completions / comments — acceptable: editing structure). Every
  // write is checked: on a failure nothing more is written, the version is not bumped, and the answer carries the
  // template id (a create is already committed).
  const fail = (code, r) => json({ ok: false, error: `${code}: ` + JSON.stringify(r?.data ?? null), id: template.id, partial: true }, 400);
  const ownSecIds = [...existSecIds];
  for (let si = 0; si < sectionsIn.length; si++) {
    const s = sectionsIn[si];
    const secRow = {
      template_id: template.id, title: String(s.title || '').trim() || 'Section',
      subtitle: s.subtitle || null,
      due_time: (s.due_time && /^([01]?\d|2[0-3]):[0-5]\d$/.test(s.due_time)) ? s.due_time : null,
      sort_order: si,
    };
    let sectionId = s.id;
    if (sectionId) {
      const sr = await sbDocket(`/rest/v1/checklist_template_sections?id=eq.${enc(sectionId)}&template_id=eq.${enc(template.id)}`, env,
        { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(secRow) });
      if (!sr.ok) return fail('section_failed', sr);
    } else {
      const sr = await sbDocket(`/rest/v1/checklist_template_sections`, env,
        { method: 'POST', body: JSON.stringify([secRow]) });
      if (!sr.ok || !sr.data?.[0]) return fail('section_failed', sr);
      sectionId = sr.data[0].id;
      ownSecIds.push(sectionId);
    }
    const itemsIn = Array.isArray(s.items) ? s.items : [];
    const toInsert = [];
    for (let ii = 0; ii < itemsIn.length; ii++) {
      const it = itemsIn[ii];
      const itemRow = {
        section_id: sectionId, title: String(it.title || '').trim() || 'Item',
        help_text: it.help_text || null, tags: sanitizeTags(it.tags), sort_order: ii,
      };
      if (it.id) {
        const ir = await sbDocket(`/rest/v1/checklist_template_items?id=eq.${enc(it.id)}&section_id=in.${inList(ownSecIds)}`, env,
          { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(itemRow) });
        if (!ir.ok) return fail('item_failed', ir);
      } else {
        toInsert.push(itemRow);
      }
    }
    if (toInsert.length) {
      const ir = await sbDocket(`/rest/v1/checklist_template_items`, env,
        { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(toInsert) });
      if (!ir.ok) return fail('item_failed', ir);
    }
  }
  const dropItemIds = [...ownItemIds].filter(id => !payloadItemIds.has(id));
  if (dropItemIds.length) {
    const dr = await sbDocket(`/rest/v1/checklist_template_items?id=in.${inList(dropItemIds)}&section_id=in.${inList(existSecIds)}`, env,
      { method: 'DELETE', prefer: 'return=minimal' });
    if (!dr.ok) return fail('item_drop_failed', dr);
  }
  const keepSecIds = sectionsIn.map(x => x.id).filter(Boolean);
  const dropSecIds = existSecIds.filter(id => !keepSecIds.includes(id));
  if (dropSecIds.length) {
    const dr = await sbDocket(`/rest/v1/checklist_template_sections?id=in.${inList(dropSecIds)}&template_id=eq.${enc(template.id)}`, env,
      { method: 'DELETE', prefer: 'return=minimal' });
    if (!dr.ok) return fail('section_drop_failed', dr);
  }
  // F8 P2: bump the version when items were added, removed, renamed or reordered, and log every save. The
  // structure is saved by now, so a failure here is reported as a flag on success, never as an error.
  // Open records compare by source_item_id (pullTemplateUpdates), so the number is for people, not matching.
  let version = Number(template.version) || 1;
  const flags = {};
  if (d.id && diff.changed) {
    const v = await sbDocket(`/rest/v1/checklist_templates?id=eq.${enc(template.id)}`, env,
      { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ version: version + 1 }) });
    if (v.ok) version += 1; else flags.version_failed = true;
  }
  const h = await sbDocket(`/rest/v1/checklist_template_history`, env, { method: 'POST', prefer: 'return=minimal',
    body: JSON.stringify({ template_id: template.id, event: d.id ? 'saved' : 'created', actor_user_id: auth.userId,
      detail: { version, added: diff.added, removed: diff.removed, renamed: diff.renamed, reordered: diff.reordered } }) });
  if (!h.ok) flags.history_failed = true;
  return ok({ id: template.id, version, ...flags });
}

async function archiveChecklistTemplate(body, auth, env) {
  const d = body.data || body;
  if (!d.id) return err('id required', 400);
  const tmpl = await loadTemplate(d.id, env);
  if (!tmpl) return err('not_found', 404);
  if (!canEditTemplate(auth, tmpl)) return err('forbidden', 403);
  const r = await sbDocket(`/rest/v1/checklist_templates?id=eq.${enc(d.id)}`, env, {
    method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({ archived_at: nowIso(), is_active: false, updated_at: nowIso(), updated_by_user_id: auth.userId }) });
  if (!r.ok) return err('archive_failed: ' + JSON.stringify(r.data), 400);
  const h = await sbDocket(`/rest/v1/checklist_template_history`, env, { method: 'POST', prefer: 'return=minimal',
    body: JSON.stringify({ template_id: d.id, event: 'archived', actor_user_id: auth.userId, detail: {} }) });
  return ok({ archived: d.id, ...(h.ok ? {} : { history_failed: true }) });
}

// ── Checklist template assignment (RULE-DOCKET-009) ─────────────────────────
// Open authoring → any authenticated user may assign. Idempotent via a pre-check
// (the active-partial unique index can't be a PostgREST on_conflict target).
async function assignChecklistTemplate(body, auth, env) {
  const d = body.data || body;
  if (!d.template_id || !d.employee_id) return err('template_id + employee_id required', 400);
  const tmpl = await loadTemplate(d.template_id, env);
  if (!tmpl) return err('template_not_found', 404);
  if (tmpl.kind === 'record') return err('record_template_not_assignable', 422);   // F8 P2: copied, not assigned
  const exists = await sbDocket(
    `/rest/v1/checklist_assignments?template_id=eq.${enc(d.template_id)}&employee_id=eq.${enc(d.employee_id)}&unassigned_at=is.null&select=id&limit=1`, env);
  if (exists.ok && exists.data?.length) return ok({ template_id: d.template_id, employee_id: d.employee_id, already: true });
  const r = await sbDocket(`/rest/v1/checklist_assignments`, env, {
    method: 'POST', prefer: 'return=minimal',
    body: JSON.stringify({ template_id: d.template_id, employee_id: d.employee_id, assigned_by_user_id: auth.userId }) });
  if (!r.ok) return err('assign_failed: ' + JSON.stringify(r.data), 400);
  return ok({ template_id: d.template_id, employee_id: d.employee_id });
}
async function unassignChecklistTemplate(body, auth, env) {
  const d = body.data || body;
  if (!d.template_id || !d.employee_id) return err('template_id + employee_id required', 400);
  const r = await sbDocket(
    `/rest/v1/checklist_assignments?template_id=eq.${enc(d.template_id)}&employee_id=eq.${enc(d.employee_id)}&unassigned_at=is.null`,
    env, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ unassigned_at: nowIso() }) });
  if (!r.ok) return err('unassign_failed: ' + JSON.stringify(r.data), 400);
  return ok({ template_id: d.template_id, employee_id: d.employee_id, unassigned: true });
}

// ── Checklist run completion (RULE-DOCKET-009) ──────────────────────────────
// You may complete / comment on a template run only if you are its assignee (or admin).
async function isAssignee(auth, templateId, env) {
  if (isAdmin(auth)) return true;
  if (!auth.employeeId) return false;
  const r = await sbDocket(
    `/rest/v1/checklist_assignments?template_id=eq.${enc(templateId)}&employee_id=eq.${enc(auth.employeeId)}&unassigned_at=is.null&select=id&limit=1`, env);
  return !!(r.ok && r.data?.length);
}
// Resolve an item → its template_id (via section) for the assignee check.
async function templateIdOfItem(itemId, env) {
  const ir = await sbDocket(`/rest/v1/checklist_template_items?id=eq.${enc(itemId)}&select=section_id&limit=1`, env);
  const sectionId = ir.ok && ir.data?.[0]?.section_id;
  if (!sectionId) return null;
  const sr = await sbDocket(`/rest/v1/checklist_template_sections?id=eq.${enc(sectionId)}&select=template_id&limit=1`, env);
  return (sr.ok && sr.data?.[0]?.template_id) || null;
}
// Check/uncheck one item for the caller's own run on a date (default IST today).
async function toggleChecklistItem(body, auth, env) {
  const d = body.data || body;
  if (!d.template_item_id) return err('template_item_id required', 400);
  if (!auth.employeeId) return err('no_employee', 400);
  const templateId = await templateIdOfItem(d.template_item_id, env);
  if (!templateId) return err('item_not_found', 404);
  if (!(await isAssignee(auth, templateId, env))) return err('forbidden', 403);
  const tmpl = await loadTemplate(templateId, env);
  if (!tmpl) return err('item_not_found', 404);
  const shared = tmpl.run_scope === 'shared';   // F8 C1: one chart per date, any assignee ticks
  const date = d.date || istDateStr();
  if (!isValidDate(date)) return err('invalid date', 400);
  const fut = futureDateErr(date); if (fut) return fut;
  const completed = d.completed === true || d.completed === 'true';
  if (completed && !isDueOn(tmpl.recurrence, date)) return err('not_due', 422);
  const itemQ = `template_item_id=eq.${enc(d.template_item_id)}&occurrence_date=eq.${date}`;
  if (completed) {
    if (!tmpl.is_active || tmpl.archived_at) return err('template_inactive', 422);
    const note = d.done_by_note != null ? (String(d.done_by_note).trim().slice(0, 120) || null) : null; // F8 C7
    const row = { template_item_id: d.template_item_id, employee_id: auth.employeeId, occurrence_date: date, completed_by_user_id: auth.userId, done_by_note: note };
    if (shared) {
      // One tick per (item, date), enforced by checklist_item_completions_shared_uq. A 409 means someone
      // else ticked it first — their tick stands.
      const r = await sbDocket(`/rest/v1/checklist_item_completions`, env, {
        method: 'POST', prefer: 'return=minimal', body: JSON.stringify({ ...row, shared: true }) });
      if (!r.ok && r.status !== 409) return err('complete_failed: ' + JSON.stringify(r.data), 400);
      return ok({ template_item_id: d.template_item_id, date, completed: true });
    }
    const r = await sbDocket(`/rest/v1/checklist_item_completions?on_conflict=template_item_id,employee_id,occurrence_date`, env, {
      method: 'POST', prefer: 'return=minimal,resolution=ignore-duplicates', body: JSON.stringify(row) });
    if (!r.ok) return err('complete_failed: ' + JSON.stringify(r.data), 400);
  } else {
    // Per-person: only your own. Shared: the person who ticked it, or the template's editor / an admin —
    // a tick is the record, so one assignee can't wipe another's (hostile review #5).
    if (shared && !(isAdmin(auth) || canEditTemplate(auth, tmpl))) {
      const ex = await sbDocket(`/rest/v1/checklist_item_completions?${itemQ}&select=completed_by_user_id`, env);
      const rows = ex.ok ? ex.data : [];
      if (rows.length && !rows.some(r => r.completed_by_user_id === auth.userId)) return err('not_your_tick', 403);
    }
    await sbDocket(`/rest/v1/checklist_item_completions?${itemQ}${shared ? '' : `&employee_id=eq.${enc(auth.employeeId)}`}`, env,
      { method: 'DELETE', prefer: 'return=minimal' });
  }
  return ok({ template_item_id: d.template_item_id, date, completed });
}
// Save (upsert) the caller's per-section comment for a date.
async function saveSectionComment(body, auth, env) {
  const d = body.data || body;
  if (!d.section_id) return err('section_id required', 400);
  if (!auth.employeeId) return err('no_employee', 400);
  const sr = await sbDocket(`/rest/v1/checklist_template_sections?id=eq.${enc(d.section_id)}&select=template_id&limit=1`, env);
  const templateId = sr.ok && sr.data?.[0]?.template_id;
  if (!templateId) return err('section_not_found', 404);
  if (!(await isAssignee(auth, templateId, env))) return err('forbidden', 403);
  const date = d.date || istDateStr();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return err('invalid date', 400);
  const r = await sbDocket(`/rest/v1/checklist_section_comments?on_conflict=section_id,employee_id,occurrence_date`, env, {
    method: 'POST', prefer: 'return=representation,resolution=merge-duplicates',
    body: JSON.stringify({ section_id: d.section_id, employee_id: auth.employeeId, occurrence_date: date, body: d.body || '', author_user_id: auth.userId, updated_at: nowIso() }) });
  if (!r.ok) return err('comment_failed: ' + JSON.stringify(r.data), 400);
  return ok({ section_id: d.section_id, date });
}

const PROTECTED = new Set(['id','task_no','created_at','created_by_user_id','deadline','status','action','data']);
const EDITABLE  = ['title','description','department_id','owner_employee_id','priority','program_id'];
async function updateTask(body, auth, env) {
  const d = body.data || body;
  if (!d.id) return err('id required', 400);
  if (d.program_id === '') d.program_id = null;   // '' clears, same as null
  const task = await loadTaskFor(d.id, auth, env);
  if (!task) return err('not_found', 404);
  if (!canEditTask(auth, task)) return err('forbidden', 403);
  // An abandoned task is read-only — except that a plan admin may CLEAR its plan link, so one stale
  // abandoned task can't block making a theme restricted forever (review R2 #5).
  const clearOnly = d.plan_item_id === null && Object.keys(d).every(k => k === 'id' || k === 'plan_item_id' || k === 'action');
  if (task.status === 'abandoned' && !(clearOnly && isPlanAdmin(auth))) return abandonedRO();

  const updates = {}; const changes = [];
  for (const f of EDITABLE) {
    if (d[f] !== undefined && d[f] !== task[f] && !PROTECTED.has(f)) {
      updates[f] = d[f]; changes.push([f, task[f], d[f]]);
    }
  }
  // A new owner on a task with no team gives it the owner's team (unless this request sets the team itself).
  if (updates.owner_employee_id && d.department_id === undefined && !task.department_id) {
    const dep = await employeeDept(updates.owner_employee_id, env);
    if (dep) { updates.department_id = dep; changes.push(['department_id', null, dep]); }
  }
  // First-time deadline set (task was quick-captured to The Grid with no deadline).
  // This becomes the immutable original — afterwards only reviseDeadline changes it. Validated first, then
  // written through the RPC (setDeadline) BEFORE the other fields, so a bad date fails the whole request.
  const deadlineSet = !!(d.deadline && !hasDeadline(task));
  if (deadlineSet && !isIsoTime(d.deadline)) return err('invalid deadline', 400);
  if (d.custom_fields !== undefined) updates.custom_fields = d.custom_fields;
  // F9 R2: the plan link — touched ONLY when the request names plan_item_id, so a teammate editing other
  // fields never disturbs a link (even one they see only at level L). null / '' clears (edit right alone);
  // setting needs the item at F / O / T and live (checkLinkTarget).
  let planChange = null;
  if (d.plan_item_id !== undefined) {
    const next = d.plan_item_id || null;
    if (next !== (task.plan_item_id || null)) {
      if (next && task.parent_task_id) return planErr('subtask_follows_parent');
      if (next) { const c = await checkLinkTarget(auth, next, TASK_SPACE.get(task), env); if (c.error) return c.error; }
      updates.plan_item_id = next; planChange = [task.plan_item_id || null, next];
    }
  }
  // F9 R8: the hand-off — same edit right as any field; validated against the task's department / owner AFTER
  // this write (moving the task can make an existing hand-off same-team).
  const hoBefore = { dept: task.handoff_to_department_id || null, emp: task.handoff_to_employee_id || null,
    own: task.department_id || null, owner: task.owner_employee_id || null };
  const after = (f) => (updates[f] !== undefined ? (updates[f] || null) : (task[f] || null));
  const ho = await resolveHandoff(d, hoBefore, { own: after('department_id'), owner: after('owner_employee_id') }, !!task.parent_task_id, env);
  if (ho.error) return ho.error;
  const hoHist = ho.fields ? handoffHistory(hoBefore, ho.fields) : null;
  if (hoHist) Object.assign(updates, ho.fields);
  if (!Object.keys(updates).length && !deadlineSet) return ok({ id: task.id, unchanged: true });
  if (deadlineSet) { const s = await setDeadline([task.id], d.deadline, null, auth, env); if (s.error) return s.error; }
  if (Object.keys(updates).length) {
    updates.updated_by = auth.userId; updates.updated_at = nowIso();
    const r = await sbDocket(`/rest/v1/tasks?id=eq.${enc(d.id)}`, env, { method: 'PATCH', body: JSON.stringify(updates) });
    if (!r.ok) return taskWriteErr(deadlineSet ? 'update_failed (the deadline was saved): ' : 'update_failed: ', r);
    for (const [f, oldV, newV] of changes) await logHistory(env, task.id, auth, `${f}_changed`, { field: f, old: oldV, new: newV });
  }
  if (planChange) await logHistory(env, task.id, auth, 'plan_item_id_changed', { field: 'plan_item_id', old: planChange[0], new: planChange[1] });
  if (hoHist) await logHistory(env, task.id, auth, ...hoHist);
  return ok({ id: task.id, updated: [...changes.map(c => c[0]), ...(deadlineSet ? ['deadline'] : []), ...(planChange ? ['plan_item_id'] : []),
    ...(hoHist ? ['handoff'] : [])] });
}

// ── F9 R8: accepting a hand-off (spec §4.6) ──────────────────────────────────
// POST { action: 'acceptHandoff', id } — the named receiver, or anyone in the receiving department. Loaded
// through loadTaskFor (the space gate — which a receiver passes in any space but the Founders' space, P3a), and
// nothing but `id` is read from the body. Not a hand-off → 400; caller not a receiver (the owner never is) → 403;
// done / abandoned / archived, or in an archived space → 409; already accepted → 200 no-op. With no named receiver the acceptor becomes it (the receiving
// side now has an owner), in the SAME write as the acceptance, so the 0027 reset trigger keeps it.
async function acceptHandoff(body, auth, env) {
  const d = body.data || body;
  if (!isUuid(String(d.id || ''))) return err('id required', 400);
  const task = await loadTaskFor(d.id, auth, env);
  if (!task) return err('not_found', 404);
  if (!task.handoff_to_department_id) return err('not_a_handoff', 400);
  if (!isHandoffReceiver(auth, task)) return err('not_receiver', 403);
  if (!handoffOpen(task) || TASK_SPACE.get(task)?.archived_at) return err('handoff_closed', 409);
  if (task.handoff_accepted_at) return ok({ unchanged: true });
  const now = nowIso();
  const patch = { handoff_accepted_at: now, handoff_accepted_by: auth.userId, updated_by: auth.userId, updated_at: now,
    ...(task.handoff_to_employee_id ? {} : { handoff_to_employee_id: auth.employeeId }) };
  // Conditional on "still open, not archived, not accepted, same receiver", so two receivers racing can't both
  // win and a task closed between the read and the write is never accepted.
  const recv = task.handoff_to_employee_id ? `handoff_to_employee_id=eq.${enc(task.handoff_to_employee_id)}` : 'handoff_to_employee_id=is.null';
  const r = await sbDocket(`/rest/v1/tasks?id=eq.${enc(task.id)}&${PW_OPEN}&archived_at=is.null&handoff_accepted_at=is.null&handoff_to_department_id=eq.${enc(task.handoff_to_department_id)}&${recv}`, env,
    { method: 'PATCH', body: JSON.stringify(patch) });
  if (!r.ok) return taskWriteErr('update_failed: ', r);
  if (!Array.isArray(r.data) || !r.data.length) {   // it changed under us: accepted by someone else → no-op; else closed / moved
    const now2 = await loadTask(task.id, env);
    return now2?.handoff_accepted_at ? ok({ unchanged: true }) : err('handoff_closed', 409);
  }
  const row = r.data[0];
  await logHistory(env, task.id, auth, 'handoff_accepted', { field: 'handoff', new: row.handoff_to_department_id, note: row.handoff_to_employee_id });
  TASK_SPACE.set(row, TASK_SPACE.get(task));
  const [hydrated] = await hydrateTasks([row], auth, env);
  return ok({ task: hydrated });
}

// GET ?action=getIncoming&scope=me|team|all (default all = me ∪ my team) — open hand-offs whose receiving side
// is the caller (named) or the caller's department, through the space gate (keepAccessible: a receiver is involved,
// so any space but the Founders' one, P3a; archived spaces out, as every list). Not-accepted first, then by effective deadline (no date last). Counts cover `all`.
const INCOMING_SCOPES = ['me', 'team', 'all'];
async function getIncoming(url, auth, env) {
  const scope = url.searchParams.get('scope') || 'all';
  if (!INCOMING_SCOPES.includes(scope)) return err('bad_scope', 400);
  const ors = [];
  if (auth.employeeId) ors.push(`handoff_to_employee_id.eq.${auth.employeeId}`);
  if (auth.departmentId) ors.push(`handoff_to_department_id.eq.${auth.departmentId}`);
  if (!ors.length) return ok({ tasks: [], counts: { me: 0, team: 0, unaccepted: 0 } });
  const [tr, ar] = await Promise.all([
    sbAll(sbDocket, `/rest/v1/tasks?handoff_to_department_id=not.is.null&archived_at=is.null&${PW_OPEN}&or=(${ors.join(',')})&select=*&order=id.asc`, env),
    sbAll(sbDocket, `/rest/v1/spaces?archived_at=not.is.null&select=id&order=id.asc`, env),
  ]);
  if (!tr.ok || !ar.ok) return err('db_error', 500);
  const archived = new Set((ar.data || []).map(x => x.id));
  const all = (await keepAccessible(auth, (tr.data || []).filter(t => !archived.has(t.space_id)), env)).filter(t => isHandoffReceiver(auth, t));
  const mine = (t) => !!auth.employeeId && t.handoff_to_employee_id === auth.employeeId;
  const ours = (t) => !!auth.departmentId && t.handoff_to_department_id === auth.departmentId;
  const counts = { me: all.filter(mine).length, team: all.filter(ours).length, unaccepted: all.filter(t => !t.handoff_accepted_at).length };
  const rows = all.filter(t => scope === 'all' || (scope === 'me' ? mine(t) : ours(t)));
  const eff = (t) => { const e = Date.parse(t.revised_deadline || t.deadline || ''); return Number.isFinite(e) ? e : Infinity; };
  rows.sort((a, b) => (!!a.handoff_accepted_at - !!b.handoff_accepted_at) || (eff(a) - eff(b))
    || String(a.task_no).localeCompare(String(b.task_no), undefined, { numeric: true }));
  const hydrated = await hydrateTasks(rows, auth, env);
  return ok({ tasks: hydrated.map(t => ({ ...t, giver_name: t.owner_name, giver_team_name: t.department_name })), counts });
}

const STATUSES = ['not_started','in_progress','done','blocked','abandoned'];
async function changeStatus(body, auth, env) {
  const d = body.data || body;
  if (!d.id || !d.status) return err('id and status required', 400);
  if (!STATUSES.includes(d.status)) return err('invalid status', 400);
  if (d.status === 'abandoned') return err('use abandonTask to abandon (reason required)', 422);
  const task = await loadTaskFor(d.id, auth, env);
  if (!task) return err('not_found', 404);
  if (!canEditTask(auth, task)) return err('forbidden', 403);
  if (task.status === d.status) return ok({ id: task.id, unchanged: true });
  // F7 dependency warning (ClickUp's): done while still waiting on an open task → 409 unless force.
  if (d.status === 'done' && !isForce(d.force)) {
    const open = (await rawLinks([task.id], env)).filter(l => l.direction === 'waiting_on' && isOpenStatus(l.other_status));
    if (open.length) {
      const cards = await taskCards(uniq(open.map(l => l.other_id)), auth, env);
      const vis = uniq(open.map(l => l.other_id)).map(i => cards[i]).filter(c => c && c.visible);
      return json({ ok: false, error: 'waiting_on',
        blockers: vis.map(c => ({ task_no: c.task_no, title: c.title, status: c.status })),
        hidden_open: uniq(open.map(l => l.other_id)).length - vis.length }, 409);
    }
  }

  const updates = { status: d.status, updated_by: auth.userId, updated_at: nowIso() };
  updates.completed_at = d.status === 'done' ? nowIso() : null;
  // Re-activating a previously abandoned task clears the abandon stamp (logged below).
  if (task.status === 'abandoned') { updates.abandoned_at = null; updates.abandoned_by = null; updates.abandon_reason = null; }
  const r = await sbDocket(`/rest/v1/tasks?id=eq.${enc(d.id)}`, env, { method: 'PATCH', body: JSON.stringify(updates) });
  if (!r.ok) return err('update_failed: ' + JSON.stringify(r.data), 400);
  await logHistory(env, task.id, auth, 'status_changed', { field: 'status', old: task.status, new: d.status, note: d.note || null });
  // Only a task that was OPEN can unblock anything — done→abandoned or back would log twice (review #3).
  if (d.status === 'done' && isOpenStatus(task.status)) await logUnblocked([task.id], auth, env);
  return ok({ id: task.id, status: d.status });
}

async function reviseDeadline(body, auth, env) {
  const d = body.data || body;
  if (!d.id || !d.new_deadline) return err('id and new_deadline required', 400);
  if (!d.reason || !String(d.reason).trim()) return err('reason required', 400);
  if (!isIsoTime(d.new_deadline)) return err('invalid deadline', 400);
  const task = await loadTaskFor(d.id, auth, env);
  if (!task) return err('not_found', 404);
  if (!canEditTask(auth, task)) return err('forbidden', 403);
  if (task.status === 'abandoned') return abandonedRO();
  // One RPC: the task and its history row together (F9 R5). An undated task gets its first deadline.
  const s = await setDeadline([task.id], d.new_deadline, d.reason, auth, env);
  if (s.error) return s.error;
  if (s.first.length) return ok({ id: task.id, deadline: d.new_deadline });
  return ok({ id: task.id, revised_deadline: d.new_deadline, ...(s.revised.length ? {} : { unchanged: true }) });
}

// Bulk update N tasks with one action. Subrequest-safe (load + ≤2 patch + 1 history
// insert, regardless of N — no per-row await loop). Only tasks the caller canEditTask
// (and not already abandoned) are touched; the rest are skipped + counted.
const BULK_FIELDS = new Set(['owner_employee_id', 'priority', 'program_id', 'status', 'deadline']);
async function bulkUpdateTasks(body, auth, env) {
  const d = body.data || body;
  const ids = Array.isArray(d.ids) ? uniq(d.ids) : [];
  const field = d.field;
  if (!ids.length) return err('ids required', 400);
  if (!BULK_FIELDS.has(field)) return err('invalid field', 400);

  const tr = await sbDocket(`/rest/v1/tasks?id=in.${inList(ids)}&select=*`, env);
  if (!tr.ok) return err('db_error: ' + JSON.stringify(tr.data), 500);
  const all = await keepAccessible(auth, tr.data || [], env);   // private spaces: members, or involved (P3a)
  const editable = all.filter(t => canEditTask(auth, t) && t.status !== 'abandoned');
  const skipped = ids.length - editable.length;
  if (!editable.length) return ok({ updated: 0, skipped, field });

  const stamp = { updated_by: auth.userId, updated_at: nowIso() };

  if (field === 'status') {
    const value = d.value;
    if (!STATUSES.includes(value)) return err('invalid status', 400);
    if (value === 'abandoned') return err('use abandonTask to abandon (reason required)', 422);
    const targets = editable.filter(t => t.status !== value);
    if (!targets.length) return ok({ updated: 0, skipped, field });
    // F7: a blocker that is ALSO in this batch doesn't count — it's being closed in the same action.
    if (value === 'done' && !isForce(d.force)) {
      const inBatch = new Set(targets.map(t => t.id));
      const waiting = uniq((await rawLinks([...inBatch], env))
        .filter(l => l.direction === 'waiting_on' && isOpenStatus(l.other_status) && !inBatch.has(l.other_id))
        .map(l => l.task_id));
      if (waiting.length) return json({ ok: false, error: 'waiting_on', waiting_count: waiting.length, waiting_ids: waiting }, 409);
    }
    const r = await sbDocket(`/rest/v1/tasks?id=in.${inList(targets.map(t => t.id))}`, env, {
      method: 'PATCH', prefer: 'return=minimal',
      body: JSON.stringify({ ...stamp, status: value, completed_at: value === 'done' ? nowIso() : null }),
    });
    if (!r.ok) return err('update_failed: ' + JSON.stringify(r.data), 400);
    await logHistoryBatch(env, auth, targets.map(t => ({ task_id: t.id, event_type: 'status_changed', field: 'status', old: t.status, new: value })));
    if (value === 'done') await logUnblocked(targets.filter(t => isOpenStatus(t.status)).map(t => t.id), auth, env);
    return ok({ updated: targets.length, skipped, field });
  }

  if (field === 'deadline') {
    const value = d.value; // ISO datetime
    if (!value) return err('value required', 400);
    if (!isIsoTime(value)) return err('invalid deadline', 400);
    const revise = editable.filter(hasDeadline);
    if (revise.length && (!d.reason || !String(d.reason).trim())) return err('reason required (some tasks already have a deadline)', 400);
    // One RPC for the whole batch: first sets + revisions + every history row, all or nothing (F9 R5).
    const s = await setDeadline(editable.map(t => t.id), value, revise.length ? String(d.reason).trim() : null, auth, env);
    if (s.error) return s.error;
    return ok({ updated: s.first.length + s.revised.length, skipped, field });
  }

  // Plain settable fields: owner_employee_id / priority / program_id.
  let value = d.value;
  if (field === 'owner_employee_id' || field === 'program_id') value = value || null;
  if (field === 'priority' && !['P0', 'P1', 'P2', 'P3'].includes(value)) return err('invalid priority', 400);
  if (field === 'owner_employee_id' && value && !isUuid(String(value))) return err('invalid owner', 400);
  let targets = editable.filter(t => (t[field] || null) !== (value || null));
  // F9 R8: a new owner can make a hand-off same-team — the named receiver can't own it, and a task with no
  // department gives from its OWNER's team (resolveHandoff's check on a single edit). Those rows are skipped.
  let sameTeam = 0;
  if (field === 'owner_employee_id' && value && targets.some(t => t.handoff_to_department_id)) {
    let ownerDept = null;
    if (targets.some(t => t.handoff_to_department_id && !t.department_id)) {
      const er = await sbPodium(`/rest/v1/employees?id=eq.${enc(value)}&select=department_id&limit=1`, env);
      if (!er.ok) return err('db_error', 500);
      ownerDept = lcId(er.data?.[0]?.department_id);
    }
    const clash = (t) => !!t.handoff_to_department_id && (lcId(t.handoff_to_employee_id) === lcId(value)
      || (!t.department_id && !!ownerDept && ownerDept === lcId(t.handoff_to_department_id)));
    sameTeam = targets.filter(clash).length;
    targets = targets.filter(t => !clash(t));
  }
  const out = (n) => ok({ updated: n, skipped: skipped + sameTeam, field, ...(sameTeam ? { handoff_same_team: sameTeam } : {}) });
  if (!targets.length) return out(0);
  // A new owner gives the tasks that have no team the owner's team (same default as a single edit).
  const noTeam = field === 'owner_employee_id' && value ? targets.filter(t => !t.department_id) : [];
  const teamDept = noTeam.length ? await employeeDept(value, env) : null;
  const filled = teamDept ? noTeam : [];
  const batches = [[filled, { ...stamp, [field]: value, department_id: teamDept }], [targets.filter(t => !filled.includes(t)), { ...stamp, [field]: value }]];
  // Each batch's history is written as soon as that batch lands, so a later failure never leaves written rows
  // without their history; the error then says how many were already updated.
  let done = 0;
  for (const [rows, patch] of batches) {
    if (!rows.length) continue;
    const r = await sbDocket(`/rest/v1/tasks?id=in.${inList(rows.map(t => t.id))}`, env, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(patch) });
    if (!r.ok) return json({ ok: false, error: 'update_failed: ' + JSON.stringify(r.data), updated: done }, 400);
    await logHistoryBatch(env, auth, [...rows.map(t => ({ task_id: t.id, event_type: `${field}_changed`, field, old: t[field], new: value })),
      ...(patch.department_id ? rows.map(t => ({ task_id: t.id, event_type: 'department_id_changed', field: 'department_id', old: null, new: teamDept })) : [])]);
    done += rows.length;
  }
  return out(done);
}

// ── S153 bulk follow-ups ──────────────────────────────────────────────────────
// All three below share bulkUpdateTasks' contract: load once, act set-based, skip what the
// caller cannot edit and COUNT the skips (never fail the whole batch for one bad row), and
// write history via logHistoryBatch. No per-row await loop.
//
// They are separate handlers rather than new BULK_FIELDS entries because none of them is a
// plain column write:
//   · collaborators live in a child table;
//   · a space move has to check space access AND carry sub-tasks;
//   · abandoning requires a reason, which bulkUpdateTasks explicitly refuses to fake.

// Add or remove ONE collaborator across N tasks.
async function bulkSetCollaborator(body, auth, env) {
  const d = body.data || body;
  const ids = Array.isArray(d.ids) ? uniq(d.ids) : [];
  const employeeId = d.employee_id;
  const mode = d.mode === 'remove' ? 'remove' : 'add';
  if (!ids.length) return err('ids required', 400);
  if (!employeeId) return err('employee_id required', 400);

  const tr = await sbDocket(`/rest/v1/tasks?id=in.${inList(ids)}&select=*`, env);
  if (!tr.ok) return err('db_error: ' + JSON.stringify(tr.data), 500);
  const all = await keepAccessible(auth, tr.data || [], env);   // private spaces: members, or involved (P3a)
  const editable = all.filter(t => canEditTask(auth, t) && t.status !== 'abandoned');
  const skipped = ids.length - editable.length;
  if (!editable.length) return ok({ updated: 0, skipped, mode });
  const targetIds = editable.map(t => t.id);

  // Read who is already on these tasks FIRST, so history records only real changes. One
  // extra subrequest, and worth it: writing 'collaborator_removed' for a task the person was
  // never on puts a false event in the audit trail, and `updated` would overstate the work.
  const exR = await sbDocket(
    `/rest/v1/task_collaborators?task_id=in.${inList(targetIds)}&employee_id=eq.${enc(employeeId)}&select=task_id`, env);
  const already = new Set((exR.ok ? exR.data : []).map(c => c.task_id));
  const changing = mode === 'add' ? targetIds.filter(id => !already.has(id))
                                  : targetIds.filter(id =>  already.has(id));
  if (!changing.length) return ok({ updated: 0, skipped, mode, employee_id: employeeId, no_change: targetIds.length });

  if (mode === 'add') {
    // ignore-duplicates anyway: `already` can be stale under a concurrent add, and a 409
    // here would sink the whole batch (same idempotency as single-task addCollaborator).
    const rows = changing.map(id => ({ task_id: id, employee_id: employeeId, added_by: auth.userId }));
    const r = await sbDocket(`/rest/v1/task_collaborators?on_conflict=task_id,employee_id`, env, {
      method: 'POST', prefer: 'return=minimal,resolution=ignore-duplicates', body: JSON.stringify(rows),
    });
    if (!r.ok) return err('add_failed: ' + JSON.stringify(r.data), 400);
  } else {
    const r = await sbDocket(
      `/rest/v1/task_collaborators?task_id=in.${inList(changing)}&employee_id=eq.${enc(employeeId)}`, env,
      { method: 'DELETE', prefer: 'return=minimal' });
    if (!r.ok) return err('remove_failed: ' + JSON.stringify(r.data), 400);
  }
  await logHistoryBatch(env, auth, changing.map(id => ({
    task_id: id,
    event_type: mode === 'add' ? 'collaborator_added' : 'collaborator_removed',
    field: 'collaborator', [mode === 'add' ? 'new' : 'old']: employeeId,
  })));
  return ok({ updated: changing.length, skipped, mode, employee_id: employeeId,
              no_change: targetIds.length - changing.length });
}

// Move N tasks into one space. Mirrors moveTask's two non-obvious behaviours rather than
// PATCHing space_id directly: the destination is access-checked ONCE, and sub-tasks travel
// with their parents — a bulk write that skipped either would strand children in the old
// space and could push a task into a space the mover cannot see.
async function bulkMoveTasks(body, auth, env) {
  const d = body.data || body;
  const ids = Array.isArray(d.ids) ? uniq(d.ids) : [];
  if (!ids.length) return err('ids required', 400);
  if (!d.space_id) return err('space_id required', 400);
  const target = await loadSpace(d.space_id, env);
  if (!target) return err('space_not_found', 404);
  if (!(await canWriteSpace(auth, target, env))) return err('forbidden_space', 403);

  const tr = await sbDocket(`/rest/v1/tasks?id=in.${inList(ids)}&select=*`, env);
  if (!tr.ok) return err('db_error: ' + JSON.stringify(tr.data), 500);
  // Private spaces: members only — an involvement-only row (P3a) is skipped: it never leaves a space you can't access.
  const all = (await keepAccessible(auth, tr.data || [], env)).filter(t => !INVOLVED_ONLY.has(t));
  const editable = all.filter(t => canEditTask(auth, t) && t.status !== 'abandoned');
  // Sub-tasks never move alone (they follow their parent): one whose parent isn't in this batch is skipped.
  const movable = editable.filter(t => !t.parent_task_id);
  const movableIds = new Set(movable.map(t => t.id));
  const orphanSubs = editable.filter(t => t.parent_task_id && !movableIds.has(t.parent_task_id)).length;
  let skipped = ids.length - editable.length + orphanSubs;
  const moving = movable.filter(t => t.space_id !== d.space_id);
  // F8 P2: tasks tied to a record checklist in another space (themselves or a sub-task) are skipped and named.
  const rb = await recordMoveBlocks(moving.map(t => t.id), d.space_id, env);
  if (rb.error) return rb.error;
  const record_link_space = moving.filter(t => rb.blocked.has(t.id)).map(t => t.task_no);
  // P2: into a personal space only what is just yours (task + sub-tasks); the rest are skipped and named.
  const pb = target.is_personal ? await personalMoveBlocks(auth, moving.filter(t => !rb.blocked.has(t.id)).map(t => t.id), env) : new Set();
  const personal_space = moving.filter(t => !rb.blocked.has(t.id) && pb.has(t.id)).map(t => t.task_no);
  const targets = moving.filter(t => !rb.blocked.has(t.id) && !pb.has(t.id));
  skipped += record_link_space.length + personal_space.length;
  if (!targets.length) return ok({ updated: 0, skipped, space_id: d.space_id, record_link_space, ...(personal_space.length ? { personal_space } : {}) });
  // A4: leaving the Founders' space needs a plan admin (spaceOf: keepAccessible read these spaces).
  if (!isPlanAdmin(auth) && targets.some(t => spaceOf(auth, t)?.is_founders)) return err('founders_move_out', 403);
  const targetIds = targets.map(t => t.id);

  // Sub-tasks first (one level, one statement for the batch), checked; then the parents in one
  // statement. If the R2 trigger refuses either, nothing is left half-moved (review R2 #10).
  const kids = await sbDocket(`/rest/v1/tasks?parent_task_id=in.${inList(targetIds)}`, env, {
    method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ space_id: d.space_id }) });
  if (!kids.ok) return taskWriteErr('update_failed: ', kids);
  const r = await sbDocket(`/rest/v1/tasks?id=in.${inList(targetIds)}`, env, {
    method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({ space_id: d.space_id, updated_by: auth.userId, updated_at: nowIso() }) });
  if (!r.ok) {
    for (const sid of uniq(targets.map(t => t.space_id))) {
      const ps = targets.filter(t => t.space_id === sid).map(t => t.id);
      await sbDocket(`/rest/v1/tasks?parent_task_id=in.${inList(ps)}`, env, {
        method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ space_id: sid }) });
    }
    return taskWriteErr('update_failed: ', r);
  }
  await logHistoryBatch(env, auth, targets.map(t => ({
    task_id: t.id, event_type: 'space_changed', field: 'space_id', old: t.space_id, new: d.space_id })));
  return ok({ updated: targets.length, skipped, space_id: d.space_id, record_link_space, ...(personal_space.length ? { personal_space } : {}) });
}

// Abandon N tasks with ONE reason.
//
// The backlog phrased this "reason-per-task". Read literally — a different reason typed for
// each task — it defeats the point of a bulk action, so this takes one reason and RECORDS it
// on every task (abandon_reason + a history row each), which is the useful reading and what
// abandonTask already does per task. If genuinely distinct reasons are ever wanted, that is
// N single abandonTask calls, not this.
async function bulkAbandonTasks(body, auth, env) {
  const d = body.data || body;
  const ids = Array.isArray(d.ids) ? uniq(d.ids) : [];
  const reason = String(d.reason || '').trim();
  if (!ids.length) return err('ids required', 400);
  // Same hard requirement as abandonTask — abandoning is terminal, so it never happens
  // unexplained, and bulk is exactly where an unexplained mass-abandon would hurt most.
  if (!reason) return err('reason required', 400);

  const tr = await sbDocket(`/rest/v1/tasks?id=in.${inList(ids)}&select=*`, env);
  if (!tr.ok) return err('db_error: ' + JSON.stringify(tr.data), 500);
  const all = await keepAccessible(auth, tr.data || [], env);   // private spaces: members, or involved (P3a)
  const targets = all.filter(t => canEditTask(auth, t) && t.status !== 'abandoned');
  const skipped = ids.length - targets.length;
  if (!targets.length) return ok({ updated: 0, skipped });
  const targetIds = targets.map(t => t.id);

  const r = await sbDocket(`/rest/v1/tasks?id=in.${inList(targetIds)}`, env, {
    method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({
      status: 'abandoned', abandoned_at: nowIso(), abandoned_by: auth.userId,
      abandon_reason: reason, updated_by: auth.userId, updated_at: nowIso(),
    }) });
  if (!r.ok) return err('update_failed: ' + JSON.stringify(r.data), 400);
  await logHistoryBatch(env, auth, targets.map(t => ({
    task_id: t.id, event_type: 'abandoned', field: 'status', old: t.status, new: 'abandoned', note: reason })));
  await logUnblocked(targets.filter(t => isOpenStatus(t.status)).map(t => t.id), auth, env);
  return ok({ updated: targets.length, skipped });
}

async function abandonTask(body, auth, env) {
  const d = body.data || body;
  if (!d.id) return err('id required', 400);
  if (!d.reason || !String(d.reason).trim()) return err('reason required', 400);
  const task = await loadTaskFor(d.id, auth, env);
  if (!task) return err('not_found', 404);
  if (!canEditTask(auth, task)) return err('forbidden', 403);
  if (task.status === 'abandoned') return abandonedRO();
  const r = await sbDocket(`/rest/v1/tasks?id=eq.${enc(d.id)}`, env, {
    method: 'PATCH', body: JSON.stringify({
      status: 'abandoned', abandoned_at: nowIso(), abandoned_by: auth.userId,
      abandon_reason: d.reason, updated_by: auth.userId, updated_at: nowIso(),
    }),
  });
  if (!r.ok) return err('update_failed: ' + JSON.stringify(r.data), 400);
  await logHistory(env, task.id, auth, 'abandoned', { field: 'status', old: task.status, new: 'abandoned', note: d.reason });
  if (isOpenStatus(task.status)) await logUnblocked([task.id], auth, env);
  return ok({ id: task.id, status: 'abandoned' });
}

async function setParent(body, auth, env) {
  const d = body.data || body;
  if (!d.id) return err('id required', 400);
  const task = await loadTaskFor(d.id, auth, env);
  if (!task) return err('not_found', 404);
  if (!canEditTask(auth, task)) return err('forbidden', 403);
  if (task.status === 'abandoned') return abandonedRO();
  const newParent = d.parent_task_id || null;
  if (newParent) {
    if (newParent === task.id) return err('a task cannot be its own parent', 422);
    const parent = await loadTaskFor(newParent, auth, env);
    if (!parent || !(await seesTask(auth, parent, env))) return err('parent_not_found', 404);
    // A sub-task lives in its parent's space (createTaskCore, moveTask) — never across a space wall,
    // or getTask's parent hydration would read a private parent's title to a non-member.
    if (parent.space_id !== task.space_id) return err('parent_in_another_space: move the task into that space first', 422);
    if (parent.parent_task_id) return err('one_level_only: parent is already a sub-task', 422);
    if (parent.status === 'abandoned') return abandonedRO();
    const kids = await sbDocket(`/rest/v1/tasks?parent_task_id=eq.${enc(task.id)}&select=id&limit=1`, env);
    if (kids.ok && kids.data?.length) return err('one_level_only: this task already has sub-tasks', 422);
    if (task.handoff_to_department_id) return err('handoff_top_level', 400);   // R8: clear the hand-off first
  }
  // F9 R2: a sub-task carries no link of its own (it follows its parent) — clear it in the same write.
  const clearsLink = !!(newParent && task.plan_item_id);
  const r = await sbDocket(`/rest/v1/tasks?id=eq.${enc(d.id)}`, env, {
    method: 'PATCH', body: JSON.stringify({ parent_task_id: newParent, ...(clearsLink ? { plan_item_id: null } : {}), updated_by: auth.userId, updated_at: nowIso() }),
  });
  if (!r.ok) return taskWriteErr('update_failed: ', r);
  await logHistory(env, task.id, auth, 'parent_changed', { field: 'parent_task_id', old: task.parent_task_id, new: newParent });
  if (clearsLink) await logHistory(env, task.id, auth, 'plan_item_id_changed',
    { field: 'plan_item_id', old: task.plan_item_id, note: 'cleared: a sub-task follows its parent’s plan link' });
  return ok({ id: task.id, parent_task_id: newParent, ...(clearsLink ? { plan_item_id: null } : {}) });
}

// Move a task (and its sub-tasks) to another space. RULE-DOCKET-003.
async function moveTask(body, auth, env) {
  const d = body.data || body;
  if (!d.id || !d.space_id) return err('id and space_id required', 400);
  const task = await loadTaskFor(d.id, auth, env);
  if (!task) return err('not_found', 404);
  if (!canEditTask(auth, task)) return err('forbidden', 403);
  if (task.status === 'abandoned') return abandonedRO();
  // P3a: a task open through involvement alone never leaves (or re-enters) a space the mover can't access.
  if (INVOLVED_ONLY.has(task)) return err('forbidden_space', 403);
  const target = await loadSpace(d.space_id, env);
  if (!target) return err('space_not_found', 404);
  if (!(await canWriteSpace(auth, target, env))) return err('forbidden_space', 403);
  if (task.space_id === d.space_id) return ok({ id: task.id, unchanged: true });
  // A sub-task lives in its parent's space; moving one alone would put parent and child on two sides of
  // a space wall, and getTask's parent/children hydration would then read titles across it.
  if (task.parent_task_id) return err('subtask_moves_with_parent: move its parent task instead', 422);
  // A4: a task leaves the Founders' space only with a plan admin (it stays founders-only, linked or not).
  if (TASK_SPACE.get(task)?.is_founders && !isPlanAdmin(auth)) return err('founders_move_out', 403);
  // P2: only work that is just yours goes into your personal space (it would vanish for everyone else).
  if (target.is_personal && (await personalMoveBlocks(auth, [task.id], env)).size) return err('personal_space_not_yours', 422);
  // F8 P2: a task (or a sub-task moving with it) tied to a record checklist moves only where the link rule holds.
  const rb = await recordMoveBlocks([task.id], d.space_id, env);
  if (rb.error) return rb.error;
  if (rb.blocked.size) return err(RECORD_LINK_SPACE, 422);
  // The R2 trigger refuses a move that would take a restricted-linked task out of the Founders' space.
  // Sub-tasks first (one level), checked: if the trigger refuses them nothing has moved; if the parent
  // is then refused, they go back. A parent never lands in a space without its children (review R2 #10).
  const kids = await sbDocket(`/rest/v1/tasks?parent_task_id=eq.${enc(d.id)}`, env, { method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({ space_id: d.space_id }) });
  if (!kids.ok) return taskWriteErr('update_failed: ', kids);
  const mv = await sbDocket(`/rest/v1/tasks?id=eq.${enc(d.id)}`, env, { method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({ space_id: d.space_id, updated_by: auth.userId, updated_at: nowIso() }) });
  if (!mv.ok) {
    await sbDocket(`/rest/v1/tasks?parent_task_id=eq.${enc(d.id)}`, env, { method: 'PATCH', prefer: 'return=minimal',
      body: JSON.stringify({ space_id: task.space_id }) });
    return taskWriteErr('update_failed: ', mv);
  }
  await logHistory(env, task.id, auth, 'space_changed', { field: 'space_id', old: task.space_id, new: d.space_id });
  return ok({ id: task.id, space_id: d.space_id });
}

async function addCollaborator(body, auth, env) {
  const d = body.data || body;
  if (!d.id || !d.employee_id) return err('id and employee_id required', 400);
  const task = await loadTaskFor(d.id, auth, env);
  if (!task) return err('not_found', 404);
  if (!canEditTask(auth, task)) return err('forbidden', 403);
  if (task.status === 'abandoned') return abandonedRO();
  const r = await sbDocket(`/rest/v1/task_collaborators?on_conflict=task_id,employee_id`, env, {
    method: 'POST', prefer: 'return=minimal,resolution=ignore-duplicates',
    body: JSON.stringify({ task_id: d.id, employee_id: d.employee_id, added_by: auth.userId }),
  });
  if (!r.ok) return err('add_failed: ' + JSON.stringify(r.data), 400);
  await logHistory(env, task.id, auth, 'collaborator_added', { field: 'collaborator', new: d.employee_id });
  return ok({ id: task.id, employee_id: d.employee_id });
}
async function removeCollaborator(body, auth, env) {
  const d = body.data || body;
  if (!d.id || !d.employee_id) return err('id and employee_id required', 400);
  const task = await loadTaskFor(d.id, auth, env);
  if (!task) return err('not_found', 404);
  if (!canEditTask(auth, task)) return err('forbidden', 403);
  if (task.status === 'abandoned') return abandonedRO();
  await sbDocket(`/rest/v1/task_collaborators?task_id=eq.${enc(d.id)}&employee_id=eq.${enc(d.employee_id)}`, env,
    { method: 'DELETE', prefer: 'return=minimal' });
  await logHistory(env, task.id, auth, 'collaborator_removed', { field: 'collaborator', old: d.employee_id });
  return ok({ id: task.id, removed: d.employee_id });
}

async function addDocument(body, auth, env) {
  const d = body.data || body;
  if (!d.id || !d.url) return err('id and url required', 400);
  if (!isHttpUrl(d.url)) return err('url must start with http:// or https://', 400);
  const task = await loadTaskFor(d.id, auth, env);
  if (!task) return err('not_found', 404);
  if (!(await seesTask(auth, task, env))) return err('forbidden', 403);
  if (task.status === 'abandoned') return abandonedRO();
  const r = await sbDocket(`/rest/v1/task_documents`, env, {
    method: 'POST',
    body: JSON.stringify([{ task_id: d.id, title: d.title || null, url: d.url.trim(), added_by: auth.userId }]),
  });
  if (!r.ok || !r.data?.[0]) return err('add_failed: ' + JSON.stringify(r.data), 400);
  await logHistory(env, task.id, auth, 'document_added', { field: 'document', new: d.title || d.url });
  return ok(r.data[0]);
}
async function removeDocument(body, auth, env) {
  const d = body.data || body;
  if (!d.document_id) return err('document_id required', 400);
  const docRes = await sbDocket(`/rest/v1/task_documents?id=eq.${enc(d.document_id)}&select=*&limit=1`, env);
  const doc = docRes.ok && docRes.data?.[0];
  if (!doc) return err('not_found', 404);
  const task = await loadTaskFor(doc.task_id, auth, env);
  if (!task) return err('not_found', 404);
  if (!canEditTask(auth, task) && doc.added_by !== auth.userId) return err('forbidden', 403);
  if (task.status === 'abandoned') return abandonedRO();
  await sbDocket(`/rest/v1/task_documents?id=eq.${enc(d.document_id)}`, env, { method: 'DELETE', prefer: 'return=minimal' });
  await logHistory(env, task.id, auth, 'document_removed', { field: 'document', old: doc.title || doc.url });
  return ok({ removed: d.document_id });
}

async function addComment(body, auth, env) {
  const d = body.data || body;
  if (!d.id || !d.body || !String(d.body).trim()) return err('id and body required', 400);
  const task = await loadTaskFor(d.id, auth, env);
  if (!task) return err('not_found', 404);
  if (!(await seesTask(auth, task, env))) return err('forbidden', 403);
  if (task.status === 'abandoned') return abandonedRO();
  const r = await sbDocket(`/rest/v1/task_comments`, env, {
    method: 'POST', body: JSON.stringify([{ task_id: d.id, author_user_id: auth.userId, body: String(d.body).trim() }]),
  });
  if (!r.ok || !r.data?.[0]) return err('comment_failed: ' + JSON.stringify(r.data), 400);
  return ok(r.data[0]);
}
async function editComment(body, auth, env) {
  const d = body.data || body;
  if (!d.comment_id || d.body === undefined) return err('comment_id and body required', 400);
  const cRes = await sbDocket(`/rest/v1/task_comments?id=eq.${enc(d.comment_id)}&select=*&limit=1`, env);
  const c = cRes.ok && cRes.data?.[0];
  if (!c) return err('not_found', 404);
  if (c.author_user_id !== auth.userId && !isAdmin(auth)) return err('forbidden', 403);
  const ct = await loadTaskFor(c.task_id, auth, env);
  if (!ct) return err('not_found', 404);   // a task in a private space the caller isn't in
  // P3a: the admin override needs real rights in the task's space, not a plan admin's see-only team-space access
  if (c.author_user_id !== auth.userId && !(await adminActsIn(auth, TASK_SPACE.get(ct), env))) return err('forbidden', 403);
  if (ct.status === 'abandoned') return abandonedRO();
  const r = await sbDocket(`/rest/v1/task_comments?id=eq.${enc(d.comment_id)}`, env, {
    method: 'PATCH', body: JSON.stringify({ body: String(d.body).trim(), edited_at: nowIso() }),
  });
  if (!r.ok) return err('edit_failed', 400);
  return ok({ id: d.comment_id });
}
async function deleteComment(body, auth, env) {
  const d = body.data || body;
  if (!d.comment_id) return err('comment_id required', 400);
  const cRes = await sbDocket(`/rest/v1/task_comments?id=eq.${enc(d.comment_id)}&select=*&limit=1`, env);
  const c = cRes.ok && cRes.data?.[0];
  if (!c) return err('not_found', 404);
  if (c.author_user_id !== auth.userId && !isAdmin(auth)) return err('forbidden', 403);
  // Admins may still remove a comment on an abandoned task (no reactivate/re-abandon dance).
  const ct = await loadTaskFor(c.task_id, auth, env);
  if (!ct) return err('not_found', 404);   // a task in a private space the caller isn't in
  // P3a: the admin override needs real rights in the task's space, not a plan admin's see-only team-space access
  const adminHere = await adminActsIn(auth, TASK_SPACE.get(ct), env);
  if (c.author_user_id !== auth.userId && !adminHere) return err('forbidden', 403);
  if (ct.status === 'abandoned' && !adminHere) return abandonedRO();
  await sbDocket(`/rest/v1/task_comments?id=eq.${enc(d.comment_id)}`, env, {
    method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ deleted_at: nowIso() }),
  });
  return ok({ deleted: d.comment_id });
}

// ── Permission layer (admin) — mirrors Podium ───────────────────────────────
// Spec §5.1 A5: a role carrying docket_plan_admin is created, edited, deleted or assigned only by a
// super admin, and only a super admin can change the role of someone who holds one.
// R6c: a role carrying docket_review (the Founders' Associates, level R) is guarded the same way — it reads
// the whole unrestricted register, so granting it is a founders' decision.
const SUPER_ADMIN_ONLY = () => err('forbidden_super_admin', 403);
const guardedPerms = (p) => { const n = normalizeDocketPerms(p); return !!(n.docket_plan_admin || n.docket_review); };
async function roleIsGuarded(roleKey, env) {
  if (!roleKey) return false;
  const r = await sbStore(`/rest/v1/docket_roles?role_key=eq.${enc(roleKey)}&select=permissions&limit=1`, env);
  if (!r.ok) return true; // fail CLOSED: can't prove it isn't guarded → treat as guarded (guard blocks)
  return guardedPerms(r.data?.[0]?.permissions);
}
async function userHoldsGuardedRole(userId, env) {
  const r = await sbStore(`/rest/v1/docket_user_roles?user_id=eq.${enc(userId)}&select=role_key&limit=1`, env);
  if (!r.ok) return true; // fail CLOSED
  return roleIsGuarded(r.data?.[0]?.role_key, env);
}
async function createDocketRole(body, auth, env) {
  const gate = requireAdmin(auth); if (gate) return gate;
  const d = body.data || body;
  if (!d.role_key || !d.label) return err('role_key and label required', 400);
  if (guardedPerms(d.permissions) && !isPlanAdmin(auth)) return SUPER_ADMIN_ONLY();
  const key = String(d.role_key).trim().toLowerCase().replace(/\s+/g, '_');
  const r = await sbStore(`/rest/v1/docket_roles`, env, {
    method: 'POST',
    body: JSON.stringify([{ role_key: key, label: d.label, description: d.description || null,
      permissions: normalizeDocketPerms(d.permissions), is_system: false }]),
  });
  if (!r.ok) return err('create_failed: ' + JSON.stringify(r.data), 400);
  return ok({ role_key: key });
}
async function updateDocketRole(body, auth, env) {
  const gate = requireAdmin(auth); if (gate) return gate;
  const d = body.data || body;
  if (!d.role_key) return err('role_key required', 400);
  const cur = await sbStore(`/rest/v1/docket_roles?role_key=eq.${enc(d.role_key)}&select=is_system,permissions&limit=1`, env);
  if (!cur.ok) return err('db_error', 503); // fail closed: never PATCH a role we couldn't read
  const isSys = !!(cur.ok && cur.data?.[0]?.is_system);
  const carries = guardedPerms(cur.ok && cur.data?.[0]?.permissions);
  const adds = d.permissions !== undefined && guardedPerms(d.permissions);
  if ((carries || adds) && !isPlanAdmin(auth)) return SUPER_ADMIN_ONLY();
  const updates = { updated_at: nowIso() };
  if (d.label !== undefined)       updates.label = d.label;
  if (d.description !== undefined) updates.description = d.description;
  if (d.permissions !== undefined && !isSys) updates.permissions = normalizeDocketPerms(d.permissions);
  const r = await sbStore(`/rest/v1/docket_roles?role_key=eq.${enc(d.role_key)}`, env, { method: 'PATCH', body: JSON.stringify(updates) });
  if (!r.ok) return err('update_failed: ' + JSON.stringify(r.data), 400);
  return ok({ updated: d.role_key });
}
async function deleteDocketRole(body, auth, env) {
  const gate = requireAdmin(auth); if (gate) return gate;
  const d = body.data || body;
  if (!d.role_key) return err('role_key required', 400);
  const chk = await sbStore(`/rest/v1/docket_roles?role_key=eq.${enc(d.role_key)}&select=is_system&limit=1`, env);
  if (!chk.ok) return err('db_error', 503); // fail closed
  if (chk.data?.[0]?.is_system) return err('cannot delete a system role', 400);
  if (!isPlanAdmin(auth) && await roleIsGuarded(d.role_key, env)) return SUPER_ADMIN_ONLY();
  const assigned = await sbStore(`/rest/v1/docket_user_roles?role_key=eq.${enc(d.role_key)}&limit=1`, env);
  if (assigned.ok && assigned.data?.length) return err('cannot delete a role with assigned users', 400);
  const r = await sbStore(`/rest/v1/docket_roles?role_key=eq.${enc(d.role_key)}`, env, { method: 'DELETE', prefer: 'return=minimal' });
  if (!r.ok) return err('delete_failed', 400);
  return ok({ deleted: d.role_key });
}
async function assignDocketRole(body, auth, env) {
  const gate = requireAdmin(auth); if (gate) return gate;
  const d = body.data || body;
  if (!d.user_id) return err('user_id required', 400);
  // Granting a guarded role (super admin / Founders' Associate), or changing/removing one: super admins only.
  if (!isPlanAdmin(auth)) {
    const [grants, demotes] = await Promise.all([roleIsGuarded(d.role_key, env), userHoldsGuardedRole(d.user_id, env)]);
    if (grants || demotes) return SUPER_ADMIN_ONLY();
  }
  if (!d.role_key) {
    await sbStore(`/rest/v1/docket_user_roles?user_id=eq.${enc(d.user_id)}`, env, { method: 'DELETE', prefer: 'return=minimal' });
    return ok({ user_id: d.user_id, role_key: null });
  }
  const chk = await sbStore(`/rest/v1/docket_roles?role_key=eq.${enc(d.role_key)}&select=role_key&limit=1`, env);
  if (!chk.ok || !chk.data?.[0]) return err('unknown role', 400);
  const r = await sbStore(`/rest/v1/docket_user_roles?on_conflict=user_id`, env, {
    method: 'POST', prefer: 'return=representation,resolution=merge-duplicates',
    body: JSON.stringify({ user_id: d.user_id, role_key: d.role_key, assigned_by: auth.userId, assigned_at: nowIso() }),
  });
  if (!r.ok) return err('assign_failed: ' + JSON.stringify(r.data), 400);
  return ok({ user_id: d.user_id, role_key: d.role_key });
}

// ── Dashboard sharing (RULE-DOCKET-006) — admin only ────────────────────────
async function setDashboardPublic(body, auth, env) {
  const gate = requireAdmin(auth); if (gate) return gate;
  const d = body.data || body;
  const value = d.value === true || d.value === 'true';
  const r = await sbDocket(`/rest/v1/settings?on_conflict=key`, env, {
    method: 'POST', prefer: 'return=minimal,resolution=merge-duplicates',
    body: JSON.stringify({ key: 'dashboard_public', value, updated_at: nowIso(), updated_by_user_id: auth.userId }),
  });
  if (!r.ok) return err('update_failed: ' + JSON.stringify(r.data), 400);
  return ok({ public: value });
}
async function addDashboardViewer(body, auth, env) {
  const gate = requireAdmin(auth); if (gate) return gate;
  const d = body.data || body;
  if (!d.user_id) return err('user_id required', 400);
  const r = await sbDocket(`/rest/v1/dashboard_viewers?on_conflict=user_id`, env, {
    method: 'POST', prefer: 'return=minimal,resolution=ignore-duplicates',
    body: JSON.stringify({ user_id: d.user_id, granted_by_user_id: auth.userId }),
  });
  if (!r.ok) return err('add_failed: ' + JSON.stringify(r.data), 400);
  return ok({ user_id: d.user_id });
}
async function removeDashboardViewer(body, auth, env) {
  const gate = requireAdmin(auth); if (gate) return gate;
  const d = body.data || body;
  if (!d.user_id) return err('user_id required', 400);
  await sbDocket(`/rest/v1/dashboard_viewers?user_id=eq.${enc(d.user_id)}`, env, { method: 'DELETE', prefer: 'return=minimal' });
  return ok({ removed: d.user_id });
}

// ── Programs (RULE-DOCKET-004) ──────────────────────────────────────────────
// A free, optional cross-space label, alongside (never instead of) the plan link — restored 2026-11-13.
async function createProgram(body, auth, env) {
  const d = body.data || body;
  if (!d.name || !String(d.name).trim()) return err('name required', 400);
  const name = String(d.name).trim();
  // Idempotent inline create: reuse an existing (case-insensitive) program if present.
  // ILIKE treats % and _ as wildcards (escaped here) and PostgREST maps * to % (can't be
  // escaped), so the query may over-match — the exact case-insensitive compare decides.
  const pattern = name.replace(/[\\%_]/g, (c) => '\\' + c);
  const existing = await sbDocket(`/rest/v1/programs?archived_at=is.null&name=ilike.${enc(pattern)}&select=id,name,color&limit=50`, env);
  const same = existing.ok ? (existing.data || []).find(p => String(p.name).toLowerCase() === name.toLowerCase()) : null;
  if (same) return ok(same);
  const r = await sbDocket(`/rest/v1/programs`, env, {
    method: 'POST', body: JSON.stringify([{ name, color: d.color || null, created_by_user_id: auth.userId }]) });
  if (!r.ok || !r.data?.[0]) return err('create_failed: ' + JSON.stringify(r.data), 400);
  return ok(r.data[0]);
}

// ── Spaces (RULE-DOCKET-003) ────────────────────────────────────────────────
async function createSpace(body, auth, env) {
  const d = body.data || body;
  if (!d.name || !String(d.name).trim()) return err('name required', 400);
  const r = await sbDocket(`/rest/v1/spaces`, env, {
    method: 'POST', body: JSON.stringify([{ name: String(d.name).trim(), is_private: true, is_default: false,
      owner_user_id: auth.userId, created_by_user_id: auth.userId }]) });
  if (!r.ok || !r.data?.[0]) return err('create_failed: ' + JSON.stringify(r.data), 400);
  const space = r.data[0];
  await sbDocket(`/rest/v1/space_members`, env, { method: 'POST', prefer: 'return=minimal',
    body: JSON.stringify({ space_id: space.id, user_id: auth.userId, added_by_user_id: auth.userId }) });
  await logSpace(env, space.id, auth.userId, 'created', space.name);
  return ok({ id: space.id, name: space.name });
}
// Only the OWNER of a private space manages it. General is system. A docket_admin has no path in here —
// RULE-DOCKET-003 "the gate beats admin"; until 2026-11-11 this also let any admin add themselves as a
// member. The one admin route is recoverSpace, for a space whose owner has left.
async function requireSpaceOwner(auth, space) {
  if (!space) return err('space_not_found', 404);
  if (space.is_default) return err('general_is_system', 422);
  if (!isSpaceOwner(auth, space)) return err('forbidden_space_owner', 403);
  return null;
}
async function renameSpace(body, auth, env) {
  const d = body.data || body; if (!d.id || !d.name) return err('id and name required', 400);
  const space = await loadSpace(d.id, env); const gate = await requireSpaceOwner(auth, space); if (gate) return gate;
  await sbDocket(`/rest/v1/spaces?id=eq.${enc(d.id)}`, env, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ name: String(d.name).trim() }) });
  await logSpace(env, d.id, auth.userId, 'renamed', `${space.name} → ${String(d.name).trim()}`);
  return ok({ id: d.id, name: String(d.name).trim() });
}
async function archiveSpace(body, auth, env) {
  const d = body.data || body; if (!d.id) return err('id required', 400);
  const space = await loadSpace(d.id, env); const gate = await requireSpaceOwner(auth, space); if (gate) return gate;
  if (space.is_founders) return err('founders_space_fixed', 403);   // nothing could un-archive it
  if (space.is_personal) return err('personal_space', 422);
  await sbDocket(`/rest/v1/spaces?id=eq.${enc(d.id)}`, env, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ archived_at: nowIso() }) });
  await logSpace(env, d.id, auth.userId, 'archived', null);
  return ok({ id: d.id, archived: true });
}
async function addSpaceMember(body, auth, env) {
  const d = body.data || body; if (!d.space_id || !d.user_id) return err('space_id and user_id required', 400);
  const space = await loadSpace(d.space_id, env); const gate = await requireSpaceOwner(auth, space); if (gate) return gate;
  if (space.is_personal) return err('personal_space', 422);   // P2: nobody else, ever
  // The Founders' space (§5.2): a plan admin adds, and only a plan admin joins.
  if (space.is_founders && !(isPlanAdmin(auth) && await userIsPlanAdminStrict(d.user_id, env))) return err('founders_space', 403);
  await sbDocket(`/rest/v1/space_members?on_conflict=space_id,user_id`, env, { method: 'POST', prefer: 'return=minimal,resolution=ignore-duplicates',
    body: JSON.stringify({ space_id: d.space_id, user_id: d.user_id, added_by_user_id: auth.userId }) });
  await logSpace(env, d.space_id, auth.userId, 'member_added', d.user_id);
  return ok({ space_id: d.space_id, user_id: d.user_id });
}
// Share a private space with a whole team (P1, 0034). Owner-only, like members. Never the Founders' space
// (its members are plan admins by rule, §5.2) and never General (system).
async function shareSpaceWithTeam(body, auth, env) {
  const d = body.data || body; if (!d.space_id || !d.department_id) return err('space_id and department_id required', 400);
  if (!isUuid(String(d.department_id))) return err('invalid department_id', 400);
  const space = await loadSpace(d.space_id, env); const gate = await requireSpaceOwner(auth, space); if (gate) return gate;
  if (space.is_founders) return err('founders_space', 403);
  if (space.is_personal) return err('personal_space', 422);
  const dr = await sbPodium(`/rest/v1/departments?id=eq.${enc(d.department_id)}&active=eq.true&select=id,name&limit=1`, env);
  if (!dr.ok) return err('db_error', 500);
  if (!dr.data?.length) return err('unknown team', 422);
  const r = await sbDocket(`/rest/v1/space_teams?on_conflict=space_id,department_id`, env, { method: 'POST', prefer: 'return=representation,resolution=ignore-duplicates',
    body: JSON.stringify({ space_id: d.space_id, department_id: d.department_id, added_by_user_id: auth.userId }) });
  if (!r.ok) return err('share_failed', 400);
  const added = Array.isArray(r.data) && r.data.length > 0;   // a duplicate share changes nothing and logs nothing
  if (added) await logSpace(env, d.space_id, auth.userId, 'team_shared', `${dr.data[0].name} (${d.department_id})`);
  return ok({ space_id: d.space_id, department_id: d.department_id, added });
}
async function unshareSpaceTeam(body, auth, env) {
  const d = body.data || body; if (!d.space_id || !d.department_id) return err('space_id and department_id required', 400);
  if (!isUuid(String(d.department_id))) return err('invalid department_id', 400);
  const space = await loadSpace(d.space_id, env); const gate = await requireSpaceOwner(auth, space); if (gate) return gate;
  const r = await sbDocket(`/rest/v1/space_teams?space_id=eq.${enc(d.space_id)}&department_id=eq.${enc(d.department_id)}`, env, { method: 'DELETE', prefer: 'return=representation' });
  if (!r.ok) return err('unshare_failed', 400);
  const removed = Array.isArray(r.data) && r.data.length > 0;
  if (removed) {
    const dr = await sbPodium(`/rest/v1/departments?id=eq.${enc(d.department_id)}&select=name&limit=1`, env);
    await logSpace(env, d.space_id, auth.userId, 'team_unshared', `${(dr.ok && dr.data?.[0]?.name) || 'team'} (${d.department_id})`);
  }
  return ok({ space_id: d.space_id, department_id: d.department_id, removed });
}
async function removeSpaceMember(body, auth, env) {
  const d = body.data || body; if (!d.space_id || !d.user_id) return err('space_id and user_id required', 400);
  const space = await loadSpace(d.space_id, env); const gate = await requireSpaceOwner(auth, space); if (gate) return gate;
  if (space.owner_user_id === d.user_id) return err('cannot remove the owner — transfer ownership first', 422);
  await sbDocket(`/rest/v1/space_members?space_id=eq.${enc(d.space_id)}&user_id=eq.${enc(d.user_id)}`, env, { method: 'DELETE', prefer: 'return=minimal' });
  await logSpace(env, d.space_id, auth.userId, 'member_removed', d.user_id);
  return ok({ removed: d.user_id });
}
async function transferSpaceOwnership(body, auth, env) {
  const d = body.data || body; if (!d.space_id || !d.new_owner_user_id) return err('space_id and new_owner_user_id required', 400);
  const space = await loadSpace(d.space_id, env);
  if (!space) return err('space_not_found', 404);
  if (space.is_default) return err('general_is_system', 422);
  if (!isSpaceOwner(auth, space)) return err('forbidden_space_owner', 403);
  if (space.is_personal) return err('personal_space', 422);
  if (!(await isSpaceMember(d.space_id, d.new_owner_user_id, env))) return err('new owner must be a member first', 422);
  if (space.is_founders && !(await userIsPlanAdminStrict(d.new_owner_user_id, env))) return err('founders_space', 403);
  await sbDocket(`/rest/v1/spaces?id=eq.${enc(d.space_id)}`, env, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ owner_user_id: d.new_owner_user_id }) });
  await logSpace(env, d.space_id, auth.userId, 'ownership_transferred', d.new_owner_user_id);
  return ok({ space_id: d.space_id, owner_user_id: d.new_owner_user_id });
}
// Break-glass: a docket_admin recovers an ORPHANED private space — no owner, or an owner whose login is
// inactive or whose Podium record is `exited` (on_leave / notice still own it). Audited. Until 2026-11-11
// it worked on any space, i.e. any admin could take over a live private space.
// A space whose owner is still here can only be UN-ARCHIVED by an admin (the stale-cleanup rollback path,
// systems/docket.md) — archived_at cleared, owner and members untouched, so the admin gains no access.
async function spaceOwnerGone(ownerUserId, env) {
  if (!ownerUserId) return true;
  const [up, em] = await Promise.all([
    sbStore(`/rest/v1/users_profile?id=eq.${enc(ownerUserId)}&select=active&limit=1`, env),
    sbPodium(`/rest/v1/employees?auth_user_id=eq.${enc(ownerUserId)}&select=status&limit=1`, env),
  ]);
  if (!up.ok || !em.ok) return false;   // can't tell → not recoverable (fail closed)
  const profile = up.data?.[0], emp = em.data?.[0];
  return !profile || profile.active === false || (!!emp && emp.status === 'exited');
}
async function recoverSpace(body, auth, env) {
  const gate = requireAdmin(auth); if (gate) return gate;
  const d = body.data || body; if (!d.space_id) return err('space_id required', 400);
  const space = await loadSpace(d.space_id, env);
  if (!space || space.is_default) return err('not_recoverable', 422);
  // Admin recovery never applies to the Founders' space (§5.2) — not even the un-archive path.
  if (space.is_founders) return err('founders_space_fixed', 403);
  // A personal space is never taken over (P3 decides what happens to a leaver's personal tasks).
  if (space.is_personal) return err('personal_space', 422);
  if (!(await spaceOwnerGone(space.owner_user_id, env))) {
    if (!space.archived_at) return err('owner_still_active: only a space whose owner has left can be recovered — ask the owner to add you or transfer it', 409);
    await sbDocket(`/rest/v1/spaces?id=eq.${enc(d.space_id)}`, env, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ archived_at: null }) });
    await logSpace(env, d.space_id, auth.userId, 'unarchived', 'admin restore; owner unchanged');
    return ok({ space_id: d.space_id, owner_user_id: space.owner_user_id, unarchived: true });
  }
  // The recovering admin becomes the owner. (A `new_owner_user_id` param was accepted unvalidated and no
  // caller sends it — dropped, spec §5.1 P0-a; hand the space on afterwards with transferSpaceOwnership.)
  const newOwner = auth.userId;
  await sbDocket(`/rest/v1/space_members?on_conflict=space_id,user_id`, env, { method: 'POST', prefer: 'return=minimal,resolution=ignore-duplicates',
    body: JSON.stringify({ space_id: d.space_id, user_id: newOwner, added_by_user_id: auth.userId }) });
  await sbDocket(`/rest/v1/spaces?id=eq.${enc(d.space_id)}`, env, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ owner_user_id: newOwner, archived_at: null }) });
  await logSpace(env, d.space_id, auth.userId, 'admin_recovered', `new owner ${newOwner}`);
  return ok({ space_id: d.space_id, owner_user_id: newOwner });
}

// ── Scratchpad (RULE-DOCKET-005) — strictly per-user; no admin path ──────────
async function getScratchNotes(url, auth, env) {
  const r = await sbDocket(`/rest/v1/scratch_notes?user_id=eq.${enc(auth.userId)}&select=id,title,body,created_at,updated_at&order=updated_at.desc.nullslast,created_at.desc`, env);
  if (!r.ok) return err('db_error', 500);
  return ok(r.data || []);
}
async function createScratchNote(body, auth, env) {
  const d = body.data || body;
  const r = await sbDocket(`/rest/v1/scratch_notes`, env, {
    method: 'POST', body: JSON.stringify([{ user_id: auth.userId, title: d.title || null, body: d.body || '', updated_at: nowIso() }]) });
  if (!r.ok || !r.data?.[0]) return err('create_failed: ' + JSON.stringify(r.data), 400);
  return ok(r.data[0]);
}
async function updateScratchNote(body, auth, env) {
  const d = body.data || body;
  if (!d.id) return err('id required', 400);
  const updates = { updated_at: nowIso() };
  if (d.title !== undefined) updates.title = d.title;
  if (d.body !== undefined) updates.body = d.body;
  // user_id in the filter is the privacy gate — a note is only writable by its owner.
  const r = await sbDocket(`/rest/v1/scratch_notes?id=eq.${enc(d.id)}&user_id=eq.${enc(auth.userId)}`, env, {
    method: 'PATCH', prefer: 'return=representation', body: JSON.stringify(updates) });
  if (!r.ok) return err('update_failed: ' + JSON.stringify(r.data), 400);
  if (!r.data?.length) return err('not_found', 404);
  return ok({ id: d.id, updated_at: updates.updated_at });
}
async function deleteScratchNote(body, auth, env) {
  const d = body.data || body;
  if (!d.id) return err('id required', 400);
  await sbDocket(`/rest/v1/scratch_notes?id=eq.${enc(d.id)}&user_id=eq.${enc(auth.userId)}`, env, { method: 'DELETE', prefer: 'return=minimal' });
  return ok({ deleted: d.id });
}

// ── Plan layer (F9 R1 — spec 2026-11-11-docket-plan-layer.md) ─────────────────
// Every read goes through docket.plan_items_for (the §5.3 projection: F / O / R / T, done in SQL — R6c: every
// call passes p_is_review = isReviewer) and
// every write through a transactional docket.plan_* RPC that also writes plan_item_history. The SQL
// enforces the §4.3 matrix; plan-core.mjs mirrors it for affordances. p_is_super = docket_plan_admin.
const PLAN_ITEM_KEYS = ['kind', 'parent_id', 'title', 'code', 'owner_employee_id', 'department_id', 'target_text',
  'done_when', 'measure', 'due_date', 'restricted', 'sort', 'state'];
function planArgs(auth) {
  return { p_actor: auth.userId, p_actor_employee: auth.employeeId, p_is_super: isPlanAdmin(auth) };
}
async function planRows(auth, env) {
  return sbDocket(`/rest/v1/rpc/plan_items_for`, env, { method: 'POST', body: JSON.stringify({
    p_actor_employee: auth.employeeId, p_is_super: isPlanAdmin(auth), p_is_review: isReviewer(auth) }) });
}
// F9 R9b: the measure auto-check's latest reading (migration 0029, docket.plan_measure_latest — one batched read
// per request). Attached as measure.reading ONLY where the projection already returns the measure: levels F / R / O,
// never T / L / none, never a restricted item below F. Clients never write readings (normalizeMeasure ignores them).
const READING_LEVELS = ['F', 'R', 'O'];
const readingOk = (i) => !!i && READING_LEVELS.includes(i.level) && !!i.measure && typeof i.measure === 'object'
  && (i.level === 'F' || !i.restricted);
// A failed read is "no reading" (an empty Map) — a page never 500s for it; `strict` (the confirm queue) → null.
async function readingsFor(rows, env, { strict = false } = {}) {
  const ids = uniq(rows.filter(readingOk).map(i => i.id));
  const r = await sbInAll(sbDocket, ids, l => `/rest/v1/plan_measure_latest?item_id=in.${l}&select=item_id,metric,target_text,reading,window_from,window_to,checked_at,reached,target_parsed&order=item_id.asc`, env);
  if (!r.ok) return strict ? null : new Map();
  return new Map((r.data || []).map(x => [x.item_id, x]));
}
// The reading for the item's CURRENT measure: none when the stored row was for another metric (the measure was
// edited since — manual included); `reached` only while the stored target is still the measure's target.
function readingOf(i, readings) {
  const x = readingOk(i) ? readings.get(i.id) : null;
  if (!x || x.metric !== i.measure.metric) return null;
  const sameTarget = (x.target_text || null) === ((typeof i.measure.target === 'string' && i.measure.target.trim()) || null);
  return { value: x.reading == null ? null : Number(x.reading), window_from: x.window_from, window_to: x.window_to, checked_at: x.checked_at,
    reached: sameTarget && x.reached != null ? !!x.reached : null, target_parsed: sameTarget && x.target_parsed != null };
}
// row → row with measure.reading (null when there is none for its current measure); rows it may not carry pass untouched.
const withReading = (readings) => (i) => (readingOk(i) ? { ...i, measure: { ...i.measure, reading: readingOf(i, readings) } } : i);

async function nameMap(sb, table, ids, env) {
  const r = await sbIn(sb, uniq(ids), (l) => `/rest/v1/${table}?id=in.${l}&select=id,full_name`, env);
  const m = {}; (r.ok ? r.data || [] : []).forEach(x => { m[x.id] = x.full_name; });
  return m;
}
const withOwnerName = (names) => (x) => ({ ...x, owner_name: x.owner_employee_id ? (names[x.owner_employee_id] || null) : null });

async function getPlan(url, auth, env) {
  const [r, week] = await Promise.all([planRows(auth, env), weekSettings(env)]);
  if (!r.ok) return err('db_error', 500);
  const raw = Array.isArray(r.data) ? r.data : [];
  const [names, readings] = await Promise.all([nameMap(sbPodium, 'employees', raw.map(x => x.owner_employee_id), env), readingsFor(raw, env)]);
  const rows = raw.map(withReading(readings));
  // R3: the "measured from" registry rides along so the app never keeps its own copy (§4.4).
  // R4: so do the week settings — /tasks groups and filters by week with the org's week_end_dow.
  return ok({ items: rows.map(withOwnerName(names)), can_admin: isPlanAdmin(auth), employee_id: auth.employeeId,
    metrics: publicMetrics(), week });
}
async function getPlanItem(url, auth, env) {
  const id = url.searchParams.get('id');
  if (!isUuid(id)) return err('bad_id', 400);
  const [r, h] = await Promise.all([
    planRows(auth, env),
    sbDocket(`/rest/v1/rpc/plan_history_for`, env, { method: 'POST', body: JSON.stringify({
      p_actor_employee: auth.employeeId, p_is_super: isPlanAdmin(auth), p_id: id, p_is_review: isReviewer(auth) }) }),
  ]);
  if (!r.ok || !h.ok) return err('db_error', 500);
  const all = Array.isArray(r.data) ? r.data : [];
  const found = all.find(x => x.id === id);
  if (!found) return err('not_found', 404);
  const readings = await readingsFor([found, ...all.filter(x => x.parent_id === id)], env);
  const rows = all.map(x => (x.id === id || x.parent_id === id ? withReading(readings)(x) : x));
  const item = rows.find(x => x.id === id);
  const children = rows.filter(x => x.parent_id === id);
  const history = Array.isArray(h.data) ? h.data : [];
  // R2: the tasks linked to this item (a milestone: and to its results), intersected with what the caller
  // can open. Only level F learns how many are hidden ("+N in spaces you're not in", §5.3).
  const linkIds = [id, ...(item.kind === 'milestone' ? children.map(c => c.id) : [])];
  const tr = await sbIn(sbDocket, linkIds, l => `/rest/v1/tasks?plan_item_id=in.${l}&archived_at=is.null&select=*&order=created_at.asc`, env);
  if (!tr.ok) return err('db_error', 500);
  const linked = Array.isArray(tr.data) ? tr.data : [];
  const visible = await visibleTaskRows(auth, linked, env);
  // R3 split form (level F only): the OPEN linked tasks the caller can't open, per plan item — they go to
  // the split's default child ("+N in spaces you can't open will go to …").
  const seen = new Set(visible.map(t => t.id));
  const hiddenOpen = {};
  for (const t of linked) {
    if (seen.has(t.id) || t.parent_task_id || t.status === 'done' || t.status === 'abandoned') continue;
    hiddenOpen[t.plan_item_id] = (hiddenOpen[t.plan_item_id] || 0) + 1;
  }
  const code = (x) => (x ? { id: x.id, code: x.code } : null);
  const [names, actors, planned] = await Promise.all([
    nameMap(sbPodium, 'employees', [item, ...children, ...visible].map(x => x.owner_employee_id), env),
    nameMap(sbStore, 'users_profile', history.map(x => x.actor_user_id), env),
    hydratePlan(visible, auth, env),
  ]);
  return ok({
    item: withOwnerName(names)(item),
    children: children.map(withOwnerName(names)),
    history: history.map(({ actor_user_id, ...x }) => ({ ...x, actor_name: actors[actor_user_id] || null })),
    tasks: planned.map(t => ({
      id: t.id, task_no: t.task_no, title: t.title, status: t.status, priority: t.priority,
      owner_name: t.owner_employee_id ? (names[t.owner_employee_id] || null) : null,
      deadline: t.deadline, revised_deadline: t.revised_deadline,
      space_name: spaceOf(auth, t)?.name || null, plan: t.plan,
    })),
    ...(item.level === 'F' ? { hidden_count: linked.length - visible.length, hidden_open: hiddenOpen } : {}),
    // R3: split lineage, through the same projection (a child the caller can't see is simply absent).
    split_into: rows.filter(x => x.split_from_id === id).map(code),
    split_from: code(item.split_from_id ? rows.find(x => x.id === item.split_from_id) : null),
    can_admin: isPlanAdmin(auth),
  });
}

// RPC → response. {ok:false, code} → the code's 4xx (plan-core planErrStatus); a constraint the RPC
// didn't pre-check surfaces as PostgREST's 4xx text.
async function planRpc(fn, args, env) {
  const r = await sbDocket(`/rest/v1/rpc/${fn}`, env, { method: 'POST', body: JSON.stringify(args) });
  if (!r.ok) {
    // R2: making a theme restricted while linked tasks sit outside the Founders' space (the trigger lists them).
    const m = planDbError(r.data);
    if (m) return planErr(m.code, m.detail ? { detail: m.detail } : {});
    return err(`plan_rejected: ${r.data?.message || r.status}`, r.status >= 500 ? 500 : 400);
  }
  const res = r.data || {};
  if (!res.ok) {
    const code = res.code || 'plan_failed';
    const extra = {};
    for (const k of ['fields', 'field', 'ids', 'count', 'value']) if (res[k] !== undefined && res[k] !== null) extra[k] = res[k];
    return json({ ok: false, error: code, ...extra }, planErrStatus(code));
  }
  const { ok: _ok, ...data } = res;
  return ok(data);
}
async function createPlanItem(body, auth, env) {
  const d = body.data || body.item || {};
  const item = {};
  for (const k of PLAN_ITEM_KEYS) if (d[k] !== undefined) item[k] = d[k];
  const bad = validatePlanFields(item);
  if (bad) return err(bad, 400);
  if (item.measure !== undefined) { const m = normalizeMeasure(item.measure); if (m.error) return err(m.error, 400); item.measure = m.value; }
  return planRpc('plan_create', { ...planArgs(auth), p_item: item }, env);
}
async function updatePlanItem(body, auth, env) {
  const d = body.data || body;
  if (!isUuid(d.id)) return err('bad_id', 400);
  const patch = d.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) return err('bad_patch', 400);
  const bad = validatePlanFields(patch);
  if (bad) return err(bad, 400);
  // R3: measure is validated against the registry and source_ok SET from it — never trusted from the client.
  if (patch.measure !== undefined) { const m = normalizeMeasure(patch.measure); if (m.error) return err(m.error, 400); patch.measure = m.value; }
  return planRpc('plan_update', { ...planArgs(auth), p_id: d.id, p_patch: patch }, env);
}
// body: { id, op: agree | redate | drop | done | reopen | split, payload } (`action` is the worker's own key).
async function planItemAction(body, auth, env) {
  const d = body.data || body;
  if (!isUuid(d.id)) return err('bad_id', 400);
  const payload = (d.payload && typeof d.payload === 'object') ? d.payload : {};
  // R3: split → docket.plan_split (one transaction; super only — below F it is not_found in SQL).
  if (d.op === 'split') {
    const bad = validateSplitPayload(payload);
    if (bad) return err(bad, 400);
    const children = [];
    for (const c of payload.children) {
      const kid = { title: c.title, owner_employee_id: c.owner_employee_id, due_date: c.due_date, done_when: c.done_when };
      if (c.code) kid.code = c.code;
      if (c.measure !== undefined) { const m = normalizeMeasure(c.measure); if (m.error) return err(m.error, 400); kid.measure = m.value; }
      children.push(kid);
    }
    const p = { reason: payload.reason, children };
    for (const k of ['results', 'result_drop_reason', 'tasks', 'tasks_default']) if (payload[k] !== undefined) p[k] = payload[k];
    return planRpc('plan_split', { ...planArgs(auth), p_id: d.id, p_payload: p }, env);
  }
  if (!PLAN_ACT_ACTIONS.includes(d.op)) return err('bad_action', 400);
  const bad = validateActPayload(d.op, payload);
  if (bad) return err(bad, 400);
  return planRpc('plan_act', { ...planArgs(auth), p_id: d.id, p_action: d.op, p_payload: payload }, env);
}

// ── F9 R3: proposals (spec §4.5, migration 0019) ──────────────────────────────
// Anyone signed in proposes; a super admin accepts (→ a milestone via plan_create, same transaction) or
// declines with a reason. docket.plan_proposals_for decides what each caller gets back: super → the
// queue; everyone else → only their own, with the outcome (an accepted item's code only if they see it).
const PROPOSAL_KEYS = ['title', 'why', 'kind_hint', 'suggested_theme_id', 'suggested_owner_employee_id', 'suggested_date'];
async function proposePlanItem(body, auth, env) {
  const d = body.data || body;
  const p = {};
  for (const k of PROPOSAL_KEYS) if (d[k] !== undefined && d[k] !== null && d[k] !== '') p[k] = d[k];
  const bad = validateProposal(p);
  if (bad) return err(bad, 400);
  return planRpc('plan_propose', { p_actor: auth.userId, p_is_super: isPlanAdmin(auth), p_payload: p }, env);
}
const DECISION_KEYS = ['decision', 'note', 'theme_id', 'owner_employee_id', 'due_date', 'done_when', 'state', 'title'];
async function decideProposal(body, auth, env) {
  const d = body.data || body;
  if (!isUuid(d.id)) return err('bad_id', 400);
  const p = {};
  for (const k of DECISION_KEYS) if (d[k] !== undefined && d[k] !== null && d[k] !== '') p[k] = d[k];
  const bad = validateDecision(p);
  if (bad) return err(bad, 400);
  return planRpc('plan_proposal_decide', { ...planArgs(auth), p_id: d.id, p_payload: p }, env);
}
async function getProposals(url, auth, env) {
  const r = await sbDocket(`/rest/v1/rpc/plan_proposals_for`, env, { method: 'POST', body: JSON.stringify({
    p_actor: auth.userId, p_actor_employee: auth.employeeId, p_is_super: isPlanAdmin(auth), p_is_review: isReviewer(auth) }) });
  if (!r.ok) return err('db_error', 500);
  const rows = Array.isArray(r.data) ? r.data : [];
  const [owners, people] = await Promise.all([
    nameMap(sbPodium, 'employees', rows.map(x => x.suggested_owner_employee_id), env),
    nameMap(sbStore, 'users_profile', rows.flatMap(x => [x.proposer_user_id, x.decided_by]), env),
  ]);
  return ok({
    proposals: rows.map(({ proposer_user_id, decided_by, ...x }) => ({
      ...x,
      suggested_owner_name: x.suggested_owner_employee_id ? (owners[x.suggested_owner_employee_id] || null) : null,
      ...(isPlanAdmin(auth) ? { proposer_name: people[proposer_user_id] || null, decided_by_name: decided_by ? (people[decided_by] || null) : null } : {}),
    })),
    can_admin: isPlanAdmin(auth),
  });
}

// ── F9 R2: tasks link up (spec §4.1 "Tasks point up", §5.3, migration 0018) ──────────────────────
// A task carries `plan_item_id` (top-level only; a sub-task's effective link is its parent's). Every
// response that returns tasks gets a `plan` object built from ONE batched docket.plan_links_for call
// (levels F / O / T / L; `none` → no plan at all). No plan title leaves the worker any other way.
const planErr = (code, extra = {}) => json({ ok: false, error: code, ...extra }, planErrStatus(code));
// A refused task write: the R2 trigger / CHECK codes come back as themselves, anything else as before.
function taskWriteErr(prefix, r) {
  // R8 (0027 checks): a sub-task hand-off / a malformed receiver, should a write ever get past the worker's own check.
  const msg = String(r.data?.message || '');
  if (/tasks_handoff_top_level/.test(msg)) return err('handoff_top_level', 400);
  if (/tasks_handoff_shape|handoff_to_(department|employee)_id_fkey/.test(msg)) return err('bad_handoff', 400);
  const m = planDbError(r.data);
  return m ? planErr(m.code, m.detail ? { detail: m.detail } : {}) : err(prefix + JSON.stringify(r.data), 400);
}
async function planLinks(ids, auth, env) {
  const out = {};
  if (!ids.length) return out;
  const r = await sbDocket(`/rest/v1/rpc/plan_links_for`, env, { method: 'POST', body: JSON.stringify({
    p_actor_employee: auth.employeeId, p_is_super: isPlanAdmin(auth), p_ids: ids, p_is_review: isReviewer(auth) }) });
  (r.ok && Array.isArray(r.data) ? r.data : []).forEach(l => { out[l.id] = l; });   // fail closed: no plan
  return out;
}
// Own links for the rows (+ the parents of sub-tasks, + any row whose source didn't carry the column —
// search_tasks), then the projection for every effective link and `extraIds` (history) in one call.
async function planContext(rows, auth, env, extraIds = []) {
  const own = {}, look = [];
  for (const t of rows) {
    if (Object.prototype.hasOwnProperty.call(t, 'plan_item_id')) own[t.id] = t.plan_item_id || null;
    else if (!t.parent_task_id) look.push(t.id);
  }
  for (const pid of uniq(rows.map(t => t.parent_task_id))) if (!(pid in own)) look.push(pid);
  if (look.length) {
    const r = await sbIn(sbDocket, uniq(look), l => `/rest/v1/tasks?id=in.${l}&select=id,plan_item_id`, env);
    (r.ok && Array.isArray(r.data) ? r.data : []).forEach(x => { own[x.id] = x.plan_item_id || null; });
  }
  const ids = uniq([...rows.map(t => effectiveLink(t, own).id), ...extraIds]);
  return { own, links: await planLinks(ids, auth, env) };
}
// The raw plan_item_id only travels with a link the caller can see at some level (never for `none`).
function withPlan(t, ctx) {
  const e = effectiveLink(t, ctx.own);
  const plan = e.id ? taskPlan(ctx.links[e.id], e.inherited) : null;
  return { ...t, plan_item_id: !e.inherited && plan ? plan.id : null, plan };
}
async function hydratePlan(rows, auth, env) {
  if (!rows.length) return rows;
  const ctx = await planContext(rows, auth, env);
  return rows.map(t => withPlan(t, ctx));
}
// Setting a link (spec §4.1 + §5.3): the caller already passed canEditTask; the item must be visible to
// them at F / O / T (L and none read as not found) and live. A super admin sees a restricted item at F —
// refuse a link from outside the Founders' space here rather than through the trigger.
async function checkLinkTarget(auth, itemId, space, env) {
  if (!isUuid(itemId)) return { error: err('bad_plan_item_id', 400) };
  const links = await planLinks([itemId], auth, env);
  const code = linkError(links[itemId]);
  if (code) return { error: planErr(code) };
  if (links[itemId].level === 'F' && !space?.is_founders) {
    const r = await sbDocket(`/rest/v1/rpc/plan_restricted`, env, { method: 'POST', body: JSON.stringify({ p_id: itemId }) });
    if (!r.ok) return { error: err('db_error', 500) };
    if (r.data === true) return { error: planErr('restricted_needs_founders_space') };
  }
  return { link: links[itemId] };
}
// The rows the caller could open with getTask, batched (no per-row await): private spaces through
// keepAccessible (flat — RULE-DOCKET-003), General through canSeeTask's rules with ONE collaborator read.
async function visibleTaskRows(auth, rows, env) {
  const inSpace = await keepAccessible(auth, rows, env);
  const general = (t) => !!spaceOf(auth, t)?.is_default;
  const quick = (t) => canViewAll(auth) || canEditTask(auth, t) || (auth.departmentId && t.department_id === auth.departmentId) || receiverSees(auth, t);
  const need = inSpace.filter(t => general(t) && !quick(t)).map(t => t.id);
  const collab = new Set();
  if (need.length && auth.employeeId) {
    const c = await sbIn(sbDocket, need, l => `/rest/v1/task_collaborators?task_id=in.${l}&employee_id=eq.${enc(auth.employeeId)}&select=task_id`, env);
    ((c.ok && c.data) || []).forEach(x => collab.add(x.task_id));
  }
  return inSpace.filter(t => !general(t) || quick(t) || collab.has(t.id));
}
// ── F9 R4: /plan/weeks (spec §7.2) ───────────────────────────────────────────
// GET ?action=getPlanWeeks[&rows=team|person|theme][&team=<department id>|all]
// The rolling three-week view + its four warnings. ACCESS: plan items only from plan_items_for (F / O / T —
// the projection, never a forked one); tasks only through visibleTaskRows (private spaces, Founders' space,
// the General baseline) and never from an ARCHIVED space (as accessibleSpaces / My tasks / programs — the
// shared keepAccessible deliberately keeps archived spaces for by-id access, so the exclusion is here).
// A level-F item's "No actionable tasks" counts every linked task (§5.3 rollups), and its card carries
// hidden_actionable = how many of those sit in spaces the viewer isn't in ("+N in spaces you're not in");
// below F only tasks the viewer can open count, and nothing about the rest is said. Default scope: a plan
// admin all teams, everyone else their own department. Every list read is paginated (sbInAll / sbAll) — a
// clipped history read would mark a fresh task stale.
const PW_TASK_COLS = 'id,task_no,title,status,priority,owner_employee_id,assignee_employee_id,created_by_user_id,department_id,deadline,revised_deadline,space_id,plan_item_id,parent_task_id,created_at,'
  + 'handoff_to_department_id,handoff_to_employee_id,handoff_accepted_at,handoff_accepted_by';   // R8: the receiver clause reads these
const PW_OPEN = 'status=in.(not_started,in_progress,blocked)';
// sbIn (chunked ids) × sbAll (paged): an in.(…) read that neither a long id list nor max-rows can clip.
// `build` must carry an order= so the pages are stable.
async function sbInAll(sb, ids, build, env, size = 150) {
  if (!ids.length) return { ok: true, status: 200, data: [] };
  const parts = [];
  for (let i = 0; i < ids.length; i += size) parts.push(ids.slice(i, i + size));
  const res = await Promise.all(parts.map(p => sbAll(sb, build(inList(p)), env)));
  const bad = res.find(r => !r.ok);
  return bad || { ok: true, status: 200, data: res.flatMap(r => r.data || []) };
}
async function getPlanWeeks(url, auth, env) {
  const q = url.searchParams;
  const rowsBy = ROWS_BY.includes(q.get('rows')) ? q.get('rows') : 'team';
  const teamParam = q.get('team') || '';
  if (teamParam && teamParam !== 'all' && !isUuid(teamParam)) return err('bad_team', 400);
  const isSuper = isPlanAdmin(auth);
  const teamId = teamParam === 'all' ? null : (teamParam || (isSuper ? null : auth.departmentId || null));
  const now = Date.now();
  const [settings, pr, dr] = await Promise.all([
    weekSettings(env), planRows(auth, env),
    sbPodium(`/rest/v1/departments?select=id,name&order=name.asc`, env),
  ]);
  if (!pr.ok || !dr.ok) return err('db_error', 500);
  const departments = dr.data || [];
  const deptNames = Object.fromEntries(departments.map(d => [d.id, d.name]));
  const win = planWindow(now, settings.week_end_dow);
  const raw = Array.isArray(pr.data) ? pr.data : [];
  const fo = (i) => i.level === 'F' || i.level === 'O' || i.level === 'R';   // R6c: R sees item detail like O
  const live = (i) => i.state === 'proposed' || i.state === 'agreed';
  const itemIds = raw.filter(i => i.kind !== 'theme' && fo(i) && live(i)).map(i => i.id);
  const themeIds = uniq(raw.filter(i => i.kind === 'milestone' && fo(i) && i.state === 'agreed').map(i => i.parent_id));

  // The window's top-level tasks: due before the last week ends, and either still open (Overdue) or due
  // inside the window. Then the viewer's own gate.
  const iso = (ms) => new Date(ms).toISOString();
  const team = teamId ? `&department_id=eq.${enc(teamId)}` : '';
  const effBefore = `or(revised_deadline.lt.${iso(win.end)},and(revised_deadline.is.null,deadline.lt.${iso(win.end)}))`;
  const openOrInside = `or(status.in.(not_started,in_progress,blocked),revised_deadline.gte.${iso(win.start)},and(revised_deadline.is.null,deadline.gte.${iso(win.start)}))`;
  const topLive = 'archived_at=is.null&is_recurring=eq.false&parent_task_id=is.null';
  const [wr, lr, tr, er, ar] = await Promise.all([
    sbAll(sbDocket, `/rest/v1/tasks?${topLive}&status=neq.abandoned${team}&and=(${effBefore},${openOrInside})&select=${PW_TASK_COLS}&order=id.asc`, env),
    sbInAll(sbDocket, itemIds, l => `/rest/v1/tasks?plan_item_id=in.${l}&${topLive}&${PW_OPEN}&select=${PW_TASK_COLS}&order=id.asc`, env),
    sbInAll(sbDocket, themeIds, l => `/rest/v1/tasks?plan_item_id=in.${l}&${topLive}&${PW_OPEN}${team}&select=${PW_TASK_COLS}&order=id.asc`, env),
    sbIn(sbPodium, uniq(raw.map(i => i.owner_employee_id)), l => `/rest/v1/employees?id=in.${l}&select=id,full_name,department_id`, env),
    sbAll(sbDocket, `/rest/v1/spaces?archived_at=not.is.null&select=id&order=id.asc`, env),
  ]);
  if (!wr.ok || !lr.ok || !tr.ok || !er.ok || !ar.ok) return err('db_error', 500);   // fail closed
  const archived = new Set((ar.data || []).map(x => x.id));
  const unarchived = (res) => (res.data || []).filter(t => !archived.has(t.space_id));
  const [winRows, linkedRows, themeRows] = [unarchived(wr), unarchived(lr), unarchived(tr)];
  const [winVisible, linkedVisible, themeVisible] = await Promise.all([
    visibleTaskRows(auth, winRows, env),
    visibleTaskRows(auth, linkedRows, env),
    visibleTaskRows(auth, themeRows, env),
  ]);
  const seen = new Set(linkedVisible.map(t => t.id));
  const linked = linkedRows.map(t => ({ id: t.id, plan_item_id: t.plan_item_id, parent_task_id: t.parent_task_id, status: t.status,
    owner_employee_id: t.owner_employee_id, deadline: t.deadline, revised_deadline: t.revised_deadline, visible: seen.has(t.id) }));

  // Qualifying updates (§8.3) since the stale cut-off: a task_history row or a live comment.
  const since = iso(istMidnight(staleCutoff(now, settings)));
  const openIds = winVisible.filter(t => t.status !== 'done').map(t => t.id);
  const [hr, cr, planned] = await Promise.all([
    sbInAll(sbDocket, openIds, l => `/rest/v1/task_history?task_id=in.${l}&created_at=gte.${since}&select=task_id&order=id.asc`, env),
    sbInAll(sbDocket, openIds, l => `/rest/v1/task_comments?task_id=in.${l}&deleted_at=is.null&created_at=gte.${since}&select=task_id&order=id.asc`, env),
    hydratePlan(winVisible, auth, env),
  ]);
  if (!hr.ok || !cr.ok) return err('db_error', 500);
  const fresh = new Set([...(hr.data || []), ...(cr.data || [])].map(x => x.task_id));

  const emp = {}; (er.data || []).forEach(e => { emp[e.id] = e; });
  const items = raw.map(i => ({ ...i, owner_name: emp[i.owner_employee_id]?.full_name || null,
    team_id: i.department_id || emp[i.owner_employee_id]?.department_id || null }));
  const names = await nameMap(sbPodium, 'employees', [...winVisible, ...themeVisible].map(t => t.owner_employee_id), env);
  const named = (t) => ({ ...t, owner_name: t.owner_employee_id ? (names[t.owner_employee_id] || null) : null,
    department_name: deptNames[t.department_id] || null, _can_edit: canEditTask(auth, t) });
  const model = buildPlanWeeks({
    items, tasks: planned.map(named), linked, themeTasks: themeVisible.map(named), fresh,
    settings, now, rowsBy, teamId, deptNames, isSuper,
  });
  return ok({ ...model, employee_id: auth.employeeId, department_id: auth.departmentId || null, departments });
}

// The task ids (of `ids`) a viewer BELOW plan admin may count and list — getPlanWeeks' gate (visibleTaskRows +
// the archived-space exclusion) and never a Founders'-space task. null = a read failed (fail closed).
async function reviewVisibleIds(auth, ids, env) {
  const [tr, sr] = await Promise.all([
    sbInAll(sbDocket, uniq(ids), l => `/rest/v1/tasks?id=in.${l}&select=${PW_TASK_COLS}&order=id.asc`, env),
    sbAll(sbDocket, `/rest/v1/spaces?or=(archived_at.not.is.null,is_founders.eq.true)&select=id,archived_at,is_founders&order=id.asc`, env),
  ]);
  if (!tr.ok || !sr.ok) return null;
  const blocked = new Set((sr.data || []).map(x => x.id));   // archived or the Founders' space
  const rows = await visibleTaskRows(auth, (tr.data || []).filter(t => !blocked.has(t.space_id)), env);
  return new Set(rows.map(t => t.id));
}
// F9 R5 — the on-time score for one week (spec §8.2): the frozen cohort, final once the week has closed
// (E+1 00:00 IST), provisional before (on time / missed so far / still due). Super admins (whole counts) and,
// since R6c, Founders' Associates (level R: counts and rows from the tasks they can open only).
// GET ?action=getWeekScore[&week=this|last|YYYY-MM-DD (the week holding it)].
async function getWeekScore(url, auth, env) {
  const reviewer = isReviewer(auth);
  if (!isPlanAdmin(auth) && !reviewer) return err('forbidden', 403);
  const w = url.searchParams.get('week') || 'this';
  const today = istDate(Date.now());
  const date = w === 'this' ? today : w === 'last' ? addDays(today, -7) : isDateStr(w) ? w : null;
  if (!date) return err('bad_week', 400);
  const [r, dr] = await Promise.all([
    sbDocket(`/rest/v1/rpc/week_score`, env, { method: 'POST', body: JSON.stringify({ p_date: date }) }),
    sbPodium(`/rest/v1/departments?select=id,name`, env),
  ]);
  if (!r.ok || !dr.ok) return err('db_error', 500);
  const s = r.data || {};
  const dept = Object.fromEntries((dr.data || []).map(x => [x.id, x.name]));
  const tasks = Array.isArray(s.tasks) ? s.tasks : [];
  const people = Array.isArray(s.people) ? s.people : [];
  // The counts are whole; task ROWS only for spaces the viewer can open (RULE-DOCKET-003: the space gate
  // beats every admin role) — the rest are a count, like level F's "+N in spaces you're not in".
  if (reviewer) {
    // R6c level R: counts AND rows only from tasks the Associate can open (the review pack's non-admin gate),
    // recomputed here — the RPC's whole-org totals never leave; nothing is said about the rest.
    const visible = await reviewVisibleIds(auth, tasks.map(t => t.task_id), env);
    if (!visible) return err('db_error', 500);
    const shown = tasks.filter(t => visible.has(t.task_id));
    const final = !!s.final;
    const groupBy = (key) => [...shown.reduce((m, t) => m.set(t[key] || null, [...(m.get(t[key] || null) || []), t]), new Map())]
      .map(([k, rows]) => ({ [key]: k, ...scoreBlock(rows, final) }));
    const names = await nameMap(sbPodium, 'employees', shown.map(x => x.owner_employee_id).filter(Boolean), env);
    const owner = (x) => ({ ...x, owner_name: x.owner_employee_id ? (names[x.owner_employee_id] || null) : null });
    const team = (x) => ({ ...x, team_name: x.department_id ? (dept[x.department_id] || null) : null });
    return ok({ ...s, totals: scoreBlock(shown, final), teams: groupBy('department_id').map(team), people: groupBy('owner_employee_id').map(owner),
      tasks: shown.map(({ space_id, ...t }) => owner(team(t))), hidden_tasks: 0 });
  }
  // The score rows carry owner_employee_id (P3a involvement: owner + collaborator); no assignee / hand-off fields.
  const open = new Set((await keepAccessible(auth, tasks.map(t => ({ id: t.task_id, space_id: t.space_id, owner_employee_id: t.owner_employee_id ?? null })), env)).map(t => t.id));
  const shown = tasks.filter(t => open.has(t.task_id));
  const names = await nameMap(sbPodium, 'employees', [...people, ...shown].map(x => x.owner_employee_id).filter(Boolean), env);
  const owner = (x) => ({ ...x, owner_name: x.owner_employee_id ? (names[x.owner_employee_id] || null) : null });
  const team = (x) => ({ ...x, team_name: x.department_id ? (dept[x.department_id] || null) : null });
  return ok({ ...s, teams: (s.teams || []).map(team), people: people.map(owner),
    tasks: shown.map(({ space_id, ...t }) => owner(team(t))), hidden_tasks: tasks.length - shown.length });
}

// ── F9 R6a: the review pack (spec §8.1–§8.5; contract r6a-contract.md) ──────────────────────────────
// GET ?action=getReviewPack&week=this|last|YYYY-MM-DD&team=<department id>|all
// ACCESS: a plan admin any team or all (default all) — score counts WHOLE (§8.2 as built), task rows only
// through the task gate below, the rest a hidden_tasks count. Anyone else ONLY their own department, and
// their counts AND rows only from tasks they can open, never a Founders'-space task. The task gate is
// getPlanWeeks' — visibleTaskRows + the archived-space exclusion — called ONCE over every task row the
// pack reads. Plan items: plan_items_for at F / O only (milestones + results). Hand-offs (§8.1 item 5) are R8.
const RV_OPEN_DAYS = 30;   // last_update looks back this far (an older own update reads as null)
function reviewDate(w, today) {
  w = w || 'this';
  return w === 'this' ? today : w === 'last' ? addDays(today, -7) : isDateStr(w) ? w : null;
}
// → { pack, score } | { error: Response }
async function buildReviewPack(weekParam, teamParam, auth, env) {
  const today = istDate(Date.now());
  const date = reviewDate(weekParam, today);
  if (!date) return { error: err('bad_week', 400) };
  teamParam = teamParam || '';
  if (teamParam && teamParam !== 'all' && !isUuid(teamParam)) return { error: err('bad_team', 400) };
  const isSuper = isPlanAdmin(auth);
  // R6c: a Founders' Associate (level R) picks any team or all (default all) like a plan admin, but every
  // count and row stays on the non-admin rules below (`isSuper` false): only tasks they can open, never a
  // Founders'-space task, no proposals.
  const anyTeam = isSuper || isReviewer(auth);
  if (!anyTeam) {
    if (!auth.departmentId) return { error: err('no_team', 403) };
    if (teamParam && teamParam !== auth.departmentId) return { error: err('forbidden', 403) };
  }
  const teamId = anyTeam ? (teamParam === 'all' || !teamParam ? null : teamParam) : auth.departmentId;
  const score = (d) => sbDocket(`/rest/v1/rpc/week_score`, env, { method: 'POST', body: JSON.stringify({ p_date: d }) });
  const iso = (ms) => new Date(ms).toISOString();
  const topLive = 'archived_at=is.null&is_recurring=eq.false&parent_task_id=is.null';
  const team = teamId ? `&department_id=eq.${enc(teamId)}` : '';

  // ── 1. the weeks, the plan, the spaces, the open list ──
  const [settings, dr, pr, sr, or, ...scores] = await Promise.all([
    weekSettings(env),
    sbPodium(`/rest/v1/departments?select=id,name&order=name.asc`, env),
    planRows(auth, env),
    sbAll(sbDocket, `/rest/v1/spaces?or=(archived_at.not.is.null,is_founders.eq.true)&select=id,archived_at,is_founders&order=id.asc`, env),
    sbAll(sbDocket, `/rest/v1/tasks?${topLive}&${PW_OPEN}${team}&select=${PW_TASK_COLS}&order=id.asc`, env),
    ...[0, -7, -14, -21, -28, -35].map(n => score(addDays(date, n))),
  ]);
  if (!dr.ok || !pr.ok || !sr.ok || !or.ok || scores.some(r => !r.ok)) return { error: err('db_error', 500) };
  const departments = dr.data || [];
  if (teamId && !departments.some(d => d.id === teamId)) return { error: err('bad_team', 400) };
  const deptNames = Object.fromEntries(departments.map(d => [d.id, d.name]));
  const [s0, s1, ...sTrend] = scores.map(r => r.data || {});
  const weekEnd = s0.week_end || weekEndOf(date, settings.week_end_dow);
  const weekStart = s0.week_start || addDays(weekEnd, -6);
  const bounds = { start: istMidnight(weekStart), end: istMidnight(addDays(weekEnd, 1)) };
  const next = { start: bounds.end, end: istMidnight(addDays(weekEnd, 15)) };
  // Staleness "last working day" only means something for the week running now (§8.3); a past or future
  // week's pack carries null there, and its update reads stop at the week's end.
  const current = today >= weekStart && today <= weekEnd;
  const lwd = current ? lastWorkingDay(today, settings) : null;
  const archived = new Set((sr.data || []).filter(x => x.archived_at).map(x => x.id));
  const founders = new Set((sr.data || []).filter(x => x.is_founders).map(x => x.id));
  const rowsOf = (s) => (Array.isArray(s.tasks) ? s.tasks : []);
  const allCohort = [s0, s1, ...sTrend].flatMap(rowsOf);
  const cohortIds = uniq(allCohort.map(r => r.task_id));

  const raw = Array.isArray(pr.data) ? pr.data : [];
  // Restricted subtree (level F only carries `restricted`, on themes): never into the Slack copy.
  const itemById = new Map(raw.map(i => [i.id, i]));
  const themeOf = (i) => (i.kind === 'theme' ? i.id : i.kind === 'milestone' ? i.parent_id : itemById.get(i.parent_id)?.parent_id);
  const restrictedThemes = new Set(raw.filter(i => i.kind === 'theme' && i.restricted).map(i => i.id));
  const restrictedItems = raw.filter(i => restrictedThemes.has(themeOf(i))).map(i => i.id);
  const foRaw = raw.filter(i => (i.level === 'F' || i.level === 'O' || i.level === 'R') && (i.kind === 'milestone' || i.kind === 'result'));
  const readings = await readingsFor(foRaw, env);   // R9b: measure.reading on the pack's milestone / result rows
  const fo = foRaw.map(withReading(readings));
  const horizonEnd = addDays(weekEnd, 14);
  const live = (i) => i.state === 'proposed' || i.state === 'agreed';
  const horizonIds = fo.filter(i => live(i) && effectiveDue(i) && effectiveDue(i) >= weekStart && effectiveDue(i) <= horizonEnd).map(i => i.id);
  const linkIds = uniq([...horizonIds, ...fo.filter(i => i.kind === 'result' && live(i) && horizonIds.includes(i.parent_id)).map(i => i.id)]);
  const inNext = `or=(and(revised_deadline.gte.${iso(next.start)},revised_deadline.lt.${iso(next.end)}),and(revised_deadline.is.null,deadline.gte.${iso(next.start)},deadline.lt.${iso(next.end)}))`;

  // R8: open hand-offs the team(s) GIVE or RECEIVE (any date — overdue is any age; the lists are cut in
  // review-core). Through the same one gate as every other row below. A task with no department gives from
  // its owner's department, so those are read too and placed once the owners are known.
  const hoTeam = teamId ? `&or=(department_id.eq.${enc(teamId)},handoff_to_department_id.eq.${enc(teamId)},department_id.is.null)` : '';
  // ── 2. every task row the pack reads, then ONE gate over all of them ──
  const [cr, nr, lr, hr, ppr, hor] = await Promise.all([
    sbInAll(sbDocket, cohortIds, l => `/rest/v1/tasks?id=in.${l}&select=${PW_TASK_COLS}&order=id.asc`, env),
    sbAll(sbDocket, `/rest/v1/tasks?${topLive}&${PW_OPEN}${team}&${inNext}&select=${PW_TASK_COLS}&order=id.asc`, env),
    sbInAll(sbDocket, linkIds, l => `/rest/v1/tasks?plan_item_id=in.${l}&${topLive}&${PW_OPEN}&select=${PW_TASK_COLS}&order=id.asc`, env),
    sbInAll(sbDocket, fo.map(i => i.id), l => `/rest/v1/plan_item_history?item_id=in.${l}&event=eq.redated&at=gte.${iso(bounds.start)}&at=lt.${iso(bounds.end)}&select=item_id,event,old,new,note,at&order=id.asc`, env),
    isSuper ? sbAll(sbDocket, `/rest/v1/plan_proposals?or=(status.eq.submitted,and(created_at.gte.${iso(bounds.start)},created_at.lt.${iso(bounds.end)}))&select=id,title,kind_hint,status,created_at,proposer_user_id&order=created_at.desc,id.asc`, env)
            : Promise.resolve({ ok: true, data: [] }),
    sbAll(sbDocket, `/rest/v1/tasks?archived_at=is.null&parent_task_id=is.null&handoff_to_department_id=not.is.null&${PW_OPEN}${hoTeam}&select=${PW_TASK_COLS}&order=id.asc`, env),
  ]);
  if (!cr.ok || !nr.ok || !lr.ok || !hr.ok || !ppr.ok || !hor.ok) return { error: err('db_error', 500) };
  const byId = new Map();
  for (const t of [...(cr.data || []), ...(or.data || []), ...(nr.data || []), ...(lr.data || []), ...(hor.data || [])]) byId.set(t.id, t);
  const gated = await visibleTaskRows(auth, [...byId.values()].filter(t => !archived.has(t.space_id)), env);
  const visible = new Set(gated.filter(t => isSuper || !founders.has(t.space_id)).map(t => t.id));

  // Counts: a plan admin every cohort row; anyone else only the rows they can open. Rows LISTED: `visible`.
  const counted = (rows) => (isSuper ? rows : rows.filter(r => visible.has(r.task_id)));
  const scoped = (rows) => (teamId ? rows.filter(r => (r.department_id || null) === teamId) : rows);
  const thisRows = scoped(counted(rowsOf(s0))), lastRows = scoped(counted(rowsOf(s1)));
  // R8: hand-offs — listed only when visible; one a plan admin can't open is counted with the hidden rows.
  const hoCtx = { now: Date.now(), start: bounds.start, end: istMidnight(addDays(weekEnd, 15)) };
  const owr = await sbIn(sbPodium, uniq((hor.data || []).filter(t => !t.department_id).map(t => t.owner_employee_id)),
    l => `/rest/v1/employees?id=in.${l}&select=id,department_id`, env);
  if (!owr.ok) return { error: err('db_error', 500) };
  const ownerDept = Object.fromEntries((owr.data || []).map(e => [e.id, e.department_id || null]));
  const giving = (t) => t.department_id || ownerDept[t.owner_employee_id] || null;
  const hoAll = (hor.data || []).filter(t => handoffBucket(t, hoCtx)
    && (!teamId || giving(t) === teamId || t.handoff_to_department_id === teamId));
  const handoffRows = hoAll.filter(t => visible.has(t.id));
  const hidden = isSuper ? uniq([...thisRows, ...lastRows].map(r => r.task_id).concat(hoAll.map(t => t.id))).filter(id => !visible.has(id)).length : 0;
  const openTasks = (or.data || []).filter(t => visible.has(t.id));
  // Open tasks due in the two weeks after the pack's week (the read filters; this re-checks, so a widened
  // read can never list a done task or one dated outside the window).
  const nextTasks = (nr.data || []).filter(t => visible.has(t.id) && isOpenStatus(t.status) && (() => {
    const e = Date.parse(t.revised_deadline || t.deadline || '');
    return Number.isFinite(e) && e >= next.start && e < next.end;
  })());
  const linked = (lr.data || []).map(t => ({ plan_item_id: t.plan_item_id, owner_employee_id: t.owner_employee_id, status: t.status,
    deadline: t.deadline, revised_deadline: t.revised_deadline, visible: visible.has(t.id) }));

  // ── 3. history, comments, people ──
  const slippedIds = uniq([...thisRows, ...lastRows].filter(r => r.outcome === 'miss' && visible.has(r.task_id)).map(r => r.task_id));
  const updIds = uniq([...openTasks.map(t => t.id), ...thisRows.filter(r => visible.has(r.task_id) && isOpenStatus(r.status)).map(r => r.task_id)]);
  const since = iso(lwd ? Math.min(bounds.start, istMidnight(lwd)) : bounds.start);
  const proposals = ppr.data || [];
  const empIds = uniq([...thisRows, ...lastRows].map(r => r.owner_employee_id)
    .concat(openTasks.map(t => t.owner_employee_id), nextTasks.map(t => t.owner_employee_id), fo.map(i => i.owner_employee_id),
      handoffRows.flatMap(t => [t.owner_employee_id, t.handoff_to_employee_id])));
  const [rvr, uhr, ucr, er, pnames] = await Promise.all([
    sbInAll(sbDocket, slippedIds, l => `/rest/v1/task_history?task_id=in.${l}&event_type=eq.deadline_revised&select=task_id,created_at,old_value,new_value,note,source&order=created_at.asc,id.asc`, env),
    sbInAll(sbDocket, updIds, l => `/rest/v1/task_history?task_id=in.${l}&created_at=gte.${since}&created_at=lt.${iso(bounds.end)}&select=task_id,created_at,source&order=id.asc`, env),
    sbInAll(sbDocket, updIds, l => `/rest/v1/task_comments?task_id=in.${l}&deleted_at=is.null&created_at=gte.${since}&created_at=lt.${iso(bounds.end)}&select=task_id,created_at&order=id.asc`, env),
    sbIn(sbPodium, empIds, l => `/rest/v1/employees?id=in.${l}&select=id,full_name,department_id,auth_user_id`, env),
    isSuper ? nameMap(sbStore, 'users_profile', proposals.map(p => p.proposer_user_id), env) : Promise.resolve({}),
  ]);
  if (!rvr.ok || !uhr.ok || !ucr.ok || !er.ok) return { error: err('db_error', 500) };
  const emp = {}; (er.data || []).forEach(e => { emp[e.id] = e; });
  const names = Object.fromEntries(Object.values(emp).map(e => [e.id, e.full_name]));
  const revisions = {};
  for (const h of rvr.data || []) (revisions[h.task_id] = revisions[h.task_id] || []).push(h);
  const updates = [...(uhr.data || []).map(h => ({ task_id: h.task_id, at: h.created_at, source: h.source || 'app' })),
    ...(ucr.data || []).map(c => ({ task_id: c.task_id, at: c.created_at, source: null }))];

  // Presence + their own latest update, for the people the staleness block will list (open-task owners).
  const staleOwners = uniq([...openTasks.map(t => t.owner_employee_id), ...thisRows.map(r => r.owner_employee_id)]);
  const authOf = {}; for (const id of staleOwners) if (emp[id]?.auth_user_id) authOf[emp[id].auth_user_id] = id;
  const authIds = Object.keys(authOf);
  const ownEndMs = Math.min(Date.now(), bounds.end);   // a past week's "last update" is as of that week's end
  const ownSince = iso(ownEndMs - RV_OPEN_DAYS * 86400000), ownUntil = iso(ownEndMs);
  const [ohr, ocr, uar] = await Promise.all([
    sbInAll(sbDocket, authIds, l => `/rest/v1/task_history?actor_user_id=in.${l}&created_at=gte.${ownSince}&created_at=lt.${ownUntil}&select=actor_user_id,created_at&order=id.asc`, env),
    sbInAll(sbDocket, authIds, l => `/rest/v1/task_comments?author_user_id=in.${l}&deleted_at=is.null&created_at=gte.${ownSince}&created_at=lt.${ownUntil}&select=author_user_id,created_at&order=id.asc`, env),
    // Presence: a plan admin sees everyone's; anyone else only their own (a colleague's isn't theirs to see).
    sbIn(sbDocket, isSuper ? authIds : authIds.filter(a => a === auth.userId), l => `/rest/v1/user_activity?user_id=in.${l}&select=user_id,last_seen_at`, env),
  ]);
  if (!ohr.ok || !ocr.ok || !uar.ok) return { error: err('db_error', 500) };
  const ownLatest = {}, lastSeen = {};
  const later = (m, k, v) => { if (k && v && (!m[k] || v > m[k])) m[k] = v; };
  for (const h of ohr.data || []) later(ownLatest, authOf[h.actor_user_id], h.created_at);
  for (const c of ocr.data || []) later(ownLatest, authOf[c.author_user_id], c.created_at);
  for (const a of uar.data || []) later(lastSeen, authOf[a.user_id], a.last_seen_at);

  const items = fo.map(i => ({ ...i, owner_name: names[i.owner_employee_id] || null,
    team_id: i.department_id || emp[i.owner_employee_id]?.department_id || null }));
  // Teams in scope (all): every team with a counted cohort row, an open or next-two-weeks task, or a plan item
  // due / re-dated in the pack's window — a milestone-only team still gets its card. null → 'No team'.
  const winItemTeams = items.filter(i => {
    const d = effectiveDue(i);
    return (i.state !== 'dropped' && d && d >= weekStart && d <= horizonEnd) || (hr.data || []).some(h => h.item_id === i.id);
  }).map(i => i.team_id);
  const teamIds = teamId ? [teamId] : uniq([...thisRows, ...lastRows, ...openTasks, ...nextTasks].map(r => r.department_id)
      .concat(winItemTeams, handoffRows.flatMap(t => [giving(t), t.handoff_to_department_id])).map(d => d || 'none'))
    .map(k => (k === 'none' ? null : k))
    .sort((a, b) => (a ? 0 : 1) - (b ? 0 : 1) || String(deptNames[a] || '').localeCompare(String(deptNames[b] || '')));
  const taskPlan = {}; for (const id of thisRows.map(r => r.task_id)) taskPlan[id] = byId.get(id)?.plan_item_id || null;
  const teams = buildReviewTeams({
    teamIds, deptNames, shown: visible, revisions, items, itemHistory: hr.data || [], linked, metrics: publicMetrics(),
    openTasks, nextTasks, updates, taskPlan, names, ownLatest, lastSeen, lwd, lookbackStart: ownSince,
    handoffs: handoffRows, ownerDept, now: hoCtx.now,
    seenOnly: isSuper ? null : auth.employeeId || '',
    week: { week_start: weekStart, week_end: weekEnd, final: !!s0.final, rows: thisRows },
    last: { week_end: s1.week_end || addDays(weekEnd, -7), final: !!s1.final, rows: lastRows },
    trend: sTrend.reverse().map(s => ({ week_end: s.week_end, final: !!s.final, rows: scoped(counted(rowsOf(s))) })),
  });
  const pack = {
    week: { week_end: weekEnd, week_start: weekStart, final: !!s0.final, opened: !!s0.opened, opened_late: !!s0.opened_late,
      as_of: s0.as_of || nowIso() },
    team_id: teamId,
    can_admin: isSuper,
    can_review: anyTeam,
    departments: anyTeam ? departments : departments.filter(d => d.id === auth.departmentId),
    hidden_tasks: hidden,
    teams,
    proposals: isSuper ? {
      submitted_this_week: proposals.filter(p => Date.parse(p.created_at) >= bounds.start && Date.parse(p.created_at) < bounds.end)
        .map(({ proposer_user_id, ...p }) => ({ ...p, proposer_name: pnames[proposer_user_id] || null })),
      waiting: proposals.filter(p => p.status === 'submitted').length,
    } : null,
  };
  pack.slack_omit = { tasks: [...byId.values()].filter(t => founders.has(t.space_id)).map(t => t.id), items: restrictedItems };
  pack.slack = packToSlack(pack);
  return { pack, score: s0 };
}
async function getReviewPack(url, auth, env) {
  const q = url.searchParams;
  const r = await buildReviewPack(q.get('week'), q.get('team'), auth, env);
  if (r.error) return r.error;
  const { slack_omit, ...pack } = r.pack;   // ids only, but the reader has no use for them
  return ok(pack);
}
// POST { action: 'holdReview', week, team } — the Friday "held" button (§8.2): the current pack, stored as a
// provisional snapshot (immutable). Plan admin only.
async function holdReview(body, auth, env) {
  if (!isPlanAdmin(auth)) return err('forbidden', 403);
  const d = body.data || body;
  const r = await buildReviewPack(d.week, d.team, auth, env);
  if (r.error) return r.error;
  const s = r.score || {};
  if (!s.opened) return err('week_not_open', 409);
  const ins = await sbDocket(`/rest/v1/review_snapshots`, env, { method: 'POST', body: JSON.stringify({
    week_end: r.pack.week.week_end, kind: 'provisional', department_id: r.pack.team_id, payload: r.pack,
    scoring_version: s.scoring_version, week_end_dow: s.week_end_dow, cutoff_at: s.cutoff_at, created_by: auth.userId }) });
  if (!ins.ok || !ins.data?.[0]) return err('insert_failed', 500);
  return ok({ id: ins.data[0].id, created_at: ins.data[0].created_at });
}
// GET ?action=getReviewSnapshots&week=… (list) | &id=<uuid> (one, re-projected for the reader — §8.5: a
// payload holds what its HOLDER could see, and week_close's final one is the raw week_score with every
// title; rows in spaces the reader can't open now become a hidden count). Plan admin only.
async function getReviewSnapshots(url, auth, env) {
  if (!isPlanAdmin(auth)) return err('forbidden', 403);
  const q = url.searchParams;
  const id = q.get('id');
  if (id) {
    if (!isUuid(id)) return err('bad_id', 400);
    const r = await sbDocket(`/rest/v1/review_snapshots?id=eq.${enc(id)}&select=id,kind,week_end,department_id,created_at,payload&limit=1`, env);
    if (!r.ok) return err('db_error', 500);
    const snap = r.data?.[0];
    if (!snap) return err('not_found', 404);
    const p = snap.payload || {};
    const ids = Array.isArray(p.tasks) ? uniq(p.tasks.map(t => t.task_id)) : packTaskIds(p);
    const [tr, fsr] = await Promise.all([
      sbIn(sbDocket, ids, l => `/rest/v1/tasks?id=in.${l}&select=id,space_id,owner_employee_id,assignee_employee_id,handoff_to_department_id,handoff_to_employee_id`, env),   // + P3a involvement fields
      sbDocket(`/rest/v1/spaces?is_founders=is.true&select=id`, env),
    ]);
    if (!tr.ok || !fsr.ok) return err('db_error', 500);
    const fsp = new Set((fsr.data || []).map(x => x.id));
    const founderTasks = (tr.data || []).filter(t => fsp.has(t.space_id)).map(t => t.id);
    const keep = new Set((await keepAccessible(auth, tr.data || [], env)).map(t => t.id));
    let payload;
    if (Array.isArray(p.tasks)) {
      // A final snapshot holds the raw week_score payload → rebuilt in the pack's shape (one batched read each
      // for team names, owner names and the slipped rows' deadline revisions), titles only for `keep`.
      const misses = uniq(p.tasks.filter(t => t.outcome === 'miss' && keep.has(t.task_id)).map(t => t.task_id));
      const [dr, names, rv] = await Promise.all([
        sbPodium(`/rest/v1/departments?select=id,name&order=name.asc`, env),
        nameMap(sbPodium, 'employees', p.tasks.filter(t => keep.has(t.task_id)).map(t => t.owner_employee_id), env),
        sbInAll(sbDocket, misses, l => `/rest/v1/task_history?task_id=in.${l}&event_type=eq.deadline_revised&select=task_id,created_at,old_value,new_value,note,source&order=created_at.asc,id.asc`, env),
      ]);
      if (!dr.ok) return err('db_error', 500);
      const revisions = rv.ok ? {} : null;
      if (rv.ok) for (const h of rv.data || []) (revisions[h.task_id] = revisions[h.task_id] || []).push(h);
      payload = finalSnapshotPack(p, { keep, names, revisions, teamId: snap.department_id || null, departments: dr.data || [],
        deptNames: Object.fromEntries((dr.data || []).map(d => [d.id, d.name])) });
    } else payload = reprojectPack({ ...p, slack_omit: { tasks: [...new Set([...(p.slack_omit?.tasks || []), ...founderTasks])], items: p.slack_omit?.items || [] } }, keep);
    if (Array.isArray(p.tasks)) payload = { ...payload, slack_omit: { tasks: founderTasks, items: [] } };
    payload = { ...payload, slack: packToSlack(payload) };
    const { slack_omit, ...shown } = payload;
    return ok({ snapshot: { ...snap, payload: shown } });
  }
  const date = reviewDate(q.get('week'), istDate(Date.now()));
  if (!date) return err('bad_week', 400);
  const [settings, wr] = await Promise.all([weekSettings(env),
    sbDocket(`/rest/v1/weeks?week_start=lte.${date}&week_end=gte.${date}&select=week_end&order=week_end.desc&limit=1`, env)]);
  if (!wr.ok) return err('db_error', 500);
  const weekEnd = wr.data?.[0]?.week_end || weekEndOf(date, settings.week_end_dow);
  const r = await sbDocket(`/rest/v1/review_snapshots?week_end=eq.${weekEnd}&select=id,kind,department_id,created_at,created_by&order=created_at.desc`, env);
  if (!r.ok) return err('db_error', 500);
  const rows = r.data || [];
  const people = await nameMap(sbStore, 'users_profile', rows.map(x => x.created_by), env);
  return ok({ snapshots: rows.map(({ created_by, ...x }) => ({ ...x, created_by_name: created_by ? (people[created_by] || null) : null })) });
}

// ── F9 R6b: the Saturday founders' catch-up (spec §8.6; contract r6bc-contract.md) — level F only ──────────
// The week holding `date`: its docket.weeks row when there is one (that row's week_end_dow), else the settings.
async function weekRowFor(date, env) {
  const [settings, wr] = await Promise.all([weekSettings(env),
    sbDocket(`/rest/v1/weeks?week_start=lte.${date}&week_end=gte.${date}&select=week_end,week_start,closed_at&order=week_end.desc&limit=1`, env)]);
  if (!wr.ok) return null;
  const row = wr.data?.[0];
  const week_end = row?.week_end || weekEndOf(date, settings.week_end_dow);
  return { week_end, week_start: row?.week_start || addDays(week_end, -6), closed: !!row?.closed_at, settings };
}
// Each plan admin's top 5 for the week (only the caller's when `onlyMe`), caller first. A ref the caller
// can't see (an item outside plan_items_for, a task outside keepAccessible) → ref null, the note kept.
async function focusEntries(weekEnd, auth, env, onlyMe = false) {
  let founders = [auth.userId];
  if (!onlyMe) {
    const rr = await sbStore(`/rest/v1/docket_roles?select=role_key,permissions`, env);
    if (!rr.ok) return null;   // fail closed: never silently drop the other founder's list
    const keys = (rr.data || []).filter(r => normalizeDocketPerms(r.permissions).docket_plan_admin).map(r => r.role_key);
    const ur = keys.length ? await sbStore(`/rest/v1/docket_user_roles?role_key=in.${inList(keys)}&select=user_id`, env) : { ok: true, data: [] };
    if (!ur.ok) return null;
    founders = uniq([auth.userId, ...(ur.data || []).map(x => x.user_id)]);
  }
  const fr = await sbDocket(`/rest/v1/founder_focus?week_end=eq.${weekEnd}&founder_user_id=in.${inList(founders)}&select=founder_user_id,rank,plan_item_id,task_id,note,updated_at&order=rank.asc`, env);
  if (!fr.ok) return null;
  const rows = fr.data || [];
  const planIds = uniq(rows.map(r => r.plan_item_id)), taskIds = uniq(rows.map(r => r.task_id));
  const [names, pr, tr] = await Promise.all([
    nameMap(sbStore, 'users_profile', founders, env),
    planIds.length ? planRows(auth, env) : Promise.resolve({ ok: true, data: [] }),
    sbIn(sbDocket, taskIds, l => `/rest/v1/tasks?id=in.${l}&select=id,task_no,title,status,deadline,revised_deadline,space_id,owner_employee_id,assignee_employee_id,handoff_to_department_id,handoff_to_employee_id`, env),   // + P3a involvement
  ]);
  if (!pr.ok || !tr.ok) return null;
  const items = new Map((Array.isArray(pr.data) ? pr.data : []).map(i => [i.id, i]));
  const tasks = new Map((await keepAccessible(auth, tr.data || [], env)).map(t => [t.id, t]));
  const ref = (r) => {
    if (r.plan_item_id) { const i = items.get(r.plan_item_id); return i ? { kind: 'item', code: i.code || null, title: i.title, state: i.state, due: effectiveDue(i) } : null; }
    if (r.task_id) { const t = tasks.get(r.task_id); return t ? { kind: 'task', task_no: t.task_no, title: t.title, status: t.status, due: t.revised_deadline || t.deadline || null } : null; }
    return null;
  };
  return founders.map(u => {
    const mine = rows.filter(r => r.founder_user_id === u);
    return { founder_user_id: u, founder_name: names[u] || null, is_me: u === auth.userId,
      updated_at: mine.reduce((m, r) => (r.updated_at && (!m || r.updated_at > m) ? r.updated_at : m), null),
      items: mine.map(r => ({ rank: r.rank, plan_item_id: r.plan_item_id || null, task_id: r.task_id || null, note: r.note || null, ref: ref(r) })) };
  }).sort((a, b) => (b.is_me - a.is_me) || String(a.founder_name || '').localeCompare(String(b.founder_name || '')));
}
// GET ?action=getFoundersReview&week=this|last|YYYY-MM-DD — cross-team asks due this week or next + both
// founders' top 5, and the one Slack message. Plan admin only.
async function getFoundersReview(url, auth, env) {
  if (!isPlanAdmin(auth)) return err('forbidden', 403);
  const date = reviewDate(url.searchParams.get('week'), istDate(Date.now()));
  if (!date) return err('bad_week', 400);
  const wk = await weekRowFor(date, env);
  if (!wk) return err('db_error', 500);
  const start = istMidnight(wk.week_start), end = istMidnight(addDays(wk.week_end, 8));
  const iso = (ms) => new Date(ms).toISOString();
  const win = `or=(and(revised_deadline.gte.${iso(start)},revised_deadline.lt.${iso(end)}),and(revised_deadline.is.null,deadline.gte.${iso(start)},deadline.lt.${iso(end)}))`;
  const cols = `${PW_TASK_COLS},archived_at`;
  const [ar, dr, focus, xr] = await Promise.all([
    sbAll(sbDocket, `/rest/v1/tasks?archived_at=is.null&parent_task_id=is.null&${PW_OPEN}&${win}&select=${cols}&order=id.asc`, env),
    sbPodium(`/rest/v1/departments?select=id,name`, env),
    focusEntries(wk.week_end, auth, env),
    sbAll(sbDocket, `/rest/v1/spaces?archived_at=not.is.null&select=id&order=id.asc`, env),
  ]);
  if (!ar.ok || !dr.ok || !focus || !xr.ok) return err('db_error', 500);
  // A task in an ARCHIVED space is no ask and no hand-off (as the review pack).
  const archived = new Set((xr.data || []).map(x => x.id));
  const blocked = (ar.data || []).filter(t => !archived.has(t.space_id));
  const lr = await sbInAll(sbDocket, blocked.map(t => t.id), l => `/rest/v1/task_links?kind=eq.blocks&to_task_id=in.${l}&select=id,from_task_id,to_task_id&order=id.asc`, env);
  if (!lr.ok) return err('db_error', 500);
  const links = lr.data || [];
  const br = await sbInAll(sbDocket, uniq(links.map(l => l.from_task_id)), l => `/rest/v1/tasks?id=in.${l}&archived_at=is.null&select=${cols}&order=id.asc`, env);   // a deleted blocker is no ask
  if (!br.ok) return err('db_error', 500);
  const blockers = (br.data || []).filter(t => !archived.has(t.space_id));
  const keep = new Set((await keepAccessible(auth, [...blocked, ...blockers], env)).map(t => t.id));
  const names = await nameMap(sbPodium, 'employees', [...blocked, ...blockers].filter(t => keep.has(t.id))
    .flatMap(t => [t.owner_employee_id, t.handoff_to_employee_id]), env);
  const deptNames = Object.fromEntries((dr.data || []).map(d => [d.id, d.name]));
  const { asks, hidden_asks } = buildAsks({ links, blocked, blockers, keep, names, start, end, deptNames });
  // R8: open cross-team hand-offs due this week or next, no named receiver or not accepted — from the same
  // window read (every open top-level task due in it), the same keepAccessible gate; hidden ones are counted.
  const owr = await sbIn(sbPodium, uniq(blocked.filter(t => isHandoff(t) && !t.department_id).map(t => t.owner_employee_id)),
    l => `/rest/v1/employees?id=in.${l}&select=id,department_id`, env);
  if (!owr.ok) return err('db_error', 500);
  const ownerDept = Object.fromEntries((owr.data || []).map(e => [e.id, e.department_id || null]));
  const ho = foundersHandoffs({ rows: blocked, keep, names, deptNames, ownerDept, start, end });
  const out = { week: { week_end: wk.week_end, week_start: wk.week_start }, asks, hidden_asks: hidden_asks + ho.hidden,
    handoffs: ho.handoffs, focus };
  return ok({ ...out, slack: foundersToSlack(out) });
}
// POST { action: 'setFounderFocus', week: this|next|YYYY-MM-DD, items: [...] } — replaces the CALLER's top 5
// for the week in one transaction (docket.founder_focus_set, migration 0026). items: [] clears it.
const FOCUS_ERR = /\b(too_many|bad_rank|bad_item|note_too_long|not_found|week_closed|bad_week)\b/;
async function setFounderFocus(body, auth, env) {
  if (!isPlanAdmin(auth)) return err('forbidden', 403);
  const d = body.data || body;
  const today = istDate(Date.now());
  const w = d.week || 'this';
  const date = w === 'this' ? today : w === 'next' ? addDays(today, 7) : isDateStr(w) ? w : null;
  if (!date) return err('bad_week', 400);
  const v = validateFocusItems(d.items);
  if (v.error) return err(v.error, 400);
  const wk = await weekRowFor(date, env);
  if (!wk) return err('db_error', 500);
  // A closed week, or any week already over, is a record (the RPC refuses it too).
  if (wk.closed || wk.week_end < weekEndOf(today, wk.settings.week_end_dow)) return err('week_closed', 409);
  const planIds = uniq(v.items.map(i => i.plan_item_id)), taskIds = uniq(v.items.map(i => i.task_id));
  const [pr, tr] = await Promise.all([
    planIds.length ? planRows(auth, env) : Promise.resolve({ ok: true, data: [] }),
    sbIn(sbDocket, taskIds, l => `/rest/v1/tasks?id=in.${l}&archived_at=is.null&select=id,space_id,owner_employee_id,assignee_employee_id,handoff_to_department_id,handoff_to_employee_id`, env),   // + P3a involvement
  ]);
  if (!pr.ok || !tr.ok) return err('db_error', 500);
  const seenItems = new Set((Array.isArray(pr.data) ? pr.data : []).map(i => i.id));
  const seenTasks = new Set((await keepAccessible(auth, tr.data || [], env)).map(t => t.id));
  if (planIds.some(id => !seenItems.has(id)) || taskIds.some(id => !seenTasks.has(id))) return err('not_found', 400);
  const r = await sbDocket(`/rest/v1/rpc/founder_focus_set`, env, { method: 'POST', body: JSON.stringify({
    p_actor: auth.userId, p_week_end: wk.week_end, p_items: v.items }) });
  if (!r.ok) {
    const code = FOCUS_ERR.exec(String(r.data?.message || ''))?.[1];
    return code ? err(code, code === 'week_closed' ? 409 : 400) : err('db_error', 500);
  }
  const focus = await focusEntries(wk.week_end, auth, env, true);
  if (!focus) return err('db_error', 500);
  return ok({ focus: focus[0] });
}

// A plan admin, read strictly: any failed read is "no" (the role guard's userHoldsGuardedRole fails the other
// way, because there "yes" blocks). Used where "yes" GRANTS — the Founders' space.
async function userIsPlanAdminStrict(userId, env) {
  if (!isUuid(userId || '')) return false;
  const r = await sbStore(`/rest/v1/docket_user_roles?user_id=eq.${enc(userId)}&select=role_key&limit=1`, env);
  const key = r.ok && r.data?.[0]?.role_key;
  if (!key) return false;
  const p = await sbStore(`/rest/v1/docket_roles?role_key=eq.${enc(key)}&select=permissions&limit=1`, env);
  return !!(p.ok && normalizeDocketPerms(p.data?.[0]?.permissions).docket_plan_admin);
}

// ── F9 R9a: the plan tree (spec §7.3) ───────────────────────────────────────
// GET ?action=getPlanTree[&theme=<uuid>][&closed=1][&mine=1]. Items: plan_items_for (the §5.3 projection getPlan
// uses — fields a level may not see are already stripped there; L / none never come back). Tasks: ONE batched
// read of top-level, non-archived tasks linked to the shown items' subtrees, ONE visibility pass
// (visibleTaskRows; never an archived space; below F never a Founders'-space task). Rollups and leaves: tree-core.
const TREE_TASK_COLS = 'id,task_no,title,status,owner_employee_id,assignee_employee_id,created_by_user_id,department_id,deadline,'
  + 'revised_deadline,completed_at,space_id,plan_item_id,parent_task_id,handoff_to_department_id,handoff_to_employee_id';
async function getPlanTree(url, auth, env) {
  const q = url.searchParams;
  const themeId = q.get('theme') || null;
  if (themeId && !isUuid(themeId)) return err('not_found', 404);
  const isF = isPlanAdmin(auth);
  // `structure`: the real links of EVERY plan item (service role) — tree-core hangs a shown item under its nearest
  // visible ancestor and rolls tasks up through hidden ones with it. Never emitted.
  const [r, ar, sr] = await Promise.all([planRows(auth, env), sbAll(sbDocket, `/rest/v1/spaces?archived_at=not.is.null&select=id&order=id.asc`, env),
    sbAll(sbDocket, `/rest/v1/plan_items?select=id,parent_id,kind&order=id.asc`, env)]);
  if (!r.ok || !ar.ok || !sr.ok) return err('db_error', 500);
  const raw = (Array.isArray(r.data) ? r.data : []).filter(i => TREE_LEVELS.includes(i.level));
  if (themeId && !raw.some(i => i.id === themeId && i.kind === 'theme')) return err('not_found', 404);
  const readings = await readingsFor(raw, env);   // R9b: measure.reading at F / R / O (a level-T row has no measure)
  const items = raw.map(withReading(readings));
  const opts = { closed: q.get('closed') === '1', mine: q.get('mine') === '1', employeeId: auth.employeeId || null, themeId, structure: sr.data || [] };
  const tr = await sbInAll(sbDocket, treeTaskItemIds(items, opts),
    l => `/rest/v1/tasks?plan_item_id=in.${l}&parent_task_id=is.null&archived_at=is.null&is_recurring=eq.false&select=${TREE_TASK_COLS}&order=id.asc`, env);
  if (!tr.ok) return err('db_error', 500);
  const archived = new Set((ar.data || []).map(x => x.id));
  const tasks = (tr.data || []).filter(t => !archived.has(t.space_id));
  const gated = await visibleTaskRows(auth, tasks, env);
  const visibleIds = new Set(gated.filter(t => isF || !spaceOf(auth, t)?.is_founders).map(t => t.id));
  const names = await nameMap(sbPodium, 'employees', [...items.map(i => i.owner_employee_id),
    ...tasks.filter(t => visibleIds.has(t.id)).map(t => t.owner_employee_id)], env);
  const tree = buildTree(items, tasks, { ...opts, now: Date.now(), visibleIds, level: isF ? 'F' : null, names, metrics: publicMetrics() });
  return ok({ items: tree.items, tasks: tree.tasks, ...(isF ? { hidden_total: tree.hidden_total } : {}), generated_at: nowIso() });
}

// ── F9 R9b: the founders' confirm queue (spec §4.4 P2) — level F only ─────────
// GET ?action=getReachedTargets → agreed milestones / results whose LATEST auto-check reading reached the target,
// by effective due. Confirming is the existing `done` action (the app pre-fills the evidence) — no new write path.
async function getReachedTargets(url, auth, env) {
  if (!isPlanAdmin(auth)) return err('forbidden', 403);
  const r = await planRows(auth, env);
  if (!r.ok) return err('db_error', 500);
  const agreed = (Array.isArray(r.data) ? r.data : []).filter(i => i.state === 'agreed' && (i.kind === 'milestone' || i.kind === 'result') && readingOk(i));
  const readings = await readingsFor(agreed, env, { strict: true });
  if (!readings) return err('db_error', 500);
  // readingOf: the reading must be for the item's CURRENT metric and target — an edited (or manual) measure never queues
  const hit = agreed.filter(i => readingOf(i, readings)?.reached === true);
  const names = await nameMap(sbPodium, 'employees', hit.map(i => i.owner_employee_id), env);
  const items = hit.map(i => {
    const rd = readingOf(i, readings);
    return { id: i.id, kind: i.kind, code: i.code || null, title: i.title,
      owner_name: i.owner_employee_id ? names[i.owner_employee_id] || null : null, effective_due: effectiveDue(i),
      metric_label: metricByKey(i.measure.metric)?.label || i.measure.metric || null, target: i.measure.target || null,
      reading: rd.value, window_from: rd.window_from, window_to: rd.window_to, checked_at: rd.checked_at };
  }).sort((a, b) => String(a.effective_due || '').localeCompare(String(b.effective_due || ''))
    || String(a.code || '').localeCompare(String(b.code || ''), undefined, { numeric: true }));
  return ok({ items });
}

// ── F9 R9b: the on-time score trend (spec §8.1 #2, §8.5) ─────────────────────
// GET ?action=getScoreTrend[&weeks=8 (1–26)][&team=<department id>|all]. Rights and team scoping = getReviewPack:
// a plan admin or a Founders' Associate any team or all; a lead ONLY their own team. Each of the last N CLOSED
// weeks (week_end before the current week) is docket.week_score(week_end) — never recomputed from tasks. Level F
// takes week_score's own team rows and totals (whole, as R5 built them). week_score's team rows are NOT split by
// space (they include Founders'-space tasks), so below F the points come from its TASK rows (each one carries its
// frozen outcome, department and space) cut by the review pack's non-admin gate (reviewVisibleIds: tasks the
// caller can open, never an archived space, never the Founders' space — and a task linked into a restricted
// subtree must live in the Founders' space, R2 link guard) and grouped by department.
async function getScoreTrend(url, auth, env) {
  const q = url.searchParams;
  const n = trendWeeksParam(q.get('weeks'));
  if (!n) return err('bad_weeks', 400);
  const teamParam = q.get('team') || '';
  if (teamParam && teamParam !== 'all' && !isUuid(teamParam)) return err('bad_team', 400);
  const isSuper = isPlanAdmin(auth);
  const anyTeam = isSuper || isReviewer(auth);
  if (!anyTeam) {
    if (!auth.departmentId) return err('no_team', 403);
    if (teamParam && teamParam !== 'all' && teamParam !== auth.departmentId) return err('forbidden', 403);
    if (teamParam === 'all') return err('forbidden', 403);
  }
  const teamId = anyTeam ? (teamParam === 'all' || !teamParam ? null : teamParam) : auth.departmentId;
  const settings = await weekSettings(env);
  const ends = trendWeekEnds(istDate(Date.now()), settings.week_end_dow, n);
  const [wr, dr] = await Promise.all([
    sbDocket(`/rest/v1/weeks?week_end=in.${inList(ends)}&closed_at=not.is.null&select=week_end&order=week_end.asc`, env),
    sbPodium(`/rest/v1/departments?select=id,name&order=name.asc`, env),
  ]);
  if (!wr.ok || !dr.ok) return err('db_error', 500);
  const deptNames = Object.fromEntries((dr.data || []).map(d => [d.id, d.name]));
  if (teamId && !deptNames[teamId]) return err('bad_team', 400);
  const closed = (wr.data || []).map(w => w.week_end).filter(we => ends.includes(we));
  const sr = await Promise.all(closed.map(we => sbDocket(`/rest/v1/rpc/week_score`, env, { method: 'POST', body: JSON.stringify({ p_date: we }) })));
  if (sr.some(r => !r.ok)) return err('db_error', 500);
  const scores = {};
  closed.forEach((we, k) => { if (sr[k].data?.final) scores[we] = sr[k].data; });
  let visible = null;
  if (!isSuper) {
    visible = await reviewVisibleIds(auth, Object.values(scores).flatMap(s => (Array.isArray(s.tasks) ? s.tasks : []).map(t => t.task_id)), env);
    if (!visible) return err('db_error', 500);
  }
  return ok(trendModel({ weekEnds: ends, scores, whole: isSuper, teamId, deptNames,
    rowsOf: (s) => (Array.isArray(s.tasks) ? s.tasks : []).filter(t => visible.has(t.task_id)) }));
}

// ── F9 R9b: the monthly re-plan (spec §8.7) — level F only ───────────────────
// GET ?action=getReplan[&month=YYYY-MM (default: next month, IST)] → the month's agreed + proposed milestones
// with readiness, the risk proposals since the last re-plan, the previous month's closed weekly scores.
async function getReplan(url, auth, env) {
  if (!isPlanAdmin(auth)) return err('forbidden', 403);
  const today = istDate(Date.now());
  const mo = replanMonth(url.searchParams.get('month'), today);
  if (!mo) return err('bad_month', 400);
  const iso = (ms) => new Date(ms).toISOString();
  const aStart = istMidnight(mo.first), aEnd = istMidnight(addDays(mo.first, REPLAN_ACTION_DAYS));
  const riskFrom = iso(istMidnight(addDays(mo.first, -REPLAN_RISK_DAYS))), riskTo = iso(istMidnight(mo.first));
  const inWin = `or=(and(revised_deadline.gte.${iso(aStart)},revised_deadline.lt.${iso(aEnd)}),and(revised_deadline.is.null,deadline.gte.${iso(aStart)},deadline.lt.${iso(aEnd)}))`;
  const [pr, settings, dr, ppr, spr] = await Promise.all([
    planRows(auth, env),
    weekSettings(env),
    sbPodium(`/rest/v1/departments?select=id,name&order=name.asc`, env),
    sbAll(sbDocket, `/rest/v1/plan_proposals?kind_hint=eq.risk&or=(status.eq.submitted,and(created_at.gte.${riskFrom},created_at.lt.${riskTo}))&select=id,title,why,status,suggested_theme_id,proposer_user_id,created_at&order=created_at.desc,id.asc`, env),
    sbAll(sbDocket, `/rest/v1/spaces?archived_at=not.is.null&select=id&order=id.asc`, env),
  ]);
  if (!pr.ok || !dr.ok || !ppr.ok || !spr.ok) return err('db_error', 500);
  const rows = Array.isArray(pr.data) ? pr.data : [];
  const byId = new Map(rows.map(i => [i.id, i]));
  const deptNames = Object.fromEntries((dr.data || []).map(d => [d.id, d.name]));
  const ms = rows.filter(i => i.kind === 'milestone' && (i.state === 'agreed' || i.state === 'proposed')
    && effectiveDue(i) && effectiveDue(i) >= mo.first && effectiveDue(i) <= mo.last);
  const resultsOf = {};
  for (const i of rows) if (i.kind === 'result' && i.parent_id && i.state !== 'dropped') (resultsOf[i.parent_id] = resultsOf[i.parent_id] || []).push(i.id);
  const linkIds = uniq(ms.flatMap(m => [m.id, ...(resultsOf[m.id] || [])]));
  const weekEnds = weekEndsIn(mo.prevFirst, mo.prevLast, settings.week_end_dow).filter(we => we < today);
  const [tr, er, wr] = await Promise.all([
    sbInAll(sbDocket, linkIds, l => `/rest/v1/tasks?plan_item_id=in.${l}&parent_task_id=is.null&archived_at=is.null&is_recurring=eq.false&${PW_OPEN}&${inWin}&select=id,status,plan_item_id,parent_task_id,space_id,deadline,revised_deadline&order=id.asc`, env),
    sbIn(sbPodium, uniq(ms.map(m => m.owner_employee_id)), l => `/rest/v1/employees?id=in.${l}&select=id,full_name,department_id,status`, env),
    weekEnds.length ? sbDocket(`/rest/v1/weeks?week_end=in.${inList(weekEnds)}&closed_at=not.is.null&select=week_end&order=week_end.asc`, env) : Promise.resolve({ ok: true, data: [] }),
  ]);
  if (!tr.ok || !er.ok || !wr.ok) return err('db_error', 500);
  const archived = new Set((spr.data || []).map(x => x.id));
  // Level F counts every linked task (§5.3 rollups) — except one in an archived space, which nobody will work.
  const tasks = (tr.data || []).filter(t => !archived.has(t.space_id) && (() => {
    const e = Date.parse(t.revised_deadline || t.deadline || '');
    return Number.isFinite(e) && e >= aStart && e < aEnd;
  })());
  const emp = Object.fromEntries((er.data || []).map(e => [e.id, e]));
  const activeOwners = new Set((er.data || []).filter(e => e.status === 'active').map(e => e.id));
  const closed = (wr.data || []).map(w => w.week_end);
  const sr = await Promise.all(closed.map(we => sbDocket(`/rest/v1/rpc/week_score`, env, { method: 'POST', body: JSON.stringify({ p_date: we }) })));
  if (sr.some(r => !r.ok)) return err('db_error', 500);
  const pnames = await nameMap(sbStore, 'users_profile', (ppr.data || []).map(p => p.proposer_user_id), env);
  const metrics = publicMetrics();
  const milestones = ms.map(m => {
    const team = m.department_id || emp[m.owner_employee_id]?.department_id || null;
    return { id: m.id, code: m.code || null, title: m.title, state: m.state, effective_due: effectiveDue(m),
      owner_name: emp[m.owner_employee_id]?.full_name || null, team_id: team, team_name: team ? deptNames[team] || null : null,
      chips: { no_data_source: noDataSource(m, metrics), redated: !!m.revised_due_date, not_agreed: m.state !== 'agreed' },
      readiness: readiness(m, { activeOwners, tasks, resultIds: resultsOf[m.id] || [] }) };
  }).sort((a, b) => String(a.effective_due).localeCompare(String(b.effective_due)) || String(a.code || '').localeCompare(String(b.code || ''), undefined, { numeric: true }));
  const block = (b) => ({ on_time: Number(b?.on_time) || 0, cohort: Number(b?.cohort) || 0, pct: b && Number(b.cohort) > 0 && b.pct != null ? Number(b.pct) : null });
  const scores = closed.map((we, k) => sr[k].data || {}).filter(s => s.final).map(s => ({ week_end: s.week_end, overall: block(s.totals),
    teams: (Array.isArray(s.teams) ? s.teams : []).map(t => ({ id: t.department_id || null, name: t.department_id ? deptNames[t.department_id] || null : 'No team', ...block(t) })) }));
  const ready = milestones.filter(m => m.readiness.ready).length;
  return ok({
    month: mo.month, first: mo.first, last: mo.last,
    milestones,
    risks: (ppr.data || []).map(p => ({ id: p.id, title: p.title, why: p.why || null, status: p.status, created_at: p.created_at,
      proposer_name: pnames[p.proposer_user_id] || null,
      suggested_theme_title: p.suggested_theme_id ? byId.get(p.suggested_theme_id)?.title || null : null })),
    scores: { month: mo.prev, weeks: scores },
    counts: { milestones: milestones.length, ready, not_ready: milestones.length - ready },
  });
}

// ── F9 R9a: plan templates (spec §11; migration 0028) ────────────────────────
// Every write is a docket.plan_template_* RPC (save / archive / apply — rights and shape decided there; apply
// creates every node through plan_create + the task triggers in ONE transaction). Reads: `founders` templates
// to a plan admin only; `leads` to a plan admin or a lead (docket.plan_is_lead — owns an agreed milestone or
// result); nobody else sees any. Non-editors get the title-only PREVIEW of the nodes (spec "Previews show only
// node titles") plus the roles and span needed to apply. RPC codes → TEMPLATE_ERR (status + a readable message).
const TEMPLATE_ERR = {
  forbidden: [403, "You can't create or change this template."],
  not_found: [404, 'Template not found.'],
  archived: [409, 'This template is archived — restore it first.'],
  name_required: [400, 'Give the template a name.'],
  name_too_long: [400, 'The name is too long (120 characters at most).'],
  description_too_long: [400, 'The description is too long (2,000 characters at most).'],
  bad_audience: [400, 'Choose who the template is for: founders or leads.'],
  bad_node: [400, 'A step is incomplete — check its title (1–300 characters) and its fields.'],
  bad_shape: [400, "A step can't sit there: founders templates start with milestones, leads templates with results or tasks, and tasks have nothing under them."],
  too_many_nodes: [400, 'A template can have at most 200 steps.'],
  done_when_required: [400, 'Add "done when" — every result needs one, and so does a milestone with steps under it.'],
  role_required: [400, 'Give every step a role (up to 40 characters).'],
  bad_offset: [400, 'Day offsets run from -365 to 730.'],
  duplicate_key: [400, 'Two steps share the same key.'],
  bad_anchor: [400, 'Pick an agreed theme (founders template) or an agreed milestone (leads template).'],
  anchor_not_found: [404, "That theme or milestone isn't available to you."],
  role_unmapped: [400, 'Pick a person for every role.'],
  owner_inactive: [400, 'That person has left — pick someone else for this role.'],
  bad_role: [400, "That role isn't in this template."],
  bad_date: [400, 'Pick a valid start date.'],
  bad_source: [400, 'Bad request source.'],
  forbidden_space: [403, "You can't add tasks to that space — nothing was created."],
  founders_space_missing: [409, "The Founders' space is missing, so tasks under a restricted theme can't be created."],
  // plan_create / trigger codes an apply can stop on (nothing was created)
  parent_not_agreed: [409, 'A milestone above this step is not agreed — nothing was created.'],
  parent_not_found: [404, "A parent item isn't available to you — nothing was created."],
  missing_fields: [400, 'A step is missing a date or "done when" — nothing was created.'],
  owner_not_found: [400, "A role's person wasn't found — nothing was created."],
  forbidden_field: [403, "You can't set that on a plan item — nothing was created."],
  duplicate_code: [409, 'A plan code clashed — try again; nothing was created.'],
  plan_item_closed: [422, 'A plan item closed while applying — nothing was created.'],
  restricted_needs_founders_space: [422, "Tasks under a restricted theme must sit in the Founders' space — nothing was created."],
};
function templateErr(res) {
  const code = String(res?.code || 'apply_failed');
  const [status, message] = TEMPLATE_ERR[code] || [400, "The template couldn't be applied — nothing was created."];
  const extra = {}; for (const k of ['key', 'label', 'fields']) if (res?.[k] != null) extra[k] = res[k];
  return json({ ok: false, error: code, message, ...extra }, status);
}
async function templateRpc(fn, args, env) {
  const r = await sbDocket(`/rest/v1/rpc/${fn}`, env, { method: 'POST', body: JSON.stringify(args) });
  if (!r.ok) return { error: err('db_error', 500) };
  const res = r.data || {};
  return res.ok ? { data: res } : { error: templateErr(res) };
}
// The caller's template rights: plan admin (everything), lead (leads templates), or neither (nothing).
async function templateAccess(auth, env) {
  const isSuper = isPlanAdmin(auth);
  if (isSuper) return { isSuper, lead: true };
  if (!auth.employeeId) return { isSuper, lead: false };
  const r = await sbDocket(`/rest/v1/rpc/plan_is_lead`, env, { method: 'POST', body: JSON.stringify({ p_employee: auth.employeeId }) });
  return { isSuper, lead: r.ok && r.data === true };
}
const TEMPLATE_COLS = 'id,name,description,audience,created_by,archived_at,created_at,updated_at';
async function templateRows(acc, filter, env) {
  if (!acc.isSuper && !acc.lead) return { ok: true, data: [] };
  return sbAll(sbDocket, `/rest/v1/plan_templates?${acc.isSuper ? '' : 'audience=eq.leads&'}${filter}select=${TEMPLATE_COLS}&order=name.asc,id.asc`, env);
}
async function templateListRows(rows, auth, acc, env) {
  const nr = await sbInAll(sbDocket, rows.map(t => t.id),
    l => `/rest/v1/plan_template_nodes?template_id=in.${l}&select=id,template_id,role_label,offset_days&order=id.asc`, env);
  if (!nr.ok) return null;
  const byT = {}; for (const n of nr.data || []) (byT[n.template_id] = byT[n.template_id] || []).push(n);
  const names = await nameMap(sbStore, 'users_profile', rows.map(t => t.created_by), env);
  return rows.map(t => templateListRow(t, byT[t.id] || [], { names, auth, acc }));
}
async function getTemplates(url, auth, env) {
  const acc = await templateAccess(auth, env);
  const withArchived = url.searchParams.get('archived') === '1';
  const tr = await templateRows(acc, withArchived ? '' : 'archived_at=is.null&', env);
  if (!tr.ok) return err('db_error', 500);
  // archived=1 adds the archived ones the caller can EDIT (super, or their own).
  const rows = (tr.data || []).filter(t => !t.archived_at || acc.isSuper || t.created_by === auth.userId);
  const list = await templateListRows(rows, auth, acc, env);
  if (!list) return err('db_error', 500);
  return ok({ templates: list, can_create: { founders: acc.isSuper, leads: acc.isSuper || acc.lead } });
}
async function getTemplate(url, auth, env) {
  const id = url.searchParams.get('id');
  if (!isUuid(id || '')) return err('not_found', 404);
  const acc = await templateAccess(auth, env);
  const tr = await templateRows(acc, `id=eq.${enc(id)}&`, env);
  if (!tr.ok) return err('db_error', 500);
  const t = (tr.data || [])[0];
  // An archived template is shown only to who may restore it (as the list).
  if (!t || (t.archived_at && !acc.isSuper && t.created_by !== auth.userId)) return err('not_found', 404);
  const nr = await sbAll(sbDocket, `/rest/v1/plan_template_nodes?template_id=eq.${enc(id)}&select=id,parent_node_id,kind,title,role_label,offset_days,done_when,sort&order=sort.asc,id.asc`, env);
  if (!nr.ok) return err('db_error', 500);
  const nodes = nr.data || [];
  const names = await nameMap(sbStore, 'users_profile', [t.created_by], env);
  const row = templateListRow(t, nodes, { names, auth, acc });
  return ok({ template: row, nodes: templateNodesFor(nodes, row.can_edit) });
}
async function saveTemplate(body, auth, env) {
  const d = body.data || body;
  const t = d.template;
  if (!t || typeof t !== 'object' || Array.isArray(t)) return templateErr({ code: 'bad_node' });
  const r = await templateRpc('plan_template_save', { ...planArgs(auth), p_template: t }, env);
  return r.error || ok({ id: r.data.id });
}
async function archiveTemplate(body, auth, env) {
  const d = body.data || body;
  if (!isUuid(String(d.id || ''))) return templateErr({ code: 'not_found' });
  if (d.archive !== undefined && typeof d.archive !== 'boolean') return err('bad_archive', 400);
  const r = await templateRpc('plan_template_archive', { p_actor: auth.userId, p_is_super: isPlanAdmin(auth), p_id: d.id,
    p_archive: d.archive !== false }, env);
  return r.error || ok({ id: d.id, archived: r.data.archived });
}
// POST { action:'applyTemplate', id, anchor_id, anchor_date, roles, space_id? } — everything or nothing (the RPC).
// P3b: tasks land in the space the caller picks (one they can open, not archived); none → their team's home space,
// else their Personal space. A restricted theme still puts them in the Founders' space (the RPC decides that).
async function applyTemplate(body, auth, env) {
  const d = body.data || body;
  if (!isUuid(String(d.id || ''))) return templateErr({ code: 'not_found' });
  if (d.roles != null && (typeof d.roles !== 'object' || Array.isArray(d.roles))) return templateErr({ code: 'bad_role' });
  let spaceId = d.space_id || null;   // '' = none, as on create
  if (spaceId) {
    const sp = isUuid(String(spaceId)) ? await loadSpace(spaceId, env) : null;
    if (!sp || sp.archived_at || !(await canWriteSpace(auth, sp, env))) return templateErr({ code: 'forbidden_space' });
  } else {
    spaceId = await defaultTargetSpace(auth, auth.departmentId, env);
    if (!spaceId) return err('no_default_space', 500);
  }
  const r = await templateRpc('plan_template_apply', { ...planArgs(auth), p_template_id: d.id,
    p_payload: { anchor_id: d.anchor_id ?? null, anchor_date: d.anchor_date ?? null, roles: d.roles || {}, space_id: spaceId },
    p_source: auth.source || 'app' }, env);
  return r.error || ok({ items: r.data.items || [], tasks: r.data.tasks || [] });
}

// ════════════════════════════════════════════════════════════════════════════
// F8 P2 — record checklists (spec 2026-11-11-docket-checklists-v2.md §3.2–3.4, decisions C3–C6; migration 0032)
// A record is a copy of a kind='record' template for one subject ("Launch: Badger"). VISIBILITY = its space,
// exactly like a task: by id through loadSpace + canAccessSpace (an archived private space stays readable by
// its members — decisions 2026-11-13), lists through accessibleSpaces, tasks shown on it through
// visibleTaskRows. A record in a space you can't open is a 404 by id, absent from lists, and on a task only a
// count ("1 checklist you can't see"). Ticking (setRecordItemState), adding an item and pulling template
// updates = anyone who can see it (C6). Title / owner / product / archive = the record's owner, its creator or
// a docket_admin (RULE-DOCKET-009's edit pattern). Completion AND every history row are the DB triggers' (0032)
// — a change and its history commit together; the worker only stamps the actor (updated_by_user_id /
// created_by_user_id / removed_by_user_id) in the same write. Arithmetic is records-core.mjs.
// LINK RULE: a task ↔ record link needs the record visible, edit rights on the task (as F7 dependencies), and
// the record in the task's own space or in General — so a private / Founders' record is never named on a task
// outside its space (link_cross_space). Moving a linked task (or an item's task, or a sub-task moving with its
// parent) to a space where that no longer holds is refused (record_link_space — moveTask / bulkMoveTasks).
// Every read whose emptiness would drive a write is checked: a failed read aborts, never reads as "nothing".
// ════════════════════════════════════════════════════════════════════════════
const sbPublic = sbProfile('public');
const RECORD_COLS = 'id,template_id,template_version,title,product,space_id,owner_employee_id,status,created_by_user_id,created_at,updated_at,completed_at,archived_at';
const RECORD_TASK_COLS = PW_TASK_COLS + ',archived_at';
const dbErr = (r) => err('db_error: ' + JSON.stringify(r?.data ?? null), 500);
// The record the caller may open by id → { rec, space } | null (→ 404, no existence leak).
async function loadRecordFor(id, auth, env) {
  if (!isUuid(String(id || ''))) return null;
  const r = await sbDocket(`/rest/v1/checklist_records?id=eq.${enc(id)}&select=${RECORD_COLS}&limit=1`, env);
  const rec = r.ok && r.data?.[0];
  if (!rec) return null;
  const space = await loadSpace(rec.space_id, env);
  if (!space || !(await canAccessSpace(auth, space, env))) return null;
  return { rec, space };
}
// `adminHere` = adminActsIn for the record's space (P3a: a plan admin's team-space access is see-only).
function canEditRecord(auth, rec, adminHere) {
  return !!adminHere || rec.created_by_user_id === auth.userId || (!!auth.employeeId && rec.owner_employee_id === auth.employeeId);
}
// A write the 0032 trigger refused because the record is archived → 409; anything else → 400.
function recordWriteErr(prefix, r) {
  if (/record_archived/.test(JSON.stringify(r?.data ?? ''))) return err('record_archived', 409);
  return err(prefix + JSON.stringify(r?.data ?? null), 400);
}
// Item states of many records (paged) → { [record_id]: [{state}] } | null on a failed read.
async function recordItemStates(recordIds, env) {
  const r = await sbInAll(sbDocket, recordIds, l => `/rest/v1/checklist_record_items?record_id=in.${l}&select=record_id,state&order=id.asc`, env);
  if (!r.ok) return null;
  const by = {}; (r.data || []).forEach(i => { (by[i.record_id] ||= []).push(i); });
  return by;
}
// → true | false | null (the read failed)
async function productExists(product, env) {
  const r = await sbPublic(`/rest/v1/product_master?product=eq.${enc(product)}&select=product&limit=1`, env);
  return r.ok ? !!r.data?.length : null;
}
async function activeEmployee(id, env) {
  if (!isUuid(String(id || ''))) return false;
  const r = await sbPodium(`/rest/v1/employees?id=eq.${enc(id)}&status=eq.active&select=id&limit=1`, env);
  return r.ok ? !!r.data?.length : null;
}
const progressOf = (items) => { const p = recordProgress(items); return { ...p, label: progressLabel(p) }; };
// Record titles behind the gate, for task_history rows naming a record (field 'checklist') → { id: title }.
async function checklistLabels(ids, auth, env) {
  if (!ids.length) return {};
  const rr = await sbIn(sbDocket, ids, l => `/rest/v1/checklist_records?id=in.${l}&select=id,title,space_id`, env);
  const vis = await keepAccessible(auth, (rr.ok && rr.data) || [], env, { involvement: false });   // fails closed → "a checklist you can't see"
  const out = {}; vis.forEach(r => { out[r.id] = r.title; });
  return out;
}

// moveTask / bulkMoveTasks: which of these top-level tasks may NOT move to `targetSpaceId`, because they — or a
// sub-task that moves with them — are linked to a record, or are a record item's task, whose space is neither
// General nor the target. Batched (children, links, item tasks, records, spaces). → { blocked: Set } | { error }
async function recordMoveBlocks(rootIds, targetSpaceId, env) {
  if (!rootIds.length) return { blocked: new Set() };
  const kr = await sbInAll(sbDocket, rootIds, l => `/rest/v1/tasks?parent_task_id=in.${l}&select=id,parent_task_id&order=id.asc`, env);
  if (!kr.ok) return { error: dbErr(kr) };
  const rootOf = new Map(rootIds.map(id => [id, id]));
  (kr.data || []).forEach(k => rootOf.set(k.id, k.parent_task_id));
  const all = [...rootOf.keys()];
  const [lr, ir] = await Promise.all([
    sbInAll(sbDocket, all, l => `/rest/v1/task_checklist_links?task_id=in.${l}&select=task_id,record_id&order=id.asc`, env),
    sbInAll(sbDocket, all, l => `/rest/v1/checklist_record_items?task_id=in.${l}&select=task_id,record_id&order=id.asc`, env),
  ]);
  if (!lr.ok) return { error: dbErr(lr) };
  if (!ir.ok) return { error: dbErr(ir) };
  const pairs = [...(lr.data || []), ...(ir.data || [])];
  if (!pairs.length) return { blocked: new Set() };
  const rr = await sbIn(sbDocket, uniq(pairs.map(p => p.record_id)), l => `/rest/v1/checklist_records?id=in.${l}&select=id,space_id`, env);
  if (!rr.ok) return { error: dbErr(rr) };
  const sr = await sbIn(sbDocket, uniq((rr.data || []).map(r => r.space_id)), l => `/rest/v1/spaces?id=in.${l}&select=id,is_default`, env);
  if (!sr.ok) return { error: dbErr(sr) };
  const general = new Set((sr.data || []).filter(s => s.is_default).map(s => s.id));
  const recSpace = new Map((rr.data || []).map(r => [r.id, r.space_id]));
  const blocked = new Set();
  for (const p of pairs) {
    const sp = recSpace.get(p.record_id);
    if (!sp || !linkAllowed({ id: sp, is_default: general.has(sp) }, targetSpaceId)) blocked.add(rootOf.get(p.task_id));
  }
  return { blocked };
}
const RECORD_LINK_SPACE = 'record_link_space: this task (or a sub-task) is tied to a record checklist in another space — it can move only to that space, or the checklist must be in General';

// GET ?action=getChecklistRecords[&template_id][&product][&status=open|complete|archived|all][&owner_employee_id][&q][&limit]
// Default status: everything but archived. q matches title or product (⌘K / + Link checklist).
async function getChecklistRecords(url, auth, env) {
  const q = url.searchParams;
  const spaces = await accessibleSpaces(auth, env);
  if (!spaces.length) return ok([]);
  const spaceName = {}; spaces.forEach(s => { spaceName[s.id] = s.name; });
  let path = `/rest/v1/checklist_records?space_id=in.${inList(spaces.map(s => s.id))}&select=${RECORD_COLS}`;
  const status = q.get('status');
  if (status === 'all') { /* every status */ }
  else if (RECORD_STATUSES.includes(status)) path += `&status=eq.${status}`;
  else path += `&status=neq.archived`;
  if (isUuid(q.get('template_id') || '')) path += `&template_id=eq.${enc(q.get('template_id'))}`;
  if (isUuid(q.get('owner_employee_id') || '')) path += `&owner_employee_id=eq.${enc(q.get('owner_employee_id'))}`;
  if (q.get('product')) path += `&product=eq.${enc(q.get('product'))}`;
  const term = searchTerm(q.get('q'));
  if (term) path += `&or=(title.ilike.*${enc(term)}*,product.ilike.*${enc(term)}*)`;
  const limit = Math.min(Math.max(Math.round(Number(q.get('limit')) || 200), 1), 200);
  const r = await sbDocket(`${path}&order=created_at.desc&limit=${limit}`, env);
  if (!r.ok) return dbErr(r);
  const rows = r.data || [];
  if (!rows.length) return ok([]);
  const [states, tRes, eRes] = await Promise.all([
    recordItemStates(rows.map(x => x.id), env),
    sbIn(sbDocket, uniq(rows.map(x => x.template_id)), l => `/rest/v1/checklist_templates?id=in.${l}&select=id,name,version`, env),
    sbIn(sbPodium, uniq(rows.map(x => x.owner_employee_id)), l => `/rest/v1/employees?id=in.${l}&select=id,full_name`, env),
  ]);
  if (!states) return err('db_error: item states', 500);
  const tmpl = {}; ((tRes.ok && tRes.data) || []).forEach(t => { tmpl[t.id] = t; });
  const emp = {}; ((eRes.ok && eRes.data) || []).forEach(e => { emp[e.id] = e.full_name; });
  const adminIn = await adminSpaceIds(auth, spaces, env);
  return ok(rows.map(x => ({ ...x, space_name: spaceName[x.space_id] || null, template_name: tmpl[x.template_id]?.name || null,
    owner_name: emp[x.owner_employee_id] || null, progress: progressOf(states[x.id] || []), _can_edit: canEditRecord(auth, x, adminIn.has(x.space_id)) })));
}

// GET ?action=getChecklistProducts — the product_master family names for the optional product picker (C5).
async function getChecklistProducts(url, auth, env) {
  const r = await sbAll(sbPublic, `/rest/v1/product_master?is_active=eq.true&select=product&order=product.asc`, env);
  if (!r.ok) return dbErr(r);
  return ok(uniq((r.data || []).map(p => p.product)));
}

// GET ?action=getChecklistRecord&id= — the record, its items (who/when, the spun-out task behind the task gate,
// the C4 tick suggestion, "no longer in template"), linked tasks (hidden ones as a count), template updates
// (C3, matched by source_item_id; offered only while the record is open) and history (task ids → task_no only
// when visible).
async function getChecklistRecord(url, auth, env) {
  const got = await loadRecordFor(url.searchParams.get('id'), auth, env);
  if (!got) return err('not_found', 404);
  const { rec, space } = got;
  const [itRes, lkRes, hiRes, tmpl, secs] = await Promise.all([
    sbAll(sbDocket, `/rest/v1/checklist_record_items?record_id=eq.${enc(rec.id)}&select=*&order=sort_order.asc,created_at.asc,id.asc`, env),
    sbAll(sbDocket, `/rest/v1/task_checklist_links?record_id=eq.${enc(rec.id)}&select=id,task_id,created_at&order=created_at.asc,id.asc`, env),
    sbDocket(`/rest/v1/checklist_record_history?record_id=eq.${enc(rec.id)}&select=*&order=at.desc,seq.desc&limit=100`, env),
    loadTemplate(rec.template_id, env),
    templateSections(rec.template_id, env),
  ]);
  for (const r of [itRes, lkRes, hiRes]) if (!r.ok) return dbErr(r);
  if (!secs) return err('db_error: template', 500);
  const items = itRes.data || [];
  const links = lkRes.data || [];
  const diff = templateDiff(flattenTemplate(secs), items);
  const gone = new Set(diff.removed);
  const hist = hiRes.data || [];
  // Every task the page names (linked, spun out, in history), through the getTask gate, batched.
  const taskIds = uniq([...links.map(l => l.task_id), ...items.map(i => i.task_id), ...hist.map(h => h.detail?.task_id).filter(v => isUuid(v || ''))]);
  const tRes = await sbIn(sbDocket, taskIds, l => `/rest/v1/tasks?id=in.${l}&select=${RECORD_TASK_COLS}`, env);
  if (!tRes.ok) return dbErr(tRes);
  const visible = await visibleTaskRows(auth, tRes.data || [], env);
  const userIds = uniq([rec.created_by_user_id, ...items.map(i => i.done_by_user_id), ...hist.map(h => h.actor_user_id)]);
  const [eRes, uRes] = await Promise.all([
    sbIn(sbPodium, uniq([rec.owner_employee_id, ...visible.map(t => t.owner_employee_id)]), l => `/rest/v1/employees?id=in.${l}&select=id,full_name`, env),
    sbIn(sbStore, userIds, l => `/rest/v1/users_profile?id=in.${l}&select=id,full_name`, env),
  ]);
  const emp = {}; ((eRes.ok && eRes.data) || []).forEach(e => { emp[e.id] = e.full_name; });
  const usr = {}; ((uRes.ok && uRes.data) || []).forEach(u => { usr[u.id] = u.full_name; });
  const card = {};
  visible.forEach(t => { card[t.id] = { id: t.id, task_no: t.task_no, title: t.title, status: t.status, owner_name: emp[t.owner_employee_id] || null }; });
  const linkedIds = new Set(links.map(l => l.task_id));
  // A history row naming a task carries its id only — its number shown when visible, never its title.
  const histOut = hist.map(h => {
    const tid = h.detail?.task_id;
    const detail = tid ? (card[tid] ? { task_no: card[tid].task_no } : { hidden_task: true }) : h.detail;
    return { ...h, detail, actor_name: usr[h.actor_user_id] || null };
  });
  return ok({
    ...rec,
    space: { id: space.id, name: space.name, is_private: !!space.is_private, is_founders: !!space.is_founders },
    template: tmpl ? { id: tmpl.id, name: tmpl.name, version: Number(tmpl.version) || 1, archived: !!tmpl.archived_at } : null,
    owner_name: emp[rec.owner_employee_id] || null,
    creator_name: usr[rec.created_by_user_id] || null,
    progress: progressOf(items),
    template_updates: { new_items: diff.missing.length, version: Number(tmpl?.version) || 1 },
    template_has_updates: diff.missing.length > 0 && rec.status === 'open',
    items: items.map(i => {
      const c = i.task_id ? card[i.task_id] : null;
      return { ...i, task_id: c ? i.task_id : null, task: c || (i.task_id ? { hidden: true } : null),
        done_by_name: usr[i.done_by_user_id] || null, no_longer_in_template: gone.has(i.id), suggest_tick: suggestTick(i, c) };
    }),
    // can_edit: unlinking needs edit rights on the task (linkEnds); the page shows ✕ only then.
    linked_tasks: links.filter(l => card[l.task_id]).map(l => ({ link_id: l.id, ...card[l.task_id],
      can_edit: canEditTask(auth, visible.find(t => t.id === l.task_id)) })),
    linked_hidden: [...linkedIds].filter(id => !card[id]).length,
    history: histOut,
    _can_edit: canEditRecord(auth, rec, await adminActsIn(auth, space, env)),
    _can_tick: rec.status !== 'archived',
  });
}

// getTask's Checklists strip: the records linked to a task, the visible ones with progress, the rest a count.
// → { list, hidden } | { error }
async function taskChecklists(taskId, auth, env) {
  const lr = await sbAll(sbDocket, `/rest/v1/task_checklist_links?task_id=eq.${enc(taskId)}&select=record_id&order=record_id.asc`, env);
  if (!lr.ok) return { error: dbErr(lr) };
  const ids = uniq((lr.data || []).map(l => l.record_id));
  if (!ids.length) return { list: [], hidden: 0 };
  const rr = await sbIn(sbDocket, ids, l => `/rest/v1/checklist_records?id=in.${l}&select=${RECORD_COLS}`, env);
  if (!rr.ok) return { error: dbErr(rr) };
  const vis = await keepAccessible(auth, rr.data || [], env, { involvement: false });   // records, not tasks; fails closed → all hidden
  const states = await recordItemStates(vis.map(r => r.id), env);
  if (!states) return { error: err('db_error: item states', 500) };
  const list = vis.map(r => {
    const p = progressOf(states[r.id] || []);
    return { record_id: r.id, title: r.title, product: r.product, status: r.status, done: p.done, na: p.na, total: p.total, label: p.label };
  }).sort((a, b) => a.title.localeCompare(b.title));
  return { list, hidden: ids.length - vis.length };
}

// POST createChecklistRecord { template_id, title, product?, space_id?, owner_employee_id? } — snapshots the
// template's items (later template edits never rewrite it). Space default General; the caller must open it.
async function createChecklistRecord(body, auth, env) {
  const d = body.data || body;
  const title = String(d.title || '').trim();
  if (!title) return err('title required', 400);
  if (title.length > RECORD_TITLE_MAX) return err('title_too_long', 400);
  if (!isUuid(String(d.template_id || ''))) return err('template_id required', 400);
  const tmpl = await loadTemplate(d.template_id, env);
  if (!tmpl) return err('template_not_found', 404);
  if (tmpl.kind !== 'record') return err('not_a_record_template', 422);
  if (!tmpl.is_active || tmpl.archived_at) return err('template_inactive', 422);
  // P3b: no space named → the owner's team's home space, else the caller's Personal (as a task).
  const spaceId = d.space_id || await defaultTargetSpace(auth,
    d.owner_employee_id ? await employeeDept(d.owner_employee_id, env) : auth.departmentId, env);
  const space = spaceId ? await loadSpace(spaceId, env) : null;
  if (!space) return err('space_not_found', 404);
  if (!(await canWriteSpace(auth, space, env))) return err('forbidden_space', 403);
  if (space.archived_at) return err('space_archived', 422);
  const product = d.product == null ? '' : String(d.product).trim();
  if (product) { const ex = await productExists(product, env); if (ex === null) return err('db_error: product', 500); if (!ex) return err('unknown_product', 400); }
  const owner = d.owner_employee_id || auth.employeeId || null;
  if (d.owner_employee_id) { const ex = await activeEmployee(d.owner_employee_id, env); if (ex === null) return err('db_error: owner', 500); if (!ex) return err('bad_owner', 400); }
  const secs = await templateSections(tmpl.id, env);
  if (!secs) return err('db_error: template', 500);   // never a record copied from a half-read template
  const flat = flattenTemplate(secs);
  const ins = await sbDocket(`/rest/v1/checklist_records`, env, { method: 'POST', body: JSON.stringify([{
    template_id: tmpl.id, template_version: Number(tmpl.version) || 1, title, product: product || null,
    space_id: space.id, owner_employee_id: owner, created_by_user_id: auth.userId, updated_by_user_id: auth.userId }]) });
  const rec = ins.ok && ins.data?.[0];
  if (!rec) return err('create_failed: ' + JSON.stringify(ins.data), 400);
  if (flat.length) {
    const ir = await sbDocket(`/rest/v1/checklist_record_items`, env, { method: 'POST', prefer: 'return=minimal',
      body: JSON.stringify(snapshotRows(rec.id, flat, 'snapshot').map(x => ({ ...x, updated_by_user_id: auth.userId }))) });
    if (!ir.ok) {   // no half-made record: the copy is the template's items or nothing
      const del = await sbDocket(`/rest/v1/checklist_records?id=eq.${enc(rec.id)}`, env, { method: 'DELETE', prefer: 'return=minimal' });
      return err(`create_failed${del.ok ? '' : ` (and the empty record ${rec.id} could not be removed)`}: ` + JSON.stringify(ir.data), del.ok ? 400 : 500);
    }
  }
  return ok({ id: rec.id });
}

// POST updateChecklistRecord { id, title?, product?, owner_employee_id?, archived? } — owner / creator / admin.
async function updateChecklistRecord(body, auth, env) {
  const d = body.data || body;
  const got = await loadRecordFor(d.id, auth, env);
  if (!got) return err('not_found', 404);
  const { rec, space } = got;
  if (!canEditRecord(auth, rec, await adminActsIn(auth, space, env))) return err('forbidden', 403);
  const patch = {};
  if (d.title !== undefined) {
    const t = String(d.title || '').trim();
    if (!t) return err('title required', 400);
    if (t.length > RECORD_TITLE_MAX) return err('title_too_long', 400);
    if (t !== rec.title) patch.title = t;
  }
  if (d.product !== undefined) {
    const p = d.product == null ? '' : String(d.product).trim();
    if (p) { const ex = await productExists(p, env); if (ex === null) return err('db_error: product', 500); if (!ex) return err('unknown_product', 400); }
    if ((p || null) !== rec.product) patch.product = p || null;
  }
  if (d.owner_employee_id !== undefined) {
    const o = d.owner_employee_id || null;
    if (o) { const ex = await activeEmployee(o, env); if (ex === null) return err('db_error: owner', 500); if (!ex) return err('bad_owner', 400); }
    if (o !== rec.owner_employee_id) patch.owner_employee_id = o;
  }
  if (d.archived !== undefined) {
    const want = d.archived === true || d.archived === 'true';
    if (want && rec.status !== 'archived') Object.assign(patch, { status: 'archived', archived_at: nowIso() });
    else if (!want && rec.status === 'archived') {
      const states = await recordItemStates([rec.id], env);
      if (!states) return err('db_error: item states', 500);   // never re-open / clear completed_at on a failed read
      const st = unarchivedStatus(states[rec.id] || []);
      Object.assign(patch, { status: st, archived_at: null, completed_at: st === 'complete' ? (rec.completed_at || nowIso()) : null });
    }
  }
  if (!Object.keys(patch).length) return ok({ id: rec.id, changed: false });
  // The 0032 trigger logs each changed field with updated_by_user_id, in this same statement.
  const r = await sbDocket(`/rest/v1/checklist_records?id=eq.${enc(rec.id)}`, env, { method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({ ...patch, updated_by_user_id: auth.userId, updated_at: nowIso() }) });
  if (!r.ok) return err('update_failed: ' + JSON.stringify(r.data), 400);
  return ok({ id: rec.id, changed: true });
}

// An item + the record it belongs to, if the caller can open the record.
async function loadRecordItemFor(itemId, auth, env) {
  if (!isUuid(String(itemId || ''))) return null;
  const r = await sbDocket(`/rest/v1/checklist_record_items?id=eq.${enc(itemId)}&select=*&limit=1`, env);
  const item = r.ok && r.data?.[0];
  if (!item) return null;
  const got = await loadRecordFor(item.record_id, auth, env);
  return got ? { item, ...got } : null;
}

// POST setRecordItemState { item_id, state?: open|done|na, na_reason?, note? } — anyone who can see the record
// (C6). The triggers log it and complete / re-open the record; the answer carries its status after the write.
async function setRecordItemState(body, auth, env) {
  const d = body.data || body;
  const got = await loadRecordItemFor(d.item_id, auth, env);
  if (!got) return err('not_found', 404);
  const { item, rec } = got;
  if (rec.status === 'archived') return err('record_archived', 409);
  const p = itemStatePatch(d, item, auth.userId, nowIso());
  if (p.error) return err(p.error, 400);
  if (!p.patch) return ok({ item_id: item.id, state: item.state, record_status: rec.status, changed: false });
  const r = await sbDocket(`/rest/v1/checklist_record_items?id=eq.${enc(item.id)}`, env, { method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({ ...p.patch, updated_by_user_id: auth.userId, updated_at: nowIso() }) });
  if (!r.ok) return recordWriteErr('update_failed: ', r);
  const after = await sbDocket(`/rest/v1/checklist_records?id=eq.${enc(rec.id)}&select=status&limit=1`, env);
  return ok({ item_id: item.id, state: p.patch.state ?? item.state, record_status: (after.ok && after.data?.[0]?.status) || null, changed: true });
}

// POST addRecordItem { record_id, title, section_title?, help_text? } — an item only this copy has.
async function addRecordItem(body, auth, env) {
  const d = body.data || body;
  const got = await loadRecordFor(d.record_id, auth, env);
  if (!got) return err('not_found', 404);
  const { rec } = got;
  if (rec.status === 'archived') return err('record_archived', 409);
  const title = String(d.title || '').trim();
  if (!title) return err('title required', 400);
  if (title.length > ITEM_TITLE_MAX) return err('title_too_long', 400);
  const section = d.section_title == null ? null : (String(d.section_title).trim() || null);
  const ex = await sbAll(sbDocket, `/rest/v1/checklist_record_items?record_id=eq.${enc(rec.id)}&select=section_title,sort_order&order=sort_order.asc,id.asc`, env);
  if (!ex.ok) return dbErr(ex);
  const rows = ex.data || [];
  const inSec = rows.filter(x => (x.section_title || null) === section).map(x => Number(x.sort_order));
  const all = rows.map(x => Number(x.sort_order));
  const sort = inSec.length ? Math.max(...inSec) + 1 : (all.length ? Math.max(...all) + 1000 : 0);
  const r = await sbDocket(`/rest/v1/checklist_record_items`, env, { method: 'POST', body: JSON.stringify([{
    record_id: rec.id, source_item_id: null, section_title: section, title, help_text: d.help_text ? String(d.help_text).trim() || null : null,
    sort_order: Math.round(sort), state: 'open', origin: 'added', updated_by_user_id: auth.userId }]) });
  if (!r.ok || !r.data?.[0]) return recordWriteErr('create_failed: ', r);
  return ok({ id: r.data[0].id });
}

// POST pullTemplateUpdates { record_id } — C3: copy only the template items this record is missing (by
// source_item_id). Never removes or un-ticks anything; a repeat adds nothing (UNIQUE record_id, source_item_id).
async function pullTemplateUpdates(body, auth, env) {
  const d = body.data || body;
  const got = await loadRecordFor(d.record_id, auth, env);
  if (!got) return err('not_found', 404);
  const { rec } = got;
  if (rec.status !== 'open') return err(rec.status === 'archived' ? 'record_archived' : 'record_complete', 409);
  const [tmpl, secs, ex] = await Promise.all([
    loadTemplate(rec.template_id, env), templateSections(rec.template_id, env),
    sbAll(sbDocket, `/rest/v1/checklist_record_items?record_id=eq.${enc(rec.id)}&select=id,source_item_id&order=id.asc`, env),
  ]);
  if (!tmpl) return err('template_not_found', 404);
  if (!secs) return err('db_error: template', 500);
  if (!ex.ok) return dbErr(ex);
  const { missing } = templateDiff(flattenTemplate(secs), ex.data || []);
  let added = 0;
  if (missing.length) {
    const r = await sbDocket(`/rest/v1/checklist_record_items?on_conflict=record_id,source_item_id`, env, {
      method: 'POST', prefer: 'return=representation,resolution=ignore-duplicates',
      body: JSON.stringify(snapshotRows(rec.id, missing, 'pull').map(x => ({ ...x, updated_by_user_id: auth.userId }))) });
    if (!r.ok) return recordWriteErr('pull_failed: ', r);
    added = Array.isArray(r.data) ? r.data.length : 0;
  }
  const version = Number(tmpl.version) || 1;
  const v = await sbDocket(`/rest/v1/checklist_records?id=eq.${enc(rec.id)}`, env, { method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({ template_version: version, updated_by_user_id: auth.userId, updated_at: nowIso() }) });
  if (!v.ok) return err(`version_failed (${added} item${added === 1 ? '' : 's'} added): ` + JSON.stringify(v.data), 500);
  return ok({ added, version });
}

// Insert a task ↔ record link (idempotent: a repeat adds nothing, and logs nothing — the trigger fires per
// inserted row). → { ok: true, inserted } | { error: r }
async function insertRecordLink(taskId, recordId, auth, env) {
  const r = await sbDocket(`/rest/v1/task_checklist_links?on_conflict=task_id,record_id`, env, { method: 'POST',
    prefer: 'return=representation,resolution=ignore-duplicates',
    body: JSON.stringify([{ task_id: taskId, record_id: recordId, created_by_user_id: auth.userId, source: auth.source || 'app' }]) });
  return r.ok ? { ok: true, inserted: Array.isArray(r.data) && r.data.length > 0 } : { error: r };
}

// POST createTaskFromRecordItem { item_id, title?, owner_employee_id?, deadline?, priority?, department_id?, description? }
// The task goes through createTaskCore (the createTask path: validation, source, deadline rules) in the
// record's space, owned by the caller and in the caller's department unless given (so General viewers of the
// record can see it); then record_item.task_id is set (only if still empty) and the task is linked to the
// record. Every write is checked; a failure after the task exists names it.
async function createTaskFromRecordItem(body, auth, env) {
  const d = body.data || body;
  const got = await loadRecordItemFor(d.item_id, auth, env);
  if (!got) return err('not_found', 404);
  const { item, rec } = got;
  if (rec.status === 'archived') return err('record_archived', 409);
  if (item.task_id) return err('item_has_task', 409);
  if (item.state !== 'open') return err('item_not_open', 422);
  const td = { title: String(d.title || '').trim() || `${item.title} — ${rec.title}`, space_id: rec.space_id,
    owner_employee_id: auth.employeeId || null, department_id: auth.departmentId || null };
  for (const k of ['owner_employee_id', 'deadline', 'priority', 'department_id', 'description']) if (d[k] !== undefined) td[k] = d[k];
  const res = await createTaskCore(td, auth, env);
  const j = await res.clone().json();
  if (!j.ok) return res;
  const task = j.data;
  const named = (code, status, extra = {}) => json({ ok: false, error: `${code}: created ${task.task_no}`, task_id: task.id, task_no: task.task_no, ...extra }, status);
  // Claim the item only while it has no task. The loser of a simultaneous create keeps its task, still linked
  // to the record (same space, so the link rule holds), and is told which task the item already has.
  const claim = await sbDocket(`/rest/v1/checklist_record_items?id=eq.${enc(item.id)}&task_id=is.null`, env, {
    method: 'PATCH', prefer: 'return=representation', body: JSON.stringify({ task_id: task.id, updated_by_user_id: auth.userId, updated_at: nowIso() }) });
  if (!claim.ok) return named('claim_failed', 500);
  const link = await insertRecordLink(task.id, rec.id, auth, env);
  if (link.error) return named('link_failed', 500);
  if (!claim.data?.length) {
    const cur = await sbDocket(`/rest/v1/checklist_record_items?id=eq.${enc(item.id)}&select=task_id&limit=1`, env);
    const otherId = cur.ok ? cur.data?.[0]?.task_id : null;
    let other = null;
    if (otherId) {
      const tr = await sbDocket(`/rest/v1/tasks?id=eq.${enc(otherId)}&select=${RECORD_TASK_COLS}&limit=1`, env);
      other = (await visibleTaskRows(auth, (tr.ok && tr.data) || [], env))[0] || null;
    }
    return json({ ok: false, error: 'item_has_task', task_id: task.id, task_no: task.task_no, other_task_no: other?.task_no || null }, 409);
  }
  return ok({ id: task.id, task_no: task.task_no, item_id: item.id });
}

// The task + record a link names → { task, rec, space } | { error }. The record must be visible and the caller
// must be able to EDIT the task (F7 dependencies' rule).
async function linkEnds(d, auth, env) {
  const task = isUuid(String(d.task_id || '')) ? await loadTaskFor(d.task_id, auth, env) : null;
  if (!task || !(await seesTask(auth, task, env))) return { error: err('task_not_found', 404) };
  if (!canEditTask(auth, task)) return { error: err('forbidden', 403) };
  const got = await loadRecordFor(d.record_id, auth, env);
  if (!got) return { error: err('record_not_found', 404) };
  return { task, ...got };
}
// POST linkTaskChecklist { task_id, record_id } — idempotent (a repeat is ok, already: true). The trigger writes
// the record's task_linked and the task's checklist_linked history rows in the same insert.
async function linkTaskChecklist(body, auth, env) {
  const d = body.data || body;
  const e = await linkEnds(d, auth, env);
  if (e.error) return e.error;
  if (e.task.status === 'abandoned') return abandonedRO();
  if (e.task.is_recurring) return err('recurring_task: a recurring (checklist) task takes no record checklist', 422);   // as dependencies
  if (e.rec.status === 'archived') return err('record_archived', 409);
  if (!linkAllowed(e.space, e.task.space_id)) return err('link_cross_space: a checklist links only to tasks in its own space (or from General)', 422);
  const r = await insertRecordLink(e.task.id, e.rec.id, auth, env);
  if (r.error) return err('link_failed: ' + JSON.stringify(r.error.data), 400);
  return ok({ task_id: e.task.id, record_id: e.rec.id, already: !r.inserted });
}
// POST unlinkTaskChecklist { task_id, record_id } — works on an abandoned task too. Stamps who is removing it
// (removed_by_user_id / removed_source), then deletes; the delete trigger logs both sides with that actor.
async function unlinkTaskChecklist(body, auth, env) {
  const d = body.data || body;
  const e = await linkEnds(d, auth, env);
  if (e.error) return e.error;
  const q = `task_id=eq.${enc(e.task.id)}&record_id=eq.${enc(e.rec.id)}`;
  const st = await sbDocket(`/rest/v1/task_checklist_links?${q}`, env, { method: 'PATCH', prefer: 'return=representation',
    body: JSON.stringify({ removed_by_user_id: auth.userId, removed_source: auth.source || 'app' }) });
  if (!st.ok) return err('unlink_failed: ' + JSON.stringify(st.data), 400);
  if (!st.data?.length) return err('not_linked', 404);
  // Delete only the row THIS caller stamped: a concurrent unlink that re-stamped it (and so owns the history row)
  // leaves this one with nothing to delete → 409, never a mis-attributed unlink.
  const r = await sbDocket(`/rest/v1/task_checklist_links?${q}&removed_by_user_id=eq.${enc(auth.userId)}`, env, { method: 'DELETE', prefer: 'return=representation' });
  if (!r.ok) return err('unlink_failed: ' + JSON.stringify(r.data), 400);
  if (!r.data?.length) return err('unlink_conflict: someone else is unlinking it — reload', 409);
  return ok({ removed: true });
}

// ════════════════════════════════════════════════════════════════════════════
// Dispatch
// ════════════════════════════════════════════════════════════════════════════
const GET_ACTIONS = {
  getMe, getDepartments, getEmployees,
  getTasks, getProgramTasks, getMyTasks, getStaleTasks, searchTasks, getTask, getTaskLinks, getDashboard,
  getChecklist, getChecklistTemplates, getChecklistTemplate, getChecklistOversight, getChecklistRegister,
  getChecklistRecords, getChecklistRecord, getChecklistProducts,
  getPrograms, getSpaces, getSpaceMembers, getSpaceTeams, getAllSpaces,
  getScratchNotes,
  getDocketRoles, getDocketUsers, getDashboardSharing,
  getPlan, getPlanItem, getProposals, getPlanWeeks, getWeekScore,
  getReviewPack, getReviewSnapshots, getFoundersReview,
  getIncoming,
  getPlanTree, getTemplates, getTemplate,
  getReachedTargets, getScoreTrend, getReplan,
};
const POST_ACTIONS = {
  createTask, createSubtask, updateTask, changeStatus, reviseDeadline, abandonTask, bulkUpdateTasks, setParent, moveTask,
  bulkSetCollaborator, bulkMoveTasks, bulkAbandonTasks,
  addTaskLink, removeTaskLink,
  createRecurringTask, updateRecurrence, toggleChecklistOccurrence,
  saveChecklistTemplate, archiveChecklistTemplate,
  assignChecklistTemplate, unassignChecklistTemplate,
  toggleChecklistItem, saveSectionComment,
  createChecklistRecord, updateChecklistRecord, setRecordItemState, addRecordItem, pullTemplateUpdates,
  createTaskFromRecordItem, linkTaskChecklist, unlinkTaskChecklist,
  addCollaborator, removeCollaborator,
  addDocument, removeDocument,
  addComment, editComment, deleteComment,
  createProgram,
  createSpace, renameSpace, archiveSpace, addSpaceMember, removeSpaceMember, shareSpaceWithTeam, unshareSpaceTeam, transferSpaceOwnership, recoverSpace,
  createScratchNote, updateScratchNote, deleteScratchNote,
  createDocketRole, updateDocketRole, deleteDocketRole, assignDocketRole,
  setDashboardPublic, addDashboardViewer, removeDashboardViewer,
  createPlanItem, updatePlanItem, planItemAction,
  proposePlanItem, decideProposal,
  holdReview, setFounderFocus,
  acceptHandoff,
  saveTemplate, archiveTemplate, applyTemplate,
  slackReminderPreview,
};

// task_history.source (F9 R6a, §8.3): the MCP gateway marks every call it makes; anything else is the app.
// Slack / system sources are stamped by their own paths (R7 / the database), never from a header.
function requestSource(request) { return request.headers.get('X-LOT-Source') === 'connector' ? 'connector' : 'app'; }
async function handleGet(url, request, env) {
  const action = url.searchParams.get('action');
  if (!action) return err('action_required', 400);
  if (action === 'ping') return ok({ pong: true });
  const auth = await verifyJWT(request.headers.get('Authorization'), env);
  if (!auth) return err('unauthorized', 401);
  auth.source = requestSource(request);
  const handler = GET_ACTIONS[action];
  if (!handler) return err(`unknown_action: ${action}`, 400);
  try { return await handler(url, auth, env); }
  catch (e) { return err(`server_error: ${e?.message || String(e)}`, 500); }
}
async function handlePost(request, env) {
  const auth = await verifyJWT(request.headers.get('Authorization'), env);
  if (!auth) return err('unauthorized', 401);
  auth.source = requestSource(request);
  let body; try { body = await request.json(); } catch { return err('bad_json', 400); }
  const action = body?.action;
  if (!action) return err('action_required', 400);
  await touchActivity(auth, env);   // mutation presence ping (best-effort, swallows its own errors)
  const handler = POST_ACTIONS[action];
  if (!handler) return err(`unknown_action: ${action}`, 400);
  try { return await handler(body, auth, env); }
  catch (e) { return err(`server_error: ${e?.message || String(e)}`, 500); }
}

// ════════════════════════════════════════════════════════════════════════════
// F9 R7a — Docket from Slack (spec §9.1, §9.3): /slack/commands + /slack/interactive. Every action runs AS the
// mapped person: the same `auth` object verifyJWT builds (authForUser — no self-provision), source 'slack', and
// the SAME GET_ACTIONS / POST_ACTIONS handler the app calls, whose own permission checks decide. Slack wants a
// 200 within 3 s: anything slow runs in ctx.waitUntil and answers through response_url / a DM.
// ════════════════════════════════════════════════════════════════════════════
const slackText = (text, status = 200) => new Response(JSON.stringify({ response_type: 'ephemeral', text }),
  { status, headers: { 'Content-Type': 'application/json' } });
const slackJson = (obj) => new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } });
const slackAck = () => new Response('', { status: 200 });
const SLACK_OOPS = "Docket couldn't finish that. Try it in Docket.";
// The work to finish after the 200: on the platform, waitUntil; without a ctx (tests) it simply runs first.
// A thrown job is logged and, where it can be, answered in plain words (never the raw error).
async function later(ctx, work, onFail = null) {
  const p = Promise.resolve().then(work).catch(async (e) => {
    console.error('docketops slack job failed', e);
    if (onFail) { try { await onFail(); } catch { /* nothing more to say */ } }
  });
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p); else await p;
}
// Signature on the RAW body (spec §9.1). No secret = not set up = refused (503), never "open".
async function slackGate(request, env) {
  const secret = env.SLACK_DOCKET_SIGNING_SECRET;
  if (!secret) return { res: new Response('not_configured', { status: 503 }) };
  const raw = await request.text();
  if (!(await slackSignatureOk(request, raw, secret))) return { res: new Response('bad_signature', { status: 401 }) };
  return { form: parseForm(raw) };
}
// The bot's own workspace (auth.test), once per isolate — a Slack user from any other team is never mapped.
let slackBotTeam = null;
async function botTeamId(env) {
  if (!slackBotTeam) { const r = await slackApi('auth.test', {}, env); if (r.ok && r.team_id) slackBotTeam = r.team_id; }
  return slackBotTeam;
}
function slackEmpDeps(env) {
  return {
    slackEmail: async (sid) => {
      const [team, info] = await Promise.all([botTeamId(env), slackApi('users.info', { user: sid }, env)]);
      return slackUserEmail(info, team);
    },
    employeesByEmail: async (email) => {
      const e = lookupEmail(email);
      if (!e) return [];
      const r = await sbPodium(`/rest/v1/employees?work_email=ilike.${enc(e.replace(/_/g, '\\_'))}&status=eq.active&select=id,auth_user_id,status,work_email&limit=5`, env);
      return (r.ok && Array.isArray(r.data)) ? r.data : [];
    },
  };
}
const forgetSlackIdentity = (sid, env) =>
  sbDocket(`/rest/v1/slack_identities?slack_user_id=eq.${enc(sid)}`, env, { method: 'DELETE', prefer: 'return=minimal' }).catch(() => null);
// Best-effort cache (R7a; the reminders' lookups save through here too). The Slack id is cleared first (it is
// UNIQUE — it may still sit on another employee's row), then the employee's row is upserted. On a failed write
// the person is still resolved (and re-resolved next time).
async function saveSlackIdentity(row, env) {
  await forgetSlackIdentity(row.slack_user_id, env);
  await sbDocket(`/rest/v1/slack_identities?on_conflict=employee_id`, env, { method: 'POST',
    prefer: 'return=minimal,resolution=merge-duplicates', body: JSON.stringify([{ ...row, resolved_at: nowIso() }]) }).catch(() => null);
}
// Slack user → the Docket person acting. Fresh cached row first; else users.info → work email → active employee → login.
function slackPerson(slackUserId, env) {
  const forget = (sid) => forgetSlackIdentity(sid, env);
  return resolveSlackPerson(slackUserId, {
    ...slackEmpDeps(env),
    cached: async (sid) => {
      const r = await sbDocket(`/rest/v1/slack_identities?slack_user_id=eq.${enc(sid)}&select=employee_id,auth_user_id,resolved_at&limit=1`, env);
      return (r.ok && r.data?.[0]) || null;
    },
    forget,
    save: (row) => saveSlackIdentity(row, env),
    authForUser: (uid) => authForUser(uid, null, env),
  });
}
// Call an action handler as the person → { ok, data } | { ok:false, error, extra } (the Response read back).
async function slackCall(handler, arg, auth, env) {
  try {
    const j = await (await handler(arg, auth, env)).json().catch(() => null);
    return j && j.ok ? { ok: true, data: j.data } : { ok: false, error: (j && j.error) || 'error', extra: j || {} };
  } catch { return { ok: false, error: 'server_error', extra: {} }; }
}
const slackGetUrl = (action, params = {}) => {
  const u = new URL('https://docketops.internal/');
  u.searchParams.set('action', action);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u;
};
async function slackDm(user, message, env) {
  const im = await slackApi('conversations.open', { users: user }, env);
  return slackApi('chat.postMessage', { channel: (im.ok && im.channel?.id) || user, ...message }, env);
}
// Reply through response_url (valid 30 min); if that is gone or refused, the same words by DM.
async function slackReply(responseUrl, user, message, env) {
  const r = responseUrl ? await slackRespond(responseUrl, message) : { ok: false };
  return r.ok ? r : slackDm(user, message, env);
}

async function slackCommands(request, env, ctx) {
  const g = await slackGate(request, env);
  if (g.res) return g.res;
  const f = g.form;
  const cmd = parseCommand(f.text);
  if (cmd.sub === 'help' || cmd.sub === 'unknown') {
    return slackText(cmd.sub === 'unknown' ? `I don't know \`${String(cmd.text).split(/\s/)[0].slice(0, 30)}\`.\n${USAGE}` : USAGE);
  }
  const reply = (text, extra = {}) => slackReply(f.response_url, f.user_id, { text, ...extra }, env);
  await later(ctx, async () => {
    const who = await slackPerson(f.user_id, env);
    if (who.error) return reply(UNLINKED);
    const auth = who.auth;
    if (cmd.sub === 'add') {
      const emps = await slackCall(GET_ACTIONS.getEmployees, slackGetUrl('getEmployees'), auth, env);
      const people = emps.ok ? emps.data : [];
      const q = parseQuickAdd(cmd.text, { people, now: new Date() });
      if (!q.title) return reply('Give the task a title: `/docket add <task>`.');
      const r = await slackCall(POST_ACTIONS.createTask, { title: q.title, deadline: q.deadline || null, priority: q.priority || undefined,
        owner_employee_id: q.owner_employee_id || null, assign_self: !q.owner_employee_id }, auth, env);
      if (!r.ok) return reply(friendlyError(r.error, r.extra));
      return reply(addReply(cmd.text, q, r.data, people, auth.employeeId));
    }
    if (cmd.sub === 'mine') {
      const r = await slackCall(GET_ACTIONS.getMyTasks, slackGetUrl('getMyTasks'), auth, env);
      if (!r.ok) return reply(friendlyError(r.error, r.extra));
      return reply(null, mineMessage((r.data || []).filter(t => t._relation === 'owner')));
    }
    if (cmd.sub === 'propose') {
      const p = proposalFrom(cmd.text, PROPOSAL_MAX);
      if (p.error) return reply(friendlyError(p.error));
      const r = await slackCall(POST_ACTIONS.proposePlanItem, p, auth, env);
      return reply(r.ok ? 'Proposed. The founders will see it in the plan\'s proposals.' : friendlyError(r.error, r.extra));
    }
  }, () => reply(SLACK_OOPS));
  return slackAck();
}

async function slackInteractive(request, env, ctx) {
  const g = await slackGate(request, env);
  if (g.res) return g.res;
  let payload = null;
  try { payload = JSON.parse(g.form.payload || ''); } catch { return new Response('bad_request', { status: 400 }); }
  const r = routeInteraction(payload);
  const user = r.user;
  const dmOops = () => slackDm(user, { text: SLACK_OOPS }, env);

  // ── open the task modal now (trigger_id lives 3 s); plan options / an unlinked notice follow by views.update ──
  if (r.kind === 'open_task') {
    const meta = r.channel && r.ts ? { channel: r.channel, ts: r.ts } : {};
    const opened = await slackApi('views.open', { trigger_id: r.trigger_id, view: taskModal({ title: r.title, ownerSlackId: user, meta }) }, env);
    if (opened.ok) await later(ctx, async () => {
      const who = await slackPerson(user, env);
      const view = opened.view || {};
      if (who.error) return slackApi('views.update', { view_id: view.id, hash: view.hash, view: messageModal('Add to Docket', UNLINKED) }, env);
      const plan = await slackCall(GET_ACTIONS.getPlan, slackGetUrl('getPlan'), who.auth, env);
      const options = plan.ok ? planOptions(plan.data?.items || []) : [];
      if (options.length) {
        await slackApi('views.update', { view_id: view.id, hash: view.hash,
          view: taskModal({ title: r.title, ownerSlackId: user, planOptions: options, meta }) }, env);
      }
    });
    return slackAck();
  }
  if (r.kind === 'open_move' || r.kind === 'open_comment') {
    const meta = { response_url: r.response_url };
    await slackApi('views.open', { trigger_id: r.trigger_id, view: r.kind === 'open_move' ? moveModal(r.task_id, meta) : commentModal(r.task_id, meta) }, env);
    return slackAck();
  }

  // ── a task modal submitted: only pure field checks before the ack (no I/O — Slack's 3 s); the modal closes,
  //    then the person, owner and receiver are mapped and the task created; the outcome (or a pick that can't be
  //    mapped) comes back by DM. ──
  if (r.kind === 'submit_task') {
    const v = validateTaskSubmission(r.values);
    if (v.errors) return slackJson({ response_action: 'errors', errors: v.errors });
    const title = v.value.title.replace(/[<>&]/g, '');
    await later(ctx, async () => {
      const dm = (text) => slackDm(user, { text }, env);
      const [who, owner, handoff] = await Promise.all([slackPerson(user, env), slackEmployee(v.value.owner, slackEmpDeps(env)),
        v.value.handoff ? slackEmployee(v.value.handoff, slackEmpDeps(env)) : null]);
      if (who.error) return dm(UNLINKED);
      const bad = [owner.error && 'the owner', handoff && handoff.error && 'the hand-off receiver'].filter(Boolean);
      if (bad.length) return dm(`Docket didn't add “${title.slice(0, 80)}”: ${bad.join(' and ')} isn't an active Docket person. Pick someone else and try again.`);
      const documents = [];
      if (r.meta.channel && r.meta.ts) {
        const pl = await slackApi('chat.getPermalink', { channel: r.meta.channel, message_ts: r.meta.ts }, env);
        if (pl.ok && typeof pl.permalink === 'string' && pl.permalink.startsWith('https://')) documents.push({ title: 'Slack message', url: pl.permalink });
      }
      const res = await slackCall(POST_ACTIONS.createTask, { title: v.value.title, owner_employee_id: owner.employeeId,
        deadline: v.value.date ? deadlineIso(v.value.date) : null, plan_item_id: v.value.plan || null,
        handoff_to_employee_id: handoff ? handoff.employeeId : null, documents }, who.auth, env);
      return dm(res.ok ? `Added <${taskLink(res.data.id)}|${res.data.task_no}> — ${title}`
        : `Docket didn't add “${title.slice(0, 80)}”: ${friendlyError(res.error, res.extra)}`);
    }, dmOops);
    return slackAck();   // closes the modal
  }
  if (r.kind === 'submit_move' || r.kind === 'submit_comment') {
    const v = r.kind === 'submit_move' ? validateMoveSubmission(r.values) : validateCommentSubmission(r.values);
    if (v.errors) return slackJson({ response_action: 'errors', errors: v.errors });
    const taskId = r.meta.task_id;
    const say = (text) => slackReply(r.meta.response_url, user, { text }, env);
    await later(ctx, async () => {
      const who = await slackPerson(user, env);
      if (who.error) return say(UNLINKED);
      const res = r.kind === 'submit_move'
        ? await slackCall(POST_ACTIONS.reviseDeadline, { id: taskId, new_deadline: deadlineIso(v.value.date), reason: v.value.reason }, who.auth, env)
        : await slackCall(POST_ACTIONS.addComment, { id: taskId, body: v.value.body }, who.auth, env);
      return say(res.ok ? (r.kind === 'submit_move' ? `Moved to ${v.value.date}. <${taskLink(taskId)}|Open in Docket>` : `Comment posted. <${taskLink(taskId)}|Open in Docket>`)
        : friendlyError(res.error, res.extra));
    }, () => say(SLACK_OOPS));
    return slackAck();
  }

  // ── buttons that act straight away ──
  if (r.kind === 'done' || r.kind === 'accept') {
    const say = (text) => slackReply(r.response_url, user, { text }, env);
    await later(ctx, async () => {
      const who = await slackPerson(user, env);
      if (who.error) return say(UNLINKED);
      const res = r.kind === 'done'
        ? await slackCall(POST_ACTIONS.changeStatus, { id: r.task_id, status: 'done' }, who.auth, env)
        : await slackCall(POST_ACTIONS.acceptHandoff, { id: r.task_id }, who.auth, env);
      return say(res.ok ? `${r.kind === 'done' ? 'Done' : 'Hand-off accepted'}. <${taskLink(r.task_id)}|Open in Docket>`
        : friendlyError(res.error, res.extra));
    }, () => say(SLACK_OOPS));
    return slackAck();
  }
  return slackAck();   // anything else is acknowledged and ignored
}

// ════════════════════════════════════════════════════════════════════════════
// F9 R7b — Slack reminders (spec §9.2). The cron wakes the worker at :00 and :30 (UTC = IST minutes, since IST is
// +05:30); dueSlots decides what is due in this half-hour from docket.settings.slack_reminders. Every message is
// rendered AS its recipient (authForUser, no self-provision) through the app's own read handlers, so it shows
// what they could see in Docket. A log row is claimed BEFORE each DM (unique slot · IST date · employee), so a
// retry or a double fire never DMs twice. One recipient failing is logged and the run goes on; one slot
// throwing never stops the others. No raw database or Slack text ever reaches a person.
// ════════════════════════════════════════════════════════════════════════════
const REMINDER_RENDER = { owner_daily: renderOwnerDaily, chase: renderChase, review_tomorrow: renderReviewTomorrow,
  review_pack: renderReviewPack, catchup_prep: renderCatchup };

async function reminderSettings(env) {
  const r = await sbDocket(`/rest/v1/settings?key=eq.slack_reminders&select=value&limit=1`, env);
  return parseReminderSettings(r.ok && r.data?.[0] ? r.data[0].value : null);   // unreadable → mode off
}
// Who each slot goes to, before mode gating: [{ id, auth_user_id, work_email, full_name, kind? }]
// The week's commitment cohort (week_score — frozen at commit time, so its owner is who the review scores).
async function weekCohort(env) {
  const sc = await sbDocket(`/rest/v1/rpc/week_score`, env, { method: 'POST', body: JSON.stringify({ p_date: istDate(Date.now()) }) });
  if (!sc.ok) throw new Error('week_score');
  return { rows: Array.isArray(sc.data?.tasks) ? sc.data.tasks : [], weekEnd: sc.data?.week_end || null };
}
async function reminderPeople(slot, env) {
  if (slot === 'review_tomorrow') {
    // whoever OWNED a committed task at commit time and still has one not done — even if they've since handed it on
    const { rows } = await weekCohort(env);
    const ids = uniq(rows.filter(r => r.status !== 'done' && r.status !== 'abandoned').map(r => r.owner_employee_id));
    const e = await sbIn(sbPodium, ids, l => `/rest/v1/employees?id=in.${l}&status=eq.active&select=id,auth_user_id,work_email,full_name`, env);
    if (!e.ok) throw new Error('owners_read');
    return e.data || [];
  }
  if (slot === 'owner_daily') {
    // every active employee who owns an open task
    const t = await sbAll(sbDocket, `/rest/v1/tasks?${PW_OPEN}&archived_at=is.null&owner_employee_id=not.is.null&select=owner_employee_id&order=id.asc`, env);
    if (!t.ok) throw new Error('owners_read');
    const ids = uniq((t.data || []).map(x => x.owner_employee_id));
    const e = await sbIn(sbPodium, ids, l => `/rest/v1/employees?id=in.${l}&status=eq.active&select=id,auth_user_id,work_email,full_name`, env);
    if (!e.ok) throw new Error('owners_read');
    return e.data || [];
  }
  // founders (docket_plan_admin) and Founders' Associates (docket_review, below plan admin) — from the Docket roles
  const [rr, ur] = await Promise.all([
    sbStore(`/rest/v1/docket_roles?select=role_key,permissions`, env),
    sbStore(`/rest/v1/docket_user_roles?select=user_id,role_key`, env),
  ]);
  if (!rr.ok || !ur.ok) throw new Error('roles_read');
  const perms = Object.fromEntries((rr.data || []).map(r => [r.role_key, normalizeDocketPerms(r.permissions || {})]));
  const kindOf = (p) => (p?.docket_plan_admin ? 'founder' : p?.docket_review ? 'associate' : null);
  const kinds = {};
  for (const u of ur.data || []) { const k = kindOf(perms[u.role_key]); if (k) kinds[u.user_id] = k; }
  const want = slot === 'catchup_prep' ? ['founder'] : ['founder', 'associate'];
  const users = Object.keys(kinds).filter(u => want.includes(kinds[u]));
  const e = await sbIn(sbPodium, users, l => `/rest/v1/employees?auth_user_id=in.${l}&status=eq.active&select=id,auth_user_id,work_email,full_name`, env);
  if (!e.ok) throw new Error('people_read');
  return (e.data || []).map(p => ({ ...p, kind: kinds[p.auth_user_id] }));
}
// employee → Slack user id: slack_identities (fresh — 6 to 8 days, staggered per person) first, else
// users.lookupByEmail on the work email — the same workspace / not-a-stranger checks as R7a — saved through the
// same path. → Map(employee_id → { sid } | { status: 'unmapped' | 'failed', code }). Lookups go 20 at once, then
// one per LOOKUP_GAP_MS (Slack allows ~50 a minute), so a cold cache of 65 fits.
const LOOKUP_BURST = 20, LOOKUP_GAP_MS = 1300;
async function reminderSlackIds(people, env, sleep = (ms) => new Promise(r => setTimeout(r, ms))) {
  const out = new Map();
  if (!people.length) return out;
  const r = await sbIn(sbDocket, people.map(p => p.id), l => `/rest/v1/slack_identities?employee_id=in.${l}&select=employee_id,slack_user_id,resolved_at`, env);
  const rows = Object.fromEntries(((r.ok && r.data) || []).map(x => [x.employee_id, x]));
  let team = null, lookups = 0;
  for (const p of people) {
    const row = rows[p.id];
    if (row && Date.parse(row.resolved_at || '') > Date.now() - identityTtlMs(p.id)) { out.set(p.id, { sid: row.slack_user_id }); continue; }
    const email = lookupEmail(p.work_email);
    if (!email) { out.set(p.id, { status: 'unmapped', code: 'no_work_email' }); continue; }
    team = team || await botTeamId(env);
    if (!team) { out.set(p.id, { status: 'failed', code: 'auth_test_failed' }); continue; }
    if (lookups++ >= LOOKUP_BURST) await sleep(LOOKUP_GAP_MS);
    const info = await slackApi('users.lookupByEmail', { email }, env);
    const o = lookupOutcome(info, email, (i) => slackUserEmail(i, team));
    if (o.sid) await saveSlackIdentity({ employee_id: p.id, slack_user_id: o.sid, auth_user_id: p.auth_user_id || null }, env);
    out.set(p.id, o);
  }
  return out;
}
// Claim the log row (insert … on conflict do nothing) → 'claimed' (this run inserted it) | 'exists' (a row is
// already there — a retry, a double fire) | 'error' (the write failed: nothing is sent, and it is said so).
async function claimReminder(slot, runDate, employeeId, status, errorCode, env) {
  const r = await sbDocket(`/rest/v1/slack_reminder_log?on_conflict=slot,run_date,employee_id`, env, { method: 'POST',
    prefer: 'return=representation,resolution=ignore-duplicates',
    body: JSON.stringify([{ slot, run_date: runDate, employee_id: employeeId, status, error_code: errorCode || null }]) });
  if (!r.ok || !Array.isArray(r.data)) { console.error('docketops reminder claim failed', slot, runDate, employeeId, r.status); return 'error'; }
  return r.data.length === 1 ? 'claimed' : 'exists';
}
async function finishReminder(slot, runDate, employeeId, status, errorCode, env) {
  await sbDocket(`/rest/v1/slack_reminder_log?slot=eq.${enc(slot)}&run_date=eq.${enc(runDate)}&employee_id=eq.${enc(employeeId)}`, env,
    { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status, error_code: errorCode || null, sent_at: nowIso() }) });
}
const asCaller = (auth) => ({ ...auth, source: 'slack' });

async function runReminders(env, scheduledTime) {
  const [settings, week] = await Promise.all([reminderSettings(env), weekSettings(env)]);
  if (settings.mode === 'off') return [];
  const due = dueSlots(scheduledTime, settings, (d) => isWorkingDay(d, week));
  const results = [];
  for (const { slot, run_date } of due) {
    try { results.push({ slot, ...(await runReminderSlot(slot, run_date, settings, env)) }); }
    catch (e) { console.error('docketops reminder slot failed', slot, e); results.push({ slot, error: true }); }
  }
  return results;
}
async function runReminderSlot(slot, runDate, settings, env) {
  const people = gateRecipients(settings.mode, settings.test_employee_ids, await reminderPeople(slot, env));
  const counts = { sent: 0, skipped_empty: 0, unmapped: 0, failed: 0, claim_failed: 0, already: 0 };
  const rendered = [];
  for (const p of people) {
    try {
      const auth = p.auth_user_id ? await authForUser(p.auth_user_id, null, env) : null;
      if (!auth || auth.employeeId !== p.id) { rendered.push({ p, status: 'unmapped', code: 'no_docket_login' }); continue; }
      const msg = await REMINDER_RENDER[slot](asCaller(auth), env, p);
      rendered.push(msg ? { p, msg } : { p, status: 'skipped_empty' });
    } catch (e) { console.error('docketops reminder render failed', slot, e); rendered.push({ p, status: 'failed', code: 'render_failed' }); }
  }
  const sids = await reminderSlackIds(rendered.filter(x => x.msg).map(x => x.p), env);
  const usedSids = new Set();   // two employees on one Slack account get ONE DM a slot
  const tally = (c, status) => { counts[c === 'claimed' ? status : c === 'exists' ? 'already' : 'claim_failed']++; };
  for (const x of rendered) {
    const id = x.p.id;
    try {
      if (!x.msg) { tally(await claimReminder(slot, runDate, id, x.status, x.code, env), x.status); continue; }
      const who = sids.get(id) || { status: 'failed', code: 'lookup_failed' };
      if (!who.sid) { tally(await claimReminder(slot, runDate, id, who.status, who.code, env), who.status); continue; }
      if (usedSids.has(who.sid)) { tally(await claimReminder(slot, runDate, id, 'unmapped', 'duplicate_slack_user', env), 'unmapped'); continue; }
      usedSids.add(who.sid);
      // the claim comes first: a row already there (a retry, a double fire) means this person is done
      const c = await claimReminder(slot, runDate, id, 'failed', 'in_flight', env);
      if (c !== 'claimed') { tally(c); continue; }
      const res = await slackDm(who.sid, x.msg, env);
      await finishReminder(slot, runDate, id, res.ok ? 'sent' : 'failed', res.ok ? null : safeCode(res.error), env);
      counts[res.ok ? 'sent' : 'failed']++;
    } catch (e) { console.error('docketops reminder send failed', slot, e); counts.failed++; }
  }
  return counts;
}

// ── the five renderers: (auth of the recipient, env, person) → message | null (null = nothing to say) ──
async function founderSpaceIds(env) {
  const r = await sbDocket(`/rest/v1/spaces?is_founders=eq.true&select=id`, env);
  if (!r.ok) throw new Error('spaces_read');
  return new Set((r.data || []).map(x => x.id));
}
async function renderOwnerDaily(auth, env) {
  const now = Date.now();
  const [mt, settings, fsp] = await Promise.all([slackCall(GET_ACTIONS.getMyTasks, slackGetUrl('getMyTasks'), auth, env), weekSettings(env), founderSpaceIds(env)]);
  if (!mt.ok) throw new Error('my_tasks');
  const own = (mt.data || []).filter(t => t._relation === 'owner' && !t.is_recurring && t.status !== 'done' && t.status !== 'abandoned');
  const shown = own.filter(t => !fsp.has(t.space_id));   // a Founders'-space task never goes into Slack (as the pack)
  const staleFrom = staleCutoff(now, settings);
  const since = new Date(istMidnight(staleFrom)).toISOString();
  const ids = shown.map(t => t.id);
  const [hr, cr] = await Promise.all([
    sbInAll(sbDocket, ids, l => `/rest/v1/task_history?task_id=in.${l}&created_at=gte.${since}&select=task_id&order=id.asc`, env),
    sbInAll(sbDocket, ids, l => `/rest/v1/task_comments?task_id=in.${l}&deleted_at=is.null&created_at=gte.${since}&select=task_id&order=id.asc`, env),
  ]);
  if (!hr.ok || !cr.ok) throw new Error('updates_read');
  const fresh = new Set([...(hr.data || []), ...(cr.data || [])].map(x => x.task_id));
  const s = ownerDailySections(shown, { nowMs: now, fresh, staleFrom });
  const hidden = ownerDailySections(own.filter(t => fsp.has(t.space_id)), { nowMs: now, fresh: new Set(), staleFrom });
  return ownerDailyMessage(s, { hidden: hidden.overdue.length + hidden.today.length });
}
// The chase, at the reader's level: plan-weeks Stale warnings (team = all) + the review pack's raised teams.
async function chaseFor(auth, env) {
  const now = Date.now();
  const [pw, settings, pack] = await Promise.all([
    slackCall(GET_ACTIONS.getPlanWeeks, slackGetUrl('getPlanWeeks', { team: 'all' }), auth, env),
    weekSettings(env),
    buildReviewPack('this', 'all', auth, env),
  ]);
  if (!pw.ok || pack.error) throw new Error('chase_read');
  const today = istDate(now);
  const until = workingDayAfter(today, 2, (d) => isWorkingDay(d, settings));
  const stale = (pw.data?.warnings || []).filter(w => w.kind === 'stale' && w.task).map(w => w.task);
  const tasks = chaseTasks(stale, { nowMs: now, until });
  const raised = (pack.pack.teams || []).filter(t => t.staleness?.quiet_last_working_day).map(t => t.team_name || 'No team');
  return { tasks, raised, lwd: lastWorkingDay(today, settings) };
}
async function renderChase(auth, env) {
  if (!isPlanAdmin(auth) && !isReviewer(auth)) return null;
  const c = await chaseFor(auth, env);
  return isPlanAdmin(auth) ? founderChaseLine(c.tasks.length, c.raised) : chaseMessage(c.tasks, c.raised, { lwd: c.lwd });
}
async function renderReviewTomorrow(auth, env) {
  if (!auth.employeeId) return null;
  const { rows: cohort, weekEnd } = await weekCohort(env);
  const mine = cohort.filter(r => r.owner_employee_id === auth.employeeId);
  if (!mine.length) return null;
  const [fsp, tr] = await Promise.all([founderSpaceIds(env),
    sbInAll(sbDocket, mine.map(r => r.task_id), l => `/rest/v1/tasks?id=in.${l}&select=id,space_id,department_id,owner_employee_id,created_by_user_id,assignee_employee_id,handoff_to_department_id,handoff_to_employee_id&order=id.asc`, env)]);
  if (!tr.ok) throw new Error('tasks_read');
  // EVERYONE through the space gate (keepAccessible = canAccessSpace's rule + P3a involvement, batched; plan admins included — a task
  // that moved into a space you can't open is not yours to see in Slack either), and below plan admin also the review
  // pack's own gate (reviewVisibleIds). A Founders'-space row never goes into Slack (counted, if you can open it).
  const inSpace = new Set((await keepAccessible(auth, tr.data || [], env)).map(t => t.id));
  const keep = isPlanAdmin(auth) ? inSpace : await reviewVisibleIds(auth, mine.map(r => r.task_id), env);
  if (!keep) throw new Error('visible_read');   // fail closed
  const space = Object.fromEntries((tr.data || []).map(t => [t.id, t.space_id]));
  const seen = mine.filter(r => inSpace.has(r.task_id) && keep.has(r.task_id));
  const rows = seen.filter(r => !fsp.has(space[r.task_id]));
  const hidden = seen.filter(r => fsp.has(space[r.task_id]) && r.status !== 'done' && r.status !== 'abandoned').length;
  return reviewTomorrowMessage(rows, { hidden, weekEnd });
}
async function renderReviewPack(auth, env) {
  if (!isPlanAdmin(auth) && !isReviewer(auth)) return null;
  const r = await buildReviewPack('this', 'all', auth, env);
  if (r.error) throw new Error('pack_read');
  if (!(r.pack.teams || []).length) return null;
  return reviewPackMessage(packToSlack(r.pack).summary, r.pack.week?.week_end || null);   // slack_omit applied
}
async function renderCatchup(auth, env) {
  if (!isPlanAdmin(auth)) return null;
  const r = await slackCall(GET_ACTIONS.getFoundersReview, slackGetUrl('getFoundersReview', { week: 'this' }), auth, env);
  if (!r.ok) throw new Error('founders_read');
  return catchupMessage(r.data?.slack, r.data?.week?.week_end || null);
}

// POST { action: 'slackReminderPreview', slot } — plan admin only. DMs the CALLER their own version of that slot
// now: no log row, no other recipient, whatever the mode.
async function slackReminderPreview(body, auth, env) {
  if (!isPlanAdmin(auth)) return err('forbidden', 403);
  const slot = (body.data || body).slot;
  if (!SLOT_KEYS.includes(slot)) return err('bad_slot', 400);
  if (!auth.employeeId) return err('no_employee', 409);
  let msg;
  try { msg = await REMINDER_RENDER[slot](asCaller(auth), env); }
  catch (e) { console.error('docketops reminder preview failed', slot, e); return err('render_failed', 500); }
  if (!msg) return ok({ slot, sent: false, empty: true });
  const er = await sbPodium(`/rest/v1/employees?id=eq.${enc(auth.employeeId)}&select=id,auth_user_id,work_email,full_name&limit=1`, env);
  const me = (er.ok && er.data?.[0]) || null;
  const who = me ? (await reminderSlackIds([me], env)).get(me.id) : null;
  if (!who || !who.sid) return err(who && who.status === 'failed' ? 'slack_lookup_failed' : 'slack_unmapped', who && who.status === 'failed' ? 502 : 409);
  const res = await slackDm(who.sid, { ...msg, text: `[Preview] ${msg.text}` }, env);
  return res.ok ? ok({ slot, sent: true }) : err('slack_send_failed', 502);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    if (url.pathname === '/health' || url.pathname === '/healthz') return ok({ service: 'docketops', time: nowIso() });
    if (url.pathname === '/slack/events' && request.method === 'POST') return slackEvents(request, env);
    if (url.pathname === '/slack/commands' && request.method === 'POST') return slackCommands(request, env, ctx);
    if (url.pathname === '/slack/interactive' && request.method === 'POST') return slackInteractive(request, env, ctx);
    if (request.method === 'GET')  return handleGet(url, request, env);
    if (request.method === 'POST') return handlePost(request, env);
    return err('method_not_allowed', 405);
  },
  // F9 R7b: crons = ["0,30 * * * *"] (wrangler.toml). event.scheduledTime = the slot's own time, not the start lag.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env, event.scheduledTime)
      .then(results => { for (const r of results) console.log('docketops reminders', JSON.stringify(r)); })   // per slot: sent / skipped_empty / unmapped / failed / claim_failed / already
      .catch(e => console.error('docketops reminders failed', e)));
  },
};
