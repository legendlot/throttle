// salesPaymentStatus is the one payment-status rule both recomputeOrderCredit and
// recomputeSalesPayment use. Lifted from index.js like the other tests (no named exports).
// Run: node --test snorkelops-worker/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/index.js'), 'utf8');
const i = src.indexOf('function salesPaymentStatus(');
const j = src.indexOf('\n// Roll up ISSUED credit notes', i);
assert.ok(i >= 0 && j > i, 'salesPaymentStatus not found');
const salesPaymentStatus = new Function(src.slice(i, j) + '\nreturn salesPaymentStatus;')();

test('fully credited, nothing received → paid (SO-0024)', () => {
  assert.equal(salesPaymentStatus(0, 0, 6399.98), 'paid');
});
test('credit exceeds grand, refund booked as negative receipt → paid (SO-0325)', () => {
  assert.equal(salesPaymentStatus(-2453, -2453, 129311.23), 'paid');
});
test('no credit, nothing received → unpaid', () => {
  assert.equal(salesPaymentStatus(0, 5000, 0), 'unpaid');
});
test('zero order with no credit and no receipt stays unpaid', () => {
  assert.equal(salesPaymentStatus(0, 0, 0), 'unpaid');
});
test('part-credited, rest unpaid → unpaid', () => {
  assert.equal(salesPaymentStatus(0, 1000, 500), 'unpaid');
});
test('received covers net after credit → paid', () => {
  assert.equal(salesPaymentStatus(500, 500, 500), 'paid');
});
test('received short of net → partial', () => {
  assert.equal(salesPaymentStatus(400, 500, 0), 'partial');
});
test('paise tolerance → paid', () => {
  assert.equal(salesPaymentStatus(499.996, 500, 0), 'paid');
});
test('both recompute paths use the helper — no inline copy of the rule', () => {
  assert.equal(src.split('= salesPaymentStatus(recv, net, credit)').length - 1, 2);
  assert.ok(!src.includes('recv > 0 && recv >= net'), 'inline payment-status rule is back');
});
