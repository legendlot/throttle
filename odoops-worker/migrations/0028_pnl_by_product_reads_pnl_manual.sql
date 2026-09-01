-- 0028_pnl_by_product_reads_pnl_manual.sql — S327
-- Closes the reconciliation hole 0027's own header names: f_pnl_by_product never read
-- `sales.pnl_manual`, so it silently under-reported any channel carrying manual P&L lines.
-- ⚠️ This file is the EXACT SQL applied live on 2026-09-01 (migration
-- `odo_pnl_by_product_reads_pnl_manual`). Keep them identical.
-- ⚠️ AMENDED SAME DAY BY 0029 — this version carries TWO latent defects that its own hostile
--    review found: a NULL `p_channel_key` silently returns 0 manual cost (the very bug this file
--    fixes, through the front door), and the `month BETWEEN` predicate diverges from f_pnl's
--    exact month-start matching for any mid-month row, which nothing prevented. **Read 0029 for
--    the live definition.**
-- ⛔ ROLLBACK TRAP: re-running 0027 to revert would DROP the THREE-arg signature (which no longer
--    exists) and CREATE a four-arg one ALONGSIDE the live five-arg — both resolvable over
--    PostgREST, so every call would fail PGRST203. Drop the five-arg explicitly first:
--    `DROP FUNCTION sales.f_pnl_by_product(date, date, uuid[], text[], text);`
--
-- MEASURED BEFORE (Jul–Aug 2026, both figures read IN ONE QUERY per 0027's own warning — the
-- 5-minute recompute cron moves sales_fact between calls):
--   Website  f_pnl logistics ₹2,29,546  ·  f_pnl_by_product ₹0        ← the gap
--   Amazon   f_pnl logistics ₹11,52,198 ·  f_pnl_by_product ₹11,52,199 ← already reconciled
-- The ₹2,29,546 is exactly the two auto-written Delhivery invoice rows in `sales.pnl_manual`
-- (2026-07 ₹95,700.92 + 2026-08 ₹1,33,844.75), written by `sales.recompute_delhivery_logistics`
-- (0026). MEASURED AFTER: six of the seven families reconcile line-for-line; the seventh ('other')
-- has no sales and no fees at all, so f_pnl_by_product returns NULL over an empty set against
-- f_pnl's 0 — an empty-set artifact that predates this change, not a discrepancy. And the
-- unscoped view now equals the /pnl master row (Σ families) to the same ±₹1.
--
-- WHY THE RESIDUAL ROW
--   `pnl_manual` is CHANNEL-keyed and MONTH-grained. A row can never attribute to a SKU, so
--   pro-rating it would invent per-product cost. The 'Account-level (unattributable)' row exists
--   for exactly this — money that is real, is the channel's, and pins to no product.
--
-- THREE THINGS THAT LOOK WRONG AND ARE NOT
--   1. p_channel_key='all' sums every FAMILY key (channel_key <> 'all'), NOT the literal 'all'
--      key. /pnl's master row is the SUM OF THE PER-FAMILY TABLES; f_pnl reserves the 'all' key
--      for company-level lines (brand_marketing / sga), which the master never folds into
--      logistics either. Reading 'all' literally would return ₹0 unscoped while the master
--      showed the Delhivery cost — the same silent gap, moved one view across.
--   2. Month grain on a day range: a partial-month range still carries the WHOLE month's manual
--      line. f_pnl behaves identically (it generate_series()es months), and `pnl_manual` has no
--      finer grain to pro-rate from. Do not "fix" this on one side only.
--   3. `has_cm` is UNCHANGED and must stay that way. It ignores the residual by design (S325
--      hostile review, throttle cbd7ea49) — so Website gains a correct ₹2,29,546 residual and
--      still renders on the GM view, i.e. this fix is invisible on screen. That is the intended
--      order of operations: fold pnl_manual in FIRST, decide about loosening has_cm SECOND.
--
-- ⚠️ DROP-then-CREATE, not a bare CREATE OR REPLACE: adding p_channel_key changes the signature,
-- and leaving the 4-arg version in place would make BOTH resolvable over PostgREST → PGRST203
-- ambiguous-function on every call. Verified afterwards that exactly ONE signature survives.
-- ⚠️ p_channel_key must describe the SAME channels as p_channels. They are not cross-checked in
-- SQL; the worker derives both from one family key (`getPnlByProduct`). A mismatch would
-- silently attribute one channel's manual cost to another's products.

DROP FUNCTION IF EXISTS sales.f_pnl_by_product(date, date, uuid[], text[]);

CREATE OR REPLACE FUNCTION sales.f_pnl_by_product(
  p_from date, p_to date,
  p_channels uuid[] DEFAULT NULL::uuid[],
  p_ad_platforms text[] DEFAULT NULL::text[],
  p_channel_key text DEFAULT 'all'::text)
 RETURNS TABLE(product text, units numeric, gmv numeric, returns_val numeric, taxes numeric, cogs numeric, logistics numeric, platform_fee numeric, cac numeric, is_residual boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'sales', 'public'
AS $function$
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
  -- Manual / auto-derived P&L lines. sales.pnl_manual is CHANNEL-keyed and MONTH-grained, so a row
  -- can never attribute to a SKU — it belongs in the residual, which is precisely what that row is
  -- for. Mirrors f_pnl's `man` CTE so the two functions agree line-for-line; only the two lines
  -- f_pnl folds into logistics / platform_fee are read here (rto / brand_marketing / sga are not
  -- columns of this function).
  -- ⚠️ p_channel_key='all' sums every FAMILY key rather than the literal 'all' key, because /pnl's
  -- master row is the SUM OF THE PER-FAMILY TABLES; f_pnl's 'all' key is reserved for company-level
  -- lines (brand_marketing / sga) which the master never adds to logistics either. Reading 'all'
  -- literally here would return 0 for the unscoped view while the master showed the Delhivery cost.
  -- ⚠️ p_channel_key must describe the SAME channels as p_channels — the caller derives both from
  -- one family key. They are not cross-checked here and a mismatch would silently mis-attribute.
  -- ⚠️ Month grain is deliberate and matches f_pnl: a partial-month range still carries the WHOLE
  -- month's manual line, because pnl_manual has no finer grain to pro-rate from.
  man AS (
    SELECT COALESCE(SUM(amount_inr) FILTER (WHERE line_key='logistics'),0) logistics,
           COALESCE(SUM(amount_inr) FILTER (WHERE line_key='platform_fee'),0) platform_fee
    FROM sales.pnl_manual
    WHERE month BETWEEN date_trunc('month',p_from)::date AND date_trunc('month',p_to)::date
      AND CASE WHEN p_channel_key = 'all' THEN channel_key <> 'all' ELSE channel_key = p_channel_key END),
  -- Unattributable: settlement rows with no joinable product_code, the channel's manual lines,
  -- plus the gap between channel-level (mkt_fact, what f_pnl uses) and product-level
  -- (mkt_product_fact) ad spend.
  resid AS (SELECT
      (SELECT -COALESCE(SUM(logi),0) FROM sf WHERE product IS NULL)
        + (SELECT logistics FROM man) logistics,
      (SELECT -COALESCE(SUM(plat),0) FROM sf WHERE product IS NULL)
        + (SELECT platform_fee FROM man) platform_fee,
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
$function$;

GRANT EXECUTE ON FUNCTION sales.f_pnl_by_product(date, date, uuid[], text[], text) TO service_role;

NOTIFY pgrst, 'reload schema';

-- PASS CONDITION (the backlog item's own, generalised to every family — run as ONE query):
--   WITH fam AS (
--     SELECT id, name,
--       CASE WHEN name ~* 'website|shopify|web'                 THEN 'website'
--            WHEN name ~* 'amazon'                              THEN 'amazon'
--            WHEN name ~* 'flipkart'                            THEN 'flipkart'
--            WHEN name ~* 'blinkit|zepto|instamart|swiggy|quick' THEN 'quickcom'
--            WHEN name ~* '^(gt|mt)$|general trade|modern trade' THEN 'gtmt'
--            WHEN name ~* 'cred|firstcry|peeko'                 THEN 'longtail'
--            ELSE 'other' END AS k
--     FROM public.dispatch_channels WHERE is_sale),
--   g AS (SELECT k, array_agg(id) ids FROM fam GROUP BY k),
--   ads AS (SELECT * FROM (VALUES ('website',ARRAY['meta','google']),('amazon',ARRAY['amazon']),
--      ('flipkart',ARRAY[]::text[]),('quickcom',ARRAY[]::text[]),('gtmt',ARRAY[]::text[]),
--      ('longtail',ARRAY[]::text[]),('other',ARRAY[]::text[])) v(k,a))
--   SELECT g.k,
--     (SELECT ROUND(SUM(logistics)) FROM sales.f_pnl(:from,:to,g.ids,ads.a,g.k))            pnl,
--     (SELECT ROUND(SUM(logistics)) FROM sales.f_pnl_by_product(:from,:to,g.ids,ads.a,g.k)) byprod
--   FROM g JOIN ads ON ads.k=g.k ORDER BY 1;
-- Every row must match to ±₹1 (per-row ROUND()). Family 'other' returns NULL from
-- f_pnl_by_product against f_pnl's 0 when it has no sales and no fees at all — SUM over zero
-- rows, not a discrepancy; that predates this change.
