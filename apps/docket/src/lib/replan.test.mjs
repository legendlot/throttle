import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as r from './replan.js';

test('months: step across years, default next IST month, label', () => {
  assert.equal(r.stepMonth('2026-12', 1), '2027-01');
  assert.equal(r.stepMonth('2026-01', -1), '2025-12');
  assert.equal(r.stepMonth('bad', 1), null);
  assert.equal(r.nextMonthIST(Date.parse('2026-11-30T20:00:00Z')), '2027-01');   // 01:30 IST on 1 Dec
  assert.equal(r.nextMonthIST(Date.parse('2026-11-12T10:00:00+05:30')), '2026-12');
  assert.equal(r.monthLabel('2026-12'), 'December 2026');
});

const M = (code, due, rd, extra = {}) => ({ id: code, code, effective_due: due, readiness: rd, ...extra });
const ok = { agreed: true, owner: true, data_source: true, actionable: 2 };

test('readiness: cells, ready rule (worker flag wins), not-ready first then due', () => {
  const list = [M('M3', '2026-12-20', ok, { ready: true }), M('M1', '2026-12-25', { ...ok, actionable: 0 }), M('M2', '2026-12-05', ok), M('M0', '2026-12-01', ok, { ready: false })];
  assert.deepEqual(r.readinessCells(list[1]).map(c => c.ok), [true, true, true, false]);
  assert.equal(r.readinessCells(list[0])[3].n, 2);
  assert.equal(r.isReady(list[2]), true);
  assert.equal(r.isReady(list[3]), false);
  assert.deepEqual(r.sortReadiness(list).map(m => m.code), ['M0', 'M1', 'M2', 'M3']);
  assert.deepEqual(r.sortReadiness(list, false).map(m => m.code), ['M0', 'M2', 'M3', 'M1']);
});

test('team: string or object, options deduped + sorted, filter', () => {
  const list = [M('a', null, ok, { team: 'Ops' }), M('b', null, ok, { team: { id: 'd1', name: 'Design' } }), M('c', null, ok, { team: 'Ops' }), M('d', null, ok)];
  assert.deepEqual(r.teamOptions(list).map(o => o.label), ['All teams', 'Design', 'Ops']);
  assert.deepEqual(r.filterTeam(list, 'Ops').map(m => m.code), ['a', 'c']);
  assert.deepEqual(r.filterTeam(list, 'd1').map(m => m.code), ['b']);
  assert.equal(r.filterTeam(list, '').length, 4);
  assert.equal(r.teamName(list[3]), 'No team');
});

test('scores: trend shape and week_score list shape → one table, All teams first', () => {
  const a = r.scoresTable({ weeks: ['w1', 'w2'], overall: [{ week_end: 'w1', pct: 50, on_time: 1, cohort: 2 }], teams: [{ id: 't', name: 'Ops', points: [{ week_end: 'w2', pct: 100, on_time: 1, cohort: 1 }] }] });
  assert.deepEqual(a.weeks, ['w1', 'w2']);
  assert.deepEqual(a.rows.map(x => x.name), ['All teams', 'Ops']);
  assert.equal(a.rows[0].cells[1].pct, null);
  assert.equal(a.rows[1].cells[1].pct, 100);
  const b = r.scoresTable([{ week_end: 'w1', totals: { pct: 40, on_time: 2, cohort: 5 }, teams: [{ department_id: 'd', name: 'Ops', pct: 40, on_time: 2, cohort: 5 }] }]);
  assert.deepEqual(b.rows.map(x => [x.name, x.cells[0].pct]), [['All teams', 40], ['Ops', 40]]);
  assert.deepEqual(r.scoresTable(null), { weeks: [], rows: [] });
});

test('risk status worded, never raw', () => {
  assert.equal(r.riskStatusLabel('submitted'), 'Open');
  assert.equal(r.riskStatusLabel('accepted'), 'Accepted');
  assert.equal(r.riskStatusLabel('declined'), 'Declined');
  assert.equal(r.riskStatusLabel('withdrawn'), 'Closed');
  assert.equal(r.riskStatusLabel(null), '');
});
