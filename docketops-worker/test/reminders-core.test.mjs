// Run: node --test docketops-worker/test/*.test.mjs
// F9 R7b — the pure reminder cores (src/reminders-core.mjs): settings parsing, dueSlots (IST conversion, the :00 and
// :30 fires, working days + holidays, dow, malformed slots disable themselves, no DST), mode gating, the chase
// window, and every message: ≤ 50 blocks, honest "showing N" counts, empty → null.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SLOT_KEYS, parseReminderSettings, slotSpec, dueSlots, gateRecipients, workingDayAfter, ownerDailySections, ownerDailyMessage,
  chaseTasks, chaseMessage, founderChaseLine, reviewTomorrowMessage, reviewPackMessage, catchupMessage, textSections, safeCode, identityTtlMs, lookupOutcome } from '../src/reminders-core.mjs';
import { slackApi } from '../src/slack-core.mjs';
import { isWorkingDay, WEEK_DEFAULTS } from '../src/weeks-core.mjs';

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DEFAULT = { mode: 'test', test_employee_ids: [U(1)], slots: {
  owner_daily: { time: '09:00', days: 'working' }, chase: { time: '09:30', days: 'working' },
  review_tomorrow: { time: '17:00', dow: 4 }, review_pack: { time: '18:00', dow: 4 }, catchup_prep: { time: '18:00', dow: 5 } } };
const wd = (s = WEEK_DEFAULTS) => (d) => isWorkingDay(d, s);
// IST wall clock → the UTC instant (IST = UTC+05:30, all year)
const ist = (d, hm) => Date.parse(`${d}T${hm}:00+05:30`);
const due = (d, hm, s = DEFAULT, w = wd()) => dueSlots(ist(d, hm), s, w).map(x => x.slot);

test('dueSlots: the 09:00 fire (UTC 03:30) is owner_daily; the 09:30 fire (UTC 04:00) is the chase', () => {
  assert.equal(new Date(ist('2026-11-16', '09:00')).toISOString(), '2026-11-16T03:30:00.000Z');
  assert.deepEqual(due('2026-11-16', '09:00'), ['owner_daily']);   // Mon
  assert.deepEqual(due('2026-11-16', '09:30'), ['chase']);
  assert.deepEqual(due('2026-11-16', '10:00'), []);
  assert.deepEqual(dueSlots(ist('2026-11-16', '09:00'), DEFAULT, wd()), [{ slot: 'owner_daily', run_date: '2026-11-16' }]);
});
test('dueSlots: a late start inside the half-hour still counts; the next half-hour does not', () => {
  assert.deepEqual(due('2026-11-16', '09:14'), ['owner_daily']);
  assert.deepEqual(due('2026-11-16', '09:29'), ['owner_daily']);
  assert.deepEqual(due('2026-11-16', '08:59'), []);
});
test('dueSlots: Thursday 17:00 / 18:00, Friday 18:00 — dow is ISO (Mon = 1)', () => {
  assert.deepEqual(due('2026-11-19', '17:00'), ['review_tomorrow']);   // Thu
  assert.deepEqual(due('2026-11-19', '18:00'), ['review_pack']);
  assert.deepEqual(due('2026-11-20', '18:00'), ['catchup_prep']);      // Fri
  assert.deepEqual(due('2026-11-18', '18:00'), []);                    // Wed
  assert.deepEqual(due('2026-11-19', '09:00'), ['owner_daily']);
});
test('dueSlots: the IST date, not the UTC date, decides the day (UTC is still Wednesday at 01:00 IST Thu)', () => {
  const s = { slots: { review_tomorrow: { time: '01:00', dow: 4 } } };
  assert.equal(new Date(ist('2026-11-19', '01:00')).toISOString().slice(0, 10), '2026-11-18');
  assert.deepEqual(due('2026-11-19', '01:00', s), ['review_tomorrow']);
  assert.equal(dueSlots(ist('2026-11-19', '01:00'), s, wd())[0].run_date, '2026-11-19');
});
test('dueSlots: no working-day slot on Sunday or a holiday; a dow slot on a holiday is skipped too', () => {
  assert.deepEqual(due('2026-11-22', '09:00'), []);   // Sunday (working days Mon–Sat)
  assert.deepEqual(due('2026-11-21', '09:00'), ['owner_daily']);   // Saturday is a working day by default
  const hol = wd({ ...WEEK_DEFAULTS, holidays: ['2026-11-16', '2026-11-19'] });
  assert.deepEqual(due('2026-11-16', '09:00', DEFAULT, hol), []);
  assert.deepEqual(due('2026-11-19', '17:00', DEFAULT, hol), []);
  assert.deepEqual(due('2026-11-17', '09:00', DEFAULT, hol), ['owner_daily']);
});
test('dueSlots: a malformed or missing value disables its slot (never guessed)', () => {
  for (const bad of [{ time: '9:00', days: 'working' }, { time: '24:00', days: 'working' }, { time: '09:60', days: 'working' }, { time: '09:00' },
    { time: '09:00', days: 'weekdays' }, { time: '09:00', dow: 0 }, { time: '09:00', dow: 8 }, { time: '09:00', dow: '4' }, { time: '09:00', days: 'working', dow: 1 },
    { days: 'working' }, null, 'x', [], { time: 900, days: 'working' }]) {
    assert.equal(slotSpec(bad), null, JSON.stringify(bad));
    assert.deepEqual(due('2026-11-16', '09:00', { slots: { owner_daily: bad, chase: DEFAULT.slots.chase } }), [], JSON.stringify(bad));
  }
  assert.deepEqual(due('2026-11-16', '09:00', { slots: {} }), []);
  assert.deepEqual(dueSlots('not a date', DEFAULT, wd()), []);
  assert.deepEqual(slotSpec({ time: '09:15', days: 'working' }), { min: 555, dow: null });
});
test('dueSlots: the same answer every month (IST has no DST)', () => {
  for (const m of ['01', '03', '04', '06', '10', '11']) {
    const d = `2026-${m}-15`;
    const n = dueSlots(ist(d, '09:00'), DEFAULT, () => true).map(x => x.slot);
    assert.deepEqual(n, ['owner_daily'], d);
    assert.equal(new Date(ist(d, '09:00')).getUTCHours() * 60 + new Date(ist(d, '09:00')).getUTCMinutes(), 210, d);
  }
});
test('parseReminderSettings: an unknown mode is off; test ids must be uuids', () => {
  assert.equal(parseReminderSettings(null).mode, 'off');
  assert.equal(parseReminderSettings({ mode: 'LIVE' }).mode, 'off');
  assert.equal(parseReminderSettings({ mode: 'live' }).mode, 'live');
  assert.deepEqual(parseReminderSettings({ mode: 'test', test_employee_ids: [U(1), 'x', 3, U(1).toUpperCase()] }).test_employee_ids, [U(1)]);
  assert.deepEqual(SLOT_KEYS, ['owner_daily', 'chase', 'review_tomorrow', 'review_pack', 'catchup_prep']);
});
test('gateRecipients: off → nobody, test → only test people, live → everyone', () => {
  const people = [{ id: U(1) }, { id: U(2) }, { id: U(3) }];
  assert.deepEqual(gateRecipients('off', [U(1)], people), []);
  assert.deepEqual(gateRecipients('test', [U(1)], people).map(p => p.id), [U(1)]);
  assert.deepEqual(gateRecipients('test', [], people), []);
  assert.deepEqual(gateRecipients('test', [U(9)], people), [], 'a test id that is not a recipient gets nothing');
  assert.deepEqual(gateRecipients('live', [U(1)], people).map(p => p.id), [U(1), U(2), U(3)]);
  assert.deepEqual(gateRecipients('weird', [U(1)], people), []);
});
test('workingDayAfter skips Sundays and holidays', () => {
  assert.equal(workingDayAfter('2026-11-20', 2, wd()), '2026-11-23');   // Fri → Sat, (Sun), Mon
  assert.equal(workingDayAfter('2026-11-16', 2, wd({ ...WEEK_DEFAULTS, holidays: ['2026-11-17'] })), '2026-11-19');
});

const NOW = ist('2026-11-16', '09:00');
const at = (d, hm = '18:00') => new Date(ist(d, hm)).toISOString();
const T = (n, o = {}) => ({ id: U(100 + n), task_no: `DKT-${n}`, title: `ZZ <t${n}>`, status: 'in_progress', deadline: null, revised_deadline: null,
  created_at: '2026-10-01T00:00:00Z', ...o });
test('owner daily: overdue · today · quiet; each task once; fresh and newly created tasks are not quiet', () => {
  const tasks = [T(1, { deadline: at('2026-11-14') }), T(2, { deadline: at('2026-11-16') }), T(3, { deadline: at('2026-11-25') }),
    T(4, { deadline: at('2026-11-25') }), T(5, {}), T(6, { created_at: at('2026-11-15', '10:00') }), T(7, { status: 'done', deadline: at('2026-11-10') }),
    T(8, { deadline: at('2026-11-10'), revised_deadline: at('2026-11-16') })];
  const s = ownerDailySections(tasks, { nowMs: NOW, fresh: new Set([U(104)]), staleFrom: '2026-11-12' });
  assert.deepEqual([s.overdue, s.today, s.quiet].map(l => l.map(t => t.task_no)), [['DKT-1'], ['DKT-2', 'DKT-8'], ['DKT-3', 'DKT-5']]);
  const m = ownerDailyMessage(s);
  assert.equal(m.text, 'Docket: 1 overdue, 2 due today, 2 quiet.');
  assert.deepEqual(m.blocks.filter(b => b.type === 'actions')[0].elements.map(e => [e.action_id, e.value]),
    [['docket_done', U(101)], ['docket_move', U(101)], ['docket_comment', U(101)]]);
  assert.ok(JSON.stringify(m.blocks).includes('ZZ &lt;t1&gt;'));
  assert.equal(ownerDailyMessage({ overdue: [], today: [], quiet: [] }), null, 'empty → no DM');
});
test('owner daily: 30 of each stays ≤ 50 blocks with honest counts and the link last', () => {
  const many = (k, o) => Array.from({ length: 30 }, (_, i) => T(k + i, o(i)));
  const s = { overdue: many(0, () => ({})), today: many(100, () => ({})), quiet: many(200, () => ({})) };
  const m = ownerDailyMessage(s, { hidden: 2 });
  assert.ok(m.blocks.length <= 50, String(m.blocks.length));
  assert.equal(m.text, 'Docket: 30 overdue (showing 8), 30 due today (showing 8), 30 quiet (showing 5).');
  assert.match(m.blocks.at(-1).elements[0].text, /2 more in the Founders' space.*All your tasks in Docket/);
});
test('chase: due from now to the 2nd working day ahead; associates get the list, founders one line', () => {
  const cards = [T(1, { deadline: at('2026-11-16') }), T(2, { deadline: at('2026-11-18') }), T(3, { deadline: at('2026-11-19') }), T(4, { deadline: at('2026-11-13') }), T(5, {})];
  const list = chaseTasks(cards, { nowMs: NOW, until: workingDayAfter('2026-11-16', 2, wd()) });
  assert.deepEqual(list.map(t => t.task_no), ['DKT-1', 'DKT-2']);
  const m = chaseMessage(list.map(t => ({ ...t, owner_name: 'ZZ Riya' })), ['ZZ Ops'], { lwd: '2026-11-14' });
  assert.match(m.text, /2 tasks due soon with no update; 1 team raised/);
  assert.ok(JSON.stringify(m.blocks).includes('ZZ Riya') && JSON.stringify(m.blocks).includes('ZZ Ops'));
  const f = founderChaseLine(2, ['ZZ Ops']);
  assert.equal(f.blocks.length, 1);
  assert.match(f.text, /^Chase: 2 tasks due in the next 2 working days with no update in 3 · 1 team raised/);
  assert.ok(!f.text.includes('DKT-1'), 'founders get counts, not the list');
  assert.equal(chaseMessage([], []), null); assert.equal(founderChaseLine(0, []), null);
  const big = chaseMessage(Array.from({ length: 60 }, (_, i) => T(i, { deadline: at('2026-11-16') })), []);
  assert.ok(big.blocks.length <= 50);
  assert.match(JSON.stringify(big.blocks), /60 tasks \(showing 20\)/);
});
test('review tomorrow: committed rows not done; empty → null', () => {
  const rows = [{ task_id: U(1), task_no: 'DKT-1', title: 'a', status: 'in_progress', effective_deadline: at('2026-11-20') },
    { task_id: U(2), task_no: 'DKT-2', title: 'b', status: 'done', effective_deadline: at('2026-11-18') }];
  const m = reviewTomorrowMessage(rows, { weekEnd: '2026-11-22', hidden: 1 });
  assert.match(m.text, /1 committed task not done/);
  assert.ok(JSON.stringify(m.blocks).includes(`task=${U(1)}`) && !JSON.stringify(m.blocks).includes(`task=${U(2)}`));
  assert.match(m.blocks.at(-1).elements[0].text, /1 more in the Founders' space.*review\?week=2026-11-22/);
  assert.equal(reviewTomorrowMessage([rows[1]]), null);
});
test('review pack / catch-up: the Slack copy, cut into ≤ 2,900-char sections, plus the link', () => {
  const long = Array.from({ length: 400 }, (_, i) => `• line ${i} ${'x'.repeat(40)}`).join('\n');
  const p = reviewPackMessage(long, '2026-11-22');
  assert.ok(p.blocks.length <= 6 && p.blocks.every(b => (b.text?.text || b.elements[0].text).length <= 2900));
  assert.match(p.blocks.at(-1).elements[0].text, /review\?week=2026-11-22/);
  assert.match(p.blocks.at(-2).text.text, /more in Docket/);
  assert.match(catchupMessage('*Founders*', '2026-11-22').blocks.at(-1).elements[0].text, /review\/founders\?week=2026-11-22/);
  assert.equal(reviewPackMessage(''), null); assert.equal(catchupMessage(null), null);
  assert.equal(textSections('a\nb').length, 1);
});
test('safeCode keeps Slack enum words only', () => {
  assert.equal(safeCode('channel_not_found'), 'channel_not_found');
  assert.equal(safeCode('relation "x" does not exist'), 'send_failed');
  assert.equal(safeCode(undefined), 'send_failed');
});

test('H3: textSections never emits an empty section and hard-splits a line longer than the cap', () => {
  const huge = 'y'.repeat(7000);
  for (const text of [huge, huge + '\nshort', 'short\n' + huge]) {
    const b = textSections(text, 10);
    assert.ok(b.every(x => x.text.text.length > 0 && x.text.text.length <= 2900), JSON.stringify(b.map(x => x.text.text.length)));
    assert.equal(b.map(x => x.text.text).join('').replace(/\n/g, '').length, text.replace(/\n/g, '').length, 'nothing lost');
  }
  assert.deepEqual(textSections(''), []);
});
test('H1: identityTtlMs spreads re-checks over 6–8 days, stable per person', () => {
  const days = new Set(Array.from({ length: 60 }, (_, i) => identityTtlMs(U(i)) / 86400000));
  assert.deepEqual([...days].sort(), [6, 7, 8]);
  assert.equal(identityTtlMs(U(5)), identityTtlMs(U(5)));
});
test('H1: lookupOutcome — not found / refused → unmapped; anything else → failed with its code', () => {
  const ok = { ok: true, user: { id: 'U1AA' } };
  assert.deepEqual(lookupOutcome(ok, 'a@x.com', () => 'a@x.com'), { sid: 'U1AA' });
  assert.deepEqual(lookupOutcome(ok, 'a@x.com', () => null), { status: 'unmapped', code: 'slack_identity_refused' });
  assert.deepEqual(lookupOutcome({ ok: false, error: 'users_not_found' }, 'a@x.com'), { status: 'unmapped', code: 'no_slack_user' });
  assert.deepEqual(lookupOutcome({ ok: false, error: 'ratelimited' }, 'a@x.com'), { status: 'failed', code: 'ratelimited' });
  assert.deepEqual(lookupOutcome({ ok: false, error: 'network' }, 'a@x.com'), { status: 'failed', code: 'network' });
  assert.deepEqual(lookupOutcome(null, 'a@x.com'), { status: 'failed', code: 'send_failed' });
});
test('H1: slackApi honours Retry-After once (capped at 5 s), then gives up as ratelimited', async () => {
  const waits = []; let n = 0;
  const f429 = async () => { n++; return new Response(JSON.stringify({ ok: false, error: 'ratelimited' }), { status: 429, headers: { 'retry-after': '30' } }); };
  const r = await slackApi('users.lookupByEmail', { email: 'a@x.com' }, { SLACK_DOCKET_BOT_TOKEN: 'x' }, f429, { sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual([r, n, waits], [{ ok: false, error: 'ratelimited' }, 2, [5000]]);
  let m = 0;
  const thenOk = async () => (++m === 1 ? new Response('{}', { status: 429, headers: { 'retry-after': '2' } }) : new Response(JSON.stringify({ ok: true, user: { id: 'U1' } })));
  const waits2 = [];
  const r2 = await slackApi('users.lookupByEmail', { email: 'a@x.com' }, { SLACK_DOCKET_BOT_TOKEN: 'x' }, thenOk, { sleep: async (ms) => { waits2.push(ms); } });
  assert.deepEqual([r2.ok, m, waits2], [true, 2, [2000]]);
});
