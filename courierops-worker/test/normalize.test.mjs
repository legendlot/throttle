import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDelhivery, TERMINAL_STAGES, istToUtc } from '../src/normalize.js';

// Delivered shipment (trimmed from the research brief, IST timestamps, microseconds).
const DELIVERED = {
  Scans: [
    { ScanDetail: { ScanDateTime: '2023-02-05T23:15:12.713000', ScanType: 'UD',
      Scan: 'Manifested', ScannedLocation: 'Chennai_Guindy_C (Tamil Nadu)',
      Instructions: 'Shipment details manifested', StatusCode: 'X-UCI' } },
    { ScanDetail: { ScanDateTime: '2023-02-15T12:18:25.002000', ScanType: 'DL',
      Scan: 'Delivered', ScannedLocation: 'Imphal_MnprUnvrsty_D (Manipur)',
      Instructions: 'Delivered to consignee', StatusCode: 'EOD-38' } },
  ],
  Status: { Status: 'Delivered', StatusLocation: 'Imphal_MnprUnvrsty_D (Manipur)',
    StatusDateTime: '2023-02-15T12:18:25.002000', StatusType: 'DL', StatusCode: 'EOD-38' },
  DeliveryDate: '2023-02-15T12:18:25.002000',
  ExpectedDeliveryDate: '2023-02-16T23:59:59',
  AWB: 'TESTAWB1',
};

test('istToUtc converts IST (no tz, microseconds) to UTC ISO', () => {
  // 12:18:25 IST == 06:48:25 UTC
  assert.equal(istToUtc('2023-02-15T12:18:25.002000'), '2023-02-15T06:48:25.002Z');
  assert.equal(istToUtc(null), null);
  assert.equal(istToUtc('garbage'), null);
});

test('delivered shipment → delivered stage, delivered_at, EDD, full timeline', () => {
  const r = normalizeDelhivery(DELIVERED);
  assert.equal(r.awb, 'TESTAWB1');
  assert.equal(r.stage, 'delivered');
  assert.equal(r.stage_label, 'Delivered');
  assert.equal(r.expected_delivery_date, '2023-02-16');
  assert.equal(r.delivered_at, '2023-02-15T06:48:25.002Z');
  assert.equal(r.checkpoints.length, 2);
  // newest-first
  assert.equal(r.checkpoints[0].stage, 'delivered');
  assert.equal(r.checkpoints[0].status_code, 'EOD-38');
  assert.equal(r.checkpoints[0].location, 'Imphal_MnprUnvrsty_D (Manipur)');
  assert.equal(r.checkpoints[1].stage, 'manifested');
});

test('in-transit (UD) shipment is non-terminal with no delivered_at', () => {
  const r = normalizeDelhivery({
    Scans: [{ ScanDetail: { ScanDateTime: '2023-02-06T14:35:08', ScanType: 'UD',
      Scan: 'In Transit', ScannedLocation: 'Gurgaon_Bilaspur_HB (Haryana)',
      Instructions: 'Shipment in transit', StatusCode: 'X-UCI' } }],
    Status: { Status: 'In Transit', StatusDateTime: '2023-02-06T14:35:08',
      StatusType: 'UD', StatusCode: 'X-UCI' },
    ExpectedDeliveryDate: '2023-02-16T23:59:59', AWB: 'TESTAWB2',
  });
  assert.equal(r.stage, 'in_transit');
  assert.equal(r.delivered_at, null);
  assert.ok(!TERMINAL_STAGES.includes(r.stage));
});
