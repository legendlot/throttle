// The `delivery_address_id` validation that guards purchase_orders is lifted into
// apps/snorkel/src/lib/deliveryAddress.js precisely so it can be tested here, outside React/Next.
// snorkelops-worker holds an INLINE copy of the same two functions (zero-import single file, no
// bundler, cannot import out of apps/) — these tests are the spec both sides must satisfy.
// Run: node --test snorkelops-worker/test/*.test.mjs
//
// THREE doors write that column and each is exercised below by its mode:
//   postPO                    → 'create'
//   amendPO                   → 'amend'
//   changePODeliveryAddress   → 'change'
//
// ⚠️ Synthetic addresses on purpose. store.company_addresses holds exactly 2 rows today and both
// are `active`, so an INACTIVE address and the no-op-on-a-deactivated-address exemption have ZERO
// reachable instances in live data — a data-driven test would have been blind to both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeliveryAddressId, decideDeliveryAddress } from '../../apps/snorkel/src/lib/deliveryAddress.js';

const ACTIVE   = { id: 2, label: 'Bommasandra Unit', active: true };
const INACTIVE = { id: 9, label: 'Old Peenya Godown', active: false };

// The whole trip one door makes: parse the payload, do the (here, faked) address read, decide.
// `addresses` is the fake company_addresses table; `lookupOk` fakes the transport result.
function runDoor(mode, raw, { addresses = [ACTIVE, INACTIVE], lookupOk = true, currentId = null } = {}) {
  const parsed = parseDeliveryAddressId(raw, mode);
  if (parsed.action !== 'lookup') return parsed;
  const address = addresses.find(a => a.id === parsed.id) || null;
  return decideDeliveryAddress({ mode, id: parsed.id, lookupOk, address, currentId });
}

// ── postPO ('create') ────────────────────────────────────────────────────────────────────────
test("postPO: a valid active id is accepted, and it is the PARSED number that gets written", () => {
  const r = runDoor('create', '2');
  assert.equal(r.action, 'accept');
  assert.equal(r.id, 2);
  assert.equal(typeof r.id, 'number');
});

test('postPO: an unknown id is 404, not a silently-null address', () => {
  const r = runDoor('create', '4242');
  assert.equal(r.action, 'reject');
  assert.equal(r.status, 404);
  assert.equal(r.error, 'Delivery address not found');
});

test('postPO: an INACTIVE id is refused by label — no PO may be created pointing at one', () => {
  const r = runDoor('create', '9');
  assert.equal(r.action, 'reject');
  assert.equal(r.status, 400);
  assert.match(r.error, /Old Peenya Godown is deactivated/);
});

test("postPO: '' is a PO with no delivery address, not an error and not '' into an int8 column", () => {
  for (const blank of ['', '   ', [], [null]]) {
    const r = runDoor('create', blank);
    assert.equal(r.action, 'skip', `blank payload ${JSON.stringify(blank)}`);
    assert.equal(r.id, null);
  }
});

test('postPO: null and absent are both a legitimate no-address create', () => {
  assert.equal(runDoor('create', null).action, 'skip');
  assert.equal(runDoor('create', undefined).action, 'skip');
});

test('postPO: an ARRAY of one digit resolves like the digit — the documented drift from amendPO', () => {
  // NOT a normalisation target without a decision: postPO stringifies+trims before every test,
  // so [2] behaves as '2' here while amendPO refuses it on TYPE. Recorded, not fixed.
  const r = runDoor('create', [2]);
  assert.equal(r.action, 'accept');
  assert.equal(r.id, 2);
  // A multi-element array is still refused — String([2,3]) === '2,3' fails the digits regex.
  const multi = runDoor('create', [2, 3]);
  assert.equal(multi.action, 'reject');
  assert.equal(multi.status, 422);
});

test('postPO: a coercible non-id ("2abc", 2.9, an object) is refused, never parseInt-ed into 2', () => {
  for (const bad of ['2abc', 2.9, '2.9', {}, { id: 2 }, '-2']) {
    const r = runDoor('create', bad);
    assert.equal(r.action, 'reject', `payload ${JSON.stringify(bad)}`);
    assert.equal(r.status, 422);
  }
});

// ── amendPO ('amend') ────────────────────────────────────────────────────────────────────────
test('amendPO: a valid active id is accepted as a parsed number', () => {
  const r = runDoor('amend', 2, { currentId: null });
  assert.equal(r.action, 'accept');
  assert.equal(r.id, 2);
});

test('amendPO: an unknown id is 404', () => {
  const r = runDoor('amend', '4242');
  assert.equal(r.action, 'reject');
  assert.equal(r.status, 404);
});

test('amendPO: an INACTIVE id is refused when it is NOT the PO\'s own address', () => {
  const r = runDoor('amend', '9', { currentId: 2 });
  assert.equal(r.action, 'reject');
  assert.equal(r.status, 400);
  assert.match(r.error, /deactivated/);
});

test('amendPO: the no-op exemption — re-sending the PO\'s OWN address survives it being deactivated', () => {
  // The case with ZERO reachable instances in live data, and the reason this is a synthetic test:
  // a client that echoes the PO header back must not lose its vendor/terms/date edits to a 400 on
  // a field it never changed. amendPO ACCEPTS (unlike changePODeliveryAddress, which no-ops out).
  const r = runDoor('amend', '9', { currentId: 9 });
  assert.equal(r.action, 'accept');
  assert.equal(r.id, 9);
});

test("amendPO: a strict '' and a strict null CLEAR the address; absent leaves it alone", () => {
  for (const clear of ['', null]) {
    const p = parseDeliveryAddressId(clear, 'amend');
    assert.equal(p.action, 'clear');
    assert.equal(p.id, null);
  }
  assert.equal(parseDeliveryAddressId(undefined, 'amend').action, 'skip');
});

test('amendPO: whitespace and [null] must NOT clear a stored address — they are refused', () => {
  // Clearing here is a DESTRUCTIVE overwrite; no caller means "wipe the delivery address" by
  // sending '   '. This is the door where the 2026-09-10 silent-clear defect lived.
  for (const sneaky of ['   ', [null], []]) {
    const r = runDoor('amend', sneaky, { currentId: 2 });
    assert.equal(r.action, 'reject', `payload ${JSON.stringify(sneaky)}`);
    assert.equal(r.status, 422);
  }
});

test('amendPO: an ARRAY payload is refused on TYPE, even one that would resolve', () => {
  const r = runDoor('amend', [2], { currentId: null });
  assert.equal(r.action, 'reject');
  assert.equal(r.status, 422);
  assert.equal(r.error, 'delivery_address_id must be an id');
});

// ── changePODeliveryAddress ('change') ───────────────────────────────────────────────────────
test('changePODeliveryAddress: a valid active id is accepted', () => {
  const r = runDoor('change', '2', { currentId: null });
  assert.equal(r.action, 'accept');
  assert.equal(r.id, 2);
});

test('changePODeliveryAddress: an unknown id is 404', () => {
  const r = runDoor('change', '4242');
  assert.equal(r.action, 'reject');
  assert.equal(r.status, 404);
});

test('changePODeliveryAddress: an INACTIVE id is refused by label', () => {
  const r = runDoor('change', '9', { currentId: 2 });
  assert.equal(r.action, 'reject');
  assert.equal(r.status, 400);
  assert.match(r.error, /Old Peenya Godown is deactivated/);
});

test("changePODeliveryAddress: '' and null are a MISSING required field, never a clear", () => {
  for (const blank of ['', null, undefined]) {
    const r = runDoor('change', blank);
    assert.equal(r.action, 'reject', `payload ${JSON.stringify(blank)}`);
    assert.equal(r.status, 400);
    assert.equal(r.error, 'delivery_address_id required');
  }
  // '   ' is not blank-by-identity here, so it falls through to the id check and 422s.
  assert.equal(runDoor('change', '   ').status, 422);
});

test('changePODeliveryAddress: an ARRAY of one digit resolves like the digit — same drift as postPO', () => {
  const r = runDoor('change', [2], { currentId: null });
  assert.equal(r.action, 'accept');
  assert.equal(r.id, 2);
});

test("changePODeliveryAddress: re-sending the PO's own address is a NO-OP, not a write", () => {
  // Distinct from amendPO's exemption: this door answers the caller `changed: false` and writes
  // nothing at all, and it must do so even once that address is deactivated.
  const r = runDoor('change', '9', { currentId: 9 });
  assert.equal(r.action, 'noop');
  assert.equal(r.address.label, 'Old Peenya Godown');
});

// ── the address read itself ──────────────────────────────────────────────────────────────────
test('every door: a FAILED address lookup is 502, never "not found" (the unchecked .ok defect)', () => {
  for (const mode of ['create', 'amend', 'change']) {
    const r = runDoor(mode, '2', { lookupOk: false });
    assert.equal(r.action, 'reject', mode);
    assert.equal(r.status, 502, mode);
    assert.equal(r.error, 'Address lookup failed');
  }
});

// ── ordering: no po_revisions row on a rejected amend ────────────────────────────────────────
// ⚠️ SCOPE HONESTY: this tests the CONTRACT (a terminal decision must be reached before any
// write), not the worker's handler. The real defect was a guard placed AFTER the po_revisions
// insert inside snorkelops-worker/src/index.js, and only a fetch-level harness — which does not
// exist in this repo — can catch that there. What this pins is that the decision is available
// before a caller needs to write, so correct ordering is at least EXPRESSIBLE.
function amendCaller(raw, { currentId = null, addresses = [ACTIVE, INACTIVE] } = {}) {
  const revisions = [];
  const decision = runDoor('amend', raw, { currentId, addresses });
  if (decision.action === 'reject') return { revisions, error: decision.error, status: decision.status };
  revisions.push({ snapshot: 'header+lines' });   // the po_revisions insert — AFTER the decision
  return { revisions, error: null, applied: decision.action === 'clear' ? null : decision.id };
}

test('amendPO: a REJECTED amend writes no po_revisions row; an accepted one writes exactly one', () => {
  for (const bad of ['9999', '   ', [2], '2abc']) {
    const out = amendCaller(bad, { currentId: 2 });
    assert.equal(out.revisions.length, 0, `payload ${JSON.stringify(bad)} left an orphan revision`);
    assert.ok(out.error);
  }
  const inactive = amendCaller('9', { currentId: 2 });
  assert.equal(inactive.revisions.length, 0);

  const good = amendCaller('2', { currentId: null });
  assert.equal(good.revisions.length, 1);
  assert.equal(good.applied, 2);

  const cleared = amendCaller(null, { currentId: 2 });
  assert.equal(cleared.revisions.length, 1);
  assert.equal(cleared.applied, null);
});
