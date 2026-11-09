import { test } from 'node:test';
import assert from 'node:assert/strict';
import { primaryReason, groupStale, staleAge, daysSince, reviseError, lastTouched } from './stale.js';

const NOW = new Date('2026-11-09T06:30:00.000Z');
const t = (o) => ({ id: o.id, stale_reasons: [], ...o });

test('reason precedence: a task in both shows once, under Overdue', () => {
  assert.equal(primaryReason(t({ stale_reasons: ['untouched60', 'overdue30'] })), 'overdue30');
  assert.equal(primaryReason(t({ stale_reasons: ['untouched60'] })), 'untouched60');
  assert.equal(primaryReason(t({})), null);
  const g = groupStale([
    t({ id: 'a', stale_reasons: ['overdue30', 'untouched60'] }),
    t({ id: 'b', stale_reasons: ['untouched60'] }),
    t({ id: 'c', stale_reasons: ['overdue30'] }),
  ]);
  assert.deepEqual(g.map(x => [x.key, x.rows.map(r => r.id)]), [['overdue30', ['a', 'c']], ['untouched60', ['b']]]);
  assert.equal(g.flatMap(x => x.rows).length, 3);
  assert.deepEqual(groupStale([t({ id: 'b', stale_reasons: ['untouched60'] })]).map(x => x.key), ['untouched60']);   // empty group dropped
  assert.deepEqual(groupStale([]), []);
});

test('Everyone groups by owner: biggest first, No owner last', () => {
  const rows = [
    t({ id: '1', owner_employee_id: 'e2', owner_name: 'Zed' }),
    t({ id: '2', owner_employee_id: null }),
    t({ id: '3', owner_employee_id: 'e1', owner_name: 'Asha' }),
    t({ id: '4', owner_employee_id: 'e2', owner_name: 'Zed' }),
    t({ id: '5', owner_employee_id: 'e3', owner_name: 'Bo' }),
    t({ id: '6', owner_employee_id: null }),
    t({ id: '7', owner_employee_id: null }),
  ];
  assert.deepEqual(groupStale(rows, 'all').map(g => [g.label, g.rows.length]), [['Zed', 2], ['Asha', 1], ['Bo', 1], ['No owner', 3]]);
});

test('age label: days over off the effective deadline, else untouched age', () => {
  assert.equal(daysSince('2026-10-09T06:30:00.000Z', NOW), 31);
  assert.equal(daysSince('2026-12-01T00:00:00Z', NOW), 0);
  assert.equal(daysSince(null, NOW), null);
  const over = staleAge(t({ stale_reasons: ['overdue30', 'untouched60'], deadline: '2026-09-01T12:30:00+00:00', revised_deadline: '2026-10-01T12:30:00+00:00', updated_at: '2026-08-01T00:00:00Z' }), NOW);
  assert.deepEqual(over, { kind: 'over', days: 38, iso: '2026-10-01T12:30:00+00:00', text: '38d over' });   // revised wins
  const un = staleAge(t({ stale_reasons: ['untouched60'], updated_at: '2026-08-01T06:30:00Z' }), NOW);
  assert.equal(un.text, 'untouched 100d');
  assert.equal(un.kind, 'untouched');
});

test('never edited since creation (updated_at NULL): ages off created_at', () => {
  const r = t({ stale_reasons: ['untouched60'], updated_at: null, created_at: '2026-06-01T06:30:00Z', deadline: null });
  assert.deepEqual(staleAge(r, NOW), { kind: 'untouched', days: 161, iso: '2026-06-01T06:30:00Z', text: 'untouched 161d' });
  assert.equal(lastTouched(r), '2026-06-01T06:30:00Z');
  assert.equal(lastTouched({ updated_at: '2026-10-01T00:00:00Z', created_at: '2026-06-01T00:00:00Z' }), '2026-10-01T00:00:00Z');
});

test('revise guard: past refused; reason required only when a deadline exists', () => {
  const dated = { deadline: '2026-09-01T12:30:00Z' };
  assert.match(reviseError(dated, null, 'x', NOW), /Pick/);
  assert.match(reviseError(dated, '2026-11-01T12:30:00.000Z', 'slipped', NOW), /past/);
  assert.match(reviseError(dated, '2026-11-20T12:30:00.000Z', '  ', NOW), /reason/);
  assert.equal(reviseError(dated, '2026-11-20T12:30:00.000Z', 'vendor slipped', NOW), null);
  assert.equal(reviseError({ deadline: null }, '2026-11-20T12:30:00.000Z', '', NOW), null);     // first deadline: no reason field
  assert.match(reviseError({ deadline: null }, '2026-11-08T12:30:00.000Z', '', NOW), /past/);
});
