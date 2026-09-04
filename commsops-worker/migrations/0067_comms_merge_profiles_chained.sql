-- 0067: comms.merge_profiles could not merge a profile that had ALREADY survived a merge
-- (S352, 2026-09-04). Pre-existing bug, found by the Shopify tag re-pull; not introduced by it.
--
-- THE BUG. merge_profiles repoints seven tables off the losing profile before deleting it —
-- identifiers, events, consent, messages, enrolments, suppressions, segment_members — but NOT
-- comms.profile_merges. That table has an FK on survivor_id -> profiles(id) with NO ACTION, so
-- the final `DELETE FROM comms.profiles WHERE id = p_merged` raises 23503 whenever the losing
-- profile is named as the SURVIVOR of some earlier merge:
--
--   update or delete on table "profiles" violates foreign key constraint
--   "profile_merges_survivor_id_fkey" ... Key (id)=(...) is still referenced from
--   table "profile_merges".
--
-- In other words a profile could be merged INTO exactly once and then became unmergeable
-- forever. Measured 2026-09-04: 1,419 merges across 1,140 distinct survivors, the most recent
-- that same day — so merging is routine, and every one of those 1,140 survivors was a landmine.
--
-- BLAST RADIUS, which is wider than the pull that found it. merge_profiles is called by
-- comms.resolve_identity, which is the single identity seam behind /ingest, every Shopify
-- customer webhook, the pixel, Shopflo, and comms.shopify_apply_customers. The error propagates
-- out of the RPC, so any of those writes could fail outright on a chained merge. It surfaced
-- here only because a bulk pull encounters far more merge candidates per call than live traffic.
--
-- ⚠️ NO DATA REPAIR IS NEEDED and none is attempted. The FK made the bad state unreachable —
-- every occurrence was a hard, immediate failure, never a silent corruption — so there are no
-- damaged rows to clean up, only writes that never landed.
--
-- THE FIX: repoint the merge history too, which is also what it MEANS. If A was merged into B
-- and B is now merged into C, then A's data now lives in C, so `survivor_id = C` is the true
-- record. The alternative (ON DELETE CASCADE on the FK) would silently destroy audit rows and
-- was rejected for that reason.
--
-- Everything below is the previous definition verbatim plus the single UPDATE marked NEW.
CREATE OR REPLACE FUNCTION comms.merge_profiles(p_survivor uuid, p_merged uuid, p_reason text, p_by text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE v_snapshot jsonb;
BEGIN
  IF p_survivor = p_merged OR p_merged IS NULL THEN RETURN; END IF;
  SELECT to_jsonb(pr.*) INTO v_snapshot FROM comms.profiles pr WHERE id = p_merged;
  IF v_snapshot IS NULL THEN RETURN; END IF;

  -- repoint everything off the merged profile onto the survivor
  UPDATE comms.identifiers SET profile_id = p_survivor WHERE profile_id = p_merged;
  UPDATE comms.events      SET profile_id = p_survivor WHERE profile_id = p_merged;
  UPDATE comms.consent     SET profile_id = p_survivor WHERE profile_id = p_merged;
  UPDATE comms.messages    SET profile_id = p_survivor WHERE profile_id = p_merged;
  UPDATE comms.enrolments  SET profile_id = p_survivor WHERE profile_id = p_merged;
  UPDATE comms.suppressions SET profile_id = p_survivor WHERE profile_id = p_merged;
  -- segment_members has PK (segment_id, profile_id): drop merged rows that would collide, then repoint
  DELETE FROM comms.segment_members sm
   WHERE sm.profile_id = p_merged
     AND EXISTS (SELECT 1 FROM comms.segment_members s2
                  WHERE s2.segment_id = sm.segment_id AND s2.profile_id = p_survivor);
  UPDATE comms.segment_members SET profile_id = p_survivor WHERE profile_id = p_merged;

  -- NEW (0067): the merge LEDGER is repointed too, or the DELETE below hits
  -- profile_merges_survivor_id_fkey and the whole merge fails. Transitively correct: rows that
  -- said "X was merged into p_merged" now say "X was merged into p_survivor", which is where
  -- X's data actually lives after this call.
  UPDATE comms.profile_merges SET survivor_id = p_survivor WHERE survivor_id = p_merged;

  INSERT INTO comms.profile_merges (survivor_id, merged_id, merged_by, reason, snapshot)
  VALUES (p_survivor, p_merged, p_by, p_reason, v_snapshot);

  DELETE FROM comms.profiles WHERE id = p_merged;
END;
$function$;
