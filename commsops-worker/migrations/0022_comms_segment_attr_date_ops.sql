-- 0022_comms_segment_attr_date_ops
-- Add relative-date ops to the segment-AST `attr` leaf so a date attribute (e.g.
-- last_order_at) can be range-compared against a MOVING window — the winback prerequisite.
--
-- Why: eval_segment_node's lt/gt ops cast to ::numeric, so `last_order_at < <date>` doesn't
-- just fail, it THROWS ('2025-02-13...'::numeric is invalid). The `event` leaf does relative
-- time via `within`, but our order_placed events only reach back to the 2026-06-30 webhook
-- go-live, so "not ordered in 90d" from events is inaccurate until 90d of history accrues.
-- The accurate winback needs a date comparison on the backfilled last_order_at attribute.
--
-- New ops (attr leaf only; purely additive — eq/neq/in/gt/gte/lt/lte/event/consent untouched):
--   before_days  {attr,op:'before_days',value:N}  → attr::timestamptz <  now() - N days  (older than N days)
--   within_days  {attr,op:'within_days',value:N}  → attr::timestamptz >= now() - N days  (in the last N days)
-- A non-date / null attribute value can't throw: a regex guard (`~ '^\d{4}-\d{2}-\d{2}'`)
-- means a null or malformed value yields NULL/false and the profile is simply excluded.
-- now() is re-read every evaluation, so a segment_entry scan sees a moving window each tick.
-- STABLE retained (now() is stable within a statement).

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
    RETURN ARRAY(SELECT id FROM comms.profiles);   -- empty definition = everyone
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
    BEGIN
      RETURN ARRAY(
        SELECT e.profile_id FROM comms.events e
        WHERE e.name = node->>'event' AND e.profile_id IS NOT NULL
          AND (win IS NULL OR e.occurred_at >= now() - win::interval)
        GROUP BY e.profile_id HAVING count(*) >= cnt);
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
