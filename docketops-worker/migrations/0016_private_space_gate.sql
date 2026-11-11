-- 0016 — private spaces hold against docket_admin in the cross-space reads (2026-11-11, Codex review of
-- the F9 plan-layer spec, finding 1 / spec §5.1 A1). RULE-DOCKET-003: a private space is visible to its
-- owner + members only, and "the gate beats admin". These three let p_view_all (docket_admin or
-- docket_view_all) OR past the membership check, so an admin could list and count private-space tasks
-- through a program (list_tasks_by_program / programs_for_user) and see own tasks in spaces they'd left
-- (list_my_tasks). p_view_all now widens only INSIDE General — the shape search_tasks already had.
-- p_member_space_ids = the caller's owned + member private spaces (worker programScopeArgs). Signatures unchanged.

CREATE OR REPLACE FUNCTION docket.list_tasks_by_program(p_user uuid, p_employee uuid, p_dept uuid, p_view_all boolean, p_member_space_ids uuid[], p_default_space_id uuid, p_program_id uuid, p_status text DEFAULT NULL::text, p_department_id uuid DEFAULT NULL::uuid, p_employee_filter uuid DEFAULT NULL::uuid, p_priority text DEFAULT NULL::text, p_overdue boolean DEFAULT false, p_revised boolean DEFAULT false, p_mine boolean DEFAULT false, p_q text DEFAULT NULL::text)
 RETURNS SETOF docket.tasks
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'docket', 'public'
AS $function$
  select t.* from docket.tasks t
  where t.program_id = p_program_id
    and t.is_recurring = false
    and t.archived_at is null
    and (
      t.space_id = any(p_member_space_ids)
      or (
        t.space_id = p_default_space_id and (
          p_view_all
          or t.owner_employee_id = p_employee
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
$function$;

CREATE OR REPLACE FUNCTION docket.list_my_tasks(p_user uuid, p_employee uuid, p_view_all boolean, p_member_space_ids uuid[], p_default_space_id uuid, p_status text DEFAULT NULL::text, p_department_id uuid DEFAULT NULL::uuid, p_priority text DEFAULT NULL::text, p_overdue boolean DEFAULT false, p_revised boolean DEFAULT false, p_program_id uuid DEFAULT NULL::uuid, p_q text DEFAULT NULL::text)
 RETURNS SETOF docket.tasks
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'docket', 'public'
AS $function$
  select t.* from docket.tasks t
  where t.is_recurring = false
    and t.archived_at is null
    and (
      t.owner_employee_id = p_employee
      or exists (select 1 from docket.task_collaborators c where c.task_id = t.id and c.employee_id = p_employee)
      -- tasks I raised but do not own. Guarded so it never duplicates the owner case
      -- and never resurfaces a closed task: a delegated task I no longer need to chase
      -- should leave my list when it is done, exactly like one I own.
      or (
        t.created_by_user_id = p_user
        and t.status not in ('done', 'abandoned')
      )
    )
    and (
      t.space_id = any(p_member_space_ids)
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
$function$;

CREATE OR REPLACE FUNCTION docket.programs_for_user(p_user uuid, p_employee uuid, p_dept uuid, p_view_all boolean, p_member_space_ids uuid[], p_default_space_id uuid)
 RETURNS TABLE(id uuid, name text, color text, task_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'docket', 'public'
AS $function$
  select p.id, p.name, p.color, count(t.id) as task_count
  from docket.programs p
  join docket.tasks t on t.program_id = p.id
  where p.archived_at is null
    and t.is_recurring = false
    and t.parent_task_id is null
    and t.status not in ('done','abandoned')
    and t.archived_at is null
    and (
      t.space_id = any(p_member_space_ids)
      or (
        t.space_id = p_default_space_id and (
          p_view_all
          or t.owner_employee_id = p_employee
          or t.assignee_employee_id = p_employee
          or t.created_by_user_id = p_user
          or (p_dept is not null and t.department_id = p_dept)
          or exists (select 1 from docket.task_collaborators c where c.task_id = t.id and c.employee_id = p_employee)
        )
      )
    )
  group by p.id, p.name, p.color
  order by p.name asc;
$function$;
