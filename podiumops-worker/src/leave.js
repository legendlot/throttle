// Leave R1 — apply, approve, balances, holidays. The PURE rules (no I/O), unit-tested in test/leave.test.mjs.
// Plan: docs/superpowers/plans/2026-11-13-podium-leave-r1.md (decisions D1–D15) · spec L1–L10.
//
// The ledger (podium.leave_ledger, migration 0016) is the ONLY balance: Σ delta per type (D3). Accrual and the
// year-end lapse are written lazily by ensureLeaveCurrent (index.js) from accrualPlan / yearClosePlan here — no cron.
// All day arithmetic runs in HALF-DAY units (integers) so 0.5 steps never pick up float error.

import { encodeHeaderWords, addressOk } from './offerlink.js';

// ── D2: types + policy constants (match the migration CHECKs) ─────────────────
// R2 (0020): MATERNITY / PATERNITY are HR grants (E3, grantLeave — never applied); WFH is applied like leave (E4) but has
// no ledger, no balance and no LOP. Only APPLY_TYPES go through applyLeave / previewLeave.
export const LEAVE_TYPES = ['PL', 'SL', 'PERIOD', 'OPTIONAL_HOLIDAY', 'MATERNITY', 'PATERNITY', 'WFH'];
export const APPLY_TYPES = ['PL', 'SL', 'PERIOD', 'OPTIONAL_HOLIDAY', 'WFH'];
export const GRANT_TYPES = ['MATERNITY', 'PATERNITY'];
export const MATERNITY_CALENDAR_DAYS = 182;                     // 26 weeks (L9), calendar days from the start
export const PATERNITY_WORKING_DAYS = 15;                       // ⚠️ plan default: working days (Mon–Fri minus fixed holidays)
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
export const TYPE_LABELS = { PL: 'Privilege leave', SL: 'Sick leave', PERIOD: 'Period leave', OPTIONAL_HOLIDAY: 'Optional holiday',
  MATERNITY: 'Maternity leave', PATERNITY: 'Paternity leave', WFH: 'Work from home' };
export const MAIL_TYPE_LABELS = { PL: 'Privilege leave', SL: 'Sick leave', PERIOD: 'Leave', OPTIONAL_HOLIDAY: 'Optional holiday',
  MATERNITY: 'Maternity leave', PATERNITY: 'Paternity leave', WFH: 'Work from home' };

// Error copy for errCode(code, LEAVE_COPY[code], status). The codes are the plan's API table (+ the input ones).
export const LEAVE_COPY = {
  not_covered: 'Leave in Podium is not set up for this person',
  no_working_days: 'Those dates have no working days (weekends and holidays are free)',
  crosses_year: 'A request cannot cross 31 December — apply for each year separately',
  too_far: 'Leave can be applied at most for next calendar year',
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
  // R2
  grant_only: 'Maternity and paternity leave are granted by HR',
  gender_unknown: "Fill the person's gender first",
  maternity_not_eligible: 'Maternity leave can be granted only to a person recorded as female',
  paternity_not_eligible: 'Paternity leave can be granted only to a person recorded as male',
  grant_too_long: 'The end date is after the full leave length (maternity 182 calendar days, paternity 15 working days)',
  report_changed: 'The report changed since you loaded it — reload, download again, then mark exported',
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
  if (GRANT_TYPES.includes(t)) return { error: 'grant_only' };
  if (!APPLY_TYPES.includes(t)) return { error: 'bad_type' };
  const start = d?.start_date, end = d?.end_date || d?.start_date;
  if (!isIsoDay(start) || !isIsoDay(end) || end < start) return { error: 'bad_dates' };
  if (start.slice(0, 4) !== end.slice(0, 4)) return { error: 'crosses_year' };
  // At most next calendar year — the split's carry view (splitBase) looks one year ahead, never two.
  if (isIsoDay(today) && Number(start.slice(0, 4)) > Number(today.slice(0, 4)) + 1) return { error: 'too_far' };
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
    const earliest = t === 'SL' || t === 'WFH' ? addDays(today, -SL_BACKDATE_DAYS) : today;   // E4: WFH as SL
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
// Pure mirror of podium.leave_close_years (0017), which does the real close under the per-employee lock. A pending
// request does NOT hold the close (Codex S453: an old pending request kept expired credit spendable forever): its
// later approve / cancel re-closes the year in the RPC (leave_reclose), and its split uses the pre-lapse closing
// (splitBase, past year).
export function yearClosePlan({ employeeId, cutoverMonth, currentYear, closedYears = new Set(), ledger = [] }) {
  const years = [], rows = [];
  if (!isMonth(cutoverMonth)) return { years, rows };
  const running = (ledger || []).map(r => ({ leave_type: r.leave_type, delta: r.delta, effective_date: String(r.effective_date).slice(0, 10) }));
  for (let y = Number(cutoverMonth.slice(0, 4)); y < currentYear; y++) {
    if (closedYears.has(y)) continue;
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

// The base balance a split starts from, per the leave's calendar year Y vs today's year C. pre = Σ rows dated ≤ C-12-31,
// post = Σ rows dated after (next-year leave already taken), keep = 5 PL / 0 SL.
// · Y < C (a pending request from a closed year, or an SL backdate): Y's own closing BEFORE its lapse — Σ rows
//   dated ≤ Y-12-31 except Y's lapse row. Approving it re-closes Y (leave_reclose), so the lapse shrinks to match.
// · Y = C: pre, but no more than keeps next year inside its cap: using x now leaves min(pre − x, keep) + post for
//   next year, which must stay ≥ −nextCap → x ≤ max(pre − keep, pre + post + nextCap). No post rows → just pre.
// · Y = C + 1: what carries plus next year's own rows: min(pre, keep) + post (Codex S453: clamping the raw sum let
//   two next-year requests both borrow the full cap).
// The snapshot the RPC re-checks is still the raw balance; only the split uses this. nextCap = borrowCap for C + 1.
export function splitBase({ leaveType, ledger = [], leaveYear, currentYear, nextCap = 0 }) {
  const rows = (ledger || []).filter(r => r.leave_type === leaveType)
    .map(r => ({ h: toHalves(r.delta), d: String(r.effective_date).slice(0, 10), kind: r.kind, period: r.period == null ? null : String(r.period) }));
  const sum = (f) => rows.filter(f).reduce((s, r) => s + r.h, 0);
  const keep = leaveType === 'PL' ? toHalves(PL_CARRY_MAX) : 0;
  if (leaveYear < currentYear) {
    const end = `${leaveYear}-12-31`, per = String(leaveYear);
    return fromHalves(sum(r => r.d <= end && !(r.kind === 'lapse' && r.period === per)));
  }
  const end = `${currentYear}-12-31`;
  const pre = sum(r => r.d <= end), post = sum(r => r.d > end);
  if (leaveYear > currentYear) return fromHalves(Math.min(pre, keep) + post);
  if (!rows.some(r => r.d > end)) return fromHalves(pre);
  return fromHalves(Math.min(pre, Math.max(pre - keep, pre + post + Math.max(0, toHalves(nextCap)))));
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
  if (GRANT_TYPES.includes(req.leave_type)) return hr && !self ? null : 'forbidden';   // E3: HR ends / corrects a grant
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

// kind: 'submitted' (to the approver) | 'approved' | 'rejected' | 'cancelled' | 'withdrawn' | 'granted' (to the person).
// Names the person, the MAIL label, dates and day count, links /leave. NEVER the reason, a borrowed / LOP figure or
// the decision note (D12). → { raw, subject, text } | { error }
export function buildLeaveMail({ kind, from, fromName = '', to, toFirst = '', personName, request, link, messageId }) {
  const f = String(from || '').trim(), t = String(to || '').trim();
  if (!addressOk(f)) return { error: 'bad_sender' };
  if (!addressOk(t)) return { error: 'bad_recipient' };
  if (!/^<[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+>$/.test(String(messageId || ''))) return { error: 'bad_message_id' };
  if (!['submitted', 'approved', 'rejected', 'cancelled', 'withdrawn', 'granted'].includes(kind)) return { error: 'bad_kind' };
  const clean = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
  const label = MAIL_TYPE_LABELS[request.leave_type] || 'Leave';
  const when = rangeLabel(request), count = dayCount(request.days);
  const who = clean(personName);
  const subject = kind === 'submitted' ? `Leave request: ${who} — ${label}, ${when}`
    : kind === 'granted' ? `Leave granted: ${label}, ${when}`
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
    'not_approved', 'no_self_approval', 'note_required', 'not_found', 'bad_decision', 'bad_mode',
    'bad_type', 'gender_unknown', 'maternity_not_eligible', 'paternity_not_eligible']) {
    if (m === c) return c;
  }
  if (d.code === '23514' && /no_self_approval/.test(m)) return 'no_self_approval';
  if (d.code === '23505' && /opening/.test(m)) return 'opening_exists';
  if (d.code === '23505') return 'balance_changed';
  if (d.code === '23514') return 'check_failed';
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// Leave R2 — LOP report (E1), exit leave fill (E2), maternity / paternity (E3), WFH (E4), year-end preview (E5).
// Plan: docs/superpowers/plans/2026-11-13-podium-leave-r2.md · migration 0020.
// ════════════════════════════════════════════════════════════════════════════

// ── E1: which halves of a request are unpaid ─────────────────────────────────
// A request's working halves in date order (Mon–Fri minus fixed holidays; the start / end half rules of
// countLeaveDays). → [{ date, half: 'first' | 'second' }]
export function workingHalves({ start_date, end_date, start_half = 'full', end_half = 'full' }, fixedHolidays = new Set()) {
  if (!isIsoDay(start_date) || !isIsoDay(end_date) || end_date < start_date) return [];
  const fixed = fixedHolidays instanceof Set ? fixedHolidays : new Set(fixedHolidays || []);
  const out = [];
  const push = (d, which) => { for (const h of which) out.push({ date: d, half: h }); };
  let guard = 0;
  for (let d = start_date; d <= end_date && guard++ < 400; d = addDays(d, 1)) {
    if (isWeekend(d) || fixed.has(d)) continue;
    if (start_date === end_date) push(d, start_half === 'first' ? ['first'] : start_half === 'second' ? ['second'] : ['first', 'second']);
    else if (d === start_date) push(d, start_half === 'second' ? ['second'] : ['first', 'second']);
    else if (d === end_date) push(d, end_half === 'first' ? ['first'] : ['first', 'second']);
    else push(d, ['first', 'second']);
  }
  return out;
}
// Halves → [{ date, half: 'full' | 'first' | 'second' }] (both halves of a day = full).
function halvesToDates(halves) {
  const by = new Map();
  for (const h of halves) (by.get(h.date) || by.set(h.date, []).get(h.date)).push(h.half);
  return [...by.entries()].map(([date, hs]) => ({ date, half: hs.length >= 2 ? 'full' : hs[0] }));
}

// Balance first, then borrow, then LOP — in date order — so the LOP days are the LAST lop_days × 2 working halves of
// the request (D7). Today's holiday list may give a different count from the frozen `days` (a holiday added / removed
// after submit): allocate over the halves that exist and flag recount_mismatch for HR.
// → { months: { 'YYYY-MM': { days, dates: [{date, half}] } }, lop_days, recount_mismatch }
export function lopAllocation(req, fixedHolidays = new Set()) {
  const halves = workingHalves(req, fixedHolidays);
  const want = Math.max(0, toHalves(req?.lop_days || 0));
  const lop = want ? halves.slice(Math.max(0, halves.length - want)) : [];
  const months = {};
  for (const h of lop) {
    const m = (months[monthOf(h.date)] ||= { halves: [] });
    m.halves.push(h);
  }
  const out = {};
  for (const [m, v] of Object.entries(months)) out[m] = { days: fromHalves(v.halves.length), dates: halvesToDates(v.halves) };
  return { months: out, lop_days: fromHalves(lop.length), recount_mismatch: halves.length !== toHalves(req?.days || 0) };
}

// The payroll rows for one month: one per employee with any unpaid half in it, from APPROVED PL / SL requests only
// (exit-time negative balances are E2's F&F figure, not here). requests: approved rows with lop_days > 0 touching the
// month; employees: { [id]: {employee_code, full_name, razorpayx_employee_id} }; fixedHolidays: a Set of fixed dates.
// warnings = every request touching the month whose working halves no longer match its frozen `days` (a holiday
// changed after submit) — listed even when none of its LOP lands in this month, so HR sees it (review F).
// → { rows: [{ employee_id, employee_code, full_name, razorpayx_employee_id, lop_days, dates, recount_mismatch, request_ids }],
//     warnings: [{ request_id, employee_id, employee_code, full_name, start_date, end_date, lop_days, placed, placed_in_month }] }
export function lopReport({ month, requests = [], employees = {}, fixedHolidays = new Set() }) {
  if (!isMonth(month)) return { rows: [], warnings: [] };
  const by = {}, warnings = [];
  for (const r of requests || []) {
    if (r.status !== 'approved' || !LEDGER_TYPES.includes(r.leave_type) || !(Number(r.lop_days) > 0)) continue;
    const a = lopAllocation(r, fixedHolidays);
    const m = a.months[month];
    const e = employees[r.employee_id] || {};
    if (a.recount_mismatch) {
      warnings.push({ request_id: r.id, employee_id: r.employee_id, employee_code: e.employee_code || null, full_name: e.full_name || null,
        start_date: r.start_date, end_date: r.end_date, lop_days: Number(r.lop_days), placed: a.lop_days, placed_in_month: m ? m.days : 0 });
    }
    if (!m) continue;
    const row = (by[r.employee_id] ||= { employee_id: r.employee_id, employee_code: e.employee_code || null, full_name: e.full_name || null,
      razorpayx_employee_id: e.razorpayx_employee_id || null, h: 0, dates: [], recount_mismatch: false, request_ids: [] });
    row.h += toHalves(m.days);
    row.dates.push(...m.dates);
    row.recount_mismatch = row.recount_mismatch || a.recount_mismatch;
    row.request_ids.push(r.id);
  }
  const byName = (a, b) => String(a.full_name || '').localeCompare(String(b.full_name || '')) || String(a.employee_id).localeCompare(String(b.employee_id));
  const rows = Object.values(by).map(({ h, ...r }) => ({ ...r, lop_days: fromHalves(h), dates: r.dates.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0)) }))
    .sort(byName);
  return { rows, warnings: warnings.sort((a, b) => byName(a, b) || String(a.start_date).localeCompare(String(b.start_date))) };
}

// What is stored on "Mark exported" and hashed for the report (review D): the rows without request ids.
export const lopExportRows = (rows) => (rows || []).map(({ request_ids, ...r }) => r);
// Canonical JSON (object keys sorted at every level) — the report_hash input, so the same rows always hash the same.
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

// What changed since the last export, per person (was X days, now Y; or the same count on other dates).
// → [{ employee_id, employee_code, full_name, was, now, was_dates, now_dates }]
const datesKey = (ds) => (ds || []).map(d => `${d.date}:${d.half}`).join(',');
export function lopDiff(prevRows = [], rows = []) {
  const prev = Object.fromEntries((prevRows || []).map(r => [r.employee_id, r]));
  const cur = Object.fromEntries((rows || []).map(r => [r.employee_id, r]));
  const out = [];
  for (const id of new Set([...Object.keys(prev), ...Object.keys(cur)])) {
    const a = prev[id], b = cur[id];
    const was = a ? Number(a.lop_days) : 0, now = b ? Number(b.lop_days) : 0;
    if (toHalves(was) === toHalves(now) && datesKey(a?.dates) === datesKey(b?.dates)) continue;
    const who = b || a;
    out.push({ employee_id: id, employee_code: who.employee_code || null, full_name: who.full_name || null,
      was, now, was_dates: a?.dates || [], now_dates: b?.dates || [] });
  }
  return out.sort((x, y) => String(x.full_name || '').localeCompare(String(y.full_name || '')));
}

// ── E2: leave figures at the last working day ────────────────────────────────
// PL / SL as at the LWD = the ledger (minus any accrual for a month after the LWD month and any year-close of the LWD's
// year or later — the person is gone by then) + the accruals still to land through the LWD month (earningMonths with
// date_exited = LWD: the exit month earns, nothing after) + the year-end lapse of every year end between today and the
// LWD. Approved leave is already a `taken` row. Negative PL / SL = LOP days for the F&F; SL never pays out (lapses).
// expected = the raw Σ ledger per type, which exit_update_item re-checks under the leave lock.
// → { as_at, PL, SL, lop_days, projected_accrual: {PL, SL}, expected: {PL, SL} } | null (bad input)
export function exitLeaveFigures({ employee, ledger = [], cutoverMonth, lwd, today }) {
  if (!isIsoDay(lwd) || !isIsoDay(today) || !isMonth(cutoverMonth)) return null;
  const lm = monthOf(lwd), ly = yearOf(lwd), cy = yearOf(today);
  const rows = (ledger || []).map(r => ({ leave_type: r.leave_type, h: toHalves(r.delta), kind: r.kind,
    period: r.period == null ? null : String(r.period), d: String(r.effective_date).slice(0, 10) }));
  const expected = Object.fromEntries(LEDGER_TYPES.map(t => [t, fromHalves(rows.filter(r => r.leave_type === t).reduce((s, r) => s + r.h, 0))]));
  const kept = rows.filter(r => !(r.kind === 'accrual' && r.period > lm) && !(r.kind === 'lapse' && Number(r.period) >= ly));
  const have = new Set(kept.filter(r => r.kind === 'accrual').map(r => `${r.leave_type}:${r.period}`));
  const projected = { PL: 0, SL: 0 };
  const months = earningMonths({ ...employee, date_exited: lwd }, cutoverMonth, cutoverMonth, lm);
  for (const m of months) {
    for (const t of LEDGER_TYPES) {
      if (have.has(`${t}:${m}`)) continue;
      const h = toHalves(ACCRUAL_RATE[t]);
      kept.push({ leave_type: t, h, kind: 'accrual', period: m, d: `${m}-01` });
      projected[t] += h;
    }
  }
  // Year ends still to come before the LWD (the lazy close has not run for them yet).
  for (let y = cy; y < ly; y++) {
    const end = `${y}-12-31`;
    for (const t of LEDGER_TYPES) {
      if (kept.some(r => r.leave_type === t && r.kind === 'lapse' && r.period === String(y))) continue;
      const close = kept.filter(r => r.leave_type === t && r.d <= end).reduce((s, r) => s + r.h, 0);
      const keep = t === 'PL' ? toHalves(PL_CARRY_MAX) : 0;
      if (close > keep) kept.push({ leave_type: t, h: -(close - keep), kind: 'lapse', period: String(y), d: end });
    }
  }
  const bal = (t) => kept.filter(r => r.leave_type === t).reduce((s, r) => s + r.h, 0);
  const pl = bal('PL'), sl = bal('SL');
  return { as_at: lwd, PL: fromHalves(pl), SL: fromHalves(sl), lop_days: fromHalves(Math.max(0, -pl) + Math.max(0, -sl)),
    projected_accrual: { PL: fromHalves(projected.PL), SL: fromHalves(projected.SL) }, expected };
}

// The leave line's Done guard (the RPC re-checks under the lock): a pending / approved request ending after the LWD
// (cancel it first) → leave_after_lwd; any pending request → leave_pending. → code | null
export function exitLeaveBlock(requests = [], lwd) {
  if ((requests || []).some(r => OPEN_STATUSES.includes(r.status) && r.end_date > lwd)) return 'leave_after_lwd';
  if ((requests || []).some(r => r.status === 'pending')) return 'leave_pending';
  return null;
}

// Review A: is a CONFIRMED leave line (status done) still true? Stale when a request is pending or an open one ends
// after the LWD, when the LWD moved since (leave_as_at ≠ lwd), or when the ledger sums moved since (ledger = the
// current raw Σ {PL, SL}; null = not covered, skip that part). exit_close re-checks it under the leave lock.
// Re-verify A': a COVERED person's done line with no snapshot (leave_confirmed_at / leave_as_at null — e.g. a confirm
// that landed between updateExit's re-open and its clear) is stale too: fail closed. Not covered = no snapshot by design.
export function exitLeaveStale({ exit, item, requests = [], ledger = null }) {
  if (!exit || !item || item.auto_source !== 'leave_ledger' || item.status !== 'done') return false;
  if (exitLeaveBlock(requests, exit.lwd)) return true;
  if (!exit.leave_confirmed_at || !exit.leave_as_at) return !!ledger;
  if (String(exit.leave_as_at || '').slice(0, 10) !== String(exit.lwd || '').slice(0, 10)) return true;
  if (ledger && (toHalves(ledger.PL) !== toHalves(exit.leave_ledger_pl) || toHalves(ledger.SL) !== toHalves(exit.leave_ledger_sl))) return true;
  return false;
}

// Review I: while an exit is OPEN, its LWD is the exit date for accrual (date_exited is only written at the close).
export const withOpenExit = (emp, lwd) => (emp && !emp.date_exited && isIsoDay(lwd) ? { ...emp, date_exited: lwd } : emp);
// Apply every open exit's LWD to the rows not yet checked (marked `_exit_checked`). readOpenExits(ids) → [{employee_id,
// lwd}] | null. FAIL CLOSED (re-verify I'): a failed read THROWS — nobody is marked checked, so no caller can go on to
// write accruals past an LWD it could not see (the handler turns the throw into a 500).
export async function applyOpenExitsWith(emps, readOpenExits) {
  const list = (emps || []).filter(e => e && !e._exit_checked);
  if (!list.length) return emps || [];
  const rows = await readOpenExits([...new Set(list.map(e => e.id).filter(Boolean))]);
  if (!Array.isArray(rows)) throw new Error('db_error: open exits read');
  const lwd = Object.fromEntries(rows.map(x => [x.employee_id, String(x.lwd).slice(0, 10)]));
  return (emps || []).map(e => (e && !e._exit_checked ? { ...withOpenExit(e, lwd[e.id]), _exit_checked: true } : e));
}

// ── E3: maternity / paternity grant ──────────────────────────────────────────
// MATERNITY: 182 calendar days from the start (end = start + 181), gender 'f', a note required (HR records the
// eligibility check there). PATERNITY: 15 working days from the start (Mon–Fri minus fixed holidays; the end is the
// 15th working day), gender 'm'. Both may cross 31 Dec. holidays: [{date, kind}] for every year the range may touch;
// a touched year with no fixed holiday → no_holiday_list (PATERNITY only — maternity counts calendar days).
// An optional end_date (review C: returning early = cancel + grant again with the actual end) must be ≥ the start and
// ≤ the full-length end; days = the calendar days (MATERNITY) / working days (PATERNITY) in that range.
// → { value: { leave_type, start_date, end_date, start_half, end_half, days, note } } | { error, year? }
export function grantPlan(d, { gender = null, holidays = [], today = null } = {}) {
  const t = String(d?.leave_type || '');
  if (!GRANT_TYPES.includes(t)) return { error: 'bad_type' };
  const start = d?.start_date;
  if (!isIsoDay(start)) return { error: 'bad_dates' };
  if (isIsoDay(today) && yearOf(start) > yearOf(today) + 1) return { error: 'too_far' };
  const n = cleanNote(d?.note, { required: t === 'MATERNITY' });
  if (n.error) return n;
  if (gender !== 'f' && gender !== 'm') return { error: 'gender_unknown' };
  if (t === 'MATERNITY' && gender !== 'f') return { error: 'maternity_not_eligible' };
  if (t === 'PATERNITY' && gender !== 'm') return { error: 'paternity_not_eligible' };
  const base = { leave_type: t, start_date: start, start_half: 'full', end_half: 'full', note: n.value };
  const wantEnd = d?.end_date == null || d.end_date === '' ? null : d.end_date;
  if (wantEnd !== null && (!isIsoDay(wantEnd) || wantEnd < start)) return { error: 'bad_dates' };
  if (t === 'MATERNITY') {
    const full = addDays(start, MATERNITY_CALENDAR_DAYS - 1);
    if (wantEnd && wantEnd > full) return { error: 'grant_too_long' };
    const end = wantEnd || full;
    return { value: { ...base, end_date: end, days: Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86400000) + 1 } };
  }
  const fixed = new Set((holidays || []).filter(h => h.kind === 'fixed').map(h => h.date));
  const working = (x) => !isWeekend(x) && !fixed.has(x);
  let d0 = start, count = 0, guard = 0;
  for (; guard++ < 400; d0 = addDays(d0, 1)) {
    if (working(d0)) count++;
    if (count === PATERNITY_WORKING_DAYS) break;
  }
  if (wantEnd && wantEnd > d0) return { error: 'grant_too_long' };
  const end = wantEnd || d0;
  for (let y = yearOf(start); y <= yearOf(end); y++) {
    if (holidayListMissing((holidays || []).filter(h => yearOf(h.date) === y))) return { error: 'no_holiday_list', year: y };
  }
  let days = 0;
  for (let x = start, g = 0; x <= end && g++ < 400; x = addDays(x, 1)) if (working(x)) days++;
  if (days <= 0) return { error: 'no_working_days' };
  return { value: { ...base, end_date: end, days } };
}

// ── E4: WFH approver at submit ───────────────────────────────────────────────
// The skip-level manager (the manager's manager); no skip-level → the manager; no manager → null (HR decides).
// ⚠️ Plan default per the spec ("needs the skip-level manager's approval"). managerOf: (employeeId) → manager_id | null.
export function wfhApprover(emp, managerOf = () => null) {
  const m = emp?.manager_id || null;
  if (!m) return null;
  const s = managerOf(m) || null;
  return s && s !== emp.id ? s : m;
}

// ── E5: year-end preview ─────────────────────────────────────────────────────
// Shown 1 Nov – 31 Jan: Nov / Dec preview this year's close, January the one just made. → the year | null
export function yearEndYear(today) {
  if (!isIsoDay(today)) return null;
  const m = Number(today.slice(5, 7)), y = yearOf(today);
  return m >= 11 ? y : m === 1 ? y - 1 : null;
}
// Projected 31 Dec of `year` per type = Σ ledger dated ≤ 31 Dec (without that year's own lapse row) + the year's
// accruals still to come after the current IST month − the pending PL / SL debit (days − lop_days) of that year.
// PL carries min(PL, 5) (a negative carries as is), the rest lapses; SL lapses fully (a negative carries). Read only.
// A year before today's (January's view) is already closed: show the ACTUAL close (review H) — closing before the
// lapse, the lapse row leave_close_years wrote, what carried — and the still-pending days of that year as their own
// figure, not subtracted. pending is reported in both modes. → { year, actual, PL: {projected, carry, lapse, pending}, SL }
export function yearEndPreview({ employee, ledger = [], requests = [], cutoverMonth, today, year }) {
  const cm = monthOf(today);
  const end = `${year}-12-31`, per = String(year);
  const pendingOf = (t) => (requests || []).filter(r => r.status === 'pending' && r.leave_type === t && yearOf(r.start_date) === year)
    .reduce((s, r) => s + toHalves(r.days) - toHalves(r.lop_days || 0), 0);
  if (year < yearOf(today)) {
    const out = { year, actual: true };
    for (const t of LEDGER_TYPES) {
      const rows = (ledger || []).filter(r => r.leave_type === t && String(r.effective_date).slice(0, 10) <= end);
      const isLapse = (r) => r.kind === 'lapse' && String(r.period) === per;
      const closing = rows.filter(r => !isLapse(r)).reduce((s, r) => s + toHalves(r.delta), 0);
      const lapse = 0 - rows.filter(isLapse).reduce((s, r) => s + toHalves(r.delta), 0);   // 0 −, never −0
      out[t] = { projected: fromHalves(closing), carry: fromHalves(closing - lapse), lapse: fromHalves(lapse), pending: fromHalves(pendingOf(t)) };
    }
    return out;
  }
  const out = { year, actual: false };
  for (const t of LEDGER_TYPES) {
    const base = (ledger || []).filter(r => r.leave_type === t && String(r.effective_date).slice(0, 10) <= end
      && !(r.kind === 'lapse' && String(r.period) === per)).reduce((s, r) => s + toHalves(r.delta), 0);
    const from = addMonths(cm, 1) > `${year}-01` ? addMonths(cm, 1) : `${year}-01`;
    const remaining = earningMonths(employee, cutoverMonth, from, `${year}-12`).length * toHalves(ACCRUAL_RATE[t]);
    const pending = pendingOf(t);
    const p = base + remaining - pending;
    const keep = t === 'PL' ? toHalves(PL_CARRY_MAX) : 0;
    out[t] = { projected: fromHalves(p), carry: fromHalves(p > keep ? keep : p), lapse: fromHalves(Math.max(0, p - keep)), pending: fromHalves(pending) };
  }
  return out;
}
