// ── Exotel → NormalisedCall ──────────────────────────────────────────────────
//
// The only place that knows Exotel's field names. Everything downstream sees the
// vendor-neutral shape that call-pipeline.js consumes.

import { normaliseDirection } from './call-pipeline.js';
import { fromIstNaive } from './exotel-client.js';

/**
 * Map Exotel's outcome onto (status, dial_status).
 *
 * ⚠️ THIS IS WHERE THE MISSED-CALL DEFECT GETS FIXED. Under MyOperator, `missed` sat
 * on 45 of 17,705 rows (0.25%) at ~110 calls/day — it only marked missed when
 * call.end reported duration=0, which it almost never did. Every missed-call KPI, the
 * nav badge and the Missed tab were reading a number that was not what it claimed.
 *
 * ⚠️ The count WILL jump and WILL read as a regression. It is the correction landing —
 * same shape as the S298 agent-report rebuild (August closed moved 4,496 → 5,743).
 * Warn the team in the same breath as the release.
 *
 * The `answered` vs `abandoned` split turns on TALK time, not leg time: a call that
 * rang, connected the leg and had nobody speak is not an answered call. Exotel gives
 * us Details.ConversationDuration for exactly this; MyOperator never did, which is why
 * ~30% of inbound (1–15s) was landing as `answered` with no agent.
 */
export function mapExotelStatus(rawStatus, talkSeconds) {
  const s = String(rawStatus || '').toLowerCase().trim();
  const talk = Number(talkSeconds) || 0;
  switch (s) {
    case 'completed':
      return { status: talk > 0 ? 'answered' : 'abandoned', dial_status: 'completed' };
    case 'no-answer':
    case 'no_answer':
      return { status: 'missed',      dial_status: 'no-answer' };
    case 'busy':
      return { status: 'missed',      dial_status: 'busy' };
    case 'failed':
      return { status: 'failed',      dial_status: 'failed' };
    case 'canceled':
    case 'cancelled':
      return { status: 'missed',      dial_status: 'canceled' };
    case 'queued':
    case 'in-progress':
    case 'in_progress':
      return { status: 'in_progress', dial_status: s };
    default:
      // Unknown vocabulary: record the call, keep the raw value in dial_status, and
      // LOG. Never invent a status — `status` is NOT NULL and CHECK-constrained, so a
      // guess would either reject the row or fake a metric.
      console.log(`[exotel] unmapped status "${rawStatus}" — recording as in_progress, raw kept in dial_status`);
      return { status: 'in_progress', dial_status: s || null };
  }
}

/** A missed/unanswered call earns a place in the callback queue. */
export function needsCallback(status, direction) {
  return direction === 'incoming' && (status === 'missed' || status === 'abandoned');
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Exotel Call object → NormalisedCall.
 *
 * ⚠️ Which number is the CUSTOMER depends on direction, and getting it backwards
 * would file every call against our own ExoPhone:
 *   inbound        → From = customer, To   = our ExoPhone
 *   outbound-*     → To   = customer, From = the agent leg (we set it on connect)
 * `PhoneNumber` carries the virtual number when Exotel supplies it; fall back to the
 * direction-derived value.
 */
export function exotelToNormalised(call, { departmentId = null } = {}) {
  const direction = normaliseDirection(call.Direction, 'exotel');
  const inbound = direction === 'incoming';

  const details = call.Details || {};
  const talk = num(details.ConversationDuration);
  const legDuration = num(call.Duration);
  const { status, dial_status } = mapExotelStatus(call.Status, talk);

  const customer_phone = inbound ? (call.From || null) : (call.To || null);
  const exophone = call.PhoneNumber || (inbound ? (call.To || null) : (call.From || null));

  return {
    provider: 'exotel',
    // Mirrored: call_session_id is NOT NULL and is what ~20 existing call sites read.
    call_session_id:   call.Sid,
    provider_call_sid: call.Sid,
    account_id: null,          // Exotel rows carry no myop_accounts FK
    department_id: departmentId,
    direction,
    exophone,
    customer_phone,
    started_at: fromIstNaive(call.StartTime || call.DateCreated),
    ended_at:   fromIstNaive(call.EndTime || call.DateUpdated),
    status,
    dial_status,
    leg_duration_seconds:  legDuration,
    talk_duration_seconds: talk,
    price_inr:   num(call.Price),
    recording_url: call.RecordingUrl || null,
    legs: Array.isArray(details.Legs) ? details.Legs : [],
    agent_ref: {},
    raw: call,
  };
}

/**
 * The cs_calls patch for a reconciled Exotel call.
 *
 * ⚠️ `duration_seconds` keeps its ORIGINAL meaning — leg time — so no existing metric
 * silently shifts under the team. Talk time lands in the new `talk_duration_seconds`.
 * Anything comparing against a figure written down last month still compares like for
 * like; anything that wants the honest number asks for the new column.
 *
 * ⚠️ Only defined values are written. Exotel settles Duration/Price/EndTime ~2 min
 * after a call ends, so an early read carries nulls — and blindly patching them would
 * wipe values a later pass already filled in.
 */
export function exotelCallPatch(norm) {
  const patch = {
    status: norm.status,
    dial_status: norm.dial_status,
    raw_meta: { last_event: 'poll', provider: 'exotel' },
  };
  const maybe = {
    started_at: norm.started_at,
    ended_at: norm.ended_at,
    duration_seconds: norm.leg_duration_seconds,
    talk_duration_seconds: norm.talk_duration_seconds,
    price_inr: norm.price_inr,
    recording_url: norm.recording_url,
    exophone: norm.exophone,
  };
  for (const [k, v] of Object.entries(maybe)) {
    if (v !== null && v !== undefined) patch[k] = v;
  }
  if (needsCallback(norm.status, norm.direction)) patch.needs_callback = true;
  return patch;
}

/** A call is settled once Exotel has finalised the fields it back-fills. */
export function isSettled(norm) {
  if (norm.status === 'in_progress') return false;
  // A completed call must have a talk duration; a missed one legitimately has none.
  if (norm.status === 'answered' || norm.status === 'abandoned') {
    return norm.talk_duration_seconds !== null && norm.leg_duration_seconds !== null;
  }
  return true;
}
