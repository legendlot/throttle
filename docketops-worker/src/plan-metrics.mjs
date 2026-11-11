// Docket F9 R3 — the "measured from" registry (spec 2026-11-11-docket-plan-layer.md §4.4).
// A milestone/result's `measure` names one of these, never free SQL. P1 = registry + flag: `source_ok`
// says whether the system records this today; the WORKER copies it onto the measure (the client's value is
// never trusted). P2 (R9) adds a daily check that reads `source` and fills `last_reading`.
//
// Seeded only from tables that exist in this codebase. source_ok = the source had rows in the 30 days to
// 2026-11-12 (read-only COUNT, checked 2026-11-12 IST); the count is in each `note`. Re-check before flipping.
//   public.scans INW 19,344 · QC_PASS+QC_FAIL 23,657 · public.v_first_pass_yield 177 day-rows ·
//   public.qc_fail_events 33 · public.pkg_scans 28,650 · public.dispatch_boxes shipped 9,042 ·
//   public.downtime_events 0 (0 ever) · store.grn_register 811 · store.issue_register 1,825 ·
//   store.production_runs 8 · sales.sales_fact 2,882 · sales.mkt_fact 3,291 · sales.traffic_fact 407 ·
//   podium.one_on_ones 0 (0 ever) · podium.okr_checkins 0 (0 ever) · docket.tasks completed 32.

export const METRIC_SYSTEMS = ['redline', 'garage', 'odo', 'podium', 'docket', 'manual'];

export const PLAN_METRICS = [
  { key: 'redline.units_inwarded', system: 'redline', label: 'Units inwarded (INW scans)', unit: 'units',
    source_ok: true, source: "public.scans (activity = 'INW')", note: '19,344 INW scans in the 30 days to 2026-11-12' },
  { key: 'redline.first_pass_yield', system: 'redline', label: 'QC first-pass yield', unit: '%',
    source_ok: true, source: 'public.v_first_pass_yield (fpy_pct)', note: '177 line/product day-rows in the 30 days to 2026-11-12' },
  { key: 'redline.qc_fail_units', system: 'redline', label: 'Units failing QC', unit: 'units',
    source_ok: true, source: 'public.qc_fail_events', note: '33 rows in the 30 days to 2026-11-12' },
  { key: 'redline.units_packed', system: 'redline', label: 'Units packed (PKG)', unit: 'units',
    source_ok: true, source: 'public.pkg_scans (packed_at)', note: '28,650 rows in the 30 days to 2026-11-12' },
  { key: 'redline.units_shipped', system: 'redline', label: 'Dispatch boxes shipped', unit: 'boxes',
    source_ok: true, source: 'public.dispatch_boxes (shipped_at)', note: '9,042 shipped in the 30 days to 2026-11-12' },
  { key: 'redline.downtime_minutes', system: 'redline', label: 'Line downtime', unit: 'minutes',
    source_ok: false, source: 'public.downtime_events (duration_mins)', note: 'no rows ever (checked 2026-11-12) — nothing logs downtime yet' },
  { key: 'garage.grn_lines', system: 'garage', label: 'Goods received (GRN lines)', unit: 'lines',
    source_ok: true, source: 'store.grn_register', note: '811 lines in the 30 days to 2026-11-12' },
  { key: 'garage.issue_lines', system: 'garage', label: 'Parts issued to production', unit: 'lines',
    source_ok: true, source: 'store.issue_register', note: '1,825 lines in the 30 days to 2026-11-12' },
  { key: 'garage.production_runs', system: 'garage', label: 'Production runs released', unit: 'runs',
    source_ok: true, source: 'store.production_runs', note: '8 runs in the 30 days to 2026-11-12' },
  { key: 'odo.net_revenue', system: 'odo', label: 'Net revenue (ex-GST)', unit: '₹',
    source_ok: true, source: 'sales.sales_fact (sale_date)', note: '2,882 rows in the 30 days to 2026-11-12' },
  { key: 'odo.ad_spend', system: 'odo', label: 'Marketing spend', unit: '₹',
    source_ok: true, source: 'sales.mkt_fact (spend)', note: '3,291 rows in the 30 days to 2026-11-12' },
  { key: 'odo.web_sessions', system: 'odo', label: 'Website sessions / conversion', unit: 'sessions',
    source_ok: true, source: 'sales.traffic_fact', note: '407 rows in the 30 days to 2026-11-12' },
  { key: 'podium.one_on_ones', system: 'podium', label: '1:1s held', unit: 'meetings',
    source_ok: false, source: 'podium.one_on_ones', note: 'no rows ever (checked 2026-11-12)' },
  { key: 'podium.okr_checkins', system: 'podium', label: 'OKR check-ins', unit: 'check-ins',
    source_ok: false, source: 'podium.okr_checkins', note: 'no rows ever (checked 2026-11-12)' },
  { key: 'docket.tasks_done', system: 'docket', label: 'Docket tasks completed', unit: 'tasks',
    source_ok: true, source: 'docket.tasks (completed_at)', note: '32 completed in the 30 days to 2026-11-12' },
  { key: 'manual', system: 'manual', label: 'Manual — no system records it', unit: null,
    source_ok: false, source: null, note: 'someone reports it by hand; always flagged' },
];

const BY_KEY = Object.fromEntries(PLAN_METRICS.map(m => [m.key, m]));
export function metricByKey(key) { return Object.prototype.hasOwnProperty.call(BY_KEY, key) ? BY_KEY[key] : null; }

// What the app needs (no `source` table names — those are worker detail).
export function publicMetrics() {
  return PLAN_METRICS.map(({ key, system, label, unit, source_ok }) => ({ key, system, label, unit, source_ok }));
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
