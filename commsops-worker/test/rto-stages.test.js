// RTO stages 2 + 3 — the return-leg emitter.
// Run: node test/rto-stages.test.js
//
// The two properties that actually matter here are both about NOT messaging people:
//   1. FAIL CLOSED on a missing watermark. `courier_emit_from` predates ScanPush, so if this
//      emitter ever fell back to it (or to "no watermark = send everything") it would fire every
//      historical X-DDD3FD scan at real customers on deploy.
//   2. RD-AC IS AMBIGUOUS. The same code carries status='DTO' (customer-initiated return coming
//      home) as well as 'RTO' (failed delivery). Telling a customer who chose to return an item
//      that "your order has been returned to our warehouse" is a different, confusing message.

const assert = require('assert');
const A = require('../src/auth.js');
const RTO = require('../src/rto-stages.js');

let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const scan = (o) => Object.assign({
  id: 's1', awb: 'AWB1', status: 'Dispatched', status_type: 'RT',
  nsl_code: 'X-DDD3FD', status_at: iso(NOW - 60000), matched_shipment_id: 'ship-1',
}, o);
const ship = (o) => Object.assign({
  id: 'ship-1', lifecycle: 'rto', shopify_order_id: '999', shopify_order_name: '#LOT43700',
  courier: 'Delhivery', tracking_number: 'AWB1', tracking_link: 'http://t/1',
  uniware_package_code: 'SP/1', dispatched_at: iso(NOW - 3 * 86400000), first_seen_at: iso(NOW - 3 * 86400000),
}, o);

const state = {};
const origSb = A.sbComms, origProfile = A.sbProfile;
function stub({ watermark = iso(NOW - 86400000), scans = [], ships = [], profile = 'p1' } = {}) {
  state.ingested = [];
  A.sbComms = async (url) => {
    if (url.startsWith('/rest/v1/settings')) return { ok: true, data: [{ rto_stage_emit_from: watermark }] };
    if (url.startsWith('/rest/v1/events')) return { ok: true, data: profile ? [{ profile_id: profile }] : [] };
    return { ok: true, data: [] };
  };
  A.sbProfile = () => async (url) => {
    if (url.startsWith('/rest/v1/courier_scan_captures')) return { ok: true, data: scans };
    if (url.startsWith('/rest/v1/ecom_shipments')) return { ok: true, data: ships };
    return { ok: true, data: [] };
  };
  // rto-stages.js binds sbProfile at require time, so reload it under the stub.
  delete require.cache[require.resolve('../src/rto-stages.js')];
  return require('../src/rto-stages.js');
}
const restore = () => { A.sbComms = origSb; A.sbProfile = origProfile; };
const ingest = async (env, ev) => { state.ingested.push(ev); return { ok: true }; };

(async () => {
  // ── 1. fail closed ─────────────────────────────────────────────────────────────────────
  await t('NO watermark ⇒ emits nothing (fails CLOSED)', async () => {
    const M = stub({ watermark: null, scans: [scan()], ships: [ship()] });
    const r = await M.emitRtoStageEvents({}, ingest);
    restore();
    assert.equal(r.skipped, 'no_watermark');
    assert.equal(state.ingested.length, 0);
  });

  // ── 2. stage 2 ─────────────────────────────────────────────────────────────────────────
  await t('X-DDD3FD → order_rto_out_for_delivery', async () => {
    const M = stub({ scans: [scan()], ships: [ship()] });
    await M.emitRtoStageEvents({}, ingest);
    restore();
    assert.equal(state.ingested.length, 1);
    const ev = state.ingested[0];
    assert.equal(ev.name, 'order_rto_out_for_delivery');
    assert.equal(ev.idempotency_key, 'delhivery:AWB1:order_rto_out_for_delivery');
    assert.equal(ev.properties.order_number, '43700', '#LOT prefix stripped for the template');
    assert.equal(ev.profile_id, 'p1');
  });

  // ── 3. stage 3, and the DTO trap ───────────────────────────────────────────────────────
  await t('RD-AC + status RTO → order_rto_delivered', async () => {
    const M = stub({ scans: [scan({ nsl_code: 'RD-AC', status: 'RTO', status_type: 'DL' })], ships: [ship()] });
    await M.emitRtoStageEvents({}, ingest);
    restore();
    assert.equal(state.ingested.length, 1);
    assert.equal(state.ingested[0].name, 'order_rto_delivered');
  });

  await t('RD-AC + status DTO is EXCLUDED (customer-initiated return ≠ RTO)', async () => {
    const M = stub({ scans: [scan({ nsl_code: 'RD-AC', status: 'DTO', status_type: 'DL' })], ships: [ship()] });
    const r = await M.emitRtoStageEvents({}, ingest);
    restore();
    assert.equal(state.ingested.length, 0);
    assert.equal(r.candidates, 0);
  });

  // ── 3b. THE FORWARD-LEG TRAP — the bug this emitter nearly shipped ─────────────────────
  // X-DDD3FD reads "Dispatched for RTO" but Delhivery reuses it for ordinary forward dispatch.
  // Measured: 64 AWBs/24h with status_type='UD' on parcels still in_transit TO the customer.
  // Emitting on those tells someone their order is going back while it is on its way to them.
  await t('TRAP: X-DDD3FD with status_type=UD (forward dispatch) emits NOTHING', async () => {
    const M = stub({
      scans: [scan({ status_type: 'UD' })],
      ships: [ship({ lifecycle: 'in_transit' })],
    });
    const r = await M.emitRtoStageEvents({}, ingest);
    restore();
    assert.equal(state.ingested.length, 0);
    assert.equal(r.candidates, 0, 'rejected at the scan-code stage, before any lookup');
  });

  await t('TRAP: PU (pickup) scan on X-DDD3FD emits nothing', async () => {
    const M = stub({ scans: [scan({ status_type: 'PU' })], ships: [ship()] });
    const r = await M.emitRtoStageEvents({}, ingest);
    restore();
    assert.equal(state.ingested.length, 0);
    assert.equal(r.candidates, 0);
  });

  // The SECOND, independent guard: even a correctly-typed RT scan is dropped if the parcel
  // itself is not on the return leg. This alone would have caught the trap above.
  await t('GUARD 2: RT scan but shipment lifecycle != rto ⇒ dropped', async () => {
    const M = stub({ scans: [scan()], ships: [ship({ lifecycle: 'in_transit' })] });
    const r = await M.emitRtoStageEvents({}, ingest);
    restore();
    assert.equal(state.ingested.length, 0);
    assert.equal(r.notRto, 1);
  });

  // ── 4. guards ──────────────────────────────────────────────────────────────────────────
  await t('parcel with no shopify_order_id is skipped (no identity path)', async () => {
    const M = stub({ scans: [scan()], ships: [ship({ shopify_order_id: null })] });
    const r = await M.emitRtoStageEvents({}, ingest);
    restore();
    assert.equal(state.ingested.length, 0);
    assert.equal(r.skipped, 1);
  });

  await t('parcel dispatched 60d ago is age-capped', async () => {
    const old = iso(NOW - 60 * 86400000);
    const M = stub({ scans: [scan()], ships: [ship({ dispatched_at: old, first_seen_at: old })] });
    const r = await M.emitRtoStageEvents({}, ingest);
    restore();
    assert.equal(state.ingested.length, 0);
    assert.equal(r.aged, 1);
  });

  await t('no matching order_placed profile ⇒ no event (and no tombstone written)', async () => {
    const M = stub({ scans: [scan()], ships: [ship()], profile: null });
    const r = await M.emitRtoStageEvents({}, ingest);
    restore();
    assert.equal(state.ingested.length, 0);
    assert.equal(r.unresolved, 1);
  });

  await t('an unrelated nsl code emits nothing', async () => {
    const M = stub({ scans: [scan({ nsl_code: 'X-ILL1F', status: 'In Transit' })], ships: [ship()] });
    await M.emitRtoStageEvents({}, ingest);
    restore();
    // the query filters by code server-side; belt-and-braces that a leaked row maps to nothing
    assert.equal(state.ingested.filter((e) => e.name).length, 0);
  });

  // ── 5. batching + idempotency shape ────────────────────────────────────────────────────
  await t('two scans on DIFFERENT awbs both emit, with distinct keys', async () => {
    const M = stub({
      scans: [scan(), scan({ id: 's2', awb: 'AWB2', matched_shipment_id: 'ship-2' })],
      ships: [ship(), ship({ id: 'ship-2', shopify_order_id: '1000', shopify_order_name: '#LOT43701' })],
    });
    await M.emitRtoStageEvents({}, ingest);
    restore();
    assert.equal(state.ingested.length, 2);
    const keys = new Set(state.ingested.map((e) => e.idempotency_key));
    assert.equal(keys.size, 2, 'idempotency keys must be per-awb, not shared');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
