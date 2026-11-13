// Run: node --test docketops-worker/test/*.test.mjs
// F8 P2 record checklists — the pure core (src/records-core.mjs): progress, the pull-updates diff by
// source_item_id, item state transitions, the record status rule (the DB trigger's twin), the version diff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordProgress, progressLabel, nextRecordStatus, unarchivedStatus, flattenTemplate, snapshotRows, templateDiff,
  itemStatePatch, itemEvent, suggestTick, linkAllowed, templateItemsDiff, searchTerm } from '../src/records-core.mjs';

const items = (...states) => states.map((state, i) => ({ id: 'r' + i, state }));

test('progress: (done + na) / all, "6/11 (1 N/A)"; no items is never complete', () => {
  const p = recordProgress(items('done', 'done', 'done', 'done', 'done', 'na', 'open', 'open', 'open', 'open', 'open'));
  assert.deepEqual(p, { done: 5, na: 1, open: 5, total: 11, complete: false });
  assert.equal(progressLabel(p), '6/11 (1 N/A)');
  assert.equal(progressLabel(recordProgress(items('done', 'open'))), '1/2');
  assert.equal(recordProgress([]).complete, false);
  assert.equal(recordProgress(items('na', 'na')).complete, true);   // N/A counts as complete
});

test('status: completes when every item is done/na, re-opens when one opens; archived stays archived', () => {
  assert.equal(nextRecordStatus('open', items('done', 'na')), 'complete');
  assert.equal(nextRecordStatus('complete', items('done', 'open')), 'open');
  assert.equal(nextRecordStatus('open', []), 'open');
  assert.equal(nextRecordStatus('archived', items('done')), 'archived');
  assert.equal(unarchivedStatus(items('done')), 'complete');
  assert.equal(unarchivedStatus(items('open')), 'open');
});

const SECS = [
  { id: 'sC', title: 'Channels', sort_order: 1, items: [{ id: 't3', title: 'Amazon', sort_order: 1 }, { id: 't2', title: 'D2C', sort_order: 0 }] },
  { id: 'sP', title: 'Product', sort_order: 0, items: [{ id: 't1', title: 'Sourcing', help_text: 'BOM signed', sort_order: 0 }] },
];
test('flattenTemplate / snapshotRows: template order, section titles, open, source_item_id kept', () => {
  const flat = flattenTemplate(SECS);
  assert.deepEqual(flat.map(f => [f.id, f.section_id, f.section_title, f.sort_order]), [['t1', 'sP', 'Product', 0], ['t2', 'sC', 'Channels', 1000], ['t3', 'sC', 'Channels', 1010]]);
  const rows = snapshotRows('R', flat);
  assert.deepEqual(rows[0], { record_id: 'R', source_item_id: 't1', section_title: 'Product', title: 'Sourcing', help_text: 'BOM signed', sort_order: 0, state: 'open', origin: 'snapshot' });
  assert.equal(snapshotRows('R', flat, 'pull')[0].origin, 'pull');
  assert.ok(rows.every(r => r.state === 'open'));
});

test('pull updates (C3): adds only what is missing by source_item_id; never touches ticked or copy-only items', () => {
  const flat = flattenTemplate(SECS);
  const rec = [{ id: 'a', source_item_id: 't1', state: 'done' }, { id: 'b', source_item_id: 'gone', state: 'done' }, { id: 'c', source_item_id: null, state: 'open' }];
  const d = templateDiff(flat, rec);
  assert.deepEqual(d.missing.map(m => m.id), ['t2', 't3']);
  assert.deepEqual(d.removed, ['b']);                 // "no longer in template" — stays on the record
  // after the pull nothing is missing, and pulling again adds nothing
  const after = [...rec, ...snapshotRows('R', d.missing).map((x, i) => ({ id: 'n' + i, ...x }))];
  assert.equal(templateDiff(flat, after).missing.length, 0);
  // a rename in the template is not "new"
  assert.equal(templateDiff(flattenTemplate([{ title: 'P', sort_order: 0, items: [{ id: 't1', title: 'Renamed', sort_order: 0 }] }]), rec).missing.length, 0);
});

test('item state: done/na stamp who + when, open clears; na needs a reason; re-sending the same state is a no-op', () => {
  const open = { state: 'open', na_reason: null };
  assert.deepEqual(itemStatePatch({ state: 'done' }, open, 'U', 'T').patch, { state: 'done', na_reason: null, done_by_user_id: 'U', done_at: 'T' });
  assert.equal(itemStatePatch({ state: 'na' }, open, 'U', 'T').error, 'na_reason_required');
  assert.equal(itemStatePatch({ state: 'na', na_reason: '   ' }, open, 'U', 'T').error, 'na_reason_required');
  assert.equal(itemStatePatch({ state: 'na', na_reason: 'x'.repeat(301) }, open, 'U', 'T').error, 'na_reason_too_long');
  assert.equal(itemStatePatch({ state: 'na', na_reason: ' No tooling ' }, open, 'U', 'T').patch.na_reason, 'No tooling');
  assert.equal(itemStatePatch({ state: 'maybe' }, open, 'U', 'T').error, 'bad_state');
  const done = { state: 'done', done_by_user_id: 'A', done_at: 'T0' };
  assert.deepEqual(itemStatePatch({ state: 'open' }, done, 'U', 'T').patch, { state: 'open', na_reason: null, done_by_user_id: null, done_at: null });
  assert.equal(itemStatePatch({ state: 'done' }, done, 'U', 'T').patch, null);   // the first tick's who/when stand
  assert.deepEqual(itemStatePatch({ state: 'done', note: ' hi ' }, done, 'U', 'T').patch, { note: 'hi' });
  assert.deepEqual(itemStatePatch({ note: '' }, open, 'U', 'T').patch, { note: null });
  assert.equal(itemStatePatch({}, open, 'U', 'T').error, 'nothing_to_change');
  assert.equal(itemEvent(open, { state: 'done' }), 'item_done');
  assert.equal(itemEvent(open, { state: 'na', na_reason: 'x' }), 'item_na');
  assert.equal(itemEvent(done, { state: 'open' }), 'item_reopened');
  assert.equal(itemEvent(done, { note: 'x' }), 'item_note');
});

test('C4: suggest the tick only for an open item whose visible task is done', () => {
  assert.equal(suggestTick({ state: 'open' }, { status: 'done' }), true);
  assert.equal(suggestTick({ state: 'done' }, { status: 'done' }), false);
  assert.equal(suggestTick({ state: 'open' }, { status: 'in_progress' }), false);
  assert.equal(suggestTick({ state: 'open' }, null), false);
});

test('link rule: same space, or the record in General', () => {
  assert.equal(linkAllowed({ id: 'G', is_default: true }, 'P'), true);
  assert.equal(linkAllowed({ id: 'P', is_default: false }, 'P'), true);
  assert.equal(linkAllowed({ id: 'F', is_default: false, is_founders: true }, 'G'), false);
  assert.equal(linkAllowed(null, 'G'), false);
});

test('version diff: added / removed / renamed / reordered / moved section bump; an untouched save does not', () => {
  const before = flattenTemplate(SECS);   // t1 (Product), t2, t3 (Channels)
  const same = [{ id: 'sP', title: 'Product', items: [{ id: 't1', title: 'Sourcing' }] }, { id: 'sC', title: 'Channels', items: [{ id: 't2', title: 'D2C' }, { id: 't3', title: 'Amazon' }] }];
  assert.equal(templateItemsDiff(before, same).changed, false);
  const add = structuredClone(same); add[1].items.push({ id: null, title: 'Flipkart' });
  assert.deepEqual(templateItemsDiff(before, add), { changed: true, added: 1, removed: 0, renamed: 0, reordered: false });
  const rm = structuredClone(same); rm[1].items.pop();
  assert.equal(templateItemsDiff(before, rm).removed, 1);
  const ren = structuredClone(same); ren[0].items[0].title = 'Raw material';
  assert.equal(templateItemsDiff(before, ren).renamed, 1);
  const ord = structuredClone(same); ord[1].items.reverse();
  assert.equal(templateItemsDiff(before, ord).reordered, true);
  const mv = [{ id: 'sP', title: 'Product', items: [{ id: 't1', title: 'Sourcing' }, { id: 't2', title: 'D2C' }] }, { id: 'sC', title: 'Channels', items: [{ id: 't3', title: 'Amazon' }] }];
  assert.equal(templateItemsDiff(before, mv).reordered, true);
  // a section rename (same section id, same items, same order) is not a reorder — nothing bumps
  const rn = structuredClone(same); rn[1].title = 'Sales channels';
  assert.equal(templateItemsDiff(before, rn).changed, false);
  // an item moved into a brand-new section is a move
  const ns = [same[0], { id: 'sC', title: 'Channels', items: [{ id: 't2', title: 'D2C' }] }, { id: null, title: 'New', items: [{ id: 't3', title: 'Amazon' }] }];
  assert.equal(templateItemsDiff(before, ns).reordered, true);
  assert.equal(templateItemsDiff([], [{ title: 'S', items: [{ title: 'a' }] }]).added, 1);   // a new template
});

test('searchTerm strips PostgREST list syntax and wildcards', () => {
  assert.equal(searchTerm('Badger, (x)*%'), 'Badger x');
  assert.equal(searchTerm(null), '');
});
