// Shopflo Abandoned Cart Webhook receiver (S211). Shopflo (our checkout layer) forwards
// checkout events — abandonment / order-completed / payment-initiated — carrying the
// Shop Pass identity (phone/email) + cart context that Shopify's own pixel/webhooks do
// NOT surface. This is the seam that lets Relay run a phone-reachable abandoned-cart
// journey on the ~56%-net-new contacts Shop Pass identifies.
//
// SECURITY: Shopflo offers no HMAC/signing secret, only arbitrary custom headers. So the
// endpoint is guarded by a shared bearer token supplied as a custom header in the Shopflo
// webhook config (Authorization: Bearer <token>  OR  X-Shopflo-Token: <token>). Low-trust,
// same posture as /pixel — worst case a forged abandonment event, itself behind the send
// gate + TEST MODE. Inert (503) until SHOPFLO_WEBHOOK_TOKEN is set.
//
// DISCOVERY MODE (current): Shopflo's payload schema is not documented, so we capture the
// raw headers+body into comms.webhook_captures and 200. The /ingest mapper (identity +
// checkout_abandoned event) is added once a real payload confirms the exact field names.
const A = require('./auth.js');

// Bearer (Authorization) or custom X-Shopflo-Token header must equal the shared secret.
function tokenOk(env, request) {
  const want = env.SHOPFLO_WEBHOOK_TOKEN;
  if (!want) return false;
  const auth = request.headers.get('Authorization') || '';
  const bearer = auth.slice(0, 7).toLowerCase() === 'bearer ' ? auth.slice(7).trim() : '';
  const custom = request.headers.get('X-Shopflo-Token') || request.headers.get('x-shopflo-token') || '';
  return bearer === want || custom === want;
}

async function handleShopfloWebhook(env, request) {
  if (!env.SHOPFLO_WEBHOOK_TOKEN) return { ok: false, error: 'shopflo_unconfigured', status: 503 };
  if (!tokenOk(env, request)) return { ok: false, error: 'unauthorised', status: 401 };

  const raw = await request.text();
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { _unparsed: raw }; }

  // Capture all headers EXCEPT the auth-bearing ones (so we discover the event-type
  // header name without persisting the shared secret).
  const hdrs = {};
  for (const [k, v] of request.headers) {
    const lk = k.toLowerCase();
    if (lk === 'authorization' || lk === 'x-shopflo-token' || lk === 'cookie') continue;
    hdrs[k] = v;
  }

  await A.sbComms('/rest/v1/webhook_captures', env, {
    method: 'POST',
    body: JSON.stringify({ source: 'shopflo', headers: hdrs, body }),
  }).catch((e) => { console.log('shopflo_capture_error', e?.message || String(e)); });

  console.log('shopflo_webhook_captured', JSON.stringify({ body_keys: Object.keys(body || {}), header_keys: Object.keys(hdrs) }));
  return { ok: true, captured: true };
}

module.exports = { handleShopfloWebhook };
