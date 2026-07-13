import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkServiceability } from '../src/uniware.js';

const ENV = { UNIWARE_TENANT: 'fraternitas', UNIWARE_USERNAME: 'u', UNIWARE_PASSWORD: 'p' };

// A fetch stub that answers the token endpoint then the serviceability endpoint.
function stub(serviceabilityBody, status = 200) {
  return async (url) => {
    if (String(url).includes('/oauth/token'))
      return new Response(JSON.stringify({ access_token: 'TOK', expires_in: 43199 }), { status: 200 });
    return new Response(JSON.stringify(serviceabilityBody), { status });
  };
}

test('serviceable pincode with a facility', async () => {
  const r = await checkServiceability(ENV, { pincode: '560001', cod: false },
    { fetchImpl: stub({ successful: true, facilityCodes: ['BLR1'] }) });
  assert.equal(r.serviceable, true);
  assert.deepEqual(r.facilityCodes, ['BLR1']);
});

test('not serviceable when successful:false', async () => {
  const r = await checkServiceability(ENV, { pincode: '999999', cod: false },
    { fetchImpl: stub({ successful: false, errors: [{ message: 'not serviceable' }] }) });
  assert.equal(r.serviceable, false);
});

test('not serviceable when no facility codes', async () => {
  const r = await checkServiceability(ENV, { pincode: '560001', cod: false },
    { fetchImpl: stub({ successful: true, facilityCodes: [] }) });
  assert.equal(r.serviceable, false);
});

test('COD query marks codAvailable when serviceable', async () => {
  const r = await checkServiceability(ENV, { pincode: '560001', cod: true },
    { fetchImpl: stub({ successful: true, facilityCodes: ['BLR1'] }) });
  assert.equal(r.codAvailable, true);
});
