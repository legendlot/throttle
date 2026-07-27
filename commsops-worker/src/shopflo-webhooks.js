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
const CAT = require('./product-category.js');

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

// The cart product's image for the v3 WA image-header slot. Cache-first
// (comms.product_images, keyed on the exact Shopify title Shopflo sends); a miss
// re-pulls the PUBLIC storefront catalog (products.json, ~31 products, no admin scope)
// and upserts every row — so a brand-new product self-heals the whole cache. Returns
// null on any failure: the template's static creative is the render-time fallback, a
// missing image must never fail the webhook.
const STOREFRONT_CATALOG_URL = 'https://www.legendoftoys.com/products.json?limit=250';
async function resolveProductImage(env, namesCsv) {
  const title = String(namesCsv || '').split(',')[0].trim();
  if (!title) return null;
  try {
    const r = await A.sbComms(`/rest/v1/product_images?title=eq.${A.enc(title)}&select=image_url&limit=1`, env);
    if (r.ok && r.data?.[0]?.image_url) return r.data[0].image_url;
    const res = await fetch(STOREFRONT_CATALOG_URL);
    if (!res.ok) return null;
    const cat = await res.json();
    const rows = (Array.isArray(cat.products) ? cat.products : [])
      .filter((p) => p && p.title && p.images?.[0]?.src)
      .map((p) => ({ title: p.title, image_url: p.images[0].src, updated_at: new Date().toISOString() }));
    if (rows.length) {
      await A.sbComms('/rest/v1/product_images?on_conflict=title', env, {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(rows),
      });
    }
    const hit = rows.find((x) => x.title === title);
    return hit ? hit.image_url : null;
  } catch (e) {
    console.log('product_image_resolve_error', e?.message || String(e));
    return null;
  }
}

// Per-VARIANT image for the add_to_cart header. Same cache-then-refetch shape as
// resolveProductImage, but keyed on the variant id Shopflo actually sends, because
// add_to_cart carries VARIANT-level names that never match the product-title cache
// (2 of 17 live titles hit). Exact key, and the customer sees their own colourway.
// Returns null on any failure — the template's static creative stays the render-time
// fallback, and a missing image must never fail the webhook.
async function resolveVariantImage(env, variantIdsCsv, primaryName) {
  const ids = String(variantIdsCsv || '').split(',')
    .map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
  if (!ids.length) return null;
  try {
    const q = ids.map((i) => `"${i}"`).join(',');
    const r = await A.sbComms(
      `/rest/v1/variant_images?variant_id=in.(${A.enc(q)})&select=variant_id,title,image_url`, env);
    if (r.ok && r.data?.length) {
      const cached = {};
      for (const row of r.data) cached[row.variant_id] = { title: row.title, image_url: row.image_url };
      const hit = FLO.pickVariantImage(variantIdsCsv, primaryName, cached);
      if (hit) return hit;
    }
    // Miss → re-pull the public catalog and upsert EVERY variant, so one miss self-heals
    // the whole cache (a newly launched colourway is the common case).
    const res = await fetch(STOREFRONT_CATALOG_URL);
    if (!res.ok) return null;
    const index = FLO.variantImageIndex(await res.json());
    const rows = Object.entries(index).map(([variant_id, v]) => ({
      variant_id, title: v.title, image_url: v.image_url, updated_at: new Date().toISOString(),
    }));
    if (rows.length) {
      await A.sbComms('/rest/v1/variant_images?on_conflict=variant_id', env, {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(rows),
      });
    }
    return FLO.pickVariantImage(variantIdsCsv, primaryName, index);
  } catch (e) {
    console.log('variant_image_resolve_error', e?.message || String(e));
    return null;
  }
}

async function handleShopfloWebhook(env, request) {
  if (!env.SHOPFLO_WEBHOOK_TOKEN) return { ok: false, error: 'shopflo_unconfigured', status: 503 };
  if (!tokenOk(env, request)) return { ok: false, error: 'unauthorised', status: 401 };

  const raw = await request.text();
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { _unparsed: raw }; }

  const evName = FLO.eventName(body);
  // Tolerant lookup (case + the add_to_cart_ui / added_to_cart_ui spelling split) — an exact
  // match would silently drop a whole event type as "unmapped" on a casing difference.
  const spec = FLO.lookupEvent(evName);

  // Unmapped (or unparseable / no event name) → capture raw for discovery, ack 200.
  if (!spec) {
    await capture(env, request, body);
    return { ok: true, captured: true, event: evName || null, mapped: false };
  }

  try {
    const envlp = spec.map(body);
    if (!envlp) return { ok: true, event: evName, skipped: 'no_identifier' };

    // v3 image-header enrichment — attach the cart product's image BEFORE ingest so the
    // event row (what the journey's send step binds from) carries it. Payload-supplied
    // image wins; catalog-cache lookup fills the gap. Best-effort by design.
    if (spec.event === 'checkout_abandoned' && envlp.properties && !envlp.properties.product_image_url) {
      envlp.properties.product_image_url = await resolveProductImage(
        env, envlp.properties.primary_product_name || envlp.properties.product_names);
    }
    // add_to_cart: Shopflo sends no image here at all, so without this the WA header always
    // renders the generic creative (seen live 2026-07-27 — a Mac Gray cart shipped stock
    // artwork). Resolved by VARIANT id, which the event does carry, so the customer gets
    // their own colourway rather than a generic product shot.
    if (spec.event === 'add_to_cart' && envlp.properties && !envlp.properties.product_image_url) {
      envlp.properties.product_image_url = await resolveVariantImage(
        env, envlp.properties.cart_variant_ids, envlp.properties.primary_product_name);
    }
    // Category enrichment (S232) — primary_category ("L.O.T Cars"|"L.O.T Build") from the
    // cart's titles, so journeys can branch template voice by product line. Best-effort.
    if (spec.event === 'checkout_abandoned' && envlp.properties && !envlp.properties.primary_category) {
      const cat = await CAT.resolveCategory(env, envlp.properties.product_names || envlp.properties.primary_product_name || '');
      if (cat) envlp.properties.primary_category = cat;
    }

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
