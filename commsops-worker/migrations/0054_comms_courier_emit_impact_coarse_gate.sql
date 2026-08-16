-- 0054 — courier_emit_impact() had DRIFTED from shipment-events.js and overstated the blast radius.
--
-- The item this closes exists because the preview replicates the emitter's eligibility predicate
-- BY HAND, so a change to one and not the other turns it into "a confident lie about how many
-- customer messages a watermark change will send". Audited 2026-08-16 (S289); it had drifted.
--
-- Measured at the live watermark 2026-07-24 18:30Z: the RPC reported 4, and ALL 4 were rows the
-- emitter can never fetch — i.e. the preview said "4 customer messages" where the truth is 0.
--
-- CAUSE. The emitter's PostgREST query carries a coarse gate,
--     or=(uniware_updated_at.gte.<from>, lifecycle_changed_at.gte.<from>)
-- and only then applies the precise occurredAt() test in JS. For a DELIVERED row occurredAt()
-- prefers `delivered_at` — so a parcel whose delivered_at passes the watermark while BOTH clocks
-- the coarse gate looks at are older passed the RPC and was invisible to the emitter.
--
-- ⚠️ Rebuilt from pg_get_functiondef (the LIVE definition), NEVER from a repo migration file —
-- PATTERN-297: in S276 a CREATE OR REPLACE rebuilt from a stale mirror silently dropped a live
-- segment filter. The only change is the added coarse-gate clause.
--
-- Deliberately NOT mirrored: MAX_PER_RUN (15/tick) and the 300-row page. Those are per-tick
-- THROTTLES, not eligibility — the emitter drains the backlog over successive cron ticks, and the
-- preview's question is "how many will this watermark eventually send", not "how many next tick".
--
-- Verified after apply: current watermark 4 -> 0; 30 days back 127 (rto 63 / in_transit 45 /
-- delivered 19), so the function still answers rather than having been zeroed.
CREATE OR REPLACE FUNCTION comms.courier_emit_impact(p_from timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  WITH e AS (
    SELECT s.lifecycle,
           CASE WHEN s.lifecycle = 'delivered'
                THEN COALESCE(s.delivered_at, s.lifecycle_changed_at, s.uniware_updated_at)
                ELSE COALESCE(s.lifecycle_changed_at, s.uniware_updated_at)
           END AS occurred_at,
           COALESCE(s.dispatched_at, s.first_seen_at) AS born
    FROM public.ecom_shipments s
    WHERE s.lifecycle IN ('in_transit', 'out_for_delivery', 'delivered', 'rto')
      AND s.shopify_order_id IS NOT NULL
      AND NOT (s.lifecycle = ANY (COALESCE(s.emitted_lifecycles, ARRAY[]::text[])))
      -- MIRRORS the emitter's coarse gate (shipment-events.js). Without it this counts rows the
      -- emitter's query never returns.
      AND (s.uniware_updated_at >= p_from OR s.lifecycle_changed_at >= p_from)
  ),
  g AS (
    SELECT lifecycle, count(*) AS n
    FROM e
    WHERE occurred_at IS NOT NULL
      AND occurred_at >= p_from
      AND (born IS NULL OR born >= now() - interval '30 days')   -- MAX_EVENT_AGE_MS
    GROUP BY lifecycle
  )
  SELECT jsonb_build_object(
    'from', p_from,
    'total', COALESCE((SELECT sum(n) FROM g), 0),
    'by_lifecycle', COALESCE((SELECT jsonb_object_agg(lifecycle, n) FROM g), '{}'::jsonb)
  );
$function$;
