// The createEngagement payload for a new deal, shared by the New Deal page and NewDealModal
// (P0.3, S412) so the two can't drift again. Before this they disagreed (B4): the page sent payment
// amount + terms on EVERY deal type, defaulting terms to on_release, while the modal sent them only
// for paid deals and defaulted to advance. Ruling D7 (Afshaan, 2026-10-07): the modal's rule wins
// on both surfaces.

export const PAID_DEALS = ['paid', 'paid_plus_affiliate'];
export const AFFILIATE_DEALS = ['affiliate', 'paid_plus_affiliate'];
export const isPaidDeal = (dealType) => PAID_DEALS.includes(dealType);
export const isAffiliateDeal = (dealType) => AFFILIATE_DEALS.includes(dealType);

// Reann #3: an affiliate-type deal must carry its commission % (0 < pct ≤ 100) — the monthly
// commission is worked out from it. Same rule and sentence as the worker's affiliatePctRefusal (422).
export const AFFILIATE_PCT_REQUIRED = 'An affiliate deal needs its commission % (more than 0, at most 100).';
const pctOk = v => v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) <= 100;
export function affiliatePctProblem(dealType, pct) {
  return isAffiliateDeal(dealType) && !pctOk(pct) ? AFFILIATE_PCT_REQUIRED : null;
}
// On an edit, as the worker's affiliatePctPatchRefusal: only when THIS edit makes it wrong (the deal
// type moves to affiliate, or the % changes). The one legacy affiliate deal with no % (IGN-2026-00903)
// can still save an unrelated change.
export function affiliatePctEditProblem(cur, next) {
  const norm = v => (v == null || v === '' ? null : Number(v));
  const typeChanged = next.deal_type !== cur.deal_type;
  const pctChanged = norm(next.affiliate_pct) !== norm(cur.affiliate_pct);
  if (!typeChanged && !pctChanged) return null;
  return affiliatePctProblem(next.deal_type, next.affiliate_pct);
}

export function initialDealForm(extra = {}) {
  return {
    engagement_type: 'video_tracking', deal_type: 'paid',
    expected_post_date: '',
    post_date_fixed: false,
    deliverables: '',
    campaign_id: '',
    payment_amount: '', payment_terms: 'advance', affiliate_pct: '',
    poc_user_id: null, poc_name: null,
    ...extra,
  };
}

/** `products` is linesToPayload(lines), already resolved by the caller. */
export function dealPayload(form, influencerId, products = []) {
  const payload = { influencer_id: influencerId, ...form };
  if (!payload.expected_post_date) delete payload.expected_post_date;
  if (form.engagement_type === 'ugc') payload.post_date_fixed = false;   // UGC never uses the contract
  if (String(payload.deliverables ?? '').trim()) payload.deliverables = payload.deliverables.trim();
  else delete payload.deliverables;
  if (!payload.campaign_id) delete payload.campaign_id;
  // Compensation only applies to paid deals; affiliate % only to affiliate deals.
  // A paid deal with the amount left blank keeps the terms that were picked (S412 review: the old
  // modal dropped them too, which is how 3 paid deals landed with NULL terms in Sep 2026); the blank
  // amount is omitted and takes the DB default.
  if (!isPaidDeal(form.deal_type)) { delete payload.payment_amount; delete payload.payment_terms; }
  else if (payload.payment_amount === '') delete payload.payment_amount;
  else payload.payment_amount = Number(payload.payment_amount);
  if (isAffiliateDeal(form.deal_type) && payload.affiliate_pct !== '') payload.affiliate_pct = Number(payload.affiliate_pct);
  else delete payload.affiliate_pct;
  if (products.length) payload.products = products;
  return payload;
}
