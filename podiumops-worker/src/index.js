/**
 * Podium — podiumops Cloudflare Worker
 * podiumops.afshaan.workers.dev
 *
 * API for the LOT People & Performance OS at podium.legendoftoys.com.
 * Sibling to lotopsproxy (Garage/Redline/Scanner), throttleops (Throttle),
 * csops (Pitstop), and ignitionops (Ignition).
 *
 * Pattern: GET  /?action=<actionName>            (reads)
 *          POST /  body: { action, ...params }   (writes, JWT-authenticated)
 *
 * SECURITY — this is the most confidential LOT system. The worker (service_role,
 * BYPASSRLS) is the SOLE DB client; RLS-on/no-anon-grants is the backstop. Access
 * is strictly tiered (RULE-PODIUM-001):
 *   - podium_admin / podium_hr : everything (admin = full; hr = no settings)
 *   - podium_comp              : compensation + salary bands (separate key)
 *   - podium_view              : baseline — directory + org chart + own record;
 *                                full profile/docs only for self or one's reports
 * Manager powers are derived from the org graph (manager_id chain), NOT a flat perm.
 * The absolute-salary vault (compensation_events.old_ctc/new_ctc/components) ships
 * but is gated OFF via podium.settings.comp_vault_enabled until Phase 5 hardening.
 *
 * Spec:  systems/podium.md ; docs/superpowers/specs/2026-06-02-podium-design.md
 */

// ── CORS ────────────────────────────────────────────────────────────────────

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
function err(message, status = 400) { return json({ ok: false, error: message }, status); }
function ok(data) { return json({ ok: true, data }); }
function nowIso() { return new Date().toISOString(); }

// ── Supabase helpers ────────────────────────────────────────────────────────

async function sb(path, env, opts = {}) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type':    'application/json',
      'apikey':          env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization':   `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Accept-Profile':  'podium',
      'Content-Profile': 'podium',
      'Prefer':          opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

async function sbStore(path, env, opts = {}) {
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

// Storage REST (private bucket podium-documents). Service-role only.
async function storageFetch(path, env, opts = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/storage/v1${path}`, {
    ...opts,
    headers: {
      'apikey':        env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

const DOC_BUCKET = 'podium-documents';

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
    `/rest/v1/users_profile?id=eq.${user.id}&select=role,full_name,active&limit=1`,
    env,
  );
  if (!profileRes.ok || !profileRes.data?.[0]) return null;
  const profile = profileRes.data[0];
  if (!profile.active) return null;

  // Podium permissions come from Podium's OWN layer (store.podium_user_roles →
  // store.podium_roles.permissions), NOT the shared store.roles (RULE-PODIUM-006,
  // mirrors Snorkel/RULE-SNORKEL-002). No assigned role → {} → self-only baseline
  // (own profile + own wins via /me; see the self-serve gate in handleGet/handlePost).
  const urRes = await sbStore(
    `/rest/v1/podium_user_roles?user_id=eq.${user.id}&select=role_key&limit=1`,
    env,
  );
  const podiumRole = (urRes.ok && urRes.data?.[0]?.role_key) || null;
  let permissions = {};
  if (podiumRole) {
    const prRes = await sbStore(
      `/rest/v1/podium_roles?role_key=eq.${encodeURIComponent(podiumRole)}&select=permissions&limit=1`,
      env,
    );
    permissions = (prRes.ok && prRes.data?.[0]?.permissions) || {};
  }

  return {
    userId: user.id,
    email: user.email,
    role: profile.role,
    podiumRole,
    fullName: profile.full_name,
    permissions,
    bearer: token,
  };
}

// ── Permission tiers ─────────────────────────────────────────────────────────

function hasPerm(auth, perm) { return !!auth?.permissions?.[perm]; }
function isAdmin(auth) { return hasPerm(auth, 'podium_admin'); }
function isHr(auth)    { return isAdmin(auth) || hasPerm(auth, 'podium_hr'); }
function canComp(auth) { return isAdmin(auth) || hasPerm(auth, 'podium_comp'); }

function requireHr(auth)    { return isHr(auth)    ? null : err('Forbidden — requires podium_hr', 403); }
function requireComp(auth)  { return canComp(auth) ? null : err('Forbidden — requires podium_comp', 403); }
function requireAdmin(auth) { return isAdmin(auth) ? null : err('Forbidden — requires podium_admin', 403); }

// ── Org graph (manager_id chain) — small table, loaded once per request ──────

async function loadOrgEdges(env) {
  const r = await sb(`/rest/v1/employees?select=id,manager_id,auth_user_id&limit=5000`, env);
  return r.ok ? (r.data || []) : [];
}
function callerEmployee(edges, userId) {
  return edges.find(e => e.auth_user_id === userId) || null;
}
// Is mgrEmpId == empId, or an ancestor manager of empId? (self counts as "can see self")
function inManagerChain(edges, empId, mgrEmpId) {
  if (!empId || !mgrEmpId) return false;
  const byId = Object.fromEntries(edges.map(e => [e.id, e]));
  let cur = byId[empId];
  let depth = 0;
  while (cur && depth++ < 25) {
    if (cur.id === mgrEmpId) return true;
    if (!cur.manager_id) break;
    cur = byId[cur.manager_id];
  }
  return false;
}
// Can the caller see employee E's FULL profile (contact, dates, etc.)?
function canSeeFull(auth, edges, employeeId) {
  if (isHr(auth)) return true;
  const me = callerEmployee(edges, auth.userId);
  if (!me) return false;
  return inManagerChain(edges, employeeId, me.id); // self OR caller is an ancestor manager
}

// Public (directory-safe) projection of an employee row.
const PUBLIC_EMP_KEYS = [
  'id', 'employee_code', 'full_name', 'preferred_name', 'job_title',
  'department_id', 'job_role_id', 'manager_id', 'photo_url', 'status', 'work_email',
];
function projectPublic(row) {
  const out = {};
  for (const k of PUBLIC_EMP_KEYS) if (k in row) out[k] = row[k];
  // keep embedded labels if present
  if (row.department) out.department = row.department;
  if (row.job_role)   out.job_role = row.job_role;
  if (row.manager)    out.manager = row.manager;
  out._restricted = true;
  return out;
}

const EMP_EMBED =
  'department:department_id(id,name,code),job_role:job_role_id(id,title,level),manager:manager_id(id,full_name,job_title)';

// ────────────────────────────────────────────────────────────────────────────
// GET ACTIONS
// ────────────────────────────────────────────────────────────────────────────

async function getMe(url, auth, env) {
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const sr = await sb(`/rest/v1/settings?id=eq.1&select=comp_vault_enabled,min_tenure_days&limit=1`, env);
  return ok({
    userId: auth.userId,
    email: auth.email,
    role: auth.role,
    fullName: auth.fullName,
    permissions: auth.permissions,
    employee_id: me?.id || null,
    settings: sr.data?.[0] || { comp_vault_enabled: false, min_tenure_days: 90 },
    tier: { admin: isAdmin(auth), hr: isHr(auth), comp: canComp(auth) },
  });
}

async function getSettings(url, auth, env) {
  const r = await sb(`/rest/v1/settings?id=eq.1&select=*&limit=1`, env);
  if (!r.ok) return err('db_error', 500);
  return ok(r.data?.[0] || null);
}

// Directory list. Everyone with podium_view sees it; rows the caller can't see in
// full are projected down to the public subset.
async function getEmployees(url, auth, env) {
  const status = url.searchParams.get('status');
  const department = url.searchParams.get('department_id');
  const search = (url.searchParams.get('search') || '').trim();
  const limit = Math.min(Number(url.searchParams.get('limit') || 500), 2000);
  const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);

  const filters = [];
  if (status && status !== 'all') filters.push(`status=eq.${encodeURIComponent(status)}`);
  else if (!status) filters.push('status=neq.exited');
  if (department) filters.push(`department_id=eq.${department}`);
  if (search) {
    const s = encodeURIComponent(search);
    filters.push(`or=(full_name.ilike.*${s}*,preferred_name.ilike.*${s}*,employee_code.ilike.*${s}*,work_email.ilike.*${s}*,job_title.ilike.*${s}*)`);
  }

  const [r, edges] = await Promise.all([
    sb(`/rest/v1/employees?${filters.join('&')}&select=*,${EMP_EMBED}&order=full_name.asc&limit=${limit}&offset=${offset}`, env),
    loadOrgEdges(env),
  ]);
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);
  const rows = (r.data || []).map(e => (canSeeFull(auth, edges, e.id) ? e : projectPublic(e)));
  return ok({ employees: rows, offset, limit });
}

async function getEmployee(url, auth, env) {
  const id = url.searchParams.get('id');
  const code = url.searchParams.get('code');
  if (!id && !code) return err('id or code required', 400);
  const filter = id ? `id=eq.${id}` : `employee_code=eq.${encodeURIComponent(code)}`;
  const [r, edges] = await Promise.all([
    sb(`/rest/v1/employees?${filter}&select=*,${EMP_EMBED}&limit=1`, env),
    loadOrgEdges(env),
  ]);
  if (!r.ok) return err('db_error', 500);
  const emp = r.data?.[0];
  if (!emp) return err('not_found', 404);
  const full = canSeeFull(auth, edges, emp.id);
  // Direct reports (directory-safe) for the profile's "Team" section.
  const reports = (r2 => (r2 || []))((await sb(
    `/rest/v1/employees?manager_id=eq.${emp.id}&status=neq.exited&select=id,employee_code,full_name,job_title,photo_url,status&order=full_name.asc`, env,
  )).data);
  return ok({ employee: full ? emp : projectPublic(emp), can_see_full: full, can_see_comp: canComp(auth), reports });
}

async function getOrgChart(url, auth, env) {
  const includeExited = url.searchParams.get('include_exited') === 'true';
  const filter = includeExited ? '' : 'status=neq.exited&';
  const r = await sb(
    `/rest/v1/employees?${filter}select=id,employee_code,full_name,preferred_name,job_title,manager_id,photo_url,status,department:department_id(id,name,code)&order=full_name.asc&limit=5000`,
    env,
  );
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);
  return ok({ nodes: r.data || [] });
}

async function getOrgSnapshots(url, auth, env) {
  const id = url.searchParams.get('id');
  if (id) {
    const r = await sb(`/rest/v1/org_snapshots?id=eq.${id}&select=*&limit=1`, env);
    if (!r.ok) return err('db_error', 500);
    return ok({ snapshot: r.data?.[0] || null });
  }
  const r = await sb(`/rest/v1/org_snapshots?select=id,label,captured_at,captured_by&order=captured_at.desc&limit=200`, env);
  if (!r.ok) return err('db_error', 500);
  return ok({ snapshots: r.data || [] });
}

async function getDepartments(url, auth, env) {
  const r = await sb(
    `/rest/v1/departments?select=*,head:head_employee_id(id,full_name),parent:parent_department_id(id,name)&order=name.asc`,
    env,
  );
  if (!r.ok) return err('db_error', 500);
  // headcount per department (directory-safe)
  const er = await sb(`/rest/v1/employees?status=neq.exited&select=department_id`, env);
  const counts = {};
  for (const e of (er.data || [])) if (e.department_id) counts[e.department_id] = (counts[e.department_id] || 0) + 1;
  const rows = (r.data || []).map(d => ({ ...d, headcount: counts[d.id] || 0 }));
  return ok({ departments: rows });
}

// Strip salary-band fields unless the caller may see compensation.
function projectJobRole(role, auth) {
  if (canComp(auth)) return role;
  const { salary_band_min, salary_band_mid, salary_band_max, ...rest } = role;
  return { ...rest, _bands_hidden: true };
}

async function getJobRoles(url, auth, env) {
  const r = await sb(
    `/rest/v1/job_roles?select=*,department:department_id(id,name)&order=title.asc`,
    env,
  );
  if (!r.ok) return err('db_error', 500);
  // KPI counts
  const kr = await sb(`/rest/v1/role_kpis?active=eq.true&select=job_role_id`, env);
  const counts = {};
  for (const k of (kr.data || [])) counts[k.job_role_id] = (counts[k.job_role_id] || 0) + 1;
  const rows = (r.data || []).map(rl => projectJobRole({ ...rl, kpi_count: counts[rl.id] || 0 }, auth));
  return ok({ job_roles: rows });
}

async function getJobRole(url, auth, env) {
  const id = url.searchParams.get('id');
  if (!id) return err('id required', 400);
  const r = await sb(`/rest/v1/job_roles?id=eq.${id}&select=*,department:department_id(id,name)&limit=1`, env);
  if (!r.ok) return err('db_error', 500);
  const role = r.data?.[0];
  if (!role) return err('not_found', 404);
  const kr = await sb(`/rest/v1/role_kpis?job_role_id=eq.${id}&select=*&order=sort_order.asc,created_at.asc`, env);
  // employees in this role (directory-safe)
  const er = await sb(`/rest/v1/employees?job_role_id=eq.${id}&status=neq.exited&select=id,employee_code,full_name,job_title,photo_url&order=full_name.asc`, env);
  return ok({ job_role: projectJobRole(role, auth), kpis: kr.data || [], employees: er.data || [] });
}

// Compensation — gated on podium_comp. Returns the per-employee event log + the
// current CTC (latest non-bonus new_ctc; null while the vault is disabled).
async function getCompensation(url, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  const employee_id = url.searchParams.get('employee_id');
  if (!employee_id) return err('employee_id required', 400);
  const r = await sb(
    `/rest/v1/compensation_events?employee_id=eq.${employee_id}&select=*&order=effective_date.desc,created_at.desc`,
    env,
  );
  if (!r.ok) return err('db_error', 500);
  const events = r.data || [];
  const latestCtc = events.find(e => e.event_type !== 'one_time_bonus' && e.new_ctc != null);
  const sr = await sb(`/rest/v1/settings?id=eq.1&select=comp_vault_enabled&limit=1`, env);
  return ok({
    events,
    current_ctc: latestCtc ? Number(latestCtc.new_ctc) : null,
    comp_vault_enabled: !!sr.data?.[0]?.comp_vault_enabled,
  });
}

// Documents — visible to hr/admin, self, or a manager in the chain. Bank/ID docs
// are restricted to hr/admin/self even from a managing chain.
const RESTRICTED_DOC_TYPES = new Set(['bank_details', 'id_proof']);

function docAllowed(auth, edges, employeeId, docType) {
  if (isHr(auth)) return true;
  const me = callerEmployee(edges, auth.userId);
  if (!me) return false;
  const isSelf = me.id === employeeId;
  if (isSelf) return true;
  const isMgr = inManagerChain(edges, employeeId, me.id);
  if (!isMgr) return false;
  return !RESTRICTED_DOC_TYPES.has(docType); // managers can't see bank/ID
}

async function getDocuments(url, auth, env) {
  const employee_id = url.searchParams.get('employee_id');
  if (!employee_id) return err('employee_id required', 400);
  const edges = await loadOrgEdges(env);
  if (!canSeeFull(auth, edges, employee_id)) return err('forbidden', 403);
  const r = await sb(`/rest/v1/documents?employee_id=eq.${employee_id}&select=*&order=uploaded_at.desc`, env);
  if (!r.ok) return err('db_error', 500);
  const rows = (r.data || []).filter(d => docAllowed(auth, edges, employee_id, d.doc_type));
  return ok({ documents: rows });
}

async function getDocumentDownloadUrl(url, auth, env) {
  const id = url.searchParams.get('id');
  if (!id) return err('id required', 400);
  const dr = await sb(`/rest/v1/documents?id=eq.${id}&select=*&limit=1`, env);
  if (!dr.ok) return err('db_error', 500);
  const doc = dr.data?.[0];
  if (!doc) return err('not_found', 404);
  const edges = await loadOrgEdges(env);
  if (!docAllowed(auth, edges, doc.employee_id, doc.doc_type)) return err('forbidden', 403);

  const seg = String(doc.storage_path).split('/').map(encodeURIComponent).join('/');
  const sr = await storageFetch(`/object/sign/${DOC_BUCKET}/${seg}`, env, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 120 }),
  });
  if (!sr.ok || !sr.data?.signedURL) return err(`sign_failed: ${JSON.stringify(sr.data)}`, 502);
  return ok({ url: `${env.SUPABASE_URL}/storage/v1${sr.data.signedURL}`, file_name: doc.file_name, mime_type: doc.mime_type });
}

// ────────────────────────────────────────────────────────────────────────────
// POST ACTIONS
// ────────────────────────────────────────────────────────────────────────────

function pickFields(body, allowed, src) {
  const o = {};
  const from = src || body;
  for (const k of allowed) if (k in from) o[k] = from[k];
  return o;
}
function pickPatch(body, allowed) {
  if (!body || typeof body.patch !== 'object') return {};
  return pickFields(body, allowed, body.patch);
}

async function mintEmployeeCode(env) {
  const r = await sbStore(`/rest/v1/rpc/next_employee_seq`, env, {
    method: 'POST',
    headers: { 'Accept-Profile': 'podium', 'Content-Profile': 'podium' },
    body: JSON.stringify({}),
  });
  if (!r.ok || typeof r.data !== 'number') return null;
  return `EMP-${String(r.data).padStart(3, '0')}`;
}

const EMPLOYEE_FIELDS = [
  'auth_user_id', 'full_name', 'preferred_name', 'personal_email', 'work_email', 'phone',
  'emergency_contact_name', 'emergency_contact_phone', 'date_of_birth',
  'department_id', 'job_role_id', 'job_title', 'manager_id', 'employment_type',
  'legal_entity', 'work_location', 'date_joined', 'probation_end_date', 'confirmed_at',
  'date_exited', 'exit_reason', 'status', 'photo_url',
];

async function createEmployee(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  if (!body.full_name) return err('full_name required', 400);
  let code = String(body.employee_code || '').trim();
  if (!code) { code = await mintEmployeeCode(env); if (!code) return err('failed_to_mint_employee_code', 500); }
  const row = { employee_code: code, created_by: auth.userId, ...pickFields(body, EMPLOYEE_FIELDS) };
  const r = await sb(`/rest/v1/employees`, env, { method: 'POST', body: JSON.stringify([row]) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

async function updateEmployee(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  if (!body.employee_id) return err('employee_id required', 400);
  const patch = pickPatch(body, EMPLOYEE_FIELDS);
  delete patch.employee_code; // immutable
  patch.updated_at = nowIso();
  if (Object.keys(patch).length === 1) return err('no_patch', 400);
  const r = await sb(`/rest/v1/employees?id=eq.${body.employee_id}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

const DEPARTMENT_FIELDS = ['name', 'code', 'parent_department_id', 'head_employee_id', 'description', 'active'];

async function createDepartment(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  if (!body.name) return err('name required', 400);
  const row = { created_by: auth.userId, ...pickFields(body, DEPARTMENT_FIELDS) };
  const r = await sb(`/rest/v1/departments`, env, { method: 'POST', body: JSON.stringify([row]) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

async function updateDepartment(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  if (!body.department_id) return err('department_id required', 400);
  const patch = pickPatch(body, DEPARTMENT_FIELDS);
  patch.updated_at = nowIso();
  if (Object.keys(patch).length === 1) return err('no_patch', 400);
  const r = await sb(`/rest/v1/departments?id=eq.${body.department_id}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

const JOB_ROLE_FIELDS = [
  'role_code', 'title', 'department_id', 'level', 'summary', 'job_description',
  'responsibilities', 'salary_band_min', 'salary_band_mid', 'salary_band_max', 'active',
];
const BAND_FIELDS = ['salary_band_min', 'salary_band_mid', 'salary_band_max'];

async function createJobRole(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  if (!body.title) return err('title required', 400);
  const row = { created_by: auth.userId, ...pickFields(body, JOB_ROLE_FIELDS) };
  if (!canComp(auth)) for (const f of BAND_FIELDS) delete row[f]; // bands are comp-gated
  const r = await sb(`/rest/v1/job_roles`, env, { method: 'POST', body: JSON.stringify([row]) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

async function updateJobRole(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  if (!body.job_role_id) return err('job_role_id required', 400);
  const patch = pickPatch(body, JOB_ROLE_FIELDS);
  if (!canComp(auth)) for (const f of BAND_FIELDS) delete patch[f];
  patch.updated_at = nowIso();
  if (Object.keys(patch).length === 1) return err('no_patch', 400);
  const r = await sb(`/rest/v1/job_roles?id=eq.${body.job_role_id}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

// Replace the full KPI set for a role (delete + insert).
async function setRoleKpis(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  if (!body.job_role_id) return err('job_role_id required', 400);
  const kpis = Array.isArray(body.kpis) ? body.kpis : [];
  await sb(`/rest/v1/role_kpis?job_role_id=eq.${body.job_role_id}`, env, { method: 'DELETE', prefer: 'return=minimal' });
  if (kpis.length === 0) return ok({ kpis: [] });
  const rows = kpis.map((k, i) => ({
    job_role_id: body.job_role_id,
    name: k.name,
    description: k.description || null,
    metric_type: ['qualitative', 'quantitative'].includes(k.metric_type) ? k.metric_type : null,
    target: k.target || null,
    weight: k.weight != null ? Number(k.weight) : null,
    sort_order: k.sort_order != null ? Math.round(Number(k.sort_order)) : i,
    active: k.active !== false,
  }));
  const r = await sb(`/rest/v1/role_kpis`, env, { method: 'POST', body: JSON.stringify(rows) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok({ kpis: r.data || [] });
}

// Compensation event. v1: only increment_pct + bonus amount allowed. The
// absolute-CTC vault columns are stripped unless settings.comp_vault_enabled.
async function addCompensationEvent(body, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  if (!body.employee_id) return err('employee_id required', 400);
  if (!['initial', 'increment', 'revision', 'one_time_bonus', 'correction'].includes(body.event_type))
    return err('invalid event_type', 400);

  const sr = await sb(`/rest/v1/settings?id=eq.1&select=comp_vault_enabled&limit=1`, env);
  const vaultOn = !!sr.data?.[0]?.comp_vault_enabled;

  const row = {
    employee_id: body.employee_id,
    event_type: body.event_type,
    effective_date: body.effective_date || undefined,
    increment_pct: body.increment_pct != null ? Number(body.increment_pct) : null,
    amount: body.amount != null ? Number(body.amount) : null,
    currency: body.currency || 'INR',
    reason: body.reason || null,
    approved_by: body.approved_by || auth.userId,
    created_by: auth.userId,
  };
  if (vaultOn) {
    if (body.old_ctc != null) row.old_ctc = Number(body.old_ctc);
    if (body.new_ctc != null) row.new_ctc = Number(body.new_ctc);
    if (body.components != null) row.components = body.components;
  }
  const r = await sb(`/rest/v1/compensation_events`, env, { method: 'POST', body: JSON.stringify([row]) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok({ event: r.data?.[0], comp_vault_enabled: vaultOn });
}

// Document upload — mint a signed upload URL into the PRIVATE bucket. The client
// PUTs the file to it (supabase-js uploadToSignedUrl), then calls recordDocument.
function safeSeg(s) { return encodeURIComponent(String(s || '').replace(/[^\w.\-]+/g, '_')); }

async function createDocumentUploadUrl(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  if (!body.employee_id) return err('employee_id required', 400);
  if (!body.file_name) return err('file_name required', 400);
  const docType = body.doc_type || 'other';
  const path = `${body.employee_id}/${safeSeg(docType)}/${Date.now()}_${safeSeg(body.file_name)}`;
  const sr = await storageFetch(`/object/upload/sign/${DOC_BUCKET}/${path}`, env, { method: 'POST' });
  if (!sr.ok || !sr.data?.url) return err(`sign_failed: ${JSON.stringify(sr.data)}`, 502);
  const tokenMatch = String(sr.data.url).match(/token=([^&]+)/);
  return ok({ storage_path: path, token: tokenMatch ? decodeURIComponent(tokenMatch[1]) : null, signed_url: sr.data.url });
}

const DOC_FIELDS = ['doc_type', 'title', 'storage_path', 'file_name', 'mime_type', 'file_size', 'expires_at', 'notes'];

async function recordDocument(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  if (!body.employee_id) return err('employee_id required', 400);
  if (!body.storage_path) return err('storage_path required', 400);
  if (!body.doc_type) return err('doc_type required', 400);
  const row = { employee_id: body.employee_id, uploaded_by: auth.userId, ...pickFields(body, DOC_FIELDS) };
  const r = await sb(`/rest/v1/documents`, env, { method: 'POST', body: JSON.stringify([row]) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

async function deleteDocument(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  if (!body.id) return err('id required', 400);
  const dr = await sb(`/rest/v1/documents?id=eq.${body.id}&select=storage_path&limit=1`, env);
  const path = dr.data?.[0]?.storage_path;
  const r = await sb(`/rest/v1/documents?id=eq.${body.id}`, env, { method: 'DELETE', prefer: 'return=minimal' });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  if (path) {
    const seg = String(path).split('/').map(encodeURIComponent).join('/');
    await storageFetch(`/object/${DOC_BUCKET}/${seg}`, env, { method: 'DELETE' });
  }
  return ok({ deleted: body.id });
}

// Capture a point-in-time org chart snapshot.
async function captureOrgSnapshot(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const r = await sb(
    `/rest/v1/employees?status=neq.exited&select=id,employee_code,full_name,job_title,manager_id,photo_url,department:department_id(name)&limit=5000`,
    env,
  );
  if (!r.ok) return err('db_error', 500);
  const ins = await sb(`/rest/v1/org_snapshots`, env, {
    method: 'POST',
    body: JSON.stringify([{ label: body.label || `Snapshot ${nowIso().slice(0, 10)}`, snapshot: { nodes: r.data || [], captured_at: nowIso() }, captured_by: auth.userId }]),
  });
  if (!ins.ok) return err(`db_error: ${JSON.stringify(ins.data)}`, 400);
  return ok(ins.data?.[0]);
}

async function updateSettings(body, auth, env) {
  const gate = requireAdmin(auth); if (gate) return gate;
  const patch = {};
  if (typeof body.comp_vault_enabled === 'boolean') patch.comp_vault_enabled = body.comp_vault_enabled;
  if (body.min_tenure_days != null) patch.min_tenure_days = Math.round(Number(body.min_tenure_days));
  if (Object.keys(patch).length === 0) return err('no_patch', 400);
  patch.updated_at = nowIso();
  const r = await sb(`/rest/v1/settings?id=eq.1`, env, { method: 'PATCH', body: JSON.stringify(patch) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

// ────────────────────────────────────────────────────────────────────────────
// PHASE 2 — PERFORMANCE CAPTURE (observations, wins, 1:1s)
// Access derives from the manager_id graph + isHr — no new perm keys.
// See docs/superpowers/specs/2026-06-02-podium-phase2-performance-capture-design.md
// ────────────────────────────────────────────────────────────────────────────

async function meOf(auth, env) { return callerEmployee(await loadOrgEdges(env), auth.userId); }

// Can the caller create/manage performance entries ABOUT employee E?
// HR/admin, or an ancestor manager of E (not E themselves).
function canManage(auth, edges, employeeId) {
  if (isHr(auth)) return true;
  const me = callerEmployee(edges, auth.userId);
  if (!me || me.id === employeeId) return false;
  return inManagerChain(edges, employeeId, me.id);
}

// All employee ids reporting (directly or transitively) up to rootEmpId. Excludes root.
function descendantsOf(edges, rootEmpId) {
  const out = new Set();
  if (!rootEmpId) return out;
  const children = {};
  for (const e of edges) if (e.manager_id) (children[e.manager_id] ||= []).push(e.id);
  const stack = [...(children[rootEmpId] || [])];
  let guard = 0;
  while (stack.length && guard++ < 10000) {
    const id = stack.pop();
    if (out.has(id)) continue;
    out.add(id);
    for (const c of (children[id] || [])) stack.push(c);
  }
  return out;
}

// Per-row observation visibility for `subjectId` (HR/admin already see all upstream).
function filterObservationsForViewer(rows, auth, edges, subjectId) {
  if (isHr(auth)) return rows;
  const me = callerEmployee(edges, auth.userId);
  const isSubject = !!(me && me.id === subjectId);
  const isChainMgr = !!(me && me.id !== subjectId && inManagerChain(edges, subjectId, me.id));
  return rows.filter(r => {
    if (me && r.author_employee_id === me.id) return true;               // author sees own (any tier)
    if (r.visibility === 'shared_with_employee') return isSubject || isChainMgr;
    if (r.visibility === 'shared_with_managers') return isChainMgr;      // not the subject
    return false;                                                        // private → author/HR only
  });
}

// Strip a 1:1's private_notes unless the viewer is its authoring manager or HR.
function projectOneOnOne(row, auth, me) {
  if (isHr(auth) || (me && row.manager_employee_id === me.id)) return row;
  return { ...row, private_notes: null, _private_hidden: true };
}

const OBS_EMBED = 'author:employees!author_employee_id(id,full_name,job_title)';
const ONE_EMBED = 'manager:employees!manager_employee_id(id,full_name,job_title)';

// ── Observations ─────────────────────────────────────────────────────────────

async function getObservations(url, auth, env) {
  const employee_id = url.searchParams.get('employee_id');
  if (!employee_id) return err('employee_id required', 400);
  const edges = await loadOrgEdges(env);
  if (!canSeeFull(auth, edges, employee_id)) return err('forbidden', 403);
  const r = await sb(
    `/rest/v1/observations?subject_employee_id=eq.${employee_id}&select=*,${OBS_EMBED}&order=observed_on.desc,created_at.desc`,
    env,
  );
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);
  const me = callerEmployee(edges, auth.userId);
  const visible = filterObservationsForViewer(r.data || [], auth, edges, employee_id).map(row => {
    const isAuthor = !!(me && row.author_employee_id === me.id);
    return { ...row, _can_edit: isAuthor, _can_delete: isAuthor || isHr(auth) };
  });
  return ok({ observations: visible, can_add: canManage(auth, edges, employee_id) });
}

const OBSERVATION_FIELDS = ['body', 'sentiment', 'tags', 'visibility', 'observed_on'];
const SENTIMENTS = ['positive', 'neutral', 'constructive'];

async function createObservation(body, auth, env) {
  if (!body.subject_employee_id) return err('subject_employee_id required', 400);
  if (!body.body) return err('body required', 400);
  if (!SENTIMENTS.includes(body.sentiment)) return err('invalid sentiment', 400);
  const edges = await loadOrgEdges(env);
  if (!canManage(auth, edges, body.subject_employee_id)) return err('forbidden — not a manager of this person', 403);
  const me = callerEmployee(edges, auth.userId);
  if (!me) return err('no_employee_record', 403);
  const row = {
    subject_employee_id: body.subject_employee_id,
    author_employee_id: me.id,
    created_by: auth.userId,
    ...pickFields(body, OBSERVATION_FIELDS),
  };
  const r = await sb(`/rest/v1/observations`, env, { method: 'POST', body: JSON.stringify([row]) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

async function updateObservation(body, auth, env) {
  if (!body.id) return err('id required', 400);
  const cur = await sb(`/rest/v1/observations?id=eq.${body.id}&select=author_employee_id&limit=1`, env);
  const row = cur.data?.[0]; if (!row) return err('not_found', 404);
  const me = await meOf(auth, env);
  if (!me || me.id !== row.author_employee_id) return err('forbidden — author only', 403);
  const patch = pickPatch(body, OBSERVATION_FIELDS);
  if (patch.sentiment && !SENTIMENTS.includes(patch.sentiment)) return err('invalid sentiment', 400);
  patch.updated_at = nowIso();
  if (Object.keys(patch).length === 1) return err('no_patch', 400);
  const r = await sb(`/rest/v1/observations?id=eq.${body.id}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

// ── Accomplishments (wins) ───────────────────────────────────────────────────

async function getAccomplishments(url, auth, env) {
  const employee_id = url.searchParams.get('employee_id');
  if (!employee_id) return err('employee_id required', 400);
  const edges = await loadOrgEdges(env);
  if (!canSeeFull(auth, edges, employee_id)) return err('forbidden', 403);
  const me = callerEmployee(edges, auth.userId);
  const r = await sb(`/rest/v1/accomplishments?employee_id=eq.${employee_id}&select=*&order=achieved_on.desc,created_at.desc`, env);
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);
  const mine = !!(me && me.id === employee_id);
  const rows = (r.data || []).map(row => ({ ...row, _can_edit: mine, _can_delete: mine || isHr(auth) }));
  return ok({ accomplishments: rows, can_add: mine });
}

const ACCOMPLISHMENT_FIELDS = ['title', 'description', 'tags', 'achieved_on'];

async function createAccomplishment(body, auth, env) {
  if (!body.title) return err('title required', 400);
  const me = await meOf(auth, env);
  if (!me) return err('no_employee_record — only employees can record wins', 403);
  const row = { employee_id: me.id, created_by: auth.userId, ...pickFields(body, ACCOMPLISHMENT_FIELDS) };
  const r = await sb(`/rest/v1/accomplishments`, env, { method: 'POST', body: JSON.stringify([row]) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

async function updateAccomplishment(body, auth, env) {
  if (!body.id) return err('id required', 400);
  const cur = await sb(`/rest/v1/accomplishments?id=eq.${body.id}&select=employee_id&limit=1`, env);
  const row = cur.data?.[0]; if (!row) return err('not_found', 404);
  const me = await meOf(auth, env);
  if (!me || me.id !== row.employee_id) return err('forbidden — author only', 403);
  const patch = pickPatch(body, ACCOMPLISHMENT_FIELDS);
  patch.updated_at = nowIso();
  if (Object.keys(patch).length === 1) return err('no_patch', 400);
  const r = await sb(`/rest/v1/accomplishments?id=eq.${body.id}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

// ── 1:1 notes ────────────────────────────────────────────────────────────────

async function getOneOnOnes(url, auth, env) {
  const employee_id = url.searchParams.get('employee_id'); // the report
  if (!employee_id) return err('employee_id required', 400);
  const edges = await loadOrgEdges(env);
  if (!canSeeFull(auth, edges, employee_id)) return err('forbidden', 403);
  const me = callerEmployee(edges, auth.userId);
  const r = await sb(
    `/rest/v1/one_on_ones?report_employee_id=eq.${employee_id}&select=*,${ONE_EMBED}&order=met_on.desc,created_at.desc`,
    env,
  );
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 500);
  const rows = (r.data || []).map(row => {
    const isAuthor = !!(me && row.manager_employee_id === me.id);
    return { ...projectOneOnOne(row, auth, me), _can_edit: isAuthor, _can_delete: isAuthor || isHr(auth) };
  });
  return ok({ one_on_ones: rows, can_add: canManage(auth, edges, employee_id) });
}

const ONEONONE_FIELDS = ['met_on', 'shared_notes', 'private_notes', 'action_items'];

async function createOneOnOne(body, auth, env) {
  if (!body.report_employee_id) return err('report_employee_id required', 400);
  const edges = await loadOrgEdges(env);
  if (!canManage(auth, edges, body.report_employee_id)) return err('forbidden — not a manager of this person', 403);
  const me = callerEmployee(edges, auth.userId);
  if (!me) return err('no_employee_record', 403);
  const fields = pickFields(body, ONEONONE_FIELDS);
  if (fields.action_items && !Array.isArray(fields.action_items)) delete fields.action_items;
  const row = { report_employee_id: body.report_employee_id, manager_employee_id: me.id, created_by: auth.userId, ...fields };
  const r = await sb(`/rest/v1/one_on_ones`, env, { method: 'POST', body: JSON.stringify([row]) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

async function updateOneOnOne(body, auth, env) {
  if (!body.id) return err('id required', 400);
  const cur = await sb(`/rest/v1/one_on_ones?id=eq.${body.id}&select=manager_employee_id&limit=1`, env);
  const row = cur.data?.[0]; if (!row) return err('not_found', 404);
  const me = await meOf(auth, env);
  if (!me || me.id !== row.manager_employee_id) return err('forbidden — author only', 403);
  const patch = pickPatch(body, ONEONONE_FIELDS);
  if (patch.action_items && !Array.isArray(patch.action_items)) delete patch.action_items;
  patch.updated_at = nowIso();
  if (Object.keys(patch).length === 1) return err('no_patch', 400);
  const r = await sb(`/rest/v1/one_on_ones?id=eq.${body.id}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok(r.data?.[0]);
}

// ── Shared delete (author or HR) ─────────────────────────────────────────────

async function deleteEntry(table, ownerCol, body, auth, env) {
  if (!body.id) return err('id required', 400);
  const cur = await sb(`/rest/v1/${table}?id=eq.${body.id}&select=${ownerCol}&limit=1`, env);
  const row = cur.data?.[0]; if (!row) return err('not_found', 404);
  const me = await meOf(auth, env);
  const isAuthor = !!(me && me.id === row[ownerCol]);
  if (!isAuthor && !isHr(auth)) return err('forbidden — author or HR only', 403);
  const r = await sb(`/rest/v1/${table}?id=eq.${body.id}`, env, { method: 'DELETE', prefer: 'return=minimal' });
  if (!r.ok) return err(`db_error: ${JSON.stringify(r.data)}`, 400);
  return ok({ deleted: body.id });
}
async function deleteObservation(body, auth, env)    { return deleteEntry('observations', 'author_employee_id', body, auth, env); }
async function deleteAccomplishment(body, auth, env)  { return deleteEntry('accomplishments', 'employee_id', body, auth, env); }
async function deleteOneOnOne(body, auth, env)        { return deleteEntry('one_on_ones', 'manager_employee_id', body, auth, env); }

// ── Aggregate reads (My Performance + Team feed) ─────────────────────────────

async function getMyPerformance(url, auth, env) {
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  if (!me) return ok({ employee_id: null, accomplishments: [], observations: [], one_on_ones: [], open_action_items: [] });
  const [wins, obs, oned] = await Promise.all([
    sb(`/rest/v1/accomplishments?employee_id=eq.${me.id}&select=*&order=achieved_on.desc&limit=200`, env),
    sb(`/rest/v1/observations?subject_employee_id=eq.${me.id}&visibility=eq.shared_with_employee&select=*,${OBS_EMBED}&order=observed_on.desc&limit=200`, env),
    sb(`/rest/v1/one_on_ones?report_employee_id=eq.${me.id}&select=*,${ONE_EMBED}&order=met_on.desc&limit=200`, env),
  ]);
  const oneRows = (oned.data || []).map(r => projectOneOnOne(r, auth, me)); // report ≠ author → private stripped
  const openItems = [];
  for (const o of oneRows)
    for (const ai of (Array.isArray(o.action_items) ? o.action_items : []))
      if (ai && !ai.done) openItems.push({ text: ai.text, met_on: o.met_on, one_on_one_id: o.id });
  return ok({
    employee_id: me.id,
    accomplishments: wins.data || [],
    observations: obs.data || [],            // subject view: shared_with_employee only
    one_on_ones: oneRows,
    open_action_items: openItems,
  });
}

async function getTeamActivity(url, auth, env) {
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  let scope;
  if (isHr(auth)) {
    const focus = url.searchParams.get('employee_id');
    scope = focus ? descendantsOf(edges, focus) : new Set(edges.map(e => e.id));
  } else {
    if (!me) return ok({ activity: [] });
    scope = descendantsOf(edges, me.id);
  }
  const ids = [...scope];
  if (ids.length === 0) return ok({ activity: [], team: [] });
  const inList = `(${ids.join(',')})`;
  const teamRes = await sb(`/rest/v1/employees?id=in.${inList}&status=neq.exited&select=id,full_name,job_title&order=full_name.asc`, env);
  const team = teamRes.data || [];
  const [obs, wins, oned] = await Promise.all([
    sb(`/rest/v1/observations?subject_employee_id=in.${inList}&select=*,subject:employees!subject_employee_id(id,full_name),${OBS_EMBED}&order=observed_on.desc&limit=50`, env),
    sb(`/rest/v1/accomplishments?employee_id=in.${inList}&select=*,employee:employees!employee_id(id,full_name)&order=achieved_on.desc&limit=50`, env),
    sb(`/rest/v1/one_on_ones?report_employee_id=in.${inList}&select=*,report:employees!report_employee_id(id,full_name),${ONE_EMBED}&order=met_on.desc&limit=50`, env),
  ]);
  const obsRows = (obs.data || []).filter(r => {
    if (isHr(auth)) return true;
    if (me && r.author_employee_id === me.id) return true;
    if (r.visibility === 'private') return false;
    return !!(me && inManagerChain(edges, r.subject_employee_id, me.id)); // chain mgr sees both shared tiers
  });
  const onedRows = (oned.data || []).map(r => projectOneOnOne(r, auth, me));
  const activity = [
    ...obsRows.map(r => ({ kind: 'observation', date: r.observed_on, ...r })),
    ...(wins.data || []).map(r => ({ kind: 'win', date: r.achieved_on, ...r })),
    ...onedRows.map(r => ({ kind: 'one_on_one', date: r.met_on, ...r })),
  ].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, 100);
  return ok({ activity, team });
}

// ────────────────────────────────────────────────────────────────────────────
// PERMISSION LAYER — Podium-managed roles (store.podium_roles / podium_user_roles)
// Mirrors Snorkel (RULE-SNORKEL-002). RULE-PODIUM-006. Admin actions gated on
// podium_admin; role list is open metadata (no PII).
// ────────────────────────────────────────────────────────────────────────────

const PODIUM_PERM_KEYS = ['podium_view', 'podium_hr', 'podium_comp', 'podium_admin'];

// Keep only known keys as `true`; any elevated key implies podium_view so an admin
// can't mint a role that 403s itself at the gate (RULE-PODIUM-001 corollary).
function normalizePodiumPerms(permissions) {
  const out = {};
  for (const k of PODIUM_PERM_KEYS) if (permissions && permissions[k]) out[k] = true;
  if (out.podium_hr || out.podium_comp || out.podium_admin) out.podium_view = true;
  return out;
}

async function getPodiumRoles(url, auth, env) {
  const r = await sbStore(`/rest/v1/podium_roles?select=*&order=is_system.desc,label.asc`, env);
  if (!r.ok) return err('db_error', 500);
  return ok(r.data || []);
}

async function getPodiumUsers(url, auth, env) {
  const gate = requireAdmin(auth); if (gate) return gate;
  const [up, ur] = await Promise.all([
    sbStore(`/rest/v1/users_profile?select=id,full_name,role,active&order=full_name.asc`, env),
    sbStore(`/rest/v1/podium_user_roles?select=user_id,role_key`, env),
  ]);
  if (!up.ok) return err('db_error', 500);
  const roleMap = {};
  if (ur.ok) (ur.data || []).forEach(x => { roleMap[x.user_id] = x.role_key; });
  const authUsers = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users?per_page=1000`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
  });
  const authData = authUsers.ok ? await authUsers.json() : { users: [] };
  const emailMap = {};
  (authData.users || []).forEach(u => { emailMap[u.id] = u.email; });
  return ok((up.data || []).map(u => ({ ...u, email: emailMap[u.id] || '', podium_role: roleMap[u.id] || null })));
}

async function createPodiumRole(body, auth, env) {
  const gate = requireAdmin(auth); if (gate) return gate;
  const d = body.data || {};
  if (!d.role_key || !d.label) return err('role_key and label required', 400);
  const key = String(d.role_key).trim().toLowerCase().replace(/\s+/g, '_');
  const r = await sbStore(`/rest/v1/podium_roles`, env, {
    method: 'POST',
    body: JSON.stringify([{
      role_key: key, label: d.label, description: d.description || null,
      permissions: normalizePodiumPerms(d.permissions), is_system: false,
    }]),
  });
  if (!r.ok) return err('create_failed: ' + JSON.stringify(r.data), 400);
  return ok({ role_key: key });
}

async function updatePodiumRole(body, auth, env) {
  const gate = requireAdmin(auth); if (gate) return gate;
  const d = body.data || {};
  if (!d.role_key) return err('role_key required', 400);
  const cur = await sbStore(`/rest/v1/podium_roles?role_key=eq.${encodeURIComponent(d.role_key)}&select=is_system&limit=1`, env);
  const isSys = !!(cur.ok && cur.data?.[0]?.is_system);
  const updates = { updated_at: nowIso() };
  if (d.label !== undefined)       updates.label = d.label;
  if (d.description !== undefined) updates.description = d.description;
  // System roles (admin / employee) have immutable permissions — prevents an admin from
  // dropping podium_admin off the admin role and locking everyone out. Label/desc editable.
  if (d.permissions !== undefined && !isSys) updates.permissions = normalizePodiumPerms(d.permissions);
  const r = await sbStore(`/rest/v1/podium_roles?role_key=eq.${encodeURIComponent(d.role_key)}`, env, {
    method: 'PATCH', body: JSON.stringify(updates),
  });
  if (!r.ok) return err('update_failed: ' + JSON.stringify(r.data), 400);
  return ok({ updated: d.role_key });
}

async function deletePodiumRole(body, auth, env) {
  const gate = requireAdmin(auth); if (gate) return gate;
  const d = body.data || {};
  if (!d.role_key) return err('role_key required', 400);
  const chk = await sbStore(`/rest/v1/podium_roles?role_key=eq.${encodeURIComponent(d.role_key)}&select=is_system&limit=1`, env);
  if (chk.ok && chk.data?.[0]?.is_system) return err('cannot delete a system role', 400);
  const assigned = await sbStore(`/rest/v1/podium_user_roles?role_key=eq.${encodeURIComponent(d.role_key)}&limit=1`, env);
  if (assigned.ok && assigned.data?.length) return err('cannot delete a role with assigned users', 400);
  const r = await sbStore(`/rest/v1/podium_roles?role_key=eq.${encodeURIComponent(d.role_key)}`, env, { method: 'DELETE', prefer: 'return=minimal' });
  if (!r.ok) return err('delete_failed', 400);
  return ok({ deleted: d.role_key });
}

async function assignPodiumRole(body, auth, env) {
  const gate = requireAdmin(auth); if (gate) return gate;
  const d = body.data || {};
  if (!d.user_id) return err('user_id required', 400);
  // Empty role_key → unassign → user falls back to self-only baseline.
  if (!d.role_key) {
    await sbStore(`/rest/v1/podium_user_roles?user_id=eq.${encodeURIComponent(d.user_id)}`, env, { method: 'DELETE', prefer: 'return=minimal' });
    return ok({ user_id: d.user_id, role_key: null });
  }
  const chk = await sbStore(`/rest/v1/podium_roles?role_key=eq.${encodeURIComponent(d.role_key)}&select=role_key&limit=1`, env);
  if (!chk.ok || !chk.data?.[0]) return err('unknown role', 400);
  const r = await sbStore(`/rest/v1/podium_user_roles?on_conflict=user_id`, env, {
    method: 'POST',
    prefer: 'return=representation,resolution=merge-duplicates',
    body: JSON.stringify({ user_id: d.user_id, role_key: d.role_key, assigned_by: auth.userId, assigned_at: nowIso() }),
  });
  if (!r.ok) return err('assign_failed: ' + JSON.stringify(r.data), 400);
  return ok({ user_id: d.user_id, role_key: d.role_key });
}

// ────────────────────────────────────────────────────────────────────────────
// DISPATCH
// ────────────────────────────────────────────────────────────────────────────

const GET_ACTIONS = {
  getMe, getSettings,
  getEmployees, getEmployee,
  getOrgChart, getOrgSnapshots,
  getDepartments,
  getJobRoles, getJobRole,
  getCompensation,
  getDocuments, getDocumentDownloadUrl,
  // Phase 2 — performance capture
  getObservations, getAccomplishments, getOneOnOnes,
  getMyPerformance, getTeamActivity,
  // Permission layer (Podium-managed)
  getPodiumRoles, getPodiumUsers,
};

const POST_ACTIONS = {
  createEmployee, updateEmployee,
  createDepartment, updateDepartment,
  createJobRole, updateJobRole, setRoleKpis,
  addCompensationEvent,
  createDocumentUploadUrl, recordDocument, deleteDocument,
  captureOrgSnapshot,
  updateSettings,
  // Phase 2 — performance capture
  createObservation, updateObservation, deleteObservation,
  createAccomplishment, updateAccomplishment, deleteAccomplishment,
  createOneOnOne, updateOneOnOne, deleteOneOnOne,
  // Permission layer (Podium-managed)
  createPodiumRole, updatePodiumRole, deletePodiumRole, assignPodiumRole,
};

// Self-only baseline (RULE-PODIUM-006): actions reachable WITHOUT podium_view.
// getMe + getPodiumRoles are pure metadata; the rest are self-scoped by canSeeFull
// (which treats self as visible) or callerEmployee, so a no-role user can only ever
// reach their OWN profile + wins via /me. Everything else still requires podium_view.
const SELF_SERVE_GET = new Set([
  'getMe', 'getPodiumRoles',
  'getEmployee', 'getMyPerformance', 'getAccomplishments', 'getObservations', 'getOneOnOnes',
]);
const SELF_SERVE_POST = new Set([
  'createAccomplishment', 'updateAccomplishment', 'deleteAccomplishment',
]);

async function handleGet(url, request, env) {
  const action = url.searchParams.get('action');
  if (!action) return err('action_required', 400);
  if (action === 'ping') return ok({ pong: true });
  const auth = await verifyJWT(request.headers.get('Authorization'), env);
  if (!auth) return err('unauthorized', 401);

  const handler = GET_ACTIONS[action];
  if (!handler) return err(`unknown_action: ${action}`, 400);
  if (!auth.permissions?.podium_view && !SELF_SERVE_GET.has(action)) return err('forbidden_podium_view', 403);
  try { return await handler(url, auth, env); }
  catch (e) { return err(`server_error: ${e?.message || String(e)}`, 500); }
}

async function handlePost(request, env) {
  const auth = await verifyJWT(request.headers.get('Authorization'), env);
  if (!auth) return err('unauthorized', 401);

  let body;
  try { body = await request.json(); } catch { return err('bad_json', 400); }
  const action = body?.action;
  if (!action) return err('action_required', 400);
  const handler = POST_ACTIONS[action];
  if (!handler) return err(`unknown_action: ${action}`, 400);
  if (!auth.permissions?.podium_view && !SELF_SERVE_POST.has(action)) return err('forbidden_podium_view', 403);
  try { return await handler(body, auth, env); }
  catch (e) { return err(`server_error: ${e?.message || String(e)}`, 500); }
}

// ────────────────────────────────────────────────────────────────────────────
// MAIN
// ────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    if (url.pathname === '/health' || url.pathname === '/healthz') {
      return ok({ service: 'podiumops', time: nowIso() });
    }

    if (request.method === 'GET')  return handleGet(url, request, env);
    if (request.method === 'POST') return handlePost(request, env);
    return err('method_not_allowed', 405);
  },
};
