-- 0069 — SP3 back-in-stock: the SENDING half (S362, 2026-09-09)
--
-- The capture half has shipped since S331 (comms.forms slug `back-in-stock`), but nothing ever
-- consumed a capture, which is what gated the storefront decision. This migration adds the
-- matching layer between a capture and a restock.
--
-- ⭐ THE DETECTOR ALREADY EXISTED — DO NOT BUILD A SECOND ONE. `sales.stock_alert_outbox` has
-- been recording stock flips for Odo's Slack alerts since S289: `direction` ∈ (oos|restock),
-- `scope` ∈ (product|variant), with qty_before/qty_after and flipped_at. Measured 2026-09-09:
-- 151 variant restocks in the last 30 days across 46 product codes, newest 16:30 IST the same
-- day. So SP3's trigger is a JOIN, not a new poller, and there is no new Shopify webhook.
--
-- ⚠️ THE JOIN KEY IS THE SHOPIFY VARIANT SKU, NOT `product_code`, AND THIS IS THE ONE THING
-- MOST LIKELY TO BE GOT WRONG. `stock_alert_outbox.product_code` holds the LOT code (SHTK,
-- GHUW, FLBG); `stock_alert_outbox.sku` holds the Shopify variant SKU
-- (`shadow-tarmac-black`). A storefront theme knows its `variant.sku` and does NOT know the LOT
-- code, so the form must capture the SKU. The two live test submissions captured a Shopify
-- VARIANT ID (`47678321164340`) under a field called `product_code` — neither grain, and it
-- would have matched nothing forever while looking correct. Measured before choosing: 78 of 78
-- distinct restock SKUs in the last 30 days resolve in `sales.sku_map`, so the SKU is a sound
-- key. The form field is renamed to `variant_sku` below so the name states what the value is.
--
-- ⭐ ONE ALERT PER SIGNUP, EVER — that is the promise the capture makes. The form's own consent
-- copy reads "Tell me once when this product is back in stock", so the dedupe is UNIQUE on
-- `submission_id`, not on (flip, submission). A product that goes out and back three times
-- sends one email to a given subscriber, not three. Re-subscribing is how a customer asks again.

BEGIN;

-- ── the claim ledger ────────────────────────────────────────────────────────
-- An outbox in the same shape as the one it reads from: a row is CLAIMED first (so two cron
-- ticks can never double-send) and its event is stamped after it is emitted. A row left with
-- event_emitted_at NULL is a visible, retryable failure rather than a silently lost alert.
CREATE TABLE IF NOT EXISTS comms.restock_notifications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id    uuid NOT NULL UNIQUE REFERENCES comms.form_submissions(id) ON DELETE CASCADE,
  outbox_id        bigint NOT NULL,          -- sales.stock_alert_outbox.id; loose ref, cross-schema by design
  profile_id       uuid,
  variant_sku      text NOT NULL,
  product_code     text,
  flipped_at       timestamptz NOT NULL,
  event_emitted_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE comms.restock_notifications IS
  'SP3 — one row per back-in-stock signup that has been matched to a restock flip. UNIQUE on submission_id enforces the "tell me once" promise in the form consent copy. event_emitted_at NULL = claimed but not yet emitted (retryable).';

CREATE INDEX IF NOT EXISTS restock_notifications_pending_idx
  ON comms.restock_notifications (created_at) WHERE event_emitted_at IS NULL;

-- The submissions side of the join. Small today, grows with every signup.
CREATE INDEX IF NOT EXISTS form_submissions_variant_sku_idx
  ON comms.form_submissions ((payload->>'variant_sku'))
  WHERE payload->>'variant_sku' IS NOT NULL;

ALTER TABLE comms.restock_notifications ENABLE ROW LEVEL SECURITY;
GRANT ALL ON comms.restock_notifications TO service_role;

-- ── the claim RPC ───────────────────────────────────────────────────────────
-- SECURITY DEFINER because it reads `sales.stock_alert_outbox`, which commsops has no business
-- being granted directly — the worker gets exactly this one question answered and nothing else.
-- Claims and returns in a single statement, so two concurrent cron ticks cannot both claim a row.
CREATE OR REPLACE FUNCTION comms.claim_restock_notifications(
  p_since timestamptz DEFAULT '2026-09-09T00:00:00Z',
  p_limit int DEFAULT 200
)
RETURNS TABLE (
  notification_id uuid,
  submission_id   uuid,
  profile_id      uuid,
  variant_sku     text,
  product_code    text,
  product_title   text,
  flipped_at      timestamptz,
  qty_after       int,
  email           text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = comms, sales, public
AS $$
  WITH f AS (SELECT id FROM comms.forms WHERE slug = 'back-in-stock'),
  flips AS (
    SELECT o.id, o.sku, o.product_code, o.product_title, o.flipped_at, o.qty_after
    FROM sales.stock_alert_outbox o
    WHERE o.direction = 'restock'
      AND o.scope     = 'variant'      -- product-scope rows carry no product_code and no SKU
      AND o.sku IS NOT NULL
      AND o.qty_after > 0
      AND o.flipped_at >= p_since      -- floor: never mail anyone about a historical flip
  ),
  -- DISTINCT ON picks the FIRST restock after the customer asked, so a backlog of flips
  -- collapses to the one that actually answered their request.
  matches AS (
    SELECT DISTINCT ON (s.id)
           s.id AS submission_id, s.profile_id, fl.id AS outbox_id,
           fl.sku, fl.product_code, fl.product_title, fl.flipped_at, fl.qty_after,
           s.payload->>'email' AS email
    FROM flips fl
    JOIN comms.form_submissions s
      ON s.form_id = (SELECT id FROM f)
     AND s.payload->>'variant_sku' = fl.sku
     AND s.submitted_at < fl.flipped_at
    WHERE NOT EXISTS (
      SELECT 1 FROM comms.restock_notifications n WHERE n.submission_id = s.id
    )
    ORDER BY s.id, fl.flipped_at
  ),
  capped AS (SELECT * FROM matches ORDER BY flipped_at LIMIT p_limit),
  ins AS (
    INSERT INTO comms.restock_notifications
      (submission_id, outbox_id, profile_id, variant_sku, product_code, flipped_at)
    SELECT submission_id, outbox_id, profile_id, sku, product_code, flipped_at FROM capped
    ON CONFLICT (submission_id) DO NOTHING
    RETURNING id, submission_id, profile_id, variant_sku, product_code, flipped_at
  )
  SELECT i.id, i.submission_id, i.profile_id, i.variant_sku, i.product_code,
         c.product_title, i.flipped_at, c.qty_after, c.email
  FROM ins i JOIN capped c ON c.submission_id = i.submission_id;
$$;

REVOKE ALL ON FUNCTION comms.claim_restock_notifications(timestamptz, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION comms.claim_restock_notifications(timestamptz, int) TO service_role;

-- ── the form now captures the SKU, and says so ──────────────────────────────
-- Renaming the key is what makes the join honest. The two existing submissions are tests
-- carrying Shopify variant IDs; they will not match anything, which is correct.
UPDATE comms.forms
SET fields = '[
      {"key":"variant_sku","type":"hidden","label":"Product","required":true},
      {"key":"email","type":"email","label":"Email address","required":true},
      {"key":"phone","type":"tel","label":"WhatsApp number","required":false}
    ]'::jsonb,
    dedupe_keys = ARRAY['variant_sku'],
    updated_at  = now()
WHERE slug = 'back-in-stock';

-- Advisory only (ingest never gates on it) but it is how a human finds out the event exists.
INSERT INTO comms.event_definitions (name, description, expected_props, is_active, category)
VALUES (
  'back_in_stock',
  'A variant a customer asked to be told about is available again. Emitted by the commsops cron from sales.stock_alert_outbox; one per signup, ever.',
  '{"variant_sku":"shopify variant sku","product_code":"LOT code","product_title":"display name","qty_after":"int","flipped_at":"timestamptz","notification_id":"uuid"}'::jsonb,
  true,
  'catalog'
)
ON CONFLICT (name) DO NOTHING;

COMMIT;

-- PostgREST caches the schema at start: a table created afterwards is invisible to it with NO
-- error at all, just empty reads (CORE.md). The worker reads this table in the same session.
NOTIFY pgrst, 'reload schema';
