// Run: node --test docketops-worker/test/*.test.mjs
// F8 P2 record checklists against a stubbed Supabase: a record's visibility is its space's (a private record is
// absent from a non-member's list, a 404 by id, and only a count on a task's Checklists strip — its title never
// in the response); ticking is open to every viewer (C6); title / owner / product / archive is the owner's,
// creator's or an admin's; a link needs the record in the task's own space (P3c); createTaskFromRecordItem
// goes through createTask in the record's space and refuses an item that already has a task.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const code = readFileSync(join(SRC, 'index.js'), 'utf8').replace(/from '\.\/([^']+)'/g, (_, f) => `from '${pathToFileURL(join(SRC, f)).href}'`);
const worker = (await import('data:text/javascript,' + encodeURIComponent(code))).default;

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// ME = auth user (employee MEE, dept D2). OWNER owns the private space and creates the records.
const ME = U(1), MEE = U(2), OE = U(3), OWNER = U(9), D1 = U(10), D2 = U(11), G = U(20), PRIV = U(21), P2 = U(23), TPL = U(30), SEC = U(31), PERS = U(27), HOME = U(32);   // PERS: ME's personal space (ensure_personal_space); HOME: D2's home space
const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_ANON_KEY: 'a' };
const SPACES = {
  [G]: { id: G, name: 'General', is_default: true, is_private: false, owner_user_id: null, is_founders: false, archived_at: null },
  [PRIV]: { id: PRIV, name: 'ZZ private', is_default: false, is_private: true, owner_user_id: OWNER, is_founders: true, archived_at: null },
  [PERS]: { id: PERS, name: 'Personal', is_default: false, is_private: true, owner_user_id: ME, is_founders: false, is_personal: true, archived_at: null },
  [HOME]: { id: HOME, name: 'ZZ home', is_default: false, is_private: true, owner_user_id: OWNER, is_founders: false, is_personal: false, archived_at: null, home_department_id: D2 },
  [P2]: { id: P2, name: 'ZZ team space', is_default: false, is_private: true, owner_user_id: OWNER, is_founders: false, archived_at: null },
};
const REC = (n, o) => ({ id: U(200 + n), template_id: TPL, template_version: 1, title: `ZZ rec ${n}`, product: null, space_id: G,
  owner_employee_id: OE, status: 'open', created_by_user_id: OWNER, created_at: '2026-11-13T00:00:00Z', updated_at: null,
  completed_at: null, archived_at: null, ...o });
const ITEM = (n, rec, o) => ({ id: U(300 + n), record_id: U(200 + rec), source_item_id: null, section_title: 'S', title: `ZZ item ${n}`,
  help_text: null, sort_order: n, state: 'open', na_reason: null, done_by_user_id: null, done_at: null, note: null, task_id: null, ...o });
const T = (n, o) => ({ id: U(100 + n), task_no: `DKT-${n}`, title: `ZZ t${n}`, status: 'in_progress', priority: 'P2', owner_employee_id: MEE,
  assignee_employee_id: null, created_by_user_id: ME, department_id: D2, deadline: null, revised_deadline: null, space_id: G,
  plan_item_id: null, parent_task_id: null, program_id: null, created_at: '2026-01-01T00:00:00Z', is_recurring: false, archived_at: null,
  handoff_to_department_id: null, handoff_to_employee_id: null, handoff_accepted_at: null, handoff_accepted_by: null, ...o });
const inIds = (v) => (v || '').replace(/^in\.\(|\)$/g, '').split(',');

// race: a task id that "wins" the item claim between createTaskFromRecordItem's read and its claim.
// archivedTrigger: the 0032 trigger refusing an item write on an archived record. tmplItems: the template's items.
function stub({ records = [], items = [], links = [], tasks = [], members = [], perms = {}, history = [], race = null, archivedTrigger = false, tmplItems = [], fail = {}, home = false } = {}) {   // home: D2 has a home space (HOME)
  const db = { records: records.map(r => ({ ...r })), items: items.map(i => ({ ...i })), links: links.map(l => ({ ...l })), tasks: tasks.map(t => ({ ...t })) };
  const calls = [];
  const fn = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    const p = decodeURIComponent(u.pathname + u.search), q = u.searchParams;
    const method = (init.method || 'GET').toUpperCase();
    const reqBody = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, p, body: reqBody });
    const body = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
    const eq = (k) => (q.get(k) || '').replace(/^eq\./, '');
    const pick = (rows, k) => { const v = q.get(k); if (!v) return rows; if (v.startsWith('eq.')) return rows.filter(r => r[k] === v.slice(3)); if (v.startsWith('in.')) return rows.filter(r => inIds(v).includes(r[k])); if (v === 'is.null') return rows.filter(r => r[k] == null); return rows; };
    if (u.pathname === '/auth/v1/user') return body({ id: ME, email: 'zz.me@legendoftoys.com' });
    if (Number(q.get('offset') || 0) > 0) return body([]);
    if (p.startsWith('/rest/v1/users_profile?id=eq.') && method === 'GET') return body([{ role: 'viewer', full_name: 'ZZ Me', active: true }]);
    if (p.startsWith('/rest/v1/users_profile?')) return body([]);
    if (p.startsWith('/rest/v1/docket_user_roles?user_id=eq.')) return body(Object.keys(perms).length ? [{ role_key: 'zz_role' }] : []);
    if (p.startsWith('/rest/v1/docket_roles?')) return body([{ role_key: 'zz_role', permissions: perms }]);
    if (p.includes('/employees?auth_user_id=eq.' + ME)) return body([{ id: MEE, full_name: 'ZZ Me', department_id: D2, status: 'active' }]);
    if (p.includes('/rpc/ensure_personal_space')) return body(PERS);
    if (p.includes('/rpc/next_task_seq')) return body('DKT-900');
    if (p.includes('/rpc/')) return body([]);
    // spaces: accessibleSpaces (General + private where owner/member), loadSpace, keepAccessible
    if (p.startsWith('/rest/v1/spaces?home_department_id=eq.')) return body(home && eq('home_department_id') === D2 ? [SPACES[HOME]] : []);
    if (p.startsWith('/rest/v1/spaces?is_default=eq.true')) return body([SPACES[G]]);
    if (p.startsWith('/rest/v1/spaces?is_private=eq.true')) return body(Object.values(SPACES).filter(s => s.is_private && !s.is_personal /* PERS opens by id only; the list tests predate it */ && (s.owner_user_id === ME || members.includes(s.id))));
    if (p.startsWith('/rest/v1/spaces?id=eq.') && method === 'GET') return body(SPACES[eq('id')] ? [SPACES[eq('id')]] : []);
    if (p.startsWith('/rest/v1/spaces?id=in.')) return body(inIds(q.get('id')).map(id => SPACES[id]).filter(Boolean));
    if (p.startsWith('/rest/v1/space_members?space_id=eq.')) return body(members.includes(eq('space_id')) ? [{ user_id: ME }] : []);
    if (p.startsWith('/rest/v1/space_members?space_id=in.')) return body(members.filter(m => inIds(q.get('space_id')).includes(m)).map(space_id => ({ space_id })));
    if (p.startsWith('/rest/v1/space_members?user_id=eq.')) return body(members.map(space_id => ({ space_id })));
    // records
    if (u.pathname === '/rest/v1/checklist_records') {
      if (method === 'GET') {
        let rows = pick(pick(db.records, 'id'), 'space_id');
        const st = q.get('status'); if (st === 'neq.archived') rows = rows.filter(r => r.status !== 'archived'); else if (st) rows = rows.filter(r => `eq.${r.status}` === st);
        return body(rows);
      }
      if (method === 'PATCH') { const rows = pick(db.records, 'id'); rows.forEach(r => Object.assign(r, reqBody)); return body(rows); }
      if (method === 'POST') { const r = { ...REC(99), ...reqBody[0], id: U(299) }; db.records.push(r); return body([r]); }
    }
    if (fail[u.pathname + ':' + method]) return body({ message: 'zz down' }, 500);
    if (u.pathname === '/rest/v1/checklist_record_history' && method === 'GET') return body(history);
    if (u.pathname === '/rest/v1/checklist_template_sections' && method === 'GET') return body(tmplItems.length ? [{ id: SEC, title: 'S', sort_order: 0 }] : []);
    if (u.pathname === '/rest/v1/checklist_template_items' && method === 'GET') return body(tmplItems.map((t, i) => ({ section_id: SEC, sort_order: i, help_text: null, ...t })));
    if (u.pathname === '/rest/v1/checklist_record_items') {
      if (method === 'GET') return body(pick(pick(pick(db.items, 'id'), 'record_id'), 'task_id'));
      if (method === 'PATCH' && archivedTrigger) return body({ code: '23514', message: 'record_archived' }, 400);
      if (method === 'PATCH' && race && q.get('task_id') === 'is.null') pick(db.items, 'id').forEach(r => { r.task_id = race; });
      if (method === 'PATCH') { const rows = pick(pick(db.items, 'id'), 'task_id'); rows.forEach(r => Object.assign(r, reqBody)); return body(rows); }
      if (method === 'POST') return body(reqBody.map((x, i) => ({ id: U(390 + i), ...x })), 201);
    }
    if (u.pathname === '/rest/v1/task_checklist_links') {
      if (method === 'GET') return body(pick(pick(db.links, 'task_id'), 'record_id'));
      if (method === 'POST') { reqBody.forEach(x => db.links.push({ id: U(450), ...x })); return body(reqBody, 201); }
      if (method === 'PATCH') { const rows = pick(pick(db.links, 'task_id'), 'record_id'); rows.forEach(r => Object.assign(r, reqBody)); return body(rows); }
      if (method === 'DELETE') return body(pick(pick(db.links, 'task_id'), 'record_id'));
    }
    if (u.pathname === '/rest/v1/checklist_template_sections' && method === 'POST') return body(reqBody.map((x, i) => ({ id: U(470 + i), ...x })), 201);
    if (u.pathname === '/rest/v1/checklist_templates') return body([{ id: TPL, name: 'ZZ Launch', kind: 'record', version: 1, is_active: true, archived_at: null }]);
    if (u.pathname === '/rest/v1/tasks') {
      if (method === 'GET') return body(pick(pick(db.tasks, 'id'), 'parent_task_id').filter(t => !q.get('space_id') || t.space_id === eq('space_id')));
      if (method === 'PATCH') return body([]);
      if (method === 'POST') { const t = { ...T(900), ...reqBody[0], id: U(1900) }; db.tasks.push(t); return body([t], 201); }
    }
    return body([]);
  };
  return { fn, calls, db };
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
const writes = (s, path) => s.calls.filter(c => c.method !== 'GET' && c.p.startsWith(path));

// ── visibility ──
const PRIV_REC = REC(2, { space_id: PRIV, title: 'ZZ secret launch', product: 'ZZ Secret Product' });
test('a private (Founders\') record: a non-member never sees it — list, by id, and on a task only as a count', async () => {
  const s = stub({ records: [REC(1), PRIV_REC], items: [ITEM(1, 2, { title: 'ZZ secret item' })], tasks: [T(1)],
    links: [{ id: U(401), task_id: U(101), record_id: U(201) }, { id: U(402), task_id: U(101), record_id: U(202) }] });
  const list = await run(s, { get: { action: 'getChecklistRecords' } });
  assert.equal(list.status, 200, JSON.stringify(list.j));
  assert.deepEqual(list.j.data.map(r => r.id), [U(201)]);
  // the list read itself is scoped to the caller's spaces — never fetched, not just filtered
  assert.ok(s.calls.some(c => c.p.startsWith('/rest/v1/checklist_records?space_id=in.(' + G + ')')), 'list scoped to General only');
  const one = await run(s, { get: { action: 'getChecklistRecord', id: U(202) } });
  assert.equal(one.status, 404);
  const t = await run(s, { get: { action: 'getTask', id: U(101) } });
  assert.equal(t.status, 200, JSON.stringify(t.j));
  assert.deepEqual(t.j.data.checklists.map(c => c.record_id), [U(201)]);
  assert.equal(t.j.data.checklists_hidden, 1);
  for (const r of [list, one, t]) for (const secret of ['ZZ secret launch', 'ZZ Secret Product', 'ZZ secret item']) assert.ok(!JSON.stringify(r.j).includes(secret), secret);
  // and writes by id are 404 too
  const tick = await run(s, { post: { action: 'setRecordItemState', item_id: U(301), state: 'done' } });
  assert.equal(tick.status, 404);
  assert.equal(writes(s, '/rest/v1/checklist_record_items').length, 0);
});
test('…a member of that space sees it everywhere (positive control)', async () => {
  const s = stub({ records: [REC(1), PRIV_REC], items: [ITEM(1, 2, { state: 'done' }), ITEM(2, 2)], tasks: [T(1)], members: [PRIV],
    links: [{ id: U(402), task_id: U(101), record_id: U(202) }] });
  const list = await run(s, { get: { action: 'getChecklistRecords' } });
  assert.deepEqual(list.j.data.map(r => r.id).sort(), [U(201), U(202)]);
  const one = await run(s, { get: { action: 'getChecklistRecord', id: U(202) } });
  assert.equal(one.status, 200, JSON.stringify(one.j));
  assert.equal(one.j.data.title, 'ZZ secret launch');
  assert.equal(one.j.data.progress.label, '1/2');
  const t = await run(s, { get: { action: 'getTask', id: U(101) } });
  assert.deepEqual(t.j.data.checklists.map(c => [c.title, c.done, c.total]), [['ZZ secret launch', 1, 2]]);
  assert.equal(t.j.data.checklists_hidden, 0);
});

// ── who may do what ──
test('C6: any viewer ticks (not the owner, not the creator) — attributed, logged', async () => {
  const s = stub({ records: [REC(1)], items: [ITEM(1, 1)] });
  const r = await run(s, { post: { action: 'setRecordItemState', item_id: U(301), state: 'done' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const patch = writes(s, '/rest/v1/checklist_record_items').find(c => c.method === 'PATCH');
  assert.equal(patch.body.state, 'done');
  assert.equal(patch.body.done_by_user_id, ME);
  assert.equal(patch.body.updated_by_user_id, ME);   // the trigger's actor for record_completed
  // history is the 0032 trigger's, in the same statement — the worker writes none
  assert.equal(writes(s, '/rest/v1/checklist_record_history').length, 0);
  // N/A without a reason is refused before any write
  const s2 = stub({ records: [REC(1)], items: [ITEM(1, 1)] });
  const na = await run(s2, { post: { action: 'setRecordItemState', item_id: U(301), state: 'na' } });
  assert.equal(na.status, 400); assert.equal(na.j.error, 'na_reason_required');
  assert.equal(writes(s2, '/rest/v1/checklist_record_items').length, 0);
});
test('edit title / owner / product / archive: a viewer who is not owner, creator or admin is refused; the owner may', async () => {
  const s = stub({ records: [REC(1)] });
  for (const patch of [{ title: 'ZZ new' }, { archived: true }, { owner_employee_id: null }, { product: '' }]) {
    const r = await run(s, { post: { action: 'updateChecklistRecord', id: U(201), ...patch } });
    assert.equal(r.status, 403, JSON.stringify(patch));
  }
  assert.equal(writes(s, '/rest/v1/checklist_records').length, 0);
  const own = stub({ records: [REC(1, { owner_employee_id: MEE })] });
  const r = await run(own, { post: { action: 'updateChecklistRecord', id: U(201), title: 'ZZ renamed' } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(writes(own, '/rest/v1/checklist_records')[0].body.title, 'ZZ renamed');
  const adm = stub({ records: [REC(1)], perms: { docket_admin: true } });
  assert.equal((await run(adm, { post: { action: 'updateChecklistRecord', id: U(201), archived: true } })).status, 200);
});

// ── links ──
test('link: same space only — a private record onto a task elsewhere, and (P3c) a General record, are refused (link_cross_space)', async () => {
  const s = stub({ records: [PRIV_REC], tasks: [T(1)], members: [PRIV] });
  const r = await run(s, { post: { action: 'linkTaskChecklist', task_id: U(101), record_id: U(202) } });
  assert.equal(r.status, 422, JSON.stringify(r.j));
  assert.match(r.j.error, /^link_cross_space/);
  assert.equal(writes(s, '/rest/v1/task_checklist_links').length, 0);
  const same = stub({ records: [PRIV_REC], tasks: [T(2, { space_id: PRIV })], members: [PRIV] });
  assert.equal((await run(same, { post: { action: 'linkTaskChecklist', task_id: U(102), record_id: U(202) } })).status, 200);
  const gen = stub({ records: [REC(1)], tasks: [T(2, { space_id: PRIV })], members: [PRIV] });   // P3c: General no longer links anywhere
  const g = await run(gen, { post: { action: 'linkTaskChecklist', task_id: U(102), record_id: U(201) } });
  assert.equal(g.status, 422, JSON.stringify(g.j)); assert.equal(g.j.error, 'link_cross_space: a checklist links only to tasks in its own space');
  assert.equal(writes(gen, '/rest/v1/task_checklist_links').length, 0);
  // a record the caller can't see is a 404, never "cross space"
  const hid = stub({ records: [PRIV_REC], tasks: [T(1)] });
  assert.equal((await run(hid, { post: { action: 'linkTaskChecklist', task_id: U(101), record_id: U(202) } })).status, 404);
});

// ── item → task ──
test('createTaskFromRecordItem: createTask in the record\'s space, item claimed, task linked; a second time is refused', async () => {
  const s = stub({ records: [PRIV_REC], items: [ITEM(1, 2, { title: 'ZZ Amazon listing' })], members: [PRIV] });
  const r = await run(s, { post: { action: 'createTaskFromRecordItem', item_id: U(301) } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const ins = writes(s, '/rest/v1/tasks').find(c => c.method === 'POST');
  assert.equal(ins.body[0].space_id, PRIV);
  assert.equal(ins.body[0].title, 'ZZ Amazon listing — ZZ secret launch');
  assert.equal(ins.body[0].created_by_user_id, ME);
  assert.ok(writes(s, '/rest/v1/task_history').some(c => c.body.event_type === 'created' && c.body.source === 'app'), 'createTask history row');
  const claim = writes(s, '/rest/v1/checklist_record_items').find(c => c.method === 'PATCH');
  assert.ok(claim.p.includes('task_id=is.null'), 'claim only while empty');
  assert.equal(claim.body.task_id, U(1900));
  assert.equal(writes(s, '/rest/v1/task_checklist_links')[0].body[0].record_id, U(202));
  // second call: the item now has a task → 409, no new task
  const again = await run(s, { post: { action: 'createTaskFromRecordItem', item_id: U(301) } });
  assert.equal(again.status, 409); assert.equal(again.j.error, 'item_has_task');
  assert.equal(writes(s, '/rest/v1/tasks').filter(c => c.method === 'POST').length, 1);
});

// ── template kind / version ──
test('saveChecklistTemplate: a record template takes no schedule, bumps its version when an item is added, logs it; kind is locked', async () => {
  const s = stub({ perms: { docket_admin: true } });
  const r = await run(s, { post: { action: 'saveChecklistTemplate', id: TPL, name: 'ZZ Launch', sections: [{ title: 'S', items: [{ title: 'ZZ new item' }] }] } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.data.version, 2);
  const patches = writes(s, '/rest/v1/checklist_templates').filter(c => c.method === 'PATCH');
  assert.deepEqual(patches[0].body.recurrence, { freq: 'none' });
  assert.ok(patches.some(c => c.body.version === 2));
  const h = writes(s, '/rest/v1/checklist_template_history')[0];
  assert.equal(h.body.event, 'saved'); assert.equal(h.body.detail.added, 1); assert.equal(h.body.actor_user_id, ME);
  const k = await run(stub({ perms: { docket_admin: true } }), { post: { action: 'saveChecklistTemplate', id: TPL, name: 'ZZ', kind: 'routine', recurrence: { freq: 'daily' } } });
  assert.equal(k.status, 422); assert.equal(k.j.error, 'kind_locked');
  const a = await run(stub(), { post: { action: 'assignChecklistTemplate', template_id: TPL, employee_id: MEE } });
  assert.equal(a.status, 422); assert.equal(a.j.error, 'record_template_not_assignable');
});

// ── review fixes (K) ──
test('getChecklistRecord: linked / item / history tasks the caller can\'t open show no title or number', async () => {
  const hiddenT = T(5, { title: 'ZZ hidden task', task_no: 'DKT-5', owner_employee_id: OE, created_by_user_id: OWNER, department_id: D1 });
  const mineT = T(6, { title: 'ZZ my task' });
  const s = stub({ records: [REC(1)], tasks: [hiddenT, mineT], items: [ITEM(1, 1, { task_id: U(105) }), ITEM(2, 1, { task_id: U(106) })],
    links: [{ id: U(401), task_id: U(105), record_id: U(201) }, { id: U(402), task_id: U(106), record_id: U(201) }],
    history: [{ id: U(601), record_id: U(201), item_id: null, event: 'task_linked', actor_user_id: OWNER, detail: { task_id: U(105) }, at: '2026-11-13T00:00:00Z' },
      { id: U(602), record_id: U(201), item_id: null, event: 'task_linked', actor_user_id: ME, detail: { task_id: U(106) }, at: '2026-11-13T00:00:00Z' }] });
  const r = await run(s, { get: { action: 'getChecklistRecord', id: U(201) } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const txt = JSON.stringify(r.j);
  for (const secret of ['ZZ hidden task', 'DKT-5', U(105)]) assert.ok(!txt.includes(secret), secret);
  assert.equal(r.j.data.linked_hidden, 1);
  assert.deepEqual(r.j.data.linked_tasks.map(t => t.task_no), ['DKT-6']);
  assert.deepEqual(r.j.data.items.map(i => i.task), [{ hidden: true }, { id: U(106), task_no: 'DKT-6', title: 'ZZ my task', status: 'in_progress', owner_name: null }]);
  assert.deepEqual(r.j.data.history.map(h => h.detail), [{ hidden_task: true }, { task_no: 'DKT-6' }]);
});

test('pull-updates banner only while the record is open', async () => {
  const tmplItems = [{ id: U(501), title: 'ZZ tmpl a' }, { id: U(502), title: 'ZZ tmpl b' }];
  const items = [ITEM(1, 1, { source_item_id: U(501), state: 'done' })];
  const open = await run(stub({ records: [REC(1)], items, tmplItems }), { get: { action: 'getChecklistRecord', id: U(201) } });
  assert.equal(open.j.data.template_has_updates, true);
  assert.equal(open.j.data.template_updates.new_items, 1);
  for (const status of ['complete', 'archived']) {
    const o = status === 'archived' ? { status, archived_at: '2026-11-13T00:00:00Z' } : { status };
    const r = await run(stub({ records: [REC(1, o)], items, tmplItems }), { get: { action: 'getChecklistRecord', id: U(201) } });
    assert.equal(r.j.data.template_has_updates, false, status);
  }
  const p = await run(stub({ records: [REC(1, { status: 'complete' })], items, tmplItems }), { post: { action: 'pullTemplateUpdates', record_id: U(201) } });
  assert.equal(p.status, 409);
});

test('moveTask: a task tied to a record in another space is refused (linked, item task, or its sub-task) — a General record too (P3c); into the record\'s space it moves', async () => {
  const recP2 = REC(3, { space_id: P2 });
  const cases = [
    ['linked', { links: [{ id: U(401), task_id: U(101), record_id: U(203) }] }],
    ['item task', { items: [ITEM(1, 3, { task_id: U(101) })] }],
    ['sub-task is an item task', { items: [ITEM(1, 3, { task_id: U(102) })] }],
  ];
  for (const [label, o] of cases) {
    const s = stub({ records: [recP2], tasks: [T(1, { space_id: P2 }), T(2, { space_id: P2, parent_task_id: U(101) })], members: [P2, HOME], ...o });
    const r = await run(s, { post: { action: 'moveTask', id: U(101), space_id: HOME } });
    assert.equal(r.status, 422, label + ' ' + JSON.stringify(r.j));
    assert.match(r.j.error, /^record_link_space/, label);
    assert.equal(writes(s, '/rest/v1/tasks').filter(c => c.method === 'PATCH').length, 0, label);
  }
  const gen = stub({ records: [REC(1)], tasks: [T(1, { space_id: P2 })], members: [P2, HOME], links: [{ id: U(401), task_id: U(101), record_id: U(201) }] });
  const g = await run(gen, { post: { action: 'moveTask', id: U(101), space_id: HOME } });
  assert.equal(g.status, 422, JSON.stringify(g.j)); assert.equal(g.j.error, 'record_link_space: this task (or a sub-task) is tied to a record checklist in another space — it can move only to that space');
  const ok = stub({ records: [REC(1, { space_id: HOME })], tasks: [T(1, { space_id: P2 })], members: [P2, HOME], links: [{ id: U(401), task_id: U(101), record_id: U(201) }] });
  const r = await run(ok, { post: { action: 'moveTask', id: U(101), space_id: HOME } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
});

test('bulkMoveTasks: tied tasks are skipped and named; the rest move', async () => {
  const s = stub({ records: [REC(3, { space_id: P2 })], tasks: [T(1, { space_id: P2 }), T(2, { space_id: P2 })], members: [P2, HOME],
    links: [{ id: U(401), task_id: U(101), record_id: U(203) }] });
  const r = await run(s, { post: { action: 'bulkMoveTasks', ids: [U(101), U(102)], space_id: HOME } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.data.record_link_space, ['DKT-1']);
  assert.equal(r.j.data.updated, 1);
  assert.equal(r.j.data.skipped, 1);
  const parentPatch = writes(s, '/rest/v1/tasks?id=in.').find(c => c.method === 'PATCH');
  assert.ok(parentPatch.p.includes(U(102)) && !parentPatch.p.includes(U(101)), parentPatch.p);
});

test('createTaskFromRecordItem: losing the claim race still links the new task and names both; defaults owner + team to the caller', async () => {
  const s = stub({ records: [REC(1, { space_id: P2 })], items: [ITEM(1, 1)], tasks: [T(7, { task_no: 'DKT-7', space_id: P2 })], members: [P2], race: U(107) });
  const r = await run(s, { post: { action: 'createTaskFromRecordItem', item_id: U(301) } });
  assert.equal(r.status, 409, JSON.stringify(r.j));
  assert.equal(r.j.error, 'item_has_task');
  assert.equal(r.j.task_no, 'DKT-900');
  assert.equal(r.j.other_task_no, 'DKT-7');
  const ins = writes(s, '/rest/v1/tasks').find(c => c.method === 'POST');
  assert.equal(ins.body[0].owner_employee_id, MEE);
  assert.equal(ins.body[0].department_id, D2);
  const link = writes(s, '/rest/v1/task_checklist_links').find(c => c.method === 'POST');
  assert.equal(link.body[0].task_id, U(1900));
  assert.ok(link.p.includes('on_conflict=task_id,record_id'));
});

test('link / unlink need edit rights on the task; unlink works on an abandoned task; an archived-record refusal is a 409', async () => {
  const viewOnly = T(8, { owner_employee_id: OE, created_by_user_id: OWNER });   // visible via my department, not editable
  const s = stub({ records: [REC(1)], tasks: [viewOnly] });
  assert.equal((await run(s, { post: { action: 'linkTaskChecklist', task_id: U(108), record_id: U(201) } })).status, 403);
  assert.equal(writes(s, '/rest/v1/task_checklist_links').length, 0);
  const ab = stub({ records: [REC(1)], tasks: [T(1, { status: 'abandoned' })], links: [{ id: U(401), task_id: U(101), record_id: U(201) }] });
  assert.equal((await run(ab, { post: { action: 'linkTaskChecklist', task_id: U(101), record_id: U(201) } })).status, 422);
  const un = await run(ab, { post: { action: 'unlinkTaskChecklist', task_id: U(101), record_id: U(201) } });
  assert.equal(un.status, 200, JSON.stringify(un.j));
  const [stamp, del] = writes(ab, '/rest/v1/task_checklist_links');
  assert.equal(stamp.method, 'PATCH'); assert.equal(stamp.body.removed_by_user_id, ME); assert.equal(stamp.body.removed_source, 'app');
  assert.equal(del.method, 'DELETE');
  const arch = await run(stub({ records: [REC(1)], items: [ITEM(1, 1)], archivedTrigger: true }), { post: { action: 'setRecordItemState', item_id: U(301), state: 'done' } });
  assert.equal(arch.status, 409); assert.equal(arch.j.error, 'record_archived');
});

// ── re-review batch ──
test('getTask: a failed checklist read degrades the strip, never the task', async () => {
  const s = stub({ tasks: [T(1)], fail: { '/rest/v1/task_checklist_links:GET': true } });
  const r = await run(s, { get: { action: 'getTask', id: U(101) } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual([r.j.data.checklists, r.j.data.checklists_hidden, r.j.data.checklists_failed], [[], 0, true]);
});
test('link refuses a recurring task and an archived record; unlink deletes only the row this caller stamped', async () => {
  const rec = stub({ records: [REC(1)], tasks: [T(1, { is_recurring: true })] });
  const r1 = await run(rec, { post: { action: 'linkTaskChecklist', task_id: U(101), record_id: U(201) } });
  assert.equal(r1.status, 422); assert.match(r1.j.error, /^recurring_task/);
  const arc = stub({ records: [REC(1, { status: 'archived', archived_at: '2026-11-13T00:00:00Z' })], tasks: [T(1)] });
  const r2 = await run(arc, { post: { action: 'linkTaskChecklist', task_id: U(101), record_id: U(201) } });
  assert.equal(r2.status, 409); assert.equal(r2.j.error, 'record_archived');
  for (const x of [rec, arc]) assert.equal(writes(x, '/rest/v1/task_checklist_links').length, 0);
  const un = stub({ records: [REC(1)], tasks: [T(1)], links: [{ id: U(401), task_id: U(101), record_id: U(201) }] });
  await run(un, { post: { action: 'unlinkTaskChecklist', task_id: U(101), record_id: U(201) } });
  const del = writes(un, '/rest/v1/task_checklist_links').find(c => c.method === 'DELETE');
  assert.ok(del.p.includes('removed_by_user_id=eq.' + ME), del.p);
});
test('saveChecklistTemplate: moving an item to another section keeps it; another template\'s item is refused; a failed log is a flag', async () => {
  const tmplItems = [{ id: U(501), title: 'ZZ keep me' }, { id: U(502), title: 'ZZ drop me' }];
  const s = stub({ perms: { docket_admin: true }, tmplItems });
  const r = await run(s, { post: { action: 'saveChecklistTemplate', id: TPL, name: 'ZZ', sections: [{ id: SEC, title: 'S', items: [] }, { id: null, title: 'New', items: [{ id: U(501), title: 'ZZ keep me' }] }] } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const dels = writes(s, '/rest/v1/checklist_template_items').filter(c => c.method === 'DELETE');
  assert.equal(dels.length, 1);
  assert.ok(dels[0].p.includes(U(502)) && !dels[0].p.includes(U(501)), dels[0].p);
  const mv = writes(s, '/rest/v1/checklist_template_items?id=eq.' + U(501)).find(c => c.method === 'PATCH');
  assert.equal(mv.body.section_id, U(470));   // the new section
  // the PATCH happens before the delete
  const order = s.calls.filter(c => c.p.startsWith('/rest/v1/checklist_template_items') && c.method !== 'GET').map(c => c.method);
  assert.deepEqual(order, ['PATCH', 'DELETE']);
  const x = await run(stub({ perms: { docket_admin: true }, tmplItems }), { post: { action: 'saveChecklistTemplate', id: TPL, name: 'ZZ', sections: [{ id: SEC, title: 'S', items: [{ id: U(999), title: 'not mine' }] }] } });
  assert.equal(x.status, 422); assert.equal(x.j.error, 'item_not_in_template');
  const h = stub({ perms: { docket_admin: true }, fail: { '/rest/v1/checklist_template_history:POST': true } });
  const c = await run(h, { post: { action: 'saveChecklistTemplate', kind: 'record', name: 'ZZ new', sections: [{ title: 'S', items: [{ title: 'a' }] }] } });
  assert.equal(c.status, 200, JSON.stringify(c.j));
  assert.equal(c.j.data.history_failed, true);
  assert.ok(c.j.data.id);
});

test('P3b createChecklistRecord: no space → the team\'s home space if the caller opens it, else their Personal; explicit wins', async () => {
  const mk = (extra = {}) => ({ action: 'createChecklistRecord', data: { template_id: TPL, title: 'ZZ new', ...extra } });
  const spaceOf = (s) => s.calls.find(c => c.method === 'POST' && c.p.startsWith('/rest/v1/checklist_records')).body[0].space_id;
  let s = stub();                                                  // no home space → Personal (caller's team is D2)
  let r = await run(s, { post: mk() });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(spaceOf(s), PERS);
  s = stub({ home: true, members: [HOME] });                       // home space, caller a member
  r = await run(s, { post: mk() });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(spaceOf(s), HOME);
  s = stub({ home: true });                                        // home space the caller can't open
  r = await run(s, { post: mk() });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(spaceOf(s), PERS);
  s = stub({ home: true, members: [HOME, P2] });                   // explicit space wins
  r = await run(s, { post: mk({ space_id: P2 }) });
  assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(spaceOf(s), P2);
});
