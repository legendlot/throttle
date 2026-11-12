import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEAVE_TYPES, LEDGER_TYPES, LEAVE_STATUSES, LEDGER_KINDS, HOLIDAY_KINDS, LEAVE_POLICIES, ACCRUAL_RATE, TYPE_LABELS, MAIL_TYPE_LABELS,
  countLeaveDays, normaliseHalves, validateLeaveInput, earningMonths, accrualPlan, yearClosePlan, borrowCap, ledgerBalance,
  pendingDebit, splitLeave, sameSplit, periodUsed, optionalUsed, limitBlock, overlaps, decideBlock, cancelBlock,
  resolveLeaveApprover, buildLeaveMail, leaveMessageId, cleanAmount, cleanNote, cleanHoliday, leaveDbErrorCode, addMonths,
  reclosePlan, splitBase, coveredFromOnChange, holidayListMissing, noHolidayListMessage, LEAVE_COPY,
} from '../src/leave.js';

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const XMAS = new Set(['2026-12-25']);
const HOL = [{ date: '2026-12-25', kind: 'fixed' }, { date: '2026-12-24', kind: 'optional' }, { date: '2026-11-09', kind: 'optional' }];
const emp = (o = {}) => ({ id: U(1), leave_policy: 'fraternitas', date_joined: '2025-04-01', date_exited: null, ...o });

test('enums match the 0016 CHECKs', () => {
  assert.deepEqual(LEAVE_TYPES, ['PL', 'SL', 'PERIOD', 'OPTIONAL_HOLIDAY']);
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

test('year close: a pending PL / SL request in the year holds the close (and the years after)', () => {
  const ledger = [{ leave_type: 'PL', delta: 8, effective_date: '2026-12-01' }];
  const pend = [{ leave_type: 'SL', status: 'pending', start_date: '2026-12-30' }];
  assert.deepEqual(yearClosePlan({ employeeId: U(1), cutoverMonth: '2026-12', currentYear: 2028, ledger, requests: pend }), { years: [], rows: [] });
  // decided (not pending) / a PERIOD / a next-year pending → it closes
  for (const requests of [[{ ...pend[0], status: 'approved' }], [{ ...pend[0], leave_type: 'PERIOD' }], [{ ...pend[0], start_date: '2027-01-04' }]]) {
    const p = yearClosePlan({ employeeId: U(1), cutoverMonth: '2026-12', currentYear: 2027, ledger, requests });
    assert.deepEqual(p.years, [2026]);
    assert.deepEqual(p.rows.map(r => r.delta), [-3]);
  }
  // 2026 closes, 2027 waits for its pending request
  const two = yearClosePlan({ employeeId: U(1), cutoverMonth: '2026-12', currentYear: 2028, ledger, requests: [{ leave_type: 'PL', status: 'pending', start_date: '2027-12-27' }] });
  assert.deepEqual(two.years, [2026]);
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

test('next-year split base: only what carries (PL ≤ 5, SL ≤ 0); this year unchanged', () => {
  assert.equal(splitBase({ leaveType: 'PL', balance: 9, leaveYear: 2027, currentYear: 2026 }), 5);
  assert.equal(splitBase({ leaveType: 'PL', balance: 3, leaveYear: 2027, currentYear: 2026 }), 3);
  assert.equal(splitBase({ leaveType: 'PL', balance: -2, leaveYear: 2027, currentYear: 2026 }), -2);
  assert.equal(splitBase({ leaveType: 'SL', balance: 4, leaveYear: 2027, currentYear: 2026 }), 0);
  assert.equal(splitBase({ leaveType: 'SL', balance: -1, leaveYear: 2027, currentYear: 2026 }), -1);
  assert.equal(splitBase({ leaveType: 'PL', balance: 9, leaveYear: 2026, currentYear: 2026 }), 9);
  assert.equal(splitBase({ leaveType: 'SL', balance: '4.0', leaveYear: 2026, currentYear: 2026 }), 4);
  // 9 PL today, 7 days in Jan next year, cap 18 → 5 from balance, 2 borrowed (not 7 from balance)
  assert.deepEqual(splitLeave({ days: 7, balance: splitBase({ leaveType: 'PL', balance: 9, leaveYear: 2027, currentYear: 2026 }), pending: 0, cap: 18 }),
    { available: 5, from_balance: 5, borrowed_days: 2, lop_days: 0 });
  // SL 4 today, 2 days next year: all borrowed
  assert.deepEqual(splitLeave({ days: 2, balance: splitBase({ leaveType: 'SL', balance: 4, leaveYear: 2027, currentYear: 2026 }), pending: 0, cap: 12 }),
    { available: 0, from_balance: 0, borrowed_days: 2, lop_days: 0 });
});
