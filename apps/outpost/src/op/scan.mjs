// What a scanned code is, before it goes anywhere. Scanners send exactly what is printed, so a wrong code is refused
// at the bench, never fixed up (no padding, no guessing).
export const UPC_RE = /^LOT-\d{8}$/;
export const BATCH_RE = /^LOT-\d{8}-[ERX]$/;
export const CTN_RE = /^CTN-\d{7}$/;
// The text printed under a sticker's QR: its product code + the same 8 digits (SHAK00517082 = LOT-00517082). Typed by
// hand when the QR is out of a scanner's reach (Joseph, #bugs 1792913884.132369). Only the reprint lookup takes it, and
// the server checks the prefix against the sticker's own batch, so a wrong prefix finds nothing.
export const STICKER_TEXT_RE = /^[A-Z]{4,5}\d{8}$/;
export const clean = s => String(s || '').trim().toUpperCase();

export function classify(v) {
  if (UPC_RE.test(v)) return 'upc';
  if (BATCH_RE.test(v)) return 'batch';
  if (CTN_RE.test(v)) return 'ctn';
  if (/^\d{13}$/.test(v)) return 'ean';
  return 'other';
}

// A scanner set up without an Enter suffix (Joseph's table scanner at Satish, S431) types the code and stops. A field
// that ENDS in a whole code with no key for AUTO_ENTER_MS counts as scanned, and only that code is taken: a stray key
// left in the box ahead of it can't jam every later scan. A scanner's keys come a few ms apart, so a sticker
// (LOT-NNNNNNNN) is not taken before a batch label's "-E" lands (not measured on that scanner; if one ever is, the
// server still refuses a packed unit's sticker). A person typing by hand gets the code taken once it is whole.
export const AUTO_ENTER_MS = 200;
const WHOLE_AT_END = /(LOT-\d{8}-[ERX]|LOT-\d{8}|CTN-\d{7}|\d{13})$/;
export const wholeCodeAtEnd = v => clean(v).match(WHOLE_AT_END)?.[1] ?? null;
