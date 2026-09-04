// LimeChat voice webhook receiver (POST /webhooks/limechat) — Phase 0 of the voice channel.
//
// WHAT THIS IS FOR. LimeChat runs the AI voice bot for CART ABANDONMENT calls (⚠️ NOT COD —
// LOT moved to partial payment, ₹100 upfront + rest at delivery; Afshaan 2026-09-04). Phase 0
// is CAPTURE ONLY: LimeChat keeps triggering calls off its own Shopflo integration, and Relay
// just receives every call outcome so nothing is lost. Phase 1 moves the trigger into Relay
// (we POST their cvf-events); this file is the other direction and is all Phase 0 needs.
//
// ⭐ THE DESIGN CONSTRAINT THAT SHAPES EVERYTHING HERE: WE DO NOT KNOW THE PAYLOAD YET.
// Pruthvi is still designing the flow, and LimeChat told us the disposition is fully custom
// with no fixed field set ("build the disposition as per our requirement"). Afshaan, 2026-09-04:
// *"that information is dependent on Pruthvi's design of the whole thing. I'm waiting on that to
// come. But let's build whatever we need to build so that we are able to take their input."*
// So this receiver is deliberately SCHEMA-AGNOSTIC:
//   - it CAPTURES 100% OF AUTHENTICATED REQUESTS RAW, mapped or not (the other discovery-mode
//     receivers here capture only what they failed to map — that is wrong for us, because a
//     payload we map "successfully" off guessed key names is exactly the one we most need the
//     raw copy of in order to check the guess).
//   - it EXTRACTS best-effort from candidate key names and never fails when it finds nothing.
//   - it does NOT invent an outcome vocabulary. Afshaan: *"let Pruthvi make that flow first, and
//     after that we will put in the conditions we need."* Mapping outcome → WhatsApp message is a
//     later, separate change; pre-empting it here would entrench names we would have to unpick.
//
// SECURITY: LimeChat offers no signing secret we know of, so the endpoint is guarded by a shared
// bearer token (Authorization: Bearer <token>  OR  X-LimeChat-Token: <token>), same posture as
// the Shopflo receiver. Inert (503) until LIMECHAT_WEBHOOK_TOKEN is set — the URL can therefore
// be handed to Pruthvi before the token exists without opening anything.
//
// NEVER 500. A mapper bug or an unexpected shape must not make LimeChat retry-storm or conclude
// we are down; every authenticated request is captured and ack'd 200 with a diagnostic body that
// says what we understood. During bring-up that response doubles as LimeChat's own self-test.
const A = require('./auth.js');
const { ingest } = require('./ingest.js');
const { normalizePhone } = require('./shopify.js');

// The one event we emit. Deliberately OUTCOME-NEUTRAL: it records that a call happened and
// attaches the vendor's whole payload, without asserting what the call meant. The send rule
// Afshaan settled (message only when the call left something for us to say — unresolved, or
// unreached in any form; never after a purchase or an explicit "I don't need it anymore")
// is implemented LATER, against real dispositions, not guessed here.
const EVENT_NAME = 'voice_call_received';

function isConfigured(env) { return !!env.LIMECHAT_WEBHOOK_TOKEN; }

// Bearer (Authorization) or custom X-LimeChat-Token must equal the shared secret.
function tokenOk(env, request) {
  const want = env.LIMECHAT_WEBHOOK_TOKEN;
  if (!want) return false;
  const auth = request.headers.get('Authorization') || '';
  const bearer = auth.slice(0, 7).toLowerCase() === 'bearer ' ? auth.slice(7).trim() : '';
  const custom = request.headers.get('X-LimeChat-Token') || request.headers.get('x-limechat-token') || '';
  return (!!bearer && bearer === want) || (!!custom && custom === want);
}

// ── schema-agnostic extraction ────────────────────────────────────────────────────────────
// Candidate key names per field, in PREFERENCE ORDER. These are guesses against an unseen
// payload and are expected to be wrong in part — that is precisely why every request is also
// stored raw. When the real shape lands, correct these lists off a capture; do not add a
// parallel mapper.
const KEYS = {
  phone:   ['phone', 'phone_number', 'phonenumber', 'msisdn', 'mobile', 'contact_number',
            'customer_phone', 'to_number', 'destination_number', 'caller_id', 'to', 'number'],
  callId:  ['call_id', 'callid', 'call_uuid', 'call_sid', 'callsid', 'conversation_id',
            'session_id', 'request_id', 'reference_id', 'uuid'],
  status:  ['call_status', 'callstatus', 'status', 'disposition', 'outcome', 'call_outcome',
            'status_reason', 'reason', 'result'],
  remarks: ['remarks', 'remark', 'notes', 'comment', 'summary', 'call_summary'],
  when:    ['last_updated', 'updated_at', 'end_time', 'ended_at', 'completed_at', 'call_time',
            'timestamp', 'created_at', 'start_time'],
  orderNo: ['order_id', 'order_number', 'order_no', 'orderid', 'ordernumber'],
};

// Normalise a key for comparison: lowercase, strip separators. So `Call Status`, `call-status`
// and `callStatus` all collapse to `callstatus` and match one candidate spelling.
function normKey(k) { return String(k).toLowerCase().replace(/[\s_\-.]/g, ''); }

// Walk a nested object/array breadth-first and collect the first scalar value whose key matches
// any candidate. BREADTH-FIRST ON PURPOSE: a top-level `status` should beat a `status` buried
// inside a nested provider blob. Bounded on nodes and depth so a hostile or huge body cannot
// spin the isolate.
const MAX_NODES = 2000;
const MAX_DEPTH = 8;

function findField(body, candidates) {
  const want = candidates.map(normKey);
  const queue = [[body, 0]];
  let seen = 0;
  const found = new Map();       // candidate index -> value (lower index = better match)
  while (queue.length) {
    const [node, depth] = queue.shift();
    if (!node || typeof node !== 'object' || depth > MAX_DEPTH || ++seen > MAX_NODES) continue;
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === 'object') { queue.push([v, depth + 1]); continue; }
      if (v === null || v === undefined || v === '') continue;
      const idx = want.indexOf(normKey(k));
      if (idx >= 0 && !found.has(idx)) found.set(idx, v);
    }
  }
  if (!found.size) return null;
  const best = Math.min(...found.keys());
  return found.get(best);
}

// Pull everything we can recognise. Every field is optional — an empty extraction is a valid,
// non-error outcome and still gets captured.
function extract(body) {
  const phoneRaw = findField(body, KEYS.phone);
  const whenRaw = findField(body, KEYS.when);
  let occurredAt = null;
  if (whenRaw != null) {
    // Accept ISO strings and epoch seconds/millis alike — vendors differ and we cannot ask yet.
    const n = Number(whenRaw);
    const d = Number.isFinite(n) && String(whenRaw).trim() !== ''
      ? new Date(n > 1e12 ? n : n * 1000)
      : new Date(String(whenRaw));
    if (!isNaN(d.getTime())) occurredAt = d.toISOString();
  }
  return {
    phone: normalizePhone(phoneRaw),
    phone_raw: phoneRaw != null ? String(phoneRaw) : null,
    call_id: (() => { const v = findField(body, KEYS.callId); return v != null ? String(v) : null; })(),
    status: (() => { const v = findField(body, KEYS.status); return v != null ? String(v) : null; })(),
    remarks: (() => { const v = findField(body, KEYS.remarks); return v != null ? String(v) : null; })(),
    order_no: (() => { const v = findField(body, KEYS.orderNo); return v != null ? String(v) : null; })(),
    occurred_at: occurredAt,
  };
}

// ── raw capture ───────────────────────────────────────────────────────────────────────────
// Headers minus the auth-bearing ones. `_reason` records why this capture happened so the
// captures table is self-describing when someone reads it weeks later.
async function capture(env, request, body, reason) {
  const hdrs = {};
  for (const [k, v] of request.headers) {
    const lk = k.toLowerCase();
    if (lk === 'authorization' || lk === 'x-limechat-token' || lk === 'cookie') continue;
    hdrs[k] = v;
  }
  await A.sbComms('/rest/v1/webhook_captures', env, {
    method: 'POST',
    body: JSON.stringify({ source: 'limechat', headers: { ...hdrs, _reason: reason || null }, body }),
  }).catch((e) => { console.log('limechat_capture_error', e?.message || String(e)); });
}

async function handleLimechatWebhook(env, request) {
  if (!isConfigured(env)) return { ok: false, error: 'limechat_not_configured', status: 503 };

  if (!tokenOk(env, request)) {
    // Capture the rejection, TRUNCATED. Same reasoning as the Cashfree receiver: silence must
    // never be ambiguous, because "LimeChat stopped calling" and "we started rejecting" look
    // identical from our side and a rotated token is the likeliest cause of both. Bounded so an
    // unauthenticated caller who finds the URL cannot use it as an unbounded write primitive.
    const excerpt = await request.text().then((t) => String(t || '').slice(0, 512)).catch(() => '');
    await capture(env, request, { _rejected: true, _excerpt: excerpt }, 'bad_token').catch(() => {});
    console.log('limechat_bad_token', { bytes: excerpt.length });
    return { ok: false, error: 'unauthorised', status: 401 };
  }

  const raw = await request.text().catch(() => '');
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { _unparsed: String(raw).slice(0, 4000) }; }

  const got = extract(body);

  // CAPTURE FIRST, ALWAYS — before any mapping can throw, and regardless of whether extraction
  // found anything. The capture is the deliverable of Phase 0; the event below is a bonus.
  await capture(env, request, body, got.phone ? 'mapped' : 'no_identity');

  // No usable identity → nothing to attach a call to. Still a 200: the payload is safely stored
  // and the shape is now inspectable, which is the whole point of this phase.
  if (!got.phone) {
    console.log('limechat_no_identity', { keys: Object.keys(body || {}).slice(0, 20) });
    return { ok: true, captured: true, mapped: false, reason: 'no_identity', extracted: got };
  }

  // Idempotency: prefer the vendor's own call id. Without one, two deliveries of the same call
  // would double-append, so fall back to a coarse key and accept the (visible) duplication
  // rather than inventing an id that could collide across calls.
  const idem = got.call_id
    ? `limechat:call:${got.call_id}`
    : `limechat:call:${got.phone}:${got.occurred_at || 'unknown'}`;

  const envelope = {
    identifiers: [{ type: 'phone', value: got.phone, is_verified: false }],
    name: EVENT_NAME,
    source: 'limechat_webhook',
    occurred_at: got.occurred_at,
    idempotency_key: idem,
    // The WHOLE vendor payload rides along under `raw`. When the disposition vocabulary settles,
    // the outcome rule can be written against real fields without a backfill or a re-send.
    properties: {
      call_id: got.call_id, status: got.status, remarks: got.remarks,
      order_no: got.order_no, phone_raw: got.phone_raw, raw: body,
    },
  };

  let r;
  try {
    r = await ingest(env, envelope);
  } catch (e) {
    // Already captured above, so nothing is lost — ack rather than trigger a retry storm.
    console.log('limechat_ingest_throw', e?.message || String(e));
    return { ok: true, captured: true, mapped: false, reason: 'ingest_error', extracted: got };
  }
  if (!r.ok) {
    console.log('limechat_ingest_error', r.error);
    return { ok: true, captured: true, mapped: false, reason: `ingest_error:${r.error}`, extracted: got };
  }

  return {
    ok: true, captured: true, mapped: true, event: EVENT_NAME,
    profile_id: r.profile_id, deduped: !!r.deduped, extracted: got,
  };
}

module.exports = { handleLimechatWebhook, isConfigured, tokenOk, extract, findField, EVENT_NAME };
