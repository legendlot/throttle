-- 0010_ads_write_v1.sql  (2026-06-30)
-- Phase 2 (WRITE) for the LOT Ad Engine. Gives Odo the "hands" to CREATE + MANAGE Meta
-- ads via the Marketing API, behind hard guardrails. Pure additions — safe to apply live.
-- Nothing here can spend on its own: every Meta write checks the `ads_write_enabled` flag
-- (default FALSE) and the approved-plan gate, both enforced in the Worker (src/index.js).
--
-- Three tables, all in the `sales` schema (mirrors 0009's grain + grants):
--   ads_plan     — the approved-plan gate. Engine drafts a batch; Afshaan approves; only an
--                  'approved' plan can be launched. Status: draft → approved → launched → done.
--   ads_managed  — the engine's OWN registry of every entity it created (campaign/adset/ad).
--                  The daily-spend ceiling = SUM(daily_budget_inr) over ACTIVE adsets here.
--   ads_ledger   — append-only audit: one row per Meta write call (who, what, payload, Meta
--                  response, status). The money trail. Never updated, only inserted.
--
-- Flag + ceiling live in the existing sales.settings table (reused, no new table):
--   ads_write_enabled       = 'false'   (master kill-switch; must be 'true' to write)
--   ads_max_daily_spend_inr = '7500'    (hard daily-budget ceiling, INR; set 2026-06-30)

-- ── The approved-plan gate ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales.ads_plan (
  id bigserial PRIMARY KEY,
  status text NOT NULL DEFAULT 'draft',            -- draft | approved | launched | done | cancelled
  product text, batch text,                        -- e.g. 'Shadow', 'shadow-0001'
  channel_id uuid,                                 -- the Meta connector channel (carries ad_account_id)
  ad_account_id text,
  daily_budget_total_inr numeric NOT NULL DEFAULT 0,  -- sum of adset daily budgets this plan commits
  plan jsonb NOT NULL DEFAULT '{}'::jsonb,         -- full launch spec: campaign + adsets + ads + copy
  notes text,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid, approved_at timestamptz,
  launched_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sales.ads_plan ENABLE ROW LEVEL SECURITY;

-- ── The engine's registry of what it manages (drives the ceiling check) ──────
CREATE TABLE IF NOT EXISTS sales.ads_managed (
  id bigserial PRIMARY KEY,
  entity_type text NOT NULL,                       -- campaign | adset | ad
  meta_id text NOT NULL,                           -- the Meta-assigned id
  parent_id text,                                  -- adset→campaign_id, ad→adset_id
  plan_id bigint REFERENCES sales.ads_plan(id),
  channel_id uuid, ad_account_id text,
  name text,
  daily_budget_inr numeric NOT NULL DEFAULT 0,     -- adsets only; 0 for campaign/ad
  status text NOT NULL DEFAULT 'paused',           -- active | paused | deleted (engine's view)
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, meta_id)
);
CREATE INDEX IF NOT EXISTS ads_managed_active_adset ON sales.ads_managed (entity_type, status);
ALTER TABLE sales.ads_managed ENABLE ROW LEVEL SECURITY;

-- ── Append-only audit of every Meta write call ──────────────────────────────
CREATE TABLE IF NOT EXISTS sales.ads_ledger (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  action text NOT NULL,                            -- metaCreateCampaign | metaCreateAdSet | ...
  plan_id bigint,
  entity_type text, entity_id text,                -- what was created/affected (filled on success)
  daily_delta_inr numeric NOT NULL DEFAULT 0,      -- budget impact of this call (for the ceiling trail)
  request jsonb, meta_response jsonb,
  status text NOT NULL DEFAULT 'ok',               -- ok | error | blocked
  error text
);
CREATE INDEX IF NOT EXISTS ads_ledger_created ON sales.ads_ledger (created_at DESC);
ALTER TABLE sales.ads_ledger ENABLE ROW LEVEL SECURITY;

-- ── Ceiling helper: current committed daily budget across ACTIVE engine adsets ──
-- The Worker compares (this + the requested delta) against ads_max_daily_spend_inr.
CREATE OR REPLACE FUNCTION sales.f_ads_committed_daily()
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'sales' AS $function$
  SELECT COALESCE(SUM(daily_budget_inr), 0)::numeric
    FROM sales.ads_managed
   WHERE entity_type = 'adset' AND status = 'active';
$function$;
GRANT EXECUTE ON FUNCTION sales.f_ads_committed_daily() TO service_role;

-- ── Seed the guardrail settings (idempotent; engine WRITE stays OFF until flipped) ──
-- sales.settings already exists (drr_window_days lives here); guard it for a clean apply.
CREATE TABLE IF NOT EXISTS sales.settings (
  key text PRIMARY KEY, value text, updated_at timestamptz, updated_by uuid
);
ALTER TABLE sales.settings ENABLE ROW LEVEL SECURITY;
GRANT ALL ON sales.settings TO service_role;

INSERT INTO sales.settings (key, value) VALUES
  ('ads_write_enabled', 'false'),      -- master kill-switch; '' until proven
  ('ads_max_daily_spend_inr', '7500'), -- hard daily-budget ceiling (set 2026-06-30)
  ('ads_kill_roas', '2'),              -- cron auto-pause: pause an ad below this ROAS…
  ('ads_kill_after_inr', '6500')       -- …once it has spent at least this much (the learning gate)
ON CONFLICT (key) DO NOTHING;

GRANT ALL ON sales.ads_plan TO service_role;
GRANT ALL ON sales.ads_managed TO service_role;
GRANT ALL ON sales.ads_ledger TO service_role;
GRANT ALL ON SEQUENCE sales.ads_plan_id_seq TO service_role;
GRANT ALL ON SEQUENCE sales.ads_managed_id_seq TO service_role;
GRANT ALL ON SEQUENCE sales.ads_ledger_id_seq TO service_role;
