// M4 — Shopify live sync: the public webhook endpoint + the Web-Pixel endpoint.
// Both flow through the same /ingest + comms.shopify_apply_customers primitives the
// backfill uses, so identity resolution / attribute derivation / idempotency / the
// M7 journey trigger fan-out are all reused unchanged. Mappers are pure (shopify.js).
const A = require('./auth.js');
const { ingest } = require('./ingest.js');
const SHOP = require('./shopify.js');

// GDPR customers/redact — we hold no special PII store, so the compliant action is to
// suppress every channel for the customer's contacts so nothing can ever reach them,
// keyed on the same address the send gate checks. Best-effort, never throws.
async function redactCustomer(env, payload) {
  const c = payload?.customer || payload || {};
  const rows = [];
  if (c.email) rows.push({ channel: 'email', value: String(c.email).toLowerCase().trim(), reason: 'gdpr_redact' });
  const ph = SHOP.normalizePhone(c.phone);
  if (ph) { rows.push({ channel: 'whatsapp', value: ph, reason: 'gdpr_redact' });
            rows.push({ channel: 'sms', value: ph, reason: 'gdpr_redact' }); }
  for (const r of rows) {
    await A.sbComms('/rest/v1/suppressions?on_conflict=channel,value', env, {
      method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates' },
      body: JSON.stringify(r),
    }).catch(() => {});
  }
  return rows.length;
}

// POST /webhooks/shopify — HMAC-verified (raw body) before parse, like /webhooks/resend.
async function handleShopifyWebhook(env, request) {
  const raw = await request.text();
  if (!env.SHOPIFY_WEBHOOK_SECRET) return { ok: false, error: 'webhook_secret_unset', status: 500 };
  const hmac = request.headers.get('X-Shopify-Hmac-Sha256') || request.headers.get('x-shopify-hmac-sha256');
  const okSig = await SHOP.verifyWebhookHmac(env.SHOPIFY_WEBHOOK_SECRET, raw, hmac).catch(() => false);
  if (!okSig) return { ok: false, error: 'bad_signature', status: 401 };

  const topic = (request.headers.get('X-Shopify-Topic') || request.headers.get('x-shopify-topic') || '').toLowerCase();
  let payload; try { payload = JSON.parse(raw); } catch { return { ok: false, error: 'bad_json', status: 400 }; }

  // GDPR mandatory topics — always 200 so Shopify doesn't flag the app.
  if (topic === 'customers/redact') {
    const n = await redactCustomer(env, payload);
    return { ok: true, topic, suppressed: n };
  }
  if (topic === 'customers/data_request' || topic === 'shop/redact') {
    return { ok: true, topic, noted: true };
  }

  // Customer upsert — reuse the bulk apply RPC (one customer page of one).
  if (topic === 'customers/create' || topic === 'customers/update') {
    const res = await SHOP.applyMapped(env, [SHOP.mapCustomerRest(payload)]);
    return { ok: true, topic, ...res };
  }

  // Order lifecycle → events on the profile stream.
  if (SHOP.ORDER_TOPIC_EVENT[topic]) {
    const envlp = SHOP.mapOrderEvent(payload, SHOP.ORDER_TOPIC_EVENT[topic]);
    if (!envlp) return { ok: true, topic, skipped: 'no_identifier' };
    const r = await ingest(env, envlp);
    return r.ok ? { ok: true, topic, profile_id: r.profile_id, deduped: r.deduped }
                : { ok: false, error: r.error, status: 400 };
  }

  // Abandoned-checkout → checkout_started (the M7 journey trigger).
  if (topic === 'checkouts/create' || topic === 'checkouts/update') {
    const envlp = SHOP.mapCheckoutEvent(payload);
    if (!envlp) return { ok: true, topic, skipped: 'no_identifier' };
    const r = await ingest(env, envlp);
    return r.ok ? { ok: true, topic, profile_id: r.profile_id, deduped: r.deduped }
                : { ok: false, error: r.error, status: 400 };
  }

  return { ok: true, topic, ignored: true };
}

// POST /pixel — the storefront Web Pixel posts here. LOW-TRUST by design: runs
// client-side so it can't carry INGEST_TOKEN; guarded only by a rotating PIXEL_TOKEN
// + an event-type allowlist. Worst case a forged cart event = one spurious
// abandoned-cart email, itself behind the send gate + TEST MODE. Accepts ONLY the
// two storefront signals the backend can't otherwise see.
async function handlePixel(env, request) {
  if (!env.PIXEL_TOKEN) return { ok: false, error: 'pixel_unconfigured', status: 503 };
  let body; try { body = await request.json(); } catch { return { ok: false, error: 'bad_json', status: 400 }; }
  if (!body || body.token !== env.PIXEL_TOKEN) return { ok: false, error: 'unauthorised', status: 401 };

  const name = body.event;
  if (name !== 'add_to_cart' && name !== 'checkout_started')
    return { ok: false, error: 'unsupported_event', status: 400 };

  const idents = [];
  if (body.email) idents.push({ type: 'email', value: String(body.email).toLowerCase().trim(), is_verified: false });
  const ph = SHOP.normalizePhone(body.phone);
  if (ph) idents.push({ type: 'phone', value: ph, is_verified: false });
  // Weak browser-session key. ALWAYS sent when we have it — never as a fallback.
  //
  // This used to be `if (!idents.length && body.client_id)`, i.e. the session key was sent
  // ONLY when email/phone were absent. So the anonymous key and the known key never appeared
  // in the same resolve_identity call, and the merge the comment promised could never fire:
  // 17,403 web_session profiles accumulated 1:1 with their identifiers, none ever joined to a
  // real customer, and add_to_cart/checkout_started history sat on profiles with no way to
  // reach anybody (0 of 15,487 had a phone or email).
  //
  // Sending both is what lets resolve_identity fold the anonymous session profile into the
  // identified one. The resolver's weak-key rules (shared-browser guard) make that safe.
  if (body.client_id) idents.push({ type: 'web_session', value: String(body.client_id), is_verified: false });
  if (!idents.length) return { ok: true, skipped: 'no_identifier' };

  const props = { ...(body.properties || {}), source_surface: 'web_pixel' };
  // dedup a pixel checkout_started against the webhook's (same checkout token)
  const tok = body.checkout_token || props.checkout_token;
  const idem = (name === 'checkout_started' && tok) ? `shopify:checkout_started:${tok}` : null;

  const r = await ingest(env, {
    identifiers: idents, name, occurred_at: body.occurred_at || null,
    properties: props, source: 'shopify_pixel', idempotency_key: idem,
  });
  return r.ok ? { ok: true, profile_id: r.profile_id, deduped: r.deduped }
              : { ok: false, error: r.error, status: 400 };
}

module.exports = { handleShopifyWebhook, handlePixel, redactCustomer };
