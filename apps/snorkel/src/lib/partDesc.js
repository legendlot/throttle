// Shared PO line-description composer.
// Used by:
//   - pos/new/page.js                   (BOM explode + part-picker line fill)
//   - pos/[poNumber]/PODetailClient.js  (add-line on a raised PO)
//
// Why this exists (Siddhanth, #bugs 2026-07-29): most packaging part names in
// `store.material_master` are generic — "Ecomm Box", "Ecomm Tray" — and the product
// they belong to lives in the separate `product` column. The PO form copied only
// part_name into the line description, so both the form and the printed PDF told the
// vendor "Ecomm Box" with nothing saying whether it was Flare, Ghost or Shadow.
//
// Fixed at composition rather than by renaming the part rows, because:
//   - part_name is displayed in many other places where the product is already in view;
//   - the newest parts (Blitz, Zipp) ALREADY carry the product in part_name, so a
//     blanket rename would produce "Blitz Blitz Ecomm Box";
//   - cross-product parts (RULE-003) legitimately have no single product.
//
// A stored line description is never rewritten — an issued PO is a document.
//
// ⚠️ The product must be gated on the PART CODE, not on the product column of whatever
// row we happen to hold. Both PO-form sources (`getBOM`, `getProcurementParts`) read
// `bom_register`, where a cross-product part carries ONE ROW PER PRODUCT it is used
// under — `UNV-PP-ELASTIC-01` has 10 rows (Bumble, Dash, Flare…) and `HW-TM-CMB` 9.
// Trusting that column would print "Bumble Elastic Band" on a PO for a universal band.
// `material_master` is the table that marks these 'Universal' (RULE-003's asymmetric
// convention), but the PO form never loads it — so gate on the code prefix, which is
// the same convention and needs no worker change.

// RULE-003 cross-product code prefixes. Verified against material_master 2026-07-29:
// 159 parts are product='Universal' and exactly these prefixes cover all 159
// (158 UNV-/HW- plus LB-WD-PINE-3, the LOT Build raw sheet stock).
const CROSS_PRODUCT_PREFIX = /^(UNV-|HW-|LB-WD-)/i;

// Product values that are not a real product name.
const NON_PRODUCT = new Set(['', 'universal', 'common', 'n/a', 'na', '-']);

/**
 * Compose the description shown on a PO line for a part.
 * Platform parts (`D1-*`, product 'Drift 1') ARE qualified — the platform is the
 * meaningful owner for a vendor (RULE-PLATFORM-001).
 *
 * @param {string} partCode  the part code (gates the cross-product check)
 * @param {string} product   the owning product / platform
 * @param {string} partName  material_master.part_name
 * @returns {string} e.g. "Flare Ecomm Box"; falls back to partName alone.
 */
export function partDescription(partCode, product, partName) {
  const name = String(partName || '').trim();
  const prod = String(product || '').trim();
  if (!name) return prod;
  if (CROSS_PRODUCT_PREFIX.test(String(partCode || '').trim())) return name;
  if (!prod || NON_PRODUCT.has(prod.toLowerCase())) return name;
  // Already product-qualified (Blitz "Blitz Ecomm Box", Zipp "Zipp Ecomm Tray") —
  // don't double it up.
  if (name.toLowerCase().startsWith(prod.toLowerCase())) return name;
  return `${prod} ${name}`;
}
