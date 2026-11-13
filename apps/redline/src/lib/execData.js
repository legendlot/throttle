// Overview (exec) data shaping — the normalisation each query's fetcher applies before
// its result is held or cached (instant-load pattern, see reference/decisions.md). Pure,
// so the cached path and the fresh path are the same function and node:test can reach it.

// IST calendar date / month for CACHE KEYS only. Figures that mean "today" (or "this
// month") are cached under the IST day (month) they belong to, so a tab reopened the next
// morning — or on the 1st — never seeds old figures under "Today" / "proj / mo". The dates
// SENT to the worker are unchanged (todayStr / getFirstOfMonthISO).
export function istDay(ms = Date.now()) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}
export function istMonth(ms = Date.now()) {
  return istDay(ms).slice(0, 7);
}

// getProductionDashboard → the four things the page renders from it.
export function normaliseDashboard(d) {
  return {
    summary: d.summary || null,
    hourly: d.hourly_dispatch?.length ? d.hourly_dispatch : (d.hourly_chart || []),
    runs: Array.isArray(d.open_runs) ? d.open_runs : [],
    scanProducts: Array.isArray(d.scan_products) ? d.scan_products : [],
  };
}

// Month-to-date packed: every car/drone RTE/RTR/RTX scan, run or no run (Afshaan
// 2026-09-25). A non-array answer used to leave the previous number standing; throwing
// does the same through the hook (existing data is kept on a failure).
export function sumMtdPacked(rows) {
  if (!Array.isArray(rows)) throw new Error('Month-to-date packed unavailable');
  return rows.reduce((sum, r) => sum + (Number(r.cnt) || 0), 0);
}

// This Week / This Month tiles: PvA over the range (pass/fail) + every packed scan in it.
// Same normalisation as before — a non-array PvA reads as no rows, a non-array packed
// answer as "unknown" (null → '—'). A FAILED call now fails the query instead of reading
// as zeros.
export function normaliseRange(pv, pk) {
  return { pva: Array.isArray(pv) ? pv : [], packed: Array.isArray(pk) ? pk : null };
}

// Open violations / return queue → the count shown. Only the count is held: the rows
// carry UPCs and nothing on the page reads them.
export const countOf = (v) => (Array.isArray(v) ? v.length : 0);
