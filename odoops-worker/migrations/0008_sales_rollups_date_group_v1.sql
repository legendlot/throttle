-- 0008_sales_rollups_date_group_v1
-- Additive: add a 'date' group to the marketing + traffic rollups so Odo can draw
-- daily time-series (Spend vs Revenue / Traffic / Conversion-Performance charts).
-- Non-destructive CREATE OR REPLACE; existing callers (no/other p_group) keep
-- byte-identical behaviour (platform/campaign for mkt, src_group for traffic).

CREATE OR REPLACE FUNCTION sales.f_mkt_rollup(p_from date, p_to date, p_group text DEFAULT 'platform')
RETURNS TABLE(grp text, spend numeric, impressions bigint, clicks bigint, conversions numeric, conv_value numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'sales' AS $$
  SELECT grp, spend, impressions, clicks, conversions, conv_value FROM (
    SELECT CASE WHEN p_group='campaign' THEN campaign_name
                WHEN p_group='date'     THEN the_date::text
                ELSE platform END AS grp,
           sum(spend) AS spend, sum(impressions) AS impressions, sum(clicks) AS clicks,
           sum(conversions) AS conversions, sum(conv_value) AS conv_value
      FROM sales.mkt_fact
     WHERE the_date BETWEEN p_from AND p_to
     GROUP BY 1
  ) q
  ORDER BY CASE WHEN p_group='date' THEN grp END ASC NULLS LAST, spend DESC;
$$;

CREATE OR REPLACE FUNCTION sales.f_traffic_rollup(p_from date, p_to date, p_group text DEFAULT 'src')
RETURNS TABLE(src_group text, sessions bigint, add_to_carts bigint, checkouts bigint, purchases bigint, conv_value numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'sales' AS $$
  SELECT src_group, sessions, add_to_carts, checkouts, purchases, conv_value FROM (
    SELECT CASE WHEN p_group='date' THEN the_date::text ELSE src_group END AS src_group,
           sum(sessions) AS sessions, sum(add_to_carts) AS add_to_carts, sum(checkouts) AS checkouts,
           sum(purchases) AS purchases, sum(conv_value) AS conv_value
      FROM sales.traffic_fact
     WHERE the_date BETWEEN p_from AND p_to
     GROUP BY 1
  ) q
  ORDER BY CASE WHEN p_group='date' THEN src_group END ASC NULLS LAST, sessions DESC;
$$;
