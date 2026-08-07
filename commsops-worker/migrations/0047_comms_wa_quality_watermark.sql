-- 0047 — watermark for the WA sender-quality pull (S266, 2026-08-07)
--
-- `quality_rating` / `messaging_limit` / `quality_updated_at` live in
-- comms.sender_identities.metadata and were NULL on every whatsapp sender, because the only
-- writer was the `phone_number_quality_update` webhook and Meta pushes that ONLY on a
-- transition. wa-quality.js adds a pull; this column throttles it to hourly off the 5-minute
-- cron (claim-then-work, same shape as `cron_lock_at`).
--
-- Additive + nullable: a NULL means "never pulled", which is what makes the first tick after
-- deploy run immediately rather than waiting out an interval.

ALTER TABLE comms.settings
  ADD COLUMN IF NOT EXISTS wa_quality_pulled_at timestamptz;

COMMENT ON COLUMN comms.settings.wa_quality_pulled_at IS
  'Last time the Meta WABA quality pull ran (wa-quality.js). Throttles the pull to hourly off the '
  '5-minute cron. NULL = never pulled.';

-- The worker reads this table through PostgREST, whose schema cache does not pick up a new
-- column until told (CORE.md: a post-CREATE cache miss fails SILENTLY as a plain not-found).
NOTIFY pgrst, 'reload schema';
