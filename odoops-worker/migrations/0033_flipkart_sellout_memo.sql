-- 0033_flipkart_sellout_memo.sql — Flipkart secondary (consumer sell-out) memo layer. S397, 2026-09-22.
-- Primary = Snorkel PO in sales_fact (unchanged). This layer is memo-only: never read by f_pnl*, recompute_facts, or Tally.
-- Fed by the odoops `flipkart_sellout` adapter from the Flipkart Category Team's daily email (HTML summary + xlsx).

CREATE TABLE sales.sellout_report (
  message_id     text NOT NULL,                       -- Gmail message id (report identity)
  platform       text NOT NULL CHECK (platform IN ('national','minutes','total')),
  source         text NOT NULL DEFAULT 'flipkart_email',
  channel_id     uuid NOT NULL,                       -- Flipkart Managed (the channel the memo describes)
  report_date    date NOT NULL,                       -- from the subject "… | 22-Sep-2026"
  received_at    timestamptz NOT NULL,                -- Gmail internalDate
  atp_qty        integer,
  mtd_units      integer,  mtd_gmv numeric(14,2),
  d1_date        date,     d1_units integer, d1_gmv numeric(14,2),
  d2_date        date,     d2_units integer, d2_gmv numeric(14,2),
  html_path      text,     xlsx_path text,            -- sales-sellout-reports/<report_date>/<message_id>.{html,xlsx}
  sha256         text,                                -- of the xlsx bytes (null when no attachment)
  parser_version integer NOT NULL DEFAULT 1,
  superseded_by  text,                                -- message_id of a later report for the same report_date
  raw            jsonb,
  ingested_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, platform)
);
CREATE INDEX ON sales.sellout_report (channel_id, report_date);

CREATE TABLE sales.sellout_fact (
  source       text NOT NULL,
  channel_id   uuid NOT NULL,
  platform     text NOT NULL CHECK (platform IN ('national','minutes','total')),
  sale_date    date NOT NULL,
  channel_sku  text NOT NULL DEFAULT '*',              -- '*' = platform-level observation; Phase 2 adds FSN rows
  product_code text,
  units        integer,
  gmv          numeric(14,2),
  report_id    text NOT NULL,                          -- sellout_report.message_id that asserted this row
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, channel_id, platform, sale_date, channel_sku)
);
CREATE INDEX ON sales.sellout_fact (channel_id, sale_date);

ALTER TABLE sales.sellout_report ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales.sellout_fact   ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON sales.sellout_report, sales.sellout_fact TO service_role;

-- fulfillment_model is NOT NULL on dispatch_channels: copy whatever the existing synthetic (non-sale) rows use.
INSERT INTO public.dispatch_channels (id, name, type, fulfillment_model, is_sale, is_active)
SELECT '00000000-0000-4000-a000-0000000000c1', 'Flipkart Sell-out (report)', 'other', fulfillment_model, false, true
FROM public.dispatch_channels WHERE id = '00000000-0000-4000-a000-0000000000a1'
ON CONFLICT (id) DO NOTHING;

INSERT INTO sales.connector_config (channel_id, adapter_kind, enabled, cursor, schedule_note, config)
-- enabled=false: the hourly producer spawns every enabled row, and a worker that predates the adapter
-- fails it with 'Unknown adapter' + a Slack alert (happened 2026-09-22 09:00 UTC). Flip to true AFTER deploy.
VALUES ('00000000-0000-4000-a000-0000000000c1', 'flipkart_sellout', false, NULL,
        'hourly cron; Gmail daily report from Flipkart Category Team',
        '{"mailbox":"harsh@legendoftoys.com","target_channel_id":"b157d0f6-b090-402c-bad7-5dfe8e1bba43","sender":"ronak.maru@flipkart.com","subject":"Flipkart Sales Report","lookback_days":21}'::jsonb)
ON CONFLICT (channel_id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public) VALUES ('sales-sellout-reports', 'sales-sellout-reports', false)
ON CONFLICT (id) DO NOTHING;

NOTIFY pgrst, 'reload schema';
