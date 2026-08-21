// Shared helpers for the ticket product cascade (Category → Product → Model → Colour).
//
// Two near-identical cascades exist — `ProductCascade` on /new and `DetailProductCascade`
// on /queue/detail — and they have drifted apart before. The category logic lives here once
// so the next change lands on both.
//
// ⚠️ Category is a FILTER, never a stored field. `cs_tickets` has no category column and
// should not gain one: the category is derivable from the product at any time, so storing it
// would create a second copy that can disagree with `product_master` after a re-classification
// (RULE-TAXONOMY-001 has already moved products between categories once — Bracey, S260).

/**
 * The category list, derived from the catalogue rather than hardcoded.
 *
 * ⚠️ Do NOT hardcode a two-option `L.O.T Cars` / `L.O.T Build` dropdown. There are THREE live
 * values — `L.O.T DIY` (Bracey) was added 2026-08-04 per RULE-TAXONOMY-001 — and a fourth is
 * an Afshaan naming decision away. Deriving means a new category appears the moment a product
 * carries it; hardcoding means it is invisible and its products are unreachable through the
 * filter, which is the exact bug this filter was asked for in order to fix.
 */
export function catalogCategories(catalog) {
  return [...new Set((catalog || []).map(c => c.category).filter(Boolean))].sort();
}

/** Rows in one category; an empty/absent category means "All" and filters nothing. */
export function filterByCategory(catalog, category) {
  if (!category) return catalog || [];
  return (catalog || []).filter(c => c.category === category);
}

/** The category a already-chosen product belongs to, so the dropdown reflects reality. */
export function categoryOfProduct(catalog, product) {
  if (!product) return '';
  return (catalog || []).find(c => c.product === product)?.category || '';
}
