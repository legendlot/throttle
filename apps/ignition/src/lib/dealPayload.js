// The createEngagement payload for a new deal, shared by the New Deal page and NewDealModal
// (P0.3, S412) so the two can't drift again. Before this they disagreed (B4): the page sent payment
// amount + terms on EVERY deal type, defaulting terms to on_release, while the modal sent them only
// for paid deals and defaulted to advance. Ruling D7 (Afshaan, 2026-10-07): the modal's rule wins
// on both surfaces.

export const PAID_DEALS = ['paid', 'paid_plus_affiliate'];
export const AFFILIATE_DEALS = ['affiliate', 'paid_plus_affiliate'];
export const isPaidDeal = (dealType) => PAID_DEALS.includes(dealType);
export const isAffiliateDeal = (dealType) => AFFILIATE_DEALS.includes(dealType);

export function initialDealForm(extra = {}) {
  return {
    engagement_type: 'video_tracking', deal_type: 'paid',
    expected_post_date: '',
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
