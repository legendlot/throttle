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

export function splitMulti(v) {
  if (!v) return [];
  const parts = v.startsWith(MULTI_SEP)
    ? v.slice(MULTI_SEP.length).split(MULTI_SEP)
    : v.split(',');
  return parts.map(x => x.trim()).filter(Boolean);
}
