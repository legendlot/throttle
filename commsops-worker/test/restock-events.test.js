// SP3 restock emitter (S362, 2026-09-09). Written after the S362 hostile review pointed out that
// the entire new sending half shipped with no test in a worker carrying 100+ of them.
//
// The three properties worth pinning are all failure paths, because the success path is the one
// that got smoked by hand and the failure paths are the ones that lose a customer's alert:
//   1. It emits NOTHING while the journey is in draft. Emitting early does not "queue events up" —
//      ingest enrols at event time, and UNIQUE(submission_id) means the claim is spent forever. A
//      regression here silently guarantees the customer never hears back.
//   2. A failed ingest increments attempts and does NOT stamp event_emitted_at, so the row stays
//      pending and retryable.
//   3. A failed stamp leaves rows pending rather than marking them done — self-healing next tick,
//      because the idempotency key makes the repeat ingest a no-op.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// Stub ./auth.js before requiring the module under test, so no network and no env is needed.
const calls = [];
let responder = () => ({ ok: true, status: 200, data: [] });
const origResolve = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === './auth.js') {
    return {
      enc: encodeURIComponent,
      sbComms: async (path, env, opts) => {
        calls.push({ path, method: opts?.method || 'GET', body: opts?.body ? JSON.parse(opts.body) : null });
        return responder(path, opts);
      },
    };
  }
  return origResolve.apply(this, arguments);
};
const { emitRestockEvents } = require('../src/restock-events.js');
Module._load = origResolve;

const reset = () => { calls.length = 0; };
const ACTIVE_JOURNEY = [{ id: 'J1', trigger: { type: 'event', name: 'back_in_stock' } }];
const PENDING = [{
  id: 'N1', profile_id: 'P1', email: 'x@example.com', variant_sku: 'shadow-tarmac-black',
  product_code: 'SHTK', product_title: 'Shadow', product_url: 'https://x/y', qty_after: 5,
  flipped_at: '2026-09-09T11:00:00Z', attempts: 0,
}];

test('emits NOTHING while the journey is in draft — an early emit spends the signup forever', async () => {
  reset();
  responder = (path) => (path.startsWith('/rest/v1/journeys')
    ? { ok: true, status: 200, data: [{ id: 'J0', trigger: { type: 'event', name: 'something_else' } }] }
    : { ok: true, status: 200, data: [] });
  let ingestCalls = 0;
  const out = await emitRestockEvents({}, async () => { ingestCalls += 1; return { ok: true }; });

  assert.deepEqual(out, { skipped: 'no_active_journey' });
  assert.equal(ingestCalls, 0, 'must not emit');
  assert.equal(calls.filter((c) => c.path.includes('claim_restock_notifications')).length, 0,
    'and must not even CLAIM — a claim with no emit is the same lost signup');
});

test('a failed ingest bumps attempts and leaves the row pending, never stamped', async () => {
  reset();
  responder = (path) => {
    if (path.startsWith('/rest/v1/journeys')) return { ok: true, status: 200, data: ACTIVE_JOURNEY };
    if (path.includes('claim_restock_notifications')) return { ok: true, status: 200, data: 1 };
    if (path.startsWith('/rest/v1/restock_notifications?event_emitted_at=is.null')) return { ok: true, status: 200, data: PENDING };
    return { ok: true, status: 200, data: [] };
  };
  const out = await emitRestockEvents({}, async () => ({ ok: false, error: 'identifiers_required' }));

  assert.equal(out.emitted, 0);
  assert.equal(out.failed, 1);
  const patches = calls.filter((c) => c.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.equal(patches[0].body.attempts, 1);
  assert.match(patches[0].body.last_error, /identifiers_required/);
  assert.ok(!('event_emitted_at' in patches[0].body), 'a failed emit must never stamp the row done');
});

test('the pending read caps attempts, so one unemittable row cannot starve every later alert', async () => {
  reset();
  responder = (path) => {
    if (path.startsWith('/rest/v1/journeys')) return { ok: true, status: 200, data: ACTIVE_JOURNEY };
    if (path.includes('claim_restock_notifications')) return { ok: true, status: 200, data: 0 };
    return { ok: true, status: 200, data: [] };
  };
  await emitRestockEvents({}, async () => ({ ok: true }));
  const read = calls.find((c) => c.path.startsWith('/rest/v1/restock_notifications?event_emitted_at=is.null'));
  assert.ok(read, 'the pending read must happen');
  assert.match(read.path, /attempts=lt\.\d+/, 'without a cap, 50 dead rows block the queue forever');
});

test('a successful emit stamps in ONE batched patch, not one write per row', async () => {
  reset();
  const two = [PENDING[0], { ...PENDING[0], id: 'N2' }];
  responder = (path) => {
    if (path.startsWith('/rest/v1/journeys')) return { ok: true, status: 200, data: ACTIVE_JOURNEY };
    if (path.includes('claim_restock_notifications')) return { ok: true, status: 200, data: 2 };
    if (path.startsWith('/rest/v1/restock_notifications?event_emitted_at=is.null')) return { ok: true, status: 200, data: two };
    return { ok: true, status: 200, data: [] };
  };
  const seen = [];
  const out = await emitRestockEvents({}, async (env, p) => { seen.push(p); return { ok: true }; });

  assert.equal(out.emitted, 2);
  assert.equal(seen[0].idempotency_key, 'restock:N1', 'one event per LEDGER row — that is the once-only guarantee');
  assert.equal(seen[0].occurred_at, '2026-09-09T11:00:00Z', 'the flip time, not when the cron noticed');
  const patches = calls.filter((c) => c.method === 'PATCH');
  assert.equal(patches.length, 1, 'one patch for both rows');
  assert.match(patches[0].path, /id=in\.\(N1,N2\)/);
  assert.ok(patches[0].body.event_emitted_at);
});
