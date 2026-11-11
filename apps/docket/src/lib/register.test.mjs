import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shiftDate, windowFor, pageWindow, cellState, pct, pctTone, colHead, cellTip, groupRows } from './register.js';

test('shiftDate crosses month and year boundaries', () => {
  assert.equal(shiftDate('2026-11-01', -1), '2026-10-31');
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDate('2028-02-28', 1), '2028-02-29');
});

test('windowFor: span days ending at end, inclusive', () => {
  assert.deepEqual(windowFor('2026-11-11', 14), { from: '2026-10-29', to: '2026-11-11' });
  assert.deepEqual(windowFor('2026-11-11', 1), { from: '2026-11-11', to: '2026-11-11' });
});

test('pageWindow pages by span and never past today', () => {
  assert.equal(pageWindow('2026-11-11', 14, -1, '2026-11-11'), '2026-10-28');
  assert.equal(pageWindow('2026-10-28', 14, 1, '2026-11-11'), '2026-11-11');
  assert.equal(pageWindow('2026-11-05', 14, 1, '2026-11-11'), '2026-11-11'); // clamped
});

test('cellState: not due, ticked variants, missed, open', () => {
  const due = new Set(['2026-11-10', '2026-11-11']);
  const today = '2026-11-11';
  assert.equal(cellState(due, undefined, '2026-11-09', today), 'nodue');
  assert.equal(cellState(due, { late: false, backfilled: false }, '2026-11-10', today), 'done');
  assert.equal(cellState(due, { late: true, backfilled: false }, '2026-11-10', today), 'late');
  assert.equal(cellState(due, { late: true, backfilled: true }, '2026-11-10', today), 'backfilled');
  assert.equal(cellState(due, undefined, '2026-11-10', today), 'missed');
  assert.equal(cellState(due, undefined, '2026-11-11', today), 'open');
  // a tick on a non-due date never shows (the worker drops it too)
  assert.equal(cellState(due, { late: false }, '2026-11-09', today), 'nodue');
});

test('pct: null when nothing due, rounded otherwise', () => {
  assert.equal(pct({ done: 0, due: 0 }), null);
  assert.equal(pct(undefined), null);
  assert.equal(pct({ done: 1, due: 3 }), 33);
  assert.equal(pct({ done: 2, due: 3 }), 67);
  assert.equal(pct({ done: 3, due: 3 }), 100);
});

test('pctTone bands', () => {
  assert.equal(pctTone(null), 'none');
  assert.equal(pctTone(95), 'good');
  assert.equal(pctTone(60), 'mid');
  assert.equal(pctTone(59), 'bad');
});

test('colHead: weekday initial, day, month on first column and the 1st', () => {
  assert.deepEqual(colHead('2026-11-11', false), { wd: 'W', day: 11, month: '' });
  assert.deepEqual(colHead('2026-11-11', true), { wd: 'W', day: 11, month: 'Nov' });
  assert.deepEqual(colHead('2026-12-01', false), { wd: 'T', day: 1, month: 'Dec' });
});

test('cellTip names who, when, back-fill and the done-by note', () => {
  const clock = (iso, withDate) => withDate ? '12 Nov 10:05' : '09:10';
  assert.equal(cellTip('done', { at: 'x', by: 'Sagar CP' }, '2026-11-10', clock), '10 Nov · done · at 09:10 · by Sagar CP');
  assert.equal(cellTip('backfilled', { at: 'x', by: 'Sagar CP', note: 'Ravi' }, '2026-11-10', clock),
    '10 Nov · done · ticked later, on 12 Nov 10:05 · by Sagar CP · for Ravi');
  assert.equal(cellTip('late', { at: 'x' }, '2026-11-10', clock), '10 Nov · done · at 09:10 · late');
  assert.equal(cellTip('missed', undefined, '2026-11-10', clock), '10 Nov · missed');
  assert.equal(cellTip('nodue', undefined, '2026-11-10', clock), '10 Nov · not scheduled');
});

test('groupRows keeps order and starts a new group when the section changes', () => {
  const g = groupRows([{ id: 1, section: 'Open' }, { id: 2, section: 'Open' }, { id: 3, section: 'Close' }, { id: 4, section: null }]);
  assert.deepEqual(g.map(x => [x.section, x.rows.map(r => r.id)]), [['Open', [1, 2]], ['Close', [3]], [null, [4]]]);
});
