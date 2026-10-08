import test from 'node:test';
import assert from 'node:assert/strict';
import { initialDealForm, dealPayload } from '../src/lib/dealPayload.js';

// P0.3 / D7 (S412): one payload rule for the New Deal page and the modal — the modal's.

test('initialDealForm: terms default to advance; page extras merge in', () => {
  assert.equal(initialDealForm().payment_terms, 'advance');
  assert.equal(initialDealForm({ directed_to: 'website' }).directed_to, 'website');
});

test('dealPayload: barter sends no payment amount, terms or affiliate %', () => {
  const p = dealPayload({ ...initialDealForm(), deal_type: 'barter', payment_amount: '5000', affiliate_pct: '10' }, 'inf');
  assert.equal('payment_amount' in p, false);
  assert.equal('payment_terms' in p, false);
  assert.equal('affiliate_pct' in p, false);
  assert.equal(p.influencer_id, 'inf');
});

test('dealPayload: paid sends a numeric amount and its terms', () => {
  const p = dealPayload({ ...initialDealForm(), payment_amount: '5000', payment_terms: 'on_draft' }, 'inf');
  assert.equal(p.payment_amount, 5000);
  assert.equal(p.payment_terms, 'on_draft');
  assert.equal('affiliate_pct' in p, false);
});

test('dealPayload: paid + affiliate sends both; blank optional fields are dropped', () => {
  const p = dealPayload({ ...initialDealForm(), deal_type: 'paid_plus_affiliate', payment_amount: '0', affiliate_pct: '7.5' }, 'inf', [{ product_code: 'X' }]);
  assert.equal(p.payment_amount, 0);
  assert.equal(p.affiliate_pct, 7.5);
  assert.deepEqual(p.products, [{ product_code: 'X' }]);
  assert.equal('expected_post_date' in p, false);
  assert.equal('campaign_id' in p, false);
});

test('dealPayload: paid with the amount left blank keeps the chosen terms, omits the amount', () => {
  const p = dealPayload({ ...initialDealForm(), payment_terms: 'on_draft' }, 'inf');
  assert.equal(p.payment_terms, 'on_draft');
  assert.equal('payment_amount' in p, false);
});

test('dealPayload: no product lines → no products key', () => {
  assert.equal('products' in dealPayload(initialDealForm(), 'inf', []), false);
});
