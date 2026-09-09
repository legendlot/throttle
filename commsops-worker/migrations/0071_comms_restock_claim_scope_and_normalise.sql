-- 0071 — SP3 claim RPC: normalise the SKU join and scope it to the storefront (S362 hostile review)
--
-- Two faults in 0070, both of the silent-mismatch class this feature exists to avoid.
--
-- (a) THE JOIN WAS CASE- AND WHITESPACE-EXACT ON BOTH SIDES. A theme emitting `SHADOW-TARMAC-BLACK`
--     or a SKU with a trailing space matched nothing, forever, and looked entirely correct — the
--     same failure as the Shopify-variant-ID submissions the 0069 header calls out. Measured
--     2026-09-09: 49 of 221 `sales.sku_map` rows on the storefront channel are not already
--     lower-case, so the shapes genuinely vary. `validateSubmission` trims but does not lowercase.
--
-- (b) IT IGNORED `channel_id`, so an Amazon restock could email a website subscriber while the
--     storefront was still sold out. Two channels feed `stock_alert_outbox` (166 storefront vs 1
--     Amazon restocks in the 30 days to 2026-09-09). Scoped via `sales.connector_config`
--     (`adapter_kind='shopify'`) rather than a pasted uuid, so it follows the connector.
--
-- Applied to the live DB as migration `comms_restock_claim_scope_and_normalise`.

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
  storefront AS (
    SELECT channel_id FROM sales.connector_config WHERE adapter_kind = 'shopify'
  ),
  flips AS (
    SELECT o.id, o.sku, o.product_code, o.product_title, o.flipped_at, o.qty_after
    FROM sales.stock_alert_outbox o
    WHERE o.direction = 'restock'
      AND o.scope     = 'variant'
      AND o.sku IS NOT NULL
      AND o.qty_after > 0
      AND o.flipped_at >= p_since
      AND o.channel_id IN (SELECT channel_id FROM storefront)
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
     AND lower(btrim(s.payload->>'variant_sku')) = lower(btrim(fl.sku))
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

-- The index must match the expression the join now uses, or it stops being used at all.
DROP INDEX IF EXISTS comms.form_submissions_variant_sku_idx;
CREATE INDEX form_submissions_variant_sku_idx
  ON comms.form_submissions (lower(btrim(payload->>'variant_sku')))
  WHERE payload->>'variant_sku' IS NOT NULL;
