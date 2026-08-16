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
  const body = {
    to,
    template_id: rendered.provider_template_id,
    ...(rendered.vars && Object.keys(rendered.vars).length ? { rcs_variables: rendered.vars } : {}),
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
  const first = Array.isArray(r.data?.results) ? r.data.results[0] : r.data;
  // F11 — RCS returns cost as a STRING ("0.1") where SMS returns a number. Coerce; a
  // non-numeric value is recorded as null rather than NaN.
  const cost = first?.cost ?? first?.rcs_cost ?? null;
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
// ⚠️ Every field name here is INFERRED — the vendor publishes webhook payloads for WhatsApp
// (25+) and none for RCS, same gap as SMS. Events are registered per-type in the Sigmo UI
// (Delivery_status · Fallback · Click · User_response · Template · Bot), and the payload may or
// may not carry the event name — so classification falls back to shape (a url ⇒ click, a status
// ⇒ delivery). Unknown statuses return canonical_status:null and are logged upstream, never
// thrown: the published catalogue is explicitly partial.
//
// The one mapping that carries real logic (F4): BOTH a `Fallback` event AND a Delivery_status of
// `nonrcs` mean "the RCS leg did not deliver; the SMS leg went out". They can both arrive, in
// either order. Each is emitted as {fallback_flip:true}; idempotency lives in the handler's
// PATCH predicate (fallback_from IS NULL), not here.
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
  const at = p.timestamp || p.time || p.created_at || new Date().toISOString();
  const ev = String(p.event || p.event_type || p.type || '').toLowerCase();
  const status = String(p.status || p.delivery_status || '').toLowerCase();
  const route = String(p.route || '').toLowerCase() || null;

  // Fallback — as its own event or as a nonrcs delivery status.
  if (ev === 'fallback' || status === 'nonrcs') {
    // The SMS leg's credit, when the payload carries one — applied ONLY on the flip (F4).
    const cost = p.sms_cost ?? p.cost ?? null;
    return { provider_message_id: txid, fallback_flip: true, at,
             cost: cost == null || !Number.isFinite(Number(cost)) ? null : Number(cost) };
  }

  // Click — F12: this maps onto the EXISTING `link_clicked` event upstream; never a new name.
  const url = p.url || p.clicked_url || p.dest_url || null;
  if (ev === 'click' || (url && !status)) {
    return { provider_message_id: txid, click: true, clicked_url: url, at, route };
  }

  // User_response (suggested-reply postback) — journey branching is build step 10; recorded
  // by the handler as a log line until then so real payload shapes accumulate.
  if (ev === 'user_response' || p.postback) {
    return { provider_message_id: txid, user_response: true, postback: p.postback || p.reply || null, at };
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
