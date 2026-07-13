import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleDeliveryCheck } from '../src/handler.js';

const ENV = { ORIGIN_PINCODE: '110001' };
const NOW = new Date(Date.UTC(2026, 6, 15, 5, 30)); // 11:00 IST Wed 15th (before cut-off)
const base = {
  verify: async () => true,
  cacheGet: async () => null,
  cachePut: async () => {},
  now: NOW,
};
const req = (pin) => new Request(`https://shop/apps/delivery-check?pincode=${pin}&signature=x`);

test('date state when serviceable + Delhivery quotes', async () => {
  const res = await handleDeliveryCheck(req('560001'), ENV, {
    ...base,
    checkServiceability: async () => ({ serviceable: true, codAvailable: false, facilityCodes: ['BLR1'] }),
    delhiveryTransitDays: async () => 3,
  });
  const b = await res.json();
  assert.equal(b.state, 'date');
  assert.equal(b.transit_days, 3);
  assert.equal(b.edd, 'Sat, 18 Jul'); // dispatch Wed 15 + 3
});

test('fallback state when serviceable but Delhivery cannot quote', async () => {
  const res = await handleDeliveryCheck(req('560001'), ENV, {
    ...base,
    checkServiceability: async () => ({ serviceable: true, codAvailable: false, facilityCodes: ['BLR1'] }),
    delhiveryTransitDays: async () => null,
  });
  const b = await res.json();
  assert.equal(b.state, 'fallback');
  assert.equal(b.message, 'Delivery in 5–7 days');
});

test('unserviceable state when Uniware says no', async () => {
  const res = await handleDeliveryCheck(req('999999'), ENV, {
    ...base,
    checkServiceability: async () => ({ serviceable: false, codAvailable: false, facilityCodes: [] }),
    delhiveryTransitDays: async () => { throw new Error('should not be called'); },
  });
  const b = await res.json();
  assert.equal(b.state, 'unserviceable');
});

test('bad signature → 401', async () => {
  const res = await handleDeliveryCheck(req('560001'), ENV, { ...base, verify: async () => false });
  assert.equal(res.status, 401);
});

test('bad pincode → 400', async () => {
  const res = await handleDeliveryCheck(req('12'), ENV, {
    ...base, checkServiceability: async () => { throw new Error('nope'); },
  });
  assert.equal(res.status, 400);
});

test('a fresh cache row short-circuits the couriers', async () => {
  const res = await handleDeliveryCheck(req('560001'), ENV, {
    ...base,
    cacheGet: async () => ({ pincode: '560001', cod: false, serviceable: true, source: 'delhivery', transit_days: 2, fetched_at: NOW.toISOString() }),
    checkServiceability: async () => { throw new Error('should not be called'); },
    delhiveryTransitDays: async () => { throw new Error('should not be called'); },
  });
  const b = await res.json();
  assert.equal(b.state, 'date');
  assert.equal(b.edd, 'Fri, 17 Jul'); // dispatch Wed 15 + 2, recomputed from cached transit_days
});
