// The TDS maths behind Mark-as-Paid is a pure function lifted into apps/snorkel/src/lib/tds.js
// precisely so it can be tested here, outside React/Next. snorkelops-worker's `markPaymentPaid`
// holds an INLINE copy of the same maths (the worker is a zero-import single file and cannot
// import out of apps/) — these tests are the spec both sides must satisfy.
// Run: node --test snorkelops-worker/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTds, netPayable, hasTds, round2 } from '../../apps/snorkel/src/lib/tds.js';

test('a normal rate computes the amount and the net', () => {
  const { tdsAmount, error } = computeTds({ invoiceTotal: 100000, rate: 10 });
  assert.equal(error, null);
  assert.equal(tdsAmount, 10000);
  assert.equal(netPayable({ amountToPay: 100000, tdsAmount }), 90000);
});

test('NULL/absent rate is NOT APPLICABLE — no amount, and the net is untouched', () => {
  for (const rate of [null, undefined, '']) {
    const { tdsAmount, error } = computeTds({ invoiceTotal: 100000, rate });
    assert.equal(error, null, `rate ${JSON.stringify(rate)} must not error`);
    assert.equal(tdsAmount, null);
    // The whole point: a payment with no TDS behaves exactly as it does today.
    assert.equal(netPayable({ amountToPay: 100000, tdsAmount }), 100000);
  }
  assert.equal(hasTds({ tds_rate: null }), false);
  assert.equal(hasTds({}), false);
});

test('rate 0 is APPLICABLE and distinct from NULL', () => {
  const { tdsAmount, error } = computeTds({ invoiceTotal: 100000, rate: 0 });
  assert.equal(error, null);
  assert.equal(tdsAmount, 0);           // 0, not null — it is recorded, not skipped
  assert.notEqual(tdsAmount, null);
  assert.equal(hasTds({ tds_rate: 0 }), true);
  assert.equal(hasTds({ tds_rate: '0.00' }), true);
});

test('string inputs (as PostgREST returns numeric) compute correctly', () => {
  const { tdsAmount, error } = computeTds({ invoiceTotal: '118000.00', rate: '2' });
  assert.equal(error, null);
  assert.equal(tdsAmount, 2360);
  assert.equal(netPayable({ amountToPay: '118000.00', tdsAmount: '2360.00' }), 115640);
});

test('an out-of-range or non-numeric rate is rejected, never silently ignored', () => {
  for (const rate of [-1, 100.01, 101, 'abc', '12x', NaN, Infinity]) {
    const { tdsAmount, error } = computeTds({ invoiceTotal: 1000, rate });
    assert.ok(error, `rate ${String(rate)} must be rejected`);
    assert.equal(tdsAmount, null);
  }
  // 0 and 100 are the inclusive bounds the CHECK constraint allows.
  assert.equal(computeTds({ invoiceTotal: 1000, rate: 100 }).error, null);
  assert.equal(computeTds({ invoiceTotal: 1000, rate: 100 }).tdsAmount, 1000);
});

// S370 (hostile review): Number() coerces non-scalars, so before the TYPE guard `rate: []`
// returned {tdsAmount: 0} with no error, `true` gave 1%, `[5]` gave 5% and `false` gave 0.
// A 0 is not a harmless default here — hasTds() calls it real, the UIs render "less 0% TDS"
// and the Tally-bound payments export writes it into a column Finance reconciles against a
// bank. Same guard shape as parseDeliveryAddressId, same class of defect, same day.
test('a non-scalar rate is REJECTED on type, never coerced into a false 0%', () => {
  for (const rate of [true, false, [], [5], ['5'], {}, () => 5]) {
    const { tdsAmount, error } = computeTds({ invoiceTotal: 1000, rate });
    assert.equal(error, 'TDS rate must be a number', `rate ${JSON.stringify(rate)} must be rejected`);
    assert.equal(tdsAmount, null);
  }
});

test('the type guard does not swallow the two states that already worked', () => {
  // '' and null still mean "not applicable": no error, no amount.
  for (const rate of [null, undefined, '']) {
    const { tdsAmount, error } = computeTds({ invoiceTotal: 1000, rate });
    assert.equal(error, null);
    assert.equal(tdsAmount, null);
  }
  // '12x' still errors, and a numeric string still computes.
  assert.equal(computeTds({ invoiceTotal: 1000, rate: '12x' }).error, 'TDS rate must be a number');
  assert.equal(computeTds({ invoiceTotal: 1000, rate: '2' }).tdsAmount, 20);
});

test('a rate with no invoice total to compute on is refused, not treated as zero', () => {
  const { tdsAmount, error } = computeTds({ invoiceTotal: null, rate: 10 });
  assert.ok(error);
  assert.equal(tdsAmount, null);
});

test('rounding to 2 decimals on a value that does not divide evenly', () => {
  // 7.5% of 1333.33 = 99.99975 → 100.00
  assert.equal(computeTds({ invoiceTotal: 1333.33, rate: 7.5 }).tdsAmount, 100);
  // 2% of 1234.56 = 24.6912 → 24.69
  assert.equal(computeTds({ invoiceTotal: 1234.56, rate: 2 }).tdsAmount, 24.69);
  // 10% of 1000.05 = 100.005 → 100.01, not 100.00 (the float-floor trap)
  assert.equal(computeTds({ invoiceTotal: 1000.05, rate: 10 }).tdsAmount, 100.01);
  assert.equal(round2(2.675), 2.68);
  // and the net stays 2-decimal too
  assert.equal(netPayable({ amountToPay: 1234.56, tdsAmount: 24.69 }), 1209.87);
});

test('part payment: TDS is computed on invoice_total, deducted from amount_to_pay', () => {
  // DOCUMENTED behaviour (reference/decisions.md, S370): the base is the invoice value even when
  // only part of it is being paid. Flagged back to Priya before anyone relies on it.
  const { tdsAmount, error } = computeTds({ invoiceTotal: 100000, rate: 10 });
  assert.equal(error, null);
  assert.equal(tdsAmount, 10000);                                    // on 100000, not on 50000
  assert.equal(netPayable({ amountToPay: 50000, tdsAmount }), 40000);
});
