-- 0020_week_settings.sql — F9 Release 4: weeks (spec 2026-11-11-docket-plan-layer.md §6, §7.2, §8.3, §12 R4)
--
-- Seeds the three week settings in docket.settings (key text PK, value jsonb — migration 0004):
--   week_end_dow  ISO weekday the week ENDS on (1 = Mon … 7 = Sun). Default 7 = Sunday (→ Q1).
--   working_days  ISO weekdays that count for staleness (§8.3). Default Mon–Sat.
--   holidays      'YYYY-MM-DD' dates that never count as working days. Default none.
-- The worker reads them (src/index.js weekSettings → weeks-core normalizeWeekSettings: a malformed value
-- falls back to its default) and ships them to the app on getPlan / getPlanWeeks. Nothing else changes:
-- the week math, the Week filter and the three-week view's warnings live in the worker, behind the
-- existing gates (plan_items_for for plan rows, visibleTaskRows for tasks) — no new RPC, no forked
-- projection.
--
-- Idempotent: an existing value (a founder's choice) is never overwritten.

begin;

insert into docket.settings (key, value) values
  ('week_end_dow', '7'::jsonb),
  ('working_days', '[1, 2, 3, 4, 5, 6]'::jsonb),
  ('holidays', '[]'::jsonb)
on conflict (key) do nothing;

commit;
