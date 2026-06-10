-- 0005 — Archive done tasks (Session 118).
--
-- NOTE (S118, same session): the FIRST cut made archive a per-TASK state via this
-- `archived_at` column + an `archiveTask` worker action. That was replaced the same
-- session by a per-PERSON view toggle ("Archive done tasks", localStorage) that simply
-- hides status='done' tasks into a collapsed section — no per-task field needed. So this
-- column is now DORMANT (no reader/writer in the worker or UI), kept (not dropped) to
-- avoid destructive DDL, and reservable if a server-synced per-task archive is ever wanted.
-- The current "archive" behaviour is entirely client-side (apps/docket/.../tasks/page.js).

alter table docket.tasks add column if not exists archived_at timestamptz;

-- Index kept alongside the dormant column.
create index if not exists docket_tasks_archived_idx on docket.tasks(space_id, archived_at);
