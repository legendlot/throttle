-- Docket — Programs + Spaces.
-- Applied to Supabase lot-production as migration `docket_programs_and_spaces_v1` (2026-06-05).
-- Mirror kept here for repo record.
--
-- Program = soft, global grouping label (no access effect). Space = hard access partition:
-- every task lives in exactly one space; General (is_default) is the open default and
-- preserves V1 behaviour; private spaces are membership-gated and hide tasks even from
-- docket_admin/docket_view_all (strict separation). Anyone creates+owns private spaces.
-- See docs/superpowers/specs/2026-06-05-docket-programs-spaces-design.md + RULE-DOCKET-003/004.

-- 1. spaces ────────────────────────────────────────────────────────────────
create table docket.spaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  is_default boolean not null default false,
  is_private boolean not null default true,
  owner_user_id uuid,
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create unique index docket_spaces_one_default on docket.spaces(is_default) where is_default;

create table docket.space_members (
  space_id uuid not null references docket.spaces(id) on delete cascade,
  user_id uuid not null,
  added_by_user_id uuid,
  added_at timestamptz not null default now(),
  primary key (space_id, user_id)
);
create index docket_space_members_user_idx on docket.space_members(user_id);

create table docket.programs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text,
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create unique index docket_programs_name_uniq on docket.programs(lower(name)) where archived_at is null;

create table docket.space_history (
  id bigint generated always as identity primary key,
  space_id uuid not null references docket.spaces(id) on delete cascade,
  action text not null,   -- created/member_added/member_removed/renamed/archived/ownership_transferred/admin_recovered
  actor_user_id uuid,
  note text,
  at timestamptz not null default now()
);
create index docket_space_history_space_idx on docket.space_history(space_id, at);

-- RLS + grants (service_role only; RULE-RLS-001)
do $$ declare t text; begin
  foreach t in array array['spaces','space_members','programs','space_history'] loop
    execute format('alter table docket.%I enable row level security;', t);
    execute format('grant all on docket.%I to service_role;', t);
  end loop;
end $$;
grant usage, select on all sequences in schema docket to service_role;

-- 2. seed General (the one open default space) ───────────────────────────────
insert into docket.spaces (name, is_default, is_private, owner_user_id)
  values ('General', true, false, null);

-- 3. tasks columns — deadline is already nullable (V2). Backfill space_id → General.
alter table docket.tasks add column space_id uuid references docket.spaces(id);
alter table docket.tasks add column program_id uuid references docket.programs(id);
update docket.tasks set space_id = (select id from docket.spaces where is_default) where space_id is null;
alter table docket.tasks alter column space_id set not null;
-- DEFAULT can't be a subquery → set General's literal id via dynamic SQL.
do $$ declare v_general uuid; begin
  select id into v_general from docket.spaces where is_default;
  execute format('alter table docket.tasks alter column space_id set default %L', v_general);
end $$;
create index docket_tasks_space_idx on docket.tasks(space_id);
create index docket_tasks_program_idx on docket.tasks(program_id);

-- 4. list_tasks v2 — space-aware. Drop the old 13-arg signature first (avoid overload ambiguity).
drop function if exists docket.list_tasks(uuid,uuid,uuid,boolean,text,uuid,uuid,text,boolean,boolean,uuid,boolean,text);
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
  and (
    -- private space: caller membership is enforced by the worker before this call,
    -- so all in-space tasks are visible (flat — no dept sub-gating inside a private space)
    (not sp.is_default)
    -- General (open default): existing baseline visibility
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
grant execute on function docket.list_tasks(uuid,uuid,uuid,boolean,uuid,text,uuid,uuid,text,boolean,boolean,uuid,boolean,text,uuid) to service_role;

-- 5. dashboard_stats v2 — scoped to one space. Drop the old no-arg signature first.
drop function if exists docket.dashboard_stats();
create or replace function docket.dashboard_stats(p_space_id uuid)
returns jsonb language sql stable security definer set search_path = docket, public as $$
  select jsonb_build_object(
    'by_status', (select coalesce(jsonb_object_agg(status,c),'{}'::jsonb) from
      (select status, count(*) c from docket.tasks where space_id=p_space_id group by status) s),
    'overdue', (select count(*) from docket.tasks
       where space_id=p_space_id and status not in ('done','abandoned') and coalesce(revised_deadline,deadline) < now()),
    'due_soon', (select count(*) from docket.tasks
       where space_id=p_space_id and status not in ('done','abandoned')
         and coalesce(revised_deadline,deadline) between now() and now() + interval '7 days'),
    'revised', (select count(*) from docket.tasks where space_id=p_space_id and revised_deadline is not null and status not in ('done','abandoned')),
    'completed_30d', (select count(*) from docket.tasks where space_id=p_space_id and status='done' and completed_at > now() - interval '30 days'),
    'by_department', (select coalesce(jsonb_agg(x),'[]'::jsonb) from
      (select d.id dept_id, d.name dept_name,
         count(*) filter (where t.status not in ('done','abandoned')) open,
         count(*) filter (where t.status='done') done,
         count(*) filter (where t.status='blocked') blocked,
         count(*) filter (where t.status not in ('done','abandoned') and coalesce(t.revised_deadline,t.deadline)<now()) overdue
       from docket.tasks t join podium.departments d on d.id=t.department_id
       where t.space_id=p_space_id group by d.id,d.name order by open desc) x),
    'by_person', (select coalesce(jsonb_agg(x),'[]'::jsonb) from
      (select e.id emp_id, e.full_name emp_name,
         count(*) filter (where t.status not in ('done','abandoned')) open,
         count(*) filter (where t.status='done') done,
         count(*) filter (where t.status not in ('done','abandoned') and coalesce(t.revised_deadline,t.deadline)<now()) overdue
       from docket.tasks t join podium.employees e on e.id=t.owner_employee_id
       where t.space_id=p_space_id group by e.id,e.full_name order by open desc) x)
  );
$$;
grant execute on function docket.dashboard_stats(uuid) to service_role;
