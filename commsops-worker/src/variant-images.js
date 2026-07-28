// Shared per-VARIANT image resolution for WhatsApp IMAGE headers.
//
// Lifted out of shopflo-webhooks.js (2026-07-28) when the Order Placed template needed the
// same per-order product image the add_to_cart journey already shows. Two copies of a
// cache-then-refetch resolver would drift — and the drift would be invisible, because both
// fail soft to null and the template's static creative covers for them.
//
// Cache-first on comms.variant_images (variant_id → title, image_url); a miss re-pulls the
// PUBLIC storefront catalog and upserts EVERY variant, so one miss self-heals the whole cache
// (a newly launched colourway is the common case). Returns null on any failure — the
// template's static creative is the render-time fallback, and a missing image must NEVER fail
// the webhook that carries the order.
const A = require('./auth.js');
const { pickVariantImage, variantImageIndex } = require('./shopflo.js');

const STOREFRONT_CATALOG_URL = 'https://www.legendoftoys.com/products.json?limit=250';

// Shopify serves the public catalog fine to a browser, but a Worker fetch carries no
// User-Agent and egresses from a datacenter IP — a combination storefronts commonly challenge
// or 403. Send an explicit UA, and LOG the status on failure: returning null silently on
// `!res.ok` makes a blocked fetch indistinguishable from "no image for that variant".
async function fetchCatalog() {
  const res = await fetch(STOREFRONT_CATALOG_URL, {
    headers: { 'User-Agent': 'commsops-relay/1.0 (+https://legendoftoys.com)', Accept: 'application/json' },
  });
  if (!res.ok) { console.log('catalog_fetch_failed', res.status); return null; }
  try { return await res.json(); }
  catch (e) { console.log('catalog_parse_failed', e?.message || String(e)); return null; }
}

async function resolveVariantImage(env, variantIdsCsv, primaryName) {
  const ids = String(variantIdsCsv || '').split(',')
    .map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
  if (!ids.length) return null;
  try {
    const q = ids.map((i) => `"${i}"`).join(',');
    const r = await A.sbComms(
      `/rest/v1/variant_images?variant_id=in.(${A.enc(q)})&select=variant_id,title,image_url`, env);
    if (r.ok && r.data?.length) {
      const cached = {};
      for (const row of r.data) cached[row.variant_id] = { title: row.title, image_url: row.image_url };
      const hit = pickVariantImage(variantIdsCsv, primaryName, cached);
      if (hit) return hit;
    }
    const cat = await fetchCatalog();
    if (!cat) return null;
    const index = variantImageIndex(cat);
    const rows = Object.entries(index).map(([variant_id, v]) => ({
      variant_id, title: v.title, image_url: v.image_url, updated_at: new Date().toISOString(),
    }));
    if (rows.length) {
      await A.sbComms('/rest/v1/variant_images?on_conflict=variant_id', env, {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(rows),
      });
    }
    return pickVariantImage(variantIdsCsv, primaryName, index);
  } catch (e) {
    console.log('variant_image_resolve_error', e?.message || String(e));
    return null;
  }
}

module.exports = { fetchCatalog, resolveVariantImage, STOREFRONT_CATALOG_URL };
