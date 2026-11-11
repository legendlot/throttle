-- 0014_checklist_register.sql — F8 P1: register view + adherence
-- (spec docs/superpowers/specs/2026-11-11-docket-checklists-v2.md §3.1, decisions C1/C2/C7)
--
-- C1 run_scope: 'per_person' (S127 behaviour — every assignee keeps their own chart) or 'shared'
--    (one chart per date, any assignee ticks; the tick row's employee_id = whoever ticked). The worker
--    keeps one tick per (item, date) for shared templates and dedupes on read (first tick wins).
-- C2 back-fill: derived, no column — a tick whose completed_at (IST date) is after its occurrence_date.
-- C7 done_by_note: a supervisor ticking on behalf of floor staff can name who actually did it.
--
-- Additive + idempotent. Both tables have no rows in production (S127 layer unused, measured 2026-11-11).

begin;

alter table docket.checklist_templates
  add column if not exists run_scope text not null default 'per_person';
do $$ begin
  alter table docket.checklist_templates
    add constraint checklist_templates_run_scope_chk check (run_scope in ('per_person', 'shared'));
exception when duplicate_object then null; end $$;

alter table docket.checklist_item_completions
  add column if not exists done_by_note text;

-- No new indexes: the unique keys (task_id, occurrence_date) and (template_item_id, employee_id,
-- occurrence_date) already lead on the column the register filters by.

-- Review fixes (applied as docket_checklist_register_v2):
-- • ONE tick per (item, date) on a shared chart, enforced by the database, not by a read-then-insert
--   (two assignees ticking at once both succeeded — Codex review #3). `shared` marks such ticks.
alter table docket.checklist_item_completions
  add column if not exists shared boolean not null default false;
create unique index if not exists checklist_item_completions_shared_uq
  on docket.checklist_item_completions (template_item_id, occurrence_date) where shared;
-- • An item added to a template later must not count as "missed" before it existed (review #5).
alter table docket.checklist_template_items
  add column if not exists created_at timestamptz not null default now();

notify pgrst, 'reload schema';

commit;
