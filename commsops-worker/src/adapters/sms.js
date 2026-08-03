// SMS adapter — TrustSignal. Contract matches adapters/email.js:
//   send(rendered, env) → {provider_message_id, status, reason, raw}
//   parseStatusWebhook(payload) → [{provider_message_id, canonical_status, at, reason}]

const TS = require('../trustsignal-client.js');

// Relay purpose → TrustSignal route, and the DLT consent type each REQUIRES.
// `global` is deliberately absent: it is the no-template international route and must never
// be reachable from an ordinary send.
const PURPOSE_ROUTE = { marketing: 'promotional', utility: 'transactional', transactional: 'transactional' };
const ROUTE_TYPE    = { promotional: 'explicit', transactional: 'implicit' };

function routeForPurpose(purpose) {
  const r = PURPOSE_ROUTE[purpose];
  if (!r) throw new Error(`unmapped_purpose:${purpose}`);
  return r;
}

// ⚠️ INTERNAL CONSISTENCY ONLY — NOT a compliance check (F15). TrustSignal's template_type is a
// self-declared dropdown value that nothing reconciles against the DLT registration, so agreement
// here proves only that we bound the template the way we labelled it. The carrier enforces on DLT.
// Never describe this as verifying compliance, in code or UI copy.
function assertBindable({ purpose, template_type }) {
  const want = ROUTE_TYPE[routeForPurpose(purpose)];
  if (!template_type) throw new Error('template_type_unset');
  if (template_type !== want)
    throw new Error(`route_template_type_mismatch:${purpose}->${want},got:${template_type}`);
  return true;
}

// DLT templates carry POSITIONAL {#var#} placeholders filled by pr1..pr5; Relay templates use
// NAMED {token} variables. `var_order` is the bridge and its order is load-bearing: get it wrong
// and the customer receives a grammatical message with the wrong words in it, and nothing errors.
// pr1..pr5 is a hard vendor ceiling — a 6th variable would silently vanish.
function buildSmsParams(varOrder, vars) {
  const order = Array.isArray(varOrder) ? varOrder : [];
  if (order.length > 5) throw new Error(`too_many_variables:${order.length}`);
  const out = {};
  const missing = [];
  order.forEach((name, i) => {
    const v = vars ? vars[name] : undefined;
    if (v === undefined || v === null || v === '') { missing.push(name); return; }
    out[`pr${i + 1}`] = String(v);
  });
  if (missing.length) throw new Error(`unresolved_variables:${missing.join(',')}`);
  return out;
}

async function send(rendered, env) {
  // Phone first: an unsupported recipient must fail BEFORE any network call, so a bad number
  // can never be partially attempted (F1).
  const phone = TS.renderPhoneForSms(rendered.to);
  if (!phone.ok) return { provider_message_id: null, status: 'failed', reason: phone.reason, raw: null, cost: null };

  let route, params;
  try {
    route = routeForPurpose(rendered.purpose);
    assertBindable({ purpose: rendered.purpose, template_type: rendered.template_type });
    params = buildSmsParams(rendered.var_order, rendered.vars);
  } catch (e) {
    return { provider_message_id: null, status: 'failed', reason: String(e.message).slice(0, 140), raw: null, cost: null };
  }

  const body = {
    sender_id: rendered.sender,
    // ⚠️ ARRAY OF INT, not a string. The vendor's param table is `to []int` and its example is
    // `"to": [9999999999]`; a bare string is rejected live with INVALID_JSON (verified against
    // the real endpoint 2026-08-03 — the whole pipeline was correct and only this field was not).
    //
    // This is a deliberate, narrow exception to the design's "never transport a phone as a JSON
    // number" rule, and it is safe HERE specifically: renderPhoneForSms guarantees exactly ten
    // digits stripped from a well-formed +91, Indian mobiles never begin with 0 (so no leading
    // zero can be eaten), and 10 digits is far below 2^53 so the value is exact. Do NOT
    // generalise this to E.164 values or to RCS, which takes the full string.
    to: [Number(phone.value)],
    route,
    message: rendered.body,
    template_id: rendered.provider_template_id,
    ...params,
    // Vendor-side link shortening + click callbacks. Safe ONLY because the URL lives inside a
    // {#var#} variable — a URL literal in approved DLT content would be rewritten and stop
    // matching the registered template (F6), which the carrier rejects.
    ...(rendered.has_link ? { isdesturl: 'true' } : {}),
  };

  const r = await TS.tsFetch(env, 'sms', '/v1/sms', { method: 'POST', body });
  if (!r.ok) {
    return { provider_message_id: null, status: 'failed',
             reason: TS.redact(`${r.error.codeMsg || 'error'}:${r.error.message}`).slice(0, 140),
             raw: r.data, cost: null };
  }
  const first = Array.isArray(r.data?.results) ? r.data.results[0] : null;
  return {
    provider_message_id: first?.transaction_id || null,
    status: 'sent',                 // accepted, NOT delivered — the webhook moves it forward
    reason: null,
    raw: r.data,
    cost: first?.sms_cost == null ? null : Number(first.sms_cost),
  };
}

// TrustSignal SMS DLR status → our canonical message status.
// `success:true` on send means ACCEPTED; only the DLR moves a row to a terminal state.
// ⚠️ The vendor collection publishes NO SMS delivery-callback payload (25+ exist for WhatsApp,
// zero for SMS), so these field names are INFERRED from the stats vocabulary. That is why an
// unrecognised status returns null instead of throwing, and why the DND suppression address is
// taken from our own messages row rather than from `p.to` — see webhooks.js handleTrustsignalSms.
const SMS_STATUS = {
  delivered: 'delivered',
  submitted: 'sent',
  submit_queue: 'sent',
  failed: 'failed',
  expired: 'failed',
  rejected: 'failed',
  dnd: 'failed',
  dndcf: 'failed',
};
// DND is the one failure that must also SUPPRESS. SMS has no inbound, so a customer cannot send
// STOP to us — the carrier's DND registry is the only signal, and it arrives as a delivery
// failure. Without suppressing we retry and re-pay indefinitely and the failure rate quietly
// becomes the channel's baseline.
// ⚠️ SMS-SCOPED ONLY. A DND registration is a carrier-SMS state and says nothing about the
// customer's email or WhatsApp reachability — never suppress the profile globally.
const DND_STATUSES = new Set(['dnd', 'dndcf']);

function parseStatusWebhook(payload) {
  const p = payload || {};
  const id = p.transaction_id || null;
  if (!id) return [];
  const raw = String(p.status || '').toLowerCase();
  const ev = {
    provider_message_id: id,
    canonical_status: SMS_STATUS[raw] || null,
    at: p.dlrt || p.st || null,
    reason: p.error || p.error_code ? `${p.error_code || ''}:${p.error || ''}`.replace(/^:|:$/g, '') : null,
  };
  if (DND_STATUSES.has(raw)) {
    ev.suppress = 'dnd';
    ev.suppress_channel = 'sms';
    ev.suppress_value = p.to || null;
  }
  return [ev];
}

module.exports = { buildSmsParams, routeForPurpose, assertBindable, send, parseStatusWebhook, PURPOSE_ROUTE, ROUTE_TYPE };
