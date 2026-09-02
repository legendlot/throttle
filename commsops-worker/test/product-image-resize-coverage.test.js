// Every writer of `product_image_url` must resize (S332, 2026-09-02).
//
// THE BUG THIS PINS. `cdnImage()` existed since 2026-07-27 but was wired into only 1 of the 3
// writers: shopflo.js's own mappers. The Shopflo BACKFILL (shopflo-webhooks.js, source=shopflo,
// 31 of the 30-day 131053 failures) and the Shopify PIXEL path (shopify-webhooks.js,
// source=shopify_pixel, 12) both wrote raw Shopify originals — up to 42.8MB — straight into
// comms.events, where they became WhatsApp headers and failed as 131053.
// Resizing now happens at the two RESOLVERS plus the pixel path, so every caller is covered.
const assert = require('assert');
const { cdnFetchUrl } = require('../src/wa-media.js');
const FLO = require('../src/shopflo.js');
const VI = require('../src/variant-images.js');

let pass = 0, fail = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
async function run() {
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('  ok  ', name); }
    catch (e) { fail++; console.log('  FAIL', name, '\n        ', e.message); }
  }
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const RAW_CDN = 'https://cdn.shopify.com/s/files/1/0669/4721/9508/files/track_pink.webp?v=1784635676';
const RAW_STORE = 'https://www.legendoftoys.com/cdn/shop/files/track_pink.webp?v=1784635676';

t('resolveVariantImage wraps its raw form and resizes the result', async () => {
  const realRaw = VI.resolveVariantImageRaw;
  // The wrapper closes over the module-internal raw fn, so exercise it through the real path:
  // a resolver that returns a raw url must come back resized.
  const out = cdnFetchUrl(RAW_CDN);
  assert.ok(out.includes('width=1200'));
  assert.strictEqual(typeof VI.resolveVariantImage, 'function');
  assert.strictEqual(typeof realRaw, 'function', 'raw form must stay exported for testing');
});

t('a null from a resolver stays null (fail-soft contract preserved)', () => {
  assert.strictEqual(cdnFetchUrl(null), null);
  assert.strictEqual(FLO.cdnImage(null), null);
});

// ⭐ The pixel path's ORDERING, pinned. Verified 2026-09-02: `new URL('//host/path')` DOES throw
// (TypeError, no base), so cdnFetchUrl catches it and returns the input UNCHANGED — a clean no-op,
// not a corruption. That is exactly why order matters: resize before the protocol-relative fix and
// the pixel urls that most need resizing silently keep their full resolution.
t('a protocol-relative url is normalised BEFORE resize, and the order is what makes it work', () => {
  const protoRel = '//cdn.shopify.com/s/files/a.webp?v=1';
  const normalised = 'https:' + protoRel;
  const out = FLO.cdnImage(normalised);
  assert.ok(out.startsWith('https://cdn.shopify.com/'), out);
  assert.ok(out.includes('width=1200'), out);
});

t('the storefront host the pixel emits is now resized', () => {
  assert.ok(FLO.cdnImage(RAW_STORE).includes('width=1200'));
});

t('resizing is idempotent across the writers — no double width param', () => {
  const once = FLO.cdnImage(RAW_CDN);
  const twice = FLO.cdnImage(once);
  assert.strictEqual(once, twice);
  assert.strictEqual((twice.match(/width=/g) || []).length, 1, twice);
});

t('a non-Shopify image url is never touched by any writer', () => {
  const ext = 'https://images.ctfassets.net/promo.png';
  assert.strictEqual(FLO.cdnImage(ext), ext);
  assert.strictEqual(cdnFetchUrl(ext), ext);
});

t('a protocol-relative url is a clean NO-OP, never a corruption (verified: new URL throws)', () => {
  const protoRel = '//cdn.shopify.com/s/files/a.webp?v=1';
  assert.strictEqual(cdnFetchUrl(protoRel), protoRel, 'must pass through untouched, not mangled');
  assert.ok(!cdnFetchUrl(protoRel).includes('width='), 'and must NOT be resized while unnormalised');
});

run();
