-- 0079 — journey_funnel: say WHY, not just how many (Pruthvi, #bugs 1790600384, 2026-09-28:
-- "display the actual reasons behind each funnel dropout and rejection instead of showing them
-- in code language").
--
-- Two ADDITIVE keys; every existing key is byte-identical, so an old client keeps working.
--
-- (1) `reasons` — step_id → { status → { reason → n } } for the rows that did NOT go through:
--     skipped / suppressed / failed / not_done. Keyed on the TRANSPORT status first (then the
--     result key), so an interactive send that was suppressed but whose outcome reads `no_reply`
--     still reports why. `deduped` is left out: the engine counts it as delivered (send.js returns
--     it when a sent/in-flight row already exists; journey-graph.js sendWentOut includes it). The reason was always recorded on the
--     row (`result.reason`, or `result.error`) and never aggregated: the Build browse-abandonment
--     journey showed "SKIPPED: 4004" when 4,771 of its skip rows say `no_consent` (measured
--     2026-09-29). Reasons are cut at the first ':' — `wa_132001:(#132001) Template name…`,
--     `unresolved_variables:cart_link_suffix`, `insufficient_stock:<product>: need 1, have 0` —
--     so a free-text tail (a product title, Meta's message) can't split one cause into many rows.
--
-- (2) `stopped` — step_id → { enrolment status → n }: where each enrolment IS now
--     (`enrolments.current_step`). `active` there means waiting at that step; any other status
--     is where it ended — a `progressed`/`purchased` exit rule fires wherever the person is
--     parked, so this is what explains a step-over-step drop (Build browse: the 994 who never
--     reached the first check = 953 progressed + 32 purchased + 5 still waiting + the rest).
--     Enrolments with no current_step (expired/failed before any step row) are keyed ''.
--
-- (3) `parked` — step_id → n active enrolments at that step. It was returned by
--     comms_journey_funnel_parked_v1 (2026-07-14) and dropped by comms_funnel_entered_fix
--     (2026-08-07). Re-emitted for API compatibility; the panel now reads `stopped` (whose
--     `active` is the same number).
--
-- (4) The trigger-event join compared `ev.id::text = context->>'trigger_event_id'`, which casts
--     every event id: a seq scan + ~1 GB sort of ~2M comms.events on EVERY call, whatever the
--     version filter (Cars-Browse cold: 54 s vs the 30 s service_role statement_timeout —
--     hostile review S403). Now a uuid = uuid join on the PK; a malformed id joins nothing,
--     exactly as the text compare did.

CREATE OR REPLACE FUNCTION comms.journey_funnel(p_journey_id uuid, p_version integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'comms', 'public', 'extensions', 'pg_temp'
AS $function$
  WITH enr AS (
    SELECT e.*, COALESCE((ev.properties->>'total')::numeric, 0) AS trigger_value
    FROM comms.enrolments e
    LEFT JOIN comms.events ev
      ON ev.id = CASE WHEN e.context->>'trigger_event_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                      THEN (e.context->>'trigger_event_id')::uuid END
    WHERE e.journey_id = p_journey_id
      AND (p_version IS NULL OR e.journey_version = p_version)
  ),
  st AS (
    SELECT es.step_id, es.step_type, enr.trigger_value, es.result,
           COALESCE(
             CASE WHEN es.result ? 'branch'
                  THEN 'branch_' || (es.result->>'branch') END,   -- condition
             es.result->>'outcome',                               -- branch taken (incl. buttons)
             es.result->>'status',                                -- plain send transport status
             'entered'                                            -- wait / other
           ) AS result_key
    FROM comms.enrolment_steps es
    JOIN enr ON es.enrolment_id = enr.id
  ),
  per_step AS (
    SELECT step_id,
           min(step_type) AS step_type,
           sum(c)         AS entered,
           jsonb_object_agg(result_key, c) AS results,
           jsonb_object_agg(result_key, v) AS result_values
    FROM (
      SELECT step_id, step_type, result_key, count(*) AS c, round(sum(trigger_value), 2) AS v
      FROM st GROUP BY step_id, step_type, result_key
    ) g
    GROUP BY step_id
  ),
  why AS (
    SELECT step_id, COALESCE(NULLIF(result->>'status', ''), result_key) AS result_key,
           COALESCE(NULLIF(split_part(COALESCE(result->>'reason', result->>'error', ''), ':', 1), ''),
                    'unknown') AS reason,
           count(*) AS c
    FROM st
    WHERE COALESCE(NULLIF(result->>'status', ''), result_key) IN ('skipped', 'suppressed', 'failed', 'not_done')
    GROUP BY 1, 2, 3
  ),
  why_key AS (
    SELECT step_id, result_key, jsonb_object_agg(reason, c) AS r FROM why GROUP BY 1, 2
  ),
  why_step AS (
    SELECT step_id, jsonb_object_agg(result_key, r) AS r FROM why_key GROUP BY 1
  ),
  stop_key AS (
    SELECT COALESCE(current_step, '') AS step_id, status, count(*) AS c FROM enr GROUP BY 1, 2
  ),
  stop_step AS (
    SELECT step_id, jsonb_object_agg(status, c) AS s FROM stop_key GROUP BY 1
  )
  SELECT jsonb_build_object(
    'steps', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'step_id', step_id, 'step_type', step_type,
               'entered', entered, 'results', results, 'result_values', result_values
             ) ORDER BY entered DESC)
      FROM per_step), '[]'::jsonb),
    'enrolments', COALESCE((
      SELECT jsonb_object_agg(status, c)
      FROM (SELECT status, count(*) AS c FROM enr GROUP BY status) s), '{}'::jsonb),
    'total_enrolments', (SELECT count(*) FROM enr),
    'trigger_value_total', (SELECT round(COALESCE(sum(trigger_value),0), 2) FROM enr),
    'reasons', COALESCE((SELECT jsonb_object_agg(step_id, r) FROM why_step), '{}'::jsonb),
    'stopped', COALESCE((SELECT jsonb_object_agg(step_id, s) FROM stop_step), '{}'::jsonb),
    'parked',  COALESCE((SELECT jsonb_object_agg(step_id, c) FROM stop_key WHERE status = 'active' AND step_id <> ''), '{}'::jsonb)
  );
$function$;
