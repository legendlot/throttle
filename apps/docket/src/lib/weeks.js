// F9 R4 — weeks (spec 2026-11-11-docket-plan-layer.md §6, §8.3). A COPY of the week math in
// docketops-worker/src/weeks-core.mjs (weeks.test.mjs checks parity) — change both together.
//
// Week = the half-open IST interval [S 00:00, E+1 00:00) where E is the week-ENDING date and S = E − 6.
// A task's week = the week holding the IST date of its effective deadline (revised_deadline ?? deadline —
// lib/tasks.js effectiveDeadline). E's weekday is docket.settings.week_end_dow (ISO 1 = Mon … 7 = Sun),
// which the app reads from getPlan (`week`) — DEFAULT Sunday only until that arrives. Overdue keeps the
// app's meaning (lib/tasks.js isOverdue): open and the effective deadline before now.
import { effectiveDeadline } from './tasks.js';

export const WEEK_DEFAULTS = Object.freeze({ week_end_dow: 7, working_days: Object.freeze([1, 2, 3, 4, 5, 6]), holidays: Object.freeze([]) });
export const WEEK_KEYS = ['week_end_dow', 'working_days', 'holidays'];
export const STALE_WORKING_DAYS = 3;
export const WEEK_FILTERS = ['this', 'next', 'overdue', 'none'];   // + a 'YYYY-MM-DD' (snapped to its week end)

const IST_MS = 5.5 * 3600000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isDateStr(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
const toMs = (v) => (typeof v === 'number' ? v : v instanceof Date ? v.getTime() : Date.parse(v));

// The IST calendar date of a timestamp (ms, Date or ISO string) → 'YYYY-MM-DD' | null.
export function istDate(v) {
  const t = toMs(v);
  if (!Number.isFinite(t)) return null;
  return new Date(t + IST_MS).toISOString().slice(0, 10);
}
export function addDays(d, n) { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
export function isoDow(d) { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return w === 0 ? 7 : w; }
// 00:00 IST of a date, as epoch ms.
export function istMidnight(d) { return Date.parse(`${d}T00:00:00+05:30`); }

// The week-ending date of the week holding date d (d itself when d falls on the week-end day).
export function weekEndOf(d, dow = 7) { return addDays(d, (dow - isoDow(d) + 7) % 7); }
export function weekStartOf(end) { return addDays(end, -6); }
export function weekBounds(end) { return { start: istMidnight(weekStartOf(end)), end: istMidnight(addDays(end, 1)) }; }

// settings rows ({ key: value } or [{ key, value }]) → { week_end_dow, working_days, holidays }; anything
// malformed falls back to the default for that key.
export function normalizeWeekSettings(raw) {
  const m = Array.isArray(raw) ? Object.fromEntries(raw.map(r => [r?.key, r?.value])) : (raw || {});
  const dow = Number(m.week_end_dow);
  const wd = Array.isArray(m.working_days)
    ? [...new Set(m.working_days.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 7))].sort((a, b) => a - b) : [];
  const hol = Array.isArray(m.holidays) ? [...new Set(m.holidays.filter(isDateStr))].sort() : [];
  return {
    week_end_dow: Number.isInteger(dow) && dow >= 1 && dow <= 7 ? dow : WEEK_DEFAULTS.week_end_dow,
    working_days: wd.length ? wd : [...WEEK_DEFAULTS.working_days],
    holidays: hol,
  };
}

// The app's one effective deadline (lib/tasks.js), re-exported so the parity test can hold it to the worker's.
export { effectiveDeadline };
const isOpen = (t) => !!t && t.status !== 'done' && t.status !== 'abandoned';
export function isOverdue(t, now = Date.now()) {
  if (!isOpen(t)) return false;
  const eff = effectiveDeadline(t);
  return !!eff && Date.parse(eff) < toMs(now);
}
// The week-ending date of a task's effective deadline, or null (no date).
export function taskWeekEnd(t, dow = 7) {
  const d = istDate(effectiveDeadline(t));
  return d ? weekEndOf(d, dow) : null;
}
// The Group-by bucket: 'overdue' (open + past due) | 'none' (no date) | the week-ending date.
export function weekBucket(t, dow = 7, now = Date.now()) {
  if (isOverdue(t, now)) return 'overdue';
  return taskWeekEnd(t, dow) || 'none';
}
export function thisWeekEnd(now = Date.now(), dow = 7) { return weekEndOf(istDate(now), dow); }

// A Week filter value → { kind: 'overdue' | 'none' } | { kind: 'week', end } | null (not a filter value).
export function resolveWeekFilter(f, dow = 7, now = Date.now()) {
  if (f === 'overdue' || f === 'none') return { kind: f };
  if (f === 'this') return { kind: 'week', end: thisWeekEnd(now, dow) };
  if (f === 'next') return { kind: 'week', end: addDays(thisWeekEnd(now, dow), 7) };
  if (isDateStr(f)) return { kind: 'week', end: weekEndOf(f, dow) };
  return null;
}
// `This week` / a week holds every task due in it, overdue ones included (the filter is the week; the
// Group-by is what pulls overdue out into its own group).
export function matchesWeek(t, resolved, dow = 7, now = Date.now()) {
  if (!resolved) return true;
  if (resolved.kind === 'overdue') return isOverdue(t, now);
  if (resolved.kind === 'none') return !effectiveDeadline(t);
  return taskWeekEnd(t, dow) === resolved.end;
}

const DOW3 = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// 'Sun 16 Nov' (+ the year when it isn't the current IST year).
export function shortDay(d, now = Date.now()) {
  if (!isDateStr(d)) return '';
  const y = d.slice(0, 4), cur = (istDate(now) || '').slice(0, 4);
  return `${DOW3[isoDow(d)]} ${Number(d.slice(8, 10))} ${MON3[Number(d.slice(5, 7)) - 1]}${y !== cur ? ' ' + y : ''}`;
}
export function weekLabel(end, now = Date.now()) { return `Week ending ${shortDay(end, now)}`; }

// ── working days (staleness, §8.3) ───────────────────────────────────────────
export function isWorkingDay(d, s = WEEK_DEFAULTS) {
  return (s.working_days || WEEK_DEFAULTS.working_days).includes(isoDow(d)) && !(s.holidays || []).includes(d);
}
// Whole working days with no update: working days strictly AFTER the last update's IST date and strictly
// BEFORE today (today is still running, so it never counts against anyone).
export function workingDaysSince(lastAt, now = Date.now(), s = WEEK_DEFAULTS) {
  const from = istDate(lastAt), today = istDate(now);
  if (!from || !today || from >= today) return 0;
  let n = 0;
  for (let d = addDays(from, 1), i = 0; d < today && i < 800; d = addDays(d, 1), i++) if (isWorkingDay(d, s)) n++;
  return n;
}
// The earliest IST date an update may carry and still keep a task fresh: the n-th working day counting
// back from yesterday. Stale ⇔ last update date < this (⇔ workingDaysSince ≥ n). The worker reads history
// and comments from 00:00 IST of this date only.
export function staleCutoff(now = Date.now(), s = WEEK_DEFAULTS, n = STALE_WORKING_DAYS) {
  let d = istDate(now), seen = 0;
  for (let i = 0; i < 800; i++) {
    d = addDays(d, -1);
    if (isWorkingDay(d, s) && ++seen >= n) return d;
  }
  return d;
}
export function isStale(lastAt, now = Date.now(), s = WEEK_DEFAULTS, n = STALE_WORKING_DAYS) {
  return workingDaysSince(lastAt, now, s) >= n;
}

// ── the three-week window (§7.2) ─────────────────────────────────────────────
// Rolling: Overdue · this week · next week · the week after.
export function planWindow(now = Date.now(), dow = 7) {
  const e0 = thisWeekEnd(now, dow);
  const weeks = [e0, addDays(e0, 7), addDays(e0, 14)];
  return { today: istDate(now), weeks, start: weekBounds(e0).start, end: weekBounds(weeks[2]).end };
}

// ── app only: /tasks Group by "Week ending" and the Week filter's label ────────
// Rows → [{ key, value, label, rows, color }]: Overdue first, then each week chronologically, No date last.
export function groupByWeek(rows = [], dow = 7, now = Date.now()) {
  const m = new Map();
  for (const t of rows) {
    const b = weekBucket(t, dow, now);
    if (!m.has(b)) m.set(b, { key: `week:${b}`, value: b, rows: [],
      label: b === 'overdue' ? 'Overdue' : b === 'none' ? 'No date' : weekLabel(b, now),
      color: b === 'overdue' ? 'var(--overdue)' : null });
    m.get(b).rows.push(t);
  }
  const rank = (v) => (v === 'overdue' ? '0' : v === 'none' ? '2' : '1' + v);
  return [...m.values()].sort((a, b) => rank(a.value).localeCompare(rank(b.value)));
}
export function weekFilterLabel(f, dow = 7, now = Date.now()) {
  if (!f) return '';
  if (f === 'this') return 'This week';
  if (f === 'next') return 'Next week';
  if (f === 'overdue') return 'Overdue';
  if (f === 'none') return 'No date';
  const r = resolveWeekFilter(f, dow, now);
  return r ? weekLabel(r.end, now) : '';
}
