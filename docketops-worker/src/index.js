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
 *   (dashboard is ALSO shareable independently of view_all: a persistent
 *    docket.settings.dashboard_public flag + per-person docket.dashboard_viewers
 *    grants — admin-managed in /admin/roles. RULE-DOCKET-006.)
 *   - (no role)       : baseline — create tasks; see own + collaborator + own-dept;
 *                       edit/status/abandon tasks they own/are assigned/created.
 * People + departments are read live from podium.employees / podium.departments.
 *
 * Spec: docs/superpowers/specs/2026-06-03-docket-design.md ; systems/docket.md
 */

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
    return { ok: res.ok, status: res.status, data };
  };
}
const sbDocket = sbProfile('docket');
const sbStore  = sbProfile('store');
const sbPodium = sbProfile('podium');

const enc = encodeURIComponent;
function inList(arr) { return `(${arr.map(enc).join(',')})`; }
function uniq(arr) { return [...new Set(arr.filter(Boolean))]; }

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
  if (!profile.active) return null;

  // Permissions from Docket's own layer (RULE-DOCKET-002). No role → {} → baseline.
  const urRes = await sbStore(
    `/rest/v1/docket_user_roles?user_id=eq.${user.id}&select=role_key&limit=1`, env);
  const docketRole = (urRes.ok && urRes.data?.[0]?.role_key) || null;
  let permissions = {};
  if (docketRole) {
    const prRes = await sbStore(
      `/rest/v1/docket_roles?role_key=eq.${enc(docketRole)}&select=permissions&limit=1`, env);
    permissions = (prRes.ok && prRes.data?.[0]?.permissions) || {};
  }

  // Resolve the caller's podium employee (for default owner + department scoping).
  const empRes = await sbPodium(
    `/rest/v1/employees?auth_user_id=eq.${user.id}&select=id,full_name,department_id&limit=1`, env);
  const emp = (empRes.ok && empRes.data?.[0]) || null;

  return {
    userId: user.id, email: user.email, role: profile.role,
    fullName: profile.full_name, permissions, docketRole,
    employeeId: emp?.id || null, departmentId: emp?.department_id || null,
    bearer: token,
  };
}

// ── Permission helpers ──────────────────────────────────────────────────────
const DOCKET_PERM_KEYS = ['docket_admin', 'docket_view_all'];
function normalizeDocketPerms(permissions) {
  const out = {};
  for (const k of DOCKET_PERM_KEYS) if (permissions && permissions[k]) out[k] = true;
  if (out.docket_admin) out.docket_view_all = true; // footgun guard
  return out;
}
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

// Edit a task's core fields: admin, creator, owner, or assignee.
function canEditTask(auth, task) {
  return isAdmin(auth)
    || task.created_by_user_id === auth.userId
    || (auth.employeeId && task.owner_employee_id === auth.employeeId)
    || (auth.employeeId && task.assignee_employee_id === auth.employeeId);
}
// See a task: view-all, the above, own department, or a collaborator.
async function canSeeTask(auth, task, env) {
  if (canViewAll(auth) || canEditTask(auth, task)) return true;
  if (auth.departmentId && task.department_id === auth.departmentId) return true;
  if (!auth.employeeId) return false;
  const c = await sbDocket(
    `/rest/v1/task_collaborators?task_id=eq.${task.id}&employee_id=eq.${auth.employeeId}&select=task_id&limit=1`, env);
  return !!(c.ok && c.data?.length);
}

async function logHistory(env, taskId, actor, eventType, extra = {}) {
  await sbDocket(`/rest/v1/task_history`, env, {
    method: 'POST', prefer: 'return=minimal',
    body: JSON.stringify({
      task_id: taskId, actor_user_id: actor, event_type: eventType,
      field: extra.field || null, old_value: extra.old != null ? String(extra.old) : null,
      new_value: extra.new != null ? String(extra.new) : null, note: extra.note || null,
    }),
  });
}
async function loadTask(id, env) {
  const r = await sbDocket(`/rest/v1/tasks?id=eq.${enc(id)}&select=*&limit=1`, env);
  return (r.ok && r.data?.[0]) || null;
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
function istDateStr(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d); // 'YYYY-MM-DD'
}
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
// A recurring task is expired (and drops off the checklist) once today is past its `until` date.
function isExpired(rec, dateStr) { return !!(rec && rec.until && rec.until < dateStr); }
// Is a recurrence due on the given IST calendar date ('YYYY-MM-DD')?
function isDueOn(rec, dateStr) {
  if (!rec || !rec.freq) return false;
  if (rec.freq === 'daily') return true;
  if (rec.freq === 'weekly') {
    const wd = new Date(`${dateStr}T12:00:00Z`).getUTCDay(); // 0=Sun..6=Sat for that calendar date
    return Array.isArray(rec.days_of_week) && rec.days_of_week.map(Number).includes(wd);
  }
  if (rec.freq === 'monthly') {
    const y = +dateStr.slice(0, 4), m = +dateStr.slice(5, 7), day = +dateStr.slice(8, 10);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(); // last day of month m (1-based)
    const dom = Number(rec.day_of_month);
    return day === dom || (day === lastDay && dom > lastDay); // clamp short months
  }
  return false;
}
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
// IST 'HH:MM' for an ISO timestamp (used for late detection + display).
function istHM(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}
// Late = completed after the section's due_time (IST). No due_time → never late.
function lateFlag(completedAtIso, dueTime) {
  if (!dueTime || !completedAtIso) return false;
  return istHM(completedAtIso) > dueTime;
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
async function defaultSpaceId(env) {
  const r = await sbDocket(`/rest/v1/spaces?is_default=eq.true&select=id&limit=1`, env);
  return (r.ok && r.data?.[0]?.id) || null;
}
async function isSpaceMember(spaceId, userId, env) {
  const r = await sbDocket(`/rest/v1/space_members?space_id=eq.${enc(spaceId)}&user_id=eq.${enc(userId)}&select=user_id&limit=1`, env);
  return !!(r.ok && r.data?.length);
}
// Can the caller READ a space at all? General = everyone; private = owner or member.
// (docket_admin is NOT special here — strict separation — unless they've broken-glass in.)
async function canAccessSpace(auth, space, env) {
  if (!space) return false;
  if (space.is_default) return true;
  if (space.owner_user_id === auth.userId) return true;
  return isSpaceMember(space.id, auth.userId, env);
}
function isSpaceOwner(auth, space) { return !!space && space.owner_user_id === auth.userId; }
async function logSpace(env, spaceId, actor, action, note = null) {
  await sbDocket(`/rest/v1/space_history`, env, { method: 'POST', prefer: 'return=minimal',
    body: JSON.stringify({ space_id: spaceId, actor_user_id: actor, action, note }) });
}
// Accessible spaces for the sidebar: General + owned/member private spaces (non-archived).
async function accessibleSpaces(auth, env) {
  const [defRes, memberRes] = await Promise.all([
    sbDocket(`/rest/v1/spaces?is_default=eq.true&archived_at=is.null&select=id,name,is_private,owner_user_id&limit=1`, env),
    sbDocket(`/rest/v1/space_members?user_id=eq.${enc(auth.userId)}&select=space_id`, env),
  ]);
  const memberIds = (memberRes.ok ? memberRes.data : []).map(m => m.space_id);
  const orParts = [`owner_user_id.eq.${auth.userId}`];
  if (memberIds.length) orParts.push(`id.in.${inList(memberIds)}`);
  const ownedRes = await sbDocket(
    `/rest/v1/spaces?is_private=eq.true&archived_at=is.null&or=(${orParts.join(',')})&select=id,name,is_private,owner_user_id&order=name.asc`, env);
  const general = (defRes.ok && defRes.data) || [];
  const privates = (ownedRes.ok && ownedRes.data) || [];
  return [...general, ...privates].map(s => ({ id: s.id, name: s.name, is_private: s.is_private, is_owner: s.owner_user_id === auth.userId }));
}

// ════════════════════════════════════════════════════════════════════════════
// GET handlers
// ════════════════════════════════════════════════════════════════════════════
async function getMe(url, auth, env) {
  const [spaces, can_view_dashboard] = await Promise.all([
    accessibleSpaces(auth, env),
    canViewDashboard(auth, env),
    touchActivity(auth, env),   // app-load presence ping (RULE-DOCKET-008 / last-seen)
  ]);
  return ok({
    id: auth.userId, email: auth.email, role: auth.role, full_name: auth.fullName,
    permissions: auth.permissions || {}, employee_id: auth.employeeId, department_id: auth.departmentId,
    spaces, can_view_dashboard,
  });
}
async function getDepartments(url, auth, env) {
  const r = await sbPodium(`/rest/v1/departments?select=id,name&order=name.asc`, env);
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
  if (!(await canAccessSpace(auth, space, env)) && !isAdmin(auth)) return err('forbidden_space', 403);
  const mr = await sbDocket(`/rest/v1/space_members?space_id=eq.${enc(spaceId)}&select=user_id,added_at&order=added_at.asc`, env);
  const ids = uniq((mr.data || []).map(m => m.user_id));
  const up = ids.length ? await sbStore(`/rest/v1/users_profile?id=in.${inList(ids)}&select=id,full_name`, env) : { data: [] };
  const name = {}; (up.data || []).forEach(u => { name[u.id] = u.full_name; });
  return ok((mr.data || []).map(m => ({ user_id: m.user_id, full_name: name[m.user_id] || null, is_owner: m.user_id === space.owner_user_id })));
}
// Admin break-glass list — metadata only (names/owner/counts), never task contents.
async function getAllSpaces(url, auth, env) {
  const gate = requireAdmin(auth); if (gate) return gate;
  const [spaces, members] = await Promise.all([
    sbDocket(`/rest/v1/spaces?select=*&order=is_default.desc,name.asc`, env),
    sbDocket(`/rest/v1/space_members?select=space_id`, env),
  ]);
  if (!spaces.ok) return err('db_error', 500);
  const mCount = {}; (members.data || []).forEach(m => { mCount[m.space_id] = (mCount[m.space_id] || 0) + 1; });
  const ownerIds = uniq((spaces.data || []).map(s => s.owner_user_id));
  const up = ownerIds.length ? await sbStore(`/rest/v1/users_profile?id=in.${inList(ownerIds)}&select=id,full_name`, env) : { data: [] };
  const oName = {}; (up.data || []).forEach(u => { oName[u.id] = u.full_name; });
  return ok((spaces.data || []).map(s => ({ ...s, owner_name: oName[s.owner_user_id] || null, member_count: mCount[s.id] || 0 })));
}

async function hydrateTasks(rows, auth, env) {
  if (!rows.length) return rows;
  const deptIds = uniq(rows.map(t => t.department_id));
  const taskIds = uniq(rows.map(t => t.id));
  const userIds = uniq(rows.map(t => t.created_by_user_id));
  const [deptRes, childRes, collabRes, docRes, commRes, creatorRes] = await Promise.all([
    deptIds.length ? sbPodium(`/rest/v1/departments?id=in.${inList(deptIds)}&select=id,name`, env) : { data: [] },
    sbDocket(`/rest/v1/tasks?parent_task_id=in.${inList(taskIds)}&select=parent_task_id,status`, env),
    sbDocket(`/rest/v1/task_collaborators?task_id=in.${inList(taskIds)}&select=task_id,employee_id`, env),
    sbDocket(`/rest/v1/task_documents?task_id=in.${inList(taskIds)}&select=task_id`, env),
    sbDocket(`/rest/v1/task_comments?task_id=in.${inList(taskIds)}&deleted_at=is.null&select=task_id`, env),
    userIds.length ? sbStore(`/rest/v1/users_profile?id=in.${inList(userIds)}&select=id,full_name`, env) : { data: [] },
  ]);
  // Employee names: owners + every collaborator (collaborator ids are only known after collabRes).
  const empIds = uniq([...rows.map(t => t.owner_employee_id), ...(collabRes.data || []).map(c => c.employee_id)]);
  const empRes = empIds.length ? await sbPodium(`/rest/v1/employees?id=in.${inList(empIds)}&select=id,full_name`, env) : { data: [] };
  const progIds = uniq(rows.map(t => t.program_id));
  const progRes = progIds.length ? await sbDocket(`/rest/v1/programs?id=in.${inList(progIds)}&select=id,name,color`, env) : { data: [] };
  const progMap = {}; (progRes.data || []).forEach(p => { progMap[p.id] = p; });
  const deptName = {}; (deptRes.data || []).forEach(d => { deptName[d.id] = d.name; });
  const empName  = {}; (empRes.data  || []).forEach(e => { empName[e.id] = e.full_name; });
  const creatorName = {}; (creatorRes.data || []).forEach(u => { creatorName[u.id] = u.full_name; });
  const childCount = {}, childDone = {};
  (childRes.data || []).forEach(c => {
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
    ...t,
    department_name: deptName[t.department_id] || null,
    owner_name: empName[t.owner_employee_id] || null,
    creator_name: creatorName[t.created_by_user_id] || null,
    program: progMap[t.program_id] || null,
    collaborators: collabByTask[t.id] || [],
    child_count: childCount[t.id] || 0, child_done: childDone[t.id] || 0,
    collab_count: (collabByTask[t.id] || []).length, doc_count: docs[t.id] || 0, comment_count: comm[t.id] || 0,
    _can_edit: canEditTask(auth, t),
  }));
}

async function getTasks(url, auth, env) {
  const q = url.searchParams;
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
    p_overdue: q.get('overdue') === '1' || q.get('overdue') === 'true',
    p_revised: q.get('revised') === '1' || q.get('revised') === 'true',
    p_parent_id: q.get('parent_id') || null,
    p_mine: q.get('lens') === 'mine',
    p_q: q.get('q') || null,
    p_program_id: q.get('program_id') || null,
  };
  const r = await sbDocket(`/rest/v1/rpc/list_tasks`, env, { method: 'POST', body: JSON.stringify(params) });
  if (!r.ok) return err('db_error: ' + JSON.stringify(r.data), 500);
  const rows = await hydrateTasks(r.data || [], auth, env);
  return ok(rows);
}

async function getTask(url, auth, env) {
  const id = url.searchParams.get('id');
  if (!id) return err('id required', 400);
  const task = await loadTask(id, env);
  if (!task) return err('not_found', 404);
  // Space gate: General falls back to the V1 baseline (own/collab/dept/view-all);
  // a private space requires membership (admins included — RULE-DOCKET-003).
  const space = await loadSpace(task.space_id, env);
  if (!space) return err('space_not_found', 404);
  if (space.is_default) { if (!(await canSeeTask(auth, task, env))) return err('forbidden', 403); }
  else { if (!(await canAccessSpace(auth, space, env))) return err('forbidden_space', 403); }

  const [parentRes, childRes, collabRes, docRes, commRes, histRes] = await Promise.all([
    task.parent_task_id
      ? sbDocket(`/rest/v1/tasks?id=eq.${enc(task.parent_task_id)}&select=id,task_no,title,status&limit=1`, env)
      : { data: [] },
    sbDocket(`/rest/v1/tasks?parent_task_id=eq.${enc(id)}&select=id,task_no,title,status,priority,owner_employee_id,deadline,revised_deadline&order=created_at.asc`, env),
    sbDocket(`/rest/v1/task_collaborators?task_id=eq.${enc(id)}&select=employee_id,added_at`, env),
    sbDocket(`/rest/v1/task_documents?task_id=eq.${enc(id)}&select=*&order=added_at.asc`, env),
    sbDocket(`/rest/v1/task_comments?task_id=eq.${enc(id)}&deleted_at=is.null&select=*&order=created_at.asc`, env),
    sbDocket(`/rest/v1/task_history?task_id=eq.${enc(id)}&select=*&order=created_at.asc`, env),
  ]);

  // Resolve all employee names referenced (owner/assignee/collaborators/children-assignees) in one read.
  const empIds = uniq([
    task.owner_employee_id,
    ...(collabRes.data || []).map(c => c.employee_id),
    ...(childRes.data || []).map(c => c.owner_employee_id),
  ]);
  const deptRes = task.department_id
    ? await sbPodium(`/rest/v1/departments?id=eq.${enc(task.department_id)}&select=id,name&limit=1`, env)
    : { data: [] };
  const empRes = empIds.length
    ? await sbPodium(`/rest/v1/employees?id=in.${inList(empIds)}&select=id,full_name`, env) : { data: [] };
  const empName = {}; (empRes.data || []).forEach(e => { empName[e.id] = e.full_name; });

  // Resolve LOT user names for the creator + comment authors + history actors (store.users_profile).
  const userIds = uniq([
    task.created_by_user_id,
    ...(commRes.data || []).map(c => c.author_user_id),
    ...(histRes.data || []).map(h => h.actor_user_id),
  ]);
  const upRes = userIds.length
    ? await sbStore(`/rest/v1/users_profile?id=in.${inList(userIds)}&select=id,full_name`, env) : { data: [] };
  const userName = {}; (upRes.data || []).forEach(u => { userName[u.id] = u.full_name; });

  const children = (childRes.data || []).map(c => ({ ...c, owner_name: empName[c.owner_employee_id] || null }));
  const prog = task.program_id
    ? (await sbDocket(`/rest/v1/programs?id=eq.${enc(task.program_id)}&select=id,name,color&limit=1`, env)).data?.[0]
    : null;
  return ok({
    ...task,
    department_name: deptRes.data?.[0]?.name || null,
    owner_name: empName[task.owner_employee_id] || null,
    creator_name: userName[task.created_by_user_id] || null,
    space: { id: space.id, name: space.name, is_private: space.is_private },
    program: prog || null,
    parent: parentRes.data?.[0] || null,
    children,
    child_count: children.length,
    child_done: children.filter(c => c.status === 'done').length,
    collaborators: (collabRes.data || []).map(c => ({ ...c, full_name: empName[c.employee_id] || null })),
    documents: docRes.data || [],
    comments: (commRes.data || []).map(c => ({ ...c, author_name: userName[c.author_user_id] || null })),
    history: (histRes.data || []).map(h => ({ ...h, actor_name: userName[h.actor_user_id] || null })),
    _can_edit: canEditTask(auth, task),
  });
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
  const live = (tRes.data || []).filter(t => !isExpired(t.recurrence, date));
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
      const itemComplRes = itemIds.length
        ? await sbDocket(`/rest/v1/checklist_item_completions?template_item_id=in.${inList(itemIds)}&employee_id=eq.${enc(targetId)}&occurrence_date=eq.${date}&select=template_item_id,completed_at,completed_by_user_id`, env)
        : { data: [] };
      const itemCompl = {}; (itemComplRes.data || []).forEach(c => { itemCompl[c.template_item_id] = c; });
      allCompleterIds = uniq([...allCompleterIds, ...Object.values(itemCompl).map(c => c.completed_by_user_id)]);
      const commBySec = {}; (secCommRes.data || []).forEach(c => { commBySec[c.section_id] = c.body || ''; });
      const itemsBySec = {}; items.forEach(i => { (itemsBySec[i.section_id] ||= []).push(i); });
      const deptName = {}; (deptRes.data || []).forEach(d => { deptName[d.id] = d.name; });
      const secByT = {}; sections.forEach(s => { (secByT[s.template_id] ||= []).push(s); });
      template_runs = dueTmpls.map(t => ({
        template: { id: t.id, name: t.name, role_label: t.role_label, department_name: deptName[t.department_id] || null },
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
    ? await sbDocket(`/rest/v1/checklist_templates?id=in.${inList(tmplIds)}&archived_at=is.null&is_active=eq.true&select=id,name,recurrence`, env)
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

  const itemsBySec = {}; items.forEach(i => { (itemsBySec[i.section_id] ||= []).push(i.id); });
  const secByTmpl = {}; sections.forEach(s => { (secByTmpl[s.template_id] ||= []).push(s); });
  const tmplsByEmp = {}; asg.forEach(a => { if (tmplById[a.template_id]) (tmplsByEmp[a.employee_id] ||= []).push(a.template_id); });

  const people = emps.map(e => {
    const recIds = recByEmp[e.id] || [];
    const recurring = { done: recIds.filter(id => recDone.has(id)).length, total: recIds.length };
    const templates = (tmplsByEmp[e.id] || []).filter(tid => dueTmplIds.includes(tid)).map(tid => {
      const secs = secByTmpl[tid] || [];
      let done = 0, total = 0; const incompleteSections = [];
      for (const s of secs) {
        const sItemIds = itemsBySec[s.id] || [];
        const sDone = sItemIds.filter(iid => doneByEmpItem.has(`${e.id}|${iid}`)).length;
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

async function createTaskCore(d, auth, env) {
  // Quick-capture: only a title is required. Everything else (team/owner/assignee/
  // deadline) is optional and enriched later — the task lands in "The Grid" until it
  // has both an owner and a deadline. (RULE-DOCKET-001, V2.)
  if (!d.title || !String(d.title).trim()) return err('title required', 400);

  // Recurring (checklist) task: validate the rule, force top-level, default owner = caller.
  const isRecurring = !!d.is_recurring;
  if (isRecurring) {
    const e = validateRecurrence(d.recurrence);
    if (e) return err(e, 400);
    d.recurrence = normalizeRecurrence(d.recurrence);
    d.parent_task_id = null;                                  // recurring tasks are top-level (v1)
    if (d.owner_employee_id == null) d.owner_employee_id = auth.employeeId || null; // "create for myself"
  }

  let parentId = d.parent_task_id || null;
  let spaceId = d.space_id || null;
  if (parentId) {
    const parent = await loadTask(parentId, env);
    if (!parent) return err('parent_not_found', 404);
    if (parent.parent_task_id) return err('one_level_only: parent is already a sub-task', 422);
    spaceId = parent.space_id; // a sub-task always lives in its parent's space
    // A sub-task inherits owner / program / team from its parent unless the caller
    // explicitly set them (speed-create passes title only — these fill in from the parent).
    if (d.owner_employee_id == null) d.owner_employee_id = parent.owner_employee_id || null;
    if (d.program_id == null)        d.program_id        = parent.program_id || null;
    if (d.department_id == null)     d.department_id     = parent.department_id || null;
  }
  if (!spaceId) spaceId = await defaultSpaceId(env);
  const space = await loadSpace(spaceId, env);
  if (!space) return err('space_not_found', 404);
  if (!(await canAccessSpace(auth, space, env))) return err('forbidden_space', 403);
  const task_no = await mintTaskNo(env);
  const ins = await sbDocket(`/rest/v1/tasks`, env, {
    method: 'POST',
    body: JSON.stringify([{
      task_no, title: String(d.title).trim(), description: d.description || null,
      department_id: d.department_id || null, owner_employee_id: d.owner_employee_id || null,
      status: isRecurring ? 'in_progress' : 'not_started', priority: d.priority || 'P2',
      parent_task_id: parentId, created_by_user_id: auth.userId,
      deadline: d.deadline || null, custom_fields: d.custom_fields || {},
      space_id: spaceId, program_id: d.program_id || null,
      is_recurring: isRecurring, recurrence: isRecurring ? d.recurrence : null,
    }]),
  });
  if (!ins.ok || !ins.data?.[0]) return err('create_failed: ' + JSON.stringify(ins.data), 400);
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
  await logHistory(env, task.id, auth.userId, parentId ? 'created' : 'created',
    { note: parentId ? 'sub-task' : null });
  return ok({ id: task.id, task_no: task.task_no });
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
  const task = await loadTask(d.id, env);
  if (!task) return err('not_found', 404);
  if (!task.is_recurring) return err('not_a_recurring_task', 422);
  if (!canEditTask(auth, task)) return err('forbidden', 403);
  const rec = normalizeRecurrence(d.recurrence);
  const r = await sbDocket(`/rest/v1/tasks?id=eq.${enc(d.id)}`, env, {
    method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({ recurrence: rec, updated_by: auth.userId, updated_at: nowIso() }) });
  if (!r.ok) return err('update_failed: ' + JSON.stringify(r.data), 400);
  await logHistory(env, task.id, auth.userId, 'recurrence_changed',
    { field: 'recurrence', old: JSON.stringify(task.recurrence), new: JSON.stringify(rec) });
  return ok({ id: task.id, recurrence: rec });
}
// Check/uncheck one occurrence (date defaults to IST today). The completion row IS the audit.
async function toggleChecklistOccurrence(body, auth, env) {
  const d = body.data || body;
  if (!d.id) return err('id required', 400);
  const task = await loadTask(d.id, env);
  if (!task) return err('not_found', 404);
  if (!task.is_recurring) return err('not_a_recurring_task', 422);
  if (!canEditTask(auth, task)) return err('forbidden', 403);
  const date = d.date || istDateStr();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return err('invalid date', 400);
  const completed = d.completed === true || d.completed === 'true';
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
  const recErr = validateTemplateRecurrence(d.recurrence); if (recErr) return err(recErr, 400);
  const rec = normalizeTemplateRecurrence(d.recurrence);
  const sectionsIn = Array.isArray(d.sections) ? d.sections : [];

  let template;
  if (d.id) {
    template = await loadTemplate(d.id, env);
    if (!template) return err('not_found', 404);
    if (!canEditTemplate(auth, template)) return err('forbidden', 403);
    const upd = {
      name: String(d.name).trim(), role_label: d.role_label || null,
      department_id: d.department_id || null, description: d.description || null,
      recurrence: rec, is_active: d.is_active !== false,
      updated_at: nowIso(), updated_by_user_id: auth.userId,
    };
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
      }]) });
    if (!r.ok || !r.data?.[0]) return err('create_failed: ' + JSON.stringify(r.data), 400);
    template = r.data[0];
  }

  // Diff-upsert sections + items. Delete sections/items not present in the payload
  // (CASCADE drops their items + any completions/comments — acceptable: editing structure).
  // Bounded fan-out (a template has ~7 sections × ~8 items, well under the 50-subrequest limit).
  const existSecRes = await sbDocket(
    `/rest/v1/checklist_template_sections?template_id=eq.${enc(template.id)}&select=id`, env);
  const existSecIds = (existSecRes.data || []).map(s => s.id);
  const keepSecIds = sectionsIn.map(s => s.id).filter(Boolean);
  const dropSecIds = existSecIds.filter(id => !keepSecIds.includes(id));
  if (dropSecIds.length) {
    await sbDocket(`/rest/v1/checklist_template_sections?id=in.${inList(dropSecIds)}`, env,
      { method: 'DELETE', prefer: 'return=minimal' });
  }

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
      await sbDocket(`/rest/v1/checklist_template_sections?id=eq.${enc(sectionId)}`, env,
        { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(secRow) });
    } else {
      const sr = await sbDocket(`/rest/v1/checklist_template_sections`, env,
        { method: 'POST', body: JSON.stringify([secRow]) });
      if (!sr.ok || !sr.data?.[0]) return err('section_failed: ' + JSON.stringify(sr.data), 400);
      sectionId = sr.data[0].id;
    }
    const itemsIn = Array.isArray(s.items) ? s.items : [];
    const existItemRes = await sbDocket(
      `/rest/v1/checklist_template_items?section_id=eq.${enc(sectionId)}&select=id`, env);
    const existItemIds = (existItemRes.data || []).map(i => i.id);
    const keepItemIds = itemsIn.map(i => i.id).filter(Boolean);
    const dropItemIds = existItemIds.filter(id => !keepItemIds.includes(id));
    if (dropItemIds.length) {
      await sbDocket(`/rest/v1/checklist_template_items?id=in.${inList(dropItemIds)}`, env,
        { method: 'DELETE', prefer: 'return=minimal' });
    }
    const toInsert = [];
    for (let ii = 0; ii < itemsIn.length; ii++) {
      const it = itemsIn[ii];
      const itemRow = {
        section_id: sectionId, title: String(it.title || '').trim() || 'Item',
        help_text: it.help_text || null, tags: sanitizeTags(it.tags), sort_order: ii,
      };
      if (it.id) {
        await sbDocket(`/rest/v1/checklist_template_items?id=eq.${enc(it.id)}`, env,
          { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(itemRow) });
      } else {
        toInsert.push(itemRow);
      }
    }
    if (toInsert.length) {
      await sbDocket(`/rest/v1/checklist_template_items`, env,
        { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(toInsert) });
    }
  }
  return ok({ id: template.id });
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
  return ok({ archived: d.id });
}

// ── Checklist template assignment (RULE-DOCKET-009) ─────────────────────────
// Open authoring → any authenticated user may assign. Idempotent via a pre-check
// (the active-partial unique index can't be a PostgREST on_conflict target).
async function assignChecklistTemplate(body, auth, env) {
  const d = body.data || body;
  if (!d.template_id || !d.employee_id) return err('template_id + employee_id required', 400);
  const tmpl = await loadTemplate(d.template_id, env);
  if (!tmpl) return err('template_not_found', 404);
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
  const date = d.date || istDateStr();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return err('invalid date', 400);
  const completed = d.completed === true || d.completed === 'true';
  if (completed) {
    const r = await sbDocket(`/rest/v1/checklist_item_completions?on_conflict=template_item_id,employee_id,occurrence_date`, env, {
      method: 'POST', prefer: 'return=minimal,resolution=ignore-duplicates',
      body: JSON.stringify({ template_item_id: d.template_item_id, employee_id: auth.employeeId, occurrence_date: date, completed_by_user_id: auth.userId }) });
    if (!r.ok) return err('complete_failed: ' + JSON.stringify(r.data), 400);
  } else {
    await sbDocket(`/rest/v1/checklist_item_completions?template_item_id=eq.${enc(d.template_item_id)}&employee_id=eq.${enc(auth.employeeId)}&occurrence_date=eq.${date}`, env,
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
  const task = await loadTask(d.id, env);
  if (!task) return err('not_found', 404);
  if (!canEditTask(auth, task)) return err('forbidden', 403);

  const updates = {}; const changes = [];
  for (const f of EDITABLE) {
    if (d[f] !== undefined && d[f] !== task[f] && !PROTECTED.has(f)) {
      updates[f] = d[f]; changes.push([f, task[f], d[f]]);
    }
  }
  // First-time deadline set (task was quick-captured to The Grid with no deadline).
  // This becomes the immutable original — afterwards only reviseDeadline changes it.
  let deadlineSet = false;
  if (d.deadline && !task.deadline) { updates.deadline = d.deadline; deadlineSet = true; }
  if (d.custom_fields !== undefined) updates.custom_fields = d.custom_fields;
  if (!Object.keys(updates).length) return ok({ id: task.id, unchanged: true });
  updates.updated_by = auth.userId; updates.updated_at = nowIso();
  const r = await sbDocket(`/rest/v1/tasks?id=eq.${enc(d.id)}`, env, { method: 'PATCH', body: JSON.stringify(updates) });
  if (!r.ok) return err('update_failed: ' + JSON.stringify(r.data), 400);
  for (const [f, oldV, newV] of changes) await logHistory(env, task.id, auth.userId, `${f}_changed`, { field: f, old: oldV, new: newV });
  if (deadlineSet) await logHistory(env, task.id, auth.userId, 'deadline_set', { field: 'deadline', new: d.deadline });
  return ok({ id: task.id, updated: [...changes.map(c => c[0]), ...(deadlineSet ? ['deadline'] : [])] });
}

const STATUSES = ['not_started','in_progress','done','blocked','abandoned'];
async function changeStatus(body, auth, env) {
  const d = body.data || body;
  if (!d.id || !d.status) return err('id and status required', 400);
  if (!STATUSES.includes(d.status)) return err('invalid status', 400);
  if (d.status === 'abandoned') return err('use abandonTask to abandon (reason required)', 422);
  const task = await loadTask(d.id, env);
  if (!task) return err('not_found', 404);
  if (!canEditTask(auth, task)) return err('forbidden', 403);
  if (task.status === d.status) return ok({ id: task.id, unchanged: true });

  const updates = { status: d.status, updated_by: auth.userId, updated_at: nowIso() };
  updates.completed_at = d.status === 'done' ? nowIso() : null;
  // Re-activating a previously abandoned task clears the abandon stamp (logged below).
  if (task.status === 'abandoned') { updates.abandoned_at = null; updates.abandoned_by = null; updates.abandon_reason = null; }
  const r = await sbDocket(`/rest/v1/tasks?id=eq.${enc(d.id)}`, env, { method: 'PATCH', body: JSON.stringify(updates) });
  if (!r.ok) return err('update_failed: ' + JSON.stringify(r.data), 400);
  await logHistory(env, task.id, auth.userId, 'status_changed', { field: 'status', old: task.status, new: d.status, note: d.note || null });
  return ok({ id: task.id, status: d.status });
}

async function reviseDeadline(body, auth, env) {
  const d = body.data || body;
  if (!d.id || !d.new_deadline) return err('id and new_deadline required', 400);
  if (!d.reason || !String(d.reason).trim()) return err('reason required', 400);
  const task = await loadTask(d.id, env);
  if (!task) return err('not_found', 404);
  if (!canEditTask(auth, task)) return err('forbidden', 403);
  const prevEffective = task.revised_deadline || task.deadline;
  const r = await sbDocket(`/rest/v1/tasks?id=eq.${enc(d.id)}`, env, {
    method: 'PATCH', body: JSON.stringify({ revised_deadline: d.new_deadline, updated_by: auth.userId, updated_at: nowIso() }),
  });
  if (!r.ok) return err('update_failed: ' + JSON.stringify(r.data), 400);
  await logHistory(env, task.id, auth.userId, 'deadline_revised',
    { field: 'revised_deadline', old: prevEffective, new: d.new_deadline, note: d.reason });
  return ok({ id: task.id, revised_deadline: d.new_deadline });
}

async function abandonTask(body, auth, env) {
  const d = body.data || body;
  if (!d.id) return err('id required', 400);
  if (!d.reason || !String(d.reason).trim()) return err('reason required', 400);
  const task = await loadTask(d.id, env);
  if (!task) return err('not_found', 404);
  if (!canEditTask(auth, task)) return err('forbidden', 403);
  const r = await sbDocket(`/rest/v1/tasks?id=eq.${enc(d.id)}`, env, {
    method: 'PATCH', body: JSON.stringify({
      status: 'abandoned', abandoned_at: nowIso(), abandoned_by: auth.userId,
      abandon_reason: d.reason, updated_by: auth.userId, updated_at: nowIso(),
    }),
  });
  if (!r.ok) return err('update_failed: ' + JSON.stringify(r.data), 400);
  await logHistory(env, task.id, auth.userId, 'abandoned', { field: 'status', old: task.status, new: 'abandoned', note: d.reason });
  return ok({ id: task.id, status: 'abandoned' });
}

async function setParent(body, auth, env) {
  const d = body.data || body;
  if (!d.id) return err('id required', 400);
  const task = await loadTask(d.id, env);
  if (!task) return err('not_found', 404);
  if (!canEditTask(auth, task)) return err('forbidden', 403);
  const newParent = d.parent_task_id || null;
  if (newParent) {
    if (newParent === task.id) return err('a task cannot be its own parent', 422);
    const parent = await loadTask(newParent, env);
    if (!parent) return err('parent_not_found', 404);
    if (parent.parent_task_id) return err('one_level_only: parent is already a sub-task', 422);
    const kids = await sbDocket(`/rest/v1/tasks?parent_task_id=eq.${enc(task.id)}&select=id&limit=1`, env);
    if (kids.ok && kids.data?.length) return err('one_level_only: this task already has sub-tasks', 422);
  }
  const r = await sbDocket(`/rest/v1/tasks?id=eq.${enc(d.id)}`, env, {
    method: 'PATCH', body: JSON.stringify({ parent_task_id: newParent, updated_by: auth.userId, updated_at: nowIso() }),
  });
  if (!r.ok) return err('update_failed: ' + JSON.stringify(r.data), 400);
  await logHistory(env, task.id, auth.userId, 'parent_changed', { field: 'parent_task_id', old: task.parent_task_id, new: newParent });
  return ok({ id: task.id, parent_task_id: newParent });
}

// Move a task (and its sub-tasks) to another space. RULE-DOCKET-003.
async function moveTask(body, auth, env) {
  const d = body.data || body;
  if (!d.id || !d.space_id) return err('id and space_id required', 400);
  const task = await loadTask(d.id, env);
  if (!task) return err('not_found', 404);
  if (!canEditTask(auth, task)) return err('forbidden', 403);
  const target = await loadSpace(d.space_id, env);
  if (!target) return err('space_not_found', 404);
  if (!(await canAccessSpace(auth, target, env))) return err('forbidden_space', 403);
  if (task.space_id === d.space_id) return ok({ id: task.id, unchanged: true });
  await sbDocket(`/rest/v1/tasks?id=eq.${enc(d.id)}`, env, { method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({ space_id: d.space_id, updated_by: auth.userId, updated_at: nowIso() }) });
  // sub-tasks travel with their parent (one level)
  await sbDocket(`/rest/v1/tasks?parent_task_id=eq.${enc(d.id)}`, env, { method: 'PATCH', prefer: 'return=minimal',
    body: JSON.stringify({ space_id: d.space_id }) });
  await logHistory(env, task.id, auth.userId, 'space_changed', { field: 'space_id', old: task.space_id, new: d.space_id });
  return ok({ id: task.id, space_id: d.space_id });
}

async function addCollaborator(body, auth, env) {
  const d = body.data || body;
  if (!d.id || !d.employee_id) return err('id and employee_id required', 400);
  const task = await loadTask(d.id, env);
  if (!task) return err('not_found', 404);
  if (!canEditTask(auth, task)) return err('forbidden', 403);
  const r = await sbDocket(`/rest/v1/task_collaborators?on_conflict=task_id,employee_id`, env, {
    method: 'POST', prefer: 'return=minimal,resolution=ignore-duplicates',
    body: JSON.stringify({ task_id: d.id, employee_id: d.employee_id, added_by: auth.userId }),
  });
  if (!r.ok) return err('add_failed: ' + JSON.stringify(r.data), 400);
  await logHistory(env, task.id, auth.userId, 'collaborator_added', { field: 'collaborator', new: d.employee_id });
  return ok({ id: task.id, employee_id: d.employee_id });
}
async function removeCollaborator(body, auth, env) {
  const d = body.data || body;
  if (!d.id || !d.employee_id) return err('id and employee_id required', 400);
  const task = await loadTask(d.id, env);
  if (!task) return err('not_found', 404);
  if (!canEditTask(auth, task)) return err('forbidden', 403);
  await sbDocket(`/rest/v1/task_collaborators?task_id=eq.${enc(d.id)}&employee_id=eq.${enc(d.employee_id)}`, env,
    { method: 'DELETE', prefer: 'return=minimal' });
  await logHistory(env, task.id, auth.userId, 'collaborator_removed', { field: 'collaborator', old: d.employee_id });
  return ok({ id: task.id, removed: d.employee_id });
}

async function addDocument(body, auth, env) {
  const d = body.data || body;
  if (!d.id || !d.url) return err('id and url required', 400);
  if (!isHttpUrl(d.url)) return err('url must start with http:// or https://', 400);
  const task = await loadTask(d.id, env);
  if (!task) return err('not_found', 404);
  if (!(await canSeeTask(auth, task, env))) return err('forbidden', 403);
  const r = await sbDocket(`/rest/v1/task_documents`, env, {
    method: 'POST',
    body: JSON.stringify([{ task_id: d.id, title: d.title || null, url: d.url.trim(), added_by: auth.userId }]),
  });
  if (!r.ok || !r.data?.[0]) return err('add_failed: ' + JSON.stringify(r.data), 400);
  await logHistory(env, task.id, auth.userId, 'document_added', { field: 'document', new: d.title || d.url });
  return ok(r.data[0]);
}
async function removeDocument(body, auth, env) {
  const d = body.data || body;
  if (!d.document_id) return err('document_id required', 400);
  const docRes = await sbDocket(`/rest/v1/task_documents?id=eq.${enc(d.document_id)}&select=*&limit=1`, env);
  const doc = docRes.ok && docRes.data?.[0];
  if (!doc) return err('not_found', 404);
  const task = await loadTask(doc.task_id, env);
  if (!task) return err('not_found', 404);
  if (!canEditTask(auth, task) && doc.added_by !== auth.userId) return err('forbidden', 403);
  await sbDocket(`/rest/v1/task_documents?id=eq.${enc(d.document_id)}`, env, { method: 'DELETE', prefer: 'return=minimal' });
  await logHistory(env, task.id, auth.userId, 'document_removed', { field: 'document', old: doc.title || doc.url });
  return ok({ removed: d.document_id });
}

async function addComment(body, auth, env) {
  const d = body.data || body;
  if (!d.id || !d.body || !String(d.body).trim()) return err('id and body required', 400);
  const task = await loadTask(d.id, env);
  if (!task) return err('not_found', 404);
  if (!(await canSeeTask(auth, task, env))) return err('forbidden', 403);
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
  await sbDocket(`/rest/v1/task_comments?id=eq.${enc(d.comment_id)}`, env, {
    method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ deleted_at: nowIso() }),
  });
  return ok({ deleted: d.comment_id });
}

// ── Permission layer (admin) — mirrors Podium ───────────────────────────────
async function createDocketRole(body, auth, env) {
  const gate = requireAdmin(auth); if (gate) return gate;
  const d = body.data || body;
  if (!d.role_key || !d.label) return err('role_key and label required', 400);
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
  const cur = await sbStore(`/rest/v1/docket_roles?role_key=eq.${enc(d.role_key)}&select=is_system&limit=1`, env);
  const isSys = !!(cur.ok && cur.data?.[0]?.is_system);
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
  if (chk.ok && chk.data?.[0]?.is_system) return err('cannot delete a system role', 400);
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
async function createProgram(body, auth, env) {
  const d = body.data || body;
  if (!d.name || !String(d.name).trim()) return err('name required', 400);
  const name = String(d.name).trim();
  // Idempotent inline create: reuse an existing (case-insensitive) program if present.
  const existing = await sbDocket(`/rest/v1/programs?archived_at=is.null&name=ilike.${enc(name)}&select=id,name,color&limit=1`, env);
  if (existing.ok && existing.data?.[0]) return ok(existing.data[0]);
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
// Owner of a private space, or a docket_admin (break-glass), may manage it. General is system.
async function requireSpaceOwner(auth, space) {
  if (!space) return err('space_not_found', 404);
  if (space.is_default) return err('general_is_system', 422);
  if (!isSpaceOwner(auth, space) && !isAdmin(auth)) return err('forbidden_space_owner', 403);
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
  await sbDocket(`/rest/v1/spaces?id=eq.${enc(d.id)}`, env, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ archived_at: nowIso() }) });
  await logSpace(env, d.id, auth.userId, 'archived', null);
  return ok({ id: d.id, archived: true });
}
async function addSpaceMember(body, auth, env) {
  const d = body.data || body; if (!d.space_id || !d.user_id) return err('space_id and user_id required', 400);
  const space = await loadSpace(d.space_id, env); const gate = await requireSpaceOwner(auth, space); if (gate) return gate;
  await sbDocket(`/rest/v1/space_members?on_conflict=space_id,user_id`, env, { method: 'POST', prefer: 'return=minimal,resolution=ignore-duplicates',
    body: JSON.stringify({ space_id: d.space_id, user_id: d.user_id, added_by_user_id: auth.userId }) });
  await logSpace(env, d.space_id, auth.userId, 'member_added', d.user_id);
  return ok({ space_id: d.space_id, user_id: d.user_id });
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
  if (!isSpaceOwner(auth, space) && !isAdmin(auth)) return err('forbidden_space_owner', 403);
  if (!(await isSpaceMember(d.space_id, d.new_owner_user_id, env))) return err('new owner must be a member first', 422);
  await sbDocket(`/rest/v1/spaces?id=eq.${enc(d.space_id)}`, env, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ owner_user_id: d.new_owner_user_id }) });
  await logSpace(env, d.space_id, auth.userId, 'ownership_transferred', d.new_owner_user_id);
  return ok({ space_id: d.space_id, owner_user_id: d.new_owner_user_id });
}
// Break-glass: a docket_admin recovers an orphaned/locked private space. Audited.
async function recoverSpace(body, auth, env) {
  const gate = requireAdmin(auth); if (gate) return gate;
  const d = body.data || body; if (!d.space_id) return err('space_id required', 400);
  const space = await loadSpace(d.space_id, env);
  if (!space || space.is_default) return err('not_recoverable', 422);
  const newOwner = d.new_owner_user_id || auth.userId;
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

// ════════════════════════════════════════════════════════════════════════════
// Dispatch
// ════════════════════════════════════════════════════════════════════════════
const GET_ACTIONS = {
  getMe, getDepartments, getEmployees,
  getTasks, getTask, getDashboard,
  getChecklist, getChecklistTemplates, getChecklistTemplate, getChecklistOversight,
  getPrograms, getSpaces, getSpaceMembers, getAllSpaces,
  getScratchNotes,
  getDocketRoles, getDocketUsers, getDashboardSharing,
};
const POST_ACTIONS = {
  createTask, createSubtask, updateTask, changeStatus, reviseDeadline, abandonTask, setParent, moveTask,
  createRecurringTask, updateRecurrence, toggleChecklistOccurrence,
  saveChecklistTemplate, archiveChecklistTemplate,
  assignChecklistTemplate, unassignChecklistTemplate,
  toggleChecklistItem, saveSectionComment,
  addCollaborator, removeCollaborator,
  addDocument, removeDocument,
  addComment, editComment, deleteComment,
  createProgram,
  createSpace, renameSpace, archiveSpace, addSpaceMember, removeSpaceMember, transferSpaceOwnership, recoverSpace,
  createScratchNote, updateScratchNote, deleteScratchNote,
  createDocketRole, updateDocketRole, deleteDocketRole, assignDocketRole,
  setDashboardPublic, addDashboardViewer, removeDashboardViewer,
};

async function handleGet(url, request, env) {
  const action = url.searchParams.get('action');
  if (!action) return err('action_required', 400);
  if (action === 'ping') return ok({ pong: true });
  const auth = await verifyJWT(request.headers.get('Authorization'), env);
  if (!auth) return err('unauthorized', 401);
  const handler = GET_ACTIONS[action];
  if (!handler) return err(`unknown_action: ${action}`, 400);
  try { return await handler(url, auth, env); }
  catch (e) { return err(`server_error: ${e?.message || String(e)}`, 500); }
}
async function handlePost(request, env) {
  const auth = await verifyJWT(request.headers.get('Authorization'), env);
  if (!auth) return err('unauthorized', 401);
  let body; try { body = await request.json(); } catch { return err('bad_json', 400); }
  const action = body?.action;
  if (!action) return err('action_required', 400);
  await touchActivity(auth, env);   // mutation presence ping (best-effort, swallows its own errors)
  const handler = POST_ACTIONS[action];
  if (!handler) return err(`unknown_action: ${action}`, 400);
  try { return await handler(body, auth, env); }
  catch (e) { return err(`server_error: ${e?.message || String(e)}`, 500); }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    if (url.pathname === '/health' || url.pathname === '/healthz') return ok({ service: 'docketops', time: nowIso() });
    if (request.method === 'GET')  return handleGet(url, request, env);
    if (request.method === 'POST') return handlePost(request, env);
    return err('method_not_allowed', 405);
  },
};
