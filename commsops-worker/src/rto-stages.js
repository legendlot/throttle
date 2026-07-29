// RTO stages 2 + 3 — the return leg, at BiteSpeed parity.
//
// WHY A SEPARATE MODULE FROM shipment-events.js. That emitter is LIFECYCLE-driven: it watches
// `ecom_shipments.lifecycle` and fires one event per (package, lifecycle). The return leg has
// three customer-visible stages but only ONE lifecycle value (`rto`), and widening the lifecycle
// enum is not an option — Depot and the dispatch pipeline read that column, so new values would
// break readers that have nothing to do with messaging. So these two stages are driven straight
// off the courier SCAN CODE instead, and `lifecycle` is left completely alone.
//
// THE MAPPING (measured 2026-07-29 against BiteSpeed's live Shiprocket journeys):
//
//   BiteSpeed (Shiprocket)              →  Delhivery ScanPush signal        seen
//   SHIPROCKET_…_RTO_IN_TRANSIT         →  lifecycle 'rto'  (stage 1, already live elsewhere)
//   SHIPROCKET_…_RTO_OUT_FOR_DELIVERY   →  nsl_code X-DDD3FD "Dispatched for RTO"      89
//   SHIPROCKET_…_RTO_DELIVERED          →  nsl_code RD-AC   "RETURN Accepted"           1
//
// The semantics line up exactly: BiteSpeed's OFD copy reads "out for delivery to our warehouse
// as part of the return", which is what "Dispatched for RTO" means; "RETURN Accepted" is the
// warehouse booking the parcel in. This retires the old claim that only two Delhivery codes were
// observable and the stages therefore could not be split.
//
// ⚠️ RD-AC ALSO APPEARS WITH status='DTO' — deliberately EXCLUDED. DTO is a customer-initiated
// return coming home; RTO is a failed delivery. Telling someone who chose to return an item that
// "your order has been returned to our warehouse" is a different (and confusing) message. Stage 3
// requires status='RTO' explicitly. Revisit as its own journey if DTO ever needs covering.
//
// COVERAGE, stated so it is not mistaken for total: this reads DELHIVERY scans only, which is
// 86.6% of RTO volume (310 of 358 shipments/30d). Xpressbees, Shadowfax, Shiprocket-direct and
// self-ship have no scan feed and produce nothing here. Uniware and a future Shiprocket webhook
// are the routes to the remaining ~13% — do NOT assume this module covers them.

const A = require('./auth.js');

const sbPublic = A.sbProfile('public');

// nsl_code → the event we emit. Keyed on the code, not the coarse `status` text, because the
// code is the stable identifier and the same status string appears on unrelated scans.
const STAGE_BY_NSL = {
  'X-DDD3FD': 'order_rto_out_for_delivery',
  'RD-AC': 'order_rto_delivered',
};
// Stage 3 only: RD-AC is reused for DTO (see the note above), so the status must confirm RTO.
const REQUIRED_STATUS = { 'RD-AC': 'RTO' };

const MAX_PER_RUN = 15;                       // matches shipment-events; keeps the tick bounded
const MAX_EVENT_AGE_MS = 30 * 86400000;       // never message about an ancient parcel
const LOOKBACK_MS = 6 * 3600000;              // scan window per tick; dedup is the real guard

async function emitRtoStageEvents(env, ingest) {
  // WATERMARK — its OWN setting, deliberately NOT `courier_emit_from`. That one predates
  // ScanPush (2026-07-24) so reusing it would have back-fired every historical X-DDD3FD scan
  // at real customers the moment this deployed. Fail CLOSED when unset: no watermark ⇒ emit
  // nothing. A missing setting must never mean "send everything" — same rule as the lifecycle
  // emitter, for the same reason.
  const st = await A.sbComms('/rest/v1/settings?id=eq.1&select=rto_stage_emit_from&limit=1', env);
  const fromRaw = st.ok ? st.data?.[0]?.rto_stage_emit_from : null;
  const fromMs = Date.parse(fromRaw || '');
  if (!fromRaw || Number.isNaN(fromMs)) return { ok: true, skipped: 'no_watermark', sent: 0 };

  const since = new Date(Math.max(fromMs, Date.now() - LOOKBACK_MS)).toISOString();
  const codes = Object.keys(STAGE_BY_NSL).join(',');
  const scans = await sbPublic(
    `/rest/v1/courier_scan_captures?nsl_code=in.(${codes})&matched_shipment_id=not.is.null`
    + `&status_at=gte.${encodeURIComponent(since)}`
    + `&select=id,awb,status,status_type,nsl_code,status_at,matched_shipment_id`
    + `&order=status_at.asc&limit=200`, env);
  if (!scans.ok) return { ok: false, error: `scan_select_failed_${scans.status}` };

  const candidates = (scans.data || [])
    .filter((s) => {
      const need = REQUIRED_STATUS[s.nsl_code];
      return !need || String(s.status || '').toUpperCase() === need;
    })
    .slice(0, MAX_PER_RUN);
  if (!candidates.length) return { ok: true, candidates: 0, sent: 0 };

  // One batched read for the parcels (never a per-row await — RULE: batch via IN filters).
  const ids = [...new Set(candidates.map((s) => s.matched_shipment_id))];
  const shipRes = await sbPublic(
    `/rest/v1/ecom_shipments?id=in.(${ids.join(',')})`
    + `&select=id,shopify_order_id,shopify_order_name,courier,tracking_number,tracking_link,`
    + `uniware_package_code,dispatched_at,first_seen_at`, env);
  if (!shipRes.ok) return { ok: false, error: `shipment_select_failed_${shipRes.status}` };
  const byId = new Map((shipRes.data || []).map((r) => [r.id, r]));

  let sent = 0, skipped = 0, aged = 0, unresolved = 0, failed = 0;
  for (const s of candidates) {
    const ship = byId.get(s.matched_shipment_id);
    // Website parcels only — identity resolves through the Shopify order, which the marketplace
    // channels Uniware also fulfils do not have in this substrate.
    if (!ship?.shopify_order_id) { skipped++; continue; }

    const born = Date.parse(ship.dispatched_at || ship.first_seen_at || '');
    if (!Number.isNaN(born) && Date.now() - born > MAX_EVENT_AGE_MS) { aged++; continue; }

    const ev = await A.sbComms(
      `/rest/v1/events?name=eq.order_placed&properties->>shopify_order_id=eq.${A.enc(ship.shopify_order_id)}`
      + `&select=profile_id&limit=1`, env);
    if (!ev.ok) { failed++; continue; }                     // transient → retry next tick
    const profileId = ev.data?.[0]?.profile_id || null;
    // Unlike the lifecycle emitter there is no "mark emitted to drain the queue" here: the
    // LOOKBACK window ages these out by itself, so an unresolvable parcel simply stops being a
    // candidate rather than needing a tombstone.
    if (!profileId) { unresolved++; continue; }

    const res = await ingest(env, {
      profile_id: profileId,
      name: STAGE_BY_NSL[s.nsl_code],
      source: 'delhivery_scanpush',
      // Idempotency is the ONLY dedup guard here (comms.events.idempotency_key is UNIQUE), which
      // is why the lookback window can overlap freely across ticks. Keyed per (awb, stage) so a
      // courier re-sending the same scan — which Delhivery does — can never double-message.
      idempotency_key: `delhivery:${s.awb}:${STAGE_BY_NSL[s.nsl_code]}`,
      properties: {
        // Same normalisation as shipment-events: '#LOT43700' → '43700', because the template
        // renders "Order #{{2}}" and would otherwise print "#LOT" twice.
        order_number: ship.shopify_order_name ? String(ship.shopify_order_name).replace(/^#?(LOT)?/i, '') : null,
        shopify_order_id: ship.shopify_order_id,
        courier: ship.courier,
        tracking_number: ship.tracking_number,
        tracking_url: ship.tracking_link,
        shipping_package: ship.uniware_package_code,
        rto_stage: STAGE_BY_NSL[s.nsl_code],
        nsl_code: s.nsl_code,
        scan_at: s.status_at,
      },
    });
    if (!res?.ok) { failed++; continue; }
    sent++;
  }
  return { ok: true, candidates: candidates.length, sent, skipped, aged, unresolved, failed };
}

module.exports = { emitRtoStageEvents, STAGE_BY_NSL, REQUIRED_STATUS };
