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
// Fail loudly at startup rather than silently corrupting in-flight sends.
if (STRANDED_AFTER_MS <= IN_FLIGHT_MS) {
  throw new Error(
    `stranded-queued: STRANDED_AFTER_MS (${STRANDED_AFTER_MS}) must exceed send.js IN_FLIGHT_MS (${IN_FLIGHT_MS})`);
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

// Rows older than the threshold, oldest first. Bounded so one sweep cannot run away.
function buildSweepQuery(nowMs, enc, limit = 500) {
  const cutoff = new Date(nowMs - STRANDED_AFTER_MS).toISOString();
  return `/rest/v1/messages?status=eq.queued&queued_at=lt.${enc(cutoff)}` +
         `&order=queued_at.asc&limit=${limit}&select=id,channel,source,queued_at`;
}

function patchBody() {
  return { status: SWEEP_STATUS, reason: SWEEP_REASON };
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

module.exports = { STRANDED_AFTER_MS, IN_FLIGHT_MS, SWEEP_STATUS, SWEEP_REASON,
                   buildSweepQuery, patchBody, summarize };
