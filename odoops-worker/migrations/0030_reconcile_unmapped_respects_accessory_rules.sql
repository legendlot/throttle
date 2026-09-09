-- 0030 — reconcile_unmapped_sku() must respect accessory_rules (S364, 2026-09-09)
--
-- FOUND BY THE S364 HOSTILE REVIEW. The worker-side accessory guard shipped in throttle fdcc725f
-- covers `resolveSkus` ONLY. `sales.reconcile_unmapped_sku()` is a SECOND matcher site — it runs on
-- the hourly cron, re-derives sales.match_channel_sku() for EVERY orphan in sales.v_staged (all-time,
-- not the run's date window) and inserts match_on='auto' rows. It re-created all four deleted
-- spare-remote rows 11 MINUTES after the deploy, and the 14 sales_fact rows / 15 units / ₹8,437 with
-- them. The session had reported "0 sales_fact rows" and that claim was false within the hour.
--
-- ⭐ Textbook PATTERN-218 / the CORE.md "N sites" rule: the fix was written against the site the
-- symptom pointed at, and fixing N−1 of N ships silently — the symptom clears, the class survives.
-- Grep for EVERY caller of a matcher before guarding one of them.
--
-- (a) A SKU matching an active accessory_rules row is never auto-mapped here either. A declared
--     memo-line SKU (§S289) is not a product.
-- (b) status='ignored' is PRESERVED on conflict. It was being reset to 'open' on every run, which
--     would have re-woken the unmapped-revenue alert hourly on rows deliberately silenced (§S325e).
-- (c) Whitespace is normalised (trim + collapse) to match sales.match_channel_sku. Without it a GT
--     free-text line composing ' Ghost Remote' misses the exact rule but still fuzzy-matches.
--
-- ⚠️ The alias is `ar`, NOT `r`: the function DECLAREs `r record` for its recompute loop, and an
-- `accessory_rules r` alias silently resolves `r.is_active` to that variable — the function then
-- throws 55000 on every call. Cost one round-trip; caught only because the fix was executed rather
-- than assumed.
--
-- Applied via apply_migration as odo_reconcile_unmapped_accessory_rules_v1 + _alias_fix_v2.
-- Verified after: reconcile_unmapped_sku() returns auto_mapped=0, sku_map and sales_fact hold zero
-- FLXXR/GHXXR/BMXXR rows, and all four channel_skus stay status='ignored' through a run.

CREATE OR REPLACE FUNCTION sales.reconcile_unmapped_sku()
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_mapped int := 0;
  v_queued int := 0;
  v_facts  int := 0;
  v_closed int := 0;
  v_stale  int := 0;
  r        record;
BEGIN
  CREATE TEMP TABLE _recon_resolved ON COMMIT DROP AS
  WITH staged AS (
    SELECT v.channel_id, v.channel_sku,
           sum(coalesce(v.qty, 0))::int             AS units,
           sum(coalesce(v.gross_value, 0))::numeric AS gross
    FROM sales.v_staged v
    WHERE v.row_type = 'sale' AND v.is_cancelled = false
      AND coalesce(v.qty, 0) > 0 AND v.channel_sku IS NOT NULL
    GROUP BY v.channel_id, v.channel_sku
  ),
  orphan AS (
    SELECT s.* FROM staged s
    LEFT JOIN sales.sku_map m
      ON m.channel_id = s.channel_id AND m.channel_sku = s.channel_sku
    WHERE m.channel_sku IS NULL
  )
  SELECT o.channel_id, o.channel_sku, o.units, o.gross,
         EXISTS (
           SELECT 1 FROM sales.accessory_rules ar
            WHERE ar.is_active
              AND ((ar.match_kind = 'prefix'
                    AND lower(btrim(regexp_replace(o.channel_sku, '\s+', ' ', 'g')))
                        LIKE lower(btrim(ar.pattern)) || '%')
                OR (ar.match_kind = 'exact'
                    AND lower(btrim(regexp_replace(o.channel_sku, '\s+', ' ', 'g')))
                        = lower(btrim(ar.pattern)))
                OR (ar.match_kind = 'contains'
                    AND lower(btrim(regexp_replace(o.channel_sku, '\s+', ' ', 'g')))
                        LIKE '%' || lower(btrim(ar.pattern)) || '%'))
         ) AS is_accessory,
         sales.match_channel_sku(o.channel_sku) AS product_code
  FROM orphan o;

  WITH ins AS (
    INSERT INTO sales.sku_map (channel_id, channel_sku, product_code, match_on, created_by)
    SELECT channel_id, channel_sku, product_code, 'auto', NULL
    FROM _recon_resolved WHERE product_code IS NOT NULL AND NOT is_accessory
    ON CONFLICT (channel_id, channel_sku) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_mapped FROM ins;

  WITH q AS (
    INSERT INTO sales.unmapped_sku (channel_id, channel_sku, pending_units, pending_gross,
                                    first_seen, last_seen, status)
    SELECT channel_id, channel_sku, units, gross, now(), now(),
           CASE WHEN is_accessory THEN 'ignored' ELSE 'open' END
    FROM _recon_resolved WHERE product_code IS NULL OR is_accessory
    ON CONFLICT (channel_id, channel_sku) DO UPDATE
      SET pending_units = EXCLUDED.pending_units,
          pending_gross = EXCLUDED.pending_gross,
          last_seen     = now(),
          status        = CASE WHEN sales.unmapped_sku.status IN ('resolved', 'ignored')
                               THEN sales.unmapped_sku.status ELSE 'open' END
    RETURNING 1
  )
  SELECT count(*) INTO v_queued FROM q;

  WITH c AS (
    UPDATE sales.unmapped_sku u
       SET status = 'resolved',
           resolved_product_code = coalesce(u.resolved_product_code, m.product_code),
           resolved_at = coalesce(u.resolved_at, now())
      FROM sales.sku_map m
     WHERE m.channel_id = u.channel_id AND m.channel_sku = u.channel_sku
       AND u.status = 'open'
    RETURNING 1
  )
  SELECT count(*) INTO v_closed FROM c;

  WITH s AS (
    UPDATE sales.unmapped_sku u
       SET status = 'ignored', resolved_at = now()
     WHERE u.status = 'open'
       AND u.last_seen < now() - interval '2 days'
       AND NOT EXISTS (
         SELECT 1 FROM sales.v_staged v
          WHERE v.channel_id = u.channel_id AND v.channel_sku = u.channel_sku)
    RETURNING 1
  )
  SELECT count(*) INTO v_stale FROM s;

  IF v_mapped > 0 THEN
    FOR r IN
      SELECT v.channel_id, array_agg(DISTINCT v.sale_date) AS dates
        FROM sales.v_staged v
        JOIN _recon_resolved x
          ON x.channel_id = v.channel_id AND x.channel_sku = v.channel_sku
       WHERE x.product_code IS NOT NULL AND NOT x.is_accessory AND v.sale_date IS NOT NULL
       GROUP BY v.channel_id
    LOOP
      v_facts := v_facts + coalesce(sales.recompute_facts(r.channel_id, r.dates, NULL), 0);
    END LOOP;
  END IF;

  RETURN jsonb_build_object('auto_mapped', v_mapped, 'queued', v_queued,
                            'facts_recomputed', v_facts,
                            'closed_now_mapped', v_closed, 'retired_gone_upstream', v_stale);
END $function$;
