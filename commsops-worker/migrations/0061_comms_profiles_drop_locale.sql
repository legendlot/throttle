-- 0061 — drop comms.profiles.locale (S337, 2026-09-03)
--
-- WHY DROP RATHER THAN POPULATE (Afshaan's call, 2026-09-03):
--   · Non-null on 0 of 217,032 profiles — it has never held a single value.
--   · BOTH Shopify mappers HARDCODE it: shopify.js:125 and :180 each emit `locale: null`,
--     so any backfill would be erased on that customer's next sync. Populating it is not a
--     data task, it is a code change plus a backfill plus an ongoing mapper contract.
--   · It buys nothing if populated: LOT is India-only, INR, Asia/Kolkata — Shopify locale
--     would be ~uniformly en/en-IN, with no segmentation value.
--   · It is already documented-as-dead in two places in the app (segmentAst.js EMPTY_ATTRS,
--     segments/page.js), i.e. it costs a permanent special-case to keep a column that will
--     never hold data.
--
-- Reversible: re-add with `ALTER TABLE comms.profiles ADD COLUMN locale text;` — no data is
-- lost because there is none. Verified immediately before writing this migration:
--   SELECT count(*) FILTER (WHERE locale IS NOT NULL) FROM comms.profiles;  -- 0
ALTER TABLE comms.profiles DROP COLUMN IF EXISTS locale;

-- PostgREST caches the schema; a column change is invisible to the worker until it reloads.
NOTIFY pgrst, 'reload schema';
