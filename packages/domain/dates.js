// ⚠️ NEVER build a Y-M-D string with `new Date().toISOString().slice(0,10)`.
// toISOString() renders a local wall-clock moment as UTC, so in IST (+5:30) it returns
// YESTERDAY for any local time between 00:00 and 05:30 — and always returns the previous
// month's last day for a local midnight (`new Date(y, m, 1)`). That silently mis-dates
// whatever it feeds: a GRN, a credit note, a delivery challan, a production run.
// Use `todayStr()` / `dateStr(d)` below, which read the local calendar fields directly.
// See archive/LEARNINGS.md PATTERN-221.

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
