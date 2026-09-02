-- 0059 · comms.forms + comms.form_submissions (S331) — the capture spine for embeddable
-- website forms and surveys. Sub-project 1 of 5.
-- Spec: docs/superpowers/specs/2026-09-02-relay-capture-spine-design.md
-- ⚠️ MIRROR MARKER of an applied Supabase migration — the live DB is the source of truth.

-- The form DEFINITION. Hand-seeded in SP1; written by the builder UI in SP4.
CREATE TABLE comms.forms (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                  text NOT NULL UNIQUE,
  name                  text NOT NULL,
  -- 'survey' is the seam SP5 renders differently. Nothing in SP1 branches on it yet.
  kind                  text NOT NULL DEFAULT 'form' CHECK (kind IN ('form','survey')),
  -- [{key,label,type,required,options?}] — type in text|email|tel|select|radio|checkbox|hidden
  fields                jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Field keys that, WITH identity, make a submission distinct. ['product_code'] for
  -- back-in-stock: the same person legitimately notifies on five different SKUs.
  dedupe_keys           text[] NOT NULL DEFAULT '{}',
  -- RESERVED for SP2 (which segment a submission joins). SP1 writes and reads nothing here.
  destination           jsonb,
  consent_copy          text,
  -- Versioned because it is DPDP evidence: we must be able to say what they agreed TO.
  consent_copy_version  int NOT NULL DEFAULT 1,
  -- true  = ongoing marketing enrolment -> no consent row until confirmed
  -- false = single requested alert      -> consent row written at capture
  requires_confirmation boolean NOT NULL DEFAULT false,
  -- Whether the form ACCEPTS submissions. NOT a sending switch — sending is journey activation.
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- One row per submission. THE shared response store — SP5 surveys reuse it unchanged.
CREATE TABLE comms.form_submissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id       uuid NOT NULL REFERENCES comms.forms(id),
  profile_id    uuid,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key    text,
  source_url    text,
  ip_hash       text,
  turnstile_ok  boolean NOT NULL DEFAULT false,
  confirm_token text UNIQUE,
  confirmed_at  timestamptz,
  submitted_at  timestamptz NOT NULL DEFAULT now()
);

-- UNIQUE, and deliberately NOT partial. Enforces per-(form, identity, product) dedupe in the
-- DB so two concurrent submits cannot both land.
-- ⛔ DO NOT ADD `WHERE dedupe_key IS NOT NULL`. It looks harmless and it breaks the upsert:
-- a PARTIAL index cannot be inferred by `ON CONFLICT (form_id, dedupe_key)`, which is the only
-- form PostgREST's `on_conflict=` can emit — proved 2026-09-02, it raises
-- `42P10 there is no unique or exclusion constraint matching the ON CONFLICT specification`.
-- The WHERE also buys nothing: Postgres already treats NULLs as distinct in a unique index, so
-- unlimited NULL-dedupe_key rows (surveys, forms with no dedupe_keys) are permitted either way.
CREATE UNIQUE INDEX form_submissions_dedupe_idx
  ON comms.form_submissions (form_id, dedupe_key);
CREATE INDEX form_submissions_profile_idx
  ON comms.form_submissions (profile_id, submitted_at DESC);

ALTER TABLE comms.forms            ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.form_submissions ENABLE ROW LEVEL SECURITY;
GRANT ALL ON comms.forms, comms.form_submissions TO service_role;

NOTIFY pgrst, 'reload schema';
