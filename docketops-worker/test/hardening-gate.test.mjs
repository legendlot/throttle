// Run: node --test docketops-worker/test/*.test.mjs
// Router + handler hardening (2026-11-14), end to end against a stubbed Supabase: uuid case can't slip a self-check
// (setParent, addTaskLink); the shared-tick guard fails closed; unassignChecklistTemplate's gate; size caps answer 400
// before any data read; a thrown identity lookup is a 401; getTask reads its space once; the dashboard gate's early
// read never reaches a refused caller; the CORS preflight is cacheable. Synthetic ids and names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const code = readFileSync(join(SRC, 'index.js'), 'utf8').replace(/from '\.\/([^']+)'/g, (_, f) => `from '${pathToFileURL(join(SRC, f)).href}'`);
const worker = (await import('data:text/javascript,' + encodeURIComponent(code))).default;

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ME = U(1), MEE = U(2), OTHER = U(8), OE = U(3), D2 = U(11), G = U(20), TPL = U(40), ITEM = U(41), SEC = U(42);
const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_ANON_KEY: 'a' };
const SPACES = { [G]: { id: G, name: 'ZZ team', is_default: false, is_private: true, owner_user_id: ME, is_founders: false, is_personal: false, archived_at: null } };
const T = (n, o) => ({ id: U(100 + n), task_no: `DKT-${n}`, title: `ZZ t${n}`, status: 'in_progress', priority: 'P2', owner_employee_id: MEE,
  assignee_employee_id: null, created_by_user_id: ME, department_id: D2, deadline: null, revised_deadline: null, space_id: G,
  plan_item_id: null, parent_task_id: null, program_id: null, created_at: '2026-01-01T00:00:00Z', is_recurring: false, archived_at: null,
  handoff_to_department_id: null, handoff_to_employee_id: null, handoff_accepted_at: null, handoff_accepted_by: null, ...o });
const HEX = '0000abcd-ef00-4000-8000-00000000beef';   // a task id with letters, so case can actually change it
const AUTH_PATHS = /^\/(auth\/v1\/user|rest\/v1\/(users_profile\?id=eq|docket_user_roles|docket_roles|employees\?auth_user_id|user_activity))/;

// `fail`: a path prefix → answer 500; `boom`: a path prefix → the fetch itself throws.
function stub({ tasks = [], perms = {}, tmpl = {}, assignments = [], fail = [], boom = [] } = {}) {
  const calls = [];
  const fn = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    const p = decodeURIComponent(u.pathname + u.search), q = u.searchParams;
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ method, p, body: init.body ? JSON.parse(init.body) : null });
    if (boom.some(b => p.startsWith(b))) throw new TypeError('fetch failed');
    const body = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
    if (fail.some(f => p.startsWith(f))) return body({ message: 'zz down' }, 500);
    const eq = (k) => (q.get(k) || '').replace(/^eq\./, '');
    if (u.pathname === '/auth/v1/user') return body({ id: ME, email: 'zz.me@legendoftoys.com' });
    if (p.startsWith('/rest/v1/users_profile?id=eq.')) return body([{ role: 'viewer', full_name: 'ZZ Me', active: true }]);
    if (p.startsWith('/rest/v1/docket_user_roles?')) return body(Object.keys(perms).length ? [{ role_key: 'zz' }] : []);
    if (p.startsWith('/rest/v1/docket_roles?')) return body([{ permissions: perms }]);
    if (p.startsWith('/rest/v1/employees?auth_user_id=eq.')) return body([{ id: MEE, full_name: 'ZZ Me', department_id: D2, status: 'active' }]);
    if (p.startsWith('/rest/v1/spaces?id=eq.')) return body(SPACES[eq('id')] ? [SPACES[eq('id')]] : []);
    if (p.startsWith('/rest/v1/checklist_template_items?')) return body([{ section_id: SEC }]);
    if (p.startsWith('/rest/v1/checklist_template_sections?')) return body([{ template_id: TPL }]);
    if (p.startsWith('/rest/v1/checklist_templates?')) return body([{ id: TPL, kind: 'routine', run_scope: 'shared', is_active: true, archived_at: null,
      recurrence: { freq: 'daily' }, created_by_user_id: OTHER, ...tmpl }]);
    if (p.startsWith('/rest/v1/checklist_assignments?') && method === 'GET') return body(assignments);
    if (p.startsWith('/rest/v1/checklist_item_completions?') && method === 'GET') return body([{ completed_by_user_id: OTHER }]);
    if (u.pathname === '/rest/v1/tasks' && method === 'GET') {
      if (q.get('id')?.startsWith('eq.')) return body(tasks.filter(t => t.id === eq('id').toLowerCase()));
      return body([]);
    }
    if (p.startsWith('/rest/v1/rpc/dashboard_stats')) return body({});
    return body([]);
  };
  return { fn, calls };
}
async function run(s, { get, post, raw }) {
  const real = globalThis.fetch;
  globalThis.fetch = s.fn;
  try {
    const req = get
      ? new Request('https://docketops.test/?' + new URLSearchParams(get), { headers: { Authorization: 'Bearer zz' } })
      : new Request('https://docketops.test/', { method: 'POST', headers: { Authorization: 'Bearer zz', 'content-type': 'application/json' }, body: raw ?? JSON.stringify(post) });
    const res = await worker.fetch(req, ENV);
    return { status: res.status, j: await res.json() };
  } finally { globalThis.fetch = real; }
}
const writes = (s) => s.calls.filter(c => c.method !== 'GET' && !c.p.startsWith('/rest/v1/user_activity'));
const dataReads = (s) => s.calls.filter(c => !AUTH_PATHS.test(c.p));

// ── A1: uuid case ──
test('setParent: the task\'s own id in CAPITALS (or mixed case) is still "its own parent" → 422, no write', async () => {
  const t = T(1, { id: HEX });
  for (const id of [t.id.toUpperCase(), t.id.split('').map((c, i) => (i % 2 ? c.toUpperCase() : c)).join('')]) {
    const s = stub({ tasks: [t] });
    const r = await run(s, { post: { action: 'setParent', id: t.id, parent_task_id: id } });
    assert.equal(r.status, 422, JSON.stringify(r.j));
    assert.equal(r.j.error, 'a task cannot be its own parent');
    assert.deepEqual(writes(s), []);
  }
  const s = stub({ tasks: [t] });
  const r = await run(s, { post: { action: 'setParent', id: t.id, parent_task_id: 'not-a-uuid' } });
  assert.equal(r.status, 404); assert.equal(r.j.error, 'parent_not_found');   // as before: a non-uuid finds no parent
  assert.deepEqual(writes(s), []);
});
test('addTaskLink: other_id = id in CAPITALS → self_link 422, no RPC', async () => {
  const t = T(1, { id: HEX });
  const s = stub({ tasks: [t] });
  const r = await run(s, { post: { action: 'addTaskLink', id: t.id, other_id: t.id.toUpperCase(), kind: 'relates' } });
  assert.equal(r.status, 422); assert.equal(r.j.error, 'self_link');
  assert.ok(!s.calls.some(c => c.p.includes('/rpc/add_task_link')));
});
test('router: an over-deep body → 400 invalid_request with no data read', async () => {
  let deep = {}; const root = deep;
  for (let i = 0; i < 200; i++) { deep.x = {}; deep = deep.x; }
  const s = stub();
  const r = await run(s, { post: { action: 'updateTask', id: U(101), custom_fields: root } });
  assert.equal(r.status, 400); assert.equal(r.j.error, 'invalid_request');
  assert.deepEqual(dataReads(s), []);
});

// ── A2: the shared-tick guard ──
test('toggleChecklistItem (shared, untick): a failed read of who ticked → 500 db_error and NO delete', async () => {
  const s = stub({ assignments: [{ id: U(50) }], fail: ['/rest/v1/checklist_item_completions?'] });
  const r = await run(s, { post: { action: 'toggleChecklistItem', template_item_id: ITEM, completed: false } });
  assert.equal(r.status, 500); assert.equal(r.j.error, 'db_error');
  assert.ok(!s.calls.some(c => c.method === 'DELETE'));
  // …and with the read working, someone else's tick is still not_your_tick (unchanged)
  const s2 = stub({ assignments: [{ id: U(50) }] });
  const r2 = await run(s2, { post: { action: 'toggleChecklistItem', template_item_id: ITEM, completed: false } });
  assert.equal(r2.status, 403); assert.equal(r2.j.error, 'not_your_tick');
  assert.ok(!s2.calls.some(c => c.method === 'DELETE'));
});

// ── A3: unassign ──
const unassign = (employee_id = OE) => ({ post: { action: 'unassignChecklistTemplate', template_id: TPL, employee_id } });
const patched = (s) => s.calls.some(c => c.method === 'PATCH' && c.p.startsWith('/rest/v1/checklist_assignments?'));
test('unassignChecklistTemplate: a bystander → 403 and no write; self / assigner / template editor / admin → done', async () => {
  let s = stub({ assignments: [{ assigned_by_user_id: OTHER }] });
  let r = await run(s, unassign());
  assert.equal(r.status, 403); assert.equal(r.j.error, 'forbidden'); assert.equal(patched(s), false);
  for (const [label, opts, who] of [
    ['self', {}, MEE.toUpperCase()],
    ['assigner', { assignments: [{ assigned_by_user_id: ME }] }, OE],
    ['editor', { tmpl: { created_by_user_id: ME }, assignments: [] }, OE],
    ['admin', { perms: { docket_admin: true } }, OE],
  ]) {
    s = stub(opts);
    r = await run(s, unassign(who));
    assert.equal(r.status, 200, label + ' ' + JSON.stringify(r.j));
    assert.equal(r.j.data.unassigned, true, label);
    assert.equal(patched(s), true, label);
  }
});
test('unassignChecklistTemplate: a failed template / assignment read refuses (500, no write); a non-uuid proves nothing (403)', async () => {
  for (const f of ['/rest/v1/checklist_templates?', '/rest/v1/checklist_assignments?']) {
    const s = stub({ assignments: [{ assigned_by_user_id: ME }], tmpl: { created_by_user_id: ME }, fail: [f] });
    const r = await run(s, unassign());
    assert.equal(r.status, 500, f); assert.equal(r.j.error, 'db_error'); assert.equal(patched(s), false, f);
  }
  const s = stub();
  const r = await run(s, { post: { action: 'unassignChecklistTemplate', template_id: 'zz', employee_id: OE } });
  assert.equal(r.status, 403); assert.equal(patched(s), false);
});

// ── A4: size caps, before any data read ──
test('size caps: each over-limit write → 400 with its error and no data read', async () => {
  const long = (n) => 'a'.repeat(n + 1);
  const ids = (n) => Array.from({ length: n }, (_, i) => U(1000 + i));
  for (const [post, error] of [
    [{ action: 'createTask', title: long(500) }, 'title_too_long'],
    [{ action: 'createTask', title: 'ok', description: long(100000) }, 'description_too_long'],
    [{ action: 'createTask', title: 'ok', custom_fields: [] }, 'custom_fields_not_object'],
    [{ action: 'createTask', title: 'ok', custom_fields: { k: long(32768) } }, 'custom_fields_too_large'],
    [{ action: 'createTask', title: 'ok', documents: Array.from({ length: 101 }, () => ({ url: 'https://x' })) }, 'too_many_documents'],
    [{ action: 'createTask', title: 'ok', collaborators: ids(201) }, 'too_many_collaborators'],
    [{ action: 'createSubtask', title: long(500), parent_task_id: U(101) }, 'title_too_long'],
    [{ action: 'updateTask', id: U(101), title: long(500) }, 'title_too_long'],
    [{ action: 'addComment', id: U(101), body: long(50000) }, 'comment_too_long'],
    [{ action: 'editComment', comment_id: U(60), body: long(50000) }, 'comment_too_long'],
    [{ action: 'addDocument', id: U(101), url: 'https://' + long(4000) }, 'document_url_too_long'],
    [{ action: 'addDocument', id: U(101), url: 'https://x', title: long(500) }, 'document_title_too_long'],
    [{ action: 'bulkUpdateTasks', ids: ids(1001), field: 'priority', value: 'P1' }, 'too_many_ids'],
    [{ action: 'bulkSetCollaborator', ids: ids(1001), employee_id: OE }, 'too_many_ids'],
    [{ action: 'bulkMoveTasks', ids: ids(1001), space_id: G }, 'too_many_ids'],
    [{ action: 'bulkAbandonTasks', ids: ids(1001), reason: 'zz' }, 'too_many_ids'],
    [{ action: 'createScratchNote', body: long(500000) }, 'body_too_long'],
    [{ action: 'updateScratchNote', id: U(70), body: long(500000) }, 'body_too_long'],
  ]) {
    const s = stub({ tasks: [T(1)] });
    const r = await run(s, { post });
    assert.equal(r.status, 400, post.action + ' ' + JSON.stringify(r.j));
    assert.equal(r.j.error, error, post.action);
    assert.deepEqual(dataReads(s), [], post.action);
  }
  // at the limit, a task title is accepted (the create goes on to its reads)
  const s = stub({ tasks: [T(1)] });
  const r = await run(s, { post: { action: 'updateTask', id: U(101), title: 'a'.repeat(500) } });
  assert.notEqual(r.j.error, 'title_too_long');
  assert.ok(dataReads(s).length > 0);
});

// ── S2: auth ──
test('auth: a thrown identity lookup (any of the wave, or the role read) → 401, never a 500 / unhandled', async () => {
  for (const b of ['/rest/v1/users_profile?id=eq.', '/rest/v1/docket_user_roles?', '/rest/v1/employees?auth_user_id=eq.', '/rest/v1/docket_roles?', '/auth/v1/user']) {
    const s = stub({ perms: { docket_view_all: true }, boom: [b] });
    const r = await run(s, { get: { action: 'getSpaces' } });
    assert.equal(r.status, 401, b); assert.equal(r.j.error, 'unauthorized', b);
  }
  // a !ok employee read is still "no employee" (as before), not a refusal
  const s = stub({ fail: ['/rest/v1/employees?auth_user_id=eq.'] });
  const r = await run(s, { get: { action: 'getMe' } });
  assert.equal(r.status, 200); assert.equal(r.j.data.employee_id, null);
});

test('auth: a FAILED profile read is never "no profile" — 401 and no users_profile write (no demote / re-activate)', async () => {
  const s = stub({ fail: ['/rest/v1/users_profile?id=eq.'] });
  const r = await run(s, { get: { action: 'getMe' } });
  assert.equal(r.status, 401);
  assert.equal(s.calls.filter(c => c.method !== 'GET' && c.p.startsWith('/rest/v1/users_profile')).length, 0);
});
test('auth: self-provision never overwrites an existing row (ignore-duplicates, not merge)', () => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const fnSrc = src.slice(src.indexOf('async function verifyJWT'), src.indexOf('async function authWave'));
  assert.match(fnSrc, /resolution=ignore-duplicates/);
  assert.doesNotMatch(fnSrc, /merge-duplicates'/);
});

// ── S3: getTask reads its space once ──
test('getTask: the space is read once (loadTaskFor\'s gate), and the page still opens (an UPPERCASE id is canonicalised)', async () => {
  const s = stub({ tasks: [T(1, { id: HEX })] });
  const r = await run(s, { get: { action: 'getTask', id: HEX.toUpperCase() } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.data.space.id, G);
  assert.equal(s.calls.filter(c => c.p.startsWith('/rest/v1/spaces?id=eq.')).length, 1);
});

// ── S9: the dashboard gate ──
test('getDashboard (org): a refused caller gets 403 even when the early spaces read fails or throws', async () => {
  for (const opt of [{ fail: ['/rest/v1/spaces?is_private'] }, { boom: ['/rest/v1/spaces?is_private'] }, {}]) {
    const s = stub(opt);
    const r = await run(s, { get: { action: 'getDashboard' } });
    assert.equal(r.status, 403, JSON.stringify(opt)); assert.equal(r.j.error, 'forbidden_dashboard');
    assert.ok(!s.calls.some(c => c.p.includes('/rpc/dashboard_stats')));
  }
  // a failed grant read is "no grant" (fail closed), the same 403
  const s = stub({ fail: ['/rest/v1/dashboard_viewers?', '/rest/v1/settings?key=eq.dashboard_public'] });
  const r = await run(s, { get: { action: 'getDashboard' } });
  assert.equal(r.status, 403);
});

// ── S1 ──
test('CORS preflight carries Access-Control-Max-Age', async () => {
  const res = await worker.fetch(new Request('https://docketops.test/', { method: 'OPTIONS' }), ENV);
  assert.equal(res.headers.get('Access-Control-Max-Age'), '3600');
});
