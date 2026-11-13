// Run: node --test docketops-worker/test/*.test.mjs
// F9 R9b end to end against a stubbed Supabase: measure.reading only at levels F / R / O (never T / L, never a
// restricted row below F; one batched read of plan_measure_latest), getReachedTargets level F only, the score trend's
// scoping (a lead: own team only; below F never a Founders'-space task; F = week_score's whole team rows; only
// CLOSED weeks are read), the re-plan's readiness math, and Programs (restored 2026-11-13) writable alongside the plan link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { istDate, weekEndOf, addDays } from '../src/weeks-core.mjs';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const code = readFileSync(join(SRC, 'index.js'), 'utf8').replace(/from '\.\/([^']+)'/g, (_, f) => `from '${pathToFileURL(join(SRC, f)).href}'`);
const worker = (await import('data:text/javascript,' + encodeURIComponent(code))).default;

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ME = U(1), MEE = U(2), D1 = U(10), D2 = U(11), G = U(20), PRIV = U(21), FND = U(22), PERS = U(27);   // PERS: ME's personal space — what ensure_personal_space returns (P3b: no-space creates land there)
const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_ANON_KEY: 'a' };
const SPACES = {
  [G]: { id: G, name: 'ZZ team', is_default: false, is_private: true, owner_user_id: U(9), is_founders: false, is_personal: false, archived_at: null },   // a team space (was General; retired P3c)
  [PRIV]: { id: PRIV, name: 'ZZ Private', is_default: false, is_private: true, owner_user_id: U(9), is_founders: false },
  [FND]: { id: FND, name: 'Founders', is_default: false, is_private: true, owner_user_id: U(9), is_founders: true },
  [PERS]: { id: PERS, name: 'Personal', is_default: false, is_private: true, owner_user_id: ME, is_founders: false, is_personal: true },
};
const inIds = (v) => (v || '').replace(/^in\.\(|\)$/g, '').split(',');

function stub({ role = null, planRows = [], readings = [], readingsFail = false, tasks = [], weeks = [], scores = {}, proposals = [], employees = [], members = [], programs = [] } = {}) {
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
    if (Number(q.get('offset') || 0) > 0) return body([]);
    if (p.startsWith('/rest/v1/users_profile?id=eq.')) return body([{ role: 'viewer', full_name: 'ZZ Me', active: true }]);
    if (p.startsWith('/rest/v1/users_profile?id=in.')) return body([{ id: U(9), full_name: 'ZZ Proposer' }].filter(x => inIds(q.get('id')).includes(x.id)));
    if (p.startsWith('/rest/v1/docket_user_roles?user_id=eq.')) return body(role ? [{ role_key: 'zz_role' }] : []);
    if (p.startsWith('/rest/v1/docket_roles?')) return body([{ role_key: 'zz_role', permissions: role === 'F' ? { docket_plan_admin: true } : role === 'R' ? { docket_review: true } : {} }]);
    if (p.includes('/employees?auth_user_id=')) return body([{ id: MEE, full_name: 'ZZ Me', department_id: D1 }]);
    if (p.includes('/employees?')) return body([{ id: MEE, full_name: 'ZZ Me', department_id: D1, status: 'active' }, ...employees].filter(x => inIds(q.get('id')).includes(x.id)));
    if (p.includes('/departments?')) return body([{ id: D1, name: 'ZZ D1' }, { id: D2, name: 'ZZ D2' }]);
    if (p.includes('/rpc/ensure_personal_space')) return body(PERS);
    if (p.includes('/rpc/plan_items_for')) return body(planRows);
    if (p.includes('/rpc/plan_history_for')) return body([]);
    if (p.includes('/rpc/week_score')) return body(scores[reqBody.p_date] || { week_end: reqBody.p_date, final: false, totals: { cohort: 0 }, teams: [], tasks: [] });
    if (p.includes('/rpc/')) return body([]);
    if (p.startsWith('/rest/v1/plan_measure_latest?') && readingsFail) return body({ message: 'zz down' }, 500);
    if (p.startsWith('/rest/v1/plan_measure_latest?')) return body(readings.filter(x => inIds(q.get('item_id')).includes(x.item_id)));
    if (p.startsWith('/rest/v1/plan_items?')) return body(planRows.map(i => ({ id: i.id, parent_id: i.parent_id, kind: i.kind })));
    if (p.startsWith('/rest/v1/settings?')) return body([{ key: 'week_end_dow', value: 7 }]);
    if (p.startsWith('/rest/v1/weeks?')) return body(weeks.filter(w => inIds(q.get('week_end')).includes(w)).map(week_end => ({ week_end })));
    if (p.startsWith('/rest/v1/plan_proposals?')) return body(proposals);
    if (p.startsWith('/rest/v1/spaces?or=')) return body([{ id: FND, archived_at: null, is_founders: true }]);
    if (p.startsWith('/rest/v1/spaces?archived_at=not.is.null')) return body([]);
    if (p.startsWith('/rest/v1/spaces?id=eq.')) return body([SPACES[q.get('id').slice(3)]].filter(Boolean));
    if (p.startsWith('/rest/v1/spaces?id=in.')) return body(inIds(q.get('id')).map(id => SPACES[id]).filter(Boolean));
    if (p.startsWith('/rest/v1/space_members?')) return body(members.map(space_id => ({ space_id })));
    if (u.pathname === '/rest/v1/tasks' && method === 'GET') {
      if (q.get('id')?.startsWith('in.')) return body(tasks.filter(t => inIds(q.get('id')).includes(t.id)));
      if (q.get('id')?.startsWith('eq.')) return body(tasks.filter(t => `eq.${t.id}` === q.get('id')));
      if (q.get('plan_item_id')?.startsWith('in.')) return body(tasks.filter(t => inIds(q.get('plan_item_id')).includes(t.plan_item_id)
        && (q.get('is_recurring') !== 'eq.false' || !t.is_recurring)));
      return body([]);
    }
    // tasks.program_id → docket.programs FK: an unknown program is refused by the DB (23503), as live
    const fk = (row) => row && row.program_id && !programs.some(x => x.id === row.program_id)
      ? body({ code: '23503', message: 'insert or update on table "tasks" violates foreign key constraint "tasks_program_id_fkey"' }, 409) : null;
    if (u.pathname === '/rest/v1/programs' && method === 'GET') return body(programs);
    if (u.pathname === '/rest/v1/programs' && method === 'POST') return body([{ id: U(41), ...reqBody[0] }], 201);
    if (u.pathname === '/rest/v1/tasks' && method === 'POST') return fk(reqBody[0]) || body([{ id: U(999), task_no: 'DKT-1', ...reqBody[0] }], 201);
    if (u.pathname === '/rest/v1/tasks' && method === 'PATCH') return fk(reqBody) || body([]);
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

const M = (o) => ({ system: 'redline', metric: 'redline.first_pass_yield', target: '≥ 98%', source_ok: true, ...o });
const PI = (n, o) => ({ id: U(300 + n), kind: 'milestone', code: `M${n}`, parent_id: U(300), title: `ZZ ${n}`, owner_employee_id: MEE, department_id: null,
  done_when: 'zz', measure: M(), due_date: '2026-11-20', revised_due_date: null, state: 'agreed', restricted: false, sort: n, level: 'F', ...o });
const RD = (n, o) => ({ item_id: U(300 + n), metric: 'redline.first_pass_yield', target_text: '≥ 98%', reading: '98.4', window_from: '2026-10-13', window_to: '2026-11-11', checked_at: '2026-11-12T00:30:01Z',
  reached: true, target_parsed: { op: '>=', value: 98 }, ...o });

test('measure.reading: attached at F / R / O only (never T / L, never a restricted row below F); one batched read; getPlan, getPlanItem, getPlanTree', async () => {
  // T / L rows carry a measure here on purpose (as if the projection leaked one): the worker's level rule must still hold
  const rows = [PI(0, { kind: 'theme', parent_id: null, level: 'T', due_date: null }), PI(1), PI(2, { level: 'O' }), PI(3, { level: 'R' }),
    PI(4, { level: 'L' }), PI(5, { level: 'O', restricted: true }), PI(6, { level: 'O', measure: null }), PI(7, { level: 'O' })];
  const readings = [0, 1, 2, 3, 4, 5, 6].map(n => RD(n));   // the stub would answer for any id — the worker must not ask for T / L / restricted
  let s = stub({ planRows: rows, readings });
  let r = await run(s, { get: { action: 'getPlan' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const by = Object.fromEntries(r.j.data.items.map(i => [i.id, i]));
  assert.deepEqual(by[U(301)].measure.reading, { value: 98.4, window_from: '2026-10-13', window_to: '2026-11-11', checked_at: '2026-11-12T00:30:01Z', reached: true, target_parsed: true });
  assert.equal(by[U(302)].measure.reading.value, 98.4); assert.equal(by[U(303)].measure.reading.reached, true);
  assert.equal(by[U(307)].measure.reading, null);                                  // no check yet
  assert.equal(by[U(305)].measure.reading, undefined);                             // restricted below F
  assert.equal(by[U(300)].measure.reading, undefined); assert.equal(by[U(304)].measure.reading, undefined); assert.equal(by[U(306)].measure, null);
  const reads = s.calls.filter(c => c.p.startsWith('/rest/v1/plan_measure_latest?'));
  assert.equal(reads.length, 1);
  assert.deepEqual(inIds(new URL('https://x' + reads[0].p).searchParams.get('item_id')).sort(), [U(301), U(302), U(303), U(307)]);

  r = await run(stub({ planRows: [PI(1, { kind: 'milestone' }), PI(8, { kind: 'result', parent_id: U(301), level: 'O' })], readings: [RD(1), RD(8, { reached: false })] }),
    { get: { action: 'getPlanItem', id: U(301) } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.data.item.measure.reading.reached, true); assert.equal(r.j.data.children[0].measure.reading.reached, false);

  r = await run(stub({ planRows: rows, readings }), { get: { action: 'getPlanTree' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const tb = Object.fromEntries(r.j.data.items.map(i => [i.id, i]));
  assert.equal(tb[U(301)].measure.reading.value, 98.4);
  assert.equal(tb[U(300)].measure, null);                                          // a level-T tree row: no measure, no reading
  assert.equal(tb[U(302)].measure.reading.value, 98.4);
});

test('getReachedTargets: level F only; agreed + latest reading reached; by effective due; label from the registry', async () => {
  for (const role of [null, 'R']) {
    const r = await run(stub({ role, planRows: [PI(1)], readings: [RD(1)] }), { get: { action: 'getReachedTargets' } });
    assert.equal(r.status, 403, String(role));
  }
  const rows = [PI(1, { due_date: '2026-11-30' }), PI(2, { due_date: '2026-11-25', revised_due_date: '2026-11-28', kind: 'result' }), PI(3, { state: 'proposed' }),
    PI(4), PI(5, { due_date: '2026-11-21' })];
  const r = await run(stub({ role: 'F', planRows: rows, readings: [RD(1), RD(2, { reading: '120' }), RD(3), RD(4, { reached: false }), RD(5, { reached: null })] }),
    { get: { action: 'getReachedTargets' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.data.items.map(i => [i.code, i.effective_due, i.reading]), [['M2', '2026-11-28', 120], ['M1', '2026-11-30', 98.4]]);
  assert.deepEqual(r.j.data.items[1], { id: U(301), kind: 'milestone', code: 'M1', title: 'ZZ 1', owner_name: 'ZZ Me', effective_due: '2026-11-30',
    metric_label: 'QC first-pass yield', target: '≥ 98%', reading: 98.4, window_from: '2026-10-13', window_to: '2026-11-11', checked_at: '2026-11-12T00:30:01Z' });
});

// the trend: two closed weeks before the current one, a third not closed
const today = istDate(Date.now());
const W1 = addDays(weekEndOf(today, 7), -14), W2 = addDays(weekEndOf(today, 7), -7);
const CR = (n, o) => ({ task_id: U(900 + n), department_id: D1, owner_employee_id: MEE, outcome: 'on_time', space_id: G, ...o });
const TT = (n, o) => ({ id: U(900 + n), status: 'done', department_id: D1, owner_employee_id: MEE, space_id: G, parent_task_id: null, created_by_user_id: U(9), ...o });
const SCORES = {
  [W1]: { week_end: W1, final: true, totals: { cohort: 3, on_time: 2, pct: 66.7 }, teams: [{ department_id: D1, cohort: 2, on_time: 1, pct: 50 }, { department_id: D2, cohort: 1, on_time: 1, pct: 100 }],
    tasks: [CR(1), CR(2, { outcome: 'miss' }), CR(3, { department_id: D2 })] },
  [W2]: { week_end: W2, final: true, totals: { cohort: 3, on_time: 3, pct: 100 }, teams: [{ department_id: D1, cohort: 3, on_time: 3, pct: 100 }],
    tasks: [CR(4), CR(5), CR(6, { space_id: FND })] },
};
const TREND_TASKS = [TT(1), TT(2), TT(3, { department_id: D2 }), TT(4), TT(5), TT(6, { space_id: FND })];

test('getScoreTrend: F = week_score\'s whole team rows for CLOSED weeks only; weeks 1–26', async () => {
  const s = stub({ role: 'F', weeks: [W1, W2], scores: SCORES, tasks: TREND_TASKS });
  const r = await run(s, { get: { action: 'getScoreTrend', weeks: '3' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const W0 = addDays(W1, -7);
  assert.deepEqual(r.j.data.weeks, [W0, W1, W2]);
  assert.deepEqual(r.j.data.overall, [{ week_end: W0, on_time: 0, cohort: 0, pct: null }, { week_end: W1, on_time: 2, cohort: 3, pct: 66.7 }, { week_end: W2, on_time: 3, cohort: 3, pct: 100 }]);
  assert.deepEqual(r.j.data.teams.map(t => [t.name, t.points.map(p => p.pct)]), [['ZZ D1', [null, 50, 100]], ['ZZ D2', [null, 100, null]]]);
  assert.deepEqual(s.calls.filter(c => c.p.includes('/rpc/week_score')).map(c => c.body.p_date).sort(), [W1, W2]);   // W0 isn't closed: not read
  for (const weeks of ['0', '27', 'x', '-1']) assert.equal((await run(stub({ role: 'F' }), { get: { action: 'getScoreTrend', weeks } })).status, 400, weeks);
  const one = await run(stub({ role: 'F', weeks: [W1, W2], scores: SCORES, tasks: TREND_TASKS }), { get: { action: 'getScoreTrend', weeks: '2', team: D2 } });
  assert.deepEqual(one.j.data.teams.map(t => t.id), [D2]); assert.deepEqual(one.j.data.overall.map(p => p.pct), [100, null]);
});

test('getScoreTrend below F: a lead only their own team (else 403); never a Founders\'-space task; an Associate any team, same gate', async () => {
  for (const team of [D2, 'all']) assert.equal((await run(stub({ weeks: [W1, W2], scores: SCORES, tasks: TREND_TASKS }), { get: { action: 'getScoreTrend', team } })).status, 403, team);
  const r = await run(stub({ weeks: [W1, W2], scores: SCORES, tasks: TREND_TASKS }), { get: { action: 'getScoreTrend', weeks: '2' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.data.teams.map(t => [t.id, t.points.map(p => [p.on_time, p.cohort, p.pct])]), [[D1, [[1, 2, 50], [2, 2, 100]]]]);   // W2: the Founders' task (6) is out
  assert.deepEqual(r.j.data.overall.map(p => p.cohort), [2, 2]);
  const a = await run(stub({ role: 'R', weeks: [W1, W2], scores: SCORES, tasks: TREND_TASKS }), { get: { action: 'getScoreTrend', weeks: '2' } });
  assert.equal(a.status, 200);
  assert.deepEqual(a.j.data.overall.map(p => p.cohort), [3, 2]);                 // every team's task they can open (D2's too) — still never the Founders' one
});

test('getReplan: level F only; readiness = agreed, active owner, data source, actionable in the first 14 days; risks; last month\'s closed scores', async () => {
  assert.equal((await run(stub({ role: 'R' }), { get: { action: 'getReplan', month: '2026-12' } })).status, 403);
  assert.equal((await run(stub({ role: 'F' }), { get: { action: 'getReplan', month: '2026-13' } })).status, 400);
  const X = U(50);
  const rows = [PI(0, { kind: 'theme', parent_id: null, measure: null, due_date: null, title: 'ZZ Growth' }),
    PI(1, { due_date: '2026-12-10' }),                                                 // ready (via its result's task)
    PI(2, { due_date: '2026-12-20', state: 'proposed' }),                              // not agreed
    PI(3, { due_date: '2026-12-05', owner_employee_id: X }),                           // owner exited
    PI(4, { due_date: '2026-12-31', measure: { system: 'manual', metric: 'manual', target: null, source_ok: false } }),
    PI(5, { due_date: '2026-12-12' }),                                                 // its only task is due on the 15th
    PI(6, { due_date: '2027-01-02' }),                                                 // outside the month
    PI(7, { kind: 'result', parent_id: U(301), due_date: '2026-12-08' })];
  const T = (n, o) => ({ id: U(950 + n), status: 'in_progress', plan_item_id: U(301), parent_task_id: null, space_id: G, deadline: '2026-12-03T12:30:00.000Z', revised_deadline: null, ...o });
  const tasks = [T(1, { plan_item_id: U(307) }), T(2, { plan_item_id: U(305), deadline: '2026-12-14T19:00:00.000Z' }),   // 15 Dec 00:30 IST — outside
    T(3, { plan_item_id: U(302) }), T(4, { plan_item_id: U(303) }), T(5, { plan_item_id: U(304) }), T(6, { plan_item_id: U(305), status: 'done' }),
    T(7, { plan_item_id: U(305), is_recurring: true })];                                                                 // a recurring task never counts
  const s = stub({ role: 'F', planRows: rows, tasks, employees: [{ id: X, full_name: 'ZZ Gone', department_id: D2, status: 'exited' }],
    proposals: [{ id: U(70), title: 'ZZ risk', why: 'zz', status: 'submitted', suggested_theme_id: U(300), proposer_user_id: U(9), created_at: '2026-11-20T00:00:00Z' }],
    weeks: ['2026-11-08', '2026-11-15'], scores: { '2026-11-08': { week_end: '2026-11-08', final: true, totals: { cohort: 4, on_time: 3, pct: 75 }, teams: [{ department_id: D1, cohort: 4, on_time: 3, pct: 75 }] },
      '2026-11-15': { week_end: '2026-11-15', final: true, totals: { cohort: 0, on_time: 0, pct: null }, teams: [] } } });
  const r = await run(s, { get: { action: 'getReplan', month: '2026-12' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const d = r.j.data;
  assert.deepEqual(d.milestones.map(m => [m.code, m.readiness]), [
    ['M3', { agreed: true, owner: false, data_source: true, actionable: 1, ready: false }],
    ['M1', { agreed: true, owner: true, data_source: true, actionable: 1, ready: true }],
    ['M5', { agreed: true, owner: true, data_source: true, actionable: 0, ready: false }],
    ['M2', { agreed: false, owner: true, data_source: true, actionable: 1, ready: false }],
    ['M4', { agreed: true, owner: true, data_source: false, actionable: 1, ready: false }]]);
  assert.deepEqual(d.counts, { milestones: 5, ready: 1, not_ready: 4 });
  assert.equal(d.milestones[0].team_name, 'ZZ D2'); assert.equal(d.milestones[3].chips.not_agreed, true); assert.equal(d.milestones[4].chips.no_data_source, true);
  assert.deepEqual(d.risks, [{ id: U(70), title: 'ZZ risk', why: 'zz', status: 'submitted', created_at: '2026-11-20T00:00:00Z', proposer_name: 'ZZ Proposer', suggested_theme_title: 'ZZ Growth' }]);
  assert.match(s.calls.find(c => c.p.startsWith('/rest/v1/plan_proposals?')).p, /kind_hint=eq\.risk&or=\(status\.eq\.submitted,and\(created_at\.gte\.2026-10-26T18:30:00\.000Z,created_at\.lt\.2026-11-30T18:30:00\.000Z\)\)/);
  // weeks ending in the PREVIOUS month that are over (before today) and closed; a 0-cohort week → pct null
  const want = [{ week_end: '2026-11-08', overall: { on_time: 3, cohort: 4, pct: 75 }, teams: [{ id: D1, name: 'ZZ D1', on_time: 3, cohort: 4, pct: 75 }] },
    { week_end: '2026-11-15', overall: { on_time: 0, cohort: 0, pct: null }, teams: [] }].filter(w => w.week_end < today);
  assert.deepEqual(d.scores, { month: '2026-11', weeks: want });
  assert.deepEqual(s.calls.filter(c => c.p.startsWith('/rest/v1/weeks?')).map(c => inIds(new URL('https://x' + c.p).searchParams.get('week_end')))[0], ['2026-11-01', '2026-11-08', '2026-11-15', '2026-11-22', '2026-11-29'].filter(w => w < today));
});

test('Programs (restored): create / update / bulk accept a program; a sub-task inherits its parent\'s; createProgram creates (idempotent); clearing works', async () => {
  const PRG = [{ id: U(40), name: 'ZZ Prog', color: null }];
  // create — with a program AND a plan-free task; the program lands on the insert
  let s = stub({ programs: PRG });
  let r = await run(s, { post: { action: 'createTask', title: 'ZZ', program_id: U(40) } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(s.calls.find(x => x.method === 'POST' && x.p.startsWith('/rest/v1/tasks')).body[0].program_id, U(40));
  // a sub-task (title only) inherits the parent's program
  s = stub({ programs: PRG, tasks: [TT(5, { status: 'in_progress', program_id: U(40), created_by_user_id: ME, space_id: PERS })] });   // P3c: not General
  r = await run(s, { post: { action: 'createTask', title: 'ZZ sub', parent_task_id: U(905) } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(s.calls.find(x => x.method === 'POST' && x.p.startsWith('/rest/v1/tasks')).body[0].program_id, U(40));
  // update
  s = stub({ programs: PRG, tasks: [TT(1, { status: 'in_progress', created_by_user_id: ME })] });
  r = await run(s, { post: { action: 'updateTask', id: U(901), program_id: U(40) } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(s.calls.find(x => x.method === 'PATCH' && x.p.startsWith('/rest/v1/tasks')).body.program_id, U(40));
  // bulk set, then bulk clear
  s = stub({ programs: PRG, tasks: [TT(1, { status: 'in_progress', created_by_user_id: ME })] });
  r = await run(s, { post: { action: 'bulkUpdateTasks', ids: [U(901)], field: 'program_id', value: U(40) } });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(r.j.data.updated, 1);
  assert.equal(s.calls.find(x => x.method === 'PATCH').body.program_id, U(40));
  s = stub({ tasks: [TT(1, { status: 'in_progress', program_id: U(40), created_by_user_id: ME })] });
  r = await run(s, { post: { action: 'bulkUpdateTasks', ids: [U(901)], field: 'program_id', value: null } });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(r.j.data.updated, 1);
  assert.equal(s.calls.find(x => x.method === 'PATCH').body.program_id, null);
  // createProgram: reuses an existing (case-insensitive) program, else inserts; a blank name is refused
  r = await run(stub({ programs: PRG }), { post: { action: 'createProgram', name: 'zz prog' } });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(r.j.data.id, U(40));
  s = stub({ programs: PRG });
  r = await run(s, { post: { action: 'createProgram', name: ' ZZ New ' } });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(r.j.data.id, U(41));
  assert.equal(s.calls.find(x => x.method === 'POST' && x.p.startsWith('/rest/v1/programs')).body[0].name, 'ZZ New');
  r = await run(stub(), { post: { action: 'createProgram', name: '  ' } });
  assert.equal(r.status, 400); assert.equal(r.j.error, 'name required');
});

test('Programs (restored): a sub-task inherits only when program_id is OMITTED — explicit null / \'\' stays null; update \'\' clears', async () => {
  const PRG = [{ id: U(40), name: 'ZZ Prog', color: null }];
  const parent = TT(5, { status: 'in_progress', program_id: U(40), created_by_user_id: ME, space_id: PERS });   // P3c: not General
  for (const [extra, want] of [[{}, U(40)], [{ program_id: null }, null], [{ program_id: '' }, null], [{ program_id: U(40) }, U(40)]]) {
    const s = stub({ programs: PRG, tasks: [parent] });
    const r = await run(s, { post: { action: 'createSubtask', parent_task_id: U(905), title: 'ZZ sub', ...extra } });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    assert.equal(s.calls.find(x => x.method === 'POST' && x.p.startsWith('/rest/v1/tasks')).body[0].program_id, want, JSON.stringify(extra));
  }
  const s = stub({ programs: PRG, tasks: [TT(1, { status: 'in_progress', program_id: U(40), created_by_user_id: ME })] });
  const r = await run(s, { post: { action: 'updateTask', id: U(901), program_id: '' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(s.calls.find(x => x.method === 'PATCH' && x.p.startsWith('/rest/v1/tasks')).body.program_id, null);
});

test('Programs (restored): a private-space task the caller is not a member of — updateTask 404, bulk skips it; no write', async () => {
  const PRG = [{ id: U(40), name: 'ZZ Prog', color: null }];
  // even their own creation: not a member. P3a: the OWNER now opens it (involvement), so it is someone else's here —
  // creating a task is not involvement.
  const hidden = TT(1, { status: 'in_progress', space_id: PRIV, created_by_user_id: ME, owner_employee_id: U(77) });
  let s = stub({ programs: PRG, tasks: [hidden] });
  let r = await run(s, { post: { action: 'updateTask', id: U(901), program_id: U(40) } });
  assert.equal(r.status, 404, JSON.stringify(r.j)); assert.equal(r.j.error, 'not_found');
  assert.ok(!s.calls.some(x => x.method === 'PATCH'));
  s = stub({ programs: PRG, tasks: [hidden, TT(2, { status: 'in_progress', created_by_user_id: ME })] });
  r = await run(s, { post: { action: 'bulkUpdateTasks', ids: [U(901), U(902)], field: 'program_id', value: U(40) } });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.deepEqual([r.j.data.updated, r.j.data.skipped], [1, 1]);
  const patches = s.calls.filter(x => x.method === 'PATCH');
  assert.equal(patches.length, 1); assert.deepEqual(inIds(new URL('https://x' + patches[0].p).searchParams.get('id')), [U(902)]);
  // and once a member, the same write goes through
  s = stub({ programs: PRG, tasks: [hidden], members: [PRIV] });
  r = await run(s, { post: { action: 'updateTask', id: U(901), program_id: U(40) } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  // P3a: so does the owner who isn't a member (involvement opens the task; the owner edits it)
  s = stub({ programs: PRG, tasks: [{ ...hidden, owner_employee_id: MEE }] });
  r = await run(s, { post: { action: 'updateTask', id: U(901), program_id: U(40) } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.ok(s.calls.some(x => x.method === 'PATCH' && x.p.startsWith('/rest/v1/tasks')));
});

test('Programs (restored): an unknown program_id is refused (the tasks_program_id_fkey, as before R9b) — create, update and bulk', async () => {
  const PRG = [{ id: U(40), name: 'ZZ Prog', color: null }];
  let r = await run(stub({ programs: PRG }), { post: { action: 'createTask', title: 'ZZ', program_id: U(49) } });
  assert.equal(r.status, 400); assert.match(r.j.error, /^create_failed: .*tasks_program_id_fkey/);
  r = await run(stub({ programs: PRG, tasks: [TT(1, { status: 'in_progress', created_by_user_id: ME })] }), { post: { action: 'updateTask', id: U(901), program_id: U(49) } });
  assert.equal(r.status, 400); assert.match(r.j.error, /^update_failed: .*tasks_program_id_fkey/);
  r = await run(stub({ programs: PRG, tasks: [TT(1, { status: 'in_progress', created_by_user_id: ME })] }), { post: { action: 'bulkUpdateTasks', ids: [U(901)], field: 'program_id', value: U(49) } });
  assert.equal(r.status, 400); assert.match(r.j.error, /^update_failed: .*tasks_program_id_fkey/);
});

test('review: a reading only for the item\'s CURRENT measure — edited to manual / another metric → no reading, off the queue; a new target → reached null', async () => {
  const before = await run(stub({ role: 'F', planRows: [PI(1)], readings: [RD(1)] }), { get: { action: 'getReachedTargets' } });
  assert.deepEqual(before.j.data.items.map(i => i.code), ['M1']);
  const manual = PI(1, { measure: { system: 'manual', metric: 'manual', target: '≥ 98%', source_ok: false } });
  const other = PI(2, { measure: M({ metric: 'redline.units_packed', system: 'redline', target: '≥ 98%' }) });
  const retarget = PI(3, { measure: M({ target: '≥ 99%' }) });
  const spaced = PI(4, { measure: M({ target: ' ≥ 98% ' }) });   // the checker stores the trimmed target
  const rows = [manual, other, retarget, spaced];
  const q = await run(stub({ role: 'F', planRows: rows, readings: [RD(1), RD(2), RD(3), RD(4)] }), { get: { action: 'getReachedTargets' } });
  assert.deepEqual(q.j.data.items.map(i => i.code), ['M4']);
  const p = await run(stub({ role: 'F', planRows: rows, readings: [RD(1), RD(2), RD(3), RD(4)] }), { get: { action: 'getPlan' } });
  const by = Object.fromEntries(p.j.data.items.map(i => [i.id, i]));
  assert.equal(by[U(301)].measure.reading, null); assert.equal(by[U(302)].measure.reading, null);
  assert.deepEqual(by[U(303)].measure.reading, { value: 98.4, window_from: '2026-10-13', window_to: '2026-11-11', checked_at: '2026-11-12T00:30:01Z', reached: null, target_parsed: false });
  assert.equal(by[U(304)].measure.reading.reached, true);
});

test('review: a failed readings read never takes a page down (no reading); only the confirm queue errors', async () => {
  const rows = [PI(0, { kind: 'theme', parent_id: null, measure: null, level: 'F', due_date: null }), PI(1)];
  for (const get of [{ action: 'getPlan' }, { action: 'getPlanItem', id: U(301) }, { action: 'getPlanTree' }]) {
    const r = await run(stub({ role: 'F', planRows: rows, readings: [RD(1)], readingsFail: true }), { get });
    assert.equal(r.status, 200, get.action + ' ' + JSON.stringify(r.j));
    const m = (r.j.data.items || [r.j.data.item]).find(i => i.id === U(301));
    assert.equal(m.measure.reading, null, get.action);
  }
  const q = await run(stub({ role: 'F', planRows: rows, readings: [RD(1)], readingsFail: true }), { get: { action: 'getReachedTargets' } });
  assert.equal(q.status, 500);
});
