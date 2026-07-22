-- 0028_comms_consent_unknown_no_override — "unknown" consent must never overrule a
-- KNOWN state (Afshaan-approved 2026-07-22, closes the Shopify unknown-consent
-- hostile-review item deferred from 2026-07-21).
--
-- BUG (verified live): comms.consent is append-only, latest-wins. Shopify's
-- customers/create|update webhook (src/shopify.js mktState) AND the customer backfill
-- both map indeterminate Shopify consent to state:'unknown' and, via
-- comms.shopify_apply_customers, appended it unconditionally. A genuine opted_in (e.g.
-- from internal_test or shopify_import) got clobbered by a later shopify_webhook
-- 'unknown' the next time Shopify fired a customer update. Live evidence: Afshaan's own
-- email/marketing opted_in (2026-06-30) was overridden by an 'unknown' row on
-- 2026-07-16, causing no_consent send-skips.
--
-- POLICY: an incoming 'unknown' row is appended ONLY when the profile has no prior
-- KNOWN row (state IN ('opted_in','opted_out')) for that (profile_id, channel, purpose).
-- A known state may ALWAYS write — a real withdrawal arrives as 'opted_out', never
-- 'unknown' (see src/optout.js applyOptOut, which rejects any other state), so
-- withdrawals are unaffected. unknown-over-unknown is deliberately NOT specially
-- handled here beyond the existing dedup EXISTS-check in the loop below (which already
-- collapses an identical repeat row) — the only invariant enforced is that 'unknown'
-- can never become the latest row ABOVE a known one.
--
-- This is the ONLY place comms.consent gets bulk-written from Shopify (both the
-- customers/* webhook path AND the backfill call comms.shopify_apply_customers via
-- src/shopify.js applyMapped/applyNodes), so this one function-body fix protects BOTH
-- call sites identically — there is no separate backfill code path to patch.
--
-- Base: copied from 0010_comms_shopify_apply_customers.sql (grepped the full migrations/
-- folder — no later migration redefines comms.shopify_apply_customers, so 0010 is the
-- current live definition being replaced here).
CREATE OR REPLACE FUNCTION comms.shopify_apply_customers(p_customers jsonb)
RETURNS TABLE(profiles_touched integer, consent_rows integer)
LANGUAGE plpgsql
AS $$
DECLARE
  c jsonb; cr jsonb; v_pid uuid; v_at timestamptz; v_known_exists boolean;
  v_prof integer := 0; v_con integer := 0;
BEGIN
  FOR c IN SELECT * FROM jsonb_array_elements(p_customers) LOOP
    v_pid := comms.resolve_identity(c->'identifiers', 'shopify');
    UPDATE comms.profiles SET
      display_name = COALESCE(NULLIF(c->>'display_name',''), display_name),
      city         = COALESCE(NULLIF(c->>'city',''), city),
      locale       = COALESCE(NULLIF(c->>'locale',''), locale),
      attributes   = attributes || COALESCE(c->'attributes', '{}'::jsonb),
      updated_at   = now()
    WHERE id = v_pid;
    v_prof := v_prof + 1;

    IF c ? 'consent' THEN
      FOR cr IN SELECT * FROM jsonb_array_elements(c->'consent') LOOP
        v_at := COALESCE((cr->>'captured_at')::timestamptz, now());

        -- GUARD: an 'unknown' row is skipped outright if a KNOWN row already exists
        -- for this (profile, channel, purpose) — regardless of timestamps, since the
        -- ledger is latest-wins by insertion, not by captured_at ordering.
        IF cr->>'state' = 'unknown' THEN
          SELECT EXISTS (
            SELECT 1 FROM comms.consent x
            WHERE x.profile_id = v_pid AND x.channel = cr->>'channel'
              AND x.purpose = cr->>'purpose' AND x.state IN ('opted_in','opted_out')
          ) INTO v_known_exists;
          IF v_known_exists THEN
            CONTINUE;
          END IF;
        END IF;

        INSERT INTO comms.consent(profile_id, channel, purpose, state, source, captured_at)
        SELECT v_pid, cr->>'channel', cr->>'purpose', cr->>'state', cr->>'source', v_at
        WHERE NOT EXISTS (
          SELECT 1 FROM comms.consent x
          WHERE x.profile_id = v_pid AND x.channel = cr->>'channel'
            AND x.purpose = cr->>'purpose' AND x.state = cr->>'state'
            AND x.source = cr->>'source' AND x.captured_at = v_at);
        IF FOUND THEN v_con := v_con + 1; END IF;
      END LOOP;
    END IF;
  END LOOP;
  profiles_touched := v_prof; consent_rows := v_con; RETURN NEXT;
END $$;

GRANT EXECUTE ON FUNCTION comms.shopify_apply_customers(jsonb) TO service_role;

-- ── Manual verification SQL (run AFTER apply_migration, controller only) ──────────────
-- Case 1: unknown over known -> row count for that (profile,channel,purpose) unchanged.
--   SELECT count(*) FROM comms.consent WHERE profile_id = '<pid>' AND channel = 'email'
--     AND purpose = 'marketing';               -- note count, e.g. N
--   SELECT * FROM comms.shopify_apply_customers(
--     '[{"identifiers":[{"type":"email","value":"<known-opted-in-email>","is_verified":true}],
--        "consent":[{"channel":"email","purpose":"marketing","state":"unknown","source":"shopify_webhook"}]}]'::jsonb);
--   SELECT count(*) FROM comms.consent WHERE profile_id = '<pid>' AND channel = 'email'
--     AND purpose = 'marketing';               -- must still be N (no new row)
--   SELECT state FROM comms.consent WHERE profile_id = '<pid>' AND channel = 'email'
--     AND purpose = 'marketing' ORDER BY captured_at DESC, id DESC LIMIT 1;  -- must still be opted_in
--
-- Case 2: unknown, fresh profile with no prior consent row -> row appears.
--   SELECT * FROM comms.shopify_apply_customers(
--     '[{"identifiers":[{"type":"email","value":"<brand-new-email>","is_verified":true}],
--        "consent":[{"channel":"email","purpose":"marketing","state":"unknown","source":"shopify_webhook"}]}]'::jsonb);
--   -- consent_rows returned = 1; SELECT * FROM comms.consent WHERE ... shows the unknown row.
--
-- Case 3: known over unknown -> row appears (known state always writes).
--   SELECT * FROM comms.shopify_apply_customers(
--     '[{"identifiers":[{"type":"email","value":"<email-with-unknown-latest>","is_verified":true}],
--        "consent":[{"channel":"email","purpose":"marketing","state":"opted_out","source":"shopify_webhook"}]}]'::jsonb);
--   -- consent_rows returned = 1; latest state for that profile/channel/purpose is now opted_out.
