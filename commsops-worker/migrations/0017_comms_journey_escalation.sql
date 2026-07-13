-- J1 (journey escalation). The wait-index: an incoming event for a profile finds
-- every parked enrolment awaiting it WITHOUT scanning. instance_id == enrolment id
-- (see enrol()). kind='response' rows are written on entering a wait_response step;
-- kind='exit' rows are written once at boot per journey exit-rule. 'expired' does NOT
-- need a row (the sweeper has the enrolment id directly). Rows are deleted on
-- transition / terminate; the */5 cron sweeps expired orphans.
CREATE TABLE IF NOT EXISTS comms.enrolment_waits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrolment_id  uuid NOT NULL REFERENCES comms.enrolments(id) ON DELETE CASCADE,
  instance_id   text NOT NULL,                       -- Workflow instance id (== enrolment id)
  profile_id    uuid NOT NULL REFERENCES comms.profiles(id) ON DELETE CASCADE,
  awaited_event text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('response','exit')),
  outcome       text,                                -- exit rules only: the outcome label to terminate with
  step_id       text,                                -- response rows: the wait_response step that parked (diagnostics)
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- The hot lookup path: (profile, event) → parked instances. O(log n).
CREATE INDEX IF NOT EXISTS enrolment_waits_match_idx
  ON comms.enrolment_waits (profile_id, awaited_event);
-- Cleanup path: the sweeper deletes rows past expiry.
CREATE INDEX IF NOT EXISTS enrolment_waits_expiry_idx
  ON comms.enrolment_waits (expires_at);
-- One row per (enrolment, awaited_event, kind) — re-entering a step upserts, never duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS enrolment_waits_uniq
  ON comms.enrolment_waits (enrolment_id, awaited_event, kind);

ALTER TABLE comms.enrolment_waits ENABLE ROW LEVEL SECURITY;
GRANT ALL ON comms.enrolment_waits TO service_role;

-- Journey-level escalation config (additive; existing rows default correctly).
-- exit_rules: [{event, filter?, outcome}] — ambient (fire while parked in ANY wait).
-- max_duration: hard lifetime cap; the sweeper auto-exits enrolments older than this.
ALTER TABLE comms.journeys ADD COLUMN IF NOT EXISTS exit_rules   jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE comms.journeys ADD COLUMN IF NOT EXISTS max_duration text  NOT NULL DEFAULT '30 days';
