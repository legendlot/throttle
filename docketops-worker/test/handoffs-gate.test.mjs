// Run: node --test docketops-worker/test/*.test.mjs
// F9 R8 hand-offs (spec §4.6, §8.1 #5, §8.6) end to end against a stubbed Supabase: create / update set,
// change and clear a hand-off and refuse the bad ones (bad_handoff, handoff_receiver_team, handoff_same_team,
// handoff_top_level) — never taking an acceptance from a body; acceptHandoff (not_a_handoff 400, not_receiver
// 403, handoff_closed 409, the already-accepted no-op, the department member becoming the named receiver, a
// Founders'-space hand-off 404 to a non-member); the receiver clause (any space but the Founders', P3a) on getTask;
// getIncoming's scopes, counts and order; the review pack's per-team hand-offs (unowned / overdue, out / in, one in a
// space a plan admin can't open — someone's personal space, since P3a — counted only, a Founders'-space one never in
// the Slack copy); the founders' page hand-offs. P3a (involvement visibility, 2026-11-13) at the end of the file.
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
  // G: a team space (was General — retired P3c), shared with D1 and D2 in every stub unless a test narrows it (see `teams`).
  // GEN: General itself, archived (0039) — only for "never General" refusals.
  [G]: { id: G, name: 'ZZ team space', is_default: false, is_private: true, owner_user_id: U(9), is_founders: false, is_personal: false, archived_at: null },
  // is_personal / archived_at as the live columns read them (P3a: planAdminSpace fails closed on a missing field)
  [PRIV]: { id: PRIV, name: 'ZZ private', is_default: false, is_private: true, owner_user_id: U(9), is_founders: false, is_personal: false, archived_at: null },
  [FND]: { id: FND, name: 'Founders', is_default: false, is_private: true, owner_user_id: U(9), is_founders: true, is_personal: false, archived_at: null },
  [U(24)]: { id: U(24), name: 'ZZ archived', is_default: false, is_private: false, owner_user_id: ME, is_founders: false, archived_at: '2026-11-01T00:00:00Z' },
};
const ARCH = U(24);
const GEN = U(19);
SPACES[GEN] = { id: GEN, name: 'General', is_default: true, is_private: false, owner_user_id: null, is_founders: false, is_personal: false, archived_at: '2026-11-14T00:00:00Z' };
const MYSP = U(25);   // a personal space: private, owned by ME
SPACES[MYSP] = { id: MYSP, name: 'ZZ mine', is_default: false, is_private: true, owner_user_id: ME, is_founders: false };
const PERS = U(27);   // P2 (0036): ME's personal space — what ensure_personal_space returns
SPACES[PERS] = { id: PERS, name: 'Personal', is_default: false, is_private: true, owner_user_id: ME, is_founders: false, is_personal: true };
const PERS9 = U(28);  // P3a: someone else's (U(9)'s) personal space — the one kind a plan admin never opens
SPACES[PERS9] = { id: PERS9, name: 'Personal', is_default: false, is_private: true, owner_user_id: U(9), is_founders: false, is_personal: true };
const ARCHT = U(29);  // P3a: an ARCHIVED team space (not personal) — a plan admin never opens it
const HOMEOK = U(30), HOMENO = U(31);   // P3b: a team's home space — one ME is a member of (opens), one ME isn't (doesn't)
SPACES[HOMEOK] = { id: HOMEOK, name: 'ZZ home open', is_default: false, is_private: true, owner_user_id: U(9), is_founders: false, is_personal: false, archived_at: null };
SPACES[HOMENO] = { id: HOMENO, name: 'ZZ home shut', is_default: false, is_private: true, owner_user_id: U(9), is_founders: false, is_personal: false, archived_at: null };
SPACES[ARCHT] = { id: ARCHT, name: 'ZZ old team', is_default: false, is_private: true, owner_user_id: U(9), is_founders: false, is_personal: false, archived_at: '2026-11-01T00:00:00Z' };
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

function stub({ tasks = [], superAdmin = false, dept = D2, members = [], archivedSpaces = [], scoreRows = [], others = {}, teams = {}, exited = false, personal = PERS, hidePersonal = false, collabs = [], comments = [], records = [], homes = {}, perms = null } = {}) {   // perms: the zz_super role's permissions (default plan admin)
     // homes: { departmentId: homeSpaceId } (P3b)
  teams = { [G]: [D1, D2], ...teams };   // G: shared with the giver's (D1) and ME's (D2) teams unless a test says otherwise
  let ensured = false;
  const db = tasks.map(t => ({ ...t }));
  const calls = [], history = [], posted = [], patches = [], teamWrites = [], spaceLog = [];
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
    if (p.startsWith('/rest/v1/docket_roles?')) return body([{ role_key: 'zz_super', permissions: perms || { docket_plan_admin: true } }]);
    if (p.includes('/employees?auth_user_id=')) return body([{ id: MEE, full_name: 'ZZ Me', department_id: dept, status: exited ? 'exited' : 'active' }]);
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
    if (p.includes('/rpc/ensure_personal_space')) { ensured = true; return body(personal); }
    if (p.startsWith('/rest/v1/task_collaborators?task_id=in.')) return body(collabs.filter(id => inIds(q.get('task_id')).includes(id)).map(task_id => ({ task_id })));
    if (p.startsWith('/rest/v1/task_collaborators?task_id=eq.') && q.get('employee_id') === `eq.${MEE}`) return body(collabs.includes(eq('task_id')) ? [{ task_id: eq('task_id') }] : []);
    if (p.includes('/rpc/')) return body([]);
    // P1 team shares (0034): teams = { spaceId: [departmentId, …] }
    if (u.pathname === '/rest/v1/space_teams' && method !== 'GET') {   // return=representation: the row only when it changed
      teamWrites.push({ method, p, body: reqBody });
      if (method === 'POST') return body((teams[reqBody.space_id] || []).includes(reqBody.department_id) ? [] : [reqBody]);
      return body((teams[eq('space_id')] || []).includes(eq('department_id')) ? [{ space_id: eq('space_id'), department_id: eq('department_id') }] : []);
    }
    if (p.startsWith('/rest/v1/space_teams?department_id=eq.')) return body(Object.keys(teams).filter(sid => teams[sid].includes(eq('department_id'))).map(space_id => ({ space_id })));
    if (p.startsWith('/rest/v1/space_teams?space_id=eq.')) return body((teams[eq('space_id')] || []).map(department_id => ({ department_id, added_at: 'x' })));
    if (p.startsWith('/rest/v1/space_teams?')) return body(Object.keys(teams).flatMap(space_id => teams[space_id].map(() => ({ space_id }))));
    if (u.pathname === '/rest/v1/space_history' && method === 'POST') { spaceLog.push(reqBody); return body([]); }
    if (p.startsWith('/rest/v1/spaces?is_private=eq.true')) {   // accessibleSpaces: or=(owner_user_id.eq.X,id.in.(…))
      const or = q.get('or') || ''; const owner = (or.match(/owner_user_id\.eq\.([^,)]+)/) || [])[1]; const ids = inIds((or.match(/id\.in\.(\([^)]*\))/) || [])[1] ? 'in.' + or.match(/id\.in\.(\([^)]*\))/)[1] : 'in.()');
      const teamSpaces = or.includes('is_personal.is.false');   // P3a: a plan admin's every team space
      return body(Object.values(SPACES).filter(sp => sp.is_private && !sp.archived_at && (sp.owner_user_id === owner || ids.includes(sp.id) || (teamSpaces && !sp.is_personal)) && !(hidePersonal && sp.id === PERS && !ensured)));
    }
    if (p.startsWith('/rest/v1/spaces?home_department_id=eq.')) return body(homes[eq('home_department_id')] ? [SPACES[homes[eq('home_department_id')]]] : []);
    if (p.startsWith('/rest/v1/spaces?id=eq.')) return body(SPACES[eq('id')] ? [SPACES[eq('id')]] : []);
    if (p.startsWith('/rest/v1/spaces?id=in.')) return body(inIds(q.get('id')).map(id => SPACES[id]).filter(Boolean));
    if (p.startsWith('/rest/v1/spaces?archived_at=not.is.null')) return body(archivedSpaces.map(id => ({ id })));
    if (p.startsWith('/rest/v1/spaces?or=')) return body([{ id: FND, archived_at: null, is_founders: true }, ...archivedSpaces.map(id => ({ id, archived_at: 'x', is_founders: false }))]);
    if (p.startsWith('/rest/v1/space_members?space_id=eq.')) return body([...(members.includes(eq('space_id')) ? [{ user_id: ME }] : []), ...(others[eq('space_id')] || []).map(user_id => ({ user_id }))]);
    if (p.startsWith('/rest/v1/space_members?')) return body(members.filter(s => !q.get('space_id') || inIds(q.get('space_id')).includes(s)).map(space_id => ({ space_id })));   // no space_id: accessibleSpaces' own read
    if (p.startsWith('/rest/v1/task_history') && method === 'POST') { history.push(...[].concat(reqBody)); return body([]); }
    if (u.pathname === '/rest/v1/task_comments' && method === 'POST') return body([{ id: U(500), ...reqBody[0] }]);
    if (p.startsWith('/rest/v1/task_comments?id=eq.') && method === 'GET') return body(comments.filter(c => c.id === eq('id')));
    if (p.startsWith('/rest/v1/checklist_records?id=eq.') && method === 'GET') return body(records.filter(x => x.id === eq('id')));
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
      if (q.get('status') === 'not.in.(done,abandoned)') return body(db.filter(t => `eq.${t.owner_employee_id}` === q.get('owner_employee_id')   // the stale sweep
        && !['done', 'abandoned'].includes(t.status) && (!q.get('space_id') || inIds(q.get('space_id')).includes(t.space_id))));
      if (q.get('parent_task_id')?.startsWith('eq.') && q.get('space_id')) return body(db.filter(t => t.parent_task_id === eq('parent_task_id') && t.space_id === eq('space_id')));   // getTask's sub-tasks
      if (q.get('parent_task_id')?.startsWith('in.') && !q.get('plan_item_id')) return body(db.filter(t => inIds(q.get('parent_task_id')).includes(t.parent_task_id)));   // hydrateTasks' sub-tasks
      if (q.get('parent_task_id')?.startsWith('eq.') || q.get('plan_item_id')) return body([]);
      if (q.get('or')?.startsWith('(id.in.')) {   // personalMoveBlocks: the tasks + their sub-tasks
        const [a, b] = q.get('or').slice(1, -1).split(/,(?=parent_task_id)/);
        const ids = inIds(a.replace(/^id\./, '')), pids = inIds(b.replace(/^parent_task_id\./, ''));
        return body(db.filter(t => ids.includes(t.id) || pids.includes(t.parent_task_id)));
      }
      if (q.get('or')) {   // the founders' window read (and the pack's next-two-weeks read): open top-level tasks in it
        assert.match(q.get('or'), /^\(and\(revised_deadline\.gte\./);
        return body(db.filter(t => OPEN.includes(t.status) && !t.parent_task_id && !t.archived_at));
      }
      return body([]);   // the pack's open list: nothing but hand-offs in this suite
    }
    return body([]);
  };
  return { fn, calls, history, posted, patches, db, teamWrites, spaceLog };
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
  s = stub({ dept: D1, tasks: [T(1, { owner_employee_id: MEE, space_id: HOMEOK })], members: [HOMEOK] });   // P3c: not General
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
    [{ dept: D3, tasks: [T(1, { handoff_to_department_id: D2 })] }, 404, 'not_found'],   // a bystander team can't open the task (was 403 while General was open to all)
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

// P3a changed this test's truth (it used to be "a private-space receiver who is not a member gets 404"): a receiver
// now opens and accepts a hand-off in any space but the Founders' space; there a non-member still gets 404.
test('a private-space hand-off: a receiver who is not a member opens and accepts it (P3a); a Founders\'-space one stays 404', async () => {
  const task = T(1, { space_id: PRIV, handoff_to_department_id: D2 });
  let s = stub({ dept: D2, tasks: [task] });
  let r = await run(s, { post: { action: 'acceptHandoff', id: U(101) } });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(s.patches.length, 1);
  r = await run(stub({ dept: D2, tasks: [task] }), { get: { action: 'getTask', id: U(101) } });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(r.j.data.can_accept_handoff, true); assert.equal(r.j.data._can_edit, false);
  r = await run(stub({ dept: D3, tasks: [task] }), { get: { action: 'getTask', id: U(101) } });
  assert.equal(r.status, 404);                                                                       // a bystander team: still nothing
  const fnd = T(1, { space_id: FND, handoff_to_department_id: D2 });
  s = stub({ dept: D2, tasks: [fnd] });
  r = await run(s, { post: { action: 'acceptHandoff', id: U(101) } });
  assert.equal(r.status, 404); assert.equal(s.patches.length, 0);
  r = await run(stub({ dept: D2, tasks: [fnd] }), { get: { action: 'getTask', id: U(101) } });
  assert.equal(r.status, 404);
  r = await run(stub({ dept: D2, tasks: [fnd], members: [FND] }), { get: { action: 'getTask', id: U(101) } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  r = await run(stub({ dept: D2, tasks: [fnd], members: [FND] }), { post: { action: 'acceptHandoff', id: U(101) } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
});

// P3c: was "a General hand-off"; G is now the giver's team space (shared with D1 only here), so the receiver opens it by
// involvement and a bystander gets 404 (no existence leak) where General gave 403.
test('getTask: the receiving department opens a team-space hand-off by id (can_accept_handoff); a bystander gets 404', async () => {
  const task = T(1, { handoff_to_department_id: D2 });
  const teams = { [G]: [D1] };
  let r = await run(stub({ dept: D2, tasks: [task], teams }), { get: { action: 'getTask', id: U(101) } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.data.can_accept_handoff, true);
  assert.equal(r.j.data.handoff_to_department_name, 'ZZ team 2');
  assert.equal(r.j.data._can_edit, false);
  r = await run(stub({ dept: D3, tasks: [task], teams }), { get: { action: 'getTask', id: U(101) } });
  assert.equal(r.status, 404);
  // the named receiver from another team sees it too; once accepted, can_accept_handoff is false
  r = await run(stub({ dept: D3, teams, tasks: [T(1, { handoff_to_department_id: D2, handoff_to_employee_id: MEE, handoff_accepted_at: 'x', handoff_accepted_by: ME })] }),
    { get: { action: 'getTask', id: U(101) } });
  assert.equal(r.status, 200); assert.equal(r.j.data.can_accept_handoff, false); assert.equal(r.j.data.handoff_accepted_by_name, 'ZZ Me');
  // the giver's team sees it, but can't accept
  r = await run(stub({ dept: D1, tasks: [task], teams }), { get: { action: 'getTask', id: U(101) } });
  assert.equal(r.status, 200); assert.equal(r.j.data.can_accept_handoff, false);
});

test('stale sweep: a sub-task\'s parent crumb shows when the parent is a team-space hand-off to the caller\'s team; not to a bystander', async () => {
  const tasks = [T(1, { title: 'ZZ parent ho', handoff_to_department_id: D2 }),
    T(2, { title: 'ZZ stale child', parent_task_id: U(101), owner_employee_id: MEE, deadline: at('2026-01-01') })];
  const teams = { [G]: [D1] };   // the giver's space only: the receiver sees the parent through the hand-off (P3a)
  let r = await run(stub({ dept: D2, tasks, teams }), { get: { action: 'getStaleTasks' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.data.tasks.map(t => [t.title, t.parent?.title || null]), [['ZZ stale child', 'ZZ parent ho']]);
  r = await run(stub({ dept: D3, tasks, teams }), { get: { action: 'getStaleTasks' } });
  assert.deepEqual(r.j.data.tasks.map(t => [t.title, t.parent?.title || null]), [['ZZ stale child', null]]);
});

// ── Incoming ──
// P3a: the private one ('ZZ secret') is now IN for a non-member receiver; a Founders'-space one is the hand-off left out.
test('getIncoming: me / team / all, counts over all, not-accepted first then by date (no date last); Founders\' non-member + archived space out', async () => {
  const tasks = [
    T(1, { title: 'ZZ team late', handoff_to_department_id: D2, deadline: at(addD(WE, 9)) }),
    T(2, { title: 'ZZ named early', handoff_to_department_id: D2, handoff_to_employee_id: MEE, deadline: at(addD(WE, 1)) }),
    T(3, { title: 'ZZ accepted', handoff_to_department_id: D2, handoff_to_employee_id: RE, handoff_accepted_at: 'x', handoff_accepted_by: U(7), deadline: at(addD(WE, -20)) }),
    T(4, { title: 'ZZ no date', handoff_to_department_id: D2, deadline: null }),
    T(5, { title: 'ZZ secret', handoff_to_department_id: D2, space_id: PRIV }),
    T(6, { title: 'ZZ archived space', handoff_to_department_id: D2, space_id: U(23) }),
    T(7, { title: 'ZZ done', handoff_to_department_id: D2, status: 'done' }),
    T(8, { title: 'ZZ elsewhere', handoff_to_department_id: D3 }),
    T(9, { title: 'ZZ founders', handoff_to_department_id: D2, space_id: FND }),
  ];
  const s = stub({ dept: D2, tasks, archivedSpaces: [U(23)] });
  SPACES[U(23)] = { id: U(23), name: 'ZZ old', is_default: true, is_private: false, owner_user_id: null, is_founders: false };
  try {
    let r = await run(s, { get: { action: 'getIncoming' } });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    assert.deepEqual(r.j.data.tasks.map(t => t.title), ['ZZ named early', 'ZZ secret', 'ZZ team late', 'ZZ no date', 'ZZ accepted']);
    assert.deepEqual(r.j.data.counts, { me: 1, team: 5, unaccepted: 4 });
    const row = r.j.data.tasks[0];
    assert.equal(row.giver_name, 'ZZ Giver'); assert.equal(row.giver_team_name, 'ZZ team 1'); assert.equal(row.handoff_to_employee_name, 'ZZ Me');
    const read = s.calls.find(c => c.p.startsWith('/rest/v1/tasks?handoff_to_department_id=not.is.null'));
    assert.match(read.p, new RegExp(`or=\\(handoff_to_employee_id\\.eq\\.${MEE},handoff_to_department_id\\.eq\\.${D2}\\)`));
    assert.match(read.p, /archived_at=is\.null/); assert.match(read.p, /status=in\.\(not_started,in_progress,blocked\)/);
    r = await run(stub({ dept: D2, tasks, archivedSpaces: [U(23)] }), { get: { action: 'getIncoming', scope: 'me' } });
    assert.deepEqual(r.j.data.tasks.map(t => t.title), ['ZZ named early']);
    r = await run(stub({ dept: D3, tasks, archivedSpaces: [U(23)] }), { get: { action: 'getIncoming', scope: 'team' } });
    assert.deepEqual(r.j.data.tasks.map(t => t.title), ['ZZ elsewhere']);   // D3's; T2 names MEE but that is "me", not team
    r = await run(stub({ dept: D2, tasks, members: [FND] }), { get: { action: 'getIncoming', scope: 'team' } });
    assert.ok(r.j.data.tasks.some(t => t.title === 'ZZ founders'));        // a member sees the Founders' one
    r = await run(stub({ dept: D2, tasks }), { get: { action: 'getIncoming', scope: 'everyone' } });
    assert.equal(r.status, 400); assert.equal(r.j.error, 'bad_scope');
  } finally { delete SPACES[U(23)]; }
});

// ── the review pack ──
const PACK_TASKS = [
  T(1, { title: 'ZZ unowned out', deadline: at(addD(WE, 3)), handoff_to_department_id: D2 }),
  T(2, { title: 'ZZ overdue accepted', deadline: at(addD(WS, -10)), handoff_to_department_id: D2, handoff_to_employee_id: RE, handoff_accepted_at: 'x', handoff_accepted_by: U(7) }),
  // P3a: a plan admin opens every team space, so the hand-off counted-only is in someone's personal space
  T(3, { title: 'ZZ secret ho', task_no: 'DKT-SECRET', deadline: at(addD(WS, -3)), handoff_to_department_id: D3, space_id: PERS9 }),
  T(4, { title: 'ZZ founders ho', task_no: 'DKT-FND', deadline: at(addD(WE, 2)), handoff_to_department_id: D2, space_id: FND }),
  T(5, { title: 'ZZ owned later', deadline: at(addD(WE, 4)), handoff_to_department_id: D2, handoff_to_employee_id: RE, handoff_accepted_at: 'x', handoff_accepted_by: U(7) }),
];
test('pack (plan admin, all teams): unowned / overdue per team, out on the giver, in on the receiver; a personal-space one counted only; Founders\' never in Slack', async () => {
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

test('pack (the receiving team\'s member, own team): sees the team-space hand-off given TO them, never the Founders\' or private one', async () => {
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
  // a bystander team (D3) sees none of D1→D2's — but (P3a) it IS the receiver of DKT-SECRET, which it now sees though
  // that space isn't theirs (involvement opens a task anywhere but the Founders' space)
  const r3 = await run(stub({ dept: D3, tasks: PACK_TASKS }), { get: { action: 'getReviewPack' } });
  assert.equal(r3.status, 200, JSON.stringify(r3.j));
  const h3 = r3.j.data.teams[0].handoffs;
  assert.deepEqual([h3.unowned, h3.overdue.map(h => [h.title, h.direction])], [[], [['ZZ secret ho', 'in']]]);
  assert.doesNotMatch(JSON.stringify(r3.j.data), /ZZ unowned out|ZZ overdue accepted|ZZ founders ho/);
});

// ── the founders' page ──
test('getFoundersReview: open cross-team hand-offs this week or next, not owned; a team-space one listed, a personal-space one adds to hidden_asks; a Slack block', async () => {
  const tasks = [
    T(1, { title: 'ZZ land this', deadline: at(addD(WE, 3)), handoff_to_department_id: D2 }),
    T(2, { title: 'ZZ named not accepted', deadline: at(addD(WS, 1)), handoff_to_department_id: D2, handoff_to_employee_id: RE }),
    T(3, { title: 'ZZ owned', deadline: at(addD(WE, 2)), handoff_to_department_id: D2, handoff_to_employee_id: RE, handoff_accepted_at: 'x', handoff_accepted_by: U(7) }),
    T(4, { title: 'ZZ secret ho', deadline: at(addD(WE, 2)), handoff_to_department_id: D2, space_id: PERS9 }),   // P3a: personal = hidden
    T(5, { title: 'ZZ plain task', deadline: at(addD(WE, 2)) }),
    T(6, { title: 'ZZ team space ho', deadline: at(addD(WE, 4)), handoff_to_department_id: D2, space_id: PRIV }),  // P3a: a team space = listed
  ];
  const s = stub({ superAdmin: true, dept: D1, tasks });
  const r = await run(s, { get: { action: 'getFoundersReview' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const d = r.j.data;
  assert.deepEqual(d.handoffs.map(h => h.title), ['ZZ named not accepted', 'ZZ land this', 'ZZ team space ho']);
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
  s = stub({ dept: D2, members: [HOMEOK] });
  await run(s, { post: { action: 'createTask', data: { title: 'ZZ b', owner_employee_id: OE, department_id: D3, space_id: HOMEOK } } });
  assert.equal(s.posted[0].department_id, D3);                                                       // explicit team wins
  s = stub({ dept: D2 });                                                                            // P3b review #4: another team,
  r = await run(s, { post: { action: 'createTask', data: { title: 'ZZ b2', owner_employee_id: OE, department_id: D3 } } });   // no space
  assert.equal(r.status, 422); assert.equal(r.j.error, 'team_space_closed'); assert.equal(s.posted.length, 0);   // it can open → refused
  s = stub({ dept: D2, members: [HOMEOK] });
  await run(s, { post: { action: 'createTask', data: { title: 'ZZ c', space_id: HOMEOK } } });
  assert.equal(s.posted[0].owner_employee_id, null); assert.equal(s.posted[0].department_id, null);  // a team space: stays blank (The Grid)
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

// ── P1 team shares (migration 0034) ──
const FND2 = U(26);   // a Founders' space ME owns (to reach the founders_space refusal, not the owner gate)
SPACES[FND2] = { id: FND2, name: 'ZZ founders mine', is_default: false, is_private: true, owner_user_id: ME, is_founders: true };

test('a space shared with my team opens like membership: getTask, sidebar, bulk; another team or an exited login gets nothing', async () => {
  const task = T(1, { space_id: PRIV });
  const teams = { [PRIV]: [D2] };
  let r = await run(stub({ dept: D2, tasks: [task], teams }), { get: { action: 'getTask', id: U(101) } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  r = await run(stub({ dept: D1, tasks: [task], teams }), { get: { action: 'getTask', id: U(101) } });
  assert.equal(r.status, 404);                                                                       // another team
  r = await run(stub({ dept: D2, tasks: [task], teams, exited: true }), { get: { action: 'getTask', id: U(101) } });
  assert.equal(r.status, 404);                                                                       // exited: no team
  r = await run(stub({ dept: D2, teams }), { get: { action: 'getSpaces' } });
  assert.ok(r.j.data.some(x => x.id === PRIV), JSON.stringify(r.j));
  assert.equal(r.j.data.find(x => x.id === PRIV).is_owner, false);
  r = await run(stub({ dept: D1, teams }), { get: { action: 'getSpaces' } });
  assert.ok(!r.j.data.some(x => x.id === PRIV));
  // the task is one I CREATED (I edit it) but don't own: P3a's involvement (owner / assignee / receiver / collaborator)
  // would open it without the share, and creating is not involvement
  let s = stub({ dept: D2, tasks: [T(1, { space_id: PRIV, created_by_user_id: ME })], teams });
  r = await run(s, { post: { action: 'bulkUpdateTasks', ids: [U(101)], field: 'priority', value: 'P1' } });
  assert.equal(r.j.data.updated, 1, JSON.stringify(r.j)); assert.equal(r.j.data.skipped, 0);
  s = stub({ dept: D1, tasks: [T(1, { space_id: PRIV, created_by_user_id: ME })], teams });
  r = await run(s, { post: { action: 'bulkUpdateTasks', ids: [U(101)], field: 'priority', value: 'P1' } });
  assert.equal(r.j.data.updated, 0); assert.equal(r.j.data.skipped, 1);
});

test('shareSpaceWithTeam / unshareSpaceTeam: owner only, never Founders or General, a real team; logged', async () => {
  let s = stub({ dept: D2 });
  let r = await run(s, { post: { action: 'shareSpaceWithTeam', space_id: MYSP, department_id: D3 } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(s.teamWrites.map(w => [w.method, w.body?.space_id, w.body?.department_id, w.body?.added_by_user_id]), [['POST', MYSP, D3, ME]]);
  assert.ok(s.spaceLog.some(l => l.action === 'team_shared' && l.note.includes('ZZ team 3')));
  assert.equal(r.j.data.added, true);
  s = stub({ dept: D2, teams: { [MYSP]: [D3] } });   // already shared: no change, no history row
  r = await run(s, { post: { action: 'shareSpaceWithTeam', space_id: MYSP, department_id: D3 } });
  assert.equal(r.status, 200); assert.equal(r.j.data.added, false); assert.equal(s.spaceLog.length, 0);
  s = stub({ dept: D2 });   // never shared: unshare changes nothing, logs nothing
  r = await run(s, { post: { action: 'unshareSpaceTeam', space_id: MYSP, department_id: D3 } });
  assert.equal(r.status, 200); assert.equal(r.j.data.removed, false); assert.equal(s.spaceLog.length, 0);
  const bad = [
    [{ space_id: PRIV, department_id: D3 }, 403, 'forbidden_space_owner'],   // not mine
    [{ space_id: FND2, department_id: D3 }, 403, 'founders_space'],
    [{ space_id: GEN, department_id: D3 }, 422, 'general_is_system'],
    [{ space_id: MYSP, department_id: U(77) }, 422, 'unknown team'],
    [{ space_id: MYSP, department_id: 'Sales' }, 400, 'invalid department_id'],
    [{ space_id: MYSP }, 400, 'space_id and department_id required'],
  ];
  for (const [o, st, e] of bad) {
    s = stub({ dept: D2 });
    r = await run(s, { post: { action: 'shareSpaceWithTeam', ...o } });
    assert.equal(r.status, st, JSON.stringify(o)); assert.equal(r.j.error, e, JSON.stringify(o)); assert.equal(s.teamWrites.length, 0);
  }
  s = stub({ dept: D2, teams: { [MYSP]: [D3] } });
  r = await run(s, { post: { action: 'unshareSpaceTeam', space_id: MYSP, department_id: D3 } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(s.teamWrites[0].method, 'DELETE'); assert.ok(s.spaceLog.some(l => l.action === 'team_unshared' && l.note.includes('ZZ team 3')));
  s = stub({ dept: D2, teams: { [PRIV]: [D2] } });   // a team member is not the owner
  r = await run(s, { post: { action: 'unshareSpaceTeam', space_id: PRIV, department_id: D2 } });
  assert.equal(r.status, 403); assert.equal(s.teamWrites.length, 0);
});

test('getSpaceTeams names the teams for anyone with access; a team share makes my space not personal', async () => {
  let r = await run(stub({ dept: D2, teams: { [PRIV]: [D2, D3] } }), { get: { action: 'getSpaceTeams', space_id: PRIV } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.data.map(t => t.name), ['ZZ team 2', 'ZZ team 3']);
  r = await run(stub({ dept: D1, teams: { [PRIV]: [D2] } }), { get: { action: 'getSpaceTeams', space_id: PRIV } });
  assert.equal(r.status, 403);
  const s = stub({ dept: D2, members: [MYSP], teams: { [MYSP]: [D3] } });
  r = await run(s, { post: { action: 'createTask', data: { title: 'ZZ t', space_id: MYSP } } });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(s.posted[0].owner_employee_id, null);
});

test('a stray team row on the Founders\' space opens nothing: getTask, sidebar, bulk all refuse', async () => {
  const teams = { [FND]: [D2] };
  const task = T(1, { space_id: FND, owner_employee_id: MEE });
  let r = await run(stub({ dept: D2, tasks: [task], teams }), { get: { action: 'getTask', id: U(101) } });
  assert.equal(r.status, 404);
  r = await run(stub({ dept: D2, teams }), { get: { action: 'getSpaces' } });
  assert.ok(!r.j.data.some(x => x.id === FND), JSON.stringify(r.j));
  r = await run(stub({ dept: D2, tasks: [task], teams }), { post: { action: 'bulkUpdateTasks', ids: [U(101)], field: 'priority', value: 'P1' } });
  assert.equal(r.j.data.updated, 0); assert.equal(r.j.data.skipped, 1);
  r = await run(stub({ dept: D2, tasks: [task], teams, members: [FND] }), { get: { action: 'getTask', id: U(101) } });
  assert.equal(r.status, 200, JSON.stringify(r.j));                                                  // a named member still opens it
});

// ── P2 personal spaces (migration 0036) ──
test('P3b create routing: no space + the owner\'s team has a home space the caller can open → that space', async () => {
  const s = stub({ dept: D2, homes: { [D1]: HOMEOK }, members: [HOMEOK] });
  const r = await run(s, { post: { action: 'createTask', data: { title: 'ZZ p', owner_employee_id: OE } } });   // OE is in D1
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(s.posted[0].space_id, HOMEOK); assert.equal(r.j.data.space_is_personal, false);
  assert.ok(!s.calls.some(c => c.p.includes('ensure_personal_space')));
  const s2 = stub({ dept: D2, homes: { [D3]: HOMEOK }, members: [HOMEOK] });                                   // an explicit team wins over the owner's
  await run(s2, { post: { action: 'createTask', data: { title: 'ZZ p2', owner_employee_id: OE, department_id: D3 } } });
  assert.equal(s2.posted[0].space_id, HOMEOK);
});

test('P3b create routing: the team has a home space the caller CANNOT open → the caller\'s Personal', async () => {
  const s = stub({ dept: D2, homes: { [D1]: HOMENO } });
  const r = await run(s, { post: { action: 'createTask', data: { title: 'ZZ p', owner_employee_id: OE } } });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(s.posted[0].space_id, PERS); assert.equal(r.j.data.space_is_personal, true);
});

test('P3b create routing: no team / no home space → the caller\'s Personal', async () => {
  for (const o of [{}, { assign_self: true }, { owner_employee_id: MEE }, { owner_employee_id: OE }, { owner_employee_id: NOD }, { department_id: D2 }]) {
    const s = stub({ dept: D2 });   // no home spaces anywhere
    const r = await run(s, { post: { action: 'createTask', data: { title: 'ZZ p', ...o } } });
    assert.equal(r.status, 200, JSON.stringify([o, r.j]));
    assert.equal(s.posted[0].space_id, PERS, JSON.stringify(o)); assert.equal(r.j.data.space_is_personal, true);
  }
});

test('P3b create routing: an explicit space_id still wins over a home space', async () => {
  const s = stub({ dept: D2, homes: { [D1]: HOMEOK, [D2]: HOMEOK }, members: [HOMEOK, PRIV] });
  const r = await run(s, { post: { action: 'createTask', data: { title: 'ZZ p', owner_employee_id: OE, space_id: PRIV } } });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(s.posted[0].space_id, PRIV);
  assert.ok(!s.calls.some(c => c.p.includes('home_department_id') || c.p.includes('ensure_personal_space')));
});

test('P3b create routing: a sub-task still takes its parent\'s space, not the home space or Personal', async () => {
  const s = stub({ dept: D2, homes: { [D1]: HOMEOK, [D2]: HOMEOK }, members: [HOMEOK, PRIV], tasks: [T(1, { owner_employee_id: MEE, department_id: D2, space_id: PRIV })] });
  const r = await run(s, { post: { action: 'createSubtask', data: { title: 'ZZ sub', parent_task_id: U(101) } } });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(s.posted[0].space_id, PRIV);
  assert.ok(!s.calls.some(c => c.p.includes('home_department_id') || c.p.includes('ensure_personal_space')));
});

test('moving into a personal space: only a task family that is just mine; bulk skips and names the rest', async () => {
  const mine = (n, o) => T(n, { owner_employee_id: MEE, department_id: D2, created_by_user_id: ME, ...o });
  let s = stub({ dept: D2, tasks: [mine(1)] });
  let r = await run(s, { post: { action: 'moveTask', id: U(101), space_id: PERS } });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.ok(s.patches.some(x => x.body.space_id === PERS));
  const bad = [
    [mine(1, { owner_employee_id: OE }), [], []],                       // someone else's
    [mine(1, { owner_employee_id: null }), [], []],                     // ownerless (The Grid)
    [mine(1, { department_id: D3 }), [], []],                           // another team's
    [mine(1, { handoff_to_department_id: D1 }), [], []],                // a hand-off
    [mine(1, { plan_item_id: U(90) }), [], []],                         // plan-linked
    [mine(1, { program_id: U(91) }), [], []],                           // in a program
    [mine(1), [mine(2, { parent_task_id: U(101), owner_employee_id: OE })], []],   // a sub-task that isn't mine
    [mine(1), [], [U(101)]],                                            // someone collaborates
  ];
  for (const [t, extra, collabs] of bad) {
    s = stub({ dept: D2, tasks: [t, ...extra], collabs });
    r = await run(s, { post: { action: 'moveTask', id: U(101), space_id: PERS } });
    assert.equal(r.status, 422, JSON.stringify(t)); assert.equal(r.j.error, 'personal_space_not_yours');
    assert.equal(s.patches.length, 0);
  }
  s = stub({ dept: D2, tasks: [mine(1), mine(2, { owner_employee_id: OE })] });
  r = await run(s, { post: { action: 'bulkMoveTasks', ids: [U(101), U(102)], space_id: PERS } });
  assert.equal(r.j.data.updated, 1, JSON.stringify(r.j)); assert.deepEqual(r.j.data.personal_space, ['DKT-2']);
  s = stub({ dept: D2, tasks: [mine(1, { owner_employee_id: OE })] });   // moving into a NORMAL space is unchanged
  r = await run(s, { post: { action: 'moveTask', id: U(101), space_id: MYSP } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
});

test('a personal space is never shared, transferred, archived or recovered; getMe makes one when missing', async () => {
  for (const [action, body] of [
    ['addSpaceMember', { space_id: PERS, user_id: U(8) }], ['shareSpaceWithTeam', { space_id: PERS, department_id: D3 }],
    ['transferSpaceOwnership', { space_id: PERS, new_owner_user_id: U(8) }], ['archiveSpace', { id: PERS }],
  ]) {
    const s = stub({ dept: D2, members: [PERS] });
    const r = await run(s, { post: { action, ...body } });
    assert.equal(r.status, 422, action); assert.equal(r.j.error, 'personal_space', action);
    assert.equal(s.teamWrites.length, 0); assert.ok(!s.calls.some(c => c.method !== 'GET' && /space_members|spaces\?id=eq/.test(c.p)), action);
  }
  let s = stub({ dept: D2 });
  let r = await run(s, { get: { action: 'getMe' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.ok(r.j.data.spaces.some(x => x.id === PERS && x.is_personal && x.is_owner));
  assert.ok(!s.calls.some(c => c.p.includes('ensure_personal_space')));                              // already listed: no RPC
  s = stub({ dept: D2, hidePersonal: true });   // none yet: getMe makes it (once) and lists it
  r = await run(s, { get: { action: 'getMe' } });
  assert.equal(s.calls.filter(c => c.p.includes('ensure_personal_space')).length, 1);
  assert.ok(r.j.data.spaces.some(x => x.id === PERS && x.is_personal), JSON.stringify(r.j.data.spaces));
  // isPersonalSpace: THE personal space defaults owner = me even before the member read
  s = stub({ dept: D2 });
  r = await run(s, { post: { action: 'createTask', data: { title: 'ZZ s', space_id: PERS } } });
  assert.equal(s.posted[0].owner_employee_id, MEE);
});

// ── P3a: involvement visibility (Afshaan 2026-11-13; migration 0037 carries the same rule into the SQL lists) ──
// Involvement (owner / assignee / collaborator / hand-off receiver) opens THAT task in any space but the Founders'
// space, without the space; a plan admin opens every team space, never a personal one.
const INV = {
  owner: [{ owner_employee_id: MEE }, {}],
  assignee: [{ assignee_employee_id: MEE }, {}],
  collaborator: [{}, { collabs: [U(101)] }],
  receiver: [{ handoff_to_department_id: D2 }, {}],
};
test('P3a: owner / assignee / collaborator / receiver opens a private-space task they are not a member of — not its sibling', async () => {
  for (const [who, [o, extra]] of Object.entries(INV)) {
    const tasks = [T(1, { space_id: PRIV, ...o }), T(2, { space_id: PRIV, title: 'ZZ sibling' })];
    let r = await run(stub({ dept: D2, tasks, ...extra }), { get: { action: 'getTask', id: U(101) } });
    assert.equal(r.status, 200, `${who} ${JSON.stringify(r.j)}`);
    assert.equal(r.j.data.id, U(101), who); assert.equal(r.j.data.space.id, PRIV, who);
    assert.equal(r.j.data._can_edit, who === 'owner' || who === 'assignee', who);   // edit rights unchanged
    r = await run(stub({ dept: D2, tasks, ...extra }), { get: { action: 'getTask', id: U(102) } });
    assert.equal(r.status, 404, who); assert.equal(r.j.error, 'not_found', who);
    r = await run(stub({ dept: D2, tasks, ...extra }), { get: { action: 'getTaskLinks', id: U(101) } });
    assert.equal(r.status, 200, who);
    // the space stays out of their sidebar
    r = await run(stub({ dept: D2, tasks, ...extra }), { get: { action: 'getSpaces' } });
    assert.equal(r.status, 200); assert.ok(r.j.data.some(x => x.id === G) && !r.j.data.some(x => x.id === PRIV), who);
  }
  // nobody involved → still 404 (a collaborator on ANOTHER task proves nothing here)
  const r = await run(stub({ dept: D2, tasks: [T(1, { space_id: PRIV })], collabs: [U(102)] }), { get: { action: 'getTask', id: U(101) } });
  assert.equal(r.status, 404);
});

test('P3a: an involvement-only viewer sees the parent and sub-tasks only where involved in them too', async () => {
  const tasks = [T(1, { space_id: PRIV, title: 'ZZ parent' }), T(2, { space_id: PRIV, parent_task_id: U(101), owner_employee_id: MEE, title: 'ZZ mine' }),
    T(3, { space_id: PRIV, parent_task_id: U(102), title: 'ZZ grand hidden' }), T(4, { space_id: PRIV, parent_task_id: U(102), title: 'ZZ grand collab' }),
    T(5, { space_id: PRIV, parent_task_id: U(102), assignee_employee_id: MEE, title: 'ZZ grand assigned' })];
  let r = await run(stub({ dept: D2, tasks, collabs: [U(104)] }), { get: { action: 'getTask', id: U(102) } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.data.parent, null);                                                               // the parent isn't theirs
  assert.deepEqual(r.j.data.children.map(c => c.title), ['ZZ grand collab', 'ZZ grand assigned']);
  assert.deepEqual([r.j.data.child_count, r.j.data.child_done], [2, 0]);
  assert.doesNotMatch(JSON.stringify(r.j.data), /ZZ parent|ZZ grand hidden/);
  // involved in the parent too → its crumb shows
  r = await run(stub({ dept: D2, tasks, collabs: [U(101), U(104)] }), { get: { action: 'getTask', id: U(102) } });
  assert.equal(r.status, 200); assert.equal(r.j.data.parent?.title, 'ZZ parent');
  // a member sees the whole family, as before
  r = await run(stub({ dept: D2, tasks, members: [PRIV] }), { get: { action: 'getTask', id: U(102) } });
  assert.equal(r.status, 200); assert.equal(r.j.data.parent?.title, 'ZZ parent');
  assert.deepEqual(r.j.data.children.map(c => c.title), ['ZZ grand hidden', 'ZZ grand collab', 'ZZ grand assigned']);
});

test('P3a: the Founders\' space stays sealed — the same involved people get 404 by id, in bulk and in Incoming', async () => {
  for (const [who, [o, extra]] of Object.entries(INV)) {
    const tasks = [T(1, { space_id: FND, ...o })];
    let r = await run(stub({ dept: D2, tasks, ...extra }), { get: { action: 'getTask', id: U(101) } });
    assert.equal(r.status, 404, who); assert.equal(r.j.error, 'not_found', who);
    const s = stub({ dept: D2, tasks, ...extra });
    r = await run(s, { post: { action: 'addComment', id: U(101), body: 'ZZ hi' } });
    assert.equal(r.status, 404, who); assert.ok(!s.calls.some(c => c.method === 'POST' && c.p.startsWith('/rest/v1/task_comments')), who);
    r = await run(stub({ dept: D2, tasks, ...extra }), { post: { action: 'bulkUpdateTasks', ids: [U(101)], field: 'priority', value: 'P1' } });
    assert.equal(r.status, 200); assert.deepEqual([r.j.data.updated, r.j.data.skipped], [0, 1], who);
  }
  const r = await run(stub({ dept: D2, tasks: [T(1, { space_id: FND, handoff_to_department_id: D2 })] }), { get: { action: 'getIncoming' } });
  assert.equal(r.status, 200); assert.deepEqual(r.j.data.counts, { me: 0, team: 0, unaccepted: 0 });
});

test('P3a: an involved collaborator comments on a private-space task (seesTask); a non-involved one is 404', async () => {
  let s = stub({ dept: D2, tasks: [T(1, { space_id: PRIV })], collabs: [U(101)] });
  let r = await run(s, { post: { action: 'addComment', id: U(101), body: 'ZZ hi' } });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.ok(s.calls.some(c => c.method === 'POST' && c.p.startsWith('/rest/v1/task_comments')));
  r = await run(stub({ dept: D2, tasks: [T(1, { space_id: PRIV })], collabs: [U(101)] }), { post: { action: 'changeStatus', id: U(101), status: 'done' } });
  assert.equal(r.status, 403); assert.equal(r.j.error, 'forbidden');                               // a collaborator still doesn't edit
  s = stub({ dept: D2, tasks: [T(1, { space_id: PRIV })] });
  r = await run(s, { post: { action: 'addComment', id: U(101), body: 'ZZ hi' } });
  assert.equal(r.status, 404); assert.ok(!s.calls.some(c => c.method === 'POST' && c.p.startsWith('/rest/v1/task_comments')));
  s = stub({ dept: D2, tasks: [T(1, { space_id: PRIV, owner_employee_id: MEE })] });               // the owner edits, as everywhere
  r = await run(s, { post: { action: 'changeStatus', id: U(101), status: 'done' } });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(s.patches.length, 1);
});

test('P3b: a view-all holder (not a plan admin) READS every team space — never the Founders\' or a personal one — and can\'t add to it', async () => {
  const VA = { docket_view_all: true };
  let r = await run(stub({ superAdmin: true, perms: VA, dept: D1 }), { get: { action: 'getSpaces' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const ids = r.j.data.map(x => x.id);
  assert.ok(ids.includes(PRIV), JSON.stringify(ids));
  assert.ok(!ids.includes(FND) && !ids.includes(PERS9) && !ids.includes(ARCH), JSON.stringify(ids));
  const tasks = [T(1, { space_id: PRIV }), T(2, { space_id: PERS9 }), T(3, { space_id: FND })];
  r = await run(stub({ superAdmin: true, perms: VA, dept: D1, tasks }), { get: { action: 'getTask', id: U(101) } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  for (const id of [U(102), U(103)]) {
    r = await run(stub({ superAdmin: true, perms: VA, dept: D1, tasks }), { get: { action: 'getTask', id } });
    assert.equal(r.status, 404, id);
  }
  // read, not write: no create / move into a team space they only read; docket_admin (implies view_all) the same
  for (const perms of [VA, { docket_admin: true }]) {
    let s = stub({ superAdmin: true, perms, dept: D1 });
    r = await run(s, { post: { action: 'createTask', data: { title: 'ZZ va', space_id: PRIV } } });
    assert.equal(r.status, 403, JSON.stringify(r.j)); assert.equal(r.j.error, 'forbidden_space'); assert.equal(s.posted.length, 0);
    s = stub({ superAdmin: true, perms, dept: D1, tasks: [T(4, { space_id: G, created_by_user_id: ME })] });
    r = await run(s, { post: { action: 'moveTask', id: U(104), space_id: PRIV } });
    assert.equal(r.status, 403, JSON.stringify(r.j));
  }
});

test('P3a: a plan admin lists every team space and opens its task; never someone\'s personal space', async () => {
  let r = await run(stub({ superAdmin: true, dept: D1 }), { get: { action: 'getSpaces' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const ids = r.j.data.map(x => x.id);
  assert.ok(ids.includes(PRIV) && ids.includes(FND), JSON.stringify(ids));
  assert.ok(!ids.includes(PERS9) && !ids.includes(ARCH), JSON.stringify(ids));
  assert.equal(r.j.data.find(x => x.id === PRIV).is_owner, false);
  r = await run(stub({ dept: D1 }), { get: { action: 'getSpaces' } });                              // not a plan admin: unchanged
  assert.ok(!r.j.data.some(x => x.id === PRIV || x.id === FND), JSON.stringify(r.j.data));
  const tasks = [T(1, { space_id: PRIV }), T(2, { space_id: PERS9 })];
  r = await run(stub({ superAdmin: true, dept: D1, tasks }), { get: { action: 'getTask', id: U(101) } });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(r.j.data.space.id, PRIV);
  r = await run(stub({ superAdmin: true, dept: D1, tasks }), { get: { action: 'getTask', id: U(102) } });
  assert.equal(r.status, 404); assert.equal(r.j.error, 'not_found');
  r = await run(stub({ superAdmin: true, dept: D1, tasks }), { get: { action: 'getSpaceTeams', space_id: PRIV } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  r = await run(stub({ superAdmin: true, dept: D1, tasks }), { get: { action: 'getSpaceTeams', space_id: PERS9 } });
  assert.equal(r.status, 403);
  // a plan admin's bulk gate: the team-space row is kept (the edit rule then decides), the personal one skipped
  const s = stub({ superAdmin: true, dept: D1, tasks: [T(1, { space_id: PRIV, created_by_user_id: ME }), T(2, { space_id: PERS9, created_by_user_id: ME })] });
  r = await run(s, { post: { action: 'bulkUpdateTasks', ids: [U(101), U(102)], field: 'priority', value: 'P1' } });
  assert.equal(r.status, 200); assert.deepEqual([r.j.data.updated, r.j.data.skipped], [1, 1], JSON.stringify(r.j));
});

test('P3a: bulk ops keep the rows a caller is involved in (keepAccessible), skip the sibling', async () => {
  for (const [who, [o, extra]] of Object.entries({ owner: INV.owner, assignee: INV.assignee })) {
    const s = stub({ dept: D2, tasks: [T(1, { space_id: PRIV, ...o }), T(2, { space_id: PRIV })], ...extra });
    const r = await run(s, { post: { action: 'bulkUpdateTasks', ids: [U(101), U(102)], field: 'priority', value: 'P1' } });
    assert.equal(r.status, 200, who); assert.deepEqual([r.j.data.updated, r.j.data.skipped], [1, 1], `${who} ${JSON.stringify(r.j)}`);
    const pp = s.patches.find(x => x.p.startsWith('/rest/v1/tasks?id=in.'));
    assert.ok(pp, who); assert.deepEqual(inIds(new URL('https://x' + pp.p).searchParams.get('id')), [U(101)], who);
  }
  // the owner abandons theirs in bulk
  const s = stub({ dept: D2, tasks: [T(1, { space_id: PRIV, owner_employee_id: MEE }), T(2, { space_id: PRIV })] });
  const r = await run(s, { post: { action: 'bulkAbandonTasks', ids: [U(101), U(102)], reason: 'ZZ' } });
  assert.deepEqual([r.j.data.updated, r.j.data.skipped], [1, 1], JSON.stringify(r.j));
});

// keepAccessible's batched collaborator branch, through a READ path (the review pack → visibleTaskRows → keepAccessible):
// a hand-off my team GIVES, in a private space I'm not in, that I only collaborate on — listed when the collaborator
// read says so, absent without it, absent when that read fails (fail closed).
// (only the caller's own collaborator reads — `employee_id=eq.` — fail; the hydration's names read stays up)
const failCollabIn = (s) => { const real = s.fn; s.fn = async (input, init) => (/\/task_collaborators\?task_id=in\.[^&]*&employee_id=eq\./.test(decodeURIComponent(String(typeof input === 'string' ? input : input.url)))
  ? new Response('{"message":"zz down"}', { status: 500, headers: { 'content-type': 'application/json' } }) : real(input, init)); return s; };
test('P3a: keepAccessible\'s collaborator branch on a read path — the review pack lists a private-space hand-off I collaborate on; not without, not on a failed read', async () => {
  const tasks = [T(1, { title: 'ZZ collab out', space_id: PRIV, department_id: D2, handoff_to_department_id: D3, deadline: at(addD(WE, 3)) })];
  let r = await run(stub({ dept: D2, tasks, collabs: [U(101)] }), { get: { action: 'getReviewPack' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.data.teams[0].handoffs.unowned.map(h => [h.title, h.direction]), [['ZZ collab out', 'out']]);
  r = await run(stub({ dept: D2, tasks }), { get: { action: 'getReviewPack' } });
  assert.equal(r.status, 200); assert.deepEqual(r.j.data.teams[0].handoffs.unowned, []);
  r = await run(failCollabIn(stub({ dept: D2, tasks, collabs: [U(101)] })), { get: { action: 'getReviewPack' } });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.deepEqual(r.j.data.teams[0].handoffs.unowned, []);
  assert.doesNotMatch(JSON.stringify(r.j.data), /ZZ collab out/);
});

test('P3a: an involvement-only viewer can\'t move the task — single or bulk; a member still can', async () => {
  const own = () => T(1, { space_id: PRIV, owner_employee_id: MEE, created_by_user_id: ME });
  for (const target of [G, MYSP]) {
    const s = stub({ dept: D2, tasks: [own()], members: [MYSP] });
    const r = await run(s, { post: { action: 'moveTask', id: U(101), space_id: target } });
    assert.equal(r.status, 403, target); assert.equal(r.j.error, 'forbidden_space', target); assert.equal(s.patches.length, 0, target);
  }
  let s = stub({ dept: D2, tasks: [own(), T(2, { owner_employee_id: MEE })], members: [MYSP] });
  let r = await run(s, { post: { action: 'bulkMoveTasks', ids: [U(101), U(102)], space_id: MYSP } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual([r.j.data.updated, r.j.data.skipped], [1, 1], JSON.stringify(r.j));               // DKT-2 (team space G) moves; DKT-1 skipped
  const mv = s.patches.filter(x => x.body.space_id && x.p.startsWith('/rest/v1/tasks?id=in.'));
  assert.equal(mv.length, 1); assert.deepEqual(inIds(new URL('https://x' + mv[0].p).searchParams.get('id')), [U(102)]);
  s = stub({ dept: D2, tasks: [own()], members: [PRIV, HOMEOK] });                                  // a member moves it
  r = await run(s, { post: { action: 'moveTask', id: U(101), space_id: HOMEOK } });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.ok(s.patches.some(x => x.body.space_id === HOMEOK));
  // nor can the involvement-only owner put a sub-task under it from outside (the space isn't theirs)
  s = stub({ dept: D2, tasks: [own()] });
  r = await run(s, { post: { action: 'createSubtask', data: { title: 'ZZ sub', parent_task_id: U(101) } } });
  assert.equal(r.status, 403); assert.equal(r.j.error, 'forbidden_space'); assert.equal(s.posted.length, 0);
});

test('P3a: a plan admin never opens an ARCHIVED team space, nor a space row missing is_personal (fail closed)', async () => {
  const tasks = [T(1, { space_id: ARCHT }), T(2, { space_id: PRIV })];
  let r = await run(stub({ superAdmin: true, dept: D1, tasks }), { get: { action: 'getTask', id: U(101) } });
  assert.equal(r.status, 404); assert.equal(r.j.error, 'not_found');
  r = await run(stub({ superAdmin: true, dept: D1, tasks }), { get: { action: 'getTasks', space_id: ARCHT } });
  assert.equal(r.status, 403); assert.equal(r.j.error, 'forbidden_space');
  r = await run(stub({ superAdmin: true, dept: D1, tasks }), { get: { action: 'getTasks', space_id: PRIV } });   // a live team space: open
  assert.equal(r.status, 200, JSON.stringify(r.j));
  r = await run(stub({ superAdmin: true, dept: D1, tasks, members: [ARCHT] }), { get: { action: 'getTask', id: U(101) } });
  assert.equal(r.status, 200, JSON.stringify(r.j));                                                  // a member still opens it by id
  const NOF = U(30);
  SPACES[NOF] = { id: NOF, name: 'ZZ no field', is_default: false, is_private: true, owner_user_id: U(9), is_founders: false, archived_at: null };
  try {
    r = await run(stub({ superAdmin: true, dept: D1, tasks: [T(3, { space_id: NOF })] }), { get: { action: 'getTask', id: U(103) } });
    assert.equal(r.status, 404);
  } finally { delete SPACES[NOF]; }
});

test('P3a: a plan admin SEES a team space but doesn\'t edit others\' comments or records there; real rights (a team share, a membership) still do', async () => {
  const cmt = (task) => ({ id: U(600), task_id: task, author_user_id: U(8), body: 'ZZ c', deleted_at: null });
  const rec = (space) => ({ id: U(700), template_id: U(701), template_version: 1, title: 'ZZ rec', product: null, space_id: space,
    owner_employee_id: OE, status: 'open', created_by_user_id: U(8), created_at: 'x', updated_at: null, completed_at: null, archived_at: null });
  for (const [where, space, extra, ok] of [['team space', PRIV, {}, false], ['team space, team share', G, {}, true], ['team space, member', PRIV, { members: [PRIV] }, true]]) {
    const tasks = [T(1, { space_id: space })];
    for (const action of ['editComment', 'deleteComment']) {
      const s = stub({ superAdmin: true, dept: D1, tasks, comments: [cmt(U(101))], ...extra });
      const r = await run(s, { post: { action, comment_id: U(600), body: 'ZZ edited' } });
      assert.equal(r.status, ok ? 200 : 403, `${action} ${where} ${JSON.stringify(r.j)}`);
      assert.equal(s.calls.some(c => c.method === 'PATCH' && c.p.startsWith('/rest/v1/task_comments')), ok, `${action} ${where}`);
    }
    const s = stub({ superAdmin: true, dept: D1, records: [rec(space)], ...extra });
    const r = await run(s, { post: { action: 'updateChecklistRecord', id: U(700), title: 'ZZ renamed' } });
    assert.equal(r.status, ok ? 200 : 403, `record ${where} ${JSON.stringify(r.j)}`);
    assert.equal(s.calls.some(c => c.method === 'PATCH' && c.p.startsWith('/rest/v1/checklist_records')), ok, `record ${where}`);
  }
  // ...but they still open (see) that team-space task and its comments
  const r = await run(stub({ superAdmin: true, dept: D1, tasks: [T(1, { space_id: PRIV })] }), { get: { action: 'getTask', id: U(101) } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
});

test('P3a: the stale sweep lists my own stale tasks in spaces I\'m not in — never the Founders\' or an archived one', async () => {
  const old = at('2026-01-01');
  const tasks = [T(1, { title: 'ZZ mine private', space_id: PRIV, owner_employee_id: MEE, deadline: old }),
    T(2, { title: 'ZZ mine founders', space_id: FND, owner_employee_id: MEE, deadline: old }),
    T(3, { title: 'ZZ mine archived', space_id: ARCHT, owner_employee_id: MEE, deadline: old }),
    T(4, { title: 'ZZ mine team', owner_employee_id: MEE, deadline: old }),
    T(5, { title: 'ZZ not mine', space_id: PRIV, deadline: old })];
  let s = stub({ dept: D2, tasks });
  let r = await run(s, { get: { action: 'getStaleTasks' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.data.tasks.map(t => [t.title, t.space_name]).sort(), [['ZZ mine private', 'ZZ private'], ['ZZ mine team', 'ZZ team space']]);
  assert.equal(r.j.data.total, 2);
  const read = s.calls.find(c => c.p.startsWith('/rest/v1/tasks?status=not.in.(done,abandoned)'));
  assert.doesNotMatch(read.p, /space_id=/); assert.match(read.p, new RegExp(`owner_employee_id=eq\\.${MEE}`));
  r = await run(stub({ dept: D2, tasks }), { get: { action: 'getStaleTasks', count_only: '1' } });
  assert.deepEqual(r.j.data, { total: 2 });
  r = await run(stub({ dept: D2, tasks, members: [FND] }), { get: { action: 'getStaleTasks', count_only: '1' } });
  assert.deepEqual(r.j.data, { total: 3 });                                                         // a Founders' member: theirs too
  // a parent in that space shows as a crumb only when I'm involved in it — not on a team match alone
  const fam = [T(1, { title: 'ZZ parent', space_id: PRIV, department_id: D2 }),
    T(2, { title: 'ZZ stale child', space_id: PRIV, parent_task_id: U(101), owner_employee_id: MEE, deadline: old })];
  r = await run(stub({ dept: D2, tasks: fam }), { get: { action: 'getStaleTasks' } });
  assert.deepEqual(r.j.data.tasks.map(t => [t.title, t.parent?.title || null]), [['ZZ stale child', null]]);
  r = await run(stub({ dept: D2, tasks: fam, collabs: [U(101)] }), { get: { action: 'getStaleTasks' } });
  assert.deepEqual(r.j.data.tasks.map(t => [t.title, t.parent?.title || null]), [['ZZ stale child', 'ZZ parent']]);
});

test('P3a: list hydration counts only the sub-tasks an involvement-only viewer can see (getIncoming child_count / child_done)', async () => {
  const tasks = [T(1, { title: 'ZZ ho', space_id: PRIV, handoff_to_department_id: D2 }),
    T(2, { space_id: PRIV, parent_task_id: U(101), owner_employee_id: MEE, status: 'done' }),
    T(3, { space_id: PRIV, parent_task_id: U(101), status: 'done' }),
    T(4, { space_id: PRIV, parent_task_id: U(101) }),
    T(5, { space_id: PRIV, parent_task_id: U(101) })];
  let r = await run(stub({ dept: D2, tasks, collabs: [U(105)] }), { get: { action: 'getIncoming' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.data.tasks.map(t => [t.title, t.child_count, t.child_done]), [['ZZ ho', 2, 1]]);   // T2 (mine) + T5 (collab)
  r = await run(stub({ dept: D2, tasks, members: [PRIV] }), { get: { action: 'getIncoming' } });
  assert.deepEqual(r.j.data.tasks.map(t => [t.title, t.child_count, t.child_done]), [['ZZ ho', 4, 2]]);   // a member: all of them
  r = await run(failCollabIn(stub({ dept: D2, tasks, collabs: [U(105)] })), { get: { action: 'getIncoming' } });
  assert.deepEqual(r.j.data.tasks.map(t => [t.title, t.child_count, t.child_done]), [['ZZ ho', 1, 1]]);   // failed read: only the direct one
});
