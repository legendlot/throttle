// COMPLETE-deal lock (S373, Afshaan 2026-09-11) — the worker's copy of the "Complete" derivation.
//
// ⚠️ This is a HAND-KEPT MIRROR of `metricsCompleteness` / `declaredGap` / `GAP_REASONS` in
// apps/ignition/src/lib/metrics.js. The worker and the app are separate deploy units and share no
// package (same arrangement as `productDisplay` ↔ `titleish`), so the rule is duplicated — and
// test/lock.test.mjs imports BOTH copies and asserts they agree on a table of cases. Change one,
// change the other, and that test is what tells you if you did not. The WHY behind every clause
// (views `> 0`, cost has no gap key, a whitespace or unrecognised reason is not an answer) is
// documented at length in the app file; it is not repeated here.
//
// The lock itself: a Complete deal's terms — the five deal-page cards DealTerms, Costs, Post-live,
// Products and Compliance — go read-only. Metrics (Performance), payments, notes, stage, POC,
// logistics and codes stay open. Two ways out: clear a metric or its gap reason (the deal stops
// being Complete, so the lock falls away by derivation), or someone with `ignition_approve` presses
// "Unlock for edit", which opens a 24h window in `engagements.unlocked_until`.

export const GAP_REASONS = {
  internal_gap:  'Internal gap',
  gated_data:    'Gated data',
  system_timing: 'System / timing',
};

const num = (v) => {
  if (v == null || typeof v === 'boolean' || Array.isArray(v) || typeof v === 'object') return null;
  const s = typeof v === 'string' ? v.trim() : v;
  return s === '' || !Number.isFinite(Number(s)) ? null : Number(s);
};

const COMPLETENESS_CHECKS = [
  { label: 'Views',            gapKey: 'views',            test: (e) => num(e.views) > 0 },
  { label: 'Likes',            gapKey: 'likes',            test: (e) => num(e.likes) != null },
  { label: 'Followers gained', gapKey: 'followers_gained', test: (e) => num(e.followers_gained) != null },
  { label: 'Cost',             gapKey: null,               test: (e) => num(e.total_cost) > 0 },
];

function declaredGap(e, gapKey) {
  if (!gapKey) return false;
  const gaps = e.metric_gaps;
  if (!gaps || typeof gaps !== 'object' || Array.isArray(gaps)) return false;
  if (!Object.hasOwn(gaps, gapKey)) return false;
  const reason = gaps[gapKey];
  return typeof reason === 'string' && Object.hasOwn(GAP_REASONS, reason.trim());
}

export function metricsCompleteness(e = {}) {
  const live = String(e.stage || '').toLowerCase() === 'live';
  const missing = [];
  const viaGaps = [];
  for (const c of COMPLETENESS_CHECKS) {
    if (c.test(e)) continue;
    if (declaredGap(e, c.gapKey)) viaGaps.push(c.label);
    else missing.push(c.label);
  }
  return { live, complete: live && missing.length === 0, missing, viaGaps };
}

// Every column the lock check reads. A caller that loads the row for the check must select ALL of
// these — omitting `metric_gaps` would read every declared gap as unfilled (deal looks incomplete,
// i.e. UNLOCKED), which fails open.
export const LOCK_SELECT = 'stage,views,likes,followers_gained,total_cost,metric_gaps,unlocked_until';

/** An unlock window is open when `unlocked_until` is a real time still in the future. */
export function unlockActive(row = {}, now = Date.now()) {
  const t = row.unlocked_until ? Date.parse(row.unlocked_until) : NaN;
  return Number.isFinite(t) && t > now;
}

/** Locked = Complete AND no open unlock window (null, unparseable, or already past = closed). */
export function isLocked(row = {}, now = Date.now()) {
  return metricsCompleteness(row).complete && !unlockActive(row, now);
}

// The fields the five locked cards save through updateEngagement (reconciled against every
// updateEngagement caller in apps/ignition, S373):
//   DealTermsCard  → deal_type, payment_terms, payment_amount, affiliate_pct, commission_amount,
//                    campaign_id, ad_rights, ad_rights_amount, ad_rights_duration
//   CostsCard      → return_cost (S373: its ad_spend input was retired — ad money now lives on the
//                    Ads card, which is NOT locked. `ad_spend` STAYS locked below: it is still a
//                    term of the generated total_cost and the UGC card still writes it.)
//   PostLiveCard   → post_date
//   ComplianceCard → compliance_caption_link, compliance_coupon_verbal, compliance_car_motion
// ProductsCard saves through setEngagementProducts and ComplianceCard's gifted flag through
// markGiftedNoPost — both refused whole when locked, so neither needs a field here.
// NOT locked, deliberately: sessions / orders / conversions_value (Performance → DealTotals), and
// every logistics, POC, UTM, UGC hook/ad/fee field — those cards stay open.
export const LOCKED_FIELDS = [
  'deal_type', 'payment_terms', 'payment_amount', 'affiliate_pct', 'commission_amount',
  'campaign_id', 'ad_rights', 'ad_rights_amount', 'ad_rights_duration',
  'return_cost', 'ad_spend',
  'post_date',
  'compliance_caption_link', 'compliance_coupon_verbal', 'compliance_car_motion',
];

/** Which LOCKED_FIELDS a patch touches, in LOCKED_FIELDS order. Presence counts, not change. */
export function lockedFieldsIn(patch = {}) {
  return LOCKED_FIELDS.filter(k => Object.hasOwn(patch, k));
}

export const LOCKED_MESSAGE = 'deal is complete and locked — unlock it or clear a metric first';
