-- 0055 · relay_segment_eval_perf_v1 · applied live 2026-08-17 (S293)
-- ⚠️ MIRROR of the applied Supabase migration — the live DB is the source of truth
-- (PATTERN-297: never rebuild a function from this file; use pg_get_functiondef).
--
-- Segment eval was tripping PostgREST's 8s statement timeout on large segments —
-- preview_segment 7.7s (per-profile marketing_consented() walk over 187k ids) and
-- materialize_segment ~11s (187k-row rewrite). Mishica hit both in the builder
-- (#bugs 1786965260.528529, 2026-08-17). Three parts:
--   1. service_role gets its own 30s statement_timeout (PostgREST applies
--      impersonated-role settings per request; anon 3s / authenticated 8s untouched —
--      the worker is the only API client on service_role).
--   2. comms.suppressions gains a (profile_id, channel) index — the reachable-count
--      NOT EXISTS probe had no profile_id index at all.
--   3. preview_segment goes hybrid: per-row path under 20k ids (index lookups beat
--      scanning all ~376k consent rows), set-based DISTINCT ON pass above it
--      (7.7s -> ~3.3s on 187k). Semantics identical — count parity proven on both
--      the plain branch and the rcs branch (rcs = COALESCE(rcs,sms)='opted_in'
--      AND sms='opted_in', the S290 consent gate). marketing_consented() itself is
--      UNCHANGED (still the per-profile truth used by the gate's SQL twin).
-- Verified live: worker-path "Refresh members" on the 187k segment completes (~11s,
-- under the new 30s), preview 4.8s cold / 0.7s warm.

ALTER ROLE service_role SET statement_timeout = '30s';

CREATE INDEX IF NOT EXISTS suppressions_profile_idx
  ON comms.suppressions (profile_id, channel);

CREATE OR REPLACE FUNCTION comms.preview_segment(p_def jsonb, p_channel text, p_purpose text)
 RETURNS TABLE(total integer, reachable integer)
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE ids uuid[];
BEGIN
  ids := comms.eval_segment_node(p_def);
  total := COALESCE(array_length(ids, 1), 0);
  IF total = 0 THEN reachable := 0; RETURN NEXT; RETURN; END IF;

  IF total < 20000 THEN
    -- small audience: per-profile index lookups beat scanning every consent row
    SELECT count(*) INTO reachable FROM unnest(ids) pid
     WHERE NOT EXISTS (SELECT 1 FROM comms.suppressions s
                        WHERE s.profile_id=pid
                          AND (s.channel=p_channel OR (p_channel='rcs' AND s.channel='sms')))
       AND (p_purpose <> 'marketing' OR comms.marketing_consented(pid, p_channel));
  ELSE
    -- large audience: one set-based pass over latest-consent-per-(profile,channel)
    SELECT count(*) INTO reachable
    FROM unnest(ids) AS i(pid)
    LEFT JOIN (
      SELECT profile_id,
             max(state) FILTER (WHERE channel = p_channel) AS ch_state,
             max(state) FILTER (WHERE channel = 'rcs')     AS rcs_state,
             max(state) FILTER (WHERE channel = 'sms')     AS sms_state
      FROM (
        SELECT DISTINCT ON (c.profile_id, c.channel) c.profile_id, c.channel, c.state
        FROM comms.consent c
        WHERE c.purpose='marketing'
          AND (c.channel = p_channel OR (p_channel='rcs' AND c.channel='sms'))
        ORDER BY c.profile_id, c.channel, c.captured_at DESC
      ) latest GROUP BY profile_id
    ) p ON p.profile_id = i.pid
    WHERE NOT EXISTS (SELECT 1 FROM comms.suppressions s
                       WHERE s.profile_id=i.pid
                         AND (s.channel=p_channel OR (p_channel='rcs' AND s.channel='sms')))
      AND (p_purpose <> 'marketing'
           OR CASE WHEN p_channel <> 'rcs' THEN p.ch_state = 'opted_in'
                   ELSE COALESCE(p.rcs_state, p.sms_state) = 'opted_in'
                        AND p.sms_state = 'opted_in' END);
  END IF;
  RETURN NEXT;
END;
$function$;

NOTIFY pgrst, 'reload config';
