-- 0032 — journey_stats_list: the journeys twin of campaign_stats_list (S230, applied
-- live as comms_journey_stats_list_v1). Set-based, ONE query for the whole list
-- (per-journey RPCs would be 2N subrequests — the RULE-AUDIT-001 trap).
-- Campaign-parity conventions preserved: skipped stays DISTINCT from failed; ₹ derived
-- at read time via message_cost_inr (self-heals on rate corrections); `unpriced` counts
-- sends we could NOT price; ROI only when spend>0 AND unpriced=0; attribution =
-- engaged-basis (read/clicked → order within the settings window).
-- Journey-native additions: enrolled / enrolled_30d / in_flight / completed /
-- purchased_exits (exit outcome 'purchased' — the journey's own success signal, which can
-- fire WITHOUT any message going out) / other exits / by_channel message split (journeys
-- are multi-channel per node; campaigns are single-channel).
CREATE OR REPLACE FUNCTION comms.journey_stats_list(p_limit integer DEFAULT 200, p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $function$
  WITH w AS (
    SELECT COALESCE((SELECT attribution_window_days FROM comms.settings WHERE id = 1), 7) AS days
  ),
  j AS (
    SELECT id, name, status, trigger, reenrolment, created_at, updated_at,
           -- The purpose of this journey's send steps, read off its ACTIVE version. A journey
           -- mixing purposes reports 'mixed' rather than silently picking one.
           (SELECT CASE WHEN count(DISTINCT st.value->>'purpose') > 1 THEN 'mixed'
                        ELSE min(st.value->>'purpose') END
              FROM comms.journey_versions v
              CROSS JOIN LATERAL jsonb_each(v.definition->'steps') st
             WHERE v.journey_id = comms.journeys.id
               AND v.version = comms.journeys.active_version
               AND st.value->>'type' = 'send') AS send_purpose
    FROM comms.journeys
    ORDER BY updated_at DESC NULLS LAST
    LIMIT GREATEST(p_limit, 0) OFFSET GREATEST(p_offset, 0)
  ),
  en AS (
    SELECT j.id AS journey_id, e.id AS enrolment_id, e.status, e.enrolled_at
    FROM j JOIN comms.enrolments e ON e.journey_id = j.id
  ),
  ena AS (
    SELECT journey_id,
      count(*)                                                          AS enrolled,
      count(*) FILTER (WHERE enrolled_at >= now() - interval '30 days') AS enrolled_30d,
      count(*) FILTER (WHERE status = 'active')                         AS in_flight,
      count(*) FILTER (WHERE status = 'completed')                      AS completed,
      count(*) FILTER (WHERE status = 'purchased')                      AS purchased_exits,
      count(*) FILTER (WHERE status = 'failed')                         AS failed_enrolments,
      count(*) FILTER (WHERE status NOT IN ('active','completed','purchased','failed')) AS exited,
      max(enrolled_at)                                                  AS last_enrolled_at
    FROM en GROUP BY journey_id
  ),
  m AS (
    SELECT en.journey_id, msg.id, msg.profile_id, msg.status, msg.provider_status, msg.reason,
           msg.queued_at, msg.sent_at, msg.delivered_at, msg.read_at, msg.cost,
           msg.channel AS msg_channel, msg.pricing_category, msg.billable,
           comms.message_cost_inr(msg.channel, msg.pricing_category, msg.billable, msg.sent_at) AS cost_inr
    FROM en JOIN comms.messages msg ON msg.source = 'journey:' || en.enrolment_id::text
  ),
  agg AS (
    SELECT journey_id,
      count(*)                                                     AS total,
      count(*) FILTER (WHERE sent_at IS NOT NULL)                  AS sent,
      count(*) FILTER (WHERE delivered_at IS NOT NULL)             AS delivered,
      count(*) FILTER (WHERE read_at IS NOT NULL)                  AS opened,
      count(*) FILTER (WHERE delivered_at IS NOT NULL OR read_at IS NOT NULL) AS reached,
      count(*) FILTER (WHERE status = 'bounced')                   AS bounced,
      count(*) FILTER (WHERE provider_status = 'email.complained') AS complained,
      count(*) FILTER (WHERE status = 'failed'
                         AND provider_status IS DISTINCT FROM 'email.complained') AS failed,
      count(*) FILTER (WHERE status = 'suppressed')                AS suppressed,
      count(*) FILTER (WHERE status = 'skipped')                   AS skipped,
      min(sent_at)                                                 AS first_sent_at,
      max(sent_at)                                                 AS last_sent_at,
      COALESCE(sum(cost), 0)                                       AS billable_units,
      COALESCE(sum(cost_inr), 0)                                   AS cost_inr,
      count(*) FILTER (WHERE sent_at IS NOT NULL AND cost_inr IS NULL
                         AND status <> 'failed') AS unpriced,
      count(*) FILTER (WHERE status='failed' AND comms.wa_failure_class(reason)='meta_declined')     AS f_meta_declined,
      count(*) FILTER (WHERE status='failed' AND comms.wa_failure_class(reason)='invalid_recipient') AS f_invalid_recipient,
      count(*) FILTER (WHERE status='failed' AND comms.wa_failure_class(reason)='our_defect')        AS f_our_defect,
      count(*) FILTER (WHERE status='failed' AND comms.wa_failure_class(reason)='transient')         AS f_transient,
      count(*) FILTER (WHERE status='failed' AND comms.wa_failure_class(reason)='other')             AS f_other
    FROM m GROUP BY journey_id
  ),
  bych AS (
    SELECT journey_id, jsonb_object_agg(msg_channel, ch) AS by_channel
    FROM (
      SELECT journey_id, msg_channel, jsonb_build_object(
        'sent',      count(*) FILTER (WHERE sent_at IS NOT NULL),
        'delivered', count(*) FILTER (WHERE delivered_at IS NOT NULL),
        'opened',    count(*) FILTER (WHERE read_at IS NOT NULL),
        'failed',    count(*) FILTER (WHERE status = 'failed'),
        'skipped',   count(*) FILTER (WHERE status IN ('skipped','suppressed'))
      ) AS ch
      FROM m GROUP BY journey_id, msg_channel
    ) x GROUP BY journey_id
  ),
  clk AS (
    SELECT m.journey_id, count(DISTINCT e.properties->>'message_id') AS clicked
    FROM m JOIN comms.events e
      ON e.name = 'link_clicked' AND e.properties->>'message_id' = m.id::text
    GROUP BY m.journey_id
  ),
  unsub AS (
    SELECT m.journey_id, count(DISTINCT m.profile_id) AS unsubscribes
    FROM m JOIN comms.events e
      ON e.profile_id = m.profile_id AND e.name = 'opted_out'
     AND e.occurred_at >= COALESCE(m.sent_at, m.queued_at)
    GROUP BY m.journey_id
  ),
  eng AS (
    SELECT DISTINCT m.journey_id, m.profile_id, COALESCE(m.sent_at, m.queued_at) AS touch_at
    FROM m
    WHERE m.profile_id IS NOT NULL
      AND (m.read_at IS NOT NULL
           OR EXISTS (SELECT 1 FROM comms.events e
                       WHERE e.name = 'link_clicked'
                         AND e.properties->>'message_id' = m.id::text))
  ),
  ord AS (
    SELECT journey_id, count(*) AS attributed_orders, COALESCE(sum(total), 0) AS attributed_revenue
    FROM (
      SELECT DISTINCT eng.journey_id, e.id,
             COALESCE((e.properties->>'total')::numeric, 0) AS total
      FROM eng
      JOIN comms.events e ON e.profile_id = eng.profile_id AND e.name = 'order_placed'
      CROSS JOIN w
      WHERE e.occurred_at >= eng.touch_at
        AND e.occurred_at <= eng.touch_at + make_interval(days => w.days)
    ) d
    GROUP BY journey_id
  )
  SELECT COALESCE(jsonb_agg(row ORDER BY row->>'at' DESC NULLS LAST), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
      'id', j.id, 'name', j.name, 'status', j.status,
      'trigger', j.trigger, 'reenrolment', j.reenrolment,
      'at',              COALESCE(a.last_sent_at, ea.last_enrolled_at, j.updated_at),
      'enrolled',        COALESCE(ea.enrolled, 0),
      'enrolled_30d',    COALESCE(ea.enrolled_30d, 0),
      'in_flight',       COALESCE(ea.in_flight, 0),
      'completed',       COALESCE(ea.completed, 0),
      'purchased_exits', COALESCE(ea.purchased_exits, 0),
      'exited',          COALESCE(ea.exited, 0),
      'failed_enrolments', COALESCE(ea.failed_enrolments, 0),
      'total',           COALESCE(a.total, 0),
      'sent',            COALESCE(a.sent, 0),
      'delivered',       COALESCE(a.delivered, 0),
      'opened',          COALESCE(a.opened, 0),
      'clicked',         COALESCE(k.clicked, 0),
      'bounced',         COALESCE(a.bounced, 0),
      'complained',      COALESCE(a.complained, 0),
      'failed',          COALESCE(a.failed, 0),
      'skipped',         COALESCE(a.skipped, 0) + COALESCE(a.suppressed, 0),
      'unsubscribes',    COALESCE(u.unsubscribes, 0),
      'billable_units',  COALESCE(a.billable_units, 0),
      'cost_inr',        COALESCE(a.cost_inr, 0),
      'unpriced',        COALESCE(a.unpriced, 0),
      'by_channel',      COALESCE(b.by_channel, '{}'::jsonb),
      'attributed_orders',  COALESCE(o.attributed_orders, 0),
      'attributed_revenue', COALESCE(o.attributed_revenue, 0),
      'window_days',     (SELECT days FROM w),
      'send_purpose',    j.send_purpose,
      'by_failure_class', jsonb_strip_nulls(jsonb_build_object(
          'meta_declined',     nullif(COALESCE(a.f_meta_declined,0),0),
          'invalid_recipient', nullif(COALESCE(a.f_invalid_recipient,0),0),
          'our_defect',        nullif(COALESCE(a.f_our_defect,0),0),
          'transient',         nullif(COALESCE(a.f_transient,0),0),
          'other',             nullif(COALESCE(a.f_other,0),0))),
      'defect_rate', CASE WHEN COALESCE(a.sent,0) > 0
                          THEN round(COALESCE(a.f_our_defect,0)::numeric / a.sent, 4) END,
      'roi', CASE WHEN COALESCE(a.cost_inr,0) > 0
                  THEN round(COALESCE(o.attributed_revenue,0) / a.cost_inr, 2) END,
      'read_rate',   CASE WHEN COALESCE(a.reached,0) > 0 THEN round(a.opened::numeric / a.reached, 4) END,
      'click_rate',  CASE WHEN COALESCE(a.delivered,0) > 0 THEN round(COALESCE(k.clicked,0)::numeric / a.delivered, 4) END,
      'order_rate',  CASE WHEN COALESCE(a.delivered,0) > 0 THEN round(COALESCE(o.attributed_orders,0)::numeric / a.delivered, 4) END,
      'unsub_rate',  CASE WHEN COALESCE(a.delivered,0) > 0 THEN round(COALESCE(u.unsubscribes,0)::numeric / a.delivered, 4) END,
      'fail_rate',   CASE WHEN COALESCE(a.sent,0) > 0      THEN round(COALESCE(a.failed,0)::numeric / a.sent, 4) END,
      'skip_rate',   CASE WHEN COALESCE(a.total,0) > 0     THEN round((COALESCE(a.skipped,0)+COALESCE(a.suppressed,0))::numeric / a.total, 4) END,
      'conversion_rate', CASE WHEN COALESCE(ea.enrolled,0) > 0
                              THEN round(COALESCE(ea.purchased_exits,0)::numeric / ea.enrolled, 4) END
    ) AS row
    FROM j
    LEFT JOIN ena ea ON ea.journey_id = j.id
    LEFT JOIN agg a  ON a.journey_id = j.id
    LEFT JOIN bych b ON b.journey_id = j.id
    LEFT JOIN clk k  ON k.journey_id = j.id
    LEFT JOIN unsub u ON u.journey_id = j.id
    LEFT JOIN ord o  ON o.journey_id = j.id
  ) s;
$function$;
