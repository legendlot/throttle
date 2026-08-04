-- 0039 — comms.links: the Phase-B first-party redirect table.
-- Applied to lot-production 2026-08-04 as `comms_links_phase_b`.
--
-- WHY. Two things Phase A (utm tagging in message CONTENT) structurally cannot do:
--   1. WhatsApp URL BUTTONS. The button's base URL is frozen when Meta APPROVES the template and
--      the template variable is only a suffix appended to it, so there is no send-time hook to
--      rewrite the resolved link. send.js therefore excludes button parameters entirely.
--   2. CLICK tracking on any non-email channel. `link_clicked` has 0 events EVER — email gets
--      clicks natively from Resend's webhook; WhatsApp and SMS have no equivalent, because
--      nothing we own sits between the customer's tap and the destination.
-- Both reduce to one missing primitive: a link we own and can resolve per recipient.
--
-- MEASURED 2026-08-04, and stronger than the spec assumed: four ACTIVE marketing templates
-- (Abandoned Cart v3, ABC2 10 hours, Cart abandonment 2_v1_10hrs, Cart ABC 1) have the approved
-- base `https://checkout.shopflo.co/stable/{{1}}` — a THIRD-PARTY host. `appendUtm` refuses
-- non-LOT hosts, so for LOT's highest-volume marketing templates the redirect is not an
-- improvement on Phase A, it is the only mechanism that can ever attribute them.
--
-- THE CODE IS A CAPABILITY, NOT AN ID. It maps to one customer's cart or order. It is random
-- (22 chars base62, rejection-sampled — never sequential, never derived from a message/profile
-- id), it expires, and no personal data goes in the path. An enumerable code would leak one
-- customer's context to anyone who guesses it.
--
-- OFF BY DEFAULT. `comms.settings.link_base_url` is NULL until the short host exists, and NULL
-- is the feature's off switch: no host means no minting and every button behaves exactly as it
-- does today. Turning it on is one UPDATE, not a deploy.

CREATE TABLE IF NOT EXISTS comms.links (
  code             text PRIMARY KEY,
  target_url       text NOT NULL,
  utm              jsonb,
  message_id       uuid,
  profile_id       uuid,
  channel          text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz,
  click_count      integer NOT NULL DEFAULT 0,
  first_clicked_at timestamptz
);

-- Deliberately NO foreign keys to messages/profiles. A link is minted mid-send and must outlive
-- retention pruning of either side; a cascade here would silently delete click history, and a
-- restrict would fail a prune. The ids are recorded for attribution, not for integrity.

CREATE INDEX IF NOT EXISTS links_message_idx ON comms.links (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS links_profile_idx ON comms.links (profile_id) WHERE profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS links_expires_idx ON comms.links (expires_at);

COMMENT ON TABLE comms.links IS
  'Phase-B first-party redirect targets. https://<link_base_url>/r/<code> -> 302 -> target_url with utm appended. One row per (message, button). Resolved by the PUBLIC GET /r/:code route on commsops.';
COMMENT ON COLUMN comms.links.code IS
  'Unguessable capability, 22 chars base62 from crypto.getRandomValues with rejection sampling. NEVER make this sequential or derive it from an id — it maps to one customer''s cart/order and would then be enumerable.';
COMMENT ON COLUMN comms.links.target_url IS
  'The real destination, composed at send time as button.target_base + resolved suffix token. Frequently a THIRD-PARTY host (checkout.shopflo.co, carrier tracking) — those are redirected pristine, without utm, since appendUtm is host-scoped and tagging someone else''s URL reaches no GA4 property of ours.';
COMMENT ON COLUMN comms.links.expires_at IS
  'Bounds the capability, not the offer — cart links are stale long before this. Default 30d at mint. An expired code 302s to legendoftoys.com, never to an error page.';
COMMENT ON COLUMN comms.links.click_count IS
  'Counted clicks only. HEAD requests, known bot/preview user-agents and hits landing within 1s of send are excluded — WhatsApp/Slack/mail-client prefetch would otherwise inflate CTR until the number is useless. A filtered hit still redirects.';

-- The short host, e.g. 'https://go.legendoftoys.com'. NULL = feature off (see header).
ALTER TABLE comms.settings ADD COLUMN IF NOT EXISTS link_base_url text;
COMMENT ON COLUMN comms.settings.link_base_url IS
  'Origin of the first-party redirect, no trailing slash, e.g. https://go.legendoftoys.com. NULL disables Phase-B minting entirely (buttons behave as before). Must be a host LOT controls end to end — never a third-party shortener, which would put an outside party between LOT and its customers and break the attribution this exists to provide.';

-- RLS on at creation, service_role only (RULE-RLS-001). The worker is service_role/BYPASSRLS;
-- nothing else may read a table of live capability tokens. Note the PUBLIC /r/:code route reads
-- through the worker, not through PostgREST-as-anon.
ALTER TABLE comms.links ENABLE ROW LEVEL SECURITY;
GRANT ALL ON comms.links TO service_role;

-- A table created in an ALREADY-exposed schema is invisible to PostgREST until the cache
-- reloads, and it fails SILENTLY — reads and inserts come back not-found with no error anywhere
-- (CORE.md; cost a live debugging round in S239 with comms.variant_images).
NOTIFY pgrst, 'reload schema';
