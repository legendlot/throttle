import test from 'node:test';
import assert from 'node:assert/strict';
import {
  commissionMonths, defaultCommissionMonth, monthLabel, prevMonth, reasonRequired, verifyProblem,
  requestStatus, canVerify, canReraise, canReopen, commissionTotals, commissionRequestLabel,
} from '../src/lib/commission.js';
import { affiliatePctProblem, affiliatePctEditProblem } from '../src/lib/dealPayload.js';

// Reann #3 S3: the Commission page / deal card / payments helpers.

test('months: never before Nov 2026, newest first; default is last month, clamped', () => {
  assert.deepEqual(commissionMonths('2026-11'), ['2026-11']);
  assert.deepEqual(commissionMonths('2027-01'), ['2027-01', '2026-12', '2026-11']);
  assert.equal(defaultCommissionMonth('2026-11'), '2026-11');
  assert.equal(defaultCommissionMonth('2026-12'), '2026-11');
  assert.equal(defaultCommissionMonth('2027-01'), '2026-12');
  assert.equal(prevMonth('2027-01'), '2026-12');
  assert.equal(monthLabel('2026-11'), 'Nov 2026');
});

test('reason: required only when the amount differs from the estimate (to the paisa)', () => {
  assert.equal(reasonRequired('95.90', 95.9), false);
  assert.equal(reasonRequired('95.91', 95.9), true);
  assert.equal(reasonRequired('0', 95.9), true);
  assert.equal(reasonRequired('', 95.9), false);
  assert.equal(verifyProblem('95.9', 95.9, ''), null);
  assert.match(verifyProblem('80', 95.9, ' '), /reason/);
  assert.equal(verifyProblem('80', 95.9, 'RTO of 1 order'), null);
  assert.match(verifyProblem('-1', 10, 'x'), /amount/);
  assert.match(verifyProblem('1.234', 10, 'x'), /amount/);
  assert.equal(verifyProblem('0', 0, ''), null);
});

const st = (o = {}) => ({ state: 'verified', verified_amount: 100, request: null, month_open: false, ...o });

test('requestStatus: every request state reads in words', () => {
  assert.equal(requestStatus(st({ state: 'estimated' })).label, 'Not verified yet');
  assert.equal(requestStatus(st()).label, 'Not raised');
  assert.equal(requestStatus(st({ verified_amount: 0 })).label, 'Nothing to pay');
  assert.equal(requestStatus(st({ request: { state: 'waiting_for_invoice' } })).label, 'Waiting for invoice');
  assert.equal(requestStatus(st({ request: { state: 'pending_approval' } })).label, 'In Snorkel');
  assert.equal(requestStatus(st({ request: { state: 'paid', amount: 100, paid_amount: 98, tds_amount: 2, utr: 'U1' } })).label, 'Paid ₹100 · TDS ₹2 · UTR U1');
  assert.equal(requestStatus(st({ request: { state: 'paid', amount: 100, paid_amount: 100, tds_amount: null, utr: null } })).label, 'Paid ₹100');
  assert.equal(requestStatus(st({ request: { state: 'rejected' } })).tone, 'error');
  assert.equal(requestStatus(st({ request: { state: 'cancelled' } })).label, 'Cancelled');
});

test('row actions: verify / re-raise / reopen gates', () => {
  assert.equal(canVerify(st({ state: 'estimated' })), true);
  assert.equal(canVerify(st({ state: 'estimated', month_open: true })), false);
  assert.equal(canVerify(st()), false);
  assert.equal(canReraise(st({ request: { state: 'rejected' } })), true);
  assert.equal(canReraise(st({ request: { state: 'waiting_for_invoice' } })), false);
  assert.equal(canReraise(st({ verified_amount: 0 })), false);
  assert.equal(canReopen(st({ verified_amount: 0 })), true);
  assert.equal(canReopen(st({ request: { state: 'paid' } })), false);
  assert.equal(canReopen(st({ state: 'estimated' })), false);
});

test('totals: verified sums only verified months', () => {
  const t = commissionTotals([
    { orders: 2, net_sales: 1000.1, estimate: 100.01, state: 'verified', verified_amount: 90 },
    { orders: 1, net_sales: 500.2, estimate: 50.02, state: 'estimated', verified_amount: null },
  ]);
  assert.deepEqual(t, { orders: 3, net_sales: 1500.3, estimate: 150.03, verified: 90 });
  assert.equal(commissionRequestLabel('2026-11'), 'Commission · Nov 2026');
  assert.equal(commissionRequestLabel(null), 'Commission');
});

test('affiliate %: required (0 < pct ≤ 100) on affiliate deal types', () => {
  assert.equal(affiliatePctProblem('paid', ''), null);
  assert.match(affiliatePctProblem('affiliate', ''), /commission %/i);
  assert.match(affiliatePctProblem('paid_plus_affiliate', '0'), /commission %/i);
  assert.match(affiliatePctProblem('affiliate', '101'), /commission %/i);
  assert.equal(affiliatePctProblem('affiliate', '10'), null);
  assert.equal(affiliatePctProblem('affiliate', '100'), null);
});

test('affiliate % on an edit: refused only when the edit makes it wrong (as the worker)', () => {
  const legacy = { deal_type: 'affiliate', affiliate_pct: null };
  assert.equal(affiliatePctEditProblem(legacy, { deal_type: 'affiliate', affiliate_pct: '' }), null);
  assert.match(affiliatePctEditProblem({ deal_type: 'paid', affiliate_pct: null }, { deal_type: 'affiliate', affiliate_pct: '' }), /commission %/i);
  assert.match(affiliatePctEditProblem({ deal_type: 'affiliate', affiliate_pct: 10 }, { deal_type: 'affiliate', affiliate_pct: '0' }), /commission %/i);
  assert.equal(affiliatePctEditProblem({ deal_type: 'affiliate', affiliate_pct: 10 }, { deal_type: 'affiliate', affiliate_pct: '10' }), null);
});
