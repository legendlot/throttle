-- 0004_sales_value_segregation_v1.sql  (Session 157, 2026-06-19)
-- Odo sales-value segregation: discounts + tax + returns measures on the product fact,
-- a new order/return staging layer for order-grain metrics (orders/AOV/cancel-rate/returns/tags),
-- and a data-driven order-type tag classification config.
-- Additive + idempotent. Existing gross facts are untouched until a recompute reruns.
-- Applied via Supabase apply_migration (name: sales_value_segregation_v1).
-- Design: docs/superpowers/specs/2026-06-19-odo-sales-segregation-design.md

-- 1) Line staging: per-line measures + sale/return marker (4 sell-out staging tables)
ALTER TABLE sales.stg_shopify ADD COLUMN IF NOT EXISTS row_type text NOT NULL DEFAULT 'sale',
  ADD COLUMN IF NOT EXISTS discount_value numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_value numeric NOT NULL DEFAULT 0;
ALTER TABLE sales.stg_amazon ADD COLUMN IF NOT EXISTS row_type text NOT NULL DEFAULT 'sale',
  ADD COLUMN IF NOT EXISTS discount_value numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_value numeric NOT NULL DEFAULT 0;
ALTER TABLE sales.stg_snorkel ADD COLUMN IF NOT EXISTS row_type text NOT NULL DEFAULT 'sale',
  ADD COLUMN IF NOT EXISTS discount_value numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_value numeric NOT NULL DEFAULT 0;
ALTER TABLE sales.stg_qc ADD COLUMN IF NOT EXISTS row_type text NOT NULL DEFAULT 'sale',
  ADD COLUMN IF NOT EXISTS discount_value numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_value numeric NOT NULL DEFAULT 0;

-- 2) v_staged: surface the new cols (appended at end -> CREATE OR REPLACE compatible)
CREATE OR REPLACE VIEW sales.v_staged AS
  SELECT channel_id, sale_date, channel_sku, qty, gross_value, is_cancelled, 'shopify'::text AS src,
         row_type, discount_value, tax_value FROM sales.stg_shopify
  UNION ALL
  SELECT channel_id, sale_date, channel_sku, qty, gross_value, is_cancelled, 'snorkel'::text,
         row_type, discount_value, tax_value FROM sales.stg_snorkel
  UNION ALL
  SELECT channel_id, sale_date, channel_sku, qty, gross_value, is_cancelled, 'qc'::text,
         row_type, discount_value, tax_value FROM sales.stg_qc
  UNION ALL
  SELECT channel_id, sale_date, channel_sku, qty, gross_value, is_cancelled, 'amazon'::text,
         row_type, discount_value, tax_value FROM sales.stg_amazon;

-- 3) sales_fact: product-grain measures (sale side + return side)
ALTER TABLE sales.sales_fact
  ADD COLUMN IF NOT EXISTS discount_value numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_value numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS returned_units integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS returned_value numeric NOT NULL DEFAULT 0;

-- 4) Order/return staging layer (order-grain source of truth for order metrics)
CREATE TABLE IF NOT EXISTS sales.stg_orders (
  id            bigserial PRIMARY KEY,
  run_id        bigint,
  channel_id    uuid NOT NULL,
  source_order_id text NOT NULL,
  refund_id     text,
  row_kind      text NOT NULL DEFAULT 'order' CHECK (row_kind IN ('order','return')),
  sale_date     date NOT NULL,
  order_name    text,
  gross         numeric NOT NULL DEFAULT 0,
  discount      numeric NOT NULL DEFAULT 0,
  tax           numeric NOT NULL DEFAULT 0,
  currency      char(3),
  is_cancelled  boolean NOT NULL DEFAULT false,
  returned_value numeric NOT NULL DEFAULT 0,
  tags          text[] NOT NULL DEFAULT '{}',
  raw           jsonb,
  ingested_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS stg_orders_uniq
  ON sales.stg_orders (channel_id, source_order_id, row_kind, COALESCE(refund_id,''));
CREATE INDEX IF NOT EXISTS stg_orders_chan_date ON sales.stg_orders (channel_id, sale_date);
ALTER TABLE sales.stg_orders ENABLE ROW LEVEL SECURITY;

-- 5) Order-type classification rules (data-driven; seeded once the real tags are known)
CREATE TABLE IF NOT EXISTS sales.order_type_rules (
  id          bigserial PRIMARY KEY,
  channel_id  uuid,                          -- NULL = applies to all channels
  match_kind  text NOT NULL DEFAULT 'tag_prefix' CHECK (match_kind IN ('tag_prefix','tag_exact')),
  pattern     text NOT NULL,
  order_type  text NOT NULL,                 -- replacement | influencer | repair | ...
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sales.order_type_rules ENABLE ROW LEVEL SECURITY;

-- 6) recompute_facts: product fact now carries discount/tax (sale side) + returned (refund side)
CREATE OR REPLACE FUNCTION sales.recompute_facts(p_channel uuid, p_dates date[], p_run_id bigint DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'sales','public' AS $function$
DECLARE n integer;
BEGIN
  DELETE FROM sales.sales_fact WHERE channel_id=p_channel AND sale_date = ANY(p_dates);
  INSERT INTO sales.sales_fact (sale_date, channel_id, product_code, units, gross_value,
                                discount_value, tax_value, returned_units, returned_value,
                                source_kind, last_run_id)
  SELECT s.sale_date, s.channel_id, m.product_code,
         COALESCE(SUM(s.qty)         FILTER (WHERE s.row_type='sale' AND s.is_cancelled=false),0)::int,
         COALESCE(SUM(s.gross_value) FILTER (WHERE s.row_type='sale' AND s.is_cancelled=false),0)::numeric(14,2),
         COALESCE(SUM(s.discount_value) FILTER (WHERE s.row_type='sale' AND s.is_cancelled=false),0)::numeric(14,2),
         COALESCE(SUM(s.tax_value)   FILTER (WHERE s.row_type='sale' AND s.is_cancelled=false),0)::numeric(14,2),
         COALESCE(SUM(s.qty)         FILTER (WHERE s.row_type='return'),0)::int,
         COALESCE(SUM(s.gross_value) FILTER (WHERE s.row_type='return'),0)::numeric(14,2),
         MAX(s.src), p_run_id
  FROM sales.v_staged s
  JOIN sales.sku_map m ON m.channel_id=s.channel_id AND m.channel_sku=s.channel_sku
  WHERE s.channel_id=p_channel AND s.sale_date = ANY(p_dates)
  GROUP BY s.sale_date, s.channel_id, m.product_code
  HAVING COALESCE(SUM(s.qty) FILTER (WHERE s.row_type='sale' AND s.is_cancelled=false),0) <> 0
      OR COALESCE(SUM(s.qty) FILTER (WHERE s.row_type='return'),0) <> 0;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $function$;

-- 7) f_order_rollup: order-grain headline metrics, read live from stg_orders + classification
CREATE OR REPLACE FUNCTION sales.f_order_rollup(p_from date, p_to date, p_channels uuid[] DEFAULT NULL)
RETURNS TABLE(
  sale_date date, channel_id uuid,
  orders bigint, cancelled_orders bigint,
  gross numeric, discount numeric, tax numeric,
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
