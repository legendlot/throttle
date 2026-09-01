-- 0029_pnl_manual_month_check_and_null_key_guard.sql — S327 HOSTILE REVIEW of 0028 (same session)
-- ⚠️ This file is the EXACT SQL applied live on 2026-09-01 (migration
-- `odo_pnl_manual_month_check_and_null_key_guard`). Keep them identical.
--
-- Two defects in my own 0028, both latent — neither reachable from the app today, both silent.
--
-- DEFECT 1 — a NULL `p_channel_key` silently drops every manual line, which is EXACTLY the gap
--   0028 exists to close, reached through the front door. `CASE WHEN p_channel_key = 'all'`
--   evaluates NULL = 'all' -> NULL -> not true -> ELSE -> `channel_key = NULL` -> NULL -> no rows
--   -> 0. No error. The worker cannot hit it (`qp('family') || 'all'` coerces '' and null to
--   'all'), but any other RPC caller passing null gets the pre-0028 wrong answer, and it is
--   indistinguishable from "this channel legitimately has no manual lines".
--   Fix: COALESCE(p_channel_key,'all') inside the CASE.
--
-- DEFECT 2 — 0028 matched manual rows with `month BETWEEN date_trunc(from) AND date_trunc(to)`,
--   while f_pnl builds `generate_series(date_trunc(from), date_trunc(to), '1 month')` and matches
--   `m = mo.m` EXACTLY. Those are the same set ONLY while every `month` value is a month start,
--   and nothing enforced that: `sales.pnl_manual` carried only a PK on
--   (month, channel_key, line_key). A mid-month row was legal, and would have been COUNTED by
--   f_pnl_by_product and SILENTLY IGNORED by f_pnl — the same divergence 0028 fixed, running in
--   the opposite direction.
--   ⭐ Fixed at the ROOT, not by patching the predicate: with the CHECK in place, BETWEEN is
--   provably the same set as the generate_series, so the two surfaces cannot disagree again.
--   ⛔ Do NOT drop `pnl_manual_month_is_month_start` without changing f_pnl_by_product's `man`
--   predicate in the same migration.
--
-- SAFE ON BOTH WRITERS — verified BEFORE applying, not assumed:
--   `setPnlManual` (odoops) validates /^\d{4}-\d{2}$/ and writes `month + '-01'`;
--   `sales.recompute_delhivery_logistics` writes
--     date_trunc('month', pickup_at AT TIME ZONE 'Asia/Kolkata')::date.
--   Both existing rows (2026-07-01, 2026-08-01) already satisfy it, so ADD CONSTRAINT validates
--   without a table rewrite. A bad future write now fails LOUDLY.
-- PROVEN TO BIND (not assumed): a DO block inserted month='2026-07-15' and caught
--   check_violation, then inserted '2026-07-01' successfully, then rolled the whole probe back —
--   pnl_manual still holds exactly its 2 website rows, no residue.
--
-- ⛔ ROLLBACK TRAP, and it applies to 0028 as much as to this file: re-running `0027` to revert
--   would `DROP FUNCTION sales.f_pnl_by_product(date,date,uuid[])` — the THREE-arg signature,
--   which no longer exists — and then CREATE the four-arg one ALONGSIDE the live five-arg. Both
--   would be resolvable over PostgREST and every call would fail PGRST203 ambiguous-function.
--   To roll back, DROP the five-arg signature explicitly first:
--     DROP FUNCTION sales.f_pnl_by_product(date, date, uuid[], text[], text);
--   then apply 0027, and drop this CHECK only if you also revert the `man` predicate.

ALTER TABLE sales.pnl_manual
  ADD CONSTRAINT pnl_manual_month_is_month_start
  CHECK (month = date_trunc('month', month)::date);

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
  -- lines (brand_marketing / sga) which the master never adds to logistics either.
  -- ⚠️ COALESCE(p_channel_key,'all') is LOAD-BEARING: without it a NULL key falls through the CASE
  -- to `channel_key = NULL`, matches nothing, and silently returns 0 — indistinguishable from a
  -- channel that genuinely has no manual lines. That is the very bug this function was fixed for.
  -- ⚠️ The BETWEEN is equivalent to f_pnl's generate_series ONLY because
  -- `pnl_manual_month_is_month_start` guarantees every month value is a month start. Do not drop
  -- that CHECK without changing this predicate too, or the two P&L surfaces silently diverge again.
  man AS (
    SELECT COALESCE(SUM(amount_inr) FILTER (WHERE line_key='logistics'),0) logistics,
           COALESCE(SUM(amount_inr) FILTER (WHERE line_key='platform_fee'),0) platform_fee
    FROM sales.pnl_manual
    WHERE month BETWEEN date_trunc('month',p_from)::date AND date_trunc('month',p_to)::date
      AND CASE WHEN COALESCE(p_channel_key,'all') = 'all' THEN channel_key <> 'all'
               ELSE channel_key = p_channel_key END),
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

NOTIFY pgrst, 'reload schema';

-- VERIFIED AFTER APPLYING, in one query:
--   f_pnl website 229546 == f_pnl_by_product website 229546   (0028's pass condition, still holds)
--   f_pnl_by_product(..., NULL) == f_pnl_by_product(..., 'all') == 1381745   (defect 1 fixed;
--     before this migration the NULL form returned 0)
--   pnl_manual_month_is_month_start present; exactly ONE f_pnl_by_product signature.
