// Run: node --test docketops-worker/test/*.test.mjs
// F9 R6a — review-core (pure): the score block, the last working day, by-person grouping, the team blocks
// and the Slack copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreBlock, lastWorkingDay, groupByPerson, noDataSource, buildReviewTeams, packToSlack, reprojectPack, packTaskIds, finalSnapshotPack,
  validateFocusItems, buildAsks, foundersToSlack }
  from '../src/review-core.mjs';

const S = { week_end_dow: 7, working_days: [1, 2, 3, 4, 5, 6], holidays: [] };
const R = (o) => ({ task_id: 't1', task_no: 'DKT-1', title: 'ZZ one', department_id: 'd1', owner_employee_id: 'e1',
  committed_deadline: '2026-11-11T12:30:00.000Z', effective_deadline: '2026-11-11T12:30:00.000Z', status: 'in_progress',
  outcome: 'due', miss_reason: null, ...o });

test('scoreBlock: provisional = on_time / (on_time + miss); final = on_time / cohort; null on 0', () => {
  const rows = [R({ outcome: 'on_time' }), R({ outcome: 'miss' }), R({ outcome: 'due' }), R({ outcome: 'on_time' })];
  assert.deepEqual(scoreBlock(rows, false), { cohort: 4, on_time: 2, miss: 1, due: 1, pct: 66.7 });
  assert.deepEqual(scoreBlock(rows, true), { cohort: 4, on_time: 2, miss: 1, due: 1, pct: 50 });
  assert.equal(scoreBlock([R({ outcome: 'due' })], false).pct, null);
  assert.equal(scoreBlock([], true).pct, null);
});

test('lastWorkingDay: skips Sundays (Mon–Sat default) and holidays', () => {
  assert.equal(lastWorkingDay('2026-11-12', S), '2026-11-11');            // Thu → Wed
  assert.equal(lastWorkingDay('2026-11-16', S), '2026-11-14');            // Mon → Sat (Sun off)
  assert.equal(lastWorkingDay('2026-11-16', { ...S, holidays: ['2026-11-14'] }), '2026-11-13');
  assert.equal(lastWorkingDay('2026-11-16', { ...S, working_days: [1, 2, 3, 4, 5] }), '2026-11-13');
});

test('groupByPerson: one group per owner, by name, no owner last, tasks by deadline', () => {
  const g = groupByPerson([
    { id: 'a', task_no: 'DKT-1', title: 'A', owner_employee_id: 'e2', deadline: '2026-11-20T00:00:00Z', status: 'not_started' },
    { id: 'b', task_no: 'DKT-2', title: 'B', owner_employee_id: null, deadline: '2026-11-19T00:00:00Z', status: 'not_started' },
    { id: 'c', task_no: 'DKT-3', title: 'C', owner_employee_id: 'e1', deadline: '2026-11-21T00:00:00Z', revised_deadline: '2026-11-18T00:00:00Z', status: 'done' },
    { id: 'd', task_no: 'DKT-4', title: 'D', owner_employee_id: 'e2', deadline: '2026-11-17T00:00:00Z', status: 'in_progress' },
  ], { e1: 'Asha', e2: 'Bala' });
  assert.deepEqual(g.map(x => x.owner_name), ['Asha', 'Bala', null]);
  assert.deepEqual(g[1].tasks.map(t => t.task_id), ['d', 'a']);
  assert.equal(g[0].tasks[0].effective_deadline, '2026-11-18T00:00:00Z');
  assert.deepEqual(Object.keys(g[0].tasks[0]).sort(), ['effective_deadline', 'status', 'task_id', 'task_no', 'title']);
});

test('noDataSource: the registry wins; no measure flags once agreed; manual always', () => {
  const M = [{ key: 'x.ok', source_ok: true }, { key: 'x.no', source_ok: false }];
  const I = (o) => ({ kind: 'milestone', state: 'agreed', ...o });
  assert.equal(noDataSource(I({ measure: null }), M), true);
  assert.equal(noDataSource(I({ state: 'proposed', measure: null }), M), false);
  assert.equal(noDataSource(I({ measure: { metric: 'x.ok', source_ok: false } }), M), false);
  assert.equal(noDataSource(I({ measure: { metric: 'x.no', source_ok: true } }), M), true);
  assert.equal(noDataSource(I({ measure: { system: 'manual', metric: 'manual' } }), M), true);
  assert.equal(noDataSource(I({ kind: 'theme', measure: null }), M), false);
});

const WEEK = { week_start: '2026-11-09', week_end: '2026-11-15', final: false };
function base(o = {}) {
  return {
    teamIds: ['d1'], deptNames: { d1: 'ZZ team' }, names: { e1: 'Asha', e2: 'Bala' }, lwd: '2026-11-11',
    week: { ...WEEK, rows: [] }, last: { week_end: '2026-11-08', final: true, rows: [] }, trend: [], shown: new Set(),
    metrics: [], ...o,
  };
}

test('buildReviewTeams: scores, slipped with revisions, trend from closed weeks only, unplanned', () => {
  const thisRows = [R({ task_id: 't1', outcome: 'miss', miss_reason: 'open' }), R({ task_id: 't2', outcome: 'on_time', status: 'done' }),
    R({ task_id: 't3', outcome: 'due', department_id: 'd2' })];
  const lastRows = [R({ task_id: 't4', outcome: 'miss', miss_reason: 'done_late', status: 'done', owner_employee_id: 'e2' }), R({ task_id: 't5', outcome: 'on_time' })];
  const [t] = buildReviewTeams(base({
    week: { ...WEEK, rows: thisRows }, last: { week_end: '2026-11-08', final: true, rows: lastRows },
    trend: [{ week_end: '2026-10-25', final: true, rows: [R({ outcome: 'on_time' }), R({ outcome: 'miss' })] },
            { week_end: '2026-11-01', final: false, rows: [R({ outcome: 'on_time' })] }],
    shown: new Set(['t1', 't2', 't4']),
    revisions: { t1: [{ created_at: '2026-11-10T05:00:00Z', old_value: 'a', new_value: 'b', note: 'zz why', source: 'connector' },
                      { created_at: '2026-11-11T05:00:00Z', old_value: 'b', new_value: 'c', note: null, source: 'app' }] },
    taskPlan: { t1: 'p1', t2: null },
  }));
  assert.deepEqual(t.this_week, { cohort: 2, on_time: 1, miss: 1, due: 0, pct: 50 });
  assert.deepEqual(t.last_week, { week_end: '2026-11-08', final: true, cohort: 2, on_time: 1, miss: 1, due: 0, pct: 50 });
  assert.deepEqual(t.trend, [{ week_end: '2026-10-25', pct: 50, cohort: 2 }]);
  assert.deepEqual(t.slipped.map(s => [s.task_id, s.week_end, s.times_moved]), [['t1', '2026-11-15', 2], ['t4', '2026-11-08', 0]]);
  assert.deepEqual(t.slipped[0].revisions[0], { at: '2026-11-10T05:00:00Z', old: 'a', new: 'b', reason: 'zz why', source: 'connector' });
  assert.equal(t.slipped[1].owner_name, 'Bala');
  assert.deepEqual(t.unplanned, { committed: 2, unplanned: 1, pct: 50 });
});

test('buildReviewTeams: a counted-but-not-shown miss is in the score, never in slipped', () => {
  const [t] = buildReviewTeams(base({ week: { ...WEEK, rows: [R({ task_id: 'hid', outcome: 'miss', title: 'ZZ secret' })] } }));
  assert.equal(t.this_week.miss, 1);
  assert.equal(t.slipped.length, 0);
  assert.doesNotMatch(JSON.stringify(t), /ZZ secret/);
});

test('buildReviewTeams: milestones due / redated / warnings (F counts hidden tasks, O does not)', () => {
  const items = [
    { id: 'm1', kind: 'milestone', code: 'M01', title: 'ZZ due', state: 'agreed', level: 'F', due_date: '2026-11-12', team_id: 'd1', owner_name: 'Asha', measure: { metric: 'x.ok' } },
    { id: 'm2', kind: 'milestone', code: 'M02', title: 'ZZ proposed', state: 'proposed', level: 'O', due_date: '2026-11-20', team_id: 'd1' },
    { id: 'm3', kind: 'milestone', code: 'M03', title: 'ZZ O hidden', state: 'agreed', level: 'O', due_date: '2026-11-25', team_id: 'd1', measure: { metric: 'x.ok' } },
    { id: 'm4', kind: 'milestone', code: 'M04', title: 'ZZ dropped', state: 'dropped', level: 'F', due_date: '2026-11-12', team_id: 'd1' },
    { id: 'm5', kind: 'milestone', code: 'M05', title: 'ZZ other team', state: 'agreed', level: 'F', due_date: '2026-11-12', team_id: 'd2' },
  ];
  const linked = [{ plan_item_id: 'm1', owner_employee_id: 'e1', deadline: '2026-11-12T00:00:00Z', status: 'in_progress', visible: false },
                  { plan_item_id: 'm3', owner_employee_id: 'e1', deadline: '2026-11-12T00:00:00Z', status: 'in_progress', visible: false }];
  const [t] = buildReviewTeams(base({ items, linked, metrics: [{ key: 'x.ok', source_ok: true }],
    itemHistory: [{ item_id: 'm1', event: 'redated', at: '2026-11-10T05:00:00Z', old: { due_date: '2026-11-10', revised_due_date: null }, new: { revised_due_date: '2026-11-12' }, note: 'zz slip' }] }));
  assert.deepEqual(t.milestones.due.map(m => m.id), ['m1']);
  assert.deepEqual(t.milestones.redated, [{ id: 'm1', kind: 'milestone', code: 'M01', title: 'ZZ due', at: '2026-11-10T05:00:00Z', old: '2026-11-10', new: '2026-11-12', reason: 'zz slip' }]);
  assert.deepEqual(t.milestones.warnings.map(w => [w.id, w.kind]), [['m2', 'not_agreed'], ['m3', 'no_tasks']]);
  assert.deepEqual(t.next_two_weeks.milestones.map(m => m.id), ['m2', 'm3']);
});

test('buildReviewTeams: staleness — touched, committed_open, by_source, quiet last working day', () => {
  const open = [{ id: 't1', department_id: 'd1', owner_employee_id: 'e1', status: 'in_progress' },
                { id: 't9', department_id: 'd1', owner_employee_id: 'e2', status: 'in_progress' }];
  const rows = [R({ task_id: 't1' }), R({ task_id: 't6', owner_employee_id: 'e1' })];
  const updates = [{ task_id: 't1', at: '2026-11-10T05:00:00Z', source: 'connector' }, { task_id: 't1', at: '2026-11-10T06:00:00Z', source: null },
                   { task_id: 't9', at: '2026-11-07T06:00:00Z', source: 'app' }];
  const [t] = buildReviewTeams(base({ week: { ...WEEK, rows }, shown: new Set(['t1', 't6']), openTasks: open, updates,
    ownLatest: { e1: '2026-11-10T06:00:00Z' }, lastSeen: { e2: '2026-11-11T03:00:00Z' } }));
  const asha = t.staleness.people.find(p => p.employee_id === 'e1');
  assert.deepEqual(asha, { employee_id: 'e1', name: 'Asha', last_seen: null, last_update: '2026-11-10T06:00:00Z', touched: 1,
    committed_open: 2, touched_pct: 50, by_source: { app: 0, connector: 1, slack: 0, system: 0 } });
  const bala = t.staleness.people.find(p => p.employee_id === 'e2');
  assert.equal(bala.by_source.app, 0);   // before week start
  assert.equal(bala.last_seen, '2026-11-11T03:00:00Z');
  assert.equal(t.staleness.quiet_last_working_day, true);   // nothing on 11 Nov
  const [t2] = buildReviewTeams(base({ openTasks: open, updates: [{ task_id: 't9', at: '2026-11-11T10:00:00Z', source: 'app' }] }));
  assert.equal(t2.staleness.quiet_last_working_day, false);
  const [t3] = buildReviewTeams(base({}));
  assert.equal(t3.staleness.quiet_last_working_day, false);   // no open tasks → nothing to be quiet about
});

test('packToSlack: bold team names, score line, slipped max 10 with owner + moved N×, milestones, quiet; no ids', () => {
  const slipped = Array.from({ length: 12 }, (_, i) => ({ task_id: `00000000-0000-4000-8000-0000000000${10 + i}`, task_no: `DKT-${i}`,
    title: `ZZ <slip> ${i}`, owner_name: 'Asha', times_moved: i === 0 ? 2 : 0 }));
  const pack = { week: { week_end: '2026-11-15', final: false }, proposals: { submitted_this_week: [{}], waiting: 3 }, teams: [{
    department_id: '00000000-0000-4000-8000-000000000099', team_name: 'ZZ & team',
    this_week: { cohort: 5, on_time: 3, miss: 1, due: 1, pct: 75 }, last_week: { final: true, cohort: 4, on_time: 2, miss: 2, due: 0, pct: 50 },
    slipped, milestones: { due: [{ id: '00000000-0000-4000-8000-000000000077', code: 'M01', title: 'ZZ ms', owner_name: 'Bala', state: 'agreed' }] },
    staleness: { quiet_last_working_day: true, last_working_day: '2026-11-11' } }] };
  const s = packToSlack(pack);
  const txt = s.teams[0].text;
  assert.equal(s.teams[0].department_id, '00000000-0000-4000-8000-000000000099');
  assert.match(txt, /^\*ZZ &amp; team\*/);
  assert.match(txt, /3 on time · 1 missed · 1 still due — 75%/);
  assert.match(txt, /2\/4 on time — 50%/);
  assert.match(txt, /DKT-0 ZZ &lt;slip&gt; 0 — Asha \(moved 2×\)/);
  assert.equal((txt.match(/^• DKT-/gm) || []).length, 10);
  assert.match(txt, /\+2 more/);
  assert.match(txt, /M01 ZZ ms — Bala — agreed/);
  assert.match(txt, /⚠ No update on any open task on Wed 11 Nov/);
  assert.doesNotMatch(txt + s.summary, /[0-9a-f]{8}-[0-9a-f]{4}-/);
  assert.match(s.summary, /\*ZZ &amp; team\*: 3 on time/);
  assert.match(s.summary, /3 waiting/);
});

test('reprojectPack: rows the reader cannot open are dropped, counted and gone from the Slack copy', () => {
  const T = (id, title) => ({ task_id: id, task_no: id, title, owner_name: 'A', times_moved: 0 });
  const pack = { week: { week_end: '2026-11-15', final: false }, hidden_tasks: 1, teams: [{ department_id: 'd1', team_name: 'ZZ',
    this_week: { cohort: 2, on_time: 0, miss: 2, due: 0, pct: 0 }, last_week: { final: true, cohort: 0, on_time: 0, miss: 0, due: 0, pct: null },
    slipped: [T('a', 'ZZ keep'), T('b', 'ZZ secret')], milestones: { due: [] },
    staleness: { quiet_last_working_day: false }, next_two_weeks: { tasks_by_person: [{ owner_employee_id: 'e', tasks: [{ task_id: 'b', title: 'ZZ secret' }] }], milestones: [] } }] };
  assert.deepEqual(packTaskIds(pack).sort(), ['a', 'b']);
  const out = reprojectPack(pack, new Set(['a']));
  assert.equal(out.hidden_tasks, 2);   // one task, listed twice, counted once
  assert.doesNotMatch(JSON.stringify(out), /ZZ secret/);
  assert.match(out.slack.teams[0].text, /ZZ keep/);
});

test('buildReviewTeams: a non-current week (lwd null) → quiet null; updates after the week end never count', () => {
  const open = [{ id: 't1', department_id: 'd1', owner_employee_id: 'e1', status: 'in_progress' }];
  const [t] = buildReviewTeams(base({ lwd: null, openTasks: open, shown: new Set(['t1']), week: { ...WEEK, rows: [R({ task_id: 't1' })] },
    updates: [{ task_id: 't1', at: '2026-11-16T05:00:00Z', source: 'app' }] }));   // Mon after the week
  assert.equal(t.staleness.quiet_last_working_day, null);
  assert.equal(t.staleness.last_working_day, null);
  assert.equal(t.staleness.people[0].touched, 0);
  assert.equal(t.staleness.people[0].by_source.app, 0);
});

test('buildReviewTeams: last_update_before when no own update in the lookback; seenOnly hides colleagues\' presence', () => {
  const open = [{ id: 't1', department_id: 'd1', owner_employee_id: 'e1', status: 'in_progress' },
                { id: 't2', department_id: 'd1', owner_employee_id: 'e2', status: 'in_progress' }];
  const x = { openTasks: open, lastSeen: { e1: 'S1', e2: 'S2' }, ownLatest: { e2: 'L2' }, lookbackStart: '2026-10-13T00:00:00.000Z' };
  const [lead] = buildReviewTeams(base({ ...x, seenOnly: 'e2' }));
  const p1 = lead.staleness.people.find(p => p.employee_id === 'e1'), p2 = lead.staleness.people.find(p => p.employee_id === 'e2');
  assert.equal('last_seen' in p1, false);
  assert.equal(p2.last_seen, 'S2');
  assert.equal(p1.last_update_before, '2026-10-13T00:00:00.000Z');
  assert.equal('last_update_before' in p2, false);
  const [admin] = buildReviewTeams(base({ ...x, seenOnly: null }));
  assert.deepEqual(admin.staleness.people.map(p => p.last_seen), ['S1', 'S2']);
});

test('finalSnapshotPack: raw week_score → pack shape per frozen team, slipped only for keep, Slack renders', () => {
  const p = { week_end: '2026-11-08', week_start: '2026-11-02', final: true, as_of: 'A', tasks: [
    R({ task_id: 'a', outcome: 'miss', title: 'ZZ keep' }), R({ task_id: 'b', outcome: 'miss', title: 'ZZ secret' }),
    R({ task_id: 'c', outcome: 'on_time' }), R({ task_id: 'd', outcome: 'on_time', department_id: null })] };
  const out = finalSnapshotPack(p, { keep: new Set(['a', 'c', 'd']), deptNames: { d1: 'ZZ team' }, names: { e1: 'Asha' },
    revisions: { a: [{ created_at: 'X', old_value: 'o', new_value: 'n', note: 'why', source: 'app' }] } });
  assert.deepEqual(out.teams.map(t => t.team_name), ['ZZ team', 'No team']);
  assert.deepEqual(out.teams[0].this_week, { cohort: 3, on_time: 1, miss: 2, due: 0, pct: 33.3 });
  assert.deepEqual(out.teams[0].slipped.map(s => [s.task_id, s.times_moved, s.owner_name]), [['a', 1, 'Asha']]);
  assert.equal(out.hidden_tasks, 1);
  assert.equal(out.revisions_loaded, true);
  assert.equal(out.teams[0].last_week, null);
  assert.doesNotMatch(JSON.stringify(out), /ZZ secret/);
  assert.match(out.slack.teams[0].text, /^\*ZZ team\*[\s\S]*ZZ keep/);
  assert.equal(finalSnapshotPack(p, { keep: new Set(), teamId: 'd1' }).teams.length, 1);
  assert.equal(finalSnapshotPack(p, { keep: new Set(['a']) }).revisions_loaded, false);
});

test('packToSlack never names an omitted (Founders\' space) task or a restricted milestone', () => {
  const pack = { week: { week_end: '2026-11-22', final: false }, teams: [{ department_id: 'd1', team_name: 'Ops',
    this_week: { cohort: 2, on_time: 0, miss: 2, due: 0, pct: 0 },
    slipped: [{ task_id: 'a', task_no: 'DKT-1', title: 'Hire CFO', owner_name: 'X' }, { task_id: 'b', task_no: 'DKT-2', title: 'Fix belt', owner_name: 'Y' }],
    milestones: { due: [{ id: 'm1', code: 'M01', title: 'Secret deal', state: 'agreed' }, { id: 'm2', code: 'M02', title: 'Open plant', state: 'agreed' }] } }],
    slack_omit: { tasks: ['a'], items: ['m1'] } };
  const s = packToSlack(pack);
  const all = s.summary + s.teams.map(t => t.text).join('');
  assert.ok(!/Hire CFO|DKT-1|Secret deal|M01/.test(all), all);
  assert.ok(/Fix belt/.test(all) && /Open plant/.test(all));
  assert.match(s.summary, /1 slipped/);
});

const UID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
test('validateFocusItems: ≤5, ranks 1–5 unique, one id at most, an id or a note, note ≤500 trimmed; sorted by rank', () => {
  assert.deepEqual(validateFocusItems([{ rank: 2, task_id: UID(1) }, { rank: 1, plan_item_id: UID(2), note: ' why ' }]), { items: [
    { rank: 1, plan_item_id: UID(2), task_id: null, note: 'why' }, { rank: 2, plan_item_id: null, task_id: UID(1), note: null }] });
  assert.deepEqual(validateFocusItems([]), { items: [] });
  assert.deepEqual(validateFocusItems([{ rank: 1, plan_item_id: '', note: 'x' }]).items[0].plan_item_id, null);
  const E = (x) => validateFocusItems(x).error;
  assert.equal(E(null), 'bad_item');
  assert.equal(E([1, 2, 3, 4, 5, 6].map(rank => ({ rank, note: 'x' }))), 'too_many');
  assert.equal(E([{ rank: 1, note: 'a' }, { rank: 1, note: 'b' }]), 'bad_rank');
  for (const rank of [0, 6, 1.5, '1', null]) assert.equal(E([{ rank, note: 'a' }]), 'bad_rank', String(rank));
  assert.equal(E([{ rank: 1, plan_item_id: UID(1), task_id: UID(2) }]), 'bad_item');
  assert.equal(E([{ rank: 1 }]), 'bad_item');
  assert.equal(E([{ rank: 1, note: '  ' }]), 'bad_item');
  assert.equal(E([{ rank: 1, task_id: 'M01' }]), 'bad_item');
  assert.equal(E([{ rank: 1, note: 5 }]), 'bad_item');
  assert.equal(E(['x']), 'bad_item');
  assert.equal(E([{ rank: 1, note: 'z'.repeat(501) }]), 'note_too_long');
  assert.equal(E([{ rank: 1, note: ' ' + 'z'.repeat(500) + ' ' }]), undefined);   // trimmed first
});

test('buildAsks: window [start, end), open top-level waiting task, cross-team (null ≠ set; both null = same), blocker not done', () => {
  const start = Date.parse('2026-11-09T00:00:00+05:30'), end = Date.parse('2026-11-23T00:00:00+05:30');
  const W = (id, o) => ({ id, task_no: id, title: id, status: 'in_progress', department_id: 'd1', owner_employee_id: 'e1', deadline: '2026-11-12T06:30:00Z', ...o });
  const pairs = [
    ['ok', {}, { department_id: 'd2' }],
    ['late', { deadline: '2026-11-23T00:00:00+05:30' }, { department_id: 'd2' }],   // exactly at end → out
    ['early', { deadline: '2026-11-08T18:29:00Z' }, { department_id: 'd2' }],
    ['same', {}, {}],
    ['nulls', { department_id: null }, { department_id: null }],
    ['nullset', { department_id: null }, { department_id: 'd2' }],
    ['done', {}, { department_id: 'd2', status: 'done' }],
    ['aband', {}, { department_id: 'd2', status: 'abandoned' }],
    ['closed', { status: 'done' }, { department_id: 'd2' }],
    ['sub', { parent_task_id: 'p' }, { department_id: 'd2' }],
    ['arch', { archived_at: 'x' }, { department_id: 'd2' }],
    ['hid', {}, { department_id: 'd2' }],
  ];
  const blocked = pairs.map(([k, o]) => W(k, o)), blockers = pairs.map(([k, , o]) => W('b-' + k, o));
  const links = pairs.map(([k]) => ({ id: 'l-' + k, from_task_id: 'b-' + k, to_task_id: k }));
  const keep = new Set([...blocked, ...blockers].map(t => t.id).filter(id => id !== 'b-hid'));
  const r = buildAsks({ links, blocked, blockers, keep, names: { e1: 'Asha' }, deptNames: { d1: 'One', d2: 'Two' }, start, end });
  assert.deepEqual(r.asks.map(a => a.link_id).sort(), ['l-aband', 'l-nullset', 'l-ok']);
  assert.equal(r.hidden_asks, 1);
  const ok = r.asks.find(a => a.link_id === 'l-ok');
  assert.deepEqual([ok.blocked.team_name, ok.blocker.team_name, ok.blocker.owner_name], ['One', 'Two', 'Asha']);
});

test('foundersToSlack: asks + hidden count + each founder\'s top 5; a null ref shows its note or "something you can\'t see"; no ids', () => {
  const card = (no, title, team) => ({ task_id: UID(9), task_no: no, title, team_name: team, owner_name: 'Asha', effective_deadline: '2026-11-13T06:30:00Z', status: 'in_progress' });
  const txt = foundersToSlack({ week: { week_end: '2026-11-15' }, hidden_asks: 2,
    asks: [{ link_id: UID(1), blocked: card('DKT-1', 'ZZ <a>', 'One'), blocker: { ...card('DKT-2', 'ZZ b', null), status: 'abandoned' } }],
    focus: [{ founder_name: 'Afshaan', items: [{ rank: 1, ref: { kind: 'item', code: 'M01', title: 'ZZ ms' }, note: null },
                                              { rank: 2, ref: { kind: 'task', task_no: 'DKT-3', title: 'ZZ t' }, note: 'push' },
                                              { rank: 3, ref: null, note: 'hidden but noted' }, { rank: 4, ref: null, note: null }] },
            { founder_name: 'Vinay', items: [] }] });
  assert.match(txt, /^\*Founders' catch-up — week ending Sun 15 Nov\*/);
  assert.match(txt, /• DKT-1 ZZ &lt;a&gt; \(One, Asha\) waits on DKT-2 ZZ b \(No team, Asha\) — due Fri 13 Nov — ⚠ the blocker was abandoned/);
  assert.match(txt, /\+2 more in spaces you can't open/);
  assert.match(txt, /1\. M01 ZZ ms\n2\. DKT-3 ZZ t — “push”\n3\. “hidden but noted”\n4\. something you can’t see/);
  assert.match(txt, /\*Vinay's top 5\*\nNot set yet\./);
  assert.doesNotMatch(txt, /[0-9a-f]{8}-[0-9a-f]{4}-/);
  assert.match(foundersToSlack({ week: { week_end: '2026-11-15' }, asks: [], focus: [] }), /No cross-team asks due this week or next\./);
});
