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

  const rolesRes = await sbStore(
    `/rest/v1/roles?role_id=eq.${encodeURIComponent(profile.role)}&select=permissions&limit=1`,
    env,
  );
  const permissions = (rolesRes.ok && rolesRes.data?.[0]?.permissions) || {};

  return {
    userId: user.id,
    email: user.email,
    role: profile.role,
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
};

const POST_ACTIONS = {
  createEmployee, updateEmployee,
  createDepartment, updateDepartment,
  createJobRole, updateJobRole, setRoleKpis,
  addCompensationEvent,
  createDocumentUploadUrl, recordDocument, deleteDocument,
  captureOrgSnapshot,
  updateSettings,
};

async function handleGet(url, request, env) {
  const action = url.searchParams.get('action');
  if (!action) return err('action_required', 400);
  if (action === 'ping') return ok({ pong: true });
  const auth = await verifyJWT(request.headers.get('Authorization'), env);
  if (!auth) return err('unauthorized', 401);
  if (!auth.permissions?.podium_view) return err('forbidden_podium_view', 403);

  const handler = GET_ACTIONS[action];
  if (!handler) return err(`unknown_action: ${action}`, 400);
  try { return await handler(url, auth, env); }
  catch (e) { return err(`server_error: ${e?.message || String(e)}`, 500); }
}

async function handlePost(request, env) {
  const auth = await verifyJWT(request.headers.get('Authorization'), env);
  if (!auth) return err('unauthorized', 401);
  if (!auth.permissions?.podium_view) return err('forbidden_podium_view', 403);

  let body;
  try { body = await request.json(); } catch { return err('bad_json', 400); }
  const action = body?.action;
  if (!action) return err('action_required', 400);
  const handler = POST_ACTIONS[action];
  if (!handler) return err(`unknown_action: ${action}`, 400);
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
