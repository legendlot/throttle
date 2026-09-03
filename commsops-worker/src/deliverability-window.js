// Deliverability-alert windowing + threshold — the pure half of checkDeliverabilitySpike().
//
// WHY THIS IS ITS OWN FILE: index.js is the ESM worker entry and no test in this suite imports
// it, so the alert logic had no coverage at all — which is how it shipped with no recency window
// and paged hourly for eight days. Same reasoning (and same shape) as courier-display.js: pull the
// decision out, unit-test it, leave index.js holding only the I/O.
//
// ⛔ THE WINDOW IS THE POINT. Until 2026-09-03 (S340) the query was a bare `order=queued_at.desc
// &limit=100` with NO time filter, so once sending went quiet the SAME rows were re-scored every
// hour, forever. Relay last sent email on 2026-08-26 and was still paging on 2026-09-03 with a
// byte-identical "23/100 ... (23%)" — a 72-second slice of an 8-day-old campaign (13 hard + 10
// soft bounces, 77 delivered alongside). Without a window the check cannot tell "nothing is
// sending" from "everything is failing", so once a bad slice froze in place it could only ever be
// a false alarm. An alert that can never clear itself is not a monitor.

const DELIVERABILITY_WINDOW_H = 24;

// Minimum real outcomes before a rate means anything. An IDLE CHANNEL LANDS HERE AND STAYS QUIET:
// no data is "nobody sent anything", never "everything failed".
const MIN_SIGNAL = 20;

const FAIL_RATE = 0.10;

// Statuses that represent a real send outcome. skipped/suppressed/queued are excluded on purpose —
// a suppression is the gate working, not a deliverability problem.
const OUTCOME_STATUSES = 'sent,delivered,opened,clicked,bounced,failed';

// The PostgREST path. `enc` is the caller's encoder (A.enc) so this file stays dependency-free.
function buildQuery(nowMs, enc) {
  const since = new Date(nowMs - DELIVERABILITY_WINDOW_H * 3600 * 1000).toISOString();
  return `/rest/v1/messages?channel=eq.email&status=in.(${OUTCOME_STATUSES})` +
         `&queued_at=gte.${enc(since)}` +
         '&order=queued_at.desc&limit=100&select=status,provider_status';
}

// rows → {alert, failed, complaints, rate, total}. Pure: no clock, no network.
function evaluate(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const total = list.length;
  if (total < MIN_SIGNAL) return { alert: false, failed: 0, complaints: 0, rate: 0, total };
  const complaints = list.filter((m) => m && m.provider_status === 'email.complained').length;
  const failed = list.filter((m) => m && (m.status === 'failed' || m.status === 'bounced')).length;
  const rate = failed / total;
  return { alert: rate > FAIL_RATE || complaints > 0, failed, complaints, rate, total };
}

function alertText(ev) {
  return `⚠️ *Relay — deliverability alert*\n${ev.failed}/${ev.total} email sends in the last ` +
         `${DELIVERABILITY_WINDOW_H}h failed/bounced (${Math.round(ev.rate * 100)}%)` +
         `${ev.complaints ? `, ${ev.complaints} spam complaint(s)` : ''}. Check /analytics.`;
}

module.exports = { DELIVERABILITY_WINDOW_H, MIN_SIGNAL, FAIL_RATE, OUTCOME_STATUSES,
                   buildQuery, evaluate, alertText };
