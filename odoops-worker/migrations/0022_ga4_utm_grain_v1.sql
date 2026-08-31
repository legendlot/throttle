-- S325 (2026-08-31) — attribution lane ③: GA4 at UTM grain.
--
-- Ignition mints a per-deal tracking link whose redirect stamps
--   utm_medium=influencer · utm_source=<influencer_code> · utm_campaign=<engagement_no lowercased>
-- (commsops `GET /r/<code>`, `comms.links.utm`). GA4 has been recording those sessions since
-- 2026-08-26, but odoops only ever asked GA4 for `sessionDefaultChannelGroup`, so nothing
-- downstream could see them: an influencer session was indistinguishable from any other referral.
--
-- ⭐ ADDITIVE ON PURPOSE — `sales.traffic_fact` IS NOT TOUCHED, and its grain must not change.
-- FIVE things read it (`f_traffic_rollup` ×2 overloads, `f_payment_recon`, `f_website_cr`,
-- `recompute_conversion_snapshot`), two of them financial-adjacent, and widening its PK with
-- campaign/source/medium would silently change what every one of them aggregates over. So the UTM
-- grain lives in its own table, fed by its own GA4 report, and the channel-group rollup that
-- /funnel depends on is byte-identical to before.
--
-- Applied to live as `odo_ga4_utm_grain_v1`. Mirror copy (PATTERN-297).

-- ── Staging: one row per (day, campaign, source, medium) ──────────────────────
CREATE TABLE IF NOT EXISTS sales.stg_ga4_utm (
  id            bigserial PRIMARY KEY,
  run_id        bigint,
  channel_id    uuid        NOT NULL,
  the_date      date        NOT NULL,
  -- GA4 returns "(not set)" rather than NULL for an absent dimension. Kept verbatim rather than
  -- normalised to NULL: it is a real GA4 value and collapsing it would merge genuinely distinct
  -- rows. NOT NULL + a literal default keeps the unique key total.
  campaign      text        NOT NULL DEFAULT '(not set)',
  source        text        NOT NULL DEFAULT '(not set)',
  medium        text        NOT NULL DEFAULT '(not set)',
  sessions      bigint      NOT NULL DEFAULT 0,
  add_to_carts  bigint      NOT NULL DEFAULT 0,
  checkouts     bigint      NOT NULL DEFAULT 0,
  purchases     bigint      NOT NULL DEFAULT 0,
  conv_value    numeric     NOT NULL DEFAULT 0,
  raw           jsonb,
  ingested_at   timestamptz NOT NULL DEFAULT now()
);

-- The upsert key. Mirrors stg_ga4's (channel_id, the_date, src_group) one dimension wider, so a
-- re-read of the same day overwrites in place — GA4 restates recent days for ~48h and MUST be
-- allowed to correct itself rather than double-count.
CREATE UNIQUE INDEX IF NOT EXISTS stg_ga4_utm_key
  ON sales.stg_ga4_utm (channel_id, the_date, campaign, source, medium);
CREATE INDEX IF NOT EXISTS stg_ga4_utm_date_idx ON sales.stg_ga4_utm (channel_id, the_date);

-- ── Fact ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales.traffic_utm_fact (
  the_date      date    NOT NULL,
  channel_id    uuid    NOT NULL,
  campaign      text    NOT NULL,
  source        text    NOT NULL,
  medium        text    NOT NULL,
  sessions      bigint  NOT NULL DEFAULT 0,
  add_to_carts  bigint  NOT NULL DEFAULT 0,
  checkouts     bigint  NOT NULL DEFAULT 0,
  purchases     bigint  NOT NULL DEFAULT 0,
  conv_value    numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (the_date, channel_id, campaign, source, medium)
);
CREATE INDEX IF NOT EXISTS traffic_utm_fact_campaign_idx ON sales.traffic_utm_fact (campaign);

-- RLS on at creation, service_role only — CORE.md RULE-RLS-001. The worker is service_role
-- (BYPASSRLS); nothing anon/authenticated may ever reach these.
ALTER TABLE sales.stg_ga4_utm      ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales.traffic_utm_fact ENABLE ROW LEVEL SECURITY;
GRANT ALL ON sales.stg_ga4_utm      TO service_role;
GRANT ALL ON sales.traffic_utm_fact TO service_role;
GRANT USAGE, SELECT ON SEQUENCE sales.stg_ga4_utm_id_seq TO service_role;

-- ── Recompute: delete + reinsert for the affected (channel, dates) ────────────
-- Same idempotency contract as sales.recompute_traffic (RULE-SALES-001): a re-pull of the same
-- window is a no-op on totals, never an append.
CREATE OR REPLACE FUNCTION sales.recompute_traffic_utm(
  p_channel uuid, p_dates date[], p_run_id bigint DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'sales' AS $$
DECLARE n integer;
BEGIN
  DELETE FROM sales.traffic_utm_fact f
   WHERE f.channel_id = p_channel AND f.the_date = ANY(p_dates);
  INSERT INTO sales.traffic_utm_fact
        (the_date, channel_id, campaign, source, medium,
         sessions, add_to_carts, checkouts, purchases, conv_value)
  SELECT s.the_date, s.channel_id, s.campaign, s.source, s.medium,
         sum(s.sessions), sum(s.add_to_carts), sum(s.checkouts),
         sum(s.purchases), sum(s.conv_value)
    FROM sales.stg_ga4_utm s
   WHERE s.channel_id = p_channel AND s.the_date = ANY(p_dates)
   GROUP BY s.the_date, s.channel_id, s.campaign, s.source, s.medium;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ── The pass condition, as a query anyone can run ────────────────────────────
-- "a deal's sessions/orders are attributable to its own engagement_no".
-- ⚠️ The join is `upper(campaign) = engagement_no` — commsops stamps the engagement number
-- LOWERCASED into utm_campaign (`ign-2026-00558`), while ignition.engagements stores it upper
-- (`IGN-2026-00558`). Do not "simplify" this to a plain equality; it silently returns zero rows.
CREATE OR REPLACE FUNCTION sales.f_influencer_attribution(p_from date, p_to date)
RETURNS TABLE (
  engagement_no text, influencer_code text, campaign text,
  sessions bigint, add_to_carts bigint, checkouts bigint,
  purchases bigint, conv_value numeric
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'sales', 'ignition', 'public' AS $$
  SELECT e.engagement_no,
         f.source                AS influencer_code,
         f.campaign,
         sum(f.sessions)::bigint, sum(f.add_to_carts)::bigint,
         sum(f.checkouts)::bigint, sum(f.purchases)::bigint,
         sum(f.conv_value)
    FROM sales.traffic_utm_fact f
    -- LEFT so an unmatched campaign is VISIBLE as a null engagement rather than dropped. A UTM
    -- that matches no deal is a real signal (a stale printed link, a typo, a retired engagement)
    -- and must not vanish into an inner join.
    LEFT JOIN ignition.engagements e ON e.engagement_no = upper(f.campaign)
   WHERE f.medium = 'influencer' AND f.the_date BETWEEN p_from AND p_to
   GROUP BY e.engagement_no, f.source, f.campaign
   ORDER BY sum(f.sessions) DESC;
$$;
GRANT EXECUTE ON FUNCTION sales.recompute_traffic_utm(uuid, date[], bigint) TO service_role;
GRANT EXECUTE ON FUNCTION sales.f_influencer_attribution(date, date)        TO service_role;

-- CORE.md: a table created after PostgREST started is invisible to it until the cache reloads,
-- and the failure is SILENT (reads come back not-found). The worker reads these in the same
-- session this migration is applied, so the NOTIFY is required, not decorative.
NOTIFY pgrst, 'reload schema';
