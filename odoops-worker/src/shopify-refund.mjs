// Value of one Shopify refund line, for the line-grain `row_type='return'` row (2026-11-09 Odo healthcheck).
//
// ⚠️ On a tax-INCLUSIVE store (LOT: `taxesIncluded: true`) a refund line's `subtotalSet` ALREADY contains
// the GST. The adapter used to stage `subtotalSet + totalTaxSet`, counting the tax twice — #LOT51546:
// subtotal ₹1,994.05 = the order's totalRefundedSet ₹1,994.05, staged ₹2,298.23. recompute_facts books
// a return row's gross_value as returned_value, so f_pnl's Refund line was overstated by the GST
// (−₹1.83L restated Jun–Nov 2026). Σ subtotal can still sit above the order's totalRefundedSet on
// exchanges / off-Shopify refunds where Shopify moved only the fee (~17 orders, ₹33k Aug–Nov) — that
// is not tax and is out of this function's scope. Only an order explicitly marked tax-EXCLUSIVE
// gets its tax added back, so the value is always the tax-inclusive amount, matching the sale rows.
const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

export function shopifyRefundLineAmount(refundLine, taxesIncluded) {
  const subtotal = n(refundLine?.subtotalSet?.shopMoney?.amount);
  return taxesIncluded === false ? subtotal + n(refundLine?.totalTaxSet?.shopMoney?.amount) : subtotal;
}
