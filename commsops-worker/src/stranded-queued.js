// Stranded-queued sweep — the pure half.
//
// THE DEFECT THIS EXISTS FOR: send.js reserves a `comms.messages` row at status='queued' (the
// dedup reserve) and every ordinary path afterwards closes it via finalize(). If the worker dies
// BETWEEN those two points the row stays 'queued' forever. It is then invisible to every rate that
// filters on real outcomes — deliverability, journey health, campaign stats all skip it — so the
// failure produces no signal at all. Same class as the deliverability alert that could never clear
// itself (see deliverability-window.js): something broken that nothing reports.
//
// Measured 2026-09-03 (S340): 35 such rows spanning 2026-08-09 → 09-01 across THREE paths —
// email/campaign, whatsapp/campaign and whatsapp/journey — so it is a recurring defect on both
// surfaces, not one bad run. All 35 were cleared by hand that day; this sweep is what stops the
// next batch accumulating silently.
//
// ⭐ WHY A SWEEP AND NOT A try/catch: the dominant cause is the isolate going away mid-fan-out
// (eviction, CPU limit, an abandoned queue batch). No in-process handler runs in that case, so
// only an out-of-band pass can catch it. A try/catch around the send path would fix the narrow
// "an exception was thrown" case and miss the common one.

const { IN_FLIGHT_MS } = require('./send.js');

// A row must be stranded for strictly LONGER than send.js's in-flight window before we touch it.
// 60 min against a 10 min window = 6x headroom.
const STRANDED_AFTER_MS = 60 * 60 * 1000;

// ⛔ LOAD-TIME GUARD. Sweeping inside the in-flight window would mark LIVE sends as abandoned
// while they are still running — the one way this sweep could cause harm rather than prevent it.
// ⚠️ MUST test Number.isFinite FIRST, not just the comparison. `3600000 <= undefined` is FALSE, so
// a bare `STRANDED_AFTER_MS <= IN_FLIGHT_MS` check FAILS OPEN on exactly the drift it exists to
// catch: if a refactor drops the export from send.js (or introduces a partial require cycle),
// IN_FLIGHT_MS is undefined, the comparison is false, no throw fires, and the sweep runs with no
// relationship to the in-flight window at all. Caught in the S340 hostile review.
if (!Number.isFinite(IN_FLIGHT_MS) || !(STRANDED_AFTER_MS > IN_FLIGHT_MS)) {
  throw new Error(
    `stranded-queued: STRANDED_AFTER_MS (${STRANDED_AFTER_MS}) must be a finite value exceeding ` +
    `send.js IN_FLIGHT_MS (${IN_FLIGHT_MS}) — refusing to sweep without a proven in-flight margin`);
}

const SWEEP_STATUS = 'skipped';

// 'skipped', not 'failed', for the same reason the manual clear used it: a stranded row is a
// non-send, and 'skipped' is excluded from deliverability stats — calling it 'failed' would
// invent delivery failures that never happened and inflate the very numbers used to spot trouble.
// ⚠️ HONEST LIMITATION, stated here because the row cannot express it: we cannot prove a swept row
// was never delivered. provider_message_id is written by finalize(), so a send that succeeded and
// then lost its receipt looks identical to one that never left. Both were true of the 35 (all had
// a NULL provider id). Under-counting a delivered message is the safer error than re-sending it —
// and re-sending is never automatic anyway (reference/decisions.md, Afshaan 2026-09-03).
const SWEEP_REASON =
  'stranded_queued: fan-out ended between the dedup reserve and finalize; swept as a non-send. ' +
  'May have been delivered without its receipt — never auto-resend, ask.';

// ⛔ 200, not 500. The PATCH built from these ids is `?id=in.(<uuid>,…)`: 500 × 36 chars + commas
// + path is ~18.5 KB, over Cloudflare's 16 KB Workers URL limit — and it would fire ONLY in the
// bulk-stranding case this feature exists for, i.e. it would break exactly when needed. 200 ids is
// ~7.4 KB. A backlog larger than one tick drains over subsequent ticks; the sweep is idempotent.
const SWEEP_LIMIT = 200;

// Rows older than the threshold, oldest first. Bounded so one sweep cannot run away.
// ⛔ `provider_message_id=is.null` IS A SAFETY FILTER, NOT AN OPTIMISATION — do not drop it. A
// queued row that already carries a provider id was handed to the provider and may well have been
// DELIVERED (a partial finalize, or an out-of-order webhook that wrote the id first). Sweeping it
// to 'skipped' would erase a real delivered message from every deliverability and campaign stat.
// The manual clear of the original 35 rows verified this property by hand before flipping them
// (all 35 had a NULL provider id); the automated sweep must assert it rather than assume it.
// Added in the S340 hostile review, which caught that the sweep had dropped the filter.
function buildSweepQuery(nowMs, enc, limit = SWEEP_LIMIT) {
  const cutoff = new Date(nowMs - STRANDED_AFTER_MS).toISOString();
  return `/rest/v1/messages?status=eq.queued&provider_message_id=is.null` +
         `&queued_at=lt.${enc(cutoff)}` +
         `&order=queued_at.asc&limit=${limit}&select=id,channel,source,queued_at`;
}

function patchBody() {
  return { status: SWEEP_STATUS, reason: SWEEP_REASON };
}

// Alert only when the sweep CLEARED rows in bulk, and at most once an hour.
// ⚠️ Two independent reasons this gate exists, both from the S340 hostile review:
//   1. The caller must pass wrote=false when the PATCH failed. Otherwise the alert fires on a
//      sweep that changed nothing, the rows stay queued, and the next tick alerts again — an alert
//      that can never clear itself, which is the exact defect this same session fixed in the
//      deliverability watch. A failed write is a LOG, not a page.
//   2. Its own throttle column (settings.stranded_alert_at, migration 0065) so this alert can
//      never mask — or be masked by — the deliverability or journey-health alerts.
const STRANDED_ALERT_AT = 100;
const ALERT_THROTTLE_MS = 60 * 60 * 1000;

function shouldAlert({ swept, wrote, lastAlertMs, nowMs }) {
  if (!wrote) return false;
  if (!Number.isFinite(swept) || swept < STRANDED_ALERT_AT) return false;
  const last = Number.isFinite(lastAlertMs) ? lastAlertMs : 0;
  return (nowMs - last) >= ALERT_THROTTLE_MS;
}

function alertText(out) {
  return `⚠️ *Relay — ${out.swept} stranded sends swept*\nRows left at 'queued' by a fan-out that `
       + `ended mid-send: ${JSON.stringify(out.by)}. They were marked skipped, NOT re-sent. `
       + `Check /journeys + campaign fan-out for a run that died.`;
}

// Grouped counts for the log line — which surface is stranding rows matters more than the total.
function summarize(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const by = {};
  for (const r of list) {
    if (!r) continue;
    const kind = String(r.source || '').split(':')[0] || 'unknown';
    const key = `${r.channel || 'unknown'}/${kind}`;
    by[key] = (by[key] || 0) + 1;
  }
  return { swept: list.length, by, oldest: list[0]?.queued_at || null };
}

module.exports = { STRANDED_AFTER_MS, IN_FLIGHT_MS, SWEEP_STATUS, SWEEP_REASON, SWEEP_LIMIT,
                   STRANDED_ALERT_AT, ALERT_THROTTLE_MS,
                   buildSweepQuery, patchBody, summarize, shouldAlert, alertText };
