-- M8 — Analytics layer. Pure derivation over data we already capture
-- (messages, events, enrolment_steps, enrolments). No new capture; read-only RPCs.
-- Aggregation lives here (SQL-side) so the client never sees raw message/event rows.
-- Idempotent (CREATE OR REPLACE / IF NOT EXISTS). Applied 2026-07-10.
--
-- Ground truth this migration relies on (verified against live worker code S206):
--   • Campaign membership → messages.source = 'campaign:'||<id>   (indexed: messages_source_idx)
--   • messages.status is LAST-EVENT-WINS (sent→delivered→opened→clicked, each webhook overwrites).
--     So delivered/opened are counted via the monotonic timestamp cols (delivered_at/read_at),
--     never rolled back; terminal states (bounced/failed/skipped/suppressed/queued) via status.
--   • Complaint = provider_status='email.complained' (status maps to 'failed', reason not patched).
--   • Clicks → comms.events name='link_clicked', properties->>'message_id' = messages.id::text.
--   • Journeys → messages.source='journey:'||<enrolment_id> (NOT journey_id); the funnel is driven
--     off enrolment_steps ⋈ enrolments (which carry journey_id + journey_version).
--   • enrolment_steps.result shapes: wait{duration} · condition{branch} · send{status,reason?} · exit{outcome}.
--   • order_placed event carries properties.total (numeric string).

-- ── Supporting index (only genuinely new access path) ───────────────────────────
-- Click counts look up events by the embedded message_id; partial to link_clicked keeps it tiny.
CREATE INDEX IF NOT EXISTS events_link_clicked_message_idx
  ON comms.events ((properties->>'message_id')) WHERE name = 'link_clicked';
-- Time-range scans for the overview/deliverability windows.
CREATE INDEX IF NOT EXISTS messages_queued_at_idx
  ON comms.messages (queued_at DESC);

-- ── 1. campaign_stats(campaign) → single json object ────────────────────────────
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
    -- profiles in this campaign who opted out at/after they were sent to
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
    'skipped_by_reason', (SELECT skipped_by_reason FROM reasons)
  );
$$;
GRANT EXECUTE ON FUNCTION comms.campaign_stats(uuid) TO service_role;

-- ── 2. journey_funnel(journey, version?) → json (per-step + enrolment status) ────
CREATE OR REPLACE FUNCTION comms.journey_funnel(p_journey_id uuid, p_version int DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH enr AS (
    SELECT * FROM comms.enrolments
    WHERE journey_id = p_journey_id
      AND (p_version IS NULL OR journey_version = p_version)
  ),
  st AS (
    SELECT es.step_id, es.step_type,
           COALESCE(
             es.result->>'status',                                        -- send
             CASE WHEN es.result ? 'branch'                               -- condition
                  THEN 'branch_' || (es.result->>'branch') END,
             es.result->>'outcome',                                       -- exit
             'entered'                                                     -- wait / other
           ) AS result_key
    FROM comms.enrolment_steps es
    JOIN enr ON es.enrolment_id = enr.id
  ),
  per_step AS (
    SELECT step_id,
           min(step_type) AS step_type,
           count(*)       AS entered,
           jsonb_object_agg(result_key, c) AS results
    FROM (
      SELECT step_id, step_type, result_key, count(*) AS c
      FROM st GROUP BY step_id, step_type, result_key
    ) g
    GROUP BY step_id
  )
  SELECT jsonb_build_object(
    'steps', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'step_id', step_id, 'step_type', step_type,
               'entered', entered, 'results', results
             ) ORDER BY entered DESC)
      FROM per_step), '[]'::jsonb),
    'enrolments', COALESCE((
      SELECT jsonb_object_agg(status, c)
      FROM (SELECT status, count(*) AS c FROM enr GROUP BY status) s), '{}'::jsonb),
    'total_enrolments', (SELECT count(*) FROM enr)
  );
$$;
GRANT EXECUTE ON FUNCTION comms.journey_funnel(uuid, int) TO service_role;

-- ── 3. sends_overview(days) → json array (day × channel × purpose) ──────────────
CREATE OR REPLACE FUNCTION comms.sends_overview(p_days int DEFAULT 30)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) FROM (
    SELECT (queued_at AT TIME ZONE 'Asia/Kolkata')::date AS day,
           channel, purpose,
           count(*) FILTER (WHERE sent_at IS NOT NULL)                      AS sent,
           count(*) FILTER (WHERE delivered_at IS NOT NULL)                 AS delivered,
           count(*) FILTER (WHERE status IN ('failed', 'bounced'))          AS failed,
           count(*) FILTER (WHERE status IN ('skipped', 'suppressed'))      AS skipped
    FROM comms.messages
    WHERE queued_at >= now() - make_interval(days => p_days)
    GROUP BY 1, 2, 3
    ORDER BY 1 DESC, 2, 3
  ) t;
$$;
GRANT EXECUTE ON FUNCTION comms.sends_overview(int) TO service_role;

-- ── 4. deliverability_health(days) → json array (per sender identity) ───────────
CREATE OR REPLACE FUNCTION comms.deliverability_health(p_days int DEFAULT 30)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) FROM (
    SELECT m.sender_identity_id,
           si.channel, si.address, si.provider,
           count(*) FILTER (WHERE m.sent_at IS NOT NULL)                     AS sent,
           count(*) FILTER (WHERE m.delivered_at IS NOT NULL)                AS delivered,
           count(*) FILTER (WHERE m.status = 'bounced')                      AS bounced,
           count(*) FILTER (WHERE m.provider_status = 'email.complained')    AS complained,
           round(100.0 * count(*) FILTER (WHERE m.delivered_at IS NOT NULL)
                 / nullif(count(*) FILTER (WHERE m.sent_at IS NOT NULL), 0), 2) AS delivered_rate,
           round(100.0 * count(*) FILTER (WHERE m.status = 'bounced')
                 / nullif(count(*) FILTER (WHERE m.sent_at IS NOT NULL), 0), 2) AS bounce_rate,
           round(100.0 * count(*) FILTER (WHERE m.provider_status = 'email.complained')
                 / nullif(count(*) FILTER (WHERE m.sent_at IS NOT NULL), 0), 2) AS complaint_rate
    FROM comms.messages m
    LEFT JOIN comms.sender_identities si ON si.id = m.sender_identity_id
    WHERE m.queued_at >= now() - make_interval(days => p_days)
      AND m.sender_identity_id IS NOT NULL
    GROUP BY 1, 2, 3, 4
    ORDER BY sent DESC
  ) t;
$$;
GRANT EXECUTE ON FUNCTION comms.deliverability_health(int) TO service_role;

-- ── 5. campaign_attribution(campaign) → json (last-touch v1) ────────────────────
-- Engaged (opened or clicked a campaign message) profiles who placed an order within
-- settings.attribution_window_days of that message's send. DISTINCT order id (a profile
-- may hold multiple campaign messages) so revenue/orders never double-count.
CREATE OR REPLACE FUNCTION comms.campaign_attribution(p_campaign_id uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH w AS (
    SELECT COALESCE((SELECT attribution_window_days FROM comms.settings WHERE id = 1), 7) AS days
  ),
  m AS (
    SELECT id, profile_id, COALESCE(sent_at, queued_at) AS touch_at, read_at
    FROM comms.messages WHERE source = 'campaign:' || p_campaign_id::text
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
    'window_days',         (SELECT days FROM w),
    'engaged_profiles',    (SELECT count(*) FROM eng),
    'attributed_orders',   (SELECT count(*) FROM ord),
    'attributed_revenue',  (SELECT COALESCE(sum(total), 0) FROM ord)
  );
$$;
GRANT EXECUTE ON FUNCTION comms.campaign_attribution(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
