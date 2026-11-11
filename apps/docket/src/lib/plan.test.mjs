import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as app from './plan.js';
// The worker's copy (itself the mirror of the SQL enforcer). Same repo, plain ESM.
import * as core from '../../../../docketops-worker/src/plan-core.mjs';

const { buildPlanTree, myMilestoneGroups, effectiveDue, isRedated, chipState, fmtPlanDate, fmtPlanStamp,
  moveSort, canAddResult, planActionsFor, planFlags, oneLine, planErrorText, historyText } = app;

test('matrix parity: the app shows exactly what the worker (and so the SQL) allows', () => {
  const states = ['proposed', 'agreed', 'done', 'split', 'dropped'];
  let n = 0;
  for (const k of core.PLAN_KINDS) for (const a of core.PLAN_ACTIONS) {
    for (const isSuper of [false, true]) for (const isOwner of [false, true]) for (const isParentOwner of [false, true]) {
      const f = { isSuper, isOwner, isParentOwner };
      assert.equal(app.canPlanAct(k, a, f), core.canPlanAct(k, a, f), `can ${k} ${a} ${JSON.stringify(f)}`); n++;
    }
    for (const s of states) { assert.equal(app.planStateAllows(k, a, s), core.planStateAllows(k, a, s), `state ${k} ${a} ${s}`); n++; }
  }
  for (const k of core.PLAN_KINDS) for (const s of states) for (const isSuper of [false, true]) for (const isOwner of [false, true]) {
    const f = { isSuper, isOwner, isParentOwner: !isOwner };
    assert.deepEqual(app.editableFields({ kind: k, state: s }, f), core.editableFields({ kind: k, state: s }, f));
    assert.deepEqual(app.planActionsFor({ kind: k, state: s }, f), core.planActionsFor({ kind: k, state: s }, f));
  }
  assert.deepEqual(app.PLAN_ACTIONS, core.PLAN_ACTIONS);
  assert.deepEqual(app.FIELD_ACTION, core.FIELD_ACTION);
  assert.ok(n > 300);
});

const T = (o) => ({ kind: 'theme', state: 'agreed', sort: 10, parent_id: null, ...o });
const M = (o) => ({ kind: 'milestone', state: 'agreed', sort: 10, ...o });
const R = (o) => ({ kind: 'result', state: 'agreed', sort: 10, ...o });

test('tree: themes → milestones → results in sort order; invisible parents go to orphans', () => {
  const items = [
    T({ id: 't2', code: 'T02', sort: 20 }), T({ id: 't1', code: 'T01', sort: 10 }),
    M({ id: 'm2', parent_id: 't1', code: 'M02', sort: 20 }), M({ id: 'm1', parent_id: 't1', code: 'M01', sort: 10 }),
    R({ id: 'r1', parent_id: 'm1', code: 'M01.R1' }), R({ id: 'rx', parent_id: 'hidden', code: 'M09.R1' }),
  ];
  const { themes, orphans } = buildPlanTree(items);
  assert.deepEqual(themes.map(t => t.code), ['T01', 'T02']);
  assert.deepEqual(themes[0].children.map(m => m.code), ['M01', 'M02']);
  assert.deepEqual(themes[0].children[0].children.map(r => r.code), ['M01.R1']);
  assert.deepEqual(orphans.map(o => o.id), ['rx']);
});

test('My milestones: only themes holding one I own; other-milestone results kept separately', () => {
  const items = [
    T({ id: 't1', code: 'T01' }), T({ id: 't2', code: 'T02', sort: 20 }),
    M({ id: 'm1', parent_id: 't1', owner_employee_id: 'me' }),
    R({ id: 'rx', parent_id: 'hidden', owner_employee_id: 'me' }),
  ];
  const g = myMilestoneGroups(items, 'me');
  assert.deepEqual(g.groups.map(x => x.theme.id), ['t1']);
  assert.deepEqual(g.groups[0].milestones.map(m => m.id), ['m1']);
  assert.deepEqual(g.otherResults.map(r => r.id), ['rx']);
  assert.equal(myMilestoneGroups(items, 'someone').groups.length, 0);
});

test('effective date + Re-dated badge', () => {
  assert.equal(effectiveDue({ due_date: '2026-12-01', revised_due_date: '2026-12-20' }), '2026-12-20');
  assert.equal(isRedated({ due_date: '2026-12-01', revised_due_date: '2026-12-20' }), true);
  assert.equal(isRedated({ due_date: '2026-12-01', revised_due_date: null }), false);
});

test('chips: themes read Active/Retired; others their state', () => {
  assert.equal(chipState({ kind: 'theme', state: 'agreed' }).label, 'Active');
  assert.equal(chipState({ kind: 'theme', state: 'dropped' }).label, 'Retired');
  assert.equal(chipState({ kind: 'milestone', state: 'proposed' }).label, 'Proposed');
  assert.equal(chipState({ kind: 'result', state: 'done' }).label, 'Done');
});

test('dates: date-only never shifts; stamps are IST', () => {
  assert.equal(fmtPlanDate('2026-12-01'), '1 Dec 2026');
  assert.equal(fmtPlanDate(null), '');
  assert.equal(fmtPlanStamp('2026-11-10T18:45:00Z'), '11 Nov 2026, 00:15');
});

test('moveSort: swaps neighbours, renumbers, returns only the moved rows', () => {
  const sib = [{ id: 'a', sort: 10 }, { id: 'b', sort: 20 }, { id: 'c', sort: 30 }];
  assert.deepEqual(moveSort(sib, 'b', -1), [{ id: 'b', sort: 10 }, { id: 'a', sort: 20 }]);
  assert.deepEqual(moveSort(sib, 'a', -1), []);
  assert.deepEqual(moveSort([{ id: 'a', sort: 0 }, { id: 'b', sort: 0 }], 'a', 1), [{ id: 'b', sort: 10 }, { id: 'a', sort: 20 }]);
});

test('+ Result: agreed milestones only, by its owner or a super admin', () => {
  const m = M({ id: 'm', owner_employee_id: 'me' });
  assert.equal(canAddResult(m, { employeeId: 'me' }), true);
  assert.equal(canAddResult(m, { employeeId: 'you' }), false);
  assert.equal(canAddResult(m, { isSuper: true }), true);
  assert.equal(canAddResult({ ...m, state: 'proposed' }, { isSuper: true }), false);
});

test('actions shown to a result owner vs its milestone owner', () => {
  const byId = { m: M({ id: 'm', owner_employee_id: 'lead' }) };
  const r = R({ id: 'r', parent_id: 'm', owner_employee_id: 'ic' });
  assert.deepEqual(planActionsFor(r, planFlags(r, { employeeId: 'ic', byId })), ['done']);
  assert.deepEqual(planActionsFor(r, planFlags(r, { employeeId: 'lead', byId })), ['redate', 'done']);
});

test('text helpers', () => {
  assert.equal(oneLine('a\nb'), 'a');
  assert.equal(oneLine('x'.repeat(200), 10).length, 10);
  const e = Object.assign(new Error('missing_fields'), { detail: { fields: ['due_date', 'done_when'] } });
  assert.equal(planErrorText(e), 'Required: due date, done-when.');
  assert.equal(planErrorText(new Error('duplicate_code')), 'That code is already used.');
  assert.equal(historyText({ event: 'field_changed', new: { title: 'x', done_when: 'y' } }), 'Changed title, done-when');
  assert.equal(historyText({ event: 'owner_changed', new: { owner_employee_id: 'e' } }, { e: 'Asha' }), 'Owner → Asha');
});

// ── R2: tasks link up ────────────────────────────────────────────────────────
const { planChain, planPickerOptions, planFilterOptions, matchesPlanFilter, planChip, UNPLANNED } = app;
const PLAN = [
  T({ id: 't1', code: 'T01', title: 'Growth', level: 'T' }),
  T({ id: 't2', code: 'T02', title: 'Ops', sort: 20, level: 'T' }),
  M({ id: 'm1', parent_id: 't1', code: 'M01', title: 'Launch', level: 'O' }),
  M({ id: 'm9', parent_id: 't1', code: 'M09', title: 'Old', state: 'done', level: 'O', sort: 90 }),
  R({ id: 'r2', parent_id: 'm1', code: 'M01.R2', title: 'Retail', level: 'O' }),
  R({ id: 'rx', parent_id: 'm5', code: 'M05.R1', title: 'Mine elsewhere', level: 'O' }),
];
const BY = Object.fromEntries(PLAN.map(x => [x.id, x]));

test('chain: theme title › milestone code › result code; an unseen parent is skipped', () => {
  assert.equal(planChain(BY.t1, BY), 'Growth');
  assert.equal(planChain(BY.m1, BY), 'Growth › M01');
  assert.equal(planChain(BY.r2, BY), 'Growth › M01 › M01.R2');
  assert.equal(planChain(BY.rx, BY), 'M05.R1');
  assert.equal(planChain(null), '');
});

test('picker: Unplanned first, live items only, tree order, searchable by chain + title', () => {
  const o = planPickerOptions(PLAN);
  assert.deepEqual(o[0], { value: '', label: 'Unplanned' });
  assert.deepEqual(o.slice(1).map(x => x.value), ['t1', 'm1', 'r2', 't2', 'rx']);   // m9 (done) gone; orphan last
  assert.equal(o.find(x => x.value === 'r2').label, 'Growth › M01 › M01.R2 · Retail');
  assert.equal(o.find(x => x.value === 't2').label, 'Ops');
  // OptionList filters on label: a code, a theme and a title word all find the result
  for (const q of ['m01.r2', 'growth', 'retail']) assert.ok(o.filter(x => x.label.toLowerCase().includes(q)).some(x => x.value === 'r2'), q);
  assert.deepEqual(planPickerOptions([]), [{ value: '', label: 'Unplanned' }]);
});

test('filter: theme covers its milestones + results (incl. L links); milestone covers its results; Unplanned', () => {
  const task = (plan) => ({ id: 'x', plan });
  const onTheme = task({ id: 't1', kind: 'theme', level: 'T', theme_id: 't1' });
  const onM1 = task({ id: 'm1', kind: 'milestone', level: 'O', theme_id: 't1' });
  const onR2 = task({ id: 'r2', kind: 'result', level: 'O', theme_id: 't1' });
  const onOther = task({ id: 'm7', kind: 'milestone', level: 'L', theme_id: 't1' });   // someone else's milestone
  const onOps = task({ id: 'm3', kind: 'milestone', level: 'L', theme_id: 't2' });
  const none = task(null);
  const pick = (f) => [onTheme, onM1, onR2, onOther, onOps, none].map(t => matchesPlanFilter(t, f, BY));
  assert.deepEqual(pick(''), [true, true, true, true, true, true]);
  assert.deepEqual(pick('t1'), [true, true, true, true, false, false]);
  assert.deepEqual(pick('m1'), [false, true, true, false, false, false]);
  assert.deepEqual(pick('r2'), [false, false, true, false, false, false]);
  assert.deepEqual(pick(UNPLANNED), [false, false, false, false, false, true]);
  // an inherited link counts as the sub-task's own
  assert.equal(matchesPlanFilter({ parent_task_id: 'p', plan: { id: 'r2', kind: 'result', theme_id: 't1', inherited: true } }, 'm1', BY), true);
  assert.equal(planFilterOptions(PLAN)[0].value, UNPLANNED);
  assert.ok(planFilterOptions(PLAN).some(x => x.value === 'm9'));   // done items still filterable
});

test('chip: code with the title on hover; L redacted; inherited muted; none nothing', () => {
  assert.deepEqual(planChip({ id: 'm1', level: 'O', kind: 'milestone', code: 'M01', title: 'Launch' }),
    { label: 'M01', title: 'M01 · Launch', muted: false, redacted: false });
  assert.deepEqual(planChip({ id: 't1', level: 'T', kind: 'theme', code: 'T01', title: 'Growth', inherited: true }),
    { label: 'T01', title: 'Growth — from the parent task', muted: true, redacted: false });
  const l = planChip({ id: 'm7', level: 'L', kind: 'milestone', theme_title: 'Growth' });
  assert.deepEqual(l, { label: 'Another owner’s milestone', title: 'Theme: Growth', muted: false, redacted: true });
  assert.equal(planChip({ id: 'r', level: 'L', kind: 'result' }).label, 'Another owner’s result');
  assert.equal(planChip({ level: 'none' }), null);
  assert.equal(planChip(null), null);
});

test('R2 error codes read as words', () => {
  assert.match(planErrorText(new Error('restricted_needs_founders_space')), /Founders’ space/);
  const e = new Error('restricted_tasks_outside'); e.detail = { detail: 'DKT-4, DKT-9' };
  assert.match(planErrorText(e), /DKT-4, DKT-9/);
  assert.match(planErrorText(new Error('founders_move_out')), /super admin/);
  assert.match(planErrorText(new Error('subtask_follows_parent')), /parent/);
});
