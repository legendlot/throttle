// Phase-B redirect resolution: what a tapped code turns into.
// The load-bearing behaviour is that NOTHING a customer taps can produce an error page, and that
// a third-party target is never rewritten.
// Run: node test/link-resolve.test.js
const assert = require('node:assert');
const { targetFor, resolveLink, FALLBACK_URL } = require('../src/links.js');

// ── LOT targets get their stored utm ─────────────────────────────────────────
const lot = targetFor({
  target_url: 'https://www.legendoftoys.com/products/ghost',
  utm: { utm_source: 'relay', utm_medium: 'whatsapp', utm_campaign: 'browse_ab' },
});
assert.ok(lot.includes('utm_source=relay'), lot);
assert.ok(lot.includes('utm_medium=whatsapp'), lot);
assert.ok(lot.includes('utm_campaign=browse_ab'), lot);
assert.ok(lot.startsWith('https://www.legendoftoys.com/products/ghost?'), lot);

// A target that already carries utm_ is left alone (appendUtm is idempotent) — so re-minting or a
// hand-authored tagged link never ends up double-tagged.
const pre = 'https://legendoftoys.com/c/all?utm_source=email';
assert.equal(targetFor({ target_url: pre, utm: { utm_source: 'relay' } }), pre);

// ── third-party targets are returned PRISTINE ────────────────────────────────
// The four highest-volume cart-recovery templates point at checkout.shopflo.co. Rewriting a
// payment/checkout URL is how things break silently, and the params would reach no GA4 property
// of ours anyway. The click is still recorded — that is the win for these.
const flo = 'https://checkout.shopflo.co/stable/abc?tokenId=d16bc793&checkout_type=ABANDONED';
assert.equal(targetFor({ target_url: flo, utm: { utm_source: 'relay' } }), flo);
// Same for a carrier tracking page.
const dl = 'https://www.delhivery.com/track/package/1234567890';
assert.equal(targetFor({ target_url: dl, utm: { utm_source: 'relay' } }), dl);

// ── nothing produces an error page ───────────────────────────────────────────
assert.equal(targetFor(null), FALLBACK_URL);
assert.equal(targetFor({}), FALLBACK_URL);
assert.equal(targetFor({ target_url: '' }), FALLBACK_URL);
// A row with no utm still resolves to its target.
assert.equal(targetFor({ target_url: 'https://legendoftoys.com/x' }), 'https://legendoftoys.com/x');

// ── the code-format guard rejects before it ever reaches the DB ──────────────
// resolveLink must not build a PostgREST query out of arbitrary path input. These all return null
// without any env being touched — if one of them tried to fetch, this test would throw on the
// undefined env instead of returning null, which is exactly the regression worth catching.
(async () => {
  for (const bad of [null, '', '../../etc', 'abc def', 'x'.repeat(65), "a'or'1", 'a/b', '%2e%2e']) {
    assert.equal(await resolveLink(undefined, bad), null, `should reject: ${JSON.stringify(bad)}`);
  }
  console.log('link-resolve.test.js: all assertions passed');
})();
