// Shopflo (Shop Pass) webhook receiver. Shopflo — LOT's checkout layer — forwards
// checkout/order events carrying the Shop Pass identity (phone/email) + cart +
// payment_mode that Shopify's own pixel/webhooks do NOT surface. This is the seam that
// lets Relay run a phone-reachable abandoned-cart journey (and detect COD orders for a
// COD→prepaid journey) on the contacts Shop Pass identifies.
//
// SECURITY: Shopflo offers no HMAC/signing secret, only arbitrary custom headers. So the
// endpoint is guarded by a shared bearer token supplied as a custom header in the Shopflo
// webhook config (Authorization: Bearer <token>  OR  X-Shopflo-Token: <token>). Low-trust,
// same posture as /pixel — worst case a forged event, itself behind the send gate + TEST
// MODE. Inert (503) until SHOPFLO_WEBHOOK_TOKEN is set (Shopflo's team must be given the
// endpoint + header — it is not a self-serve dashboard toggle).
//
// FLOW (S212): parse → map known events (shopflo.js EVENT_MAP) → /ingest (identity +
// event, idempotent, journey triggers) → record marketing consent from the payload. Any
// UNMAPPED or errored event is still captured raw into comms.webhook_captures so a
// new/changed wire shape is discovered, not lost (the doc warns the live shape may differ).
const A = require('./auth.js');
const { ingest } = require('./ingest.js');
const { recordConsent } = require('./consent.js');
const FLO = require('./shopflo.js');

// Bearer (Authorization) or custom X-Shopflo-Token header must equal the shared secret.
function tokenOk(env, request) {
  const want = env.SHOPFLO_WEBHOOK_TOKEN;
  if (!want) return false;
  const auth = request.headers.get('Authorization') || '';
  const bearer = auth.slice(0, 7).toLowerCase() === 'bearer ' ? auth.slice(7).trim() : '';
  const custom = request.headers.get('X-Shopflo-Token') || request.headers.get('x-shopflo-token') || '';
  return bearer === want || custom === want;
}

// Capture a raw event (headers minus the auth-bearing ones + body) for discovery.
async function capture(env, request, body) {
  const hdrs = {};
  for (const [k, v] of request.headers) {
    const lk = k.toLowerCase();
    if (lk === 'authorization' || lk === 'x-shopflo-token' || lk === 'cookie') continue;
    hdrs[k] = v;
  }
  await A.sbComms('/rest/v1/webhook_captures', env, {
    method: 'POST', body: JSON.stringify({ source: 'shopflo', headers: hdrs, body }),
  }).catch((e) => { console.log('shopflo_capture_error', e?.message || String(e)); });
}

async function handleShopfloWebhook(env, request) {
  if (!env.SHOPFLO_WEBHOOK_TOKEN) return { ok: false, error: 'shopflo_unconfigured', status: 503 };
  if (!tokenOk(env, request)) return { ok: false, error: 'unauthorised', status: 401 };

  const raw = await request.text();
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { _unparsed: raw }; }

  const evName = FLO.eventName(body);
  const spec = evName ? FLO.EVENT_MAP[evName] : null;

  // Unmapped (or unparseable / no event name) → capture raw for discovery, ack 200.
  if (!spec) {
    await capture(env, request, body);
    return { ok: true, captured: true, event: evName || null, mapped: false };
  }

  try {
    const envlp = spec.map(body);
    if (!envlp) return { ok: true, event: evName, skipped: 'no_identifier' };

    const r = await ingest(env, envlp);
    if (!r.ok) {
      // Mapper produced an envelope but ingest rejected it — keep the raw so we can replay.
      await capture(env, request, body);
      return { ok: false, error: r.error, status: 400 };
    }

    // Record marketing consent from the payload (only on first occurrence, not on a
    // deduped retry — the ledger is append-only and latest-wins).
    let consent = 0;
    if (!r.deduped) {
      for (const c of FLO.consentRowsFrom(body, envlp.occurred_at)) {
        await recordConsent(env, { profile_id: r.profile_id, ...c }).catch(() => {});
        consent++;
      }
    }
    return { ok: true, event: evName, emitted: spec.event, profile_id: r.profile_id, deduped: r.deduped, consent };
  } catch (e) {
    // Never 500 back to Shopflo on a mapper bug (avoids a retry storm) — capture + ack.
    await capture(env, request, body).catch(() => {});
    console.log('shopflo_map_error', evName, e?.message || String(e));
    return { ok: true, event: evName, error_captured: true };
  }
}

module.exports = { handleShopfloWebhook };
