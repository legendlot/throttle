// Run: node --test docketops-worker/test/*.test.mjs
// F9 R9a end to end against a stubbed Supabase: template visibility (a non-lead sees nothing and reads nothing;
// a lead sees only `leads` templates, archived ones only their own; a plan admin everything), the preview (a
// non-editor gets titles + shape only, with roles and span), save / archive / apply reaching their RPCs with the
// caller's identity and X-LOT-Source → p_source, RPC codes → TEMPLATE_ERR (status, message, key / label); and
// getPlanTree (one items read, one batched task read, one visibility pass; hidden at F only; below F never a
// Founders'-space task; an unknown theme → 404).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const code = readFileSync(join(SRC, 'index.js'), 'utf8').replace(/from '\.\/([^']+)'/g, (_, f) => `from '${pathToFileURL(join(SRC, f)).href}'`);
const worker = (await import('data:text/javascript,' + encodeURIComponent(code))).default;

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ME = U(1), MEE = U(2), OTHER = U(8), D1 = U(10), G = U(20), PRIV = U(21), FND = U(22);
const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_ANON_KEY: 'a' };
const SPACES = {
  [G]: { id: G, name: 'General', is_default: true, is_private: false, owner_user_id: null, is_founders: false },
  [PRIV]: { id: PRIV, name: 'ZZ private', is_default: false, is_private: true, owner_user_id: U(9), is_founders: false },
  [FND]: { id: FND, name: 'Founders', is_default: false, is_private: true, owner_user_id: U(9), is_founders: true },
};
const TPL = (n, o) => ({ id: U(500 + n), name: `ZZ tpl ${n}`, description: null, audience: 'leads', created_by: OTHER, archived_at: null,
  created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', ...o });
const TEMPLATES = [TPL(1), TPL(2, { audience: 'founders', name: 'ZZ founders tpl' }), TPL(3, { created_by: ME, name: 'ZZ mine' }),
  TPL(4, { archived_at: '2026-11-02T00:00:00Z', name: 'ZZ archived other' }), TPL(5, { created_by: ME, archived_at: '2026-11-02T00:00:00Z', name: 'ZZ archived mine' })];
const NODES = [
  { id: U(601), template_id: U(501), parent_node_id: null, kind: 'result', title: 'ZZ res', role_label: 'Owner', offset_days: 5, done_when: 'zz secret done', sort: 10 },
  { id: U(602), template_id: U(501), parent_node_id: U(601), kind: 'task', title: 'ZZ task', role_label: ' owner', offset_days: -2, done_when: null, sort: 20 },
  { id: U(603), template_id: U(501), parent_node_id: null, kind: 'task', title: 'ZZ help', role_label: 'Helper', offset_days: 9, done_when: null, sort: 30 },
];
const inIds = (v) => (v || '').replace(/^in\.\(|\)$/g, '').split(',');

function stub({ superAdmin = false, lead = false, planRows = [], structure = null, tasks = [], members = [], rpc = {} } = {}) {
  const calls = [];
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
    if (p.startsWith('/rest/v1/users_profile?id=in.')) return body([{ id: ME, full_name: 'ZZ Me' }, { id: OTHER, full_name: 'ZZ Other' }].filter(x => inIds(q.get('id')).includes(x.id)));
    if (p.startsWith('/rest/v1/docket_user_roles?user_id=eq.')) return body(superAdmin ? [{ role_key: 'zz_super' }] : []);
    if (p.startsWith('/rest/v1/docket_roles?')) return body([{ role_key: 'zz_super', permissions: { docket_plan_admin: true } }]);
    if (p.includes('/employees?auth_user_id=')) return body([{ id: MEE, full_name: 'ZZ Me', department_id: D1 }]);
    if (p.includes('/employees?')) return body([{ id: MEE, full_name: 'ZZ Me' }, { id: U(3), full_name: 'ZZ Owner' }].filter(x => inIds(q.get('id')).includes(x.id)));
    if (p.includes('/rpc/plan_is_lead')) return body(lead);
    if (p.includes('/rpc/plan_items_for')) return body(planRows);
    if (p.startsWith('/rest/v1/plan_items?select=id,parent_id,kind')) return body(structure || planRows.map(i => ({ id: i.id, parent_id: i.parent_id, kind: i.kind })));
    const m = /\/rpc\/(plan_template_\w+)/.exec(p);
    if (m) return body(rpc[m[1]] || { ok: true, id: U(599), archived: true, items: [{ key: U(601), id: U(700), code: 'M01.R1', kind: 'result', state: 'agreed' }], tasks: [] });
    if (p.includes('/rpc/')) return body([]);
    if (p.startsWith('/rest/v1/plan_templates?')) {
      return body(TEMPLATES.filter(t => (!q.get('audience') || `eq.${t.audience}` === q.get('audience'))
        && (q.get('archived_at') !== 'is.null' || !t.archived_at) && (!q.get('id') || `eq.${t.id}` === q.get('id'))));
    }
    if (p.startsWith('/rest/v1/plan_template_nodes?')) {
      const tid = q.get('template_id') || '';
      return body(NODES.filter(n => (tid.startsWith('eq.') ? `eq.${n.template_id}` === tid : inIds(tid).includes(n.template_id))));
    }
    if (p.startsWith('/rest/v1/spaces?archived_at=not.is.null')) return body([]);
    if (p.startsWith('/rest/v1/spaces?id=in.')) return body(inIds(q.get('id')).map(id => SPACES[id]).filter(Boolean));
    if (p.startsWith('/rest/v1/space_members?')) return body(members.map(space_id => ({ space_id })));
    if (u.pathname === '/rest/v1/tasks' && method === 'GET') {
      if (q.get('plan_item_id')?.startsWith('in.')) return body(tasks.filter(t => inIds(q.get('plan_item_id')).includes(t.plan_item_id)
        && (q.get('is_recurring') !== 'eq.false' || !t.is_recurring)));
      return body([]);
    }
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

test('getTemplates: a non-lead sees nothing and no template is read; can_create both false', async () => {
  const s = stub();
  const r = await run(s, { get: { action: 'getTemplates', archived: '1' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.data, { templates: [], can_create: { founders: false, leads: false } });
  assert.equal(s.calls.some(c => c.p.includes('plan_template')), false);
  const t = await run(stub(), { get: { action: 'getTemplate', id: U(501) } });
  assert.equal(t.status, 404);
});

test('getTemplates: a lead sees leads templates only (archived = their own, with archived=1); a plan admin all', async () => {
  let s = stub({ lead: true });
  let r = await run(s, { get: { action: 'getTemplates' } });
  assert.deepEqual(r.j.data.templates.map(t => t.name), ['ZZ tpl 1', 'ZZ mine']);
  assert.deepEqual(r.j.data.can_create, { founders: false, leads: true });
  assert.match(s.calls.find(c => c.p.startsWith('/rest/v1/plan_templates?')).p, /audience=eq\.leads/);
  const one = r.j.data.templates[0];
  assert.deepEqual(one, { id: U(501), name: 'ZZ tpl 1', description: null, audience: 'leads', node_count: 3, roles: ['Helper', 'Owner'],
    span: { min_offset: -2, max_offset: 9 }, created_by_name: 'ZZ Other', mine: false, can_edit: false, can_apply_kind: 'milestone', archived: false });
  assert.equal(r.j.data.templates[1].can_edit, true);
  assert.ok(!('created_by' in one));
  r = await run(stub({ lead: true }), { get: { action: 'getTemplates', archived: '1' } });
  assert.deepEqual(r.j.data.templates.map(t => t.name).sort(), ['ZZ archived mine', 'ZZ mine', 'ZZ tpl 1']);
  r = await run(stub({ superAdmin: true }), { get: { action: 'getTemplates', archived: '1' } });
  assert.equal(r.j.data.templates.length, 5);
  assert.deepEqual(r.j.data.can_create, { founders: true, leads: true });
  assert.equal(r.j.data.templates.find(t => t.audience === 'founders').can_apply_kind, 'theme');
});

test('getTemplate: a non-editor gets the title-only preview (+ roles, span); the editor every field; founders → 404 for a lead', async () => {
  let r = await run(stub({ lead: true }), { get: { action: 'getTemplate', id: U(501) } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.data.nodes[1], { id: U(602), parent_node_id: U(601), kind: 'task', title: 'ZZ task' });
  assert.doesNotMatch(JSON.stringify(r.j.data.nodes), /zz secret done|offset_days|role_label/);
  assert.deepEqual(r.j.data.template.roles, ['Helper', 'Owner']);
  assert.deepEqual(r.j.data.template.span, { min_offset: -2, max_offset: 9 });
  r = await run(stub({ superAdmin: true }), { get: { action: 'getTemplate', id: U(501) } });
  assert.equal(r.j.data.nodes[0].done_when, 'zz secret done'); assert.equal(r.j.data.nodes[1].offset_days, -2);
  for (const id of [U(502), U(504), 'nope']) {
    r = await run(stub({ lead: true }), { get: { action: 'getTemplate', id } });
    assert.equal(r.status, 404, id);
  }
  r = await run(stub({ lead: true }), { get: { action: 'getTemplate', id: U(505) } });   // archived, but theirs
  assert.equal(r.status, 200);
});

test('save / archive / apply reach their RPCs as the caller; the connector → p_source connector; codes → readable errors', async () => {
  let s = stub({ lead: true });
  const tpl = { name: 'ZZ', audience: 'leads', nodes: [{ key: 'r', kind: 'result', title: 't', role_label: 'A', offset_days: 1, done_when: 'd' }] };
  let r = await run(s, { post: { action: 'saveTemplate', template: tpl } });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(r.j.data.id, U(599));
  assert.deepEqual(s.calls.find(c => c.p.includes('plan_template_save')).body, { p_actor: ME, p_actor_employee: MEE, p_is_super: false, p_template: tpl });
  s = stub({ rpc: { plan_template_save: { ok: false, code: 'done_when_required', key: 'm' } } });
  r = await run(s, { post: { action: 'saveTemplate', template: tpl } });
  assert.equal(r.status, 400); assert.equal(r.j.error, 'done_when_required'); assert.equal(r.j.key, 'm'); assert.match(r.j.message, /done when/);
  r = await run(stub(), { post: { action: 'saveTemplate', template: 'x' } });
  assert.equal(r.status, 400); assert.equal(r.j.error, 'bad_node');

  s = stub();
  r = await run(s, { post: { action: 'archiveTemplate', id: U(503), archive: false } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(s.calls.find(c => c.p.includes('plan_template_archive')).body, { p_actor: ME, p_is_super: false, p_id: U(503), p_archive: false });
  s = stub({ rpc: { plan_template_archive: { ok: false, code: 'forbidden' } } });
  r = await run(s, { post: { action: 'archiveTemplate', id: U(503) } });
  assert.equal(r.status, 403);

  s = stub({ lead: true });
  const roles = { Owner: MEE, Helper: U(3) };
  r = await run(s, { post: { action: 'applyTemplate', id: U(501), anchor_id: U(800), anchor_date: '2026-11-20', roles, extra: 'ignored' },
    headers: { 'X-LOT-Source': 'connector' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.data, { items: [{ key: U(601), id: U(700), code: 'M01.R1', kind: 'result', state: 'agreed' }], tasks: [] });
  assert.deepEqual(s.calls.find(c => c.p.includes('plan_template_apply')).body, { p_actor: ME, p_actor_employee: MEE, p_is_super: false,
    p_template_id: U(501), p_payload: { anchor_id: U(800), anchor_date: '2026-11-20', roles }, p_source: 'connector' });
  s = stub({ rpc: { plan_template_apply: { ok: false, code: 'owner_inactive', label: 'Helper' } } });
  r = await run(s, { post: { action: 'applyTemplate', id: U(501), anchor_id: U(800), anchor_date: '2026-11-20', roles } });
  assert.equal(r.status, 400); assert.equal(r.j.label, 'Helper'); assert.match(r.j.message, /has left/);
  assert.equal(s.calls.find(c => c.p.includes('plan_template_apply')).body.p_source, 'app');
  s = stub({ rpc: { plan_template_apply: { ok: false, code: 'zz_some_trigger', key: U(602) } } });
  r = await run(s, { post: { action: 'applyTemplate', id: U(501), anchor_id: U(800), anchor_date: '2026-11-20', roles } });
  assert.equal(r.status, 400); assert.match(r.j.message, /nothing was created/); assert.equal(r.j.key, U(602));
  s = stub({ rpc: { plan_template_apply: { ok: false, code: 'forbidden_space' } } });
  r = await run(s, { post: { action: 'applyTemplate', id: U(501), anchor_id: U(800), anchor_date: '2026-11-20', roles } });
  assert.equal(r.status, 403); assert.equal(r.j.error, 'forbidden_space'); assert.match(r.j.message, /that space — nothing was created/);
  r = await run(stub(), { post: { action: 'applyTemplate', id: 'x' } });
  assert.equal(r.status, 404);
});

// ── the tree ──
const PI = (id, o) => ({ id, kind: 'milestone', code: id.slice(-3), parent_id: null, title: `ZZ ${id.slice(-3)}`, owner_employee_id: MEE,
  department_id: null, target_text: null, done_when: 'zz', measure: null, due_date: '2026-11-20', revised_due_date: null, state: 'agreed',
  split_from_id: null, restricted: false, sort: 0, level: 'F', ...o });
const TK = (n, o) => ({ id: U(900 + n), task_no: `DKT-${n}`, title: `ZZ task ${n}`, status: 'in_progress', owner_employee_id: U(3), assignee_employee_id: null,
  created_by_user_id: U(9), department_id: D1, deadline: '2026-12-01T12:30:00.000Z', revised_deadline: null, completed_at: null, space_id: G,
  plan_item_id: U(301), parent_task_id: null, handoff_to_department_id: null, handoff_to_employee_id: null, is_recurring: false, ...o });
const TREE_ITEMS = [PI(U(300), { kind: 'theme', owner_employee_id: null, due_date: null, done_when: null }), PI(U(301), { parent_id: U(300), target_text: 'zz target' })];
const TREE_TASKS = [TK(1), TK(2, { space_id: PRIV, title: 'ZZ secret task' }), TK(3, { space_id: FND, title: 'ZZ founders task' }),
  TK(4, { is_recurring: true, title: 'ZZ recurring task' })];   // a recurring task is never in the tree

test('getPlanTree (F): one items read, one batched task read, private-space task counted as hidden only; no target_text', async () => {
  const s = stub({ superAdmin: true, planRows: TREE_ITEMS, tasks: TREE_TASKS, members: [FND] });
  const r = await run(s, { get: { action: 'getPlanTree' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const m = r.j.data.items.find(i => i.id === U(301));
  assert.deepEqual(m.counts, { open: 2, done: 0, overdue: 0, hidden: 1 });
  assert.equal(r.j.data.hidden_total, 1);
  assert.deepEqual(r.j.data.tasks[U(301)].rows.map(t => t.title).sort(), ['ZZ founders task', 'ZZ task 1']);
  assert.doesNotMatch(JSON.stringify(r.j.data), /ZZ secret task|zz target|ZZ recurring task/);
  assert.ok(r.j.data.generated_at);
  const reads = s.calls.filter(c => c.p.startsWith('/rest/v1/tasks?'));
  assert.equal(reads.length, 1);
  assert.match(reads[0].p, /plan_item_id=in\.\(.*\)&parent_task_id=is\.null&archived_at=is\.null&is_recurring=eq\.false/);
  assert.equal(s.calls.filter(c => c.p.includes('/rpc/plan_items_for')).length, 1);
});

test('getPlanTree (below F): the Founders\'-space and private tasks are in no count, hidden 0, no hidden_total; unknown theme → 404', async () => {
  const rows = TREE_ITEMS.map(i => ({ ...i, level: i.kind === 'theme' ? 'T' : 'O', target_text: null }));
  const r = await run(stub({ planRows: rows, tasks: TREE_TASKS, members: [FND] }), { get: { action: 'getPlanTree', mine: '1' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const m = r.j.data.items.find(i => i.id === U(301));
  assert.deepEqual(m.counts, { open: 1, done: 0, overdue: 0, hidden: 0 });
  assert.ok(!('hidden_total' in r.j.data));
  assert.doesNotMatch(JSON.stringify(r.j.data), /ZZ founders task|ZZ secret task/);
  const t = r.j.data.items.find(i => i.id === U(300));
  assert.equal(t.level, 'T'); assert.equal(t.owner_name, null);
  for (const theme of [U(399), U(301), 'x']) {
    const x = await run(stub({ planRows: rows }), { get: { action: 'getPlanTree', theme } });
    assert.equal(x.status, 404, theme);
  }
  const ok1 = await run(stub({ planRows: rows, tasks: TREE_TASKS }), { get: { action: 'getPlanTree', theme: U(300) } });
  assert.equal(ok1.status, 200);
});

test('getPlanTree: a result under a milestone the caller can\'t see hangs under its theme, survives theme=, rolls into the theme', async () => {
  // projection (level O): the theme + a result; its milestone U(310) is hidden — only the server-side structure knows it
  const rows = [PI(U(300), { kind: 'theme', level: 'O', owner_employee_id: null, due_date: null, done_when: null }),
    PI(U(302), { kind: 'result', level: 'O', parent_id: null, title: 'ZZ orphan result' })];
  const structure = [{ id: U(300), parent_id: null, kind: 'theme' }, { id: U(310), parent_id: U(300), kind: 'milestone' },
    { id: U(302), parent_id: U(310), kind: 'result' }, { id: U(320), parent_id: null, kind: 'theme' }];
  const tasks = [TK(5, { plan_item_id: U(302) }), TK(6, { plan_item_id: U(310), title: 'ZZ task on hidden ms' }), TK(7, { plan_item_id: U(302), space_id: PRIV })];
  for (const theme of [null, U(300)]) {
    const s = stub({ planRows: rows, structure, tasks });
    const r = await run(s, { get: { action: 'getPlanTree', ...(theme ? { theme } : {}) } });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    assert.deepEqual(r.j.data.items.map(i => [i.id, i.parent_id]), [[U(300), null], [U(302), U(300)]], String(theme));
    const th = r.j.data.items[0], res = r.j.data.items[1];
    assert.deepEqual(th.counts, { open: 2, done: 0, overdue: 0, hidden: 0 });           // task 5 + the hidden milestone's task 6
    assert.deepEqual(res.counts, { open: 1, done: 0, overdue: 0, hidden: 0 });
    assert.deepEqual(Object.keys(r.j.data.tasks), [U(302)]);                           // leaves: direct only — no hidden item's id
    assert.ok(!JSON.stringify(r.j.data).includes(U(310)));
    assert.match(inIds(new URL('https://x' + s.calls.find(c => c.p.startsWith('/rest/v1/tasks?')).p).searchParams.get('plan_item_id')).join(), new RegExp(U(310)));
  }
  const other = await run(stub({ planRows: rows, structure, tasks }), { get: { action: 'getPlanTree', theme: U(320) } });
  assert.equal(other.status, 404);                                                    // a theme the caller can't see
});
