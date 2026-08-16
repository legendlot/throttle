-- 0016_sales_accessories_rollup_v1
-- "Accessories & others" — ONE bundled memo line for unmapped accessories / spares / gift-wrapping.
-- Decided Afshaan 2026-08-16; memo semantics confirmed 2026-08-16 (S289).
--
-- ⚠️ DELIBERATELY OUTSIDE sales_fact, AND OUTSIDE EVERY TOTAL.
-- These SKUs are unmapped by design — mapping them to product variants would inflate variant units
-- (that was the explicit instruction). Writing them into sales_fact would instead restate Website
-- net revenue back to 2026-06, moving every published dashboard/P&L figure. So this is a READ-ONLY
-- rollup computed straight off staging: nothing here can change a number that already exists.
-- If the bundle is ever wanted INSIDE totals, that is a separate, deliberate decision.
--
-- Scope is rule-driven (same shape as sales.order_type_rules) so the team can widen it from data
-- without a deploy. Anything NOT matched stays in sales.unmapped_sku where it belongs — the memo
-- line must never silently swallow a real product that just needs mapping.

CREATE TABLE IF NOT EXISTS sales.accessory_rules (
  id          bigserial PRIMARY KEY,
  bucket      text NOT NULL,                      -- display grouping within the bundle
  match_kind  text NOT NULL CHECK (match_kind IN ('prefix','exact','contains')),
  pattern     text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_kind, pattern)
);

ALTER TABLE sales.accessory_rules ENABLE ROW LEVEL SECURITY;
GRANT ALL ON sales.accessory_rules TO service_role;
GRANT USAGE, SELECT ON SEQUENCE sales.accessory_rules_id_seq TO service_role;

-- Seed: measured off the live open unmapped queue 2026-08-16. Patterns are matched case-insensitively.
INSERT INTO sales.accessory_rules (bucket, match_kind, pattern, note) VALUES
  ('Gift wrapping',      'prefix',   'accnotvisible-giftwrap', 'Website gift-wrap add-on line'),
  ('Gift wrapping',      'contains', 'gift wrapping',          'loose-title gift wrap'),
  ('Spares & parts',     'prefix',   'lotsp-',                 'spare-part SKU namespace'),
  ('Spares & parts',     'prefix',   'acc-',                   'accessory SKU namespace'),
  ('Spares & parts',     'prefix',   'accnotvisible-',         'catch-all for hidden accessory SKUs'),
  ('Spares & parts',     'exact',    'remote',                 'loose-title spare remote'),
  ('Spares & parts',     'exact',    'remote control',         'loose-title spare remote'),
  ('Spares & parts',     'exact',    'battery pack',           'loose-title spare battery'),
  ('Spares & parts',     'exact',    'charging cable',         'loose-title spare cable'),
  ('Spares & parts',     'exact',    'container',              'loose-title spare container'),
  ('Spares & parts',     'exact',    'passenger + cargo',      'loose-title spare body'),
  -- Second pass, same session: the first seed left obvious spares in the unmatched tail.
  ('Spares & parts',     'contains', 'l.o.t spare parts',      'legacy loose spare-part titles'),
  ('Spares & parts',     'exact',    'battery',                'loose-title spare battery'),
  ('Spares & parts',     'exact',    'alex battery',           'loose-title spare battery'),
  ('Spares & parts',     'exact',    'l.o.t flare remote',     'loose-title spare remote'),
  ('Spares & parts',     'exact',    'l.o.t cars - bumble remote control', 'loose-title spare remote'),
  ('Spares & parts',     'exact',    'mccloud drone remote',   'loose-title spare remote'),
  ('Repairs & service',  'contains', 'drone repair',           'paid repair line'),
  ('Repairs & service',  'exact',    'mccloud service',        'paid service line')
ON CONFLICT (match_kind, pattern) DO NOTHING;
-- Deliberately NOT matched (verified 2026-08-16): 'L.O.T Cars "Frost" …', 'Street blue',
-- 'lotbuild-base-hermionegranger', '1'. Those are real products or junk needing a real mapping —
-- the memo line must not swallow them.

-- Rollup: unmapped, non-cancelled SALE rows in staging that match an active accessory rule.
-- Excludes anything already in sku_map — once a SKU is genuinely mapped it is a product, not a memo.
CREATE OR REPLACE FUNCTION sales.f_accessories_rollup(
  p_from date, p_to date, p_channels uuid[] DEFAULT NULL::uuid[]
) RETURNS TABLE(channel_id uuid, channel_name text, bucket text,
                skus bigint, units bigint, gross numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'sales','public'
-- ⚠️ AGGREGATE TO (channel, sku) FIRST, THEN match the rules. The original body ran the rule
-- subquery once per STAGED ROW (~200k over an FY window): 7,293 ms, which returned 502 to the
-- dashboard and — because the call sat in the dashboard's Promise.all — blanked every KPI on the
-- page. Aggregating first drops the subquery to ~500 loops: 632 ms, byte-identical output.
-- Never widen this back to per-row matching.
AS $$
  WITH cand AS (
    SELECT v.channel_id, v.channel_sku,
           SUM(v.qty) AS qty, SUM(v.gross_value) AS gross
    FROM sales.v_staged v
    WHERE v.sale_date BETWEEN p_from AND p_to
      AND NOT v.is_cancelled
      AND v.row_type = 'sale'
      AND (p_channels IS NULL OR v.channel_id = ANY(p_channels))
    GROUP BY v.channel_id, v.channel_sku
  ),
  unmapped AS (
    SELECT c.* FROM cand c
    WHERE NOT EXISTS (SELECT 1 FROM sales.sku_map m
                       WHERE m.channel_id = c.channel_id AND m.channel_sku = c.channel_sku)
  ),
  tagged AS (
    SELECT u.*,
           (SELECT r.bucket FROM sales.accessory_rules r
             WHERE r.is_active
               AND ((r.match_kind='prefix'   AND lower(u.channel_sku) LIKE lower(r.pattern)||'%')
                 OR (r.match_kind='exact'    AND lower(u.channel_sku) = lower(r.pattern))
                 OR (r.match_kind='contains' AND lower(u.channel_sku) LIKE '%'||lower(r.pattern)||'%'))
             ORDER BY CASE r.match_kind WHEN 'exact' THEN 1 WHEN 'prefix' THEN 2 ELSE 3 END,
                      length(r.pattern) DESC
             LIMIT 1) AS bucket
    FROM unmapped u
  )
  SELECT t.channel_id, dc.name, t.bucket,
         COUNT(*)::bigint, SUM(t.qty)::bigint, SUM(t.gross)::numeric
  FROM tagged t
  LEFT JOIN public.dispatch_channels dc ON dc.id = t.channel_id
  WHERE t.bucket IS NOT NULL
  GROUP BY t.channel_id, dc.name, t.bucket
  ORDER BY SUM(t.gross) DESC;
$$;

GRANT EXECUTE ON FUNCTION sales.f_accessories_rollup(date, date, uuid[]) TO service_role;

-- PostgREST caches the schema at start; a table created afterwards is invisible until reload
-- (CORE.md — it fails SILENTLY, reads just come back not-found).
NOTIFY pgrst, 'reload schema';
