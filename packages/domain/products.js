// FBU vs non-FBU classification.
// Legacy Garage carries FBU status as a shipment/PO flag (receive_format === 'fbu')
// and a DB column on products (is_fbu). There is no client-side pattern-based classifier.
// Accepts either a raw code string (looked up against the known list below)
// or a product record with an is_fbu flag.
const KNOWN_FBU_CODES = new Set([]);

export function isFbuProduct(productOrCode) {
  if (!productOrCode) return false;
  if (typeof productOrCode === 'object') {
    if (typeof productOrCode.is_fbu === 'boolean') return productOrCode.is_fbu;
    if (productOrCode.receive_format === 'fbu') return true;
    if (typeof productOrCode.code === 'string') return KNOWN_FBU_CODES.has(productOrCode.code.toUpperCase());
    return false;
  }
  return KNOWN_FBU_CODES.has(String(productOrCode).toUpperCase());
}
