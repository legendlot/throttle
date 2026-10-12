// One row per sku for the Shopify price-cache upsert (refreshProductPrices).
//
// Two Shopify variants sharing a SKU in the same upsert batch make Postgres refuse the WHOLE
// batch ("ON CONFLICT DO UPDATE command cannot affect row a second time"). From 2026-10 that
// silently dropped every variant past row 200 — Bhoot among them (Nandu #bugs 1791791716).
//
// Ranking when a SKU repeats: a variant on an ACTIVE product beats a draft/archived one, then a
// priced variant beats a ₹0 one, then the first seen (Shopify returns variants in id order).
// The winner's handle + variant_id ride along, so tracking links point at the live product.
// `status` is a Shopify ProductStatus ('ACTIVE' | 'DRAFT' | 'ARCHIVED') or absent.

function rank(row) {
  return (row.status === 'ACTIVE' ? 2 : 0) + (row.price > 0 ? 1 : 0);
}

export function dedupeBySku(rows) {
  const bySku = new Map();
  const duplicates = new Set();
  for (const row of rows) {
    const prev = bySku.get(row.sku);
    if (!prev) { bySku.set(row.sku, row); continue; }
    duplicates.add(row.sku);
    if (rank(row) > rank(prev)) bySku.set(row.sku, row);
  }
  return { rows: [...bySku.values()], duplicates: [...duplicates] };
}
