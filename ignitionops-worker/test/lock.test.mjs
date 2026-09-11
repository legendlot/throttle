import test from 'node:test';
import assert from 'node:assert/strict';
import * as W from '../src/completeness.js';
// The app's copy — the worker and the app share no package, so the rule is duplicated by hand and
// THIS import is what keeps the two honest (S373 COMPLETE-deal lock).
import * as A from '../../apps/ignition/src/lib/metrics.js';

const live = (over = {}) => ({
  stage: 'live', views: 1000, likes: 50, followers_gained: 7, total_cost: 250, metric_gaps: {}, ...over,
});

// [name, row] — every edge the derivation has a comment about.
const CASES = [
  ['fully measured live', live()],
  ['not live', live({ stage: 'posting' })],
  ['retired completed stage', live({ stage: 'completed' })],
  ['stage casing', live({ stage: 'LIVE' })],
  ['views 0', live({ views: 0 })],
  ['views null', live({ views: null })],
  ['views "0"', live({ views: '0' })],
  ['views whitespace', live({ views: '  ' })],
  ['cost 0', live({ total_cost: 0 })],
  ['cost "250.00" string', live({ total_cost: '250.00' })],
  ['cost 0 with a gap for cost (no gap key)', live({ total_cost: 0, metric_gaps: { total_cost: 'gated_data' } })],
  ['likes 0 is an answer', live({ likes: 0 })],
  ['likes null, no gap', live({ likes: null })],
  ['followers_gained null, valid gap', live({ followers_gained: null, metric_gaps: { followers_gained: 'gated_data' } })],
  ['followers_gained null, gap with whitespace', live({ followers_gained: null, metric_gaps: { followers_gained: ' system_timing ' } })],
  ['followers_gained null, unrecognised gap', live({ followers_gained: null, metric_gaps: { followers_gained: 'x' } })],
  ['followers_gained null, whitespace-only gap', live({ followers_gained: null, metric_gaps: { followers_gained: '   ' } })],
  ['followers_gained null, object gap', live({ followers_gained: null, metric_gaps: { followers_gained: { a: 1 } } })],
  ['views 0, valid gap', live({ views: 0, metric_gaps: { views: 'internal_gap' } })],
  ['metric_gaps as array', live({ followers_gained: null, metric_gaps: ['followers_gained'] })],
  ['metric_gaps as string', live({ followers_gained: null, metric_gaps: 'gated_data' })],
  ['metric_gaps null', live({ followers_gained: null, metric_gaps: null })],
  ['inherited key as gap', live({ followers_gained: null, metric_gaps: { constructor: 'gated_data' } })],
  ['likes boolean', live({ likes: false })],
  ['likes array', live({ likes: [] })],
  ['empty row', {}],
];

test('parity: worker metricsCompleteness === app metricsCompleteness on every case', () => {
  for (const [name, row] of CASES) {
    assert.deepEqual(W.metricsCompleteness(row), A.metricsCompleteness(row), name);
  }
});

test('parity: GAP_REASONS is the same vocabulary in both copies', () => {
  assert.deepEqual(W.GAP_REASONS, A.GAP_REASONS);
});

test('parity: isLocked agrees across both copies, with and without a window', () => {
  const now = Date.parse('2026-09-11T06:00:00Z');
  const windows = [null, '2026-09-12T06:00:00Z', '2026-09-10T06:00:00Z', 'not a date', ''];
  for (const [name, row] of CASES) {
    for (const w of windows) {
      const r = { ...row, unlocked_until: w };
      assert.equal(W.isLocked(r, now), A.isLocked(r, now), `${name} / window ${w}`);
    }
  }
});

test('the case table exercises both outcomes (a parity test over one answer proves nothing)', () => {
  const results = CASES.map(([, r]) => W.metricsCompleteness(r).complete);
  assert.ok(results.includes(true) && results.includes(false));
});

// ── isLocked ──────────────────────────────────────────────────────────────────────────────────
const NOW = Date.parse('2026-09-11T06:00:00Z');

test('isLocked: a complete deal with no window is locked', () => {
  assert.equal(W.isLocked(live(), NOW), true);
  assert.equal(W.isLocked(live({ unlocked_until: null }), NOW), true);
});

test('isLocked: an open window unlocks, an expired one does not', () => {
  assert.equal(W.isLocked(live({ unlocked_until: '2026-09-12T05:59:59Z' }), NOW), false);
  assert.equal(W.isLocked(live({ unlocked_until: '2026-09-11T06:00:00Z' }), NOW), true);   // <= now is closed
  assert.equal(W.isLocked(live({ unlocked_until: '2026-09-10T06:00:00Z' }), NOW), true);
});

test('isLocked: an unparseable window is treated as closed (fails locked, not open)', () => {
  assert.equal(W.isLocked(live({ unlocked_until: 'garbage' }), NOW), true);
});

test('isLocked: an incomplete deal is never locked — clearing a metric releases it', () => {
  assert.equal(W.isLocked(live({ likes: null }), NOW), false);
  assert.equal(W.isLocked(live({ stage: 'on_hold' }), NOW), false);
  assert.equal(W.isLocked(live({ followers_gained: null, metric_gaps: { followers_gained: 'gated_data' } }), NOW), true);
  assert.equal(W.isLocked(live({ followers_gained: null, metric_gaps: {} }), NOW), false);
});

// ── the updateEngagement field classifier ─────────────────────────────────────────────────────
// Mirrors the guard exactly: refuse = lockedFieldsIn(patch) is non-empty AND isLocked(row).
const refused = (row, patch, now = NOW) => W.lockedFieldsIn(patch).length > 0 && W.isLocked(row, now);

// The payloads each deal-page card actually sends (apps/ignition/src/app/(auth)/engagements/detail/page.js).
const CARD_PAYLOADS = {
  DealTermsCard: { deal_type: 'paid', payment_terms: null, payment_amount: 5000, affiliate_pct: null,
    commission_amount: null, campaign_id: null, ad_rights: null, ad_rights_amount: null, ad_rights_duration: null },
  CostsCard: { return_cost: 0 },   // S373: the card's ad_spend input was retired (ads have their own card)
  PostLiveCard: { post_date: '2026-09-01' },
  ComplianceCard: { compliance_car_motion: true },
};

test('classifier: every locked card payload is refused on a locked deal, naming its fields', () => {
  for (const [card, patch] of Object.entries(CARD_PAYLOADS)) {
    assert.equal(refused(live(), patch), true, card);
    assert.deepEqual(W.lockedFieldsIn(patch), Object.keys(patch).filter(k => W.LOCKED_FIELDS.includes(k)), card);
    assert.equal(W.lockedFieldsIn(patch).length, Object.keys(patch).length, `${card}: every field it sends is locked`);
  }
});

test('classifier: open fields pass on a locked deal (Performance totals, logistics, POC, UGC)', () => {
  for (const patch of [
    { sessions: 3, orders: 1, conversions_value: 999 },        // DealTotals
    { shipping_order_id: 'X1', tracking_id: 'T', delivered_date: '2026-09-01' },
    { poc_user_id: 'u', poc_name: 'n' },
    { hook_version: 'A', hook_script: 's', meta_ad_id: '1', ctr: 1, purchases: 2 },
    { expected_post_date: '2026-09-20', video_link: 'https://v', utm_link: 'https://u' },
  ]) {
    assert.deepEqual(W.lockedFieldsIn(patch), [], JSON.stringify(patch));
    assert.equal(refused(live(), patch), false);
  }
});

test('classifier: a mixed patch is refused whole (never stripped) and names only the locked fields', () => {
  const patch = { sessions: 3, ad_spend: 10, post_date: '2026-09-01' };
  assert.equal(refused(live(), patch), true);
  assert.deepEqual(W.lockedFieldsIn(patch), ['ad_spend', 'post_date']);
});

test('classifier: inside an unlock window a locked field is allowed; once expired it is refused again', () => {
  const patch = CARD_PAYLOADS.CostsCard;
  assert.equal(refused(live({ unlocked_until: '2026-09-11T18:00:00Z' }), patch), false);
  assert.equal(refused(live({ unlocked_until: '2026-09-11T05:00:00Z' }), patch), true);
});

test('classifier: presence counts — a key sent as null is still a touch', () => {
  assert.deepEqual(W.lockedFieldsIn({ campaign_id: null }), ['campaign_id']);
  assert.deepEqual(W.lockedFieldsIn({}), []);
});

test('LOCK_SELECT carries every column the derivation and the window read', () => {
  const cols = W.LOCK_SELECT.split(',');
  for (const c of ['stage', 'views', 'likes', 'followers_gained', 'total_cost', 'metric_gaps', 'unlocked_until']) {
    assert.ok(cols.includes(c), c);
  }
});
