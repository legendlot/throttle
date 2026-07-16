-- M8.5 — Measurement parity for the WhatsApp cutover.
-- Closes the analytics gaps vs BiteSpeed identified in reference/bitespeed.md §4/§5:
--   • BiteSpeed shows per-broadcast ROI (3.63×), cost and revenue. Relay captured
--     messages.cost (the WA adapter parses per-conversation cost off the status webhook)
--     but NO RPC ever read it — `cost` appeared only in 0001's table definition. Email is a
--     flat Resend plan so this was invisible; WhatsApp bills PER CONVERSATION, so at cutover
--     cost becomes real per-send money. → spend surfaces on campaign_stats/sends_overview.
--   • BiteSpeed journeys: 1,81,014 triggered · ₹39,09,587 revenue · 1.24% conv — journeys
--     drive ~49× the broadcast revenue, yet journey_funnel returned step counts only.
--     → NEW journey_attribution(), mirroring campaign_attribution's last-touch v1 model.
--   • WA quality/limit drives Meta throttling. → surfaced on deliverability_health from the
--     sender identity's metadata (persisted by wa-webhooks handleMeta, this session).
--
-- Pure derivation as with 0013 — no new capture, read-only, SQL-side aggregation.
-- Idempotent (CREATE OR REPLACE). All the 0013 ground-truth notes still hold; additionally:
--   • Journey membership → messages.source = 'journey:'||<enrolment_id> (verified against
--     journey-workflow.js #doSend), joined via messages_source_idx.
--   • messages.cost is nullable — null for email (no per-message price) and for any provider
--     that reports no price, so sum() is COALESCE'd to 0 and spend=0 means "no priced sends",
--     NOT "free".

-- ── 1. campaign_stats + spend ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION comms.campaign_stats(p_campaign_id uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH m AS (
    SELECT * FROM comms.messages WHERE source = 'campaign:' || p_campaign_id::text
  ),
  clk AS (
    SELECT count(DISTINCT e.properties->>'message_id') AS clicked
    FROM comms.events e
    WHERE e.name = 'link_clicked'
      AND e.properties->>'message_id' IN (SELECT id::text FROM m)
  ),
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
    -- NEW: money out. Per-conversation for WA; null/0 for flat-rate email.
    'spend',       (SELECT COALESCE(sum(cost), 0) FROM m),
    'priced_sends',(SELECT count(*) FROM m WHERE cost IS NOT NULL)
  );
$$;
GRANT EXECUTE ON FUNCTION comms.campaign_stats(uuid) TO service_role;

-- ── 2. sends_overview + read-rate + spend ───────────────────────────────────────
-- Read rate is THE headline WhatsApp metric (BiteSpeed reports read-rate per broadcast);
-- the overview previously carried sent/delivered/failed/skipped only. WA 'read' maps to
-- read_at via the adapter, same column email opens use — so one metric covers both.
CREATE OR REPLACE FUNCTION comms.sends_overview(p_days int DEFAULT 30)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) FROM (
    SELECT (queued_at AT TIME ZONE 'Asia/Kolkata')::date AS day,
           channel, purpose,
           count(*) FILTER (WHERE sent_at IS NOT NULL)                      AS sent,
           count(*) FILTER (WHERE delivered_at IS NOT NULL)                 AS delivered,
           count(*) FILTER (WHERE read_at IS NOT NULL)                      AS opened,
           count(*) FILTER (WHERE status IN ('failed', 'bounced'))          AS failed,
           count(*) FILTER (WHERE status IN ('skipped', 'suppressed'))      AS skipped,
           COALESCE(sum(cost), 0)                                           AS spend
    FROM comms.messages
    WHERE queued_at >= now() - make_interval(days => p_days)
    GROUP BY 1, 2, 3
    ORDER BY 1 DESC, 2, 3
  ) t;
$$;
GRANT EXECUTE ON FUNCTION comms.sends_overview(int) TO service_role;

-- ── 3. deliverability_health + WA quality/limit + spend ─────────────────────────
-- Meta's quality rating + messaging limit gate throughput; a drop means throttling.
-- Read off the sender identity's metadata, which wa-webhooks now persists on every
-- phone_number_quality_update (previously the update only alerted to Slack and was lost).
CREATE OR REPLACE FUNCTION comms.deliverability_health(p_days int DEFAULT 30)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) FROM (
    SELECT m.sender_identity_id,
           si.channel, si.address, si.provider,
           si.metadata->>'quality_rating'  AS quality_rating,
           si.metadata->>'messaging_limit' AS messaging_limit,
           si.metadata->>'quality_updated_at' AS quality_updated_at,
           count(*) FILTER (WHERE m.sent_at IS NOT NULL)                     AS sent,
           count(*) FILTER (WHERE m.delivered_at IS NOT NULL)                AS delivered,
           count(*) FILTER (WHERE m.read_at IS NOT NULL)                     AS opened,
           count(*) FILTER (WHERE m.status = 'bounced')                      AS bounced,
           count(*) FILTER (WHERE m.provider_status = 'email.complained')    AS complained,
           COALESCE(sum(m.cost), 0)                                          AS spend,
           round(100.0 * count(*) FILTER (WHERE m.delivered_at IS NOT NULL)
                 / nullif(count(*) FILTER (WHERE m.sent_at IS NOT NULL), 0), 2) AS delivered_rate,
           round(100.0 * count(*) FILTER (WHERE m.read_at IS NOT NULL)
                 / nullif(count(*) FILTER (WHERE m.delivered_at IS NOT NULL), 0), 2) AS read_rate,
           round(100.0 * count(*) FILTER (WHERE m.status = 'bounced')
                 / nullif(count(*) FILTER (WHERE m.sent_at IS NOT NULL), 0), 2) AS bounce_rate,
           round(100.0 * count(*) FILTER (WHERE m.provider_status = 'email.complained')
                 / nullif(count(*) FILTER (WHERE m.sent_at IS NOT NULL), 0), 2) AS complaint_rate
    FROM comms.messages m
    LEFT JOIN comms.sender_identities si ON si.id = m.sender_identity_id
    WHERE m.queued_at >= now() - make_interval(days => p_days)
      AND m.sender_identity_id IS NOT NULL
    GROUP BY 1, 2, 3, 4, 5, 6, 7
    ORDER BY sent DESC
  ) t;
$$;
GRANT EXECUTE ON FUNCTION comms.deliverability_health(int) TO service_role;

-- ── 4. journey_attribution(journey, version?) → jsonb (last-touch v1) ───────────
-- The BiteSpeed-parity number: triggered · revenue · conversion. Deliberately mirrors
-- campaign_attribution's model (engaged = opened|clicked within attribution_window_days,
-- DISTINCT order id so a profile holding several journey messages can't double-count) so
-- campaign and journey revenue are computed the same way and are comparable.
-- Membership: enrolments → messages.source = 'journey:'||enrolment_id (via messages_source_idx).
-- conversion_rate is orders ÷ TRIGGERED (enrolments), matching how BiteSpeed reports 1.24%.
CREATE OR REPLACE FUNCTION comms.journey_attribution(p_journey_id uuid, p_version int DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH w AS (
    SELECT COALESCE((SELECT attribution_window_days FROM comms.settings WHERE id = 1), 7) AS days
  ),
  enr AS (
    SELECT id FROM comms.enrolments
    WHERE journey_id = p_journey_id
      AND (p_version IS NULL OR journey_version = p_version)
  ),
  m AS (
    SELECT msg.id, msg.profile_id, COALESCE(msg.sent_at, msg.queued_at) AS touch_at,
           msg.read_at, msg.cost
    FROM comms.messages msg
    JOIN enr ON msg.source = 'journey:' || enr.id::text
  ),
  eng AS (
    SELECT DISTINCT m.profile_id, m.touch_at
    FROM m
    WHERE m.profile_id IS NOT NULL
      AND (m.read_at IS NOT NULL
           OR EXISTS (SELECT 1 FROM comms.events e
                       WHERE e.name = 'link_clicked'
                         AND e.properties->>'message_id' = m.id::text))
  ),
  ord AS (
    SELECT DISTINCT e.id,
           COALESCE((e.properties->>'total')::numeric, 0) AS total
    FROM comms.events e
    JOIN eng ON e.profile_id = eng.profile_id
    CROSS JOIN w
    WHERE e.name = 'order_placed'
      AND e.occurred_at >= eng.touch_at
      AND e.occurred_at <= eng.touch_at + make_interval(days => w.days)
  )
  SELECT jsonb_build_object(
    'window_days',        (SELECT days FROM w),
    'triggered',          (SELECT count(*) FROM enr),
    'messages_sent',      (SELECT count(*) FROM m),
    'engaged_profiles',   (SELECT count(*) FROM eng),
    'attributed_orders',  (SELECT count(*) FROM ord),
    'attributed_revenue', (SELECT COALESCE(sum(total), 0) FROM ord),
    'spend',              (SELECT COALESCE(sum(cost), 0) FROM m),
    'conversion_rate',    round(100.0 * (SELECT count(*) FROM ord)
                                / nullif((SELECT count(*) FROM enr), 0), 2)
  );
$$;
GRANT EXECUTE ON FUNCTION comms.journey_attribution(uuid, int) TO service_role;

NOTIFY pgrst, 'reload schema';
