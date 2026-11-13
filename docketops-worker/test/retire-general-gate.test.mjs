// Run: node --test docketops-worker/test/*.test.mjs
// P3c (migration 0039) — General retired, against a stubbed Supabase: the org dashboard (no space_id) is gated as
// General's was (RULE-DOCKET-006) and spans only live TEAM spaces (never personal / Founders' / archived / General);
// a General id is a 404 there; getTasks with no space opens the caller's default (team home space, else Personal);
// getMe names that default; nothing can be put into General or an archived space (canWriteSpace); an archived General
// opens nothing; recoverSpace never brings General back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const code = readFileSync(join(SRC, 'index.js'), 'utf8').replace(/from '\.\/([^']+)'/g, (_, f) => `from '${pathToFileURL(join(SRC, f)).href}'`);
const worker = (await import('data:text/javascript,' + encodeURIComponent(code))).default;

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// ME (auth user) = employee MEE in D2. OWNER owns the team spaces.
const ME = U(1), MEE = U(2), OWNER = U(9), D1 = U(10), D2 = U(11), TPL = U(30);
const G = U(20), TEAM1 = U(21), TEAM2 = U(22), FND = U(23), PERS = U(24), PERS9 = U(25), ARCHT = U(26);
const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_ANON_KEY: 'a' };
const SP = (id, o) => ({ id, name: 'ZZ ' + id.slice(-2), is_default: false, is_private: true, owner_user_id: OWNER, is_founders: false,
  is_personal: false, archived_at: null, home_department_id: null, ...o });
const LIVE_G = SP(G, { name: 'General', is_default: true, is_private: false, owner_user_id: null });
const ARCH_G = { ...LIVE_G, archived_at: '2026-11-13T00:00:00Z' };
const BASE = [SP(TEAM1, { home_department_id: D2 }), SP(TEAM2, { home_department_id: D1 }), SP(FND, { is_founders: true }),
  SP(PERS, { name: 'Personal', owner_user_id: ME, is_personal: true }), SP(PERS9, { name: 'Personal', is_personal: true }),
  SP(ARCHT, { archived_at: '2026-11-01T00:00:00Z' })];
const inIds = (v) => (v || '').replace(/^in\.\(|\)$/g, '').split(',');

// A PostgREST filter, honestly applied to the spaces fixture: eq / is / in on any column, plus accessibleSpaces' or=().
function filterRows(rows, q) {
  const one = (r, k, v) => {
    if (v.startsWith('eq.')) { const x = v.slice(3); return String(r[k]) === x; }
    if (v === 'is.null') return r[k] == null;
    if (v === 'is.false') return r[k] === false;
    if (v === 'is.true') return r[k] === true;
    if (v.startsWith('in.')) return inIds(v).includes(r[k]);
    return true;
  };
  return rows.filter(r => {
    for (const [k, v] of q.entries()) {
      if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
      if (k === 'or') {
        const parts = v.replace(/^\(|\)$/g, '').match(/[a-z_]+\.(?:in\.\([^)]*\)|[a-z]+\.[^,]+)/g) || [];
        if (!parts.some(p => { const i = p.indexOf('.'); return one(r, p.slice(0, i), p.slice(i + 1)); })) return false;
        continue;
      }
      if (!one(r, k, v)) return false;
    }
    return true;
  });
}

function stub({ perms = {}, members = [], general = ARCH_G, dashboardPublic = false, viewer = false, tasks = [], extra = [] } = {}) {
  const spaces = [general, ...BASE, ...extra];
  const calls = [];
  const fn = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    const p = decodeURIComponent(u.pathname + u.search), q = u.searchParams;
    const method = (init.method || 'GET').toUpperCase();
    const reqBody = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, p, body: reqBody });
    const body = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
    const eq = (k) => (q.get(k) || '').replace(/^eq\./, '');
    if (u.pathname === '/auth/v1/user') return body({ id: ME, email: 'zz.me@legendoftoys.com' });
    if (p.startsWith('/rest/v1/users_profile?id=eq.') && method === 'GET') return body([{ role: 'viewer', full_name: 'ZZ Me', active: true }]);
    if (p.startsWith('/rest/v1/users_profile?')) return body([]);
    if (p.startsWith('/rest/v1/docket_user_roles?user_id=eq.')) return body(Object.keys(perms).length ? [{ role_key: 'zz_role' }] : []);
    if (p.startsWith('/rest/v1/docket_roles?')) return body([{ role_key: 'zz_role', permissions: perms }]);
    if (p.includes('/employees?auth_user_id=eq.' + ME)) return body([{ id: MEE, full_name: 'ZZ Me', department_id: D2, status: 'active' }]);
    if (p.includes('/employees?auth_user_id=eq.')) return body([{ status: 'active' }]);   // every space owner is still here
    if (p.includes('/rpc/ensure_personal_space')) return body(PERS);
    if (p.includes('/rpc/next_task_seq')) return body('DKT-900');
    if (p.includes('/rpc/dashboard_stats')) return body({ by_status: { not_started: 1 }, by_person: [], by_department: [{ dept_id: D1, dept_name: 'ZZ D1' }, { dept_id: U(99), dept_name: 'ZZ none' }] });
    if (p.includes('/rpc/')) return body([]);
    if (u.pathname === '/rest/v1/settings') return body(dashboardPublic ? [{ value: true }] : []);
    if (u.pathname === '/rest/v1/dashboard_viewers') return body(viewer ? [{ user_id: ME }] : []);
    if (u.pathname === '/rest/v1/spaces' && method === 'GET') return body(filterRows(spaces, q));
    if (u.pathname === '/rest/v1/spaces') return body([]);
    if (p.startsWith('/rest/v1/space_members?space_id=eq.')) return body(members.includes(eq('space_id')) ? [{ user_id: ME }] : []);
    if (p.startsWith('/rest/v1/space_members?space_id=in.')) return body(members.filter(m => inIds(q.get('space_id')).includes(m)).map(space_id => ({ space_id })));
    if (p.startsWith('/rest/v1/space_members?user_id=eq.')) return body(members.map(space_id => ({ space_id })));
    if (u.pathname === '/rest/v1/checklist_templates') return body([{ id: TPL, name: 'ZZ Launch', kind: 'record', version: 1, is_active: true, archived_at: null }]);
    if (u.pathname === '/rest/v1/tasks' && method === 'GET') return body(tasks.filter(t => !q.get('id') || inIds(q.get('id').replace(/^eq\./, 'in.(') + (q.get('id').startsWith('eq.') ? ')' : '')).includes(t.id)));
    return body([]);
  };
  return { fn, calls };
}
async function run(s, { get, post }) {
  const real = globalThis.fetch;
  globalThis.fetch = s.fn;
  try {
    const req = get
      ? new Request('https://docketops.test/?' + new URLSearchParams(get), { headers: { Authorization: 'Bearer zz' } })
      : new Request('https://docketops.test/', { method: 'POST', headers: { Authorization: 'Bearer zz', 'content-type': 'application/json' }, body: JSON.stringify(post) });
    const res = await worker.fetch(req, ENV);
    return { status: res.status, j: await res.json() };
  } finally { globalThis.fetch = real; }
}
const rpc = (s, name) => s.calls.filter(c => c.p === '/rest/v1/rpc/' + name);
const writes = (s) => s.calls.filter(c => c.method !== 'GET' && !c.p.includes('/rpc/') && !c.p.startsWith('/rest/v1/user_activity'));

// ── the org dashboard ──
test('org dashboard (no space_id): gated as General was — view_all, dashboard_public or a grant; nobody else', async () => {
  let s = stub();
  let r = await run(s, { get: { action: 'getDashboard' } });
  assert.equal(r.status, 403); assert.equal(r.j.error, 'forbidden_dashboard');
  assert.equal(rpc(s, 'dashboard_stats_spaces').length, 0);
  for (const o of [{ perms: { docket_view_all: true } }, { dashboardPublic: true }, { viewer: true }]) {
    s = stub(o);
    r = await run(s, { get: { action: 'getDashboard' } });
    assert.equal(r.status, 200, JSON.stringify([o, r.j]));
    assert.equal(rpc(s, 'dashboard_stats_spaces').length, 1, JSON.stringify(o));
    assert.equal(rpc(s, 'dashboard_stats').length, 0, JSON.stringify(o));
  }
});
test('org dashboard: only live team spaces are passed — never General, a personal, the Founders\' or an archived space', async () => {
  for (const general of [ARCH_G, LIVE_G]) {   // before and after 0039 archives General
    const s = stub({ perms: { docket_view_all: true }, general });
    const r = await run(s, { get: { action: 'getDashboard' } });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    assert.deepEqual(rpc(s, 'dashboard_stats_spaces')[0].body.p_space_ids.sort(), [TEAM1, TEAM2].sort());
  }
});
test('org dashboard: a grantee / dashboard_public sees only team HOME spaces (no ad-hoc private space); view_all sees all', async () => {
  const ADHOC = U(27);
  for (const o of [{ dashboardPublic: true }, { viewer: true }]) {
    const s = stub({ ...o, extra: [SP(ADHOC)] });
    const r = await run(s, { get: { action: 'getDashboard' } });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    assert.deepEqual(rpc(s, 'dashboard_stats_spaces')[0].body.p_space_ids.sort(), [TEAM1, TEAM2].sort(), JSON.stringify(o));
  }
  const s = stub({ perms: { docket_view_all: true }, extra: [SP(ADHOC)] });
  const r = await run(s, { get: { action: 'getDashboard' } });
  assert.deepEqual(rpc(s, 'dashboard_stats_spaces')[0].body.p_space_ids.sort(), [TEAM1, TEAM2, ADHOC].sort());
  // each team row names its home space for the drill-through; a team with no home space gets null
  assert.deepEqual(r.j.data.by_department.map(d => d.home_space_id), [TEAM2, null]);
});
test('dashboard with a General id → 404 space_not_found (live or archived); a team space keeps its per-space dashboard', async () => {
  for (const general of [ARCH_G, LIVE_G]) {
    const s = stub({ perms: { docket_view_all: true }, general });
    const r = await run(s, { get: { action: 'getDashboard', space_id: G } });
    assert.equal(r.status, 404, JSON.stringify(r.j)); assert.equal(r.j.error, 'space_not_found');
    assert.equal(rpc(s, 'dashboard_stats').length + rpc(s, 'dashboard_stats_spaces').length, 0);
  }
  let s = stub({ members: [TEAM1] });
  let r = await run(s, { get: { action: 'getDashboard', space_id: TEAM1 } });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(rpc(s, 'dashboard_stats')[0].body.p_space_id, TEAM1);
  s = stub();
  r = await run(s, { get: { action: 'getDashboard', space_id: TEAM1 } });
  assert.equal(r.status, 403); assert.equal(r.j.error, 'forbidden_space');
});

// ── defaults ──
test('getTasks with no space → the caller\'s team home space (a member), else their Personal space', async () => {
  let s = stub({ members: [TEAM1] });
  let r = await run(s, { get: { action: 'getTasks' } });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.ok(Array.isArray(r.j.data));
  assert.equal(rpc(s, 'list_tasks')[0].body.p_space_id, TEAM1);
  s = stub();   // D2's home space exists but ME can't put work there → Personal
  r = await run(s, { get: { action: 'getTasks' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(rpc(s, 'list_tasks')[0].body.p_space_id, PERS);
  assert.ok(!s.calls.some(c => c.p.startsWith('/rest/v1/spaces?is_default=eq.true')), 'never looks General up');
});
test('getMe: default_space_id = team home space, else Personal — no ensure_personal_space call when it is listed', async () => {
  let s = stub({ members: [TEAM1] });
  let r = await run(s, { get: { action: 'getMe' } });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(r.j.data.default_space_id, TEAM1);
  s = stub();
  r = await run(s, { get: { action: 'getMe' } });
  assert.equal(r.j.data.default_space_id, PERS);
  assert.equal(s.calls.filter(c => c.p.includes('ensure_personal_space')).length, 0);
  assert.ok(!r.j.data.spaces.some(x => x.id === G), 'an archived General is not in the sidebar');
  // getMe re-runs after every write: no General lookup on that path (it always came back empty after 0039)
  assert.ok(!s.calls.some(c => /\/rest\/v1\/spaces\?[^ ]*is_default=eq\.true/.test(c.p)), 'getMe never looks General up');
  assert.equal(rpc(s, 'programs_for_user')[0].body.p_default_space_id, null);
  // a view_all holder SEES every team space, but their default is still one they can write to
  s = stub({ perms: { docket_view_all: true } });
  r = await run(s, { get: { action: 'getMe' } });
  assert.equal(r.j.data.default_space_id, PERS);
});

// ── writes ──
test('canWriteSpace: nothing goes into General (live or archived) or an archived space — create, move, record', async () => {
  for (const general of [ARCH_G, LIVE_G]) {
    const s = stub({ general, perms: { docket_admin: true } });
    const r = await run(s, { post: { action: 'createTask', data: { title: 'ZZ g', space_id: G } } });
    assert.equal(r.status, 403, JSON.stringify(r.j)); assert.equal(r.j.error, 'forbidden_space');
    assert.equal(writes(s).length, 0);
  }
  // an archived team space I belong to: no create (it says space_archived, as a record does), no move in
  let s = stub({ members: [ARCHT] });
  let r = await run(s, { post: { action: 'createTask', data: { title: 'ZZ a', space_id: ARCHT } } });
  assert.equal(r.status, 422, JSON.stringify(r.j)); assert.equal(r.j.error, 'space_archived');
  assert.equal(writes(s).length, 0);
  s = stub();   // one I can't read: no hint that it is archived
  r = await run(s, { post: { action: 'createTask', data: { title: 'ZZ a', space_id: ARCHT } } });
  assert.equal(r.status, 403, JSON.stringify(r.j)); assert.equal(r.j.error, 'forbidden_space');
  const mine = { id: U(101), task_no: 'DKT-1', title: 'ZZ t', status: 'in_progress', space_id: PERS, owner_employee_id: MEE, created_by_user_id: ME,
    department_id: D2, parent_task_id: null, is_recurring: false, archived_at: null };
  for (const target of [ARCHT, G]) {
    s = stub({ members: [ARCHT], tasks: [mine] });
    r = await run(s, { post: { action: 'moveTask', id: U(101), space_id: target } });
    assert.equal(r.status, 403, target + JSON.stringify(r.j)); assert.equal(r.j.error, 'forbidden_space');
    assert.equal(writes(s).length, 0);
  }
  // a record: an archived space I belong to keeps its own code; General is just forbidden
  s = stub({ members: [ARCHT] });
  r = await run(s, { post: { action: 'createChecklistRecord', data: { template_id: TPL, title: 'ZZ r', space_id: ARCHT } } });
  assert.equal(r.status, 422, JSON.stringify(r.j)); assert.equal(r.j.error, 'space_archived');
  s = stub();
  r = await run(s, { post: { action: 'createChecklistRecord', data: { template_id: TPL, title: 'ZZ r', space_id: G } } });
  assert.equal(r.status, 403, JSON.stringify(r.j)); assert.equal(r.j.error, 'forbidden_space');
  s = stub();   // an archived space I can't read: no hint that it is archived
  r = await run(s, { post: { action: 'createChecklistRecord', data: { template_id: TPL, title: 'ZZ r', space_id: ARCHT } } });
  assert.equal(r.status, 403, JSON.stringify(r.j)); assert.equal(r.j.error, 'forbidden_space');
});
test('General opens nothing by id — archived, or even un-archived by hand (its live-General read path is gone, P3c cleanup)', async () => {
  for (const general of [ARCH_G, LIVE_G]) {
    const s = stub({ general });
    const r = await run(s, { get: { action: 'getTasks', space_id: G } });
    assert.equal(r.status, 403, JSON.stringify(r.j)); assert.equal(r.j.error, 'forbidden_space');
  }
});
test('recoverSpace never brings General back (general_is_system); other archived spaces keep their rules', async () => {
  for (const general of [ARCH_G, LIVE_G]) {
    const s = stub({ general, perms: { docket_admin: true } });
    const r = await run(s, { post: { action: 'recoverSpace', space_id: G } });
    assert.equal(r.status, 422, JSON.stringify(r.j)); assert.equal(r.j.error, 'general_is_system');
    assert.ok(!s.calls.some(c => c.method === 'PATCH' && c.p.startsWith('/rest/v1/spaces')));
  }
  const s = stub({ perms: { docket_admin: true } });   // an archived team space whose owner is here → the un-archive path
  const r = await run(s, { post: { action: 'recoverSpace', space_id: ARCHT } });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(r.j.data.unarchived, true);
});
