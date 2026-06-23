// Standard GST on LOT's toys. Gross is staged tax-INCLUSIVE on every channel, so ex-GST is a
// deterministic strip at this rate — available LIVE from gross with no settlement lag. Marketplace
// settlement (e.g. Amazon Finances) gives the EXACT GST per order, but that posts WEEKS after the
// sale; using it for the headline would make recent net lag/wobble as orders trickle in. So the
// metric derives GST here; the exact settled GST is kept as `gstSettled` for reconciliation only.
// (Afshaan S166 — "live recent data, settled as a refinement".)
const GST_RATE = 0.18;

// Order-grain ladder math over f_order_rollup rows (per sale_date × channel).
// Single definition shared by /performance and the Channels family pages.
export function aggOrders(rows) {
  const a = { gross: 0, cancelledValue: 0, discount: 0, tax: 0, orders: 0, cancelledOrders: 0,
              returnsCount: 0, returnsValue: 0, repl: 0, infl: 0, repair: 0 };
  for (const r of (rows || [])) {
    a.gross += Number(r.gross || 0);
    a.cancelledValue += Number(r.cancelled_value || 0);
    a.discount += Number(r.discount || 0);
    a.tax += Number(r.tax || 0);
    a.orders += Number(r.orders || 0);
    a.cancelledOrders += Number(r.cancelled_orders || 0);
    a.returnsCount += Number(r.returns_count || 0);
    a.returnsValue += Number(r.returns_value || 0);
    a.repl += Number(r.replacement_orders || 0);
    a.infl += Number(r.influencer_orders || 0);
    a.repair += Number(r.repair_orders || 0);
  }
  // NET-revenue ladder (Afshaan S164): NET = gross − discounts − cancellations − returns − GST,
  // ex-GST everywhere. Gross rungs are tax-inclusive (every channel now stages tax-incl gross +
  // true GST separately); the final rung strips GST to the taxable base = THE net-revenue metric.
  a.grossAll = a.gross + a.cancelledValue;          // Total Sales — gross, incl. cancellations + GST (P&L only)
  a.netCancel = a.gross;                            // after cancellations (non-cancelled, pre-discount, tax-incl)
  a.netDisc = a.gross - a.discount;                 // after discounts
  a.netReturns = a.netDisc - a.returnsValue;        // after returns (realized tax-incl revenue)
  a.gstSettled = a.tax;                             // exact GST from settlement (lags weeks; reconciliation only)
  a.tax = a.netReturns - a.netReturns / (1 + GST_RATE);  // GST stripped at the standard rate — LIVE, derived from gross
  a.netExGst = a.netReturns - a.tax;                // = netReturns / 1.18 — NET REVENUE (ex-GST), the metric
  a.totalOrders = a.orders + a.cancelledOrders;
  a.aov = a.totalOrders ? a.grossAll / a.totalOrders : 0;
  a.cancelRate = a.totalOrders ? a.cancelledOrders / a.totalOrders * 100 : 0;
  return a;
}
