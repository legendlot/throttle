import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isForbidden, pickCounts, pickLines, pickChannelRows, pickScanSummary, countRequests,
  rosterByLine, floorOpsCount, slimPipeline, dispatchedToday, istStamp, freshness, panelAsOf,
} from '../src/lib/overview.mjs';
import { isPresent } from '../../../packages/domain/attendance.js';

// useCachedQuery state shapes, as the page reads them.
const q = (o = {}) => ({ data: undefined, error: null, loading: false, refreshing: false, updatedAt: null, ...o });
const boom = new Error('Worker 500');

test('only a 403 is the by-design no-access reply', () => {
  assert.equal(isForbidden(Object.assign(new Error('No permission to view attendance'), { status: 403 })), true);
  assert.equal(isForbidden(Object.assign(new Error('x'), { status: 401 })), false);
  assert.equal(isForbidden(Object.assign(new Error('x'), { status: 500 })), false);
  assert.equal(isForbidden(new Error('No permission to view attendance')), false);
  assert.equal(isForbidden(undefined), false);
});

test('slimmers keep the page fallbacks and drop what it never shows', () => {
  assert.deepEqual(pickCounts({ counts: { rtd_count: 3 }, units: [{ upc: 'X' }] }), { rtd_count: 3 });
  assert.equal(pickCounts({}), null);
  const lines = pickLines({ dispatch_lines: [{ line: 'D1', pack_count: 4, alloc_count: 1, dout_count: 2, active_operators: 3, last_scan_at: 't', active_channels: ['Amazon'], extra: 1 }], operator_stats: [{ operator_name: 'A' }] });
  assert.deepEqual(lines, [{ line: 'D1', pack_count: 4, alloc_count: 1, dout_count: 2, active_operators: 3, last_scan_at: 't', active_channels: ['Amazon'] }]);
  assert.deepEqual(pickLines(null), []);
  assert.deepEqual(pickChannelRows([{ channel_name: 'A', channel_type: 'ecom', is_sale: true, unit_count: 5, channel_id: 9 }]),
    [{ channel_name: 'A', channel_type: 'ecom', is_sale: true, unit_count: 5 }]);
  assert.deepEqual(pickChannelRows('nope'), []);
  assert.deepEqual(pickScanSummary({ DOUT: 7, shipments_out: 2, PACK: 9 }), { DOUT: 7, shipments_out: 2 });
  assert.equal(pickScanSummary(null), null);
  assert.equal(countRequests([{ customer_name: 'x', phone: 'y' }, {}]), 2);
  assert.equal(countRequests(null), 0);
});

test('roster: D1/D2 counts; a non-object reply means no roster', () => {
  assert.deepEqual(rosterByLine({ data: { D1: [{ operator_name: 'a' }, {}], D2: [], Others: [{}] } }), { D1: 2, D2: 0 });
  assert.deepEqual(rosterByLine({ data: [] }), {});
  assert.deepEqual(rosterByLine({}), {});
});

test('on the floor: distinct operators, open shift, present', () => {
  const rows = [
    { operator_id: 1, clock_out: null, day_status: 'present' },
    { operator_id: 1, clock_out: null, day_status: 'present' },
    { operator_id: 2, clock_out: '17:00' },
    { operator_id: 3, clock_out: null, day_status: 'absent' },
    { operator_id: 4, clock_out: null },
  ];
  assert.equal(floorOpsCount({ data: rows }, isPresent), 2);
  assert.equal(floorOpsCount(rows, isPresent), 2);
  assert.equal(floorOpsCount({ data: null }, isPresent), 0);
});

test('pipeline keeps totals per product, drops variants', () => {
  const out = slimPipeline({ products: [{ product: 'Gator', totals: { with_production: 2, channels: { Amazon: 1 }, vendor_at: 1 }, variants: [{ color: 'Green' }] }] });
  assert.equal(out.length, 1);
  assert.equal(out[0].variants, undefined);
  assert.equal(out[0].totals.with_production, 2);
  assert.deepEqual(out[0].totals.channels, { Amazon: 1 });
  assert.deepEqual(slimPipeline({}), []);
});

test('Dispatched never shows the line sum standing in for a summary that has not answered', () => {
  const lines = q({ data: [{ dout_count: 3 }, { dout_count: 4 }] });
  assert.equal(dispatchedToday(q(), lines).state, 'loading');
  assert.equal(dispatchedToday(q({ loading: true }), lines).state, 'loading');
  assert.equal(dispatchedToday(q({ error: boom }), lines).state, 'error');
  assert.deepEqual(dispatchedToday(q({ data: { DOUT: '12' } }), q()), { state: 'ready', value: 12 });
  // No DOUT in the summary → the line sum, but only once the lines are in.
  assert.equal(dispatchedToday(q({ data: {} }), q()).state, 'loading');
  assert.equal(dispatchedToday(q({ data: null }), q({ error: boom })).state, 'error');
  assert.deepEqual(dispatchedToday(q({ data: {} }), lines), { state: 'ready', value: 7 });
  // Stale data kept through a failed refresh still renders.
  assert.deepEqual(dispatchedToday(q({ data: { DOUT: 5 }, error: boom }), lines), { state: 'ready', value: 5 });
});

test('IST stamp: time today, date + time otherwise', () => {
  const now = Date.parse('2026-11-13T10:00:00Z');                    // 15:30 IST
  assert.equal(istStamp(Date.parse('2026-11-13T09:04:00Z'), now), '14:34');
  assert.equal(istStamp(Date.parse('2026-11-12T15:34:00Z'), now), '12 Nov 21:04');
  // 23:00 UTC on the 12th is already the 13th in IST.
  assert.equal(istStamp(Date.parse('2026-11-12T23:00:00Z'), now), '04:30');
});

test('freshness: Garage wording over the polled calls; the once-loaded panels stamp themselves', () => {
  const now = Date.parse('2026-11-13T10:00:00Z');
  const t1 = Date.parse('2026-11-13T09:30:00Z');                     // 15:00 IST
  const t2 = Date.parse('2026-11-13T09:45:00Z');                     // 15:15 IST
  const old = Date.parse('2026-11-12T15:34:00Z');                    // 12 Nov 21:04 IST
  assert.deepEqual(freshness([q()], now), { text: '', warn: false });
  assert.equal(freshness([q({ loading: true })], now).text, 'Updating…');
  assert.equal(freshness([q({ data: 1, updatedAt: t1, refreshing: true }), q({ data: 1, updatedAt: t2 })], now).text, 'Updating… (showing 15:00)');
  assert.equal(freshness([q({ data: 1, updatedAt: t2 })], now).text, 'Updated 15:15');
  assert.deepEqual(freshness([q({ data: 1, updatedAt: t2, error: boom })], now), { text: "Couldn't refresh — showing 15:15", warn: true });
  assert.deepEqual(freshness([q({ error: boom })], now), { text: "Couldn't refresh", warn: true });
  // Panel stamps: only while the panel shows data; a failed refresh over stale data says so.
  assert.equal(panelAsOf(q(), now), null);
  assert.equal(panelAsOf(q({ loading: true }), now), null);
  assert.equal(panelAsOf(q({ error: boom }), now), null);
  assert.deepEqual(panelAsOf(q({ data: [], updatedAt: t1 }), now), { text: 'as of 15:00', warn: false });
  assert.deepEqual(panelAsOf(q({ data: [], updatedAt: t1, refreshing: true }), now), { text: 'as of 15:00', warn: false });
  assert.deepEqual(panelAsOf(q({ data: [], updatedAt: old, error: boom }), now), { text: "Couldn't refresh — as of 12 Nov 21:04", warn: true });
});
