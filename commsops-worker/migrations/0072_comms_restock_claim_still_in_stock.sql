-- 0072 (S372, 2026-09-11) — claim a back-in-stock sign-up only against a restock that is STILL IN STOCK.
--
-- Why: the journey "Back in stock — requested alert" stays DRAFT while sign-ups record (Afshaan,
-- 2026-09-11), and emitRestockEvents claims nothing until it is activated. At activation, 0071's
-- claim matched every waiting sign-up to its EARLIEST restock flip since p_since — including a
-- variant that came back and sold out again while the journey was draft. That is a "back in stock"
-- email about something that is not in stock, sent in one burst on the day the journey goes live.
-- Now a flip only counts if no later variant `oos` flip exists for the same SKU on the same channel,
-- i.e. it is the start of the CURRENT in-stock stretch. A sign-up whose variant is out again simply
-- waits for the next restock. Measured 2026-09-11: 12 restock flips since 2026-09-09, 0 followed
-- by an oos, 1 claimable pair — identical under old and new rules today; they diverge with time.
-- Signature and everything else unchanged from 0071.

CREATE OR REPLACE FUNCTION comms.claim_restock_notifications(p_since timestamp with time zone DEFAULT '2026-09-09 00:00:00+00'::timestamp with time zone, p_limit integer DEFAULT 200)
 RETURNS integer
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'comms', 'sales', 'public'
AS $function$
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
      -- 0072: still in stock — no later variant sell-out for this SKU on this channel.
      AND NOT EXISTS (
        SELECT 1 FROM sales.stock_alert_outbox o2
        WHERE o2.direction  = 'oos'
          AND o2.scope      = 'variant'
          AND o2.sku        = o.sku
          AND o2.channel_id = o.channel_id
          AND o2.flipped_at > o.flipped_at
      )
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
$function$;
