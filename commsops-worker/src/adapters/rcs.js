// RCS adapter — TrustSignal. Contract matches adapters/sms.js:
//   send(rendered, env) → {provider_message_id, status, reason, raw, cost}
//   parseStatusWebhook(payload) → [{provider_message_id, canonical_status, at, reason, ...}]
//
// ⚠️ TrustSignal exposes NO pure-RCS send — `with_fallback` is the only path, and it REQUIRES a
// complete SMS fallback leg (spec 2026-08-03 §7). send.js resolves that leg from the template's
// referenced SMS template BEFORE calling this adapter; a rendered payload without one is refused
// here rather than half-sent.
//
// D6: RCS is `marketing`-only — the provisioned bot ("L.O.T", d91c046d040e4950) is registered
// `promotional` with the vi hub, so a transactional RCS message is not a thing we can send
// regardless of what the caller asks for. D7: the fallback leg's route is pinned 'promotional'
// for the same reason; send.js enforces the matching DLT constraint (fallback template must be
// `explicit`) where it can see the template row.

const TS = require('../trustsignal-client.js');

async function send(rendered, env) {
  // RCS takes the stored E.164 UNCHANGED (spec §6b rule 4) — unlike SMS, which strips +91.
  // Same fail-before-network posture as adapters/sms.js: a bad recipient must never be
  // partially attempted.
  const to = typeof rendered.to === 'string' ? rendered.to.trim() : '';
  if (!/^\+\d{8,14}$/.test(to))
    return { provider_message_id: null, status: 'failed', reason: 'invalid_phone', raw: null, cost: null };

  if (rendered.purpose !== 'marketing')
    return { provider_message_id: null, status: 'failed', reason: 'rcs_is_marketing_only', raw: null, cost: null };

  if (!rendered.provider_template_id)
    return { provider_message_id: null, status: 'failed', reason: 'rcs_template_not_registered', raw: null, cost: null };

  const fb = rendered.sms_fallback;
  if (!fb || !fb.sender || !fb.message || !fb.template_id)
    return { provider_message_id: null, status: 'failed', reason: 'missing_sms_fallback', raw: null, cost: null };

  // Payload per the vendor collection as recorded in spec §7 (`to`, `template_id`,
  // `rcs_variables`, `ttl`, `sms_fallback{sender,message,template_id,route}`). The collection
  // publishes no live example of a with_fallback RESPONSE, so the id/cost extraction below
  // handles both shapes the SMS side has shown (results[] and flat). First live send (build
  // step 8) validates this end to end — do not wire a journey to RCS before that has run.
  // Variable convention hedge: the spec records `rcs_variables` (named), while the vendor's
  // delivery-webhook reference lists pr1..pr5 as "custom parameters passed while sending RCS" —
  // positional, exactly like SMS. Both are sent (names from the map, positions from var_order,
  // which the catalogue pull writes in csparams index order); the first enabled live send tells
  // us which one the vendor actually reads, and the loser gets removed then.
  const prParams = {};
  (Array.isArray(rendered.var_order) ? rendered.var_order : []).forEach((name, i) => {
    const v = rendered.vars ? rendered.vars[name] : undefined;
    if (v !== undefined && v !== null && v !== '' && i < 5) prParams[`pr${i + 1}`] = String(v);
  });

  const body = {
    to,
    template_id: rendered.provider_template_id,
    ...(rendered.vars && Object.keys(rendered.vars).length ? { rcs_variables: rendered.vars } : {}),
    ...prParams,
    ...(rendered.ttl ? { ttl: rendered.ttl } : {}),
    sms_fallback: {
      sender: fb.sender,
      message: fb.message,
      template_id: fb.template_id,
      // D7 — pinned, never taken from the caller. The bot is promotional; a fallback that
      // rode the transactional route would be a DLT category violation on the SMS leg.
      route: 'promotional',
    },
  };

  const r = await TS.tsFetch(env, 'rcs', '/api/v1/rcs/with_fallback', { method: 'POST', body });
  if (!r.ok) {
    return { provider_message_id: null, status: 'failed',
             reason: TS.redact(`${r.error.codeMsg || 'error'}:${r.error.message}`).slice(0, 140),
             raw: r.data, cost: null };
  }
  // with_fallback's live response (captured 2026-08-17, first enabled send) nests under a
  // SINGULAR `result` object: {message, result:{phone, transaction_id, cost, sms_cost}, success}
  // — not `results[]` (the SMS shape) and not flat. All three are handled; DLRs key on
  // transaction_id, so a miss here orphans the message forever.
  const first = Array.isArray(r.data?.results) ? r.data.results[0] : (r.data?.result || r.data);
  // F11 — RCS returns cost as a STRING ("0.1") where SMS returns a number. Coerce; a
  // non-numeric value is recorded as null rather than NaN.
  const cost = first?.cost ?? first?.rcs_cost ?? null;
  if (!first?.transaction_id)
    console.log('rcs_send_no_transaction_id', TS.redact(JSON.stringify(r.data) || '').slice(0, 500));
  return {
    provider_message_id: first?.transaction_id || null,
    status: 'sent',                 // accepted, NOT delivered — the webhook moves it forward
    reason: null,
    raw: r.data,
    cost: cost == null || !Number.isFinite(Number(cost)) ? null : Number(cost),
  };
}

// TrustSignal RCS webhook events → normalized updates for webhooks.js handleTrustsignalRcs.
//
// Field names verified against the vendor's OWN "RCS Webhook Payload Reference" (Sigmo UI,
// read 2026-08-17 while registering the webhooks — this reference exists in the portal even
// though the Postman collection ships no RCS payloads). The documented shapes:
//   Delivery Status (webhook_type 'rcs_message'): transaction_id · mid · to · route ·
//     status ∈ {delivered, nonrcs, failed, read} · st (submission ts) · dlrt (DLR ts) ·
//     credit (number) · error · error_code · variables
//   Click (also webhook_type 'rcs_message'): status:'click' · final_url · st · ip · user_agent
//     — a click is a STATUS VALUE on the message webhook, not its own event shape.
//   Fallback (webhook_type 'rcs_fallback_status'): transaction_id · mid (the SMS leg's id) ·
//     status ∈ {delivered, failed} · st · dlrt · error — ⚠️ this is the SMS LEG'S OWN DLR,
//     not a mere "fallback happened" ping: it BOTH implies the flip AND carries the surviving
//     leg's terminal status.
//   User Response (webhook_type 'rcs_user_response'): phone · response · response_type ·
//     tlmsgid · mvar · camp_id — NO transaction_id; tlmsgid is the message reference.
// The legacy event/url fallbacks below are kept as a second net for undocumented variants;
// unknown statuses still return canonical_status:null and are logged upstream, never thrown.
//
// F4: BOTH 'rcs_fallback_status' AND a Delivery_status of 'nonrcs' imply the flip, can both
// arrive, in either order. Each is emitted with {fallback_flip:true}; idempotency lives in the
// handler's PATCH predicate (fallback_from IS NULL), not here.
const RCS_STATUS = {
  delivered: 'delivered',
  read: 'opened',                  // RCS 'read' → our canonical 'opened' (same as WA)
  sent: 'sent',
  submitted: 'sent',
  submit_queue: 'sent',
  failed: 'failed',
  expired: 'failed',
  rejected: 'failed',
};

function one(p) {
  if (!p || typeof p !== 'object') return null;
  const txid = p.transaction_id || p.transactionId || p.txid || null;
  // dlrt is the delivery-report timestamp, st the submission timestamp — dlrt dates the event
  // being reported, so it wins when present.
  const at = p.dlrt || p.st || p.timestamp || p.time || new Date().toISOString();
  const wt = String(p.webhook_type || '').toLowerCase();
  const ev = String(p.event || p.event_type || '').toLowerCase();
  const status = String(p.status || p.delivery_status || '').toLowerCase();
  const route = String(p.route || '').toLowerCase() || null;
  const credit = p.credit ?? p.sms_cost ?? null;
  const cost = credit == null || !Number.isFinite(Number(credit)) ? null : Number(credit);

  // User_response — carries NO transaction_id; tlmsgid references the message log. Journey
  // branching is build step 10; the handler logs these so real shapes accumulate first.
  if (wt === 'rcs_user_response' || ev === 'user_response' || p.postback) {
    return { provider_message_id: txid || p.tlmsgid || null, user_response: true,
             postback: p.postback || p.response || null, at };
  }

  // The SMS fallback leg's DLR — flip + the surviving leg's own terminal status in one event.
  if (wt === 'rcs_fallback_status' || ev === 'fallback') {
    return {
      provider_message_id: txid, fallback_flip: true, at, cost,
      sms_status: status === 'delivered' ? 'delivered' : status === 'failed' ? 'failed' : null,
      reason: status === 'failed' ? String(p.error || 'fallback_failed').slice(0, 140) : null,
    };
  }

  // Click — a status value on the message webhook; the url field is `final_url`.
  // F12: maps onto the EXISTING `link_clicked` event upstream; never a new name.
  const url = p.final_url || p.url || p.clicked_url || p.dest_url || null;
  if (status === 'click' || ev === 'click' || (url && !status)) {
    return { provider_message_id: txid, click: true, clicked_url: url, at, route };
  }

  // nonrcs — the RCS leg reporting it went out as SMS. Flip only; the SMS leg's status
  // arrives separately on 'rcs_fallback_status'. No cost carried: the delivery webhook's
  // `credit` on this status describes the RCS attempt, not the SMS leg.
  if (status === 'nonrcs') {
    return { provider_message_id: txid, fallback_flip: true, at, cost: null, sms_status: null, reason: null };
  }

  if (!status) return null;
  return {
    provider_message_id: txid,
    canonical_status: RCS_STATUS[status] || null,
    raw_status: status,
    route,
    reason: RCS_STATUS[status] === 'failed'
      ? String(p.error || p.reason || status).slice(0, 140) : null,
    at,
  };
}

function parseStatusWebhook(payload) {
  const rows = Array.isArray(payload) ? payload
    : Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.events) ? payload.events
    : [payload];
  return rows.map(one).filter(Boolean);
}

module.exports = { send, parseStatusWebhook };
