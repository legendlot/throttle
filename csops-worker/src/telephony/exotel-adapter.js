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
export function mapExotelStatus(rawStatus, talkSeconds, ended = false, connected = false, unfinishedAnswered = false) {
  const s = String(rawStatus || '').toLowerCase().trim();
  const talk = Number(talkSeconds) || 0;
  // ⚠️ Exotel sometimes finalises a call with NO Status at all — EndTime set, legs timed
  // (29 outgoing calls on 2026-09-30 sat at in_progress forever because the default below
  // keeps unknowns open). An ENDED call cannot be in progress, so map it the way `completed`
  // is mapped (Afshaan, S412), marked in dial_status so it stays distinguishable.
  // ⚠️ On those rows ConversationDuration is 0 EVEN WHEN THE CALL CONNECTED (22 of the 29 had a
  // recording and a second leg on-call 4–264 s), so talk alone would file real conversations
  // as abandoned. `connected` = a recording exists or a non-first leg was on the call.
  if (!s && ended) {
    console.log(`[exotel] call ended with no Status (talk=${talk}, connected=${connected}) — mapped as completed`);
    return { status: (talk > 0 || connected) ? 'answered' : 'abandoned', dial_status: 'ended-no-status' };
  }
  switch (s) {
    case 'completed':
      // `unfinishedAnswered` (exotelUnfinishedAnswered): an INBOUND call Exotel closed as
      // completed without finishing the record — talk 0, no legs, EndTime 1970 — but with a
      // recording. 521 such calls over 10 s (23 Aug–9 Oct) were filed abandoned, mostly also queued
      // for callback, although an agent had spoken to the customer (Pruthvi #bugs 1791541942.326389).
      return { status: (talk > 0 || unfinishedAnswered) ? 'answered' : 'abandoned', dial_status: 'completed' };
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
/**
 * Did the call actually connect, judged WITHOUT ConversationDuration (which Exotel leaves 0 on
 * calls it finalises with no Status)? A recording, or any leg after the first with on-call time.
 * Legs are nested under `Leg` (observed shape, see collectAgentIdentifiers).
 */
export function exotelConnected(call) {
  if (call?.RecordingUrl) return true;
  const legs = Array.isArray(call?.Details?.Legs) ? call.Details.Legs : [];
  return legs.slice(1).some((l) => (Number((l && l.Leg) ? l.Leg.OnCallDuration : l?.OnCallDuration) || 0) > 0);
}

/**
 * An INBOUND call Exotel finalised UNFINISHED: no Legs at all, yet a recording exists. Exotel's
 * own dashboard shows these as completed with Talk Time 0s and End Time 01 Jan 1970, hours later,
 * so re-polling never completes them. Measured 2026-10-09 over every Exotel call: a recording sits
 * on every normally-answered inbound call and on NO normally-abandoned one, and all 533 inbound
 * completed+recording+no-legs rows were this shape.
 * ⚠️ Inbound only: our OUTBOUND calls also arrive with no legs and a recording (148 abandoned), but
 * there the recording only proves the AGENT leg connected — not that the customer picked up.
 */
// Shortest normally-answered inbound Exotel call: 11 s, and greeting + ring alone never took under
// 9 s (measured 2026-10-09, 2,298 answered calls). The 12 unfinished calls at ≤10 s (of 533) hung up
// in the greeting — the recording is the IVR, not a conversation.
const MIN_ANSWERABLE_SECONDS = 10;

export function exotelUnfinishedAnswered(call, direction) {
  if (direction !== 'incoming' || !call?.RecordingUrl) return false;
  if (!(Number(call.Duration) > MIN_ANSWERABLE_SECONDS)) return false;
  const legs = call?.Details?.Legs;
  return !Array.isArray(legs) || legs.length === 0;
}

export function exotelToNormalised(call, { departmentId = null } = {}) {
  const direction = normaliseDirection(call.Direction, 'exotel');
  const inbound = direction === 'incoming';

  const details = call.Details || {};
  const talk = num(details.ConversationDuration);
  const legDuration = num(call.Duration);
  const { status, dial_status } = mapExotelStatus(call.Status, talk, Boolean(call.EndTime), exotelConnected(call),
    exotelUnfinishedAnswered(call, direction));

  // ⚠️ OBSERVED 2026-08-20 from a live inbound call — the field names are not what
  // the shape suggests, and one of them was mapped wrongly on the first pass:
  //   From           = the CUSTOMER
  //   To             = the AGENT leg, e.g. "sip:sunithab17b95f7f"  ← NOT our number
  //   PhoneNumberSid = the ExoPhone, e.g. "08044656833"            ← despite the name,
  //                    this is a NUMBER, not a SID
  // Using `To` as the ExoPhone on inbound stored an agent's SIP id in the exophone
  // column. There is deliberately NO inbound fallback to `To` now: a wrong number is
  // worse than a null one, because it looks like data.
  const customer_phone = inbound ? (call.From || null) : (call.To || null);
  const exophone = call.PhoneNumberSid || call.PhoneNumber
    || (inbound ? null : (call.From || null));

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
    // Persist the raw legs. Same instrument-first move the MyOperator path made after
    // S144: the real Details.Legs[] shape has not been observed, and attribution is
    // built on guesses until it is. This makes the next real routed call the evidence.
    raw_meta: {
      last_event: 'poll', provider: 'exotel',
      legs: Array.isArray(norm.legs) ? norm.legs : [],
    },
  };
  // No legs = Exotel left the record unfinished (exotelUnfinishedAnswered) and there is nothing to
  // attribute the agent from. Keep the two fields that might name them, so the next such call is
  // the evidence (Pruthvi reports Exotel's own To column shows the agent on these, S413).
  if (!patch.raw_meta.legs.length && norm.raw) {
    patch.raw_meta.to = norm.raw.To ?? null;
    patch.raw_meta.dial_whom = norm.raw.DialWhomNumber ?? null;
  }
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
  // ...and cleared once a later poll finds the call answered (e.g. an unfinished record that was
  // first read before its recording landed). The flag is derived from status alone — markCalledBack
  // never touches it — so clearing it here loses nothing.
  else if (norm.status === 'answered') patch.needs_callback = false;
  return patch;
}

/**
 * The ONE agent the flow rang for this call, from the agent-hook's dial_attempts (S410), or null
 * when none or several were rung. Only meaningful on a call already proven answered
 * (exotelUnfinishedAnswered): a Dial fire alone means "rang", not "picked up".
 */
export function soleDialedAgent(dialAttempts) {
  const rung = new Set((Array.isArray(dialAttempts) ? dialAttempts : [])
    .filter((a) => a && (!a.event || a.event === 'dial') && typeof a.agent === 'string' && a.agent.trim())
    .map((a) => a.agent.trim().toLowerCase()));
  return rung.size === 1 ? [...rung][0] : null;
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

/**
 * Every identifier in an Exotel call that could name one of OUR agents.
 *
 * ⚠️ Deliberately shape-tolerant rather than reading one documented field. The docs
 * say Details.Legs[] carries { Id, OnCallDuration, Status, AnsweredBy }, but the real
 * payload has not been observed yet, and the codebase has been burned by trusting a
 * vendor's documented field name before (metaAttachmentKind, the dropped reels). So
 * this walks the leg objects and collects anything that LOOKS like an identity — a
 * SIP URI or a 10+ digit number — and lets the caller match those against the known
 * roster. An unknown field name costs nothing; a wrong assumption costs attribution.
 *
 * Outbound is exact and needs no guessing: we set `From` to the agent on connect.
 */
export function agentCandidates(call, direction) {
  const out = [];
  const push = (v) => {
    if (typeof v !== 'string') return;
    const s = v.trim();
    if (!s) return;
    if (/^sip:/i.test(s)) out.push(s.toLowerCase());
    else if (/^\+?\d[\d\s-]{8,}$/.test(s)) out.push(s);
  };

  // The agent is on the OPPOSITE end from the customer:
  //   inbound  → `To` is the agent leg (SIP id, or a mobile number)
  //   outbound → `From` is the agent, by construction (Calls/connect From=agent)
  // Confirmed live 2026-08-20: an inbound call carried To="sip:sunithab17b95f7f".
  push(direction === 'outgoing' ? call.From : call.To);

  // ⚠️ OBSERVED SHAPE (2026-08-20, live): legs are NESTED under a `Leg` key —
  //     [{"Leg":{"Id":1,"OnCallDuration":121}}, {"Leg":{"Id":2,"OnCallDuration":105}}]
  // — and carry NO agent identity whatsoever. The docs advertise `AnsweredBy`; the
  // list endpoint does not return it. Walk recursively anyway so a future field is
  // picked up automatically rather than silently ignored.
  const legs = Array.isArray(call.Details?.Legs) ? call.Details.Legs : [];
  const walk = (node, depth = 0) => {
    if (!node || depth > 3) return;
    if (typeof node === 'string') { push(node); return; }
    if (Array.isArray(node)) { node.forEach(n => walk(n, depth + 1)); return; }
    if (typeof node === 'object') { Object.values(node).forEach(v => walk(v, depth + 1)); }
  };
  walk(legs);
  // ⚠️ NOT call.AnsweredBy — observed value is "human", i.e. answering-machine
  // detection, not an identity. Pushing it would match nothing and mislead the next
  // reader into thinking attribution had a source it does not.
  push(call.DialWhomNumber);

  return [...new Set(out)];
}

/**
 * Match candidate identifiers against the agent roster.
 * `roster` is { bySip: Map, byPhone: Map } built once per poll run — never per row.
 */
export function matchAgent(candidates, roster, toE164) {
  for (const c of candidates) {
    if (/^sip:/i.test(c)) {
      const hit = roster.bySip.get(c.toLowerCase());
      if (hit) return { ...hit, matched_on: 'sip', matched_value: c };
    } else {
      const e164 = toE164(c);
      const hit = e164 && roster.byPhone.get(e164);
      if (hit) return { ...hit, matched_on: 'phone', matched_value: e164 };
    }
  }
  return null;
}

/**
 * What the Connect applet's `agent-passthru-url` hook is reporting: which agent, and which
 * moment of the call.
 *
 * ⚠️ OBSERVED LIVE 2026-10-07 (S410, `wrangler tail`), not from the docs. One call fires it
 * once per agent rung, then once more when the call ends:
 *     EventType=Dial      DialWhomNumber=sip:sunithab17b95f7f  Status=busy  (her phone rings)
 *     EventType=Terminal  DialWhomNumber=sip:sunithab17b95f7f  Status=free  (call over)
 * `Status` is the AGENT's line state, so `busy` on a Dial means "now ringing for this call",
 * not "skipped" (that 18:46 call was answered by her). `To`/`CallTo` are OUR ExoPhone on
 * every fire — the hook used to read `To` before `DialWhomNumber`, so it never matched an
 * agent: the "Open call" row upgrade and the pop for tel-device agents never fired. (SIP
 * agents still got a pop from the browser-phone SDK, apps/pitstop callEvents.js.) `To` is
 * deliberately not a fallback now.
 */
export function hookDialTarget(params) {
  const get = (k) => {
    const v = params.get(k);
    return v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim();
  };
  const ref = get('DialWhomNumber') || get('AgentId') || get('AgentSipId') || get('CurrentAgent');
  return {
    ref,
    email: get('AgentEmail'),
    status: get('Status') ? get('Status').toLowerCase() : null,
    event: get('EventType') ? get('EventType').toLowerCase() : null,
  };
}

/**
 * What the hook does with one fire.
 *   'ring'   — Dial (or no EventType at all, the pre-S410 shape): create/upsert the row,
 *              stamp the agent for the live pop, warm the context.
 *   'end'    — Terminal: record it, close the row's live state, touch nothing else.
 *   'record' — any other EventType: record it only.
 * ⚠️ Only 'ring' may reach upsertCall. That PATCHes status='in_progress' and a fresh
 * started_at, so an after-the-fact fire routed there un-settles a call the poller finished.
 * An unknown word is recorded in dial_attempts and logged, so a new vocabulary shows up.
 */
export function hookAction(target) {
  if (!target.event || target.event === 'dial') return 'ring';
  if (target.event === 'terminal') return 'end';
  return 'record';
}

/** The dial_attempts element for one fire. */
export function hookAttempt(target, at) {
  return { event: target.event, agent: target.ref, email: target.email, status: target.status, at };
}
