// Uniware tracking sync — the multi-page run driver + the window calculation (pure; node-testable).
//
// The sync used to process ONE page of 25 orders per hourly tick (a cap sized against the
// Free-plan 50-subrequest ceiling; LOT is on Paid = 10,000). 600 orders/day could not keep up
// with 300–500 dispatches/day plus every status change on in-flight parcels, so the UPDATED
// cursor fell 35 h behind the present (measured 2026-09-17) and Relay's "Order shipped" WhatsApp
// landed 27–49 h after dispatch. A tick now keeps taking pages until it reaches the live edge or
// spends its budget. Each page still persists its own progress, so a run that stops (budget,
// error, eviction) resumes exactly where it left off on the next tick.

// Per-run budget. Gets are the real Uniware cost (one saleorder/get per changed order, sequential);
// pages bound the search calls when a window is mostly skipped/known orders; ms keeps the hourly
// tick's later steps (funnel snapshot etc.) from waiting on a long catch-up.
export const UNI_TRACK_RUN_BUDGET = { maxPages: 80, maxGets: 400, maxMs: 4 * 60 * 1000 };

// runPage() → one page's result ({ seen, candidates, fetched, packages, caughtUp, cursor, window })
// or { skipped: 'caught_up' }. A finished WINDOW is not the end of the run — only caughtUp is.
export async function runTrackingPages(runPage, budgetIn = UNI_TRACK_RUN_BUDGET, clock = Date.now) {
  const budget = { ...UNI_TRACK_RUN_BUDGET, ...budgetIn };   // a partial budget never disables a guard
  const t0 = clock();
  const total = { pages: 0, seen: 0, candidates: 0, fetched: 0, packages: 0,
                  window: null, cursor: null, stopped: null };
  for (;;) {
    if (total.pages >= budget.maxPages) { total.stopped = 'max_pages'; break; }
    if (total.fetched >= budget.maxGets) { total.stopped = 'max_gets'; break; }
    if (clock() - t0 >= budget.maxMs) { total.stopped = 'max_ms'; break; }
    let r;
    try { r = await runPage(); }
    catch (e) {
      total.ms = clock() - t0;
      if (e && typeof e === 'object') e.partial = total;
      throw e;
    }
    if (r?.skipped) { total.stopped = r.skipped; break; }
    total.pages += 1;
    total.seen += r.seen || 0;
    total.candidates += r.candidates || 0;
    total.fetched += r.fetched || 0;
    total.packages += r.packages || 0;
    if (r.window) total.window = [total.window ? total.window[0] : r.window[0], r.window[1]];
    total.cursor = r.cursor;
    if (r.caughtUp) { total.stopped = 'caught_up'; break; }
  }
  total.ms = clock() - t0;
  return total;
}

// The [winStart, winEnd) the next page reads. A multi-page window keeps its frozen end
// (state.win_end_ms) so the offset always indexes one immutable range. An unfrozen window ends at
// cursor+windowMs or at the live edge, whichever is earlier. The live edge is `now - edgeLagMs`,
// not `now`: precautionary (unmeasured) room for Uniware's search index to settle — an order
// missed at the edge is only seen again on its NEXT update, which is exactly the "shipped after
// out-for-delivery" symptom. liveEdge = this window reaches the present; finishing it = caught up.
// `offset` is only meaningful INSIDE a frozen window: a stored page_offset with no live frozen end
// (a hand-moved cursor, a stale row) would start a fresh window mid-page and skip its first rows.
export function trackingWindow(state, now, windowMs, edgeLagMs) {
  const winStart = Number(state?.cursor_ms) || (now - 3 * 86400000);   // cold start: 3 days back
  const frozenEnd = Number(state?.win_end_ms) || 0;
  if (frozenEnd > winStart) {
    return { winStart, winEnd: frozenEnd, liveEdge: false, offset: Number(state?.page_offset) || 0 };
  }
  const edge = now - edgeLagMs;
  if (winStart >= edge) return { winStart, winEnd: edge, liveEdge: true, offset: 0, empty: true };
  const full = winStart + windowMs;
  return full < edge ? { winStart, winEnd: full, liveEdge: false, offset: 0 }
                     : { winStart, winEnd: edge, liveEdge: true, offset: 0 };
}

// saleorder/get failures tolerated per page before the page is ABORTED (thrown before the state
// patch, so it is retried next tick). An isolated bad order must not deadlock the whole feed, so a
// few are skipped with a warning; more than this is an outage or rate limiting, where skipping
// would advance the offset past every failed order and lose it until its next Uniware update.
export const UNI_TRACK_MAX_GET_FAILS = 3;
