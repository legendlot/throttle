// Back-in-stock alerts — the SENDING half of SP3 (S362, 2026-09-09).
//
// The capture half has existed since S331: the `/f/*` widget writes a `comms.form_submissions`
// row for the `back-in-stock` form. Nothing ever consumed one, which is exactly what gated the
// storefront decision — a second form on a live PDP that also could not send anything.
//
// ⭐ THE RESTOCK DETECTOR ALREADY EXISTED. `sales.stock_alert_outbox` has recorded stock flips
// for Odo's Slack alerts since S289 (direction oos|restock, scope product|variant, qty_before →
// qty_after). Measured 2026-09-09: 151 variant restocks in 30 days over 46 product codes, newest
// the same afternoon. So this is a JOIN, not a poller — no new Shopify webhook, no new cron, and
// no second source of truth for "is it back".
//
// ⚠️ THE JOIN KEY IS THE SHOPIFY VARIANT SKU. `stock_alert_outbox.product_code` is the LOT code
// (SHTK, GHUW); `.sku` is the Shopify variant SKU (shadow-tarmac-black). A Liquid theme knows its
// `variant.sku` and has no idea what a LOT code is, so the form captures the SKU. The two
// pre-existing test submissions stored a Shopify VARIANT ID under a field called `product_code` —
// neither grain, matching nothing, while looking perfectly correct. The field is `variant_sku`
// now so the name states what the value is. 78 of 78 restock SKUs resolve in sales.sku_map.
//
// PULL + IN-PROCESS ingest, for the same two reasons shipment-events.js documents: a Worker
// cannot fetch() a sibling Worker on the same workers.dev zone (error 1042), and ingest() is what
// performs journey-trigger matching — writing to comms.events directly records the event and
// starts nothing.
//
// ⛔ THIS EMITS; IT DOES NOT SEND. ingest() only enrols into journeys whose status is ACTIVE, so
// while "Back in stock — requested alert" sits in draft the events accumulate and no customer is
// mailed. Activating that journey is the entire go-live switch.

const A = require('./auth.js');

// Floor. Nothing older than this is ever matched, so switching the feature on cannot mail anyone
// about a flip from before it existed. `submitted_at < flipped_at` already prevents that for any
// signup made after go-live; this guards the ones made before it.
const RESTOCK_SINCE = '2026-09-09T00:00:00Z';

// Per tick. Each row costs one ingest (a few subrequests), and the ceiling is 10,000 per
// invocation — this is bounded for latency and for the shared cron budget, not by that limit.
const CLAIM_LIMIT = 200;
const EMIT_LIMIT = 50;

/**
 * Claim newly-restocked signups, then emit a `back_in_stock` event for every pending row.
 *
 * Claim and emit are deliberately SEPARATE passes over the ledger rather than one pass over the
 * RPC's return value. The claim row is written before the event exists, so if the emit fails, a
 * design that trusted the RPC's output would strand that alert forever — the RPC's own
 * NOT EXISTS would never hand the submission out again. Reading `event_emitted_at IS NULL`
 * instead picks up new claims and previous failures in the same query.
 */
async function emitRestockEvents(env, ingest) {
  // 1. claim — one statement, so two overlapping ticks cannot both take the same signup.
  const claim = await A.sbComms('/rest/v1/rpc/claim_restock_notifications', env, {
    method: 'POST',
    body: JSON.stringify({ p_since: RESTOCK_SINCE, p_limit: CLAIM_LIMIT }),
  });
  if (!claim.ok) return { error: 'claim_failed', status: claim.status };
  const claimed = typeof claim.data === 'number' ? claim.data : 0;

  // 2. emit everything still pending, whatever tick claimed it.
  const pend = await A.sbComms(
    '/rest/v1/restock_notifications?event_emitted_at=is.null'
    + '&select=id,profile_id,email,variant_sku,product_code,product_title,product_url,qty_after,flipped_at,attempts'
    + `&order=flipped_at.asc&limit=${EMIT_LIMIT}`, env);
  if (!pend.ok) return { claimed, error: 'pending_read_failed', status: pend.status };
  const rows = Array.isArray(pend.data) ? pend.data : [];
  if (!rows.length) return { claimed, emitted: 0 };

  const done = [];
  let failed = 0;
  for (const r of rows) {
    // profile_id is copied from the submission and is normally set; the email identifier is the
    // fallback for a submission whose profile resolution had not landed yet. ingest() refuses a
    // payload with neither, which is the correct outcome — that row stays pending and visible.
    const res = await ingest(env, {
      profile_id: r.profile_id || null,
      identifiers: r.email ? [{ type: 'email', value: r.email, is_verified: false }] : undefined,
      name: 'back_in_stock',
      source: 'restock_watch',
      // The flip is when it became true, not when this cron noticed.
      occurred_at: r.flipped_at,
      // One event per ledger row, and the ledger is UNIQUE per submission — so "tell me once"
      // survives a retry, a redeploy and an overlapping tick.
      idempotency_key: `restock:${r.id}`,
      properties: {
        variant_sku: r.variant_sku,
        product_code: r.product_code,
        product_title: r.product_title,
        product_url: r.product_url,
        qty_after: r.qty_after,
        flipped_at: r.flipped_at,
        notification_id: r.id,
      },
    });
    if (res?.ok) { done.push(r.id); continue; }
    failed++;
    // Record WHY on the row itself. `res.error` is raw PostgREST text in some paths, so it is
    // truncated and kept off Slack — the same posture forms.js takes with it.
    await A.sbComms(`/rest/v1/restock_notifications?id=eq.${A.enc(r.id)}`, env, {
      method: 'PATCH', prefer: 'return=minimal',
      body: JSON.stringify({
        attempts: (Number(r.attempts) || 0) + 1,
        last_error: String(res?.error || 'unknown').slice(0, 300),
      }),
    }).catch(() => {});
    console.log('restock_ingest_failed', JSON.stringify({ id: r.id, sku: r.variant_sku }));
  }

  // 3. stamp the successes in ONE patch — never a write per row.
  if (done.length) {
    const stamp = await A.sbComms(
      `/rest/v1/restock_notifications?id=in.(${done.map((i) => A.enc(i)).join(',')})`, env, {
        method: 'PATCH', prefer: 'return=minimal',
        body: JSON.stringify({ event_emitted_at: new Date().toISOString() }),
      });
    // A failed stamp is self-healing rather than duplicating: the rows stay pending and are
    // re-emitted next tick, where the idempotency key makes the second ingest a no-op.
    if (!stamp.ok) console.log('restock_stamp_failed', JSON.stringify({ n: done.length, status: stamp.status }));
  }

  return { claimed, emitted: done.length, failed };
}

module.exports = { emitRestockEvents, RESTOCK_SINCE };
