-- 0005 — Archive done tasks (Session 118).
-- Additive: a task can be archived (tucked into a collapsed "Archived" section)
-- independently of its status. Archiving is NOT deletion (RULE-DOCKET-001 intact) —
-- it only hides the task from the active board; it is fully reversible (unarchive).
-- list_tasks returns `setof docket.tasks` (select t.*), so it surfaces the new
-- column automatically — no function change needed.

alter table docket.tasks add column if not exists archived_at timestamptz;

-- Speeds the per-space active/archived split.
create index if not exists docket_tasks_archived_idx on docket.tasks(space_id, archived_at);
