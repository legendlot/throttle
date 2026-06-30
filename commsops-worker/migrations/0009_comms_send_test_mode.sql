-- 0009_comms_send_test_mode — global TEST MODE for the Relay send path.
-- Default ON (fail-safe): until a super-admin explicitly turns it off, the central
-- send gate (runGate step 0) blocks any send to an address not on the allowlist, so
-- Relay can never reach a real customer before sign-off. Allowlist entries starting
-- with '@' are domain-suffix matches; others are exact email addresses.
-- Applied to lot-production via Supabase apply_migration as comms_send_test_mode_v1.

ALTER TABLE comms.settings
  ADD COLUMN IF NOT EXISTS test_mode boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS test_mode_allow jsonb NOT NULL DEFAULT '["@legendoftoys.com"]'::jsonb;

UPDATE comms.settings
  SET test_mode = true,
      test_mode_allow = COALESCE(NULLIF(test_mode_allow, '[]'::jsonb), '["@legendoftoys.com"]'::jsonb)
  WHERE id = 1;
