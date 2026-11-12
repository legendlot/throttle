// Run: node --test docketops-worker/test/*.test.mjs
// F9 R6b end to end against a stubbed Supabase — the Saturday founders' catch-up (spec §8.6, level F):
//   getFoundersReview lists an open cross-team `blocks` pair whose waiting task is due this week or next, skips
//   a same-team pair, one due in three weeks, one whose blocker is done and a both-null-team pair, counts (never
//   lists) a pair whose blocker is in a private space, and returns both founders' top 5 (caller first; a ref to
//   a task the caller can't open → null, its note kept) and one Slack message; setFounderFocus validates before
//   anything is written, refuses a week that is over, and sends the RPC the normalised items.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const code = readFileSync(join(SRC, 'index.js'), 'utf8').replace(/from '\.\/([^']+)'/g, (_, f) => `from '${pathToFileURL(join(SRC, f)).href}'`);
const worker = (await import('data:text/javascript,' + encodeURIComponent(code))).default;

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ME = U(1), MEE = U(2), VIN = U(5), OE = U(3), D1 = U(10), D2 = U(11), G = U(20), PRIV = U(21), P1 = U(300);
const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_ANON_KEY: 'a' };
const SPACES = {
  [G]: { id: G, name: 'General', is_default: true, is_private: false, owner_user_id: null, is_founders: false },
  [PRIV]: { id: PRIV, name: 'ZZ private', is_default: false, is_private: true, owner_user_id: U(9), is_founders: false },
};
const addD = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const TODAY = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
const WE = addD(TODAY, (7 - (new Date(`${TODAY}T00:00:00Z`).getUTCDay() || 7)) % 7), WS = addD(WE, -6);
const at = (d) => new Date(Date.parse(`${d}T12:00:00+05:30`)).toISOString();
const T = (n, o) => ({ id: U(100 + n), task_no: `DKT-${n}`, title: `ZZ t${n}`, status: 'in_progress', priority: 'P2', owner_employee_id: OE,
  assignee_employee_id: null, created_by_user_id: U(9), department_id: D1, deadline: at(WS), revised_deadline: null, space_id: G,
  plan_item_id: null, parent_task_id: null, created_at: '2026-01-01T00:00:00Z', archived_at: null, ...o });
// waiting (blocked) tasks — what the window read returns (the stub hands back the out-of-window one too)
const A = [
  T(1, { title: 'ZZ waits next week', deadline: at(addD(WE, 3)) }),
  T(2, { title: 'ZZ same team' }),
  T(3, { title: 'ZZ waits on secret' }),
  T(4, { title: 'ZZ three weeks out', deadline: at(addD(WE, 20)) }),
  T(5, { title: 'ZZ blocker done' }),
  T(6, { title: 'ZZ both no team', department_id: null }),
  T(7, { title: 'ZZ no team vs set', department_id: null, revised_deadline: at(WS) }),
];
// blockers
const B = [
  T(11, { title: 'ZZ blocker other team', department_id: D2 }),
  T(12, { title: 'ZZ blocker same team', department_id: D1 }),
  T(13, { title: 'ZZ secret blocker', task_no: 'DKT-SECRET', department_id: D2, space_id: PRIV }),
  T(14, { title: 'ZZ far blocker', department_id: D2 }),
  T(15, { title: 'ZZ done blocker', department_id: D2, status: 'done' }),
  T(16, { title: 'ZZ null blocker', department_id: null }),
  T(17, { title: 'ZZ abandoned blocker', department_id: D2, status: 'abandoned' }),
];
const LINKS = A.map((a, i) => ({ id: U(400 + i + 1), from_task_id: B[i].id, to_task_id: a.id }));
const HIDDEN_TASK = T(30, { title: 'ZZ focus secret', space_id: PRIV });
const ALL = [...A, ...B, HIDDEN_TASK];

function stub({ superAdmin = true, weeksRow = null, rpcError = null } = {}) {
  const calls = [];
  const fn = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    const p = decodeURIComponent(u.pathname + u.search);
    const q = u.searchParams;
    const method = (init.method || 'GET').toUpperCase();
    const reqBody = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, p, body: reqBody });
    const body = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
    const ids = () => (q.get('id') || '').replace(/^in\.\(|\)$/g, '').split(',');
    if (u.pathname === '/auth/v1/user') return body({ id: ME, email: 'zz.me@legendoftoys.com' });
    if (Number(q.get('offset') || 0) > 0) return body([]);
    if (p.startsWith('/rest/v1/users_profile?id=eq.')) return body([{ role: 'viewer', full_name: 'ZZ Me', active: true }]);
    if (p.startsWith('/rest/v1/users_profile?id=in.')) return body([{ id: ME, full_name: 'ZZ Me' }, { id: VIN, full_name: 'ZZ Vinay' }].filter(x => ids().includes(x.id)));
    if (p.startsWith('/rest/v1/docket_user_roles?user_id=eq.')) return body(superAdmin ? [{ role_key: 'zz_super' }] : []);
    if (p.startsWith('/rest/v1/docket_user_roles?role_key=in.')) return body([{ user_id: VIN }, { user_id: ME }]);
    if (p.startsWith('/rest/v1/docket_roles?role_key=eq.')) return body([{ permissions: { docket_plan_admin: true } }]);
    if (p.startsWith('/rest/v1/docket_roles?select=')) return body([{ role_key: 'zz_super', permissions: { docket_plan_admin: true } }, { role_key: 'zz_plain', permissions: {} }]);
    if (p.includes('/employees?auth_user_id=')) return body([{ id: MEE, full_name: 'ZZ Me', department_id: D1 }]);
    if (p.includes('/employees?')) return body([{ id: OE, full_name: 'ZZ Owner' }]);
    if (p.includes('/departments?')) return body([{ id: D1, name: 'ZZ team 1' }, { id: D2, name: 'ZZ team 2' }]);
    if (p.includes('/settings?')) return body([]);
    if (p.startsWith('/rest/v1/weeks?')) return body(weeksRow ? [weeksRow] : []);
    if (p.includes('/rpc/plan_items_for')) return body([{ id: P1, kind: 'milestone', code: 'M01', title: 'ZZ ms', state: 'agreed', due_date: WE, revised_due_date: null, level: 'F' }]);
    if (p.includes('/rpc/founder_focus_set')) return rpcError ? body({ message: rpcError }, 400) : body([]);
    if (p.includes('/rpc/')) return body([]);
    if (p.startsWith('/rest/v1/founder_focus?')) return body([
      { founder_user_id: ME, rank: 1, plan_item_id: P1, task_id: null, note: 'zz why', updated_at: '2026-11-12T01:00:00Z' },
      { founder_user_id: ME, rank: 2, plan_item_id: null, task_id: HIDDEN_TASK.id, note: 'zz hidden note', updated_at: '2026-11-12T02:00:00Z' },
      { founder_user_id: VIN, rank: 1, plan_item_id: null, task_id: null, note: 'zz vin', updated_at: '2026-11-11T01:00:00Z' }]);
    if (p.startsWith('/rest/v1/spaces?id=in.')) return body(ids().map(id => SPACES[id]).filter(Boolean));
    if (p.startsWith('/rest/v1/space_members?')) return body([]);
    if (p.startsWith('/rest/v1/task_links?')) {
      assert.equal(q.get('kind'), 'eq.blocks');
      const to = (q.get('to_task_id') || '').replace(/^in\.\(|\)$/g, '').split(',');
      return body(LINKS.filter(l => to.includes(l.to_task_id)));
    }
    if (p.startsWith('/rest/v1/tasks?id=in.')) return body(ALL.filter(t => ids().includes(t.id)));
    if (u.pathname === '/rest/v1/tasks' && method === 'GET') {
      // the waiting-task read must carry its window as a real or= filter
      assert.match(q.get('or') || '', /^\(and\(revised_deadline\.gte\..+\),and\(revised_deadline\.is\.null,deadline\.gte\./);
      return body(A);
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

test('getFoundersReview: cross-team asks this week or next; same-team / far / done-blocker / both-null skipped; a private blocker counted only', async () => {
  const { status, j } = await run(stub(), { get: { action: 'getFoundersReview' } });
  assert.equal(status, 200, JSON.stringify(j));
  const d = j.data;
  assert.deepEqual(d.week, { week_end: WE, week_start: WS });
  // listed: next-week cross-team (1) and null-vs-set team with an abandoned blocker (7); sorted by due date
  assert.deepEqual(d.asks.map(a => a.blocked.task_no), ['DKT-7', 'DKT-1']);
  assert.equal(d.hidden_asks, 1);
  const a1 = d.asks.find(a => a.blocked.task_no === 'DKT-1');
  assert.equal(a1.link_id, U(401));
  assert.deepEqual(a1.blocker, { task_id: U(111), task_no: 'DKT-11', title: 'ZZ blocker other team', team_id: D2, team_name: 'ZZ team 2',
    owner_employee_id: OE, owner_name: 'ZZ Owner', effective_deadline: at(WS), status: 'in_progress' });
  assert.equal(a1.blocked.team_name, 'ZZ team 1');
  assert.equal(d.asks[0].blocker.status, 'abandoned');
  const s = JSON.stringify(d);
  for (const leak of ['ZZ secret blocker', 'DKT-SECRET', 'ZZ waits on secret', 'ZZ same team', 'ZZ three weeks out', 'ZZ blocker done', 'ZZ both no team', 'ZZ focus secret'])
    assert.ok(!s.includes(leak), leak);
});

test('getFoundersReview: both founders\' top 5, caller first; a hidden task ref → null with its note; one Slack message, no ids', async () => {
  const { j } = await run(stub(), { get: { action: 'getFoundersReview', week: 'this' } });
  const [me, vin] = j.data.focus;
  assert.deepEqual([me.founder_name, me.is_me, vin.founder_name, vin.is_me], ['ZZ Me', true, 'ZZ Vinay', false]);
  assert.equal(me.updated_at, '2026-11-12T02:00:00Z');
  assert.deepEqual(me.items[0], { rank: 1, plan_item_id: P1, task_id: null, note: 'zz why', ref: { kind: 'item', code: 'M01', title: 'ZZ ms', state: 'agreed', due: WE } });
  assert.deepEqual(me.items[1], { rank: 2, plan_item_id: null, task_id: HIDDEN_TASK.id, note: 'zz hidden note', ref: null });
  assert.deepEqual(vin.items.map(i => i.note), ['zz vin']);
  const sl = j.data.slack;
  assert.equal(typeof sl, 'string');
  assert.match(sl, /Cross-team asks/);
  assert.match(sl, /DKT-1 ZZ waits next week \(ZZ team 1, ZZ Owner\) waits on DKT-11 ZZ blocker other team \(ZZ team 2, ZZ Owner\)/);
  assert.match(sl, /\+1 more in spaces you can't open/);
  assert.match(sl, /\*ZZ Me's top 5\*\n1\. M01 ZZ ms — “zz why”\n2\. “zz hidden note”/);
  assert.match(sl, /\*ZZ Vinay's top 5\*/);
  assert.doesNotMatch(sl, /[0-9a-f]{8}-[0-9a-f]{4}-/);
  assert.doesNotMatch(sl, /ZZ focus secret|DKT-SECRET/);
});

test('getFoundersReview: plan admin only; a bad week is refused', async () => {
  const r = await run(stub({ superAdmin: false }), { get: { action: 'getFoundersReview' } });
  assert.equal(r.status, 403); assert.equal(r.j.error, 'forbidden');
  const b = await run(stub(), { get: { action: 'getFoundersReview', week: 'nope' } });
  assert.equal(b.status, 400); assert.equal(b.j.error, 'bad_week');
});

test('setFounderFocus: validation errors are 400 with their code and write nothing', async () => {
  const cases = [
    [{ items: [1, 2, 3, 4, 5, 6].map(rank => ({ rank, note: 'zz' })) }, 'too_many'],
    [{ items: [{ rank: 1, note: 'a' }, { rank: 1, note: 'b' }] }, 'bad_rank'],
    [{ items: [{ rank: 6, note: 'a' }] }, 'bad_rank'],
    [{ items: [{ rank: '1', note: 'a' }] }, 'bad_rank'],
    [{ items: [{ rank: 1, plan_item_id: P1, task_id: U(101) }] }, 'bad_item'],
    [{ items: [{ rank: 1, note: '   ' }] }, 'bad_item'],
    [{ items: [{ rank: 1, task_id: 'nope' }] }, 'bad_item'],
    [{ items: 'x' }, 'bad_item'],
    [{ items: [{ rank: 1, note: 'z'.repeat(501) }] }, 'note_too_long'],
    [{ items: [{ rank: 1, plan_item_id: U(399) }] }, 'not_found'],            // not in the caller's plan_items_for
    [{ items: [{ rank: 1, task_id: HIDDEN_TASK.id }] }, 'not_found'],         // a task they can't open
    [{ week: 'whenever', items: [] }, 'bad_week'],
  ];
  for (const [d, code] of cases) {
    const s = stub();
    const r = await run(s, { post: { action: 'setFounderFocus', ...d } });
    assert.equal(r.status, 400, JSON.stringify(d));
    assert.equal(r.j.error, code, JSON.stringify(d));
    assert.equal(s.calls.filter(c => c.p.includes('/rpc/founder_focus_set')).length, 0, JSON.stringify(d));
  }
});

test('setFounderFocus: a week that is over (or closed) → 409; valid items go to the RPC normalised; plan admin only', async () => {
  const s0 = stub();
  const past = await run(s0, { post: { action: 'setFounderFocus', week: addD(WS, -3), items: [] } });
  assert.equal(past.status, 409); assert.equal(past.j.error, 'week_closed');
  const closed = await run(stub({ weeksRow: { week_end: WE, week_start: WS, closed_at: '2026-11-16T00:00:00Z' } }), { post: { action: 'setFounderFocus', items: [] } });
  assert.equal(closed.status, 409);
  const s = stub();
  const { status, j } = await run(s, { post: { action: 'setFounderFocus', week: 'next', items: [{ rank: 2, task_id: U(101) }, { rank: 1, plan_item_id: P1, note: ' zz why ' }] } });
  assert.equal(status, 200, JSON.stringify(j));
  const rpc = s.calls.find(c => c.p.includes('/rpc/founder_focus_set'));
  assert.deepEqual(rpc.body, { p_actor: ME, p_week_end: addD(WE, 7), p_items: [
    { rank: 1, plan_item_id: P1, task_id: null, note: 'zz why' }, { rank: 2, plan_item_id: null, task_id: U(101), note: null }] });
  assert.equal(j.data.focus.is_me, true);
  assert.equal(j.data.focus.founder_name, 'ZZ Me');
  const lost = await run(stub({ rpcError: 'week_closed' }), { post: { action: 'setFounderFocus', items: [] } });
  assert.equal(lost.status, 409);
  const no = await run(stub({ superAdmin: false }), { post: { action: 'setFounderFocus', items: [] } });
  assert.equal(no.status, 403);
});
