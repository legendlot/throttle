// The prior-TDS matcher (normInvoiceNo / sameInvoice / priorTdsFor / priorTdsWarning) is pure and
// lives only in the single-file worker (no named exports), so — like party-balances.test.mjs — the
// test lifts its source text straight out of index.js. tdsNum comes along because the matcher uses it.
// Warning only: the correct TDS base on a part-payment is open with Finance; see the worker comment.
// Run: node --test snorkelops-worker/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/index.js'), 'utf8');
const lift = (start, end) => { const i = src.indexOf(start); assert.ok(i >= 0, `missing ${start}`); const j = src.indexOf(end, i); assert.ok(j > i, `no end for ${start}`); return src.slice(i, j); };
const code = [
  lift('function tdsNum(', '\nfunction computeTds('),
  lift('function normInvoiceNo(', '\n// ⚠️⚠️ REQUESTER NOTE'),
  'return { normInvoiceNo, sameInvoice, priorTdsFor, priorTdsWarning, PRIOR_TDS_SELECT };',
].join('\n');
const { normInvoiceNo, sameInvoice, priorTdsFor, priorTdsWarning, PRIOR_TDS_SELECT } = new Function(code)();

// PostgREST hands ids and numerics back as strings — the fixtures do too, in places.
const req = (id, extra = {}) => ({
  id, request_no: `PAY-${String(id).padStart(4, '0')}`, status: 'approved', payee_id: 7,
  invoice_no: 'CT/PI/2026/0143', linked_po_number: null, invoice_total: '129800.00',
  currency: 'INR', tds_rate: null, tds_amount: null, paid_at: null, ...extra,
});
const paidWithTds = (id, extra = {}) => req(id, {
  status: 'paid', tds_rate: '2', tds_amount: '2596.00', paid_at: '2026-09-05T06:30:00Z', ...extra,
});

test('same invoice with different punctuation, spacing and case → match (the PAY-0010 shape)', () => {
  const t2 = req(11, { invoice_no: 'ct-pi-2026-0143 ' });
  const t1 = paidWithTds(10, { invoice_no: 'CT/PI/2026/0143' });
  assert.equal(sameInvoice(t2, t1), true);
  const prior = priorTdsFor(t2, [t1]);
  assert.deepEqual(prior, [{ request_no: 'PAY-0010', status: 'paid', tds_rate: '2',
                             tds_amount: '2596.00', paid_at: '2026-09-05T06:30:00Z' }]);
});

test('a different payee with the same invoice number → no match', () => {
  const t2 = req(11);
  assert.equal(sameInvoice(t2, paidWithTds(10, { payee_id: 8 })), false);
  assert.deepEqual(priorTdsFor(t2, [paidWithTds(10, { payee_id: 8 })]), []);
});

test('payee ids compare as ids, not by type — "7" (PostgREST string) matches 7', () => {
  assert.equal(sameInvoice(req(11, { payee_id: 7 }), paidWithTds(10, { payee_id: '7' })), true);
});

test('empty invoice_no on either side falls back to same payee + same PO + same invoice_total', () => {
  const po = 'PO-2026-0042';
  const t2 = req(11, { invoice_no: '', linked_po_number: po, invoice_total: 129800 });
  // fallback hit: PO and total equal (numeric vs string total)
  assert.equal(sameInvoice(t2, paidWithTds(10, { invoice_no: null, linked_po_number: po })), true);
  // one side HAS an invoice_no, the other not → still the fallback, not a compare against ''
  assert.equal(sameInvoice(t2, paidWithTds(10, { linked_po_number: po })), true);
  // different total → no
  assert.equal(sameInvoice(t2, paidWithTds(10, { invoice_no: null, linked_po_number: po, invoice_total: '64900' })), false);
  // different PO → no
  assert.equal(sameInvoice(t2, paidWithTds(10, { invoice_no: null, linked_po_number: 'PO-2026-0043' })), false);
  // no PO on either side → no match: payee + total alone is not "the same invoice"
  assert.equal(sameInvoice(req(11, { invoice_no: '' }), paidWithTds(10, { invoice_no: '' })), false);
  // punctuation-only invoice_no normalises to empty → treated as empty, falls back
  assert.equal(sameInvoice(req(11, { invoice_no: ' - / ', linked_po_number: po }),
                           paidWithTds(10, { invoice_no: '', linked_po_number: po })), true);
});

test('a request is never its own prior deduction (string vs number id too)', () => {
  const self = paidWithTds(10);
  assert.deepEqual(priorTdsFor(self, [self]), []);
  assert.deepEqual(priorTdsFor({ ...self, id: 10 }, [{ ...self, id: '10' }]), []);
});

test('rejected and cancelled requests never count, even if they carry a rate', () => {
  const t2 = req(11);
  assert.deepEqual(priorTdsFor(t2, [paidWithTds(10, { status: 'rejected' }),
                                    paidWithTds(12, { status: 'cancelled' })]), []);
});

test('only requests that actually carry a deduction count — NULL and 0% are not a deduction', () => {
  const t2 = req(11);
  assert.deepEqual(priorTdsFor(t2, [req(10, { status: 'paid' }),                                  // NULL = n/a
                                    paidWithTds(12, { tds_rate: '0', tds_amount: '0' })]), []);  // PAY-0027 shape
  // rate > 0 alone, or amount > 0 alone, is enough
  assert.equal(priorTdsFor(t2, [paidWithTds(13, { tds_amount: null })]).length, 1);
  assert.equal(priorTdsFor(t2, [paidWithTds(14, { tds_rate: null })]).length, 1);
});

test('comma-list invoice_no normalises consistently (the PAY-0027 shape)', () => {
  const list = 'IN-CMP-0457,IN-CMP-0448,IN-CMP-0430,IN-CMP-0399';
  assert.equal(normInvoiceNo(list), 'INCMP0457INCMP0448INCMP0430INCMP0399');
  assert.equal(normInvoiceNo('in-cmp-0457, in-cmp-0448, in-cmp-0430, in-cmp-0399'), normInvoiceNo(list));
  assert.equal(sameInvoice(req(11, { invoice_no: 'in-cmp-0457, in-cmp-0448, in-cmp-0430, in-cmp-0399' }),
                           paidWithTds(10, { invoice_no: list })), true);
  // ⚠️ Known limit, by the brief's definition: a list does NOT match one of its own members.
  assert.equal(sameInvoice(req(11, { invoice_no: 'IN-CMP-0457' }), paidWithTds(10, { invoice_no: list })), false);
});

test('the markPaymentPaid warning names each prior deduction; null when there is none', () => {
  assert.equal(priorTdsWarning([]), null);
  assert.equal(priorTdsWarning(undefined), null);
  assert.equal(
    priorTdsWarning(priorTdsFor(req(11), [paidWithTds(10)])),
    'TDS already deducted on this invoice: ₹2,596 on PAY-0010 (2%) — this deducts it again on the full invoice value.');
  assert.match(priorTdsWarning([{ request_no: 'PAY-0010', tds_rate: '2', tds_amount: '2596' }], 'USD'),
    /USD 2,596 on PAY-0010 \(2%\)/);
});

test('PRIOR_TDS_SELECT carries every column the matcher and prior_tds read', () => {
  for (const col of ['id', 'request_no', 'status', 'payee_id', 'invoice_no', 'linked_po_number',
                     'invoice_total', 'tds_rate', 'tds_amount', 'paid_at'])
    assert.ok(PRIOR_TDS_SELECT.split(/[=,]/).includes(col), `select is missing ${col}`);
});
