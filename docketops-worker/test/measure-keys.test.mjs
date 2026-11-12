// Run: node --test docketops-worker/test/*.test.mjs
// F9 R9b — the registry ↔ SQL sync: migration 0029's docket.measure_check reads exactly MEASURE_CHECK_UNITS (its
// v_units constant: key → the unit its target parser checks against), docket.plan_metric_reading has one fixed
// branch for EVERY registry key (manual included), and test/measure-check.sql embeds 0029 verbatim; plus
// rhythm-core (the trend's weeks, the re-plan month and readiness).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PLAN_METRICS, MEASURE_CHECK_KEYS, MEASURE_CHECK_UNITS, publicMetrics } from '../src/plan-metrics.mjs';
import { trendWeeksParam, trendWeekEnds, trendModel, replanMonth, weekEndsIn, readiness } from '../src/rhythm-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SQL = readFileSync(join(ROOT, 'migrations', '0029_measure_check.sql'), 'utf8');

test('measure_check v_units = MEASURE_CHECK_UNITS (source_ok, auto_check, not manual; the registry unit); a branch per registry key', () => {
  const m = /v_units jsonb := '([^']*)';/.exec(SQL);
  assert.ok(m, 'v_units constant not found');
  const sqlUnits = JSON.parse(m[1]);
  assert.deepEqual(sqlUnits, MEASURE_CHECK_UNITS);
  assert.deepEqual(Object.keys(sqlUnits).sort(), [...MEASURE_CHECK_KEYS].sort());
  for (const k of MEASURE_CHECK_KEYS) assert.equal(sqlUnits[k], PLAN_METRICS.find(x => x.key === k).unit, k);
  assert.deepEqual(MEASURE_CHECK_KEYS, PLAN_METRICS.filter(x => x.source_ok && x.auto_check !== false && x.key !== 'manual').map(x => x.key));
  assert.ok(!MEASURE_CHECK_KEYS.includes('odo.net_revenue') && !MEASURE_CHECK_KEYS.includes('manual') && !MEASURE_CHECK_KEYS.includes('redline.downtime_minutes'));
  const body = SQL.slice(SQL.indexOf('function docket.plan_metric_reading'), SQL.indexOf('function docket.plan_target_parse'));
  const branches = [...body.matchAll(/when '([^']+)' then/g)].map(x => x[1]);
  assert.deepEqual([...branches].sort(), PLAN_METRICS.map(x => x.key).filter(k => k !== 'manual').sort());   // manual → the else (null)
  assert.doesNotMatch(body, /execute|format\(/i);                                                          // never dynamic SQL
  assert.equal(publicMetrics().find(x => x.key === 'odo.net_revenue').auto_check, false);
  assert.equal(publicMetrics().find(x => x.key === 'odo.ad_spend').auto_check, true);
  assert.ok(!('source' in publicMetrics()[0]));
});

test('rhythm-core: weeks param, the closed-week ends, the re-plan month (default next, Dec → Jan), week ends in a month', () => {
  assert.equal(trendWeeksParam(null), 8); assert.equal(trendWeeksParam('26'), 26); assert.equal(trendWeeksParam('1'), 1);
  for (const bad of ['0', '27', '1.5', 'x', '-3', '100']) assert.equal(trendWeeksParam(bad), null, bad);
  assert.deepEqual(trendWeekEnds('2026-11-12', 7, 3), ['2026-10-25', '2026-11-01', '2026-11-08']);   // Thu → the week ending Sun 15th is current
  assert.deepEqual(trendWeekEnds('2026-11-15', 7, 1), ['2026-11-08']);
  assert.deepEqual(replanMonth(null, '2026-11-12'), { month: '2026-12', first: '2026-12-01', last: '2026-12-31', prev: '2026-11', prevFirst: '2026-11-01', prevLast: '2026-11-30' });
  assert.deepEqual(replanMonth('', '2026-12-31').month, '2027-01');
  assert.deepEqual(replanMonth('2027-01', '2026-11-12'), { month: '2027-01', first: '2027-01-01', last: '2027-01-31', prev: '2026-12', prevFirst: '2026-12-01', prevLast: '2026-12-31' });
  assert.equal(replanMonth('2028-02', 'x').last, '2028-02-29');
  for (const bad of ['2026-13', '2026-1', '26-12', '2026-12-01']) assert.equal(replanMonth(bad, '2026-11-12'), null, bad);
  assert.deepEqual(weekEndsIn('2026-11-01', '2026-11-30', 7), ['2026-11-01', '2026-11-08', '2026-11-15', '2026-11-22', '2026-11-29']);
  assert.deepEqual(weekEndsIn('2026-11-01', '2026-11-30', 5), ['2026-11-06', '2026-11-13', '2026-11-20', '2026-11-27']);
});

test('rhythm-core: trendModel — whole (F) uses week_score team rows; below F groups the countable rows; no cohort → pct null', () => {
  const scores = { b: { teams: [{ department_id: 'd1', cohort: 2, on_time: 1, pct: 50 }], totals: { cohort: 2, on_time: 1, pct: 50 },
    tasks: [{ task_id: 1, department_id: 'd1', outcome: 'on_time' }, { task_id: 2, department_id: 'd1', outcome: 'miss' }, { task_id: 3, department_id: null, outcome: 'on_time' }] } };
  const F = trendModel({ weekEnds: ['a', 'b'], scores, whole: true, deptNames: { d1: 'D1' } });
  assert.deepEqual(F, { weeks: ['a', 'b'], teams: [{ id: 'd1', name: 'D1', points: [{ week_end: 'a', on_time: 0, cohort: 0, pct: null }, { week_end: 'b', on_time: 1, cohort: 2, pct: 50 }] }],
    overall: [{ week_end: 'a', on_time: 0, cohort: 0, pct: null }, { week_end: 'b', on_time: 1, cohort: 2, pct: 50 }] });
  const below = trendModel({ weekEnds: ['b'], scores, rowsOf: s => s.tasks.filter(t => t.task_id !== 2), deptNames: { d1: 'D1' } });
  assert.deepEqual(below.teams.map(t => [t.name, t.points[0].pct]), [['D1', 100], ['No team', 100]]);
  assert.deepEqual(below.overall[0], { week_end: 'b', on_time: 2, cohort: 2, pct: 100 });
  assert.deepEqual(trendModel({ weekEnds: ['b'], scores, rowsOf: s => s.tasks, teamId: 'd1' }).overall[0], { week_end: 'b', on_time: 1, cohort: 2, pct: 50 });
});

test('rhythm-core: readiness — each column and `ready` only when all four hold', () => {
  const ms = { id: 'm', state: 'agreed', owner_employee_id: 'e', measure: { metric: 'garage.grn_lines' } };
  const t = (o) => ({ plan_item_id: 'r', parent_task_id: null, status: 'in_progress', ...o });
  const ctx = { activeOwners: new Set(['e']), tasks: [t(), t({ status: 'done' }), t({ parent_task_id: 'x' }), t({ plan_item_id: 'other' })], resultIds: ['r'] };
  assert.deepEqual(readiness(ms, ctx), { agreed: true, owner: true, data_source: true, actionable: 1, ready: true });
  assert.equal(readiness({ ...ms, state: 'proposed' }, ctx).ready, false);
  assert.equal(readiness(ms, { ...ctx, activeOwners: new Set() }).owner, false);
  for (const measure of [null, { metric: 'manual' }, { metric: 'podium.one_on_ones' }, { metric: 'zz' }]) assert.equal(readiness({ ...ms, measure }, ctx).data_source, false, JSON.stringify(measure));
  assert.equal(readiness({ ...ms, measure: { metric: 'odo.net_revenue' } }, ctx).data_source, true);   // a source exists, only not auto-checked
  assert.deepEqual(readiness(ms, { ...ctx, resultIds: [] }), { agreed: true, owner: true, data_source: true, actionable: 0, ready: false });
});

test('test/measure-check.sql embeds migrations/0029_measure_check.sql byte for byte', () => {
  const t = readFileSync(join(ROOT, 'test', 'measure-check.sql'), 'utf8');
  const open = '    execute $mig$\n';
  const i = t.indexOf(open);
  assert.ok(i > 0, 'no embedded migration');
  const j = t.indexOf('$mig$;', i + open.length);
  assert.ok(j > i, 'embedded migration not closed');
  assert.equal(t.slice(i + open.length, j), SQL);
  assert.ok(!SQL.includes('$mig$') && !SQL.includes('$mcheck$'), 'the migration must not use the test\'s dollar tags');
});
