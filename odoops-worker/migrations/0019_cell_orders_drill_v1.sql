-- S294 (2026-08-17) — per-cell drill-through: order lines under a cockpit Detail slice.
-- Applied to live as `odo_cell_orders_drill_v1`. ⚠️ This file is a MIRROR of the applied
-- migration (PATTERN-297: never rebuild a live function from a repo copy — use pg_get_functiondef).

CREATE INDEX IF NOT EXISTS stg_shopify_chan_date_idx ON sales.stg_shopify (channel_id, sale_date);
CREATE INDEX IF NOT EXISTS stg_snorkel_chan_date_idx ON sales.stg_snorkel (channel_id, sale_date);
CREATE INDEX IF NOT EXISTS stg_qc_chan_date_idx      ON sales.stg_qc      (channel_id, sale_date);
CREATE INDEX IF NOT EXISTS stg_amazon_fin_chan_posted_idx ON sales.stg_amazon_fin (channel_id, posted_date);

CREATE OR REPLACE FUNCTION sales.f_cell_orders(
  p_from date, p_to date,
  p_channels uuid[] DEFAULT NULL,
  p_products text[] DEFAULT NULL,
  p_limit int DEFAULT 500
) RETURNS TABLE(
  src text, channel_id uuid, sale_date date, source_order_id text, order_ref text,
  channel_sku text, product_code text, row_type text, is_cancelled boolean,
  qty int, gross_value numeric
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'sales', 'public' AS $$
  WITH lines AS (
    SELECT 'shopify'::text AS src, s.channel_id, s.sale_date, s.source_order_id,
           s.order_name AS order_ref, s.channel_sku, s.row_type, s.is_cancelled, s.qty, s.gross_value
      FROM sales.stg_shopify s
     WHERE s.sale_date BETWEEN p_from AND p_to
       AND (p_channels IS NULL OR s.channel_id = ANY(p_channels))
    UNION ALL
    SELECT 'snorkel', s.channel_id, s.sale_date, s.source_order_id, s.source_order_id,
           s.channel_sku, s.row_type, s.is_cancelled, s.qty, s.gross_value
      FROM sales.stg_snorkel s
     WHERE s.sale_date BETWEEN p_from AND p_to
       AND (p_channels IS NULL OR s.channel_id = ANY(p_channels))
    UNION ALL
    SELECT 'qc', s.channel_id, s.sale_date, NULL, NULL,
           s.channel_sku, s.row_type, s.is_cancelled, s.qty, s.gross_value
      FROM sales.stg_qc s
     WHERE s.sale_date BETWEEN p_from AND p_to
       AND (p_channels IS NULL OR s.channel_id = ANY(p_channels))
    UNION ALL
    SELECT 'amazon', s.channel_id, s.sale_date, s.source_order_id, s.source_order_id,
           s.channel_sku, s.row_type, s.is_cancelled, s.qty, s.gross_value
      FROM sales.stg_amazon s
     WHERE s.sale_date BETWEEN p_from AND p_to
       AND (p_channels IS NULL OR s.channel_id = ANY(p_channels))
    UNION ALL
    SELECT 'uniware', s.channel_id, s.sale_date, s.source_order_id, s.source_order_id,
           s.channel_sku, s.row_type, s.is_cancelled, s.qty, s.gross_value
      FROM sales.stg_uniware s
     WHERE s.sale_date BETWEEN p_from AND p_to
       AND (p_channels IS NULL OR s.channel_id = ANY(p_channels))
    UNION ALL
    -- amazon_fin refunds only; the qty0/gross0 'shipment' enrichment branch is EXCLUDED
    -- (it would double-print every Amazon order id).
    SELECT 'amazon_fin', f.channel_id, f.posted_date, f.amazon_order_id, f.amazon_order_id,
           f.seller_sku, 'return'::text, false, f.qty, (f.principal + f.tax)::numeric(14,2)
      FROM sales.stg_amazon_fin f
     WHERE f.event_type = 'refund'
       AND f.posted_date BETWEEN p_from AND p_to
       AND (p_channels IS NULL OR f.channel_id = ANY(p_channels))
  )
  SELECT l.src, l.channel_id, l.sale_date, l.source_order_id, l.order_ref, l.channel_sku,
         m.product_code, l.row_type, l.is_cancelled, l.qty, l.gross_value
    FROM lines l
    JOIN sales.sku_map m ON m.channel_id = l.channel_id AND m.channel_sku = l.channel_sku
   WHERE (p_products IS NULL OR m.product_code = ANY(p_products))
   ORDER BY l.sale_date DESC, l.gross_value DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 500), 1), 2000)
$$;

REVOKE ALL ON FUNCTION sales.f_cell_orders(date, date, uuid[], text[], int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION sales.f_cell_orders(date, date, uuid[], text[], int) TO service_role;
NOTIFY pgrst, 'reload schema';
