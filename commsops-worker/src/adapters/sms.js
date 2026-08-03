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

module.exports = { buildSmsParams, routeForPurpose, assertBindable, PURPOSE_ROUTE, ROUTE_TYPE };
