-- 0007_sales_amazon_ads_v1.sql  (Session 157, 2026-06-19)
-- Amazon Ads (Advertising API v3) → marketing domain (mkt_fact, platform='amazon').
-- Mirrors the Meta Ads pattern: own staging table + own recompute (platform hardcoded).
-- Channel/connector inserted DISABLED; flipped on after the adapter deploys + AMAZON_ADS_* secrets set.
CREATE TABLE IF NOT EXISTS sales.stg_amazon_ads (
  id bigserial PRIMARY KEY, run_id bigint, channel_id uuid NOT NULL,
  ad_account_id text, campaign_id text, campaign_name text, the_date date NOT NULL,
  spend numeric NOT NULL DEFAULT 0, impressions bigint NOT NULL DEFAULT 0, clicks bigint NOT NULL DEFAULT 0,
  conversions numeric NOT NULL DEFAULT 0, conv_value numeric NOT NULL DEFAULT 0,
  raw jsonb, ingested_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stg_amazon_ads_chan_date ON sales.stg_amazon_ads (channel_id, the_date);
ALTER TABLE sales.stg_amazon_ads ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION sales.recompute_amzn_ads(p_channel uuid, p_dates date[], p_run_id bigint DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'sales' AS $function$
DECLARE n integer;
BEGIN
  DELETE FROM sales.mkt_fact f WHERE f.channel_id = p_channel AND f.the_date = ANY(p_dates);
  INSERT INTO sales.mkt_fact (the_date, channel_id, platform, ad_account_id, campaign_id, campaign_name,
                              spend, impressions, clicks, conversions, conv_value)
  SELECT s.the_date, s.channel_id, 'amazon', s.ad_account_id, s.campaign_id,
         max(s.campaign_name), sum(s.spend), sum(s.impressions), sum(s.clicks),
         sum(s.conversions), sum(s.conv_value)
    FROM sales.stg_amazon_ads s
   WHERE s.channel_id = p_channel AND s.the_date = ANY(p_dates)
   GROUP BY s.the_date, s.channel_id, s.ad_account_id, s.campaign_id;
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n;
END $function$;

INSERT INTO public.dispatch_channels (id, name, type, fulfillment_model, is_sale, is_active)
VALUES ('00000000-0000-4000-a000-0000000000a3','Amazon Ads','other','unit',false,true)
ON CONFLICT (id) DO NOTHING;
INSERT INTO sales.connector_config (channel_id, adapter_kind, enabled, config)
VALUES ('00000000-0000-4000-a000-0000000000a3','amazon_ads',false,
  jsonb_build_object('region_host','https://advertising-api-eu.amazon.com','ad_product','SPONSORED_PRODUCTS',
                     'backfill_start',(CURRENT_DATE - 60)::text,'profile_id', null))
ON CONFLICT (channel_id) DO NOTHING;
