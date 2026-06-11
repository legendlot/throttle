-- Docket — Checklists (recurring tasks). RULE-DOCKET-008.
-- Applied to Supabase lot-production as migration `docket_checklists_v1` (2026-06-12, S124).
-- Mirror kept here for repo record.
--
-- A recurring task lives in docket.tasks (is_recurring=true + recurrence jsonb) so it reuses
-- visibility/collaborators/comments/docs/history. Per-day completion is logged in
-- docket.checklist_completions ("one task + completion log"). Recurring tasks are EXCLUDED
-- from the board + dashboard (list_tasks / dashboard_stats filter is_recurring=false) and
-- surface only on the per-person /checklist page.
-- See docs/superpowers/specs/2026-06-12-docket-checklists-design.md.

-- 1. tasks columns ───────────────────────────────────────────────────────────
alter table docket.tasks
  add column if not exists is_recurring boolean not null default false,
  add column if not exists recurrence  jsonb;            -- {freq, days_of_week[], day_of_month, time}; null for one-time
create index if not exists docket_tasks_recurring_owner_idx
  on docket.tasks(owner_employee_id) where is_recurring;

-- 2. completion log ───────────────────────────────────────────────────────────
create table if not exists docket.checklist_completions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references docket.tasks(id) on delete cascade,
  occurrence_date date not null,                          -- IST date of this occurrence
  completed_at timestamptz not null default now(),
  completed_by_user_id uuid not null,
  unique (task_id, occurrence_date)                       -- one occurrence per task per day
);
create index if not exists docket_checklist_compl_task_idx
  on docket.checklist_completions(task_id, occurrence_date);
alter table docket.checklist_completions enable row level security;
grant all on docket.checklist_completions to service_role;

-- 3. list_tasks — exclude recurring tasks (board only). Signature unchanged → CREATE OR REPLACE.
create or replace function docket.list_tasks(
  p_user uuid, p_employee uuid, p_dept uuid, p_view_all boolean,
  p_space_id uuid,
  p_status text default null, p_department_id uuid default null,
  p_employee_filter uuid default null, p_priority text default null,
  p_overdue boolean default false, p_revised boolean default false,
  p_parent_id uuid default null, p_mine boolean default false,
  p_q text default null, p_program_id uuid default null
) returns setof docket.tasks language sql stable security definer set search_path = docket, public as $$
  with sp as (select is_default from docket.spaces where id = p_space_id)
  select t.* from docket.tasks t, sp
  where t.space_id = p_space_id
  and t.is_recurring = false
  and (
    (not sp.is_default)
    or p_view_all
    or t.owner_employee_id = p_employee
    or t.assignee_employee_id = p_employee
    or t.created_by_user_id = p_user
    or (p_dept is not null and t.department_id = p_dept)
    or exists (select 1 from docket.task_collaborators c where c.task_id = t.id and c.employee_id = p_employee)
  )
  and (p_status is null or t.status = p_status)
  and (p_department_id is null or t.department_id = p_department_id)
  and (p_employee_filter is null or t.owner_employee_id = p_employee_filter or t.assignee_employee_id = p_employee_filter)
  and (p_priority is null or t.priority = p_priority)
  and (not p_overdue or (t.status not in ('done','abandoned') and coalesce(t.revised_deadline,t.deadline) < now()))
  and (not p_revised or t.revised_deadline is not null)
  and (p_parent_id is null or t.parent_task_id = p_parent_id)
  and (p_program_id is null or t.program_id = p_program_id)
  and (not p_mine or t.owner_employee_id = p_employee or t.assignee_employee_id = p_employee
       or t.created_by_user_id = p_user
       or exists (select 1 from docket.task_collaborators c where c.task_id=t.id and c.employee_id=p_employee))
  and (p_q is null or t.title ilike '%'||p_q||'%' or t.task_no ilike '%'||p_q||'%')
  order by
    case t.priority when 'P0' then 0 when 'P1' then 1 when 'P2' then 2 else 3 end,
    coalesce(t.revised_deadline, t.deadline) asc nulls last,
    t.created_at desc;
$$;

-- 4. dashboard_stats — exclude recurring tasks from every count. Signature unchanged.
create or replace function docket.dashboard_stats(p_space_id uuid)
returns jsonb language sql stable security definer set search_path = docket, public as $$
  select jsonb_build_object(
    'by_status', (select coalesce(jsonb_object_agg(status,c),'{}'::jsonb) from
      (select status, count(*) c from docket.tasks where space_id=p_space_id and is_recurring=false group by status) s),
    'overdue', (select count(*) from docket.tasks
       where space_id=p_space_id and is_recurring=false and status not in ('done','abandoned') and coalesce(revised_deadline,deadline) < now()),
    'due_soon', (select count(*) from docket.tasks
       where space_id=p_space_id and is_recurring=false and status not in ('done','abandoned')
         and coalesce(revised_deadline,deadline) between now() and now() + interval '7 days'),
    'revised', (select count(*) from docket.tasks where space_id=p_space_id and is_recurring=false and revised_deadline is not null and status not in ('done','abandoned')),
    'completed_30d', (select count(*) from docket.tasks where space_id=p_space_id and is_recurring=false and status='done' and completed_at > now() - interval '30 days'),
    'by_department', (select coalesce(jsonb_agg(x),'[]'::jsonb) from
      (select d.id dept_id, d.name dept_name,
         count(*) filter (where t.status not in ('done','abandoned')) open,
         count(*) filter (where t.status='done') done,
         count(*) filter (where t.status='blocked') blocked,
         count(*) filter (where t.status not in ('done','abandoned') and coalesce(t.revised_deadline,t.deadline)<now()) overdue
       from docket.tasks t join podium.departments d on d.id=t.department_id
       where t.space_id=p_space_id and t.is_recurring=false group by d.id,d.name order by open desc) x),
    'by_person', (select coalesce(jsonb_agg(x),'[]'::jsonb) from
      (select e.id emp_id, e.full_name emp_name,
         count(*) filter (where t.status not in ('done','abandoned')) open,
         count(*) filter (where t.status='done') done,
         count(*) filter (where t.status not in ('done','abandoned') and coalesce(t.revised_deadline,t.deadline)<now()) overdue
       from docket.tasks t join podium.employees e on e.id=t.owner_employee_id
       where t.space_id=p_space_id and t.is_recurring=false group by e.id,e.full_name order by open desc) x)
  );
$$;
