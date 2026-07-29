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
      // The gate is an OR over BOTH clocks (2026-07-29): a ScanPush row has a fresh
      // lifecycle_changed_at and a stale uniware_updated_at, and must still get through.
      // THROW on no-match rather than defaulting the floor — the previous version fell back to
      // -Infinity, so when the query shape changed the gate silently stopped being emulated and
      // every test kept passing while testing nothing.
      const m = url.match(/or=\(uniware_updated_at\.gte\.([^,]+),lifecycle_changed_at\.gte\.([^)]+)\)/);
      if (!m) throw new Error('test stub: coarse-gate filter not recognised in URL — ' + url);
      const floorU = Date.parse(decodeURIComponent(m[1]));
      const floorL = Date.parse(decodeURIComponent(m[2]));
      const at = (v) => { const t = Date.parse(v || ''); return Number.isNaN(t) ? -Infinity : t; };
      return { ok: true, data: state.rows.filter((r) => at(r.uniware_updated_at) >= floorU
                                                     || at(r.lifecycle_changed_at) >= floorL) };
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
// first_seen_at defaults RELATIVE (3d ago): old enough to be past the 24h profile grace,
// young enough to pass the 30d age cap — and no hardcoded date for the age cap to time-bomb.
const row = (o) => Object.assign({
  id: 'r1', uniware_package_code: 'SP/1', shopify_order_id: '123', shopify_order_name: '#LOT1',
  lifecycle: 'delivered', emitted_lifecycles: [], delivered_at: null, uniware_updated_at: null,
  lifecycle_changed_at: null,   // NULL on every pre-2026-07-29 row, by design — see migration 0036
  dispatched_at: null, first_seen_at: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(),
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

  // ── THE SCANPUSH REGRESSION (found 2026-07-29) ──────────────────────────────────────────
  // ScanPush advances `lifecycle` but cannot touch `uniware_updated_at` (odoops owns it and
  // uses it as a poll cursor). Before `lifecycle_changed_at`, such a transition was dated by
  // Uniware's stale stamp and dropped as `stale`: 150 of 153 live rto rows, silently.
  reset();
  state.rows = [row({ lifecycle: 'rto', delivered_at: null,
    uniware_updated_at: '2026-07-15T09:00:00Z',            // stale — Uniware last touched it in the past
    lifecycle_changed_at: '2026-07-28T16:00:00Z' })];       // fresh — the courier scan that flipped it
  await SE.emitShipmentEvents({}, ingest);
  ok(state.ingested.length === 1 && state.ingested[0].name === 'order_rto',
    'SCANPUSH: rto with fresh lifecycle_changed_at + STALE uniware_updated_at emits');

  // The other half of the same fix: the NULL fallback is what keeps history silent. If
  // lifecycle_changed_at were ever backfilled from updated_at, ~208 held transitions would fire
  // at once — 57 of them into LIVE journeys. Never backfill it (migration 0036).
  // NB it is excluded by the COARSE gate (both clocks below the watermark), so it never reaches
  // the `stale` counter — silence is the invariant, not which stage produced it.
  reset();
  state.rows = [row({ lifecycle: 'rto', delivered_at: null,
    uniware_updated_at: '2026-07-15T09:00:00Z', lifecycle_changed_at: null })];
  await SE.emitShipmentEvents({}, ingest);
  ok(state.ingested.length === 0 && state.patched.length === 0,
    'SCANPUSH: pre-fix row (lifecycle_changed_at NULL, stale uniware) stays SILENT + unmarked');

  // in_transit rides the same clock — the fix is not rto-specific.
  reset();
  state.rows = [row({ lifecycle: 'in_transit', delivered_at: null,
    uniware_updated_at: '2026-07-15T09:00:00Z', lifecycle_changed_at: '2026-07-28T16:00:00Z' })];
  await SE.emitShipmentEvents({}, ingest);
  ok(state.ingested.length === 1 && state.ingested[0].name === 'order_shipped',
    'SCANPUSH: in_transit emits off lifecycle_changed_at too');

  // delivered keeps its OWN stamp as the authority — a late scan-push flip must not re-date a
  // delivery that already has a real delivered_at behind the watermark.
  reset();
  state.rows = [row({ lifecycle: 'delivered', delivered_at: '2026-05-10T09:00:00Z',
    uniware_updated_at: '2026-07-15T09:00:00Z', lifecycle_changed_at: '2026-07-28T16:00:00Z' })];
  let rD = await SE.emitShipmentEvents({}, ingest);
  ok(state.ingested.length === 0 && rD.stale === 1,
    'delivered still governed by delivered_at, NOT lifecycle_changed_at');

  // AGE CAP — shipped with the 2026-07-23 poller seconds-vs-ms fix. Once re-polling works,
  // a bulk Uniware reconciliation can bump uniware_updated_at past the watermark on parcels
  // dispatched weeks ago; for rto/in_transit/OFD that stamp IS occurredAt, so without the cap
  // each would emit a fresh customer message. delivered rides its true stamp; the cap is
  // belt-and-braces there (accepted trade-off: a genuine >30d-after-dispatch event is silenced).
  reset();
  state.rows = [row({ lifecycle: 'rto', uniware_updated_at: '2026-07-26T09:00:00Z',
    dispatched_at: new Date(Date.now() - 60 * 86400000).toISOString() })];
  r = await SE.emitShipmentEvents({}, ingest);
  ok(state.ingested.length === 0 && r.aged === 1 && state.patched.length === 0,
    'rto on a parcel dispatched 60d ago is age-capped (dropped, NOT marked)');

  reset();
  state.rows = [row({ lifecycle: 'rto', uniware_updated_at: '2026-07-26T09:00:00Z',
    dispatched_at: new Date(Date.now() - 5 * 86400000).toISOString() })];
  await SE.emitShipmentEvents({}, ingest);
  ok(state.ingested.length === 1 && state.ingested[0].name === 'order_rto',
    'rto on a recently-dispatched parcel still emits');

  reset();
  state.rows = [row({ lifecycle: 'in_transit', uniware_updated_at: '2026-07-26T09:00:00Z',
    first_seen_at: new Date(Date.now() - 45 * 86400000).toISOString() })];
  r = await SE.emitShipmentEvents({}, ingest);
  ok(state.ingested.length === 0 && r.aged === 1,
    'no dispatched_at → first_seen_at governs the age cap');

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
