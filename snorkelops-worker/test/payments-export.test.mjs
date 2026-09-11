// The PAID-payments export (Priya, #bugs 2026-09-07 — the Tally / vendor-ledger file). The CSV
// shape is a pure function in apps/snorkel/src/lib/paymentsExport.js precisely so it can be
// tested here, outside React/Next. snorkelops-worker's `getPaidPaymentsExport` supplies the rows
// (paid only, date-ranged, privilege-gated); this file is the spec for what the rows become.
// Run: node --test snorkelops-worker/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPaymentsExportCsv, PAYMENTS_EXPORT_COLUMNS, istDateOf, netPaidOf }
  from '../../apps/snorkel/src/lib/paymentsExport.js';

// A live-shaped row: PostgREST returns numerics as STRINGS and embeds the payee as an object.
function row(over = {}) {
  return {
    request_no: 'PAY-0021', payee: { name: 'Ashirwad Polymers' },
    invoice_no: 'INV-99', invoice_date: '2026-09-01', invoice_total: '98345.00',
    currency: 'INR', amount_to_pay: '98345.00', tds_rate: null, tds_amount: null,
    tds_gst_rate: null, tds_base: null,
    paid_amount: '98345.00', paid_at: '2026-09-08T06:24:19.538+00:00',
    payment_ref: 'HSBCN25184661539', payment_mode: 'neft',
    category: { label: 'Raw material' }, category_key: 'raw_material',
    linked_po_number: 'IN-RM-0042', purpose: 'September resin',
    requested_by_name: 'Prarthi', approved_by_name: 'Vinay', paid_by_name: 'Priya',
    ...over,
  };
}
const cells = line => {
  // Minimal CSV splitter — enough to prove a quoted comma did not shift a column.
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
};
const col = name => PAYMENTS_EXPORT_COLUMNS.indexOf(name);

test('one row per payment, columns in the declared order', () => {
  const csv = buildPaymentsExportCsv([row(), row({ request_no: 'PAY-0022' })]);
  const lines = csv.split('\n');
  assert.equal(lines.length, 3);                       // header + 2 payments
  assert.equal(lines[0], PAYMENTS_EXPORT_COLUMNS.join(','));
  assert.deepEqual(PAYMENTS_EXPORT_COLUMNS.slice(0, 7), [
    'Request No', 'Payee / Vendor', 'Invoice No', 'Invoice Date', 'Invoice Total', 'Currency',
    'Amount to Pay',
  ]);
  const c = cells(lines[1]);
  assert.equal(c.length, PAYMENTS_EXPORT_COLUMNS.length);
  assert.equal(c[col('Request No')], 'PAY-0021');
  assert.equal(c[col('Payee / Vendor')], 'Ashirwad Polymers');
  assert.equal(c[col('UTR / Ref')], 'HSBCN25184661539');
  assert.equal(c[col('Paid By')], 'Priya');
  assert.equal(cells(lines[2])[col('Request No')], 'PAY-0022');
});

test('a NULL tds_rate exports BLANK TDS cells, not 0', () => {
  // A 0 in a Tally-bound sheet reads as a deduction that WAS applied — a different, wrong claim.
  const c = cells(buildPaymentsExportCsv([row()]).split('\n')[1]);
  assert.equal(c[col('TDS %')], '');
  assert.equal(c[col('TDS Amount')], '');
  assert.equal(c[col('GST % (TDS)')], '');
  assert.equal(c[col('Taxable value (TDS base)')], '');
  assert.notEqual(c[col('TDS %')], '0');
  // …and the net is untouched by the absent TDS.
  assert.equal(c[col('Net Paid')], '98345');
});

test('a row WITH TDS exports rate and amount, and Net Paid is the net', () => {
  // Finance types a rate; Mark-as-Paid already rewrote paid_amount to the net (detail/page.js).
  const c = cells(buildPaymentsExportCsv([row({
    tds_rate: '2', tds_amount: '1966.90', paid_amount: '96378.10',
  })]).split('\n')[1]);
  assert.equal(c[col('TDS %')], '2');
  assert.equal(c[col('TDS Amount')], '1966.9');
  assert.equal(c[col('Amount to Pay')], '98345.00');   // gross, as recorded
  assert.equal(c[col('Net Paid')], '96378.1');
  // A 0% rate IS applicable and must render as 0, not blank — it is a recorded decision.
  const zero = cells(buildPaymentsExportCsv([row({ tds_rate: '0.00', tds_amount: '0.00' })]).split('\n')[1]);
  assert.equal(zero[col('TDS %')], '0');
  assert.equal(zero[col('TDS Amount')], '0');
});

// S376: the TDS base is the TAXABLE value (decisions.md 2026-09-11) and the export carries the two
// audit columns. The header/row alignment is asserted POSITIONALLY here, not just via col(): a
// header that gained a column the row didn't (or vice versa) shifted every cell after it once.
test('GST % (TDS) and Taxable value (TDS base) export beside the TDS columns, aligned to the header', () => {
  const at = PAYMENTS_EXPORT_COLUMNS.indexOf('Amount to Pay');
  assert.deepEqual(PAYMENTS_EXPORT_COLUMNS.slice(at, at + 6), [
    'Amount to Pay', 'GST % (TDS)', 'Taxable value (TDS base)', 'TDS %', 'TDS Amount', 'Net Paid',
  ]);
  // 118000 incl. 18% GST → taxable 100000, 2% TDS = 2000 (as PostgREST returns them: strings).
  const c = cells(buildPaymentsExportCsv([row({
    invoice_total: '118000.00', amount_to_pay: '118000.00', paid_amount: '116000.00',
    tds_rate: '2', tds_gst_rate: '18', tds_base: '100000.00', tds_amount: '2000.00',
  })]).split('\n')[1]);
  assert.equal(c.length, PAYMENTS_EXPORT_COLUMNS.length);
  assert.deepEqual(c.slice(at, at + 6), ['118000.00', '18', '100000', '2', '2000', '116000']);
  assert.equal(c[col('Payment Date')], '2026-09-08');      // the column after them did not shift
  assert.equal(c[col('Paid By')], 'Priya');
  // A row paid BEFORE the base was stored: rate present, base/GST NULL → blank, never a guess.
  const legacy = cells(buildPaymentsExportCsv([row({ tds_rate: '0.00', tds_amount: '0.00' })]).split('\n')[1]);
  assert.equal(legacy.length, PAYMENTS_EXPORT_COLUMNS.length);
  assert.equal(legacy[col('GST % (TDS)')], '');
  assert.equal(legacy[col('Taxable value (TDS base)')], '');
  assert.equal(legacy[col('TDS %')], '0');
  // 0% GST is a real pick and renders 0, not blank.
  const zeroGst = cells(buildPaymentsExportCsv([row({
    tds_rate: '10', tds_gst_rate: '0', tds_base: '98345.00', tds_amount: '9834.50',
  })]).split('\n')[1]);
  assert.equal(zeroGst[col('GST % (TDS)')], '0');
  assert.equal(zeroGst[col('Taxable value (TDS base)')], '98345');
});

test('Net Paid derives from amount_to_pay less TDS when paid_amount was never recorded', () => {
  assert.equal(netPaidOf({ amount_to_pay: '10000.00', tds_amount: '1000.00', paid_amount: null }), 9000);
  // ⚠️ and it must NOT double-deduct when paid_amount is already the net.
  assert.equal(netPaidOf({ amount_to_pay: '10000.00', tds_amount: '1000.00', paid_amount: '9000.00' }), 9000);
});

test('string numerics (as PostgREST returns numeric) render correctly', () => {
  const c = cells(buildPaymentsExportCsv([row({
    invoice_total: '42180.38', amount_to_pay: '42180.38', paid_amount: '42180.38',
  })]).split('\n')[1]);
  assert.equal(c[col('Invoice Total')], '42180.38');
  assert.equal(c[col('Amount to Pay')], '42180.38');
  assert.equal(c[col('Net Paid')], '42180.38');
  assert.ok(!/NaN/.test(c.join(',')));
});

test('a comma or a quote in a purpose or payee name is quoted and does not shift columns', () => {
  const line = buildPaymentsExportCsv([row({
    payee: { name: 'Sharma, Gupta & Co' },
    purpose: 'Moulds for "Nitro" — 3 tools, urgent',
  })]).split('\n')[1];
  assert.ok(line.includes('"Sharma, Gupta & Co"'));
  assert.ok(line.includes('""Nitro""'));               // the quote is doubled, not dropped
  const c = cells(line);
  assert.equal(c.length, PAYMENTS_EXPORT_COLUMNS.length);
  assert.equal(c[col('Payee / Vendor')], 'Sharma, Gupta & Co');
  assert.equal(c[col('Purpose')], 'Moulds for "Nitro" — 3 tools, urgent');
  assert.equal(c[col('Paid By')], 'Priya');            // the column after it did not shift
});

test('a NULL payment_ref exports an empty UTR cell without throwing', () => {
  // PAY-0009 is live in this state today — marked paid with no UTR captured.
  const c = cells(buildPaymentsExportCsv([row({
    request_no: 'PAY-0009', payment_ref: null, payment_mode: null,
  })]).split('\n')[1]);
  assert.equal(c[col('UTR / Ref')], '');
  assert.equal(c[col('Payment Mode')], '');
  assert.equal(c[col('Request No')], 'PAY-0009');
});

test('the payment date is the IST calendar date, not the UTC one', () => {
  // 23:00 IST on the 8th is 17:30Z on the 8th — but a late-night payment can land on the NEXT
  // UTC day, and booking it a day late breaks the bank reconciliation the file exists for.
  assert.equal(istDateOf('2026-09-08T20:15:00.000+00:00'), '2026-09-09');
  assert.equal(istDateOf('2026-09-08T06:24:19.538+00:00'), '2026-09-08');
  assert.equal(istDateOf(null), '');
  assert.equal(istDateOf('not a date'), '');
});

test('an empty range produces a header-only file, never a throw', () => {
  // The default range is Today and only 7 payments exist (newest 2026-09-08), so this is the
  // COMMON case — the screen is what must say "no payments in these dates", not a broken file.
  const csv = buildPaymentsExportCsv([]);
  assert.equal(csv, PAYMENTS_EXPORT_COLUMNS.join(','));
  assert.equal(buildPaymentsExportCsv(null), PAYMENTS_EXPORT_COLUMNS.join(','));
});
