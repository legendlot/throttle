import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slimReorders, slimPOs, arrivingCount, istStamp, freshness, shouldRefreshOnReturn,
  poOverviewKey, canSeeChinaPrices, rowsAreFresh,
  TO_APPROVE_STATUSES, ARRIVING_STATUSES,
} from '../src/lib/overview.mjs';
import { OPEN_PO_STATUSES } from '../src/components/format.js';

// useCachedQuery state shapes, as the page reads them.
const q = (o = {}) => ({ data: undefined, error: null, loading: false, refreshing: false, updatedAt: null, ...o });
const NOW = Date.parse('2026-11-14T06:30:00Z'); // 12:00 IST
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

// The page's derivation BEFORE instant load, verbatim — the slimmed shape must reproduce it.
const FX = { INR: 1, USD: 84, RMB: 11.6, CNY: 11.6 };
const toInr = (v, cur) => (Number(v) || 0) * (FX[cur] || 1);
function oldPage(pos, nowMs) {
  const poRows = Array.isArray(pos) ? pos : (pos?.rows ?? []);
  const poTruncated = Array.isArray(pos) ? false : !!pos?.truncated;
  const openPO = poRows.filter((p) => OPEN_PO_STATUSES.includes(p.status)).length;
  const pendingApproval = poRows.filter((p) => TO_APPROVE_STATUSES.includes(p.status)).length;
  const cutoff = new Date(nowMs); cutoff.setDate(cutoff.getDate() + 14);
  const arriving = poRows.filter((p) => {
    if (!ARRIVING_STATUSES.includes(p.status)) return false;
    if (!p.expected_delivery) return false;
    const d = new Date(p.expected_delivery);
    return !isNaN(d) && d <= cutoff && d >= new Date(nowMs);
  }).length;
  const openPOList = poRows.filter((p) => OPEN_PO_STATUSES.includes(p.status)).slice(0, 6);
  const c = (s) => poRows.filter((p) => s.includes(p.status)).length;
  const pipeline = [
    { stage: 'To Approve', count: c(TO_APPROVE_STATUSES), tone: 'orange' },
    { stage: 'Approved', count: c(['Approved']), tone: 'blue' },
    { stage: 'Sent', count: c(['Sent']), tone: 'yellow' },
    { stage: 'Confirmed', count: c(['Confirmed & Payment Done']), tone: 'green' },
    { stage: 'Receiving', count: c(['Partially Received']), tone: 'yellow' },
  ];
  const total = poRows.filter((p) => OPEN_PO_STATUSES.includes(p.status)).reduce((s, p) => s + toInr(p.po_value, p.currency), 0);
  return { poTruncated, openPO, pendingApproval, arriving, openPOList, pipeline, total };
}

// A China PO as the worker sends it to a viewer WITHOUT China rights (stripChinaPOHeader).
const stripped = { po_number: 'PO-C1', status: 'Approved', source: 'China', vendor_name: 'Shenzhen Co',
  expected_delivery: iso(NOW + 3 * DAY), total_qty_ordered: 10, total_qty_received: 0 };
const rows = [
  { po_number: 'PO-1', status: 'Accepted', source: 'India', vendor_name: 'A', currency: 'INR', po_value: '1000.50', expected_delivery: iso(NOW + 2 * DAY), payment_terms: '30d', invoice_value: 9, vendor_email: 'a@x', raised_by_name: 'R' },
  { po_number: 'PO-2', status: 'Sent', source: 'India', vendor_name: 'B', currency: 'USD', po_value: 10, expected_delivery: iso(NOW + 20 * DAY) },
  stripped,
  { po_number: 'PO-3', status: 'Closed', source: 'India', vendor_name: 'C', currency: 'INR', po_value: 99999, expected_delivery: iso(NOW + 1 * DAY) },
  { po_number: 'PO-4', status: 'Pending Approval', source: 'India', vendor_name: 'D', currency: 'RMB', po_value: 7 },
  { po_number: 'PO-5', status: 'Confirmed & Payment Done', source: 'India', vendor_name: 'E', currency: 'INR', po_value: 1, expected_delivery: iso(NOW - 2 * DAY) },
  { po_number: 'PO-6', status: 'Draft', source: 'India', vendor_name: 'F', currency: 'INR', po_value: 2 },
  { po_number: 'PO-7', status: 'Partially Received', source: 'India', vendor_name: 'G', currency: 'CNY', po_value: 3, expected_delivery: 'not a date' },
  { po_number: 'PO-8', status: 'Approved', source: 'India', vendor_name: 'H', currency: 'INR', po_value: 4, expected_delivery: iso(NOW + 14 * DAY) },
];

test('getPOs → every figure equals the old page derivation (object and legacy array replies)', () => {
  for (const reply of [{ rows, total: 12, truncated: true }, rows, { rows: [] }]) {
    const old = oldPage(reply, NOW);
    const s = slimPOs(reply, NOW);
    assert.equal(s.truncated, old.poTruncated);
    assert.equal(s.openPO, old.openPO);
    assert.equal(s.pendingApproval, old.pendingApproval);
    assert.equal(arrivingCount(s.arrivingDates, NOW), old.arriving);
    assert.deepEqual(s.pipeline, old.pipeline);
    assert.equal(s.openValueInr, old.total);
    assert.deepEqual(s.openList.map((p) => p.po_number), old.openPOList.map((p) => p.po_number));
  }
});

test('the cached PO shape carries no row set, no vendor contact, no invoice/terms fields', () => {
  const s = slimPOs({ rows, truncated: false }, NOW);
  assert.deepEqual(Object.keys(s).sort(), ['arrivingDates', 'openList', 'openPO', 'openValueInr', 'pendingApproval', 'pipeline', 'truncated']);
  assert.equal(s.openList.length, 6);
  assert.deepEqual(Object.keys(s.openList[0]).sort(), ['currency', 'expected_delivery', 'po_number', 'po_value', 'source', 'status', 'vendor_name']);
  const json = JSON.stringify(s);
  for (const leaked of ['vendor_email', 'payment_terms', 'invoice_value', 'raised_by_name', '99999']) assert.ok(!json.includes(leaked), leaked);
});

test('price restriction: a stripped China row stays price-less through the cache and adds 0', () => {
  const s = JSON.parse(JSON.stringify(slimPOs({ rows }, NOW))); // round-trip, as sessionStorage does
  const c = s.openList.find((p) => p.po_number === 'PO-C1');
  assert.equal(c.po_value, undefined);
  assert.equal(c.currency, undefined);
  assert.equal(c.source, 'China');
  // Same total with the stripped row present or absent — it never contributed a price.
  const without = slimPOs({ rows: rows.filter((r) => r !== stripped) }, NOW);
  assert.equal(s.openValueInr, without.openValueInr);
  // And a price the worker DID send is kept exactly (string, as PostgREST returns numerics).
  assert.equal(s.openList.find((p) => p.po_number === 'PO-1').po_value, '1000.50');
});

test('arriving: 14-day window from now; past dates dropped at fetch; later in the window still counts', () => {
  const s = slimPOs({ rows }, NOW);
  assert.ok(!s.arrivingDates.includes(iso(NOW - 2 * DAY)));
  assert.ok(!s.arrivingDates.includes('not a date'));
  assert.ok(s.arrivingDates.includes(iso(NOW + 20 * DAY))); // outside today, inside in a week
  assert.equal(arrivingCount(s.arrivingDates, NOW), oldPage({ rows }, NOW).arriving);
  const later = NOW + 7 * DAY;
  assert.equal(arrivingCount(s.arrivingDates, later), oldPage({ rows }, later).arriving);
  assert.equal(arrivingCount(undefined, NOW), 0);
});

test('reorders → queue length + six rows of the rendered fields only', () => {
  const rrs = Array.from({ length: 9 }, (_, i) => ({ request_id: `RR-${i}`, request_type: i ? 'product' : 'part', part_code: 'P1', part_name: 'Wheel',
    product: 'Gator', variant: 'V', color: 'Red', requested_qty: 5, unit: 'pcs', urgency: 'Urgent', notes: 'secret', requested_by_email: 'x@y' }));
  const s = slimReorders(rrs);
  assert.equal(s.count, 9);
  assert.equal(s.top.length, 6);
  assert.deepEqual(s.top[0], { request_id: 'RR-0', request_type: 'part', part_code: 'P1', part_name: 'Wheel', product: 'Gator', variant: 'V', color: 'Red', requested_qty: 5, unit: 'pcs', urgency: 'Urgent' });
  assert.deepEqual(slimReorders([]), { count: 0, top: [] });
});

test('freshness: updating over cached data, as of, failed refresh, date when not today', () => {
  const at = Date.parse('2026-11-14T04:30:00Z'); // 10:00 IST
  const older = Date.parse('2026-11-14T03:45:00Z'); // 09:15 IST
  assert.deepEqual(freshness([q({ data: 1, updatedAt: at, refreshing: true }), q({ data: 1, updatedAt: older })], NOW), { text: 'Updating… (showing 09:15)', warn: false });
  assert.deepEqual(freshness([q({ data: 1, updatedAt: at }), q({ data: 1, updatedAt: at })], NOW), { text: 'As of 10:00', warn: false });
  assert.deepEqual(freshness([q({ data: 1, updatedAt: at, error: new Error('x') }), q({ data: 1, updatedAt: at })], NOW), { text: "Couldn't refresh — showing 10:00", warn: true });
  assert.deepEqual(freshness([q({ loading: true }), q({ loading: true })], NOW), { text: 'Updating…', warn: false });
  assert.deepEqual(freshness([q(), q()], NOW), { text: '', warn: false });
  assert.equal(freshness([q({ data: 1, updatedAt: at - DAY })], NOW).text, 'As of 13 Nov 10:00');
  assert.equal(istStamp(Date.parse('2026-11-13T18:40:00Z'), NOW), '00:10'); // after IST midnight = today
});

test('refresh on return only after more than a minute hidden', () => {
  assert.equal(shouldRefreshOnReturn(null, NOW), false);
  assert.equal(shouldRefreshOnReturn(NOW - 30000, NOW), false);
  assert.equal(shouldRefreshOnReturn(NOW - 60000, NOW), false);
  assert.equal(shouldRefreshOnReturn(NOW - 60001, NOW), true);
});

test('a bad reply shape throws — it is an error, never a cached "nothing"', () => {
  for (const bad of [null, undefined, {}, { rows: null }, { rows: 'x' }, 'oops', { error: 'x' }]) {
    assert.throws(() => slimPOs(bad, NOW), /Unexpected getPOs reply/);
  }
  for (const bad of [null, undefined, {}, { rows: [] }, 'oops']) {
    assert.throws(() => slimReorders(bad), /Unexpected getReorderRequests reply/);
  }
});

test('PO cache key carries the price tier: a tier change is a different key', () => {
  assert.equal(poOverviewKey({ po_china: true }), 'snorkel:overview:pos:cn');
  assert.equal(poOverviewKey({ po_china_view: true }), 'snorkel:overview:pos:cn');
  assert.equal(poOverviewKey({ procurement_view: true }), 'snorkel:overview:pos:std');
  assert.equal(poOverviewKey(null), 'snorkel:overview:pos:std');
  assert.notEqual(poOverviewKey({ po_china: true }), poOverviewKey({ po_china: false }));
  assert.equal(canSeeChinaPrices({ po_china_view: 1 }), true);
});

test('Convert: only on rows from a successful fetch since mount, not mid-refresh', () => {
  const since = NOW;
  assert.equal(rowsAreFresh(q({ data: {}, updatedAt: NOW + 5 }), since), true);
  assert.equal(rowsAreFresh(q({ data: {}, updatedAt: NOW - 60000 }), since), false); // seeded from cache
  assert.equal(rowsAreFresh(q({ data: {}, updatedAt: NOW + 5, refreshing: true }), since), false);
  assert.equal(rowsAreFresh(q({ data: {}, updatedAt: NOW + 5, error: new Error('x') }), since), false);
  assert.equal(rowsAreFresh(q({ loading: true }), since), false);
});
