// The TDS maths behind Mark-as-Paid is a pure function lifted into apps/snorkel/src/lib/tds.js
// precisely so it can be tested here, outside React/Next. snorkelops-worker's `markPaymentPaid`
// holds an INLINE copy of the same maths (the worker is a zero-import single file and cannot
// import out of apps/) — these tests are the spec both sides must satisfy; tds-parity.test.mjs
// runs the worker copy against this one.
// S376: the base is the TAXABLE value, invoice_total ÷ (1 + GST%) (decisions.md 2026-09-11). The
// cases written before that pass gstRate: 0, where taxable === invoice_total and the old
// expectations hold unchanged.
// Run: node --test snorkelops-worker/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTds, netPayable, hasTds, round2, defaultGstRate, GST_RATES }
  from '../../apps/snorkel/src/lib/tds.js';

test('a normal rate computes the amount and the net', () => {
  const { tdsAmount, error } = computeTds({ invoiceTotal: 100000, rate: 10, gstRate: 0 });
  assert.equal(error, null);
  assert.equal(tdsAmount, 10000);
  assert.equal(netPayable({ amountToPay: 100000, tdsAmount }), 90000);
});

test('NULL/absent rate is NOT APPLICABLE — no amount, and the net is untouched', () => {
  for (const rate of [null, undefined, '']) {
    const { tdsAmount, error } = computeTds({ invoiceTotal: 100000, rate, gstRate: 0 });
    assert.equal(error, null, `rate ${JSON.stringify(rate)} must not error`);
    assert.equal(tdsAmount, null);
    // The whole point: a payment with no TDS behaves exactly as it does today.
    assert.equal(netPayable({ amountToPay: 100000, tdsAmount }), 100000);
  }
  assert.equal(hasTds({ tds_rate: null }), false);
  assert.equal(hasTds({}), false);
});

test('rate 0 is APPLICABLE and distinct from NULL', () => {
  const { tdsAmount, error } = computeTds({ invoiceTotal: 100000, rate: 0, gstRate: 0 });
  assert.equal(error, null);
  assert.equal(tdsAmount, 0);           // 0, not null — it is recorded, not skipped
  assert.notEqual(tdsAmount, null);
  assert.equal(hasTds({ tds_rate: 0 }), true);
  assert.equal(hasTds({ tds_rate: '0.00' }), true);
});

test('string inputs (as PostgREST returns numeric) compute correctly', () => {
  const { tdsAmount, error } = computeTds({ invoiceTotal: '118000.00', rate: '2', gstRate: 0 });
  assert.equal(error, null);
  assert.equal(tdsAmount, 2360);
  assert.equal(netPayable({ amountToPay: '118000.00', tdsAmount: '2360.00' }), 115640);
});

test('an out-of-range or non-numeric rate is rejected, never silently ignored', () => {
  for (const rate of [-1, 100.01, 101, 'abc', '12x', NaN, Infinity]) {
    const { tdsAmount, error } = computeTds({ invoiceTotal: 1000, rate, gstRate: 0 });
    assert.ok(error, `rate ${String(rate)} must be rejected`);
    assert.equal(tdsAmount, null);
  }
  // 0 and 100 are the inclusive bounds the CHECK constraint allows.
  assert.equal(computeTds({ invoiceTotal: 1000, rate: 100, gstRate: 0 }).error, null);
  assert.equal(computeTds({ invoiceTotal: 1000, rate: 100, gstRate: 0 }).tdsAmount, 1000);
});

// S370 (hostile review): Number() coerces non-scalars, so before the TYPE guard `rate: []`
// returned {tdsAmount: 0} with no error, `true` gave 1%, `[5]` gave 5% and `false` gave 0.
// A 0 is not a harmless default here — hasTds() calls it real, the UIs render "less 0% TDS"
// and the Tally-bound payments export writes it into a column Finance reconciles against a
// bank. Same guard shape as parseDeliveryAddressId, same class of defect, same day.
test('a non-scalar rate is REJECTED on type, never coerced into a false 0%', () => {
  for (const rate of [true, false, [], [5], ['5'], {}, () => 5]) {
    const { tdsAmount, error } = computeTds({ invoiceTotal: 1000, rate, gstRate: 0 });
    assert.equal(error, 'TDS rate must be a number', `rate ${JSON.stringify(rate)} must be rejected`);
    assert.equal(tdsAmount, null);
  }
});

test('the type guard does not swallow the two states that already worked', () => {
  // '' and null still mean "not applicable": no error, no amount.
  for (const rate of [null, undefined, '']) {
    const { tdsAmount, error } = computeTds({ invoiceTotal: 1000, rate, gstRate: 0 });
    assert.equal(error, null);
    assert.equal(tdsAmount, null);
  }
  // '12x' still errors, and a numeric string still computes.
  assert.equal(computeTds({ invoiceTotal: 1000, rate: '12x', gstRate: 0 }).error, 'TDS rate must be a number');
  assert.equal(computeTds({ invoiceTotal: 1000, rate: '2', gstRate: 0 }).tdsAmount, 20);
});

test('a rate with no invoice total to compute on is refused, not treated as zero', () => {
  const { tdsAmount, error } = computeTds({ invoiceTotal: null, rate: 10, gstRate: 0 });
  assert.ok(error);
  assert.equal(tdsAmount, null);
});

test('rounding to 2 decimals on a value that does not divide evenly', () => {
  // 7.5% of 1333.33 = 99.99975 → 100.00
  assert.equal(computeTds({ invoiceTotal: 1333.33, rate: 7.5, gstRate: 0 }).tdsAmount, 100);
  // 2% of 1234.56 = 24.6912 → 24.69
  assert.equal(computeTds({ invoiceTotal: 1234.56, rate: 2, gstRate: 0 }).tdsAmount, 24.69);
  // 10% of 1000.05 = 100.005 → 100.01, not 100.00 (the float-floor trap)
  assert.equal(computeTds({ invoiceTotal: 1000.05, rate: 10, gstRate: 0 }).tdsAmount, 100.01);
  assert.equal(round2(2.675), 2.68);
  // and the net stays 2-decimal too
  assert.equal(netPayable({ amountToPay: 1234.56, tdsAmount: 24.69 }), 1209.87);
});

test('part payment: TDS is computed on the WHOLE invoice, deducted from amount_to_pay', () => {
  // DOCUMENTED behaviour (reference/decisions.md, S370 + S376): the base is the whole invoice's
  // taxable value even when only part of it is being paid (gstRate 0 here, so taxable = total).
  const { tdsAmount, error } = computeTds({ invoiceTotal: 100000, rate: 10, gstRate: 0 });
  assert.equal(error, null);
  assert.equal(tdsAmount, 10000);                                    // on 100000, not on 50000
  assert.equal(netPayable({ amountToPay: 50000, tdsAmount }), 40000);
});

// ── S376: the taxable-value base ──────────────────────────────────────────────────────────────

test('the base is the TAXABLE value: 118000 incl. 18% GST, 2% TDS → base 100000, TDS 2000', () => {
  const { tdsAmount, tdsBase, error } = computeTds({ invoiceTotal: 118000, rate: 2, gstRate: 18 });
  assert.equal(error, null);
  assert.equal(tdsBase, 100000);
  assert.equal(tdsAmount, 2000);                      // not 2360 — the GST-inclusive answer
  assert.equal(netPayable({ amountToPay: 118000, tdsAmount }), 116000);
});

test('a 5% GST invoice divides by 1.05, and the amount reproduces from the ROUNDED base', () => {
  const r = computeTds({ invoiceTotal: '105000.00', rate: '10', gstRate: 5 });
  assert.deepEqual(r, { tdsAmount: 10000, tdsBase: 100000, error: null });
  // 12345.67 / 1.05 = 11757.7809… → 11757.78; 2% of THAT = 235.1556 → 235.16
  const odd = computeTds({ invoiceTotal: 12345.67, rate: 2, gstRate: 5 });
  assert.equal(odd.tdsBase, 11757.78);
  assert.equal(odd.tdsAmount, 235.16);
  assert.equal(odd.tdsAmount, round2(odd.tdsBase * 2 / 100));   // what the stored columns say
});

test('a rate WITHOUT a GST rate is refused — never defaulted to 0 (that is the GST-inclusive base)', () => {
  for (const gstRate of [undefined, null, '', '   ']) {
    const r = computeTds({ invoiceTotal: 118000, rate: 2, gstRate });
    assert.equal(r.error, "Pick the invoice's GST rate", `gstRate ${JSON.stringify(gstRate)}`);
    assert.equal(r.tdsAmount, null);
    assert.equal(r.tdsBase, null);
  }
  // …including a 0% TDS rate: it is applicable, so its base must be stated too.
  assert.equal(computeTds({ invoiceTotal: 1000, rate: 0 }).error, "Pick the invoice's GST rate");
});

test('no TDS rate → no GST rate needed, and nothing is computed', () => {
  for (const gstRate of [undefined, 18, 7, [], 'x']) {
    assert.deepEqual(computeTds({ invoiceTotal: 118000, rate: '', gstRate }),
                     { tdsAmount: null, tdsBase: null, error: null });
  }
});

test('a GST rate outside 0/5/12/18/28 is refused', () => {
  for (const gstRate of [7, 3, -5, 100, '12x', 'abc', NaN, 18.5]) {
    const r = computeTds({ invoiceTotal: 1000, rate: 2, gstRate });
    assert.equal(r.error, 'GST rate must be one of 0, 5, 12, 18, 28', `gstRate ${String(gstRate)}`);
    assert.equal(r.tdsAmount, null);
  }
  assert.deepEqual(GST_RATES, [0, 5, 12, 18, 28]);
  for (const g of GST_RATES) assert.equal(computeTds({ invoiceTotal: 1000, rate: 2, gstRate: g }).error, null);
});

test('a non-scalar GST rate is REJECTED on type, never coerced ([18] → 18, true → 1, [] → 0)', () => {
  for (const gstRate of [true, false, [], [18], ['18'], {}, () => 18]) {
    const r = computeTds({ invoiceTotal: 118000, rate: 2, gstRate });
    assert.equal(r.error, 'GST rate must be one of 0, 5, 12, 18, 28', `gstRate ${JSON.stringify(gstRate)}`);
    assert.equal(r.tdsBase, null);
  }
});

test("a string GST rate ('18', as a <select> sends it) computes like the number", () => {
  assert.deepEqual(computeTds({ invoiceTotal: '118000.00', rate: '2', gstRate: '18' }),
                   { tdsAmount: 2000, tdsBase: 100000, error: null });
  assert.deepEqual(computeTds({ invoiceTotal: 118000, rate: 2, gstRate: ' 18 ' }),
                   computeTds({ invoiceTotal: 118000, rate: 2, gstRate: 18 }));
});

test('defaultGstRate: the linked PO rate wins, then 18 with a payee GSTIN, else 0', () => {
  // PO rate wins over the GSTIN rule, in either direction.
  assert.equal(defaultGstRate({ poGstRate: 5, payeeGstin: '27AABCU9603R1ZM' }), 5);
  assert.equal(defaultGstRate({ poGstRate: '18.00', payeeGstin: null }), 18);   // PostgREST string
  assert.equal(defaultGstRate({ poGstRate: 0, payeeGstin: '27AABCU9603R1ZM' }), 0);   // 0 is a rate
  // Mixed-rate or no PO → the worker sends null → the GSTIN rule.
  assert.equal(defaultGstRate({ poGstRate: null, payeeGstin: '27AABCU9603R1ZM' }), 18);
  assert.equal(defaultGstRate({ poGstRate: undefined, payeeGstin: '27AABCU9603R1ZM' }), 18);
  // A PO rate that isn't a picker option falls through too.
  assert.equal(defaultGstRate({ poGstRate: 3, payeeGstin: '27AABCU9603R1ZM' }), 18);
  // No / blank GSTIN → 0.
  for (const payeeGstin of [null, undefined, '', '   '])
    assert.equal(defaultGstRate({ poGstRate: null, payeeGstin }), 0);
  assert.equal(defaultGstRate(), 0);
  // S376: the vendor's usual PO rate sits between the linked PO and the GSTIN rule.
  assert.equal(defaultGstRate({ poGstRate: null, vendorGstRate: 18, payeeGstin: null }), 18);   // the VITBOJ case
  assert.equal(defaultGstRate({ poGstRate: null, vendorGstRate: '5.00', payeeGstin: '27AABCU9603R1ZM' }), 5);
  assert.equal(defaultGstRate({ poGstRate: 12, vendorGstRate: 18, payeeGstin: null }), 12);     // PO still wins
  assert.equal(defaultGstRate({ poGstRate: null, vendorGstRate: 0, payeeGstin: '27AABCU9603R1ZM' }), 0);  // 0 is a rate
  assert.equal(defaultGstRate({ poGstRate: null, vendorGstRate: 3, payeeGstin: '27AABCU9603R1ZM' }), 18); // not an option
  assert.equal(defaultGstRate({ poGstRate: null, vendorGstRate: [18], payeeGstin: null }), 0);  // non-scalar ignored
  // Every default is a picker option, so it always passes computeTds.
  for (const g of [5, 18, 0]) assert.ok(GST_RATES.includes(g));
});
