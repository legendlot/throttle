import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapB2BStatus, extractB2BTrack, mergeCheckpoint, TERMINAL_STAGES, toDate, istToUtc,
} from '../src/normalize.js';

test('mapB2BStatus maps the canonical vocabulary, aliases, and unknowns', () => {
  assert.deepEqual(mapB2BStatus('MANIFESTED'), { stage: 'manifested', label: 'Manifested', raw: 'MANIFESTED' });
  assert.equal(mapB2BStatus('DELIVERED').stage, 'delivered');
  assert.equal(mapB2BStatus('RETURN_DELIVERED').stage, 'rto_delivered');
  assert.equal(mapB2BStatus('NOT_PICKED').stage, 'not_picked');
  // alias + free-text tolerance
  assert.equal(mapB2BStatus('Out For Delivery').stage, 'out_for_delivery');
  assert.equal(mapB2BStatus('in transit').stage, 'in_transit');
  assert.equal(mapB2BStatus('partially delivered').stage, 'part_delivered');
  // unknown → stage 'unknown' but a readable label, never throws
  const u = mapB2BStatus('SOME_NEW_CODE');
  assert.equal(u.stage, 'unknown');
  assert.equal(u.label, 'Some New Code');
});

test('TERMINAL_STAGES covers the closed states (forward + return + lost)', () => {
  for (const s of ['delivered', 'rto_delivered', 'lost']) assert.ok(TERMINAL_STAGES.includes(s));
  assert.ok(!TERMINAL_STAGES.includes('in_transit'));
  assert.ok(!TERMINAL_STAGES.includes('not_picked'));   // pickup can still reattempt → keep polling
});

test('toDate / istToUtc parsing', () => {
  assert.equal(toDate('2024-06-20T23:59:59'), '2024-06-20');
  assert.equal(toDate(null), null);
  assert.equal(istToUtc('2024-06-20T12:18:25.002000'), '2024-06-20T06:48:25.002Z');  // IST→UTC
  assert.equal(istToUtc('2024-06-20T12:18:25Z'), '2024-06-20T12:18:25.000Z');        // explicit Z honored
});

test('extractB2BTrack reads a top-level status + EDD, no LRN → null', () => {
  assert.equal(extractB2BTrack({ status: 'IN_TRANSIT' }, null), null);
  const r = extractB2BTrack({ status: 'OFD', expected_delivery_date: '2024-06-22' }, '220110457');
  assert.equal(r.lrn, '220110457');
  assert.equal(r.stage, 'out_for_delivery');
  assert.equal(r.expected_delivery_date, '2024-06-22');
  assert.equal(r.delivered_at, null);
});

test('extractB2BTrack finds status nested under data + a delivered timestamp', () => {
  const r = extractB2BTrack({ data: { lr_status: 'DELIVERED', delivered_date: '2024-06-21T15:00:00' } }, 'LR9');
  assert.equal(r.stage, 'delivered');
  assert.equal(r.delivered_at, istToUtc('2024-06-21T15:00:00'));
});

test('extractB2BTrack: delivered with no timestamp field falls back to now (clock must start)', () => {
  const r = extractB2BTrack({ status: 'DELIVERED' }, 'LR10');
  assert.equal(r.stage, 'delivered');
  assert.ok(r.delivered_at);                      // not null — payment-due clock needs a date
});

test('extractB2BTrack deep-scans for a known status when no obvious field exists', () => {
  const r = extractB2BTrack({ shipment_info: { legs: [{ note: 'PICKED_UP' }] } }, 'LR11');
  assert.equal(r.stage, 'picked_up');
});

test('mergeCheckpoint accumulates a timeline only on status change', () => {
  const t1 = '2024-06-20T10:00:00.000Z', t2 = '2024-06-20T16:00:00.000Z';
  const res1 = { stage: 'in_transit', stage_label: 'Left origin', raw_status: 'LEFT_ORIGIN', delivered_at: null, fetched_at: t1 };
  let cps = mergeCheckpoint(null, res1, t1);
  assert.equal(cps.length, 1);
  assert.equal(cps[0].stage, 'in_transit');
  assert.equal(cps[0].timestamp, t1);

  // same stage on the next poll → no new row
  cps = mergeCheckpoint(cps, { ...res1, fetched_at: t2 }, t2);
  assert.equal(cps.length, 1);

  // status advances → prepend (newest-first)
  const res2 = { stage: 'out_for_delivery', stage_label: 'Out for delivery', raw_status: 'OFD', delivered_at: null, fetched_at: t2 };
  cps = mergeCheckpoint(cps, res2, t2);
  assert.equal(cps.length, 2);
  assert.equal(cps[0].stage, 'out_for_delivery');
  assert.equal(cps[1].stage, 'in_transit');

  // delivered checkpoint uses the delivered timestamp, not the sync time
  const res3 = { stage: 'delivered', stage_label: 'Delivered', raw_status: 'DELIVERED', delivered_at: '2024-06-21T09:00:00.000Z', fetched_at: t2 };
  cps = mergeCheckpoint(cps, res3, t2);
  assert.equal(cps[0].stage, 'delivered');
  assert.equal(cps[0].timestamp, '2024-06-21T09:00:00.000Z');
});
