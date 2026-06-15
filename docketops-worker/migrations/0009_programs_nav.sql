-- 0009_programs_nav.sql — Programs sidebar section + cross-space program view.
-- Spec: docs/superpowers/specs/2026-06-15-docket-programs-sidebar-design.md
--
-- Two ADDITIVE functions. The load-bearing list_tasks / dashboard_stats are NOT
-- touched (they stay single-space) — zero regression risk to the board/dashboard.
--
-- Visibility rule (identical to list_tasks, but evaluated ACROSS spaces in one query):
-- a task is visible iff
--   p_view_all
--   OR t.space_id = ANY(p_member_space_ids)        -- private spaces the caller owns/belongs to
--   OR ( t.space_id = p_default_space_id AND baseline:                -- General (open default)
--          owner=me OR legacy assignee=me OR creator=me OR dept=mine OR collaborator )
-- The worker passes p_member_space_ids = the caller's accessible PRIVATE spaces (owned + member),
-- and p_default_space_id = the General space id.

-- 1. programs_for_user — drives the sidebar Programs list. Only programs the caller has
--    >=1 visible, non-recurring, top-level task in, with a matching task_count badge.
create or replace function docket.programs_for_user(
  p_user uuid, p_employee uuid, p_dept uuid, p_view_all boolean,
  p_member_space_ids uuid[], p_default_space_id uuid
) returns table(id uuid, name text, color text, task_count bigint)
language sql stable security definer set search_path = docket, public as $$
  select p.id, p.name, p.color, count(t.id) as task_count
  from docket.programs p
  join docket.tasks t on t.program_id = p.id
  where p.archived_at is null
    and t.is_recurring = false
    and t.parent_task_id is null
    and (
      p_view_all
      or t.space_id = any(p_member_space_ids)
      or (
        t.space_id = p_default_space_id and (
          t.owner_employee_id = p_employee
          or t.assignee_employee_id = p_employee
          or t.created_by_user_id = p_user
          or (p_dept is not null and t.department_id = p_dept)
          or exists (select 1 from docket.task_collaborators c where c.task_id = t.id and c.employee_id = p_employee)
        )
      )
    )
  group by p.id, p.name, p.color
  order by p.name asc;
$$;
grant execute on function docket.programs_for_user(uuid,uuid,uuid,boolean,uuid[],uuid) to service_role;

-- 2. list_tasks_by_program — drives the cross-space program view. Same visibility rule,
--    non-recurring; returns top-level tasks AND their sub-tasks (the page nests children
--    under parents, exactly like the space board). The sidebar count badge counts top-level
--    only (programs_for_user), which equals the board's top-level rows.
--    Accepts the same optional filters as list_tasks (minus space/program, which are fixed here).
create or replace function docket.list_tasks_by_program(
  p_user uuid, p_employee uuid, p_dept uuid, p_view_all boolean,
  p_member_space_ids uuid[], p_default_space_id uuid, p_program_id uuid,
  p_status text default null, p_department_id uuid default null,
  p_employee_filter uuid default null, p_priority text default null,
  p_overdue boolean default false, p_revised boolean default false,
  p_mine boolean default false, p_q text default null
) returns setof docket.tasks
language sql stable security definer set search_path = docket, public as $$
  select t.* from docket.tasks t
  where t.program_id = p_program_id
    and t.is_recurring = false
    and (
      p_view_all
      or t.space_id = any(p_member_space_ids)
      or (
        t.space_id = p_default_space_id and (
          t.owner_employee_id = p_employee
          or t.assignee_employee_id = p_employee
          or t.created_by_user_id = p_user
          or (p_dept is not null and t.department_id = p_dept)
          or exists (select 1 from docket.task_collaborators c where c.task_id = t.id and c.employee_id = p_employee)
        )
      )
    )
    and (p_status is null or t.status = p_status)
    and (p_department_id is null or t.department_id = p_department_id)
    and (p_employee_filter is null or t.owner_employee_id = p_employee_filter or t.assignee_employee_id = p_employee_filter)
    and (p_priority is null or t.priority = p_priority)
    and (not p_overdue or (t.status not in ('done','abandoned') and coalesce(t.revised_deadline,t.deadline) < now()))
    and (not p_revised or t.revised_deadline is not null)
    and (not p_mine or t.owner_employee_id = p_employee or t.assignee_employee_id = p_employee
         or t.created_by_user_id = p_user
         or exists (select 1 from docket.task_collaborators c where c.task_id=t.id and c.employee_id=p_employee))
    and (p_q is null or t.title ilike '%'||p_q||'%' or t.task_no ilike '%'||p_q||'%')
  order by
    case t.priority when 'P0' then 0 when 'P1' then 1 when 'P2' then 2 else 3 end,
    coalesce(t.revised_deadline, t.deadline) asc nulls last,
    t.created_at desc;
$$;
grant execute on function docket.list_tasks_by_program(uuid,uuid,uuid,boolean,uuid[],uuid,uuid,text,uuid,uuid,text,boolean,boolean,boolean,text) to service_role;
