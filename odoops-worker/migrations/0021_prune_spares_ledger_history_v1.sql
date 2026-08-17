-- S294 (2026-08-17) — the daily prune deleted EVERYTHING older than retention, including the
-- 18:30 UTC FBA ledger-history spine (13,977 rows >90d at fix time). It had not yet fired against
-- them; the next successful 19:00 UTC run would have silently destroyed the whole deep backfill.
-- 18:30:00 uniquely identifies ledger rows (live readings are hour-truncated, :00 only).
-- Applied to live as `odo_prune_spares_ledger_history_v1`. Mirror copy (PATTERN-297).
CREATE OR REPLACE FUNCTION sales.prune_inventory_readings()
RETURNS integer LANGUAGE plpgsql SET search_path TO 'sales', 'public' AS $$
DECLARE n int; keep int;
BEGIN
  keep := sales.f_inv_setting('inv_reading_retention_days', 90);
  DELETE FROM sales.inventory_reading
   WHERE captured_at < now() - make_interval(days => keep)
     AND captured_at::time <> time '18:30:00';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
NOTIFY pgrst, 'reload schema';
