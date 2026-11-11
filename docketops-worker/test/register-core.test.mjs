// Run: node --test docketops-worker/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRegister, isDueOn, lateFlag, istDateStr } from '../src/register-core.mjs';

const DAYS = ['2026-11-09', '2026-11-10', '2026-11-11'];   // Mon, Tue, Wed
const TODAY = '2026-11-11';
const daily = { freq: 'daily', time: '09:00' };
const row = (o) => ({ id: 'r1', kind: 'task', title: 'A', section: null, due_time: '09:00', rec: daily, start: '2026-01-01', spans: null, ...o });

test('istDateStr: 18:30Z is IST midnight', () => {
  assert.equal(istDateStr(new Date('2026-11-10T18:15:00Z')), '2026-11-10');
  assert.equal(istDateStr(new Date('2026-11-10T18:45:00Z')), '2026-11-11');
});

test('back-fill: a tick at 18:45Z for day D is a later IST day; 18:15Z is not', () => {
  const r = buildRegister({ rows: [row({ due_time: null })], days: DAYS, today: TODAY, ticks: [
    { row: 'r1', date: '2026-11-10', at: '2026-11-10T18:15:00Z', by: 'u' },
    { row: 'r1', date: '2026-11-09', at: '2026-11-09T18:45:00Z', by: 'u' },
  ] });
  assert.equal(r.cells['r1|2026-11-10'].backfilled, false);
  assert.equal(r.cells['r1|2026-11-09'].backfilled, true);
});

test('late only when same-day and after due_time (IST)', () => {
  assert.equal(lateFlag('2026-11-10T04:00:00Z', '09:00'), true);    // 09:30 IST
  assert.equal(lateFlag('2026-11-10T03:00:00Z', '09:00'), false);   // 08:30 IST
  const r = buildRegister({ rows: [row()], days: DAYS, today: TODAY, ticks: [
    { row: 'r1', date: '2026-11-09', at: '2026-11-10T04:00:00Z', by: 'u' },   // back-filled AND past time
  ] });
  assert.equal(r.cells['r1|2026-11-09'].late, false);   // back-fill wins over late
});

test('adherence: today counts only once ticked', () => {
  const r = buildRegister({ rows: [row()], days: DAYS, today: TODAY, ticks: [
    { row: 'r1', date: '2026-11-09', at: '2026-11-09T03:00:00Z', by: 'u' },
  ] });
  assert.deepEqual(r.adherence.overall, { done: 1, due: 2 });   // 9th done, 10th missed, 11th not over
  const r2 = buildRegister({ rows: [row()], days: DAYS, today: TODAY, ticks: [
    { row: 'r1', date: '2026-11-11', at: '2026-11-11T03:00:00Z', by: 'u' },
  ] });
  assert.deepEqual(r2.adherence.overall, { done: 1, due: 3 });
});

test('start date: nothing due before the row existed', () => {
  const r = buildRegister({ rows: [row({ start: '2026-11-10' })], days: DAYS, today: TODAY, ticks: [] });
  assert.deepEqual(r.rows[0].due, ['2026-11-10', '2026-11-11']);
  assert.deepEqual(r.adherence.overall, { done: 0, due: 1 });
});

test('spans: an unassigned gap is not due; until is exclusive', () => {
  const r = buildRegister({ rows: [row({ spans: [['2026-11-01', '2026-11-10'], ['2026-11-11', '9999-12-31']] })], days: DAYS, today: TODAY, ticks: [] });
  assert.deepEqual(r.rows[0].due, ['2026-11-09', '2026-11-11']);
});

test('weekly: columns are only the due dates', () => {
  const r = buildRegister({ rows: [row({ rec: { freq: 'weekly', days_of_week: [1] } })], days: DAYS, today: TODAY, ticks: [] });
  assert.deepEqual(r.cols, ['2026-11-09']);
});

test('a recorded tick on a day the CURRENT schedule skips is kept (schedule changed since)', () => {
  const r = buildRegister({ rows: [row({ rec: { freq: 'weekly', days_of_week: [1, 3, 5] } })], days: DAYS, today: TODAY, ticks: [
    { row: 'r1', date: '2026-11-10', at: '2026-11-10T03:00:00Z', by: 'u' },   // a Tuesday tick
  ] });
  assert.ok(r.cols.includes('2026-11-10'));
  assert.ok(r.cells['r1|2026-11-10']);
  assert.deepEqual(r.adherence.overall, { done: 1, due: 2 });   // Mon missed + Tue done; Wed is today
});

test('first tick wins; ticks outside the window or for unknown rows are ignored', () => {
  const r = buildRegister({ rows: [row()], days: DAYS, today: TODAY, names: { a: 'Asha', b: 'Bala' }, userId: 'b', ticks: [
    { row: 'r1', date: '2026-11-09', at: '2026-11-09T05:00:00Z', by: 'b' },
    { row: 'r1', date: '2026-11-09', at: '2026-11-09T04:00:00Z', by: 'a', note: 'Ravi' },
    { row: 'r1', date: '2026-11-01', at: '2026-11-01T04:00:00Z', by: 'a' },
    { row: 'zz', date: '2026-11-09', at: '2026-11-09T04:00:00Z', by: 'a' },
  ] });
  const c = r.cells['r1|2026-11-09'];
  assert.equal(c.by, 'Asha'); assert.equal(c.note, 'Ravi'); assert.equal(c.mine, false);
  assert.equal(Object.keys(r.cells).length, 1);
});

test('until: expired days are not due', () => {
  const r = buildRegister({ rows: [row({ rec: { ...daily, until: '2026-11-09' } })], days: DAYS, today: TODAY, ticks: [] });
  assert.deepEqual(r.rows[0].due, ['2026-11-09']);
});

test('monthly clamps to the last day of short months', () => {
  assert.equal(isDueOn({ freq: 'monthly', day_of_month: 31 }, '2026-02-28'), true);
  assert.equal(isDueOn({ freq: 'monthly', day_of_month: 31 }, '2026-02-27'), false);
});
