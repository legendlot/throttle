-- 0009_sales_meta_ads_ad_level_v1.sql  (2026-06-29)
-- Ad-level (level=ad) Meta insights → its OWN fact table sales.mkt_fact_ad (does NOT touch
-- the existing campaign-grain sales.mkt_fact). Lets the LOT Ad Engine attribute ROAS to a
-- SPECIFIC creative/ad, not just a campaign. Populated best-effort by metaAdsAdapter (recent
-- ~14d window); campaign ingestion is unchanged. Pure additions — safe to apply live.

-- Staging (one row per ad per day per run)
CREATE TABLE IF NOT EXISTS sales.stg_meta_ad (
  id bigserial PRIMARY KEY, run_id bigint, channel_id uuid NOT NULL,
  ad_account_id text, campaign_id text, campaign_name text,
  adset_id text, adset_name text, ad_id text, ad_name text, the_date date NOT NULL,
  spend numeric NOT NULL DEFAULT 0, impressions bigint NOT NULL DEFAULT 0, clicks bigint NOT NULL DEFAULT 0,
  conversions numeric NOT NULL DEFAULT 0, conv_value numeric NOT NULL DEFAULT 0,
  raw jsonb, ingested_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, ad_account_id, ad_id, the_date)
);
CREATE INDEX IF NOT EXISTS stg_meta_ad_chan_date ON sales.stg_meta_ad (channel_id, the_date);
ALTER TABLE sales.stg_meta_ad ENABLE ROW LEVEL SECURITY;

-- Fact (federated, deduped per ad/day)
CREATE TABLE IF NOT EXISTS sales.mkt_fact_ad (
  id bigserial PRIMARY KEY, channel_id uuid NOT NULL, ad_account_id text,
  campaign_id text, campaign_name text, adset_id text, adset_name text,
  ad_id text, ad_name text, the_date date NOT NULL,
  spend numeric NOT NULL DEFAULT 0, impressions bigint NOT NULL DEFAULT 0, clicks bigint NOT NULL DEFAULT 0,
  conversions numeric NOT NULL DEFAULT 0, conv_value numeric NOT NULL DEFAULT 0,
  last_run_id bigint, updated_at timestamptz DEFAULT now(),
  UNIQUE (channel_id, ad_account_id, ad_id, the_date)
);
CREATE INDEX IF NOT EXISTS mkt_fact_ad_chan_date ON sales.mkt_fact_ad (channel_id, the_date);
ALTER TABLE sales.mkt_fact_ad ENABLE ROW LEVEL SECURITY;

-- recompute: refresh mkt_fact_ad for the given dates from stg_meta_ad (mirrors recompute_amzn_ads).
CREATE OR REPLACE FUNCTION sales.recompute_mkt_ad(p_channel uuid, p_dates date[], p_run_id bigint DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'sales' AS $function$
DECLARE n integer;
BEGIN
  DELETE FROM sales.mkt_fact_ad f WHERE f.channel_id = p_channel AND f.the_date = ANY(p_dates);
  INSERT INTO sales.mkt_fact_ad (the_date, channel_id, ad_account_id, campaign_id, campaign_name,
                                 adset_id, adset_name, ad_id, ad_name,
                                 spend, impressions, clicks, conversions, conv_value, last_run_id)
  SELECT s.the_date, s.channel_id, s.ad_account_id, s.campaign_id, max(s.campaign_name),
         s.adset_id, max(s.adset_name), s.ad_id, max(s.ad_name),
         sum(s.spend), sum(s.impressions), sum(s.clicks), sum(s.conversions), sum(s.conv_value), p_run_id
    FROM sales.stg_meta_ad s
   WHERE s.channel_id = p_channel AND s.the_date = ANY(p_dates)
   GROUP BY s.the_date, s.channel_id, s.ad_account_id, s.campaign_id, s.adset_id, s.ad_id;
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n;
END $function$;
GRANT EXECUTE ON FUNCTION sales.recompute_mkt_ad(uuid, date[], bigint) TO service_role;

-- rollup: ad-level performance for the engine. ROAS = conv_value/spend (compute client-side).
-- p_group ∈ {ad (default), adset, campaign, date}.
CREATE OR REPLACE FUNCTION sales.f_mkt_ad_rollup(p_from date, p_to date, p_group text DEFAULT 'ad')
RETURNS TABLE(grp text, label text, campaign_id text, adset_id text, ad_id text,
              spend numeric, impressions bigint, clicks bigint, conversions numeric, conv_value numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'sales' AS $function$
  SELECT grp, label, campaign_id, adset_id, ad_id, spend, impressions, clicks, conversions, conv_value FROM (
    SELECT CASE WHEN p_group='campaign' THEN campaign_id
                WHEN p_group='adset'    THEN adset_id
                WHEN p_group='date'     THEN the_date::text
                ELSE ad_id END AS grp,
           CASE WHEN p_group='campaign' THEN max(campaign_name)
                WHEN p_group='adset'    THEN max(adset_name)
                WHEN p_group='date'     THEN max(the_date::text)
                ELSE max(ad_name) END AS label,
           max(campaign_id) AS campaign_id, max(adset_id) AS adset_id,
           CASE WHEN p_group='ad' THEN max(ad_id) ELSE NULL END AS ad_id,
           sum(spend) AS spend, sum(impressions) AS impressions, sum(clicks) AS clicks,
           sum(conversions) AS conversions, sum(conv_value) AS conv_value
      FROM sales.mkt_fact_ad
     WHERE the_date BETWEEN p_from AND p_to
     GROUP BY 1
  ) q
  ORDER BY spend DESC;
$function$;
GRANT EXECUTE ON FUNCTION sales.f_mkt_ad_rollup(date, date, text) TO service_role;

GRANT ALL ON sales.stg_meta_ad TO service_role;
GRANT ALL ON sales.mkt_fact_ad TO service_role;
GRANT ALL ON SEQUENCE sales.stg_meta_ad_id_seq TO service_role;
GRANT ALL ON SEQUENCE sales.mkt_fact_ad_id_seq TO service_role;
