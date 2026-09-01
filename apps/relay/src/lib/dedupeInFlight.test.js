// In-flight dedupe tests. Run from apps/relay:
//   node src/lib/dedupeInFlight.test.js
//
// The property under test: concurrent callers share ONE underlying call, and a caller arriving
// after settle gets a FRESH one. The second half is the guard that matters — it is what stops
// this being quietly turned into a TTL cache, which would let `/campaigns` serve the
// pre-mutation list back to someone who just pressed Stop.
const assert = require('assert');
const { dedupeInFlight } = require('./dedupeInFlight.js');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n        ', e.message); }
}

const defer = () => { let r, j; const p = new Promise((res, rej) => { r = res; j = rej; }); return { p, resolve: r, reject: j }; };

(async () => {
  await t('concurrent callers share one underlying call', async () => {
    let calls = 0;
    const d = defer();
    const f = dedupeInFlight(() => { calls++; return d.p; });
    const a = f(), b = f(), c = f();
    assert.equal(calls, 1, 'expected exactly one underlying call');
    d.resolve('x');
    assert.deepEqual(await Promise.all([a, b, c]), ['x', 'x', 'x']);
  });

  // THE ANTI-CACHE GUARD. If someone adds a TTL, this fails.
  await t('a caller after settle gets a FRESH call, never a cached value', async () => {
    let calls = 0;
    const f = dedupeInFlight(() => { calls++; return Promise.resolve(calls); });
    assert.equal(await f(), 1);
    assert.equal(await f(), 2, 'second call must re-fetch, not replay the first result');
    assert.equal(await f(), 3);
    assert.equal(calls, 3);
  });

  await t('a rejection is shared by concurrent callers and clears the slot', async () => {
    let calls = 0;
    const d = defer();
    const f = dedupeInFlight(() => { calls++; return d.p; });
    const a = f(), b = f();
    d.reject(new Error('boom'));
    await assert.rejects(() => a, /boom/);
    await assert.rejects(() => b, /boom/);
    assert.equal(calls, 1);
    // Slot released: a failure must not wedge the helper permanently.
    const f2 = f();
    assert.equal(calls, 2, 'after a failure the next caller must be able to retry');
    await f2.catch(() => {});
  });

  await t('each caller keeps its OWN failure policy', async () => {
    // The layout swallows to keep the On-Air rail; the home page toasts. Both must work off
    // the same shared promise.
    const d = defer();
    const f = dedupeInFlight(() => d.p);
    const swallowed = f().catch(() => 'kept-last-known');
    let surfaced = null;
    const toasted = f().catch((e) => { surfaced = e.message; return 'toasted'; });
    d.reject(new Error('transient'));
    assert.equal(await swallowed, 'kept-last-known');
    assert.equal(await toasted, 'toasted');
    assert.equal(surfaced, 'transient');
  });

  await t('a synchronous throw rejects rather than wedging the slot', async () => {
    let calls = 0;
    const f = dedupeInFlight(() => { calls++; if (calls === 1) throw new Error('sync'); return Promise.resolve('ok'); });
    await assert.rejects(() => f(), /sync/);
    assert.equal(await f(), 'ok', 'helper must still work after a synchronous throw');
  });

  await t('arguments of the FIRST caller win while a call is in flight', async () => {
    // Documents real behaviour rather than asserting it is ideal: getCampaigns takes only the
    // session, and concurrent callers on one screen share it, so this is safe here. A future
    // consumer passing meaningfully different args needs keying, not this helper.
    const seen = [];
    const d = defer();
    const f = dedupeInFlight((x) => { seen.push(x); return d.p; });
    f('first'); f('second');
    assert.deepEqual(seen, ['first']);
    d.resolve(null);
  });

  console.log(`\ndedupeInFlight: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
