import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as t from './tree.js';

const items = [
  { id: 'T1', kind: 'theme', code: 'T01', title: 'Growth' },
  { id: 'M1', parent_id: 'T1', kind: 'milestone', code: 'M01', title: 'Launch' },
  { id: 'R1', parent_id: 'M1', kind: 'result', code: 'M01.R1', title: 'Retail' },
  { id: 'M2', parent_id: 'T1', kind: 'milestone', code: 'M02', title: 'Empty' },
  { id: 'X', parent_id: 'GONE', kind: 'milestone', code: 'M09', title: 'Orphan' },
];
const tasks = { M1: { rows: [{ id: 'k1', task_no: 'DKT-1' }], more: 0 }, R1: { rows: [{ id: 'k2' }], more: 3 } };

test('index: an item whose parent is missing renders as a root', () => {
  const idx = t.treeIndex(items);
  assert.deepEqual(idx.roots.map(i => i.id), ['T1', 'X']);
  assert.deepEqual(idx.kids.get('T1').map(i => i.id), ['M1', 'M2']);
});

test('default: themes open to their milestones, nothing deeper', () => {
  const rows = t.flattenTree(items, tasks, t.defaultExpanded(items));
  assert.deepEqual(rows.map(r => r.type === 'item' ? r.item.id : r.type), ['T1', 'M1', 'M2', 'X']);
  assert.equal(rows[1].expandable, true);
  assert.equal(rows[1].open, false);
  assert.equal(rows[2].expandable, false);   // no children, no tasks
  assert.equal(rows[1].depth, 1);
});

test('open: child items first, then direct tasks, then "+N more"', () => {
  const rows = t.flattenTree(items, tasks, new Set(['T1', 'M1', 'R1']));
  assert.deepEqual(rows.map(r => r.type === 'item' ? r.item.id : r.type === 'task' ? r.task.id : 'more:' + r.more),
    ['T1', 'M1', 'R1', 'k2', 'more:3', 'k1', 'M2', 'X']);
  assert.equal(rows.find(r => r.type === 'more').itemId, 'R1');
  assert.equal(rows.find(r => r.type === 'task' && r.task.id === 'k2').depth, 3);
});

test('expand all / collapse / toggle', () => {
  assert.deepEqual([...t.expandAll(items, tasks)].sort(), ['M1', 'R1', 'T1']);
  const s = t.toggle(new Set(['T1']), 'T1');
  assert.equal(s.has('T1'), false);
  assert.equal(t.toggle(s, 'M1').has('M1'), true);
  assert.deepEqual(t.flattenTree(items, tasks, new Set()).map(r => r.item.id), ['T1', 'X']);
});

test('a malformed cycle never loops', () => {
  const cyc = [{ id: 'a', parent_id: 'b', kind: 'milestone' }, { id: 'b', parent_id: 'a', kind: 'result' }, { id: 'r', kind: 'theme' }];
  assert.ok(t.flattenTree(cyc, {}, new Set(['a', 'b', 'r'])).length <= 3);
});

test('counts, on-time, hidden, themes', () => {
  assert.deepEqual(t.countParts({ open: 2, done: 0, overdue: 1 }).map(p => p.text), ['2 open', '1 overdue']);
  assert.deepEqual(t.countParts(null).map(p => p.text), ['0 open']);
  assert.equal(t.onTimeText({ on_time: 3, scored: 4, pct: 75 }), '75% on time');
  assert.equal(t.onTimeText({ scored: 0, pct: null }), '—');
  assert.equal(t.hiddenText({ hidden: 2 }), '+2 hidden');
  assert.equal(t.hiddenText({ hidden: 0 }), '');
  assert.deepEqual(t.themeOptions(items).map(o => o.value), ['', 'T1']);
});

test('nearest visible ancestor: a result directly under its theme renders at depth 1', () => {
  const its = [{ id: 'T', kind: 'theme', title: 'Growth' }, { id: 'R', parent_id: 'T', kind: 'result', title: 'Retail' }];
  const rows = t.flattenTree(its, { R: { rows: [{ id: 'k' }], more: 0 } }, new Set(['T', 'R']));
  assert.deepEqual(rows.map(r => [r.type, r.depth]), [['item', 0], ['item', 1], ['task', 2]]);
  assert.equal(rows[1].item.id, 'R');
  assert.deepEqual(t.flattenTree(its, {}, t.defaultExpanded(its)).map(r => r.item.id), ['T', 'R']);   // shown with the theme open
});

test('treeErrorText: known plan codes worded, anything else a fixed sentence', () => {
  assert.equal(t.treeErrorText(new Error('db_error')), t.TREE_LOAD_FAILED);
  assert.equal(t.treeErrorText(new Error('server_error')), t.TREE_LOAD_FAILED);
  assert.equal(t.treeErrorText(new Error('not_found')), 'This item is no longer visible to you.');
});
