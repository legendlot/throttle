// PaymentList's tab-filtering, value totals and currency normalisation are pure functions
// lifted into apps/snorkel/src/lib/paymentList.js precisely so they can be tested here,
// outside React/Next. Run: node --test snorkelops-worker/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS_TABS, isINR, filterByTab, valueRowsForTab, otherStatusRows,
} from '../../apps/snorkel/src/lib/paymentList.js';

const rows = [
  { id: 1, status: 'submitted',        currency: 'INR', amount_to_pay: 100 },
  { id: 2, status: 'pending_approval', currency: 'INR', amount_to_pay: 200 },
  { id: 3, status: 'approved',         currency: 'INR', amount_to_pay: 300 },
  { id: 4, status: 'held',             currency: 'INR', amount_to_pay: 400 },
  { id: 5, status: 'paid',             currency: 'INR', amount_to_pay: 500 },
  { id: 6, status: 'cancelled',        currency: 'INR', amount_to_pay: 600 },
  { id: 7, status: 'rejected',         currency: 'INR', amount_to_pay: 700 },
];

test('each tab selects exactly its own statuses', () => {
  assert.deepEqual(filterByTab(rows, 'submitted').map(r => r.id), [1, 2]);
  assert.deepEqual(filterByTab(rows, 'approved').map(r => r.id), [3, 4]);
  assert.deepEqual(filterByTab(rows, 'paid').map(r => r.id), [5]);
  assert.deepEqual(filterByTab(rows, 'cancelled').map(r => r.id), [6, 7]);
  assert.deepEqual(filterByTab(rows, 'all').map(r => r.id), rows.map(r => r.id));
});

test("'all' excludes cancelled and rejected from the value total", () => {
  const valueRows = valueRowsForTab(rows, 'all');
  assert.deepEqual(valueRows.map(r => r.id), [1, 2, 3, 4, 5]);
  const total = valueRows.filter(isINR).reduce((a, r) => a + r.amount_to_pay, 0);
  assert.equal(total, 1500);
  // The Cancelled tab itself is NOT closed-filtered — it still shows what was cancelled.
  assert.deepEqual(valueRowsForTab(rows, 'cancelled').map(r => r.id), [6, 7]);
});

test('currency normalisation: case and whitespace never drop a row out of INR', () => {
  assert.equal(isINR({ currency: 'INR' }), true);
  assert.equal(isINR({ currency: 'inr' }), true);
  assert.equal(isINR({ currency: ' INR ' }), true);
  assert.equal(isINR({ currency: undefined }), true); // default
  assert.equal(isINR({ currency: 'USD' }), false);
});

test('an unknown 8th status falls into Other, invisible to every named tab', () => {
  const withUnknown = [...rows, { id: 8, status: 'escalated', currency: 'INR', amount_to_pay: 999 }];
  for (const t of STATUS_TABS) {
    if (t.key === 'all') continue;
    assert.ok(!filterByTab(withUnknown, t.key).some(r => r.id === 8), `tab ${t.key} must not claim status 'escalated'`);
  }
  const other = otherStatusRows(withUnknown);
  assert.deepEqual(other.map(r => r.id), [8]);
});
