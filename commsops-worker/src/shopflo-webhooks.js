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

    // Backfill the profile's display_name from the Shop Pass identity. Shopflo is the
    // ONLY feed that knows the name for net-new checkout contacts (the Shopify customer
    // webhook never sees them), and without it every journey greeting renders the
    // "there" fallback (measured: ~55% of abandoners had no name). Fill-when-EMPTY only —
    // never overwrite a Shopify-sourced name (the PostgREST filter makes the PATCH a
    // no-op when a name exists). Best-effort: a greeting name is never worth a redelivery.
    const dn = FLO.displayName(body);
    if (dn && r.profile_id) {
      await A.sbComms(
        `/rest/v1/profiles?id=eq.${A.enc(r.profile_id)}&or=(display_name.is.null,display_name.eq.)`,
        env, { method: 'PATCH', body: JSON.stringify({ display_name: String(dn).slice(0, 120), updated_at: new Date().toISOString() }) }
      ).catch((e) => { console.log('shopflo_name_backfill_error', e?.message || String(e)); });
    }

    // Record marketing consent from the payload — on EVERY delivery, including deduped
    // retries. The ledger is append-only latest-wins, so a duplicate row is cosmetic; a
    // LOST opt-out is a compliance failure (review C3). A failed write returns 500 so
    // Shopflo redelivers and the consent is re-attempted (never swallow a withdrawal error).
    //
    // This inner try/catch is the consent-stage boundary (Gate-1 review): once we're here,
    // ANY failure — a returned {ok:false} OR a THROW from recordConsent's fetch (connection
    // reset/DNS on the transport call) — must surface as the same 500. A throw must NOT be
    // allowed to fall through to the outer mapper-crash catch below, which acks 200 — that
    // would silently lose the opt-out, exactly the compliance failure this codebase forbids.
    let consent = 0;
    try {
      for (const c of FLO.consentRowsFrom(body, envlp.occurred_at)) {
        const w = await recordConsent(env, { profile_id: r.profile_id, ...c });
        if (!w.ok) throw new Error('consent_write_failed');
        consent++;
      }
    } catch (e) {
      await capture(env, request, body).catch(() => {});
      console.log('shopflo_consent_error', evName, e?.message || String(e));
      return { ok: false, error: 'consent_write_failed', status: 500 };
    }
    return { ok: true, event: evName, emitted: spec.event, profile_id: r.profile_id, deduped: r.deduped, consent };
  } catch (e) {
    // Never 500 back to Shopflo on a mapper bug (avoids a retry storm) — capture + ack.
    // Only reachable for failures BEFORE the consent stage (mapping/ingest) — the inner
    // try/catch above intercepts anything from the consent-writing stage onward and always
    // returns 500, so this 200 path never covers a lost opt-out.
    await capture(env, request, body).catch(() => {});
    console.log('shopflo_map_error', evName, e?.message || String(e));
    return { ok: true, event: evName, error_captured: true };
  }
}

module.exports = { handleShopfloWebhook };
