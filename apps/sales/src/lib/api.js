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
