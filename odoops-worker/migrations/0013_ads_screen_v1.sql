-- 0013: Screening-campaign support (the creative throughput loop's Gate 1)
-- 1. ads_plan.kind gains 'screen' — an ATC-optimized CBO campaign whose ads are judged
--    on cost-per-ATC (human review), NOT the prospect ROAS kill-gate.
-- 2. f_ads_committed_daily counts active CBO CAMPAIGN budgets too (CBO moves the daily
--    budget from the ad set to the campaign; without this the ceiling check is blind).
-- Context: Brand/ad-engine/strategy/creative-throughput-loop.md

ALTER TABLE sales.ads_plan DROP CONSTRAINT IF EXISTS ads_plan_kind_check;
ALTER TABLE sales.ads_plan ADD CONSTRAINT ads_plan_kind_check
  CHECK (kind = ANY (ARRAY['experiment'::text, 'scale'::text, 'screen'::text]));

CREATE OR REPLACE FUNCTION sales.f_ads_committed_daily()
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'sales' AS $function$
  SELECT COALESCE(SUM(daily_budget_inr), 0)::numeric
    FROM sales.ads_managed
   WHERE status = 'active'
     AND (entity_type = 'adset'
          OR (entity_type = 'campaign' AND daily_budget_inr > 0));  -- CBO campaigns carry their own budget
$function$;
