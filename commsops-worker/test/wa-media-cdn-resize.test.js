// Shopify CDN resize on the WhatsApp media-header upload path (S332, 2026-09-02).
//
// WHY THIS EXISTS. Browse/cart abandonment templates take their header from the event's
// `product_image_url` — the raw Shopify variant asset. Measured live over 30 days: 46 of 47
// attributable `wa_131053` failures were assets over MAX_BYTES (7.2MB / 10.6MB / 14.2MB /
// 26.5MB / 26.6MB / 42.8MB), all HTTP 200 with a supported mime. uploadMedia refused them as
// `too_large`, the send fell back to `image:{link}`, and Meta ran the same oversized fetch itself
// and failed it asynchronously as 131053. Deterministic per variant, not the ~0.4% noise it was
// filed as. `width=1200` brought every one of those 12 assets under 2.3MB.
const assert = require('assert');
const WAM = require('../src/wa-media.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n        ', e.message); }
};

const CDN = 'https://cdn.shopify.com/s/files/1/0669/4721/9508/files/track_pink.webp?v=1784635676';
const STORE = 'https://www.legendoftoys.com/cdn/shop/files/track_pink.webp?v=1784635676';

t('HEADER_WIDTH is above WhatsApp\'s 1125px recommended header width', () => {
  assert.ok(WAM.HEADER_WIDTH >= 1125, `got ${WAM.HEADER_WIDTH}`);
});

// ⭐ THE REGRESSION TEST. Both hosts must match: the SAME asset measured 26.6MB via cdn.shopify.com
// and 42.8MB via the storefront path, and both shapes appear in live events.
t('cdn.shopify.com gets width appended', () => {
  const u = new URL(WAM.cdnFetchUrl(CDN));
  assert.strictEqual(u.searchParams.get('width'), String(WAM.HEADER_WIDTH));
  assert.strictEqual(u.searchParams.get('v'), '1784635676', 'existing query params must survive');
});

t('the storefront /cdn/shop/ host gets width appended too', () => {
  const u = new URL(WAM.cdnFetchUrl(STORE));
  assert.strictEqual(u.searchParams.get('width'), String(WAM.HEADER_WIDTH));
});

t('a non-Shopify host is left EXACTLY as given', () => {
  const other = 'https://images.example.com/promo/banner.png?v=9';
  assert.strictEqual(WAM.cdnFetchUrl(other), other);
});

t('a Supabase-hosted library asset is untouched', () => {
  const sb = 'https://jkxcnjabmrkteanzoofj.supabase.co/storage/v1/object/public/relay-email-assets/x.png';
  assert.strictEqual(WAM.cdnFetchUrl(sb), sb);
});

t('an explicit width the caller chose is NOT clobbered', () => {
  const chosen = CDN + '&width=640';
  assert.strictEqual(WAM.cdnFetchUrl(chosen), chosen);
});

t('an explicit height is respected too (aspect-driven sizing)', () => {
  const chosen = CDN + '&height=400';
  assert.strictEqual(WAM.cdnFetchUrl(chosen), chosen);
});

t('an unparseable url falls through unchanged rather than throwing', () => {
  assert.strictEqual(WAM.cdnFetchUrl('not a url'), 'not a url');
  assert.strictEqual(WAM.cdnFetchUrl(''), '');
});

t('is idempotent — rewriting an already-rewritten url changes nothing', () => {
  const once = WAM.cdnFetchUrl(CDN);
  assert.strictEqual(WAM.cdnFetchUrl(once), once);
});

// The cache key must stay the ORIGINAL url: same logical asset, so a resized fetch must not
// fragment wa_media_cache or change what applyMediaIds matches the rendered component on.
t('the rewrite is fetch-only — it does not become the cache key', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => {
    calls.push(String(u));
    if (String(u).includes('graph.facebook.com')) {
      return { ok: true, json: async () => ({ id: 'MEDIA1' }) };
    }
    return {
      ok: true,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => new ArrayBuffer(1024),
    };
  };
  const stored = [];
  const A = require('../src/auth.js');
  const realSb = A.sbComms;
  A.sbComms = async (path, _env, opts) => {
    if (opts?.method === 'POST' && path.includes('wa_media_cache')) {
      stored.push(JSON.parse(opts.body));
      return { ok: true, data: [] };
    }
    return { ok: true, data: [] };   // cache lookup miss
  };
  try {
    const id = await WAM.resolveMediaId({ WA_TOKEN: 'T' }, CDN, 'PN1');
    assert.strictEqual(id, 'MEDIA1');
    assert.ok(calls.some((c) => c.includes('width=1200')), 'the asset fetch must use the resized url');
    assert.strictEqual(stored.length, 1, 'expected exactly one cache write');
    assert.strictEqual(stored[0].asset_url, CDN, 'cache key must be the ORIGINAL url, not the resized one');
  } finally { globalThis.fetch = realFetch; A.sbComms = realSb; }
});

setTimeout(() => {
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, 100);
