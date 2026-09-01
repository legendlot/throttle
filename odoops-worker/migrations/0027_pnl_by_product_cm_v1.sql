-- 0027_pnl_by_product_cm_v1.sql — S325
-- Per-product P&L extended from GM to CM1/CM2 (fast-follow ① of the split /pnl v2 entry).
-- ⚠️ This file is the EXACT SQL applied live on 2026-08-31. Keep them identical.
-- ⚠️ SUPERSEDED BY 0028 (2026-09-01) — the "It does NOT hold for a channel with MANUAL lines"
--    limit in the reconciliation contract below is CLOSED: f_pnl_by_product now reads
--    `sales.pnl_manual` via a p_channel_key arg. Kept verbatim as the record of what was
--    applied that day; read 0028 for the live definition.
--
-- WHY THIS SHAPE
--   f_pnl_by_product stopped at GM. Amazon is the only channel with per-SKU cost inputs, and
--   both are live: settlement_fact carries product_code (fee_commission/fba/storage/refund/other)
--   and mkt_product_fact carries per-product_code spend. Both join public.product_master at
--   100% (48/48 and 43/43 codes, Jul-Aug 2026, measured S325); product_master has no duplicate
--   product_code (210/210 distinct), so the join cannot fan out.
--
-- THE FOUR TRAPS, all measured rather than assumed (Jul-Aug 2026):
--   1. fee_advertising is NOT inside fees_total — proven arithmetically: fees_total (-2,650,932)
--      equals SUM(commission+fba+storage+refund+other) exactly. It is ad spend arriving by a
--      second route, and f_pnl itself never reads it. ⛔ NEVER add it to a fee line: that
--      double-counts CAC. Amazon ad spend disagrees three ways over the period —
--      fee_advertising 4,739,607 · mkt_fact 4,148,063 · mkt_product_fact 3,980,023 — and this
--      function uses mkt_product_fact, the only one at product grain.
--   2. The account-level pool is NOT a small residual and NOT a cost — it is a large CREDIT.
--      134 of 2,597 settlement rows carry no product_code and net to -960,422 of platform fee
--      (dominated by fee_other reimbursements) against a channel platform-fee total of
--      +1,498,734. ⛔ Do NOT pro-rate it across SKUs — allocating a credit that size makes
--      every per-SKU CM indefensible. It is returned as its own 'Account-level' row.
--   3. Fees are keyed on SETTLEMENT date, sales on SALE date — the same accrual mismatch f_pnl
--      already carries. Kept identical so the two surfaces agree; do not "fix" it here alone.
--   4. A product can have fees in the range but no sales (and vice versa). Keys are UNIONed
--      from all three sources, not LEFT JOINed off sales, or such a product's fees vanish.
--
-- RECONCILIATION CONTRACT — AND ITS LIMIT (corrected by the S325 hostile review):
--   Σ all rows, residual INCLUDED, equals f_pnl's gmv/cogs/logistics/platform_fee/cac for the
--   same channels+platforms ONLY where those lines are SETTLEMENT-derived. Verified for Amazon
--   to ±3 rupees on CM2 (per-row ROUND()).
--   ⛔ It does NOT hold for a channel with MANUAL lines. This function never reads
--   `sales.pnl_manual`, which f_pnl adds — so for Website, f_pnl logistics is ₹2,29,546 (the
--   Delhivery invoice row) while this returns 0. The gap is silent.
--   That is survivable ONLY because the worker's `has_cm` refuses to show CM columns unless a
--   REAL product carries cost, which keeps such a channel on the GM view. If you ever loosen
--   `has_cm`, fold `pnl_manual` into the residual FIRST (it needs a p_channel_key arg).
-- ⚠️ Compare the two IN ONE QUERY. The 5-minute recompute cron moves sales_fact between calls;
-- two figures read minutes apart differ by thousands and look like a bug that is not there.

DROP FUNCTION IF EXISTS sales.f_pnl_by_product(date, date, uuid[]);

CREATE OR REPLACE FUNCTION sales.f_pnl_by_product(
  p_from date, p_to date, p_channels uuid[] DEFAULT NULL::uuid[], p_ad_platforms text[] DEFAULT NULL::text[])
RETURNS TABLE(product text, units numeric, gmv numeric, returns_val numeric, taxes numeric,
              cogs numeric, logistics numeric, platform_fee numeric, cac numeric, is_residual boolean)
LANGUAGE sql STABLE SET search_path TO 'sales', 'public'
AS $fn$
  WITH s AS (
    SELECT pm.product, SUM(f.units) units,
      SUM(COALESCE(f.gross_value,0)-COALESCE(f.discount_value,0)) gmv,
      SUM(COALESCE(f.returned_value,0)) returns_val, SUM(COALESCE(f.tax_value,0)) taxes
    FROM sales.sales_fact f JOIN public.product_master pm ON pm.product_code=f.product_code
    WHERE f.sale_date BETWEEN p_from AND p_to AND (p_channels IS NULL OR f.channel_id = ANY(p_channels))
    GROUP BY pm.product),
  u AS (SELECT f.product_code, SUM(f.units) units FROM sales.sales_fact f
    WHERE f.sale_date BETWEEN p_from AND p_to AND (p_channels IS NULL OR f.channel_id = ANY(p_channels))
    GROUP BY f.product_code),
  c AS (SELECT pm.product, SUM(u.units * pc.cogs_inr) cogs
    FROM u JOIN public.product_master pm ON pm.product_code=u.product_code
    CROSS JOIN LATERAL (SELECT p.cogs_inr FROM sales.product_cost p
      WHERE p.product_code=u.product_code AND p.effective_from <= p_to
      ORDER BY p.effective_from DESC LIMIT 1) pc
    GROUP BY pm.product),
  -- One pass over settlement_fact, LEFT JOINed so unattributable rows survive as product IS NULL.
  -- Mirrors f_pnl's split EXACTLY: platform = -(commission+other+refund), logistics = -(fba+storage).
  sf AS (SELECT pm.product AS product,
      COALESCE(sfx.fee_fba,0)+COALESCE(sfx.fee_storage,0) AS logi,
      COALESCE(sfx.fee_commission,0)+COALESCE(sfx.fee_other,0)+COALESCE(sfx.fee_refund,0) AS plat
    FROM sales.settlement_fact sfx LEFT JOIN public.product_master pm ON pm.product_code=sfx.product_code
    WHERE sfx.the_date BETWEEN p_from AND p_to AND (p_channels IS NULL OR sfx.channel_id = ANY(p_channels))),
  fee AS (SELECT product, -SUM(logi) logistics, -SUM(plat) platform_fee
    FROM sf WHERE product IS NOT NULL GROUP BY product),
  ad AS (SELECT pm.product, SUM(COALESCE(mp.spend,0)) cac
    FROM sales.mkt_product_fact mp JOIN public.product_master pm ON pm.product_code=mp.product_code
    WHERE mp.the_date BETWEEN p_from AND p_to AND (p_ad_platforms IS NULL OR mp.platform = ANY(p_ad_platforms))
    GROUP BY pm.product),
  -- Unattributable: settlement rows with no joinable product_code, plus the gap between
  -- channel-level (mkt_fact, what f_pnl uses) and product-level (mkt_product_fact) ad spend.
  resid AS (SELECT
      (SELECT -COALESCE(SUM(logi),0) FROM sf WHERE product IS NULL) logistics,
      (SELECT -COALESCE(SUM(plat),0) FROM sf WHERE product IS NULL) platform_fee,
      (SELECT COALESCE(SUM(COALESCE(mf.spend,0)),0) FROM sales.mkt_fact mf
        WHERE mf.the_date BETWEEN p_from AND p_to
          AND (p_ad_platforms IS NULL OR mf.platform = ANY(p_ad_platforms)))
      - (SELECT COALESCE(SUM(cac),0) FROM ad) cac),
  keys AS (SELECT product FROM s UNION SELECT product FROM fee UNION SELECT product FROM ad),
  body AS (SELECT k.product, ROUND(COALESCE(s.units,0)) units, ROUND(COALESCE(s.gmv,0)) gmv,
      ROUND(COALESCE(s.returns_val,0)) returns_val, ROUND(COALESCE(s.taxes,0)) taxes,
      ROUND(COALESCE(c.cogs,0)) cogs, ROUND(COALESCE(fee.logistics,0)) logistics,
      ROUND(COALESCE(fee.platform_fee,0)) platform_fee, ROUND(COALESCE(ad.cac,0)) cac, false is_residual
    FROM keys k
    LEFT JOIN s ON s.product=k.product LEFT JOIN c ON c.product=k.product
    LEFT JOIN fee ON fee.product=k.product LEFT JOIN ad ON ad.product=k.product
    WHERE COALESCE(s.gmv,0)<>0 OR COALESCE(s.units,0)<>0 OR COALESCE(fee.logistics,0)<>0
       OR COALESCE(fee.platform_fee,0)<>0 OR COALESCE(ad.cac,0)<>0)
  SELECT * FROM body
  UNION ALL
  SELECT 'Account-level (unattributable)', 0,0,0,0,0,
         ROUND(r.logistics), ROUND(r.platform_fee), ROUND(r.cac), true
  FROM resid r
  WHERE ROUND(r.logistics)<>0 OR ROUND(r.platform_fee)<>0 OR ROUND(r.cac)<>0
  ORDER BY is_residual, gmv DESC;
$fn$;

GRANT EXECUTE ON FUNCTION sales.f_pnl_by_product(date, date, uuid[], text[]) TO service_role;
NOTIFY pgrst, 'reload schema';
