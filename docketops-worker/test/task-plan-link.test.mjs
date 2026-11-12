// Run: node --test docketops-worker/test/
// F9 R2 — tasks link up. The SQL twin is migrations/0018_task_plan_link.sql (tasks_plan_guard,
// plan_items_confidential, plan_links_for); test/task-plan-link.sql runs those against the database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkError, effectiveLink, taskPlan, planLinkLabel, planDbError, planErrStatus,
  LINK_STATES, LINKABLE_LEVELS } from '../src/plan-core.mjs';

const row = (o) => ({ id: 'i1', level: 'O', kind: 'milestone', code: 'M01', title: 'Ship it', state: 'agreed',
  theme_id: 't1', theme_code: 'T01', theme_title: 'Growth', ...o });

test('link targets: F / O / T and live only; L, none and unknown all read as not found', () => {
  assert.deepEqual(LINKABLE_LEVELS, ['F', 'O', 'T']);
  assert.deepEqual(LINK_STATES, ['proposed', 'agreed']);
  for (const level of ['F', 'O', 'T']) for (const state of ['proposed', 'agreed']) assert.equal(linkError(row({ level, state })), null);
  for (const state of ['done', 'dropped', 'split']) assert.equal(linkError(row({ state })), 'plan_item_closed');
  // An L row carries no state — it must fail on level, never leak "closed" for an item you can't see.
  assert.equal(linkError(row({ level: 'L', state: null })), 'plan_item_not_found');
  assert.equal(linkError(row({ level: 'L', state: 'done' })), 'plan_item_not_found');
  assert.equal(linkError({ id: 'i1', level: 'none' }), 'plan_item_not_found');
  assert.equal(linkError(undefined), 'plan_item_not_found');
});

test('effective link: a top-level task its own, a sub-task its parent\'s (its own is never read)', () => {
  const own = { p: 'mA', q: null };
  assert.deepEqual(effectiveLink({ id: 'p', plan_item_id: 'stale' }, own), { id: 'mA', inherited: false });
  assert.deepEqual(effectiveLink({ id: 'x', plan_item_id: 'mB' }, own), { id: 'mB', inherited: false });
  assert.deepEqual(effectiveLink({ id: 'c', parent_task_id: 'p', plan_item_id: 'mZ' }, own), { id: 'mA', inherited: true });
  assert.deepEqual(effectiveLink({ id: 'c', parent_task_id: 'q' }, own), { id: null, inherited: true });
  assert.deepEqual(effectiveLink({ id: 'c', parent_task_id: 'unknown' }, own), { id: null, inherited: true });
  assert.deepEqual(effectiveLink(null), { id: null, inherited: false });
});

test('task plan object: L is redacted to kind + theme; none leaves no trace', () => {
  const o = taskPlan(row(), false);
  assert.deepEqual(o, { id: 'i1', level: 'O', kind: 'milestone', code: 'M01', title: 'Ship it', state: 'agreed',
    theme_id: 't1', theme_code: 'T01', theme_title: 'Growth', inherited: false });
  // Even if a row arrived carrying more than L allows, the worker never forwards it.
  const l = taskPlan(row({ level: 'L', code: 'M07', title: 'Secret', state: 'agreed' }), true);
  assert.equal(l.code, null); assert.equal(l.title, null); assert.equal(l.state, null);
  assert.equal(l.theme_title, 'Growth'); assert.equal(l.inherited, true); assert.equal(l.kind, 'milestone');
  assert.equal(taskPlan({ id: 'i1', level: 'none' }), null);
  assert.equal(taskPlan(undefined), null);
  assert.doesNotMatch(JSON.stringify(l), /Secret|M07/);
});

test('labels: F/O/T code · title (a theme its title); L the redacted line; none nothing', () => {
  assert.equal(planLinkLabel(taskPlan(row())), 'M01 · Ship it');
  assert.equal(planLinkLabel(taskPlan(row({ level: 'T', kind: 'theme', code: 'T01', title: 'Growth' }))), 'Growth');
  assert.equal(planLinkLabel(taskPlan(row({ level: 'L' }))), 'Another owner’s milestone (Growth)');
  assert.equal(planLinkLabel(taskPlan(row({ level: 'L', kind: 'result', theme_title: null }))), 'Another owner’s result');
  assert.equal(planLinkLabel(taskPlan({ level: 'none' })), null);
  assert.equal(planLinkLabel(null), null);
});

test('trigger / CHECK errors map to their codes and statuses', () => {
  assert.deepEqual(planDbError({ message: 'restricted_needs_founders_space' }), { code: 'restricted_needs_founders_space' });
  assert.deepEqual(planDbError({ message: 'plan_item_closed' }), { code: 'plan_item_closed' });
  assert.deepEqual(planDbError({ message: 'new row for relation "tasks" violates check constraint "tasks_plan_link_top_level"' }), { code: 'subtask_follows_parent' });
  assert.deepEqual(planDbError({ message: 'restricted_tasks_outside: DKT-1, DKT-2 (+3 more)' }), { code: 'restricted_tasks_outside', detail: 'DKT-1, DKT-2 (+3 more)' });
  assert.equal(planDbError({ message: 'duplicate key value' }), null);
  assert.equal(planDbError(null), null);
  assert.equal(planErrStatus('plan_item_not_found'), 404);
  assert.equal(planErrStatus('plan_item_closed'), 422);
  assert.equal(planErrStatus('subtask_follows_parent'), 422);
  assert.equal(planErrStatus('restricted_needs_founders_space'), 422);
  assert.equal(planErrStatus('restricted_tasks_outside'), 409);
});

test('level R links like everyone: an R theme yes, an R milestone/result no (not the Associate\'s to attach work to)', () => {
  assert.equal(linkError({ id: 't', level: 'R', kind: 'theme', state: 'agreed' }), null);
  assert.equal(linkError({ id: 'm', level: 'R', kind: 'milestone', state: 'agreed' }), 'plan_item_not_found');
  assert.equal(linkError({ id: 'r', level: 'R', kind: 'result', state: 'agreed' }), 'plan_item_not_found');
  assert.equal(linkError({ id: 't', level: 'R', kind: 'theme', state: 'dropped' }), 'plan_item_closed');
});
