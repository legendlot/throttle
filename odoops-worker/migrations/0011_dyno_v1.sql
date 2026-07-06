-- 0011_dyno_v1.sql — Dyno (creative testing grounds) V1 schema
-- Extends the existing ads_* tables (single source of truth for the launch flow) + adds the
-- net-new angle playbook and decision-tree tables in the already-exposed `sales` schema.
-- ALL additive / nullable / backfillable — safe against the live shadow-0002 campaign + cron.
-- Decisions (2026-07-06, confirmed with Afshaan): extend ads_* (not a parallel schema);
-- net-new tables live in sales.* (no PostgREST exposed-schema change).

-- 5a. ads_plan == an experiment / batch
ALTER TABLE sales.ads_plan
  ADD COLUMN IF NOT EXISTS hypothesis      text,
  ADD COLUMN IF NOT EXISTS decision_rule   text,
  ADD COLUMN IF NOT EXISTS verdict         text,
  ADD COLUMN IF NOT EXISTS verdict_reason  text,
  ADD COLUMN IF NOT EXISTS concluded_at    timestamptz;
-- status gains a 'staged' value by CONVENTION (column is free text, no enum to alter).

-- 5b. ads_managed rows where entity_type='ad' == a variant
ALTER TABLE sales.ads_managed
  ADD COLUMN IF NOT EXISTS angle             text,   -- soft ref → sales.lab_angles.slug (validated app-side)
  ADD COLUMN IF NOT EXISTS audience_segment  text,
  ADD COLUMN IF NOT EXISTS format            text,
  ADD COLUMN IF NOT EXISTS psychology_pillar text,
  ADD COLUMN IF NOT EXISTS headline          text,
  ADD COLUMN IF NOT EXISTS primary_text      text,
  ADD COLUMN IF NOT EXISTS utm_content       text,
  ADD COLUMN IF NOT EXISTS asset_url         text,   -- storage path in lab-creatives (§6)
  ADD COLUMN IF NOT EXISTS parent_meta_id    text,   -- CREATIVE lineage (distinct from parent_id = Meta hierarchy)
  ADD COLUMN IF NOT EXISTS verdict           text,
  ADD COLUMN IF NOT EXISTS verdict_reason    text;

-- 5c. lab_angles — the reusable, product-agnostic playbook
CREATE TABLE IF NOT EXISTS sales.lab_angles (
  slug              text PRIMARY KEY,
  name              text NOT NULL,
  description       text,
  psychology_pillar text,
  hypothesis        text,
  status            text NOT NULL DEFAULT 'candidate'
                      CHECK (status IN ('candidate','testing','proven','retired')),
  evidence          text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- 5d. lab_decisions — the decision-tree edges (write from day one)
CREATE TABLE IF NOT EXISTS sales.lab_decisions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_id         bigint REFERENCES sales.ads_plan(id),
  variant_meta_id text,                 -- the ad this decision is about
  type            text NOT NULL
                    CHECK (type IN ('kill','scale','graduate','iterate','pause','hold','restore-budget')),
  rationale       text,
  spawned_meta_id text,                 -- child variant when type='iterate' (lineage)
  decided_by      uuid,
  decided_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lab_decisions_plan_idx    ON sales.lab_decisions(plan_id);
CREATE INDEX IF NOT EXISTS lab_decisions_variant_idx ON sales.lab_decisions(variant_meta_id);
CREATE INDEX IF NOT EXISTS ads_managed_angle_idx     ON sales.ads_managed(angle) WHERE angle IS NOT NULL;

-- RLS on + service_role only (RULE-RLS-001 / CORE.md — worker is the only client).
ALTER TABLE sales.lab_angles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales.lab_decisions ENABLE ROW LEVEL SECURITY;
GRANT ALL ON sales.lab_angles    TO service_role;
GRANT ALL ON sales.lab_decisions TO service_role;

-- §6 asset storage: private bucket for pre-launch creative review in Odo.
INSERT INTO storage.buckets (id, name, public)
VALUES ('lab-creatives','lab-creatives', false)
ON CONFLICT (id) DO NOTHING;

-- §10 getDynoBoard source: one row per live variant (entity_type='ad'), joined to its
-- experiment + windowed Meta results (recent-window AND lifetime), with the computed status
-- chip. Thresholds read from sales.settings (same ceiling/kill knobs the write path uses).
CREATE OR REPLACE FUNCTION sales.f_dyno_board(
  p_filter      text DEFAULT 'active',   -- active | all | staged
  p_product     text DEFAULT NULL,
  p_angle       text DEFAULT NULL,
  p_recent_days int  DEFAULT 3
) RETURNS TABLE(
  plan_id bigint, batch text, product text, plan_status text,
  hypothesis text, decision_rule text, plan_verdict text, plan_verdict_reason text, concluded_at timestamptz,
  meta_id text, ad_name text, ad_status text, angle text, audience_segment text, format text,
  psychology_pillar text, headline text, primary_text text, utm_content text, asset_url text,
  parent_meta_id text, verdict text, verdict_reason text, daily_budget_inr numeric,
  adset_meta_id text, adset_daily_budget_inr numeric, adset_status text,
  spend_life numeric, purchases_life numeric, revenue_life numeric, roas_life numeric, cpa_life numeric, ctr_life numeric,
  spend_recent numeric, purchases_recent numeric, revenue_recent numeric, roas_recent numeric, cpa_recent numeric, ctr_recent numeric,
  computed_status text
) LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  v_kill_after numeric := COALESCE((SELECT NULLIF(regexp_replace(value::text,'[^0-9.\-]','','g'),'')::numeric FROM sales.settings WHERE key='ads_kill_after_inr'), 6500);
  v_kill_roas  numeric := COALESCE((SELECT NULLIF(regexp_replace(value::text,'[^0-9.\-]','','g'),'')::numeric FROM sales.settings WHERE key='ads_kill_roas'), 2);
  v_win_roas   numeric := 4;
  v_early_inr  numeric := 1500;
  v_recent_from date  := (now() AT TIME ZONE 'Asia/Kolkata')::date - GREATEST(p_recent_days,0);
BEGIN
  RETURN QUERY
  WITH life AS (
    SELECT f.ad_id, SUM(f.spend) spend, SUM(f.conversions) conv, SUM(f.conv_value) rev,
           SUM(f.clicks) clicks, SUM(f.impressions) impr
    FROM sales.mkt_fact_ad f GROUP BY f.ad_id
  ),
  recent AS (
    SELECT f.ad_id, SUM(f.spend) spend, SUM(f.conversions) conv, SUM(f.conv_value) rev,
           SUM(f.clicks) clicks, SUM(f.impressions) impr
    FROM sales.mkt_fact_ad f WHERE f.the_date >= v_recent_from GROUP BY f.ad_id
  )
  SELECT
    pl.id, pl.batch, pl.product, pl.status,
    pl.hypothesis, pl.decision_rule, pl.verdict, pl.verdict_reason, pl.concluded_at,
    am.meta_id, am.name, am.status, am.angle, am.audience_segment, am.format,
    am.psychology_pillar, am.headline, am.primary_text, am.utm_content, am.asset_url,
    am.parent_meta_id, am.verdict, am.verdict_reason, am.daily_budget_inr,
    aset.meta_id, aset.daily_budget_inr, aset.status,
    COALESCE(l.spend,0), COALESCE(l.conv,0), COALESCE(l.rev,0),
    CASE WHEN COALESCE(l.spend,0)>0 THEN ROUND(l.rev/l.spend,2) END,
    CASE WHEN COALESCE(l.conv,0)>0 THEN ROUND(l.spend/l.conv,2) END,
    CASE WHEN COALESCE(l.impr,0)>0 THEN ROUND(l.clicks::numeric/l.impr*100,2) END,
    COALESCE(r.spend,0), COALESCE(r.conv,0), COALESCE(r.rev,0),
    CASE WHEN COALESCE(r.spend,0)>0 THEN ROUND(r.rev/r.spend,2) END,
    CASE WHEN COALESCE(r.conv,0)>0 THEN ROUND(r.spend/r.conv,2) END,
    CASE WHEN COALESCE(r.impr,0)>0 THEN ROUND(r.clicks::numeric/r.impr*100,2) END,
    CASE
      WHEN am.verdict = 'killed' THEN 'killed'
      WHEN COALESCE(l.spend,0) < v_early_inr THEN 'early'
      WHEN COALESCE(l.spend,0) >= v_kill_after AND COALESCE(l.rev,0)/NULLIF(l.spend,0) < v_kill_roas THEN 'killing'
      WHEN COALESCE(r.spend,0) > 0 AND COALESCE(r.rev,0)/NULLIF(r.spend,0) >= v_win_roas THEN 'winning'
      ELSE 'watch'
    END
  FROM sales.ads_managed am
  JOIN sales.ads_plan pl ON pl.id = am.plan_id
  LEFT JOIN sales.ads_managed aset ON aset.entity_type='adset' AND aset.meta_id = am.parent_id
  LEFT JOIN life   l ON l.ad_id = am.meta_id
  LEFT JOIN recent r ON r.ad_id = am.meta_id
  WHERE am.entity_type = 'ad'
    AND (p_product IS NULL OR pl.product = p_product)
    AND (p_angle   IS NULL OR am.angle   = p_angle)
    AND (
      p_filter = 'staged' AND pl.status = 'staged'
      OR p_filter = 'active' AND am.status = 'active'
      OR p_filter NOT IN ('active','staged')            -- 'all' / unknown → everything
    )
  ORDER BY pl.id DESC, am.meta_id;
END;
$fn$;

GRANT EXECUTE ON FUNCTION sales.f_dyno_board(text,text,text,int) TO service_role;
