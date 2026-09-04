// Multi-select filter transport (S347, 2026-09-04).
//
// Multi-select filter values used to be COMMA-joined on the wire, so any dimension value
// CONTAINING a comma (a product named "Shadow, Red") split into two fragments, matched
// nothing, and rendered an EMPTY report — which reads like a quiet month, not an error.
// Found by the S344 hostile review. Zero such values exist today (0 of 14,195 tickets,
// measured 2026-09-04), so this closes a legal-tomorrow input rather than a live bug.
//
// Encoding: the client joins on U+001F (UNIT SEPARATOR) and PREFIXES the string with one
// (joinMulti in apps/pitstop/src/lib/csopsFetch.js). The leading marker is what makes the
// rollout safe — it distinguishes the encodings, so a page cached before this shipped still
// sends the comma form and still works, while a single value containing a comma survives.
export const MULTI_SEP = '\u001f';

// ⚠️ Hardened S347b after the hostile review. `v` is whatever the query string held, so it is not
// necessarily a string; a non-string used to throw `v.startsWith is not a function` out of a report
// handler. Coerce rather than trust.
export function splitMulti(v) {
  if (v === null || v === undefined) return [];
  const str = String(v);
  if (!str) return [];
  const parts = str.startsWith(MULTI_SEP)
    ? str.slice(MULTI_SEP.length).split(MULTI_SEP)
    : str.split(',');
  return parts.map(x => x.trim()).filter(Boolean);
}
