-- Segment evaluation: interpret a JSON predicate AST into the set of matching
-- profile ids. Set-algebra (intersect/union/except) — injection-safe, no dynamic SQL.
-- Leaves: {attr,op,value} | {event,count,within} | {consent,channel,purpose,state}
-- Groups: {all:[...]} (intersect) | {any:[...]} (union) | {none:[...]} (all except union)
-- Applied 2026-06-25 (S170). Logic verified on the win-back example (4 synthetic profiles).

CREATE OR REPLACE FUNCTION comms._attr(p comms.profiles, k text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE k
    WHEN 'city' THEN p.city
    WHEN 'locale' THEN p.locale
    WHEN 'display_name' THEN p.display_name
    ELSE p.attributes->>k END;
$$;

CREATE OR REPLACE FUNCTION comms.eval_segment_node(node jsonb) RETURNS uuid[]
LANGUAGE plpgsql STABLE AS $$
DECLARE
  child jsonb; acc uuid[]; first boolean := true; k text; op text; val jsonb;
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
      WHERE c.channel = node->>'channel' AND c.purpose = node->>'purpose' AND c.state = node->>'state'
        AND c.id = (SELECT c2.id FROM comms.consent c2
                    WHERE c2.profile_id=c.profile_id AND c2.channel=c.channel AND c2.purpose=c.purpose
                    ORDER BY c2.captured_at DESC LIMIT 1));
  END IF;
  RETURN ARRAY[]::uuid[];
END;
$$;

CREATE OR REPLACE FUNCTION comms.materialize_segment(p_segment_id uuid) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE v_def jsonb; v_kind text; n integer;
BEGIN
  SELECT definition, kind INTO v_def, v_kind FROM comms.segments WHERE id = p_segment_id;
  IF v_kind <> 'dynamic' THEN RETURN NULL; END IF;
  DELETE FROM comms.segment_members WHERE segment_id = p_segment_id;
  INSERT INTO comms.segment_members (segment_id, profile_id)
    SELECT p_segment_id, pid FROM unnest(comms.eval_segment_node(v_def)) pid
    ON CONFLICT DO NOTHING;
  SELECT count(*) INTO n FROM comms.segment_members WHERE segment_id = p_segment_id;
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION comms.preview_segment(p_def jsonb, p_channel text, p_purpose text)
RETURNS TABLE(total integer, reachable integer) LANGUAGE plpgsql STABLE AS $$
DECLARE ids uuid[];
BEGIN
  ids := comms.eval_segment_node(p_def);
  total := array_length(ids, 1); IF total IS NULL THEN total := 0; END IF;
  SELECT count(*) INTO reachable FROM unnest(ids) pid
   WHERE NOT EXISTS (SELECT 1 FROM comms.suppressions s WHERE s.channel=p_channel AND s.profile_id=pid)
     AND (p_purpose <> 'marketing' OR EXISTS (
          SELECT 1 FROM comms.consent c WHERE c.profile_id=pid AND c.channel=p_channel AND c.purpose='marketing'
            AND c.state='opted_in'
            AND c.id=(SELECT c2.id FROM comms.consent c2 WHERE c2.profile_id=pid AND c2.channel=p_channel AND c2.purpose='marketing' ORDER BY c2.captured_at DESC LIMIT 1)));
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION comms._attr(comms.profiles, text)        TO service_role;
GRANT EXECUTE ON FUNCTION comms.eval_segment_node(jsonb)           TO service_role;
GRANT EXECUTE ON FUNCTION comms.materialize_segment(uuid)          TO service_role;
GRANT EXECUTE ON FUNCTION comms.preview_segment(jsonb, text, text) TO service_role;
NOTIFY pgrst, 'reload schema';
