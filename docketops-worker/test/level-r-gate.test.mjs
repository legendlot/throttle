// Run: node --test docketops-worker/test/*.test.mjs
// F9 R6c end to end against a stubbed Supabase — level R (docket_review, the Founders' Associates):
//   - every call to plan_items_for / plan_history_for / plan_links_for passes p_is_review = isReviewer (true for
//     an Associate, false for everyone else, false for a plan admin who also carries docket_review);
//   - the review pack: any team or all (default all), full departments, can_review true, can_admin false,
//     proposals null, counts AND rows only from tasks they can open, never a Founders'-space task;
//   - getWeekScore allowed, recomputed from visible tasks; holdReview / getReviewSnapshots / getFoundersReview /
//     setFounderFocus refused;
//   - a role carrying docket_review is created / edited / deleted / assigned only by a plan admin (A5).
// The SQL projection itself (target_text null, no restricted subtree) is proved by test/level-r.sql; here the
// stub returns what 0025 returns for each flag, and the worker must pass it through untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const code = readFileSync(join(SRC, 'index.js'), 'utf8').replace(/from '\.\/([^']+)'/g, (_, f) => `from '${pathToFileURL(join(SRC, f)).href}'`);
const worker = (await import('data:text/javascript,' + encodeURIComponent(code))).default;

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ME = U(1), MEE = U(2), OE = U(3), OTHER = U(4), D1 = U(10), D2 = U(11), G = U(20), PRIV = U(21), FND = U(22), G2 = U(23);
const TH = U(200), TH2 = U(201), MS = U(202);
const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_ANON_KEY: 'a' };
const ROLES = { zz_super: { docket_plan_admin: true }, zz_super_review: { docket_plan_admin: true, docket_review: true },
  zz_admin: { docket_admin: true }, zz_assoc: { docket_review: true }, zz_plain: {} };
const SPACES = {
  // G / G2: D1's and D2's team spaces (was General; retired P3c). G is shared with the viewer's team (D1), G2 isn't.
  [G]: { id: G, name: 'ZZ team 1', is_default: false, is_private: true, owner_user_id: U(9), is_founders: false, is_personal: false, archived_at: null },
  [G2]: { id: G2, name: 'ZZ team 2', is_default: false, is_private: true, owner_user_id: U(9), is_founders: false, is_personal: false, archived_at: null },
  [PRIV]: { id: PRIV, name: 'ZZ private', is_default: false, is_private: true, owner_user_id: U(9), is_founders: false },
  [FND]: { id: FND, name: 'Founders', is_default: false, is_private: true, owner_user_id: U(9), is_founders: true },
};
const TODAY = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
const T = (n, o) => ({ id: U(100 + n), task_no: `DKT-${n}`, title: `ZZ t${n}`, status: 'in_progress', priority: 'P2', owner_employee_id: OE,
  assignee_employee_id: null, created_by_user_id: U(9), department_id: D1, deadline: `${TODAY}T06:30:00.000Z`, revised_deadline: null,
  space_id: G, plan_item_id: null, parent_task_id: null, created_at: '2026-01-01T00:00:00Z', is_recurring: false, ...o });
const TASKS = [
  T(0, { plan_item_id: MS }),                                       // the viewer's team space → visible
  T(1, { space_id: PRIV, title: 'ZZ secret', task_no: 'DKT-SECRET' }), // private, not a member → hidden
  T(2, { space_id: FND, title: 'ZZ founders' }),                    // Founders' space (the viewer IS a member) → never below F
  T(3, { department_id: D2, title: 'ZZ other team', space_id: G2 }), // another team's space, not shared → hidden
];
const ROW = (t, outcome) => ({ task_id: t.id, task_no: t.task_no, title: t.title, space_id: t.space_id, department_id: t.department_id,
  owner_employee_id: t.owner_employee_id, committed_deadline: t.deadline, effective_deadline: t.deadline, entry_reason: 'week_start',
  status: t.status, completed_at: null, outcome, miss_reason: outcome === 'miss' ? 'open' : null, redated: false });
const ROWS = TASKS.map(t => ROW(t, 'miss'));
// What 0025 returns: R = every unrestricted item in full, target_text / restricted null; F adds the restricted theme.
const ITEM = (o) => ({ id: MS, kind: 'milestone', code: 'M01', parent_id: TH, title: 'ZZ milestone', owner_employee_id: OE, department_id: D1,
  target_text: null, done_when: 'zz', measure: null, due_date: TODAY, revised_due_date: null, state: 'agreed', restricted: null, level: 'R', ...o });
const PLAN = {
  R: [ITEM({ id: TH, kind: 'theme', code: 'T01', parent_id: null, title: 'ZZ theme' }), ITEM({})],
  F: [ITEM({ id: TH, kind: 'theme', code: 'T01', parent_id: null, title: 'ZZ theme', level: 'F', target_text: 'ZZ target', restricted: false }),
      ITEM({ level: 'F', restricted: false }), ITEM({ id: TH2, kind: 'theme', code: 'T02', parent_id: null, title: 'ZZ restricted', level: 'F', target_text: 'x', restricted: true })],
  none: [ITEM({ id: TH, kind: 'theme', code: 'T01', parent_id: null, title: 'ZZ theme', level: 'T', owner_employee_id: null, done_when: null, due_date: null })],
};

function stub({ role = 'zz_assoc', otherRole = 'zz_plain' } = {}) {
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
    if (p.includes('/users_profile?')) return body([{ id: ME, role: 'viewer', full_name: 'ZZ Me', active: true }]);
    if (p.startsWith('/rest/v1/docket_user_roles?user_id=eq.')) {
      const who = q.get('user_id').slice(3);
      const k = who === ME ? role : who === OTHER ? otherRole : null;
      return body(k ? [{ role_key: k }] : []);
    }
    if (p.startsWith('/rest/v1/docket_user_roles') && method !== 'GET') return body([{ user_id: OTHER }]);
    if (p.startsWith('/rest/v1/docket_roles?role_key=eq.') && method === 'GET') {
      const k = q.get('role_key').slice(3);
      return body(ROLES[k] ? [{ role_key: k, permissions: ROLES[k], is_system: false }] : []);
    }
    if (p.startsWith('/rest/v1/docket_roles')) return body([{ role_key: 'zz_new' }]);
    if (p.includes('/employees?auth_user_id=')) return body([{ id: MEE, full_name: 'ZZ Me', department_id: D1 }]);
    if (p.includes('/employees?')) return body([{ id: MEE, full_name: 'ZZ Me', department_id: D1, auth_user_id: ME },
                                                { id: OE, full_name: 'ZZ Owner', department_id: D1, auth_user_id: U(8) }]);
    if (p.includes('/departments?')) return body([{ id: D1, name: 'ZZ team 1' }, { id: D2, name: 'ZZ team 2' }]);
    if (p.includes('/settings?')) return body([]);
    if (p.includes('/rpc/plan_items_for')) return body(reqBody.p_is_super ? PLAN.F : reqBody.p_is_review ? PLAN.R : PLAN.none);
    if (p.includes('/rpc/plan_history_for')) return body([]);
    if (p.includes('/rpc/plan_links_for')) return body((reqBody.p_ids || []).map(id => ({ id, level: reqBody.p_is_review ? 'R' : 'L', kind: 'milestone' })));
    if (p.includes('/rpc/week_score')) {
      const thisWeek = reqBody.p_date === TODAY;
      return body({ week_end: TODAY, week_start: TODAY, opened: true, final: false, as_of: 'A', scoring_version: 1, week_end_dow: 7,
        cutoff_at: 'C', totals: { cohort: 4, on_time: 0, miss: 4, due: 0, pct: 0 }, teams: [{ department_id: D1, cohort: 3 }], people: [],
        tasks: thisWeek ? ROWS : [] });
    }
    if (p.includes('/rpc/')) return body([]);
    if (p.startsWith('/rest/v1/spaces?or=')) return body([{ id: FND, archived_at: null, is_founders: true }]);
    if (p.startsWith('/rest/v1/spaces?id=in.')) {
      const ids = q.get('id').replace(/^in\.\(|\)$/g, '').split(',');
      return body(ids.map(id => SPACES[id]).filter(Boolean));
    }
    if (p.startsWith('/rest/v1/space_members?')) return body([{ space_id: FND }]);
    if (p.startsWith('/rest/v1/space_teams?')) return body(q.get('department_id') === `eq.${D1}` ? [{ space_id: G }] : []);
    if (p.startsWith('/rest/v1/tasks?id=in.') && method === 'GET') {
      const ids = q.get('id').replace(/^in\.\(|\)$/g, '').split(',');
      return body(TASKS.filter(t => ids.includes(t.id)));
    }
    if (u.pathname === '/rest/v1/tasks' && method === 'GET') {
      if (q.get('plan_item_id')) return body(TASKS.filter(t => t.plan_item_id));
      if (q.get('or')) return body([]);
      const d = q.get('department_id');
      return body(TASKS.filter(t => !d || `eq.${t.department_id}` === d));
    }
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
const rpcFlags = (calls) => calls.filter(c => /\/rpc\/plan_(items|history|links)_for/.test(c.p))
  .map(c => [c.p.match(/plan_(items|history|links)_for/)[0], c.body.p_is_review]);

test('every plan projection call carries p_is_review: true for an Associate, false otherwise', async () => {
  for (const [role, want] of [['zz_assoc', true], ['zz_plain', false], ['zz_super', false], ['zz_super_review', false]]) {
    const s = stub({ role });
    await run(s, { get: { action: 'getPlan' } });
    await run(s, { get: { action: 'getPlanItem', id: MS } });
    const flags = rpcFlags(s.calls);
    const seen = new Set(flags.map(f => f[0]));
    if (role === 'zz_assoc') assert.deepEqual([...seen].sort(), ['plan_history_for', 'plan_items_for', 'plan_links_for'], role);
    assert.ok(flags.length >= 3, role);
    assert.ok(flags.every(f => f[1] === want), `${role}: ${JSON.stringify(flags)}`);
  }
});

test('an Associate reads level R: target_text null, no restricted theme; getMe carries docket_review, not view_all', async () => {
  const { j } = await run(stub(), { get: { action: 'getPlan' } });
  assert.deepEqual(j.data.items.map(i => i.level), ['R', 'R']);
  assert.ok(j.data.items.every(i => i.target_text === null && i.restricted === null));
  assert.doesNotMatch(JSON.stringify(j.data), /ZZ restricted|ZZ target/);
  assert.equal(j.data.can_admin, false);
  const me = await run(stub(), { get: { action: 'getMe' } });
  assert.equal(me.j.data.permissions.docket_review, true);
  assert.equal(me.j.data.permissions.docket_view_all, undefined);
  assert.equal(me.j.data.permissions.docket_admin, undefined);
});

test('review pack for an Associate: team=all by default, full departments, only tasks they can open, never Founders\'', async () => {
  const { status, j } = await run(stub(), { get: { action: 'getReviewPack' } });
  assert.equal(status, 200, JSON.stringify(j));
  const d = j.data;
  assert.equal(d.team_id, null);
  assert.equal(d.can_review, true);
  assert.equal(d.can_admin, false);
  assert.equal(d.proposals, null);
  assert.equal(d.hidden_tasks, 0);
  assert.equal(d.departments.length, 2);
  const t1 = d.teams.find(t => t.department_id === D1);
  assert.deepEqual(t1.this_week, { cohort: 1, on_time: 0, miss: 1, due: 0, pct: 0 });
  assert.deepEqual(t1.slipped.map(s => s.task_no), ['DKT-0']);
  assert.deepEqual(t1.milestones.due.map(m => m.code), ['M01']);   // a level-R milestone counts like O
  const s = JSON.stringify(d);
  for (const leak of ['ZZ secret', 'DKT-SECRET', 'ZZ founders', 'ZZ other team', U(101), U(102), U(103)]) assert.ok(!s.includes(leak), leak);
  const other = await run(stub(), { get: { action: 'getReviewPack', team: D2 } });
  assert.equal(other.status, 200);                                 // any team, unlike a lead
  assert.equal(other.j.data.team_id, D2);
  assert.equal(other.j.data.teams[0].this_week.cohort, 0);         // D2's only row is one they can't open
  const lead = await run(stub({ role: 'zz_plain' }), { get: { action: 'getReviewPack' } });
  assert.equal(lead.j.data.can_review, false);
  const sup = await run(stub({ role: 'zz_super' }), { get: { action: 'getReviewPack' } });
  assert.equal(sup.j.data.can_review, true);
  assert.equal(sup.j.data.can_admin, true);
});

test('getWeekScore for an Associate: allowed, counts and rows from the tasks they can open only', async () => {
  const { status, j } = await run(stub(), { get: { action: 'getWeekScore' } });
  assert.equal(status, 200, JSON.stringify(j));
  assert.deepEqual(j.data.totals, { cohort: 1, on_time: 0, miss: 1, due: 0, pct: 0 });
  assert.deepEqual(j.data.teams.map(t => [t.department_id, t.cohort, t.team_name]), [[D1, 1, 'ZZ team 1']]);
  assert.deepEqual(j.data.tasks.map(t => t.task_no), ['DKT-0']);
  assert.equal(j.data.hidden_tasks, 0);
  assert.doesNotMatch(JSON.stringify(j.data), /ZZ secret|ZZ founders|ZZ other team/);
  assert.equal((await run(stub({ role: 'zz_plain' }), { get: { action: 'getWeekScore' } })).status, 403);
});

test('an Associate is refused the founders-only actions', async () => {
  for (const req of [{ post: { action: 'holdReview', week: 'this' } }, { get: { action: 'getReviewSnapshots', week: 'this' } },
                     { get: { action: 'getReviewSnapshots', id: U(500) } }, { get: { action: 'getFoundersReview' } },
                     { post: { action: 'setFounderFocus', week: 'this', items: [] } }]) {
    const r = await run(stub(), req);
    assert.equal(r.status, 403, JSON.stringify(req));
  }
});

test('roles: a non-plan-admin can\'t create, edit, delete or assign a docket_review role (A5); a plan admin can', async () => {
  const asAdmin = (post, otherRole) => run(stub({ role: 'zz_admin', otherRole }), { post });
  const refused = async (post, otherRole) => { const r = await asAdmin(post, otherRole); assert.equal(r.status, 403, JSON.stringify(post)); assert.equal(r.j.error, 'forbidden_super_admin'); };
  await refused({ action: 'createDocketRole', role_key: 'zz_new', label: 'Assoc', permissions: { docket_review: true } });
  await refused({ action: 'updateDocketRole', role_key: 'zz_assoc', label: 'renamed' });
  await refused({ action: 'updateDocketRole', role_key: 'zz_plain', permissions: { docket_review: true } });
  await refused({ action: 'deleteDocketRole', role_key: 'zz_assoc' });
  await refused({ action: 'assignDocketRole', user_id: OTHER, role_key: 'zz_assoc' });
  await refused({ action: 'assignDocketRole', user_id: OTHER, role_key: 'zz_plain' }, 'zz_assoc');   // demoting an Associate
  // the same admin is NOT blocked for an ordinary role / person
  assert.equal((await asAdmin({ action: 'createDocketRole', role_key: 'zz_new', label: 'Plain', permissions: { docket_view_all: true } })).status, 200);
  assert.equal((await asAdmin({ action: 'assignDocketRole', user_id: OTHER, role_key: 'zz_plain' })).status, 200);
  // a plan admin may
  const sup = await run(stub({ role: 'zz_super' }), { post: { action: 'createDocketRole', role_key: 'zz_new', label: 'Assoc', permissions: { docket_review: true } } });
  assert.equal(sup.status, 200, JSON.stringify(sup.j));
  const sup2 = await run(stub({ role: 'zz_super' }), { post: { action: 'assignDocketRole', user_id: OTHER, role_key: 'zz_assoc' } });
  assert.equal(sup2.status, 200, JSON.stringify(sup2.j));
});
