// Run: node --test docketops-worker/test/
// F9 R4: the week math (§6), working days + staleness (§8.3) and the /plan/weeks model (§7.2) — including
// that a warning never leans on an item or task the viewer can't see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { istDate, isoDow, weekEndOf, weekBounds, weekBucket, taskWeekEnd, resolveWeekFilter, matchesWeek,
  normalizeWeekSettings, weekLabel, isWorkingDay, workingDaysSince, staleCutoff, isStale, planWindow,
  buildPlanWeeks, WEEK_DEFAULTS } from '../src/weeks-core.mjs';

const at = (s) => Date.parse(s);
// Thu 12 Nov 2026, 10:00 IST
const NOW = at('2026-11-12T10:00:00+05:30');
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('IST date boundaries: 23:59 IST is that day, 00:00 IST is the next', () => {
  assert.equal(istDate('2026-11-15T23:59:59+05:30'), '2026-11-15');
  assert.equal(istDate('2026-11-16T00:00:00+05:30'), '2026-11-16');
  assert.equal(istDate('2026-11-15T18:29:59Z'), '2026-11-15');   // = 23:59:59 IST
  assert.equal(istDate('2026-11-15T18:30:00Z'), '2026-11-16');   // = 00:00 IST
  assert.equal(istDate(null), null);
  assert.equal(isoDow('2026-11-15'), 7);
  assert.equal(isoDow('2026-11-16'), 1);
});

test('week = [S 00:00, E+1 00:00) IST; a Sunday deadline at 23:59 is that week, 00:00 Monday the next', () => {
  assert.equal(weekEndOf('2026-11-12', 7), '2026-11-15');
  assert.equal(weekEndOf('2026-11-15', 7), '2026-11-15');
  assert.equal(weekEndOf('2026-11-16', 7), '2026-11-22');
  const b = weekBounds('2026-11-15');
  assert.equal(b.start, at('2026-11-09T00:00:00+05:30'));
  assert.equal(b.end, at('2026-11-16T00:00:00+05:30'));
  assert.equal(taskWeekEnd({ deadline: '2026-11-15T18:29:00Z' }), '2026-11-15');
  assert.equal(taskWeekEnd({ deadline: '2026-11-15T18:30:00Z' }), '2026-11-22');
});

test('week_end_dow other than Sunday: a Friday-ending week', () => {
  assert.equal(weekEndOf('2026-11-12', 5), '2026-11-13');   // Thu → Fri 13
  assert.equal(weekEndOf('2026-11-13', 5), '2026-11-13');
  assert.equal(weekEndOf('2026-11-14', 5), '2026-11-20');   // Sat → next Fri
  assert.equal(taskWeekEnd({ deadline: '2026-11-13T23:59:00+05:30' }, 5), '2026-11-13');
  assert.equal(taskWeekEnd({ deadline: '2026-11-14T00:00:00+05:30' }, 5), '2026-11-20');
  assert.deepEqual(planWindow(NOW, 5).weeks, ['2026-11-13', '2026-11-20', '2026-11-27']);
});

test('the revised deadline wins; no date → "none"; open + past due → "overdue"', () => {
  const t = { status: 'in_progress', deadline: '2026-11-13T12:00:00+05:30', revised_deadline: '2026-11-20T12:00:00+05:30' };
  assert.equal(taskWeekEnd(t), '2026-11-22');
  assert.equal(weekBucket(t, 7, NOW), '2026-11-22');
  assert.equal(weekBucket({ status: 'not_started' }, 7, NOW), 'none');
  assert.equal(weekBucket({ status: 'not_started', deadline: '2026-11-12T09:59:00+05:30' }, 7, NOW), 'overdue');
  // done past due is NOT overdue — it stays in its week
  assert.equal(weekBucket({ status: 'done', deadline: '2026-11-10T09:00:00+05:30' }, 7, NOW), '2026-11-15');
});

test('Week filter: this / next / a date snaps to its week / overdue / none; junk → null', () => {
  assert.deepEqual(resolveWeekFilter('this', 7, NOW), { kind: 'week', end: '2026-11-15' });
  assert.deepEqual(resolveWeekFilter('next', 7, NOW), { kind: 'week', end: '2026-11-22' });
  assert.deepEqual(resolveWeekFilter('2026-11-18', 7, NOW), { kind: 'week', end: '2026-11-22' });
  assert.deepEqual(resolveWeekFilter('overdue', 7, NOW), { kind: 'overdue' });
  assert.equal(resolveWeekFilter('2026-02-30', 7, NOW), null);
  assert.equal(resolveWeekFilter("this'", 7, NOW), null);
  const thisWk = resolveWeekFilter('this', 7, NOW);
  // "This week" holds an overdue task due earlier this week
  assert.equal(matchesWeek({ status: 'blocked', deadline: '2026-11-10T10:00:00+05:30' }, thisWk, 7, NOW), true);
  assert.equal(matchesWeek({ status: 'blocked', deadline: '2026-11-16T00:00:00+05:30' }, thisWk, 7, NOW), false);
  assert.equal(matchesWeek({ status: 'blocked' }, { kind: 'none' }, 7, NOW), true);
  assert.equal(matchesWeek({ status: 'done', deadline: '2026-11-01T10:00:00Z' }, { kind: 'overdue' }, 7, NOW), false);
});

test('settings: defaults + malformed values fall back per key', () => {
  assert.deepEqual(normalizeWeekSettings([]), { week_end_dow: 7, working_days: [1, 2, 3, 4, 5, 6], holidays: [] });
  assert.deepEqual(normalizeWeekSettings([{ key: 'week_end_dow', value: 5 }, { key: 'working_days', value: [5, 1, 1, 9] },
    { key: 'holidays', value: ['2026-11-14', 'nope'] }]), { week_end_dow: 5, working_days: [1, 5], holidays: ['2026-11-14'] });
  assert.equal(normalizeWeekSettings({ week_end_dow: 0 }).week_end_dow, 7);
  assert.deepEqual(normalizeWeekSettings({ working_days: [] }).working_days, [1, 2, 3, 4, 5, 6]);
  assert.equal(weekLabel('2026-11-15', NOW), 'Week ending Sun 15 Nov');
  assert.equal(weekLabel('2027-01-03', NOW), 'Week ending Sun 3 Jan 2027');
});

test('working days: Sunday off, a holiday off; today never counts', () => {
  const s = { ...WEEK_DEFAULTS };
  assert.equal(isWorkingDay('2026-11-15', s), false);              // Sunday
  assert.equal(isWorkingDay('2026-11-14', s), true);               // Saturday
  const hol = { ...s, holidays: ['2026-11-11'] };
  assert.equal(isWorkingDay('2026-11-11', hol), false);
  // last update Mon 9 Nov; now Thu 12 → Tue 10, Wed 11 = 2 (not stale)
  assert.equal(workingDaysSince('2026-11-09T15:00:00+05:30', NOW, s), 2);
  assert.equal(isStale('2026-11-09T15:00:00+05:30', NOW, s), false);
  // last update Sat 7 → Mon 9, Tue 10, Wed 11 (Sun 8 off) = 3 → stale
  assert.equal(workingDaysSince('2026-11-07T15:00:00+05:30', NOW, s), 3);
  assert.equal(isStale('2026-11-07T15:00:00+05:30', NOW, s), true);
  // …but with Wed 11 a holiday it is only 2
  assert.equal(isStale('2026-11-07T15:00:00+05:30', NOW, hol), false);
  // Mon 16 Nov 10:00, last update Thu 12: Fri 13, Sat 14 (Sun off) = 2
  assert.equal(workingDaysSince('2026-11-12T23:00:00+05:30', at('2026-11-16T10:00:00+05:30'), s), 2);
  // an update at 23:59 IST vs 00:00 IST the next day
  assert.equal(workingDaysSince('2026-11-08T23:59:00+05:30', NOW, s), 3);
  assert.equal(workingDaysSince('2026-11-09T00:00:00+05:30', NOW, s), 2);
});

test('staleCutoff agrees with workingDaysSince ≥ 3 for every day of a month, with a holiday', () => {
  const s = { ...WEEK_DEFAULTS, holidays: ['2026-11-11', '2026-11-20'] };
  for (let dn = 1; dn <= 30; dn++) {
    const now = at(`2026-11-${String(dn).padStart(2, '0')}T11:00:00+05:30`);
    const cut = staleCutoff(now, s);
    for (let back = 0; back <= 14; back++) {
      const last = new Date(now - back * 86400000).toISOString();
      assert.equal(istDate(last) < cut, isStale(last, now, s), `now=${dn} back=${back}`);
    }
  }
  assert.equal(staleCutoff(NOW, WEEK_DEFAULTS), '2026-11-09');   // Wed 11, Tue 10, Mon 9
});

/* ---------------- the /plan/weeks model ---------------- */
const TH = U(1), M1 = U(2), R1 = U(3), M2 = U(4), MP = U(5), TH2 = U(6), MO = U(7);
const D1 = U(50), D2 = U(51), E1 = U(60), E2 = U(61);
const item = (o) => ({ state: 'agreed', level: 'F', owner_employee_id: E1, team_id: D1, ...o });
const ITEMS_F = [
  item({ id: TH, kind: 'theme', code: 'ZZ-T', title: 'ZZ theme', owner_employee_id: null }),
  item({ id: M1, kind: 'milestone', parent_id: TH, code: 'M01', title: 'ZZ m1', due_date: '2026-11-14' }),
  item({ id: R1, kind: 'result', parent_id: M1, code: 'M01.R1', title: 'ZZ r1', due_date: '2026-11-20' }),
  item({ id: M2, kind: 'milestone', parent_id: TH, code: 'M02', title: 'ZZ m2', due_date: '2026-11-25', owner_employee_id: E2, team_id: D2 }),
  item({ id: MP, kind: 'milestone', parent_id: TH, code: 'M03', title: 'ZZ proposed', due_date: '2026-11-21', state: 'proposed' }),
  item({ id: TH2, kind: 'theme', code: 'ZZ-T2', title: 'ZZ theme 2', owner_employee_id: null }),
  item({ id: MO, kind: 'milestone', parent_id: TH2, code: 'M09', title: 'ZZ outside', due_date: '2027-02-01' }),
];
const task = (o) => ({ status: 'in_progress', owner_employee_id: E1, department_id: D1, created_at: '2026-10-01T00:00:00Z', ...o });

test('cells: Overdue · this · next · after; items by effective due; tasks by effective deadline', () => {
  const tasks = [
    task({ id: U(100), title: 'a', deadline: '2026-11-10T10:00:00+05:30' }),                 // overdue
    task({ id: U(101), title: 'b', deadline: '2026-11-13T10:00:00+05:30' }),                 // this
    task({ id: U(102), title: 'c', deadline: '2026-11-13T10:00:00+05:30', revised_deadline: '2026-11-28T10:00:00+05:30' }), // after
    task({ id: U(103), title: 'd', deadline: '2026-12-30T10:00:00+05:30' }),                 // out
    task({ id: U(104), title: 'e', status: 'done', deadline: '2026-11-10T10:00:00+05:30' }), // done, this week
  ];
  const m = buildPlanWeeks({ items: ITEMS_F, tasks, now: NOW, isSuper: true, deptNames: { [D1]: 'ZZ team 1', [D2]: 'ZZ team 2' } });
  assert.deepEqual(m.columns.map(c => c.key), ['overdue', '2026-11-15', '2026-11-22', '2026-11-29']);
  const r1 = m.rows.find(r => r.key === D1);
  assert.equal(r1.label, 'ZZ team 1');
  assert.deepEqual(r1.cells.overdue.tasks.map(t => t.title), ['a']);
  assert.deepEqual(r1.cells['2026-11-15'].tasks.map(t => t.title).sort(), ['b', 'e']);
  assert.deepEqual(r1.cells['2026-11-29'].tasks.map(t => t.title), ['c']);
  assert.deepEqual(r1.cells['2026-11-15'].items.map(i => i.code), ['M01']);
  assert.deepEqual(r1.cells['2026-11-22'].items.map(i => i.code).sort(), ['M01.R1', 'M03']);
  assert.ok(!JSON.stringify(m).includes('ZZ outside'));
  // team scope
  const scoped = buildPlanWeeks({ items: ITEMS_F, tasks, now: NOW, isSuper: true, teamId: D2 });
  assert.deepEqual(scoped.rows.map(r => r.key), [D2]);
});

test('No actionable tasks: needs an open, owned, dated task on the item or its results', () => {
  const base = { items: ITEMS_F, now: NOW, isSuper: true };
  let m = buildPlanWeeks(base);
  assert.deepEqual(m.warnings.filter(w => w.kind === 'no_actionable').map(w => w.item.code).sort(), ['M01', 'M01.R1', 'M02']);
  assert.equal(m.warnings.find(w => w.item?.code === 'M01').resolver.employee_id, E1);
  // a task on the RESULT covers the milestone too (and the result)
  const onResult = [{ id: U(200), plan_item_id: R1, status: 'in_progress', owner_employee_id: E1, deadline: '2026-11-18T10:00:00Z', visible: true }];
  m = buildPlanWeeks({ ...base, linked: onResult });
  assert.deepEqual(m.warnings.filter(w => w.kind === 'no_actionable').map(w => w.item.code), ['M02']);
  // undated / unowned / done do not count
  for (const bad of [{ deadline: null }, { owner_employee_id: null }, { status: 'done' }]) {
    m = buildPlanWeeks({ ...base, linked: [{ ...onResult[0], ...bad }] });
    assert.ok(m.warnings.some(w => w.kind === 'no_actionable' && w.item.code === 'M01'), JSON.stringify(bad));
  }
});

test('access: level O counts only tasks the viewer can open; F counts every one; L / none never warn', () => {
  const asO = ITEMS_F.filter(i => i.id === TH || i.id === M1 || i.id === R1).map(i => ({ ...i, level: i.kind === 'theme' ? 'T' : 'O' }));
  const hidden = [{ id: U(300), plan_item_id: M1, status: 'in_progress', owner_employee_id: E2, deadline: '2026-11-13T10:00:00Z', visible: false }];
  const mo = buildPlanWeeks({ items: asO, linked: hidden, now: NOW });
  assert.ok(mo.warnings.some(w => w.kind === 'no_actionable' && w.item.code === 'M01'), 'O: an invisible task does not satisfy it');
  const mf = buildPlanWeeks({ items: ITEMS_F, linked: hidden, now: NOW, isSuper: true });
  assert.ok(!mf.warnings.some(w => w.kind === 'no_actionable' && w.item.code === 'M01'), 'F: every linked task counts');
  // items at T (a theme) or anything not in the projection are never cells nor warnings
  const asT = [{ ...ITEMS_F[0], level: 'T' }];
  const mt = buildPlanWeeks({ items: asT, now: NOW });
  assert.equal(mt.warnings.length, 0);
  assert.equal(mt.rows.length, 0);
  // a stray item at L (should never arrive) is ignored too
  const ml = buildPlanWeeks({ items: [{ ...ITEMS_F[1], level: 'L' }], now: NOW });
  assert.equal(ml.warnings.length, 0);
});

test('Not agreed yet: a proposed milestone due in the window; resolver = the founders', () => {
  const m = buildPlanWeeks({ items: ITEMS_F, now: NOW, isSuper: true });
  const w = m.warnings.filter(x => x.kind === 'not_agreed');
  assert.deepEqual(w.map(x => x.item.code), ['M03']);
  assert.equal(w[0].resolver.kind, 'founders');
  assert.equal(m.counts.not_agreed, 1);
});

test('Theme-only links: only when the theme has an agreed milestone the viewer sees; lists those', () => {
  const tt = [task({ id: U(400), title: 'on theme', plan_item_id: TH, deadline: '2027-01-10T10:00:00Z' }),
    task({ id: U(401), title: 'on theme 2', plan_item_id: TH2 })];
  const mf = buildPlanWeeks({ items: ITEMS_F, themeTasks: tt, now: NOW, isSuper: true });
  const w = mf.warnings.filter(x => x.kind === 'theme_only');
  assert.deepEqual(w.map(x => x.task.title).sort(), ['on theme', 'on theme 2']);
  assert.deepEqual(w.find(x => x.task.title === 'on theme').milestones.map(x => x.code), ['M01', 'M02']);
  assert.equal(w[0].resolver.kind, 'task_owner');
  // a viewer who sees the themes only at T (no milestones) gets no theme-only warning
  const asT = ITEMS_F.filter(i => i.kind === 'theme').map(i => ({ ...i, level: 'T' }));
  assert.equal(buildPlanWeeks({ items: asT, themeTasks: tt, now: NOW }).counts.theme_only, 0);
  // a viewer who owns M01 sees exactly M01 offered
  const asO = [{ ...ITEMS_F[0], level: 'T' }, { ...ITEMS_F[1], level: 'O' }];
  const wo = buildPlanWeeks({ items: asO, themeTasks: tt, now: NOW }).warnings.filter(x => x.kind === 'theme_only');
  assert.deepEqual(wo.map(x => [x.task.title, x.milestones.map(y => y.code)]), [['on theme', ['M01']]]);
});

test('Stale: open window tasks with no qualifying update since the cut-off; done / fresh / new are not', () => {
  const tasks = [
    task({ id: U(500), title: 'stale', deadline: '2026-11-13T10:00:00Z' }),
    task({ id: U(501), title: 'fresh', deadline: '2026-11-13T10:00:00Z' }),
    task({ id: U(502), title: 'done', status: 'done', deadline: '2026-11-13T10:00:00Z' }),
    task({ id: U(503), title: 'new', deadline: '2026-11-13T10:00:00Z', created_at: '2026-11-11T10:00:00+05:30' }),
  ];
  const m = buildPlanWeeks({ items: [], tasks, fresh: new Set([U(501)]), now: NOW });
  assert.deepEqual(m.warnings.filter(w => w.kind === 'stale').map(w => w.task.title), ['stale']);
  const card = m.rows[0].cells['2026-11-15'].tasks.find(t => t.title === 'stale');
  assert.deepEqual(card.warnings, ['stale']);
});

test('rows by person and by theme; empty plan + no tasks → no rows, zero counts', () => {
  const tasks = [task({ id: U(600), title: 'x', deadline: '2026-11-13T10:00:00Z', plan: { theme_id: TH, theme_title: 'ZZ theme' } }),
    task({ id: U(601), title: 'y', deadline: '2026-11-13T10:00:00Z', owner_employee_id: null, owner_name: null })];
  const byP = buildPlanWeeks({ items: ITEMS_F, tasks, now: NOW, isSuper: true, rowsBy: 'person' });
  assert.ok(byP.rows.some(r => r.label === 'Unassigned'));
  assert.equal(byP.rows.at(-1).label, 'Unassigned');   // the "none" row sorts last
  const byT = buildPlanWeeks({ items: ITEMS_F, tasks, now: NOW, isSuper: true, rowsBy: 'theme' });
  assert.deepEqual(byT.rows.map(r => r.label), ['ZZ theme', 'Unplanned']);
  const empty = buildPlanWeeks({ now: NOW });
  assert.deepEqual([empty.rows.length, empty.warnings.length], [0, 0]);
  assert.deepEqual(empty.counts, { no_actionable: 0, not_agreed: 0, theme_only: 0, stale: 0 });
});

/* ---------------- hostile review R4 ---------------- */
test('review #1: empty-key rows stay apart — "No theme" item vs "Unplanned" task; "Unknown owner" vs "Unassigned"', () => {
  // an O-level result whose milestone the viewer can't see → no theme for it
  const orphan = { ...ITEMS_F[2], level: 'O' };
  const tasks = [task({ id: U(700), title: 'loose', deadline: '2026-11-18T10:00:00Z' })];
  const byT = buildPlanWeeks({ items: [orphan], tasks, now: NOW, rowsBy: 'theme' });
  assert.deepEqual(byT.rows.map(r => r.label), ['No theme', 'Unplanned']);
  assert.deepEqual(byT.rows.find(r => r.label === 'Unplanned').cells['2026-11-22'].tasks.map(t => t.title), ['loose']);
  assert.deepEqual(byT.rows.find(r => r.label === 'No theme').cells['2026-11-22'].tasks, []);
  const noOwner = { ...ITEMS_F[1], owner_employee_id: null, owner_name: null };
  const byP = buildPlanWeeks({ items: [noOwner], tasks: [{ ...tasks[0], owner_employee_id: null }], now: NOW, isSuper: true, rowsBy: 'person' });
  assert.deepEqual(byP.rows.map(r => r.label).sort(), ['Unassigned', 'Unknown owner']);
  // "No team" is the same meaning for items and tasks → one row
  const byTeam = buildPlanWeeks({ items: [{ ...ITEMS_F[1], team_id: null }], tasks: [{ ...tasks[0], department_id: null }], now: NOW, isSuper: true });
  assert.deepEqual(byTeam.rows.map(r => r.label), ['No team']);
});

test('review #2: level F — hidden actionable tasks still satisfy the item, and say "+N" (hidden_actionable)', () => {
  const hidden = [{ id: U(800), plan_item_id: M1, status: 'in_progress', owner_employee_id: E1, deadline: '2026-11-13T10:00:00Z', visible: false },
    { id: U(801), plan_item_id: R1, status: 'in_progress', owner_employee_id: E1, deadline: '2026-11-13T10:00:00Z', visible: false },
    { id: U(802), plan_item_id: M1, status: 'in_progress', owner_employee_id: E1, deadline: '2026-11-13T10:00:00Z', visible: true }];
  const m = buildPlanWeeks({ items: ITEMS_F, linked: hidden, now: NOW, isSuper: true });
  const card = m.rows.find(r => r.key === D1).cells['2026-11-15'].items.find(i => i.code === 'M01');
  assert.equal(card.hidden_actionable, 2);
  assert.ok(!m.warnings.some(w => w.kind === 'no_actionable' && w.item.code === 'M01'));
  const r1 = m.rows.find(r => r.key === D1).cells['2026-11-22'].items.find(i => i.code === 'M01.R1');
  assert.equal(r1.hidden_actionable, 1);
  // below F: never a count, and the hidden ones don't count
  const asO = ITEMS_F.filter(i => [TH, M1].includes(i.id)).map(i => ({ ...i, level: i.kind === 'theme' ? 'T' : 'O' }));
  const mo = buildPlanWeeks({ items: asO, linked: hidden.slice(0, 2), now: NOW });
  const oc = mo.rows[0].cells['2026-11-15'].items[0];
  assert.equal(oc.hidden_actionable, undefined);
  assert.ok(!JSON.stringify(mo).includes('hidden_actionable'));
  assert.ok(mo.warnings.some(w => w.kind === 'no_actionable'));
});

test('review #3: theme-only task cards carry can_edit from the worker', () => {
  const tt = [task({ id: U(900), title: 'mine', plan_item_id: TH, _can_edit: true }), task({ id: U(901), title: 'theirs', plan_item_id: TH })];
  const w = buildPlanWeeks({ items: ITEMS_F, themeTasks: tt, now: NOW, isSuper: true }).warnings.filter(x => x.kind === 'theme_only');
  assert.deepEqual(w.map(x => [x.task.title, x.task.can_edit]).sort(), [['mine', true], ['theirs', false]]);
});
