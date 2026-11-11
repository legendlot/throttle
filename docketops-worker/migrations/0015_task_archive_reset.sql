-- 0015 — Docket reset 2026-11-11 (Afshaan): tasks.archived_at becomes real ("hidden").
-- archived_at was dormant since S118. search_tasks / list_my_tasks / task_cards / programs_for_user /
-- add_task_link / getStaleTasks / the register already honour it; these four did not. An archived task
-- drops out of every list, count and the dashboard; a direct link (getTask by id) still opens it, so
-- history is kept. Signatures unchanged.
-- Data step (run once, after this): archive every done + abandoned task.
-- Snapshot taken before the reset: store.safety_docket_reset_2026_11_11 (1,201 rows).

CREATE OR REPLACE FUNCTION docket.dashboard_stats(p_space_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'docket', 'public'
AS $function$
  with t as (select * from docket.tasks where space_id=p_space_id and is_recurring=false and archived_at is null)
  select jsonb_build_object(
    'by_status', (select coalesce(jsonb_object_agg(status,c),'{}'::jsonb) from
      (select status, count(*) c from t group by status) s),
    'overdue', (select count(*) from t
       where status not in ('done','abandoned') and coalesce(revised_deadline,deadline) < now()),
    'due_soon', (select count(*) from t
       where status not in ('done','abandoned')
         and coalesce(revised_deadline,deadline) between now() and now() + interval '7 days'),
    'revised', (select count(*) from t where revised_deadline is not null and status not in ('done','abandoned')),
    'completed_30d', (select count(*) from t where status='done' and completed_at > now() - interval '30 days'),
    'by_department', (select coalesce(jsonb_agg(x),'[]'::jsonb) from
      (select d.id dept_id, d.name dept_name,
         count(*) filter (where t.status not in ('done','abandoned')) open,
         count(*) filter (where t.status='done') done,
         count(*) filter (where t.status='blocked') blocked,
         count(*) filter (where t.status not in ('done','abandoned') and coalesce(t.revised_deadline,t.deadline)<now()) overdue
       from t join podium.departments d on d.id=t.department_id
       group by d.id,d.name order by open desc) x),
    'by_person', (select coalesce(jsonb_agg(x),'[]'::jsonb) from
      (select e.id emp_id, e.full_name emp_name,
         count(*) filter (where t.status not in ('done','abandoned')) open,
         count(*) filter (where t.status='done') done,
         count(*) filter (where t.status not in ('done','abandoned') and coalesce(t.revised_deadline,t.deadline)<now()) overdue
       from t join podium.employees e on e.id=t.owner_employee_id
       group by e.id,e.full_name order by open desc) x)
  );
$function$;

CREATE OR REPLACE FUNCTION docket.list_tasks(p_user uuid, p_employee uuid, p_dept uuid, p_view_all boolean, p_space_id uuid, p_status text DEFAULT NULL::text, p_department_id uuid DEFAULT NULL::uuid, p_employee_filter uuid DEFAULT NULL::uuid, p_priority text DEFAULT NULL::text, p_overdue boolean DEFAULT false, p_revised boolean DEFAULT false, p_parent_id uuid DEFAULT NULL::uuid, p_mine boolean DEFAULT false, p_q text DEFAULT NULL::text, p_program_id uuid DEFAULT NULL::uuid)
 RETURNS SETOF docket.tasks
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'docket', 'public'
AS $function$
  with sp as (select is_default from docket.spaces where id = p_space_id)
  select t.* from docket.tasks t, sp
  where t.space_id = p_space_id
  and t.is_recurring = false
  and t.archived_at is null
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
$function$;

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
$function$;

CREATE OR REPLACE FUNCTION docket.space_counts_for_user(p_user uuid, p_employee uuid, p_dept uuid, p_view_all boolean, p_space_ids uuid[])
 RETURNS TABLE(space_id uuid, task_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'docket', 'public'
AS $function$
  select t.space_id, count(*) as task_count
  from docket.tasks t
  join docket.spaces s on s.id = t.space_id
  where t.space_id = any(p_space_ids)
    and t.is_recurring = false
    and t.parent_task_id is null
    and t.status not in ('done','abandoned')
    and t.archived_at is null
    and (
      (not s.is_default)
      or p_view_all
      or t.owner_employee_id = p_employee
      or t.assignee_employee_id = p_employee
      or t.created_by_user_id = p_user
      or (p_dept is not null and t.department_id = p_dept)
      or exists (select 1 from docket.task_collaborators c where c.task_id = t.id and c.employee_id = p_employee)
    )
  group by t.space_id;
$function$;

-- v2: list_my_tasks only checked archived_at on its "tasks I raised" branch, so an archived task I own
-- still listed under My Tasks (found in the live smoke: DKT-981). The filter is now top-level.
-- programs_for_user gets it too (it counts open tasks only, so this is consistency, not a fix).
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
$function$;
