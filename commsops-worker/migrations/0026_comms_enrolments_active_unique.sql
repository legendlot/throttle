-- comms_enrolments_active_unique_v1 — race-proof once_while_active (review H12).
CREATE UNIQUE INDEX IF NOT EXISTS enrolments_one_active_per_journey_profile
  ON comms.enrolments (journey_id, profile_id) WHERE status = 'active';
