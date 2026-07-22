// Courier-lifecycle emission watermark.
//
// The bug this pins: `emitted_lifecycles` answers "already sent?" but not "did this happen
// before Relay existed?". The 2026-07-20 backfill needed the second answer, had only the first,
// and bulk-marked every row — permanently silencing order_delivered/order_rto (terminal states
// never transition again). The watermark is the second gate. The case that MUST stay silent is
// a late DISCOVERY of an old delivery: uniware_updated_at moves to today, delivered_at stays in May.
const Module = require('module');
const path = require('path').join(__dirname, '..', 'src') + '/';

const state = { rows: [], settings: [{ courier_emit_from: '2026-07-25T00:00:00+05:30' }], patched: [], ingested: [], orderPlaced: true, eventsOk: true };
const orig = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === './auth.js') return {
    enc: (s) => encodeURIComponent(s),
    sbProfile: () => async (url, env, opts) => {
      if (opts && opts.method === 'PATCH') { state.patched.push(url); return { ok: true }; }
      // Emulate the coarse PostgREST gate so the test exercises the real two-stage filter.
      const m = url.match(/uniware_updated_at=gte\.([^&]+)/);
      const floor = m ? Date.parse(decodeURIComponent(m[1])) : -Infinity;
      return { ok: true, data: state.rows.filter((r) => Date.parse(r.uniware_updated_at) >= floor) };
    },
    sbComms: async (url) => {
      if (url.startsWith('/rest/v1/settings')) return { ok: true, data: state.settings };
      // order_placed lookup — H11: a transient read failure must NOT be treated as "no profile".
      if (!state.eventsOk) return { ok: false, status: 500 };
      return { ok: true, data: state.orderPlaced ? [{ profile_id: 'p1' }] : [] };
    },
  };
  return orig.apply(this, arguments);
};
const SE = require(path + 'shipment-events.js');
Module._load = orig;

let fail = 0; const ok = (c, l) => { console.log((c ? '  ok  ' : '  FAIL') + ' ' + l); if (!c) fail++; };
const ingest = async (env, ev) => { state.ingested.push(ev); return { ok: true }; };
const row = (o) => Object.assign({
  id: 'r1', uniware_package_code: 'SP/1', shopify_order_id: '123', shopify_order_name: '#LOT1',
  lifecycle: 'delivered', emitted_lifecycles: [], delivered_at: null, uniware_updated_at: null,
  first_seen_at: '2026-07-01T00:00:00Z',
}, o);
const reset = () => { state.rows = []; state.patched = []; state.ingested = []; state.orderPlaced = true; state.eventsOk = true; state.settings = [{ courier_emit_from: '2026-07-25T00:00:00+05:30' }]; };

(async () => {
  // The regression that caused this work.
  reset();
  state.rows = [row({ delivered_at: '2026-05-10T09:00:00Z', uniware_updated_at: '2026-07-28T09:00:00Z' })];
  let r = await SE.emitShipmentEvents({}, ingest);
  ok(state.ingested.length === 0, 'late discovery of a MAY delivery emits nothing (delivered_at governs, not poll time)');
  ok(r.stale === 1, '  …and is counted stale');
  ok(state.patched.length === 0, '  …and is NOT marked emitted (out of scope ≠ done)');

  reset();
  state.rows = [row({ delivered_at: '2026-07-26T09:00:00Z', uniware_updated_at: '2026-07-26T09:30:00Z' })];
  await SE.emitShipmentEvents({}, ingest);
  ok(state.ingested.length === 1 && state.ingested[0].name === 'order_delivered', 'a genuine post-cutover delivery emits order_delivered');

  // Boundary: the watermark instant itself is inclusive.
  reset();
  state.rows = [row({ delivered_at: '2026-07-24T18:30:00Z', uniware_updated_at: '2026-07-24T18:30:00Z' })];
  await SE.emitShipmentEvents({}, ingest);
  ok(state.ingested.length === 1, 'exactly at the cutover instant emits (gte, not gt)');

  reset();
  state.rows = [row({ delivered_at: '2026-07-24T17:00:00Z', uniware_updated_at: '2026-07-24T17:00:00Z' })];
  await SE.emitShipmentEvents({}, ingest);
  ok(state.ingested.length === 0, 'ninety minutes before the cutover stays silent');

  // Fail closed — a missing watermark must never mean "send everything".
  reset();
  state.settings = [{ courier_emit_from: null }];
  state.rows = [row({ delivered_at: '2026-07-26T09:00:00Z', uniware_updated_at: '2026-07-26T09:00:00Z' })];
  r = await SE.emitShipmentEvents({}, ingest);
  ok(state.ingested.length === 0 && r.skipped === 'no_watermark', 'no watermark ⇒ emits nothing (fails CLOSED)');

  // RTO has no timestamp of its own, so it rides uniware_updated_at.
  reset();
  state.rows = [row({ lifecycle: 'rto', delivered_at: null, uniware_updated_at: '2026-07-26T09:00:00Z' })];
  await SE.emitShipmentEvents({}, ingest);
  ok(state.ingested.length === 1 && state.ingested[0].name === 'order_rto', 'rto (no own stamp) emits off uniware_updated_at');

  // The original de-dup guard must keep working alongside the watermark.
  reset();
  state.rows = [row({ emitted_lifecycles: ['delivered'], delivered_at: '2026-07-26T09:00:00Z', uniware_updated_at: '2026-07-26T09:00:00Z' })];
  await SE.emitShipmentEvents({}, ingest);
  ok(state.ingested.length === 0, 'already-emitted row still suppressed (array guard intact)');

  // An unresolvable profile is drained, not retried forever — but only if in scope.
  reset();
  state.orderPlaced = false;
  state.rows = [row({ delivered_at: '2026-07-26T09:00:00Z', uniware_updated_at: '2026-07-26T09:00:00Z' })];
  r = await SE.emitShipmentEvents({}, ingest);
  ok(state.ingested.length === 0 && r.unresolved === 1 && state.patched.length === 1, 'in-scope row with no profile is marked emitted to drain the queue');

  // H11 — fail-closed + grace-window regression tests.

  // 1. A transient failure reading order_placed must retry next tick, never terminally cancel.
  reset();
  state.eventsOk = false;
  state.rows = [row({ delivered_at: '2026-07-26T09:00:00Z', uniware_updated_at: '2026-07-26T09:00:00Z' })];
  r = await SE.emitShipmentEvents({}, ingest);
  ok(state.ingested.length === 0 && state.patched.length === 0 && r.failed === 1,
    'order_placed lookup FAILURE → parcel retried next tick, NOT marked emitted');

  // 2. A young parcel (< 24h old) with no order_placed yet is likely just ahead of the Shopify
  // webhook (same-day ship) — must not be permanently written off.
  reset();
  state.orderPlaced = false;
  state.rows = [row({
    delivered_at: '2026-07-26T09:00:00Z', uniware_updated_at: '2026-07-26T09:00:00Z',
    first_seen_at: new Date().toISOString(),
  })];
  r = await SE.emitShipmentEvents({}, ingest);
  ok(state.ingested.length === 0 && state.patched.length === 0 && r.unresolved === 1,
    'young parcel with no order_placed yet → NOT marked emitted (grace <24h)');

  // 3. An old parcel (> 24h) with no order_placed is genuinely pre-Relay — drain as before.
  reset();
  state.orderPlaced = false;
  state.rows = [row({
    delivered_at: '2026-07-26T09:00:00Z', uniware_updated_at: '2026-07-26T09:00:00Z',
    first_seen_at: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(),
  })];
  r = await SE.emitShipmentEvents({}, ingest);
  ok(state.ingested.length === 0 && state.patched.length === 1 && r.unresolved === 1,
    'old parcel (>24h) with no order_placed → marked emitted (pre-Relay order)');

  console.log(fail ? `\n${fail} FAILED` : '\nall passed');
  process.exit(fail ? 1 : 0);
})();
