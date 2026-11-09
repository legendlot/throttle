// Import PO — the browser-side parsers (apps/snorkel/src/lib/poImport), on TEXT fixtures cut from
// Harsh's sample POs (#bugs 1794224462.796779). The PDF fixtures are itemsToLines() output from
// pdf.js on page 1 (exactly what extract.js hands the parsers), the xlsx ones are worksheetRows()
// from exceljs; both trimmed to header + item rows + totals, phones/emails/POC name replaced.
// The raw PDFs/xlsx are NOT committed — they carry buyer contacts.
// Run: node --test snorkelops-worker/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parsePurchaseOrder, detectBuyer } from '../../apps/snorkel/src/lib/poImport/index.js';
import { itemsToLines } from '../../apps/snorkel/src/lib/poImport/lines.js';
import { isoDate, num } from '../../apps/snorkel/src/lib/poImport/common.js';
import { initialFromPreview, afterImportLineEdit, importLineProblems } from '../../apps/snorkel/src/lib/poImport/form.js';

const FX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/po-import');
const pdf = name => ({ kind: 'pdf', lines: readFileSync(join(FX, name), 'utf8').replace(/\n$/, '').split('\n') });
const xlsx = name => ({ kind: 'xlsx', rows: JSON.parse(readFileSync(join(FX, name), 'utf8')) });
const sum = ls => Math.round(ls.reduce((s, l) => s + l.qty * l.unit_cost_ex_gst, 0) * 100) / 100;

test('Zepto P6150806: header, ship-to, both lines, the wrapped SKU UUID reassembled', () => {
  const ex = pdf('zepto-P6150806.txt');
  assert.equal(detectBuyer(ex), 'zepto');
  const po = parsePurchaseOrder(ex);
  assert.equal(po.error, undefined);
  assert.equal(po.channel_key, 'ZEPTO');
  assert.equal(po.po_no, 'P6150806');
  assert.deepEqual([po.po_date, po.delivery_date, po.expiry_date], ['2026-11-05', '2026-11-06', '2026-12-12']);
  assert.equal(po.ship_to_gstin, '27AAICK4821A1ZV');
  assert.equal(po.ship_to_pincode, '421302');
  assert.match(po.ship_to_address, /MUM-SS-MH-SHAKTI \(MUM175M\)/);
  assert.doesNotMatch(po.ship_to_address, /29AAFCF7834H1ZA|Horamavu/, 'our own vendor block is not the ship-to');
  assert.equal(po.lines.length, 2);
  assert.deepEqual(po.lines.map(l => l.channel_code), ['05285852-99e0-4b15-8ce1-d8dc026e4bf4', '125e53c2-3c24-423d-8388-4ff47200d1ac']);
  assert.deepEqual(po.lines.map(l => l.ean), ['5949999234230', '5949998500299']);
  assert.deepEqual(po.lines.map(l => [l.qty, l.unit_cost_ex_gst, l.mrp, l.gst_pct, l.taxable]), [[12, 1203.86, 3999, 18, 14446.27], [24, 1203.86, 3999, 18, 28892.54]]);
  assert.equal(po.lines[0].title, 'Legend of Toys Shadow Remote Control Drift Car 20Kmph 2.4Ghz | LED Lights Asphalt Black - 1 pc');
  assert.equal(po.lines[1].title, 'Legend of Toys Shadow Remote Control Drifting Car | 20Kmph 2.4Ghz | Multi Mode | Black - 1 pc');
  assert.equal(po.po_total_taxable, 43338.81);
  assert.equal(po.po_grand_total, 51139.8);
  assert.deepEqual(po.warnings, []);
});

test('Zepto: a UUID count that does not match the rows → no codes at all (EAN fallback), with a warning', () => {
  const ex = pdf('zepto-P6150806.txt');
  ex.lines = ex.lines.filter(l => !/^8388-4ff47200d1ac$/.test(l.trim()));   // lose half of line 2's UUID
  const po = parsePurchaseOrder(ex);
  assert.deepEqual(po.lines.map(l => l.channel_code), [null, null]);
  assert.ok(po.lines.every(l => l.ean));
  assert.match(po.warnings.join(' '), /matching on EAN instead/);
});

test('Instamart (Scootsy) CMFPO377563 Mumbai FC22', () => {
  const ex = pdf('instamart-CMFPO377563.txt');
  assert.equal(detectBuyer(ex), 'instamart');
  const po = parsePurchaseOrder(ex);
  assert.equal(po.channel_key, 'INSTAMART');
  assert.equal(po.po_no, 'CMFPO377563');
  assert.deepEqual([po.po_date, po.delivery_date, po.expiry_date], ['2026-10-30', '2026-11-14', '2026-11-16']);
  assert.deepEqual([po.bill_to_gstin, po.ship_to_gstin], ['27AAVCS1691R1Z5', '27AAVCS1691R1Z5']);
  assert.deepEqual([po.ship_to_city, po.ship_to_pincode], ['Mumbai', '421302']);
  assert.match(po.ship_to_address, /^SCOOTSY LOGISTICS PRIVATE LIMITED, MUM FC22, Survey No\.26,27,28 C1 Building/);
  assert.doesNotMatch(po.ship_to_address, /@|9000000000/, 'emails / contact lines skipped');
  assert.equal(po.lines.length, 1);
  const l = po.lines[0];
  assert.deepEqual([l.channel_code, l.ean, l.hsn, l.qty, l.mrp, l.unit_cost_ex_gst, l.gst_pct, l.taxable], ['140019', null, '95030090', 36, 3499, 1135.09932, 18, 40863.58]);
  assert.equal(l.title, 'L.O.T Cars Ghost RC Drift Car (20Kmph, LED Lights, Underground White) 1.00 Piece');
  assert.equal(po.po_total_taxable, 40863.58);
  assert.equal(po.po_grand_total, 48219.02);
  assert.ok(Math.abs(sum(po.lines) - po.po_total_taxable) < 0.01);
});

test('Instamart (Scootsy) KOCPO162032 Kochi IM1 — same layout, different FC', () => {
  const po = parsePurchaseOrder(pdf('instamart-KOCPO162032.txt'));
  assert.equal(po.po_no, 'KOCPO162032');
  assert.deepEqual([po.po_date, po.delivery_date, po.expiry_date], ['2026-11-05', '2026-11-20', '2026-11-22']);
  assert.equal(po.ship_to_gstin, '32AAVCS1691R1ZE');
  assert.deepEqual([po.ship_to_city, po.ship_to_pincode], ['Kochi', '683503']);
  assert.deepEqual(po.lines.map(l => [l.channel_code, l.qty, l.unit_cost_ex_gst, l.gst_pct]), [['646970', 36, 1134.71542, 18]]);
  assert.equal(po.lines[0].title, 'L.O.T Cars Fang 6- Channel RC Excavator Toy 1.00 pack');
  assert.equal(po.po_total_taxable, 40849.76);
});

test('Flipkart Minutes FLSHM4VFE4XN (Anekal, intra-state): GST-inclusive unit price → ex-GST via taxable ÷ qty', () => {
  const ex = xlsx('flipkart-FLSHM4VFE4XN.json');
  assert.equal(detectBuyer(ex), 'flipkart');
  const po = parsePurchaseOrder(ex);
  assert.equal(po.channel_key, 'FLIPKART_MGD');
  assert.equal(po.po_no, 'FLSHM4VFE4XN');
  assert.deepEqual([po.po_date, po.expiry_date, po.delivery_date], ['2026-10-11', '2026-11-15', null]);   // dd/mm/yyyy
  assert.deepEqual([po.bill_to_gstin, po.ship_to_gstin, po.ship_to_pincode], ['29AABCF8078M1ZX', '29AABCF8078M1ZX', '562106']);
  assert.match(po.ship_to_address, /Anekal taluk/);
  assert.equal(po.lines.length, 1);
  const l = po.lines[0];
  assert.deepEqual([l.channel_code, l.ean, l.qty, l.mrp, l.gst_pct, l.taxable, l.hsn], ['RCTHK8ATQPC2MQPA', null, 60, 3499, 18, 74694.91, '95030090']);
  assert.ok(Math.abs(l.unit_cost_ex_gst - 1244.9152) < 0.0001, 'NOT the 1469.00 GST-inclusive Supplier Unit Price');
  assert.equal(l.title, 'L.O.T CARS_Burnout Yellow_Drifting Car');
  assert.equal(po.po_total_taxable, 74694.91);
  assert.equal(po.po_grand_total, 88140);
});

test('Flipkart National FLSJD88U0HRZ (Bhiwandi WE-II, inter-state): six lines, IGST, EAN where printed', () => {
  const po = parsePurchaseOrder(xlsx('flipkart-FLSJD88U0HRZ.json'));
  assert.equal(po.po_no, 'FLSJD88U0HRZ');
  assert.deepEqual([po.po_date, po.expiry_date], ['2026-10-18', '2026-11-11']);
  assert.deepEqual([po.ship_to_gstin, po.ship_to_pincode], ['27AABCF8078M1Z1', '421302']);
  assert.deepEqual(po.lines.map(l => l.channel_code), ['RCTHJH5PSQGYXE7E', 'RCTHK8ATUGJTYZFF', 'RCTHJGH9UAM8PZDG', 'RCTHJFY5QFDXRS4Q', 'RCTHK8CFRKRGXXMG', 'RCTHK8CFEH2HH3W4']);
  assert.deepEqual(po.lines.map(l => l.qty), [18, 45, 6, 6, 9, 16]);   // Quantity, not Pending Quantity (0 on line 1)
  assert.deepEqual(po.lines.map(l => l.ean), [null, '5949998487842', null, null, null, null]);
  assert.ok(po.lines.every(l => l.gst_pct === 18));
  assert.equal(po.po_total_taxable, 128910.34);
  // The six printed line taxables sum to 128,910.36 — Flipkart's own paise rounding, inside the ₹1 checksum.
  assert.ok(Math.abs(sum(po.lines) - po.po_total_taxable) < 0.05);
});

test('unknown buyer / wrong kind → unsupported, never a guess', () => {
  assert.equal(detectBuyer({ kind: 'pdf', lines: ['PURCHASE ORDER', 'Zippycubs Pvt Ltd'] }), null);
  assert.equal(parsePurchaseOrder({ kind: 'pdf', lines: ['Some other buyer'] }).unsupported, true);
  // A Flipkart-looking PDF is not the Flipkart (xlsx) layout.
  assert.equal(detectBuyer({ kind: 'pdf', lines: ['FLIPKART INDIA PRIVATE LIMITED'] }), null);
});

test('itemsToLines: one row per baseline (0.4pt jitter tolerated), wrapped cells kept apart, blank items dropped', () => {
  const it = (str, x, y, w = 10, h = 6) => ({ str, transform: [h, 0, 0, h, x, y], width: w, height: h });
  const lines = itemsToLines([
    it('8ce1-d8dc026e4bf4', 219, 328.8, 47),
    it('12', 372.5, 332.2, 6), it('1', 37.7, 332.2, 3), it('96747869', 71.6, 332.2, 24),
    it('28892.54', 462.8, 332.6, 22),
    it(' ', 40, 332.2, 1798),
    it('05285852-99e0-4b15-', 216, 335.7, 53),
  ]);
  assert.deepEqual(lines, ['05285852-99e0-4b15-', '1  96747869  12  28892.54', '8ce1-d8dc026e4bf4']);
});

test('date + number helpers', () => {
  assert.equal(isoDate('Oct 30, 2026'), '2026-10-30');
  assert.equal(isoDate('Nov 5, 2026'), '2026-11-05');
  assert.equal(isoDate('15/11/2026'), '2026-11-15');
  assert.equal(isoDate('2026-12-12'), '2026-12-12');
  assert.equal(isoDate('31/02/20'), null);
  assert.equal(isoDate(new Date(Date.UTC(2026, 10, 9))), '2026-11-09');
  assert.equal(num('1,469.00 (INR)'), 1469);
  assert.equal(num('18.00 %'), 18);
  assert.equal(num(''), null, 'a blank cell is not a zero price');
});

// ── hostile review 2026-11-09 ──
test('Flipkart: Pending Quantity parsed; "X of Y already supplied" warned per line', () => {
  const po = parsePurchaseOrder(xlsx('flipkart-FLSJD88U0HRZ.json'));
  assert.deepEqual(po.lines.map(l => l.pending_qty), [0, 45, 6, 2, 9, 16]);
  assert.deepEqual(po.warnings.filter(w => /already supplied/.test(w)), [
    'Line 1 (RCTHJH5PSQGYXE7E): 18 of 18 already supplied on this PO — 0 still pending.',
    'Line 4 (RCTHJFY5QFDXRS4Q): 4 of 6 already supplied on this PO — 2 still pending.',
  ]);
  const minutes = parsePurchaseOrder(xlsx('flipkart-FLSHM4VFE4XN.json'));
  assert.deepEqual(minutes.lines.map(l => l.pending_qty), [60]);
  assert.equal(minutes.warnings.length, 0);
});

test('Flipkart: rate × (1 + GST%) is cross-checked against the printed Supplier Unit Price (the taxable checksum is circular here)', () => {
  const clean = parsePurchaseOrder(xlsx('flipkart-FLSJD88U0HRZ.json'));
  assert.equal(clean.warnings.filter(w => /Supplier Unit Price/.test(w)).length, 0, 'all six samples agree within ₹1');
  const ex = xlsx('flipkart-FLSHM4VFE4XN.json');
  const row = ex.rows.find(r => r[2] === 'RCTHK8ATQPC2MQPA');
  const col = ex.rows.find(r => r.includes('Supplier Unit Price')).indexOf('Supplier Unit Price');
  row[col] = '1499.00 (INR)';                       // a price that does not fit Taxable ÷ Qty + 18%
  const po = parsePurchaseOrder(ex);
  assert.match(po.warnings.join(' '), /Line 1 \(RCTHK8ATQPC2MQPA\): ₹1244\.92 \+ 18% GST ≠ the PO's Supplier Unit Price ₹1499/);
});

const PV = (over = {}) => ({
  channel_key: 'FLIPKART_MGD', po: { po_no: 'FLSJD88U0HRZ', po_date: '2026-10-18', delivery_date: null, expiry_date: '2026-11-11' },
  duplicate_of: [],
  lines: [
    { channel_code: 'RCTHJH5PSQGYXE7E', qty: 18, pending_qty: 0, rate: 1304.49, product: 'Shadow', model: 'Asphalt', color: 'Black', sku: 'shadow-asphalt-black', matched: true, code_mapped: true, gst_pct: 18 },
    { channel_code: 'RCTHK8ATUGJTYZFF', qty: 45, pending_qty: 30, rate: 1185.85, product: 'Ghost', model: 'Underground', color: 'Black', sku: 'ghost-underground-black', matched: true, code_mapped: true, gst_pct: 18 },
    { channel_code: 'NEWCODE', qty: 6, pending_qty: 6, rate: null, matched: false, code_mapped: false, gst_pct: 18 },
    { channel_code: 'CONFLICT', qty: 2, pending_qty: 2, rate: 10, matched: false, code_mapped: true, gst_pct: 18 },
  ],
  ...over,
});

test('initialFromPreview: PO quantities normally; on a duplicate, pending quantities with fully-supplied lines left off and listed', () => {
  const a = initialFromPreview(PV(), { id: 'p1', channel_key: 'FLIPKART_MGD', default_credit_days: 90 }, '2026-11-09');
  assert.deepEqual(a.initial.lines.map(l => l.qty), [18, 45, 6, 2]);
  assert.equal(a.usedPending, false);
  assert.equal(a.initial.credit_days, 90);
  const b = initialFromPreview(PV({ duplicate_of: ['SO-0901'] }), { id: 'p1', channel_key: 'FLIPKART_MGD' }, '2026-11-09');
  assert.deepEqual(b.initial.lines.map(l => [l._import.channel_code, l.qty]), [['RCTHK8ATUGJTYZFF', 30], ['NEWCODE', 6], ['CONFLICT', 2]]);
  assert.equal(b.usedPending, true);
  assert.deepEqual(b.skippedPending.map(l => l.channel_code), ['RCTHJH5PSQGYXE7E']);
  assert.deepEqual([b.initial.partner_po_ref, b.initial.order_date, b.initial.credit_days], ['FLSJD88U0HRZ', '2026-10-18', 45]);
});

test('initialFromPreview: a blank price stays blank (not ₹0); learn only codes with no sku_map row', () => {
  const { initial } = initialFromPreview(PV(), null, '2026-11-09');
  const byCode = Object.fromEntries(initial.lines.map(l => [l._import.channel_code, l]));
  assert.equal(byCode.NEWCODE.rate, '');
  assert.equal(byCode.NEWCODE._import.learn, true);
  assert.equal(byCode.CONFLICT._import.learn, false, 'code/barcode conflict: the code is already mapped — never learned over');
  assert.equal(byCode.RCTHK8ATUGJTYZFF._import.learn, false);
});

test('afterImportLineEdit: changing product / model / colour on an imported line clears the pre-filled SKU', () => {
  const line = { product: 'Ghost', model: 'Underground', color: 'Black', sku: 'ghost-underground-black', _import: { matched: true } };
  for (const k of ['product', 'model', 'color']) assert.equal(afterImportLineEdit({ ...line, [k]: 'X' }, k).sku, '', k);
  assert.equal(afterImportLineEdit({ ...line, qty: 3 }, 'qty').sku, 'ghost-underground-black');
  assert.equal(afterImportLineEdit({ ...line, _import: undefined, product: 'X' }, 'product').sku, 'ghost-underground-black', 'hand-entered lines unchanged');
});

test('importLineProblems: an imported line with rate ≤ 0 / blank or qty ≤ 0 blocks Save in plain words', () => {
  const imp = { _import: {} };
  assert.deepEqual(importLineProblems({ ...imp, qty: 5, rate: 100 }), []);
  assert.match(importLineProblems({ ...imp, qty: 5, rate: '' }).join(), /rate above ₹0/);
  assert.match(importLineProblems({ ...imp, qty: 5, rate: 0 }).join(), /rate above ₹0/);
  assert.match(importLineProblems({ ...imp, qty: 0, rate: 10 }).join(), /quantity above 0/);
  assert.deepEqual(importLineProblems({ qty: 0, rate: 0 }), [], "hand-entered lines keep the form's own rules");
});

test('OrderForm wiring: imported lines run afterImportLineEdit + importLineProblems', () => {
  const f = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../apps/snorkel/src/app/(auth)/sales/orders/OrderForm.js'), 'utf8');
  assert.match(f, /if \(next\._import\) return afterImportLineEdit\(next, k\);/);
  assert.match(f, /if \(l\._import\) miss\.push\(\.\.\.importLineProblems\(l\)\);/);
  assert.match(f, /const started = l\.product \|\| Number\(l\.qty\) > 0 \|\| l\._import;/);
});
