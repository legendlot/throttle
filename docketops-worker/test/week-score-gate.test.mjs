// Run: node --test docketops-worker/test/
// F9 R5 end to end against a stubbed Supabase: getWeekScore is super-admin only, hydrates team / owner
// names and refuses a bad week; every deadline write (updateTask first set, reviseDeadline, bulk) goes
// through rpc/task_set_deadline and never PATCHes tasks.deadline / revised_deadline itself, and no longer
// writes its own deadline history row (the database's trigger does, in the same transaction).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const code = readFileSync(join(SRC, 'index.js'), 'utf8').replace(/from '\.\/([^']+)'/g, (_, f) => `from '${pathToFileURL(join(SRC, f)).href}'`);
const worker = (await import('data:text/javascript,' + encodeURIComponent(code))).default;

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ME = U(1), MEE = U(2), OE = U(3), D1 = U(10), G = U(20), PRIV = U(21);
const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_ANON_KEY: 'a' };
const SPACE = { id: G, name: 'ZZ team', is_default: false, is_private: true, owner_user_id: U(9), is_founders: false, is_personal: false, archived_at: null };   // a team space (was General; retired P3c)
const PSPACE = { id: PRIV, name: 'ZZ private', is_default: false, is_private: true, owner_user_id: U(9), is_founders: false, is_personal: true };   // P3a: a plan admin opens every team space, so the space they can't open is someone's PERSONAL one
const TASK = (o) => ({ id: U(100), task_no: 'DKT-1', title: 'ZZ', status: 'in_progress', priority: 'P2', owner_employee_id: MEE,
  assignee_employee_id: null, created_by_user_id: ME, department_id: D1, deadline: null, revised_deadline: null, space_id: G,
  plan_item_id: null, parent_task_id: null, is_recurring: false, ...o });

function stub({ superAdmin = false, task = TASK({}), rpc = {} } = {}) {
  const calls = [];
  const fn = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    const p = decodeURIComponent(u.pathname + u.search);
    const q = u.searchParams;
    const method = (init.method || 'GET').toUpperCase();
    const reqBody = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, p, body: reqBody });
    const body = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/auth/v1/user') return body({ id: ME, email: 'zz.me@legendoftoys.com' });
    if (p.includes('/users_profile?')) return body([{ role: 'viewer', full_name: 'ZZ Me', active: true }]);
    if (p.includes('/docket_user_roles?')) return body(superAdmin ? [{ role_key: 'zz_super' }] : []);
    if (p.includes('/docket_roles?')) return body([{ permissions: { docket_plan_admin: true } }]);
    if (p.includes('/employees?auth_user_id=')) return body([{ id: MEE, full_name: 'ZZ Me', department_id: D1 }]);
    if (p.includes('/employees?')) return body([{ id: MEE, full_name: 'ZZ Me' }]);
    if (p.includes('/departments?')) return body([{ id: D1, name: 'ZZ team' }]);
    if (p.includes('/rpc/week_score')) return body({ week_end: '2026-11-15', opened: true, final: false,
      totals: { cohort: 1, on_time: 0, miss: 0, due: 1, pct: null },
      teams: [{ department_id: D1, cohort: 1, on_time: 0, miss: 0, due: 1, pct: null }],
      people: [{ owner_employee_id: MEE, cohort: 1, on_time: 0, miss: 0, due: 1, pct: null }],
      tasks: [{ task_id: U(100), task_no: 'DKT-1', title: 'ZZ open', space_id: G, department_id: D1, owner_employee_id: MEE, outcome: 'due' },
              { task_id: U(101), task_no: 'DKT-2', title: 'ZZ secret', space_id: PRIV, department_id: D1, owner_employee_id: OE, outcome: 'due' }] });
    if (p.includes('/rpc/task_set_deadline')) {
      if (rpc.error) return body({ message: rpc.error }, 400);
      return body(rpc.result || { first: [], revised: reqBody.p_ids });
    }
    if (p.includes('/rpc/')) return body([]);
    if (p.startsWith('/rest/v1/tasks?id=eq.') && method === 'GET') return body([task]);
    if (p.startsWith('/rest/v1/tasks?id=in.') && method === 'GET') return body([task]);
    if (p.startsWith('/rest/v1/spaces?id=eq.')) return body([SPACE]);
    if (p.startsWith('/rest/v1/spaces?id=in.')) return body([SPACE, PSPACE].filter(x => q.get('id').includes(x.id)));
    if (p.startsWith('/rest/v1/space_members?')) return body([]);
    if (method === 'PATCH' || method === 'POST') return body([{ ...task }]);
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
const deadlinePatches = (calls) => calls.filter(c => c.method === 'PATCH' && c.p.startsWith('/rest/v1/tasks')
  && c.body && ('deadline' in c.body || 'revised_deadline' in c.body));
const deadlineHistory = (calls) => calls.filter(c => c.method === 'POST' && c.p.startsWith('/rest/v1/task_history')
  && [].concat(c.body).some(r => /deadline/.test(r.event_type)));

test('getWeekScore: a non-super-admin is refused', async () => {
  const { status } = await run(stub(), { get: { action: 'getWeekScore' } });
  assert.equal(status, 403);
});

test('getWeekScore: a super admin gets names hydrated; bad week refused; last = 7 days back', async () => {
  const s = stub({ superAdmin: true });
  const { status, j } = await run(s, { get: { action: 'getWeekScore', week: 'this' } });
  assert.equal(status, 200, JSON.stringify(j));
  assert.equal(j.data.teams[0].team_name, 'ZZ team');
  assert.equal(j.data.people[0].owner_name, 'ZZ Me');
  assert.equal(j.data.tasks[0].team_name, 'ZZ team');
  assert.equal(j.data.tasks[0].owner_name, 'ZZ Me');
  // a task in a private space the super admin can't open: counted, never shown (RULE-DOCKET-003)
  assert.equal(j.data.tasks.length, 1);
  assert.equal(j.data.hidden_tasks, 1);
  assert.doesNotMatch(JSON.stringify(j.data), /ZZ secret|DKT-2/);
  assert.equal(j.data.tasks[0].space_id, undefined);
  assert.equal((await run(stub({ superAdmin: true }), { get: { action: 'getWeekScore', week: 'nope' } })).status, 400);
  assert.equal((await run(stub({ superAdmin: true }), { get: { action: 'getWeekScore', week: '2026-02-30' } })).status, 400);
  const s2 = stub({ superAdmin: true });
  await run(s2, { get: { action: 'getWeekScore', week: 'last' } });
  const sent = s2.calls.find(c => c.p.includes('/rpc/week_score')).body.p_date;
  const today = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
  assert.equal((Date.parse(today) - Date.parse(sent)) / 86400000, 7);
});

test('reviseDeadline: one RPC with the reason, no direct PATCH, no worker-written history', async () => {
  const s = stub({ task: TASK({ deadline: '2026-11-13T12:30:00.000Z' }) });
  const { status, j } = await run(s, { post: { action: 'reviseDeadline', id: U(100), new_deadline: '2026-11-20T12:30:00.000Z', reason: 'zz slip' } });
  assert.equal(status, 200, JSON.stringify(j));
  const rpc = s.calls.filter(c => c.p.includes('/rpc/task_set_deadline'));
  assert.equal(rpc.length, 1);
  assert.deepEqual(rpc[0].body, { p_actor: ME, p_ids: [U(100)], p_value: '2026-11-20T12:30:00.000Z', p_reason: 'zz slip', p_source: 'app' });
  assert.equal(deadlinePatches(s.calls).length, 0);
  assert.equal(deadlineHistory(s.calls).length, 0);
});

test('reviseDeadline: the database refusing without a reason surfaces as 400', async () => {
  const s = stub({ task: TASK({ deadline: '2026-11-13T12:30:00.000Z' }), rpc: { error: 'reason_required' } });
  const { status } = await run(s, { post: { action: 'reviseDeadline', id: U(100), new_deadline: '2026-11-20T12:30:00.000Z', reason: 'x' } });
  assert.equal(status, 400);
});

test('updateTask: a first deadline goes through the RPC (no reason); other fields still PATCH', async () => {
  const s = stub({ rpc: { result: { first: [U(100)], revised: [] } } });
  const { status, j } = await run(s, { post: { action: 'updateTask', id: U(100), title: 'ZZ new', deadline: '2026-11-14T12:30:00.000Z' } });
  assert.equal(status, 200, JSON.stringify(j));
  const rpc = s.calls.filter(c => c.p.includes('/rpc/task_set_deadline'));
  assert.equal(rpc.length, 1);
  assert.equal(rpc[0].body.p_reason, null);
  assert.equal(deadlinePatches(s.calls).length, 0);
  assert.equal(deadlineHistory(s.calls).length, 0);
  assert.ok(s.calls.some(c => c.method === 'PATCH' && c.body?.title === 'ZZ new'));
  assert.ok(j.data.updated.includes('deadline'));
});

test('updateTask: a task that already has a deadline (even only a revised one) is not re-dated', async () => {
  for (const t of [TASK({ deadline: '2026-11-13T12:30:00.000Z' }), TASK({ revised_deadline: '2026-11-13T12:30:00.000Z' })]) {
    const s = stub({ task: t });
    const { j } = await run(s, { post: { action: 'updateTask', id: U(100), deadline: '2026-11-14T12:30:00.000Z' } });
    assert.equal(j.data.unchanged, true);
    assert.equal(s.calls.filter(c => c.p.includes('/rpc/task_set_deadline')).length, 0);
  }
});

test('bulk deadline: one RPC for the batch; a revision without a reason is refused before it', async () => {
  const s = stub({ task: TASK({ deadline: '2026-11-13T12:30:00.000Z' }), rpc: { result: { first: [], revised: [U(100)] } } });
  const { status, j } = await run(s, { post: { action: 'bulkUpdateTasks', ids: [U(100)], field: 'deadline', value: '2026-11-20T12:30:00.000Z', reason: 'zz' } });
  assert.equal(status, 200, JSON.stringify(j));
  assert.equal(j.data.updated, 1);
  assert.equal(s.calls.filter(c => c.p.includes('/rpc/task_set_deadline')).length, 1);
  assert.equal(deadlinePatches(s.calls).length, 0);
  assert.equal(deadlineHistory(s.calls).length, 0);
  const s2 = stub({ task: TASK({ revised_deadline: '2026-11-13T12:30:00.000Z' }) });
  const r2 = await run(s2, { post: { action: 'bulkUpdateTasks', ids: [U(100)], field: 'deadline', value: '2026-11-20T12:30:00.000Z' } });
  assert.equal(r2.status, 400);
  assert.equal(s2.calls.filter(c => c.p.includes('/rpc/task_set_deadline')).length, 0);
});

test('a deadline that is not a date is refused before anything is written', async () => {
  for (const post of [{ action: 'updateTask', id: U(100), title: 'ZZ new', deadline: ' ' },
                      { action: 'updateTask', id: U(100), owner_employee_id: OE, deadline: 'soon' },
                      { action: 'reviseDeadline', id: U(100), new_deadline: 'nope', reason: 'x' },
                      { action: 'bulkUpdateTasks', ids: [U(100)], field: 'deadline', value: '13/11/2026' }]) {
    const s = stub({ task: post.action === 'reviseDeadline' ? TASK({ deadline: '2026-11-13T12:30:00.000Z' }) : TASK({}) });
    const { status } = await run(s, { post });
    assert.equal(status, 400, JSON.stringify(post));
    assert.equal(s.calls.filter(c => c.method === 'PATCH' || c.p.includes('/rpc/task_set_deadline')).length, 0, JSON.stringify(post));
  }
});

test('updateTask: the deadline RPC runs before the field PATCH, so its failure writes nothing', async () => {
  const s = stub({ rpc: { error: 'boom' } });
  const { status } = await run(s, { post: { action: 'updateTask', id: U(100), owner_employee_id: OE, deadline: '2026-11-14T12:30:00.000Z' } });
  assert.equal(status, 400);
  assert.equal(s.calls.filter(c => c.method === 'PATCH').length, 0);
});
