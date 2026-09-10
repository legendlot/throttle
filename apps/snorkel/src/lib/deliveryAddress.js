// The canonical statement of the `delivery_address_id` validation that guards purchase_orders.
// THREE doors write that column — postPO (create), amendPO (revisioned header edit) and
// changePODeliveryAddress (the no-revision address-only edit) — and on 2026-09-10 all three
// carried their own hand-rolled copy, which is how three defects shipped in one day: a guard
// placed AFTER the po_revisions insert, a whitespace/array payload that could silently CLEAR an
// address, and three unchecked `.ok` on the address read.
//
// No React import here on purpose, so these functions are importable from a plain node:test file
// in snorkelops-worker/test without pulling in Next (same arrangement as poExport.js/tds.js).
// snorkelops-worker holds an INLINE copy of both functions — the worker is a zero-import single
// file with no bundler and cannot import out of apps/. If the two diverge, THIS one is the spec,
// and snorkelops-worker/test/po-delivery-address.test.mjs is the test both sides must satisfy.
// (Nothing here imports a sibling, but if it ever does: relative `./x.js`, never the `@/lib`
// alias — that alias is webpack-only and node --test cannot resolve it.)
//
// ⚠️ ORDER IS PART OF THE CONTRACT, and it is the half these pure functions can only make
// EXPRESSIBLE, not enforce. Both functions return a DECISION; the caller must reach a terminal
// decision (`reject`/`noop`) and return from it BEFORE it writes anything — before the
// po_revisions snapshot, before the revision bump, before the header PATCH. A rejected amend
// that has already snapshotted leaves an orphan po_revisions row (po_revisions has no unique key,
// so it collides with the next successful amend and Revision History shows one revision twice).
// A test at this level cannot see that ordering; only a fetch-level harness can.

// The three doors are NOT the same door, and the differences below are deliberate — do not
// "harmonise" them without a decision:
//   'create' (postPO)  — blank-ish means "no delivery address", which is a normal PO. The value
//                        is TRIMMED before the blank test, so '   ', [] and [null] (all '' after
//                        String()+trim) create a PO with a null address rather than erroring.
//   'amend'  (amendPO) — a STRICT null or a STRICT '' means CLEAR; nothing else does. Clearing
//                        here is a DESTRUCTIVE overwrite of a stored address, so whitespace and
//                        array payloads must be refused, not obeyed. This is the only mode that
//                        rejects arrays/objects on TYPE.
//   'change' (changePODeliveryAddress) — the action exists only to SET an address, so
//                        undefined/null/'' is a missing required field, never a clear.
export function parseDeliveryAddressId(raw, mode) {
  if (mode === 'create') {
    // Trim-then-blank, on purpose: creating a PO with no address is legitimate.
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      return { action: 'skip', id: null };
    }
  } else if (mode === 'amend') {
    // Not sent at all = leave the stored address alone (the Amend modal is header-only and never
    // sends this field, so the normal amend path is unaffected).
    if (raw === undefined) return { action: 'skip', id: null };
    if (raw === null || raw === '') return { action: 'clear', id: null };
    // Only a string or a number can be an id. Arrays and objects are rejected on TYPE, because
    // String([2]) === '2' passes the regex below and would resolve to a real address the caller
    // never named.
    if (typeof raw !== 'string' && typeof raw !== 'number') {
      return { action: 'reject', error: 'delivery_address_id must be an id', status: 422 };
    }
  } else if (mode === 'change') {
    if (raw === undefined || raw === null || raw === '') {
      return { action: 'reject', error: 'delivery_address_id required', status: 400 };
    }
  }
  // parseInt COERCES — parseInt('2abc',10)===2, and 2.9 survives Number.isFinite — so the digits
  // are checked with a regex FIRST and the PARSED number is what the caller writes, never the
  // raw payload value (a raw '2' into an int8 column is a 22P02 at best).
  if (!/^\d+$/.test(String(raw).trim())) {
    return { action: 'reject', error: 'delivery_address_id must be an id', status: 422 };
  }
  const id = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(id)) {
    return { action: 'reject', error: 'delivery_address_id must be an id', status: 422 };
  }
  return { action: 'lookup', id };
}

// Second phase: the caller does the (async) company_addresses read, then hands the result back
// here. `lookupOk` is the transport result — a failed lookup is NOT a missing address, and
// blaming the transport failure on the id sends the caller off to fix a row that is fine.
// `currentId` is the PO's stored delivery_address_id ('create' has none, pass null).
export function decideDeliveryAddress({ mode, id, lookupOk, address, currentId = null }) {
  if (!lookupOk) return { action: 'reject', error: 'Address lookup failed', status: 502 };
  if (!address) return { action: 'reject', error: 'Delivery address not found', status: 404 };
  // The no-op exemption runs BEFORE the active check on purpose: re-submitting a PO's OWN
  // address changes nothing and must survive that address being deactivated later. A client that
  // echoes the PO header back on amend would otherwise lose its vendor, terms and date edits to a
  // 400 on a field it never touched. 'create' can have no current address, so it never applies.
  const isCurrent = currentId != null && Number(currentId) === id;
  if (isCurrent) {
    // changePODeliveryAddress answers the no-op to the CALLER (changed: false) and writes
    // nothing; amendPO carries on, because the rest of the amend still has work to do.
    if (mode === 'change') return { action: 'noop', id, address };
    return { action: 'accept', id, address };
  }
  // A PO must never point at a deactivated address — the print letterhead and the "where to
  // ship" answer both read this row straight out.
  if (!address.active) {
    return { action: 'reject', error: `${address.label} is deactivated — pick an active address`, status: 400 };
  }
  return { action: 'accept', id, address };
}
