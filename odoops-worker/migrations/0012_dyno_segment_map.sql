-- 0012_dyno_segment_map.sql — Dyno Matrix (coverage view) V1
-- Canonicalises the ad-hoc `ads_managed.audience_segment` strings onto the fixed 4 matrix
-- columns (Kidult / Parent / Family / Gifter). Data-driven + non-destructive: the raw
-- audience_segment on each variant is untouched; the Matrix view maps raw→canonical through
-- this table at render time. Unmapped / untagged variants are surfaced as a data-hygiene
-- warning in the UI (never silently dropped). Editable without a deploy.
-- Decision (2026-07-10, Afshaan): mapping table over a canonical column (brief §6 option b).

CREATE TABLE IF NOT EXISTS sales.lab_segment_map (
  raw        text PRIMARY KEY,            -- lower-cased ads_managed.audience_segment
  canonical  text NOT NULL
               CHECK (canonical IN ('Kidult','Parent','Family','Gifter')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sales.lab_segment_map ENABLE ROW LEVEL SECURITY;
GRANT ALL ON sales.lab_segment_map TO service_role;

-- Seed the current live strings (Afshaan-approved 2026-07-10). enthusiast→Kidult (adult
-- collector) and all-neutral→Family are the two judgement calls; edit here to re-map.
INSERT INTO sales.lab_segment_map (raw, canonical) VALUES
  ('kidult',      'Kidult'),
  ('gifter',      'Gifter'),
  ('parent-kid',  'Parent'),
  ('enthusiast',  'Kidult'),
  ('all-neutral', 'Family')
ON CONFLICT (raw) DO NOTHING;
