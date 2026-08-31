-- S325 (2026-08-31) — "3 of 4 mapped" detector. A product family with one sibling silently unmapped.
--
-- THE CLASS, which has now fired FOUR times: a set of variants is mapped on a channel and one member
-- is quietly left out, so its sales fall out of `sales_fact` (RULE-SALES-001 excludes unmapped SKUs)
-- and nothing says so. Prior instances: the Blinkit HP standees ×2, the S294 `lotbuild-base-*` pair,
-- and `lotbuild-housecrest-hufflepuff` (3 of the 4 Hogwarts houses mapped, one missed — invisible
-- until a sweep found it).
--
-- ⚠️ **WHY THIS IS NOT THE UNMAPPED-REVENUE ALARM AGAIN.** That one fires on VALUE (₹10,000 per
-- channel per rolling 7 days). A slow-selling sibling never reaches it — that is the sub-threshold
-- tail recorded in `reference/watchboard.md`. This detector fires on the **PATTERN** regardless of
-- value: the money is not the signal, the gap in a set is.
--
-- ⛔ TWO REJECTED DESIGNS, MEASURED RATHER THAN ARGUED — do not "improve" it back into either:
--   • Catalogue siblings by `product`      → warns on **46.6%** of product×channel pairs (62 of 133).
--   • Catalogue siblings by `product` + model prefix → **38.9%** (58 of 149).
--   Both are useless as alarms, and for a real reason: **a channel legitimately carries a subset of
--   the catalogue.** Not stocking a variant is normal; it is not a mapping gap.
-- ✅ THE DISCRIMINATOR IS THAT THE MISSING SIBLING IS *ALREADY SELLING*. If a channel has staged
--   sales for a SKU, it is not "not stocked" — it is unmapped. So the rule works off the CHANNEL SKU
--   string among SKUs that actually appear in staging, not off the catalogue.
--
-- FAMILY = the channel SKU minus its last `-` segment (`lotbuild-housecrest-hufflepuff` →
-- `lotbuild-housecrest`). Warn when an UNMAPPED staged SKU has ≥1 MAPPED sibling in its family on
-- the same channel.
--
-- VERIFIED IN BOTH DIRECTIONS before shipping, because a zero-firing alarm and a broken one look
-- identical (the S307 lesson):
--   • TRUE NEGATIVE — on live data: **0 warnings**, across 236 unmapped staged SKUs that have a
--     family. Nothing to cry wolf about today.
--   • TRUE POSITIVE — replaying the real miss (treating `lotbuild-housecrest-hufflepuff` as
--     unmapped) fires on **exactly that one SKU**, reporting family `lotbuild-housecrest` and its
--     3 mapped siblings, and nothing else.
--
-- ⚠️ Honours `unmapped_sku.status='ignored'` — a human saying "never map this" (spares, gift wrap,
-- repairs) must not resurface here. Same suppression the unmapped alarm uses.
--
-- Applied to live as `odo_sibling_skip_detector_v1`. Mirror copy (PATTERN-297).

CREATE OR REPLACE FUNCTION sales.f_sibling_skips()
RETURNS TABLE (
  channel_id       uuid,
  channel_name     text,
  channel_sku      text,
  family           text,
  mapped_siblings  int,
  siblings         text,
  units            bigint,
  gross            numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'sales', 'public'
AS $fn$
  WITH staged AS (
    SELECT channel_id, channel_sku, qty, gross_value, is_cancelled, row_type FROM sales.stg_shopify
    UNION ALL SELECT channel_id, channel_sku, qty, gross_value, is_cancelled, row_type FROM sales.stg_amazon
    UNION ALL SELECT channel_id, channel_sku, qty, gross_value, is_cancelled, row_type FROM sales.stg_qc
    UNION ALL SELECT channel_id, channel_sku, qty, gross_value, is_cancelled, row_type FROM sales.stg_uniware
    UNION ALL SELECT channel_id, channel_sku, qty, gross_value, is_cancelled, row_type FROM sales.stg_snorkel
  ), agg AS (
    SELECT s.channel_id, s.channel_sku,
           sum(s.qty) FILTER (WHERE COALESCE(s.row_type,'sale')='sale'
                                AND COALESCE(s.is_cancelled,false)=false)          AS units,
           sum(s.gross_value) FILTER (WHERE COALESCE(s.row_type,'sale')='sale'
                                AND COALESCE(s.is_cancelled,false)=false)          AS gross
    FROM staged s GROUP BY 1,2
  ), lab AS (
    SELECT a.channel_id, a.channel_sku, a.units, a.gross,
           (m.product_code IS NOT NULL) AS is_mapped,
           -- NULLIF(...) leaves NULL when there is no '-' to strip, i.e. the SKU has no family
           NULLIF(regexp_replace(a.channel_sku, '-[^-]+$', ''), a.channel_sku) AS fam
    FROM agg a
    LEFT JOIN sales.sku_map m
           ON m.channel_id = a.channel_id AND m.channel_sku = a.channel_sku
    LEFT JOIN sales.unmapped_sku u
           ON u.channel_id = a.channel_id AND u.channel_sku = a.channel_sku
    WHERE COALESCE(u.status, 'open') <> 'ignored'
  )
  SELECT x.channel_id,
         dc.name,
         x.channel_sku,
         x.fam,
         (SELECT count(*)::int FROM lab b
           WHERE b.channel_id = x.channel_id AND b.fam = x.fam AND b.is_mapped),
         (SELECT string_agg(b.channel_sku, ', ' ORDER BY b.channel_sku) FROM lab b
           WHERE b.channel_id = x.channel_id AND b.fam = x.fam AND b.is_mapped),
         COALESCE(x.units, 0)::bigint,
         COALESCE(x.gross, 0)::numeric
  FROM lab x
  JOIN public.dispatch_channels dc ON dc.id = x.channel_id
  WHERE NOT x.is_mapped
    AND x.fam IS NOT NULL
    AND EXISTS (SELECT 1 FROM lab b
                 WHERE b.channel_id = x.channel_id AND b.fam = x.fam AND b.is_mapped)
  ORDER BY COALESCE(x.gross, 0) DESC;
$fn$;

GRANT EXECUTE ON FUNCTION sales.f_sibling_skips() TO service_role;

NOTIFY pgrst, 'reload schema';
