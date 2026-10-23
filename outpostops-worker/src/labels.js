// What a supervisor scanned to find a unit's labels: a car or remote sticker (LOT-NNNNNNNN) or a batch label
// (LOT-NNNNNNNN-E|R|X, whose prefix is always the car). Only [A-Z0-9-] gets past this, so it is safe in a PostgREST filter.
export function unitLabelCode(raw) {
  const m = String(raw || '').trim().toUpperCase().match(/^(LOT-\d{8})(-[ERX])?$/);
  return m ? m[1] : null;
}
