import { test } from 'node:test';
import assert from 'node:assert/strict';
import { delhiveryTransitDays } from '../src/delhivery.js';

const ENV = { DELHIVERY_API_TOKEN: 'T' };
const NOW = new Date('2026-07-15T06:00:00Z'); // 11:30 IST on the 15th
const ok = (body) => ({ fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 }), now: NOW });

test('reads an integer transit-days field', async () => {
  const n = await delhiveryTransitDays(ENV, { originPin: '110001', destPin: '560001', cod: false },
    ok([{ tat: 3 }]));
  assert.equal(n, 3);
});

test('converts an absolute EDD date to transit days from today IST', async () => {
  // EDD 2026-07-19, today (IST) is the 15th → 4 days
  const n = await delhiveryTransitDays(ENV, { originPin: '110001', destPin: '560001', cod: false },
    ok([{ expected_delivery_date: '2026-07-19' }]));
  assert.equal(n, 4);
});

test('returns null when the response carries no usable field', async () => {
  const n = await delhiveryTransitDays(ENV, { originPin: '110001', destPin: '560001', cod: false },
    ok([{ note: 'embargo' }]));
  assert.equal(n, null);
});

test('returns null on a non-200 / thrown fetch', async () => {
  const n = await delhiveryTransitDays(ENV, { originPin: '110001', destPin: '560001', cod: false },
    { now: NOW, fetchImpl: async () => { throw new Error('timeout'); } });
  assert.equal(n, null);
});
