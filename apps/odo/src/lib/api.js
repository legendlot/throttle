'use client';
import { garageFetch, workerFetch } from '@throttle/db';
import { rangePresetsAt } from './ranges.mjs';

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

// Quick-range presets → [{ key, label, from, to }] (IST). FY = Indian fiscal year (Apr 1).
// Odo initialises every range picker on MTD (S169, systems/odo.md §Shared UI kit) — a deliberate departure from the
// every-picker-defaults-to-Today rule, pending Afshaan's ruling (reference/decisions.md, 2026-09-22). One constant flips it.
export const DEFAULT_RANGE_PRESET = 'mtd';
export function defaultRange() { const all = rangePresets(); return all.find(p => p.key === DEFAULT_RANGE_PRESET) || all[0]; }

// Computed from the clock at CALL time (see lib/ranges.mjs, which also holds the logic so it can be
// tested across an IST midnight). Same output as before the move.
export function rangePresets() { return rangePresetsAt(Date.now()); }

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
