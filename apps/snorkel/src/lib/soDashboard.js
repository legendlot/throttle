// Pure logic behind the Sales Orders date filter + value tiles (Akshay, #bugs 1790855178,
// 2026-10-01: "custom date filter", "Total PO value", "Total fulfilled value", all following the
// channel). No React here, so snorkelops-worker/test can import it directly — keep it JSX-free.
// Relative imports only (node --test has no `@/` alias).

// The order's own date: `order_date` is a Postgres DATE (a calendar day, no timezone maths) and is
// set on every order at capture. A row without one is '' and shows under All time only.
export const soOrderDate = (o) => o?.order_date || '';

export function inDateRange(o, { from, to } = {}) {
  if (!from && !to) return true;
  const d = soOrderDate(o);
  return !!d && (!from || d >= from) && (!to || d <= to);
}

// Both tiles count CONFIRMED orders only: a draft is not yet the partner's PO and a cancelled one
// is void. "PO value" is `grand_total` — the Total column on screen, i.e. what the partner
// ordered. "Fulfilled value" is the worker's `fulfilled_value` (₹ actually despatched, GST incl.)
// — the Fulfilled column — not invoiced and not collected. An order whose fulfilment the worker
// could not read (fulfilled_value null) adds nothing to Fulfilled and is COUNTED in `unknown`, so
// the tile can say so rather than read as a smaller real number.
export function soValueTiles(rows) {
  // `orderedValue` is the LINE-derived ordered ₹ (worker `ordered_value`) — the same basis as
  // fulfilled_value. The "% fulfilled" must divide like by like: grand_total disagrees with its own
  // lines on ~106 of 672 orders (2026-10-06), so fulfilled ÷ grand_total could read above 100%.
  let poValue = 0, orderedValue = 0, fulfilledValue = 0, orders = 0, unknown = 0;
  for (const o of rows || []) {
    if (o?.status !== 'confirmed') continue;
    orders++;
    poValue += Number(o.grand_total) || 0;
    orderedValue += Number(o.ordered_value ?? o.grand_total) || 0;
    if (o.fulfilled_value == null) unknown++;
    else fulfilledValue += Number(o.fulfilled_value) || 0;
  }
  return {
    orders, unknown,
    poValue: Math.round(poValue * 100) / 100,
    orderedValue: Math.round(orderedValue * 100) / 100,
    fulfilledValue: Math.round(fulfilledValue * 100) / 100,
  };
}
