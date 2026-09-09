-- 0070 — make the SP3 restock ledger a REAL outbox (S362, 2026-09-09)
--
-- 0069 had the claim RPC return the email payload and the worker emit straight from it. That is
-- wrong on the retry path: the claim row is written BEFORE the event exists, so a failed emit
-- left a row the RPC would never hand out again (its own NOT EXISTS matched the claim) and the
-- customer's alert was stranded forever with no error anywhere. Same silent-loss shape that has
-- bitten the shipment feed and the web-bot forward.
--
-- Fix: denormalise everything the email needs onto the ledger, so a pending row is
-- self-contained and re-emittable. The worker reads `event_emitted_at IS NULL` — new claims AND
-- previous failures — instead of trusting the RPC's return value. The RPC becomes a pure claimer.
ALTER TABLE comms.restock_notifications
  ADD COLUMN IF NOT EXISTS product_title text,
  ADD COLUMN IF NOT EXISTS product_url   text,
  ADD COLUMN IF NOT EXISTS qty_after     int,
  ADD COLUMN IF NOT EXISTS email         text,
  ADD COLUMN IF NOT EXISTS attempts      int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error    text;

COMMENT ON COLUMN comms.restock_notifications.attempts IS
  'Incremented by the worker per emit attempt. attempts high + event_emitted_at NULL = a stuck alert worth looking at.';

DROP FUNCTION IF EXISTS comms.claim_restock_notifications(timestamptz, int);

CREATE FUNCTION comms.claim_restock_notifications(
  p_since timestamptz DEFAULT '2026-09-09T00:00:00Z',
  p_limit int DEFAULT 200
)
RETURNS int
LANGUAGE sql
SECURITY DEFINER
SET search_path = comms, sales, public
AS $fn$
  WITH f AS (SELECT id FROM comms.forms WHERE slug = 'back-in-stock'),
  flips AS (
    SELECT o.id, o.sku, o.product_code, o.product_title, o.flipped_at, o.qty_after
    FROM sales.stock_alert_outbox o
    WHERE o.direction = 'restock'
      AND o.scope     = 'variant'
      AND o.sku IS NOT NULL
      AND o.qty_after > 0
      AND o.flipped_at >= p_since
  ),
  matches AS (
    SELECT DISTINCT ON (s.id)
           s.id AS submission_id, s.profile_id, fl.id AS outbox_id,
           fl.sku, fl.product_code, fl.product_title, fl.flipped_at, fl.qty_after,
           s.payload->>'email' AS email,
           nullif(split_part(split_part(s.source_url, '?', 1), '#', 1), '') AS product_url
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
      (submission_id, outbox_id, profile_id, variant_sku, product_code,
       product_title, product_url, qty_after, email, flipped_at)
    SELECT submission_id, outbox_id, profile_id, sku, product_code,
           product_title, product_url, qty_after, email, flipped_at
    FROM capped
    ON CONFLICT (submission_id) DO NOTHING
    RETURNING 1
  )
  SELECT coalesce((SELECT count(*) FROM ins), 0)::int;
$fn$;

REVOKE ALL ON FUNCTION comms.claim_restock_notifications(timestamptz, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION comms.claim_restock_notifications(timestamptz, int) TO service_role;
