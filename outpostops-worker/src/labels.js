// What a supervisor scanned to find a unit's labels: a car or remote sticker (LOT-NNNNNNNN) or a batch label
// (LOT-NNNNNNNN-E|R|X, whose prefix is always the car). Only [A-Z0-9-] gets past this, so it is safe in a PostgREST filter.
export function unitLabelCode(raw) {
  const m = String(raw || '').trim().toUpperCase().match(/^(LOT-\d{8})(-[ERX])?$/);
  return m ? m[1] : null;
}

// The text printed under a sticker's QR, typed when the QR is out of reach: product code + the sticker's 8 digits
// (SHAK00517082 → LOT-00517082). The caller must check productCode against the sticker's upc_pool row — the digits
// alone would let a mistyped prefix land on a real unit. Letters and digits only, so both parts are filter-safe.
export function printedStickerCode(raw) {
  const m = String(raw || '').trim().toUpperCase().match(/^([A-Z]{4,5})(\d{8})$/);
  return m ? { upc: `LOT-${m[2]}`, productCode: m[1] } : null;
}

// The upc_pool read that proves a typed sticker text is real: this vendor's sticker, with those digits AND that prefix.
export function stickerPoolPath(printed, vendorId) {
  return `/rest/v1/upc_pool?upc_id=eq.${printed.upc}&product_code=eq.${printed.productCode}` +
    `&vendor_id=eq.${Number(vendorId)}&select=upc_id&limit=1`;
}
