-- 0043 — journey_funnel: `entered` counted RESULT KEYS, not enrolments.
--
-- The inner subquery `g` is already GROUP BY (step_id, step_type, result_key), so the outer
-- `count(*)` counted how many DISTINCT OUTCOMES a step had — 1 or 2 — never how many enrolments
-- reached it. Measured on Cart Recovery 2026-08-07: the funnel rendered
--   wait1 1 · cond1 1 · send1 2 · exit 1 · exit 1
-- where the truth is
--   wait1 3311 · cond1 3189 · send1 3176 · exit 3172 · exit 4.
-- Every journey funnel in the app has been showing 1s and 2s since 0013 shipped.
--
-- ⚠️ SECOND-ORDER: `ORDER BY entered DESC` inherited the same broken number, so steps were
-- ordered by how many distinct outcomes they had. That is why Cart Recovery's funnel rendered
-- send → cond → exit → wait instead of its actual wait → cond → send → exit flow. Sorting by the
-- corrected value fixes the order as a side effect, because a funnel monotonically decreases.
--
-- Everything else about the RPC is unchanged: same result_key COALESCE ladder, same enrolment
-- status rollup, same total. Only the aggregate and the sort key move.
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
           sum(c)         AS entered,   -- was count(*): the count of result keys, not enrolments
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
