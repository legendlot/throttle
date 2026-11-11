import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as app from './weeks.js';
import { isOverdue as appIsOverdue } from './tasks.js';
// The worker's copy. Same repo, plain ESM.
import * as core from '../../../../docketops-worker/src/weeks-core.mjs';

const at = (s) => Date.parse(s);
const NOW = at('2026-11-12T10:00:00+05:30');   // Thu

test('parity: the app and the worker agree on every week fact, every dow, a month of dates', () => {
  const stamps = [];
  for (let d = 1; d <= 30; d++) {
    const day = `2026-11-${String(d).padStart(2, '0')}`;
    stamps.push(`${day}T00:00:00+05:30`, `${day}T23:59:00+05:30`, `${day}T05:00:00Z`);
  }
  let n = 0;
  for (const dow of [1, 2, 3, 4, 5, 6, 7]) {
    for (const s of stamps) {
      const t = { status: 'in_progress', deadline: s };
      const r = { status: 'blocked', deadline: '2026-10-01T10:00:00Z', revised_deadline: s };
      for (const x of [t, r, { status: 'done', deadline: s }, { status: 'not_started' }]) {
        assert.equal(app.taskWeekEnd(x, dow), core.taskWeekEnd(x, dow));
        assert.equal(app.weekBucket(x, dow, NOW), core.weekBucket(x, dow, NOW));
        for (const f of ['this', 'next', 'overdue', 'none', '2026-11-18']) {
          assert.equal(app.matchesWeek(x, app.resolveWeekFilter(f, dow, NOW), dow, NOW),
            core.matchesWeek(x, core.resolveWeekFilter(f, dow, NOW), dow, NOW)); n++;
        }
      }
      assert.equal(app.weekEndOf(app.istDate(s), dow), core.weekEndOf(core.istDate(s), dow));
    }
    assert.deepEqual(app.planWindow(NOW, dow), core.planWindow(NOW, dow));
  }
  const hol = { working_days: [1, 2, 3, 4, 5, 6], holidays: ['2026-11-11'] };
  for (const s of stamps) {
    assert.equal(app.workingDaysSince(s, NOW, hol), core.workingDaysSince(s, NOW, hol));
    assert.equal(app.staleCutoff(at(s), hol), core.staleCutoff(at(s), hol));
  }
  assert.deepEqual(app.normalizeWeekSettings([{ key: 'week_end_dow', value: 5 }]), core.normalizeWeekSettings([{ key: 'week_end_dow', value: 5 }]));
  assert.ok(n > 1000);
});

test('the app\'s overdue (lib/tasks.js isOverdue) is the week math\'s overdue', () => {
  const now = Date.now();
  for (const x of [{ status: 'in_progress', deadline: new Date(now - 60000).toISOString() },
    { status: 'in_progress', deadline: new Date(now + 3600000).toISOString() },
    { status: 'done', deadline: new Date(now - 60000).toISOString() },
    { status: 'blocked', deadline: new Date(now + 3600000).toISOString(), revised_deadline: new Date(now - 60000).toISOString() },
    { status: 'not_started' }]) {
    assert.equal(app.isOverdue(x, now), appIsOverdue(x), JSON.stringify(x));
  }
});

test('IST 23:59 vs 00:00 at the week boundary; Friday-ending weeks; revised deadline; no date', () => {
  assert.equal(app.taskWeekEnd({ deadline: '2026-11-15T23:59:00+05:30' }), '2026-11-15');
  assert.equal(app.taskWeekEnd({ deadline: '2026-11-16T00:00:00+05:30' }), '2026-11-22');
  assert.equal(app.taskWeekEnd({ deadline: '2026-11-13T23:59:00+05:30' }, 5), '2026-11-13');
  assert.equal(app.taskWeekEnd({ deadline: '2026-11-14T00:00:00+05:30' }, 5), '2026-11-20');
  assert.equal(app.taskWeekEnd({ deadline: '2026-11-13T10:00:00Z', revised_deadline: '2026-11-24T10:00:00Z' }), '2026-11-29');
  assert.equal(app.taskWeekEnd({}), null);
});

test('groupByWeek: Overdue first, weeks in date order, No date last; labels', () => {
  const rows = [
    { id: 'a', status: 'in_progress' },
    { id: 'b', status: 'in_progress', deadline: '2026-11-25T10:00:00+05:30' },
    { id: 'c', status: 'in_progress', deadline: '2026-11-10T10:00:00+05:30' },
    { id: 'd', status: 'done', deadline: '2026-11-10T10:00:00+05:30' },
    { id: 'e', status: 'in_progress', deadline: '2026-11-14T10:00:00+05:30' },
    { id: 'f', status: 'in_progress', deadline: '2027-01-02T10:00:00+05:30' },
  ];
  const g = app.groupByWeek(rows, 7, NOW);
  assert.deepEqual(g.map(x => x.label), ['Overdue', 'Week ending Sun 15 Nov', 'Week ending Sun 29 Nov', 'Week ending Sun 3 Jan 2027', 'No date']);
  assert.deepEqual(g.map(x => x.rows.map(r => r.id).join('')), ['c', 'de', 'b', 'f', 'a']);
  assert.equal(g[0].color, 'var(--overdue)');
  assert.deepEqual(app.groupByWeek(rows, 6, NOW).map(x => x.label).slice(0, 3), ['Overdue', 'Week ending Sat 14 Nov', 'Week ending Sat 28 Nov']);
});

test('Week filter labels', () => {
  assert.equal(app.weekFilterLabel('this', 7, NOW), 'This week');
  assert.equal(app.weekFilterLabel('2026-11-18', 7, NOW), 'Week ending Sun 22 Nov');
  assert.equal(app.weekFilterLabel('2026-11-18', 3, NOW), 'Week ending Wed 18 Nov');
  assert.equal(app.weekFilterLabel('', 7, NOW), '');
  assert.equal(app.weekFilterLabel('junk', 7, NOW), '');
});

test('stale working days: a holiday and Sunday off', () => {
  const s = { working_days: [1, 2, 3, 4, 5, 6], holidays: ['2026-11-10'] };
  // last update Sat 7 Nov; now Thu 12: Mon 9, (Tue 10 holiday), Wed 11 = 2
  assert.equal(app.workingDaysSince('2026-11-07T12:00:00+05:30', NOW, s), 2);
  assert.equal(app.isStale('2026-11-07T12:00:00+05:30', NOW, s), false);
  assert.equal(app.isStale('2026-11-06T12:00:00+05:30', NOW, s), true);   // + Sat 7
});
