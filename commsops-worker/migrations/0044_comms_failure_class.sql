-- 0044 — failure classification + deliverability_health corrections.
--
-- WHY. `status='failed'` was ONE undifferentiated bucket, and 76.7% of it is not a failure in any
-- actionable sense. Measured over 30 days on 2026-08-07 (1,719 failed messages):
--   1,269 (73.8%)  wa_131049  Meta declined — "healthy ecosystem engagement" (per-user frequency)
--     240 (14.0%)  wa_131026  no WhatsApp account on that number
--      52 ( 3.0%)  unresolved_variables — OUR defect
--      50 ( 2.9%)  wa_130472  recipient in a Meta experiment
--      33           wa_131053  media upload
--      30           no_sender_on_waba — OUR config defect
--      20           wa_132018  template parameters — OUR defect
--   plus 132001 / 200 / 100 / 2 / 131050
-- Mixing these means a 33% "fail rate" on Cart Recovery reads as a system problem when it is
-- audience fatigue, while the ~8% that IS a real defect is invisible — which is exactly how the
-- OFD unresolved_variables break went unnoticed until someone happened to query for it.
--
-- The class is DERIVED from the reason string (which already carries `wa_<code>:`), so there is
-- no new column, no backfill, and historical rows classify identically to new ones.
--
-- ⚠️ Keep `other` as the catch-all and DO NOT let it silently absorb new codes — a code that
-- starts appearing in `other` at volume is a new failure mode worth naming. Add it here once its
-- meaning is confirmed against Meta's error reference, not on a guess.
CREATE OR REPLACE FUNCTION comms.wa_failure_class(p_reason text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_reason IS NULL THEN 'other'
    -- Meta accepted the request and then declined to deliver. Not retryable, not our bug:
    -- it is a signal about the AUDIENCE (fatigue / per-user limits / experiments).
    WHEN p_reason LIKE 'wa_131049%' THEN 'meta_declined'
    WHEN p_reason LIKE 'wa_130472%' THEN 'meta_declined'
    WHEN p_reason LIKE 'wa_131050%' THEN 'meta_declined'   -- recipient stopped marketing
    -- The number cannot receive WhatsApp at all. A data-quality signal: these should be
    -- suppressed rather than retried, because every attempt is spend with a zero ceiling.
    WHEN p_reason LIKE 'wa_131026%' THEN 'invalid_recipient'
    WHEN p_reason LIKE 'wa_131047%' THEN 'invalid_recipient'
    -- OURS. This is the only bucket anyone can act on, and the only one worth alerting on.
    WHEN p_reason LIKE 'unresolved_variables%' THEN 'our_defect'
    WHEN p_reason LIKE 'media_header%'         THEN 'our_defect'
    WHEN p_reason LIKE 'no_sender_on_waba%'    THEN 'our_defect'
    WHEN p_reason LIKE 'wa_132018%' THEN 'our_defect'   -- template parameter mismatch
    WHEN p_reason LIKE 'wa_132001%' THEN 'our_defect'   -- template name/translation missing
    WHEN p_reason LIKE 'wa_200%'    THEN 'our_defect'   -- permissions on the sending number
    WHEN p_reason LIKE 'wa_100%'    THEN 'our_defect'   -- bad object id in the request
    WHEN p_reason LIKE 'INVALID_JSON%' THEN 'our_defect'
    -- Retry would plausibly succeed.
    WHEN p_reason LIKE 'wa_131053%' THEN 'transient'    -- media upload
    WHEN p_reason LIKE 'wa_2:%'     THEN 'transient'    -- service temporarily unavailable
    ELSE 'other'
  END;
$$;
GRANT EXECUTE ON FUNCTION comms.wa_failure_class(text) TO service_role;

COMMENT ON FUNCTION comms.wa_failure_class(text) IS
'Buckets comms.messages.reason into meta_declined | invalid_recipient | our_defect | transient | other. Derived, not stored, so history and new rows classify the same. ⚠️ our_defect is the only bucket that indicates a bug; meta_declined is an AUDIENCE signal and should be excluded from any engineering fail-rate. Watch `other` — a code appearing there at volume is a new failure mode to name deliberately.';


-- ── deliverability_health / _v2 ─────────────────────────────────────────────────────────────
-- THREE corrections, all measured live 2026-08-07:
--
-- (1) FAILURES WERE ENTIRELY ABSENT. The surface showed sent/delivered/opened only, so a 65.67%
--     delivered_rate on +919035697508 had no visible explanation anywhere in the app. Now carries
--     `failed` plus a `by_failure_class` breakdown.
--
-- (2) read_rate could EXCEED 100% — 129.17% was live on +917022142666 (31 opened / 24 delivered),
--     because WhatsApp can deliver a `read` webhook with no preceding `delivered` one. The
--     denominator is now "reached the handset at all" (delivered_at OR read_at), which is both
--     correct and impossible to exceed.
--
-- (3) bounced / complained are EMAIL concepts. Rendering a hard 0 for a WhatsApp sender reads as
--     "measured, none occurred" when the right answer is "not applicable". They are NULL for
--     non-email channels now, so the UI can show an em-dash.
CREATE OR REPLACE FUNCTION comms.deliverability_health(p_days int DEFAULT 30)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) FROM (
    SELECT m.sender_identity_id,
           si.channel, si.address, si.provider,
           si.metadata->>'quality_rating'  AS quality_rating,
           si.metadata->>'messaging_limit' AS messaging_limit,
           si.metadata->>'quality_updated_at' AS quality_updated_at,
           count(*) FILTER (WHERE m.sent_at IS NOT NULL)      AS sent,
           count(*) FILTER (WHERE m.delivered_at IS NOT NULL) AS delivered,
           count(*) FILTER (WHERE m.read_at IS NOT NULL)      AS opened,
           count(*) FILTER (WHERE m.status = 'failed')        AS failed,
           CASE WHEN si.channel = 'email'
                THEN count(*) FILTER (WHERE m.status = 'bounced') END                   AS bounced,
           CASE WHEN si.channel = 'email'
                THEN count(*) FILTER (WHERE m.provider_status = 'email.complained') END AS complained,
           COALESCE(sum(m.cost), 0) AS spend,
           -- Explicit per-class FILTERs rather than an object_agg: the classes are a closed set,
           -- and jsonb_strip_nulls keeps a sender's breakdown to the classes it actually hit
           -- instead of five zeroes that read like measurements.
           jsonb_strip_nulls(jsonb_build_object(
             'meta_declined',     nullif(count(*) FILTER (WHERE m.status='failed' AND comms.wa_failure_class(m.reason)='meta_declined'), 0),
             'invalid_recipient', nullif(count(*) FILTER (WHERE m.status='failed' AND comms.wa_failure_class(m.reason)='invalid_recipient'), 0),
             'our_defect',        nullif(count(*) FILTER (WHERE m.status='failed' AND comms.wa_failure_class(m.reason)='our_defect'), 0),
             'transient',         nullif(count(*) FILTER (WHERE m.status='failed' AND comms.wa_failure_class(m.reason)='transient'), 0),
             'other',             nullif(count(*) FILTER (WHERE m.status='failed' AND comms.wa_failure_class(m.reason)='other'), 0)
           )) AS by_failure_class,
           round(100.0 * count(*) FILTER (WHERE m.delivered_at IS NOT NULL)
                 / nullif(count(*) FILTER (WHERE m.sent_at IS NOT NULL), 0), 2) AS delivered_rate,
           round(100.0 * count(*) FILTER (WHERE m.read_at IS NOT NULL)
                 / nullif(count(*) FILTER (WHERE m.delivered_at IS NOT NULL
                                              OR m.read_at IS NOT NULL), 0), 2) AS read_rate,
           CASE WHEN si.channel = 'email' THEN round(100.0 * count(*) FILTER (WHERE m.status='bounced')
                 / nullif(count(*) FILTER (WHERE m.sent_at IS NOT NULL), 0), 2) END AS bounce_rate,
           CASE WHEN si.channel = 'email' THEN round(100.0 * count(*) FILTER (WHERE m.provider_status='email.complained')
                 / nullif(count(*) FILTER (WHERE m.sent_at IS NOT NULL), 0), 2) END AS complaint_rate
    FROM comms.messages m
    LEFT JOIN comms.sender_identities si ON si.id = m.sender_identity_id
    WHERE m.queued_at >= now() - make_interval(days => p_days)
      AND m.sender_identity_id IS NOT NULL
    GROUP BY 1, 2, 3, 4, 5, 6, 7
    ORDER BY sent DESC
  ) t;
$$;
GRANT EXECUTE ON FUNCTION comms.deliverability_health(int) TO service_role;


-- The calendar-range twin the app uses for Today/MTD/Last-month/FY presets. Kept
-- byte-identical to the trailing-window version above except the range predicate, so the
-- two can never disagree about what a number means.
CREATE OR REPLACE FUNCTION comms.deliverability_health_v2(p_from timestamptz, p_to timestamptz)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) FROM (
    SELECT m.sender_identity_id,
           si.channel, si.address, si.provider,
           si.metadata->>'quality_rating'  AS quality_rating,
           si.metadata->>'messaging_limit' AS messaging_limit,
           si.metadata->>'quality_updated_at' AS quality_updated_at,
           count(*) FILTER (WHERE m.sent_at IS NOT NULL)      AS sent,
           count(*) FILTER (WHERE m.delivered_at IS NOT NULL) AS delivered,
           count(*) FILTER (WHERE m.read_at IS NOT NULL)      AS opened,
           count(*) FILTER (WHERE m.status = 'failed')        AS failed,
           CASE WHEN si.channel = 'email'
                THEN count(*) FILTER (WHERE m.status = 'bounced') END                   AS bounced,
           CASE WHEN si.channel = 'email'
                THEN count(*) FILTER (WHERE m.provider_status = 'email.complained') END AS complained,
           COALESCE(sum(m.cost), 0) AS spend,
           -- Explicit per-class FILTERs rather than an object_agg: the classes are a closed set,
           -- and jsonb_strip_nulls keeps a sender's breakdown to the classes it actually hit
           -- instead of five zeroes that read like measurements.
           jsonb_strip_nulls(jsonb_build_object(
             'meta_declined',     nullif(count(*) FILTER (WHERE m.status='failed' AND comms.wa_failure_class(m.reason)='meta_declined'), 0),
             'invalid_recipient', nullif(count(*) FILTER (WHERE m.status='failed' AND comms.wa_failure_class(m.reason)='invalid_recipient'), 0),
             'our_defect',        nullif(count(*) FILTER (WHERE m.status='failed' AND comms.wa_failure_class(m.reason)='our_defect'), 0),
             'transient',         nullif(count(*) FILTER (WHERE m.status='failed' AND comms.wa_failure_class(m.reason)='transient'), 0),
             'other',             nullif(count(*) FILTER (WHERE m.status='failed' AND comms.wa_failure_class(m.reason)='other'), 0)
           )) AS by_failure_class,
           round(100.0 * count(*) FILTER (WHERE m.delivered_at IS NOT NULL)
                 / nullif(count(*) FILTER (WHERE m.sent_at IS NOT NULL), 0), 2) AS delivered_rate,
           round(100.0 * count(*) FILTER (WHERE m.read_at IS NOT NULL)
                 / nullif(count(*) FILTER (WHERE m.delivered_at IS NOT NULL
                                              OR m.read_at IS NOT NULL), 0), 2) AS read_rate,
           CASE WHEN si.channel = 'email' THEN round(100.0 * count(*) FILTER (WHERE m.status='bounced')
                 / nullif(count(*) FILTER (WHERE m.sent_at IS NOT NULL), 0), 2) END AS bounce_rate,
           CASE WHEN si.channel = 'email' THEN round(100.0 * count(*) FILTER (WHERE m.provider_status='email.complained')
                 / nullif(count(*) FILTER (WHERE m.sent_at IS NOT NULL), 0), 2) END AS complaint_rate
    FROM comms.messages m
    LEFT JOIN comms.sender_identities si ON si.id = m.sender_identity_id
    WHERE m.queued_at >= p_from AND m.queued_at < p_to
      AND m.sender_identity_id IS NOT NULL
    GROUP BY 1, 2, 3, 4, 5, 6, 7
    ORDER BY sent DESC
  ) t;
$$;
GRANT EXECUTE ON FUNCTION comms.deliverability_health_v2(timestamptz, timestamptz) TO service_role;
