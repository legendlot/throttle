-- 0035 — f_inventory_status: 23 s → ~1–3 s, IDENTICAL output (S403, 2026-09-29).
-- Odo Inventory "keeps loading": getInventoryStatus took 23.2 s in Postgres alone.
-- Cause: `since` was a CORRELATED subquery over the `runs` CTE — for each of the 239 current
-- (channel, sku) rows it re-scanned all ~369k materialised readings (spilled to temp:
-- 2.0M temp blocks read), i.e. ~88M row visits. Now the run start is one extra window pass
-- (MIN(captured_at) OVER (channel, sku, run_id)) carried onto the latest row.
-- Also: latest_pull used to seq-scan ~970k readings for MAX(captured_at) per channel; it is now
-- one backward pkey probe per channel. Restricting it to the 120-day window is exact: every
-- `cur` row is inside the window, and a channel's latest pull is ≥ its own latest row.
-- work_mem is raised for this function only — the 369k-row sort spilled ~60 MB to disk.
-- Verified before shipping: new vs old output EXCEPT both ways = 0 / 0 rows (239 rows).
CREATE OR REPLACE FUNCTION sales.f_inventory_status(p_channels uuid[] DEFAULT NULL::uuid[], p_include_unmapped boolean DEFAULT false)
 RETURNS TABLE(channel_id uuid, sku text, product_code text, product_title text, available_qty integer, purchasable boolean, status text, is_gone boolean, since timestamp with time zone, last_seen_at timestamp with time zone, low_threshold integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'sales', 'public'
 SET work_mem TO '128MB'
AS $function$
  WITH thr AS (SELECT sales.f_inv_setting('inv_low_stock_qty', 10) AS v),
  base AS (
    SELECT r.channel_id, r.sku, r.product_code, r.product_title,
           r.available_qty, r.purchasable, r.captured_at,
           COALESCE(it.low_stock_qty, (SELECT v FROM thr)) AS thr_v,
           CASE WHEN r.available_qty <= 0 THEN 'oos'
                WHEN r.available_qty < COALESCE(it.low_stock_qty, (SELECT v FROM thr)) THEN 'low'
                ELSE 'ok' END AS st
    FROM sales.inventory_reading r
    LEFT JOIN sales.inv_threshold it ON it.product_code = r.product_code
    WHERE r.pull_complete
      AND r.captured_at >= now() - interval '120 days'
      AND (p_channels IS NULL OR r.channel_id = ANY(p_channels))
      AND (p_include_unmapped OR r.product_code IS NOT NULL)
  ),
  runs AS (
    SELECT b.*,
           COUNT(*) FILTER (WHERE b.st IS DISTINCT FROM b.prev_st)
             OVER (PARTITION BY b.channel_id, b.sku ORDER BY b.captured_at
                   ROWS UNBOUNDED PRECEDING) AS run_id
    FROM (SELECT *, LAG(st) OVER (PARTITION BY channel_id, sku ORDER BY captured_at) AS prev_st
          FROM base) b
  ),
  runs2 AS (
    SELECT *, MIN(captured_at) OVER (PARTITION BY channel_id, sku, run_id) AS run_start FROM runs
  ),
  chans AS (SELECT DISTINCT channel_id FROM base),
  latest_pull AS (
    SELECT ch.channel_id,
           (SELECT r.captured_at FROM sales.inventory_reading r
             WHERE r.channel_id = ch.channel_id AND r.pull_complete
               AND r.captured_at >= now() - interval '120 days'
             ORDER BY r.captured_at DESC LIMIT 1) AS at
    FROM chans ch
  ),
  cur AS (SELECT DISTINCT ON (channel_id, sku) * FROM runs2
          ORDER BY channel_id, sku, captured_at DESC)
  SELECT c.channel_id, c.sku, c.product_code, c.product_title,
         c.available_qty, c.purchasable,
         CASE WHEN c.captured_at < lp.at THEN 'gone' ELSE c.st END AS status,
         (c.captured_at < lp.at) AS is_gone,
         c.run_start AS since,
         c.captured_at AS last_seen_at,
         c.thr_v AS low_threshold
  FROM cur c JOIN latest_pull lp ON lp.channel_id = c.channel_id;
$function$;
