-- 0034_flipkart_sellout_sku.sql — Flipkart sell-out Phase 2: per-FSN snapshot from the archived xlsx. S397c, 2026-09-22.
-- Memo layer (see 0033): nothing here feeds sales_fact / f_pnl* / Tally.
-- sales.sellout_fact already carries FSN rows (channel_sku = FSN, D-1..D-7 from the xlsx); this table is the
-- LATEST snapshot per FSN — title / ATP / MTD as of the newest report — for the FSN table on /channels/flipkart.
-- product_code is resolved at READ time via sales.sku_map (channel_id = Flipkart Managed, channel_sku = FSN),
-- so a mapping made later on /mapping applies without re-ingest.

CREATE TABLE sales.sellout_sku (
  source       text NOT NULL DEFAULT 'flipkart_email',
  channel_id   uuid NOT NULL,                           -- Flipkart Managed
  channel_sku  text NOT NULL,                           -- FSN
  title        text,
  brand        text,
  vertical     text,
  atp_qty      integer,
  mtd_units    integer,
  mtd_gmv      numeric(14,2),
  mtd_label    text,                                    -- "Sep 2026"
  report_date  date NOT NULL,                           -- the report this snapshot came from
  report_id    text NOT NULL,                           -- sellout_report.message_id
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, channel_id, channel_sku)
);

ALTER TABLE sales.sellout_sku ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON sales.sellout_sku TO service_role;

NOTIFY pgrst, 'reload schema';
