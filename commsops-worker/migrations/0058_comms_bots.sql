-- 0058 — Bot builder: scripted decision-tree bots (spec 2026-08-26-bot-builder-design.md).
-- Separate from journeys/enrolments ON PURPOSE: enrolments.profile_id is NOT NULL (web
-- visitors are anonymous until collect), and journey re-enrolment/dedup semantics are wrong
-- for chat (five sessions a day is legitimate). Shared step VOCABULARY, separate tables.

CREATE TABLE comms.bots (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused')),
  channel        text NOT NULL DEFAULT 'web' CHECK (channel IN ('web')),
  active_version integer,
  draft_definition jsonb NOT NULL DEFAULT '{}'::jsonb,
  config         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- widget copy, offhours message
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Immutable once written (same rule as journey_versions): a running session is pinned to
-- the version it started on; editing a live bot never rewrites a conversation mid-flight.
CREATE TABLE comms.bot_versions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id     uuid NOT NULL REFERENCES comms.bots(id),
  version    integer NOT NULL,
  definition jsonb NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bot_id, version)
);

CREATE TABLE comms.bot_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id           uuid NOT NULL REFERENCES comms.bots(id),
  bot_version      integer NOT NULL,
  profile_id       uuid,                          -- NULLABLE: anonymous until collect resolves one
  visitor_key      text NOT NULL,
  thread_id        uuid,                          -- loose ref -> store.cs_wa_threads.id (ignition.connects precedent; no FK)
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','handed_off','ended')),
  current_step     text,
  context          jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at       timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz
);
CREATE INDEX bot_sessions_bot_started_idx ON comms.bot_sessions (bot_id, started_at DESC);
CREATE INDEX bot_sessions_visitor_idx     ON comms.bot_sessions (visitor_key, started_at DESC);

-- Append-only. THE analytics substrate: handled/drop-off/handoff/conversion derive from
-- here, never from a separate counter that can drift. Also carries agent replies after
-- handoff (step_type='agent_reply') so /web/poll has one ordered stream to read.
CREATE TABLE comms.bot_session_steps (
  id         bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES comms.bot_sessions(id),
  step_id    text NOT NULL,
  step_type  text NOT NULL,
  entered_at timestamptz NOT NULL DEFAULT now(),
  result     jsonb
);
CREATE INDEX bot_session_steps_session_idx ON comms.bot_session_steps (session_id, id);

ALTER TABLE comms.bots              ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.bot_versions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.bot_sessions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.bot_session_steps ENABLE ROW LEVEL SECURITY;
GRANT ALL ON comms.bots, comms.bot_versions, comms.bot_sessions, comms.bot_session_steps TO service_role;
GRANT USAGE, SELECT ON SEQUENCE comms.bot_session_steps_id_seq TO service_role;

NOTIFY pgrst, 'reload schema';
