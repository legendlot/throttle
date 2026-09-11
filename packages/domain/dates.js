// ⚠️ NEVER build a Y-M-D string with `new Date().toISOString().slice(0,10)`.
// toISOString() renders a local wall-clock moment as UTC, so in IST (+5:30) it returns
// YESTERDAY for any local time between 00:00 and 05:30 — and always returns the previous
// month's last day for a local midnight (`new Date(y, m, 1)`). That silently mis-dates
// whatever it feeds: a GRN, a credit note, a delivery challan, a production run.
// Use `todayStr()` / `dateStr(d)` below, which read the local calendar fields directly.
// See archive/LEARNINGS.md PATTERN-221.
//
// ── Two traps found closing this class fleet-wide on 2026-08-31 (S324) ──────────────
//
// 1. ⚠️ AUDIT WITH THE SPACE. The offending code is written `.slice(0, 10)`, so
//    `grep -rn "toISOString().slice(0,10)"` returns ZERO across apps that are full of it
//    and reads as a clean bill of health. This nearly closed the class early here, and a
//    parallel lane confirmed all five of Odo's sites are the spaced variant too. Use:
//        grep -rnE "toISOString\(\)\s*\.\s*slice\(0,\s*10\)" apps/ packages/
//
// 2. ⭐ THE LOCAL-MIDNIGHT CONSTRUCTOR IS THE WORSE BUG, AND IT IS NOT THE 05:30 WINDOW.
//    `new Date(y, m, d)` is local midnight, which toISOString() renders as the PREVIOUS
//    DAY at any positive offset — so it is wrong ALL DAY, not for five and a half hours.
//    Live case: Pitstop's year-to-date report defaulted `from` to `new Date(y, 0, 1)` and
//    therefore opened on 31 Dec of the PRIOR YEAR, every day, until 2026-08-31. Grep for
//    `new Date(` with two or more numeric args separately from the plain `new Date()`
//    case — they fail differently and the multi-arg one is far more visible to users.
//
// ⛔ AND DO NOT "FIX" AN ALREADY-COMPENSATED SITE. Several call sites deliberately add
//    +5.5h (or build with `Date.UTC(...)`) BEFORE calling toISOString(), which is correct
//    and must be left alone — `odo/lib/api.js`, `throttle/performance`, `depot/scans`
//    (`isoOf`), and `pitstop/queue/detail`'s `ageingLabel`. Changing those double-shifts
//    the date. Read the surrounding lines before editing; the pattern alone is not enough.

/** Format a Date as a local (not UTC) `YYYY-MM-DD` string. */
export function dateStr(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return '';
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Today as a local `YYYY-MM-DD` string. */
export function todayStr() {
  return dateStr(new Date());
}

// ── IST calendar dates + quick-range presets ────────────────────────────────────────
// Lifted from Odo's `rangePresets()` (apps/odo/src/lib/api.js) for Snorkel's PO list
// (Joseph, #bugs 1789108860.383049) — same keys, labels and maths, so Odo's copy can become a
// re-export of this one without a visible change. Computed on the IST clock, NOT the
// browser's: a +5.5h-shifted Date read through getUTC* IS the IST wall clock, whatever zone
// the machine is in. Every value is a `YYYY-MM-DD` calendar date, inclusive at both ends, so
// it compares directly (as a string) against a Postgres `date` column.
const IST_MS = 5.5 * 3600 * 1000;
const pad2 = (n) => String(n).padStart(2, '0');

/** A moment (Date | ISO string | ms) as its IST calendar date `YYYY-MM-DD`. '' if missing or
 *  unparseable. No default on purpose: a missing value (undefined/null/'') is '' — never "today"
 *  (a default param did that for undefined) and never 1970-01-01 (new Date(null) is epoch 0).
 *  For today, pass `new Date()` explicitly. */
export function istDateStr(input) {
  if (input == null || input === '') return '';
  const t = input instanceof Date ? input.getTime() : new Date(input).getTime();
  if (isNaN(t)) return '';
  const s = new Date(t + IST_MS);
  return `${s.getUTCFullYear()}-${pad2(s.getUTCMonth() + 1)}-${pad2(s.getUTCDate())}`;
}

/** Quick ranges → [{ key, label, from, to }] (IST, inclusive). FY = Indian fiscal year (Apr 1). */
export function istRangePresets(now = new Date()) {
  const to = istDateStr(now);
  const s = new Date(now.getTime() + IST_MS);
  const y = s.getUTCFullYear(), m = s.getUTCMonth();                 // 0-indexed month
  const daysAgo = (n) => istDateStr(new Date(now.getTime() - n * 86400000));
  // Last calendar month, 1st → last day (day 0 of the next month = last day).
  const lmY = m === 0 ? y - 1 : y, lmM = m === 0 ? 11 : m - 1;
  const lmLast = new Date(Date.UTC(lmY, lmM + 1, 0)).getUTCDate();
  return [
    { key: 'today', label: 'Today',   from: to, to },
    { key: '7d',    label: '7D',      from: daysAgo(6),  to },
    { key: '30d',   label: '30D',     from: daysAgo(29), to },
    { key: '90d',   label: '90D',     from: daysAgo(89), to },
    { key: 'mtd',   label: 'MTD',     from: `${y}-${pad2(m + 1)}-01`, to },
    { key: 'lm',    label: 'Last mo', from: `${lmY}-${pad2(lmM + 1)}-01`, to: `${lmY}-${pad2(lmM + 1)}-${pad2(lmLast)}` },
    { key: 'fy',    label: 'FY',      from: `${m >= 3 ? y : y - 1}-04-01`, to },
  ];
}

export function todayISO() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export function formatDate(input, format = 'display') {
  if (!input) return '';
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return '';
  if (format === 'display') {
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }
  if (format === 'iso') return d.toISOString();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
