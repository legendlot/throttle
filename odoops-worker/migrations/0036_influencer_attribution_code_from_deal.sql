-- S409 (2026-10-06) — mirror of live migrations ignition_engagements_utm_term_v1 +
-- odo_influencer_attribution_code_from_deal_v1/_v2_upper.
-- Ignition links now carry utm_source = platform (instagram|youtube|other) and utm_term = product
-- code; utm_campaign = engagement_no is unchanged and stays the join key. influencer_code is
-- resolved from the matched deal; f.source is the fallback only for pre-S409 links (where source
-- WAS the code) that match no deal.
ALTER TABLE ignition.engagements ADD COLUMN IF NOT EXISTS utm_term text;
NOTIFY pgrst, 'reload schema';

CREATE OR REPLACE FUNCTION sales.f_influencer_attribution(p_from date, p_to date)
 RETURNS TABLE(engagement_no text, influencer_code text, campaign text, sessions bigint, add_to_carts bigint, checkouts bigint, purchases bigint, conv_value numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'sales', 'ignition', 'public'
AS $function$
  SELECT e.engagement_no,
         coalesce(i.influencer_code,
                  CASE WHEN lower(f.source) IN ('instagram','youtube','other') THEN NULL ELSE upper(f.source) END) AS influencer_code,
         f.campaign,
         sum(f.sessions)::bigint, sum(f.add_to_carts)::bigint,
         sum(f.checkouts)::bigint, sum(f.purchases)::bigint,
         sum(f.conv_value)
    FROM sales.traffic_utm_fact f
    LEFT JOIN ignition.engagements e ON e.engagement_no = upper(f.campaign)
    LEFT JOIN ignition.influencers i ON i.id = e.influencer_id
   WHERE f.medium = 'influencer' AND f.the_date BETWEEN p_from AND p_to
   GROUP BY e.engagement_no, 2, f.campaign
   ORDER BY sum(f.sessions) DESC;
$function$;
