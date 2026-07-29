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
// The lifecycles Shopify's fulfillment webhook can ALSO observe — these share an
// order-scoped idempotency key with that path so one delivery cannot message twice.
const SHARED_KEY_LIFECYCLES = new Set(['delivered', 'out_for_delivery']);
const MAX_PER_RUN = 15;   // keeps the cron tick well inside its subrequest budget
// A courier event for a parcel dispatched more than this long ago is a late discovery /
// reconciliation, not news a customer should be messaged about. See the age-cap filter below.
const MAX_EVENT_AGE_MS = 30 * 86400000;

// When did this lifecycle transition actually HAPPEN upstream? Deliberately not "when did we
// poll it" — see the watermark note below. `delivered` carries a real delivery stamp (populated
// on 9,884 of 9,885 live rows).
//
// `lifecycle_changed_at` (migration 0036, added 2026-07-29) is the transition clock for every
// OTHER state. Before it, this read `uniware_updated_at` — a column only the Uniware poller
// writes. That was correct until the Delhivery ScanPush APPLY flip (2026-07-28) made ScanPush a
// second writer of `lifecycle`: its transitions were then dated by Uniware's stale last-touch
// stamp, fell below the watermark, and were dropped as `stale`. Measured before the fix: 150 of
// 153 live `rto` rows silently dropped, 2 order_rto events ever. `delivered` was unaffected
// because ScanPush stamps `delivered_at`.
//
// The fallback to `uniware_updated_at` is LOAD-BEARING, not just back-compat: `lifecycle_changed_at`
// is NULL on every pre-fix row by design (never backfill it — see 0036). That null is what keeps
// ~208 historical transitions silent instead of firing them at customers in one burst.
//
// NOT `updated_at`: that bumps on ANY write, including a reconcile that changes nothing, so it
// would turn every housekeeping touch into "your order is on the way".
function occurredAt(s) {
  const raw = s.lifecycle === 'delivered'
    ? (s.delivered_at || s.lifecycle_changed_at || s.uniware_updated_at)
    : (s.lifecycle_changed_at || s.uniware_updated_at);
  const t = Date.parse(raw || '');
  return Number.isNaN(t) ? null : t;
}

// emitShipmentEvents(env, ingest) — `ingest` is injected to keep this module pure-ish and
// avoid a require cycle with index.js.
async function emitShipmentEvents(env, ingest) {
  const want = Object.keys(EMIT_EVENT);

  // WATERMARK. `emitted_lifecycles` answers "already sent?"; it cannot answer "did this happen
  // before Relay existed?". The 2026-07-20 backfill needed the second answer and only had the
  // first, so it bulk-marked every row — permanently silencing order_delivered/order_rto, whose
  // states are terminal and never transition again.
  //
  // Fail CLOSED: no watermark ⇒ emit nothing. A missing setting must never mean "send everything"
  // — the blast radius here is live customer messages.
  const st = await A.sbComms('/rest/v1/settings?id=eq.1&select=courier_emit_from&limit=1', env);
  const fromRaw = st.ok ? st.data?.[0]?.courier_emit_from : null;
  const fromMs = Date.parse(fromRaw || '');
  if (!fromRaw || Number.isNaN(fromMs)) return { ok: true, skipped: 'no_watermark', sent: 0 };
  // Website parcels only: identity resolves via the Shopify order, which the marketplace
  // channels Uniware also fulfils (CRED / FirstCry) do not have in this substrate.
  // Coarse gate in the query (index-friendly, and stops the 300-row window filling with ancient
  // rows and starving live ones); the precise per-lifecycle check happens below on occurredAt.
  // The coarse gate must accept EITHER clock, or the ScanPush rows this fix exists for never
  // reach occurredAt() — their `uniware_updated_at` is stale by construction.
  // Ordered by `updated_at`, which BOTH feeds bump (verified 2026-07-29: non-null and >=
  // uniware_updated_at on 179/179 recent rows), so neither feed can starve the other out of the
  // 300-row window. Ordering only — `updated_at` is never the transition clock, see occurredAt().
  const fromIso = encodeURIComponent(new Date(fromMs).toISOString());
  const q = `/rest/v1/ecom_shipments?lifecycle=in.(${want.join(',')})&shopify_order_id=not.is.null`
    + `&or=(uniware_updated_at.gte.${fromIso},lifecycle_changed_at.gte.${fromIso})`
    + `&select=id,uniware_package_code,shopify_order_name,shopify_order_id,lifecycle,courier,`
    + `tracking_number,tracking_link,emitted_lifecycles,delivered_at,dispatched_at,uniware_updated_at,`
    + `lifecycle_changed_at,first_seen_at,updated_at`
    + `&order=updated_at.desc.nullslast&limit=300`;
  const r = await sbPublic(q, env);
  if (!r.ok) return { ok: false, error: `select_failed_${r.status}` };

  // A row can pass the coarse gate but still be a LATE DISCOVERY of an old event — Uniware
  // reconciling a months-stale parcel bumps uniware_updated_at to today while delivered_at
  // stays in May. Those are dropped WITHOUT marking: they are not "done", they are out of
  // scope, and marking them would corrupt the guard if the watermark is ever moved back.
  let stale = 0, aged = 0;
  const pending = (r.data || [])
    .filter((s) => !(s.emitted_lifecycles || []).includes(s.lifecycle))
    .filter((s) => {
      const at = occurredAt(s);
      if (at === null || at < fromMs) { stale++; return false; }
      // AGE CAP (2026-07-23, shipped with the poller seconds-vs-ms fix). For rto/in_transit/
      // out_for_delivery, occurredAt is the transition clock — `lifecycle_changed_at` since
      // 2026-07-29, `uniware_updated_at` on older rows — and BOTH can be pushed past the
      // watermark by a late upstream re-touch (a Uniware reconcile, or a courier back-filling
      // an old scan). ~6k parcels sit at in_transit with dispatch weeks
      // in the past; a bulk reconciliation on Uniware's side would otherwise turn each into a
      // fresh "your order is on the way / being returned" message. A courier message about a
      // parcel DISPATCHED >30 days ago is never news — drop WITHOUT marking (same rationale
      // as `stale`: out of scope, not done). delivered is already governed by its true
      // delivered_at stamp; this is belt-and-braces there.
      const born = Date.parse(s.dispatched_at || s.first_seen_at || '');
      if (!Number.isNaN(born) && Date.now() - born > MAX_EVENT_AGE_MS) { aged++; return false; }
      return true;
    })
    .slice(0, MAX_PER_RUN);
  if (!pending.length) return { ok: true, candidates: 0, sent: 0, stale, aged };

  let sent = 0, unresolved = 0, failed = 0;
  for (const s of pending) {
    const ev = await A.sbComms(
      `/rest/v1/events?name=eq.order_placed&properties->>shopify_order_id=eq.${A.enc(s.shopify_order_id)}`
      + `&select=profile_id&limit=1`, env);
    if (!ev.ok) { failed++; continue; }          // transient read error → retry next tick (review H11)
    const profileId = ev.data?.[0]?.profile_id || null;
    // No profile means either (a) the order predates Relay's Shopify feed, or (b) this parcel
    // is simply ahead of the Shopify order_placed webhook (same-day ship + retry backoff).
    // (a) should drain via markEmitted; (b) must NOT be written off — a same-day-ship customer's
    // delivered/rto message would be permanently cancelled by a race that resolves itself in
    // minutes (review H11). Use a 24h grace window on first_seen_at to tell them apart.
    if (!profileId) {
      // first_seen_at is NOT NULL with a DEFAULT now() (verified live: 0 nulls across 19,406
      // rows) — the `|| 0` fallback below is defensive only, and if it ever did fire, treating
      // an unknown birth as epoch-0 (i.e. always "old") would be the wrong direction for a
      // terminal, message-cancelling action. Kept as-is only because the column cannot be null.
      const born = new Date(s.first_seen_at || 0).getTime();
      if (Date.now() - born < 24 * 3600 * 1000) { unresolved++; continue; }
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
      // ⚠️ SHARED WITH THE SHOPIFY FULFILLMENT PATH for the two lifecycles BOTH feeds can
      // observe. Shopify's fulfillment shipment_status emits `delivery:<order_id>:<status>` for
      // delivered / out_for_delivery, so keying those per-source would message one customer
      // twice for one parcel. Whichever source sees it first wins; the second dedupes on
      // arrival. in_transit / rto stay on the package key — Shopify's in_transit is deliberately
      // not mapped, and rto is Uniware-only. Falls back to the package key when the row has no
      // Shopify order id, which is the only case the shared key cannot express.
      idempotency_key: (SHARED_KEY_LIFECYCLES.has(s.lifecycle) && s.shopify_order_id)
        ? `delivery:${s.shopify_order_id}:${s.lifecycle}`
        : `uniware:${s.uniware_package_code}:${s.lifecycle}`,
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
  return { ok: true, candidates: pending.length, sent, unresolved, failed, stale, aged };
}

async function markEmitted(env, s) {
  return sbPublic(`/rest/v1/ecom_shipments?id=eq.${A.enc(s.id)}`, env, {
    method: 'PATCH',
    body: JSON.stringify({ emitted_lifecycles: [...(s.emitted_lifecycles || []), s.lifecycle] }),
  });
}

module.exports = { emitShipmentEvents, EMIT_EVENT };
