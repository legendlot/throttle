-- 0049 — retire comms.resolve_identity_v2 (S272, 2026-08-11)
--
-- `resolve_identity_v2` had 0 callers: not the worker (grep of the whole 05_Throttle repo
-- returns nothing), not another function, not a view. The live path is `resolve_identity`,
-- called from ingest.js.
--
-- ⚠️ It was NOT stale scaffolding, and the tempting read is the wrong one. The two functions
-- are LOGICALLY IDENTICAL — normalising both (strip `--` comments, collapse whitespace) gives
-- 2,958 characters each and an exact string match. The only difference is that `_v2` carries
-- the explanatory comments and the live one had them stripped, which is why `_v2` was the
-- LARGER of the two (3,616 vs 3,297 raw). That size difference reads as "v2 is the newer,
-- improved one" and it is not — which is exactly the footgun of leaving it in place, and the
-- reason for dropping it rather than leaving two near-identical names in one schema.
--
-- So: port the better comments ONTO the live function first (logic untouched, byte-identical
-- after normalisation), then drop the orphan. Nothing behavioural changes here.

-- ⚠️ `p_source` carries `DEFAULT NULL::text` and it must be restated here. Omitting it fails
-- loudly (42P13 "cannot remove parameter defaults from existing function") rather than
-- silently — but restate it anyway, because a caller may invoke this with one argument.
CREATE OR REPLACE FUNCTION comms.resolve_identity(p_identifiers jsonb, p_source text DEFAULT NULL::text)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_strong_types text[] := ARRAY['phone','email','shopify_customer_id'];
  v_strong uuid[];
  v_weak   uuid[];
  v_survivor uuid;
  v_ident jsonb;
  v_type text;
  v_value text;
  v_pid uuid;
  v_other uuid;
  v_is_weak boolean;
  v_incoming_strong boolean := false;   -- payload OFFERS a strong key (matched or brand-new)
  v_weak_owner_identified boolean := false;
BEGIN
  FOR v_ident IN SELECT * FROM jsonb_array_elements(p_identifiers) LOOP
    v_type  := v_ident->>'type';
    v_value := v_ident->>'value';
    CONTINUE WHEN v_type IS NULL OR v_value IS NULL OR length(v_value) = 0;
    IF v_type = ANY(v_strong_types) THEN v_incoming_strong := true; END IF;
    SELECT profile_id INTO v_pid FROM comms.identifiers WHERE type = v_type AND value = v_value;
    IF v_pid IS NOT NULL THEN
      IF v_type = ANY(v_strong_types) THEN v_strong := array_append(v_strong, v_pid);
      ELSE                                 v_weak   := array_append(v_weak,   v_pid);
      END IF;
    END IF;
  END LOOP;
  SELECT array_agg(DISTINCT m) INTO v_strong FROM unnest(COALESCE(v_strong, '{}')) m;
  SELECT array_agg(DISTINCT m) INTO v_weak   FROM unnest(COALESCE(v_weak,   '{}')) m;

  IF v_weak IS NOT NULL AND array_length(v_weak,1) >= 1 THEN
    SELECT EXISTS (SELECT 1 FROM comms.identifiers i
                    WHERE i.profile_id = ANY(v_weak) AND i.type = ANY(v_strong_types))
      INTO v_weak_owner_identified;
  END IF;

  IF v_strong IS NOT NULL AND array_length(v_strong,1) >= 1 THEN
    SELECT id INTO v_survivor FROM comms.profiles WHERE id = ANY(v_strong) ORDER BY created_at ASC LIMIT 1;
  ELSIF v_weak IS NOT NULL AND array_length(v_weak,1) >= 1
        AND NOT (v_incoming_strong AND v_weak_owner_identified) THEN
    -- continue the session's profile. Excluded when a BRAND-NEW strong key arrives on a
    -- browser whose session already belongs to an identified person: that is a second human
    -- on a shared device, and absorbing them would silently fuse two customers.
    SELECT id INTO v_survivor FROM comms.profiles WHERE id = ANY(v_weak) ORDER BY created_at ASC LIMIT 1;
  ELSE
    INSERT INTO comms.profiles DEFAULT VALUES RETURNING id INTO v_survivor;
  END IF;

  IF v_strong IS NOT NULL THEN
    FOR v_other IN SELECT unnest(v_strong) EXCEPT SELECT v_survivor LOOP
      PERFORM comms.merge_profiles(v_survivor, v_other, 'auto:identity_resolution', p_source);
    END LOOP;
  END IF;

  IF v_weak IS NOT NULL THEN
    FOR v_other IN SELECT unnest(v_weak) EXCEPT SELECT v_survivor LOOP
      IF NOT EXISTS (SELECT 1 FROM comms.identifiers i
                      WHERE i.profile_id = v_other AND i.type = ANY(v_strong_types)) THEN
        PERFORM comms.merge_profiles(v_survivor, v_other, 'auto:identity_resolution_weak', p_source);
      END IF;
    END LOOP;
  END IF;

  FOR v_ident IN SELECT * FROM jsonb_array_elements(p_identifiers) LOOP
    v_type  := v_ident->>'type';
    v_value := v_ident->>'value';
    CONTINUE WHEN v_type IS NULL OR v_value IS NULL OR length(v_value) = 0;
    v_is_weak := NOT (v_type = ANY(v_strong_types));
    INSERT INTO comms.identifiers (profile_id, type, value, is_verified, source, last_seen)
    VALUES (v_survivor, v_type, v_value,
            COALESCE((v_ident->>'is_verified')::boolean, false),
            COALESCE(v_ident->>'source', p_source), now())
    ON CONFLICT (type, value) DO UPDATE
      SET last_seen  = now(),
          profile_id = CASE WHEN v_is_weak THEN EXCLUDED.profile_id ELSE comms.identifiers.profile_id END;
  END LOOP;

  UPDATE comms.profiles SET updated_at = now() WHERE id = v_survivor;
  RETURN v_survivor;
END;
$$;

COMMENT ON FUNCTION comms.resolve_identity(jsonb, text) IS
  'Identity resolution for ingest: strong keys (phone/email/shopify_customer_id) win, weak '
  'session keys continue a profile unless a brand-new strong key lands on an already-identified '
  'session (shared device). The only version — resolve_identity_v2 was an identical duplicate, '
  'dropped 2026-08-11 (migration 0049).';

DROP FUNCTION IF EXISTS comms.resolve_identity_v2(jsonb, text);
