-- S325 (2026-08-31) — an RTO is a RETURN. Net it on the RTO date.
--
-- ⭐ THE RULE (Afshaan, 2026-08-31, verbatim): "COD order that is never delivered is part of
-- returns (Returns is customer cancellation + RTO (never accepted)). So it's not a sale, it
-- should be net as a return on the RTO date."
--
-- WHAT WAS WRONG. RULE-SALES-001's net ladder subtracts cancellations (`is_cancelled`) and returns
-- (refund rows). An RTO is NEITHER — the order was never cancelled, and for a COD parcel no money
-- was ever taken so no refund exists to stage. It fell straight through, leaving
-- **₹34,75,852 of gross counted as revenue on parcels that came back** (measured 2026-08-31):
-- website COD ₹29,90,599 · CRED ₹2,01,610 · FLIPKART ₹1,48,872 · FIRSTCRY ₹1,34,771.
--
-- ⚠️ NOT A UNIWARE-FEED PROBLEM, which is what the backlog item assumed. 2,029 of 2,422 RTOs (84%)
-- are the WEBSITE, which does not come through the uniware sales adapter at all. So this works off
-- `public.ecom_shipments.lifecycle='rto'` — the signal we ALREADY ingest for every channel — not
-- off a new returns feed. The Uniware `/oms/return/search` endpoint verified this session
-- (reference/integrations.md) is not needed for this and is deliberately unused here.
--
-- MECHANISM: mirror each RTO'd order's non-cancelled `sale` rows as `return` rows dated to the RTO
-- date. `sales.v_staged` already unions these tables and exposes `row_type`, and
-- `sales.recompute_facts` already sums `row_type='return'` into `returned_units`/`returned_value`
-- — so nothing downstream changes. This only supplies rows that were always meant to exist.
--
-- ✅ SAFE TO ATTRIBUTE THE WHOLE ORDER: every one of the 2,422 RTO orders has EXACTLY ONE package
-- (measured — 0 multi-package, 0 partial RTO, max 1). An RTO is therefore the whole order coming
-- back. ⚠️ If multi-package orders ever appear, this over-returns and needs per-package attribution.
-- Re-check with: orders in ecom_shipments having count(*) > 1 packages.
--
-- ⚠️ THE DATE: `COALESCE(lifecycle_changed_at, uniware_updated_at)`, in IST to match the fact grain.
-- Only 423 of 2,422 carry `lifecycle_changed_at` (courierops migration 0036 stamps it going
-- forward, and CORE.md forbids backfilling the pre-fix NULLs). For the other 1,999 we fall back to
-- Uniware's own last-update stamp, which for an RTO'd package is when Uniware last touched it — a
-- good proxy, NOT a certified RTO timestamp. Do not present these dates as exact.
--
-- ⚠️ IDEMPOTENT BY CONSTRUCTION: `source_line_id` is `rto:<package>:<original line id>`, unique per
-- returned line and namespaced so it can never collide with a Shopify refund row (whose ids are
-- `gid://shopify/Refund/…`). Re-running inserts nothing new. The 87 website RTOs that ALSO have a
-- genuine Shopify refund row are the one real double-count risk — see the guard below.
--
-- Applied to live as `odo_rto_returns_v1`. Mirror copy (PATTERN-297).

CREATE OR REPLACE FUNCTION sales.sync_rto_returns()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'sales', 'public'
AS $fn$
DECLARE
  n_web int := 0; n_mkt int := 0; r record;
BEGIN
  CREATE TEMP TABLE _touched (channel_id uuid, sale_date date) ON COMMIT DROP;

  -- ── WEBSITE (stg_shopify) ────────────────────────────────────────────────
  -- ⚠️ The join needs the GID stripped: stg_shopify.source_order_id is
  -- `gid://shopify/Order/6267954724916` while ecom_shipments.shopify_order_id is the bare numeric.
  -- Joining them raw matches NOTHING and reads as "no RTO was ever returned" — a false clean bill.
  WITH rto AS (
    SELECT e.shopify_order_id AS oid,
           max(e.uniware_package_code) AS pkg,
           max(COALESCE(e.lifecycle_changed_at, e.uniware_updated_at)) AS rto_at
    FROM public.ecom_shipments e
    WHERE e.lifecycle = 'rto'
      AND e.shopify_order_id IS NOT NULL
      AND COALESCE(e.lifecycle_changed_at, e.uniware_updated_at) IS NOT NULL
    GROUP BY e.shopify_order_id
  ), ins AS (
    INSERT INTO sales.stg_shopify
      (channel_id, source_order_id, order_name, source_line_id, occurred_at, sale_date,
       channel_sku, variant_title, title, qty, gross_value, discount_value, tax_value,
       row_type, order_status, is_cancelled, raw)
    SELECT s.channel_id, s.source_order_id, s.order_name,
           'rto:' || rto.pkg || ':' || s.source_line_id,
           rto.rto_at,
           (rto.rto_at AT TIME ZONE 'Asia/Kolkata')::date,
           s.channel_sku, s.variant_title, s.title,
           s.qty, s.gross_value, s.discount_value, s.tax_value,
           'return', 'RTO', false,
           jsonb_build_object('rto_package', rto.pkg, 'src', 'sync_rto_returns')
    FROM sales.stg_shopify s
    JOIN rto ON rto.oid = regexp_replace(s.source_order_id, '^.*/', '')
    WHERE s.row_type = 'sale' AND s.is_cancelled = false
      -- ⛔ Do NOT double-count an RTO that Shopify ALSO refunded (87 of 2,029 measured). The refund
      -- row is the authoritative one — it carries the real refund date and the real refunded value.
      AND NOT EXISTS (
        SELECT 1 FROM sales.stg_shopify rf
         WHERE rf.row_type = 'return'
           AND rf.source_order_id = s.source_order_id
           AND rf.channel_sku = s.channel_sku
           AND rf.source_line_id NOT LIKE 'rto:%')
    ON CONFLICT (source_line_id) DO NOTHING
    RETURNING channel_id, sale_date
  )
  INSERT INTO _touched SELECT channel_id, sale_date FROM ins;
  GET DIAGNOSTICS n_web = ROW_COUNT;

  -- ── MARKETPLACE (stg_uniware) — CRED / FLIPKART / FIRSTCRY ───────────────
  -- Keyed on the Uniware order code, which IS stg_uniware.source_order_id (no GID here).
  WITH rto AS (
    SELECT e.uniware_order_code AS oid,
           max(e.uniware_package_code) AS pkg,
           max(COALESCE(e.lifecycle_changed_at, e.uniware_updated_at)) AS rto_at
    FROM public.ecom_shipments e
    WHERE e.lifecycle = 'rto'
      AND e.uniware_order_code IS NOT NULL
      AND COALESCE(e.channel, '') <> 'LEGEND_OF_TOYS'
      AND COALESCE(e.lifecycle_changed_at, e.uniware_updated_at) IS NOT NULL
    GROUP BY e.uniware_order_code
  ), ins AS (
    INSERT INTO sales.stg_uniware
      (channel_id, source_order_id, source_line_id, occurred_at, sale_date,
       channel_sku, title, qty, gross_value, discount_value, tax_value,
       row_type, order_status, is_cancelled, raw)
    SELECT s.channel_id, s.source_order_id,
           'rto:' || rto.pkg || ':' || s.source_line_id,
           rto.rto_at,
           (rto.rto_at AT TIME ZONE 'Asia/Kolkata')::date,
           s.channel_sku, s.title,
           s.qty, s.gross_value, s.discount_value, s.tax_value,
           'return', 'RTO', false,
           jsonb_build_object('rto_package', rto.pkg, 'src', 'sync_rto_returns')
    FROM sales.stg_uniware s
    JOIN rto ON rto.oid = s.source_order_id
    WHERE s.row_type = 'sale' AND s.is_cancelled = false
      AND NOT EXISTS (
        SELECT 1 FROM sales.stg_uniware rf
         WHERE rf.row_type = 'return'
           AND rf.source_order_id = s.source_order_id
           AND rf.channel_sku = s.channel_sku
           AND rf.source_line_id NOT LIKE 'rto:%')
    ON CONFLICT (source_line_id) DO NOTHING
    RETURNING channel_id, sale_date
  )
  INSERT INTO _touched SELECT channel_id, sale_date FROM ins;
  GET DIAGNOSTICS n_mkt = ROW_COUNT;

  -- ── Recompute only the (channel, date) pairs we actually touched ─────────
  FOR r IN SELECT channel_id, array_agg(DISTINCT sale_date) AS dates FROM _touched GROUP BY channel_id
  LOOP
    PERFORM sales.recompute_facts(r.channel_id, r.dates, NULL);
  END LOOP;

  RETURN n_web + n_mkt;
END $fn$;

GRANT EXECUTE ON FUNCTION sales.sync_rto_returns() TO service_role;

NOTIFY pgrst, 'reload schema';
