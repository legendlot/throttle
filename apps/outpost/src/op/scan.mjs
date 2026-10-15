// What a scanned code is, before it goes anywhere. Scanners send exactly what is printed, so a wrong code is refused
// at the bench, never fixed up (no padding, no guessing).
export const UPC_RE = /^LOT-\d{8}$/;
export const BATCH_RE = /^LOT-\d{8}-[ERX]$/;
export const CTN_RE = /^CTN-\d{7}$/;
export const clean = s => String(s || '').trim().toUpperCase();

export function classify(v) {
  if (UPC_RE.test(v)) return 'upc';
  if (BATCH_RE.test(v)) return 'batch';
  if (CTN_RE.test(v)) return 'ctn';
  if (/^\d{13}$/.test(v)) return 'ean';
  return 'other';
}
