// Leave R1 — labels, fetchers and the read-side helpers for /leave and /admin/leave.
// The worker (podiumops-worker/src/leave.js + index.js) is the authority on every count, split and gate;
// the UI only offers. Plan: docs/superpowers/plans/2026-11-13-podium-leave-r1.md (D1–D15).
// Dates are YYYY-MM-DD calendar days in IST throughout.
import { podiumopsGet, podiumopsPost } from './podiumopsFetch.js';

// D2 / D12. PERIOD is labelled as itself only on the person's own view, their approver chain and HR (D11);
// GENERIC_LABEL is what any wider view shows.
// R2 (plan 2026-11-13-podium-leave-r2): WFH is applied like leave (no balance, no LOP; approved by the skip-level
// manager, E4); MATERNITY / PATERNITY are HR grants only (`grant: true` — never on the apply form, E3).
export const LEAVE_TYPES = [
  { id: 'PL',               label: 'Privilege leave', short: 'PL' },
  { id: 'SL',               label: 'Sick leave',      short: 'SL' },
  { id: 'PERIOD',           label: 'Period leave',    short: 'Period' },
  { id: 'OPTIONAL_HOLIDAY', label: 'Optional holiday', short: 'Optional' },
  { id: 'WFH',              label: 'Work from home',  short: 'WFH' },
  { id: 'MATERNITY',        label: 'Maternity leave', short: 'Maternity', grant: true },
  { id: 'PATERNITY',        label: 'Paternity leave', short: 'Paternity', grant: true },
];
export const GRANT_TYPES = LEAVE_TYPES.filter(t => t.grant);
export const GENERIC_LABEL = 'Leave';
export const LEDGER_TYPES = ['PL', 'SL'];
export function leaveTypeLabel(id) { return LEAVE_TYPES.find(t => t.id === id)?.label || GENERIC_LABEL; }

export const LEAVE_STATUSES = [
  { id: 'pending',   label: 'Pending',   tone: 'warn' },
  { id: 'approved',  label: 'Approved',  tone: 'ok' },
  { id: 'rejected',  label: 'Rejected',  tone: 'bad' },
  { id: 'withdrawn', label: 'Withdrawn', tone: 'neutral' },
  { id: 'cancelled', label: 'Cancelled', tone: 'neutral' },
];

export const LEDGER_KINDS = [
  { id: 'opening',    label: 'Opening balance' },
  { id: 'accrual',    label: 'Monthly credit' },
  { id: 'taken',      label: 'Leave taken' },
  { id: 'cancelled',  label: 'Leave cancelled' },
  { id: 'carry_over', label: 'Carried over' },
  { id: 'lapse',      label: 'Lapsed' },
  { id: 'adjustment', label: 'Adjustment' },
];

// D6 half days. A range: the first day is full or second-half only, the last day full or first-half only.
export const START_HALVES = [{ id: 'full', label: 'Full day' }, { id: 'second', label: 'From second half' }];
export const END_HALVES   = [{ id: 'full', label: 'Full day' }, { id: 'first',  label: 'Until first half' }];
export const SINGLE_HALVES = [{ id: 'full', label: 'Full day' }, { id: 'first', label: 'First half' }, { id: 'second', label: 'Second half' }];

export const MAX_REASON = 500;

// D1: employees.leave_policy (null = not covered). HR sets it on the person's edit form.
export const LEAVE_POLICIES = [{ id: '', label: 'Not covered' }, { id: 'fraternitas', label: 'Fraternitas' }];

// Worker refusal codes (errCode) → what the person reads.
const ERROR_COPY = {
  not_covered:          'Leave is not set up for this person yet. HR turns it on in their profile.',
  no_working_days:      'Those dates have no working days (weekends and holidays are free).',
  crosses_year:         'A request cannot cross 31 December. Apply for each year separately.',
  overlap:              'You already have a pending or approved request on some of these dates.',
  notice:               'Too late to apply for these dates. Privilege leave must start today or later; sick leave up to 7 days back.',
  period_not_eligible:  'Period leave is not available for this person.',
  period_used:          'Period leave for that month is already used or requested.',
  optional_used:        'The optional holiday for that year is already used or requested.',
  not_optional_holiday: 'Pick a date from the optional holiday list.',
  too_long:             'One request can cover at most 60 working days. Split it.',
  period_one_day:       'Period leave is one day at most.',
  no_holiday_list:      "The holiday list for that year isn't in Podium yet. Ask HR to add it.",
  balance_changed:      'The balance changed since you opened this. Reloaded — check the split and decide again.',
  not_pending:          'This request has already been decided or withdrawn.',
  no_self_approval:     'You cannot decide your own leave.',
  forbidden:            'You are not allowed to do that.',
  opening_exists:       'The opening balance is already set. Use an adjustment with a note instead.',
  // Validation codes the worker also returns (podiumops-worker/src/leave.js LEAVE_COPY).
  not_approved:         'Only an approved request can be cancelled.',
  bad_type:             'Pick a leave type.',
  bad_dates:            'Pick valid start and end dates.',
  bad_half:             'Pick valid half-day options.',
  reason_too_long:      'The reason is limited to 500 characters.',
  note_required:        'A note is required.',
  note_too_long:        'The note is limited to 500 characters.',
  bad_amount:           'Enter a number of days in steps of 0.5.',
  bad_month:            'Pick a month.',
  cutover_locked:       'Credits already exist before that month, so the cutover can only move earlier.',
  bad_holiday:          'Enter a date, a name and fixed / optional.',
  holiday_past:         'Only a future holiday can be added, renamed or deleted.',
  not_found:            'Not found.',
  // R2
  grant_only:             'Maternity and paternity leave are granted by HR.',
  gender_unknown:         "Fill the person's gender in their profile first.",
  maternity_not_eligible: 'Maternity leave can be granted only to a person recorded as female.',
  paternity_not_eligible: 'Paternity leave can be granted only to a person recorded as male.',
  too_far:                'Leave can be applied at most for next calendar year.',
  grant_too_long:         'The end date is after the full length (maternity 182 calendar days, paternity 15 working days).',
  report_changed:         'The report changed since you loaded it — reload, download again, then mark exported.',
};
export function leaveError(e, fallback = 'Something went wrong') {
  const raw = (e && (e.message || e.code || e.error)) || (typeof e === 'string' ? e : '');
  const code = String(raw).split(/[:\s]/)[0];
  // no_holiday_list: the worker's message names the year.
  if (code === 'no_holiday_list' && e?.body?.message) return e.body.message;
  return ERROR_COPY[code] || e?.body?.message || raw || fallback;
}
export function leaveErrorCode(e) {
  const raw = (e && (e.body?.error || e.message || e.code || e.error)) || (typeof e === 'string' ? e : '');
  return String(raw).split(/[:\s]/)[0];
}

// ── Fetchers ────────────────────────────────────────────────────────────────
export const getMyLeave     = (session) => podiumopsGet('getMyLeave', {}, session);
export const getTeamLeave   = (from, to, session) => podiumopsGet('getTeamLeave', { from, to }, session);
export const getLeaveAdmin  = (session) => podiumopsGet('getLeaveAdmin', {}, session);
export const getLeaveLedger = (employeeId, session) => podiumopsGet('getLeaveLedger', { employee_id: employeeId }, session);
export const previewLeave   = (body, session) => podiumopsPost('previewLeave', body, session);
export const applyLeave     = (body, session) => podiumopsPost('applyLeave', body, session);
export const decideLeave    = (body, session) => podiumopsPost('decideLeave', body, session);
export const withdrawLeave  = (id, session) => podiumopsPost('withdrawLeave', { id }, session);
export const cancelLeave    = (id, note, session) => podiumopsPost('cancelLeave', { id, note: note || null }, session);
export const setLeaveSettings = (body, session) => podiumopsPost('setLeaveSettings', body, session);
export const saveHoliday      = (body, session) => podiumopsPost('saveHoliday', body, session);
export const deleteHoliday    = (date, session) => podiumopsPost('deleteHoliday', { date }, session);
// The opening amount rides as `days` AND `delta` until the worker's field name is pinned (see the R1 report).
export const setOpeningBalance = (employeeId, leaveType, days, note, session) =>
  podiumopsPost('setOpeningBalance', { employee_id: employeeId, leave_type: leaveType, days, delta: days, note: note || null }, session);
export const adjustLeave = (employeeId, leaveType, delta, note, session) =>
  podiumopsPost('adjustLeave', { employee_id: employeeId, leave_type: leaveType, delta, note }, session);
// R2 — payroll unpaid days (E1) + maternity / paternity grants (E3). HR only (the worker checks isHr).
export const getLeaveLopReport = (month, session) => podiumopsGet('getLeaveLopReport', { month }, session);
export const markLopExported   = (month, reportHash, session) => podiumopsPost('markLopExported', { month, report_hash: reportHash }, session);
export const grantLeave        = (body, session) => podiumopsPost('grantLeave', body, session);

// E1 CSV (built here, downloaded in the browser): code, RazorpayX id, name, LOP days, dates, check. warnings (review F):
// requests whose holiday count changed after approval — their person's row gets the check text; someone with a warning
// but no unpaid day in the month gets a 0 row so it is not missed.
const HALF_TXT = { full: '', first: ' (1st half)', second: ' (2nd half)' };
export function lopDatesText(dates) { return (dates || []).map(d => `${d.date}${HALF_TXT[d.half] || ''}`).join('; '); }
export function lopCheckText(ws) {
  return (ws || []).map(w => `holiday list changed — frozen LOP ${fmtNum(w.lop_days)}, placed ${fmtNum(w.placed)} (${w.start_date} – ${w.end_date})`).join('; ');
}
export function lopCsv(rows, warnings = []) {
  // A cell that a spreadsheet would read as a formula gets a leading ' (CSV injection); quotes / commas are quoted.
  const esc = (v) => { let s = v == null ? '' : String(v); if (/^[=+\-@]/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['Employee code', 'RazorpayX employee id', 'Name', 'LOP days', 'Dates', 'Check'];
  const wBy = {};
  for (const w of warnings || []) (wBy[w.employee_id] ||= []).push(w);
  const extra = Object.keys(wBy).filter(id => !(rows || []).some(r => r.employee_id === id))
    .map(id => ({ employee_id: id, employee_code: wBy[id][0].employee_code, full_name: wBy[id][0].full_name, razorpayx_employee_id: null, lop_days: 0, dates: [] }));
  return [head, ...[...(rows || []), ...extra].map(r => [r.employee_code, r.razorpayx_employee_id, r.full_name, fmtNum(r.lop_days), lopDatesText(r.dates), lopCheckText(wBy[r.employee_id])])]
    .map(line => line.map(esc).join(',')).join('\r\n') + '\r\n';
}
export function downloadText(filename, text, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Response readers (the worker's shapes are read defensively) ──────────────
export const arr = (d, ...keys) => {
  if (Array.isArray(d)) return d;
  for (const k of keys) if (d && Array.isArray(d[k])) return d[k];
  return [];
};
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// A request's split: stored columns or a nested `split`.
export function splitOf(r) {
  const s = r?.split || r || {};
  return {
    days: num(s.days ?? r?.days) ?? 0,
    borrowed_days: num(s.borrowed_days ?? s.borrowed) ?? 0,
    lop_days: num(s.lop_days ?? s.lop) ?? 0,
  };
}
// The person on a team row: embedded `employee` (getTeamLeave requests / to_decide) or flat columns — a request row
// carries employee_id, a person row (getLeaveAdmin / getTeamLeave people[]) is itself {id, employee_code, full_name}.
export function personOf(r) {
  const e = r?.employee || r?.person || {};
  return {
    id: e.id || r?.employee_id || r?.id || null,
    name: e.full_name || r?.employee_name || r?.full_name || 'Unknown',
    code: e.employee_code || r?.employee_code || '',
  };
}

// ── Dates (IST calendar days) ───────────────────────────────────────────────
export function istToday() { return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10); }
export function addDays(iso, n) {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return new Date(t + n * 86400000).toISOString().slice(0, 10);
}
export function weekdayOf(iso) { return new Date(`${iso}T00:00:00Z`).getUTCDay(); }   // 0 Sun … 6 Sat
export function mondayOf(iso) { const w = weekdayOf(iso); return addDays(iso, w === 0 ? -6 : 1 - w); }
export function monthStart(iso) { return `${iso.slice(0, 7)}-01`; }
export function monthEnd(iso) {
  const [y, m] = iso.slice(0, 7).split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
export function shiftMonth(iso, n) {
  const [y, m] = iso.slice(0, 7).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10);
}
export function daysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
// "Fri, 14 Nov 2026" (date-only strings are read as calendar days, never shifted).
export function fmtDay(iso, { weekday = true, year = true } = {}) {
  if (!iso) return '—';
  const t = Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(t)) return String(iso);
  return new Date(t).toLocaleDateString('en-IN', {
    timeZone: 'UTC', day: '2-digit', month: 'short', ...(year ? { year: 'numeric' } : {}), ...(weekday ? { weekday: 'short' } : {}),
  });
}
export function fmtMonth(iso) {
  const t = Date.parse(`${String(iso).slice(0, 7)}-01T00:00:00Z`);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-IN', { timeZone: 'UTC', month: 'long', year: 'numeric' }) : String(iso);
}
// "14 Nov – 18 Nov 2026 (from 2nd half)" style range text.
export function fmtRange(r) {
  const s = r.start_date, e = r.end_date || r.start_date;
  if (s === e) {
    const h = r.start_half && r.start_half !== 'full' ? r.start_half : (r.end_half && r.end_half !== 'full' ? r.end_half : null);
    return `${fmtDay(s)}${h ? ` (${h} half)` : ''}`;
  }
  const a = r.start_half === 'second' ? ' (2nd half)' : '';
  const b = r.end_half === 'first' ? ' (1st half)' : '';
  return `${fmtDay(s, { year: false })}${a} – ${fmtDay(e)}${b}`;
}
// 1.5 → "1.5", 2 → "2"; "day"/"days".
export function fmtDays(n) {
  const v = Number(n) || 0;
  const s = Number.isInteger(v) ? String(v) : v.toFixed(1);
  return `${s} ${Math.abs(v) === 1 ? 'day' : 'days'}`;
}
export function fmtNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}
// The half a person is out on one calendar day of a request: 'full' | 'first' | 'second' | null.
export function halfOn(r, day) {
  const s = r.start_date, e = r.end_date || r.start_date;
  if (day < s || day > e) return null;
  if (s === e) return r.start_half && r.start_half !== 'full' ? r.start_half : (r.end_half && r.end_half !== 'full' ? r.end_half : 'full');
  if (day === s && r.start_half === 'second') return 'second';
  if (day === e && r.end_half === 'first') return 'first';
  return 'full';
}
