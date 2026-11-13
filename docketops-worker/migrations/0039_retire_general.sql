-- 0039 (docket_retire_general_v1) — General-space rethink, P3c "remove General".
-- P3b (0038) emptied General: every task and record now lives in a team home space or a Personal space. This
-- retires it for good:
-- (1) docket.dashboard_stats_spaces(uuid[]) — the org dashboard over every live team space (the worker passes the
--     ids; it was dashboard_stats(General)). Same output shape as dashboard_stats(uuid), whose live body it copies.
-- (2) General archived — refused if it still holds any task or checklist record.
-- (3) tasks.space_id loses its default (General's literal id, set in 0002). checklist_records.space_id never had
--     one (0032). Every insert names its space; the column stays NOT NULL.
-- (4) A trigger refuses any task / record put into General (insert, or a move in): 'general_retired'. The one SQL
--     caller that still falls back to General is plan_template_apply with no p_payload.space_id (0038) — the
--     worker always sends one, so an old caller now fails loudly instead of filing work into a retired space.

-- 1. dashboard_stats over a set of spaces ─────────────────────────────────────
create or replace function docket.dashboard_stats_spaces(p_space_ids uuid[])
returns jsonb language sql stable security definer set search_path = docket, public as $$
  with t as (select * from docket.tasks where space_id = any(p_space_ids) and is_recurring=false and archived_at is null)
  select jsonb_build_object(
    'by_status', (select coalesce(jsonb_object_agg(status,c),'{}'::jsonb) from (select status, count(*) c from t group by status) s),
    'overdue', (select count(*) from t where status not in ('done','abandoned') and coalesce(revised_deadline,deadline) < now()),
    'due_soon', (select count(*) from t where status not in ('done','abandoned')
                   and coalesce(revised_deadline,deadline) between now() and now() + interval '7 days'),
    'revised', (select count(*) from t where revised_deadline is not null and status not in ('done','abandoned')),
    'completed_30d', (select count(*) from t where status='done' and completed_at > now() - interval '30 days'),
    'by_department', (select coalesce(jsonb_agg(x),'[]'::jsonb) from
      (select d.id dept_id, d.name dept_name,
         count(*) filter (where t.status not in ('done','abandoned')) open,
         count(*) filter (where t.status='done') done,
         count(*) filter (where t.status='blocked') blocked,
         count(*) filter (where t.status not in ('done','abandoned') and coalesce(t.revised_deadline,t.deadline)<now()) overdue
       from t join podium.departments d on d.id=t.department_id group by d.id,d.name order by open desc) x),
    'by_person', (select coalesce(jsonb_agg(x),'[]'::jsonb) from
      (select e.id emp_id, e.full_name emp_name,
         count(*) filter (where t.status not in ('done','abandoned')) open,
         count(*) filter (where t.status='done') done,
         count(*) filter (where t.status not in ('done','abandoned') and coalesce(t.revised_deadline,t.deadline)<now()) overdue
       from t join podium.employees e on e.id=t.owner_employee_id group by e.id,e.full_name order by open desc) x));
$$;
revoke all on function docket.dashboard_stats_spaces(uuid[]) from public, anon, authenticated;
grant execute on function docket.dashboard_stats_spaces(uuid[]) to service_role;

-- 2. archive General (only if empty) ───────────────────────────────────────────
do $m$
declare v_general uuid := (select id from docket.spaces where is_default limit 1);
begin
  if v_general is null then return; end if;
  if exists (select 1 from docket.tasks where space_id = v_general) then
    raise exception 'general_not_empty: General still holds % task(s) — move them first (P3b)', (select count(*) from docket.tasks where space_id = v_general);
  end if;
  if exists (select 1 from docket.checklist_records where space_id = v_general) then
    raise exception 'general_not_empty: General still holds % checklist record(s) — move them first (P3b)', (select count(*) from docket.checklist_records where space_id = v_general);
  end if;
  if exists (select 1 from docket.spaces where id = v_general and archived_at is null) then
    update docket.spaces set archived_at = now() where id = v_general;
    insert into docket.space_history (space_id, action, actor_user_id, note) values (v_general, 'archived', null, 'P3c (0039): General retired');
  end if;
end $m$;

-- 3. no more default space ────────────────────────────────────────────────────
alter table docket.tasks alter column space_id drop default;

-- 4. nothing goes into General ────────────────────────────────────────────────
create or replace function docket.general_retired_guard() returns trigger
language plpgsql set search_path = docket, public as $$
begin
  if tg_op = 'UPDATE' and new.space_id is not distinct from old.space_id then return new; end if;
  if exists (select 1 from docket.spaces s where s.id = new.space_id and s.is_default) then
    raise exception 'general_retired: General is retired — put work in a team space or your Personal space'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke all on function docket.general_retired_guard() from public, anon, authenticated;

drop trigger if exists general_retired_guard on docket.tasks;
create trigger general_retired_guard before insert or update of space_id on docket.tasks
  for each row execute function docket.general_retired_guard();
drop trigger if exists general_retired_guard on docket.checklist_records;
create trigger general_retired_guard before insert or update of space_id on docket.checklist_records
  for each row execute function docket.general_retired_guard();

notify pgrst, 'reload schema';
