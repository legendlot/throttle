// Merge calls that OVERLAP IN TIME into one underlying request. Nothing more.
//
// ⚠️ THIS IS NOT A CACHE, AND KEEPING IT THAT WAY IS THE WHOLE POINT.
// The moment the underlying promise settles the slot is released, so the next caller starts a
// fresh request and NO CALLER EVER RECEIVES A STALE RESULT. A time-based cache is the obvious
// shape for "stop fetching this twice" and it is the wrong one for this app: `/campaigns`
// reloads its list immediately after a mutation (start / stop / archive), so even a 5s
// freshness window risks handing the pre-mutation list back to the person who just acted —
// which reads as "the button did nothing". Deduping only concurrent calls saves the same
// request with no staleness surface and no invalidation hook for callers to forget to call.
//
// ⛔ If you are here to add a TTL: don't. Add memoisation at the CALL SITE that actually wants
// stale-tolerance, so the blast radius is that one surface rather than every consumer.
//
// Written CommonJS on purpose — same convention as journeyTrigger.js, so it is testable with a
// plain `node src/lib/dedupeInFlight.test.js` and still `import`-able from the Next app.

function dedupeInFlight(fn) {
  let inflight = null;
  return function deduped(...args) {
    if (inflight) return inflight;
    let p;
    try {
      p = Promise.resolve(fn(...args));
    } catch (e) {
      // A synchronous throw must not leave the slot wedged — without this, `inflight` would
      // never have been assigned but a caller relying on the wrapper would still see the
      // exception surface differently from the underlying fn. Normalise to a rejection.
      return Promise.reject(e);
    }
    inflight = p.finally(() => { inflight = null; });
    // ⚠️ Return the SAME promise every concurrent caller gets, and let each attach its own
    // catch. The shared thing is the request; the failure policy is deliberately not shared —
    // the Relay layout swallows a transient failure to keep the On-Air rail on screen mid-send
    // while the home page raises a toast, and both must keep working.
    return inflight;
  };
}

module.exports = { dedupeInFlight };
