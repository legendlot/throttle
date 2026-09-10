// The China/Soft gate and the row shape of the PO LINE-LEVEL export are pure functions lifted
// into apps/snorkel/src/lib/poExport.js precisely so they can be tested here, outside React/Next.
// snorkelops-worker's `getPOLinesBulk` holds an INLINE copy of the same gate (the worker is a
// zero-import single file and cannot import out of apps/) — these tests are the spec both sides
// must satisfy. Run: node --test snorkelops-worker/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatePoLines, buildPoLinesCsv, PO_LINES_COLUMNS } from '../../apps/snorkel/src/lib/poExport.js';

const headers = [
  { po_number: 'IN-PRD-0001', status: 'Approved', source: 'India', revision: 1,
    order_type: 'Product', vendor_name: 'Acme Ltd', vendor_code: 'V001', expected_delivery: '2026-09-20' },
  { po_number: 'CN-PRD-0002', status: 'Sent', source: 'China', revision: 0,
    order_type: 'Product', vendor_name: 'MJ Toys', vendor_code: 'V002', expected_delivery: '2026-10-01' },
  { po_number: 'CN-SOFT-0003', status: 'Soft', source: 'China', revision: 0,
    order_type: 'Product', vendor_name: 'MJ Toys', vendor_code: 'V002', expected_delivery: null },
];
const headersByPo = Object.fromEntries(headers.map(h => [h.po_number, h]));

const lines = [
  { po_number: 'IN-PRD-0001', line_no: 1, part_code: 'SH-PB-46', description: 'Shadow top',
    product: 'Shadow', variant: 'Black', color: 'Black', qty_ordered: 100, qty_received: 0,
    unit: 'pcs', unit_price: 120, total_value: 12000, hsn_code: '9503', gst_percent: 18 },
  { po_number: 'CN-PRD-0002', line_no: 1, part_code: 'UNV-RC-500-01', description: '500 mAh cell',
    product: 'Universal', variant: '', color: '', qty_ordered: 200, qty_received: 200,
    unit: 'pcs', unit_price: 42.5, total_value: 8500, hsn_code: '8507', gst_percent: 18 },
  { po_number: 'CN-PRD-0002', line_no: 2, part_code: 'UNV-AU-AA-01', description: 'AA battery',
    product: 'Universal', variant: '', color: '', qty_ordered: 400, qty_received: 0,
    unit: 'pcs', unit_price: 8, total_value: 3200, hsn_code: '8506', gst_percent: 18 },
  { po_number: 'CN-SOFT-0003', line_no: 1, part_code: 'FL-PB-90', description: 'Flare bottom',
    product: 'Flare', variant: 'Red', color: 'Red', qty_ordered: 50, qty_received: 0,
    unit: 'pcs', unit_price: 300, total_value: 15000, hsn_code: '9503', gst_percent: 18 },
];

test('a Soft PO is completely absent without po_china, and present with it', () => {
  const restricted = gatePoLines({ lines, headersByPo, canChina: false });
  assert.equal(restricted.filter(l => l.po_number === 'CN-SOFT-0003').length, 0);

  const full = gatePoLines({ lines, headersByPo, canChina: true });
  assert.equal(full.filter(l => l.po_number === 'CN-SOFT-0003').length, 1);
  assert.equal(full.length, lines.length);
});

test("a China PO's lines are returned without po_china, but carry no unit_price/total_value", () => {
  const out = gatePoLines({ lines, headersByPo, canChina: false })
    .filter(l => l.po_number === 'CN-PRD-0002');
  assert.equal(out.length, 2);                       // the lines themselves are NOT hidden
  for (const l of out) {
    assert.equal('unit_price' in l, false);          // absent, not zeroed — a zero reads as free
    assert.equal('total_value' in l, false);
    assert.equal(l.part_code.length > 0, true);      // everything else survives
    assert.equal(l.qty_ordered > 0, true);
  }
});

test("a China PO's lines are untouched with po_china", () => {
  const out = gatePoLines({ lines, headersByPo, canChina: true })
    .filter(l => l.po_number === 'CN-PRD-0002');
  assert.deepEqual(out.map(l => l.unit_price), [42.5, 8]);
  assert.deepEqual(out.map(l => l.total_value), [8500, 3200]);
});

test('an ordinary India PO is untouched in both cases', () => {
  for (const canChina of [true, false]) {
    const out = gatePoLines({ lines, headersByPo, canChina })
      .filter(l => l.po_number === 'IN-PRD-0001');
    assert.equal(out.length, 1);
    assert.equal(out[0].unit_price, 120);
    assert.equal(out[0].total_value, 12000);
  }
});

test('a line whose PO has no header is dropped — deny is the fail-safe on a gate', () => {
  const orphan = [{ po_number: 'XX-UNKNOWN-9999', line_no: 1, unit_price: 999 }];
  assert.deepEqual(gatePoLines({ lines: orphan, headersByPo, canChina: false }), []);
  assert.deepEqual(gatePoLines({ lines: orphan, headersByPo, canChina: true }), []);
});

// ── CSV shape ────────────────────────────────────────────────────────────────
function linesByPoFrom(gated) {
  const by = {};
  for (const l of gated) (by[l.po_number] ||= []).push(l);
  return by;
}

test('one CSV row per line, and China rows render the Restricted marker not a number', () => {
  const canChina = false;
  const gated = gatePoLines({ lines, headersByPo, canChina });
  // filteredRows is the client list: getPOs would already have dropped the Soft PO too.
  const filteredRows = headers.filter(h => h.status !== 'Soft');
  const csv = buildPoLinesCsv({ filteredRows, linesByPo: linesByPoFrom(gated), canChina });
  const rows = csv.split('\n');

  assert.equal(rows[0], PO_LINES_COLUMNS.join(','));
  assert.equal(rows.length - 1, 3);                  // 1 India line + 2 China lines, no Soft line

  const priceIdx = PO_LINES_COLUMNS.indexOf('Unit Price');
  const totalIdx = PO_LINES_COLUMNS.indexOf('Total Value');
  const india = rows[1].split(',');
  assert.equal(india[0], 'IN-PRD-0001');
  assert.equal(india[priceIdx], '120');
  assert.equal(india[totalIdx], '12000');
  for (const r of [rows[2], rows[3]]) {
    const c = r.split(',');
    assert.equal(c[0], 'CN-PRD-0002');
    assert.equal(c[priceIdx], 'Restricted');
    assert.equal(c[totalIdx], 'Restricted');
  }
});

test('with po_china the CSV carries every line and the real numbers', () => {
  const canChina = true;
  const gated = gatePoLines({ lines, headersByPo, canChina });
  const csv = buildPoLinesCsv({ filteredRows: headers, linesByPo: linesByPoFrom(gated), canChina });
  const rows = csv.split('\n');
  assert.equal(rows.length - 1, 4);
  const priceIdx = PO_LINES_COLUMNS.indexOf('Unit Price');
  assert.deepEqual(rows.slice(1).map(r => r.split(',')[priceIdx]), ['120', '42.5', '8', '300']);
  // The Soft PO's line is in the file, with its PO number and status intact.
  const soft = rows[4].split(',');
  assert.equal(soft[0], 'CN-SOFT-0003');
  assert.equal(soft[PO_LINES_COLUMNS.indexOf('Status')], 'Soft');
});

test('a comma in a description is quoted, not allowed to shift the columns', () => {
  const canChina = true;
  const trick = [{ po_number: 'IN-PRD-0001', line_no: 1, description: 'Top, Black, glossy',
                   unit_price: 5, total_value: 50 }];
  const csv = buildPoLinesCsv({
    filteredRows: [headersByPo['IN-PRD-0001']],
    linesByPo: { 'IN-PRD-0001': trick }, canChina,
  });
  assert.match(csv.split('\n')[1], /"Top, Black, glossy"/);
});
