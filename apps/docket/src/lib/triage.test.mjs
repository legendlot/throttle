// node --test src/lib/*.test.mjs  (npm test) — Grid triage (Docket F3): queue, counts, patch guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTriage, triageReducer as r, progressLine, triageCounts, isLocked, buildTriagePatch, saveOutcome, relAgo, isGoneError } from './triage.js';

test('queue: record / skip advance, back steps, the end is the summary (i === length)', () => {
  let s = startTriage(['a', 'b', 'c']);
  s = r(s, { type: 'record', result: 'set' });
  assert.equal(s.i, 1);
  s = r(s, { type: 'skip' });
  assert.deepEqual(s.results, { a: 'set', b: 'skipped' });
  s = r(s, { type: 'back' });
  assert.equal(s.i, 1);
  s = r(s, { type: 'record', result: 'partial' });          // a skipped card can still be worked
  assert.equal(s.results.b, 'partial');
  s = r(s, { type: 'record', result: 'abandoned' });
  assert.equal(s.i, 3);                                     // summary
  assert.equal(r(s, { type: 'skip' }), s);                  // nothing past the end
  s = r(r(r(s, { type: 'back' }), { type: 'back' }), { type: 'back' });
  s = r(r(s, { type: 'back' }), { type: 'back' });
  assert.equal(s.i, 0);                                     // clamps at the start
});

test('skip never overwrites a saved outcome; locked = saved or abandoned', () => {
  let s = startTriage(['a', 'b']);
  s = r(s, { type: 'record', result: 'set' });
  s = r(s, { type: 'back' });
  s = r(s, { type: 'skip' });                               // → past a saved card
  assert.equal(s.results.a, 'set');
  assert.ok(isLocked('set') && isLocked('partial') && isLocked('abandoned'));
  assert.ok(!isLocked('skipped') && !isLocked('gone') && !isLocked(undefined));
});

test('progress line: position + only the non-zero counts; gone counts as skipped', () => {
  let s = startTriage(['a', 'b', 'c', 'd', 'e']);
  assert.equal(progressLine(s), '1 of 5');
  s = r(s, { type: 'record', result: 'set' });
  s = r(s, { type: 'record', result: 'set' });
  s = r(s, { type: 'record', result: 'partial' });
  s = r(s, { type: 'record', result: 'abandoned' });
  assert.equal(progressLine(s), '5 of 5 · 2 set · 1 still in the Grid · 1 abandoned');
  s = r(s, { type: 'record', result: 'gone' });
  assert.equal(progressLine(s), '5 of 5 · 2 set · 1 still in the Grid · 1 abandoned · 1 skipped');
  assert.deepEqual(triageCounts(s), { set: 2, partial: 1, abandoned: 1, skipped: 0, gone: 1 });
});

const NOW = new Date('2026-11-09T04:30:00.000Z');           // 10:00 IST
test('patch: only changed fields; a deadline only when the task has none', () => {
  const task = { id: 't', owner_employee_id: null, deadline: null, priority: 'P2' };
  const fut = '2026-11-13T12:30:00.000Z';
  assert.deepEqual(buildTriagePatch(task, { owner_employee_id: 'e1', deadline: fut, priority: 'P2' }, NOW),
    { patch: { owner_employee_id: 'e1', deadline: fut }, error: null, complete: true });
  const withDl = { ...task, deadline: '2026-11-01T12:30:00.000Z' };
  const p2 = buildTriagePatch(withDl, { owner_employee_id: 'e1', deadline: fut, priority: 'P1' }, NOW);
  assert.deepEqual(p2.patch, { owner_employee_id: 'e1', priority: 'P1' });   // never re-sends a deadline
  assert.equal(p2.complete, true);
  assert.deepEqual(buildTriagePatch(task, { priority: 'P2' }, NOW), { patch: null, error: null, complete: false });
});

test('patch: partial progress is allowed and flagged incomplete', () => {
  const task = { id: 't', owner_employee_id: null, deadline: null, priority: 'P2' };
  const p = buildTriagePatch(task, { owner_employee_id: 'e1' }, NOW);
  assert.deepEqual(p.patch, { owner_employee_id: 'e1' });
  assert.equal(p.complete, false);
});

test('patch: a past (or now) deadline is refused — it would become immutable', () => {
  const task = { id: 't', owner_employee_id: 'e1', deadline: null, priority: 'P2' };
  const past = buildTriagePatch(task, { owner_employee_id: 'e1', deadline: '2026-11-08T12:30:00.000Z' }, NOW);
  assert.equal(past.patch, null);
  assert.match(past.error, /past/);
  assert.match(buildTriagePatch(task, { deadline: NOW.toISOString() }, NOW).error, /past/);
  assert.match(buildTriagePatch(task, { deadline: 'nope' }, NOW).error, /valid/);
});

test('relAgo + gone errors', () => {
  assert.equal(relAgo('2026-11-09T04:00:00.000Z', NOW), '30m ago');
  assert.equal(relAgo('2026-11-06T04:30:00.000Z', NOW), '3d ago');
  assert.equal(relAgo('2026-08-09T04:30:00.000Z', NOW), '3mo ago');
  assert.equal(relAgo('2024-11-01T04:30:00.000Z', NOW), '2y ago');
  for (const s of [403, 404, 409, 422]) assert.ok(isGoneError({ status: s }), String(s));
  for (const s of [400, 500, undefined]) assert.ok(!isGoneError({ status: s }), String(s));
});

test('record keys on the WRITTEN task id; advances only if it is still the current card', () => {
  let s = startTriage(['a', 'b', 'c']);
  s = r(s, { type: 'skip' });                               // user moved on to b while a saved
  s = r(s, { type: 'record', id: 'a', result: 'set', patch: { priority: 'P1' } });
  assert.equal(s.i, 1);                                     // still on b
  assert.equal(s.results.a, 'set');
  assert.deepEqual(s.saved.a, { priority: 'P1' });          // kept for the locked card's display
  s = r(s, { type: 'record', id: 'b', result: 'abandoned' });
  assert.equal(s.i, 2);
  assert.equal(r(s, { type: 'record', id: 'zzz', result: 'set' }), s);   // not in the queue → ignored
});

test('patch: an untouched field is never sent (stale draft after Open task can\'t revert)', () => {
  // Seeded at P2 / no owner; TaskView then set P1 + owner e9 on the live row.
  const live = { id: 't', owner_employee_id: 'e9', deadline: null, priority: 'P1' };
  const staleDraft = { owner_employee_id: null, deadline: null, priority: 'P2' };
  assert.equal(buildTriagePatch(live, staleDraft, NOW, new Set()).patch, null);
  const p = buildTriagePatch(live, { ...staleDraft, deadline: '2026-11-13T12:30:00.000Z' }, NOW, new Set(['deadline']));
  assert.deepEqual(p.patch, { deadline: '2026-11-13T12:30:00.000Z' });
  assert.equal(p.complete, true);                           // live owner e9 + the new deadline
  // A dirty field equal to the live value isn't sent either.
  assert.equal(buildTriagePatch(live, { priority: 'P1' }, NOW, new Set(['priority'])).patch, null);
});

test('saveOutcome: a deadline the worker ignored is not "set"', () => {
  const patch = { owner_employee_id: 'e1', deadline: '2026-11-13T12:30:00.000Z' };
  assert.deepEqual(saveOutcome(patch, { id: 't', updated: ['owner_employee_id'] }, true),
    { result: 'partial', patch: { owner_employee_id: 'e1' }, note: 'deadline was already set elsewhere' });
  assert.equal(saveOutcome({ deadline: patch.deadline }, { id: 't', updated: [] }, true).result, 'gone');
  assert.equal(saveOutcome({ deadline: patch.deadline }, { id: 't', unchanged: true }, true).result, 'gone');
  assert.deepEqual(saveOutcome(patch, { id: 't', updated: ['owner_employee_id', 'deadline'] }, true), { result: 'set', patch, note: null });
  assert.equal(saveOutcome({ priority: 'P1' }, { id: 't', updated: ['priority'] }, false).result, 'partial');
  assert.equal(saveOutcome({ priority: 'P1' }, { id: 't', unchanged: true }, false).result, 'skipped');
});
