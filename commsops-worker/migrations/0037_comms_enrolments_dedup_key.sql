-- 0037 — enrolment uniqueness keys on the TRIGGERING ENTITY, not the profile.
-- Applied to lot-production 2026-07-30 as `comms_enrolments_dedup_key_per_trigger`.
--
-- WHY. `comms.journeys.reenrolment='always'` (COD -> Prepaid / C2P is the only journey on it) had
-- never once taken effect. The old partial unique index
--     (journey_id, profile_id) WHERE status='active'
-- enforced one active enrolment per profile per journey REGARDLESS of policy, so C2P behaved as
-- once_while_active for its entire life: a customer's 2nd COD order placed while the 1st enrolment
-- was still open was refused, and silently stayed COD with no confirm/cancel/pay ask. enrol() skips
-- the dedup read for 'always', so the insert hit 23505 -> threw -> queue retried x3 -> dead-letter
-- -> comms.queue_failures + a #relay-alerts page. Measured 3 of 99 C2P enrolments in 24h.
--
-- DESIGN. dedup_key is worker-computed per policy (commsops journeys.js enrol()):
--   every policy except 'always' -> the constant 'one_active'  (behaviour byte-identical to before,
--                                   so all 12 other journeys are unchanged by construction)
--   'always'                     -> 'evt:<trigger_event_id>', or a random 'uniq:<uuid>' when there
--                                   is no event id. The fallback must be UNIQUE, never a shared
--                                   constant, or the same refusal comes straight back.
-- A same-key replay (re-delivered webhook) still collides -> 23505 -> handled as a clean skip in
-- enrol(), so idempotency is preserved rather than traded away.
--
-- Deliberately NOT a unique index on the context->>'trigger_event_id' expression: that form weakens
-- the backstop for the other 12 journeys (two different events racing would both insert) and lets
-- NULL trigger ids multiply freely.
--
-- ORDERING. This migration is INERT on its own — the DEFAULT reproduces current behaviour until the
-- worker starts sending the column — so migration-then-deploy is safe at every intermediate point.
-- The reverse order fails EVERY enrolment insert fleet-wide.
-- ⚠️ A new COLUMN is invisible to PostgREST until the schema cache reloads (CORE.md documents this
-- for tables; it applies to columns too). NOTIFY at the end, or the worker 404s the column.

ALTER TABLE comms.enrolments
  ADD COLUMN IF NOT EXISTS dedup_key text NOT NULL DEFAULT 'one_active';

-- Safe to swap in one transaction: every existing active row takes the constant, and the old index
-- already guaranteed those are unique on (journey_id, profile_id), so the 3-column index cannot
-- fail to build.
DROP INDEX IF EXISTS comms.enrolments_one_active_per_journey_profile;

CREATE UNIQUE INDEX IF NOT EXISTS enrolments_one_active_per_journey_profile_dedup
  ON comms.enrolments (journey_id, profile_id, dedup_key) WHERE (status = 'active');

COMMENT ON COLUMN comms.enrolments.dedup_key IS
  'Concurrency key for the one-active-enrolment unique index. ''one_active'' (the default) = one active enrolment per journey+profile, the behaviour for every reenrolment policy except ''always''. For ''always'', the worker sets ''evt:<trigger_event_id>'' so each triggering entity (e.g. each COD order on C2P) gets its own enrolment while still blocking a replayed webhook carrying the same event id.';

NOTIFY pgrst, 'reload schema';
