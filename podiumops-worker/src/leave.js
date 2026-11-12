// Leave R1 — apply, approve, balances, holidays. The PURE rules (no I/O), unit-tested in test/leave.test.mjs.
// Plan: docs/superpowers/plans/2026-11-13-podium-leave-r1.md (decisions D1–D15) · spec L1–L10.
//
// The ledger (podium.leave_ledger, migration 0016) is the ONLY balance: Σ delta per type (D3). Accrual and the
// year-end lapse are written lazily by ensureLeaveCurrent (index.js) from accrualPlan / yearClosePlan here — no cron.
// All day arithmetic runs in HALF-DAY units (integers) so 0.5 steps never pick up float error.

import { encodeHeaderWords, addressOk } from './offerlink.js';

// ── D2: types + policy constants (match the migration CHECKs) ─────────────────
export const LEAVE_TYPES = ['PL', 'SL', 'PERIOD', 'OPTIONAL_HOLIDAY'];
export const LEDGER_TYPES = ['PL', 'SL'];                       // the only types with a ledger / balance
export const ACCRUAL_RATE = { PL: 1.5, SL: 1 };                 // per earning month (L3, credited on the 1st)
export const PL_CARRY_MAX = 5;                                  // D5: PL above this lapses at year end; SL lapses fully (L8)
export const MAX_REQUEST_DAYS = 60;                             // D6 R1 sanity cap (working days)
export const SL_BACKDATE_DAYS = 7;                              // D8 notice: SL may start up to 7 days ago
export const REASON_MAX = 500;
export const NOTE_MAX = 500;
export const HOLIDAY_NAME_MAX = 80;
export const ADJUST_MAX = 60;                                   // |delta| of one HR adjustment / opening
export const LEAVE_POLICIES = ['fraternitas'];                  // D1: employees.leave_policy (null = not covered)
export const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'withdrawn', 'cancelled'];
export const OPEN_STATUSES = ['pending', 'approved'];           // these block overlapping dates
export const LEDGER_KINDS = ['opening', 'accrual', 'taken', 'cancelled', 'carry_over', 'lapse', 'adjustment'];
export const HOLIDAY_KINDS = ['fixed', 'optional'];
export const START_HALVES = ['full', 'second'];                 // multi-day: the first day is full or its second half only
export const END_HALVES = ['full', 'first'];                    // multi-day: the last day is full or its first half only
export const SINGLE_HALVES = ['full', 'first', 'second'];
export const DEFAULT_CUTOVER_MONTH = '2026-12';

// Labels. TYPE_LABELS is for the person / their chain / HR. MAIL_TYPE_LABELS is what an email may say (D12): PERIOD
// is never named in a mail — "Leave".
export const TYPE_LABELS = { PL: 'Privilege leave', SL: 'Sick leave', PERIOD: 'Period leave', OPTIONAL_HOLIDAY: 'Optional holiday' };
export const MAIL_TYPE_LABELS = { PL: 'Privilege leave', SL: 'Sick leave', PERIOD: 'Leave', OPTIONAL_HOLIDAY: 'Optional holiday' };

// Error copy for errCode(code, LEAVE_COPY[code], status). The codes are the plan's API table (+ the input ones).
export const LEAVE_COPY = {
  not_covered: 'Leave in Podium is not set up for this person',
  no_working_days: 'Those dates have no working days (weekends and holidays are free)',
  crosses_year: 'A request cannot cross 31 December — apply for each year separately',
  overlap: 'You already have a pending or approved request on those dates',
  notice: 'This leave must be applied for before it starts (sick leave: up to 7 days after)',
  period_not_eligible: 'Period leave is not available for this person',
  period_used: 'Period leave for that month is already used or requested',
  optional_used: 'The optional holiday for that year is already used or requested',
  not_optional_holiday: 'Pick one date from the optional holiday list',
  too_long: `One request can cover at most ${MAX_REQUEST_DAYS} working days`,
  period_one_day: 'Period leave is one day at most',
  no_holiday_list: "The holiday list for that year isn't in Podium yet — ask HR to add it",
  balance_changed: 'The balance changed since this was loaded — reload and check again',
  not_pending: 'This request is no longer pending',
  not_approved: 'Only an approved request can be cancelled',
  no_self_approval: 'You cannot decide your own leave',
  forbidden: 'You cannot do that for this request',
  opening_exists: 'An opening balance is already set — use an adjustment instead',
  bad_type: 'Pick a leave type',
  bad_dates: 'Pick valid start and end dates',
  bad_half: 'Pick valid half-day options',
  reason_too_long: `Reason is limited to ${REASON_MAX} characters`,
  note_required: 'A note is required',
  note_too_long: `Note is limited to ${NOTE_MAX} characters`,
  bad_amount: 'Enter a number of days in steps of 0.5',
  bad_month: 'Pick a month (YYYY-MM)',
  cutover_locked: 'Accruals already exist before that month — the cutover can only move earlier',
  bad_holiday: 'Enter a date, a name and fixed / optional',
  holiday_past: 'Only a future holiday can be added or deleted',
  bad_decision: 'Decision must be approve or reject',
  not_found: 'Not found',
};

// no_holiday_list names the year (the leave's year has no fixed holiday in podium.holidays — 2027 must be added).
export const noHolidayListMessage = (year) => `The holiday list for ${year} isn't in Podium yet — ask HR to add it`;
// The leave's year has zero kind='fixed' holidays → refuse rather than count every weekday (a missing list, not a
// year without holidays). holidays: that year's rows.
export const holidayListMissing = (holidays) => !(holidays || []).some(h => h.kind === 'fixed');

// ── dates ────────────────────────────────────────────────────────────────────
export function isIsoDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
export const isMonth = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
export const monthOf = (iso) => String(iso).slice(0, 7);
export const yearOf = (iso) => Number(String(iso).slice(0, 4));
export function addMonths(ym, n) {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, '0')}`;
}
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const dow = (iso) => new Date(iso + 'T00:00:00Z').getUTCDay();   // 0 Sun … 6 Sat
export const isWeekend = (iso) => { const w = dow(iso); return w === 0 || w === 6; };

const toHalves = (n) => Math.round(Number(n) * 2);
const fromHalves = (h) => h / 2;
export const isHalfStep = (n) => Number.isFinite(Number(n)) && Math.abs(Number(n) * 2 - Math.round(Number(n) * 2)) < 1e-9;

// ── D6: day count ────────────────────────────────────────────────────────────
// Mon–Fri (L6) minus fixed holidays; a weekend holiday changes nothing (L10); optional holidays are working days.
// Halves are as normalised by normaliseHalves. → { days } | { error }
export function countLeaveDays({ start_date, end_date, start_half = 'full', end_half = 'full' }, fixedHolidays = new Set()) {
  if (!isIsoDay(start_date) || !isIsoDay(end_date) || end_date < start_date) return { error: 'bad_dates' };
  if (start_date.slice(0, 4) !== end_date.slice(0, 4)) return { error: 'crosses_year' };
  const fixed = fixedHolidays instanceof Set ? fixedHolidays : new Set(fixedHolidays || []);
  const working = (d) => !isWeekend(d) && !fixed.has(d);
  let halves = 0;
  if (start_date === end_date) {
    if (!SINGLE_HALVES.includes(start_half)) return { error: 'bad_half' };
    if (working(start_date)) halves = start_half === 'full' ? 2 : 1;
  } else {
    if (!START_HALVES.includes(start_half) || !END_HALVES.includes(end_half)) return { error: 'bad_half' };
    let guard = 0;
    for (let d = start_date; d <= end_date && guard++ < 400; d = addDays(d, 1)) {
      if (!working(d)) continue;
      if (d === start_date) halves += start_half === 'full' ? 2 : 1;
      else if (d === end_date) halves += end_half === 'full' ? 2 : 1;
      else halves += 2;
    }
  }
  return { days: fromHalves(halves) };
}

// A single day carries its half on BOTH fields (start_half = end_half ∈ full|first|second — the 0016 CHECK); the app
// may send it on either. Multi-day: start_half ∈ full|second, end_half ∈ full|first. → { start_half, end_half } | { error }
export function normaliseHalves(start_date, end_date, sh, eh) {
  const s = sh == null || sh === '' ? 'full' : String(sh), e = eh == null || eh === '' ? 'full' : String(eh);
  if (start_date === end_date) {
    if (!SINGLE_HALVES.includes(s) || !SINGLE_HALVES.includes(e)) return { error: 'bad_half' };
    if (s !== 'full' && e !== 'full' && s !== e) return { error: 'bad_half' };
    const h = s !== 'full' ? s : e;
    return { start_half: h, end_half: h };
  }
  if (!START_HALVES.includes(s) || !END_HALVES.includes(e)) return { error: 'bad_half' };
  return { start_half: s, end_half: e };
}

// ── input validation (D2 / D6 / D8) ──────────────────────────────────────────
// ctx: { today (IST), gender, holidays: [{date, kind}], notice (false when HR records for someone else) }
// → { value: {leave_type, start_date, end_date, start_half, end_half, days, reason} } | { error }
export function validateLeaveInput(d, { today, gender = null, holidays = [], notice = true } = {}) {
  const t = String(d?.leave_type || '');
  if (!LEAVE_TYPES.includes(t)) return { error: 'bad_type' };
  const start = d?.start_date, end = d?.end_date || d?.start_date;
  if (!isIsoDay(start) || !isIsoDay(end) || end < start) return { error: 'bad_dates' };
  if (start.slice(0, 4) !== end.slice(0, 4)) return { error: 'crosses_year' };
  const hv = normaliseHalves(start, end, d?.start_half, d?.end_half);
  if (hv.error) return hv;
  const reason = d?.reason == null ? null : String(d.reason).trim() || null;
  if (reason && reason.length > REASON_MAX) return { error: 'reason_too_long' };
  if (t === 'PERIOD') {
    if (gender !== 'f') return { error: 'period_not_eligible' };
    if (start !== end) return { error: 'period_one_day' };           // max 1 day per request
  }
  if (t === 'OPTIONAL_HOLIDAY') {
    if (start !== end || hv.start_half !== 'full') return { error: 'not_optional_holiday' };
    if (!(holidays || []).some(h => h.date === start && h.kind === 'optional')) return { error: 'not_optional_holiday' };
  }
  const fixed = new Set((holidays || []).filter(h => h.kind === 'fixed').map(h => h.date));
  const c = countLeaveDays({ start_date: start, end_date: end, ...hv }, fixed);
  if (c.error) return c;
  if (c.days <= 0) return { error: 'no_working_days' };
  if (c.days > MAX_REQUEST_DAYS) return { error: 'too_long' };
  if (notice && isIsoDay(today)) {
    const earliest = t === 'SL' ? addDays(today, -SL_BACKDATE_DAYS) : today;
    if (start < earliest) return { error: 'notice' };
  }
  return { value: { leave_type: t, start_date: start, end_date: end, ...hv, days: c.days, reason } };
}

// ── D4: accrual ──────────────────────────────────────────────────────────────
// The months that earn, from `from` through `to` (YYYY-MM, inclusive): none while leave_policy is null; from
// max(cutover, join month, month of leave_covered_from) — the join month only if date_joined's day ≤ 15 (L3); none
// after the month of date_exited. leave_covered_from (0016) is set when HR turns coverage on (null = since the
// cutover, the D1 seed), so an off → on gap never back-fills.
export function earningMonths(emp, cutoverMonth, from, to) {
  if (!emp?.leave_policy || !isMonth(cutoverMonth) || !isMonth(from) || !isMonth(to)) return [];
  let first = from < cutoverMonth ? cutoverMonth : from;
  if (isIsoDay(emp.date_joined)) {
    const jm = monthOf(emp.date_joined);
    const joinFirst = Number(emp.date_joined.slice(8, 10)) <= 15 ? jm : addMonths(jm, 1);
    if (joinFirst > first) first = joinFirst;
  }
  const cf = emp.leave_covered_from ? String(emp.leave_covered_from).slice(0, 10) : null;
  if (isIsoDay(cf) && monthOf(cf) > first) first = monthOf(cf);
  let last = to;
  if (isIsoDay(emp.date_exited) && monthOf(emp.date_exited) < last) last = monthOf(emp.date_exited);
  const out = [];
  for (let m = first, g = 0; m <= last && g++ < 1200; m = addMonths(m, 1)) out.push(m);
  return out;
}

// D1 coverage history: off → on (null → a policy) stamps employees.leave_covered_from = the 1st of the current IST
// month; on → off leaves it (accrual stops because the policy is null). → the date to write | undefined (no change)
export const coveredFromOnChange = (was, next, today) => (!was && next && isIsoDay(today) ? `${monthOf(today)}-01` : undefined);

// Missing accrual rows for one employee through currentMonth. existing: Set of 'PL:2026-12' keys already in the ledger.
// → [{ employee_id, leave_type, delta, kind:'accrual', period, effective_date }]
export function accrualPlan({ employee, cutoverMonth, currentMonth, existing = new Set() }) {
  const rows = [];
  for (const m of earningMonths(employee, cutoverMonth, cutoverMonth, currentMonth)) {
    for (const t of LEDGER_TYPES) {
      if (existing.has(`${t}:${m}`)) continue;
      rows.push({ employee_id: employee.id, leave_type: t, delta: ACCRUAL_RATE[t], kind: 'accrual', period: m, effective_date: `${m}-01` });
    }
  }
  return rows;
}

// ── D5: year end ─────────────────────────────────────────────────────────────
// For each completed calendar year Y ≥ the cutover year not yet closed: closing(type) = Σ delta with
// effective_date ≤ Y-12-31 (including the lapse rows this plan adds for earlier years). PL > 5 → lapse −(closing−5);
// SL > 0 → lapse −closing; a negative closing carries as is (no row). → { years: [Y…], rows: [lapse rows] }
// A year is NOT closed while the person has a PENDING PL / SL request starting on or before Y-12-31 (requests:
// [{leave_type, status, start_date}]) — its decision would move the closing; a later read closes it. Later years wait
// too (their closing chains on this one's lapse). A change after the close is re-closed in the RPC (leave_reclose).
export function yearClosePlan({ employeeId, cutoverMonth, currentYear, closedYears = new Set(), ledger = [], requests = [] }) {
  const years = [], rows = [];
  if (!isMonth(cutoverMonth)) return { years, rows };
  const running = (ledger || []).map(r => ({ leave_type: r.leave_type, delta: r.delta, effective_date: String(r.effective_date).slice(0, 10) }));
  const pendingStarts = (requests || []).filter(r => r.status === 'pending' && LEDGER_TYPES.includes(r.leave_type)).map(r => String(r.start_date).slice(0, 10));
  for (let y = Number(cutoverMonth.slice(0, 4)); y < currentYear; y++) {
    if (closedYears.has(y)) continue;
    if (pendingStarts.some(d => d <= `${y}-12-31`)) break;
    const end = `${y}-12-31`;
    for (const t of LEDGER_TYPES) {
      const h = running.filter(r => r.leave_type === t && r.effective_date <= end).reduce((s, r) => s + toHalves(r.delta), 0);
      const keep = t === 'PL' ? toHalves(PL_CARRY_MAX) : 0;
      if (h > keep) {
        const row = { employee_id: employeeId, leave_type: t, delta: fromHalves(-(h - keep)), kind: 'lapse', period: String(y), effective_date: end };
        rows.push(row);
        running.push(row);
      }
    }
    years.push(y);
  }
  return { years, rows };
}

// Re-close after a late change (mirror of podium.leave_reclose in 0016, called by leave_decide approve and
// leave_cancel cancel): for the request's year Y and each consecutive closed year after it, closing = Σ delta of the
// type with effective_date ≤ Y-12-31 EXCLUDING Y's own lapse row; keep = 5 PL / 0 SL; lapse = −(closing − keep) when
// closing > keep, else no row. ledger rows: {leave_type, delta, kind, period, effective_date}.
// → [{ year, leave_type, old, new }] — only the years whose lapse changes (old / new = the lapse delta or null).
export function reclosePlan({ ledger = [], leaveType, fromYear, closedYears = new Set() }) {
  const running = (ledger || []).map(r => ({ leave_type: r.leave_type, delta: Number(r.delta), kind: r.kind, period: r.period == null ? null : String(r.period),
    effective_date: String(r.effective_date).slice(0, 10) }));
  const keep = leaveType === 'PL' ? toHalves(PL_CARRY_MAX) : 0;
  const out = [];
  for (let y = fromYear, g = 0; closedYears.has(y) && g++ < 100; y++) {
    const end = `${y}-12-31`, per = String(y);
    const isLapse = (r) => r.leave_type === leaveType && r.kind === 'lapse' && r.period === per;
    const i = running.findIndex(isLapse);
    const old = i >= 0 ? running[i].delta : null;
    const h = running.filter(r => r.leave_type === leaveType && r.effective_date <= end && !isLapse(r)).reduce((s, r) => s + toHalves(r.delta), 0);
    const nw = h > keep ? fromHalves(-(h - keep)) : null;
    if ((old == null ? null : toHalves(old)) === (nw == null ? null : toHalves(nw))) continue;
    out.push({ year: y, leave_type: leaveType, old, new: nw });
    if (i >= 0) running.splice(i, 1);
    if (nw != null) running.push({ leave_type: leaveType, delta: nw, kind: 'lapse', period: per, effective_date: end });
  }
  return out;
}

// ── D7: borrow cap + split ───────────────────────────────────────────────────
// cap = the accruals still to come in the leave's calendar year after the current IST month (a next-year leave: that
// whole year), counted with the same earning rules (cutover, join, exit). A past year → 0.
export function borrowCap({ leaveType, leaveYear, currentMonth, employee, cutoverMonth }) {
  if (!LEDGER_TYPES.includes(leaveType) || !isMonth(currentMonth)) return 0;
  const cy = Number(currentMonth.slice(0, 4));
  if (leaveYear < cy) return 0;
  const from = leaveYear === cy ? addMonths(currentMonth, 1) : `${leaveYear}-01`;
  const to = `${leaveYear}-12`;
  if (from > to) return 0;
  return fromHalves(earningMonths(employee, cutoverMonth, from, to).length * toHalves(ACCRUAL_RATE[leaveType]));
}

// The base balance a split starts from. A leave in a LATER calendar year than today (IST) sees only what will carry
// into that year: PL min(balance, 5), SL min(balance, 0) — a negative balance stays negative. The snapshot the RPC
// re-checks is still the raw ledger balance; only the split uses this.
export function splitBase({ leaveType, balance, leaveYear, currentYear }) {
  const b = Number(balance) || 0;
  if (!(leaveYear > currentYear)) return b;
  return Math.min(b, leaveType === 'PL' ? PL_CARRY_MAX : 0);
}

// Σ delta of ledger rows of one type.
export function ledgerBalance(ledger, type) {
  return fromHalves((ledger || []).filter(r => r.leave_type === type).reduce((s, r) => s + toHalves(r.delta), 0));
}
// What the person's OTHER pending requests of this type will debit when approved: Σ (days − lop_days).
// (The plan says Σ days; LOP days are never debited, so counting them would double-penalise a mostly-unpaid request.)
export function pendingDebit(requests, type, exceptId = null) {
  return fromHalves((requests || []).filter(r => r.status === 'pending' && r.leave_type === type && r.id !== exceptId)
    .reduce((s, r) => s + toHalves(r.days) - toHalves(r.lop_days || 0), 0));
}

// The request's days come first from max(available, 0), then are borrowed while balance ≥ −cap, the rest is LOP.
// available = balance − pending. → { available, from_balance, borrowed_days, lop_days }
export function splitLeave({ days, balance = 0, pending = 0, cap = 0 }) {
  const d = toHalves(days), a = toHalves(balance) - toHalves(pending), c = Math.max(0, toHalves(cap));
  const from = Math.max(0, Math.min(d, Math.max(a, 0)));
  const rem = d - from;
  const room = Math.max(0, a - from + c);
  const borrowed = Math.min(rem, room);
  return { available: fromHalves(a), from_balance: fromHalves(from), borrowed_days: fromHalves(borrowed), lop_days: fromHalves(rem - borrowed) };
}
export const sameSplit = (a, b) => !!a && !!b && toHalves(a.borrowed_days) === toHalves(b.borrowed_days) && toHalves(a.lop_days) === toHalves(b.lop_days);

// PERIOD: 1 day per calendar month (half days allowed: two halves use it up). OPTIONAL_HOLIDAY: 1 per calendar year.
// Counted over pending + approved requests. → days used
export function periodUsed(requests, month, exceptId = null) {
  return fromHalves((requests || []).filter(r => r.leave_type === 'PERIOD' && OPEN_STATUSES.includes(r.status) && r.id !== exceptId
    && monthOf(r.start_date) === month).reduce((s, r) => s + toHalves(r.days), 0));
}
export function optionalUsed(requests, year, exceptId = null) {
  return (requests || []).filter(r => r.leave_type === 'OPTIONAL_HOLIDAY' && OPEN_STATUSES.includes(r.status) && r.id !== exceptId
    && yearOf(r.start_date) === year).length;
}
// The per-month / per-year limit check for a validated request (the RPC re-checks under the lock). → code | null
export function limitBlock(v, requests) {
  if (v.leave_type === 'PERIOD' && periodUsed(requests, monthOf(v.start_date)) + v.days > 1) return 'period_used';
  if (v.leave_type === 'OPTIONAL_HOLIDAY' && optionalUsed(requests, yearOf(v.start_date)) > 0) return 'optional_used';
  return null;
}
// Same-date check (any type, pending / approved). The RPC re-checks under the per-employee lock.
export function overlaps(requests, start, end, exceptId = null) {
  return (requests || []).some(r => r.id !== exceptId && OPEN_STATUSES.includes(r.status) && r.start_date <= end && r.end_date >= start);
}

// ── D9 / D10: who may decide / withdraw / cancel ─────────────────────────────
// req: { employee_id, approver_employee_id, status, start_date }; approverManagerId = the approver's own manager (cover).
export function decideBlock({ req, meId, hr, approverManagerId = null }) {
  if (meId && meId === req.employee_id) return 'no_self_approval';
  if (hr) return null;
  if (meId && req.approver_employee_id && (meId === req.approver_employee_id || meId === approverManagerId)) return null;
  return 'forbidden';
}
// mode 'withdraw': a pending request, by the person (or HR). mode 'cancel': an approved one — by the person while it
// has not started (start_date > today), by the approver / their manager / HR otherwise (never the person once started).
export function cancelBlock({ mode, req, meId, hr, approverManagerId = null, today }) {
  const self = !!meId && meId === req.employee_id;
  if (mode === 'withdraw') {
    if (req.status !== 'pending') return 'not_pending';
    return self || hr ? null : 'forbidden';
  }
  if (req.status !== 'approved') return 'not_approved';
  if (self) return req.start_date > today ? null : 'forbidden';
  if (hr) return null;
  if (meId && req.approver_employee_id && (meId === req.approver_employee_id || meId === approverManagerId)) return null;
  return 'forbidden';
}

// ── D9: approver at submit ───────────────────────────────────────────────────
// manager_id; no manager → the other founder when the person is a founder; else null (HR decides).
export function resolveLeaveApprover(emp, founders = []) {
  if (emp?.manager_id) return emp.manager_id;
  if ((founders || []).includes(emp?.id)) return (founders || []).find(f => f !== emp.id) || null;
  return null;
}

// ── D12: email ───────────────────────────────────────────────────────────────
export const leaveMessageId = (requestId, kind, nonce) => `<podium-leave-${requestId}-${kind}-${nonce}@legendoftoys.com>`;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function dayLabel(iso) { return `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`; }
const HALF_LABEL = { first: ' (first half)', second: ' (second half)', full: '' };
export function rangeLabel(r) {
  if (r.start_date === r.end_date) return `${dayLabel(r.start_date)}${HALF_LABEL[r.start_half] || ''}`;
  return `${dayLabel(r.start_date)}${HALF_LABEL[r.start_half] || ''} – ${dayLabel(r.end_date)}${HALF_LABEL[r.end_half] || ''}`;
}
const dayCount = (n) => `${Number(n)} day${Number(n) === 1 ? '' : 's'}`;

// kind: 'submitted' (to the approver) | 'approved' | 'rejected' | 'cancelled' | 'withdrawn' (to the person).
// Names the person, the MAIL label, dates and day count, links /leave. NEVER the reason, a borrowed / LOP figure or
// the decision note (D12). → { raw, subject, text } | { error }
export function buildLeaveMail({ kind, from, fromName = '', to, toFirst = '', personName, request, link, messageId }) {
  const f = String(from || '').trim(), t = String(to || '').trim();
  if (!addressOk(f)) return { error: 'bad_sender' };
  if (!addressOk(t)) return { error: 'bad_recipient' };
  if (!/^<[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+>$/.test(String(messageId || ''))) return { error: 'bad_message_id' };
  if (!['submitted', 'approved', 'rejected', 'cancelled', 'withdrawn'].includes(kind)) return { error: 'bad_kind' };
  const clean = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
  const label = MAIL_TYPE_LABELS[request.leave_type] || 'Leave';
  const when = rangeLabel(request), count = dayCount(request.days);
  const who = clean(personName);
  const subject = kind === 'submitted' ? `Leave request: ${who} — ${label}, ${when}`
    : `Your leave request was ${kind}: ${label}, ${when}`;
  const body = kind === 'submitted'
    ? `${who} has requested ${label.toLowerCase()} for ${when} (${count}).`
    : `Your ${label.toLowerCase()} for ${when} (${count}) was ${kind}${clean(fromName) ? ` by ${clean(fromName)}` : ''}.`;
  const name = clean(fromName).replace(/["\\<>]/g, '');
  const text = [
    `Hi ${clean(toFirst) || 'there'},`, '', body, '',
    kind === 'submitted' ? `Review it in Podium: ${clean(link)}` : `See it in Podium: ${clean(link)}`, '',
    name ? `Thanks,\n${name}` : 'Thanks',
  ].join('\n');
  const headers = [
    `From: ${name ? `${/^[\x20-\x7E]*$/.test(name) ? `"${name}"` : encodeHeaderWords(name)} <${f}>` : f}`,
    `To: ${t}`,
    `Subject: ${encodeHeaderWords(subject)}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ];
  return { raw: headers.join('\r\n') + '\r\n\r\n' + text.replace(/\r?\n/g, '\r\n'), subject, text };
}

// ── HR inputs ────────────────────────────────────────────────────────────────
// An opening / adjustment amount: a 0.5 step, |n| ≤ ADJUST_MAX; an adjustment may not be 0. → { value } | { error }
export function cleanAmount(v, { allowZero = false } = {}) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return { error: 'bad_amount' };
  const n = Number(v);
  if (!Number.isFinite(n) || !isHalfStep(n) || Math.abs(n) > ADJUST_MAX) return { error: 'bad_amount' };
  if (!allowZero && n === 0) return { error: 'bad_amount' };
  return { value: fromHalves(toHalves(n)) };
}
export function cleanNote(v, { required = false } = {}) {
  const s = v == null ? '' : String(v).trim();
  if (!s) return required ? { error: 'note_required' } : { value: null };
  if (s.length > NOTE_MAX) return { error: 'note_too_long' };
  return { value: s };
}
export function cleanHoliday(d) {
  const date = d?.date, name = String(d?.name ?? '').replace(/\s+/g, ' ').trim(), kind = String(d?.kind || '');
  if (!isIsoDay(date) || !name || name.length > HOLIDAY_NAME_MAX || !HOLIDAY_KINDS.includes(kind)) return { error: 'bad_holiday' };
  return { value: { date, name, kind } };
}

// A function's own `raise exception '<code>'` comes back as PostgREST { message: '<code>' }. → code | null
export function leaveDbErrorCode(r) {
  const d = r?.data || {};
  const m = String(d.message || '');
  for (const c of ['not_covered', 'overlap', 'period_used', 'optional_used', 'not_optional_holiday', 'balance_changed', 'not_pending',
    'not_approved', 'no_self_approval', 'note_required', 'not_found', 'bad_decision', 'bad_mode']) {
    if (m === c) return c;
  }
  if (d.code === '23514' && /no_self_approval/.test(m)) return 'no_self_approval';
  if (d.code === '23505' && /opening/.test(m)) return 'opening_exists';
  if (d.code === '23505') return 'balance_changed';
  if (d.code === '23514') return 'check_failed';
  return null;
}
