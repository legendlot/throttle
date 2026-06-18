-- salesops migration 0002 — aggregate RPCs (recompute facts + dashboard rollup)
-- Applied via MCP apply_migration (salesops_rpcs_v1). Reference copy.

-- Unified staging view across all adapter staging tables.
CREATE OR REPLACE VIEW sales.v_staged AS
  SELECT channel_id, sale_date, channel_sku, qty, gross_value, is_cancelled, 'shopify'::text src FROM sales.stg_shopify
  UNION ALL SELECT channel_id, sale_date, channel_sku, qty, gross_value, is_cancelled, 'snorkel' FROM sales.stg_snorkel
  UNION ALL SELECT channel_id, sale_date, channel_sku, qty, gross_value, is_cancelled, 'qc' FROM sales.stg_qc;

-- Delete + reinsert facts for (channel, dates) from staging joined through sku_map.
-- The SUM is authoritative → re-pulling a window is a no-op on totals; cancelled rows drop out.
CREATE OR REPLACE FUNCTION sales.recompute_facts(p_channel uuid, p_dates date[], p_run_id bigint DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path = sales, public AS $$
DECLARE n integer;
BEGIN
  DELETE FROM sales.sales_fact WHERE channel_id=p_channel AND sale_date = ANY(p_dates);
  INSERT INTO sales.sales_fact (sale_date, channel_id, product_code, units, gross_value, source_kind, last_run_id)
  SELECT s.sale_date, s.channel_id, m.product_code,
         SUM(s.qty)::int, SUM(s.gross_value)::numeric(14,2), MAX(s.src), p_run_id
  FROM sales.v_staged s
  JOIN sales.sku_map m ON m.channel_id=s.channel_id AND m.channel_sku=s.channel_sku
  WHERE s.channel_id=p_channel AND s.sale_date = ANY(p_dates) AND s.is_cancelled = false
  GROUP BY s.sale_date, s.channel_id, m.product_code
  HAVING SUM(s.qty) <> 0;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
GRANT EXECUTE ON FUNCTION sales.recompute_facts(uuid, date[], bigint) TO service_role;

-- Dashboard rollup. p_group ∈ {variant|date|channel}.
CREATE OR REPLACE FUNCTION sales.f_sales_rollup(
  p_from date, p_to date, p_channels uuid[] DEFAULT NULL,
  p_product_code text DEFAULT NULL, p_group text DEFAULT 'variant')
RETURNS TABLE(grp_key text, grp_label text, sale_date date, channel_id uuid,
              product_code text, units bigint, gross_value numeric)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = sales, public AS $$
  SELECT
    CASE p_group WHEN 'date' THEN f.sale_date::text
                 WHEN 'channel' THEN f.channel_id::text
                 ELSE f.product_code END AS grp_key,
    CASE p_group WHEN 'channel' THEN dc.name
                 WHEN 'variant' THEN btrim(coalesce(pm.product,'')||' '||coalesce(pm.model,'')||' '||coalesce(pm.color,''))
                 ELSE '' END AS grp_label,
    f.sale_date, f.channel_id, f.product_code,
    SUM(f.units)::bigint, SUM(f.gross_value)::numeric
  FROM sales.sales_fact f
  LEFT JOIN public.dispatch_channels dc ON dc.id=f.channel_id
  LEFT JOIN public.product_master pm ON pm.product_code=f.product_code
  WHERE f.sale_date BETWEEN p_from AND p_to
    AND (p_channels IS NULL OR f.channel_id = ANY(p_channels))
    AND (p_product_code IS NULL OR f.product_code = p_product_code)
  GROUP BY grp_key, grp_label, f.sale_date, f.channel_id, f.product_code
$$;
GRANT EXECUTE ON FUNCTION sales.f_sales_rollup(date,date,uuid[],text,text) TO service_role;
