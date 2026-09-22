// Dead-instance sweep — the pure half. (S397, 2026-09-22)
//
// THE DEFECT THIS EXISTS FOR: journeys.js inserts the `comms.enrolments` row at status='active'
// and THEN creates the Workflow instance under the same id. From that moment the row's lifecycle
// belongs to the instance — every status after 'active' is written by the Workflow's own #end().
// If the instance dies without reaching #end(), or never really existed, the row stays 'active'
// forever, and for a `once_while_active` journey that profile is BLOCKED from re-enrolment until
// the J1 max_duration mop stamps it 'expired' (3–30 days later). The customer never gets the
// journey, and for Order Placed that is the order WhatsApp.
//
// Measured 2026-09-22: 29 such rows in two cohorts, both proven by asking Cloudflare —
//   • 16 from 2026-08-26/27: instance ERRORED at its first wait with `PGRST106 Invalid schema:
//     comms` (the exposed-schemas reset that day). The Workflow threw; nothing wrote the row.
//   • 13 from 2026-09-13 17:11–22:49 IST: instance NOT FOUND — create() returned without an
//     instance existing. 13 of 608 enrolments in that window (2%); nothing since.
// Neither shape is reachable by a try/catch in enrol(): the first happens inside the Workflow,
// the second is Cloudflare returning success for an instance it does not have. Only an
// out-of-band probe can catch both, and the probe is one binding call per row.
//
// WHAT IT DOES: for every active enrolment that is either (a) still without a `current_step`
// an hour after enrolment — the Workflow never ran step 1 — or (b) older than 24 h at any step,
// ask the Workflow binding for the instance's status. A dead instance (errored / terminated /
// not found) → the row becomes 'failed'; a finished instance whose final PATCH never landed
// ('complete') → 'ended_unknown'. Anything alive (queued / running / waiting / paused / unknown)
// is left alone, and so is a probe that failed for any reason OTHER than not-found — a
// transient API error must never be read as "the instance is gone".

const NULL_STEP_AFTER_MS = 60 * 60 * 1000;         // (a) never started: 1 h of nothing
const ACTIVE_AFTER_MS = 24 * 60 * 60 * 1000;       // (b) any step: 24 h (live journeys run ≤ 6 h)

// ⛔ 25 per tick, not 200. Unlike stranded-queued.js (one HTTP call per batch) every candidate
// here costs a SERIAL Workflow-binding round-trip inside a cron that already runs six other jobs
// under a 4-minute single-flight lock. 200 probes at 100–300 ms is 20–60 s and a fifth of the
// subrequest budget; 25 is ≤ 8 s. A backlog drains over ticks (today's 29 = two ticks). The
// PATCH URL bound (16 KB ≈ 200 uuids) is therefore never the binding constraint.
const PROBE_LIMIT = 25;

// Oldest first, bounded. The `or=` groups the two shapes; `status=eq.active` is the outer guard.
function buildSweepQuery(nowMs, enc, limit = PROBE_LIMIT) {
  const nullStepCutoff = new Date(nowMs - NULL_STEP_AFTER_MS).toISOString();
  const activeCutoff = new Date(nowMs - ACTIVE_AFTER_MS).toISOString();
  return `/rest/v1/enrolments?status=eq.active` +
         `&or=(and(current_step.is.null,enrolled_at.lt.${enc(nullStepCutoff)}),enrolled_at.lt.${enc(activeCutoff)})` +
         `&order=enrolled_at.asc&limit=${limit}&select=id,journey_id,current_step,enrolled_at`;
}

// Instance statuses per the Workflows binding (`instance.status().status`).
const DEAD_TO_FAILED = new Set(['errored', 'terminated']);
// Cloudflare's shape: `workflows.api.error.instance.not_found [code: 10400]`.
const INSTANCE_NOT_FOUND = /instance[\s._-]*not[\s._-]*found|\b10400\b/i;
const ALIVE = new Set(['queued', 'running', 'paused', 'waiting', 'waitingForPause', 'unknown']);

// probe = { found: true, status } | { found: false, error }
// → { dead: false } | { dead: true, to: 'failed' | 'ended_unknown', why }
function classify(probe) {
  if (!probe || typeof probe !== 'object') return { dead: false, why: 'no_probe' };
  if (probe.found === false) {
    // ⚠️ Only a NOT-FOUND is a verdict. A 5xx, a timeout or a binding hiccup says nothing about
    // the instance, and sweeping on it would kill live journeys during a Cloudflare blip.
    // ⛔ INSTANCE-scoped wording only. "Workflow JOURNEY_WORKFLOW not found" (a binding/class
    // rename, a mid-deploy window) is a FLEET error — matching a bare 'not found' would stamp
    // every candidate 'failed' while their instances run on, and unblock dedup into double sends.
    const msg = String(probe.error || '');
    if (INSTANCE_NOT_FOUND.test(msg)) return { dead: true, to: 'failed', why: 'instance_not_found' };
    return { dead: false, why: 'probe_error' };
  }
  const s = String(probe.status || '');
  if (DEAD_TO_FAILED.has(s)) return { dead: true, to: 'failed', why: `instance_${s}` };
  // 'complete' with the row still active means #end()'s own PATCH never landed — and #end was
  // writing ANY of progressed / purchased / no_response / completed … which we cannot know
  // from here. Stamping 'completed' would silently under-count purchases in journey_funnel.
  // 'ended_unknown' is the honest value: the journey finished, the outcome was lost.
  if (s === 'complete') return { dead: true, to: 'ended_unknown', why: 'instance_complete_row_active' };
  if (ALIVE.has(s)) return { dead: false, why: `instance_${s}` };
  return { dead: false, why: `instance_status_unrecognised:${s}` };   // fail SAFE on a new status
}

function patchBody(to, nowIso) {
  return { status: to, ended_at: nowIso };
}

// ⛔ BATCH SANITY GUARD. A real not-found cohort is a fraction of a window (2026-09-13: 13 of
// 608). EVERY candidate reading not-found is, by construction, not a cohort — it is the probe
// itself failing in a way the regex did not anticipate. Refuse to write; the log carries it.
const ABORT_ALL_NOT_FOUND_ABOVE = 10;
function shouldAbort({ why, n }) {
  return n > ABORT_ALL_NOT_FOUND_ABOVE && (why?.instance_not_found || 0) === n;
}

// Alert when a tick sweeps in bulk — the whole point is that this class used to be silent, and
// a sweep that quietly tidies an outage every 5 minutes would make it silent again. Throttled
// on its OWN settings column (dead_instance_alert_at, migration 0074) like the sibling sweep.
const ALERT_AT = 10;
const ALERT_THROTTLE_MS = 60 * 60 * 1000;
function shouldAlert({ swept, lastAlertMs, nowMs }) {
  if (!Number.isFinite(swept) || swept < ALERT_AT) return false;
  const last = Number.isFinite(lastAlertMs) ? lastAlertMs : 0;
  return (nowMs - last) >= ALERT_THROTTLE_MS;
}
function alertText(out) {
  return `⚠️ *Relay — ${out.swept} enrolments closed by the dead-instance sweep*\n`
       + `Their Workflow instances were gone (${JSON.stringify(out.why)}). The customers did NOT `
       + `get those journeys. Check /journeys and the commsops tail for an instance-level outage.`;
}

// Groups ids by target status and counts reasons — the log line needs both.
function plan(rows, probes) {
  const byStatus = {};
  const why = {};
  let alive = 0;
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!r || !r.id) continue;
    const c = classify(probes[r.id]);
    why[c.why] = (why[c.why] || 0) + 1;
    if (!c.dead) { alive++; continue; }
    (byStatus[c.to] ||= []).push(r.id);
  }
  return { byStatus, why, alive };
}

module.exports = { NULL_STEP_AFTER_MS, ACTIVE_AFTER_MS, PROBE_LIMIT, ABORT_ALL_NOT_FOUND_ABOVE,
                   ALERT_AT, ALERT_THROTTLE_MS,
                   buildSweepQuery, classify, patchBody, plan, shouldAbort, shouldAlert, alertText };
