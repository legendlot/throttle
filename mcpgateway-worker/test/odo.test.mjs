import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRange, todayIST, shapeSalesSummary, MAX_RANGE_DAYS } from '../src/odo.js';
import { hybridHeadline } from '../../apps/odo/src/lib/segregation.js';

const NOW = Date.parse('2026-11-09T20:00:00Z'); // 01:30 IST on 10 Nov
test('todayIST rolls over at IST midnight, not UTC', () => {
  assert.equal(todayIST(NOW), '2026-11-10');
  assert.equal(todayIST(Date.parse('2026-11-09T18:00:00Z')), '2026-11-09');
});
test('range: defaults, limits, bad input', () => {
  assert.deepEqual(parseRange({}, NOW), { ok: true, from: '2026-11-10', to: '2026-11-10', days: 1 });
  assert.deepEqual(parseRange({ from: '2026-11-01' }, NOW), { ok: true, from: '2026-11-01', to: '2026-11-01', days: 1 });
  assert.equal(parseRange({ from: '2026-11-01', to: '2026-11-10' }, NOW).days, 10);
  assert.equal(parseRange({ from: '2026-08-11', to: '2026-11-10' }, NOW).days, MAX_RANGE_DAYS);
  for (const bad of [
    { from: '2026-08-10', to: '2026-11-10' },   // 93 days
    { from: '2026-11-05', to: '2026-11-01' },   // reversed
    { from: '2026-11-11' },                     // future
    { from: '2026-02-30' }, { from: '2026-1-01' }, { from: 20261101 }, { from: '2026-11-01T00:00' },
    { from: "2026-11-01'; drop" },
  ]) assert.equal(parseRange(bad, NOW).ok, false, JSON.stringify(bad));
  assert.equal(parseRange(null, NOW).ok, true);
});

const channels = [{ id: 'a', name: 'Amazon' }, { id: 'w', name: 'Website' }];
const orderRows = [
  { channel_id: 'w', gross: 11800, discount: 0, tax: 1800, cancelled_value: 1180, returns_value: 0, orders: 3 },
];
const productRows = [
  { channel_id: 'w', units: 3, gross_value: 11800, tax_value: 1800 },
  { channel_id: 'a', units: 2, gross_value: 5900, tax_value: 900 },
  { channel_id: 'z', units: 1, gross_value: 1180, tax_value: null },
];
test('summary: Odo headline maths, channel tie-out, names, sort', () => {
  const r = shapeSalesSummary({ orderRows, channels, productRows }, { from: '2026-11-01', to: '2026-11-01', days: 1 });
  const h = hybridHeadline(orderRows, productRows);
  assert.equal(r.net_revenue_ex_gst, Math.round(h.netExGst));
  assert.equal(r.gross_sales_incl_gst, Math.round(h.grossAll));
  assert.equal(r.units, 6);
  const sumNet = r.by_channel.reduce((s, c) => s + c.net_revenue_ex_gst, 0);
  assert.ok(Math.abs(sumNet - r.net_revenue_ex_gst) <= r.by_channel.length, 'channels tie out to the headline (rounding only)');
  assert.deepEqual(r.by_channel.map(c => c.channel), ['Website', 'Amazon', 'Unknown channel']);
  assert.equal(r.period.timezone, 'IST');
  const keys = JSON.stringify(r);
  for (const banned of ['cost', 'margin', 'pnl', 'settlement', 'fee']) assert.ok(!keys.toLowerCase().includes(`"${banned}`), banned);
});
test('summary: empty day is zeros, not an error', () => {
  const r = shapeSalesSummary({ orderRows: [], channels: [], productRows: [] }, { from: '2026-11-01', to: '2026-11-01', days: 1 });
  assert.equal(r.net_revenue_ex_gst, 0);
  assert.deepEqual(r.by_channel, []);
});

import { odoSalesSummary } from '../src/odo.js';
import { ttlFor } from '../src/checks.js';
const fakeEnv = (handler) => { const seen = []; return { seen, ODOOPS: { fetch: async (url, init) => { seen.push({ url, auth: init.headers.Authorization }); return handler(new URL(url)); } } }; };
const json = (status, body) => new Response(JSON.stringify(body), { status });
const R = { from: '2026-11-01', to: '2026-11-02', days: 2 };
test('odoops call: only the two read actions, as the person, dates only', async () => {
  const env = fakeEnv(u => json(200, { ok: true, data: { rows: [], channels: [] } }));
  const r = await odoSalesSummary(env, 'JWT', R);
  assert.equal(r.ok, true);
  assert.deepEqual(env.seen.map(s => new URL(s.url).searchParams.get('action')).sort(), ['getSales', 'getSegregation']);
  for (const s of env.seen) {
    assert.equal(s.auth, 'Bearer JWT');
    const keys = [...new URL(s.url).searchParams.keys()].sort();
    assert.ok(keys.every(k => ['action', 'from', 'to', 'group'].includes(k)), keys.join());
  }
});
test('odoops call: status mapping fails closed', async () => {
  const cases = [
    [() => json(401, { ok: false }), 'session expired'],
    [() => json(403, { ok: false }), 'odo denied'],
    [() => json(502, { ok: false }), 'unreachable'],
    [() => new Response('not json', { status: 200 }), 'unreachable'],
    [() => json(200, { ok: true }), 'unreachable'],
    [() => json(200, { ok: true, data: null }), 'unreachable'],
    [() => json(200, { ok: true, data: { rows: 'x' } }), 'unreachable'],
    [() => { throw new Error('down'); }, 'unreachable'],
  ];
  for (const [h, reason] of cases) {
    const r = await odoSalesSummary(fakeEnv(h), 'JWT', R);
    assert.deepEqual(r, { ok: false, reason });
  }
});
test('ttl: gateway token never outlives the LOT session', () => {
  const now = 1_800_000_000;
  assert.equal(ttlFor(now + 3600, now), 3480);
  assert.equal(ttlFor(now + 7200, now), 3600);
  assert.equal(ttlFor(now + 180, now), 60);
  assert.equal(ttlFor(now + 179, now), null);
  assert.equal(ttlFor(now - 5, now), null);
  assert.equal(ttlFor(undefined, now), null);
  assert.equal(ttlFor('x', now), null);
});
