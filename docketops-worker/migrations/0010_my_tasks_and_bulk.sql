-- 0010_my_tasks_and_bulk.sql — cross-space "My tasks" view.
-- Spec: docs/superpowers/specs/2026-06-18-docket-my-tasks-and-bulk-update.md
--
-- ONE additive function. list_tasks / dashboard_stats are NOT touched.
-- (Bulk update needs no SQL — the worker does a batched PATCH + array history insert
--  over PostgREST.)
--
-- list_my_tasks — every non-recurring task the caller OWNS or COLLABORATES on, across
-- every space they can see. Same cross-space visibility frame as list_tasks_by_program:
--   p_view_all OR space = ANY(p_member_space_ids) OR space = p_default_space_id
-- (the owner/collaborator predicate already makes a General-space task "mine", so the
--  default-space branch needs no extra baseline check). Returns top-level AND sub-tasks,
--  flat — the My-tasks page lists each matching task as its own row (no parent nesting).

create or replace function docket.list_my_tasks(
  p_user uuid, p_employee uuid, p_view_all boolean,
  p_member_space_ids uuid[], p_default_space_id uuid,
  p_status text default null, p_department_id uuid default null,
  p_priority text default null, p_overdue boolean default false,
  p_revised boolean default false, p_program_id uuid default null,
  p_q text default null
) returns setof docket.tasks
language sql stable security definer set search_path = docket, public as $$
  select t.* from docket.tasks t
  where t.is_recurring = false
    and (
      t.owner_employee_id = p_employee
      or exists (select 1 from docket.task_collaborators c where c.task_id = t.id and c.employee_id = p_employee)
    )
    and (
      p_view_all
      or t.space_id = any(p_member_space_ids)
      or t.space_id = p_default_space_id
    )
    and (p_status is null or t.status = p_status)
    and (p_department_id is null or t.department_id = p_department_id)
    and (p_priority is null or t.priority = p_priority)
    and (not p_overdue or (t.status not in ('done','abandoned') and coalesce(t.revised_deadline,t.deadline) < now()))
    and (not p_revised or t.revised_deadline is not null)
    and (p_program_id is null or t.program_id = p_program_id)
    and (p_q is null or t.title ilike '%'||p_q||'%' or t.task_no ilike '%'||p_q||'%')
  order by
    case t.priority when 'P0' then 0 when 'P1' then 1 when 'P2' then 2 else 3 end,
    coalesce(t.revised_deadline, t.deadline) asc nulls last,
    t.created_at desc;
$$;
grant execute on function docket.list_my_tasks(uuid,uuid,boolean,uuid[],uuid,text,uuid,text,boolean,boolean,uuid,text) to service_role;
