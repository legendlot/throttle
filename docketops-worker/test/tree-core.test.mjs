// Run: node --test docketops-worker/test/*.test.mjs
// F9 R9a — tree-core (pure): subtree rollups (each task once, abandoned in no count, sub-tasks never on their
// own), hidden only at level F, the on-time rule (the first deadline is the promise), task leaves (open by date,
// then done latest first, cap 25 + more), the closed filter (a closed item hides its subtree), mine (+ ancestors),
// the theme filter, orphans, level-T stripping, and treeTaskItemIds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, treeTaskItemIds, TREE_TASK_CAP } from '../src/tree-core.mjs';
import { templateRoles, templateSpan, templateListRow, templateNodesFor } from '../src/template-core.mjs';

const NOW = Date.parse('2026-11-12T06:00:00Z');
const PAST = '2026-11-01T12:30:00.000Z', FUTURE = '2026-11-30T12:30:00.000Z';
const I = (id, o) => ({ id, kind: 'milestone', code: id.toUpperCase(), title: `ZZ ${id}`, level: 'F', state: 'agreed', parent_id: null,
  owner_employee_id: 'e1', due_date: '2026-11-20', revised_due_date: null, measure: { system: 'manual' }, restricted: false, sort: 0, ...o });
const ITEMS = [
  I('t1', { kind: 'theme', owner_employee_id: null, due_date: null, measure: null }),
  I('m1', { parent_id: 't1', sort: 10 }),
  I('r1', { kind: 'result', parent_id: 'm1', owner_employee_id: 'e2' }),
  I('r2', { kind: 'result', parent_id: 'm1', state: 'done' }),
  I('m2', { parent_id: 't1', sort: 20, state: 'dropped' }),
  I('r3', { kind: 'result', parent_id: 'm2', state: 'agreed' }),   // under a dropped milestone
];
const K = (id, o) => ({ id, task_no: `DKT-${id}`, title: `ZZ task ${id}`, status: 'in_progress', owner_employee_id: 'e1', deadline: FUTURE,
  revised_deadline: null, completed_at: null, plan_item_id: 'r1', parent_task_id: null, ...o });
const TASKS = [
  K('a', { deadline: PAST }),                                                        // open, overdue, scored (missed)
  K('b', { status: 'done', deadline: PAST, completed_at: '2026-10-30T00:00:00Z' }),  // done on time
  K('c', { status: 'done', deadline: PAST, completed_at: '2026-11-05T00:00:00Z' }),  // done late
  K('d', { status: 'abandoned', deadline: PAST }),                                  // in no count
  K('e', { plan_item_id: 'm1', deadline: null, revised_deadline: FUTURE }),         // open, never scored (no first deadline)
  K('f', { plan_item_id: 'r2', status: 'done', deadline: null, completed_at: '2026-11-02T00:00:00Z' }),   // under a closed result
  K('h', { plan_item_id: 'r1' }),                                                    // invisible to the caller
  K('s', { plan_item_id: 'r1', parent_task_id: 'a' }),                              // a sub-task: never counted on its own
];
const VIS = new Set(['a', 'b', 'c', 'd', 'e', 'f', 's']);
const byId = (out) => Object.fromEntries(out.items.map(r => [r.id, r]));

test('rollups over the subtree, each task once; abandoned + sub-tasks in no count; hidden at F only', () => {
  const f = buildTree(ITEMS, TASKS, { now: NOW, visibleIds: VIS, level: 'F' });
  const r = byId(f);
  assert.deepEqual(f.items.map(x => x.id), ['t1', 'm1', 'r1']);                     // r2 done, m2 dropped (+ r3) hidden by default
  assert.deepEqual(r.r1.counts, { open: 1, done: 2, overdue: 1, hidden: 1 });
  assert.deepEqual(r.m1.counts, { open: 2, done: 3, overdue: 1, hidden: 1 });        // + e (direct) + f (under the hidden-by-state r2)
  assert.deepEqual(r.t1.counts, r.m1.counts);
  assert.equal(f.hidden_total, 1);
  assert.equal(r.r1.restricted, false);
  // below F: the invisible task is in no count, hidden is 0, hidden_total null
  const o = buildTree(ITEMS, TASKS, { now: NOW, visibleIds: VIS, level: null });
  assert.deepEqual(byId(o).r1.counts, { open: 1, done: 2, overdue: 1, hidden: 0 });
  assert.equal(o.hidden_total, null);
  assert.ok(!('restricted' in byId(o).r1));
  assert.doesNotMatch(JSON.stringify(o), /DKT-h|task h/);
});

test('on time: scored = first deadline set and (done, or open past it); on time = done by it; pct rounded, null on 0', () => {
  const r = byId(buildTree(ITEMS, TASKS, { now: NOW, visibleIds: VIS, level: 'F' }));
  assert.deepEqual(r.r1.on_time, { on_time: 1, scored: 3, pct: 33 });               // a (missed), b (on time), c (late)
  assert.deepEqual(r.m1.on_time, { on_time: 1, scored: 3, pct: 33 });               // e: no first deadline; f: no deadline
  const none = byId(buildTree(ITEMS, [K('x')], { now: NOW, visibleIds: new Set(['x']), level: 'F' }));
  assert.deepEqual(none.r1.on_time, { on_time: 0, scored: 0, pct: null });          // open, not yet due → not scored
});

test('leaves: direct visible tasks only, open by effective date (none last) then done latest first; cap + more', () => {
  const t = buildTree(ITEMS, TASKS, { now: NOW, visibleIds: VIS, level: 'F' }).tasks;
  assert.deepEqual(t.r1.rows.map(x => x.id), ['a', 'c', 'b']);
  assert.equal(t.r1.more, 0);
  assert.deepEqual(t.r1.rows[0], { id: 'a', task_no: 'DKT-a', title: 'ZZ task a', status: 'in_progress', owner_name: null,
    effective_deadline: PAST, overdue: true });
  assert.deepEqual(t.m1.rows.map(x => x.id), ['e']);
  assert.ok(!t.t1);
  const many = Array.from({ length: 30 }, (_, n) => K(`n${String(n).padStart(2, '0')}`, { deadline: n === 0 ? null : FUTURE }));
  const c = buildTree(ITEMS, many, { now: NOW, visibleIds: new Set(many.map(x => x.id)), level: null }).tasks.r1;
  assert.equal(c.rows.length, TREE_TASK_CAP); assert.equal(c.more, 5);
  assert.notEqual(c.rows[0].id, 'n00');                                               // the undated one sorts last
});

test('closed=1 shows done / dropped items and what is under them; mine keeps owned items + ancestors; theme narrows', () => {
  const all = buildTree(ITEMS, TASKS, { now: NOW, visibleIds: VIS, level: 'F', closed: true });
  assert.deepEqual(all.items.map(x => x.id), ['t1', 'm1', 'r1', 'r2', 'm2', 'r3']);
  const mine = buildTree(ITEMS, TASKS, { now: NOW, visibleIds: VIS, level: 'F', mine: true, employeeId: 'e2' });
  assert.deepEqual(mine.items.map(x => x.id), ['t1', 'm1', 'r1']);                   // e2 owns r1 → its path
  assert.deepEqual(buildTree(ITEMS, TASKS, { now: NOW, visibleIds: VIS, mine: true, employeeId: 'e9' }).items, []);
  const two = [...ITEMS, I('t2', { kind: 'theme', owner_employee_id: null, due_date: null }), I('m9', { parent_id: 't2' })];
  assert.deepEqual(buildTree(two, [], { now: NOW, themeId: 't2' }).items.map(x => x.id), ['t2', 'm9']);
  // the tasks read: every shown item's whole subtree (closed descendants too — their tasks roll up)
  assert.deepEqual(treeTaskItemIds(ITEMS, {}).sort(), ['m1', 'm2', 'r1', 'r2', 'r3', 't1']);
  assert.deepEqual(treeTaskItemIds(ITEMS, { mine: true, employeeId: 'e2' }).sort(), ['m1', 'm2', 'r1', 'r2', 'r3', 't1']);   // t1 is an ancestor
  assert.deepEqual(treeTaskItemIds(two, { themeId: 't2' }).sort(), ['m9', 't2']);
  assert.deepEqual(treeTaskItemIds(ITEMS, { mine: true, employeeId: 'e9' }), []);
});

test('rows: effective date, re-dated, ⚠ no data source; a level-T row is code + title + kind + level; an orphan is a root', () => {
  const items = [I('t1', { kind: 'theme', level: 'T', owner_employee_id: null, due_date: null, measure: null }),
    I('m1', { parent_id: 'mX', level: 'O', revised_due_date: '2026-11-25', measure: { metric: 'zz', source_ok: true } })];
  const r = byId(buildTree(items, [], { now: NOW, names: { e1: 'ZZ One' }, metrics: [{ key: 'zz', source_ok: true }] }));
  assert.deepEqual(r.t1, { id: 't1', parent_id: null, kind: 'theme', code: 'T1', title: 'ZZ t1', level: 'T', state: 'agreed',
    owner_employee_id: null, owner_name: null, due_date: null, revised_due_date: null, effective_due: null, redated: false,
    no_data_source: null, measure: null, counts: { open: 0, done: 0, overdue: 0, hidden: 0 }, on_time: { on_time: 0, scored: 0, pct: null } });
  assert.equal(r.m1.parent_id, null);                                                // its milestone's theme isn't in the projection
  assert.equal(r.m1.effective_due, '2026-11-25'); assert.equal(r.m1.redated, true);
  assert.equal(r.m1.owner_name, 'ZZ One'); assert.equal(r.m1.no_data_source, false);
  assert.equal(byId(buildTree([I('m2', { measure: null })], [], {})).m2.no_data_source, true);
});

test('template-core: roles (trimmed, case-insensitive, first spelling), span, list row rights, the preview strips fields', () => {
  const nodes = [{ id: 'n1', parent_node_id: null, kind: 'result', title: 'ZZ r', role_label: ' Owner ', offset_days: 5, done_when: 'zz', sort: 10 },
    { id: 'n2', parent_node_id: 'n1', kind: 'task', title: 'ZZ t', role_label: 'owner', offset_days: -3, done_when: null, sort: 20 },
    { id: 'n3', parent_node_id: null, kind: 'task', title: 'ZZ h', role_label: 'Helper', offset_days: 12, done_when: null, sort: 30 }];
  assert.deepEqual(templateRoles(nodes), ['Helper', 'Owner']);
  assert.deepEqual(templateSpan(nodes), { min_offset: -3, max_offset: 12 });
  assert.deepEqual(templateSpan([]), { min_offset: null, max_offset: null });
  const t = { id: 'x', name: 'ZZ', description: null, audience: 'leads', created_by: 'u1', archived_at: null };
  assert.equal(templateListRow(t, nodes, { auth: { userId: 'u1' }, acc: {} }).can_edit, true);
  assert.equal(templateListRow(t, nodes, { auth: { userId: 'u2' }, acc: {} }).can_edit, false);
  assert.equal(templateListRow(t, nodes, { auth: { userId: 'u2' }, acc: { isSuper: true } }).can_edit, true);
  assert.equal(templateListRow({ ...t, audience: 'founders' }, nodes).can_apply_kind, 'theme');
  assert.deepEqual(templateNodesFor(nodes, false)[1], { id: 'n2', parent_node_id: 'n1', kind: 'task', title: 'ZZ t' });
  assert.equal(templateNodesFor(nodes, true)[0].done_when, 'zz');
});

test('structure: a shown item hangs under its nearest VISIBLE ancestor; theme= by its real theme; rollups through hidden items', () => {
  const items = [I('t1', { kind: 'theme', owner_employee_id: null, due_date: null, measure: null }), I('rX', { kind: 'result', parent_id: null }),
    I('t2', { kind: 'theme', owner_employee_id: null, due_date: null, measure: null })];
  const structure = [{ id: 't1', parent_id: null, kind: 'theme' }, { id: 'mH', parent_id: 't1', kind: 'milestone' },
    { id: 'rX', parent_id: 'mH', kind: 'result' }, { id: 'rH', parent_id: 'mH', kind: 'result' }, { id: 't2', parent_id: null, kind: 'theme' }];
  const tasks = [K('x', { plan_item_id: 'rX' }), K('y', { plan_item_id: 'rH' }), K('z', { plan_item_id: 'mH' }), K('q', { plan_item_id: 'rH' })];
  const vis = new Set(['x', 'y', 'z']);
  const o = { now: NOW, visibleIds: vis, structure };
  const t = byId(buildTree(items, tasks, o));
  assert.equal(t.rX.parent_id, 't1');
  assert.deepEqual(t.t1.counts, { open: 3, done: 0, overdue: 0, hidden: 0 });        // x + y + z; q invisible, below F no count
  assert.deepEqual(t.rX.counts, { open: 1, done: 0, overdue: 0, hidden: 0 });
  assert.deepEqual(byId(buildTree(items, tasks, { ...o, level: 'F' })).t1.counts.hidden, 1);
  assert.deepEqual(buildTree(items, tasks, { ...o, themeId: 't1' }).items.map(x => x.id), ['t1', 'rX']);
  assert.deepEqual(buildTree(items, tasks, { ...o, themeId: 't2' }).items.map(x => x.id), ['t2']);
  assert.ok(!JSON.stringify(buildTree(items, tasks, { ...o, level: 'F' })).match(/"(mH|rH)"/));
  assert.deepEqual(treeTaskItemIds(items, { structure, themeId: 't1' }).sort(), ['mH', 'rH', 'rX', 't1']);
});
