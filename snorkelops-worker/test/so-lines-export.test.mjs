// Row shape of the Sales Orders LINE-LEVEL export ("Export + lines", Prarthi, #bugs 2026-09-11).
// buildSoLinesCsv lives in apps/snorkel/src/lib/soExport.js so it can be tested here, outside
// React/Next. The worker's getSalesOrderLinesBulk supplies `linesByOrder` + `partnerByOrder`.
// ⚠️ Every assertion reads cells by COLUMN NAME through a real CSV parse, never by a hard-coded
// index or a naive split(','): a header/row shift was a real bug (S370 PO export), and a naive
// split cannot see one caused by a quoted comma or newline.
// Run: node --test snorkelops-worker/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSoLinesCsv, SO_LINES_COLUMNS } from '../../apps/snorkel/src/lib/soExport.js';

// Minimal RFC-4180 parser: quoted fields, doubled quotes, commas and newlines inside quotes.
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  row.push(cell); rows.push(row);
  return rows;
}
const col = (name) => { const i = SO_LINES_COLUMNS.indexOf(name); assert.ok(i >= 0, name); return i; };

// getSalesOrders rows (sales_orders.* + partner_name flattened on). Numbers arrive as STRINGS.
const orders = [
  { id: 'o1', order_no: 'SO-0001', order_date: '2026-09-01', status: 'confirmed',
    partner_name: 'Toy World, Pune', partner_po_ref: 'BLK/PO/771', channel_key: 'MT',
    invoice_no: 'INV-0101', invoice_date: '2026-09-03' },
  { id: 'o2', order_no: 'SO-0002', order_date: '2026-09-05', status: 'draft',
    partner_name: 'The "Big" Store\nAndheri', partner_po_ref: null, channel_key: 'GT',
    invoice_no: null, invoice_date: null },
  { id: 'o3', order_no: 'SO-0003', order_date: '2026-09-06', status: 'cancelled',
    partner_name: 'No Lines Traders', partner_po_ref: 'X', channel_key: 'GT' },
];
const linesByOrder = {
  o1: [
    { order_id: 'o1', product: 'Shadow', model: 'Pro', color: 'Black', sku: 'SH-PRO-BK',
      hsn_code: '9503', description: 'RC car, 1:16', qty: 12, rate: '1234.50', discount_pct: '0',
      taxable_value: '14814.00', gst_pct: '18', gst_amount: '2666.52', line_total: '17480.52' },
    { order_id: 'o1', product: 'Flare', model: '', color: 'Red', sku: null, hsn_code: '9503',
      description: null, qty: 3, rate: '999', discount_pct: '5.5', taxable_value: '2832.17',
      gst_pct: '18', gst_amount: '509.79', line_total: '3341.96' },
  ],
  o2: [
    { order_id: 'o2', product: 'Universal', model: null, color: null, sku: 'UNV-1',
      hsn_code: null, description: 'Charger "fast", 2A', qty: 1, rate: null, discount_pct: null,
      taxable_value: null, gst_pct: null, gst_amount: null, line_total: null },
  ],
};
const partnerByOrder = {
  o1: { partner_code: 'P-TW01', gstin: '27ABCDE1234F1Z5' },
  o2: { partner_code: 'P-BS02', gstin: null },
  o3: { partner_code: 'P-NL03', gstin: '27ZZZZZ9999Z1Z9' },
};

test('every row has exactly as many cells as the header, even with commas/quotes/newlines', () => {
  const csv = buildSoLinesCsv({ filteredRows: orders, linesByOrder, partnerByOrder });
  const rows = parseCsv(csv);
  assert.deepEqual(rows[0], SO_LINES_COLUMNS);
  assert.equal(rows.length - 1, 3);                  // 2 lines on o1 + 1 on o2; o3 has none
  for (const r of rows) assert.equal(r.length, SO_LINES_COLUMNS.length);
});

test('header context lands under the right header on every line', () => {
  const rows = parseCsv(buildSoLinesCsv({ filteredRows: orders, linesByOrder, partnerByOrder }));
  const [a, b, c] = rows.slice(1);
  for (const r of [a, b]) {
    assert.equal(r[col('Order')], 'SO-0001');
    assert.equal(r[col('Order Date')], '2026-09-01');
    assert.equal(r[col('Status')], 'Confirmed');
    assert.equal(r[col('Partner')], 'Toy World, Pune');
    assert.equal(r[col('Partner Code')], 'P-TW01');
    assert.equal(r[col('Partner GSTIN')], '27ABCDE1234F1Z5');
    assert.equal(r[col('Partner PO Ref')], 'BLK/PO/771');
    assert.equal(r[col('Channel')], 'MT');
    assert.equal(r[col('Invoice')], 'INV-0101');
    assert.equal(r[col('Invoice Date')], '2026-09-03');
  }
  assert.deepEqual([a[col('Line No')], b[col('Line No')]], ['1', '2']);
  assert.equal(a[col('Product')], 'Shadow');
  assert.equal(a[col('Model')], 'Pro');
  assert.equal(a[col('Colour')], 'Black');
  assert.equal(a[col('SKU')], 'SH-PRO-BK');
  assert.equal(a[col('HSN')], '9503');
  assert.equal(a[col('Description')], 'RC car, 1:16');
  // Blank-able header fields render BLANK, never "null"/"undefined".
  assert.equal(c[col('Partner PO Ref')], '');
  assert.equal(c[col('Partner GSTIN')], '');
  assert.equal(c[col('Invoice')], '');
  assert.equal(c[col('Status')], 'Draft');
  assert.ok(!/null|undefined/.test(rows.flat().join('|')));
});

test('quotes and newlines in a partner name survive the round trip intact', () => {
  const csv = buildSoLinesCsv({ filteredRows: orders, linesByOrder, partnerByOrder });
  const r = parseCsv(csv)[3];
  assert.equal(r[col('Partner')], 'The "Big" Store\nAndheri');
  assert.equal(r[col('Description')], 'Charger "fast", 2A');
  assert.match(csv, /"The ""Big"" Store\nAndheri"/);  // RFC-4180 on the wire
});

test('numeric strings from PostgREST come out as numbers; 0 stays 0, null stays blank', () => {
  const rows = parseCsv(buildSoLinesCsv({ filteredRows: orders, linesByOrder, partnerByOrder }));
  const [a, b, c] = rows.slice(1);
  assert.equal(a[col('Qty')], '12');
  assert.equal(a[col('Rate')], '1234.5');
  assert.equal(a[col('Discount %')], '0');           // a genuine zero, not blank
  assert.equal(a[col('Taxable Value')], '14814');
  assert.equal(a[col('GST %')], '18');
  assert.equal(a[col('GST Amount')], '2666.52');
  assert.equal(a[col('Line Total')], '17480.52');
  assert.equal(b[col('Discount %')], '5.5');
  for (const k of ['Rate', 'Discount %', 'Taxable Value', 'GST %', 'GST Amount', 'Line Total'])
    assert.equal(c[col(k)], '', k);                  // unknown is blank, never 0
});

test('only the client-filtered orders are exported, in the client order', () => {
  const csv = buildSoLinesCsv({ filteredRows: [orders[1], orders[0]], linesByOrder, partnerByOrder });
  const rows = parseCsv(csv).slice(1);
  assert.deepEqual(rows.map(r => r[col('Order')]), ['SO-0002', 'SO-0001', 'SO-0001']);
  const one = parseCsv(buildSoLinesCsv({ filteredRows: [orders[0]], linesByOrder, partnerByOrder }));
  assert.equal(one.length - 1, 2);
});

test('an order missing from the worker maps renders blank partner code/GSTIN and no lines', () => {
  const csv = buildSoLinesCsv({ filteredRows: orders, linesByOrder: { o1: linesByOrder.o1 } });
  const rows = parseCsv(csv).slice(1);
  assert.equal(rows.length, 2);
  assert.equal(rows[0][col('Partner Code')], '');
  assert.equal(rows[0][col('Partner GSTIN')], '');
  assert.equal(buildSoLinesCsv({ filteredRows: [] }), SO_LINES_COLUMNS.join(','));
});
