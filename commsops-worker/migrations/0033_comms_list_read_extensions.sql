-- 0033 — list read extensions for the COMMAND redesign (S231, §9 of
-- RELAY_REDESIGN_HANDOFF.md). Two purely-additive STABLE reads — no writes,
-- no gate changes. Set-based (one query per list — never per-row N+1,
-- RULE-AUDIT-001 class).
--
-- profiles_list: the contacts list + each profile's effective MARKETING
-- consent per channel ({channel: state}). Latest-row-wins per
-- (profile, channel, purpose='marketing'), ordered captured_at DESC with
-- created_at DESC as the tiebreaker (the S228-flagged latestConsent
-- same-millisecond hazard, done right here from day one).
--
-- segments_list: segments + current member count from comms.segment_members.
-- NB segment_members is REBUILT by materialize_segment() (PATTERN-176), so for
-- dynamic segments the count is "as of last refresh" — the UI labels it so.

CREATE OR REPLACE FUNCTION comms.profiles_list(p_limit integer DEFAULT 100)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $function$
  WITH p AS (
    SELECT id, display_name, locale, city, attributes, created_at
    FROM comms.profiles
    ORDER BY created_at DESC
    LIMIT GREATEST(p_limit, 0)
  ),
  latest AS (
    SELECT DISTINCT ON (c.profile_id, c.channel)
      c.profile_id, c.channel, c.state
    FROM comms.consent c
    JOIN p ON p.id = c.profile_id
    WHERE c.purpose = 'marketing'
    ORDER BY c.profile_id, c.channel, c.captured_at DESC, c.created_at DESC
  ),
  agg AS (
    SELECT profile_id, jsonb_object_agg(channel, state) AS consent
    FROM latest
    GROUP BY profile_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', p.id,
    'display_name', p.display_name,
    'locale', p.locale,
    'city', p.city,
    'attributes', p.attributes,
    'created_at', p.created_at,
    'consent', COALESCE(a.consent, '{}'::jsonb)
  ) ORDER BY p.created_at DESC), '[]'::jsonb)
  FROM p
  LEFT JOIN agg a ON a.profile_id = p.id;
$function$;

CREATE OR REPLACE FUNCTION comms.segments_list()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', s.id,
    'name', s.name,
    'kind', s.kind,
    'definition', s.definition,
    'created_by', s.created_by,
    'created_at', s.created_at,
    'updated_at', s.updated_at,
    'entry_tracking_since', s.entry_tracking_since,
    'member_count', COALESCE(m.n, 0)
  ) ORDER BY s.updated_at DESC), '[]'::jsonb)
  FROM comms.segments s
  LEFT JOIN (
    SELECT segment_id, count(*) AS n
    FROM comms.segment_members
    GROUP BY segment_id
  ) m ON m.segment_id = s.id;
$function$;

GRANT EXECUTE ON FUNCTION comms.profiles_list(integer) TO service_role;
GRANT EXECUTE ON FUNCTION comms.segments_list() TO service_role;
