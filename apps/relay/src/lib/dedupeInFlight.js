// Merge calls that OVERLAP IN TIME into one underlying request. Nothing more.
//
// ⛔ THE SLOT LIVES ON `globalThis`, NOT IN A MODULE CLOSURE, AND THAT IS THE ENTIRE REASON
// THIS FILE WORKS. A module-level `let inflight` is the obvious implementation and it is
// SILENTLY BROKEN in this app. Measured on the deployed build 2026-09-01 (S327): Next's app
// router bundles `(auth)/layout.js` and `(auth)/page.js` as separate chunk groups, and a small
// module imported by both is INLINED INTO EACH rather than hoisted into a shared chunk —
// verified by fetching the deployed chunks and finding the dedupe's own fingerprint once in
// `layout-*.js` and again in `page-*.js`. Two module instances means two independent closures,
// so each caller deduped against itself and the duplicate request still fired: 2 calls, 1ms
// apart, exactly as before the "fix".
// ⚠️ The first version of this shipped that way and the browser smoke is what caught it — the
// unit tests passed, because in `node` there is only ever one module instance. A test that
// requires the module twice now covers it (see dedupeInFlight.test.js).
//
// ⚠️ THIS IS NOT A CACHE, AND KEEPING IT THAT WAY IS THE WHOLE POINT.
// The moment the underlying promise settles the slot is released, so the next caller starts a
// fresh request and NO CALLER EVER RECEIVES A STALE RESULT. A time-based cache is the obvious
// shape for "stop fetching this twice" and is the wrong one here: `/campaigns` reloads its list
// immediately after a mutation (start / stop / archive), so even a 5s freshness window risks
// handing the pre-mutation list back to the person who just acted — which reads as "the button
// did nothing". Deduping only concurrent calls saves the same request with no staleness surface
// and no invalidation hook for callers to forget to call.
// ⛔ If you are here to add a TTL: don't. Memoise at the CALL SITE that wants stale-tolerance,
// so the blast radius is that one surface rather than every consumer.
//
// ⚠️ BROWSER-ONLY BY DESIGN. Relay is a static export (gh-pages), so `globalThis` is per browser
// tab and a shared slot can only ever be shared between one person's own components. Do NOT
// lift this helper into a long-lived SSR server without keying the slot per request — there,
// one global map would leak one user's in-flight response to another.
//
// CommonJS on purpose — same convention as journeyTrigger.js, so it is testable with a plain
// `node src/lib/dedupeInFlight.test.js` and still `import`-able from the Next app.

// One map for the whole tab, shared across every duplicated copy of this module.
const SLOTS = (globalThis.__relayInFlight ||= new Map());

function dedupeInFlight(key, fn) {
  if (!key || typeof key !== 'string') throw new TypeError('dedupeInFlight: a string key is required');
  return function deduped(...args) {
    const existing = SLOTS.get(key);
    if (existing) return existing;
    let p;
    try {
      p = Promise.resolve(fn(...args));
    } catch (e) {
      // A synchronous throw must not wedge the slot — nothing was stored, so just normalise
      // to a rejection and let the next caller try again.
      return Promise.reject(e);
    }
    // ⚠️ Identity-check before deleting. Without it, a slow first request settling AFTER a
    // newer one has claimed the slot would delete the newer entry, and the callers waiting on
    // it would be orphaned from the dedupe (harmless but it silently stops working).
    const shared = p.finally(() => { if (SLOTS.get(key) === shared) SLOTS.delete(key); });
    SLOTS.set(key, shared);
    // Every concurrent caller gets the SAME promise and attaches its own catch. The shared
    // thing is the request; the failure policy deliberately is not — the Relay layout swallows
    // a transient failure to hold the On-Air rail mid-send while the home page raises a toast,
    // and both must keep working.
    return shared;
  };
}

// Test-only: drop every slot. Never call this from app code — clearing a live slot does not
// cancel the request, it only stops later callers joining it.
function __resetInFlight() { SLOTS.clear(); }

module.exports = { dedupeInFlight, __resetInFlight };
