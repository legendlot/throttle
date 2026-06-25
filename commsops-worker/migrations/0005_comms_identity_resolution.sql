-- Atomic identity resolution + conservative merge for the comms substrate.
-- resolve_identity: given a set of {type,value} identifiers, returns the single
-- profile they belong to — creating, attaching, or (on strong-key collision) merging.
-- Applied 2026-06-25 (S170) via Supabase apply_migration. Logic verified across
-- 5 scenarios (new / attach / same / strong-merge / conservative-no-merge).

CREATE OR REPLACE FUNCTION comms.merge_profiles(p_survivor uuid, p_merged uuid, p_reason text, p_by text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_snapshot jsonb;
BEGIN
  IF p_survivor = p_merged OR p_merged IS NULL THEN RETURN; END IF;
  SELECT to_jsonb(pr.*) INTO v_snapshot FROM comms.profiles pr WHERE id = p_merged;
  IF v_snapshot IS NULL THEN RETURN; END IF;

  UPDATE comms.identifiers SET profile_id = p_survivor WHERE profile_id = p_merged;
  UPDATE comms.events      SET profile_id = p_survivor WHERE profile_id = p_merged;
  UPDATE comms.consent     SET profile_id = p_survivor WHERE profile_id = p_merged;
  UPDATE comms.messages    SET profile_id = p_survivor WHERE profile_id = p_merged;
  UPDATE comms.enrolments  SET profile_id = p_survivor WHERE profile_id = p_merged;
  UPDATE comms.suppressions SET profile_id = p_survivor WHERE profile_id = p_merged;
  DELETE FROM comms.segment_members sm
   WHERE sm.profile_id = p_merged
     AND EXISTS (SELECT 1 FROM comms.segment_members s2
                  WHERE s2.segment_id = sm.segment_id AND s2.profile_id = p_survivor);
  UPDATE comms.segment_members SET profile_id = p_survivor WHERE profile_id = p_merged;

  INSERT INTO comms.profile_merges (survivor_id, merged_id, merged_by, reason, snapshot)
  VALUES (p_survivor, p_merged, p_by, p_reason, v_snapshot);

  DELETE FROM comms.profiles WHERE id = p_merged;
END;
$$;

CREATE OR REPLACE FUNCTION comms.resolve_identity(p_identifiers jsonb, p_source text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_strong text[] := ARRAY['phone','email','shopify_customer_id'];
  v_matched uuid[];
  v_survivor uuid;
  v_has_strong boolean := false;
  v_ident jsonb;
  v_type text;
  v_value text;
  v_pid uuid;
  v_other uuid;
BEGIN
  FOR v_ident IN SELECT * FROM jsonb_array_elements(p_identifiers) LOOP
    v_type  := v_ident->>'type';
    v_value := v_ident->>'value';
    CONTINUE WHEN v_type IS NULL OR v_value IS NULL OR length(v_value) = 0;
    SELECT profile_id INTO v_pid FROM comms.identifiers WHERE type = v_type AND value = v_value;
    IF v_pid IS NOT NULL THEN
      v_matched := array_append(v_matched, v_pid);
      IF v_type = ANY(v_strong) THEN v_has_strong := true; END IF;
    END IF;
  END LOOP;
  SELECT array_agg(DISTINCT m) INTO v_matched FROM unnest(v_matched) m;

  IF v_matched IS NULL OR array_length(v_matched, 1) IS NULL THEN
    INSERT INTO comms.profiles DEFAULT VALUES RETURNING id INTO v_survivor;
  ELSIF array_length(v_matched, 1) = 1 THEN
    v_survivor := v_matched[1];
  ELSE
    SELECT id INTO v_survivor FROM comms.profiles
      WHERE id = ANY(v_matched) ORDER BY created_at ASC LIMIT 1;
    IF v_has_strong THEN
      FOR v_other IN SELECT unnest(v_matched) EXCEPT SELECT v_survivor LOOP
        PERFORM comms.merge_profiles(v_survivor, v_other, 'auto:identity_resolution', p_source);
      END LOOP;
    END IF;
  END IF;

  FOR v_ident IN SELECT * FROM jsonb_array_elements(p_identifiers) LOOP
    v_type  := v_ident->>'type';
    v_value := v_ident->>'value';
    CONTINUE WHEN v_type IS NULL OR v_value IS NULL OR length(v_value) = 0;
    INSERT INTO comms.identifiers (profile_id, type, value, is_verified, source, last_seen)
    VALUES (v_survivor, v_type, v_value,
            COALESCE((v_ident->>'is_verified')::boolean, false),
            COALESCE(v_ident->>'source', p_source), now())
    ON CONFLICT (type, value) DO UPDATE SET last_seen = now();
  END LOOP;

  UPDATE comms.profiles SET updated_at = now() WHERE id = v_survivor;
  RETURN v_survivor;
END;
$$;

GRANT EXECUTE ON FUNCTION comms.merge_profiles(uuid, uuid, text, text)  TO service_role;
GRANT EXECUTE ON FUNCTION comms.resolve_identity(jsonb, text)           TO service_role;

NOTIFY pgrst, 'reload schema';
