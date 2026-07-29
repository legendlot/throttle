// M4 — Shopify live sync: the public webhook endpoint + the Web-Pixel endpoint.
// Both flow through the same /ingest + comms.shopify_apply_customers primitives the
// backfill uses, so identity resolution / attribute derivation / idempotency / the
// M7 journey trigger fan-out are all reused unchanged. Mappers are pure (shopify.js).
const A = require('./auth.js');
const { ingest } = require('./ingest.js');
const SHOP = require('./shopify.js');
const CAT = require('./product-category.js');
const SF = require('./shopflo.js');   // cartLinkSuffix/STOREFRONT_BASE — one cart-permalink impl
const { resolveVariantImage } = require('./variant-images.js');

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

// Resolve the profile that owns a Shopify order, via the order_placed event we already store.
// Cheap (one indexed-ish read at ~7 events/day) and it is the only reliable identity path for a
// fulfillment payload that carries no contact block.
async function profileFromOrder(env, shopifyOrderId) {
  if (!shopifyOrderId) return null;
  const q = `/rest/v1/events?select=profile_id&properties->>shopify_order_id=eq.${A.enc(String(shopifyOrderId))}`
    + '&profile_id=not.is.null&order=occurred_at.asc&limit=1';
  const r = await A.sbComms(q, env).catch(() => null);
  return (r && r.ok && r.data && r.data[0] && r.data[0].profile_id) || null;
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
    // Per-order product image for the WA IMAGE header (Order Placed et al). Resolved HERE
    // rather than in the mapper because it needs a cache lookup + possible catalog refetch,
    // and mapOrderEvent is pure/unit-tested. Fails soft to null on every path — the
    // template's static creative is the render-time fallback, and no missing image may ever
    // cost us the order event itself.
    if (envlp.properties?.variant_ids) {
      const img = await resolveVariantImage(env, envlp.properties.variant_ids, envlp.properties.primary_title);
      if (img) envlp.properties.product_image_url = img;
    }
    const r = await ingest(env, envlp);
    return r.ok ? { ok: true, topic, profile_id: r.profile_id, deduped: r.deduped }
                : { ok: false, error: r.error, status: 400 };
  }

  // Fulfillment shipment_status → the courier lifecycle (delivered / out-for-delivery).
  // Parity with BiteSpeed's Delivered journey, which rides this exact source; see
  // mapFulfillmentEvent for why this is a floor and not the fix.
  if (topic === 'fulfillments/create' || topic === 'fulfillments/update') {
    const envlp = SHOP.mapFulfillmentEvent(payload);
    if (!envlp) return { ok: true, topic, skipped: 'no_customer_transition' };
    // A fulfillment payload frequently carries NO contact block at all, so identity falls back
    // to the order: every delivered order necessarily had an order_placed, and those resolve at
    // 100% (measured 879/879 with a phone). Without this the event would silently drop and the
    // journey would look broken for exactly the orders we most want to message.
    if (!envlp.identifiers || !envlp.identifiers.length) {
      const pid = await profileFromOrder(env, envlp.properties.shopify_order_id);
      if (!pid) return { ok: true, topic, skipped: 'no_profile_for_order' };
      delete envlp.identifiers;
      envlp.profile_id = pid;
    }
    const r = await ingest(env, envlp);
    return r.ok ? { ok: true, topic, event: envlp.name, profile_id: r.profile_id, deduped: r.deduped }
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
// What the low-trust /pixel route accepts. add_to_cart + checkout_started may MINT a
// web_session profile (they are the identity anchor points); everything else is
// browse-class and ATTACH-ONLY (see the guard below).
const PIXEL_EVENTS = new Set(['add_to_cart', 'checkout_started', 'product_viewed',
  'collection_viewed', 'search_submitted', 'cart_viewed', 'cart_item_removed']);
const ATTACH_ONLY_EVENTS = new Set(['product_viewed', 'collection_viewed',
  'search_submitted', 'cart_viewed', 'cart_item_removed']);

async function handlePixel(env, request) {
  if (!env.PIXEL_TOKEN) return { ok: false, error: 'pixel_unconfigured', status: 503 };
  let body; try { body = await request.json(); } catch { return { ok: false, error: 'bad_json', status: 400 }; }
  if (!body || body.token !== env.PIXEL_TOKEN) return { ok: false, error: 'unauthorised', status: 401 };

  const name = body.event;
  if (!PIXEL_EVENTS.has(name)) return { ok: false, error: 'unsupported_event', status: 400 };

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
  // Checkout token — the one key that survives the Shopflo hand-off. Shopflo runs checkout on
  // its own domain (checkout.shopflo.co) where this pixel cannot run, so the browser session
  // dies at the boundary; but the Shopify ORDER carries the same checkout_token, so attaching
  // it here lets the order later fold this anonymous session into the real customer.
  // Shopify's own guidance: correlate on checkout_token, NOT the pixel cart id (different
  // namespace from the Ajax cart token, so it is not a reliable join key).
  const ckTok = body.checkout_token || body.properties?.checkout_token || null;
  if (ckTok) idents.push({ type: 'checkout_token', value: String(ckTok), is_verified: false });
  // Weak cart key on add_to_cart. Independent of client_id, so it still links the cart if the
  // browser key is lost (cookie cleared / new session). NOT a join key to orders — see above.
  if (body.cart_id) idents.push({ type: 'cart_id', value: String(body.cart_id), is_verified: false });
  if (!idents.length) return { ok: true, skipped: 'no_identifier' };

  // Browse-class events are ATTACH-ONLY: they fire on ordinary browsing — an order of
  // magnitude above add_to_cart — and a browser we have never seen can never be
  // messaged anyway. Minting a profile per anonymous view/search would bloat the
  // substrate (and enrol phantom browsers into browse-abandonment) for zero reach.
  // So: only ingest when SOME identifier already exists. Fail-closed on a lookup
  // error — a lost view is cheap, a junk profile is forever.
  if (ATTACH_ONLY_EVENTS.has(name)) {
    const ors = idents.map((i) => `and(type.eq.${i.type},value.eq.${A.enc(i.value)})`).join(',');
    const known = await A.sbComms(`/rest/v1/identifiers?or=(${ors})&select=profile_id&limit=1`, env);
    if (!(known.ok && known.data?.length)) return { ok: true, skipped: 'anonymous_view' };
  }

  const props = { ...(body.properties || {}), source_surface: 'web_pixel' };
  // Shopify's image.src is often PROTOCOL-RELATIVE (//cdn.shopify.com/…) — live-verified
  // 2026-07-23 on the first real product_viewed. Meta's WA media header requires an
  // absolute https URL, so normalize here (server-side, so the pasted pixel needn't change).
  if (typeof props.product_image_url === 'string' && props.product_image_url.startsWith('//'))
    props.product_image_url = 'https:' + props.product_image_url;
  // CART PERMALINK on pixel add_to_cart (2026-07-29). The pixel carries `variant_id` +
  // `quantity` — everything needed to build the same `/cart/<variant>:<qty>` permalink the
  // Shopflo path emits — but never built it: measured 0 of 4,119 pixel add_to_cart events had
  // `cart_link_suffix`, vs 90.8% of Shopflo's. Any cart template bound to that token therefore
  // hard-failed at render (`unresolved_variables:cart_link_suffix`) on a pixel-triggered send.
  //
  // Reuses shopflo.js `cartLinkSuffix` rather than re-deriving: that function already drops
  // non-numeric and all-zero ids, which matters because these values become a path segment in
  // a link we send to a customer. One implementation, one set of rules.
  //
  // SCOPE DIFFERENCE, stated because it is easy to misread: the pixel fires per ADDED ITEM, so
  // this permalink holds just that variant, whereas Shopflo's `cart_variant_ids` is the whole
  // cart. For a recovery nudge that is the right target anyway (it is the item they were
  // looking at), but do not treat the two tokens as interchangeable cart snapshots.
  //
  // NB with `requires_identifier` now gating the add-to-cart journey, pixel-triggered
  // enrolments are rare — this closes the latent trap rather than a live fire, and is what
  // makes the pixel path usable if identity coverage ever improves.
  if (name === 'add_to_cart' && !props.cart_link_suffix && props.variant_id != null) {
    const qty = Number(props.quantity);
    const suffix = SF.cartLinkSuffix(String(props.variant_id));
    if (suffix) {
      // cartLinkSuffix hardcodes `:1` per line; carry the real quantity when we have one.
      const withQty = Number.isFinite(qty) && qty > 1 ? suffix.replace(/:1$/, `:${Math.floor(qty)}`) : suffix;
      props.cart_link_suffix = withQty;
      props.cart_link = `${SF.STOREFRONT_BASE}/cart/${withQty}`;
    }
  }
  // Category enrichment (S232): stamp primary_category so journeys can branch voice by
  // product line (L.O.T Cars vs Build — RULE-TAXONOMY-001). Best-effort; null on no match
  // (add-ons like "Gift Wrapping" deliberately classify to nothing).
  if ((name === 'add_to_cart' || name === 'product_viewed') && !props.primary_category) {
    const cat = await CAT.resolveCategory(env, props.product_title || props.product_name || '');
    if (cat) props.primary_category = cat;
  }
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
