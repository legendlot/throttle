// One CPM (Reann #7), the app-side twin of cpmCostOf + cpmStats in ignitionops-worker, for tiles that
// compute over the rows on screen. Blended = cost of deals with views ÷ their organic views × 1,000.
// Median = the middle deal's own CPM. Commission stays out of the cost; ad rights already left total_cost.
const n = v => Number(v) || 0;
export function cpmCost(e) {
  return e.total_cost != null ? Math.max(0, n(e.total_cost) - n(e.commission_amount)) : n(e.payment_amount);
}
export function cpmStats(deals) {
  const viewed = (deals || []).filter(d => n(d.views) > 0);
  if (!viewed.length) return { blended: null, median: null, deals: 0 };
  const cost = viewed.reduce((t, d) => t + n(d.cost), 0);
  const views = viewed.reduce((t, d) => t + n(d.views), 0);
  const each = viewed.map(d => n(d.cost) / n(d.views) * 1000).sort((a, b) => a - b);
  const mid = Math.floor(each.length / 2);
  return { blended: cost / views * 1000, median: each.length % 2 ? each[mid] : (each[mid - 1] + each[mid]) / 2, deals: viewed.length };
}
export const cpmLabel = v => (v == null ? '—' : `₹${Number(v).toFixed(0)}`);
