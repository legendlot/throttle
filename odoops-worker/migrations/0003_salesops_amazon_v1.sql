-- odoops migration 0003 — Amazon (SP-API) staging (Phase 2)
-- Applied to Supabase project jkxcnjabmrkteanzoofj via MCP apply_migration (salesops_amazon_v1), Session 154.
-- Adds sales.stg_amazon + extends the sales.v_staged UNION so recompute_facts picks Amazon up.
-- The amazon_spapi ADAPTER code (worker) is NOT yet written — Phase 2 is paused pending the
-- Amazon Production app (the user must complete SP-API identity/business-doc verification first).

CREATE TABLE sales.stg_amazon (
  id bigserial PRIMARY KEY,
  run_id bigint,
  channel_id uuid NOT NULL,
  source_order_id text,
  sale_date date,
  channel_sku text,
  title text,
  qty integer,
  gross_value numeric(14,2),
  order_status text,
  is_cancelled boolean DEFAULT false,
  raw jsonb,
  ingested_at timestamptz DEFAULT now()
);
ALTER TABLE sales.stg_amazon ENABLE ROW LEVEL SECURITY;
GRANT ALL ON sales.stg_amazon TO service_role;
GRANT ALL ON SEQUENCE sales.stg_amazon_id_seq TO service_role;
CREATE INDEX ON sales.stg_amazon (channel_id, sale_date);

CREATE OR REPLACE VIEW sales.v_staged AS
  SELECT channel_id, sale_date, channel_sku, qty, gross_value, is_cancelled, 'shopify'::text src FROM sales.stg_shopify
  UNION ALL SELECT channel_id, sale_date, channel_sku, qty, gross_value, is_cancelled, 'snorkel' FROM sales.stg_snorkel
  UNION ALL SELECT channel_id, sale_date, channel_sku, qty, gross_value, is_cancelled, 'qc' FROM sales.stg_qc
  UNION ALL SELECT channel_id, sale_date, channel_sku, qty, gross_value, is_cancelled, 'amazon' FROM sales.stg_amazon;
