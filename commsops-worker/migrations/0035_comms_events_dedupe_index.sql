-- 0035_comms_events_dedupe_index — remove a duplicate index on comms.events.
--
-- `comms.events` carried TWO byte-identical btree indexes on (name, occurred_at DESC):
--   · events_name_time_idx      — the original, from 0001_comms_schema_v1
--   · events_name_occurred_idx  — added 2026-07-23 by comms_event_feed_v1 (S232 /activity),
--                                 which re-declared an index that already existed.
--
-- A redundant index is pure cost: every INSERT into comms.events (ingest runs on the hot
-- path — Shopify/Shopflo webhooks + the pixel, ~1k+ rows/day) maintains BOTH, and the second
-- one can never serve a query the first cannot. Verified before removal (2026-07-24):
-- identical definitions, neither UNIQUE/PRIMARY, neither backs a constraint, both valid.
--
-- The ORIGINAL is kept so 0001 stays the source of truth and the events_name_time_idx
-- referenced by 0034's event_registry() usage query remains correct. Queries are unaffected:
-- the planner simply uses the surviving identical index.
--
-- Reversible: re-create with
--   CREATE INDEX events_name_occurred_idx ON comms.events USING btree (name, occurred_at DESC);

SET lock_timeout = '5s';   -- comms.events is write-hot; fail fast rather than block ingest

DROP INDEX IF EXISTS comms.events_name_occurred_idx;
