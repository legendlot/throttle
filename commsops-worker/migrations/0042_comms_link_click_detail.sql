-- 0042 — Relay Links: per-click detail, so a click can be attributed to a DESTINATION.
--
-- ⚠️ THIS DELIBERATELY REVERSES A DECISION MADE IN 0040, which said: "a row-per-click table on a
-- printed QR is unbounded" and shipped `link_click_daily` instead. That reasoning was sound but the
-- premise was never measured, and it costs the one question the shortener exists to answer.
--
-- WHAT IT COSTS TODAY. `link_click_daily` is keyed (code, day) and `links.click_count` is a single
-- running total, so after a campaign link is repointed there is NO WAY to say "40 clicks went to the
-- old destination, 20 to the new one". `link_changes` records that the change happened; nothing
-- records which side of it a click landed on. Day-granularity inference against the change timestamp
-- is the best available answer today, and it is simply wrong for any same-day repoint — which is the
-- normal case, since repointing is what the feature is FOR.
--
-- WHY UNBOUNDED IS NOT THE RIGHT FEAR. Measured 2026-08-06: the cart/browse journeys deliver ~2,000
-- marketing messages a week in total, so even at an implausible 100% click-through this table takes
-- ~100k rows a year — a rounding error for Postgres, and small next to comms.events (which is already
-- row-per-event and has never been a problem). The real risk is not growth, it is growth WITHOUT A
-- CEILING, so this ships with `prune_link_clicks()` and a stated retention from day one rather than
-- an open-ended table nobody prunes.
--
-- WHAT IS DELIBERATELY *NOT* STORED. No IP address, ever, in any column. `visitor_key` is a hash
-- whose input includes the IST DAY, so it cannot be linked across days — it answers "how many
-- distinct people clicked today", never "is this the same person as last week". That is the honest
-- ceiling of what can be measured without fingerprinting, and the UI must label it per-day rather
-- than as lifetime "unique visitors". Referrer is stored as HOST ONLY: a full referrer URL can carry
-- someone's search terms or a private page path.

CREATE TABLE IF NOT EXISTS comms.link_click (
  id           bigserial PRIMARY KEY,
  code         text        NOT NULL,
  clicked_at   timestamptz NOT NULL DEFAULT now(),

  -- The destination AS RESOLVED AT TAP TIME. This single column is the whole point of the table:
  -- it is what makes a click attributable to a destination after the link has been repointed.
  -- Copied at click time, never joined back to links.target_url — that column has moved on.
  target_url   text,

  -- 'qr' | 'link' | NULL. From the `?s=` parameter the QR image encodes.
  -- ⚠️ CALLER-CONTROLLABLE, therefore A LABEL ONLY. It must never influence whether a hit COUNTS
  -- (see countsAsClick) — anything in the URL can be set by a prefetcher opting itself in.
  source       text,

  device       text,      -- mobile | tablet | desktop | NULL   (coarse buckets, from UA)
  os           text,
  browser      text,
  referrer_host text,     -- HOST ONLY — never the full referrer URL
  country      text,      -- 2-letter, from the Cloudflare edge

  -- Day-rotating hash for honest per-day unique counts. NOT an identity, NOT reversible to an IP,
  -- and NOT comparable across days by construction. See the header note.
  visitor_key  text,

  -- Present for recipient links, always NULL for campaign links (which carry no personal context).
  message_id   uuid,
  profile_id   uuid
);

COMMENT ON TABLE comms.link_click IS
  'One row per COUNTED click (the same bot/prefetch filter as click_count). Exists so a click can be attributed to the destination that was live when it happened — link_click_daily cannot do that, and a repointed QR makes the aggregate meaningless. Pruned by comms.prune_link_clicks(); retention is 400 days.';
COMMENT ON COLUMN comms.link_click.target_url IS
  'The destination resolved AT TAP TIME. Never re-derive this from links.target_url — after a repoint that column is a different URL, which is exactly the ambiguity this table removes.';
COMMENT ON COLUMN comms.link_click.source IS
  'qr | link | NULL, read from ?s= on the incoming URL. A LABEL ONLY: it is caller-controllable, so it must never gate whether the hit is counted.';
COMMENT ON COLUMN comms.link_click.visitor_key IS
  'Salted per-day hash (input includes the IST date + the link code). Enables "distinct people today"; deliberately NOT linkable across days. No IP is stored anywhere in this table.';

CREATE INDEX IF NOT EXISTS link_click_code_time_idx ON comms.link_click (code, clicked_at DESC);
CREATE INDEX IF NOT EXISTS link_click_code_target_idx ON comms.link_click (code, target_url);

-- Retention. Stated and enforced from day one, so this table can never become the unbounded thing
-- 0040 was right to refuse. 400 days keeps a full year plus a comparison window.
CREATE OR REPLACE FUNCTION comms.prune_link_clicks(p_keep_days integer DEFAULT 400)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = comms, public AS $$
DECLARE n integer;
BEGIN
  DELETE FROM comms.link_click
   WHERE clicked_at < now() - make_interval(days => GREATEST(p_keep_days, 1));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
COMMENT ON FUNCTION comms.prune_link_clicks(integer) IS
  'Deletes link_click rows older than p_keep_days (default 400). The daily rollup and links.click_count are NOT touched, so pruning never rewrites a historical total — only the per-click detail ages out.';

-- Breakdowns, aggregated IN POSTGRES. The worker must never pull raw click rows to count them:
-- a printed QR can accumulate thousands, and the read path here is a modal someone opens casually.
--
-- Returns one jsonb object so the whole panel is ONE subrequest rather than six.
CREATE OR REPLACE FUNCTION comms.link_click_stats(p_code text, p_days integer DEFAULT 90)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = comms, public AS $$
  WITH win AS (
    SELECT * FROM comms.link_click
     WHERE code = p_code
       AND clicked_at >= now() - make_interval(days => GREATEST(p_days, 1))
  )
  SELECT jsonb_build_object(
    'detail_clicks', (SELECT count(*) FROM win),
    -- The answer to "how many went where after I repointed it".
    'by_destination', COALESCE((
      SELECT jsonb_agg(x ORDER BY x.clicks DESC) FROM (
        SELECT target_url, count(*) AS clicks,
               min(clicked_at) AS first_at, max(clicked_at) AS last_at
          FROM win WHERE target_url IS NOT NULL GROUP BY target_url) x), '[]'::jsonb),
    'by_source', COALESCE((
      SELECT jsonb_agg(x ORDER BY x.clicks DESC) FROM (
        SELECT COALESCE(source, 'unknown') AS source, count(*) AS clicks
          FROM win GROUP BY 1) x), '[]'::jsonb),
    'by_device', COALESCE((
      SELECT jsonb_agg(x ORDER BY x.clicks DESC) FROM (
        SELECT COALESCE(device, 'unknown') AS device, count(*) AS clicks
          FROM win GROUP BY 1) x), '[]'::jsonb),
    'by_browser', COALESCE((
      SELECT jsonb_agg(x ORDER BY x.clicks DESC) FROM (
        SELECT COALESCE(browser, 'unknown') AS browser, count(*) AS clicks
          FROM win GROUP BY 1) x), '[]'::jsonb),
    'by_country', COALESCE((
      SELECT jsonb_agg(x ORDER BY x.clicks DESC) FROM (
        SELECT COALESCE(country, 'unknown') AS country, count(*) AS clicks
          FROM win GROUP BY 1) x), '[]'::jsonb),
    'by_referrer', COALESCE((
      SELECT jsonb_agg(x ORDER BY x.clicks DESC) FROM (
        SELECT COALESCE(referrer_host, 'direct') AS referrer_host, count(*) AS clicks
          FROM win GROUP BY 1) x), '[]'::jsonb),
    -- Per-day only. visitor_key rotates daily by construction, so a lifetime unique is NOT
    -- derivable and summing this column would overstate it. The UI must say "per day".
    'daily_unique', COALESCE((
      SELECT jsonb_agg(x ORDER BY x.day DESC) FROM (
        SELECT (clicked_at AT TIME ZONE 'Asia/Kolkata')::date AS day,
               count(DISTINCT visitor_key) AS uniques
          FROM win WHERE visitor_key IS NOT NULL GROUP BY 1) x), '[]'::jsonb)
  );
$$;
COMMENT ON FUNCTION comms.link_click_stats(text, integer) IS
  'Per-link click breakdowns aggregated server-side. daily_unique is PER DAY ONLY — visitor_key rotates daily by design, so these must never be summed into a lifetime unique-visitor figure.';

ALTER TABLE comms.link_click ENABLE ROW LEVEL SECURITY;
GRANT ALL ON comms.link_click TO service_role;
GRANT USAGE, SELECT ON SEQUENCE comms.link_click_id_seq TO service_role;
GRANT EXECUTE ON FUNCTION comms.prune_link_clicks(integer) TO service_role;
GRANT EXECUTE ON FUNCTION comms.link_click_stats(text, integer) TO service_role;

-- New tables in an already-exposed schema are invisible to PostgREST until the cache reloads, and it
-- fails SILENTLY (CORE.md; cost a live round in S239).
NOTIFY pgrst, 'reload schema';
