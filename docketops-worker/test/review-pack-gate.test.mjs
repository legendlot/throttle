// Run: node --test docketops-worker/test/*.test.mjs
// F9 R6a end to end against a stubbed Supabase: getReviewPack's access (own team only below plan admin;
// 403 forbidden / no_team), the task gate (a private-space row is counted for a plan admin and never shown —
// not in the rows, not in the Slack copy; a non-admin's counts drop tasks they can't open and every
// Founders'-space task), holdReview / getReviewSnapshots plan-admin only, holdReview storing a provisional
// snapshot, and X-LOT-Source stamping task_history.source + task_set_deadline's p_source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const code = readFileSync(join(SRC, 'index.js'), 'utf8').replace(/from '\.\/([^']+)'/g, (_, f) => `from '${pathToFileURL(join(SRC, f)).href}'`);
const worker = (await import('data:text/javascript,' + encodeURIComponent(code))).default;

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ME = U(1), MEE = U(2), OE = U(3), D1 = U(10), D2 = U(11), D3 = U(12), G = U(20), PRIV = U(21), FND = U(22);
// The current IST week (Sunday-ending, the default), computed so the suite doesn't rot with the calendar.
const addD = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const TODAY = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
const WE = addD(TODAY, (7 - (new Date(`${TODAY}T00:00:00Z`).getUTCDay() || 7)) % 7), WS = addD(WE, -6);
const at = (d, hhmm = '12:00') => new Date(Date.parse(`${d}T${hhmm}:00+05:30`)).toISOString();
const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_ANON_KEY: 'a' };
const SPACES = {
  [G]: { id: G, name: 'General', is_default: true, is_private: false, owner_user_id: null, is_founders: false },
  [PRIV]: { id: PRIV, name: 'ZZ private', is_default: false, is_private: true, owner_user_id: U(9), is_founders: false, is_personal: true },   // P3a: a plan admin opens every team space, so the space they can't open is someone's PERSONAL one
  [FND]: { id: FND, name: 'Founders', is_default: false, is_private: true, owner_user_id: U(9), is_founders: true },
};
const T = (n, o) => ({ id: U(100 + n), task_no: `DKT-${n}`, title: `ZZ t${n}`, status: 'in_progress', priority: 'P2', owner_employee_id: OE,
  assignee_employee_id: null, created_by_user_id: U(9), department_id: D1, deadline: '2026-11-11T12:30:00.000Z', revised_deadline: null,
  space_id: G, plan_item_id: null, parent_task_id: null, created_at: '2026-01-01T00:00:00Z', is_recurring: false, ...o });
const TASKS = [
  T(0, {}),                                                         // General, the viewer's team → visible to all
  T(1, { space_id: PRIV, title: 'ZZ secret', task_no: 'DKT-SECRET' }), // private, nobody here is a member → hidden
  T(2, { space_id: FND, title: 'ZZ founders' }),                    // Founders' space (the viewer IS a member) → never below F
  T(3, { department_id: D2 }),                                      // General, now another team, not theirs → hidden from the lead
  T(4, { department_id: D2 }),                                      // other team, frozen D2 → only in "all"
];
const ROW = (t, frozenDept, outcome) => ({ task_id: t.id, task_no: t.task_no, title: t.title, space_id: t.space_id, department_id: frozenDept,
  owner_employee_id: t.owner_employee_id, committed_deadline: t.deadline, effective_deadline: t.deadline, entry_reason: 'week_start',
  status: t.status, completed_at: null, outcome, miss_reason: outcome === 'miss' ? 'open' : null, redated: false });
// The next-two-weeks read: one open task inside the window, one DONE inside it, one open beyond it.
const NEXT = [T(5, { task_no: 'DKT-N1', title: 'ZZ next open', deadline: at(addD(WE, 3)) }),
              T(6, { task_no: 'DKT-N2', title: 'ZZ next done', status: 'done', deadline: at(addD(WE, 4)) }),
              T(7, { task_no: 'DKT-N3', title: 'ZZ next far', deadline: at(addD(WE, 20)) })];
// A milestone-only team (no cohort row, no open task) with an item due this week.
const ITEMS = [{ id: U(300), kind: 'milestone', code: 'M09', parent_id: U(299), title: 'ZZ milestone only', owner_employee_id: null,
  department_id: D3, due_date: TODAY, revised_due_date: null, state: 'agreed', level: 'F', measure: null }];
const THIS_ROWS = [ROW(TASKS[0], D1, 'miss'), ROW(TASKS[1], D1, 'miss'), ROW(TASKS[2], D1, 'due'), ROW(TASKS[3], D1, 'on_time'), ROW(TASKS[4], D2, 'on_time')];

function stub({ superAdmin = false, dept = D1, snapshot = null } = {}) {
  const calls = [];
  const today = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
  const fn = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    const p = decodeURIComponent(u.pathname + u.search);
    const q = u.searchParams;
    const method = (init.method || 'GET').toUpperCase();
    const reqBody = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, p, body: reqBody });
    const body = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/auth/v1/user') return body({ id: ME, email: 'zz.me@legendoftoys.com' });
    if (Number(q.get('offset') || 0) > 0) return body([]);
    if (p.includes('/users_profile?')) return body([{ id: ME, role: 'viewer', full_name: 'ZZ Me', active: true }]);
    if (p.includes('/docket_user_roles?')) return body(superAdmin ? [{ role_key: 'zz_super' }] : []);
    if (p.includes('/docket_roles?')) return body([{ permissions: { docket_plan_admin: true } }]);
    if (p.includes('/employees?auth_user_id=')) return body([{ id: MEE, full_name: 'ZZ Me', department_id: dept }]);
    if (p.includes('/employees?')) return body([{ id: MEE, full_name: 'ZZ Me', department_id: D1, auth_user_id: ME },
                                                { id: OE, full_name: 'ZZ Owner', department_id: D1, auth_user_id: U(8) }]);
    if (p.includes('/departments?')) return body([{ id: D1, name: 'ZZ team 1' }, { id: D2, name: 'ZZ team 2' }, { id: D3, name: 'ZZ team 3' }]);
    if (p.includes('/rpc/plan_items_for')) return body(superAdmin ? ITEMS : []);
    if (p.startsWith('/rest/v1/user_activity?')) return body([{ user_id: ME, last_seen_at: '2026-11-12T01:00:00Z' }, { user_id: U(8), last_seen_at: '2026-11-12T02:00:00Z' }]);
    if (p.includes('/settings?')) return body([]);
    if (p.includes('/rpc/week_score')) {
      const thisWeek = reqBody.p_date === today;
      return body({ week_end: thisWeek ? WE : addD(WE, -7), week_start: thisWeek ? WS : addD(WS, -7),
        opened: true, final: !thisWeek, opened_late: false, as_of: '2026-11-12T10:00:00Z', scoring_version: 1, week_end_dow: 7,
        cutoff_at: '2026-11-15T18:30:00Z', tasks: thisWeek ? THIS_ROWS : [] });
    }
    if (p.includes('/rpc/task_set_deadline')) return body({ first: [], revised: reqBody.p_ids });
    if (p.includes('/rpc/')) return body([]);
    if (p.startsWith('/rest/v1/spaces?or=')) return body([{ id: FND, archived_at: null, is_founders: true }]);
    if (p.startsWith('/rest/v1/spaces?id=eq.')) return body([SPACES[G]]);
    if (p.startsWith('/rest/v1/spaces?id=in.')) {
      const ids = q.get('id').replace(/^in\.\(|\)$/g, '').split(',');
      return body(ids.map(id => SPACES[id]).filter(Boolean));
    }
    if (p.startsWith('/rest/v1/space_members?')) return body([{ space_id: FND }]);
    if (p.startsWith('/rest/v1/review_snapshots') && method === 'POST') return body([{ id: U(500), created_at: '2026-11-12T10:00:00Z' }]);
    if (p.startsWith('/rest/v1/review_snapshots?id=eq.')) return body(snapshot ? [snapshot] : []);
    if (p.startsWith('/rest/v1/review_snapshots')) return body([{ id: U(500), kind: 'provisional', department_id: null, created_at: '2026-11-12T10:00:00Z', created_by: ME }]);
    if (p.startsWith('/rest/v1/tasks?id=eq.') && method === 'GET') return body([{ ...TASKS[0], owner_employee_id: MEE }]);   // their own task (writes)
    if (p.startsWith('/rest/v1/tasks?id=in.') && method === 'GET') {
      const ids = q.get('id').replace(/^in\.\(|\)$/g, '').split(',');
      return body(TASKS.filter(t => ids.includes(t.id)));
    }
    if (u.pathname === '/rest/v1/tasks' && method === 'GET') {
      if (q.get('plan_item_id')) return body([]);                      // linked tasks
      if (q.get('handoff_to_department_id')) return body([]);          // R8 hand-offs (handoffs-gate.test.mjs)
      // The next-two-weeks read MUST carry its window as a real `or=` filter (not a bare key PostgREST ignores);
      // the stub hands back a done task and an out-of-window one anyway, so the worker's own re-check is proven.
      if (q.get('or')) {
        assert.match(q.get('or'), /^\(and\(revised_deadline\.gte\..+\),and\(revised_deadline\.is\.null,deadline\.gte\./);
        return body(NEXT);
      }
      const d = q.get('department_id');
      return body(TASKS.filter(t => !d || `eq.${t.department_id}` === d));   // the open list
    }
    if (method === 'PATCH' || method === 'POST') return body([{ ...TASKS[0] }]);
    return body([]);
  };
  return { fn, calls };
}

async function run(s, { get, post, headers = {} }) {
  const real = globalThis.fetch;
  globalThis.fetch = s.fn;
  try {
    const req = get
      ? new Request('https://docketops.test/?' + new URLSearchParams(get), { headers: { Authorization: 'Bearer zz', ...headers } })
      : new Request('https://docketops.test/', { method: 'POST', headers: { Authorization: 'Bearer zz', 'content-type': 'application/json', ...headers }, body: JSON.stringify(post) });
    const res = await worker.fetch(req, ENV);
    return { status: res.status, j: await res.json() };
  } finally { globalThis.fetch = real; }
}
const pack = (get, o) => run(stub(o), { get: { action: 'getReviewPack', ...get } });

test('non-admin: defaults to their own team; another team or all → 403 forbidden; no department → 403 no_team', async () => {
  const { status, j } = await pack({});
  assert.equal(status, 200, JSON.stringify(j));
  assert.equal(j.data.team_id, D1);
  assert.equal(j.data.can_admin, false);
  assert.deepEqual(j.data.departments, [{ id: D1, name: 'ZZ team 1' }]);
  assert.equal(j.data.proposals, null);
  assert.deepEqual(j.data.teams.map(t => t.department_id), [D1]);
  assert.equal((await pack({ team: D1 })).status, 200);
  for (const team of [D2, 'all']) {
    const r = await pack({ team });
    assert.equal(r.status, 403); assert.equal(r.j.error, 'forbidden');
  }
  const r = await pack({}, { dept: null });
  assert.equal(r.status, 403); assert.equal(r.j.error, 'no_team');
});

test('non-admin: counts exclude a task they cannot open and every Founders\'-space task', async () => {
  const { j } = await pack({});
  const t = j.data.teams[0];
  // of the five D1-frozen rows only DKT-0 is theirs to see: private (DKT-SECRET), Founders' (t2), another team's (t3) drop
  assert.deepEqual(t.this_week, { cohort: 1, on_time: 0, miss: 1, due: 0, pct: 0 });
  assert.deepEqual(t.slipped.map(s => s.task_no), ['DKT-0']);
  assert.deepEqual(t.unplanned, { committed: 1, unplanned: 1, pct: 100 });
  assert.equal(j.data.hidden_tasks, 0);
  const s = JSON.stringify(j.data);
  for (const leak of ['ZZ secret', 'DKT-SECRET', 'ZZ founders', 'ZZ t3', U(101), U(102), U(103)]) assert.ok(!s.includes(leak), leak);
});

test('plan admin: all teams by default, whole counts, a private-space row counted in hidden_tasks and never shown', async () => {
  const { status, j } = await pack({}, { superAdmin: true });
  assert.equal(status, 200, JSON.stringify(j));
  assert.equal(j.data.team_id, null);
  assert.equal(j.data.can_admin, true);
  assert.equal(j.data.departments.length, 3);
  assert.deepEqual(j.data.teams.map(t => t.department_id).sort(), [D1, D2, D3].sort());   // D3: a plan item only
  const t1 = j.data.teams.find(t => t.department_id === D1);
  assert.deepEqual(t1.this_week, { cohort: 4, on_time: 1, miss: 2, due: 1, pct: 33.3 });
  assert.equal(j.data.hidden_tasks, 1);
  assert.deepEqual(t1.slipped.map(s => s.task_no), ['DKT-0']);
  assert.ok(j.data.proposals && typeof j.data.proposals.waiting === 'number');
  assert.equal(typeof j.data.slack.summary, 'string');
  const s = JSON.stringify(j.data);
  assert.ok(!s.includes('ZZ secret') && !s.includes('DKT-SECRET') && !s.includes(U(101)), 'private row leaked');
  // and asking for one team works
  const r = await pack({ team: D2 }, { superAdmin: true });
  assert.equal(r.j.data.team_id, D2);
  assert.deepEqual(r.j.data.teams.map(t => t.this_week.cohort), [1]);
});

test('bad week → 400 bad_week; bad team → 400 bad_team', async () => {
  for (const week of ['nope', '2026-02-30']) {
    const r = await pack({ week }, { superAdmin: true });
    assert.equal(r.status, 400); assert.equal(r.j.error, 'bad_week');
  }
  for (const team of ['nope', U(99)]) {
    const r = await pack({ team }, { superAdmin: true });
    assert.equal(r.status, 400); assert.equal(r.j.error, 'bad_team');
  }
});

test('holdReview / getReviewSnapshots: 403 below plan admin', async () => {
  assert.equal((await run(stub(), { post: { action: 'holdReview', week: 'this' } })).status, 403);
  assert.equal((await run(stub(), { get: { action: 'getReviewSnapshots', week: 'this' } })).status, 403);
  assert.equal((await run(stub(), { get: { action: 'getReviewSnapshots', id: U(500) } })).status, 403);
});

test('holdReview: stores the pack as a provisional snapshot; the list names its holder', async () => {
  const s = stub({ superAdmin: true });
  const { status, j } = await run(s, { post: { action: 'holdReview', week: 'this', team: D1 } });
  assert.equal(status, 200, JSON.stringify(j));
  assert.deepEqual(j.data, { id: U(500), created_at: '2026-11-12T10:00:00Z' });
  const ins = s.calls.find(c => c.method === 'POST' && c.p.startsWith('/rest/v1/review_snapshots'));
  assert.equal(ins.body.kind, 'provisional');
  assert.equal(ins.body.department_id, D1);
  assert.equal(ins.body.week_end, WE);
  assert.equal(ins.body.created_by, ME);
  assert.equal(ins.body.scoring_version, 1);
  assert.ok(Array.isArray(ins.body.payload.teams));
  assert.ok(!JSON.stringify(ins.body.payload).includes('ZZ secret'));
  const l = await run(stub({ superAdmin: true }), { get: { action: 'getReviewSnapshots', week: 'this' } });
  assert.equal(l.j.data.snapshots[0].created_by_name, 'ZZ Me');
  assert.equal(l.j.data.snapshots[0].created_by, undefined);
});

test('X-LOT-Source: connector stamps task_history.source and p_source; absent → app', async () => {
  const hist = (calls) => calls.filter(c => c.method === 'POST' && c.p.startsWith('/rest/v1/task_history')).flatMap(c => [].concat(c.body));
  const s1 = stub();
  await run(s1, { post: { action: 'updateTask', id: U(100), title: 'ZZ renamed' }, headers: { 'X-LOT-Source': 'connector' } });
  assert.deepEqual(hist(s1.calls).map(r => r.source), ['connector']);
  const s2 = stub();
  await run(s2, { post: { action: 'updateTask', id: U(100), title: 'ZZ renamed' } });
  assert.deepEqual(hist(s2.calls).map(r => r.source), ['app']);
  const s3 = stub();
  await run(s3, { post: { action: 'updateTask', id: U(100), title: 'ZZ renamed' }, headers: { 'X-LOT-Source': 'slack' } });
  assert.deepEqual(hist(s3.calls).map(r => r.source), ['app']);   // only the gateway's value is honoured
  const s4 = stub();
  await run(s4, { post: { action: 'reviseDeadline', id: U(100), new_deadline: '2026-11-20T12:30:00.000Z', reason: 'zz' }, headers: { 'X-LOT-Source': 'connector' } });
  assert.equal(s4.calls.find(c => c.p.includes('/rpc/task_set_deadline')).body.p_source, 'connector');
  const s5 = stub({ superAdmin: true });
  await run(s5, { post: { action: 'bulkUpdateTasks', ids: [U(100)], field: 'priority', value: 'P1' }, headers: { 'X-LOT-Source': 'connector' } });
  assert.ok(hist(s5.calls).length && hist(s5.calls).every(r => r.source === 'connector'));
});

test('next_two_weeks: only open tasks dated inside the two weeks after the pack\'s week (the `or=` window is sent)', async () => {
  const s = stub();
  const { status, j } = await run(s, { get: { action: 'getReviewPack' } });
  assert.equal(status, 200, JSON.stringify(j));
  assert.ok(s.calls.some(c => c.p.startsWith('/rest/v1/tasks?') && c.p.includes('&or=(and(revised_deadline.gte.')), 'window filter not sent as or=');
  const nos = j.data.teams[0].next_two_weeks.tasks_by_person.flatMap(g => g.tasks.map(t => t.task_no));
  assert.deepEqual(nos, ['DKT-N1']);
});

test('team=all: a team with only a plan item in the window (no cohort row, no open task) still gets its card', async () => {
  const { j } = await pack({ team: 'all' }, { superAdmin: true });
  const t3 = j.data.teams.find(t => t.department_id === D3);
  assert.ok(t3, 'milestone-only team missing');
  assert.equal(t3.team_name, 'ZZ team 3');
  assert.deepEqual(t3.milestones.due.map(m => m.code), ['M09']);
  assert.equal(t3.this_week.cohort, 0);
});

test('staleness: a past week has null quiet / last_working_day and its update reads stop at the week end', async () => {
  const s = stub({ superAdmin: true });
  const { j } = await run(s, { get: { action: 'getReviewPack', week: 'last', team: D1 } });
  const st = j.data.teams[0].staleness;
  assert.equal(st.quiet_last_working_day, null);
  assert.equal(st.last_working_day, null);
  const end = new Date(Date.parse(`${addD(WE, -6)}T00:00:00+05:30`)).toISOString();
  const reads = s.calls.filter(c => /^\/rest\/v1\/task_(history|comments)\?task_id=in\./.test(c.p) && !c.p.includes('deadline_revised'));
  assert.ok(reads.length >= 2 && reads.every(c => c.p.includes(`created_at=lt.${end}`)), JSON.stringify(reads.map(c => c.p)));
  const cur = await pack({ team: D1 }, { superAdmin: true });
  assert.equal(typeof cur.j.data.teams[0].staleness.last_working_day, 'string');
});

test('staleness people: last_update_before when no own update in the lookback; presence only the viewer\'s below plan admin', async () => {
  const lead = await pack({});
  const owner = lead.j.data.teams[0].staleness.people.find(p => p.employee_id === OE);
  assert.ok(owner, 'owner missing');
  assert.equal(owner.last_update, null);
  assert.match(owner.last_update_before, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal('last_seen' in owner, false);           // a colleague's presence isn't the lead's to see
  const s = stub();
  await run(s, { get: { action: 'getReviewPack' } });
  assert.ok(!s.calls.some(c => c.p.startsWith('/rest/v1/user_activity?') && c.p.includes(U(8))), 'read a colleague\'s presence');
  const admin = await pack({ team: D1 }, { superAdmin: true });
  const o2 = admin.j.data.teams[0].staleness.people.find(p => p.employee_id === OE);
  assert.equal(o2.last_seen, '2026-11-12T02:00:00Z');
});

test('getReviewSnapshots by id: a final (raw week_score) snapshot comes back pack-shaped, re-projected, with Slack copy', async () => {
  const snapshot = { id: U(501), kind: 'final', week_end: addD(WE, -7), department_id: null, created_at: '2026-11-09T00:05:00Z',
    payload: { week_end: addD(WE, -7), week_start: addD(WS, -7), final: true, opened: true, as_of: '2026-11-09T00:05:00Z',
      teams: [{ department_id: D1, cohort: 4 }], tasks: THIS_ROWS } };
  const { status, j } = await run(stub({ superAdmin: true, snapshot }), { get: { action: 'getReviewSnapshots', id: U(501) } });
  assert.equal(status, 200, JSON.stringify(j));
  const p = j.data.snapshot.payload;
  assert.equal(p.week.final, true);
  assert.equal(p.week.week_end, addD(WE, -7));
  assert.deepEqual(p.teams.map(t => t.team_name), ['ZZ team 1', 'ZZ team 2']);
  const t1 = p.teams[0];
  assert.deepEqual(t1.this_week, { cohort: 4, on_time: 1, miss: 2, due: 1, pct: 25 });
  assert.deepEqual(t1.slipped.map(s => s.task_no), ['DKT-0']);
  assert.equal(t1.slipped[0].owner_name, 'ZZ Owner');
  assert.equal(p.revisions_loaded, true);
  assert.equal(p.hidden_tasks, 1);
  assert.match(p.slack.teams[0].text, /^\*ZZ team 1\*/);
  assert.ok(!JSON.stringify(j.data).includes('ZZ secret') && !JSON.stringify(j.data).includes('DKT-SECRET'));
  assert.equal(p.tasks, undefined);   // the raw rows (with space_id) never travel
});
