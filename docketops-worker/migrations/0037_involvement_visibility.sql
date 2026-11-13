-- 0037 (docket_involvement_visibility_v1) — General-space rethink, P3a "Involvement opens the task".
-- Afshaan 2026-11-13: a task's owner, assignee, collaborators and hand-off receivers see it in ANY space except the
-- Founders' space, without access to that space. It opens THAT task only (the space stays out of their sidebar; the
-- worker's loadTaskFor / keepAccessible carry the same rule for by-id and bulk). The Founders' space stays sealed.
-- The plan admins' "every team space" half needs no SQL: the worker passes those spaces in p_member_space_ids.
--
-- Each list / search / card function keeps its body as live (2026-11-13) and gains ONE clause beside the space test:
--   or (<the task's space is live and not the Founders' space> and (owner = p_employee or assignee = p_employee
--       or a collaborator row or <a hand-off receiver: handoff_to_department_id set, owner is not the caller, and the
--       named receiver is the caller or the receiving team is the caller's>))
-- "Live" (archived_at is null) keeps parity with every list: accessibleSpaces never passes an archived space, so a
-- member never sees an archived space's tasks here either (by id they still open, member or involved).
-- list_my_tasks has no p_dept, so its receiver part is the named receiver only (and its row predicate already asks
-- for owner / collaborator / own open creation, so the clause only opens those rows' spaces).
-- Unchanged on purpose: list_tasks (one space, gated by canAccessSpace) and space_counts_for_user.
-- In General the clause adds the hand-off receiver to the lists (the worker's canSeeTask already opened it by id).

create or replace function docket.list_my_tasks(p_user uuid, p_employee uuid, p_view_all boolean, p_member_space_ids uuid[], p_default_space_id uuid, p_status text default null::text, p_department_id uuid default null::uuid, p_priority text default null::text, p_overdue boolean default false, p_revised boolean default false, p_program_id uuid default null::uuid, p_q text default null::text)
 returns setof docket.tasks
 language sql
 stable security definer
 set search_path to 'docket', 'public'
as $function$
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
      -- 0037 (P3a): involvement opens the task in any live space but the Founders' space
      or (
        exists (select 1 from docket.spaces s where s.id = t.space_id and not s.is_founders and s.archived_at is null)
        and (
          t.owner_employee_id = p_employee
          or t.assignee_employee_id = p_employee
          or exists (select 1 from docket.task_collaborators c where c.task_id = t.id and c.employee_id = p_employee)
          or (t.handoff_to_department_id is not null and t.owner_employee_id is distinct from p_employee
              and t.handoff_to_employee_id = p_employee)
        )
      )
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

create or replace function docket.list_tasks_by_program(p_user uuid, p_employee uuid, p_dept uuid, p_view_all boolean, p_member_space_ids uuid[], p_default_space_id uuid, p_program_id uuid, p_status text default null::text, p_department_id uuid default null::uuid, p_employee_filter uuid default null::uuid, p_priority text default null::text, p_overdue boolean default false, p_revised boolean default false, p_mine boolean default false, p_q text default null::text)
 returns setof docket.tasks
 language sql
 stable security definer
 set search_path to 'docket', 'public'
as $function$
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
      -- 0037 (P3a): involvement opens the task in any live space but the Founders' space
      or (
        exists (select 1 from docket.spaces s where s.id = t.space_id and not s.is_founders and s.archived_at is null)
        and (
          t.owner_employee_id = p_employee
          or t.assignee_employee_id = p_employee
          or exists (select 1 from docket.task_collaborators c where c.task_id = t.id and c.employee_id = p_employee)
          or (t.handoff_to_department_id is not null and t.owner_employee_id is distinct from p_employee
              and (t.handoff_to_employee_id = p_employee or (p_dept is not null and t.handoff_to_department_id = p_dept)))
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

create or replace function docket.programs_for_user(p_user uuid, p_employee uuid, p_dept uuid, p_view_all boolean, p_member_space_ids uuid[], p_default_space_id uuid)
 returns table(id uuid, name text, color text, task_count bigint)
 language sql
 stable security definer
 set search_path to 'docket', 'public'
as $function$
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
      -- 0037 (P3a): involvement opens the task in any live space but the Founders' space
      or (
        exists (select 1 from docket.spaces s where s.id = t.space_id and not s.is_founders and s.archived_at is null)
        and (
          t.owner_employee_id = p_employee
          or t.assignee_employee_id = p_employee
          or exists (select 1 from docket.task_collaborators c where c.task_id = t.id and c.employee_id = p_employee)
          or (t.handoff_to_department_id is not null and t.owner_employee_id is distinct from p_employee
              and (t.handoff_to_employee_id = p_employee or (p_dept is not null and t.handoff_to_department_id = p_dept)))
        )
      )
    )
  group by p.id, p.name, p.color
  order by p.name asc;
$function$;

create or replace function docket.search_tasks(p_user uuid, p_employee uuid, p_dept uuid, p_view_all boolean, p_member_space_ids uuid[], p_default_space_id uuid, p_q text, p_num text default null::text, p_limit integer default 20)
 returns table(id uuid, task_no text, title text, status text, priority text, space_id uuid, space_name text, parent_task_id uuid, parent_task_no text, parent_title text, owner_employee_id uuid, deadline timestamp with time zone, revised_deadline timestamp with time zone, match_rank integer)
 language sql
 stable security definer
 set search_path to 'docket', 'public', 'extensions'
as $function$
  with q as (
    select lower(btrim(coalesce(p_q, ''))) as raw
  ), qq as (
    select raw,
      case when p_num ~ '^[0-9]{1,7}$' then p_num end as num,   -- digits only: it goes into a LIKE
      -- ILIKE-escape (\ % _) once, for the prefix test and each term
      replace(replace(replace(raw, '\', '\\'), '%', '\%'), '_', '\_') as esc,
      (select coalesce(array_agg(replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_')), '{}')
         from (select w from unnest(regexp_split_to_array(raw, '\s+')) w where w <> '' limit 8) s) as terms
    from q
  ), vis as (
    select t.* from docket.tasks t
    where t.is_recurring = false
      and t.archived_at is null
      and (
        t.space_id = any(coalesce(p_member_space_ids, '{}'))
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
        -- 0037 (P3a): involvement opens the task in any live space but the Founders' space (a parent's crumb
        -- below comes from `vis` too, so it shows only when the parent is itself visible)
        or (
          exists (select 1 from docket.spaces s where s.id = t.space_id and not s.is_founders and s.archived_at is null)
          and (
            t.owner_employee_id = p_employee
            or t.assignee_employee_id = p_employee
            or exists (select 1 from docket.task_collaborators c where c.task_id = t.id and c.employee_id = p_employee)
            or (t.handoff_to_department_id is not null and t.owner_employee_id is distinct from p_employee
                and (t.handoff_to_employee_id = p_employee or (p_dept is not null and t.handoff_to_department_id = p_dept)))
          )
        )
      )
  ), scored as (
    select m.*,
      case
        when qq.num is not null and m.task_no = 'DKT-' || qq.num then 0
        when qq.num is not null and m.task_no like 'DKT-' || qq.num || '%' then 1
        when qq.esc <> '' and m.title ilike qq.esc || '%' then 2
        when cardinality(qq.terms) > 0 and not exists (
          select 1 from unnest(qq.terms) w
          where not (m.title ilike '%' || w || '%' or (w ~ '[0-9]' and m.task_no ilike '%' || w || '%'))
        ) then 3
        when length(qq.raw) >= 4 and word_similarity(qq.raw, lower(m.title)) >= 0.4 then 4
        else 9
      end as rnk,
      case when length(qq.raw) >= 4 then word_similarity(qq.raw, lower(m.title)) else 0 end as sim
    from vis m, qq
    where qq.raw <> '' or qq.num is not null
  )
  select s.id, s.task_no, s.title, s.status, s.priority,
         s.space_id, sp.name, s.parent_task_id, p.task_no, p.title,
         s.owner_employee_id, s.deadline, s.revised_deadline, s.rnk
  from scored s
  join docket.spaces sp on sp.id = s.space_id
  left join vis p on p.id = s.parent_task_id
  where s.rnk < 4 or (s.rnk = 4 and not exists (select 1 from scored x where x.rnk < 4))
  order by s.rnk, (s.status in ('done', 'abandoned')), s.sim desc, coalesce(s.updated_at, s.created_at) desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
$function$;

create or replace function docket.task_cards(p_ids uuid[], p_user uuid, p_employee uuid, p_dept uuid, p_view_all boolean, p_member_space_ids uuid[], p_default_space_id uuid)
 returns table(id uuid, visible boolean, task_no text, title text, status text, owner_employee_id uuid, due timestamp with time zone, space_name text)
 language sql
 stable security definer
 set search_path to 'docket', 'public'
as $function$
  with v as (
    select t.*, (
      t.archived_at is null and (
        t.space_id = any(coalesce(p_member_space_ids, '{}'))
        or (t.space_id = p_default_space_id and (
          p_view_all
          or t.owner_employee_id = p_employee
          or t.assignee_employee_id = p_employee
          or t.created_by_user_id = p_user
          or (p_dept is not null and t.department_id = p_dept)
          or exists (select 1 from docket.task_collaborators c where c.task_id = t.id and c.employee_id = p_employee)
        ))
        -- 0037 (P3a): involvement opens the task in any live space but the Founders' space
        or (
          exists (select 1 from docket.spaces s where s.id = t.space_id and not s.is_founders and s.archived_at is null)
          and (
            t.owner_employee_id = p_employee
            or t.assignee_employee_id = p_employee
            or exists (select 1 from docket.task_collaborators c where c.task_id = t.id and c.employee_id = p_employee)
            or (t.handoff_to_department_id is not null and t.owner_employee_id is distinct from p_employee
                and (t.handoff_to_employee_id = p_employee or (p_dept is not null and t.handoff_to_department_id = p_dept)))
          )
        )
      )
    ) as ok
    from docket.tasks t where t.id = any(p_ids)
  )
  select v.id, v.ok,
         case when v.ok then v.task_no end, case when v.ok then v.title end, case when v.ok then v.status end,
         case when v.ok then v.owner_employee_id end,
         case when v.ok then coalesce(v.revised_deadline, v.deadline) end,
         case when v.ok then sp.name end
  from v left join docket.spaces sp on sp.id = v.space_id;
$function$;

revoke all on function docket.list_my_tasks(uuid, uuid, boolean, uuid[], uuid, text, uuid, text, boolean, boolean, uuid, text) from public, anon, authenticated;
grant execute on function docket.list_my_tasks(uuid, uuid, boolean, uuid[], uuid, text, uuid, text, boolean, boolean, uuid, text) to service_role;
revoke all on function docket.list_tasks_by_program(uuid, uuid, uuid, boolean, uuid[], uuid, uuid, text, uuid, uuid, text, boolean, boolean, boolean, text) from public, anon, authenticated;
grant execute on function docket.list_tasks_by_program(uuid, uuid, uuid, boolean, uuid[], uuid, uuid, text, uuid, uuid, text, boolean, boolean, boolean, text) to service_role;
revoke all on function docket.programs_for_user(uuid, uuid, uuid, boolean, uuid[], uuid) from public, anon, authenticated;
grant execute on function docket.programs_for_user(uuid, uuid, uuid, boolean, uuid[], uuid) to service_role;
revoke all on function docket.search_tasks(uuid, uuid, uuid, boolean, uuid[], uuid, text, text, integer) from public, anon, authenticated;
grant execute on function docket.search_tasks(uuid, uuid, uuid, boolean, uuid[], uuid, text, text, integer) to service_role;
revoke all on function docket.task_cards(uuid[], uuid, uuid, uuid, boolean, uuid[], uuid) from public, anon, authenticated;
grant execute on function docket.task_cards(uuid[], uuid, uuid, uuid, boolean, uuid[], uuid) to service_role;
