// Standard GST on LOT's toys. Gross is staged tax-INCLUSIVE on every channel, so ex-GST is a
// deterministic strip at this rate — available LIVE from gross with no settlement lag. Marketplace
// settlement (e.g. Amazon Finances) gives the EXACT GST per order, but that posts WEEKS after the
// sale; using it for the headline would make recent net lag/wobble as orders trickle in. So the
// metric derives GST here; the exact settled GST is kept as `gstSettled` for reconciliation only.
// (Afshaan S166 — "live recent data, settled as a refinement".)
// ⭐ S355 (2026-09-07) narrowed that to the channels where it is TRUE. Website (Shopify) and
// GT/MT/Peeko (Snorkel) stage the exact GST per order AT INGEST — no lag to wait out — so the
// order-grain ladder now uses it there (`rowGst` below) and keeps the flat strip only where the
// exact figure genuinely lags (Amazon). A flat 18% under-nets every 5% L.O.T Build line
// (RULE-LOTBUILD-002): GT alone was short ₹6,828 for 1–7 Sep 2026, measured the day this shipped.
// Exported so a surface needing the ex-GST basis strips at THIS rate rather than restating
// 0.18 of its own — one rate, one place.
export const GST_RATE = 0.18;

// Adapters whose `tax_ingest` (f_order_rollup, S355) is the EXACT per-order GST at ingest.
// Everything else keeps the flat strip, each for a measured reason (2026-09-07):
//   amazon_spapi — `tax_ingest` is ~0; the exact GST arrives through Finances WEEKS later and is
//                  only 26% settled at ≤14 days old, so "exact when present" would overstate net
//                  on every recent day. S166 stands for Amazon.
//   uniware      — Firstcry stages `discount` at 68–95% of gross while its tax is computed on the
//                  FULL gross (tax > post-discount base on 124 of 232 rows / 90d), so exact tax
//                  there makes an already-wrong base worse; Cred would move ~₹230/month. Add
//                  `uniware` once the Firstcry discount field is understood (backlog [odo]).
//   qc_upload / Export — zero-rated export sales need an explicit 0% rule here, not a strip.
export const TAX_AT_INGEST_ADAPTERS = new Set(['shopify', 'snorkel_internal']);

// GST to strip from ONE f_order_rollup row's post-discount, tax-inclusive base. Exact only when
// the adapter stages it AND the value is sane: 0 < tax ≤ base. A zero on a positive base means
// "not captured" and a tax above its base is a broken feed — both fall back to the flat strip,
// never to zero (zero GST overstates net, the dangerous direction; same rule as the QC fallback).
export function rowGst(r) {
  const base = Number(r.gross || 0) - Number(r.discount || 0);
  const flat = base - base / (1 + GST_RATE);
  if (!TAX_AT_INGEST_ADAPTERS.has(r.adapter_kind)) return flat;
  const raw = r.tax_ingest;
  const t = (raw === null || raw === undefined || raw === '') ? NaN : Number(raw);
  return (Number.isFinite(t) && t > 0 && t <= base + 0.5) ? t : flat;
}

// Order-grain ladder math over f_order_rollup rows (per sale_date × channel).
// Single definition shared by /performance and the Channels family pages.
export function aggOrders(rows) {
  const a = { gross: 0, cancelledValue: 0, discount: 0, tax: 0, orders: 0, cancelledOrders: 0,
              returnsCount: 0, returnsValue: 0, repl: 0, infl: 0, repair: 0, gstRows: 0 };
  for (const r of (rows || [])) {
    a.gstRows += rowGst(r);
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
  a.gstSettled = a.tax;                             // exact GST, staged + settlement (Amazon's lags weeks; reconciliation only)
  // GST rung (S355): per row — exact where the channel stages it at ingest, flat 18% elsewhere
  // (`rowGst`); returns carry no staged GST, so the returns rung is stripped at the flat rate.
  // For an all-flat row set this is algebraically the old `netReturns − netReturns/1.18`.
  a.tax = a.gstRows - (a.returnsValue - a.returnsValue / (1 + GST_RATE));
  a.netExGst = a.netReturns - a.tax;                // NET REVENUE (ex-GST), the metric
  // Reconciliation confidence: how much of the period's GST is confirmed by marketplace settlement
  // (exact gstSettled) vs the live 18% estimate (a.tax). ~100% = fully reconciled (older periods,
  // real-time channels like Shopify); low = recent marketplace sales whose settlement hasn't posted.
  a.settledPct = a.tax > 0 ? Math.min(100, Math.round(a.gstSettled / a.tax * 100)) : null;
  // ₹0 REPLACEMENTS ARE NOT ORDERS (Afshaan, S274). A free replacement is a fulfilment event, not a
  // sale: it carries no revenue but did occupy a slot in the count, so it dragged AOV = gross ÷ orders
  // purely by existing. Measured 2026-08-13 over 60 days: 1,070 of Amazon's 11,460 non-cancelled
  // orders are `amz_replacement` — 9.3%, and ALL 1,070 are exactly ₹0 (the tag and the zero agree
  // perfectly, 1070/1070). No other channel has any. So they are excluded from the headline order
  // count and from AOV; the Replacements tile still counts them, so nothing is hidden.
  //   ⚠️ `replacement_orders` is a STRICT SUBSET of `orders` — sales.f_order_rollup filters both on
  //   `row_kind='order' AND NOT is_cancelled` — so this subtraction cannot go negative or double-count.
  //   Verified against the function definition, not assumed.
  //   `ordersAll`/`totalOrdersAll` keep the un-excluded counts, because reconciling against Amazon's
  //   own order count needs the literal number.
  a.ordersAll = a.orders;
  a.orders = Math.max(0, a.orders - a.repl);
  a.totalOrdersAll = a.ordersAll + a.cancelledOrders;
  a.totalOrders = a.orders + a.cancelledOrders;
  // AOV excludes cancellations on BOTH sides — the e-commerce team's definition (gross sales
  // excl. cancellations ÷ orders excl. cancellations), and the only one that reads as a basket
  // size. Dividing all-in gross by all-in orders understated Amazon's June AOV as ₹1,532 against
  // Amazon's own ₹1,953, purely because ~22% of Amazon orders cancel and carry ~no value.
  a.aov = a.orders ? a.gross / a.orders : 0;
  // Cancel rate uses the same replacement-free basis as the count above it, so the two tiles agree.
  a.cancelRate = a.totalOrders ? a.cancelledOrders / a.totalOrders * 100 : 0;
  return a;
}

// Hybrid headline (cockpit). Order-grain (f_order_rollup) is COMPLETE within a channel —
// it counts an order's whole value regardless of whether each line's SKU is mapped — but only
// some channels stage order rows (Website, Amazon, Flipkart/uniware, GT/MT). Others (QC quick-
// commerce — Zepto/Blinkit/Instamart) are product-grain only. Using order-grain wholesale would
// fix the Amazon/Website sku-map undercount but DROP QC entirely. So per channel: use order-grain
// where present, else fall back to product-grain gross. Result is complete + never undercounts.
//   orderRows   = f_order_rollup rows (sale_date × channel)            — getSegregation
//   productRows = f_sales_rollup rows (variant grain; channel_id, gross_value, units) — getSales
// Units come from product-grain only (order-grain carries no unit count). QC has no order-level
// discount/return data, so its net is gross minus GST — see the tax note on the loop below.
//
// ⭐ THE FALLBACK USES THE REAL PER-SKU GST, NOT A FLAT 18% STRIP (S328, 2026-09-01).
// `f_sales_rollup` has returned `tax_value` since S294 and `sales.fill_qc_tax` populates it per-HSN
// on every QC row (measured 2026-09-01: 100% non-null across all 6,010 Blinkit/Zepto/Instamart
// `sales_fact` rows). Recomputing `fbGross/1.18` here THREW THAT AWAY and over-taxed every L.O.T
// Build SKU, which is 5% (RULE-LOTBUILD-002), understating net revenue.
//   Measured 2026-09-01, all time: Blinkit stored GST ₹10,22,171 vs flat-18% ₹10,63,587
//   — net was understated by ₹41,416 (Blinkit's implied blended rate is 14.66%).
//   Instamart (₹2.49) and Zepto (₹0.64) are ~zero: their catalogue is genuinely all-18%, so the
//   flat strip was already right there. The whole QC exposure was one channel.
// ✅ The ORDER-grain ladder got the same treatment in S355 (2026-09-07): `aggOrders` uses the
// GST staged at ingest per row (`rowGst`) for Shopify/Snorkel channels and keeps the flat strip
// only where the exact figure lags (Amazon). "The ladder has no product dimension" was never the
// constraint — the order grain carries the exact per-order tax; it was simply being overwritten.
// ⚠️ Per-ROW fallback is deliberate: a row with no `tax_value` (a future fallback channel that
// `fill_qc_tax` does not cover) degrades to the flat strip rather than reading as zero GST, which
// would OVERSTATE net — the dangerous direction on a financial surface.
export function hybridHeadline(orderRows, productRows) {
  const og = aggOrders(orderRows);
  const ogChannels = new Set((orderRows || []).map(r => r.channel_id));
  let fbGross = 0, fbGst = 0, units = 0;
  const fbChannels = new Set();
  for (const r of (productRows || [])) {
    units += Number(r.units) || 0;
    if (ogChannels.has(r.channel_id)) continue;
    const g = Number(r.gross_value) || 0;
    // ⚠️ Test ABSENCE before coercing: `Number('') === 0`, which is finite and not null, so a
    // blank `tax_value` would read as ZERO GST and OVERSTATE net — the dangerous direction, and
    // the exact thing the per-row fallback exists to prevent. A real `0`/`'0'` is left alone,
    // because zero tax is a legitimate value. (Own-diff hostile review, S328.)
    const raw = r.tax_value;
    const t = (raw === null || raw === undefined || raw === '') ? NaN : Number(raw);
    fbGross += g;
    fbGst += Number.isFinite(t) ? t : g - g / (1 + GST_RATE);
    fbChannels.add(r.channel_id);
  }
  const grossAll = og.grossAll + fbGross;                    // complete gross (P&L, tax-incl)
  const netExGst = og.netExGst + (fbGross - fbGst);          // complete net revenue (ex-GST)
  const totalGst = og.tax + fbGst;
  return {
    ...og,
    grossAll, netExGst, units,
    asp: units ? grossAll / units : 0,
    // Confidence over the WHOLE headline: only order-grain settlement is ever "confirmed".
    // The QC fallback GST is now HSN-derived rather than a flat 18% guess, but it is still not
    // marketplace-settled, so it correctly keeps dragging the badge down. Do not "promote" it.
    settledPct: totalGst > 0 ? Math.min(100, Math.round(og.gstSettled / totalGst * 100)) : null,
    ogChannelCount: ogChannels.size,
    fallbackChannelCount: fbChannels.size,
  };
}
