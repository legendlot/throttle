// Run: node --test docketops-worker/test/
// F9 R3: the split cell of the §4.3 matrix, the split / proposal shape checks, and the §4.4 metric
// registry. The SQL twin is migrations/0019_plan_r3.sql (plan-r3.sql runs it against the live functions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canPlanAct, planStateAllows, canSplit, planActionsFor, PLAN_ACTIONS, PLAN_KINDS, PLAN_STATES,
  validateSplitPayload, validateProposal, validateDecision, planErrStatus } from '../src/plan-core.mjs';
import { PLAN_METRICS, METRIC_SYSTEMS, metricByKey, normalizeMeasure, publicMetrics } from '../src/plan-metrics.mjs';

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const kid = (o = {}) => ({ title: 'a', owner_employee_id: U(1), due_date: '2026-12-31', done_when: 'x', ...o });

test('split: super only, an agreed milestone or result; never a theme; never from split/done/dropped/proposed', () => {
  assert.ok(PLAN_ACTIONS.includes('split'));
  for (const k of PLAN_KINDS) {
    assert.equal(canPlanAct(k, 'split', { isSuper: true }), true);
    assert.equal(canPlanAct(k, 'split', { isOwner: true, isParentOwner: true }), false);
  }
  assert.equal(planStateAllows('milestone', 'split', 'agreed'), true);
  assert.equal(planStateAllows('result', 'split', 'agreed'), true);
  assert.equal(planStateAllows('theme', 'split', 'agreed'), false);
  for (const s of PLAN_STATES.filter(x => x !== 'agreed')) {
    assert.equal(planStateAllows('milestone', 'split', s), false, s);
    assert.equal(planStateAllows('result', 'split', s), false, s);
  }
  assert.equal(canSplit({ kind: 'milestone', state: 'agreed' }, { isSuper: true }), true);
  assert.equal(canSplit({ kind: 'result', state: 'agreed' }, { isOwner: true, isParentOwner: true }), false);
  assert.equal(canSplit({ kind: 'milestone', state: 'split' }, { isSuper: true }), false);
  // planActionsFor lists plan_act's actions only — split has its own button
  assert.deepEqual(planActionsFor({ kind: 'milestone', state: 'agreed' }, { isSuper: true }), ['redate', 'drop', 'done']);
  // a split item is read-only for everyone
  for (const a of PLAN_ACTIONS) for (const k of PLAN_KINDS) assert.equal(planStateAllows(k, a, 'split'), false, `${k} ${a}`);
});

test('split payload: reason, 2..10 full children, results child|drop, tasks child|uuid, default a child', () => {
  const ok = { reason: 'r', children: [kid(), kid()] };
  assert.equal(validateSplitPayload(ok), null);
  assert.equal(validateSplitPayload({ ...ok, reason: ' ' }), 'reason_required');
  assert.equal(validateSplitPayload({ ...ok, children: [kid()] }), 'bad_children');
  assert.equal(validateSplitPayload({ ...ok, children: Array.from({ length: 11 }, () => kid()) }), 'bad_children');
  assert.equal(validateSplitPayload({ ...ok, children: [kid(), kid({ title: '' })] }), 'title_required');
  assert.equal(validateSplitPayload({ ...ok, children: [kid(), kid({ owner_employee_id: undefined })] }), 'owner_required');
  assert.equal(validateSplitPayload({ ...ok, children: [kid(), kid({ due_date: undefined })] }), 'missing_fields');
  assert.equal(validateSplitPayload({ ...ok, children: [kid(), kid({ done_when: ' ' })] }), 'missing_fields');
  assert.equal(validateSplitPayload({ ...ok, children: [kid(), kid({ due_date: '2026-02-30' })] }), 'bad_date');
  assert.equal(validateSplitPayload({ ...ok, children: [kid(), kid({ code: 'M 1' })] }), 'bad_code');
  assert.equal(validateSplitPayload({ ...ok, results: { [U(2)]: 1, [U(3)]: 'drop' } }), null);
  assert.equal(validateSplitPayload({ ...ok, results: { [U(2)]: 2 } }), 'bad_results');
  assert.equal(validateSplitPayload({ ...ok, results: { nope: 0 } }), 'bad_results');
  assert.equal(validateSplitPayload({ ...ok, results: [] }), 'bad_results');
  assert.equal(validateSplitPayload({ ...ok, tasks: { [U(4)]: 0, [U(5)]: U(2) } }), null);
  assert.equal(validateSplitPayload({ ...ok, tasks: { [U(4)]: 'drop' } }), 'bad_tasks');
  assert.equal(validateSplitPayload({ ...ok, tasks_default: 1 }), null);
  assert.equal(validateSplitPayload({ ...ok, tasks_default: 2 }), 'bad_tasks_default');
  assert.equal(validateSplitPayload({ ...ok, tasks_default: '0' }), 'bad_tasks_default');
});

test('proposals: title ≤200 + why ≤2000 required; decide accept|decline, decline needs a note', () => {
  assert.equal(validateProposal({ title: 'x', why: 'y' }), null);
  assert.equal(validateProposal({ title: ' ', why: 'y' }), 'title_required');
  assert.equal(validateProposal({ title: 'x'.repeat(201), why: 'y' }), 'text_too_long');
  assert.equal(validateProposal({ title: 'x', why: '' }), 'why_required');
  assert.equal(validateProposal({ title: 'x', why: 'y'.repeat(2001) }), 'text_too_long');
  assert.equal(validateProposal({ title: 'x', why: 'y', kind_hint: 'task' }), 'bad_kind');
  assert.equal(validateProposal({ title: 'x', why: 'y', suggested_date: '2026-13-01' }), 'bad_date');
  assert.equal(validateProposal({ title: 'x', why: 'y', suggested_theme_id: 'nope' }), 'bad_theme');
  assert.equal(validateProposal({ title: 'x', why: 'y', suggested_owner_employee_id: 'nope' }), 'bad_owner');
  assert.equal(validateDecision({ decision: 'maybe' }), 'bad_decision');
  assert.equal(validateDecision({ decision: 'decline' }), 'note_required');
  assert.equal(validateDecision({ decision: 'decline', note: 'covered' }), null);
  assert.equal(validateDecision({ decision: 'accept', theme_id: U(1), state: 'agreed', due_date: '2026-12-01' }), null);
  assert.equal(validateDecision({ decision: 'accept', state: 'done' }), 'bad_state');
  assert.equal(validateDecision({ decision: 'accept', theme_id: 'x' }), 'bad_theme');
  assert.equal(planErrStatus('unmapped_results'), 422);
  assert.equal(planErrStatus('unmapped_tasks'), 422);
  assert.equal(planErrStatus('already_decided'), 409);
});

test('metric registry: unique keys, known systems, manual is never a source, source tables named', () => {
  assert.equal(new Set(PLAN_METRICS.map(m => m.key)).size, PLAN_METRICS.length);
  for (const m of PLAN_METRICS) {
    assert.ok(METRIC_SYSTEMS.includes(m.system), m.key);
    assert.equal(typeof m.source_ok, 'boolean', m.key);
    assert.ok(m.label && m.note, m.key);
    if (m.system !== 'manual') { assert.ok(m.key.startsWith(m.system + '.'), m.key); assert.match(m.source, /^[a-z]+\.[a-z_]+/, m.key); }
  }
  assert.equal(metricByKey('manual').source_ok, false);
  assert.equal(metricByKey('toString'), null);
  for (const s of ['redline', 'garage', 'odo', 'podium', 'docket']) assert.ok(PLAN_METRICS.some(m => m.system === s), s);
  assert.ok(!('source' in publicMetrics()[0]));
});

test('measure: validated against the registry; source_ok comes from it, never the client', () => {
  assert.deepEqual(normalizeMeasure(null), { value: null });
  assert.deepEqual(normalizeMeasure({ system: 'redline', metric: 'redline.first_pass_yield', target: ' ≥ 97% ', source_ok: false, last_reading: '99' }),
    { value: { system: 'redline', metric: 'redline.first_pass_yield', target: '≥ 97%', source_ok: true } });
  assert.deepEqual(normalizeMeasure({ metric: 'redline.downtime_minutes', source_ok: true }).value.source_ok, false);
  assert.deepEqual(normalizeMeasure({ system: 'manual', metric: 'manual' }).value, { system: 'manual', metric: 'manual', target: null, source_ok: false });
  assert.equal(normalizeMeasure({ system: 'odo', metric: 'redline.units_packed' }).error, 'unknown_metric');
  assert.equal(normalizeMeasure({ system: 'odo', metric: 'SELECT 1' }).error, 'unknown_metric');
  assert.equal(normalizeMeasure([]).error, 'bad_measure');
  assert.equal(normalizeMeasure({ metric: 'manual', target: 'x'.repeat(301) }).error, 'bad_measure');
});
