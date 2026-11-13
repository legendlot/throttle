// Run: node --test docketops-worker/test/*.test.mjs
// F9 R8 hand-offs (spec §4.6, §8.1 #5, §8.6) end to end against a stubbed Supabase: create / update set,
// change and clear a hand-off and refuse the bad ones (bad_handoff, handoff_receiver_team, handoff_same_team,
// handoff_top_level) — never taking an acceptance from a body; acceptHandoff (not_a_handoff 400, not_receiver
// 403, handoff_closed 409, the already-accepted no-op, the department member becoming the named receiver, a
// private-space hand-off 404 to a non-member); the receiver clause (General only) on getTask; getIncoming's
// scopes, counts and order; the review pack's per-team hand-offs (unowned / overdue, out / in, a private one
// counted for a plan admin, a Founders'-space one never in the Slack copy); the founders' page hand-offs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const code = readFileSync(join(SRC, 'index.js'), 'utf8').replace(/from '\.\/([^']+)'/g, (_, f) => `from '${pathToFileURL(join(SRC, f)).href}'`);
const worker = (await import('data:text/javascript,' + encodeURIComponent(code))).default;

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// ME (auth user) = employee MEE; OE gives (D1), RE is in D2, NOD has no department.
const ME = U(1), MEE = U(2), OE = U(3), RE = U(4), NOD = U(6), D1 = U(10), D2 = U(11), D3 = U(12), G = U(20), PRIV = U(21), FND = U(22);
const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_ANON_KEY: 'a' };
const addD = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const TODAY = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
const WE = addD(TODAY, (7 - (new Date(`${TODAY}T00:00:00Z`).getUTCDay() || 7)) % 7), WS = addD(WE, -6);
const at = (d) => new Date(Date.parse(`${d}T12:00:00+05:30`)).toISOString();
const SPACES = {
  [G]: { id: G, name: 'General', is_default: true, is_private: false, owner_user_id: null, is_founders: false },
  [PRIV]: { id: PRIV, name: 'ZZ private', is_default: false, is_private: true, owner_user_id: U(9), is_founders: false },
  [FND]: { id: FND, name: 'Founders', is_default: false, is_private: true, owner_user_id: U(9), is_founders: true },
  [U(24)]: { id: U(24), name: 'ZZ archived', is_default: false, is_private: false, owner_user_id: ME, is_founders: false, archived_at: '2026-11-01T00:00:00Z' },
};
const ARCH = U(24);
const MYSP = U(25);   // a personal space: private, owned by ME
SPACES[MYSP] = { id: MYSP, name: 'ZZ mine', is_default: false, is_private: true, owner_user_id: ME, is_founders: false };
const DEPTS = [{ id: D1, name: 'ZZ team 1' }, { id: D2, name: 'ZZ team 2' }, { id: D3, name: 'ZZ team 3' }];
// podium.employees.status is 'active' | 'exited' (live, 2026-11-12).
const EX = U(5);
const EMPS = [{ id: MEE, full_name: 'ZZ Me', department_id: D2, auth_user_id: ME, status: 'active' }, { id: OE, full_name: 'ZZ Giver', department_id: D1, auth_user_id: U(8), status: 'active' },
  { id: RE, full_name: 'ZZ Recv', department_id: D2, auth_user_id: U(7), status: 'active' }, { id: NOD, full_name: 'ZZ Nobody', department_id: null, auth_user_id: null, status: 'active' },
  { id: EX, full_name: 'ZZ Left', department_id: D2, auth_user_id: null, status: 'exited' }];
const T = (n, o) => ({ id: U(100 + n), task_no: `DKT-${n}`, title: `ZZ t${n}`, status: 'in_progress', priority: 'P2', owner_employee_id: OE,
  assignee_employee_id: null, created_by_user_id: U(8), department_id: D1, deadline: at(addD(WE, 3)), revised_deadline: null, space_id: G,
  plan_item_id: null, parent_task_id: null, created_at: '2026-01-01T00:00:00Z', is_recurring: false, archived_at: null,
  handoff_to_department_id: null, handoff_to_employee_id: null, handoff_accepted_at: null, handoff_accepted_by: null, ...o });
const inIds = (v) => (v || '').replace(/^in\.\(|\)$/g, '').split(',');
const OPEN = ['not_started', 'in_progress', 'blocked'];

function stub({ tasks = [], superAdmin = false, dept = D2, members = [], archivedSpaces = [], scoreRows = [], others = {} } = {}) {
  const db = tasks.map(t => ({ ...t }));
  const calls = [], history = [], posted = [], patches = [];
  const fn = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    const p = decodeURIComponent(u.pathname + u.search);
    const q = u.searchParams;
    const method = (init.method || 'GET').toUpperCase();
    const reqBody = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, p, body: reqBody });
    const body = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
    const eq = (k) => (q.get(k) || '').replace(/^eq\./, '');
    if (u.pathname === '/auth/v1/user') return body({ id: ME, email: 'zz.me@legendoftoys.com' });
    if (Number(q.get('offset') || 0) > 0) return body([]);
    if (p.startsWith('/rest/v1/users_profile?id=eq.')) return body([{ role: 'viewer', full_name: 'ZZ Me', active: true }]);
    if (p.startsWith('/rest/v1/users_profile?id=in.')) return body([{ id: ME, full_name: 'ZZ Me' }, { id: U(8), full_name: 'ZZ Giver user' }].filter(x => inIds(q.get('id')).includes(x.id)));
    if (p.startsWith('/rest/v1/docket_user_roles?user_id=eq.')) return body(superAdmin ? [{ role_key: 'zz_super' }] : []);
    if (p.startsWith('/rest/v1/docket_user_roles?')) return body([]);
    if (p.startsWith('/rest/v1/docket_roles?')) return body([{ role_key: 'zz_super', permissions: { docket_plan_admin: true } }]);
    if (p.includes('/employees?auth_user_id=')) return body([{ id: MEE, full_name: 'ZZ Me', department_id: dept }]);
    if (p.includes('/employees?id=eq.')) return body(EMPS.filter(e => e.id === eq('id')));
    if (p.includes('/employees?id=in.')) return body(EMPS.filter(e => inIds(q.get('id')).includes(e.id)));
    if (p.includes('/departments?id=eq.')) return body(DEPTS.filter(d => d.id === eq('id')));
    if (p.includes('/departments?id=in.')) return body(DEPTS.filter(d => inIds(q.get('id')).includes(d.id)));
    if (p.includes('/departments?')) return body(DEPTS);
    if (p.includes('/settings?')) return body([]);
    if (p.startsWith('/rest/v1/weeks?')) return body([]);
    if (p.includes('/rpc/next_task_seq')) return body('DKT-99');
    if (p.includes('/rpc/week_score')) {
      const thisWeek = reqBody.p_date === TODAY;
      return body({ week_end: thisWeek ? WE : addD(WE, -7), week_start: thisWeek ? WS : addD(WS, -7), opened: true, final: !thisWeek,
        opened_late: false, as_of: new Date().toISOString(), scoring_version: 1, week_end_dow: 7, tasks: thisWeek ? scoreRows : [] });
    }
    if (p.includes('/rpc/')) return body([]);
    if (p.startsWith('/rest/v1/spaces?is_default=eq.true')) return body([{ id: G }]);
    if (p.startsWith('/rest/v1/spaces?id=eq.')) return body(SPACES[eq('id')] ? [SPACES[eq('id')]] : []);
    if (p.startsWith('/rest/v1/spaces?id=in.')) return body(inIds(q.get('id')).map(id => SPACES[id]).filter(Boolean));
    if (p.startsWith('/rest/v1/spaces?archived_at=not.is.null')) return body(archivedSpaces.map(id => ({ id })));
    if (p.startsWith('/rest/v1/spaces?or=')) return body([{ id: FND, archived_at: null, is_founders: true }, ...archivedSpaces.map(id => ({ id, archived_at: 'x', is_founders: false }))]);
    if (p.startsWith('/rest/v1/space_members?space_id=eq.')) return body([...(members.includes(eq('space_id')) ? [{ user_id: ME }] : []), ...(others[eq('space_id')] || []).map(user_id => ({ user_id }))]);
    if (p.startsWith('/rest/v1/space_members?')) return body(members.filter(s => inIds(q.get('space_id')).includes(s)).map(space_id => ({ space_id })));
    if (p.startsWith('/rest/v1/task_history') && method === 'POST') { history.push(...[].concat(reqBody)); return body([]); }
    if (u.pathname === '/rest/v1/tasks' && method === 'POST') {
      const row = T(99, { ...reqBody[0], id: U(199) }); posted.push(reqBody[0]); db.push(row); return body([row]);
    }
    if (u.pathname === '/rest/v1/tasks' && method === 'PATCH') {
      patches.push({ p, body: reqBody });
      const row = db.find(t => t.id === eq('id'));
      if (!row) return body([]);
      // acceptHandoff's conditional write: every condition it names must still hold
      if (q.get('handoff_accepted_at') === 'is.null' && row.handoff_accepted_at) return body([]);
      if (q.get('status') && !q.get('status').replace(/^in\.\(|\)$/g, '').split(',').includes(row.status)) return body([]);
      if (q.get('archived_at') === 'is.null' && row.archived_at) return body([]);
      if (q.get('handoff_to_department_id') && row.handoff_to_department_id !== eq('handoff_to_department_id')) return body([]);
      const he = q.get('handoff_to_employee_id');
      if (he && (he === 'is.null' ? row.handoff_to_employee_id !== null : row.handoff_to_employee_id !== eq('handoff_to_employee_id'))) return body([]);
      Object.assign(row, reqBody);
      return body([row]);
    }
    if (u.pathname === '/rest/v1/tasks' && method === 'GET') {
      if (q.get('id')?.startsWith('eq.')) return body(db.filter(t => t.id === eq('id') && (!q.get('space_id') || t.space_id === eq('space_id'))));
      if (q.get('id')?.startsWith('in.')) return body(db.filter(t => inIds(q.get('id')).includes(t.id)));
      if (q.get('handoff_to_department_id') === 'not.is.null') {
        const ors = (q.get('or') || '').replace(/^\(|\)$/g, '').split(',').filter(Boolean)
          .map(c => { const [k, op, v] = c.split('.'); assert.ok(op === 'eq' || (op === 'is' && v === 'null'), c); return (t) => (op === 'is' ? t[k] == null : t[k] === v); });
        return body(db.filter(t => t.handoff_to_department_id && OPEN.includes(t.status) && !t.archived_at
          && (!q.get('parent_task_id') || !t.parent_task_id) && (!ors.length || ors.some(f => f(t)))));
      }
      if (q.get('status') === 'not.in.(done,abandoned)') return body(db.filter(t => t.parent_task_id && `eq.${t.owner_employee_id}` === q.get('owner_employee_id')));   // the stale sweep
      if (q.get('parent_task_id')?.startsWith('in.') || q.get('parent_task_id')?.startsWith('eq.') || q.get('plan_item_id')) return body([]);
      if (q.get('or')) {   // the founders' window read (and the pack's next-two-weeks read): open top-level tasks in it
        assert.match(q.get('or'), /^\(and\(revised_deadline\.gte\./);
        return body(db.filter(t => OPEN.includes(t.status) && !t.parent_task_id && !t.archived_at));
      }
      return body([]);   // the pack's open list: nothing but hand-offs in this suite
    }
    return body([]);
  };
  return { fn, calls, history, posted, patches, db };
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

// ── set / change / clear ──
test('createTask: a hand-off is set (history handoff_set), a receiver alone names its team; bad ones refused before any write', async () => {
  let s = stub({ dept: D1 });
  let r = await run(s, { post: { action: 'createTask', data: { title: 'ZZ brief', department_id: D1, handoff_to_department_id: D2 } } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(s.posted[0].handoff_to_department_id, D2); assert.equal(s.posted[0].handoff_to_employee_id, null);
  assert.ok(!('handoff_accepted_at' in s.posted[0]) && !('handoff_accepted_by' in s.posted[0]));
  assert.deepEqual(s.history.filter(h => h.field === 'handoff').map(h => [h.event_type, h.new_value, h.note]), [['handoff_set', D2, null]]);

  s = stub({ dept: D1 });   // receiver only → the receiver's department
  r = await run(s, { post: { action: 'createTask', data: { title: 'ZZ brief', department_id: D1, handoff_to_employee_id: RE,
    handoff_accepted_at: '2026-11-12T00:00:00Z', handoff_accepted_by: ME } } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(s.posted[0].handoff_to_department_id, D2); assert.equal(s.posted[0].handoff_to_employee_id, RE);
  assert.ok(!('handoff_accepted_at' in s.posted[0]) && !('handoff_accepted_by' in s.posted[0]));   // never from a body

  const bad = [
    [{ handoff_to_department_id: 'Sales' }, 'bad_handoff'],
    [{ handoff_to_department_id: U(77) }, 'bad_handoff'],                   // no such department
    [{ handoff_to_employee_id: U(78) }, 'bad_handoff'],                     // no such employee
    [{ handoff_to_employee_id: NOD }, 'bad_handoff'],                       // a receiver with no team
    [{ handoff_to_department_id: D3, handoff_to_employee_id: RE }, 'handoff_receiver_team'],
    [{ handoff_to_department_id: D1 }, 'handoff_same_team'],
  ];
  for (const [o, e] of bad) {
    s = stub({ dept: D1 });
    r = await run(s, { post: { action: 'createTask', data: { title: 'ZZ x', department_id: D1, ...o } } });
    assert.equal(r.status, 400, JSON.stringify(o)); assert.equal(r.j.error, e, JSON.stringify(o));
    assert.equal(s.posted.length, 0); assert.equal(s.calls.some(c => c.p.includes('next_task_seq')), false);
  }
  // a task with no department hands off anywhere
  s = stub({ dept: D1 });
  r = await run(s, { post: { action: 'createTask', data: { title: 'ZZ x', handoff_to_department_id: D1 } } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  // a sub-task can't be one
  s = stub({ dept: D1, tasks: [T(1, { owner_employee_id: MEE })] });
  r = await run(s, { post: { action: 'createSubtask', data: { title: 'ZZ sub', parent_task_id: U(101), handoff_to_department_id: D2 } } });
  assert.equal(r.status, 400); assert.equal(r.j.error, 'handoff_top_level');
});

test('updateTask: set / change receiver / clear, each one history row; acceptance never from a body; a department change re-validates', async () => {
  const mine = (o) => T(1, { owner_employee_id: MEE, ...o });
  let s = stub({ dept: D1, tasks: [mine()] });
  let r = await run(s, { post: { action: 'updateTask', data: { id: U(101), handoff_to_department_id: D2, handoff_accepted_at: '2026-11-12T00:00:00Z', handoff_accepted_by: ME } } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.data.updated, ['handoff']);
  assert.equal(s.patches.length, 1);
  assert.equal(s.patches[0].body.handoff_to_department_id, D2);
  assert.ok(!('handoff_accepted_at' in s.patches[0].body) && !('handoff_accepted_by' in s.patches[0].body));

  // only acceptance in the body → nothing changes at all
  s = stub({ dept: D1, tasks: [mine({ handoff_to_department_id: D2 })] });
  r = await run(s, { post: { action: 'updateTask', data: { id: U(101), handoff_accepted_at: '2026-11-12T00:00:00Z', handoff_accepted_by: ME } } });
  assert.equal(r.status, 200); assert.equal(r.j.data.unchanged, true); assert.equal(s.patches.length, 0);

  // same values again → unchanged, no history
  s = stub({ dept: D1, tasks: [mine({ handoff_to_department_id: D2, handoff_to_employee_id: RE })] });
  r = await run(s, { post: { action: 'updateTask', data: { id: U(101), handoff_to_department_id: D2, handoff_to_employee_id: RE } } });
  assert.equal(r.j.data.unchanged, true); assert.equal(s.history.length, 0);

  // a new department with no receiver given drops the old receiver
  s = stub({ dept: D1, tasks: [mine({ handoff_to_department_id: D2, handoff_to_employee_id: RE })] });
  r = await run(s, { post: { action: 'updateTask', data: { id: U(101), handoff_to_department_id: D3 } } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual([s.patches[0].body.handoff_to_department_id, s.patches[0].body.handoff_to_employee_id], [D3, null]);
  assert.deepEqual(s.history.map(h => [h.event_type, h.old_value, h.new_value]), [['handoff_set', D2, D3]]);

  // clear
  s = stub({ dept: D1, tasks: [mine({ handoff_to_department_id: D2, handoff_to_employee_id: RE })] });
  r = await run(s, { post: { action: 'updateTask', data: { id: U(101), handoff_to_department_id: null } } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual([s.patches[0].body.handoff_to_department_id, s.patches[0].body.handoff_to_employee_id], [null, null]);
  assert.deepEqual(s.history.map(h => [h.event_type, h.old_value]), [['handoff_cleared', D2]]);

  // moving the task INTO the receiving department makes it same-team → refused, nothing written
  s = stub({ dept: D1, tasks: [mine({ handoff_to_department_id: D2 })] });
  r = await run(s, { post: { action: 'updateTask', data: { id: U(101), department_id: D2 } } });
  assert.equal(r.status, 400); assert.equal(r.j.error, 'handoff_same_team'); assert.equal(s.patches.length, 0);

  // a sub-task, and someone without the edit right
  s = stub({ dept: D1, tasks: [mine({ parent_task_id: U(150) })] });
  r = await run(s, { post: { action: 'updateTask', data: { id: U(101), handoff_to_department_id: D2 } } });
  assert.equal(r.j.error, 'handoff_top_level');
  s = stub({ dept: D2, tasks: [T(1, { handoff_to_department_id: D2 })] });   // a receiver may NOT edit the giver's task
  r = await run(s, { post: { action: 'updateTask', data: { id: U(101), handoff_to_employee_id: MEE } } });
  assert.equal(r.status, 403);
});

// ── accept ──
test('acceptHandoff: a department member accepts and becomes the named receiver; one conditional write, history handoff_accepted', async () => {
  const s = stub({ dept: D2, tasks: [T(1, { handoff_to_department_id: D2 })] });
  const r = await run(s, { post: { action: 'acceptHandoff', data: { id: U(101), handoff_to_employee_id: RE, handoff_accepted_by: U(7) } } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(s.patches.length, 1);
  assert.match(s.patches[0].p, /handoff_accepted_at=is\.null/);
  assert.match(s.patches[0].p, new RegExp(`handoff_to_department_id=eq\\.${D2}`));
  assert.match(s.patches[0].p, /handoff_to_employee_id=is\.null/);
  assert.equal(s.patches[0].body.handoff_to_employee_id, MEE);        // the caller, not the body's RE
  assert.equal(s.patches[0].body.handoff_accepted_by, ME);            // the caller, not the body's
  assert.ok(s.patches[0].body.handoff_accepted_at);
  assert.deepEqual(s.history.map(h => [h.event_type, h.new_value, h.note]), [['handoff_accepted', D2, MEE]]);
  const t = r.j.data.task;
  assert.equal(t.handoff_to_employee_name, 'ZZ Me'); assert.equal(t.handoff_to_department_name, 'ZZ team 2');
  assert.equal(t.handoff_accepted_by_name, 'ZZ Me');
});

test('acceptHandoff: the named receiver keeps the name; 403 not_receiver / 409 handoff_closed / 400 not_a_handoff / no-op / lost race', async () => {
  // the named receiver (from another department than the caller? no — named wins even if the caller moved teams)
  let s = stub({ dept: D3, tasks: [T(1, { handoff_to_department_id: D2, handoff_to_employee_id: MEE })] });
  let r = await run(s, { post: { action: 'acceptHandoff', id: U(101) } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.ok(!('handoff_to_employee_id' in s.patches[0].body));
  assert.match(s.patches[0].p, new RegExp(`handoff_to_employee_id=eq\\.${MEE}`));

  // someone in the receiving department when another person is named — still a receiver
  s = stub({ dept: D2, tasks: [T(1, { handoff_to_department_id: D2, handoff_to_employee_id: RE })] });
  r = await run(s, { post: { action: 'acceptHandoff', id: U(101) } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.ok(!('handoff_to_employee_id' in s.patches[0].body));

  const cases = [
    [{ dept: D3, tasks: [T(1, { handoff_to_department_id: D2 })] }, 403, 'not_receiver'],
    [{ dept: D1, tasks: [T(1, { owner_employee_id: MEE, handoff_to_department_id: D2 })] }, 403, 'not_receiver'],   // the giver can't accept
    [{ dept: D2, tasks: [T(1, { handoff_to_department_id: D2, status: 'done' })] }, 409, 'handoff_closed'],
    [{ dept: D2, tasks: [T(1, { handoff_to_department_id: D2, status: 'abandoned' })] }, 409, 'handoff_closed'],
    [{ dept: D2, tasks: [T(1, { handoff_to_department_id: D2, archived_at: '2026-11-01T00:00:00Z' })] }, 409, 'handoff_closed'],
    [{ dept: D2, tasks: [T(1)] }, 400, 'not_a_handoff'],
    [{ dept: D2, tasks: [] }, 404, 'not_found'],
  ];
  for (const [o, st, e] of cases) {
    s = stub(o);
    r = await run(s, { post: { action: 'acceptHandoff', id: U(101) } });
    assert.equal(r.status, st, e); assert.equal(r.j.error, e); assert.equal(s.patches.length, 0, e);
  }
  s = stub({ dept: D2 });
  r = await run(s, { post: { action: 'acceptHandoff', id: 'DKT-1' } });
  assert.equal(r.status, 400);

  // already accepted → 200 no-op, nothing written
  s = stub({ dept: D2, tasks: [T(1, { handoff_to_department_id: D2, handoff_to_employee_id: RE, handoff_accepted_at: '2026-11-10T00:00:00Z', handoff_accepted_by: U(7) })] });
  r = await run(s, { post: { action: 'acceptHandoff', id: U(101) } });
  assert.equal(r.status, 200); assert.equal(r.j.data.unchanged, true); assert.equal(s.patches.length, 0); assert.equal(s.history.length, 0);

  // lost the race (accepted between the read and the write) → unchanged, no history
  s = stub({ dept: D2, tasks: [T(1, { handoff_to_department_id: D2 })] });
  const real = s.fn;
  s.fn = async (input, init = {}) => {
    if ((init.method || '').toUpperCase() === 'PATCH') { s.db[0].handoff_accepted_at = 'x'; s.db[0].handoff_to_employee_id = RE; }
    return real(input, init);
  };
  r = await run(s, { post: { action: 'acceptHandoff', id: U(101) } });
  assert.equal(r.status, 200); assert.equal(r.j.data.unchanged, true); assert.equal(s.history.length, 0);
});

test('a private-space hand-off: a receiver who is not a member gets 404 on accept and on getTask; a member can', async () => {
  const task = T(1, { space_id: PRIV, handoff_to_department_id: D2 });
  for (const action of ['acceptHandoff']) {
    const s = stub({ dept: D2, tasks: [task] });
    const r = await run(s, { post: { action, id: U(101) } });
    assert.equal(r.status, 404); assert.equal(s.patches.length, 0);
  }
  let r = await run(stub({ dept: D2, tasks: [task] }), { get: { action: 'getTask', id: U(101) } });
  assert.equal(r.status, 404);
  r = await run(stub({ dept: D2, tasks: [task], members: [PRIV] }), { get: { action: 'getTask', id: U(101) } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  r = await run(stub({ dept: D2, tasks: [task], members: [PRIV] }), { post: { action: 'acceptHandoff', id: U(101) } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
});

test('getTask: the receiving department opens a General hand-off by id (can_accept_handoff); a bystander is refused', async () => {
  const task = T(1, { handoff_to_department_id: D2 });
  let r = await run(stub({ dept: D2, tasks: [task] }), { get: { action: 'getTask', id: U(101) } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.data.can_accept_handoff, true);
  assert.equal(r.j.data.handoff_to_department_name, 'ZZ team 2');
  assert.equal(r.j.data._can_edit, false);
  r = await run(stub({ dept: D3, tasks: [task] }), { get: { action: 'getTask', id: U(101) } });
  assert.equal(r.status, 403);
  // the named receiver from another team sees it too; once accepted, can_accept_handoff is false
  r = await run(stub({ dept: D3, tasks: [T(1, { handoff_to_department_id: D2, handoff_to_employee_id: MEE, handoff_accepted_at: 'x', handoff_accepted_by: ME })] }),
    { get: { action: 'getTask', id: U(101) } });
  assert.equal(r.status, 200); assert.equal(r.j.data.can_accept_handoff, false); assert.equal(r.j.data.handoff_accepted_by_name, 'ZZ Me');
  // the giver's team sees it, but can't accept
  r = await run(stub({ dept: D1, tasks: [task] }), { get: { action: 'getTask', id: U(101) } });
  assert.equal(r.status, 200); assert.equal(r.j.data.can_accept_handoff, false);
});

test('stale sweep: a sub-task\'s parent crumb shows when the parent is a General hand-off to the caller\'s team; not to a bystander', async () => {
  const tasks = [T(1, { title: 'ZZ parent ho', handoff_to_department_id: D2 }),
    T(2, { title: 'ZZ stale child', parent_task_id: U(101), owner_employee_id: MEE, deadline: at('2026-01-01') })];
  let r = await run(stub({ dept: D2, tasks }), { get: { action: 'getStaleTasks' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.data.tasks.map(t => [t.title, t.parent?.title || null]), [['ZZ stale child', 'ZZ parent ho']]);
  r = await run(stub({ dept: D3, tasks }), { get: { action: 'getStaleTasks' } });
  assert.deepEqual(r.j.data.tasks.map(t => [t.title, t.parent?.title || null]), [['ZZ stale child', null]]);
});

// ── Incoming ──
test('getIncoming: me / team / all, counts over all, not-accepted first then by date (no date last); private non-member + archived space out', async () => {
  const tasks = [
    T(1, { title: 'ZZ team late', handoff_to_department_id: D2, deadline: at(addD(WE, 9)) }),
    T(2, { title: 'ZZ named early', handoff_to_department_id: D2, handoff_to_employee_id: MEE, deadline: at(addD(WE, 1)) }),
    T(3, { title: 'ZZ accepted', handoff_to_department_id: D2, handoff_to_employee_id: RE, handoff_accepted_at: 'x', handoff_accepted_by: U(7), deadline: at(addD(WE, -20)) }),
    T(4, { title: 'ZZ no date', handoff_to_department_id: D2, deadline: null }),
    T(5, { title: 'ZZ secret', handoff_to_department_id: D2, space_id: PRIV }),
    T(6, { title: 'ZZ archived space', handoff_to_department_id: D2, space_id: U(23) }),
    T(7, { title: 'ZZ done', handoff_to_department_id: D2, status: 'done' }),
    T(8, { title: 'ZZ elsewhere', handoff_to_department_id: D3 }),
  ];
  const s = stub({ dept: D2, tasks, archivedSpaces: [U(23)] });
  SPACES[U(23)] = { id: U(23), name: 'ZZ old', is_default: true, is_private: false, owner_user_id: null, is_founders: false };
  try {
    let r = await run(s, { get: { action: 'getIncoming' } });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    assert.deepEqual(r.j.data.tasks.map(t => t.title), ['ZZ named early', 'ZZ team late', 'ZZ no date', 'ZZ accepted']);
    assert.deepEqual(r.j.data.counts, { me: 1, team: 4, unaccepted: 3 });
    const row = r.j.data.tasks[0];
    assert.equal(row.giver_name, 'ZZ Giver'); assert.equal(row.giver_team_name, 'ZZ team 1'); assert.equal(row.handoff_to_employee_name, 'ZZ Me');
    const read = s.calls.find(c => c.p.startsWith('/rest/v1/tasks?handoff_to_department_id=not.is.null'));
    assert.match(read.p, new RegExp(`or=\\(handoff_to_employee_id\\.eq\\.${MEE},handoff_to_department_id\\.eq\\.${D2}\\)`));
    assert.match(read.p, /archived_at=is\.null/); assert.match(read.p, /status=in\.\(not_started,in_progress,blocked\)/);
    r = await run(stub({ dept: D2, tasks, archivedSpaces: [U(23)] }), { get: { action: 'getIncoming', scope: 'me' } });
    assert.deepEqual(r.j.data.tasks.map(t => t.title), ['ZZ named early']);
    r = await run(stub({ dept: D3, tasks, archivedSpaces: [U(23)] }), { get: { action: 'getIncoming', scope: 'team' } });
    assert.deepEqual(r.j.data.tasks.map(t => t.title), ['ZZ elsewhere']);   // D3's; T2 names MEE but that is "me", not team
    r = await run(stub({ dept: D2, tasks, members: [PRIV] }), { get: { action: 'getIncoming', scope: 'team' } });
    assert.ok(r.j.data.tasks.some(t => t.title === 'ZZ secret'));          // a member sees the private one
    r = await run(stub({ dept: D2, tasks }), { get: { action: 'getIncoming', scope: 'everyone' } });
    assert.equal(r.status, 400); assert.equal(r.j.error, 'bad_scope');
  } finally { delete SPACES[U(23)]; }
});

// ── the review pack ──
const PACK_TASKS = [
  T(1, { title: 'ZZ unowned out', deadline: at(addD(WE, 3)), handoff_to_department_id: D2 }),
  T(2, { title: 'ZZ overdue accepted', deadline: at(addD(WS, -10)), handoff_to_department_id: D2, handoff_to_employee_id: RE, handoff_accepted_at: 'x', handoff_accepted_by: U(7) }),
  T(3, { title: 'ZZ secret ho', task_no: 'DKT-SECRET', deadline: at(addD(WS, -3)), handoff_to_department_id: D3, space_id: PRIV }),
  T(4, { title: 'ZZ founders ho', task_no: 'DKT-FND', deadline: at(addD(WE, 2)), handoff_to_department_id: D2, space_id: FND }),
  T(5, { title: 'ZZ owned later', deadline: at(addD(WE, 4)), handoff_to_department_id: D2, handoff_to_employee_id: RE, handoff_accepted_at: 'x', handoff_accepted_by: U(7) }),
];
test('pack (plan admin, all teams): unowned / overdue per team, out on the giver, in on the receiver; a private one counted only; Founders\' never in Slack', async () => {
  const s = stub({ superAdmin: true, dept: D1, tasks: PACK_TASKS, members: [FND] });
  const r = await run(s, { get: { action: 'getReviewPack', team: 'all' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const d = r.j.data;
  const team = (id) => d.teams.find(t => t.department_id === id);
  assert.deepEqual(d.teams.map(t => t.department_id), [D1, D2]);   // teams with only hand-offs still get a card
  const ids = (l) => l.map(h => [h.title, h.direction]);
  assert.deepEqual(ids(team(D1).handoffs.unowned), [['ZZ founders ho', 'out'], ['ZZ unowned out', 'out']]);
  assert.deepEqual(ids(team(D1).handoffs.overdue), [['ZZ overdue accepted', 'out']]);
  assert.deepEqual(ids(team(D2).handoffs.unowned), [['ZZ founders ho', 'in'], ['ZZ unowned out', 'in']]);
  assert.deepEqual(ids(team(D2).handoffs.overdue), [['ZZ overdue accepted', 'in']]);
  const h = team(D2).handoffs.overdue[0];
  assert.deepEqual([h.from_team_name, h.to_team_name, h.giver_name, h.receiver_name, h.accepted], ['ZZ team 1', 'ZZ team 2', 'ZZ Giver', 'ZZ Recv', true]);
  assert.equal(d.hidden_tasks, 1);
  assert.doesNotMatch(JSON.stringify(d), /ZZ secret ho|DKT-SECRET/);
  const slack = d.slack.summary + d.slack.teams.map(t => t.text).join('\n');
  assert.match(slack, /\*Hand-offs\*/);
  assert.match(slack, /⚠ overdue: DKT-2 ZZ overdue accepted/);
  assert.doesNotMatch(slack, /ZZ founders ho|DKT-FND/);
  assert.doesNotMatch(slack, /ZZ owned later/);
  // the hand-off read: open, top-level, live, any date
  const read = s.calls.find(c => c.p.includes('handoff_to_department_id=not.is.null'));
  assert.match(read.p, /archived_at=is\.null&parent_task_id=is\.null/);
  assert.doesNotMatch(read.p, /deadline\.(gte|lt)/);   // any date
});

test('pack (the receiving team\'s member, own team): sees the General hand-off given TO them, never the Founders\' or private one', async () => {
  const s = stub({ dept: D2, tasks: PACK_TASKS, members: [FND] });
  const r = await run(s, { get: { action: 'getReviewPack' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const d = r.j.data;
  assert.deepEqual(d.teams.map(t => t.department_id), [D2]);
  assert.deepEqual(d.teams[0].handoffs.unowned.map(h => [h.title, h.direction]), [['ZZ unowned out', 'in']]);
  assert.deepEqual(d.teams[0].handoffs.overdue.map(h => h.title), ['ZZ overdue accepted']);
  assert.equal(d.hidden_tasks, 0);
  assert.doesNotMatch(JSON.stringify(d), /ZZ founders ho|ZZ secret ho/);
  const read = s.calls.find(c => c.p.includes('handoff_to_department_id=not.is.null'));
  assert.match(read.p, new RegExp(`or=\\(department_id\\.eq\\.${D2},handoff_to_department_id\\.eq\\.${D2},department_id\\.is\\.null\\)`));
  // a bystander team (D3) sees none of D1→D2's
  const r3 = await run(stub({ dept: D3, tasks: PACK_TASKS }), { get: { action: 'getReviewPack' } });
  assert.equal(r3.status, 200, JSON.stringify(r3.j));
  assert.deepEqual(r3.j.data.teams[0].handoffs, { unowned: [], overdue: [] });
});

// ── the founders' page ──
test('getFoundersReview: open cross-team hand-offs this week or next, not owned; a private one adds to hidden_asks; a Slack block', async () => {
  const tasks = [
    T(1, { title: 'ZZ land this', deadline: at(addD(WE, 3)), handoff_to_department_id: D2 }),
    T(2, { title: 'ZZ named not accepted', deadline: at(addD(WS, 1)), handoff_to_department_id: D2, handoff_to_employee_id: RE }),
    T(3, { title: 'ZZ owned', deadline: at(addD(WE, 2)), handoff_to_department_id: D2, handoff_to_employee_id: RE, handoff_accepted_at: 'x', handoff_accepted_by: U(7) }),
    T(4, { title: 'ZZ secret ho', deadline: at(addD(WE, 2)), handoff_to_department_id: D2, space_id: PRIV }),
    T(5, { title: 'ZZ plain task', deadline: at(addD(WE, 2)) }),
  ];
  const s = stub({ superAdmin: true, dept: D1, tasks });
  const r = await run(s, { get: { action: 'getFoundersReview' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const d = r.j.data;
  assert.deepEqual(d.handoffs.map(h => h.title), ['ZZ named not accepted', 'ZZ land this']);
  assert.deepEqual([d.handoffs[0].from_team_name, d.handoffs[0].to_team_name, d.handoffs[0].receiver_name, d.handoffs[0].accepted],
    ['ZZ team 1', 'ZZ team 2', 'ZZ Recv', false]);
  assert.equal(d.hidden_asks, 1);
  assert.doesNotMatch(JSON.stringify(d), /ZZ secret ho/);
  assert.match(d.slack, /\*Hand-offs to land\*/);
  assert.match(d.slack, /ZZ land this \(ZZ team 1, ZZ Giver\) → ZZ team 2 — no named receiver/);
});

// ── hostile review (2026-11-12): the giver never receives; lowercase ids; own-side moves; exited receivers; races ──
test('the giver (owner) is never a receiver: accept 403, can_accept false, not in their Incoming; no-team task gives from its owner\'s team', async () => {
  const own = (o) => T(1, { owner_employee_id: MEE, department_id: null, handoff_to_department_id: D2, ...o });
  let s = stub({ dept: D2, tasks: [own()] });
  let r = await run(s, { post: { action: 'acceptHandoff', id: U(101) } });
  assert.equal(r.status, 403); assert.equal(r.j.error, 'not_receiver'); assert.equal(s.patches.length, 0);
  r = await run(stub({ dept: D2, tasks: [own({ department_id: D3 })] }), { post: { action: 'acceptHandoff', id: U(101) } });
  assert.equal(r.status, 403);                                              // in the receiving team, but the giver
  r = await run(stub({ dept: D3, tasks: [own({ department_id: D3, handoff_to_employee_id: MEE })] }), { post: { action: 'acceptHandoff', id: U(101) } });
  assert.equal(r.status, 403);                                              // named, but the giver
  r = await run(stub({ dept: D2, tasks: [own()] }), { get: { action: 'getTask', id: U(101) } });
  assert.equal(r.status, 200); assert.equal(r.j.data.can_accept_handoff, false);
  r = await run(stub({ dept: D2, tasks: [own()] }), { get: { action: 'getIncoming' } });
  assert.deepEqual(r.j.data.tasks, []); assert.deepEqual(r.j.data.counts, { me: 0, team: 0, unaccepted: 0 });

  // set: a task with no department, owned by someone in the receiving team → same team; the owner as receiver → same team
  for (const data of [{ owner_employee_id: OE, handoff_to_department_id: D1 }, { owner_employee_id: RE, handoff_to_department_id: D2 },
    { department_id: D1, owner_employee_id: RE, handoff_to_employee_id: RE }]) {
    s = stub({ dept: D1 });
    r = await run(s, { post: { action: 'createTask', data: { title: 'ZZ x', ...data } } });
    assert.equal(r.status, 400, JSON.stringify(data)); assert.equal(r.j.error, 'handoff_same_team'); assert.equal(s.posted.length, 0);
  }
  s = stub({ dept: D1 });
  r = await run(s, { post: { action: 'createTask', data: { title: 'ZZ x', owner_employee_id: OE, handoff_to_department_id: D2 } } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  // moving a no-team hand-off's owner INTO the receiving team → same team (re-checked, nothing written)
  s = stub({ dept: D1, tasks: [T(1, { owner_employee_id: MEE, created_by_user_id: ME, department_id: null, handoff_to_department_id: D1 })] });
  r = await run(s, { post: { action: 'updateTask', data: { id: U(101), owner_employee_id: OE } } });
  assert.equal(r.status, 400); assert.equal(r.j.error, 'handoff_same_team'); assert.equal(s.patches.length, 0);
});

test('ids are compared lowercase: an uppercase same-team id is refused; an uppercase re-send of the current hand-off changes nothing', async () => {
  const mine = (o) => T(1, { owner_employee_id: MEE, ...o });
  let s, r;
  // the fixture uuids are digits only, so these carry a hex letter to prove the case fold
  const DH = '0000000a-0000-4000-8000-000000000010', DHU = DH.toUpperCase();
  s = stub({ dept: D1, tasks: [mine({ department_id: DH })] });
  DEPTS.push({ id: DH, name: 'ZZ hex team' });
  try {
    r = await run(s, { post: { action: 'updateTask', data: { id: U(101), handoff_to_department_id: DHU } } });
    assert.equal(r.status, 400); assert.equal(r.j.error, 'handoff_same_team');
    s = stub({ dept: D1, tasks: [mine({ handoff_to_department_id: DH, handoff_to_employee_id: null })] });
    r = await run(s, { post: { action: 'updateTask', data: { id: U(101), handoff_to_department_id: DHU } } });
    assert.equal(r.status, 200); assert.equal(r.j.data.unchanged, true); assert.equal(s.patches.length, 0);
  } finally { DEPTS.pop(); }
  const EH = '0000000b-0000-4000-8000-000000000004';
  EMPS.push({ id: EH, full_name: 'ZZ hex recv', department_id: D2, auth_user_id: null, status: 'active' });
  try {
    s = stub({ dept: D1, tasks: [mine({ handoff_to_department_id: D2, handoff_to_employee_id: EH })] });
    r = await run(s, { post: { action: 'updateTask', data: { id: U(101), handoff_to_department_id: D2.toUpperCase(), handoff_to_employee_id: EH.toUpperCase() } } });
    assert.equal(r.status, 200); assert.equal(r.j.data.unchanged, true); assert.equal(s.patches.length, 0);   // the named receiver is NOT nulled
    s = stub({ dept: D1, tasks: [mine()] });
    r = await run(s, { post: { action: 'updateTask', data: { id: U(101), handoff_to_employee_id: EH.toUpperCase() } } });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    assert.deepEqual([s.patches[0].body.handoff_to_department_id, s.patches[0].body.handoff_to_employee_id], [D2, EH]);   // stored lowercase
  } finally { EMPS.pop(); }
});

test('an exited receiver is refused when named; moving only the task\'s own department leaves the named receiver alone', async () => {
  let s = stub({ dept: D1 });
  let r = await run(s, { post: { action: 'createTask', data: { title: 'ZZ x', department_id: D1, handoff_to_employee_id: EX } } });
  assert.equal(r.status, 400); assert.equal(r.j.error, 'handoff_receiver_inactive'); assert.equal(s.posted.length, 0);
  const mine = T(1, { owner_employee_id: MEE, handoff_to_department_id: D2, handoff_to_employee_id: EX });   // named before they left
  s = stub({ dept: D1, tasks: [mine] });
  r = await run(s, { post: { action: 'updateTask', data: { id: U(101), department_id: D3 } } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.data.updated, ['department_id']);
  assert.ok(!('handoff_to_employee_id' in s.patches[0].body) && !('handoff_to_department_id' in s.patches[0].body));
  assert.equal(s.history.filter(h => h.field === 'handoff').length, 0);
  s = stub({ dept: D1, tasks: [mine] });
  r = await run(s, { post: { action: 'updateTask', data: { id: U(101), title: 'ZZ renamed', handoff_to_department_id: D2, handoff_to_employee_id: EX } } });
  assert.equal(r.status, 200, JSON.stringify(r.j));   // a re-send of what is there never fails on a receiver who has left
  s = stub({ dept: D1, tasks: [mine] });
  r = await run(s, { post: { action: 'updateTask', data: { id: U(101), department_id: D2 } } });
  assert.equal(r.j.error, 'handoff_same_team');       // the same-team re-check still runs
});

test('acceptHandoff: closed between read and write → 409; accepted between → no-op; an archived space → 409 (and can_accept false)', async () => {
  let s = stub({ dept: D2, tasks: [T(1, { handoff_to_department_id: D2 })] });
  const real = s.fn;
  s.fn = async (input, init = {}) => { if ((init.method || '').toUpperCase() === 'PATCH') s.db[0].status = 'done'; return real(input, init); };
  let r = await run(s, { post: { action: 'acceptHandoff', id: U(101) } });
  assert.equal(r.status, 409); assert.equal(r.j.error, 'handoff_closed'); assert.equal(s.history.length, 0);
  assert.match(s.patches[0].p, /status=in\.\(not_started,in_progress,blocked\)/); assert.match(s.patches[0].p, /archived_at=is\.null/);
  assert.equal(s.db[0].handoff_accepted_at, null);
  s = stub({ dept: D2, tasks: [T(1, { handoff_to_department_id: D2, space_id: ARCH })] });
  r = await run(s, { post: { action: 'acceptHandoff', id: U(101) } });
  assert.equal(r.status, 409); assert.equal(r.j.error, 'handoff_closed'); assert.equal(s.patches.length, 0);
  r = await run(stub({ dept: D2, tasks: [T(1, { handoff_to_department_id: D2, space_id: ARCH })] }), { get: { action: 'getTask', id: U(101) } });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(r.j.data.can_accept_handoff, false);
});

test('pack + founders: a no-team hand-off gives from its owner\'s team (out on that team, cross-team by it); archived-space ones never on the founders\' page', async () => {
  const tasks = [T(1, { title: 'ZZ noteam out', department_id: null, owner_employee_id: OE, handoff_to_department_id: D2 }),
    T(2, { title: 'ZZ noteam same', department_id: null, owner_employee_id: RE, handoff_to_department_id: D2 }),
    T(3, { title: 'ZZ archived ho', handoff_to_department_id: D2, space_id: ARCH })];
  let r = await run(stub({ superAdmin: true, dept: D1, tasks, archivedSpaces: [ARCH] }), { get: { action: 'getReviewPack', team: D1 } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.data.teams[0].handoffs.unowned.map(h => [h.title, h.direction, h.from_team_name]), [['ZZ noteam out', 'out', 'ZZ team 1']]);
  r = await run(stub({ superAdmin: true, dept: D1, tasks, archivedSpaces: [ARCH] }), { get: { action: 'getFoundersReview' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.data.handoffs.map(h => [h.title, h.from_team_name]), [['ZZ noteam out', 'ZZ team 1']]);   // same-team + archived out
  assert.equal(r.j.data.hidden_asks, 0);
});

test('bulk owner change: the named receiver, or (no-team task) an owner in the receiving team, is skipped as same-team', async () => {
  const mk = (n, o) => T(n, { owner_employee_id: MEE, created_by_user_id: ME, ...o });
  const patchedIds = (s) => s.patches.map(x => inIds(new URL('https://x' + x.p).searchParams.get('id'))).flat().sort();
  // OE is in D1: T1 has no team and goes to D1 → same team; T2 has its own team; T3 is no hand-off
  let s = stub({ dept: D2, tasks: [mk(1, { department_id: null, handoff_to_department_id: D1 }), mk(2, { department_id: D3, handoff_to_department_id: D1 }), mk(3)] });
  let r = await run(s, { post: { action: 'bulkUpdateTasks', ids: [U(101), U(102), U(103)], field: 'owner_employee_id', value: OE } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual([r.j.data.updated, r.j.data.skipped, r.j.data.handoff_same_team], [2, 1, 1]);
  assert.deepEqual(patchedIds(s), [U(102), U(103)]);
  assert.deepEqual(s.history.map(h => h.task_id).sort(), [U(102), U(103)]);
  // RE is the named receiver of T4 → skipped; T5 has no team and goes to D1 while RE is in D2 → fine
  s = stub({ dept: D2, tasks: [mk(4, { department_id: D3, handoff_to_department_id: D2, handoff_to_employee_id: RE }), mk(5, { department_id: null, handoff_to_department_id: D1 })] });
  r = await run(s, { post: { action: 'bulkUpdateTasks', ids: [U(104), U(105)], field: 'owner_employee_id', value: RE } });
  assert.deepEqual([r.j.data.updated, r.j.data.skipped, r.j.data.handoff_same_team], [1, 1, 1]);
  assert.deepEqual(patchedIds(s), [U(105)]);
  // single edit agrees: making the named receiver the owner is refused; another owner on the same task passes
  s = stub({ dept: D2, tasks: [mk(4, { department_id: D3, handoff_to_department_id: D2, handoff_to_employee_id: RE })] });
  r = await run(s, { post: { action: 'updateTask', data: { id: U(104), owner_employee_id: RE } } });
  assert.equal(r.status, 400); assert.equal(r.j.error, 'handoff_same_team'); assert.equal(s.patches.length, 0);
  r = await run(s, { post: { action: 'updateTask', data: { id: U(104), owner_employee_id: OE } } });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(s.history.filter(h => h.field === 'handoff').length, 0);
  // every row clashes → nothing written; clearing the owner never clashes; a junk id is refused
  s = stub({ dept: D2, tasks: [mk(1, { department_id: null, handoff_to_department_id: D1 })] });
  r = await run(s, { post: { action: 'bulkUpdateTasks', ids: [U(101)], field: 'owner_employee_id', value: OE } });
  assert.deepEqual([r.j.data.updated, r.j.data.skipped, s.patches.length], [0, 1, 0]);
  r = await run(s, { post: { action: 'bulkUpdateTasks', ids: [U(101)], field: 'owner_employee_id', value: null } });
  assert.equal(r.j.data.updated, 1); assert.equal(r.j.data.handoff_same_team, undefined);
  r = await run(stub({ tasks: [mk(3)] }), { post: { action: 'bulkUpdateTasks', ids: [U(103)], field: 'owner_employee_id', value: 'zz' } });
  assert.equal(r.status, 400); assert.equal(r.j.error, 'invalid owner');
});

test('0033: link / unblocked RPCs carry the request source; getProposals passes the review flag', async () => {
  const s = stub({ dept: D2, tasks: [T(1, { owner_employee_id: MEE, created_by_user_id: ME }), T(2, { owner_employee_id: MEE, created_by_user_id: ME })] });
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {   // both ends visible to the caller
    const u = new URL(typeof input === 'string' ? input : input.url);
    if (u.pathname === '/rest/v1/rpc/task_cards') {
      const ids = JSON.parse(init.body).p_ids; s.calls.push({ method: 'POST', p: u.pathname, body: JSON.parse(init.body) });
      return new Response(JSON.stringify(ids.map(id => ({ id, visible: true, status: 'in_progress' }))), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return s.fn(input, init);
  };
  const post = (b, src) => worker.fetch(new Request('https://docketops.test/', { method: 'POST',
    headers: { Authorization: 'Bearer zz', 'content-type': 'application/json', ...(src ? { 'X-LOT-Source': src } : {}) }, body: JSON.stringify(b) }), ENV);
  try {
    await post({ action: 'addTaskLink', id: U(101), other_id: U(102), kind: 'waiting_on' }, 'connector');
    await post({ action: 'bulkUpdateTasks', ids: [U(101)], field: 'status', value: 'done' });
    await worker.fetch(new Request('https://docketops.test/?action=getProposals', { headers: { Authorization: 'Bearer zz' } }), ENV);
  } finally { globalThis.fetch = real; }
  const rpc = (n) => s.calls.find(c => c.p.includes(`/rpc/${n}`))?.body;
  assert.equal(rpc('add_task_link')?.p_source, 'connector');
  assert.equal(rpc('log_unblocked')?.p_source, 'app');
  assert.equal(rpc('plan_proposals_for')?.p_is_review, false);
});


test('create defaults: team = owner\'s team; owner = me in a personal space only; explicit values win', async () => {
  let s = stub({ dept: D2 });
  let r = await run(s, { post: { action: 'createTask', data: { title: 'ZZ a', owner_employee_id: OE } } });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(s.posted[0].department_id, D1);   // OE is in D1
  s = stub({ dept: D2 });
  await run(s, { post: { action: 'createTask', data: { title: 'ZZ b', owner_employee_id: OE, department_id: D3 } } });
  assert.equal(s.posted[0].department_id, D3);                                                       // explicit team wins
  s = stub({ dept: D2 });
  await run(s, { post: { action: 'createTask', data: { title: 'ZZ c' } } });
  assert.equal(s.posted[0].owner_employee_id, null); assert.equal(s.posted[0].department_id, null);  // General: stays blank (The Grid)
  s = stub({ dept: D2, members: [MYSP] });
  await run(s, { post: { action: 'createTask', data: { title: 'ZZ d', space_id: MYSP } } });
  assert.equal(s.posted[0].owner_employee_id, MEE); assert.equal(s.posted[0].department_id, D2);     // personal space → me, my team
  s = stub({ dept: D2, members: [MYSP] });
  await run(s, { post: { action: 'createTask', data: { title: 'ZZ e', space_id: MYSP, owner_employee_id: OE } } });
  assert.equal(s.posted[0].owner_employee_id, OE);                                                   // explicit owner wins
  s = stub({ dept: D2, members: [PRIV] });
  await run(s, { post: { action: 'createTask', data: { title: 'ZZ f', space_id: PRIV } } });
  assert.equal(s.posted[0].owner_employee_id, null);                                                 // someone else's private space: not personal
  s = stub({ dept: D2, members: [MYSP], others: { [MYSP]: [U(8)] } });
  r = await run(s, { post: { action: 'createTask', data: { title: 'ZZ g', space_id: MYSP } } });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(s.posted[0].owner_employee_id, null);   // mine, but shared: not personal
  s = stub({ dept: D2, members: [MYSP] });
  r = await run(s, { post: { action: 'createTask', data: { title: 'ZZ h', space_id: MYSP } } });
  assert.equal(r.j.data.owner_employee_id, MEE); assert.equal(r.j.data.department_id, D2);           // the reply names the final owner + team
});

test('owner change fills a blank team: single edit (history row) and bulk; a task with a team keeps it', async () => {
  const mk = (n, o) => T(n, { owner_employee_id: MEE, created_by_user_id: ME, ...o });
  let s = stub({ dept: D2, tasks: [mk(1, { department_id: null })] });
  let r = await run(s, { post: { action: 'updateTask', data: { id: U(101), owner_employee_id: OE } } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(s.patches.at(-1).body.department_id, D1);
  assert.ok(s.history.some(h => h.event_type === 'department_id_changed' && h.new_value === D1));
  s = stub({ dept: D2, tasks: [mk(1, { department_id: null })] });
  await run(s, { post: { action: 'updateTask', data: { id: U(101), owner_employee_id: OE, department_id: D3 } } });
  assert.equal(s.patches.at(-1).body.department_id, D3);                                             // the request's own team wins
  s = stub({ dept: D2, tasks: [mk(2, { department_id: D3 })] });
  await run(s, { post: { action: 'updateTask', data: { id: U(102), owner_employee_id: OE } } });
  assert.ok(!('department_id' in s.patches.at(-1).body));                                            // has a team: untouched
  s = stub({ dept: D2, tasks: [mk(1, { department_id: null }), mk(2, { department_id: D3 })] });
  r = await run(s, { post: { action: 'bulkUpdateTasks', ids: [U(101), U(102)], field: 'owner_employee_id', value: OE } });
  assert.equal(r.j.data.updated, 2);
  const withDept = s.patches.filter(x => 'department_id' in x.body);
  assert.equal(withDept.length, 1); assert.equal(withDept[0].body.department_id, D1);
  assert.ok(decodeURIComponent(withDept[0].p).includes(U(101)) && !decodeURIComponent(withDept[0].p).includes(U(102)));
  assert.deepEqual(s.history.filter(h => h.event_type === 'department_id_changed').map(h => h.task_id), [U(101)]);
});
