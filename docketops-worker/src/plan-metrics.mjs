// Docket F9 R3 — the "measured from" registry (spec 2026-11-11-docket-plan-layer.md §4.4).
// A milestone/result's `measure` names one of these, never free SQL. P1 = registry + flag: `source_ok`
// says whether the system records this today; the WORKER copies it onto the measure (the client's value is
// never trusted). P2 (R9b, migration 0029) adds the daily check: docket.measure_check() (pg_cron, 06:00 IST)
// reads every agreed item whose metric is in MEASURE_CHECK_KEYS through docket.plan_metric_reading — one fixed
// SQL branch per key — into docket.plan_measure_readings. `auto_check: false` = the registry knows the source
// but the checker may not read it (no single canonical SQL definition); such an item is never auto-checked.
//
// Seeded only from tables that exist in this codebase. source_ok = the source had rows in the 30 IST days
// 2026-10-14 … 2026-11-12 (read-only COUNTs with docket.plan_metric_reading's own filters, re-run 2026-11-12 for
// the R9b review); the count is in each `note`. Re-check before flipping.
//   INW scans 18,292 · first pass 10,397 of 11,002 distinct car units inspected · qc_fail_events 2 ·
//   pkg_scans 28,198 · dispatch_boxes shipped 9,013 · downtime_events 0 (0 ever) · grn_register 771 ·
//   issue_register 1,766 · production runs released (not cancelled / rejected) 7 · sales_fact 2,874 ·
//   mkt_fact 3,285 · traffic_fact 406 · one_on_ones 0 (0 ever) · okr_checkins 0 (0 ever) ·
//   docket tasks done (top-level, not archived, not the Founders' space) 3.

export const METRIC_SYSTEMS = ['redline', 'garage', 'odo', 'podium', 'docket', 'manual'];

export const PLAN_METRICS = [
  { key: 'redline.units_inwarded', system: 'redline', label: 'Units inwarded (INW scans)', unit: 'units',
    source_ok: true, source: "public.scans (activity = 'INW', not voided)", note: '18,292 INW scans in the 30 days to 2026-11-12' },
  { key: 'redline.first_pass_yield', system: 'redline', label: 'QC first-pass yield', unit: '%',
    source_ok: true, source: 'public.scans ⋈ public.units — v_first_pass_yield\'s filters, distinct car units across the window',
    note: '10,397 first-pass of 11,002 car units inspected in the 30 days to 2026-11-12' },
  { key: 'redline.qc_fail_units', system: 'redline', label: 'Units failing QC', unit: 'units',
    source_ok: true, source: 'public.qc_fail_events (failed_at)',
    note: '2 fail events in the 30 days to 2026-11-12. Counts fail EVENTS — a unit that fails twice counts twice' },
  { key: 'redline.units_packed', system: 'redline', label: 'Units packed (PKG)', unit: 'units',
    source_ok: true, source: 'public.pkg_scans (packed_at)', note: '28,198 rows in the 30 days to 2026-11-12' },
  { key: 'redline.units_shipped', system: 'redline', label: 'Dispatch boxes shipped', unit: 'boxes',
    source_ok: true, source: 'public.dispatch_boxes (shipped_at)', note: '9,013 shipped in the 30 days to 2026-11-12' },
  { key: 'redline.downtime_minutes', system: 'redline', label: 'Line downtime', unit: 'minutes',
    source_ok: false, source: 'public.downtime_events (duration_mins)', note: 'no rows ever (checked 2026-11-12) — nothing logs downtime yet' },
  { key: 'garage.grn_lines', system: 'garage', label: 'Goods received (GRN lines)', unit: 'lines',
    source_ok: true, source: 'store.grn_register', note: '771 lines in the 30 days to 2026-11-12' },
  { key: 'garage.issue_lines', system: 'garage', label: 'Parts issued to production', unit: 'lines',
    source_ok: true, source: 'store.issue_register', note: '1,766 lines in the 30 days to 2026-11-12' },
  { key: 'garage.production_runs', system: 'garage', label: 'Production runs released', unit: 'runs',
    source_ok: true, source: 'store.production_runs (released_at; not Cancelled / Rejected)', note: '7 runs released in the 30 days to 2026-11-12' },
  { key: 'odo.net_revenue', system: 'odo', label: 'Net revenue (ex-GST)', unit: '₹',
    source_ok: true, auto_check: false, source: 'sales.sales_fact (sale_date)',
    note: '2,874 rows in the 30 days to 2026-11-12. NOT auto-checked: net ex-GST is computed at display by Odo\'s '
      + 'apps/odo/src/lib/segregation.js (hybridHeadline over f_order_rollup + f_sales_rollup), not by any SQL function — '
      + 'the checker will not re-derive revenue (R9b)' },
  { key: 'odo.ad_spend', system: 'odo', label: 'Marketing spend', unit: '₹',
    source_ok: true, source: "sales.f_mkt_rollup(from, to, 'platform') Σ spend — Odo /marketing's \"Ad spend\" KPI", note: '3,285 rows in the 30 days to 2026-11-12' },
  { key: 'odo.web_sessions', system: 'odo', label: 'Website sessions / conversion', unit: 'sessions',
    source_ok: true, source: "sales.f_traffic_rollup(from, to, 'src') Σ sessions — Odo /funnel's GA4 \"Sessions\" step", note: '406 rows in the 30 days to 2026-11-12' },
  { key: 'podium.one_on_ones', system: 'podium', label: '1:1s held', unit: 'meetings',
    source_ok: false, source: 'podium.one_on_ones', note: 'no rows ever (checked 2026-11-12)' },
  { key: 'podium.okr_checkins', system: 'podium', label: 'OKR check-ins', unit: 'check-ins',
    source_ok: false, source: 'podium.okr_checkins', note: 'no rows ever (checked 2026-11-12)' },
  { key: 'docket.tasks_done', system: 'docket', label: 'Docket tasks completed', unit: 'tasks',
    source_ok: true, source: "docket.tasks (completed_at; top-level, not archived, never the Founders' space)", note: '3 completed in the 30 days to 2026-11-12' },
  { key: 'manual', system: 'manual', label: 'Manual — no system records it', unit: null,
    source_ok: false, source: null, note: 'someone reports it by hand; always flagged' },
];

// The keys docket.measure_check reads, with the unit its target parser checks the target against (its v_units
// constant in migration 0029 — test/measure-keys.test.mjs keeps the two equal): known to the system today,
// auto-checkable, not manual.
export const MEASURE_CHECK_KEYS = PLAN_METRICS.filter(m => m.source_ok && m.auto_check !== false && m.key !== 'manual').map(m => m.key);
export const MEASURE_CHECK_UNITS = Object.fromEntries(MEASURE_CHECK_KEYS.map(k => [k, PLAN_METRICS.find(m => m.key === k).unit]));

const BY_KEY = Object.fromEntries(PLAN_METRICS.map(m => [m.key, m]));
export function metricByKey(key) { return Object.prototype.hasOwnProperty.call(BY_KEY, key) ? BY_KEY[key] : null; }

// What the app needs (no `source` table names — those are worker detail).
export function publicMetrics() {
  return PLAN_METRICS.map(({ key, system, label, unit, source_ok, auto_check }) => ({ key, system, label, unit, source_ok, auto_check: auto_check !== false }));
}

export const MAX_TARGET = 300;
// The client's measure → the stored one: { system, metric, target, source_ok } (source_ok from the
// registry; checked_at / last_reading are the P2 checker's and never come from a client). null clears.
// Returns { value } or { error }.
export function normalizeMeasure(m) {
  if (m === null || m === undefined) return { value: null };
  if (typeof m !== 'object' || Array.isArray(m)) return { error: 'bad_measure' };
  const metric = metricByKey(typeof m.metric === 'string' ? m.metric : '');
  if (!metric) return { error: 'unknown_metric' };
  if (m.system !== undefined && m.system !== metric.system) return { error: 'unknown_metric' };
  if (m.target != null && (typeof m.target !== 'string' || m.target.length > MAX_TARGET)) return { error: 'bad_measure' };
  const target = typeof m.target === 'string' && m.target.trim() ? m.target.trim() : null;
  return { value: { system: metric.system, metric: metric.key, target, source_ok: metric.source_ok } };
}
