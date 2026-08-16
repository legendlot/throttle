-- 0018_stock_events_and_alerts_website_only
-- Applied live 2026-08-16 (S289) as migrations `stock_events_website_only_v1` and
-- `stock_alerts_website_only_v1`. Recorded here so the repo matches the database.
--
-- WHY: sales.inventory_reading became MULTI-CHANNEL when the S289 Amazon FBA feed landed. Two
-- consumers had been written when it was single-channel:
--
--   sales.recompute_stock_events — read the table with NO channel filter and keyed on `sku` alone
--   (DISTINCT ON (sku)). Amazon SKUs immediately began writing stream='stock' change_events, which
--   /funnel renders as WEBSITE stock markers. MEASURED 2026-08-16: 34 events that day against a
--   3-9 baseline, 14 of them Amazon-shaped. After the fix + a re-run: 4, none Amazon.
--   Also latent: DISTINCT ON (sku) would let whichever channel wrote last define a SKU's end-of-day
--   state. Zero SKU strings collide today (Amazon uses the -flex convention) but that is a naming
--   accident, not a guarantee — 19 of 208 Amazon SKUs already sit outside it.
--   Same defect class as the S223 bug this function was rewritten to fix (19% of events false).
--
--   sales.detect_stock_alerts — already channel-aware, so its Amazon rows would have been CORRECT.
--   Scoped anyway on CONSENT, not correctness: the Slack seam is live (347 alerts sent) and this
--   would have silently added a new class of message to a human channel (133 Amazon SKUs, 102 of
--   them out of stock). The task was to capture Amazon inventory, not to change what pings the team.
--
-- Enabling Amazon for either is a one-line change (drop the channel_id filter) and is a product
-- decision, tracked in BACKLOG. Amazon stock markers would also need their own surface and their
-- own event ids — `stock:<sku>:<date>:<dir>` has no channel in it.
--
-- Full bodies below, dumped from the live database so this file cannot drift from it.

-- (bodies follow)

CREATE OR REPLACE FUNCTION sales.detect_stock_alerts(p_lookback_days integer DEFAULT 7)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'sales', 'public'
AS $function$
DECLARE n int; need int; web_id uuid;
BEGIN
  need := GREATEST(sales.f_inv_setting('inv_confirm_readings', 2), 1);
  SELECT id INTO web_id FROM public.dispatch_channels WHERE name = 'Website' LIMIT 1;

  WITH base AS (
    SELECT channel_id, sku, product_code, product_title, captured_at,
           available_qty, purchasable,
           LAG(purchasable)  OVER w AS prev_purchasable,
           LAG(available_qty) OVER w AS prev_qty,
           LEAD(purchasable, GREATEST(need - 1, 0)) OVER w AS state_after_window,
           COUNT(*) OVER (PARTITION BY channel_id, sku ORDER BY captured_at
                          ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) AS rows_ahead
    FROM sales.inventory_reading
    WHERE pull_complete AND product_code IS NOT NULL
      AND channel_id = web_id
      AND captured_at >= now() - make_interval(days => p_lookback_days)
    WINDOW w AS (PARTITION BY channel_id, sku ORDER BY captured_at)
  )
  INSERT INTO sales.stock_alert_outbox
    (channel_id, sku, product_code, product_title, direction, flipped_at, confirmed_at,
     qty_before, qty_after, status)
  SELECT channel_id, sku, product_code, product_title,
         CASE WHEN purchasable THEN 'restock' ELSE 'oos' END,
         captured_at, now(), prev_qty, available_qty, 'pending'
  FROM base
  WHERE prev_purchasable IS NOT NULL
    AND purchasable IS DISTINCT FROM prev_purchasable
    AND rows_ahead >= need
    AND state_after_window = purchasable
  ON CONFLICT (channel_id, sku, direction, flipped_at) DO NOTHING;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $function$;

CREATE OR REPLACE FUNCTION sales.recompute_stock_events(p_date date)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'sales', 'public'
AS $function$
DECLARE n int; web_id uuid;
BEGIN
  SELECT id INTO web_id FROM public.dispatch_channels WHERE name = 'Website' LIMIT 1;

  DROP TABLE IF EXISTS _flips;
  CREATE TEMP TABLE _flips ON COMMIT DROP AS
  WITH eod AS (
    SELECT DISTINCT ON (sku) sku, product_code, product_title, available_qty, purchasable
    FROM sales.inventory_reading
    WHERE pull_complete AND product_code IS NOT NULL
      AND channel_id = web_id
      AND (captured_at AT TIME ZONE 'Asia/Kolkata')::date = p_date
    ORDER BY sku, captured_at DESC
  ),
  prior AS (
    SELECT DISTINCT ON (sku) sku, purchasable AS prev_purchasable, available_qty AS prev_qty
    FROM sales.inventory_reading
    WHERE pull_complete AND product_code IS NOT NULL
      AND channel_id = web_id
      AND (captured_at AT TIME ZONE 'Asia/Kolkata')::date < p_date
    ORDER BY sku, captured_at DESC
  )
  SELECT e.sku, e.product_code, e.product_title, e.available_qty, e.purchasable,
         p.prev_qty,
         CASE WHEN e.purchasable THEN 'restock' ELSE 'oos' END AS dir
  FROM eod e JOIN prior p ON p.sku = e.sku
  WHERE e.purchasable IS DISTINCT FROM p.prev_purchasable;

  DELETE FROM sales.change_events ce
  WHERE ce.stream = 'stock' AND ce.the_date = p_date
    AND NOT EXISTS (
      SELECT 1 FROM _flips f
      WHERE ce.id = 'stock:'||f.sku||':'||p_date||':'||f.dir);

  INSERT INTO sales.change_events
    (id, stream, the_date, workstream, surface, title, metric, status, raw, synced_at)
  SELECT 'stock:'||sku||':'||p_date||':'||dir, 'stock', p_date, 'stock',
         COALESCE(product_title, sku),
         COALESCE(product_title, sku) || CASE WHEN dir='oos' THEN ' — out of stock' ELSE ' — restocked' END,
         'purchasable', dir,
         jsonb_build_object('sku',sku,'product_code',product_code,'direction',dir,
                            'qty_before',prev_qty,'qty_after',available_qty),
         now()
  FROM _flips
  ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, status=EXCLUDED.status,
                                 raw=EXCLUDED.raw, synced_at=EXCLUDED.synced_at;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $function$;
