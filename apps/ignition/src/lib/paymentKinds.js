// Payment kind labels (redesign Phase 2, S412). The stored `kind` values stay advance/final/other;
// "final" reads "Balance" everywhere a person sees it — the Payments list, the record modal and the
// engagement Payments card must agree.
// 'commission' (Reann #3) is a monthly affiliate commission paid through Snorkel — outside the fee.
export const PAYMENT_KIND_LABEL = { advance: 'Advance', final: 'Balance', other: 'Other', commission: 'Commission' };
export const paymentKindLabel = (kind) => PAYMENT_KIND_LABEL[kind] || kind;
