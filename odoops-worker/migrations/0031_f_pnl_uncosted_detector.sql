-- 0031 — sales.f_pnl_uncosted: missing COGS must not look like margin (S364, 2026-09-09)
--
-- f_pnl's cogs_agg uses CROSS JOIN LATERAL on `effective_from <= month-end`, so a product with no
-- cost layer at or before that month DROPS OUT of the join: revenue counted, COGS silently absent,
-- month renders as excellent margin. Hid ₹17,28,717 across 12 codes for months.
--
-- ⛔ NOT fixed by making that lateral LEFT — numerically a no-op (a dropped row and a
-- COALESCE(...,0) row both contribute zero COGS), so it buys nothing while requiring a rewrite of a
-- live super-admin P&L function. The defect is invisibility, not arithmetic. This is additive.
--
-- Proven 2026-09-09 in a rolled-back transaction: deleting ONE layer (MCBK FY24-25) removed
-- ₹3,17,520 of COGS from f_pnl (= 240 units × ₹1323, exact) with no other signal anywhere, while
-- this detector caught 4 product-months / ₹7,91,760.
--
-- Consumed by odoops `/pnl` as `uncosted` {ok, rows, gross_total}; a FAILED read reports ok:false
-- rather than an empty list, because "all costed" is the reassuring direction.
CREATE OR REPLACE FUNCTION sales.f_pnl_uncosted(
  p_from date, p_to date, p_channels uuid[] DEFAULT NULL)
RETURNS TABLE(month date, product_code text, units bigint, gross numeric)
LANGUAGE sql STABLE AS $function$
  WITH span AS (
    SELECT date_trunc('month', p_from)::date AS lo,
           (date_trunc('month', p_to) + interval '1 month - 1 day')::date AS hi
  ),
  sold AS (
    SELECT date_trunc('month', f.sale_date)::date AS m, f.product_code,
           SUM(f.units)::bigint AS units, SUM(f.gross_value)::numeric AS gross
    FROM sales.sales_fact f, span
    WHERE f.sale_date BETWEEN span.lo AND span.hi
      AND (p_channels IS NULL OR cardinality(p_channels) = 0 OR f.channel_id = ANY(p_channels))
    GROUP BY 1, 2
  )
  SELECT s.m, s.product_code, s.units, s.gross
  FROM sold s
  WHERE s.units > 0
    AND NOT EXISTS (
      SELECT 1 FROM sales.product_cost p
       WHERE p.product_code = s.product_code
         AND p.effective_from <= (s.m + interval '1 month - 1 day')::date)
  ORDER BY s.gross DESC, s.m;
$function$;

GRANT EXECUTE ON FUNCTION sales.f_pnl_uncosted(date, date, uuid[]) TO service_role;
