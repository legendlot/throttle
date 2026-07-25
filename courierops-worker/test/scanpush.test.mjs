import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scanLifecycle, scanTimestamp, parseScanPush, parseScanPushBatch, tokenMatches,
} from '../src/scanpush.js';

test('scanLifecycle maps the StatusType buckets', () => {
  assert.equal(scanLifecycle({ statusType: 'DL' }), 'delivered');
  assert.equal(scanLifecycle({ statusType: 'RT' }), 'rto');
  assert.equal(scanLifecycle({ statusType: 'CN' }), 'cancelled');
  assert.equal(scanLifecycle({ statusType: 'PP' }), 'manifested');
  assert.equal(scanLifecycle({ statusType: 'UD' }), 'in_transit');   // coarse default
});

test('scanLifecycle refines UD via the free-text Status', () => {
  assert.equal(scanLifecycle({ status: 'Manifested', statusType: 'UD' }), 'manifested');
  assert.equal(scanLifecycle({ status: 'In Transit', statusType: 'UD' }), 'in_transit');
  assert.equal(scanLifecycle({ status: 'Out for delivery', statusType: 'UD' }), 'out_for_delivery');
  assert.equal(scanLifecycle({ status: 'Dispatched', statusType: 'UD' }), 'in_transit');
  assert.equal(scanLifecycle({ status: 'Pending', statusType: 'UD' }), 'pending');
});

// THE load-bearing case: an RTO leg still says "Delivered". Calling that a delivery would tell a
// customer their order arrived when it actually came back to us.
test('RTO always outranks delivered', () => {
  assert.equal(scanLifecycle({ status: 'RTO Delivered', statusType: 'DL' }), 'rto');
  assert.equal(scanLifecycle({ status: 'Delivered', statusType: 'RT' }), 'rto');
  assert.equal(scanLifecycle({ status: 'Delivered', nslCode: 'RT-DEL' }), 'rto');
  assert.equal(scanLifecycle({ status: 'Returned to origin', statusType: 'UD' }), 'rto');
  // and a genuine delivery is still a delivery
  assert.equal(scanLifecycle({ status: 'Delivered', statusType: 'DL', nslCode: 'DL-SCH' }), 'delivered');
});

test('scanLifecycle returns null for an unclassifiable scan (capture, never guess)', () => {
  assert.equal(scanLifecycle({ status: 'Some New Delhivery Code', statusType: 'ZZ' }), null);
  assert.equal(scanLifecycle({}), null);
});

// Delhivery sends a naive timestamp; it is IST. Reading it as UTC dates a delivery 5h30m early.
test('scanTimestamp treats a zoneless stamp as IST', () => {
  assert.equal(scanTimestamp('2019-01-09T17:10:42.767'), '2019-01-09T11:40:42.767Z');
  assert.equal(scanTimestamp('2019-01-09 17:10:42.543'), '2019-01-09T11:40:42.543Z');
  assert.equal(scanTimestamp('2019-01-09T17:10:42Z'), '2019-01-09T17:10:42.000Z'); // zoned = trusted
  assert.equal(scanTimestamp(null), null);
  assert.equal(scanTimestamp('not a date'), null);
});

test('parseScanPush reads the documented default payload', () => {
  const body = {
    Shipment: {
      Status: {
        Status: 'Manifested',
        StatusDateTime: '2019-01-09T17:10:42.767',
        StatusType: 'UD',
        StatusLocation: 'Chandigarh_Raiprkln_C (Chandigarh)',
        Instructions: 'Manifest uploaded',
      },
      PickUpDate: '2019-01-09 17:10:42.543',
      NSLCode: 'X-UCI',
      Sortcode: 'IXC/MDP',
      ReferenceNo: '28',
      AWB: '1234567890',
    },
  };
  const s = parseScanPush(body);
  assert.equal(s.awb, '1234567890');
  assert.equal(s.status, 'Manifested');
  assert.equal(s.statusType, 'UD');
  assert.equal(s.nslCode, 'X-UCI');
  assert.equal(s.referenceNo, '28');
  assert.equal(s.statusAt, '2019-01-09T11:40:42.767Z');
  assert.equal(s.lifecycle, 'manifested');
});

// The Shopflo lesson: the real wire shape differed from the vendor's own doc.
test('parseScanPush tolerates flat / camelCase shape drift', () => {
  const s = parseScanPush({ awb: '999', status: 'Delivered', statusType: 'DL' });
  assert.equal(s.awb, '999');
  assert.equal(s.lifecycle, 'delivered');
  const s2 = parseScanPush({ Shipment: { AWB: 7, Status: { Status: 'In Transit' } } });
  assert.equal(s2.awb, '7');            // numeric AWB coerced, not dropped
  assert.equal(s2.lifecycle, 'in_transit');
});

test('parseScanPushBatch accepts single, array and wrapped batches', () => {
  const one = { Shipment: { AWB: 'A', Status: { Status: 'Delivered', StatusType: 'DL' } } };
  assert.equal(parseScanPushBatch(one).length, 1);
  assert.equal(parseScanPushBatch([one, one]).length, 2);
  assert.equal(parseScanPushBatch({ Shipments: [one, one, one] }).length, 3);
  assert.deepEqual(parseScanPushBatch({}), []);          // empty body → no rows, no throw
});

test('tokenMatches is exact and rejects empties', () => {
  assert.equal(tokenMatches('abc123', 'abc123'), true);
  assert.equal(tokenMatches('abc123', 'abc124'), false);
  assert.equal(tokenMatches('abc', 'abc123'), false);    // length mismatch
  assert.equal(tokenMatches('', ''), false);             // unset token never authenticates
  assert.equal(tokenMatches(null, 'abc'), false);
  assert.equal(tokenMatches('abc', undefined), false);
});
