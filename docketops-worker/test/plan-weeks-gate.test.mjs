// Run: node --test docketops-worker/test/
// F9 R4 hostile review #6: getPlanWeeks end to end against a stubbed Supabase — a baseline (no-role)
// viewer asking for another team, or all teams, gets exactly what the task gate (visibleTaskRows +
// the archived-space exclusion) allows: never a General task outside their own relation, never a private
// space they aren't in, never an archived space. The worker is loaded as-is (its file is .js in a
// commonjs package, so it is imported through a data: URL with its relative imports made absolute).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const code = readFileSync(join(SRC, 'index.js'), 'utf8').replace(/from '\.\/([^']+)'/g, (_, f) => `from '${pathToFileURL(join(SRC, f)).href}'`);
const worker = (await import('data:text/javascript,' + encodeURIComponent(code))).default;

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VIEWER = U(1), VE = U(2), OTHER = U(3), OE = U(4);
const D1 = U(10), D2 = U(11);                       // the viewer is in D1
const G = U(20), PRIV = U(21), ARCH = U(22);        // General · a private space they're not in · an archived one they ARE in
const SPACES = {
  [G]: { id: G, name: 'General', is_default: true, is_private: false, owner_user_id: null, is_founders: false },
  [PRIV]: { id: PRIV, name: 'ZZ private', is_default: false, is_private: true, owner_user_id: OTHER, is_founders: false },
  [ARCH]: { id: ARCH, name: 'ZZ archived', is_default: false, is_private: true, owner_user_id: OTHER, is_founders: false },
};
const soon = new Date(Date.now() + 3600000).toISOString();
const T = (n, o) => ({ id: U(100 + n), task_no: `DKT-${n}`, title: `ZZ t${n}`, status: 'in_progress', priority: 'P2',
  owner_employee_id: OE, assignee_employee_id: null, created_by_user_id: OTHER, department_id: D2, deadline: soon,
  revised_deadline: null, space_id: G, plan_item_id: null, parent_task_id: null, created_at: '2026-01-01T00:00:00Z', ...o });
const TASKS = [
  T(1, {}),                                   // General, other team, not theirs → hidden
  T(2, { department_id: D1 }),                // General, their team → visible (team=all / own team)
  T(3, { space_id: PRIV }),                   // private, not a member → hidden
  T(4, {}),                                   // General, other team, they collaborate → visible
  T(5, { space_id: ARCH }),                   // archived space they're a member of → excluded
  T(6, { owner_employee_id: VE }),            // General, other team, they own it → visible
];

function stub() {
  return async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    const p = decodeURIComponent(u.pathname + u.search);
    const q = u.searchParams;
    const body = (d) => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/auth/v1/user') return body({ id: VIEWER, email: 'zz.viewer@legendoftoys.com' });
    if (Number(q.get('offset') || 0) > 0) return body([]);    // sbAll: one page
    if (p.includes('/users_profile?')) return body([{ role: 'viewer', full_name: 'ZZ Viewer', active: true }]);
    if (p.includes('/docket_user_roles?')) return body([]);
    if (p.includes('/employees?auth_user_id=')) return body([{ id: VE, full_name: 'ZZ Viewer', department_id: D1 }]);
    if (p.includes('/employees?')) return body([{ id: VE, full_name: 'ZZ Viewer' }, { id: OE, full_name: 'ZZ Other' }]);
    if (p.includes('/departments?')) return body([{ id: D1, name: 'ZZ team 1' }, { id: D2, name: 'ZZ team 2' }]);
    if (p.includes('/rpc/plan_items_for') || p.includes('/rpc/plan_links_for')) return body([]);
    if (p.includes('/settings?')) return body([]);
    if (p.includes('/spaces?archived_at=not.is.null')) return body([{ id: ARCH }]);
    if (p.includes('/spaces?id=in.')) {
      const ids = q.get('id').replace(/^in\.\(|\)$/g, '').split(',');
      return body(ids.map(id => SPACES[id]).filter(Boolean));
    }
    if (p.includes('/space_members?')) return body([{ space_id: ARCH }]);
    if (p.includes('/task_collaborators?')) return body([{ task_id: U(104) }]);
    if (p.includes('/task_history?') || p.includes('/task_comments?')) return body([]);
    if (u.pathname === '/rest/v1/tasks') {
      if (q.get('plan_item_id')) return body([]);
      const dept = q.get('department_id');
      return body(TASKS.filter(t => !dept || `eq.${t.department_id}` === dept));
    }
    return body([]);
  };
}

async function weeks(params) {
  const real = globalThis.fetch;
  globalThis.fetch = stub();
  try {
    const url = 'https://docketops.test/?' + new URLSearchParams({ action: 'getPlanWeeks', ...params });
    const res = await worker.fetch(new Request(url, { headers: { Authorization: 'Bearer zz' } }),
      { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_ANON_KEY: 'a' });
    const j = await res.json();
    assert.equal(j.ok, true, JSON.stringify(j));
    return j.data;
  } finally { globalThis.fetch = real; }
}
const taskIds = (d) => d.rows.flatMap(r => Object.values(r.cells).flatMap(c => c.tasks.map(t => t.task_no))).sort();

test('baseline viewer, team = another department: only the tasks they collaborate on or own', async () => {
  const d = await weeks({ team: D2 });
  assert.deepEqual(taskIds(d), ['DKT-4', 'DKT-6']);
  assert.equal(d.all_teams, false);
  const s = JSON.stringify(d);
  for (const n of [1, 3, 5]) assert.ok(!s.includes(`ZZ t${n}"`) && !s.includes(U(100 + n)), `t${n} leaked`);
});

test('baseline viewer, team = all: + their own team, still nothing hidden, nothing archived', async () => {
  const d = await weeks({ team: 'all' });
  assert.deepEqual(taskIds(d), ['DKT-2', 'DKT-4', 'DKT-6']);
  assert.equal(d.all_teams, true);
  // stale counts only what they can see (every visible task here has no update → stale)
  assert.equal(d.counts.stale, 3);
});

test('baseline viewer, default scope = their own department', async () => {
  const d = await weeks({});
  assert.equal(d.team_id, D1);
  assert.deepEqual(taskIds(d), ['DKT-2']);
});

test('a bad team id is refused', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = stub();
  try {
    const res = await worker.fetch(new Request('https://docketops.test/?action=getPlanWeeks&team=nope', { headers: { Authorization: 'Bearer zz' } }),
      { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_ANON_KEY: 'a' });
    assert.equal(res.status, 400);
  } finally { globalThis.fetch = real; }
});
