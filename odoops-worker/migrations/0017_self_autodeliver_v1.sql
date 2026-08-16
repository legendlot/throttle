-- 0017_self_autodeliver_v1
-- SELF-shipped parcels are auto-closed as `delivered` 25 days after dispatch.
-- Decided Afshaan 2026-08-16; emission semantics decided in-session 2026-08-16 (S289): SILENT.
--
-- WHY IT EXISTS: SELF has no courier, so no ScanPush/Uniware scan can ever close one. 5,894 SELF
-- shipments were stuck `in_transit`, the oldest dispatched 2026-04-21 — a structural hole in
-- `order_delivered` coverage that no feed could fill.
--
-- ⚠️⚠️ THIS TRANSITION MUST NEVER MESSAGE A CUSTOMER. It is an ASSUMPTION (25 days elapsed), not
-- evidence of delivery — a parcel that never arrived would otherwise be announced as delivered.
-- Afshaan chose data-only closure permanently, for the forward flow as well as the historical tail.
--
-- HOW THE SILENCE IS ENFORCED (belt AND braces — commsops/shipment-events.js is the contract):
--   1. `emitted_lifecycles` gains 'delivered' IN THE SAME WRITE. The emitter filters on
--      `!(emitted_lifecycles).includes(lifecycle)`, so the row is invisible to it forever —
--      this is the DURABLE guard and survives any later clock bump by another feed.
--   2. `lifecycle_changed_at` is deliberately LEFT ALONE (NULL on these rows). The emitter's
--      coarse gate is `uniware_updated_at >= watermark OR lifecycle_changed_at >= watermark`,
--      so an unstamped row never even enters the 300-row window.
--   3. `delivered_at` is set to a HISTORICAL stamp (dispatched_at + 25d), never now(). For
--      `delivered`, occurredAt() reads `delivered_at` FIRST — a now() stamp would look like a
--      fresh delivery the moment anything else bumped the row into the window.
-- Guard 1 alone is sufficient; 2 and 3 exist so that a future change to any one of them cannot
-- silently start messaging people about months-old orders.
--
-- ⚠️ Pre-marking `emitted_lifecycles` LOOKS like the 2026-07-20 backfill incident that
-- permanently silenced order_delivered/order_rto by bulk-marking every row. It is the opposite
-- case: there, rows that SHOULD have emitted were silenced by accident. Here, silence is the
-- product decision. Do not "fix" this by clearing the marks.
--
-- ⚠️ `rto` SELF rows (85) are deliberately NOT touched — rto is terminal and a returned parcel
-- was never delivered.
-- ⚠️ `uniware_updated_at` is odoops-owned and is never stamped from here (CORE.md).

CREATE OR REPLACE FUNCTION public.close_self_shipments(p_age_days integer DEFAULT 25)
RETURNS TABLE(closed bigint, oldest date, newest date)
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $$
  WITH upd AS (
    UPDATE public.ecom_shipments s
       SET lifecycle    = 'delivered',
           delivered_at = s.dispatched_at + make_interval(days => p_age_days),
           emitted_lifecycles = (SELECT array_agg(DISTINCT x)
                                 FROM unnest(COALESCE(s.emitted_lifecycles,'{}') || ARRAY['delivered']) x)
     WHERE lower(COALESCE(s.courier,'')) = 'self'
       AND s.lifecycle = 'in_transit'
       AND s.dispatched_at IS NOT NULL
       AND s.dispatched_at < now() - make_interval(days => p_age_days)
    RETURNING s.delivered_at
  )
  SELECT COUNT(*)::bigint, MIN(delivered_at)::date, MAX(delivered_at)::date FROM upd;
$$;

GRANT EXECUTE ON FUNCTION public.close_self_shipments(integer) TO service_role;
