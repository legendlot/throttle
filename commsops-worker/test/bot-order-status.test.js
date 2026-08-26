// Unit tests for the verified order-status lookup. Run: node test/bot-order-status.test.js
const assert = require('assert');
const { lookupOrderStatus, statusTextFor, identityMatches } = require('../src/bot-order-status.js');

// identityMatches: last-10 phone digits, case-insensitive email
assert.equal(identityMatches({ phone: '9876543210' }, { phone: '+919876543210', email: null }), true);
assert.equal(identityMatches({ email: 'A@B.com' }, { phone: null, email: 'a@b.com' }), true);
assert.equal(identityMatches({ phone: '9876543210' }, { phone: '+919999999999', email: 'x@y.z' }), false);
assert.equal(identityMatches({}, { phone: '+919876543210' }), false);   // no identity NEVER matches

// statusTextFor: lifecycle -> human copy, tracking link appended when present
assert.match(statusTextFor({ lifecycle: 'out_for_delivery', courier: 'Delhivery', tracking_link: 'https://t.example/x' }),
  /out for delivery today.*Delhivery.*https:\/\/t\.example\/x/is);
assert.match(statusTextFor({ lifecycle: 'delivered', delivered_at: '2026-08-25T10:00:00Z' }), /delivered/i);
assert.match(statusTextFor({ lifecycle: 'pending' }), /being prepared|packed/i);
assert.match(statusTextFor(null), /being processed/i);   // order exists, no shipment row yet

(async () => {
  const deps = {
    fetchOrder: async () => ({ name: '#12345', phone: '+919876543210', email: 'a@b.com' }),
    fetchShipment: async () => ({ lifecycle: 'in_transit', courier: 'Delhivery', tracking_link: null }),
  };
  let r = await lookupOrderStatus({}, { orderNumber: '#12345', identity: { phone: '9876543210' } }, deps);
  assert.equal(r.ok, true); assert.match(r.statusText, /on its way/i);

  r = await lookupOrderStatus({}, { orderNumber: '#12345', identity: { phone: '1112223334' } }, deps);
  assert.deepEqual(r, { ok: false, reason: 'identity_mismatch' });

  r = await lookupOrderStatus({}, { orderNumber: '#404', identity: { phone: '9876543210' } },
    { ...deps, fetchOrder: async () => null });
  assert.deepEqual(r, { ok: false, reason: 'order_not_found' });

  r = await lookupOrderStatus({}, { orderNumber: '#12345', identity: {} }, deps);
  assert.deepEqual(r, { ok: false, reason: 'no_identity' });
  console.log('bot-order-status tests OK');
})();
