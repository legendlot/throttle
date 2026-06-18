-- salesops migration 0001 — sales schema + salesops permission tables + connector_config seed
-- Applied to Supabase project jkxcnjabmrkteanzoofj via MCP apply_migration (sales_schema_v1, salesops_roles_v1)
-- + PostgREST exposed-schemas append + connector_config seed (execute_sql). Reference copy.

CREATE SCHEMA IF NOT EXISTS sales;

CREATE TABLE sales.sales_fact (
  id bigserial PRIMARY KEY,
  sale_date date NOT NULL,
  channel_id uuid NOT NULL,                 -- = public.dispatch_channels.id
  product_code text NOT NULL,               -- = public.product_master.product_code (variant dim)
  units integer NOT NULL DEFAULT 0,
  gross_value numeric(14,2) NOT NULL DEFAULT 0,
  currency char(3) NOT NULL DEFAULT 'INR',
  source_kind text NOT NULL,                -- shopify|snorkel|qc|amazon|flipkart
  last_run_id bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sale_date, channel_id, product_code)   -- idempotency / upsert key
);
CREATE INDEX ON sales.sales_fact (channel_id, sale_date);
CREATE INDEX ON sales.sales_fact (product_code, sale_date);

CREATE TABLE sales.connector_config (
  channel_id uuid PRIMARY KEY,              -- → public.dispatch_channels.id
  adapter_kind text NOT NULL,               -- shopify|snorkel_internal|qc_upload|amazon_spapi|flipkart_v3
  enabled boolean NOT NULL DEFAULT false,
  cursor text,                              -- live incremental watermark
  schedule_note text,
  last_ok_at timestamptz,
  last_error text
);

CREATE TABLE sales.connector_runs (
  id bigserial PRIMARY KEY,
  channel_id uuid NOT NULL,
  adapter_kind text NOT NULL,
  trigger text NOT NULL,                    -- cron|manual|upload|backfill
  window_from timestamptz, window_to timestamptz,
  cursor_before text, cursor_after text,
  status text NOT NULL DEFAULT 'running',   -- running|ok|partial|error
  rows_fetched int DEFAULT 0, rows_mapped int DEFAULT 0, rows_unmapped int DEFAULT 0,
  facts_upserted int DEFAULT 0, subrequests_used int,
  error text,
  started_at timestamptz DEFAULT now(), finished_at timestamptz, started_by uuid
);
CREATE INDEX ON sales.connector_runs (channel_id, started_at DESC);

CREATE TABLE sales.sku_map (
  id bigserial PRIMARY KEY,
  channel_id uuid NOT NULL,
  channel_sku text NOT NULL,                -- ASIN/FSN/listing-id/shopify sku/portal SKU
  product_code text NOT NULL,
  match_on text,                            -- sku|ean|product_code|manual
  created_by uuid, created_at timestamptz DEFAULT now(),
  UNIQUE (channel_id, channel_sku)
);

CREATE TABLE sales.unmapped_sku (
  id bigserial PRIMARY KEY,
  channel_id uuid NOT NULL,
  channel_sku text NOT NULL,
  sample_title text,
  first_seen timestamptz DEFAULT now(), last_seen timestamptz,
  occurrences integer DEFAULT 1,
  pending_units integer DEFAULT 0, pending_gross numeric(14,2) DEFAULT 0,
  status text DEFAULT 'open',               -- open|resolved|ignored
  resolved_product_code text, resolved_by uuid, resolved_at timestamptz,
  UNIQUE (channel_id, channel_sku)
);

CREATE TABLE sales.upload_batch (
  id bigserial PRIMARY KEY,
  channel_id uuid NOT NULL,
  storage_path text NOT NULL,               -- private bucket salesops-uploads
  file_name text, mime_type text,
  report_period_from date, report_period_to date,
  status text DEFAULT 'uploaded',           -- uploaded|parsed|mapped|error
  rows_total int, rows_mapped int, rows_unmapped int,
  uploaded_by uuid, uploaded_at timestamptz DEFAULT now(), parsed_at timestamptz, error text
);

CREATE TABLE sales.stg_shopify (
  id bigserial PRIMARY KEY, run_id bigint, channel_id uuid NOT NULL,
  source_order_id text, order_name text, source_line_id text NOT NULL,
  occurred_at timestamptz, sale_date date,
  channel_sku text, variant_title text, title text,
  qty integer, gross_value numeric(14,2),
  order_status text, is_cancelled boolean DEFAULT false,
  raw jsonb, ingested_at timestamptz DEFAULT now(),
  UNIQUE (source_line_id)
);

CREATE TABLE sales.stg_snorkel (
  id bigserial PRIMARY KEY, run_id bigint, channel_id uuid NOT NULL,
  source_order_id text, source_line_id text NOT NULL,
  sale_date date, channel_sku text, title text,
  qty integer, gross_value numeric(14,2),
  order_status text, is_cancelled boolean DEFAULT false,
  raw jsonb, ingested_at timestamptz DEFAULT now(),
  UNIQUE (source_line_id)
);

CREATE TABLE sales.stg_qc (
  id bigserial PRIMARY KEY, run_id bigint, channel_id uuid NOT NULL,
  upload_batch_id bigint NOT NULL, row_no int NOT NULL,
  sale_date date, channel_sku text, title text,
  qty integer, gross_value numeric(14,2),
  is_cancelled boolean DEFAULT false,
  raw jsonb, ingested_at timestamptz DEFAULT now(),
  UNIQUE (upload_batch_id, row_no)
);

-- RLS on every table (service_role bypasses; no anon policy = locked, mirrors manifest/docket)
ALTER TABLE sales.sales_fact      ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales.connector_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales.connector_runs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales.sku_map         ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales.unmapped_sku    ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales.upload_batch    ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales.stg_shopify     ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales.stg_snorkel     ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales.stg_qc          ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA sales TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA sales TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA sales TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA sales GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA sales GRANT ALL ON SEQUENCES TO service_role;

-- ── Permission layer (in store, mirrors snorkel/manifest) ──
CREATE TABLE store.salesops_roles (
  id bigserial PRIMARY KEY,
  role_key text UNIQUE NOT NULL,
  label text NOT NULL,
  description text,
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_system boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE store.salesops_user_roles (
  user_id uuid PRIMARY KEY,
  role_key text NOT NULL REFERENCES store.salesops_roles(role_key),
  active boolean NOT NULL DEFAULT true,
  assigned_by uuid, assigned_at timestamptz DEFAULT now(),
  disabled_at timestamptz, disabled_by uuid
);
ALTER TABLE store.salesops_roles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE store.salesops_user_roles ENABLE ROW LEVEL SECURITY;
GRANT ALL ON store.salesops_roles TO service_role;
GRANT ALL ON store.salesops_user_roles TO service_role;
GRANT ALL ON SEQUENCE store.salesops_roles_id_seq TO service_role;

INSERT INTO store.salesops_roles (role_key, label, description, permissions, is_system) VALUES
('admin','Administrator','Full access incl. access control',
 '{"sales_view":true,"sales_refresh":true,"sales_upload":true,"sales_mapping_manage":true,"sales_connector_manage":true,"salesops_admin":true,"salesops_super_admin":true}'::jsonb, true),
('analyst','Analyst','View + export + refresh + mapping + upload',
 '{"sales_view":true,"sales_refresh":true,"sales_upload":true,"sales_mapping_manage":true}'::jsonb, true),
('viewer','Viewer','Read-only dashboard + export',
 '{"sales_view":true}'::jsonb, true);

-- ── PostgREST exposed schemas (append sales) ──
-- ALTER ROLE authenticator SET pgrst.db_schemas = 'public, graphql_public, store, brand, ignition, podium, docket, manifest, sales';
-- NOTIFY pgrst, 'reload config';

-- ── connector_config seed from dispatch_channels (is_sale=true) ──
-- Website→shopify, GT/MT→snorkel_internal (enabled); all others→qc_upload (disabled).
-- INSERT … SELECT … FROM public.dispatch_channels WHERE is_sale=true ON CONFLICT DO NOTHING;
