import test from 'node:test';
import assert from 'node:assert/strict';
import { shipKey, shipmentFor } from '../src/index.js';

// ── The two courier-display helpers are COPIED from
// `apps/ignition/src/app/(auth)/engagements/detail/page.js` — that file is JSX and node:test
// cannot import it, and both functions are pure. Change one, change the other (the page carries
// the same note). They are here because both shipped a wrong answer that LOOKED right:
// "D.T.D.C. · Ress", and a Delhivery URL for a Shiprocket parcel.
function courierText(raw) {
  const s = String(raw || '').trim();
  return s && s === s.toLowerCase() ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function courierLabel(courier, provider) {
  const norm = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const c = String(courier || '').trim();
  const p = String(provider || '').trim();
  if (!c) return courierText(p);
  const cn = norm(c), pn = norm(p);
  if (!pn || pn === cn) return courierText(c);
  if (pn.startsWith(cn)) {
    let seen = 0, i = 0;
    while (i < p.length && seen < cn.length) { if (/[A-Za-z0-9]/.test(p[i])) seen++; i++; }
    const extra = p.slice(i).replace(/^[^A-Za-z0-9]+/, '');
    return extra ? `${courierText(c)} · ${courierText(extra.toLowerCase())}` : courierText(c);
  }
  return `${courierText(c)} · ${courierText(p)}`;
}

function trackingUrlFor(shipment) {
  const link = String(shipment.tracking_link || '').trim();
  if (/^https?:\/\//i.test(link)) return link;
  const awb = String(shipment.tracking_number || '').trim();
  const carrier = String(shipment.courier || '').toLowerCase();
  if (!awb || !carrier.includes('delhivery')) return null;
  return `https://www.delhivery.com/track/package/${encodeURIComponent(awb)}`;
}

// ── shipKey ─────────────────────────────────────────────────────────────────────────────────
test('shipKey normalises punctuation and case, and yields "" for anything empty', () => {
  assert.equal(shipKey('#LOT-438 38'), 'LOT43838');
  assert.equal(shipKey('LOT43838'), 'LOT43838');
  assert.equal(shipKey(''), '');
  assert.equal(shipKey('   '), '');
  assert.equal(shipKey(null), '');
  assert.equal(shipKey(undefined), '');
});

test('shipKey accepts a NUMBER — PostgREST hands back unquoted numerics and String() must not blow up', () => {
  assert.equal(shipKey(43838), '43838');
});

// ── shipmentFor ─────────────────────────────────────────────────────────────────────────────
const tracked = (o = {}) => ({
  match_kind: 'exact', courier: 'delhivery', shipping_provider: 'DELHIVERY_SURFACE',
  tracking_number: '1234567890', tracking_link: null, lifecycle: 'delivered',
  dispatched_at: '2026-08-01T00:00:00Z', delivered_at: '2026-08-04T00:00:00Z', ...o,
});

test('a matched id is tracked, and an exact match is labelled exact', () => {
  const s = shipmentFor('#LOT43838', { LOT43838: tracked() });
  assert.equal(s.state, 'tracked');
  assert.equal(s.match, 'exact');
  assert.equal(s.lifecycle, 'delivered');
  assert.equal(s.courier, 'delhivery');
});

test('a PREFIX match is keyed under the caller\'s own key and is never silently exact', () => {
  // The RPC keys its result by `order_key` = the key WE sent, so "#LOT43838 Complete" comes back
  // under LOT43838COMPLETE even though the shipment it found is LOT43838.
  const s = shipmentFor('#LOT43838 Complete', { LOT43838COMPLETE: tracked({ match_kind: 'prefix' }) });
  assert.equal(s.state, 'tracked');
  assert.equal(s.match, 'prefix');
  assert.equal(s.delivered_at, '2026-08-04T00:00:00Z');
});

test('an unmatched id with a DIGIT is pending_sync, not an error', () => {
  assert.deepEqual(shipmentFor('LOT99999', {}), { state: 'pending_sync' });
});

test('a letters-only id is a courier NAME typed in the field — other_courier, nothing to track', () => {
  assert.deepEqual(shipmentFor('porter', {}), { state: 'other_courier' });
  assert.deepEqual(shipmentFor('DTDC', {}), { state: 'other_courier' });
});

test('no order id at all renders nothing', () => {
  assert.equal(shipmentFor(null, {}), null);
  assert.equal(shipmentFor(undefined, {}), null);
  assert.equal(shipmentFor('', {}), null);
  assert.equal(shipmentFor('   ', {}), null);
  assert.equal(shipmentFor('---', {}), null);   // punctuation-only normalises to ''
});

// ── courierLabel ────────────────────────────────────────────────────────────────────────────
test('courier and provider saying the same thing renders ONCE', () => {
  assert.equal(courierLabel('self', 'SELF'), 'Self');
  assert.equal(courierLabel('shiprocket', 'Shiprocket'), 'Shiprocket');
});

test('DELHIVERY_SURFACE keeps the service word', () => {
  assert.equal(courierLabel('delhivery', 'DELHIVERY_SURFACE'), 'Delhivery · Surface');
});

test('a punctuated courier does not eat the front of the provider (was "D.T.D.C. · Ress")', () => {
  assert.equal(courierLabel('D.T.D.C.', 'DTDC Express'), 'D.T.D.C. · Express');
});

test('an empty provider or a missing courier still reads as a name', () => {
  assert.equal(courierLabel('porter', ''), 'Porter');
  assert.equal(courierLabel('porter', null), 'Porter');
  assert.equal(courierLabel(null, 'E-Kart Logistics'), 'E-Kart Logistics');
  assert.equal(courierLabel('other', 'ATS'), 'Other · ATS');
});

// ── trackingUrlFor ──────────────────────────────────────────────────────────────────────────
test('a Delhivery parcel gets the public tracking URL', () => {
  assert.equal(
    trackingUrlFor({ courier: 'delhivery', shipping_provider: 'DELHIVERY_SURFACE', tracking_number: '1234567890' }),
    'https://www.delhivery.com/track/package/1234567890',
  );
});

test('a Shiprocket parcel with a Delhivery PROVIDER gets no URL — the courier decides', () => {
  assert.equal(
    trackingUrlFor({ courier: 'shiprocket', shipping_provider: 'Delhivery Surface', tracking_number: '1234567890' }),
    null,
  );
});

test('self-delivery and a missing AWB have nothing to link to', () => {
  assert.equal(trackingUrlFor({ courier: 'self', shipping_provider: 'SELF', tracking_number: 'ABC' }), null);
  assert.equal(trackingUrlFor({ courier: 'delhivery', tracking_number: null }), null);
  assert.equal(trackingUrlFor({ courier: 'delhivery', tracking_number: '   ' }), null);
});

test('a stored tracking_link is used only when it is http(s) — javascript: is refused', () => {
  assert.equal(
    trackingUrlFor({ tracking_link: 'https://shiprocket.co/tracking/ABC', courier: 'shiprocket', tracking_number: 'ABC' }),
    'https://shiprocket.co/tracking/ABC',
  );
  assert.equal(
    trackingUrlFor({ tracking_link: 'javascript:alert(1)', courier: 'delhivery', tracking_number: 'ABC' }),
    'https://www.delhivery.com/track/package/ABC',
  );
  assert.equal(trackingUrlFor({ tracking_link: 'javascript:alert(1)', courier: 'self', tracking_number: 'ABC' }), null);
});
