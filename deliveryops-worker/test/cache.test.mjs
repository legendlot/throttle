import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheGet, cachePut } from '../src/cache.js';

const ENV = { SUPABASE_URL: 'https://sb.example', SUPABASE_SERVICE_KEY: 'k' };
const NOW = new Date('2026-07-15T06:00:00Z');
const TTL = 12 * 3600 * 1000;

test('cacheGet returns a fresh row', async () => {
  const row = { pincode: '560001', cod: false, serviceable: true, source: 'delhivery', transit_days: 3, fetched_at: '2026-07-15T05:00:00Z' };
  const fetchImpl = async () => new Response(JSON.stringify([row]), { status: 200 });
  const got = await cacheGet(ENV, { pincode: '560001', cod: false }, { fetchImpl, now: NOW, ttlMs: TTL });
  assert.equal(got.transit_days, 3);
});

test('cacheGet returns null for a stale row', async () => {
  const row = { pincode: '560001', cod: false, serviceable: true, source: 'delhivery', transit_days: 3, fetched_at: '2026-07-13T05:00:00Z' };
  const fetchImpl = async () => new Response(JSON.stringify([row]), { status: 200 });
  const got = await cacheGet(ENV, { pincode: '560001', cod: false }, { fetchImpl, now: NOW, ttlMs: TTL });
  assert.equal(got, null);
});

test('cacheGet returns null when absent', async () => {
  const fetchImpl = async () => new Response('[]', { status: 200 });
  const got = await cacheGet(ENV, { pincode: '560001', cod: false }, { fetchImpl, now: NOW, ttlMs: TTL });
  assert.equal(got, null);
});

test('cachePut issues an upsert with resolution=merge-duplicates', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url: String(url), init }; return new Response('', { status: 201 }); };
  await cachePut(ENV, { pincode: '560001', cod: false, serviceable: true, source: 'delhivery', transit_days: 3 }, { fetchImpl });
  assert.match(seen.url, /\/rest\/v1\/delivery_edd_cache/);
  assert.equal(seen.init.method, 'POST');
  assert.match(seen.init.headers.Prefer, /merge-duplicates/);
});
