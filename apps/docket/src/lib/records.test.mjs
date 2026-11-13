import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordProgress, progressLabel, progressPct, groupSections, hiddenChecklistsText, recordErrorText, createTaskErrorText, tickSuggestion } from './records.js';

test('progress label and percent', () => {
  const p = recordProgress([{ state: 'done' }, { state: 'na' }, { state: 'open' }]);
  assert.deepEqual(p, { done: 1, na: 1, open: 1, total: 3, complete: false });
  assert.equal(progressLabel(p), '2/3 (1 N/A)');
  assert.equal(progressPct(p), 67);
  assert.equal(progressPct(recordProgress([])), 0);
  assert.equal(recordProgress([{ state: 'na' }]).complete, true);
});
test('sections group in order of first appearance; no section is its own group', () => {
  const g = groupSections([{ id: 1, section_title: 'A' }, { id: 2, section_title: 'A' }, { id: 3, section_title: 'B' }, { id: 4, section_title: null }]);
  assert.deepEqual(g.map(s => [s.title, s.items.map(i => i.id)]), [['A', [1, 2]], ['B', [3]], [null, [4]]]);
});
test('hidden count, refusal words, the C4 suggestion', () => {
  assert.equal(hiddenChecklistsText(1), '1 checklist you can’t see');
  assert.equal(hiddenChecklistsText(2), '2 checklists you can’t see');
  assert.equal(hiddenChecklistsText(0), '');
  assert.match(recordErrorText(new Error('link_cross_space: a checklist links only…')), /own space/);
  assert.equal(recordErrorText(new Error('weird')), 'weird');
  assert.equal(tickSuggestion({ suggest_tick: true, task: { task_no: 'DKT-123' } }), 'DKT-123 is done — tick this?');
  assert.equal(tickSuggestion({ suggest_tick: false, task: { task_no: 'DKT-123' } }), null);
});

test('createTask refusals after the task exists name it', () => {
  const e = (detail) => Object.assign(new Error(detail.error), { detail });
  assert.equal(createTaskErrorText(e({ error: 'item_has_task', task_no: 'DKT-900', other_task_no: 'DKT-7' })), 'Created DKT-900 but the item already had DKT-7');
  assert.equal(createTaskErrorText(e({ error: 'item_has_task', task_no: 'DKT-900', other_task_no: null })), 'Created DKT-900 but the item already had a task');
  assert.match(createTaskErrorText(e({ error: 'link_failed: created DKT-900', task_no: 'DKT-900' })), /^Created DKT-900, but/);
  assert.equal(createTaskErrorText(e({ error: 'item_has_task' })), 'This item already has a task.');
});
