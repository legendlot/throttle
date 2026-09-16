// The purchase-unit factor rules (normPurchaseUnit / piecesFactor / perPiecePreview) are pure and
// live only in the single-file worker (no named exports), so — like prior-tds.test.mjs — this test
// lifts their source text straight out of index.js.
// ⚠️ These helpers are the worker's copy of the rules inside store.derive_unit_costs; they drive
// the page preview only. A change to the SQL function's factor rules must land here too, and this
// test is what catches the preview drifting away from the write.
// Run: node --test snorkelops-worker/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/index.js'), 'utf8');
const lift = (start, end) => { const i = src.indexOf(start); assert.ok(i >= 0, `missing ${start}`); const j = src.indexOf(end, i); assert.ok(j > i, `no end for ${start}`); return src.slice(i, j); };
const code = [
  lift('function normPurchaseUnit(', '\n// Map shipment.status'),
  'return { normPurchaseUnit, piecesFactor, perPiecePreview, summariseDerivation, validPieces, pickConvertibleLine, byNewestPo, MAX_PIECES_PER_UOM };',
].join('\n');
const { normPurchaseUnit, piecesFactor, perPiecePreview, summariseDerivation,
        validPieces, pickConvertibleLine, byNewestPo, MAX_PIECES_PER_UOM } = new Function(code)();

// PostgREST hands every numeric back as a STRING — the fixtures do too, deliberately.
const shrink = { part_code: 'UNV-PP-SHRINK-1418-01', weight_per_unit_grams: null,
                 purchase_uom: 'Roll', pieces_per_purchase_uom: '2200' };
const screw  = { part_code: 'HW-SC-23-8', weight_per_unit_grams: '0.35',
                 purchase_uom: null, pieces_per_purchase_uom: null };

test('unit normalisation: trimmed and lower-cased, null/undefined → empty string', () => {
  assert.equal(normPurchaseUnit(' Roll '), 'roll');
  assert.equal(normPurchaseUnit('PCS'), 'pcs');
  assert.equal(normPurchaseUnit('  KG\t'), 'kg');
  assert.equal(normPurchaseUnit(null), '');
  assert.equal(normPurchaseUnit(undefined), '');
  assert.equal(normPurchaseUnit('   '), '');
});

test('pcs is always factor 1, whatever the part carries — and case/space do not matter', () => {
  assert.equal(piecesFactor('pcs', screw), 1);
  assert.equal(piecesFactor(' PCS ', shrink), 1);
});

test('kg converts through weight_per_unit_grams (RULE-014), never through a stored conversion', () => {
  // 0.35 g screw → 1 kg is 2,857.14 pieces
  assert.equal(piecesFactor('kg', screw), 1000 / 0.35);
  assert.equal(piecesFactor(' KG ', screw), 1000 / 0.35);
});

test('kg WITHOUT a weight is not convertible → null, never a guessed factor', () => {
  assert.equal(piecesFactor('kg', { ...screw, weight_per_unit_grams: null }), null);
  assert.equal(piecesFactor('kg', { ...screw, weight_per_unit_grams: '0' }), null);
  assert.equal(piecesFactor('kg', { ...screw, weight_per_unit_grams: 'n/a' }), null);
  // a stored Roll conversion must NOT be borrowed for a kg line
  assert.equal(piecesFactor('kg', shrink), null);
});

test('a line unit matching purchase_uom takes pieces_per_purchase_uom (string numeric included)', () => {
  assert.equal(piecesFactor('Roll', shrink), 2200);
  assert.equal(piecesFactor(' roll ', shrink), 2200);
  assert.equal(piecesFactor('roll', { ...shrink, pieces_per_purchase_uom: 2200 }), 2200);
});

test('a NON-matching unit is not a candidate → null (packets ≠ roll, and no conversion at all)', () => {
  assert.equal(piecesFactor('packets', shrink), null);
  assert.equal(piecesFactor('mtrs', screw), null);
  assert.equal(piecesFactor('roll', { ...shrink, purchase_uom: null }), null);
  assert.equal(piecesFactor('roll', { ...shrink, pieces_per_purchase_uom: null }), null);
  assert.equal(piecesFactor('roll', { ...shrink, pieces_per_purchase_uom: '0' }), null);
  assert.equal(piecesFactor('', shrink), null);
  assert.equal(piecesFactor(null, shrink), null);
});

test('preview: the pass-condition value — ₹5,040 a Roll of 2,200 → ₹2.2909 a piece, at 4 dp', () => {
  assert.equal(perPiecePreview('5040', piecesFactor('Roll', shrink)), 2.2909);
  // 2 dp would round a sticker-class value to ₹0.00, which is why this is 4
  assert.equal(perPiecePreview('999', 2857.142857142857), 0.3497);
});

test('preview refuses a non-price or a non-factor rather than returning 0 or Infinity', () => {
  assert.equal(perPiecePreview(0, 1), null);
  assert.equal(perPiecePreview('', 1), null);
  assert.equal(perPiecePreview(null, 1), null);
  assert.equal(perPiecePreview('abc', 1), null);
  assert.equal(perPiecePreview(100, null), null);
  assert.equal(perPiecePreview(100, 0), null);
});

test('derivation summary counts every v4 refusal, price_spread and sub_paisa included', () => {
  const rows = [
    { part_code: 'A', applied: true,  reason: 'applied' },
    { part_code: 'B', applied: false, reason: 'family_outlier' },
    { part_code: 'C', applied: false, reason: 'category_absolute' },
    { part_code: 'D', applied: false, reason: 'mixed_moulds' },
    { part_code: 'E', applied: false, reason: 'price_spread' },   // live today on VE-PP-01
    { part_code: 'F', applied: false, reason: 'sub_paisa' },      // new in v4
    { part_code: 'G', applied: false, reason: 'unchanged' },
  ];
  assert.deepEqual(summariseDerivation(rows), { applied: 1, rejected: 5, unchanged: 1, evaluated: 7 });
  // v4 returns NO row for a part with no candidate line, so `evaluated` is the parts that had
  // one — a caller can never read it as "the parts I asked for".
  assert.deepEqual(summariseDerivation([]),   { applied: 0, rejected: 0, unchanged: 0, evaluated: 0 });
  assert.deepEqual(summariseDerivation(null), { applied: 0, rejected: 0, unchanged: 0, evaluated: 0 });
});

test('pieces per unit: Infinity is not a number — "1e999" must never reach the column', () => {
  // `!(pieces > 0)` alone let Infinity through; JSON.stringify emits it as null, which would
  // write purchase_uom with a NULL count — a half-set conversion that converts nothing.
  assert.equal(validPieces('1e999'), false);
  assert.equal(Number('1e999'), Infinity);          // the exact input the guard must catch
  assert.equal(validPieces(Infinity), false);
  assert.equal(validPieces(-Infinity), false);
  assert.equal(validPieces(NaN), false);
  assert.equal(validPieces('abc'), false);
  assert.equal(validPieces(0), false);
  assert.equal(validPieces(-5), false);
  assert.equal(validPieces(MAX_PIECES_PER_UOM + 1), false);   // past numeric(12,4)
  assert.equal(validPieces(MAX_PIECES_PER_UOM), true);
  assert.equal(validPieces('2200'), true);
  assert.equal(validPieces(0.5), true);
});

test('pcs and kg are refused as a STORED conversion — the v4 function refuses them too', () => {
  const bad = { weight_per_unit_grams: null, purchase_uom: 'kg', pieces_per_purchase_uom: '500' };
  assert.equal(piecesFactor('kg', bad), null);      // weight, never the stored 500 (RULE-014)
  assert.equal(piecesFactor('KG', bad), null);
  const badPcs = { weight_per_unit_grams: null, purchase_uom: 'PCS', pieces_per_purchase_uom: '12' };
  assert.equal(piecesFactor('pcs', badPcs), 1);     // pcs is the piece, not 12 of them
});

test('newest-first ordering: NULL timestamps last, po_number DESC as the tie-break', () => {
  const a = { created_at: '2026-09-10T06:00:00Z', po_number: 'PO-2026-0042' };
  const b = { created_at: '2026-08-01T06:00:00Z', po_number: 'PO-2026-0001' };
  const c = { created_at: '2026-09-10T06:00:00Z', po_number: 'PO-2026-0043' };
  const n = { created_at: null, po_number: 'PO-2026-0099' };
  assert.deepEqual([b, n, a, c].sort(byNewestPo).map(x => x.po_number),
                   ['PO-2026-0043', 'PO-2026-0042', 'PO-2026-0001', 'PO-2026-0099']);
});

test('the preview prices the newest CONVERTIBLE line, not simply the newest line', () => {
  // UNV-PP-CLING-01: newer kg line, no weight (dead end) → the older roll line is what prices.
  const cling = { weight_per_unit_grams: null, purchase_uom: 'Roll', pieces_per_purchase_uom: '1000' };
  const clingUnits = [   // newest first, as listPurchaseUnits hands them over
    { unit: 'kg',   unit_price: '220', po_number: 'PO-2026-0090' },
    { unit: 'roll', unit_price: '240', po_number: 'PO-2026-0010' },
  ];
  const pick = pickConvertibleLine(clingUnits, cling);
  assert.equal(pick.line.po_number, 'PO-2026-0010');
  assert.equal(perPiecePreview(pick.line.unit_price, pick.factor), 0.24);   // 240/1000

  // HW-SC-23-8: newest line is pcs @0.35 → 0.35, never the older kg line's 0.29.
  const screwUnits = [{ unit: 'pcs', unit_price: '0.35', po_number: 'PO-2026-0080' },
                      { unit: 'kg',  unit_price: '1000', po_number: 'PO-2026-0009' }];
  const p2 = pickConvertibleLine(screwUnits, screw);
  assert.equal(p2.factor, 1);
  assert.equal(perPiecePreview(p2.line.unit_price, p2.factor), 0.35);

  // Nothing convertible at all → null, so the page shows an em dash rather than a made-up price.
  assert.equal(pickConvertibleLine([{ unit: 'packets', unit_price: '500' }], cling), null);
  assert.equal(pickConvertibleLine([], cling), null);
  assert.equal(pickConvertibleLine(null, cling), null);
});
