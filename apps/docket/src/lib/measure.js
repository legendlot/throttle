// F9 R9b — the measure auto-check, app side (spec docs/superpowers/specs/2026-11-11-docket-plan-layer.md §4.4).
// The database reads each agreed, source-backed measure daily (docket.measure_check) and the worker attaches
// the latest reading as `measure.reading = { value, window_from, window_to, checked_at, reached, target_parsed }`
// at levels F / R / O only. This file only words it: the chip, and the evidence a founder confirms with.
import { fmtPlanDate } from './plan.js';
import { shortDay } from './weeks.js';

const n = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const trimZeros = (s) => s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');

// ₹ in L / cr, % as is, everything else a count with Indian thousands grouping.
export function fmtMeasureValue(value, unit) {
  const v = n(value);
  if (v == null) return '—';
  if (unit === '₹') {
    const a = Math.abs(v), sign = v < 0 ? '−' : '';
    if (a >= 1e7) return `${sign}₹${trimZeros((a / 1e7).toFixed(2))} cr`;
    if (a >= 1e5) return `${sign}₹${trimZeros((a / 1e5).toFixed(2))} L`;
    return `${sign}₹${Math.round(a).toLocaleString('en-IN')}`;
  }
  if (unit === '%') return `${trimZeros(v.toFixed(1))}%`;
  // A fraction rounds to one decimal for display (FPY arrives at full precision; also covers a registry not yet loaded).
  const num = Number.isInteger(v) ? v.toLocaleString('en-IN') : trimZeros(v.toFixed(1));
  return unit ? `${num} ${unit}` : num;
}

export function metricUnit(metrics = [], { key, label } = {}) {
  const m = (metrics || []).find(x => (key && x.key === key) || (label && x.label === label));
  return m ? m.unit : null;
}

// The chip: "12,340 units · 30d to Sun 15 Nov" (+ reached). null when there is no reading at all.
export function readingChip(measure, metrics = [], now = Date.now()) {
  const r = measure?.reading;
  if (!r) return null;
  const unit = metricUnit(metrics, { key: measure.metric });
  const to = r.window_to ? shortDay(r.window_to, now) : '';
  const value = r.value == null ? 'no data' : fmtMeasureValue(r.value, unit);
  // reached: null = not decided yet (a ceiling before its due date, or the target changed since the check) → no mark.
  return { text: `${value}${to ? ` · 30d to ${to}` : ''}`, reached: r.reached === true,
    title: r.window_from && r.window_to ? `Read ${fmtPlanDate(r.window_from)} – ${fmtPlanDate(r.window_to)}${r.target_parsed === false ? ' · the target isn’t a number the check can compare' : ''}` : '' };
}

// "13 Oct – 12 Nov 2026" (one year when both share it).
export function fmtRange(from, to) {
  const a = fmtPlanDate(from), b = fmtPlanDate(to);
  if (!a || !b) return a || b || '';
  return from.slice(0, 4) === to.slice(0, 4) ? `${a.replace(/ \d{4}$/, '')} – ${b}` : `${a} – ${b}`;
}

// The done dialog's prefilled evidence for a reached target (getReachedTargets row).
export function reachedEvidence(row, metrics = []) {
  const unit = metricUnit(metrics, { key: row?.metric, label: row?.metric_label });
  const val = fmtMeasureValue(row?.reading, unit);
  const parts = [`Measured ${val}`];
  if (row?.metric_label) parts[0] += ` (${row.metric_label})`;
  if (row?.window_from && row?.window_to) parts.push(`over ${fmtRange(row.window_from, row.window_to)}`);
  return parts.join(' ') + (row?.target ? `, target ${row.target}` : '');
}
