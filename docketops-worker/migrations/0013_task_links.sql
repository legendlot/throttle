-- 0013_task_links.sql — F7 task dependencies, modelled on ClickUp
-- (spec docs/superpowers/specs/2026-11-11-docket-dependencies.md)
--
-- One table, two kinds:
--   'blocks'  — directed: from_task_id BLOCKS to_task_id (to_task "is waiting on" from_task)
--   'relates' — undirected, stored canonically (from = least(a,b), to = greatest(a,b))
-- At most ONE link of any kind per pair (blocking AND related is redundant; reverse blocking is a cycle).
--
-- Visibility: links themselves are not secret, the OTHER task is. task_links_for returns raw ids +
-- status (for open counts only); task_cards applies getTask's gate (the same `vis` as search_tasks,
-- RULE-DOCKET-003) and nulls every identifying field of a task the caller can't open.
--
-- Additive + idempotent. Every function is service_role only, like every docket RPC.

begin;

create table if not exists docket.task_links (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('blocks', 'relates')),
  from_task_id uuid not null references docket.tasks(id) on delete cascade,
  to_task_id   uuid not null references docket.tasks(id) on delete cascade,
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  constraint task_links_not_self check (from_task_id <> to_task_id),
  constraint task_links_relates_canonical check (kind <> 'relates' or from_task_id < to_task_id),
  constraint task_links_uq unique (kind, from_task_id, to_task_id)
);
create index if not exists task_links_from on docket.task_links(from_task_id);
create index if not exists task_links_to   on docket.task_links(to_task_id);
alter table docket.task_links enable row level security;
revoke all on docket.task_links from public, anon, authenticated;
grant all on docket.task_links to service_role;

-- ── add ──────────────────────────────────────────────────────────────────────
-- p_kind is from p_task's point of view: 'waiting_on' (p_other blocks p_task), 'blocks'
-- (p_task blocks p_other), 'relates'. The worker has already checked the caller may EDIT p_task and
-- OPEN p_other; this re-checks everything that is about the tasks themselves.
create or replace function docket.add_task_link(p_task uuid, p_other uuid, p_kind text, p_user uuid)
returns jsonb
language plpgsql security definer
set search_path to 'docket', 'public'
as $function$
declare
  t docket.tasks; o docket.tasks;
  v_kind text; v_from uuid; v_to uuid; v_id uuid;
  v_phrase_t text; v_phrase_o text;
begin
  if p_kind not in ('waiting_on', 'blocks', 'relates') then return jsonb_build_object('ok', false, 'code', 'bad_kind'); end if;
  if p_task = p_other then return jsonb_build_object('ok', false, 'code', 'self_link'); end if;
  select * into t from docket.tasks where id = p_task;
  select * into o from docket.tasks where id = p_other;
  if t.id is null or o.id is null then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if t.is_recurring or o.is_recurring then return jsonb_build_object('ok', false, 'code', 'recurring_task'); end if;
  if t.archived_at is not null or o.archived_at is not null then return jsonb_build_object('ok', false, 'code', 'archived_task'); end if;
  if t.status = 'abandoned' then return jsonb_build_object('ok', false, 'code', 'abandoned_read_only'); end if;
  if o.status = 'abandoned' then return jsonb_build_object('ok', false, 'code', 'other_abandoned'); end if;

  if p_kind = 'waiting_on' then v_kind := 'blocks';  v_from := p_other; v_to := p_task;  v_phrase_t := 'waiting on'; v_phrase_o := 'blocks';
  elsif p_kind = 'blocks'  then v_kind := 'blocks';  v_from := p_task;  v_to := p_other; v_phrase_t := 'blocks';     v_phrase_o := 'waiting on';
  else v_kind := 'relates'; v_from := least(p_task, p_other); v_to := greatest(p_task, p_other); v_phrase_t := 'related to'; v_phrase_o := 'related to';
  end if;

  -- One writer at a time, so two concurrent adds can't close a loop neither saw.
  perform pg_advisory_xact_lock(hashtext('docket.task_links'));

  if exists (select 1 from docket.task_links l
             where (l.from_task_id = p_task and l.to_task_id = p_other) or (l.from_task_id = p_other and l.to_task_id = p_task)) then
    return jsonb_build_object('ok', false, 'code', 'already_linked');
  end if;

  if v_kind = 'blocks' and exists (
    with recursive walk(id) as (
      select v_to
      union
      select l.to_task_id from docket.task_links l join walk w on l.from_task_id = w.id where l.kind = 'blocks'
    ) select 1 from walk where id = v_from
  ) then
    return jsonb_build_object('ok', false, 'code', 'cycle');
  end if;

  insert into docket.task_links (kind, from_task_id, to_task_id, created_by_user_id)
  values (v_kind, v_from, v_to, p_user) returning id into v_id;

  insert into docket.task_history (task_id, actor_user_id, event_type, field, new_value, note) values
    (p_task,  p_user, 'link_added', 'dependency', p_other::text, v_phrase_t),
    (p_other, p_user, 'link_added', 'dependency', p_task::text,  v_phrase_o);

  return jsonb_build_object('ok', true, 'link_id', v_id);
end;
$function$;

-- ── remove ───────────────────────────────────────────────────────────────────
-- The worker checks the caller may edit a non-abandoned end before calling.
create or replace function docket.remove_task_link(p_link_id uuid, p_user uuid)
returns jsonb
language plpgsql security definer
set search_path to 'docket', 'public'
as $function$
declare l docket.task_links;
begin
  delete from docket.task_links where id = p_link_id returning * into l;
  if l.id is null then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  insert into docket.task_history (task_id, actor_user_id, event_type, field, old_value, note) values
    (l.from_task_id, p_user, 'link_removed', 'dependency', l.to_task_id::text,
       case when l.kind = 'blocks' then 'blocks' else 'related to' end),
    (l.to_task_id,   p_user, 'link_removed', 'dependency', l.from_task_id::text,
       case when l.kind = 'blocks' then 'waiting on' else 'related to' end);
  return jsonb_build_object('ok', true);
end;
$function$;

-- ── read: raw links for a set of tasks (no gate — ids + status only) ─────────
-- direction is from task_id's point of view. other_status feeds the open counts; the worker never
-- sends a hidden task's status to the browser.
create or replace function docket.task_links_for(p_task_ids uuid[])
returns table(task_id uuid, link_id uuid, kind text, direction text, other_id uuid, other_status text)
language sql stable security definer
set search_path to 'docket', 'public'
as $function$
  select l.to_task_id, l.id, l.kind, case when l.kind = 'blocks' then 'waiting_on' else 'related' end, l.from_task_id, o.status
  from docket.task_links l join docket.tasks o on o.id = l.from_task_id
  where l.to_task_id = any(p_task_ids)
  union all
  select l.from_task_id, l.id, l.kind, case when l.kind = 'blocks' then 'blocking' else 'related' end, l.to_task_id, o.status
  from docket.task_links l join docket.tasks o on o.id = l.to_task_id
  where l.from_task_id = any(p_task_ids);
$function$;

-- ── read: task cards behind getTask's gate ───────────────────────────────────
-- Gate = search_tasks `vis` exactly: a private space needs membership (p_member_space_ids, from the
-- worker's accessibleSpaces — already excludes archived spaces); General needs canSeeTask. An
-- unarchived task only. Invisible rows come back with visible=false and NOTHING else filled.
create or replace function docket.task_cards(
  p_ids uuid[], p_user uuid, p_employee uuid, p_dept uuid, p_view_all boolean,
  p_member_space_ids uuid[], p_default_space_id uuid
)
returns table(id uuid, visible boolean, task_no text, title text, status text,
              owner_employee_id uuid, due timestamptz, space_name text)
language sql stable security definer
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

-- ── unblock history ──────────────────────────────────────────────────────────
-- Called after tasks go done/abandoned. For every task those tasks were blocking that now has NO open
-- blocker left (and is itself still open), write one 'unblocked' row naming one of the closers.
create or replace function docket.log_unblocked(p_closed_ids uuid[], p_actor uuid)
returns int
language sql security definer
set search_path to 'docket', 'public'
as $function$
  with cand as (
    select distinct on (l.to_task_id) l.to_task_id as waiting_id, l.from_task_id as blocker_id, b.status as blocker_status
    from docket.task_links l
    join docket.tasks b on b.id = l.from_task_id and b.status in ('done', 'abandoned')
    join docket.tasks w on w.id = l.to_task_id and w.status not in ('done', 'abandoned')
    where l.kind = 'blocks' and l.from_task_id = any(p_closed_ids)
      and not exists (select 1 from docket.task_links l2 join docket.tasks b2 on b2.id = l2.from_task_id
                      where l2.kind = 'blocks' and l2.to_task_id = l.to_task_id and b2.status not in ('done', 'abandoned'))
    order by l.to_task_id, l.created_at
  ), ins as (
    insert into docket.task_history (task_id, actor_user_id, event_type, field, new_value, note)
    select waiting_id, p_actor, 'unblocked', 'dependency', blocker_id::text, blocker_status from cand
    returning 1
  )
  select count(*)::int from ins;
$function$;

revoke all on function docket.add_task_link(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function docket.remove_task_link(uuid, uuid) from public, anon, authenticated;
revoke all on function docket.task_links_for(uuid[]) from public, anon, authenticated;
revoke all on function docket.task_cards(uuid[], uuid, uuid, uuid, boolean, uuid[], uuid) from public, anon, authenticated;
revoke all on function docket.log_unblocked(uuid[], uuid) from public, anon, authenticated;
grant execute on function docket.add_task_link(uuid, uuid, text, uuid) to service_role;
grant execute on function docket.remove_task_link(uuid, uuid) to service_role;
grant execute on function docket.task_links_for(uuid[]) to service_role;
grant execute on function docket.task_cards(uuid[], uuid, uuid, uuid, boolean, uuid[], uuid) to service_role;
grant execute on function docket.log_unblocked(uuid[], uuid) to service_role;

notify pgrst, 'reload schema';

commit;
