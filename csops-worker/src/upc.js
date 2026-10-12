// LOT unit UPC normalisation. ESM to match the rest of csops src/*.js modules.
//
// Agents type or scan UPCs in whatever form the label carries ("SHAK00386646", "386646",
// "lot-00386646"); public.units keys them as `LOT-` + an 8-digit serial. Every write of a
// UPC column on cs_tickets MUST go through here — both columns carry an FK to units(upc),
// so a raw value fails the save outright. createTicket always normalised; updateTicket did
// not, so filling the UPC in later (the normal case for a ticket born from a conversation)
// broke with a raw FK error (S412, Pruthvi #bugs 1791447559.578369).

/** Trailing run of digits = the serial → `LOT-` + 8 digits. No digits → returned trimmed, unchanged. */
export function normalizeUpc(raw) {
  const s = String(raw || '').trim();
  if (!s) return s;
  const m = s.match(/(\d+)\s*$/);   // trailing run of digits = the serial
  if (!(m && m[1])) return s;
  let digits = m[1];
  // The label prints `<product code><serial>`, and a code ending in the letter O is read as a
  // zero: "SHTO00431807" typed as "SHT000431807" leaves a 9-digit run → LOT-000431807, which
  // matches nothing (S415, Pruthvi #bugs 1791800633). Every unit serial is exactly 8 digits, so
  // surplus LEADING ZEROS are dropped. Any other surplus (an EAN pasted by mistake) is left
  // as-is: "not found" is right there, and taking its last 8 digits would land on a stranger's unit.
  if (digits.length > 8 && /^0+$/.test(digits.slice(0, digits.length - 8))) digits = digits.slice(-8);
  return 'LOT-' + digits.padStart(8, '0');
}

/** cs_tickets columns that reference units(upc). */
export const TICKET_UPC_FIELDS = ['lot_unit_upc', 'replacement_unit_upc'];

/**
 * Normalise the UPC columns present in a cs_tickets patch. Blank → null (clearing the field;
 * '' would itself violate the FK). Keys absent from the patch stay absent. Returns a new object.
 */
export function normalizeTicketUpcs(patch) {
  const out = { ...patch };
  for (const k of TICKET_UPC_FIELDS) {
    if (!(k in out)) continue;
    out[k] = normalizeUpc(out[k]) || null;
  }
  return out;
}

/** PostgREST `in.(…)` filter with each value double-quoted, so `)`/`,`/`"` in junk input can't break the list. */
export function upcInFilter(upcs) {
  return 'in.(' + upcs.map((u) => encodeURIComponent('"' + String(u).replace(/["\\]/g, '\\$&') + '"')).join(',') + ')';
}

/**
 * Before PATCHing a (normalised) ticket patch: which UPC it sets that is not a real unit.
 * Only values that change from `current` are checked. `fetchUpcs(list)` resolves to the subset
 * that exists in units, or null when the lookup itself failed.
 * → { missing: string|null, failed: boolean }
 */
export async function findMissingUpc(patch, current, fetchUpcs) {
  const want = [...new Set(
    TICKET_UPC_FIELDS.filter((k) => patch[k] && patch[k] !== current?.[k]).map((k) => patch[k]),
  )];
  if (!want.length) return { missing: null, failed: false };
  const found = await fetchUpcs(want);
  if (found == null) return { missing: null, failed: true };
  const have = new Set(found);
  return { missing: want.find((u) => !have.has(u)) || null, failed: false };
}
