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

  // Salary access is an explicit allow-list (podium.comp_access), decoupled from
  // admin/hr (RULE-PODIUM-002, amended 2026-07-06). Resolved once per request.
  const caRes = await sb(
    `/rest/v1/comp_access?auth_user_id=eq.${user.id}&select=auth_user_id&limit=1`,
    env,
  );
  const compAccess = !!(caRes.ok && caRes.data?.[0]);

  return {
    userId: user.id,
    email: user.email,
    role: profile.role,
    podiumRole,
    fullName: profile.full_name,
    permissions,
    compAccess,
    isSuperAdmin: profile.role === 'super_admin',
    bearer: token,
  };
}

// ── Google Workspace Directory (service account + domain-wide delegation) ─────
// Read-only sync of @legendoftoys.com accounts → Podium employees. Graceful when
// the GOOGLE_* secrets are absent (the action returns google_not_configured).

function b64urlBytes(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlStr(str) { return b64urlBytes(new TextEncoder().encode(str)); }
function pemToPkcs8(pem) {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s+/g, '');
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
function googleConfigured(env) { return !!(env.GOOGLE_SA_JSON && env.GOOGLE_ADMIN_IMPERSONATE_EMAIL); }

async function googleAccessToken(env) {
  const sa = JSON.parse(env.GOOGLE_SA_JSON);
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64urlStr(JSON.stringify({
    iss: sa.client_email,
    sub: env.GOOGLE_ADMIN_IMPERSONATE_EMAIL,
    scope: 'https://www.googleapis.com/auth/admin.directory.user.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const signingInput = `${header}.${claim}`;
  const key = await crypto.subtle.importKey('pkcs8', pemToPkcs8(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${b64urlBytes(sigBuf)}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const t = await res.json();
  if (!t.access_token) throw new Error('google_token_failed: ' + JSON.stringify(t));
  return t.access_token;
}

async function fetchGoogleUsers(env) {
  const token = await googleAccessToken(env);
  const out = [];
  let pageToken = '', pages = 0;
  do {
    const u = new URL('https://admin.googleapis.com/admin/directory/v1/users');
    u.searchParams.set('customer', 'my_customer');
    u.searchParams.set('maxResults', '500');
    u.searchParams.set('orderBy', 'email');
    u.searchParams.set('projection', 'full');
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    if (!r.ok) throw new Error('google_dir_failed: ' + JSON.stringify(d));
    (d.users || []).forEach(x => out.push(x));
    pageToken = d.nextPageToken || '';
  } while (pageToken && ++pages < 10);
  return out;
}

// email(lowercased) → auth.users id, via the GoTrue admin API.
async function authEmailMap(env) {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users?per_page=1000`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) return {};
  const d = await res.json();
  const m = {};
  (d.users || []).forEach(u => { if (u.email) m[u.email.toLowerCase()] = u.id; });
  return m;
}

async function nextEmployeeSeq(env) {
  const r = await sb(`/rest/v1/rpc/next_employee_seq`, env, { method: 'POST', body: JSON.stringify({}) });
  if (!r.ok) return null;
  const v = Array.isArray(r.data) ? r.data[0] : r.data;
  return Number(v);
}

// ── Permission tiers ─────────────────────────────────────────────────────────

function hasPerm(auth, perm) { return !!auth?.permissions?.[perm]; }
function isAdmin(auth) { return hasPerm(auth, 'podium_admin'); }
function isHr(auth)    { return isAdmin(auth) || hasPerm(auth, 'podium_hr'); }
// Salary access = explicit allow-list membership only (auth.compAccess from verifyJWT).
// NOT implied by podium_admin/podium_hr. RULE-PODIUM-002 (amended 2026-07-06).
function canComp(auth) { return auth?.compAccess === true; }

function requireHr(auth)    { return isHr(auth)    ? null : err('Forbidden — requires podium_hr', 403); }
function requireComp(auth)  { return canComp(auth) ? null : err('Forbidden — requires podium_comp', 403); }
function requireAdmin(auth) { return isAdmin(auth) ? null : err('Forbidden — requires podium_admin', 403); }
function requireSuperAdmin(auth) { return auth?.isSuperAdmin ? null : err('Forbidden — requires super_admin', 403); }

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

// PAN is a government ID — HR/self ONLY, hidden even from the managing chain
// (same posture as bank/ID documents, RULE-PODIUM-001). Apply to FULL rows only;
// projectPublic() never includes pan_number anyway.
function stripPan(row, auth, edges) {
  if (!row || !('pan_number' in row)) return row;
  if (isHr(auth)) return row;
  const me = callerEmployee(edges, auth.userId);
  if (me && me.id === row.id) return row;
  const { pan_number, ...rest } = row;
  return rest;
}

// Public (directory-safe) projection of an employee row.
const PUBLIC_EMP_KEYS = [
  'id', 'employee_code', 'full_name', 'preferred_name', 'job_title',
  'department_id', 'job_role_id', 'manager_id', 'secondary_manager_id', 'photo_url', 'status', 'work_email',
];
function projectPublic(row) {
  const out = {};
  for (const k of PUBLIC_EMP_KEYS) if (k in row) out[k] = row[k];
  // keep embedded labels if present
  if (row.department) out.department = row.department;
  if (row.job_role)   out.job_role = row.job_role;
  if (row.manager)    out.manager = row.manager;
  if (row.secondary_manager) out.secondary_manager = row.secondary_manager;
  out._restricted = true;
  return out;
}

const EMP_EMBED =
  'department:department_id(id,name,code),job_role:job_role_id(id,title,level),manager:manager_id(id,full_name,job_title),secondary_manager:secondary_manager_id(id,full_name,job_title)';

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
    tier: { admin: isAdmin(auth), hr: isHr(auth), comp: canComp(auth), super_admin: !!auth.isSuperAdmin },
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
  const rows = (r.data || []).map(e => (canSeeFull(auth, edges, e.id) ? stripPan(e, auth, edges) : projectPublic(e)));
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
  return ok({ employee: full ? stripPan(emp, auth, edges) : projectPublic(emp), can_see_full: full, can_see_comp: canComp(auth), reports });
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

// Append-only audit of CROSS-PERSON salary reads. Self-views of one's own pay are
// not a leak and are not logged. Best-effort: a failed insert must never block a read.
async function logCompAccess(auth, action, subjectEmployeeId, subjectLabel, env, detail) {
  try {
    await sb(`/rest/v1/comp_access_log`, env, {
      method: 'POST', prefer: 'return=minimal',
      body: JSON.stringify([{
        viewer_user_id: auth.userId,
        viewer_name: auth.fullName || null,
        action,
        subject_employee_id: subjectEmployeeId || null,
        subject_label: subjectLabel || null,
        detail: detail || null,
      }]),
    });
  } catch (_e) { /* best-effort audit; never block the read */ }
}

// Compensation — CROSS-PERSON read, allow-list-gated (canComp = comp_access member).
// The ONLY path that returns another person's pay. Returns the per-employee event
// log + current CTC (latest non-bonus new_ctc). Every read is audited.
async function getCompensation(url, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  const employee_id = url.searchParams.get('employee_id');
  if (!employee_id) return err('employee_id required', 400);
  await logCompAccess(auth, 'getCompensation', employee_id, null, env);
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

// SELF-ONLY comp view. Takes NO employee-id parameter — a caller can structurally
// only ever see their OWN compensation (resolved from the JWT via callerEmployee).
// Reachable by the self-only baseline (SELF_SERVE_GET). Self-views are not audited.
async function getMyCompensation(url, auth, env) {
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  if (!me) return ok({ employee_id: null, events: [], current_ctc: null });
  const r = await sb(
    `/rest/v1/compensation_events?employee_id=eq.${me.id}&select=*&order=effective_date.desc,created_at.desc`,
    env,
  );
  if (!r.ok) return err('db_error', 500);
  const events = r.data || [];
  const latestCtc = events.find(e => e.event_type !== 'one_time_bonus' && e.new_ctc != null);
  return ok({ employee_id: me.id, events, current_ctc: latestCtc ? Number(latestCtc.new_ctc) : null });
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
  'department_id', 'job_role_id', 'job_title', 'manager_id', 'secondary_manager_id', 'employment_type',
  'legal_entity', 'work_location', 'date_joined', 'probation_end_date', 'confirmed_at',
  'date_exited', 'exit_reason', 'status', 'photo_url',
  'gender', 'blood_group', 'pan_number',
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
  // A person can't be their own (solid or dotted) manager.
  if (patch.secondary_manager_id === body.employee_id) patch.secondary_manager_id = null;
  if (patch.manager_id === body.employee_id) patch.manager_id = null;
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

const PODIUM_PERM_KEYS = ['podium_view', 'podium_hr', 'podium_admin'];

// Keep only known keys as `true`; any elevated key implies podium_view so an admin
// can't mint a role that 403s itself at the gate (RULE-PODIUM-001 corollary).
function normalizePodiumPerms(permissions) {
  const out = {};
  for (const k of PODIUM_PERM_KEYS) if (permissions && permissions[k]) out[k] = true;
  if (out.podium_hr || out.podium_admin) out.podium_view = true;
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
// GOOGLE DIRECTORY SYNC (on-demand) — HR-gated. RULE-PODIUM-007.
// Excludes shared/role OUs + an ignore list; proposes new joiners + departures;
// imports are review-and-confirm (drafts nothing, never clobbers manual edits).
// ────────────────────────────────────────────────────────────────────────────

const DEPT_ALIAS = { 'd2c': 'D2C / Website' }; // OU leaf → podium department name

function ouExcluded(ou, excluded) {
  return (excluded || []).some(x => ou === x || (ou || '').startsWith(x + '/'));
}
function mapOuToDept(ou, deptByName) {
  if (!ou || ou === '/') return null;
  const leaf = ou.split('/').filter(Boolean).pop() || '';
  const name = (DEPT_ALIAS[leaf.toLowerCase()] || leaf).toLowerCase();
  return deptByName.get(name) || null;
}

async function getDirectorySyncPreview(url, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  if (!googleConfigured(env)) return err('google_not_configured', 400);
  let gusers;
  try { gusers = await fetchGoogleUsers(env); }
  catch (e) { return err('google_sync_failed: ' + (e?.message || e), 502); }

  const [sres, igRes, eRes, dRes] = await Promise.all([
    sb(`/rest/v1/settings?id=eq.1&select=directory_excluded_ous&limit=1`, env),
    sb(`/rest/v1/directory_ignored?select=email`, env),
    sb(`/rest/v1/employees?select=id,full_name,work_email,status&limit=5000`, env),
    sb(`/rest/v1/departments?select=id,name&limit=500`, env),
  ]);
  const excluded = (sres.ok && sres.data?.[0]?.directory_excluded_ous) || ['/Admin and general'];
  const ignored = new Set((igRes.ok ? igRes.data : []).map(r => (r.email || '').toLowerCase()));
  const emps = eRes.ok ? eRes.data : [];
  const empByEmail = new Map(emps.map(e => [(e.work_email || '').toLowerCase(), e]));
  const depts = (dRes.ok ? dRes.data : []).slice().sort((a, b) => a.name.localeCompare(b.name));
  const deptByName = new Map(depts.map(d => [d.name.toLowerCase(), d.id]));
  const authMap = await authEmailMap(env);

  const gEmails = new Set();
  const gSuspended = new Set();
  let excludedCount = 0;
  const newCands = [];
  for (const gu of gusers) {
    const email = (gu.primaryEmail || '').toLowerCase();
    if (!email) continue;
    gEmails.add(email);
    if (gu.suspended) gSuspended.add(email);
    if (ouExcluded(gu.orgUnitPath, excluded)) { excludedCount++; continue; }
    if (ignored.has(email)) continue;
    if (empByEmail.has(email)) continue;     // already an employee
    if (gu.suspended) continue;              // suspended & not in Podium → not a new active hire
    const deptId = mapOuToDept(gu.orgUnitPath, deptByName);
    const rel = (gu.relations || []).find(r => r.type === 'manager' && r.value);
    const mgr = rel ? empByEmail.get(rel.value.toLowerCase()) : null;
    newCands.push({
      email: gu.primaryEmail,
      full_name: [gu.name?.givenName, gu.name?.familyName].filter(Boolean).join(' ') || gu.name?.fullName || gu.primaryEmail,
      org_unit: gu.orgUnitPath || '',
      job_title: gu.organizations?.[0]?.title || '',
      suggested_department_id: deptId,
      suggested_manager_id: mgr ? mgr.id : null,
      has_login: !!authMap[email],
    });
  }
  // Departures: active LOT-domain employees whose Google account is gone or suspended.
  const departed = emps.filter(e => {
    if (e.status !== 'active' || !e.work_email) return false;
    const em = e.work_email.toLowerCase();
    if (!em.endsWith('@legendoftoys.com')) return false; // only judge accounts we expect in Google
    return !gEmails.has(em) || gSuspended.has(em);
  }).map(e => ({
    id: e.id, full_name: e.full_name, work_email: e.work_email,
    reason: gSuspended.has(e.work_email.toLowerCase()) ? 'suspended in Google' : 'no Google account',
  }));

  return ok({
    new_candidates: newCands.sort((a, b) => a.full_name.localeCompare(b.full_name)),
    departed,
    departments: depts,
    managers: emps.filter(e => e.status === 'active').map(e => ({ id: e.id, full_name: e.full_name }))
                  .sort((a, b) => a.full_name.localeCompare(b.full_name)),
    counts: { google_total: gusers.length, excluded_ou: excludedCount, new: newCands.length, departed: departed.length },
  });
}

async function importDirectoryCandidates(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  if (!googleConfigured(env)) return err('google_not_configured', 400);
  const d = body.data || body;
  const create = Array.isArray(d.create) ? d.create : []; // [{email, department_id, manager_id, job_title}]
  const exit = Array.isArray(d.exit) ? d.exit : [];        // [email,...]
  const ignore = Array.isArray(d.ignore) ? d.ignore : [];  // [email,...]
  if (create.length > 20) return err('import at most 20 people per sync (subrequest limit) — run again for the rest', 400);
  const result = { created: [], exited: [], ignored: [], errors: [] };

  if (ignore.length) {
    const rows = ignore.map(em => ({ email: String(em).toLowerCase(), ignored_by: auth.userId }));
    await sb(`/rest/v1/directory_ignored?on_conflict=email`, env,
      { method: 'POST', prefer: 'return=minimal,resolution=merge-duplicates', body: JSON.stringify(rows) });
    result.ignored = ignore;
  }

  for (const em of exit) {
    const r = await sb(`/rest/v1/employees?work_email=eq.${encodeURIComponent(em)}&status=eq.active`, env,
      { method: 'PATCH', body: JSON.stringify({ status: 'exited', date_exited: nowIso().slice(0, 10), updated_at: nowIso() }) });
    if (r.ok) result.exited.push(em); else result.errors.push(`exit ${em}: ${JSON.stringify(r.data)}`);
  }

  if (create.length) {
    let gusers;
    try { gusers = await fetchGoogleUsers(env); }
    catch (e) { return err('google_sync_failed: ' + (e?.message || e), 502); }
    const gByEmail = new Map(gusers.map(u => [(u.primaryEmail || '').toLowerCase(), u]));
    const authMap = await authEmailMap(env);
    const exRes = await sb(`/rest/v1/employees?select=work_email&limit=5000`, env);
    const existing = new Set((exRes.ok ? exRes.data : []).map(e => (e.work_email || '').toLowerCase()));
    for (const c of create) {
      const em = (c.email || '').toLowerCase();
      if (!em || existing.has(em)) { result.errors.push(`${c.email || '?'}: already exists`); continue; }
      const gu = gByEmail.get(em);
      if (!gu) { result.errors.push(`${c.email}: not in Google directory`); continue; }
      const seq = await nextEmployeeSeq(env);
      if (!seq && seq !== 0) { result.errors.push(`${c.email}: sequence error`); continue; }
      const row = {
        employee_code: 'EMP-' + String(seq).padStart(3, '0'),
        full_name: [gu.name?.givenName, gu.name?.familyName].filter(Boolean).join(' ') || gu.name?.fullName || gu.primaryEmail,
        work_email: gu.primaryEmail,
        department_id: c.department_id || null,
        manager_id: c.manager_id || null,
        job_title: c.job_title || gu.organizations?.[0]?.title || null,
        status: 'active',
        auth_user_id: authMap[em] || null,
        google_user_id: gu.id || null,
        synced_from_google_at: nowIso(),
        created_by: auth.userId,
      };
      const ins = await sb(`/rest/v1/employees`, env, { method: 'POST', body: JSON.stringify([row]) });
      if (ins.ok) { existing.add(em); result.created.push({ email: gu.primaryEmail, employee_code: row.employee_code }); }
      else result.errors.push(`${c.email}: ${JSON.stringify(ins.data)}`);
    }
  }
  return ok(result);
}

// ────────────────────────────────────────────────────────────────────────────
// APPRAISAL ENGINE (Phase 3) — RULE-PODIUM-008.
// Twice-yearly (Apr 1 / Oct 1) two-sided hybrid reviews → lightweight calibration
// → banded (pro-rated) increment → share + acknowledge; PIP flag. Participation is
// relationship-scoped (subject / manager-chain), NOT podium_view-gated.
// ────────────────────────────────────────────────────────────────────────────

function clampRating(v) { const n = Math.round(Number(v)); return (n >= 1 && n <= 5) ? n : null; }
function isoMinusMonths(dateStr, months) { const x = new Date(dateStr + 'T00:00:00Z'); x.setUTCMonth(x.getUTCMonth() - months); return x.toISOString().slice(0, 10); }
function isoMinusDays(dateStr, days) { const x = new Date(dateStr + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - days); return x.toISOString().slice(0, 10); }
function periodMonths(start, end) {
  if (!start || !end) return 6;
  const s = new Date(start + 'T00:00:00Z'), e = new Date(end + 'T00:00:00Z');
  let m = (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + (e.getUTCMonth() - s.getUTCMonth());
  if (e.getUTCDate() < s.getUTCDate()) m -= 1;
  return Math.max(m, 1);
}
function suggestedPct(bands, rating, months) {
  const b = (bands || []).find(x => Number(x.rating) === Number(rating));
  if (!b) return null;
  const base = Number(b.mid != null ? b.mid : (b.default || 0));
  return Math.round(base * (months / 6) * 100) / 100;
}
async function loadAppraisalSettings(env) {
  const r = await sb(`/rest/v1/settings?id=eq.1&select=increment_bands,appraisal_prompts,pip_rating_threshold,comp_vault_enabled&limit=1`, env);
  const s = r.data?.[0] || {};
  return {
    bands: s.increment_bands || [],
    prompts: s.appraisal_prompts || ['What went well', 'What could have gone better', 'Focus for the next period'],
    pipThreshold: s.pip_rating_threshold ?? 2,
    vault: !!s.comp_vault_enabled,
  };
}
async function saveKpiRatings(appraisalId, list, side, env) {
  if (!Array.isArray(list) || !list.length) return;
  const col = side === 'manager' ? 'manager_rating' : 'self_rating';
  for (const item of list.slice(0, 25)) {
    if (!item || !item.id) continue;
    await sb(`/rest/v1/appraisal_kpi_ratings?id=eq.${item.id}&appraisal_id=eq.${appraisalId}`, env,
      { method: 'PATCH', body: JSON.stringify({ [col]: clampRating(item.rating) }) });
  }
}
// Subject sees own self-side always; manager qualitative + final + outcome only once shared;
// never manager_overall_rating or calibration_note.
function projectAppraisalForSubject(a) {
  const o = {
    id: a.id, cycle: a.cycle, status: a.status,
    review_period_start: a.review_period_start, review_period_end: a.review_period_end,
    self_overall_rating: a.self_overall_rating, self_did_well: a.self_did_well,
    self_improve: a.self_improve, self_focus: a.self_focus, self_submitted_at: a.self_submitted_at,
  };
  if (a.status === 'shared' || a.status === 'acknowledged') {
    o.final_rating = a.final_rating; o.outcome = a.outcome;
    o.manager_did_well = a.manager_did_well; o.manager_improve = a.manager_improve; o.manager_focus = a.manager_focus;
    o.shared_at = a.shared_at; o.acknowledged_at = a.acknowledged_at; o.ack_note = a.ack_note;
  }
  return o;
}

// ── Config (self-serve; bands/threshold only for HR/comp) ─────────────────────
async function getAppraisalConfig(url, auth, env) {
  const s = await loadAppraisalSettings(env);
  const out = { appraisal_prompts: s.prompts };
  if (isHr(auth) || canComp(auth)) { out.increment_bands = s.bands; out.pip_rating_threshold = s.pipThreshold; }
  return ok(out);
}

// ── Cycles (HR) ───────────────────────────────────────────────────────────────
async function getAppraisalCycles(url, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const r = await sb(`/rest/v1/appraisal_cycles?select=*&order=appraisal_date.desc&limit=100`, env);
  return ok({ cycles: r.data || [] });
}
async function getAppraisalCycle(url, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const id = url.searchParams.get('id'); if (!id) return err('id required', 400);
  const [cr, ar] = await Promise.all([
    sb(`/rest/v1/appraisal_cycles?id=eq.${id}&select=*&limit=1`, env),
    sb(`/rest/v1/appraisals?cycle_id=eq.${id}&select=status,self_submitted_at,manager_submitted_at,final_rating,outcome&limit=2000`, env),
  ]);
  const cycle = cr.data?.[0]; if (!cycle) return err('not_found', 404);
  const a = ar.data || [];
  return ok({
    cycle,
    counts: {
      total: a.length,
      self_done: a.filter(x => x.self_submitted_at).length,
      manager_done: a.filter(x => x.manager_submitted_at).length,
      finalized: a.filter(x => x.final_rating).length,
      shared: a.filter(x => x.status === 'shared' || x.status === 'acknowledged').length,
      acknowledged: a.filter(x => x.status === 'acknowledged').length,
      pip: a.filter(x => x.outcome === 'pip').length,
    },
  });
}
async function createAppraisalCycle(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const d = body.data || body;
  if (!d.appraisal_date) return err('appraisal_date required (e.g. an Apr 1 / Oct 1)', 400);
  const ad = d.appraisal_date;
  const row = {
    name: d.name || ('Appraisal ' + ad),
    appraisal_date: ad,
    period_start: d.period_start || isoMinusMonths(ad, 6),
    period_end: d.period_end || isoMinusDays(ad, 1),
    eligibility_cutoff_date: d.eligibility_cutoff_date || isoMinusMonths(ad, 3),
    self_review_due: d.self_review_due || null,
    manager_review_due: d.manager_review_due || null,
    status: 'draft',
    created_by: auth.userId,
  };
  const r = await sb(`/rest/v1/appraisal_cycles`, env, { method: 'POST', body: JSON.stringify([row]) });
  if (!r.ok) return err('create_failed: ' + JSON.stringify(r.data), 400);
  return ok(r.data?.[0]);
}
async function setCycleStatus(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const d = body.data || body;
  if (!d.cycle_id || !['draft', 'active', 'calibration', 'closed'].includes(d.status)) return err('cycle_id + valid status required', 400);
  const r = await sb(`/rest/v1/appraisal_cycles?id=eq.${d.cycle_id}`, env, { method: 'PATCH', body: JSON.stringify({ status: d.status, updated_at: nowIso() }) });
  if (!r.ok) return err('update_failed', 400);
  return ok({ cycle_id: d.cycle_id, status: d.status });
}

// ── Enrollment (HR) ────────────────────────────────────────────────────────────
async function getEnrollmentPreview(url, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const cycleId = url.searchParams.get('cycle_id'); if (!cycleId) return err('cycle_id required', 400);
  const cr = await sb(`/rest/v1/appraisal_cycles?id=eq.${cycleId}&select=*&limit=1`, env);
  const cycle = cr.data?.[0]; if (!cycle) return err('cycle not found', 404);
  const [er, ar, existing] = await Promise.all([
    sb(`/rest/v1/employees?status=eq.active&select=id,full_name,date_joined,manager_id&order=full_name.asc&limit=5000`, env),
    sb(`/rest/v1/appraisals?select=employee_id,cycle:cycle_id(appraisal_date)&limit=5000`, env),
    sb(`/rest/v1/appraisals?cycle_id=eq.${cycleId}&select=employee_id&limit=5000`, env),
  ]);
  const emps = er.data || [];
  const empById = new Map(emps.map(e => [e.id, e]));
  const enrolled = new Set((existing.data || []).map(x => x.employee_id));
  const lastByEmp = {};
  for (const a of (ar.data || [])) { const ad = a.cycle?.appraisal_date; if (ad && (!lastByEmp[a.employee_id] || ad > lastByEmp[a.employee_id])) lastByEmp[a.employee_id] = ad; }
  const cutoff = cycle.eligibility_cutoff_date;
  const cands = emps.map(e => {
    let eligibility = 'eligible', flag = null;
    if (!e.date_joined) { eligibility = 'unknown'; flag = 'no join date'; }
    else if (e.date_joined < cutoff) { eligibility = 'eligible'; }
    else {
      eligibility = 'ineligible';
      const days = (new Date(e.date_joined + 'T00:00:00Z') - new Date(cutoff + 'T00:00:00Z')) / 86400000;
      if (days >= 0 && days <= 7) flag = 'borderline';
    }
    const ps = lastByEmp[e.id] || e.date_joined || cycle.period_start;
    const mgr = e.manager_id ? empById.get(e.manager_id) : null;
    return {
      employee_id: e.id, full_name: e.full_name, date_joined: e.date_joined,
      eligibility, flag, already_enrolled: enrolled.has(e.id),
      review_period_start: ps, review_period_end: cycle.appraisal_date,
      review_period_months: periodMonths(ps, cycle.appraisal_date),
      manager_id: e.manager_id, manager_name: mgr ? mgr.full_name : null,
    };
  });
  return ok({ cycle, candidates: cands });
}
async function enrollAppraisalCycle(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const d = body.data || body;
  const cycleId = d.cycle_id, ids = Array.isArray(d.employee_ids) ? d.employee_ids : [];
  if (!cycleId || !ids.length) return err('cycle_id and employee_ids[] required', 400);
  const cr = await sb(`/rest/v1/appraisal_cycles?id=eq.${cycleId}&select=*&limit=1`, env);
  const cycle = cr.data?.[0]; if (!cycle) return err('cycle not found', 404);
  const ex = await sb(`/rest/v1/appraisals?cycle_id=eq.${cycleId}&select=employee_id&limit=5000`, env);
  const already = new Set((ex.data || []).map(x => x.employee_id));
  const toAdd = ids.filter(id => !already.has(id));
  if (!toAdd.length) return ok({ enrolled: 0, skipped: ids.length });
  const [er, ar] = await Promise.all([
    sb(`/rest/v1/employees?id=in.(${toAdd.join(',')})&select=id,date_joined,manager_id,job_role_id&limit=5000`, env),
    sb(`/rest/v1/appraisals?select=employee_id,cycle:cycle_id(appraisal_date)&limit=5000`, env),
  ]);
  const emps = er.data || [];
  const lastByEmp = {};
  for (const a of (ar.data || [])) { const ad = a.cycle?.appraisal_date; if (ad && (!lastByEmp[a.employee_id] || ad > lastByEmp[a.employee_id])) lastByEmp[a.employee_id] = ad; }
  const roleIds = [...new Set(emps.map(e => e.job_role_id).filter(Boolean))];
  const kpisByRole = {};
  if (roleIds.length) {
    const kr = await sb(`/rest/v1/role_kpis?job_role_id=in.(${roleIds.join(',')})&active=eq.true&select=id,job_role_id,name,weight,sort_order&order=sort_order.asc&limit=2000`, env);
    for (const k of (kr.data || [])) (kpisByRole[k.job_role_id] ||= []).push(k);
  }
  const rows = emps.map(e => ({
    cycle_id: cycleId, employee_id: e.id, manager_id: e.manager_id || null,
    review_period_start: lastByEmp[e.id] || e.date_joined || cycle.period_start,
    review_period_end: cycle.appraisal_date, status: 'self_review',
  }));
  const ins = await sb(`/rest/v1/appraisals`, env, { method: 'POST', body: JSON.stringify(rows), prefer: 'return=representation' });
  if (!ins.ok) return err('enroll_failed: ' + JSON.stringify(ins.data), 400);
  const created = ins.data || [];
  const kpiRows = [];
  for (const a of created) {
    const e = emps.find(x => x.id === a.employee_id);
    for (const k of ((e && kpisByRole[e.job_role_id]) || [])) kpiRows.push({ appraisal_id: a.id, role_kpi_id: k.id, kpi_name: k.name, weight: k.weight, sort_order: k.sort_order || 0 });
  }
  if (kpiRows.length) await sb(`/rest/v1/appraisal_kpi_ratings`, env, { method: 'POST', body: JSON.stringify(kpiRows), prefer: 'return=minimal' });
  return ok({ enrolled: created.length, kpis: kpiRows.length });
}

// ── Reviews (self-serve, relationship-checked) ─────────────────────────────────
async function submitSelfReview(body, auth, env) {
  const d = body.data || body;
  if (!d.appraisal_id) return err('appraisal_id required', 400);
  const ar = await sb(`/rest/v1/appraisals?id=eq.${d.appraisal_id}&select=*,cycle:cycle_id(status)&limit=1`, env);
  const a = ar.data?.[0]; if (!a) return err('not_found', 404);
  const me = await meOf(auth, env);
  if (!me || me.id !== a.employee_id) return err('forbidden — your own self-review only', 403);
  if (a.cycle?.status !== 'active') return err('cycle is not open for reviews', 422);
  if (a.status === 'shared' || a.status === 'acknowledged') return err('already finalized', 422);
  const patch = {
    self_overall_rating: clampRating(d.self_overall_rating),
    self_did_well: d.self_did_well ?? null, self_improve: d.self_improve ?? null, self_focus: d.self_focus ?? null,
    self_submitted_at: nowIso(), updated_at: nowIso(),
  };
  if (a.status === 'self_review') patch.status = 'manager_review';
  const r = await sb(`/rest/v1/appraisals?id=eq.${d.appraisal_id}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
  if (!r.ok) return err('save_failed: ' + JSON.stringify(r.data), 400);
  await saveKpiRatings(d.appraisal_id, d.kpi_ratings, 'self', env);
  return ok({ id: d.appraisal_id, status: patch.status || a.status });
}
async function submitManagerReview(body, auth, env) {
  const d = body.data || body;
  if (!d.appraisal_id) return err('appraisal_id required', 400);
  const ar = await sb(`/rest/v1/appraisals?id=eq.${d.appraisal_id}&select=*,cycle:cycle_id(status)&limit=1`, env);
  const a = ar.data?.[0]; if (!a) return err('not_found', 404);
  const edges = await loadOrgEdges(env);
  if (!canManage(auth, edges, a.employee_id)) return err('forbidden — manager only', 403);
  if (a.cycle?.status !== 'active') return err('cycle is not open for reviews', 422);
  if (a.status === 'shared' || a.status === 'acknowledged') return err('already finalized', 422);
  const patch = {
    manager_overall_rating: clampRating(d.manager_overall_rating),
    manager_did_well: d.manager_did_well ?? null, manager_improve: d.manager_improve ?? null, manager_focus: d.manager_focus ?? null,
    manager_submitted_at: nowIso(), status: 'calibration', updated_at: nowIso(),
  };
  const r = await sb(`/rest/v1/appraisals?id=eq.${d.appraisal_id}`, env, { method: 'PATCH', body: JSON.stringify(patch) });
  if (!r.ok) return err('save_failed: ' + JSON.stringify(r.data), 400);
  await saveKpiRatings(d.appraisal_id, d.kpi_ratings, 'manager', env);
  return ok({ id: d.appraisal_id, status: 'calibration' });
}
async function acknowledgeAppraisal(body, auth, env) {
  const d = body.data || body;
  if (!d.appraisal_id) return err('appraisal_id required', 400);
  const ar = await sb(`/rest/v1/appraisals?id=eq.${d.appraisal_id}&select=employee_id,status&limit=1`, env);
  const a = ar.data?.[0]; if (!a) return err('not_found', 404);
  const me = await meOf(auth, env);
  if (!me || me.id !== a.employee_id) return err('forbidden', 403);
  if (a.status !== 'shared') return err('not yet shared', 422);
  const r = await sb(`/rest/v1/appraisals?id=eq.${d.appraisal_id}`, env, { method: 'PATCH', body: JSON.stringify({ status: 'acknowledged', acknowledged_at: nowIso(), ack_note: d.ack_note ?? null, updated_at: nowIso() }) });
  if (!r.ok) return err('ack_failed', 400);
  return ok({ id: d.appraisal_id, status: 'acknowledged' });
}

// ── Calibration / finalize / share (HR) ────────────────────────────────────────
async function finalizeAppraisal(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const d = body.data || body;
  const fr = clampRating(d.final_rating);
  if (!d.appraisal_id || !fr) return err('appraisal_id + final_rating (1-5) required', 400);
  const s = await loadAppraisalSettings(env);
  const r = await sb(`/rest/v1/appraisals?id=eq.${d.appraisal_id}`, env, {
    method: 'PATCH', body: JSON.stringify({
      final_rating: fr, calibration_note: d.calibration_note ?? null,
      calibrated_by: auth.userId, calibrated_at: nowIso(),
      outcome: fr <= s.pipThreshold ? 'pip' : 'standard', updated_at: nowIso(),
    }),
  });
  if (!r.ok) return err('finalize_failed: ' + JSON.stringify(r.data), 400);
  return ok({ id: d.appraisal_id, final_rating: fr, outcome: fr <= s.pipThreshold ? 'pip' : 'standard' });
}
async function shareAppraisal(body, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const d = body.data || body;
  const ids = Array.isArray(d.appraisal_ids) ? d.appraisal_ids : (d.appraisal_id ? [d.appraisal_id] : []);
  if (!ids.length) return err('appraisal_id or appraisal_ids[] required', 400);
  const r = await sb(`/rest/v1/appraisals?id=in.(${ids.join(',')})&final_rating=not.is.null&status=neq.acknowledged`, env,
    { method: 'PATCH', body: JSON.stringify({ status: 'shared', shared_at: nowIso(), updated_at: nowIso() }), prefer: 'return=representation' });
  if (!r.ok) return err('share_failed: ' + JSON.stringify(r.data), 400);
  return ok({ shared: (r.data || []).length });
}
async function applyIncrement(body, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  const d = body.data || body;
  if (!d.appraisal_id) return err('appraisal_id required', 400);
  const ar = await sb(`/rest/v1/appraisals?id=eq.${d.appraisal_id}&select=employee_id,final_rating,cycle:cycle_id(appraisal_date)&limit=1`, env);
  const a = ar.data?.[0]; if (!a) return err('not_found', 404);
  if (!a.final_rating) return err('finalize the appraisal first', 422);
  const pct = d.increment_pct != null && d.increment_pct !== '' ? Number(d.increment_pct) : null;
  const bonus = d.bonus_amount != null && d.bonus_amount !== '' ? Number(d.bonus_amount) : null;
  if (pct == null && bonus == null) return err('increment_pct or bonus_amount required', 400);
  const row = {
    employee_id: a.employee_id,
    event_type: pct != null ? 'increment' : 'one_time_bonus',
    effective_date: d.effective_date || a.cycle?.appraisal_date,
    increment_pct: pct, amount: bonus, currency: d.currency || 'INR',
    reason: d.reason || 'Appraisal increment', appraisal_id: d.appraisal_id,
    approved_by: auth.userId, created_by: auth.userId,
  };
  // Vault OFF: CTC fields never accepted here (not read from input).
  const ins = await sb(`/rest/v1/compensation_events`, env, { method: 'POST', body: JSON.stringify([row]) });
  if (!ins.ok) return err('increment_failed: ' + JSON.stringify(ins.data), 400);
  return ok(ins.data?.[0]);
}

// ── Reads: subject / manager / HR views ────────────────────────────────────────
async function getMyAppraisals(url, auth, env) {
  const me = await meOf(auth, env);
  if (!me) return ok({ employee_id: null, appraisals: [], to_review: [] });
  const [ar, tr] = await Promise.all([
    sb(`/rest/v1/appraisals?employee_id=eq.${me.id}&select=*,cycle:cycle_id(name,appraisal_date,status,self_review_due)&order=created_at.desc&limit=200`, env),
    sb(`/rest/v1/appraisals?manager_id=eq.${me.id}&select=id,status,manager_submitted_at,employee:employee_id(full_name,job_title),cycle:cycle_id(name,status,manager_review_due)&order=created_at.desc&limit=300`, env),
  ]);
  const appraisals = (ar.data || []).map(projectAppraisalForSubject);
  const to_review = (tr.data || []).filter(a => a.cycle?.status === 'active')
    .map(a => ({ id: a.id, employee: a.employee, status: a.status, done: !!a.manager_submitted_at, cycle: a.cycle }));
  return ok({ employee_id: me.id, appraisals, to_review });
}
async function getTeamAppraisals(url, auth, env) {
  const me = await meOf(auth, env);
  const hr = isHr(auth);
  if (!me && !hr) return ok({ appraisals: [] });
  const cycleId = url.searchParams.get('cycle_id');
  let filter = cycleId ? `cycle_id=eq.${cycleId}` : `cycle_id=not.is.null`;
  if (!hr) filter += `&manager_id=eq.${me.id}`;
  const ar = await sb(`/rest/v1/appraisals?${filter}&select=id,status,self_submitted_at,manager_submitted_at,final_rating,outcome,employee:employee_id(full_name,job_title),cycle:cycle_id(name,status)&order=created_at.desc&limit=500`, env);
  return ok({ appraisals: ar.data || [] });
}
async function getAppraisal(url, auth, env) {
  const id = url.searchParams.get('id'); if (!id) return err('id required', 400);
  const ar = await sb(`/rest/v1/appraisals?id=eq.${id}&select=*,cycle:cycle_id(*),employee:employee_id(id,full_name,job_title,department:department_id(name)),manager:manager_id(id,full_name)&limit=1`, env);
  const a = ar.data?.[0]; if (!a) return err('not_found', 404);
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  const isSubject = !!(me && me.id === a.employee_id);
  const hr = isHr(auth);
  const isMgr = !hr && !isSubject && canManage(auth, edges, a.employee_id);
  if (!isSubject && !isMgr && !hr) return err('forbidden', 403);
  const kr = await sb(`/rest/v1/appraisal_kpi_ratings?appraisal_id=eq.${id}&select=*&order=sort_order.asc`, env);
  const kpis = kr.data || [];
  let increment = null;
  if (isSubject || canComp(auth)) {
    const cr = await sb(`/rest/v1/compensation_events?appraisal_id=eq.${id}&select=increment_pct,amount,currency,effective_date,event_type&order=created_at.desc&limit=1`, env);
    increment = cr.data?.[0] || null;
    if (isSubject && !(a.status === 'shared' || a.status === 'acknowledged')) increment = null;
  }
  if (hr || isMgr) {
    const out = { ...a, kpis, increment, _role: hr ? 'hr' : 'manager', _can_calibrate: hr, _can_comp: canComp(auth) };
    if (!hr) out.calibration_note = null; // HR-internal
    return ok(out);
  }
  // subject
  const out = projectAppraisalForSubject(a);
  out._role = 'subject';
  out.increment = increment;
  out.kpis = kpis.map(k => ({ id: k.id, kpi_name: k.kpi_name, weight: k.weight, self_rating: k.self_rating, manager_rating: (a.status === 'shared' || a.status === 'acknowledged') ? k.manager_rating : null }));
  return ok(out);
}
async function getAppraisals(url, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const cycleId = url.searchParams.get('cycle_id'); if (!cycleId) return err('cycle_id required', 400);
  const compOk = canComp(auth);
  const [cr, ar] = await Promise.all([
    sb(`/rest/v1/appraisal_cycles?id=eq.${cycleId}&select=*&limit=1`, env),
    sb(`/rest/v1/appraisals?cycle_id=eq.${cycleId}&select=*,employee:employee_id(full_name,job_title,department:department_id(name)),manager:manager_id(full_name)&order=created_at.desc&limit=2000`, env),
  ]);
  const cycle = cr.data?.[0];
  const s = await loadAppraisalSettings(env);
  const rows = (ar.data || []).map(a => {
    const months = periodMonths(a.review_period_start, a.review_period_end);
    return { ...a, review_period_months: months, suggested_pct: compOk ? suggestedPct(s.bands, a.final_rating || a.manager_overall_rating, months) : null };
  });
  return ok({ cycle, appraisals: rows, increment_bands: compOk ? s.bands : null, pip_rating_threshold: s.pipThreshold });
}

// ────────────────────────────────────────────────────────────────────────────
// DISPATCH
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// FACTORY COST MODULE (compensation-tier) — source of truth for the cost engine.
// Salaries live ONLY here + are rendered ONLY in the Podium admin UI. The Redline
// cost views read aggregates from Postgres RPCs, never these raw rows.
// ────────────────────────────────────────────────────────────────────────────
// requireComp(auth) (defined above) returns an err Response for non-comp users, else null.

// public-schema read (operators live in public). Service-role, no schema profile.
async function sbPublicGet(path, env) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
  });
  const text = await res.text(); let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

async function getFactoryWorkforce(url, auth, env) {
  { const _g = requireComp(auth); if (_g) return _g; }
  await logCompAccess(auth, 'getFactoryWorkforce', null, 'all factory operators', env);
  const ops   = (await sbPublicGet(`/rest/v1/operators?select=id,employee_id,name,department,status&status=eq.active&order=department,name`, env)).data || [];
  const wf    = (await sb(`/rest/v1/factory_workforce?select=*`, env)).data || [];
  const pay   = (await sb(`/rest/v1/factory_pay?select=operator_id,effective_from,monthly_ctc&order=effective_from.desc`, env)).data || [];
  const ranks = (await sb(`/rest/v1/factory_ranks?select=*&order=sort_order`, env)).data || [];
  const wfBy = {}; for (const w of (wf || [])) wfBy[w.operator_id] = w;
  const curPay = {}; for (const p of (pay || [])) if (!curPay[p.operator_id]) curPay[p.operator_id] = p; // latest
  const rows = (Array.isArray(ops) ? ops : []).map(o => ({
    id: o.id, employee_id: o.employee_id, name: o.name, department: o.department, status: o.status,
    factory: wfBy[o.id] || null,
    current_ctc: curPay[o.id]?.monthly_ctc ?? null,
    current_ctc_from: curPay[o.id]?.effective_from ?? null,
  }));
  return ok({ operators: rows, ranks: ranks || [] });
}

async function getFactoryCostInputs(url, auth, env) {
  { const _g = requireComp(auth); if (_g) return _g; }
  const r     = await sb(`/rest/v1/factory_cost_inputs?select=*&order=kind,label,effective_from.desc`, env);
  const rates = await sb(`/rest/v1/factory_ot_rates?select=*&order=effective_from.desc`, env);
  return ok({ cost_inputs: r.data || [], ot_rates: rates.data || [] });
}

async function setFactoryWorkforce(body, auth, env) {
  { const _g = requireComp(auth); if (_g) return _g; }
  const d = body.data || body;
  if (!d.operator_id) return err('operator_id required');
  const row = {
    operator_id: d.operator_id,
    rank_id: d.rank_id || null,
    employment_type: d.employment_type === 'contract' ? 'contract' : 'in_house',
    active: d.active !== false,
    updated_at: new Date().toISOString(),
  };
  const r = await sb(`/rest/v1/factory_workforce?on_conflict=operator_id`, env, {
    method: 'POST', body: JSON.stringify(row),
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
  });
  if (!r.ok) return err('workforce upsert failed: ' + JSON.stringify(r.data));
  return ok(Array.isArray(r.data) ? r.data[0] : r.data);
}

async function setFactoryPay(body, auth, env) {
  { const _g = requireComp(auth); if (_g) return _g; }
  const d = body.data || body;
  if (!d.operator_id || d.monthly_ctc == null || !d.effective_from) return err('operator_id, monthly_ctc, effective_from required');
  const r = await sb(`/rest/v1/factory_pay`, env, {
    method: 'POST',
    body: JSON.stringify({ operator_id: d.operator_id, effective_from: d.effective_from, monthly_ctc: Number(d.monthly_ctc), note: d.note || null, created_by: auth.userId || null }),
  });
  if (!r.ok) return err('pay insert failed: ' + JSON.stringify(r.data));
  return ok(Array.isArray(r.data) ? r.data[0] : r.data);
}

async function bulkUploadFactoryPay(body, auth, env) {
  { const _g = requireComp(auth); if (_g) return _g; }
  const d = body.data || body;
  const rows = Array.isArray(d.rows) ? d.rows : [];
  if (!rows.length) return err('rows required');
  const ops = (await sbPublicGet(`/rest/v1/operators?select=id,employee_id,name`, env)).data || [];
  const byEmp = {}, byName = {};
  for (const o of (Array.isArray(ops) ? ops : [])) {
    if (o.employee_id) byEmp[String(o.employee_id).trim().toLowerCase()] = o.id;
    if (o.name) byName[String(o.name).trim().toLowerCase()] = o.id;
  }
  const eff = d.effective_from || (new Date().toISOString().slice(0, 8) + '01');
  const payRows = [], wfRows = [], unmatched = []; let matched = 0;
  for (const r of rows) {
    const opId = byEmp[String(r.employee_id || '').trim().toLowerCase()] || byName[String(r.name || '').trim().toLowerCase()] || null;
    if (!opId || r.monthly_ctc == null || isNaN(Number(r.monthly_ctc))) { unmatched.push(r); continue; }
    matched++;
    payRows.push({ operator_id: opId, effective_from: r.effective_from || eff, monthly_ctc: Number(r.monthly_ctc), note: 'bulk upload', created_by: auth.userId || null });
    wfRows.push({ operator_id: opId, employment_type: r.employment_type === 'contract' ? 'contract' : 'in_house', active: true, updated_at: new Date().toISOString() });
  }
  if (wfRows.length) await sb(`/rest/v1/factory_workforce?on_conflict=operator_id`, env, { method: 'POST', body: JSON.stringify(wfRows), headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
  if (payRows.length) { const pr = await sb(`/rest/v1/factory_pay`, env, { method: 'POST', body: JSON.stringify(payRows), prefer: 'return=minimal' }); if (!pr.ok) return err('pay bulk insert failed: ' + JSON.stringify(pr.data)); }
  return ok({ inserted: payRows.length, matched, unmatched });
}

async function setFactoryCostInput(body, auth, env) {
  { const _g = requireComp(auth); if (_g) return _g; }
  const d = body.data || body;
  const KINDS = ['rent', 'electricity', 'other', 'admin', 'security'];
  if (!KINDS.includes(d.kind) || !d.label || d.monthly_amount == null || !d.effective_from) return err('kind(valid), label, monthly_amount, effective_from required');
  const r = await sb(`/rest/v1/factory_cost_inputs`, env, {
    method: 'POST',
    body: JSON.stringify({ kind: d.kind, label: d.label, effective_from: d.effective_from, monthly_amount: Number(d.monthly_amount), is_estimated: !!d.is_estimated, note: d.note || null, created_by: auth.userId || null }),
  });
  if (!r.ok) return err('cost input insert failed: ' + JSON.stringify(r.data));
  return ok(Array.isArray(r.data) ? r.data[0] : r.data);
}

async function setFactoryOtRates(body, auth, env) {
  { const _g = requireComp(auth); if (_g) return _g; }
  const d = body.data || body;
  if (d.in_house_per_hour == null || d.contract_per_hour == null || !d.effective_from) return err('in_house_per_hour, contract_per_hour, effective_from required');
  const r = await sb(`/rest/v1/factory_ot_rates`, env, {
    method: 'POST',
    body: JSON.stringify({ effective_from: d.effective_from, in_house_per_hour: Number(d.in_house_per_hour), contract_per_hour: Number(d.contract_per_hour) }),
  });
  if (!r.ok) return err('ot rate insert failed: ' + JSON.stringify(r.data));
  return ok(Array.isArray(r.data) ? r.data[0] : r.data);
}

// ── Phase 6 — Analytics (aggregate-only; math lives in podium.f_analytics_*) ──
// Org + Perf are HR/admin surfaces. Comp is allow-list-gated (RULE-PODIUM-002:
// the allow-list is THE salary gate) and audited — it is a cross-person comp
// read even though only aggregates are returned.

function clampInt(v, def, min, max) {
  if (v == null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), min), max) : def;
}

async function getAnalyticsOrg(url, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const months = clampInt(url.searchParams.get('months'), 12, 1, 36);
  const r = await sb(`/rest/v1/rpc/f_analytics_org`, env, {
    method: 'POST', body: JSON.stringify({ p_months: months }),
  });
  if (!r.ok) return err('db_error', 500);
  return ok(r.data);
}

async function getAnalyticsComp(url, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  const months = clampInt(url.searchParams.get('months'), 12, 1, 36);
  await logCompAccess(auth, 'getAnalyticsComp', null, 'comp aggregates', env, { months });
  const r = await sb(`/rest/v1/rpc/f_analytics_comp`, env, {
    method: 'POST', body: JSON.stringify({ p_months: months }),
  });
  if (!r.ok) return err('db_error', 500);
  return ok(r.data);
}

async function getAnalyticsPerf(url, auth, env) {
  const gate = requireHr(auth); if (gate) return gate;
  const cycles = clampInt(url.searchParams.get('cycles'), 4, 1, 10);
  const r = await sb(`/rest/v1/rpc/f_analytics_perf`, env, {
    method: 'POST', body: JSON.stringify({ p_cycles: cycles }),
  });
  if (!r.ok) return err('db_error', 500);
  return ok(r.data);
}

// ── Payouts ledger — period + component helpers ──────────────────────────────
// FY = Apr 1 – Mar 31. Half 1 = Apr–Sep, Half 2 = Oct–Mar. Monthly key 'YYYY-MM';
// half key 'FYaa-bb-H1|H2' (e.g. 'FY26-27-H1').
function periodMeta(key) {
  if (/^\d{4}-\d{2}$/.test(key)) {
    const [y, m] = key.split('-').map(Number);
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // last day of month m
    return { period_type: 'monthly', period_start: `${key}-01`, period_end: end };
  }
  const hm = /^FY(\d{2})-(\d{2})-H([12])$/.exec(key);
  if (hm) {
    const sy = 2000 + Number(hm[1]);
    return Number(hm[3]) === 1
      ? { period_type: 'half_yearly', period_start: `${sy}-04-01`, period_end: `${sy}-09-30` }
      : { period_type: 'half_yearly', period_start: `${sy}-10-01`, period_end: `${sy + 1}-03-31` };
  }
  return { period_type: 'one_time', period_start: null, period_end: null };
}

// Latest non-bonus CTC components per employee id → { <empId>: componentsJsonb }.
// Batched (single query, IN filter) — no per-row awaits.
async function currentComponentsFor(empIds, env) {
  if (!empIds.length) return {};
  const r = await sb(
    `/rest/v1/compensation_events?employee_id=in.(${empIds.join(',')})&event_type=neq.one_time_bonus` +
    `&select=employee_id,components,effective_date,created_at&order=effective_date.desc,created_at.desc`,
    env,
  );
  const out = {};
  for (const row of (r.ok ? r.data || [] : [])) if (!out[row.employee_id]) out[row.employee_id] = row.components || {};
  return out;
}

// ── Payouts ledger — reads (comp = cross-person + audited; self = own-only) ───
const PAYOUT_ORDER = 'order=period_start.desc.nullslast,paid_on.desc.nullslast,created_at.desc';

async function getPayouts(url, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  const employee_id = url.searchParams.get('employee_id');
  if (!employee_id) return err('employee_id required', 400);
  await logCompAccess(auth, 'getPayouts', employee_id, null, env);
  const r = await sb(`/rest/v1/payouts?employee_id=eq.${employee_id}&select=*&${PAYOUT_ORDER}`, env);
  if (!r.ok) return err('db_error', 500);
  return ok({ payouts: r.data || [] });
}

async function getMyPayouts(url, auth, env) {
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  if (!me) return ok({ employee_id: null, payouts: [] });
  const r = await sb(`/rest/v1/payouts?employee_id=eq.${me.id}&select=*&${PAYOUT_ORDER}`, env);
  if (!r.ok) return err('db_error', 500);
  return ok({ employee_id: me.id, payouts: r.data || [] });
}

// The entry grid: every active employee for a period+type, with a defaulted target
// (from current CTC components) and any existing row. Comp-gated + audited.
async function getPayoutPeriodSheet(url, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  const period_key = url.searchParams.get('period_key');
  const payout_type = url.searchParams.get('payout_type') || 'fixed';
  if (!period_key) return err('period_key required', 400);
  const meta = periodMeta(period_key);
  await logCompAccess(auth, 'getPayoutPeriodSheet', null, `${payout_type} ${period_key}`, env);
  const er = await sb(`/rest/v1/employees?status=neq.exited&select=id,employee_code,full_name,department:department_id(name)&order=full_name.asc`, env);
  const emps = er.ok ? (er.data || []) : [];
  const comps = await currentComponentsFor(emps.map(e => e.id), env);
  const xr = await sb(`/rest/v1/payouts?period_key=eq.${encodeURIComponent(period_key)}&payout_type=eq.${payout_type}&select=*`, env);
  const existing = {}; for (const row of (xr.ok ? xr.data || [] : [])) existing[row.employee_id] = row;
  const rows = emps.map(e => {
    const c = comps[e.id] || {};
    let target = null;
    if (payout_type === 'fixed') target = c.monthly_fixed ?? null;
    else if (payout_type === 'variable') {
      if (meta.period_type === 'monthly') target = c.monthly_variable ?? null;
      else if (meta.period_type === 'half_yearly') target = c.variable_yearly != null ? Number(c.variable_yearly) / 2 : null;
    }
    return {
      employee_id: e.id, employee_code: e.employee_code, full_name: e.full_name,
      department: e.department?.name || null, bonus_type: c.bonus_type || null,
      default_target: target != null ? Number(target) : null,
      existing: existing[e.id] || null,
    };
  });
  return ok({ period_key, period_type: meta.period_type, payout_type, rows });
}

// Vendor / bulk payouts (e.g. contract-labour agency) — not tied to an employee.
async function getBulkPayouts(url, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  const period_key = url.searchParams.get('period_key');
  await logCompAccess(auth, 'getBulkPayouts', null, period_key || 'all', env);
  let q = `/rest/v1/payouts?payee_type=eq.vendor&select=*&${PAYOUT_ORDER}`;
  if (period_key) q += `&period_key=eq.${encodeURIComponent(period_key)}`;
  const r = await sb(q, env);
  if (!r.ok) return err('db_error', 500);
  return ok({ payouts: r.data || [] });
}

// ── Payouts ledger — writes (comp-gated) ─────────────────────────────────────
async function upsertPayouts(body, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  const d = body.data || body;
  const inRows = Array.isArray(d.rows) ? d.rows : [];
  if (!inRows.length) return err('rows required', 400);
  const clean = [];
  for (const r of inRows) {
    const isVendor = r.payee_type === 'vendor';
    if (!r.payout_type || r.amount == null || isNaN(Number(r.amount))) continue;
    if (isVendor ? !r.payee_label : !r.employee_id) continue; // vendor needs a label, employee needs an id
    const key = r.period_key || null;
    const meta = key ? periodMeta(key)
      : { period_type: r.period_type || 'one_time', period_start: r.period_start || null, period_end: r.period_end || null };
    clean.push({
      ...(r.id ? { id: r.id } : {}),
      employee_id: isVendor ? null : r.employee_id,
      payee_type: isVendor ? 'vendor' : 'employee',
      payee_label: isVendor ? r.payee_label : null,
      payout_type: r.payout_type,
      period_type: meta.period_type,
      period_key: key,
      period_start: meta.period_start,
      period_end: meta.period_end,
      target_amount: r.target_amount != null ? Number(r.target_amount) : null,
      achievement_pct: r.achievement_pct != null ? Number(r.achievement_pct) : null,
      amount: Number(r.amount),
      currency: r.currency || 'INR',
      paid_on: r.paid_on || null,
      note: r.note || null,
      source: r.source || 'manual',
      created_by: auth.userId || null,
      updated_at: nowIso(),
    });
  }
  if (!clean.length) return err('no valid rows', 400);
  // Only per-EMPLOYEE periodic rows dedup via the unique index. Vendor rows (null
  // employee_id) + ad-hoc rows are plain inserts (delete+re-add to correct).
  const periodic = clean.filter(r => r.employee_id && r.period_key);
  const rest = clean.filter(r => !(r.employee_id && r.period_key));
  let saved = 0;
  if (periodic.length) {
    const r = await sb(`/rest/v1/payouts?on_conflict=employee_id,payout_type,period_key`, env, {
      method: 'POST', prefer: 'return=minimal,resolution=merge-duplicates', body: JSON.stringify(periodic),
    });
    if (!r.ok) return err('upsert_failed: ' + JSON.stringify(r.data), 400);
    saved += periodic.length;
  }
  if (rest.length) {
    const r = await sb(`/rest/v1/payouts`, env, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(rest) });
    if (!r.ok) return err('insert_failed: ' + JSON.stringify(r.data), 400);
    saved += rest.length;
  }
  await logCompAccess(auth, 'upsertPayouts', null, `${saved} rows`, env);
  return ok({ saved });
}

// Auto-create a month's FIXED rows for active staff from current monthly_fixed.
// Idempotent — skips employees who already have a fixed row for the month.
async function generateFixedPayouts(body, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  const d = body.data || body;
  const period_key = d.period_key;
  if (!period_key || !/^\d{4}-\d{2}$/.test(period_key)) return err('period_key (YYYY-MM) required', 400);
  const meta = periodMeta(period_key);
  const er = await sb(`/rest/v1/employees?status=neq.exited&select=id`, env);
  const emps = er.ok ? (er.data || []) : [];
  const comps = await currentComponentsFor(emps.map(e => e.id), env);
  const xr = await sb(`/rest/v1/payouts?period_key=eq.${encodeURIComponent(period_key)}&payout_type=eq.fixed&select=employee_id`, env);
  const have = new Set((xr.ok ? xr.data || [] : []).map(r => r.employee_id));
  const rows = [];
  for (const e of emps) {
    if (have.has(e.id)) continue;
    const mf = comps[e.id]?.monthly_fixed;
    if (mf == null) continue;
    rows.push({
      employee_id: e.id, payout_type: 'fixed', period_type: 'monthly', period_key,
      period_start: meta.period_start, period_end: meta.period_end,
      target_amount: Number(mf), amount: Number(mf), currency: 'INR',
      source: 'fixed_autogen', created_by: auth.userId || null,
    });
  }
  if (rows.length) {
    const r = await sb(`/rest/v1/payouts`, env, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(rows) });
    if (!r.ok) return err('generate_failed: ' + JSON.stringify(r.data), 400);
  }
  await logCompAccess(auth, 'generateFixedPayouts', null, `${period_key}: +${rows.length}`, env);
  return ok({ created: rows.length, skipped: have.size });
}

async function deletePayout(body, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  const d = body.data || body;
  if (!d.id) return err('id required', 400);
  const r = await sb(`/rest/v1/payouts?id=eq.${encodeURIComponent(d.id)}`, env, { method: 'DELETE', prefer: 'return=minimal' });
  if (!r.ok) return err('delete_failed', 400);
  await logCompAccess(auth, 'deletePayout', null, d.id, env);
  return ok({ deleted: d.id });
}

// ── Salary-access allow-list (super_admin only: exactly Afshaan + Vinay) ──────
// Controls who is in podium.comp_access, i.e. who can see EVERYONE's salary.
// Edit-right derives from store.users_profile.role='super_admin', never from
// comp_access membership, so a super_admin can't lock themselves out.
async function getCompAccess(url, auth, env) {
  const gate = requireSuperAdmin(auth); if (gate) return gate;
  const r = await sb(`/rest/v1/comp_access?select=*&order=added_at.asc`, env);
  if (!r.ok) return err('db_error', 500);
  return ok({ members: r.data || [] });
}

async function addCompAccess(body, auth, env) {
  const gate = requireSuperAdmin(auth); if (gate) return gate;
  const d = body.data || body;
  if (!d.auth_user_id) return err('auth_user_id required', 400);
  const prof = await sbStore(`/rest/v1/users_profile?id=eq.${encodeURIComponent(d.auth_user_id)}&select=full_name&limit=1`, env);
  const fullName = (prof.ok && prof.data?.[0]?.full_name) || d.full_name || null;
  const r = await sb(`/rest/v1/comp_access?on_conflict=auth_user_id`, env, {
    method: 'POST', prefer: 'return=representation,resolution=merge-duplicates',
    body: JSON.stringify({ auth_user_id: d.auth_user_id, full_name: fullName, added_by: auth.userId, note: d.note || null }),
  });
  if (!r.ok) return err('add_failed: ' + JSON.stringify(r.data), 400);
  await logCompAccess(auth, 'addCompAccess', null, fullName, env, { added: d.auth_user_id });
  return ok({ auth_user_id: d.auth_user_id, full_name: fullName });
}

async function removeCompAccess(body, auth, env) {
  const gate = requireSuperAdmin(auth); if (gate) return gate;
  const d = body.data || body;
  if (!d.auth_user_id) return err('auth_user_id required', 400);
  const r = await sb(`/rest/v1/comp_access?auth_user_id=eq.${encodeURIComponent(d.auth_user_id)}`, env, { method: 'DELETE', prefer: 'return=minimal' });
  if (!r.ok) return err('remove_failed', 400);
  await logCompAccess(auth, 'removeCompAccess', null, d.full_name || null, env, { removed: d.auth_user_id });
  return ok({ removed: d.auth_user_id });
}

async function getCompAccessLog(url, auth, env) {
  const gate = requireSuperAdmin(auth); if (gate) return gate;
  const limit = Math.min(Number(url.searchParams.get('limit') || 200), 1000);
  const r = await sb(`/rest/v1/comp_access_log?select=*&order=at.desc&limit=${limit}`, env);
  if (!r.ok) return err('db_error', 500);
  return ok({ log: r.data || [] });
}

const GET_ACTIONS = {
  getMe, getSettings,
  getEmployees, getEmployee,
  getOrgChart, getOrgSnapshots,
  getDepartments,
  getJobRoles, getJobRole,
  getCompensation, getMyCompensation,
  getPayouts, getMyPayouts, getPayoutPeriodSheet, getBulkPayouts,
  getDocuments, getDocumentDownloadUrl,
  // Phase 2 — performance capture
  getObservations, getAccomplishments, getOneOnOnes,
  getMyPerformance, getTeamActivity,
  // Permission layer (Podium-managed)
  getPodiumRoles, getPodiumUsers,
  // Salary-access allow-list (super_admin)
  getCompAccess, getCompAccessLog,
  // Google Directory sync
  getDirectorySyncPreview,
  // Appraisal engine
  getAppraisalConfig, getMyAppraisals, getAppraisal, getTeamAppraisals,
  getAppraisals, getAppraisalCycles, getAppraisalCycle, getEnrollmentPreview,
  // Factory cost module (compensation-tier)
  getFactoryWorkforce, getFactoryCostInputs,
  // Phase 6 — analytics
  getAnalyticsOrg, getAnalyticsComp, getAnalyticsPerf,
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
  // Payouts ledger (comp-gated)
  upsertPayouts, generateFixedPayouts, deletePayout,
  // Salary-access allow-list (super_admin)
  addCompAccess, removeCompAccess,
  // Google Directory sync
  importDirectoryCandidates,
  // Appraisal engine
  createAppraisalCycle, setCycleStatus, enrollAppraisalCycle,
  submitSelfReview, submitManagerReview, acknowledgeAppraisal,
  finalizeAppraisal, shareAppraisal, applyIncrement,
  // Factory cost module (compensation-tier)
  setFactoryWorkforce, setFactoryPay, bulkUploadFactoryPay, setFactoryCostInput, setFactoryOtRates,
};

// Self-only baseline (RULE-PODIUM-006): actions reachable WITHOUT podium_view.
// getMe + getPodiumRoles are pure metadata; the rest are self-scoped by canSeeFull
// (which treats self as visible) or callerEmployee, so a no-role user can only ever
// reach their OWN profile + wins via /me. Everything else still requires podium_view.
const SELF_SERVE_GET = new Set([
  'getMe', 'getPodiumRoles',
  // Salary-access admin — internally super_admin-gated.
  'getCompAccess', 'getCompAccessLog',
  'getEmployee', 'getMyPerformance', 'getAccomplishments', 'getObservations', 'getOneOnOnes',
  // Own-salary view — parameter-less, self-scoped by callerEmployee.
  'getMyCompensation', 'getMyPayouts',
  // Appraisal participation — relationship-scoped inside each handler, not podium_view-gated.
  'getAppraisalConfig', 'getMyAppraisals', 'getAppraisal', 'getTeamAppraisals',
  // Factory cost — self-gated by requireComp (a comp-only role need not hold podium_view).
  'getFactoryWorkforce', 'getFactoryCostInputs',
  // Comp analytics — self-gated by requireComp (a comp-only user need not hold podium_view).
  'getAnalyticsComp',
]);
const SELF_SERVE_POST = new Set([
  'createAccomplishment', 'updateAccomplishment', 'deleteAccomplishment',
  // Salary-access admin — internally super_admin-gated.
  'addCompAccess', 'removeCompAccess',
  // Appraisal participation (self-review / manager-review / acknowledge).
  'submitSelfReview', 'submitManagerReview', 'acknowledgeAppraisal',
  // Factory cost — self-gated by requireComp (a comp-only role need not hold podium_view).
  'setFactoryWorkforce', 'setFactoryPay', 'bulkUploadFactoryPay', 'setFactoryCostInput', 'setFactoryOtRates',
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
