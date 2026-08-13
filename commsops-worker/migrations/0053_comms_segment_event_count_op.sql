-- Segment AST: the `event` leaf gets a COUNT OPERATOR (S276, 2026-08-13).
--
-- Until now the event count was hardcoded `HAVING count(*) >= cnt` and the UI drew the `≥` as a
-- static glyph, so "ordered exactly once" was not expressible on events.
-- New optional key: {"event":…, "count":N, "count_op":"gte"|"eq"|"lte"}   (absent => "gte")
--
-- ⚠️ THIS FILE IS THE LIVE BODY, DUMPED FROM pg_get_functiondef AFTER APPLYING — not hand-written.
-- Read the incident note below before you edit it.
--
-- ⛔ INCIDENT, 2026-08-13 — HOW THIS WENT WRONG THE FIRST TIME (v1, reverted by v2).
-- I rebuilt this function by copying the body out of migrations/0022 and adding my branch. That
-- file is NOT the current definition: `comms_segment_event_property_filter_v1` (applied
-- 2026-08-09, S268, Mishica's per-product narrowing) added the event `where` filter DIRECTLY TO
-- THE DATABASE and was never written into this directory. CREATE OR REPLACE silently dropped it.
-- Caught only by a before/after audience diff: "HP Drop Test" went 896 -> 21,310 because its
-- collection_handle='l-o-t-build' narrowing stopped applying. No customer impact — 0 segments
-- re-materialized and 0 segment-entry enrolments occurred in the ~2-minute window — but a
-- campaign send in that window would have gone to 24x the intended audience.
--
-- ⭐ THE RULE: `commsops-worker/migrations/` is an INCOMPLETE MIRROR of what is applied (~270
-- migrations applied, ~53 files here). NEVER reconstruct a function from a file in this
-- directory. Start from the live body:
--     SELECT pg_get_functiondef('comms.eval_segment_node(jsonb)'::regprocedure);
-- and diff before/after audience counts for every segment before you call it done:
--     store.safety_segment_eval_before_2026_08_13
--
-- ⚠️ Two behaviours this encodes, both load-bearing:
--  1. count_op ABSENT MUST MEAN 'gte', and 'gte' ALWAYS takes the original HAVING path for ANY
--     cnt. v1 special-cased cnt>=1 and routed gte-with-0 down the new branch, which is a
--     different result. Back-compat must be total, not "total for the values we expect".
--  2. 'lte' (any n) and 'eq 0' MUST use the LEFT JOIN over profiles. A GROUP BY over events can
--     never emit a row for a profile with none, so "at most 1 order" would otherwise mean "has
--     ordered, at most once" and silently omit everyone who never ordered — a plausible-looking
--     wrong number, which is the worst kind.

CREATE OR REPLACE FUNCTION comms.eval_segment_node(node jsonb)
 RETURNS uuid[]
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  child jsonb;
  acc uuid[];
  first boolean := true;
  k text; op text; val jsonb;
BEGIN
  IF node IS NULL OR node = '{}'::jsonb THEN
    RETURN ARRAY(SELECT id FROM comms.profiles);
  ELSIF node ? 'all' THEN
    FOR child IN SELECT * FROM jsonb_array_elements(node->'all') LOOP
      IF first THEN acc := comms.eval_segment_node(child); first := false;
      ELSE acc := ARRAY(SELECT unnest(acc) INTERSECT SELECT unnest(comms.eval_segment_node(child))); END IF;
    END LOOP;
    RETURN coalesce(acc, ARRAY[]::uuid[]);
  ELSIF node ? 'any' THEN
    FOR child IN SELECT * FROM jsonb_array_elements(node->'any') LOOP
      acc := ARRAY(SELECT DISTINCT unnest(coalesce(acc, ARRAY[]::uuid[]) || comms.eval_segment_node(child)));
    END LOOP;
    RETURN coalesce(acc, ARRAY[]::uuid[]);
  ELSIF node ? 'none' THEN
    FOR child IN SELECT * FROM jsonb_array_elements(node->'none') LOOP
      acc := ARRAY(SELECT DISTINCT unnest(coalesce(acc, ARRAY[]::uuid[]) || comms.eval_segment_node(child)));
    END LOOP;
    RETURN ARRAY(SELECT id FROM comms.profiles WHERE id <> ALL(coalesce(acc, ARRAY[]::uuid[])));
  ELSIF node ? 'attr' THEN
    k := node->>'attr'; op := coalesce(node->>'op','eq'); val := node->'value';
    RETURN ARRAY(
      SELECT p.id FROM comms.profiles p WHERE CASE
        WHEN op='eq'  THEN comms._attr(p,k) = (val#>>'{}')
        WHEN op='neq' THEN comms._attr(p,k) IS DISTINCT FROM (val#>>'{}')
        WHEN op='in'  THEN comms._attr(p,k) IN (SELECT jsonb_array_elements_text(val))
        WHEN op='gt'  THEN (comms._attr(p,k))::numeric >  (val#>>'{}')::numeric
        WHEN op='gte' THEN (comms._attr(p,k))::numeric >= (val#>>'{}')::numeric
        WHEN op='lt'  THEN (comms._attr(p,k))::numeric <  (val#>>'{}')::numeric
        WHEN op='lte' THEN (comms._attr(p,k))::numeric <= (val#>>'{}')::numeric
        WHEN op='before_days' THEN comms._attr(p,k) ~ '^\d{4}-\d{2}-\d{2}'
             AND (comms._attr(p,k))::timestamptz <  now() - ((val#>>'{}')::int * interval '1 day')
        WHEN op='within_days' THEN comms._attr(p,k) ~ '^\d{4}-\d{2}-\d{2}'
             AND (comms._attr(p,k))::timestamptz >= now() - ((val#>>'{}')::int * interval '1 day')
        ELSE false END);
  ELSIF node ? 'event' THEN
    DECLARE cnt int := coalesce(NULLIF(regexp_replace(coalesce(node->>'count','1'),'[^0-9]','','g'),'')::int, 1);
            win text := node->>'within';
            wnode jsonb := node->'where';
            wprop text := wnode->>'prop';
            wval jsonb := wnode->'value';
            wvals text[];
            cop text := lower(coalesce(node->>'count_op','gte'));
    BEGIN
      -- A half-written filter is REJECTED LOUDLY rather than silently ignored (which would
      -- over-send to an unfiltered audience) or silently matched to nothing (the S268
      -- consent-leaf failure, PATTERN-277). Both silent directions are harmful here: one
      -- mails people who never viewed the product, the other reports a real audience as empty.
      IF wnode IS NOT NULL AND (wprop IS NULL OR wprop = '' OR wval IS NULL OR wval = 'null'::jsonb) THEN
        RAISE EXCEPTION 'segment event filter is incomplete: `where` needs both prop and value (got prop=%, value=%)', wprop, wval;
      END IF;
      IF wnode IS NOT NULL THEN
        wvals := CASE WHEN jsonb_typeof(wval) = 'array'
                      THEN ARRAY(SELECT jsonb_array_elements_text(wval))
                      ELSE ARRAY[wval#>>'{}'] END;
      END IF;

      IF cop NOT IN ('gte','eq','lte') THEN cop := 'gte'; END IF;

      IF cop = 'gte' THEN
        -- the ORIGINAL path, unchanged, for ANY cnt — this is what every pre-existing
        -- segment resolves to, so it must stay byte-identical in behaviour.
        RETURN ARRAY(
          SELECT e.profile_id FROM comms.events e
          WHERE e.name = node->>'event' AND e.profile_id IS NOT NULL
            AND (win IS NULL OR e.occurred_at >= now() - win::interval)
            AND (wnode IS NULL OR e.properties->>wprop = ANY(wvals))
          GROUP BY e.profile_id HAVING count(*) >= cnt);
      ELSIF cop = 'eq' AND cnt >= 1 THEN
        RETURN ARRAY(
          SELECT e.profile_id FROM comms.events e
          WHERE e.name = node->>'event' AND e.profile_id IS NOT NULL
            AND (win IS NULL OR e.occurred_at >= now() - win::interval)
            AND (wnode IS NULL OR e.properties->>wprop = ANY(wvals))
          GROUP BY e.profile_id HAVING count(*) = cnt);
      ELSE
        -- 'lte' at any n, or 'eq 0': zero must be a CANDIDATE, and a GROUP BY over events can
        -- never produce a row for a profile that has none. Without this, "at most 1 order"
        -- would mean "has ordered, at most once" and silently omit everyone who never ordered.
        RETURN ARRAY(
          SELECT p.id FROM comms.profiles p
          LEFT JOIN (
            SELECT e.profile_id, count(*) AS c FROM comms.events e
             WHERE e.name = node->>'event' AND e.profile_id IS NOT NULL
               AND (win IS NULL OR e.occurred_at >= now() - win::interval)
               AND (wnode IS NULL OR e.properties->>wprop = ANY(wvals))
             GROUP BY e.profile_id
          ) ec ON ec.profile_id = p.id
          WHERE CASE cop
                  WHEN 'lte' THEN coalesce(ec.c, 0) <= cnt
                  ELSE            coalesce(ec.c, 0) =  cnt
                END);
      END IF;
    END;
  ELSIF node ? 'consent' THEN
    RETURN ARRAY(
      SELECT c.profile_id FROM comms.consent c
      WHERE c.channel = node->>'channel' AND c.purpose = node->>'purpose'
        AND c.state = node->>'state'
        AND c.id = (SELECT c2.id FROM comms.consent c2
                    WHERE c2.profile_id=c.profile_id AND c2.channel=c.channel AND c2.purpose=c.purpose
                    ORDER BY c2.captured_at DESC LIMIT 1));
  END IF;
  RETURN ARRAY[]::uuid[];
END;
$function$;

GRANT EXECUTE ON FUNCTION comms.eval_segment_node(jsonb) TO service_role;
NOTIFY pgrst, 'reload schema';
