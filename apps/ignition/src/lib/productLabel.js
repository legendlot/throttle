/**
 * Product / variant display formatting (Reann, #bugs 2026-08-27:
 * "an issue with the formatting of how the product names are displayed").
 *
 * Two separate defects sat behind that report and only ONE of them is a display bug:
 *
 *  ① The engagements list rendered `product_variant || product_code`, so a deal on
 *    Crest / Ravenclaw showed as the bare word "ravenclaw" and Shadow / Asphalt Black
 *    showed as "ASPHALT BLACK" — the product name was not on screen at all. Fixed by
 *    rendering both (`productLabel`).
 *
 *  ② The values themselves are free text and wildly inconsistent: 44 distinct product
 *    strings collapsing to 22 once cased, and 75 variant strings to 43 (measured
 *    2026-08-27 over 377 `engagement_products` rows). CREST / Crest / crest are one
 *    product typed three ways.
 *    ⚠️ Those two numbers are the JUSTIFICATION, not the current state: the stored strings
 *    were cleaned later the same day (18 products / 32 variants after). Do not re-measure and
 *    conclude this file is pointless — **the field is still free text**, so the mess regrows,
 *    which is exactly why the normalisation lives at the display layer and not only in a
 *    one-off migration.
 *
 * `titleish()` fixes the CASING half of ② at the display layer so the screen reads as one
 * catalogue while the stored strings are cleaned separately.
 *
 * ⚠️ It re-cases a token ONLY when the whole string is uniformly upper or lower case.
 * Anything already mixed-case is passed through untouched, because mixed case is usually
 * deliberate and title-casing it does damage: "McCloud" would become "Mccloud". The
 * all-caps and all-lower forms are the ones that carry no information to lose.
 */

/** True when the string carries no case information worth preserving. */
function isUniformCase(s) {
  const letters = s.replace(/[^A-Za-z]/g, '');
  if (!letters) return false;
  return letters === letters.toUpperCase() || letters === letters.toLowerCase();
}

/**
 * Title-case a free-text product or variant, but only when it is safe to do so.
 * "ASPHALT BLACK" → "Asphalt Black" · "crest" → "Crest" · "McCloud" → "McCloud".
 */
export function titleish(raw) {
  const s = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  if (!isUniformCase(s)) return s;
  return s.replace(/[A-Za-z][A-Za-z']*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

/**
 * The one-line label for a deal's product: "Crest · Ravenclaw".
 * Falls back to whichever half exists; returns '' when neither does, so callers
 * can render their own em-dash placeholder.
 */
export function productLabel(productCode, productVariant) {
  const p = titleish(productCode);
  const v = titleish(productVariant);
  if (p && v) {
    // A variant that merely repeats the product ("Crest" / "Crest") reads as a stutter.
    if (p.toLowerCase() === v.toLowerCase()) return p;
    return `${p} · ${v}`;
  }
  return p || v;
}

/**
 * Grouping key for the product filter — case- and space-insensitive, so the 44 typed
 * spellings offer 22 choices instead of 44. Deliberately NOT used for storage.
 */
export function productKey(productCode) {
  return titleish(productCode).toLowerCase();
}
