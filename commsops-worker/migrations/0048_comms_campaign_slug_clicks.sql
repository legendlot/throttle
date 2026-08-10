-- 0048 — Campaign CTR for CAMPAIGN-KIND (slug) links.
--
-- THE DEFECT THIS FIXES: `campaign_stats` / `campaign_stats_list` computed `clicked` ONLY from
-- `link_clicked` events joined on `message_id`. A campaign-kind link (a chosen slug like
-- `/r/roxie-launch-whatsapp`, shared by every recipient) deliberately emits NO event — links.js:
-- "Events are profile-scoped, so a CAMPAIGN link has nowhere to land one". So every campaign that
-- used a slug link reported a confident `clicked: 0` while real clicks were accruing in
-- `comms.link_click`. Measured 2026-08-10: Roxie WA read 0 against 19 real clicks, Roxie email 0
-- against 2. A wrong zero is worse than a blank — it reads as "nobody clicked".
--
-- ⚠️ SLUG CLICKS ARE A SEPARATE FIELD, NOT FOLDED INTO `clicked`. Two reasons, both load-bearing:
--   1. `clicked` is per-RECIPIENT attribution ("these people clicked"); a slug click is an
--      anonymous tap on a shared code ("this many taps arrived"). Different questions.
--   2. `clicked` feeds the `eng` CTE that drives ORDER/REVENUE attribution in campaign_stats_list.
--      A slug click carries no profile_id, so it can never attribute an order — merging it would
--      inflate the engaged set with profiles that cannot be resolved and corrupt ROI.
--
-- ⚠️ CLICKS ARE WINDOWED FROM THE FIRST SEND. A campaign slug is PERMANENT and reused (it is
-- printed on packaging; RULE in comms.links), so its lifetime `click_count` includes taps from
-- before this campaign ever sent. Roxie WA: 31 lifetime vs 19 in-window. Reporting the lifetime
-- count as campaign CTR would have overstated it by 63%.
--
-- Code extraction is by regex over the template content, then INTERSECTED with real
-- `kind='campaign'` rows — so a false match resolves to nothing rather than inventing a code, and
-- it works for any channel (WA button url, email HTML href) without a schema change. DISTINCT
-- matters: the Roxie email template references its slug 3× (logo + button + image).

CREATE OR REPLACE FUNCTION comms.campaign_slug_clicks(p_campaign_id uuid)
RETURNS TABLE (codes text[], clicks bigint, unique_visitors bigint, window_from timestamptz)
LANGUAGE sql STABLE AS $$
  WITH win AS (
    SELECT min(COALESCE(sent_at, queued_at)) AS from_ts
    FROM comms.messages WHERE source = 'campaign:' || p_campaign_id::text
  ),
  slugs AS (
    SELECT DISTINCT l.code
    FROM comms.campaigns c
    JOIN comms.templates t ON t.id = c.template_id
    CROSS JOIN LATERAL regexp_matches(t.content::text, '/r/([A-Za-z0-9_-]+)', 'g') AS mt(m)
    JOIN comms.links l ON l.code = mt.m[1] AND l.kind = 'campaign'
    WHERE c.id = p_campaign_id
  )
  SELECT (SELECT COALESCE(array_agg(code ORDER BY code), '{}') FROM slugs),
         (SELECT count(*)                     FROM comms.link_click lc
            WHERE lc.code IN (SELECT code FROM slugs)
              AND lc.clicked_at >= (SELECT from_ts FROM win)),
         (SELECT count(DISTINCT lc.visitor_key) FROM comms.link_click lc
            WHERE lc.code IN (SELECT code FROM slugs)
              AND lc.clicked_at >= (SELECT from_ts FROM win)),
         (SELECT from_ts FROM win);
$$;
GRANT EXECUTE ON FUNCTION comms.campaign_slug_clicks(uuid) TO service_role;

-- ── campaign_stats: add the slug block, everything else byte-identical ──────────────────────
CREATE OR REPLACE FUNCTION comms.campaign_stats(p_campaign_id uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $function$
  WITH m AS (
    SELECT * FROM comms.messages WHERE source = 'campaign:' || p_campaign_id::text
  ),
  clk AS (
    SELECT count(DISTINCT e.properties->>'message_id') AS clicked
    FROM comms.events e
    WHERE e.name = 'link_clicked'
      AND e.properties->>'message_id' IN (SELECT id::text FROM m)
  ),
  slug AS (SELECT * FROM comms.campaign_slug_clicks(p_campaign_id)),
  unsub AS (
    SELECT count(DISTINCT m.profile_id) AS unsubscribes
    FROM m JOIN comms.events e
      ON e.profile_id = m.profile_id AND e.name = 'opted_out'
     AND e.occurred_at >= COALESCE(m.sent_at, m.queued_at)
  ),
  reasons AS (
    SELECT COALESCE(jsonb_object_agg(reason, c), '{}'::jsonb) AS skipped_by_reason
    FROM (
      SELECT COALESCE(reason, 'unspecified') AS reason, count(*) AS c
      FROM m WHERE status IN ('skipped', 'suppressed') GROUP BY 1
    ) r
  )
  SELECT jsonb_build_object(
    'total',       (SELECT count(*) FROM m),
    'queued',      (SELECT count(*) FROM m WHERE status = 'queued'),
    'sent',        (SELECT count(*) FROM m WHERE sent_at IS NOT NULL),
    'delivered',   (SELECT count(*) FROM m WHERE delivered_at IS NOT NULL),
    'opened',      (SELECT count(*) FROM m WHERE read_at IS NOT NULL),
    'clicked',     (SELECT clicked FROM clk),
    'bounced',     (SELECT count(*) FROM m WHERE status = 'bounced'),
    'complained',  (SELECT count(*) FROM m WHERE provider_status = 'email.complained'),
    'failed',      (SELECT count(*) FROM m WHERE status = 'failed'
                                             AND provider_status IS DISTINCT FROM 'email.complained'),
    'suppressed',  (SELECT count(*) FROM m WHERE status = 'suppressed'),
    'skipped',     (SELECT count(*) FROM m WHERE status = 'skipped'),
    'unsubscribes',(SELECT unsubscribes FROM unsub),
    'skipped_by_reason', (SELECT skipped_by_reason FROM reasons),
    'spend',       (SELECT COALESCE(sum(cost), 0) FROM m),
    'priced_sends',(SELECT count(*) FROM m WHERE cost IS NOT NULL),
    -- NEW: campaign-slug click-through. Anonymous by construction — counts + unique visitors only.
    'slug_codes',        (SELECT codes           FROM slug),
    'slug_clicks',       (SELECT clicks          FROM slug),
    'slug_unique',       (SELECT unique_visitors FROM slug),
    'slug_window_from',  (SELECT window_from     FROM slug)
  );
$function$;

-- ── campaign_stats_list: same addition, set-based across every campaign in the page ─────────
-- ⚠️ ONE lateral over the page's campaigns — never a per-campaign call in a loop (the rule the
-- original RPC exists to enforce).
CREATE OR REPLACE FUNCTION comms.campaign_stats_list(p_limit integer DEFAULT 200, p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE sql STABLE AS $function$
  WITH w AS (
    SELECT COALESCE((SELECT attribution_window_days FROM comms.settings WHERE id = 1), 7) AS days
  ),
  c AS (
    SELECT id, name, channel, purpose, status, scheduled_at, audience_snapshot, created_at, updated_at
    FROM comms.campaigns
    ORDER BY COALESCE(scheduled_at, updated_at) DESC NULLS LAST
    LIMIT GREATEST(p_limit, 0) OFFSET GREATEST(p_offset, 0)
  ),
  m AS (
    SELECT c.id AS campaign_id, msg.id, msg.profile_id, msg.status, msg.provider_status,
           msg.queued_at, msg.sent_at, msg.delivered_at, msg.read_at, msg.cost,
           msg.channel AS msg_channel, msg.pricing_category, msg.billable,
           comms.message_cost_inr(msg.channel, msg.pricing_category, msg.billable, msg.sent_at) AS cost_inr
    FROM c JOIN comms.messages msg ON msg.source = 'campaign:' || c.id::text
  ),
  agg AS (
    SELECT campaign_id,
      count(*)                                                     AS total,
      count(*) FILTER (WHERE status = 'queued')                    AS queued,
      count(*) FILTER (WHERE sent_at IS NOT NULL)                  AS sent,
      count(*) FILTER (WHERE delivered_at IS NOT NULL)             AS delivered,
      count(*) FILTER (WHERE read_at IS NOT NULL)                  AS opened,
      count(*) FILTER (WHERE status = 'bounced')                   AS bounced,
      count(*) FILTER (WHERE provider_status = 'email.complained') AS complained,
      count(*) FILTER (WHERE status = 'failed'
                         AND provider_status IS DISTINCT FROM 'email.complained') AS failed,
      count(*) FILTER (WHERE status = 'suppressed')                AS suppressed,
      count(*) FILTER (WHERE status = 'skipped')                   AS skipped,
      min(sent_at)                                                 AS first_sent_at,
      COALESCE(sum(cost), 0)                                       AS billable_units,
      COALESCE(sum(cost_inr), 0)                                   AS cost_inr,
      count(*) FILTER (WHERE sent_at IS NOT NULL AND cost_inr IS NULL) AS unpriced
    FROM m GROUP BY campaign_id
  ),
  clk AS (
    SELECT m.campaign_id, count(DISTINCT e.properties->>'message_id') AS clicked
    FROM m JOIN comms.events e
      ON e.name = 'link_clicked' AND e.properties->>'message_id' = m.id::text
    GROUP BY m.campaign_id
  ),
  slug AS (
    SELECT c.id AS campaign_id, s.codes, s.clicks, s.unique_visitors
    FROM c CROSS JOIN LATERAL comms.campaign_slug_clicks(c.id) s
  ),
  unsub AS (
    SELECT m.campaign_id, count(DISTINCT m.profile_id) AS unsubscribes
    FROM m JOIN comms.events e
      ON e.profile_id = m.profile_id AND e.name = 'opted_out'
     AND e.occurred_at >= COALESCE(m.sent_at, m.queued_at)
    GROUP BY m.campaign_id
  ),
  eng AS (
    SELECT DISTINCT m.campaign_id, m.profile_id, COALESCE(m.sent_at, m.queued_at) AS touch_at
    FROM m
    WHERE m.profile_id IS NOT NULL
      AND (m.read_at IS NOT NULL
           OR EXISTS (SELECT 1 FROM comms.events e
                       WHERE e.name = 'link_clicked'
                         AND e.properties->>'message_id' = m.id::text))
  ),
  ord AS (
    SELECT campaign_id, count(*) AS attributed_orders, COALESCE(sum(total), 0) AS attributed_revenue
    FROM (
      SELECT DISTINCT eng.campaign_id, e.id,
             COALESCE((e.properties->>'total')::numeric, 0) AS total
      FROM eng
      JOIN comms.events e ON e.profile_id = eng.profile_id AND e.name = 'order_placed'
      CROSS JOIN w
      WHERE e.occurred_at >= eng.touch_at
        AND e.occurred_at <= eng.touch_at + make_interval(days => w.days)
    ) d
    GROUP BY campaign_id
  )
  SELECT COALESCE(jsonb_agg(row ORDER BY row->>'at' DESC NULLS LAST), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
      'id', c.id, 'name', c.name, 'channel', c.channel, 'purpose', c.purpose,
      'status', c.status,
      'at',            COALESCE(a.first_sent_at, c.scheduled_at),
      'is_scheduled',  (a.first_sent_at IS NULL AND c.scheduled_at IS NOT NULL),
      'audience',      c.audience_snapshot,
      'total',         COALESCE(a.total, 0),
      'sent',          COALESCE(a.sent, 0),
      'delivered',     COALESCE(a.delivered, 0),
      'opened',        COALESCE(a.opened, 0),
      'clicked',       COALESCE(k.clicked, 0),
      'bounced',       COALESCE(a.bounced, 0),
      'complained',    COALESCE(a.complained, 0),
      'failed',        COALESCE(a.failed, 0),
      'skipped',       COALESCE(a.skipped, 0) + COALESCE(a.suppressed, 0),
      'unsubscribes',  COALESCE(u.unsubscribes, 0),
      'billable_units',COALESCE(a.billable_units, 0),
      'cost_inr',      COALESCE(a.cost_inr, 0),
      'unpriced',      COALESCE(a.unpriced, 0),
      'attributed_orders',  COALESCE(o.attributed_orders, 0),
      'attributed_revenue', COALESCE(o.attributed_revenue, 0),
      'window_days',   (SELECT days FROM w),
      'roi', CASE WHEN COALESCE(a.cost_inr,0) > 0 AND COALESCE(a.unpriced,0) = 0
                  THEN round(COALESCE(o.attributed_revenue,0) / a.cost_inr, 2) END,
      'read_rate',   CASE WHEN COALESCE(a.delivered,0) > 0 THEN round(a.opened::numeric        / a.delivered, 4) END,
      'click_rate',  CASE WHEN COALESCE(a.delivered,0) > 0 THEN round(COALESCE(k.clicked,0)::numeric / a.delivered, 4) END,
      'order_rate',  CASE WHEN COALESCE(a.delivered,0) > 0 THEN round(COALESCE(o.attributed_orders,0)::numeric / a.delivered, 4) END,
      'unsub_rate',  CASE WHEN COALESCE(a.delivered,0) > 0 THEN round(COALESCE(u.unsubscribes,0)::numeric / a.delivered, 4) END,
      'fail_rate',   CASE WHEN COALESCE(a.sent,0) > 0      THEN round(COALESCE(a.failed,0)::numeric / a.sent, 4) END,
      'skip_rate',   CASE WHEN COALESCE(a.total,0) > 0     THEN round((COALESCE(a.skipped,0)+COALESCE(a.suppressed,0))::numeric / a.total, 4) END,
      -- NEW: slug click-through, kept distinct from `clicked`/`click_rate` above.
      'slug_codes',       COALESCE(sg.codes, '{}'),
      'slug_clicks',      COALESCE(sg.clicks, 0),
      'slug_unique',      COALESCE(sg.unique_visitors, 0),
      'slug_click_rate',  CASE WHEN COALESCE(a.delivered,0) > 0 AND COALESCE(sg.clicks,0) > 0
                               THEN round(sg.clicks::numeric / a.delivered, 4) END
    ) AS row
    FROM c
    LEFT JOIN agg a ON a.campaign_id = c.id
    LEFT JOIN clk k ON k.campaign_id = c.id
    LEFT JOIN slug sg ON sg.campaign_id = c.id
    LEFT JOIN unsub u ON u.campaign_id = c.id
    LEFT JOIN ord o ON o.campaign_id = c.id
  ) s;
$function$;

NOTIFY pgrst, 'reload schema';
