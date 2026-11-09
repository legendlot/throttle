// Per-line Shopify discount for the product-grain sales_fact (2026-11-09 Odo healthcheck).
//
// ⚠️ `originalTotalSet − discountedTotalSet` sees ONLY line-level discounts. Order-level discount
// CODES (the bulk of LOT's Website discounting) are allocated to lines in `discountAllocations`
// and never move `discountedTotalSet` — proven on #LOT65378: original ₹3,418 = discounted ₹3,418,
// totalDiscountSet ₹0, discountAllocations ₹1,367.20 = the order's totalDiscountsSet. Reading
// only the first form left every Website line at ₹0 discount, so f_pnl's GMV was pre-discount
// (₹11–15L/month, Aug–Oct 2026).
//
// discountAllocations already INCLUDES line-level discounts, so the two must never be summed —
// take the larger (the legacy form survives a response that omits the allocations field) and
// clamp to the line's own gross.
const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

export function shopifyLineDiscount(line) {
  const gross = n(line?.originalTotalSet?.shopMoney?.amount);
  const legacy = Math.max(0, gross - n(line?.discountedTotalSet?.shopMoney?.amount));
  const alloc = (Array.isArray(line?.discountAllocations) ? line.discountAllocations : [])
    .reduce((a, d) => a + n(d?.allocatedAmountSet?.shopMoney?.amount), 0);
  return Math.min(gross, Math.max(legacy, alloc));
}

// The GraphQL selection every Shopify order query must carry for shopifyLineDiscount to work.
export const SHOPIFY_LINE_DISCOUNT_SELECTION = 'discountAllocations{ allocatedAmountSet{ shopMoney{ amount } } }';
