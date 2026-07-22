-- comms_cron_lock_v1 — single-flight lease for runScheduled (review M4).
-- A tick claims this column via conditional PATCH before doing any sweep work; an overlapping
-- tick (a prior run still in flight) fails the claim and exits. 4-min lease < 5-min cron cadence,
-- so a crashed tick's lock expires before the next tick — no unlock write needed.
ALTER TABLE comms.settings ADD COLUMN IF NOT EXISTS cron_lock_at timestamptz;
