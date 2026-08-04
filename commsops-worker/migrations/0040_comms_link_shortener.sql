-- 0040 — Relay Links: the campaign/QR half of comms.links.
-- Applied to lot-production 2026-08-04 as `comms_link_shortener`.
--
-- WHY. 0039 built the redirect engine for ONE case: per-recipient WhatsApp button links, minted by
-- the send path. The mechanism it created — a link we own whose destination is decided at TAP time —
-- is worth more than that case. This adds the human-facing half: mint a link by hand, change where it
-- points afterwards, see what got clicked. The driving use is PRINTED QR CODES (packaging, box labels,
-- catalogue, print ads), where the destination must stay changeable long after the artwork is on paper
-- and cannot be recalled.
--
-- ⚠️ THE LOAD-BEARING DECISION: two KINDS on one table, with DELIBERATELY OPPOSITE RULES.
--
--                  kind='recipient' (0039)          kind='campaign' (this migration)
--   code           random 22-char base62            a slug the author chooses ('diwali26')
--   why            maps to ONE customer's cart —    carries NO personal data; deliberately
--                  guessable = leaks their context  shared with thousands of strangers
--   expires_at     30 days, always set              NULL — NEVER expires
--   target_url     fixed at mint                    editable forever, audited
--
-- DO NOT later "unify" these as duplication. Making all links slug-able and permanent would expose
-- customer cart contexts to slug-guessing; making all links expire would kill a printed QR mid-campaign.
--
-- ⚠️ A PRINTED QR MUST NEVER 404. Retiring a campaign link sets active=false, which 302s to
-- legendoftoys.com exactly like an unknown code. Rows are never deleted — the artwork is already in
-- customers' hands and will keep being scanned for years.

ALTER TABLE comms.links
  ADD COLUMN IF NOT EXISTS kind            text NOT NULL DEFAULT 'recipient',
  ADD COLUMN IF NOT EXISTS title           text,
  ADD COLUMN IF NOT EXISTS active          boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS created_by      uuid,
  ADD COLUMN IF NOT EXISTS updated_by      uuid,
  ADD COLUMN IF NOT EXISTS updated_at      timestamptz,
  ADD COLUMN IF NOT EXISTS last_clicked_at timestamptz;

-- Default 'recipient' means every row 0039 already wrote is correct with no backfill.
DO $$ BEGIN
  ALTER TABLE comms.links ADD CONSTRAINT links_kind_chk CHECK (kind IN ('recipient','campaign'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN comms.links.kind IS
  'recipient = minted per send, random code, expires, target fixed (it maps to ONE customer''s cart — guessable would leak it). campaign = author-created slug, NEVER expires, target editable forever (it is printed on packaging). The two are deliberately opposite; do not unify them.';
COMMENT ON COLUMN comms.links.active IS
  'false retires a campaign link: it 302s to the fallback like an unknown code. NEVER delete a campaign row — the printed artwork is already in customers'' hands and keeps being scanned for years.';
COMMENT ON COLUMN comms.links.title IS
  'Human label for the Links UI ("Diwali 2026 catalogue insert"). Campaign links only; a recipient link is identified by its message.';

CREATE INDEX IF NOT EXISTS links_kind_created_idx ON comms.links (kind, created_at DESC);

-- Append-only audit of destination edits. An editable redirect is something a person could repoint at
-- anywhere; this is what makes that attributable and recoverable. Target edits ONLY — title/active
-- changes are cosmetic and not worth the noise.
CREATE TABLE IF NOT EXISTS comms.link_changes (
  id              bigserial PRIMARY KEY,
  code            text NOT NULL,
  old_target_url  text,
  new_target_url  text NOT NULL,
  reason          text,
  changed_by      uuid,
  changed_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS link_changes_code_idx ON comms.link_changes (code, changed_at DESC);
COMMENT ON TABLE comms.link_changes IS
  'Append-only log of comms.links.target_url edits. Never updated or deleted — it answers "where did this printed QR point in March?", which is unanswerable from the row itself.';

-- Bounded daily rollup. click_count alone cannot draw a chart, and a row-per-click table on a printed
-- QR is unbounded. Campaign links have no profile_id, so they emit NO link_clicked event (that event
-- is profile-scoped by design) — this rollup is their entire analytics story.
CREATE TABLE IF NOT EXISTS comms.link_click_daily (
  code   text NOT NULL,
  day    date NOT NULL,
  clicks integer NOT NULL DEFAULT 0,
  PRIMARY KEY (code, day)
);
COMMENT ON TABLE comms.link_click_daily IS
  'Counted clicks per link per IST day. Counted = the same prefetch filter as click_count (HEAD, bot UAs and sub-second hits excluded) — a QR on packaging is scanned by crawlers too.';

-- Atomic upsert. A plain read-modify-write would lose concurrent clicks, which on a printed QR is the
-- normal case rather than the edge one.
CREATE OR REPLACE FUNCTION comms.bump_link_click(p_code text, p_day date)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = comms, public AS $$
  INSERT INTO comms.link_click_daily (code, day, clicks) VALUES (p_code, p_day, 1)
  ON CONFLICT (code, day) DO UPDATE SET clicks = comms.link_click_daily.clicks + 1;
$$;

ALTER TABLE comms.link_changes     ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms.link_click_daily ENABLE ROW LEVEL SECURITY;
GRANT ALL ON comms.link_changes     TO service_role;
GRANT ALL ON comms.link_click_daily TO service_role;
GRANT USAGE, SELECT ON SEQUENCE comms.link_changes_id_seq TO service_role;
GRANT EXECUTE ON FUNCTION comms.bump_link_click(text, date) TO service_role;

-- New tables in an already-exposed schema are invisible to PostgREST until the cache reloads, and it
-- fails SILENTLY (CORE.md; cost a live round in S239).
NOTIFY pgrst, 'reload schema';
