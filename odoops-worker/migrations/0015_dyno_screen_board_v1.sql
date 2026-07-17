-- 0015: Dyno Screen board (Gate 1 of the creative throughput loop).
-- Spend split gains a Screen bucket; a screen-native board RPC judges ads on CTR / CPC / cost-per-ATC /
-- CBO spend-share vs the batch median — NOT purchase ROAS (screen ads log ~0 buys by design).
-- Context: Brand/ad-engine/lab/dyno-screen-board-brief.md.

-- 1. Spend split adds screen_today / screen_life (return type changes → drop+recreate).
DROP FUNCTION IF EXISTS sales.f_dyno_spend_summary();
CREATE OR REPLACE FUNCTION sales.f_dyno_spend_summary()
 RETURNS TABLE(exp_today numeric, exp_life numeric, scale_today numeric, scale_life numeric, screen_today numeric, screen_life numeric)
 LANGUAGE sql STABLE AS $function$
  SELECT
    COALESCE(SUM(f.spend) FILTER (WHERE pl.kind='experiment' AND f.the_date=(now() AT TIME ZONE 'Asia/Kolkata')::date),0),
    COALESCE(SUM(f.spend) FILTER (WHERE pl.kind='experiment'),0),
    COALESCE(SUM(f.spend) FILTER (WHERE pl.kind='scale' AND f.the_date=(now() AT TIME ZONE 'Asia/Kolkata')::date),0),
    COALESCE(SUM(f.spend) FILTER (WHERE pl.kind='scale'),0),
    COALESCE(SUM(f.spend) FILTER (WHERE pl.kind='screen' AND f.the_date=(now() AT TIME ZONE 'Asia/Kolkata')::date),0),
    COALESCE(SUM(f.spend) FILTER (WHERE pl.kind='screen'),0)
  FROM sales.ads_managed am
  JOIN sales.ads_plan pl ON pl.id=am.plan_id
  JOIN sales.mkt_fact_ad f ON f.ad_id=am.meta_id
  WHERE am.entity_type='ad';
$function$;

-- 2. f_dyno_screen_board — one row per screen ad + batch-relative screen metrics + screen status.
-- Status vocabulary (calibrated on shadow-screen-0001, 2026-07-18):
--   promote  CBO is concentrating budget here (spend-share >= 15% ~= 2x fair share in a ~14-ad batch) — the CBO IS the verdict.
--   starved  Meta barely funded it (spend-share < 3% AND spend < INR 200) -> insufficient signal / losing.
--   kill     real spend (>= INR 200) but worse than the batch on the leading metric: below-median CTR AND (no ATC OR above-median CPATC).
--   watch    in between (mid spend-share, or under-funded but strong CTR/CPATC worth a manual wildcard promote).
--   killed   operator verdict override.
-- spend_share + medians are over the WHOLE batch (unfiltered) so they're stable regardless of the row filter.
CREATE OR REPLACE FUNCTION sales.f_dyno_screen_board(
  p_filter text DEFAULT 'all', p_product text DEFAULT NULL, p_angle text DEFAULT NULL, p_recent_days int DEFAULT 3
) RETURNS TABLE(
  plan_id bigint, batch text, product text, plan_status text, plan_kind text,
  hypothesis text, decision_rule text, plan_verdict text, plan_verdict_reason text, concluded_at timestamptz,
  meta_id text, ad_name text, ad_status text, angle text, audience_segment text, format text,
  psychology_pillar text, headline text, primary_text text, utm_content text, asset_url text,
  parent_meta_id text, verdict text, verdict_reason text, daily_budget_inr numeric,
  adset_meta_id text, adset_daily_budget_inr numeric, adset_status text,
  spend_life numeric, clicks_life numeric, impr_life numeric, atc_life numeric,
  ctr_life numeric, cpc_life numeric, cpatc_life numeric,
  spend_recent numeric, atc_recent numeric, ctr_recent numeric, cpatc_recent numeric,
  spend_share numeric, computed_status text
) LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  v_recent_from date := (now() AT TIME ZONE 'Asia/Kolkata')::date - GREATEST(p_recent_days,0);
BEGIN
  RETURN QUERY
  WITH life AS (
    SELECT f.ad_id, SUM(f.spend) spend, SUM(f.clicks) clicks, SUM(f.impressions) impr,
           SUM(COALESCE(f.add_to_carts,0)) atc
    FROM sales.mkt_fact_ad f GROUP BY f.ad_id
  ),
  recent AS (
    SELECT f.ad_id, SUM(f.spend) spend, SUM(f.clicks) clicks, SUM(f.impressions) impr,
           SUM(COALESCE(f.add_to_carts,0)) atc
    FROM sales.mkt_fact_ad f WHERE f.the_date >= v_recent_from GROUP BY f.ad_id
  ),
  base AS (
    SELECT am.plan_id AS b_plan_id, am.meta_id, am.name, am.status AS ad_status, am.angle, am.audience_segment, am.format,
           am.psychology_pillar, am.headline, am.primary_text, am.utm_content, am.asset_url, am.parent_meta_id,
           am.verdict, am.verdict_reason, am.daily_budget_inr, am.parent_id,
           COALESCE(l.spend,0) l_spend, COALESCE(l.clicks,0) l_clicks, COALESCE(l.impr,0) l_impr, COALESCE(l.atc,0) l_atc,
           COALESCE(r.spend,0) r_spend, COALESCE(r.clicks,0) r_clicks, COALESCE(r.impr,0) r_impr, COALESCE(r.atc,0) r_atc
    FROM sales.ads_managed am
    LEFT JOIN life   l ON l.ad_id = am.meta_id
    LEFT JOIN recent r ON r.ad_id = am.meta_id
    WHERE am.entity_type='ad'
      AND am.plan_id IN (SELECT id FROM sales.ads_plan WHERE kind='screen')
  ),
  stats AS (
    SELECT b.b_plan_id,
           SUM(b.l_spend) tot_spend,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY CASE WHEN b.l_impr>0 THEN b.l_clicks::numeric/b.l_impr*100 END)
             FILTER (WHERE b.l_spend>0) med_ctr,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY CASE WHEN b.l_atc>0 THEN b.l_spend/b.l_atc END)
             FILTER (WHERE b.l_spend>0 AND b.l_atc>0) med_cpatc
    FROM base b GROUP BY b.b_plan_id
  )
  SELECT
    pl.id, pl.batch, pl.product, pl.status, pl.kind,
    pl.hypothesis, pl.decision_rule, pl.verdict, pl.verdict_reason, pl.concluded_at,
    b.meta_id, b.name, b.ad_status, b.angle, b.audience_segment, b.format,
    b.psychology_pillar, b.headline, b.primary_text, b.utm_content, b.asset_url,
    b.parent_meta_id, b.verdict, b.verdict_reason, b.daily_budget_inr,
    aset.meta_id, aset.daily_budget_inr, aset.status,
    b.l_spend, b.l_clicks::numeric, b.l_impr::numeric, b.l_atc,
    CASE WHEN b.l_impr>0  THEN ROUND(b.l_clicks::numeric/b.l_impr*100,2) END,
    CASE WHEN b.l_clicks>0 THEN ROUND(b.l_spend/b.l_clicks,2) END,
    CASE WHEN b.l_atc>0    THEN ROUND(b.l_spend/b.l_atc,2) END,
    b.r_spend, b.r_atc,
    CASE WHEN b.r_impr>0 THEN ROUND(b.r_clicks::numeric/b.r_impr*100,2) END,
    CASE WHEN b.r_atc>0  THEN ROUND(b.r_spend/b.r_atc,2) END,
    CASE WHEN COALESCE(st.tot_spend,0)>0 THEN ROUND(b.l_spend/st.tot_spend*100,1) ELSE 0 END,
    CASE
      WHEN b.verdict='killed' THEN 'killed'
      WHEN COALESCE(st.tot_spend,0)>0 AND b.l_spend/st.tot_spend >= 0.15 THEN 'promote'
      WHEN b.l_spend < 200 AND (COALESCE(st.tot_spend,0)=0 OR b.l_spend/st.tot_spend < 0.03) THEN 'starved'
      WHEN b.l_spend >= 200
           AND (st.med_ctr IS NULL OR (b.l_impr>0 AND b.l_clicks::numeric/b.l_impr*100 < st.med_ctr))
           AND (b.l_atc=0 OR (st.med_cpatc IS NOT NULL AND b.l_spend/NULLIF(b.l_atc,0) > st.med_cpatc))
        THEN 'kill'
      ELSE 'watch'
    END
  FROM base b
  JOIN sales.ads_plan pl ON pl.id = b.b_plan_id
  LEFT JOIN stats st ON st.b_plan_id = b.b_plan_id
  LEFT JOIN sales.ads_managed aset ON aset.entity_type='adset' AND aset.meta_id = b.parent_id
  WHERE (p_product IS NULL OR pl.product = p_product)
    AND (p_angle   IS NULL OR b.angle   = p_angle)
    AND (
      p_filter='staged' AND pl.status='staged'
      OR p_filter='active' AND b.ad_status='active'
      OR p_filter NOT IN ('active','staged')
    )
  ORDER BY pl.id DESC, b.l_spend DESC NULLS LAST, b.meta_id;
END;
$fn$;

GRANT EXECUTE ON FUNCTION sales.f_dyno_screen_board(text,text,text,int) TO service_role;
