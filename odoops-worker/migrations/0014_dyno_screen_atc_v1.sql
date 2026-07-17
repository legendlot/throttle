-- 0014: Add-to-Cart in the Meta ad-level pull — the leading metric the Dyno screen board runs on.
-- Screen ads are ATC-optimized (purchase is meaningless); omni_add_to_cart aggregates pixel+app+offline,
-- mirroring how omni_purchase is used. Columns are additive/nullable + backfilled from retained raw.
-- Context: Brand/ad-engine/lab/dyno-screen-board-brief.md §4 + strategy/creative-throughput-loop.md.

ALTER TABLE sales.stg_meta_ad  ADD COLUMN IF NOT EXISTS add_to_carts numeric;
ALTER TABLE sales.mkt_fact_ad  ADD COLUMN IF NOT EXISTS add_to_carts numeric;

-- recompute_mkt_ad carries add_to_carts through staging → fact.
CREATE OR REPLACE FUNCTION sales.recompute_mkt_ad(p_channel uuid, p_dates date[], p_run_id bigint DEFAULT NULL::bigint)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'sales' AS $function$
DECLARE n integer;
BEGIN
  DELETE FROM sales.mkt_fact_ad f WHERE f.channel_id = p_channel AND f.the_date = ANY(p_dates);
  INSERT INTO sales.mkt_fact_ad (the_date, channel_id, ad_account_id, campaign_id, campaign_name,
                                 adset_id, adset_name, ad_id, ad_name,
                                 spend, impressions, clicks, conversions, conv_value, add_to_carts, last_run_id)
  SELECT s.the_date, s.channel_id, s.ad_account_id, s.campaign_id, max(s.campaign_name),
         s.adset_id, max(s.adset_name), s.ad_id, max(s.ad_name),
         sum(s.spend), sum(s.impressions), sum(s.clicks), sum(s.conversions), sum(s.conv_value),
         sum(COALESCE(s.add_to_carts,0)), p_run_id
    FROM sales.stg_meta_ad s
   WHERE s.channel_id = p_channel AND s.the_date = ANY(p_dates)
   GROUP BY s.the_date, s.channel_id, s.ad_account_id, s.campaign_id, s.adset_id, s.ad_id;
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n;
END $function$;

-- Backfill stg_meta_ad.add_to_carts from the retained raw actions (omni_add_to_cart).
UPDATE sales.stg_meta_ad s
   SET add_to_carts = COALESCE(
     (SELECT (a->>'value')::numeric FROM jsonb_array_elements(s.raw->'actions') a
       WHERE a->>'action_type' = 'omni_add_to_cart' LIMIT 1), 0)
 WHERE s.raw ? 'actions' AND s.add_to_carts IS NULL;

-- Backfill existing mkt_fact_ad rows (add_to_carts only), same grain recompute_mkt_ad uses.
UPDATE sales.mkt_fact_ad f
   SET add_to_carts = agg.atc
  FROM (SELECT the_date, channel_id, ad_account_id, campaign_id, adset_id, ad_id, SUM(COALESCE(add_to_carts,0)) atc
          FROM sales.stg_meta_ad
         GROUP BY the_date, channel_id, ad_account_id, campaign_id, adset_id, ad_id) agg
 WHERE f.the_date=agg.the_date AND f.channel_id=agg.channel_id AND f.ad_account_id=agg.ad_account_id
   AND f.campaign_id=agg.campaign_id AND f.adset_id=agg.adset_id AND f.ad_id=agg.ad_id
   AND f.add_to_carts IS DISTINCT FROM agg.atc;
