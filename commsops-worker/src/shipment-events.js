// Courier lifecycle → Relay substrate events (the trigger source for the Delivered and RTO
// journeys, which BiteSpeed drives off Shiprocket webhooks and Relay previously had no feed for).
//
// PULL, not push. odoops owns the Uniware poll and writes public.ecom_shipments; commsops reads
// that table on its existing */5 cron and calls ingest() IN-PROCESS. Two reasons this beats
// odoops POSTing to /ingest:
//   1. A Worker cannot fetch() another Worker on the same workers.dev zone — Cloudflare
//      error 1042. odoops → commsops/ingest 404s. (Same trap awaits the csops → commsops
//      call at the Pitstop WA cutover.) A service binding would fix it; not needing one is better.
//   2. ingest() is what performs the M7 journey-trigger matching + enrolment fan-out. Writing
//      to comms.events directly would record the event but never start a journey.
//
// Identity: Uniware MASKS customer contact ('********'), so it supplies no identifiers. The
// profile is resolved from the order_placed event Relay already holds for that Shopify order —
// so no customer PII crosses between the two systems.

const A = require('./auth.js');

// Explicitly 'public' — sbProfile stamps Accept-Profile unconditionally, so passing null
// would send the literal header value "null" and PostgREST would reject the schema.
const sbPublic = A.sbProfile('public');

// Only transitions worth a customer message. `manifested`/`pending` are not news, and
// `cancelled` is already covered by Shopify's order-level event.
const EMIT_EVENT = {
  in_transit: 'order_shipped',
  out_for_delivery: 'order_out_for_delivery',
  delivered: 'order_delivered',
  rto: 'order_rto',
};
const MAX_PER_RUN = 15;   // keeps the cron tick well inside its subrequest budget

// emitShipmentEvents(env, ingest) — `ingest` is injected to keep this module pure-ish and
// avoid a require cycle with index.js.
async function emitShipmentEvents(env, ingest) {
  const want = Object.keys(EMIT_EVENT);
  // Website parcels only: identity resolves via the Shopify order, which the marketplace
  // channels Uniware also fulfils (CRED / FirstCry) do not have in this substrate.
  const q = `/rest/v1/ecom_shipments?lifecycle=in.(${want.join(',')})&shopify_order_id=not.is.null`
    + `&select=id,uniware_package_code,shopify_order_name,shopify_order_id,lifecycle,courier,`
    + `tracking_number,tracking_link,emitted_lifecycles`
    + `&order=uniware_updated_at.desc.nullslast&limit=300`;
  const r = await sbPublic(q, env);
  if (!r.ok) return { ok: false, error: `select_failed_${r.status}` };

  const pending = (r.data || [])
    .filter((s) => !(s.emitted_lifecycles || []).includes(s.lifecycle))
    .slice(0, MAX_PER_RUN);
  if (!pending.length) return { ok: true, candidates: 0, sent: 0 };

  let sent = 0, unresolved = 0, failed = 0;
  for (const s of pending) {
    const ev = await A.sbComms(
      `/rest/v1/events?name=eq.order_placed&properties->>shopify_order_id=eq.${A.enc(s.shopify_order_id)}`
      + `&select=profile_id&limit=1`, env);
    const profileId = (ev.ok && ev.data?.[0]?.profile_id) || null;
    // No profile means the order predates Relay's Shopify feed. Nothing to message, and
    // re-checking it every tick is waste — mark it done so the queue drains.
    if (!profileId) {
      unresolved++;
      await markEmitted(env, s);
      continue;
    }
    const res = await ingest(env, {
      profile_id: profileId,
      name: EMIT_EVENT[s.lifecycle],
      source: 'uniware',
      // One event per (package, lifecycle): a retry after a partial failure can never
      // double-fire a customer message.
      idempotency_key: `uniware:${s.uniware_package_code}:${s.lifecycle}`,
      properties: {
        // Uniware's displayOrderCode is '#LOT43700'; templates render "Order #{{n}}", so strip
        // both the hash and the LOT prefix to leave the bare number Shopify shows customers.
        order_number: s.shopify_order_name ? String(s.shopify_order_name).replace(/^#?(LOT)?/i, '') : null,
        shopify_order_id: s.shopify_order_id,
        courier: s.courier,
        tracking_number: s.tracking_number,
        tracking_url: s.tracking_link,
        shipping_package: s.uniware_package_code,
      },
    });
    if (!res?.ok) { failed++; continue; }        // leave unmarked → retried next tick
    await markEmitted(env, s);
    sent++;
  }
  return { ok: true, candidates: pending.length, sent, unresolved, failed };
}

async function markEmitted(env, s) {
  return sbPublic(`/rest/v1/ecom_shipments?id=eq.${A.enc(s.id)}`, env, {
    method: 'PATCH',
    body: JSON.stringify({ emitted_lifecycles: [...(s.emitted_lifecycles || []), s.lifecycle] }),
  });
}

module.exports = { emitShipmentEvents, EMIT_EVENT };
