-- 0006_sales_order_rollup_cancelled_value.sql  (Session 157, 2026-06-19)
-- Add cancelled_value to sales.f_order_rollup so the Performance dashboard can show the full
-- ladder: Total Sales (gross incl cancelled = gross + cancelled_value) -> Net of cancellations
-- (gross, which already excludes cancelled). Recreate required (RETURNS TABLE column add);
-- function is new this session (0004), no dependents.
DROP FUNCTION IF EXISTS sales.f_order_rollup(date, date, uuid[]);
CREATE FUNCTION sales.f_order_rollup(p_from date, p_to date, p_channels uuid[] DEFAULT NULL)
RETURNS TABLE(
  sale_date date, channel_id uuid,
  orders bigint, cancelled_orders bigint,
  gross numeric, cancelled_value numeric, discount numeric, tax numeric,
  returns_count bigint, returns_value numeric,
  replacement_orders bigint, influencer_orders bigint, repair_orders bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'sales','public' AS $function$
  WITH o AS (
    SELECT s.*,
      COALESCE(ARRAY(
        SELECT DISTINCT r.order_type FROM sales.order_type_rules r
        WHERE r.is_active AND (r.channel_id IS NULL OR r.channel_id = s.channel_id)
          AND EXISTS (SELECT 1 FROM unnest(s.tags) t WHERE
                (r.match_kind='tag_exact'  AND lower(t)=lower(r.pattern)) OR
                (r.match_kind='tag_prefix' AND lower(t) LIKE lower(r.pattern)||'%'))
      ), '{}')::text[] AS types
    FROM sales.stg_orders s
    WHERE s.sale_date BETWEEN p_from AND p_to
      AND (p_channels IS NULL OR s.channel_id = ANY(p_channels))
  )
  SELECT sale_date, channel_id,
    COUNT(*)  FILTER (WHERE row_kind='order' AND NOT is_cancelled),
    COUNT(*)  FILTER (WHERE row_kind='order' AND is_cancelled),
    COALESCE(SUM(gross)    FILTER (WHERE row_kind='order' AND NOT is_cancelled),0),
    COALESCE(SUM(gross)    FILTER (WHERE row_kind='order' AND is_cancelled),0),
    COALESCE(SUM(discount) FILTER (WHERE row_kind='order' AND NOT is_cancelled),0),
    COALESCE(SUM(tax)      FILTER (WHERE row_kind='order' AND NOT is_cancelled),0),
    COUNT(*)  FILTER (WHERE row_kind='return'),
    COALESCE(SUM(returned_value) FILTER (WHERE row_kind='return'),0),
    COUNT(*)  FILTER (WHERE row_kind='order' AND NOT is_cancelled AND 'replacement'=ANY(types)),
    COUNT(*)  FILTER (WHERE row_kind='order' AND NOT is_cancelled AND 'influencer'=ANY(types)),
    COUNT(*)  FILTER (WHERE row_kind='order' AND NOT is_cancelled AND 'repair'=ANY(types))
  FROM o
  GROUP BY sale_date, channel_id
$function$;
GRANT EXECUTE ON FUNCTION sales.f_order_rollup(date,date,uuid[]) TO service_role;
