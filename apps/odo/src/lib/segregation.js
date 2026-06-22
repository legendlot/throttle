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
  a.grossAll = a.gross + a.cancelledValue;          // Total Sales (incl cancellations)
  a.netCancel = a.gross;                            // Net Sales (excl cancellations)
  a.netExGst = a.netCancel - a.tax;                 // Net of GST (tax-inclusive store)
  a.totalOrders = a.orders + a.cancelledOrders;
  a.aov = a.totalOrders ? a.grossAll / a.totalOrders : 0;
  a.cancelRate = a.totalOrders ? a.cancelledOrders / a.totalOrders * 100 : 0;
  return a;
}
