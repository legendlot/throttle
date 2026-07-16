-- Segment-entry trigger (BiteSpeed parity: the "Winback WA" journey triggers on
-- `enters "winback90"`). reference/bitespeed.md §5 lists segment-entry as a Relay
-- engine coverage gap; this closes it.
--
-- WHY A NEW TABLE — the load-bearing constraint:
--   comms.materialize_segment() does DELETE-then-INSERT of comms.segment_members, so
--   segment_members.added_at is reset to now() for EVERY member on every refresh. It is
--   NOT a record of when anyone entered. Building entry detection on it (e.g. "enrol
--   where added_at > last_run") would re-enrol the ENTIRE segment on every refresh —
--   14,020 people for winback60+, repeatedly. Entry therefore needs durable state that
--   materialization cannot destroy: comms.segment_membership.
--   segment_members stays exactly as-is (campaign audiences); the two are independent.
--
-- THE BASELINE RULE (safety-critical):
--   Activating an entry journey on a segment that already has 14,020 members must NOT
--   enrol those 14,020 — "entry" means crossing IN, not already being there. The first
--   scan of a segment therefore runs in BASELINE mode: it adopts the whole current set
--   silently, emits nothing, enrols nobody, and stamps segments.entry_tracking_since.
--   Only arrivals after that point are entries.
--
-- THE CAP:
--   A widened segment definition (winback60 → winback30) makes thousands newly qualify
--   at once; all of them legitimately "enter". segment_entry_max_per_tick bounds how many
--   are admitted per run. The remainder is NOT dropped — un-admitted profiles simply have
--   no membership row yet, so the next tick re-detects them and drains at cap/tick. The
--   caller alerts on `remaining > 0` (no silent truncation).

-- ── durable membership (independent of the volatile segment_members) ────────────
CREATE TABLE IF NOT EXISTS comms.segment_membership (
  segment_id uuid NOT NULL REFERENCES comms.segments(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES comms.profiles(id) ON DELETE CASCADE,
  entered_at timestamptz NOT NULL DEFAULT now(),
  exited_at  timestamptz,                       -- non-null = left; re-entry clears it
  PRIMARY KEY (segment_id, profile_id)
);
-- RULE-RLS-001: RLS on at creation, service_role only.
ALTER TABLE comms.segment_membership ENABLE ROW LEVEL SECURITY;
GRANT ALL ON comms.segment_membership TO service_role;
CREATE INDEX IF NOT EXISTS segment_membership_active_idx
  ON comms.segment_membership (segment_id) WHERE exited_at IS NULL;

-- null = never baselined → the next scan baselines rather than enrolling.
ALTER TABLE comms.segments ADD COLUMN IF NOT EXISTS entry_tracking_since timestamptz;

ALTER TABLE comms.settings
  ADD COLUMN IF NOT EXISTS segment_entry_max_per_tick int NOT NULL DEFAULT 500;

INSERT INTO comms.event_definitions (name, description, expected_props, is_active)
  VALUES ('segment_entered', 'A profile newly entered a dynamic segment (emitted by segment_entry_scan).',
          '{"segment_id":"uuid","segment_name":"text"}'::jsonb, true)
ON CONFLICT (name) DO NOTHING;

-- ── the scan ────────────────────────────────────────────────────────────────────
-- segment_entry_scan(segment, limit, emit) → jsonb
--   emit=false → BASELINE: adopt the current set silently (no events, no entries returned)
--   emit=true  → admit up to `limit` new entrants: write membership, emit segment_entered,
--                return their profile ids for the caller to enrol.
-- Exits are always reconciled so a later re-entry is a genuine new entry.
CREATE OR REPLACE FUNCTION comms.segment_entry_scan(
  p_segment_id uuid, p_limit int DEFAULT 500, p_emit boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_def jsonb; v_kind text; v_name text;
  cur uuid[]; v_new uuid[]; v_take uuid[];
  v_exited int := 0; v_total_new int := 0; v_taken int := 0;
BEGIN
  SELECT definition, kind, name INTO v_def, v_kind, v_name
    FROM comms.segments WHERE id = p_segment_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'segment_not_found'); END IF;
  IF v_kind <> 'dynamic' THEN RETURN jsonb_build_object('error', 'not_dynamic'); END IF;

  -- Current truth. NULLs stripped: a NULL in the array would make the NOT IN below
  -- match zero rows and silently mark the whole segment as exited.
  SELECT COALESCE(array_agg(pid), ARRAY[]::uuid[]) INTO cur
    FROM unnest(COALESCE(comms.eval_segment_node(v_def), ARRAY[]::uuid[])) pid
   WHERE pid IS NOT NULL;

  -- exits first, so a profile that left and came back re-enters cleanly below
  UPDATE comms.segment_membership m SET exited_at = now()
   WHERE m.segment_id = p_segment_id
     AND m.exited_at IS NULL
     AND m.profile_id <> ALL (cur);
  GET DIAGNOSTICS v_exited = ROW_COUNT;

  -- entrants = current set MINUS anyone holding an ACTIVE membership row.
  -- EXCEPT (hash-based set difference) not NOT EXISTS-over-unnest, which would
  -- re-evaluate the array per row. ORDER BY makes the capped subset deterministic.
  SELECT COALESCE(array_agg(pid ORDER BY pid), ARRAY[]::uuid[]) INTO v_new
    FROM (
      SELECT unnest(cur) AS pid
      EXCEPT
      SELECT profile_id FROM comms.segment_membership
       WHERE segment_id = p_segment_id AND exited_at IS NULL
    ) x;
  v_total_new := COALESCE(array_length(v_new, 1), 0);

  IF NOT p_emit THEN
    INSERT INTO comms.segment_membership (segment_id, profile_id)
      SELECT p_segment_id, pid FROM unnest(v_new) pid
    ON CONFLICT (segment_id, profile_id)
      DO UPDATE SET entered_at = now(), exited_at = NULL;
    UPDATE comms.segments SET entry_tracking_since = now() WHERE id = p_segment_id;
    RETURN jsonb_build_object('mode', 'baseline', 'segment_name', v_name,
      'baselined', v_total_new, 'exited', v_exited,
      'entered', '[]'::jsonb, 'entered_count', 0, 'remaining', 0);
  END IF;

  v_take := v_new[1:GREATEST(p_limit, 0)];
  v_taken := COALESCE(array_length(v_take, 1), 0);

  INSERT INTO comms.segment_membership (segment_id, profile_id)
    SELECT p_segment_id, pid FROM unnest(v_take) pid
  ON CONFLICT (segment_id, profile_id)
    DO UPDATE SET entered_at = now(), exited_at = NULL;

  -- Substrate record of the entry (also makes it visible on the contact timeline).
  INSERT INTO comms.events (profile_id, name, occurred_at, properties, source, idempotency_key)
    SELECT pid, 'segment_entered', now(),
           jsonb_build_object('segment_id', p_segment_id::text, 'segment_name', v_name),
           'segment_entry_scan',
           -- clock_timestamp() (real wall clock, per-row) NOT now() (transaction time,
           -- constant for the whole call): an exit and re-entry share a now() second, so a
           -- now()-based key collides and ON CONFLICT silently eats the re-entry event.
           'segment_entry:' || p_segment_id::text || ':' || pid::text || ':'
             || ((extract(epoch from clock_timestamp()) * 1000000)::bigint)::text
      FROM unnest(v_take) pid
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN jsonb_build_object('mode', 'emit', 'segment_name', v_name,
    'entered', to_jsonb(v_take), 'entered_count', v_taken, 'exited', v_exited,
    'remaining', GREATEST(v_total_new - v_taken, 0));
END;
$$;
GRANT EXECUTE ON FUNCTION comms.segment_entry_scan(uuid, int, boolean) TO service_role;

NOTIFY pgrst, 'reload schema';
