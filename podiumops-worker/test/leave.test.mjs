import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEAVE_TYPES, LEDGER_TYPES, LEAVE_STATUSES, LEDGER_KINDS, HOLIDAY_KINDS, LEAVE_POLICIES, ACCRUAL_RATE, TYPE_LABELS, MAIL_TYPE_LABELS,
  countLeaveDays, normaliseHalves, validateLeaveInput, earningMonths, accrualPlan, yearClosePlan, borrowCap, ledgerBalance,
  pendingDebit, splitLeave, sameSplit, periodUsed, optionalUsed, limitBlock, overlaps, decideBlock, cancelBlock,
  resolveLeaveApprover, buildLeaveMail, leaveMessageId, cleanAmount, cleanNote, cleanHoliday, leaveDbErrorCode, addMonths,
  reclosePlan, splitBase, coveredFromOnChange, holidayListMissing, noHolidayListMessage, LEAVE_COPY,
  APPLY_TYPES, GRANT_TYPES, workingHalves, lopAllocation, lopReport, lopDiff, exitLeaveFigures, exitLeaveBlock, grantPlan,
  wfhApprover, yearEndYear, yearEndPreview, exitLeaveStale, withOpenExit, applyOpenExitsWith, lopExportRows, canonicalJson,
} from '../src/leave.js';

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const XMAS = new Set(['2026-12-25']);
const HOL = [{ date: '2026-12-25', kind: 'fixed' }, { date: '2026-12-24', kind: 'optional' }, { date: '2026-11-09', kind: 'optional' }];
const emp = (o = {}) => ({ id: U(1), leave_policy: 'fraternitas', date_joined: '2025-04-01', date_exited: null, ...o });

test('enums match the 0016 CHECKs', () => {
  assert.deepEqual(LEAVE_TYPES, ['PL', 'SL', 'PERIOD', 'OPTIONAL_HOLIDAY', 'MATERNITY', 'PATERNITY', 'WFH']);   // 0020
  assert.deepEqual(LEDGER_TYPES, ['PL', 'SL']);
  assert.deepEqual(LEAVE_STATUSES, ['pending', 'approved', 'rejected', 'withdrawn', 'cancelled']);
  assert.deepEqual(LEDGER_KINDS, ['opening', 'accrual', 'taken', 'cancelled', 'carry_over', 'lapse', 'adjustment']);
  assert.deepEqual(HOLIDAY_KINDS, ['fixed', 'optional']);
  assert.deepEqual(LEAVE_POLICIES, ['fraternitas']);
  assert.deepEqual(ACCRUAL_RATE, { PL: 1.5, SL: 1 });
});

test('labels: a mail never names period leave (D12)', () => {
  assert.equal(MAIL_TYPE_LABELS.PERIOD, 'Leave');
  assert.equal(MAIL_TYPE_LABELS.PL, 'Privilege leave');
  assert.equal(MAIL_TYPE_LABELS.SL, 'Sick leave');
  assert.equal(MAIL_TYPE_LABELS.OPTIONAL_HOLIDAY, 'Optional holiday');
  assert.equal(TYPE_LABELS.PERIOD, 'Period leave');
});

test('day count: Mon–Fri, weekends inside are free', () => {
  // Mon 7 Dec → Sun 13 Dec = 5 working days
  assert.deepEqual(countLeaveDays({ start_date: '2026-12-07', end_date: '2026-12-13' }), { days: 5 });
  // Mon 7 → Mon 14 = 6
  assert.deepEqual(countLeaveDays({ start_date: '2026-12-07', end_date: '2026-12-14' }), { days: 6 });
});

test('day count: a fixed holiday inside is free; a weekend holiday changes nothing (L10)', () => {
  // Mon 21 → Fri 25 Dec, 25th fixed → 4
  assert.deepEqual(countLeaveDays({ start_date: '2026-12-21', end_date: '2026-12-25' }, XMAS), { days: 4 });
  // a "holiday" on a Saturday: the Mon–Sun week still counts 5
  assert.deepEqual(countLeaveDays({ start_date: '2026-12-07', end_date: '2026-12-13' }, new Set(['2026-12-12'])), { days: 5 });
  // only the holiday → 0
  assert.deepEqual(countLeaveDays({ start_date: '2026-12-25', end_date: '2026-12-25' }, XMAS), { days: 0 });
});

test('day count: half days', () => {
  assert.deepEqual(countLeaveDays({ start_date: '2026-12-07', end_date: '2026-12-09', start_half: 'second', end_half: 'first' }), { days: 2 });
  assert.deepEqual(countLeaveDays({ start_date: '2026-12-07', end_date: '2026-12-09', start_half: 'second' }), { days: 2.5 });
  // single half day
  assert.deepEqual(countLeaveDays({ start_date: '2026-12-07', end_date: '2026-12-07', start_half: 'first', end_half: 'first' }), { days: 0.5 });
  // a half mark on a weekend day contributes nothing: Sat (second) → Mon = 1
  assert.deepEqual(countLeaveDays({ start_date: '2026-12-12', end_date: '2026-12-14', start_half: 'second' }), { days: 1 });
  // multi-day may not start with a first-half-only / end with a second-half-only
  assert.equal(countLeaveDays({ start_date: '2026-12-07', end_date: '2026-12-08', start_half: 'first' }).error, 'bad_half');
  assert.equal(countLeaveDays({ start_date: '2026-12-07', end_date: '2026-12-08', end_half: 'second' }).error, 'bad_half');
});

test('day count: crossing 31 Dec refused', () => {
  assert.equal(countLeaveDays({ start_date: '2026-12-31', end_date: '2027-01-01' }).error, 'crosses_year');
  assert.equal(countLeaveDays({ start_date: '2026-12-09', end_date: '2026-12-07' }).error, 'bad_dates');
});

test('halves normalise: a single day carries its half on both fields', () => {
  assert.deepEqual(normaliseHalves('2026-12-07', '2026-12-07', 'second', 'full'), { start_half: 'second', end_half: 'second' });
  assert.deepEqual(normaliseHalves('2026-12-07', '2026-12-07', 'full', 'first'), { start_half: 'first', end_half: 'first' });
  assert.deepEqual(normaliseHalves('2026-12-07', '2026-12-07', null, undefined), { start_half: 'full', end_half: 'full' });
  assert.equal(normaliseHalves('2026-12-07', '2026-12-07', 'first', 'second').error, 'bad_half');
  assert.deepEqual(normaliseHalves('2026-12-07', '2026-12-09', 'second', 'first'), { start_half: 'second', end_half: 'first' });
});

test('validate: PL happy path + notice', () => {
  const ctx = { today: '2026-12-01', holidays: HOL };
  const r = validateLeaveInput({ leave_type: 'PL', start_date: '2026-12-21', end_date: '2026-12-25', reason: ' trip ' }, ctx);
  assert.deepEqual(r.value, { leave_type: 'PL', start_date: '2026-12-21', end_date: '2026-12-25', start_half: 'full', end_half: 'full', days: 4, reason: 'trip' });
  // PL may not start in the past
  assert.equal(validateLeaveInput({ leave_type: 'PL', start_date: '2026-11-30', end_date: '2026-11-30' }, ctx).error, 'notice');
  // today is fine
  assert.ok(validateLeaveInput({ leave_type: 'PL', start_date: '2026-12-01', end_date: '2026-12-01' }, ctx).value);
  // HR recording for someone else: no notice rule
  assert.ok(validateLeaveInput({ leave_type: 'PL', start_date: '2026-11-02', end_date: '2026-11-02' }, { ...ctx, notice: false }).value);
});

test('validate: SL may be applied up to 7 days after', () => {
  const ctx = { today: '2026-12-10', holidays: HOL };
  assert.ok(validateLeaveInput({ leave_type: 'SL', start_date: '2026-12-03', end_date: '2026-12-03' }, ctx).value);
  assert.equal(validateLeaveInput({ leave_type: 'SL', start_date: '2026-12-02', end_date: '2026-12-02' }, ctx).error, 'notice');
});

test('validate: refusals', () => {
  const ctx = { today: '2026-12-01', holidays: HOL };
  assert.equal(validateLeaveInput({ leave_type: 'XX', start_date: '2026-12-07' }, ctx).error, 'bad_type');
  assert.equal(validateLeaveInput({ leave_type: 'PL', start_date: '2026-02-30' }, ctx).error, 'bad_dates');
  assert.equal(validateLeaveInput({ leave_type: 'PL', start_date: '2026-12-31', end_date: '2027-01-04' }, ctx).error, 'crosses_year');
  assert.equal(validateLeaveInput({ leave_type: 'PL', start_date: '2026-12-12', end_date: '2026-12-13' }, ctx).error, 'no_working_days');
  assert.equal(validateLeaveInput({ leave_type: 'PL', start_date: '2026-12-25', end_date: '2026-12-25' }, ctx).error, 'no_working_days');
  assert.equal(validateLeaveInput({ leave_type: 'PL', start_date: '2026-12-07', reason: 'x'.repeat(501) }, ctx).error, 'reason_too_long');
  // > 60 working days
  assert.equal(validateLeaveInput({ leave_type: 'PL', start_date: '2027-01-04', end_date: '2027-04-30' }, ctx).error, 'too_long');
  // end_date defaults to start_date
  assert.equal(validateLeaveInput({ leave_type: 'PL', start_date: '2026-12-07' }, ctx).value.days, 1);
});

test('validate: PERIOD — women only, one date, half allowed', () => {
  const ctx = { today: '2026-12-01', holidays: HOL, gender: 'f' };
  assert.equal(validateLeaveInput({ leave_type: 'PERIOD', start_date: '2026-12-07' }, { ...ctx, gender: 'm' }).error, 'period_not_eligible');
  assert.equal(validateLeaveInput({ leave_type: 'PERIOD', start_date: '2026-12-07' }, { ...ctx, gender: null }).error, 'period_not_eligible');
  assert.equal(validateLeaveInput({ leave_type: 'PERIOD', start_date: '2026-12-07', end_date: '2026-12-08' }, ctx).error, 'period_one_day');
  assert.equal(LEAVE_COPY.period_one_day, 'Period leave is one day at most');
  assert.equal(validateLeaveInput({ leave_type: 'PERIOD', start_date: '2026-12-07', start_half: 'first' }, ctx).value.days, 0.5);
});

test('validate: OPTIONAL_HOLIDAY — exactly one optional date, full day', () => {
  const ctx = { today: '2026-12-01', holidays: HOL };
  assert.equal(validateLeaveInput({ leave_type: 'OPTIONAL_HOLIDAY', start_date: '2026-12-24' }, ctx).value.days, 1);
  assert.equal(validateLeaveInput({ leave_type: 'OPTIONAL_HOLIDAY', start_date: '2026-12-23' }, ctx).error, 'not_optional_holiday');
  assert.equal(validateLeaveInput({ leave_type: 'OPTIONAL_HOLIDAY', start_date: '2026-12-25' }, ctx).error, 'not_optional_holiday');
  assert.equal(validateLeaveInput({ leave_type: 'OPTIONAL_HOLIDAY', start_date: '2026-12-24', start_half: 'first' }, ctx).error, 'not_optional_holiday');
  assert.equal(validateLeaveInput({ leave_type: 'OPTIONAL_HOLIDAY', start_date: '2026-12-23', end_date: '2026-12-24' }, ctx).error, 'not_optional_holiday');
});

test('accrual: cutover, join on the 15th vs the 16th (L3)', () => {
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.deepEqual(earningMonths(emp(), '2026-12', '2026-12', '2027-02'), ['2026-12', '2027-01', '2027-02']);
  assert.deepEqual(earningMonths(emp({ date_joined: '2027-01-15' }), '2026-12', '2026-12', '2027-02'), ['2027-01', '2027-02']);
  assert.deepEqual(earningMonths(emp({ date_joined: '2027-01-16' }), '2026-12', '2026-12', '2027-02'), ['2027-02']);
  // joined before the cutover: from the cutover
  assert.deepEqual(earningMonths(emp({ date_joined: '2026-06-20' }), '2026-12', '2026-12', '2026-12'), ['2026-12']);
  // a future joiner earns nothing yet
  assert.deepEqual(earningMonths(emp({ date_joined: '2027-03-01' }), '2026-12', '2026-12', '2027-02'), []);
});

test('accrual: exit mid-month earns that month, none after; no policy → none', () => {
  assert.deepEqual(earningMonths(emp({ date_exited: '2027-01-20' }), '2026-12', '2026-12', '2027-03'), ['2026-12', '2027-01']);
  assert.deepEqual(earningMonths(emp({ leave_policy: null }), '2026-12', '2026-12', '2027-03'), []);
});

test('accrualPlan: only the missing rows, dated the 1st', () => {
  const rows = accrualPlan({ employee: emp(), cutoverMonth: '2026-12', currentMonth: '2027-01', existing: new Set(['PL:2026-12', 'SL:2026-12']) });
  assert.deepEqual(rows, [
    { employee_id: U(1), leave_type: 'PL', delta: 1.5, kind: 'accrual', period: '2027-01', effective_date: '2027-01-01' },
    { employee_id: U(1), leave_type: 'SL', delta: 1, kind: 'accrual', period: '2027-01', effective_date: '2027-01-01' },
  ]);
  // before the cutover nothing is due
  assert.deepEqual(accrualPlan({ employee: emp(), cutoverMonth: '2026-12', currentMonth: '2026-11' }), []);
  // idempotent: everything present → nothing
  assert.deepEqual(accrualPlan({ employee: emp(), cutoverMonth: '2026-12', currentMonth: '2026-12', existing: new Set(['PL:2026-12', 'SL:2026-12']) }), []);
});

test('year close: PL above 5 lapses, SL lapses fully, negatives carry, once per year', () => {
  const ledger = [
    { leave_type: 'PL', delta: 8, effective_date: '2026-12-01' },
    { leave_type: 'SL', delta: 3, effective_date: '2026-12-01' },
    { leave_type: 'PL', delta: 1.5, effective_date: '2027-01-01' },   // next year: not in the 2026 closing
  ];
  const p = yearClosePlan({ employeeId: U(1), cutoverMonth: '2026-12', currentYear: 2027, ledger });
  assert.deepEqual(p.years, [2026]);
  assert.deepEqual(p.rows, [
    { employee_id: U(1), leave_type: 'PL', delta: -3, kind: 'lapse', period: '2026', effective_date: '2026-12-31' },
    { employee_id: U(1), leave_type: 'SL', delta: -3, kind: 'lapse', period: '2026', effective_date: '2026-12-31' },
  ]);
  // already closed → nothing
  assert.deepEqual(yearClosePlan({ employeeId: U(1), cutoverMonth: '2026-12', currentYear: 2027, ledger, closedYears: new Set([2026]) }), { years: [], rows: [] });
  // the current year never closes
  assert.deepEqual(yearClosePlan({ employeeId: U(1), cutoverMonth: '2026-12', currentYear: 2026, ledger }).years, []);
});

test('year close: negative carry (borrowed) has no row; PL at exactly 5 has none', () => {
  const neg = yearClosePlan({ employeeId: U(1), cutoverMonth: '2026-12', currentYear: 2027, ledger: [
    { leave_type: 'PL', delta: 1.5, effective_date: '2026-12-01' }, { leave_type: 'PL', delta: -4, effective_date: '2026-12-21' },
    { leave_type: 'SL', delta: -1, effective_date: '2026-12-10' },
  ] });
  assert.deepEqual(neg, { years: [2026], rows: [] });
  const five = yearClosePlan({ employeeId: U(1), cutoverMonth: '2026-12', currentYear: 2027, ledger: [{ leave_type: 'PL', delta: 5, effective_date: '2026-12-01' }] });
  assert.deepEqual(five.rows, []);
});

test('year close: two open years chain (the first lapse feeds the second closing)', () => {
  const ledger = [{ leave_type: 'PL', delta: 10, effective_date: '2026-12-01' }, { leave_type: 'PL', delta: 3, effective_date: '2027-06-01' }];
  const p = yearClosePlan({ employeeId: U(1), cutoverMonth: '2026-12', currentYear: 2028, ledger });
  assert.deepEqual(p.years, [2026, 2027]);
  // 2026: 10 → lapse 5 · 2027: 10 − 5 + 3 = 8 → lapse 3
  assert.deepEqual(p.rows.map(r => [r.leave_type, r.period, r.delta]), [['PL', '2026', -5], ['PL', '2027', -3]]);
});

test('borrow cap: what is still to come this year; a next-year leave = 12 months; past year 0', () => {
  const e = emp();
  assert.equal(borrowCap({ leaveType: 'PL', leaveYear: 2027, currentMonth: '2027-03', employee: e, cutoverMonth: '2026-12' }), 13.5);
  assert.equal(borrowCap({ leaveType: 'SL', leaveYear: 2027, currentMonth: '2027-03', employee: e, cutoverMonth: '2026-12' }), 9);
  assert.equal(borrowCap({ leaveType: 'PL', leaveYear: 2027, currentMonth: '2027-12', employee: e, cutoverMonth: '2026-12' }), 0);
  assert.equal(borrowCap({ leaveType: 'PL', leaveYear: 2028, currentMonth: '2027-12', employee: e, cutoverMonth: '2026-12' }), 18);
  assert.equal(borrowCap({ leaveType: 'PL', leaveYear: 2026, currentMonth: '2027-01', employee: e, cutoverMonth: '2026-12' }), 0);
  // before the cutover only the post-cutover months count (today Nov 2026 → December)
  assert.equal(borrowCap({ leaveType: 'PL', leaveYear: 2026, currentMonth: '2026-11', employee: e, cutoverMonth: '2026-12' }), 1.5);
  // an exit date stops the cap
  assert.equal(borrowCap({ leaveType: 'PL', leaveYear: 2027, currentMonth: '2027-03', employee: emp({ date_exited: '2027-05-31' }), cutoverMonth: '2026-12' }), 3);
  assert.equal(borrowCap({ leaveType: 'PERIOD', leaveYear: 2027, currentMonth: '2027-03', employee: e, cutoverMonth: '2026-12' }), 0);
});

test('split: balance first, then borrow to −cap, the rest LOP', () => {
  assert.deepEqual(splitLeave({ days: 3, balance: 5, pending: 0, cap: 6 }), { available: 5, from_balance: 3, borrowed_days: 0, lop_days: 0 });
  assert.deepEqual(splitLeave({ days: 5, balance: 2, pending: 0, cap: 6 }), { available: 2, from_balance: 2, borrowed_days: 3, lop_days: 0 });
  // cap exhaustion → LOP
  assert.deepEqual(splitLeave({ days: 10, balance: 2, pending: 0, cap: 6 }), { available: 2, from_balance: 2, borrowed_days: 6, lop_days: 2 });
  // already negative: the negative part eats the cap
  assert.deepEqual(splitLeave({ days: 4, balance: -3, pending: 0, cap: 4.5 }), { available: -3, from_balance: 0, borrowed_days: 1.5, lop_days: 2.5 });
  // past the cap entirely → all LOP
  assert.deepEqual(splitLeave({ days: 2, balance: -5, pending: 0, cap: 4.5 }), { available: -5, from_balance: 0, borrowed_days: 0, lop_days: 2 });
  // pending requests hold balance
  assert.deepEqual(splitLeave({ days: 2, balance: 3, pending: 2, cap: 0 }), { available: 1, from_balance: 1, borrowed_days: 0, lop_days: 1 });
  // halves stay exact
  assert.deepEqual(splitLeave({ days: 0.5, balance: 0.5, pending: 0, cap: 0 }), { available: 0.5, from_balance: 0.5, borrowed_days: 0, lop_days: 0 });
});

test('ledger balance + pending debit (LOP never debited; PostgREST numerics are strings)', () => {
  const ledger = [{ leave_type: 'PL', delta: '1.5' }, { leave_type: 'PL', delta: '-0.5' }, { leave_type: 'SL', delta: '1.0' }];
  assert.equal(ledgerBalance(ledger, 'PL'), 1);
  assert.equal(ledgerBalance(ledger, 'SL'), 1);
  const reqs = [
    { id: 'a', status: 'pending', leave_type: 'PL', days: '3.0', lop_days: '1.0' },
    { id: 'b', status: 'pending', leave_type: 'PL', days: '1.5', lop_days: '0.0' },
    { id: 'c', status: 'approved', leave_type: 'PL', days: '2.0', lop_days: '0' },
  ];
  assert.equal(pendingDebit(reqs, 'PL'), 3.5);
  assert.equal(pendingDebit(reqs, 'PL', 'a'), 1.5);
  assert.equal(pendingDebit(reqs, 'SL'), 0);
  assert.ok(sameSplit({ borrowed_days: '1.5', lop_days: 0 }, { borrowed_days: 1.5, lop_days: '0.0' }));
  assert.ok(!sameSplit({ borrowed_days: 1, lop_days: 0 }, { borrowed_days: 1.5, lop_days: 0 }));
  assert.ok(!sameSplit({ borrowed_days: 0, lop_days: 0 }, undefined));
});

test('PERIOD twice in a month; optional holiday twice in a year', () => {
  const reqs = [
    { id: 'p1', leave_type: 'PERIOD', status: 'approved', start_date: '2026-12-07', days: 1 },
    { id: 'o1', leave_type: 'OPTIONAL_HOLIDAY', status: 'pending', start_date: '2026-12-24', days: 1 },
    { id: 'p0', leave_type: 'PERIOD', status: 'rejected', start_date: '2027-01-05', days: 1 },
  ];
  assert.equal(periodUsed(reqs, '2026-12'), 1);
  assert.equal(periodUsed(reqs, '2027-01'), 0);
  assert.equal(limitBlock({ leave_type: 'PERIOD', start_date: '2026-12-15', days: 1 }, reqs), 'period_used');
  assert.equal(limitBlock({ leave_type: 'PERIOD', start_date: '2027-01-15', days: 1 }, reqs), null);
  // two halves fill one month
  const half = [{ id: 'h', leave_type: 'PERIOD', status: 'pending', start_date: '2027-01-05', days: 0.5 }];
  assert.equal(limitBlock({ leave_type: 'PERIOD', start_date: '2027-01-15', days: 0.5 }, half), null);
  assert.equal(limitBlock({ leave_type: 'PERIOD', start_date: '2027-01-15', days: 1 }, half), 'period_used');
  assert.equal(optionalUsed(reqs, 2026), 1);
  assert.equal(limitBlock({ leave_type: 'OPTIONAL_HOLIDAY', start_date: '2026-11-09', days: 1 }, reqs), 'optional_used');
  assert.equal(limitBlock({ leave_type: 'OPTIONAL_HOLIDAY', start_date: '2027-01-14', days: 1 }, reqs), null);
});

test('overlap: any type, pending / approved only', () => {
  const reqs = [{ id: 'a', status: 'approved', start_date: '2026-12-07', end_date: '2026-12-09' },
    { id: 'b', status: 'withdrawn', start_date: '2026-12-14', end_date: '2026-12-14' }];
  assert.ok(overlaps(reqs, '2026-12-09', '2026-12-10'));
  assert.ok(!overlaps(reqs, '2026-12-10', '2026-12-11'));
  assert.ok(!overlaps(reqs, '2026-12-14', '2026-12-14'));
  assert.ok(!overlaps(reqs, '2026-12-07', '2026-12-07', 'a'));
});

test('decide: approver, approver\'s manager, HR — never self', () => {
  const req = { employee_id: U(1), approver_employee_id: U(2), status: 'pending' };
  assert.equal(decideBlock({ req, meId: U(2), hr: false }), null);
  assert.equal(decideBlock({ req, meId: U(3), hr: false, approverManagerId: U(3) }), null);
  assert.equal(decideBlock({ req, meId: U(4), hr: false, approverManagerId: U(3) }), 'forbidden');
  assert.equal(decideBlock({ req, meId: U(4), hr: true }), null);
  assert.equal(decideBlock({ req, meId: U(1), hr: true }), 'no_self_approval');
  // no approver (HR decides)
  assert.equal(decideBlock({ req: { ...req, approver_employee_id: null }, meId: U(2), hr: false }), 'forbidden');
  assert.equal(decideBlock({ req: { ...req, approver_employee_id: null }, meId: null, hr: true }), null);
});

test('withdraw / cancel rules (D10)', () => {
  const pend = { employee_id: U(1), approver_employee_id: U(2), status: 'pending', start_date: '2026-12-10' };
  const appr = { ...pend, status: 'approved' };
  const today = '2026-12-05';
  assert.equal(cancelBlock({ mode: 'withdraw', req: pend, meId: U(1), today }), null);
  assert.equal(cancelBlock({ mode: 'withdraw', req: pend, meId: U(2), today }), 'forbidden');
  assert.equal(cancelBlock({ mode: 'withdraw', req: pend, meId: U(9), hr: true, today }), null);
  assert.equal(cancelBlock({ mode: 'withdraw', req: appr, meId: U(1), today }), 'not_pending');
  assert.equal(cancelBlock({ mode: 'cancel', req: pend, meId: U(1), today }), 'not_approved');
  assert.equal(cancelBlock({ mode: 'cancel', req: appr, meId: U(1), today }), null);
  // started (start ≤ today): the person may not; the approver / their manager / HR may
  assert.equal(cancelBlock({ mode: 'cancel', req: appr, meId: U(1), today: '2026-12-10' }), 'forbidden');
  assert.equal(cancelBlock({ mode: 'cancel', req: appr, meId: U(1), hr: true, today: '2026-12-10' }), 'forbidden');
  assert.equal(cancelBlock({ mode: 'cancel', req: appr, meId: U(2), today: '2026-12-10' }), null);
  assert.equal(cancelBlock({ mode: 'cancel', req: appr, meId: U(3), approverManagerId: U(3), today: '2026-12-10' }), null);
  assert.equal(cancelBlock({ mode: 'cancel', req: appr, meId: U(9), hr: true, today: '2026-12-10' }), null);
  assert.equal(cancelBlock({ mode: 'cancel', req: appr, meId: U(9), today: '2026-12-10' }), 'forbidden');
});

test('approver at submit (D9)', () => {
  assert.equal(resolveLeaveApprover({ id: U(1), manager_id: U(2) }, [U(5), U(6)]), U(2));
  assert.equal(resolveLeaveApprover({ id: U(5), manager_id: null }, [U(5), U(6)]), U(6));
  assert.equal(resolveLeaveApprover({ id: U(6), manager_id: null }, [U(5), U(6)]), U(5));
  assert.equal(resolveLeaveApprover({ id: U(7), manager_id: null }, [U(5), U(6)]), null);
});

test('mail: names type label + dates + days, never reason / borrowed / LOP; period says "Leave"', () => {
  const request = { id: U(10), leave_type: 'PERIOD', start_date: '2026-12-07', end_date: '2026-12-07', start_half: 'first', end_half: 'first',
    days: 0.5, reason: 'SECRET-REASON', borrowed_days: 0, lop_days: 0 };
  const m = buildLeaveMail({ kind: 'submitted', from: 'a@legendoftoys.com', fromName: 'Asha K', to: 'b@legendoftoys.com', toFirst: 'Bala',
    personName: 'Asha K', request, link: 'https://podium.legendoftoys.com/leave/', messageId: leaveMessageId(U(10), 'submitted', 'abc') });
  assert.ok(!m.error);
  assert.match(m.subject, /Leave request: Asha K — Leave, 7 Dec 2026 \(first half\)/);
  assert.match(m.text, /0\.5 days/);
  assert.ok(!/period/i.test(m.raw));
  assert.ok(!m.raw.includes('SECRET-REASON'));
  const pl = buildLeaveMail({ kind: 'approved', from: 'b@legendoftoys.com', fromName: 'Bala', to: 'a@legendoftoys.com', personName: 'Asha K',
    request: { ...request, leave_type: 'PL', end_date: '2026-12-09', start_half: 'full', end_half: 'full', days: 3, borrowed_days: 1.5, lop_days: 0.5 },
    link: 'x', messageId: leaveMessageId(U(10), 'approved', 'n1') });
  assert.match(pl.subject, /Your leave request was approved: Privilege leave, 7 Dec 2026 – 9 Dec 2026/);
  assert.ok(!/borrow|unpaid|LOP|1\.5/i.test(pl.text));
  assert.equal(buildLeaveMail({ kind: 'approved', from: 'nope', to: 'a@legendoftoys.com', request, messageId: leaveMessageId(U(1), 'x', 'y') }).error, 'bad_sender');
  assert.equal(buildLeaveMail({ kind: 'nope', from: 'a@legendoftoys.com', to: 'b@legendoftoys.com', request, messageId: leaveMessageId(U(1), 'x', 'y') }).error, 'bad_kind');
});

test('HR inputs', () => {
  assert.deepEqual(cleanAmount('2.5'), { value: 2.5 });
  assert.deepEqual(cleanAmount(-1), { value: -1 });
  assert.equal(cleanAmount(0).error, 'bad_amount');
  assert.deepEqual(cleanAmount(0, { allowZero: true }), { value: 0 });
  assert.equal(cleanAmount(1.25).error, 'bad_amount');
  assert.equal(cleanAmount(61).error, 'bad_amount');
  assert.equal(cleanAmount('').error, 'bad_amount');
  assert.equal(cleanAmount(true).error, 'bad_amount');
  assert.deepEqual(cleanNote('  '), { value: null });
  assert.equal(cleanNote('  ', { required: true }).error, 'note_required');
  assert.equal(cleanNote('x'.repeat(501)).error, 'note_too_long');
  assert.deepEqual(cleanHoliday({ date: '2027-01-26', name: ' Republic   Day ', kind: 'fixed' }), { value: { date: '2027-01-26', name: 'Republic Day', kind: 'fixed' } });
  assert.equal(cleanHoliday({ date: '2027-01-26', name: '', kind: 'fixed' }).error, 'bad_holiday');
  assert.equal(cleanHoliday({ date: '2027-01-26', name: 'X', kind: 'floating' }).error, 'bad_holiday');
});

test('db error mapping', () => {
  assert.equal(leaveDbErrorCode({ ok: false, data: { message: 'overlap' } }), 'overlap');
  assert.equal(leaveDbErrorCode({ ok: false, data: { message: 'balance_changed' } }), 'balance_changed');
  assert.equal(leaveDbErrorCode({ ok: false, data: { code: '23514', message: 'new row violates check constraint "leave_requests_no_self_approval"' } }), 'no_self_approval');
  assert.equal(leaveDbErrorCode({ ok: false, data: { code: '23505', message: 'duplicate key value violates unique constraint "leave_ledger_opening_unique"' } }), 'opening_exists');
  assert.equal(leaveDbErrorCode({ ok: true, data: {} }), null);
});

test('holiday list missing for the leave year → no_holiday_list (names the year)', () => {
  assert.ok(holidayListMissing([]));
  assert.ok(holidayListMissing(null));
  // only optional dates: still no list of days off
  assert.ok(holidayListMissing([{ date: '2027-03-10', kind: 'optional' }]));
  assert.ok(!holidayListMissing([{ date: '2027-01-26', kind: 'fixed' }]));
  assert.equal(noHolidayListMessage(2027), "The holiday list for 2027 isn't in Podium yet — ask HR to add it");
  assert.ok(LEAVE_COPY.no_holiday_list);
});

test('coverage history: off → on stamps the 1st of this IST month; on → off and unchanged leave it', () => {
  assert.equal(coveredFromOnChange(null, 'fraternitas', '2027-03-18'), '2027-03-01');
  assert.equal(coveredFromOnChange('fraternitas', null, '2027-03-18'), undefined);
  assert.equal(coveredFromOnChange('fraternitas', 'fraternitas', '2027-03-18'), undefined);
  assert.equal(coveredFromOnChange(null, null, '2027-03-18'), undefined);
});

test('accrual: an off → on gap earns nothing for the gap (leave_covered_from)', () => {
  // covered from the D1 seed (null): every month since the cutover
  assert.deepEqual(earningMonths(emp({ leave_covered_from: null }), '2026-12', '2026-12', '2027-04'), ['2026-12', '2027-01', '2027-02', '2027-03', '2027-04']);
  // turned off in Jan, back on in Mar: Dec + Jan were already written; the re-on reads from March only
  const back = emp({ leave_covered_from: '2027-03-01' });
  assert.deepEqual(earningMonths(back, '2026-12', '2026-12', '2027-04'), ['2027-03', '2027-04']);
  const rows = accrualPlan({ employee: back, cutoverMonth: '2026-12', currentMonth: '2027-04', existing: new Set(['PL:2026-12', 'SL:2026-12', 'PL:2027-01', 'SL:2027-01']) });
  assert.deepEqual(rows.map(r => `${r.leave_type}:${r.period}`), ['PL:2027-03', 'SL:2027-03', 'PL:2027-04', 'SL:2027-04']);
  // the borrow cap counts the same months
  assert.equal(borrowCap({ leaveType: 'PL', leaveYear: 2027, currentMonth: '2027-01', employee: emp({ leave_covered_from: '2027-06-01' }), cutoverMonth: '2026-12' }), 10.5);
  // join month still wins when later
  assert.deepEqual(earningMonths(emp({ date_joined: '2027-04-10', leave_covered_from: '2027-03-01' }), '2026-12', '2026-12', '2027-04'), ['2027-04']);
});

test('year close: a pending request does not hold the close (Codex S453 #3)', () => {
  const ledger = [{ leave_type: 'PL', delta: 8, effective_date: '2026-12-01' }];
  const p = yearClosePlan({ employeeId: U(1), cutoverMonth: '2026-12', currentYear: 2028, ledger, requests: [{ leave_type: 'SL', status: 'pending', start_date: '2026-12-30' }] });
  assert.deepEqual(p.years, [2026, 2027]);
  assert.deepEqual(p.rows.map(r => [r.period, r.delta]), [['2026', -3]]);
});

test('reclose (mirror of podium.leave_reclose): approve / cancel into a closed year moves its lapse', () => {
  const base = [
    { leave_type: 'PL', delta: 8, kind: 'opening', period: null, effective_date: '2026-12-01' },
    { leave_type: 'PL', delta: -3, kind: 'lapse', period: '2026', effective_date: '2026-12-31' },
    { leave_type: 'SL', delta: 1, kind: 'opening', period: null, effective_date: '2026-12-01' },
    { leave_type: 'SL', delta: -1, kind: 'lapse', period: '2026', effective_date: '2026-12-31' },
  ];
  const closed = new Set([2026]);
  // approve 2 PL days on 28 Dec: closing 6 → lapse −1
  const taken = [...base, { leave_type: 'PL', delta: -2, kind: 'taken', period: null, effective_date: '2026-12-28' }];
  assert.deepEqual(reclosePlan({ ledger: taken, leaveType: 'PL', fromYear: 2026, closedYears: closed }), [{ year: 2026, leave_type: 'PL', old: -3, new: -1 }]);
  // then cancel: closing 8 → back to −3
  const lapse1 = taken.map(r => (r.kind === 'lapse' && r.leave_type === 'PL' ? { ...r, delta: -1 } : r));
  const cancelled = [...lapse1, { leave_type: 'PL', delta: 2, kind: 'cancelled', period: null, effective_date: '2026-12-28' }];
  assert.deepEqual(reclosePlan({ ledger: cancelled, leaveType: 'PL', fromYear: 2026, closedYears: closed }), [{ year: 2026, leave_type: 'PL', old: -1, new: -3 }]);
  // SL 1 day approved: closing 0 → the lapse row goes (none)
  const sl = [...base, { leave_type: 'SL', delta: -1, kind: 'taken', period: null, effective_date: '2026-12-30' }];
  assert.deepEqual(reclosePlan({ ledger: sl, leaveType: 'SL', fromYear: 2026, closedYears: closed }), [{ year: 2026, leave_type: 'SL', old: -1, new: null }]);
  // a 5-or-under closing with no lapse row and nothing changing → nothing
  assert.deepEqual(reclosePlan({ ledger: [{ leave_type: 'PL', delta: 4, kind: 'opening', effective_date: '2026-12-01' }], leaveType: 'PL', fromYear: 2026, closedYears: closed }), []);
  // a cancel that pushes a no-lapse year above 5 → a new lapse row
  assert.deepEqual(reclosePlan({ ledger: [{ leave_type: 'PL', delta: 4, kind: 'opening', effective_date: '2026-12-01' },
    { leave_type: 'PL', delta: 3, kind: 'cancelled', effective_date: '2026-12-21' }], leaveType: 'PL', fromYear: 2026, closedYears: closed }),
  [{ year: 2026, leave_type: 'PL', old: null, new: -2 }]);
  // an open year is not touched
  assert.deepEqual(reclosePlan({ ledger: taken, leaveType: 'PL', fromYear: 2026, closedYears: new Set() }), []);
  // chained: 2027 closed too, its closing includes 2026's new lapse
  const chain = [
    { leave_type: 'PL', delta: 10, kind: 'opening', effective_date: '2026-12-01' },
    { leave_type: 'PL', delta: -5, kind: 'lapse', period: '2026', effective_date: '2026-12-31' },
    { leave_type: 'PL', delta: 3, kind: 'accrual', period: '2027-06', effective_date: '2027-06-01' },
    { leave_type: 'PL', delta: -3, kind: 'lapse', period: '2027', effective_date: '2027-12-31' },
    { leave_type: 'PL', delta: -4, kind: 'taken', effective_date: '2026-12-21' },
  ];
  // 2026: 10 − 4 = 6 → −1 · 2027: 6 − 1 + 3 = 8 → −3 (unchanged, no entry)
  assert.deepEqual(reclosePlan({ ledger: chain, leaveType: 'PL', fromYear: 2026, closedYears: new Set([2026, 2027]) }), [{ year: 2026, leave_type: 'PL', old: -5, new: -1 }]);
  const chain2 = [...chain, { leave_type: 'PL', delta: -5, kind: 'taken', effective_date: '2026-12-14' }];
  // 2026: 10 − 9 = 1 → none · 2027: 1 + 3 = 4 → none
  assert.deepEqual(reclosePlan({ ledger: chain2, leaveType: 'PL', fromYear: 2026, closedYears: new Set([2026, 2027]) }),
    [{ year: 2026, leave_type: 'PL', old: -5, new: null }, { year: 2027, leave_type: 'PL', old: -3, new: null }]);
});

// one ledger row per call: L('PL', 9, '2026-12-01') → an opening-like row of that type and date
const L = (leave_type, delta, effective_date, kind = 'opening', period = null) => ({ leave_type, delta, effective_date, kind, period });
const sb = (leaveType, ledger, leaveYear, currentYear, nextCap = 0) => splitBase({ leaveType, ledger, leaveYear, currentYear, nextCap });

test('next-year split base: only what carries (PL ≤ 5, SL ≤ 0); this year unchanged', () => {
  assert.equal(sb('PL', [L('PL', 9, '2026-12-01')], 2027, 2026), 5);
  assert.equal(sb('PL', [L('PL', 3, '2026-12-01')], 2027, 2026), 3);
  assert.equal(sb('PL', [L('PL', -2, '2026-12-01')], 2027, 2026), -2);
  assert.equal(sb('SL', [L('SL', 4, '2026-12-01')], 2027, 2026), 0);
  assert.equal(sb('SL', [L('SL', -1, '2026-12-01')], 2027, 2026), -1);
  assert.equal(sb('PL', [L('PL', 9, '2026-12-01')], 2026, 2026), 9);
  assert.equal(sb('SL', [L('SL', '4.0', '2026-12-01')], 2026, 2026), 4);
  assert.equal(sb('SL', [L('PL', 4, '2026-12-01')], 2026, 2026), 0);   // other type ignored
  // 9 PL today, 7 days in Jan next year, cap 18 → 5 from balance, 2 borrowed (not 7 from balance)
  assert.deepEqual(splitLeave({ days: 7, balance: sb('PL', [L('PL', 9, '2026-12-01')], 2027, 2026), pending: 0, cap: 18 }),
    { available: 5, from_balance: 5, borrowed_days: 2, lop_days: 0 });
  // SL 4 today, 2 days next year: all borrowed
  assert.deepEqual(splitLeave({ days: 2, balance: sb('SL', [L('SL', 4, '2026-12-01')], 2027, 2026), pending: 0, cap: 12 }),
    { available: 0, from_balance: 0, borrowed_days: 2, lop_days: 0 });
});

test('Codex S453 #1: two next-year requests cannot both borrow the full cap', () => {
  const ledger = [L('SL', 12, '2027-11-01')];
  const first = splitLeave({ days: 12, balance: sb('SL', ledger, 2028, 2027), pending: 0, cap: 12 });
  assert.deepEqual(first, { available: 0, from_balance: 0, borrowed_days: 12, lop_days: 0 });
  // approved → taken −12 dated in 2028; the second 12-day request is all unpaid
  const after = [...ledger, L('SL', -12, '2028-01-10', 'taken')];
  assert.equal(sb('SL', after, 2028, 2027), -12);
  assert.deepEqual(splitLeave({ days: 12, balance: sb('SL', after, 2028, 2027), pending: 0, cap: 12 }),
    { available: -12, from_balance: 0, borrowed_days: 0, lop_days: 12 });
  // PL: 10 now, 3 already taken next year → base 5 − 3 = 2
  assert.equal(sb('PL', [L('PL', 10, '2027-11-01'), L('PL', -3, '2028-01-05', 'taken')], 2028, 2027), 2);
});

test('this-year split base after a next-year leave: this year\'s days stay usable within next year\'s cap', () => {
  // 10 PL, a 5-day Jan leave already approved (post −5), next-year cap 18 → all 10 usable now
  assert.equal(sb('PL', [L('PL', 10, '2027-11-01'), L('PL', -5, '2028-01-05', 'taken')], 2027, 2027, 18), 10);
  // next year fully borrowed (post −23): only the 5 above the carry are usable, so the carry still covers next year
  assert.equal(sb('PL', [L('PL', 10, '2027-11-01'), L('PL', -23, '2028-01-05', 'taken')], 2027, 2027, 18), 5);
  // SL 12 that would lapse, 12 next-year days borrowed against a 12 cap → all 12 usable now
  assert.equal(sb('SL', [L('SL', 12, '2027-11-01'), L('SL', -12, '2028-01-05', 'taken')], 2027, 2027, 12), 12);
  // no next-year rows → plain balance
  assert.equal(sb('PL', [L('PL', 10, '2027-11-01'), L('PL', -2, '2027-11-20', 'taken')], 2027, 2027, 18), 8);
});

test('Codex S453 #3: a past-year request splits on that year\'s closing before its lapse', () => {
  // 2026: SL 2, closed → lapse −2; Jan 2027 accrual +1. A pending 2-day Dec 2026 SL request is decided in Jan 2027.
  const ledger = [L('SL', 2, '2026-12-01'), L('SL', -2, '2026-12-31', 'lapse', '2026'), L('SL', 1, '2027-01-01', 'accrual', '2027-01')];
  assert.equal(sb('SL', ledger, 2026, 2027), 2);
  assert.deepEqual(splitLeave({ days: 2, balance: sb('SL', ledger, 2026, 2027), pending: 0, cap: 0 }),
    { available: 2, from_balance: 2, borrowed_days: 0, lop_days: 0 });
  // an earlier year's lapse still counts (period differs)
  assert.equal(sb('PL', [L('PL', 9, '2026-12-01'), L('PL', -4, '2026-12-31', 'lapse', '2026'), L('PL', 18, '2027-12-01')], 2027, 2028), 23);
});

test('validate: at most next calendar year', () => {
  const base = { leave_type: 'PL', start_half: 'full', end_half: 'full' };
  assert.equal(validateLeaveInput({ ...base, start_date: '2028-01-05', end_date: '2028-01-05' }, { today: '2026-12-10', notice: false }).error, 'too_far');
  assert.equal(validateLeaveInput({ ...base, start_date: '2027-01-05', end_date: '2027-01-05' }, { today: '2026-12-10' }).error, undefined);
});

// ════════════════════════════════════════════════════════════════════════════
// Leave R2 (plan 2026-11-13-podium-leave-r2, E1–E5). Synthetic people only.
// ════════════════════════════════════════════════════════════════════════════

test('R2 types: apply vs grant; labels; WFH notice as SL; grants are HR-only', () => {
  assert.deepEqual(APPLY_TYPES, ['PL', 'SL', 'PERIOD', 'OPTIONAL_HOLIDAY', 'WFH']);
  assert.deepEqual(GRANT_TYPES, ['MATERNITY', 'PATERNITY']);
  assert.equal(TYPE_LABELS.WFH, 'Work from home');
  assert.equal(MAIL_TYPE_LABELS.MATERNITY, 'Maternity leave');
  const w = { leave_type: 'WFH', start_half: 'full', end_half: 'full' };
  // WFH may start up to 7 days back (as SL); 8 days back → notice
  assert.equal(validateLeaveInput({ ...w, start_date: '2026-12-03', end_date: '2026-12-03' }, { today: '2026-12-10', holidays: HOL }).value.days, 1);
  assert.equal(validateLeaveInput({ ...w, start_date: '2026-12-02', end_date: '2026-12-02' }, { today: '2026-12-10', holidays: HOL }).error, 'notice');
  // half day + holiday counted like leave
  assert.equal(validateLeaveInput({ ...w, start_date: '2026-12-24', end_date: '2026-12-28', end_half: 'first' }, { today: '2026-12-10', holidays: HOL }).value.days, 1.5);   // 24 · 25 hol · 28 ½
  assert.equal(validateLeaveInput({ leave_type: 'MATERNITY', start_date: '2026-12-14', end_date: '2026-12-14' }, { today: '2026-12-10' }).error, 'grant_only');
  // a grant: never cancelled by the person (even before it starts); HR may
  const g = { employee_id: U(1), approver_employee_id: null, status: 'approved', start_date: '2027-01-04', leave_type: 'PATERNITY' };
  assert.equal(cancelBlock({ mode: 'cancel', req: g, meId: U(1), hr: false, today: '2026-12-10' }), 'forbidden');
  assert.equal(cancelBlock({ mode: 'cancel', req: g, meId: U(9), hr: true, today: '2026-12-10' }), null);
  assert.equal(cancelBlock({ mode: 'cancel', req: g, meId: U(1), hr: true, today: '2026-12-10' }), 'forbidden');
  // a WFH approved request still follows D10
  assert.equal(cancelBlock({ mode: 'cancel', req: { ...g, leave_type: 'WFH' }, meId: U(1), hr: false, today: '2026-12-10' }), null);
});

test('E1 LOP allocation: the LAST working halves, across a month boundary, with half days', () => {
  // Fri 27 Nov (2nd half) → Wed 2 Dec (1st half): 27 s · 30 f s · 1 f s · 2 f = 6 halves = 3 days
  const req = { start_date: '2026-11-27', end_date: '2026-12-02', start_half: 'second', end_half: 'first', days: 3, lop_days: 2 };
  assert.equal(workingHalves(req).length, 6);
  const a = lopAllocation(req, new Set());
  assert.deepEqual(a.months, {
    '2026-11': { days: 0.5, dates: [{ date: '2026-11-30', half: 'second' }] },
    '2026-12': { days: 1.5, dates: [{ date: '2026-12-01', half: 'full' }, { date: '2026-12-02', half: 'first' }] },
  });
  assert.equal(a.lop_days, 2);
  assert.equal(a.recount_mismatch, false);
  // no LOP → nothing
  assert.deepEqual(lopAllocation({ ...req, lop_days: 0 }).months, {});
});

test('E1 LOP allocation: a holiday added after submit → allocate over what exists + recount_mismatch', () => {
  const req = { start_date: '2026-11-27', end_date: '2026-12-02', start_half: 'second', end_half: 'first', days: 3, lop_days: 2 };
  const a = lopAllocation(req, new Set(['2026-12-01']));   // 1 Dec became a fixed holiday: 4 halves left
  assert.equal(a.recount_mismatch, true);
  assert.deepEqual(a.months, {
    '2026-11': { days: 1.5, dates: [{ date: '2026-11-27', half: 'second' }, { date: '2026-11-30', half: 'full' }] },
    '2026-12': { days: 0.5, dates: [{ date: '2026-12-02', half: 'first' }] },
  });
  // fewer halves than lop_days → every half is unpaid, never more
  const b = lopAllocation({ ...req, lop_days: 3 }, new Set(['2026-12-01']));
  assert.equal(b.lop_days, 2);
});

test('E1 report rows: approved PL / SL only, per person per month; diff since the last export', () => {
  const req = (o) => ({ id: U(50), employee_id: U(1), leave_type: 'PL', status: 'approved', start_half: 'full', end_half: 'full', ...o });
  const requests = [
    req({ id: U(51), start_date: '2026-12-07', end_date: '2026-12-08', days: 2, lop_days: 1 }),             // 8 Dec
    req({ id: U(52), leave_type: 'SL', start_date: '2026-12-10', end_date: '2026-12-10', days: 0.5, lop_days: 0.5, start_half: 'first', end_half: 'first' }),
    req({ id: U(53), status: 'rejected', start_date: '2026-12-14', end_date: '2026-12-14', days: 1, lop_days: 1 }),
    req({ id: U(54), leave_type: 'WFH', start_date: '2026-12-15', end_date: '2026-12-15', days: 1, lop_days: 1 }),
    req({ id: U(55), employee_id: U(2), start_date: '2026-11-30', end_date: '2026-12-01', days: 2, lop_days: 1 }),   // LOP on 1 Dec
    req({ id: U(56), employee_id: U(3), start_date: '2026-11-26', end_date: '2026-11-27', days: 2, lop_days: 1 }),   // LOP in Nov only
  ];
  const employees = { [U(1)]: { employee_code: 'T-001', full_name: 'Test Alpha', razorpayx_employee_id: 'rx-1' },
    [U(2)]: { employee_code: 'T-002', full_name: 'Test Beta', razorpayx_employee_id: null } };
  const { rows, warnings } = lopReport({ month: '2026-12', requests, employees, fixedHolidays: XMAS });
  assert.equal(rows.length, 2);
  assert.deepEqual(warnings, []);
  assert.deepEqual(rows[0], { employee_id: U(1), employee_code: 'T-001', full_name: 'Test Alpha', razorpayx_employee_id: 'rx-1',
    dates: [{ date: '2026-12-08', half: 'full' }, { date: '2026-12-10', half: 'first' }], recount_mismatch: false,
    request_ids: [U(51), U(52)], lop_days: 1.5 });
  assert.equal(rows[1].full_name, 'Test Beta');
  assert.deepEqual(rows[1].dates, [{ date: '2026-12-01', half: 'full' }]);
  assert.deepEqual(lopReport({ month: '2026-13', requests }), { rows: [], warnings: [] });
  // diff: Alpha was 1 now 1.5; Beta unchanged; Gamma dropped out (cancelled after export)
  const prev = [{ ...rows[0], lop_days: 1, dates: [{ date: '2026-12-08', half: 'full' }] }, rows[1],
    { employee_id: U(3), employee_code: 'T-003', full_name: 'Test Gamma', lop_days: 2, dates: [] }];
  const diff = lopDiff(prev, rows);
  assert.deepEqual(diff.map(x => [x.full_name, x.was, x.now]), [['Test Alpha', 1, 1.5], ['Test Gamma', 2, 0]]);
  // same count on different dates is a change too
  assert.equal(lopDiff([{ ...rows[1], dates: [{ date: '2026-12-02', half: 'full' }] }], [rows[1]]).length, 1);
  assert.deepEqual(lopDiff(rows, rows), []);
});

const LG = (t, delta, d, kind = 'accrual', period = kind === 'accrual' ? d.slice(0, 7) : null) => ({ leave_type: t, delta, kind, period, effective_date: d });

test('E2 exit figures: negative SL + positive PL; LWD mid-month still earns that month; next year-end applied', () => {
  const e = emp();
  const ledger = [LG('PL', 3, '2026-12-01', 'opening'), LG('PL', 1.5, '2026-12-01'), LG('SL', 1, '2026-12-01'),
    LG('SL', -4, '2026-12-05', 'taken')];
  // today 10 Dec 2026, LWD Sun 14 Feb 2027: Jan + Feb still earn (the exit month earns), nothing after
  const f = exitLeaveFigures({ employee: e, ledger, cutoverMonth: '2026-12', lwd: '2027-02-14', today: '2026-12-10' });
  assert.deepEqual(f, { as_at: '2027-02-14', PL: 7.5, SL: -1, lop_days: 1, projected_accrual: { PL: 3, SL: 2 }, expected: { PL: 4.5, SL: -3 } });
  // PL above 5 at 31 Dec lapses before the next year's credits; SL negative carries as is
  const g = exitLeaveFigures({ employee: e, ledger: [...ledger, LG('PL', 5, '2026-12-02', 'adjustment')], cutoverMonth: '2026-12', lwd: '2027-02-14', today: '2026-12-10' });
  assert.equal(g.PL, 8);          // 9.5 → lapse 4.5 → 5, + 3
  assert.equal(g.lop_days, 1);    // only the SL −1
  // both negative → both are F&F LOP
  const h = exitLeaveFigures({ employee: e, ledger: [LG('PL', -2, '2026-12-01', 'opening'), LG('SL', -1, '2026-12-01', 'opening')], cutoverMonth: '2026-12', lwd: '2026-12-31', today: '2026-12-10' });
  assert.deepEqual([h.PL, h.SL, h.lop_days], [-0.5, 0, 0.5]);   // no Dec credit row yet → projected +1.5 / +1
});

test('E2 exit figures: LWD already past — later accruals and the later year close are not counted', () => {
  const ledger = [LG('PL', 8, '2026-12-01', 'opening'), LG('PL', 1.5, '2026-12-01'), LG('PL', -4.5, '2026-12-31', 'lapse', '2026'),
    LG('PL', 1.5, '2027-01-01'), LG('SL', 1, '2026-12-01'), LG('SL', -1, '2026-12-31', 'lapse', '2026'), LG('SL', 1, '2027-01-01'),
    LG('PL', -1, '2027-01-05', 'adjustment')];   // an HR adjustment made after the LWD still counts
  const f = exitLeaveFigures({ employee: emp(), ledger, cutoverMonth: '2026-12', lwd: '2026-12-20', today: '2027-01-05' });
  assert.deepEqual([f.PL, f.SL, f.lop_days], [8.5, 1, 0]);
  assert.deepEqual(f.projected_accrual, { PL: 0, SL: 0 });
  assert.equal(exitLeaveFigures({ employee: emp(), ledger, cutoverMonth: '2026-12', lwd: 'x', today: '2027-01-05' }), null);
});

test('E2 exit Done guard: after-LWD first, then pending', () => {
  const r = (o) => ({ status: 'approved', start_date: '2026-12-01', end_date: '2026-12-02', ...o });
  assert.equal(exitLeaveBlock([r()], '2026-12-15'), null);
  assert.equal(exitLeaveBlock([r({ end_date: '2026-12-16' })], '2026-12-15'), 'leave_after_lwd');
  assert.equal(exitLeaveBlock([r({ status: 'pending' })], '2026-12-15'), 'leave_pending');
  assert.equal(exitLeaveBlock([r({ status: 'pending', end_date: '2026-12-20' })], '2026-12-15'), 'leave_after_lwd');
  assert.equal(exitLeaveBlock([r({ status: 'cancelled', end_date: '2026-12-20' })], '2026-12-15'), null);
});

test('E3 maternity: 182 calendar days, may cross 31 Dec; gender f; a note is required', () => {
  const g = grantPlan({ leave_type: 'MATERNITY', start_date: '2026-10-01', note: 'Eligibility checked: 80+ days worked' }, { gender: 'f', today: '2026-09-20' });
  assert.deepEqual(g.value, { leave_type: 'MATERNITY', start_date: '2026-10-01', start_half: 'full', end_half: 'full',
    note: 'Eligibility checked: 80+ days worked', end_date: '2027-03-31', days: 182 });
  assert.equal(grantPlan({ leave_type: 'MATERNITY', start_date: '2026-10-01' }, { gender: 'f' }).error, 'note_required');
  assert.equal(grantPlan({ leave_type: 'MATERNITY', start_date: '2026-10-01', note: 'x' }, { gender: 'm' }).error, 'maternity_not_eligible');
  assert.equal(grantPlan({ leave_type: 'MATERNITY', start_date: '2026-10-01', note: 'x' }, { gender: null }).error, 'gender_unknown');
  assert.equal(grantPlan({ leave_type: 'PL', start_date: '2026-10-01' }, { gender: 'f' }).error, 'bad_type');
  assert.equal(grantPlan({ leave_type: 'MATERNITY', start_date: '2028-01-03', note: 'x' }, { gender: 'f', today: '2026-12-10' }).error, 'too_far');
});

test('E3 paternity: 15 working days over holidays and 31 Dec; needs the next year\'s list', () => {
  const hol = [{ date: '2026-12-25', kind: 'fixed' }, { date: '2027-01-01', kind: 'fixed' }, { date: '2027-01-26', kind: 'fixed' }];
  // Mon 21 Dec: 21–24 (4), 25 hol, 28–31 (8), 1 Jan hol, 4–8 Jan (13), 11–12 Jan (15)
  const g = grantPlan({ leave_type: 'PATERNITY', start_date: '2026-12-21' }, { gender: 'm', holidays: hol });
  assert.equal(g.value.end_date, '2027-01-12');
  assert.equal(g.value.days, 15);
  assert.equal(g.value.note, null);
  // without 2027's list → refuse, naming the year
  assert.deepEqual(grantPlan({ leave_type: 'PATERNITY', start_date: '2026-12-21' }, { gender: 'm', holidays: hol.slice(0, 1) }), { error: 'no_holiday_list', year: 2027 });
  // inside one year with no holiday in range: 3 weeks of weekdays
  assert.equal(grantPlan({ leave_type: 'PATERNITY', start_date: '2026-11-16' }, { gender: 'm', holidays: hol }).value.end_date, '2026-12-04');
  assert.equal(grantPlan({ leave_type: 'PATERNITY', start_date: '2026-11-16' }, { gender: 'f', holidays: hol }).error, 'paternity_not_eligible');
});

test('E4 WFH approver: skip-level, else the manager, else HR (null)', () => {
  const mgr = { [U(2)]: U(3), [U(3)]: null, [U(5)]: U(1) };
  const of = (id) => mgr[id] ?? null;
  assert.equal(wfhApprover({ id: U(1), manager_id: U(2) }, of), U(3));      // skip-level
  assert.equal(wfhApprover({ id: U(2), manager_id: U(3) }, of), U(3));      // manager has no manager → the manager
  assert.equal(wfhApprover({ id: U(3), manager_id: null }, of), null);      // no manager → HR
  assert.equal(wfhApprover({ id: U(1), manager_id: U(5) }, of), U(5));      // a loop back to the person → the manager
});

test('E5 year-end window + preview (negative PL carries; PL above 5 and positive SL lapse)', () => {
  assert.equal(yearEndYear('2026-11-01'), 2026);
  assert.equal(yearEndYear('2026-12-31'), 2026);
  assert.equal(yearEndYear('2027-01-31'), 2026);
  assert.equal(yearEndYear('2026-10-31'), null);
  const e = emp();
  const ledger = [LG('PL', -2, '2026-11-20', 'opening'), LG('SL', 3, '2026-11-20', 'opening')];
  const reqs = [{ status: 'pending', leave_type: 'PL', start_date: '2026-12-10', days: 2, lop_days: 0 },
    { status: 'pending', leave_type: 'PL', start_date: '2027-01-10', days: 4, lop_days: 0 }];   // next year: not this close
  const p = yearEndPreview({ employee: e, ledger, requests: reqs, cutoverMonth: '2026-12', today: '2026-11-20', year: 2026 });
  // PL −2 + Dec 1.5 − 2 pending = −2.5 carries; SL 3 + 1 = 4 lapses
  assert.deepEqual(p, { year: 2026, actual: false, PL: { projected: -2.5, carry: -2.5, lapse: 0, pending: 2 }, SL: { projected: 4, carry: 0, lapse: 4, pending: 0 } });
  const q = yearEndPreview({ employee: e, ledger: [LG('PL', 9, '2026-11-20', 'opening')], requests: [], cutoverMonth: '2026-12', today: '2026-12-05', year: 2026 });
  assert.deepEqual(q.PL, { projected: 9, carry: 5, lapse: 4, pending: 0 });   // in December no credit is still to come
  // January view of last year: its own lapse row is ignored, no credits to come
  const j = yearEndPreview({ employee: e, ledger: [LG('PL', 9, '2026-12-01', 'opening'), LG('PL', -4, '2026-12-31', 'lapse', '2026'), LG('PL', 1.5, '2027-01-01')],
    requests: [], cutoverMonth: '2026-12', today: '2027-01-10', year: 2026 });
  assert.deepEqual(j.PL, { projected: 9, carry: 5, lapse: 4, pending: 0 });
});

test('R2 mail: a grant says "granted", never the note', () => {
  const m = buildLeaveMail({ kind: 'granted', from: 'hr@legendoftoys.com', fromName: 'Test HR', to: 'p@legendoftoys.com', toFirst: 'Pat',
    personName: 'Test Person', request: { id: U(9), leave_type: 'PATERNITY', start_date: '2026-12-21', end_date: '2027-01-12', start_half: 'full', end_half: 'full', days: 15, decision_note: 'secret note' },
    link: 'https://podium.example/leave/', messageId: leaveMessageId(U(9), 'granted', 'abcd1234') });
  assert.match(m.subject, /^Leave granted: Paternity leave, 21 Dec 2026 – 12 Jan 2027$/);
  assert.match(m.text, /Your paternity leave for 21 Dec 2026 – 12 Jan 2027 \(15 days\) was granted by Test HR\./);
  assert.doesNotMatch(m.raw, /secret/);
  assert.equal(leaveDbErrorCode({ data: { message: 'gender_unknown' } }), 'gender_unknown');
});

// ── Review fixes (hostile review + Codex on the R2 diff) ─────────────────────

test('review F: a recount mismatch is a warning even when none of its LOP lands in the month', () => {
  // Thu 26 Nov – Tue 1 Dec frozen at 2 days with 1 LOP (30 Nov + 1 Dec were holidays at submit, since deleted).
  const r = { id: U(60), employee_id: U(1), leave_type: 'PL', status: 'approved', start_date: '2026-11-26', end_date: '2026-12-01',
    start_half: 'full', end_half: 'full', days: 2, lop_days: 1 };
  const emps = { [U(1)]: { employee_code: 'T-001', full_name: 'Test Alpha', razorpayx_employee_id: 'rx-1' } };
  // today's list: 26 Nov – 1 Dec has 4 working days (26, 27, 30, 1) vs frozen 2 → mismatch; LOP = the last 2 halves = 1 Dec
  const dec = lopReport({ month: '2026-12', requests: [r], employees: emps, fixedHolidays: new Set() });
  assert.equal(dec.rows.length, 1);
  assert.equal(dec.warnings.length, 1);
  // November: no LOP lands there, but the request touches it → still warned
  const nov = lopReport({ month: '2026-11', requests: [r], employees: emps, fixedHolidays: new Set() });
  assert.deepEqual(nov.rows, []);
  assert.deepEqual(nov.warnings, [{ request_id: U(60), employee_id: U(1), employee_code: 'T-001', full_name: 'Test Alpha',
    start_date: '2026-11-26', end_date: '2026-12-01', lop_days: 1, placed: 1, placed_in_month: 0 }]);
});

test('review D: canonical JSON is key-order independent; export rows drop request ids', () => {
  assert.equal(canonicalJson({ b: 1, a: [{ y: 2, x: null }] }), canonicalJson({ a: [{ x: null, y: 2 }], b: 1 }));
  assert.equal(canonicalJson({ a: 1, u: undefined }), '{"a":1}');
  assert.notEqual(canonicalJson([{ lop_days: 1 }]), canonicalJson([{ lop_days: 1.5 }]));
  assert.deepEqual(lopExportRows([{ employee_id: 'x', request_ids: ['r'], lop_days: 1 }]), [{ employee_id: 'x', lop_days: 1 }]);
});

test('review C: a grant may end early (≤ the full length); days follow the range', () => {
  const hol = [{ date: '2026-12-25', kind: 'fixed' }, { date: '2027-01-01', kind: 'fixed' }, { date: '2027-01-26', kind: 'fixed' }];
  const m = grantPlan({ leave_type: 'MATERNITY', start_date: '2026-10-01', end_date: '2026-10-31', note: 'checked' }, { gender: 'f' });
  assert.deepEqual([m.value.end_date, m.value.days], ['2026-10-31', 31]);
  assert.equal(grantPlan({ leave_type: 'MATERNITY', start_date: '2026-10-01', end_date: '2027-04-01', note: 'checked' }, { gender: 'f' }).error, 'grant_too_long');
  assert.equal(grantPlan({ leave_type: 'MATERNITY', start_date: '2026-10-01', end_date: '2027-03-31', note: 'checked' }, { gender: 'f' }).value.days, 182);
  assert.equal(grantPlan({ leave_type: 'MATERNITY', start_date: '2026-10-01', end_date: '2026-09-30', note: 'checked' }, { gender: 'f' }).error, 'bad_dates');
  // paternity Mon 21 Dec → Thu 31 Dec: 21–24, 28–31 = 8 working days (25 Dec is a holiday)
  const p = grantPlan({ leave_type: 'PATERNITY', start_date: '2026-12-21', end_date: '2026-12-31' }, { gender: 'm', holidays: hol });
  assert.deepEqual([p.value.end_date, p.value.days], ['2026-12-31', 8]);
  assert.equal(grantPlan({ leave_type: 'PATERNITY', start_date: '2026-12-21', end_date: '2027-01-13' }, { gender: 'm', holidays: hol }).error, 'grant_too_long');
  assert.equal(grantPlan({ leave_type: 'PATERNITY', start_date: '2026-12-26', end_date: '2026-12-27' }, { gender: 'm', holidays: hol }).error, 'no_working_days');
  // ending in this year needs only this year's list
  assert.equal(grantPlan({ leave_type: 'PATERNITY', start_date: '2026-12-21', end_date: '2026-12-31' }, { gender: 'm', holidays: hol.slice(0, 1) }).value.days, 8);
});

test('review A: a confirmed leave line goes stale on a new LWD, a ledger move, a pending or after-LWD request', () => {
  const exit = { lwd: '2026-12-15', leave_confirmed_at: '2026-12-10T10:00:00Z', leave_as_at: '2026-12-15', leave_ledger_pl: 4.5, leave_ledger_sl: -3 };
  const item = { auto_source: 'leave_ledger', status: 'done' };
  const ledger = { PL: 4.5, SL: -3 };
  assert.equal(exitLeaveStale({ exit, item, requests: [], ledger }), false);
  assert.equal(exitLeaveStale({ exit: { ...exit, lwd: '2026-12-20' }, item, requests: [], ledger }), true);           // LWD moved
  assert.equal(exitLeaveStale({ exit, item, requests: [], ledger: { PL: 3, SL: -3 } }), true);                          // ledger moved
  assert.equal(exitLeaveStale({ exit, item, requests: [{ status: 'pending', end_date: '2026-12-01' }], ledger }), true);
  assert.equal(exitLeaveStale({ exit, item, requests: [{ status: 'approved', end_date: '2026-12-16' }], ledger }), true);
  assert.equal(exitLeaveStale({ exit, item: { ...item, status: 'open' }, requests: [{ status: 'pending', end_date: '2026-12-01' }], ledger }), false);
  // not covered: no snapshot, only the request checks
  const bare = { lwd: '2026-12-15', leave_confirmed_at: null };
  assert.equal(exitLeaveStale({ exit: bare, item, requests: [], ledger: null }), false);
  assert.equal(exitLeaveStale({ exit: bare, item, requests: [{ status: 'pending', end_date: '2026-12-01' }], ledger: null }), true);
});

test('review I: an open exit stops accrual after its LWD month (date_exited is only set at the close)', () => {
  const e = emp();
  // LWD 14 Jan 2027 → Jan earns, Feb and Mar do not
  const rows = accrualPlan({ employee: withOpenExit(e, '2027-01-14'), cutoverMonth: '2026-12', currentMonth: '2027-03' });
  assert.deepEqual([...new Set(rows.map(r => r.period))], ['2026-12', '2027-01']);
  assert.equal(accrualPlan({ employee: e, cutoverMonth: '2026-12', currentMonth: '2027-03' }).length, 8);   // no exit: 4 months × 2
  // a real date_exited wins; no LWD → unchanged
  assert.equal(withOpenExit({ ...e, date_exited: '2026-12-31' }, '2027-01-14').date_exited, '2026-12-31');
  assert.equal(withOpenExit(e, null), e);
  // the borrow cap stops there too
  assert.equal(borrowCap({ leaveType: 'PL', leaveYear: 2027, currentMonth: '2026-12', employee: withOpenExit(e, '2027-02-10'), cutoverMonth: '2026-12' }), 3);
});

test('review H: January shows the ACTUAL close of last year, pending as its own figure', () => {
  const e = emp();
  const ledger = [LG('PL', 9, '2026-12-01', 'opening'), LG('PL', -4, '2026-12-31', 'lapse', '2026'), LG('PL', 1.5, '2027-01-01'),
    LG('SL', -2, '2026-12-01', 'opening')];
  const reqs = [{ status: 'pending', leave_type: 'PL', start_date: '2026-12-20', days: 2, lop_days: 0 }];
  const j = yearEndPreview({ employee: e, ledger, requests: reqs, cutoverMonth: '2026-12', today: '2027-01-10', year: 2026 });
  assert.equal(j.actual, true);
  assert.deepEqual(j.PL, { projected: 9, carry: 5, lapse: 4, pending: 2 });   // the written lapse, not a projection
  assert.deepEqual(j.SL, { projected: -2, carry: -2, lapse: 0, pending: 0 });
  const n = yearEndPreview({ employee: e, ledger: [], requests: reqs, cutoverMonth: '2026-12', today: '2026-11-20', year: 2026 });
  assert.equal(n.actual, false);
  assert.deepEqual(n.PL, { projected: -0.5, carry: -0.5, lapse: 0, pending: 2 });   // Dec 1.5 − 2 pending
});

test("re-verify I': a failed open-exit read throws and marks nobody checked (no accrual past an unseen LWD)", async () => {
  const e = emp();
  await assert.rejects(applyOpenExitsWith([e], async () => null), /open exits read/);
  // success: the LWD is applied and the row is marked; checked rows are not re-read
  let reads = 0;
  const out = await applyOpenExitsWith([e], async (ids) => { reads++; return [{ employee_id: ids[0], lwd: '2027-01-14' }]; });
  assert.equal(out[0].date_exited, '2027-01-14');
  assert.equal(out[0]._exit_checked, true);
  assert.deepEqual([...new Set(accrualPlan({ employee: out[0], cutoverMonth: '2026-12', currentMonth: '2027-03' }).map(r => r.period))], ['2026-12', '2027-01']);
  await applyOpenExitsWith(out, async () => { reads++; return null; });   // nothing unchecked → no read, no throw
  assert.equal(reads, 1);
});

test("re-verify A': a covered person's done leave line with no snapshot is stale; not covered is not", () => {
  const item = { auto_source: 'leave_ledger', status: 'done' };
  const exit = { lwd: '2026-12-15', leave_confirmed_at: null, leave_as_at: null };
  assert.equal(exitLeaveStale({ exit, item, requests: [], ledger: { PL: 1, SL: 0 } }), true);
  assert.equal(exitLeaveStale({ exit: { ...exit, leave_confirmed_at: '2026-12-10T00:00:00Z' }, item, requests: [], ledger: { PL: 1, SL: 0 } }), true);
  assert.equal(exitLeaveStale({ exit, item, requests: [], ledger: null }), false);
});
