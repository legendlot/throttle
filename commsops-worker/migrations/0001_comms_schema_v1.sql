-- Relay comms schema — v1 full skeleton (substrate + delivery + orchestration).
-- RLS-on, service_role-only (RULE-RLS-001). Commsops worker is the only client.
-- Applied 2026-06-25 (S170) via Supabase apply_migration.
CREATE SCHEMA IF NOT EXISTS comms;

-- ── SUBSTRATE ──────────────────────────────────────────────────────────────
CREATE TABLE comms.profiles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name  text,
  locale        text,
  city          text,
  attributes    jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE comms.identifiers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id   uuid NOT NULL REFERENCES comms.profiles(id) ON DELETE CASCADE,
  type         text NOT NULL,
  value        text NOT NULL,
  is_verified  boolean NOT NULL DEFAULT false,
  source       text,
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identifiers_type_value_uniq UNIQUE (type, value)
);
CREATE INDEX identifiers_profile_idx ON comms.identifiers(profile_id);

CREATE TABLE comms.profile_merges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  survivor_id  uuid NOT NULL REFERENCES comms.profiles(id),
  merged_id    uuid NOT NULL,
  merged_at    timestamptz NOT NULL DEFAULT now(),
  merged_by    text,
  reason       text,
  snapshot     jsonb
);

CREATE TABLE comms.events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id      uuid REFERENCES comms.profiles(id) ON DELETE CASCADE,
  name            text NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  properties      jsonb NOT NULL DEFAULT '{}',
  source          text,
  idempotency_key text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT events_idempotency_uniq UNIQUE (idempotency_key)
);
CREATE INDEX events_profile_name_idx ON comms.events(profile_id, name, occurred_at DESC);
CREATE INDEX events_name_time_idx ON comms.events(name, occurred_at DESC);

CREATE TABLE comms.event_definitions (
  name           text PRIMARY KEY,
  description    text,
  expected_props jsonb NOT NULL DEFAULT '{}',
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE comms.consent (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id        uuid NOT NULL REFERENCES comms.profiles(id) ON DELETE CASCADE,
  channel           text NOT NULL,
  purpose           text NOT NULL,
  state             text NOT NULL,
  source            text,
  captured_at       timestamptz NOT NULL DEFAULT now(),
  evidence          jsonb,
  unsubscribe_token text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consent_lookup_idx ON comms.consent(profile_id, channel, purpose, captured_at DESC);
CREATE INDEX consent_token_idx ON comms.consent(unsubscribe_token);

CREATE TABLE comms.suppressions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel     text NOT NULL,
  value       text,
  profile_id  uuid REFERENCES comms.profiles(id) ON DELETE SET NULL,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT suppressions_channel_value_uniq UNIQUE (channel, value)
);

-- ── AUDIENCE ───────────────────────────────────────────────────────────────
CREATE TABLE comms.segments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  kind        text NOT NULL,
  definition  jsonb NOT NULL DEFAULT '{}',
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE comms.segment_members (
  segment_id  uuid NOT NULL REFERENCES comms.segments(id) ON DELETE CASCADE,
  profile_id  uuid NOT NULL REFERENCES comms.profiles(id) ON DELETE CASCADE,
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (segment_id, profile_id)
);

-- ── DELIVERY ───────────────────────────────────────────────────────────────
CREATE TABLE comms.sender_identities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel         text NOT NULL,
  address         text,
  purpose         text,
  provider        text,
  status          text NOT NULL DEFAULT 'inactive',
  credentials_ref text,
  metadata        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE comms.templates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel             text NOT NULL,
  name                text NOT NULL,
  purpose             text NOT NULL,
  language            text NOT NULL DEFAULT 'en',
  status              text NOT NULL DEFAULT 'draft',
  version             integer NOT NULL DEFAULT 1,
  provider_template_id text,
  approval_status     text,
  content             jsonb NOT NULL DEFAULT '{}',
  variables           jsonb NOT NULL DEFAULT '[]',
  created_by          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX templates_channel_status_idx ON comms.templates(channel, status);

CREATE TABLE comms.messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id          uuid REFERENCES comms.profiles(id) ON DELETE SET NULL,
  channel             text NOT NULL,
  purpose             text NOT NULL,
  sender_identity_id  uuid REFERENCES comms.sender_identities(id),
  template_id         uuid REFERENCES comms.templates(id),
  template_version    integer,
  source              text,
  provider            text,
  provider_message_id text,
  status              text NOT NULL,
  provider_status     text,
  reason              text,
  cost                numeric,
  dedup_key           text,
  to_address          text,
  queued_at           timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  delivered_at        timestamptz,
  read_at             timestamptz,
  CONSTRAINT messages_dedup_uniq UNIQUE (dedup_key)
);
CREATE INDEX messages_profile_idx ON comms.messages(profile_id, queued_at DESC);
CREATE INDEX messages_source_idx ON comms.messages(source);
CREATE INDEX messages_provider_msg_idx ON comms.messages(provider, provider_message_id);

-- ── ORCHESTRATION ──────────────────────────────────────────────────────────
CREATE TABLE comms.campaigns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  channel       text NOT NULL,
  purpose       text NOT NULL,
  segment_id    uuid REFERENCES comms.segments(id),
  template_id   uuid REFERENCES comms.templates(id),
  template_version integer,
  vars          jsonb NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'draft',
  scheduled_at  timestamptz,
  created_by    text,
  approved_by   text,
  sent_by       text,
  reject_reason text,
  audience_snapshot integer,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE comms.journeys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  status          text NOT NULL DEFAULT 'draft',
  active_version  integer,
  trigger         jsonb NOT NULL DEFAULT '{}',
  reenrolment     text NOT NULL DEFAULT 'once_while_active',
  reenrol_cooldown_hours integer,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE comms.journey_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journey_id  uuid NOT NULL REFERENCES comms.journeys(id) ON DELETE CASCADE,
  version     integer NOT NULL,
  definition  jsonb NOT NULL,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT journey_version_uniq UNIQUE (journey_id, version)
);

CREATE TABLE comms.enrolments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journey_id      uuid NOT NULL REFERENCES comms.journeys(id),
  journey_version integer NOT NULL,
  profile_id      uuid NOT NULL REFERENCES comms.profiles(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'active',
  current_step    text,
  context         jsonb NOT NULL DEFAULT '{}',
  enrolled_at     timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz
);
CREATE INDEX enrolments_journey_idx ON comms.enrolments(journey_id, status);
CREATE INDEX enrolments_profile_idx ON comms.enrolments(profile_id);

CREATE TABLE comms.enrolment_steps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrolment_id  uuid NOT NULL REFERENCES comms.enrolments(id) ON DELETE CASCADE,
  step_id       text NOT NULL,
  step_type     text NOT NULL,
  entered_at    timestamptz NOT NULL DEFAULT now(),
  result        jsonb
);
CREATE INDEX enrolment_steps_enrolment_idx ON comms.enrolment_steps(enrolment_id, entered_at);

CREATE TABLE comms.settings (
  id                          smallint PRIMARY KEY DEFAULT 1,
  approval_required_marketing boolean NOT NULL DEFAULT true,
  approval_audience_threshold integer NOT NULL DEFAULT 500,
  frequency_cap_per_day       integer NOT NULL DEFAULT 3,
  frequency_cap_window_hours  integer NOT NULL DEFAULT 24,
  quiet_hours_start           smallint NOT NULL DEFAULT 21,
  quiet_hours_end             smallint NOT NULL DEFAULT 9,
  attribution_window_days     integer NOT NULL DEFAULT 7,
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT comms_settings_singleton CHECK (id = 1)
);

-- ── RLS + grants (service_role only; no policies = locked) ────────────────────
ALTER TABLE comms.profiles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.identifiers       ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.profile_merges    ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.events            ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.event_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.consent           ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.suppressions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.segments          ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.segment_members   ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.sender_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.templates         ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.messages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.campaigns         ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.journeys          ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.journey_versions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.enrolments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.enrolment_steps   ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.settings          ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA comms TO service_role;
GRANT ALL ON ALL TABLES    IN SCHEMA comms TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA comms TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA comms TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA comms GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA comms GRANT ALL ON SEQUENCES TO service_role;

NOTIFY pgrst, 'reload schema';
