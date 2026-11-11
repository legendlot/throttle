// Run: node --test docketops-worker/test/
// The §4.3 matrix (split since R3). The SQL twin is docket.plan_can / docket.plan_state_ok in
// migrations/0017_plan_items.sql, replaced by 0019_plan_r3.sql — change both together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canPlanAct, planStateAllows, planActionsFor, editableFields, planFlags, nextPlanCode,
  validatePlanFields, validateActPayload, planErrStatus, effectiveDue, isPlanDate, PLAN_KINDS, PLAN_ACTIONS } from '../src/plan-core.mjs';

const SUPER = { isSuper: true };
const OWNER = { isOwner: true };
const MOWNER = { isParentOwner: true };
const NOBODY = {};

test('themes and milestones: super admin only, every action', () => {
  for (const kind of ['theme', 'milestone']) {
    for (const a of PLAN_ACTIONS) {
      assert.equal(canPlanAct(kind, a, SUPER), true, `${kind} ${a} super`);
      assert.equal(canPlanAct(kind, a, OWNER), false, `${kind} ${a} owner`);
      assert.equal(canPlanAct(kind, a, { isOwner: true, isParentOwner: true }), false);
    }
  }
});

test('results: owner edits + marks done; milestone owner also creates, re-owns, re-dates; drop/reopen super', () => {
  const who = (a) => [canPlanAct('result', a, OWNER), canPlanAct('result', a, MOWNER), canPlanAct('result', a, SUPER), canPlanAct('result', a, NOBODY)];
  assert.deepEqual(who('edit'),       [true,  true,  true, false]);
  assert.deepEqual(who('done'),       [true,  true,  true, false]);
  assert.deepEqual(who('create'),     [false, true,  true, false]);
  assert.deepEqual(who('owner'),      [false, true,  true, false]);
  assert.deepEqual(who('redate'),     [false, true,  true, false]);
  assert.deepEqual(who('edit_admin'), [false, false, true, false]);
  assert.deepEqual(who('drop'),       [false, false, true, false]);
  assert.deepEqual(who('reopen'),     [false, false, true, false]);
});

test('unknown kind/action is never allowed, even for super', () => {
  assert.equal(canPlanAct('task', 'edit', SUPER), false);
  assert.equal(canPlanAct('result', 'split', { isOwner: true, isParentOwner: true }), false);   // R3: super only
});

test('lifecycle: agree only a proposed milestone; redate/done only agreed; theme drop/reopen', () => {
  assert.equal(planStateAllows('milestone', 'agree', 'proposed'), true);
  assert.equal(planStateAllows('milestone', 'agree', 'agreed'), false);
  assert.equal(planStateAllows('result', 'agree', 'proposed'), false);
  assert.equal(planStateAllows('milestone', 'redate', 'proposed'), false);   // a proposal's date is a draft: edit it
  assert.equal(planStateAllows('milestone', 'redate', 'agreed'), true);
  assert.equal(planStateAllows('theme', 'redate', 'agreed'), false);
  assert.equal(planStateAllows('milestone', 'drop', 'proposed'), true);
  assert.equal(planStateAllows('result', 'drop', 'proposed'), false);
  assert.equal(planStateAllows('theme', 'done', 'agreed'), false);
  assert.equal(planStateAllows('theme', 'reopen', 'dropped'), true);
  assert.equal(planStateAllows('theme', 'reopen', 'done'), false);
  assert.equal(planStateAllows('result', 'reopen', 'done'), true);
  for (const a of PLAN_ACTIONS) for (const k of PLAN_KINDS) assert.equal(planStateAllows(k, a, 'split'), false, `split is read-only: ${k} ${a}`);
});

test('planActionsFor: what each viewer is offered', () => {
  assert.deepEqual(planActionsFor({ kind: 'milestone', state: 'proposed' }, SUPER), ['agree', 'drop']);
  assert.deepEqual(planActionsFor({ kind: 'milestone', state: 'agreed' }, SUPER), ['redate', 'drop', 'done']);
  assert.deepEqual(planActionsFor({ kind: 'milestone', state: 'agreed' }, OWNER), []);
  assert.deepEqual(planActionsFor({ kind: 'result', state: 'agreed' }, OWNER), ['done']);
  assert.deepEqual(planActionsFor({ kind: 'result', state: 'agreed' }, MOWNER), ['redate', 'done']);
  assert.deepEqual(planActionsFor({ kind: 'result', state: 'done' }, MOWNER), []);
  assert.deepEqual(planActionsFor({ kind: 'result', state: 'done' }, SUPER), ['reopen']);
  assert.deepEqual(planActionsFor({ kind: 'theme', state: 'agreed' }, SUPER), ['drop']);
  assert.deepEqual(planActionsFor({ kind: 'theme', state: 'dropped' }, SUPER), ['reopen']);
});

test('editableFields: due_date only on a proposal; restricted only on a theme; owners get the edit trio', () => {
  assert.ok(editableFields({ kind: 'milestone', state: 'proposed' }, SUPER).includes('due_date'));
  assert.ok(!editableFields({ kind: 'milestone', state: 'agreed' }, SUPER).includes('due_date'));
  assert.ok(editableFields({ kind: 'theme', state: 'agreed' }, SUPER).includes('restricted'));
  assert.ok(!editableFields({ kind: 'theme', state: 'agreed' }, SUPER).includes('done_when'));
  assert.ok(!editableFields({ kind: 'milestone', state: 'agreed' }, SUPER).includes('restricted'));
  assert.deepEqual(editableFields({ kind: 'result', state: 'agreed' }, OWNER), ['title', 'done_when', 'measure']);
  assert.deepEqual(editableFields({ kind: 'result', state: 'agreed' }, MOWNER), ['title', 'done_when', 'measure', 'owner_employee_id']);
  assert.deepEqual(editableFields({ kind: 'result', state: 'done' }, SUPER), []);
});

test('planFlags: parent owner needs the milestone visible and the item to be a result', () => {
  const byId = { m: { id: 'm', kind: 'milestone', owner_employee_id: 'e1' } };
  assert.deepEqual(planFlags({ kind: 'result', parent_id: 'm', owner_employee_id: 'e2' }, { employeeId: 'e1', byId }),
    { isSuper: false, isOwner: false, isParentOwner: true });
  assert.deepEqual(planFlags({ kind: 'result', parent_id: 'gone', owner_employee_id: 'e1' }, { employeeId: 'e1', byId }),
    { isSuper: false, isOwner: true, isParentOwner: false });
  assert.equal(planFlags({ kind: 'result', owner_employee_id: null }, { employeeId: null }).isOwner, false);
});

test('codes: T01/M01 global, results per milestone, no truncation past 99', () => {
  assert.equal(nextPlanCode('theme', []), 'T01');
  assert.equal(nextPlanCode('theme', ['T01', 'T09', 'Tx', 'M44']), 'T10');
  assert.equal(nextPlanCode('milestone', ['M05', 'M05a', 'M02']), 'M06');
  assert.equal(nextPlanCode('milestone', ['M99']), 'M100');
  assert.equal(nextPlanCode('result', ['M01.R1', 'M01.R3', 'M02.R9', 'M01.Rx'], 'M01'), 'M01.R4');
  assert.equal(nextPlanCode('result', ['M01.R1'], 'M05a'), 'M05a.R1');
});

test('validation: shapes only', () => {
  assert.equal(validatePlanFields({ kind: 'theme', title: 'x' }), null);
  assert.equal(validatePlanFields({ kind: 'epic' }), 'bad_kind');
  assert.equal(validatePlanFields({ title: '  ' }), 'title_required');
  assert.equal(validatePlanFields({ due_date: '2026-02-30' }), 'bad_date');
  assert.equal(validatePlanFields({ due_date: '' }), null);
  assert.equal(validatePlanFields({ owner_employee_id: 'nope' }), 'bad_owner');
  assert.equal(validatePlanFields({ parent_id: 'nope' }), 'bad_parent');
  assert.equal(validatePlanFields({ code: 'M 1' }), 'bad_code');
  assert.equal(validatePlanFields({ measure: [1] }), 'bad_measure');
  assert.equal(validatePlanFields({ restricted: 'yes' }), 'bad_restricted');
  assert.equal(validatePlanFields({ title: 'x'.repeat(301) }), 'text_too_long');
  assert.equal(validateActPayload('redate', { due_date: '2026-12-01' }), 'reason_required');
  assert.equal(validateActPayload('redate', { due_date: 'soon', reason: 'x' }), 'bad_date');
  assert.equal(validateActPayload('done', { evidence: ' ' }), 'evidence_required');
  assert.equal(validateActPayload('drop', { reason: 'x' }), null);
  assert.equal(validateActPayload('agree', {}), null);
  assert.equal(validateActPayload('split', {}), 'bad_action');
});

test('error codes → HTTP', () => {
  assert.equal(planErrStatus('forbidden'), 403);
  assert.equal(planErrStatus('not_found'), 404);
  assert.equal(planErrStatus('duplicate_code'), 409);
  assert.equal(planErrStatus('missing_fields'), 400);
});

test('effective due + date guard', () => {
  assert.equal(effectiveDue({ due_date: '2026-12-01', revised_due_date: '2026-12-15' }), '2026-12-15');
  assert.equal(effectiveDue({ due_date: '2026-12-01' }), '2026-12-01');
  assert.equal(isPlanDate('2026-11-31'), false);
});
