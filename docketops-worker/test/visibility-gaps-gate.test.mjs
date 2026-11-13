// Run: node --test docketops-worker/test/*.test.mjs
// The F4/F5 reviews' visibility gap (1) (backlog 2026-11-09), against a stubbed Supabase: getTask's parent crumb
// only when the caller could open the parent (General = canSeeTask on the parent; a private space is flat).
// Gap (2), programs_for_user, is the SQL test visibility-gaps.sql. Gap (3) (archived spaces by id) was reviewed
// and kept as is: a member reading their own archived space by id is not a leak, and history links need it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const code = readFileSync(join(SRC, 'index.js'), 'utf8').replace(/from '\.\/([^']+)'/g, (_, f) => `from '${pathToFileURL(join(SRC, f)).href}'`);
const worker = (await import('data:text/javascript,' + encodeURIComponent(code))).default;

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// ME (auth user) = employee MEE in D2; OE (another person, D1) owns the parents.
const ME = U(1), MEE = U(2), OE = U(3), OWNER = U(9), D1 = U(10), D2 = U(11), G = U(20), PRIV = U(21);
const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_ANON_KEY: 'a' };
const SPACES = {
  [G]: { id: G, name: 'General', is_default: true, is_private: false, owner_user_id: null, is_founders: false, archived_at: null },
  [PRIV]: { id: PRIV, name: 'ZZ private', is_default: false, is_private: true, owner_user_id: OWNER, is_founders: false, archived_at: null },
};
const T = (n, o) => ({ id: U(100 + n), task_no: `DKT-${n}`, title: `ZZ t${n}`, status: 'in_progress', priority: 'P2', owner_employee_id: OE,
  assignee_employee_id: null, created_by_user_id: OWNER, department_id: D1, deadline: null, revised_deadline: null, space_id: G,
  plan_item_id: null, parent_task_id: null, program_id: null, created_at: '2026-01-01T00:00:00Z', is_recurring: false, archived_at: null,
  handoff_to_department_id: null, handoff_to_employee_id: null, handoff_accepted_at: null, handoff_accepted_by: null, ...o });
const inIds = (v) => (v || '').replace(/^in\.\(|\)$/g, '').split(',');

function stub({ tasks = [], members = [], collab = [], perms = {} } = {}) {
  const db = tasks.map(t => ({ ...t })), calls = [];
  const fn = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    const p = decodeURIComponent(u.pathname + u.search), q = u.searchParams;
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ method, p, body: init.body ? JSON.parse(init.body) : null });
    const body = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
    const eq = (k) => (q.get(k) || '').replace(/^eq\./, '');
    if (u.pathname === '/auth/v1/user') return body({ id: ME, email: 'zz.me@legendoftoys.com' });
    if (p.startsWith('/rest/v1/users_profile?id=eq.') && method === 'GET') return body([{ role: 'viewer', full_name: 'ZZ Me', active: true }]);
    if (p.startsWith('/rest/v1/users_profile?')) return body([{ id: OWNER, full_name: 'ZZ Owner', active: true }]);
    if (p.startsWith('/rest/v1/docket_user_roles?user_id=eq.')) return body(Object.keys(perms).length ? [{ role_key: 'zz_role' }] : []);
    if (p.startsWith('/rest/v1/docket_roles?')) return body([{ role_key: 'zz_role', permissions: perms }]);
    if (p.includes('/employees?auth_user_id=eq.' + ME)) return body([{ id: MEE, full_name: 'ZZ Me', department_id: D2, status: 'active' }]);
    if (p.includes('/rpc/')) return body([]);
    if (p.startsWith('/rest/v1/spaces?is_default=eq.true')) return body([{ id: G }]);
    if (p.startsWith('/rest/v1/spaces?id=eq.') && method === 'GET') return body(SPACES[eq('id')] ? [SPACES[eq('id')]] : []);
    if (p.startsWith('/rest/v1/spaces?id=in.')) return body(inIds(q.get('id')).map(id => SPACES[id]).filter(Boolean));
    if (p.startsWith('/rest/v1/space_members?space_id=eq.')) return body(members.includes(eq('space_id')) ? [{ user_id: ME }] : []);
    if (p.startsWith('/rest/v1/space_members?user_id=eq.')) return body(members.map(space_id => ({ space_id })));
    if (p.startsWith('/rest/v1/task_collaborators?task_id=eq.')) return body(collab.includes(eq('task_id')) && eq('employee_id') === MEE ? [{ task_id: eq('task_id') }] : []);
    if (u.pathname === '/rest/v1/tasks' && method === 'GET') {
      if (q.get('id')?.startsWith('eq.')) return body(db.filter(t => t.id === eq('id') && (!q.get('space_id') || t.space_id === eq('space_id'))));
      if (q.get('id')?.startsWith('in.')) return body(db.filter(t => inIds(q.get('id')).includes(t.id)));
      return body([]);
    }
    return body([]);
  };
  return { fn, calls, db };
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
const getTask = (s, n) => run(s, { get: { action: 'getTask', id: U(100 + n) } });

// ── (1) the parent crumb ──
test('getTask (General): my sub-task under a parent I can\'t open → parent null; the sub-task itself still opens', async () => {
  const tasks = [T(1, { title: 'ZZ secret parent' }), T(2, { parent_task_id: U(101), owner_employee_id: MEE })];
  const r = await getTask(stub({ tasks }), 2);
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.data.parent, null);
  assert.ok(!JSON.stringify(r.j).includes('ZZ secret parent'));
  assert.equal(r.j.data.parent_task_id, U(101));   // the app keys sub-task behaviour on this, not on parent
});
test('getTask (General): the parent crumb shows when the caller can open the parent — dept, collaborator, view_all', async () => {
  const tasks = (o) => [T(1, { title: 'ZZ parent', ...o }), T(2, { parent_task_id: U(101), owner_employee_id: MEE })];
  for (const [label, s] of [['dept', stub({ tasks: tasks({ department_id: D2 }) })], ['collaborator', stub({ tasks: tasks(), collab: [U(101)] })],
    ['view_all', stub({ tasks: tasks(), perms: { docket_view_all: true } })]]) {
    const r = await getTask(s, 2);
    assert.equal(r.status, 200, label + ' ' + JSON.stringify(r.j));
    assert.equal(r.j.data.parent?.title, 'ZZ parent', label);
    assert.equal(r.j.data.parent?.task_no, 'DKT-1', label);
  }
  // …and the same parent, none of those relations → no title anywhere in the response
  const r = await getTask(stub({ tasks: tasks() }), 2);
  assert.equal(r.j.data.parent, null);
  assert.ok(!JSON.stringify(r.j).includes('ZZ parent'));
});
test('getTask (private, member): the space is flat — the parent crumb shows whoever owns it', async () => {
  const tasks = [T(1, { space_id: PRIV, title: 'ZZ priv parent' }), T(2, { space_id: PRIV, parent_task_id: U(101) })];
  const r = await getTask(stub({ tasks, members: [PRIV] }), 2);
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.data.parent?.title, 'ZZ priv parent');
});
