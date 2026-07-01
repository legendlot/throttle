'use client';
import { garageFetch, workerFetch } from '@throttle/db';

// GET — returns the worker payload (garageFetch unwraps { data }).
export const salesGet = (action, params, session) => garageFetch(action, params, session);

// POST — worker reads body.data; workerFetch returns { ok, data }. Unwrap to the payload.
export const salesPost = (action, data, session) =>
  workerFetch(action, { data: data || {} }, session).then(r => (r && r.data !== undefined ? r.data : r));

// INR money formatter (compact for large values).
export function inr(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e7) return '₹' + (v / 1e7).toFixed(2) + ' Cr';
  if (Math.abs(v) >= 1e5) return '₹' + (v / 1e5).toFixed(2) + ' L';
  return '₹' + Math.round(v).toLocaleString('en-IN');
}
export const fmtInt = (n) => (Number(n) || 0).toLocaleString('en-IN');

// today / N-days-ago as IST YYYY-MM-DD
export function istToday() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}
export function istDaysAgo(days) {
  return new Date(Date.now() + 5.5 * 3600 * 1000 - days * 86400 * 1000).toISOString().slice(0, 10);
}

// IST wall-clock parts (UTC getters on a +5.5h-shifted Date == IST Y/M/D).
function istParts() { const d = new Date(Date.now() + 5.5 * 3600 * 1000); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() }; }

// Quick-range presets → [{ key, label, from, to }] (IST). FY = Indian fiscal year (Apr 1).
export function rangePresets() {
  const to = istToday();
  const { y, m } = istParts();
  const pad = n => String(n).padStart(2, '0');
  const mtd = `${y}-${pad(m + 1)}-01`;
  const fy = `${m >= 3 ? y : y - 1}-04-01`;
  // Last calendar month (full 1st→last day of the previous month, IST).
  const lmY = m === 0 ? y - 1 : y, lmM = m === 0 ? 11 : m - 1;   // 0-indexed prev month
  const lmFrom = `${lmY}-${pad(lmM + 1)}-01`;
  const lmLast = new Date(Date.UTC(lmY, lmM + 1, 0)).getUTCDate();   // day 0 of next month = last day
  const lmTo = `${lmY}-${pad(lmM + 1)}-${pad(lmLast)}`;
  return [
    { key: 'today', label: 'Today',   from: to, to },
    { key: '7d',    label: '7D',      from: istDaysAgo(6),  to },
    { key: '30d',   label: '30D',     from: istDaysAgo(29), to },
    { key: '90d',   label: '90D',     from: istDaysAgo(89), to },
    { key: 'mtd',   label: 'MTD',     from: mtd, to },
    { key: 'lm',    label: 'Last mo', from: lmFrom, to: lmTo },
    { key: 'fy',    label: 'FY',      from: fy,  to },
  ];
}

// The equal-length window immediately preceding [from,to] (for period-over-period deltas).
export function priorPeriod(from, to) {
  const f = Date.parse(from + 'T00:00:00Z'), t = Date.parse(to + 'T00:00:00Z');
  if (isNaN(f) || isNaN(t)) return { from, to };
  const lenDays = Math.round((t - f) / 86400000) + 1;
  const iso = d => new Date(d).toISOString().slice(0, 10);
  return { from: iso(f - lenDays * 86400000), to: iso(f - 86400000) };
}

// Build + download a CSV from an array of flat objects.
export function downloadCsv(rows, filename) {
  if (!rows || !rows.length) return;
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
