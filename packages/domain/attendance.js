// Attendance helpers shared by Garage / Redline / Depot.
//
// ⚠️ THE RULE THIS EXISTS TO ENFORCE: an attendance ROW is not the same as being PRESENT.
// A supervisor can mark the day `absent` or `leave` and the row stays exactly where it was
// (that is what day_status is for — RULE-ATT-001). Counting rows therefore reports people
// known to be away as present.
//
// This was live on FIVE surfaces until 2026-08-28 (S322) — Garage dashboard "Store Present",
// Garage Manpower "N present", Redline Manpower "N present", Redline /exec per-line roster,
// and it was fixed piecemeal twice before the full set was swept. Hence one helper: the next
// surface that needs a headcount should be correct by default rather than by remembering.
//
// ⚠️ Values are lowercase snake_case — `absent`, NOT the display label `Absent` the manuals
// show. A filter written against the labels matches nothing and looks like it worked.
// The full allow-list enforced by the worker is
// ['full_day','half_day','absent','leave','holiday', null].
// `half_day` / `full_day` / `holiday` / null all COUNT as present — only the two states that
// mean "not at work" are excluded.
export const AWAY_DAY_STATUSES = Object.freeze(['absent', 'leave']);

const AWAY = new Set(AWAY_DAY_STATUSES);

/** True when this attendance row represents someone who was actually at work. */
export function isPresent(row) {
  return !AWAY.has(row?.day_status);
}

/**
 * Distinct operators actually present, from raw operator_attendance rows.
 * Deduplicates by operator_id, because one operator can hold more than one row a day.
 */
export function countPresent(rows) {
  if (!Array.isArray(rows)) return 0;
  return new Set(rows.filter(isPresent).map(r => r.operator_id)).size;
}
