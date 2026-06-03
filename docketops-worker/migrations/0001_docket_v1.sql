-- Docket V1 — org task manager schema.
-- Applied to Supabase lot-production as migration `docket_v1` (2026-06-03).
-- Mirror kept here for repo record. store.sequences is (name, current_val).
-- Exposed-schemas: `docket` added to PostgREST db_schemas
--   (ALTER ROLE authenticator SET pgrst.db_schemas = '... , docket'; NOTIFY pgrst).

create schema if not exists docket;
grant usage on schema docket to service_role;

create table docket.tasks (
  id uuid primary key default gen_random_uuid(),
  task_no text unique not null,
  title text not null,
  description text,
  department_id uuid references podium.departments(id),
  owner_employee_id uuid references podium.employees(id),
  assignee_employee_id uuid references podium.employees(id),
  status text not null default 'not_started'
    check (status in ('not_started','in_progress','done','blocked','abandoned')),
  priority text not null default 'P2' check (priority in ('P0','P1','P2','P3')),
  parent_task_id uuid references docket.tasks(id),
  created_by_user_id uuid not null,
  created_at timestamptz not null default now(),
  deadline timestamptz not null,
  revised_deadline timestamptz,
  completed_at timestamptz,
  abandoned_at timestamptz,
  abandoned_by uuid,
  abandon_reason text,
  custom_fields jsonb not null default '{}'::jsonb,
  updated_by uuid,
  updated_at timestamptz
);
create index docket_tasks_status_idx on docket.tasks(status);
create index docket_tasks_priority_idx on docket.tasks(priority);
create index docket_tasks_dept_idx on docket.tasks(department_id);
create index docket_tasks_owner_idx on docket.tasks(owner_employee_id);
create index docket_tasks_assignee_idx on docket.tasks(assignee_employee_id);
create index docket_tasks_parent_idx on docket.tasks(parent_task_id);
create index docket_tasks_creator_idx on docket.tasks(created_by_user_id);
create index docket_tasks_eff_deadline_idx on docket.tasks((coalesce(revised_deadline, deadline)));

create table docket.task_collaborators (
  task_id uuid not null references docket.tasks(id) on delete cascade,
  employee_id uuid not null references podium.employees(id),
  added_by uuid, added_at timestamptz not null default now(),
  primary key (task_id, employee_id)
);

create table docket.task_documents (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references docket.tasks(id) on delete cascade,
  title text, url text not null,
  added_by uuid, added_at timestamptz not null default now()
);
create index docket_task_documents_task_idx on docket.task_documents(task_id);

create table docket.task_comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references docket.tasks(id) on delete cascade,
  author_user_id uuid not null, body text not null,
  created_at timestamptz not null default now(),
  edited_at timestamptz, deleted_at timestamptz
);
create index docket_task_comments_task_idx on docket.task_comments(task_id);

create table docket.task_history (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references docket.tasks(id) on delete cascade,
  actor_user_id uuid, event_type text not null,
  field text, old_value text, new_value text, note text,
  created_at timestamptz not null default now()
);
create index docket_task_history_task_idx on docket.task_history(task_id, created_at);

do $$ declare t text; begin
  foreach t in array array['tasks','task_collaborators','task_documents','task_comments','task_history']
  loop
    execute format('alter table docket.%I enable row level security;', t);
    execute format('grant all on docket.%I to service_role;', t);
  end loop;
end $$;

insert into store.sequences (name, current_val) values ('docket_task', 0)
  on conflict (name) do nothing;

create or replace function docket.next_task_seq()
returns text language plpgsql security definer set search_path = store, public as $$
declare v_next bigint;
begin
  insert into store.sequences(name, current_val) values ('docket_task', 0)
    on conflict (name) do nothing;
  update store.sequences set current_val = current_val + 1
    where name = 'docket_task' returning current_val into v_next;
  return 'DKT-' || v_next::text;
end $$;
grant execute on function docket.next_task_seq() to service_role;

create or replace function docket.list_tasks(
  p_user uuid, p_employee uuid, p_dept uuid, p_view_all boolean,
  p_status text default null, p_department_id uuid default null,
  p_employee_filter uuid default null, p_priority text default null,
  p_overdue boolean default false, p_revised boolean default false,
  p_parent_id uuid default null, p_mine boolean default false, p_q text default null
) returns setof docket.tasks language sql stable security definer set search_path = docket, public as $$
  select t.* from docket.tasks t
  where (
    p_view_all
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
  and (not p_mine or t.owner_employee_id = p_employee or t.assignee_employee_id = p_employee
       or t.created_by_user_id = p_user
       or exists (select 1 from docket.task_collaborators c where c.task_id=t.id and c.employee_id=p_employee))
  and (p_q is null or t.title ilike '%'||p_q||'%' or t.task_no ilike '%'||p_q||'%')
  order by
    case t.priority when 'P0' then 0 when 'P1' then 1 when 'P2' then 2 else 3 end,
    coalesce(t.revised_deadline, t.deadline) asc nulls last,
    t.created_at desc;
$$;
grant execute on function docket.list_tasks(uuid,uuid,uuid,boolean,text,uuid,uuid,text,boolean,boolean,uuid,boolean,text) to service_role;

create table if not exists store.docket_roles (
  role_key text primary key,
  label text not null, description text,
  permissions jsonb not null default '{}'::jsonb,
  is_system boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz
);
create table if not exists store.docket_user_roles (
  user_id uuid primary key,
  role_key text not null references store.docket_roles(role_key),
  assigned_by uuid, assigned_at timestamptz not null default now()
);
alter table store.docket_roles enable row level security;
alter table store.docket_user_roles enable row level security;
grant all on store.docket_roles to service_role;
grant all on store.docket_user_roles to service_role;

insert into store.docket_roles (role_key,label,description,permissions,is_system) values
  ('admin','Admin','Full Docket administration + see all tasks',
     '{"docket_admin":true,"docket_view_all":true}'::jsonb, true),
  ('employee','Employee','Baseline — own + collaborator + own-department tasks',
     '{}'::jsonb, true),
  ('reviewer','Reviewer','Org-wide task visibility + review dashboard (no admin)',
     '{"docket_view_all":true}'::jsonb, false)
on conflict (role_key) do nothing;

create or replace function docket.dashboard_stats()
returns jsonb language sql stable security definer set search_path = docket, public as $$
  select jsonb_build_object(
    'by_status', (select coalesce(jsonb_object_agg(status,c),'{}'::jsonb) from
      (select status, count(*) c from docket.tasks group by status) s),
    'overdue', (select count(*) from docket.tasks
       where status not in ('done','abandoned') and coalesce(revised_deadline,deadline) < now()),
    'due_soon', (select count(*) from docket.tasks
       where status not in ('done','abandoned')
         and coalesce(revised_deadline,deadline) between now() and now() + interval '7 days'),
    'revised', (select count(*) from docket.tasks where revised_deadline is not null and status not in ('done','abandoned')),
    'completed_30d', (select count(*) from docket.tasks where status='done' and completed_at > now() - interval '30 days'),
    'by_department', (select coalesce(jsonb_agg(x),'[]'::jsonb) from
      (select d.id dept_id, d.name dept_name,
         count(*) filter (where t.status not in ('done','abandoned')) open,
         count(*) filter (where t.status='done') done,
         count(*) filter (where t.status='blocked') blocked,
         count(*) filter (where t.status not in ('done','abandoned') and coalesce(t.revised_deadline,t.deadline)<now()) overdue
       from docket.tasks t join podium.departments d on d.id=t.department_id
       group by d.id,d.name order by open desc) x),
    'by_person', (select coalesce(jsonb_agg(x),'[]'::jsonb) from
      (select e.id emp_id, e.full_name emp_name,
         count(*) filter (where t.status not in ('done','abandoned')) open,
         count(*) filter (where t.status='done') done,
         count(*) filter (where t.status not in ('done','abandoned') and coalesce(t.revised_deadline,t.deadline)<now()) overdue
       from docket.tasks t join podium.employees e on e.id=t.owner_employee_id
       group by e.id,e.full_name order by open desc) x)
  );
$$;
grant execute on function docket.dashboard_stats() to service_role;
