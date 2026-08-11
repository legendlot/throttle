-- 0050 — A/B testing: variant arms, the experiment record, and the per-message stamp (S272, 2026-08-11)
--
-- campaign_experiments is keyed on campaign_id itself (no surrogate id) because there is exactly
-- one experiment per campaign — the campaign id IS the natural key, so a surrogate would be a
-- redundant second identity for the same row and every read would carry a needless join key.
-- (NB it is NOT about strictness: a surrogate id plus UNIQUE(campaign_id) would enforce the 1:1
-- exactly as well — Postgres implements PRIMARY KEY and UNIQUE with the same b-tree.)

CREATE TABLE IF NOT EXISTS comms.campaign_variants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid NOT NULL REFERENCES comms.campaigns(id) ON DELETE CASCADE,
  label        text NOT NULL,
  template_id  uuid NULL REFERENCES comms.templates(id),   -- NULL = holdout arm (future)
  weight       int  NOT NULL DEFAULT 50 CHECK (weight > 0),
  sort_order   int  NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_variants_campaign_label_uniq UNIQUE (campaign_id, label)
);
CREATE INDEX IF NOT EXISTS campaign_variants_campaign_idx ON comms.campaign_variants(campaign_id);

CREATE TABLE IF NOT EXISTS comms.campaign_experiments (
  campaign_id      uuid PRIMARY KEY REFERENCES comms.campaigns(id) ON DELETE CASCADE,
  hypothesis       text NULL,
  planned_read_at  timestamptz NULL,
  learning         text NULL,
  verdict_snapshot jsonb NULL,
  decided_at       timestamptz NULL,
  decided_by       uuid NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ON DELETE NO ACTION matches messages_template_id_fkey / messages_sender_identity_id_fkey.
-- It deliberately collides with the CASCADE above: deleting a campaign that has sent messages is
-- blocked, which is correct. index.js must catch the 23503 and name it (a later task).
ALTER TABLE comms.messages
  ADD COLUMN IF NOT EXISTS variant_id uuid NULL REFERENCES comms.campaign_variants(id);
CREATE INDEX IF NOT EXISTS messages_variant_idx ON comms.messages(variant_id) WHERE variant_id IS NOT NULL;

ALTER TABLE comms.campaign_variants    ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.campaign_experiments ENABLE ROW LEVEL SECURITY;
GRANT ALL ON comms.campaign_variants    TO service_role;
GRANT ALL ON comms.campaign_experiments TO service_role;

COMMENT ON TABLE comms.campaign_variants IS
  'A/B arms for a campaign. No rows = a normal single-version campaign. Two or more rows = a test; arm A always mirrors campaigns.template_id.';
COMMENT ON COLUMN comms.campaign_variants.template_id IS
  'NULL = holdout arm (send nothing). Seam only - nothing reads it yet.';
COMMENT ON COLUMN comms.campaign_variants.weight IS
  'RELATIVE weight, not a percentage. Buckets are weight/SUM(weight); no constraint forces the set to total 100.';
COMMENT ON TABLE comms.campaign_experiments IS
  'One row per A/B campaign: the hypothesis, the pre-committed read time, the recorded learning, and a snapshot of the verdict as it stood when that learning was recorded.';
COMMENT ON COLUMN comms.campaign_experiments.verdict_snapshot IS
  'Frozen copy of the stats payload at the moment the learning was recorded. Deliberate: the live verdict is recomputed on every view, so late-arriving reads can flip it after someone acted on it.';
COMMENT ON COLUMN comms.messages.variant_id IS
  'A/B arm this message belongs to. Stamped for EVERY outcome including skipped and failed - the per-arm failure asymmetry check depends on those rows.';

-- ⚠️ REQUIRED. PostgREST caches the schema; a table created afterwards is invisible to it and
-- fails SILENTLY as a not-found (cost a debugging round in a prior session).
NOTIFY pgrst, 'reload schema';
