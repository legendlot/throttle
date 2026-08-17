-- S294 (2026-08-17) — f_sales_rollup exposes the S158 value measures at product grain.
-- Applied to live as `odo_sales_rollup_value_measures_v1`. Mirror copy (PATTERN-297).
-- ⚠️ Same args + changed RETURNS TABLE requires DROP+CREATE; no overload risk since the
-- argument list is unchanged.

DROP FUNCTION sales.f_sales_rollup(date, date, uuid[], text, text);

CREATE FUNCTION sales.f_sales_rollup(
  p_from date, p_to date,
  p_channels uuid[] DEFAULT NULL,
  p_product_code text DEFAULT NULL,
  p_group text DEFAULT 'variant'
) RETURNS TABLE(
  grp_key text, grp_label text, sale_date date, channel_id uuid, product_code text,
  units bigint, gross_value numeric,
  discount_value numeric, tax_value numeric, returned_units bigint, returned_value numeric
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'sales', 'public' AS $$
  SELECT
    CASE p_group WHEN 'date' THEN f.sale_date::text
                 WHEN 'channel' THEN f.channel_id::text
                 ELSE f.product_code END AS grp_key,
    CASE p_group WHEN 'channel' THEN dc.name
                 WHEN 'variant' THEN btrim(coalesce(pm.product,'')||' '||coalesce(pm.model,'')||' '||coalesce(pm.color,''))
                 ELSE '' END AS grp_label,
    f.sale_date, f.channel_id, f.product_code,
    SUM(f.units)::bigint, SUM(f.gross_value)::numeric,
    SUM(coalesce(f.discount_value,0))::numeric,
    SUM(coalesce(f.tax_value,0))::numeric,
    SUM(coalesce(f.returned_units,0))::bigint,
    SUM(coalesce(f.returned_value,0))::numeric
  FROM sales.sales_fact f
  LEFT JOIN public.dispatch_channels dc ON dc.id=f.channel_id
  LEFT JOIN public.product_master pm ON pm.product_code=f.product_code
  WHERE f.sale_date BETWEEN p_from AND p_to
    AND (p_channels IS NULL OR f.channel_id = ANY(p_channels))
    AND (p_product_code IS NULL OR f.product_code = p_product_code)
  GROUP BY grp_key, grp_label, f.sale_date, f.channel_id, f.product_code
$$;

REVOKE ALL ON FUNCTION sales.f_sales_rollup(date, date, uuid[], text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION sales.f_sales_rollup(date, date, uuid[], text, text) TO service_role;
NOTIFY pgrst, 'reload schema';
