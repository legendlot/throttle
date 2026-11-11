-- 0017_plan_items.sql — F9 Release 1: the plan container (themes → milestones → results)
-- (spec docs/superpowers/specs/2026-11-11-docket-plan-layer.md §4.1, §4.3 minus split, §5.2–5.3, §12 R1)
--
-- One table, three kinds, one append-only history. EVERY write is a docket.plan_* RPC that writes its
-- history row in the same transaction (plan_create / plan_update / plan_act) — never PATCH + history.
-- The permission matrix lives here (plan_can + plan_state_ok); docketops-worker/src/plan-core.mjs is its
-- JS mirror for UI affordances and must agree with it.
--
-- Reads go through ONE projection, plan_items_for(viewer): super admin (docket_plan_admin) → every row at
-- level F; everyone else → the milestones/results they own + results under milestones they own at level
-- O (no target_text), plus every UNRESTRICTED theme at level T (id, kind, code, title, sort, state only).
-- A restricted theme's subtree never leaves level F.
--
-- p_is_super is decided by the worker from Docket's own role layer (as p_view_all is for tasks).
-- Seeds ONE row: the system role `super_admin`. It is assigned to nobody here. No plan content is seeded
-- (decisions 2026-11-11: "The build does not populate Docket").
--
-- Additive + idempotent. Every function is service_role only, like every docket RPC.

begin;

-- ── tables ───────────────────────────────────────────────────────────────────
create table if not exists docket.plan_items (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('theme', 'milestone', 'result')),
  code text not null,
  parent_id uuid references docket.plan_items(id),
  title text not null check (btrim(title) <> ''),
  owner_employee_id uuid references podium.employees(id),
  department_id uuid references podium.departments(id),
  target_text text,
  done_when text,
  measure jsonb,
  due_date date,
  revised_due_date date,
  state text not null default 'proposed' check (state in ('proposed', 'agreed', 'done', 'split', 'dropped')),
  split_from_id uuid references docket.plan_items(id),
  restricted boolean not null default false,
  sort int not null default 0,
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_by_user_id uuid,
  updated_at timestamptz,
  agreed_by_user_id uuid,
  agreed_at timestamptz,
  done_by_user_id uuid,
  done_at timestamptz,
  done_evidence text,
  dropped_by_user_id uuid,
  dropped_at timestamptz,
  drop_reason text,
  constraint plan_items_code_uq unique (code),
  -- themes: no parent, no date, state agreed (active) / dropped (retired) only
  constraint plan_items_theme_shape check (kind <> 'theme' or (parent_id is null and due_date is null
    and revised_due_date is null and state in ('agreed', 'dropped'))),
  -- milestone + result: an owner always; a date and a done-when once committed (a proposal is a draft)
  constraint plan_items_owner_req check (kind = 'theme' or owner_employee_id is not null),
  constraint plan_items_committed check (kind = 'theme' or state not in ('agreed', 'done', 'split')
    or (due_date is not null and done_when is not null and btrim(done_when) <> '')),
  constraint plan_items_restricted_theme check (not restricted or kind = 'theme'),
  constraint plan_items_revised_needs_due check (revised_due_date is null or due_date is not null)
);
create index if not exists plan_items_parent on docket.plan_items(parent_id);
create index if not exists plan_items_owner  on docket.plan_items(owner_employee_id);
alter table docket.plan_items enable row level security;
revoke all on docket.plan_items from public, anon, authenticated;
grant all on docket.plan_items to service_role;

create table if not exists docket.plan_item_history (
  id bigint generated always as identity primary key,
  item_id uuid not null references docket.plan_items(id),
  event text not null check (event in ('created', 'agreed', 'redated', 'split', 'dropped', 'done', 'reopened',
                                       'owner_changed', 'field_changed', 'moved')),
  old jsonb,
  new jsonb,
  note text,
  actor_user_id uuid,
  source text not null default 'app',
  at timestamptz not null default now()
);
create index if not exists plan_item_history_item on docket.plan_item_history(item_id, at desc);
alter table docket.plan_item_history enable row level security;
revoke all on docket.plan_item_history from public, anon, authenticated;
grant all on docket.plan_item_history to service_role;

-- ── shape trigger: theme ← milestone ← result; kind never changes; restricted only on themes ─────
create or replace function docket.plan_items_shape()
returns trigger
language plpgsql
set search_path to 'docket', 'public'
as $function$
declare pk text;
begin
  if tg_op = 'UPDATE' and new.kind <> old.kind then
    raise exception 'plan_items: kind never changes' using errcode = 'check_violation';
  end if;
  if new.kind = 'theme' then
    if new.parent_id is not null then raise exception 'plan_items: a theme has no parent' using errcode = 'check_violation'; end if;
  else
    select kind into pk from docket.plan_items where id = new.parent_id;
    if new.kind = 'milestone' and pk is distinct from 'theme' then
      raise exception 'plan_items: a milestone sits under a theme' using errcode = 'check_violation';
    end if;
    if new.kind = 'result' and pk is distinct from 'milestone' then
      raise exception 'plan_items: a result sits under a milestone' using errcode = 'check_violation';
    end if;
  end if;
  if new.restricted and new.kind <> 'theme' then
    raise exception 'plan_items: only a theme is restricted' using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;
drop trigger if exists plan_items_shape on docket.plan_items;
create trigger plan_items_shape before insert or update of kind, parent_id, restricted on docket.plan_items
  for each row execute function docket.plan_items_shape();

-- History is append-only.
create or replace function docket.plan_item_history_append_only()
returns trigger
language plpgsql
as $function$
begin
  raise exception 'plan_item_history is append-only' using errcode = 'insufficient_privilege';
end;
$function$;
drop trigger if exists plan_item_history_append_only on docket.plan_item_history;
create trigger plan_item_history_append_only before update or delete on docket.plan_item_history
  for each row execute function docket.plan_item_history_append_only();

-- ── the matrix (mirror: plan-core.mjs canPlanAct / planStateAllows) ──────────
-- WHO. Themes + milestones: super only. Results: edit (title/done_when/measure) + done → its owner or the
-- milestone owner; create / owner / redate → the milestone owner; edit_admin / drop / reopen → super.
create or replace function docket.plan_can(p_kind text, p_action text, p_super boolean, p_owner boolean, p_parent_owner boolean)
returns boolean
language sql immutable
set search_path to 'docket', 'public'
as $function$
  select case
    when p_kind not in ('theme', 'milestone', 'result') then false
    when p_action not in ('create', 'edit', 'edit_admin', 'owner', 'agree', 'redate', 'drop', 'done', 'reopen') then false
    when coalesce(p_super, false) then true
    when p_kind <> 'result' then false
    when p_action in ('edit', 'done') then coalesce(p_owner, false) or coalesce(p_parent_owner, false)
    when p_action in ('create', 'owner', 'redate') then coalesce(p_parent_owner, false)
    else false
  end;
$function$;

-- WHEN. split is terminal and read-only (R3 builds it).
create or replace function docket.plan_state_ok(p_kind text, p_action text, p_state text)
returns boolean
language sql immutable
set search_path to 'docket', 'public'
as $function$
  select coalesce(case p_action
    when 'edit'       then p_state in ('proposed', 'agreed')
    when 'edit_admin' then p_state in ('proposed', 'agreed')
    when 'owner'      then p_state in ('proposed', 'agreed')
    when 'agree'      then p_kind = 'milestone' and p_state = 'proposed'
    when 'redate'     then p_kind <> 'theme' and p_state = 'agreed'
    when 'drop'       then case when p_kind = 'milestone' then p_state in ('proposed', 'agreed') else p_state = 'agreed' end
    when 'done'       then p_kind <> 'theme' and p_state = 'agreed'
    when 'reopen'     then case when p_kind = 'theme' then p_state = 'dropped' else p_state in ('done', 'dropped') end
    else false
  end, false);
$function$;

-- Is the item inside a restricted theme's subtree (the theme itself included)?
create or replace function docket.plan_restricted(p_id uuid)
returns boolean
language sql stable
set search_path to 'docket', 'public'
as $function$
  select coalesce(case i.kind when 'theme' then i.restricted when 'milestone' then p.restricted else g.restricted end, false)
  from docket.plan_items i
  left join docket.plan_items p on p.id = i.parent_id
  left join docket.plan_items g on g.id = p.parent_id
  where i.id = p_id;
$function$;

-- The fields a history row records.
create or replace function docket.plan_snap(r docket.plan_items)
returns jsonb
language sql immutable
set search_path to 'docket', 'public'
as $function$
  select jsonb_build_object(
    'code', r.code, 'title', r.title, 'parent_id', r.parent_id,
    'owner_employee_id', r.owner_employee_id, 'department_id', r.department_id,
    'target_text', r.target_text, 'done_when', r.done_when, 'measure', r.measure,
    'due_date', r.due_date, 'revised_due_date', r.revised_due_date, 'state', r.state,
    'restricted', r.restricted, 'sort', r.sort);
$function$;

-- Next auto code: theme T01…, milestone M01… (global), result <milestone code>.R1… Never truncates past 99.
create or replace function docket.plan_next_code(p_kind text, p_parent_code text)
returns text
language sql stable
set search_path to 'docket', 'public'
as $function$
  with n as (
    select case p_kind
      when 'theme' then coalesce(max(case when code ~ '^T[0-9]{1,6}$' then substring(code from 2)::int end), 0) + 1
      when 'milestone' then coalesce(max(case when code ~ '^M[0-9]{1,6}$' then substring(code from 2)::int end), 0) + 1
      else coalesce(max(case when left(code, length(p_parent_code) + 2) = p_parent_code || '.R'
                              and substring(code from length(p_parent_code) + 3) ~ '^[0-9]{1,6}$'
                             then substring(code from length(p_parent_code) + 3)::int end), 0) + 1
    end as v
    from docket.plan_items
  )
  select case p_kind
    when 'theme' then 'T' || case when v < 10 then '0' || v else v::text end
    when 'milestone' then 'M' || case when v < 10 then '0' || v else v::text end
    else p_parent_code || '.R' || v
  end from n;
$function$;

-- ── create ───────────────────────────────────────────────────────────────────
-- p_item: { kind, parent_id?, title, code?, owner_employee_id?, department_id?, target_text?, done_when?,
--           measure?, due_date?, restricted?, sort?, state? (milestone only: proposed | agreed) }
create or replace function docket.plan_create(p_actor uuid, p_actor_employee uuid, p_is_super boolean, p_item jsonb)
returns jsonb
language plpgsql security definer
set search_path to 'docket', 'public'
as $function$
declare
  v_super boolean := coalesce(p_is_super, false);
  v_kind text := p_item->>'kind';
  v_parent docket.plan_items;
  v_parent_owner boolean := false;
  v_title text := nullif(btrim(coalesce(p_item->>'title', '')), '');
  v_code text := nullif(btrim(coalesce(p_item->>'code', '')), '');
  v_done_when text := nullif(btrim(coalesce(p_item->>'done_when', '')), '');
  v_target text := nullif(btrim(coalesce(p_item->>'target_text', '')), '');
  v_owner uuid; v_dept uuid; v_emp_dept uuid; v_status text;
  v_measure jsonb; v_due date; v_state text; v_restricted boolean := false; v_sort int;
  v_missing text[] := '{}';
  r docket.plan_items;
begin
  if v_kind is null or v_kind not in ('theme', 'milestone', 'result') then
    return jsonb_build_object('ok', false, 'code', 'bad_kind');
  end if;
  if v_title is null then return jsonb_build_object('ok', false, 'code', 'title_required'); end if;

  if v_kind = 'theme' then
    if nullif(p_item->>'parent_id', '') is not null then return jsonb_build_object('ok', false, 'code', 'bad_parent'); end if;
  else
    begin
      select * into v_parent from docket.plan_items where id = nullif(p_item->>'parent_id', '')::uuid;
    exception when invalid_text_representation then
      return jsonb_build_object('ok', false, 'code', 'bad_parent');
    end;
    if v_parent.id is null then return jsonb_build_object('ok', false, 'code', 'parent_not_found'); end if;
    -- A restricted subtree does not exist below level F.
    if not v_super and docket.plan_restricted(v_parent.id) then
      return jsonb_build_object('ok', false, 'code', 'parent_not_found');
    end if;
    if (v_kind = 'milestone' and v_parent.kind <> 'theme') or (v_kind = 'result' and v_parent.kind <> 'milestone') then
      return jsonb_build_object('ok', false, 'code', 'bad_parent');
    end if;
    v_parent_owner := v_kind = 'result' and p_actor_employee is not null and v_parent.owner_employee_id = p_actor_employee;
  end if;

  -- A parent the caller can't act under looks the same as a missing one (no existence oracle).
  if v_kind <> 'theme' and not v_super and not v_parent_owner then
    return jsonb_build_object('ok', false, 'code', 'parent_not_found');
  end if;
  if not docket.plan_can(v_kind, 'create', v_super, false, v_parent_owner) then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  if v_kind <> 'theme' and v_parent.state <> 'agreed' then
    return jsonb_build_object('ok', false, 'code', 'parent_not_agreed');
  end if;
  -- Code, sort, target, team and restricted are super-admin fields.
  if not v_super and (v_code is not null or v_target is not null or nullif(p_item->>'sort', '') is not null
                      or nullif(p_item->>'department_id', '') is not null
                      or coalesce(p_item->>'restricted', 'false') <> 'false') then
    return jsonb_build_object('ok', false, 'code', 'forbidden_field');
  end if;

  begin
    v_due := nullif(p_item->>'due_date', '')::date;
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'bad_date');
  end;
  if v_kind = 'theme' and v_due is not null then return jsonb_build_object('ok', false, 'code', 'theme_no_date'); end if;
  if v_kind = 'theme' and v_done_when is not null then return jsonb_build_object('ok', false, 'code', 'theme_no_done_when'); end if;

  if p_item ? 'measure' and jsonb_typeof(p_item->'measure') not in ('object', 'null') then
    return jsonb_build_object('ok', false, 'code', 'bad_measure');
  end if;
  v_measure := case when jsonb_typeof(p_item->'measure') = 'object' then p_item->'measure' end;

  if p_item ? 'restricted' and jsonb_typeof(p_item->'restricted') not in ('boolean', 'null') then
    return jsonb_build_object('ok', false, 'code', 'bad_restricted');
  end if;
  v_restricted := coalesce((p_item->>'restricted')::boolean, false);
  if v_restricted and v_kind <> 'theme' then return jsonb_build_object('ok', false, 'code', 'restricted_theme_only'); end if;

  if nullif(p_item->>'owner_employee_id', '') is not null then
    begin
      v_owner := (p_item->>'owner_employee_id')::uuid;
    exception when invalid_text_representation then
      return jsonb_build_object('ok', false, 'code', 'bad_owner');
    end;
    select e.status, e.department_id into v_status, v_emp_dept from podium.employees e where e.id = v_owner;
    if not found then return jsonb_build_object('ok', false, 'code', 'owner_not_found'); end if;
    if v_status <> 'active' then return jsonb_build_object('ok', false, 'code', 'owner_inactive'); end if;
  end if;
  if v_kind <> 'theme' and v_owner is null then return jsonb_build_object('ok', false, 'code', 'owner_required'); end if;

  if nullif(p_item->>'department_id', '') is not null then
    begin
      v_dept := (p_item->>'department_id')::uuid;
    exception when invalid_text_representation then
      return jsonb_build_object('ok', false, 'code', 'bad_department');
    end;
    if not exists (select 1 from podium.departments d where d.id = v_dept) then
      return jsonb_build_object('ok', false, 'code', 'bad_department');
    end if;
  else
    v_dept := v_emp_dept;   -- defaults from the owner
  end if;

  -- Themes and results are agreed on creation; a milestone is a proposal unless agreed now.
  if v_kind = 'milestone' then
    v_state := coalesce(nullif(p_item->>'state', ''), 'proposed');
    if v_state not in ('proposed', 'agreed') then return jsonb_build_object('ok', false, 'code', 'bad_state'); end if;
  else
    v_state := 'agreed';
  end if;
  if v_kind <> 'theme' and v_state = 'agreed' then
    if v_due is null then v_missing := array_append(v_missing, 'due_date'); end if;
    if v_done_when is null then v_missing := array_append(v_missing, 'done_when'); end if;
    if cardinality(v_missing) > 0 then
      return jsonb_build_object('ok', false, 'code', 'missing_fields', 'fields', to_jsonb(v_missing));
    end if;
  end if;

  -- One writer at a time: auto codes and sort are read-then-insert.
  perform pg_advisory_xact_lock(hashtext('docket.plan_items'));
  if v_code is null then
    v_code := docket.plan_next_code(v_kind, v_parent.code);
  elsif v_code !~ '^[A-Za-z0-9][A-Za-z0-9.-]{0,23}$' then
    return jsonb_build_object('ok', false, 'code', 'bad_code');
  end if;
  if exists (select 1 from docket.plan_items where code = v_code) then
    return jsonb_build_object('ok', false, 'code', 'duplicate_code', 'value', v_code);
  end if;

  if nullif(p_item->>'sort', '') is not null then
    begin
      v_sort := (p_item->>'sort')::int;
    exception when others then
      return jsonb_build_object('ok', false, 'code', 'bad_sort');
    end;
  else
    select coalesce(max(sort), 0) + 10 into v_sort from docket.plan_items
    where kind = v_kind and parent_id is not distinct from v_parent.id;
  end if;

  insert into docket.plan_items (kind, code, parent_id, title, owner_employee_id, department_id, target_text,
    done_when, measure, due_date, state, restricted, sort, created_by_user_id,
    agreed_by_user_id, agreed_at)
  values (v_kind, v_code, v_parent.id, v_title, v_owner, v_dept, v_target,
    v_done_when, v_measure, v_due, v_state, v_restricted, v_sort, p_actor,
    case when v_state = 'agreed' then p_actor end, case when v_state = 'agreed' then now() end)
  returning * into r;

  insert into docket.plan_item_history (item_id, event, old, new, actor_user_id)
  values (r.id, 'created', null, docket.plan_snap(r), p_actor);

  return jsonb_build_object('ok', true, 'id', r.id, 'code', r.code);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'code', 'duplicate_code');
end;
$function$;

-- ── generic edit ─────────────────────────────────────────────────────────────
-- p_patch keys: title, done_when, measure (edit) · owner_employee_id (owner) · sort, target_text, code,
-- restricted, department_id, due_date (edit_admin; due_date only while proposed).
-- NEVER: kind, parent_id, revised_due_date, state, split_from_id — those move only through their actions.
create or replace function docket.plan_update(p_actor uuid, p_actor_employee uuid, p_is_super boolean, p_id uuid, p_patch jsonb)
returns jsonb
language plpgsql security definer
set search_path to 'docket', 'public'
as $function$
declare
  v_super boolean := coalesce(p_is_super, false);
  it docket.plan_items; n docket.plan_items;
  v_owner boolean; v_parent_owner boolean;
  k text; v_action text; v_status text; v_emp_dept uuid;
  v_old jsonb; v_new jsonb;
  v_fold jsonb := '{}'; v_fnew jsonb := '{}'; v_oold jsonb := '{}'; v_onew jsonb := '{}';
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then return jsonb_build_object('ok', false, 'code', 'bad_patch'); end if;
  select * into it from docket.plan_items where id = p_id for update;
  if it.id is null then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  v_owner := p_actor_employee is not null and it.owner_employee_id = p_actor_employee;
  v_parent_owner := it.kind = 'result' and p_actor_employee is not null
    and exists (select 1 from docket.plan_items m where m.id = it.parent_id and m.owner_employee_id = p_actor_employee);
  -- Below F: a restricted subtree, or an item you have no relation to, does not exist.
  if not v_super and (docket.plan_restricted(it.id) or not (v_owner or v_parent_owner)) then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  for k in select jsonb_object_keys(p_patch) loop
    if k in ('kind', 'parent_id', 'revised_due_date', 'state', 'split_from_id') then
      return jsonb_build_object('ok', false, 'code', 'locked_field', 'field', k);
    end if;
    v_action := case
      when k in ('title', 'done_when', 'measure') then 'edit'
      when k = 'owner_employee_id' then 'owner'
      when k in ('sort', 'target_text', 'code', 'restricted', 'department_id', 'due_date') then 'edit_admin'
    end;
    if v_action is null then return jsonb_build_object('ok', false, 'code', 'unknown_field', 'field', k); end if;
    if k = 'restricted' and it.kind <> 'theme' then return jsonb_build_object('ok', false, 'code', 'restricted_theme_only'); end if;
    if k = 'due_date' and (it.kind = 'theme' or it.state <> 'proposed') then
      return jsonb_build_object('ok', false, 'code', 'locked_field', 'field', k);   -- locks at agree; use redate
    end if;
    if k = 'done_when' and it.kind = 'theme' then return jsonb_build_object('ok', false, 'code', 'theme_no_done_when'); end if;
    if not docket.plan_can(it.kind, v_action, v_super, v_owner, v_parent_owner) then
      return jsonb_build_object('ok', false, 'code', 'forbidden', 'field', k);
    end if;
    if not docket.plan_state_ok(it.kind, v_action, it.state) then
      return jsonb_build_object('ok', false, 'code', 'bad_state');
    end if;
  end loop;

  n := it;
  if p_patch ? 'title' then
    n.title := nullif(btrim(coalesce(p_patch->>'title', '')), '');
    if n.title is null then return jsonb_build_object('ok', false, 'code', 'title_required'); end if;
  end if;
  if p_patch ? 'done_when' then n.done_when := nullif(btrim(coalesce(p_patch->>'done_when', '')), ''); end if;
  if p_patch ? 'target_text' then n.target_text := nullif(btrim(coalesce(p_patch->>'target_text', '')), ''); end if;
  if p_patch ? 'measure' then
    if jsonb_typeof(p_patch->'measure') not in ('object', 'null') then return jsonb_build_object('ok', false, 'code', 'bad_measure'); end if;
    n.measure := case when jsonb_typeof(p_patch->'measure') = 'object' then p_patch->'measure' end;
  end if;
  if p_patch ? 'restricted' then
    if jsonb_typeof(p_patch->'restricted') <> 'boolean' then return jsonb_build_object('ok', false, 'code', 'bad_restricted'); end if;
    n.restricted := (p_patch->>'restricted')::boolean;
  end if;
  if p_patch ? 'sort' then
    begin
      n.sort := (p_patch->>'sort')::int;
    exception when others then
      return jsonb_build_object('ok', false, 'code', 'bad_sort');
    end;
    if n.sort is null then return jsonb_build_object('ok', false, 'code', 'bad_sort'); end if;
  end if;
  if p_patch ? 'due_date' then
    begin
      n.due_date := nullif(p_patch->>'due_date', '')::date;
    exception when others then
      return jsonb_build_object('ok', false, 'code', 'bad_date');
    end;
  end if;
  if p_patch ? 'code' then
    n.code := nullif(btrim(coalesce(p_patch->>'code', '')), '');
    if n.code is null or n.code !~ '^[A-Za-z0-9][A-Za-z0-9.-]{0,23}$' then return jsonb_build_object('ok', false, 'code', 'bad_code'); end if;
    if exists (select 1 from docket.plan_items where code = n.code and id <> it.id) then
      return jsonb_build_object('ok', false, 'code', 'duplicate_code', 'value', n.code);
    end if;
  end if;
  if p_patch ? 'owner_employee_id' then
    if nullif(p_patch->>'owner_employee_id', '') is null then
      if it.kind <> 'theme' then return jsonb_build_object('ok', false, 'code', 'owner_required'); end if;
      n.owner_employee_id := null;
    else
      begin
        n.owner_employee_id := (p_patch->>'owner_employee_id')::uuid;
      exception when invalid_text_representation then
        return jsonb_build_object('ok', false, 'code', 'bad_owner');
      end;
      select e.status, e.department_id into v_status, v_emp_dept from podium.employees e where e.id = n.owner_employee_id;
      if not found then return jsonb_build_object('ok', false, 'code', 'owner_not_found'); end if;
      if v_status <> 'active' then return jsonb_build_object('ok', false, 'code', 'owner_inactive'); end if;
      -- The team follows a new owner unless the patch names one.
      if n.owner_employee_id is distinct from it.owner_employee_id and not (p_patch ? 'department_id') then
        n.department_id := v_emp_dept;
      end if;
    end if;
  end if;
  if p_patch ? 'department_id' then
    if nullif(p_patch->>'department_id', '') is null then
      n.department_id := null;
    else
      begin
        n.department_id := (p_patch->>'department_id')::uuid;
      exception when invalid_text_representation then
        return jsonb_build_object('ok', false, 'code', 'bad_department');
      end;
      if not exists (select 1 from podium.departments d where d.id = n.department_id) then
        return jsonb_build_object('ok', false, 'code', 'bad_department');
      end if;
    end if;
  end if;
  if it.kind <> 'theme' and it.state = 'agreed' and n.done_when is null then
    return jsonb_build_object('ok', false, 'code', 'missing_fields', 'fields', jsonb_build_array('done_when'));
  end if;

  v_old := docket.plan_snap(it);
  v_new := docket.plan_snap(n);
  for k in select jsonb_object_keys(v_new) loop
    if v_old->k is distinct from v_new->k then
      if k in ('owner_employee_id') or (k = 'department_id' and it.owner_employee_id is distinct from n.owner_employee_id) then
        v_oold := v_oold || jsonb_build_object(k, v_old->k); v_onew := v_onew || jsonb_build_object(k, v_new->k);
      else
        v_fold := v_fold || jsonb_build_object(k, v_old->k); v_fnew := v_fnew || jsonb_build_object(k, v_new->k);
      end if;
    end if;
  end loop;
  if v_fnew = '{}'::jsonb and v_onew = '{}'::jsonb then
    return jsonb_build_object('ok', true, 'id', it.id, 'unchanged', true);
  end if;

  update docket.plan_items set
    title = n.title, done_when = n.done_when, target_text = n.target_text, measure = n.measure,
    restricted = n.restricted, sort = n.sort, due_date = n.due_date, code = n.code,
    owner_employee_id = n.owner_employee_id, department_id = n.department_id,
    updated_by_user_id = p_actor, updated_at = now()
  where id = it.id;

  if v_onew <> '{}'::jsonb then
    insert into docket.plan_item_history (item_id, event, old, new, actor_user_id) values (it.id, 'owner_changed', v_oold, v_onew, p_actor);
  end if;
  if v_fnew <> '{}'::jsonb then
    insert into docket.plan_item_history (item_id, event, old, new, actor_user_id) values (it.id, 'field_changed', v_fold, v_fnew, p_actor);
  end if;
  return jsonb_build_object('ok', true, 'id', it.id);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'code', 'duplicate_code');
end;
$function$;

-- ── lifecycle actions: agree / redate / drop / done / reopen ─────────────────
-- p_payload: agree { owner_employee_id?, due_date?, done_when? } (fills, then all three required; due_date
-- locks) · redate { due_date, reason } · drop { reason } · done { evidence } · reopen { reason }.
create or replace function docket.plan_act(p_actor uuid, p_actor_employee uuid, p_is_super boolean, p_id uuid, p_action text, p_payload jsonb)
returns jsonb
language plpgsql security definer
set search_path to 'docket', 'public'
as $function$
declare
  v_super boolean := coalesce(p_is_super, false);
  it docket.plan_items; n docket.plan_items;
  v_owner boolean; v_parent_owner boolean;
  v_p jsonb := coalesce(p_payload, '{}'::jsonb);
  v_note text; v_date date; v_status text; v_emp_dept uuid; v_event text;
  v_missing text[] := '{}';
  v_parent_state text;
begin
  if p_action is null or p_action not in ('agree', 'redate', 'drop', 'done', 'reopen') then
    return jsonb_build_object('ok', false, 'code', 'bad_action');
  end if;
  select * into it from docket.plan_items where id = p_id for update;
  if it.id is null then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  v_owner := p_actor_employee is not null and it.owner_employee_id = p_actor_employee;
  v_parent_owner := it.kind = 'result' and p_actor_employee is not null
    and exists (select 1 from docket.plan_items m where m.id = it.parent_id and m.owner_employee_id = p_actor_employee);
  if not v_super and (docket.plan_restricted(it.id) or not (v_owner or v_parent_owner)) then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if not docket.plan_can(it.kind, p_action, v_super, v_owner, v_parent_owner) then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  if not docket.plan_state_ok(it.kind, p_action, it.state) then
    return jsonb_build_object('ok', false, 'code', 'bad_state');
  end if;

  n := it;
  if p_action = 'agree' then
    if nullif(v_p->>'owner_employee_id', '') is not null then
      begin
        n.owner_employee_id := (v_p->>'owner_employee_id')::uuid;
      exception when invalid_text_representation then
        return jsonb_build_object('ok', false, 'code', 'bad_owner');
      end;
      select e.status, e.department_id into v_status, v_emp_dept from podium.employees e where e.id = n.owner_employee_id;
      if not found then return jsonb_build_object('ok', false, 'code', 'owner_not_found'); end if;
      if v_status <> 'active' then return jsonb_build_object('ok', false, 'code', 'owner_inactive'); end if;
      if n.owner_employee_id is distinct from it.owner_employee_id then n.department_id := v_emp_dept; end if;
    end if;
    if nullif(v_p->>'due_date', '') is not null then
      begin
        n.due_date := (v_p->>'due_date')::date;
      exception when others then
        return jsonb_build_object('ok', false, 'code', 'bad_date');
      end;
    end if;
    if nullif(btrim(coalesce(v_p->>'done_when', '')), '') is not null then n.done_when := btrim(v_p->>'done_when'); end if;
    if n.owner_employee_id is null then v_missing := array_append(v_missing, 'owner_employee_id'); end if;
    if n.due_date is null then v_missing := array_append(v_missing, 'due_date'); end if;
    if n.done_when is null or btrim(n.done_when) = '' then v_missing := array_append(v_missing, 'done_when'); end if;
    if cardinality(v_missing) > 0 then
      return jsonb_build_object('ok', false, 'code', 'missing_fields', 'fields', to_jsonb(v_missing));
    end if;
    n.state := 'agreed'; n.agreed_at := now(); n.agreed_by_user_id := p_actor;
    v_event := 'agreed';

  elsif p_action = 'redate' then
    v_note := nullif(btrim(coalesce(v_p->>'reason', '')), '');
    if v_note is null then return jsonb_build_object('ok', false, 'code', 'reason_required'); end if;
    begin
      v_date := (v_p->>'due_date')::date;
    exception when others then
      return jsonb_build_object('ok', false, 'code', 'bad_date');
    end;
    if v_date is null then return jsonb_build_object('ok', false, 'code', 'bad_date'); end if;
    if v_date = coalesce(it.revised_due_date, it.due_date) then return jsonb_build_object('ok', false, 'code', 'same_date'); end if;
    n.revised_due_date := v_date;
    v_event := 'redated';

  elsif p_action = 'drop' then
    v_note := nullif(btrim(coalesce(v_p->>'reason', '')), '');
    if v_note is null then return jsonb_build_object('ok', false, 'code', 'reason_required'); end if;
    -- Nothing live may sit below a dropped/done theme or milestone (children AND grandchildren).
    if it.kind <> 'result' and exists (
      select 1 from docket.plan_items c
       where c.state in ('proposed', 'agreed')
         and (c.parent_id = it.id or c.parent_id in (select m.id from docket.plan_items m where m.parent_id = it.id))) then
      return jsonb_build_object('ok', false, 'code', 'live_children');
    end if;
    n.state := 'dropped'; n.dropped_at := now(); n.dropped_by_user_id := p_actor; n.drop_reason := v_note;
    v_event := 'dropped';

  elsif p_action = 'done' then
    v_note := nullif(btrim(coalesce(v_p->>'evidence', '')), '');
    if v_note is null then return jsonb_build_object('ok', false, 'code', 'evidence_required'); end if;
    -- Nothing live may sit below a dropped/done theme or milestone (children AND grandchildren).
    if it.kind <> 'result' and exists (
      select 1 from docket.plan_items c
       where c.state in ('proposed', 'agreed')
         and (c.parent_id = it.id or c.parent_id in (select m.id from docket.plan_items m where m.parent_id = it.id))) then
      return jsonb_build_object('ok', false, 'code', 'live_children');
    end if;
    n.state := 'done'; n.done_at := now(); n.done_by_user_id := p_actor; n.done_evidence := v_note;
    v_event := 'done';

  else   -- reopen
    v_note := nullif(btrim(coalesce(v_p->>'reason', '')), '');
    if v_note is null then return jsonb_build_object('ok', false, 'code', 'reason_required'); end if;
    if it.kind <> 'theme' then
      select state into v_parent_state from docket.plan_items where id = it.parent_id;
      if v_parent_state is distinct from 'agreed' then return jsonb_build_object('ok', false, 'code', 'parent_not_agreed'); end if;
    end if;
    -- Back to agreed (§4.3); a proposal that was declined before it was ever agreed goes back to proposed.
    n.state := case when it.kind = 'milestone' and it.agreed_at is null then 'proposed' else 'agreed' end;
    n.done_at := null; n.done_by_user_id := null; n.done_evidence := null;
    n.dropped_at := null; n.dropped_by_user_id := null; n.drop_reason := null;
    v_event := 'reopened';
  end if;

  update docket.plan_items set
    owner_employee_id = n.owner_employee_id, department_id = n.department_id, due_date = n.due_date,
    done_when = n.done_when, revised_due_date = n.revised_due_date, state = n.state,
    agreed_at = n.agreed_at, agreed_by_user_id = n.agreed_by_user_id,
    done_at = n.done_at, done_by_user_id = n.done_by_user_id, done_evidence = n.done_evidence,
    dropped_at = n.dropped_at, dropped_by_user_id = n.dropped_by_user_id, drop_reason = n.drop_reason,
    updated_by_user_id = p_actor, updated_at = now()
  where id = it.id;

  insert into docket.plan_item_history (item_id, event, old, new, note, actor_user_id)
  values (it.id, v_event,
    case v_event
      when 'redated' then jsonb_build_object('due_date', it.due_date, 'revised_due_date', it.revised_due_date)
      when 'agreed'  then jsonb_build_object('state', it.state, 'owner_employee_id', it.owner_employee_id, 'due_date', it.due_date, 'done_when', it.done_when)
      else jsonb_build_object('state', it.state) end,
    case v_event
      when 'redated' then jsonb_build_object('revised_due_date', n.revised_due_date)
      when 'agreed'  then jsonb_build_object('state', n.state, 'owner_employee_id', n.owner_employee_id, 'due_date', n.due_date, 'done_when', n.done_when)
      else jsonb_build_object('state', n.state) end,
    v_note, p_actor);

  return jsonb_build_object('ok', true, 'id', it.id, 'state', n.state);
end;
$function$;

-- ── the projection (§5.3 levels F / O / T) ───────────────────────────────────
-- F: super → every column of every row. O: own milestones/results + results under own milestones,
-- target_text nulled. T: unrestricted themes → id, kind, code, title, sort, state; everything else null.
-- A restricted theme's subtree (theme included) returns nothing below F.
create or replace function docket.plan_items_for(p_actor_employee uuid, p_is_super boolean)
returns table(id uuid, kind text, code text, parent_id uuid, title text, owner_employee_id uuid, department_id uuid,
              target_text text, done_when text, measure jsonb, due_date date, revised_due_date date, state text,
              split_from_id uuid, restricted boolean, sort int, created_at timestamptz, updated_at timestamptz,
              agreed_at timestamptz, done_at timestamptz, done_evidence text, dropped_at timestamptz,
              drop_reason text, level text)
language sql stable security definer
set search_path to 'docket', 'public'
as $function$
  with tree as (
    select i.*, m.owner_employee_id as parent_owner,
           case i.kind when 'theme' then i.id when 'milestone' then i.parent_id else m.parent_id end as theme_id
    from docket.plan_items i
    left join docket.plan_items m on m.id = i.parent_id
  ), lv as (
    select t.*, case
      when coalesce(p_is_super, false) then 'F'
      when th.restricted then null
      when t.kind = 'theme' then 'T'
      when p_actor_employee is not null and (t.owner_employee_id = p_actor_employee
           or (t.kind = 'result' and t.parent_owner = p_actor_employee)) then 'O'
    end as lvl
    from tree t
    join docket.plan_items th on th.id = t.theme_id
  )
  select lv.id, lv.kind, lv.code,
         case when lv.lvl = 'T' then null else lv.parent_id end,
         lv.title,
         case when lv.lvl = 'T' then null else lv.owner_employee_id end,
         case when lv.lvl = 'T' then null else lv.department_id end,
         case when lv.lvl = 'F' then lv.target_text end,
         case when lv.lvl = 'T' then null else lv.done_when end,
         case when lv.lvl = 'T' then null else lv.measure end,
         case when lv.lvl = 'T' then null else lv.due_date end,
         case when lv.lvl = 'T' then null else lv.revised_due_date end,
         lv.state,
         case when lv.lvl = 'T' then null else lv.split_from_id end,
         case when lv.lvl = 'F' then lv.restricted end,
         lv.sort,
         case when lv.lvl = 'T' then null else lv.created_at end,
         case when lv.lvl = 'T' then null else lv.updated_at end,
         case when lv.lvl = 'T' then null else lv.agreed_at end,
         case when lv.lvl = 'T' then null else lv.done_at end,
         case when lv.lvl = 'T' then null else lv.done_evidence end,
         case when lv.lvl = 'T' then null else lv.dropped_at end,
         case when lv.lvl = 'T' then null else lv.drop_reason end,
         lv.lvl
  from lv
  where lv.lvl is not null;
$function$;

-- History for one item, through the same projection: F gets it whole; O gets it with target_text and
-- restricted stripped (an edit that only touched those disappears); T and below get nothing.
create or replace function docket.plan_history_for(p_actor_employee uuid, p_is_super boolean, p_id uuid)
returns table(id bigint, item_id uuid, event text, old jsonb, new jsonb, note text, actor_user_id uuid, source text, at timestamptz)
language sql stable security definer
set search_path to 'docket', 'public'
as $function$
  with v as (
    select p.level from docket.plan_items_for(p_actor_employee, p_is_super) p where p.id = p_id
  ), h as (
    select x.id, x.item_id, x.event,
           case when (select level from v) = 'F' then x.old else x.old - 'target_text' - 'restricted' end as old,
           case when (select level from v) = 'F' then x.new else x.new - 'target_text' - 'restricted' end as new,
           x.note, x.actor_user_id, x.source, x.at
    from docket.plan_item_history x
    where x.item_id = p_id and (select level from v) in ('F', 'O')
  )
  select h.id, h.item_id, h.event, h.old, h.new, h.note, h.actor_user_id, h.source, h.at
  from h
  where not (h.event = 'field_changed' and coalesce(h.new, '{}'::jsonb) = '{}'::jsonb)
  order by h.at desc, h.id desc;
$function$;

revoke all on function docket.plan_items_shape() from public, anon, authenticated;
revoke all on function docket.plan_item_history_append_only() from public, anon, authenticated;
revoke all on function docket.plan_can(text, text, boolean, boolean, boolean) from public, anon, authenticated;
revoke all on function docket.plan_state_ok(text, text, text) from public, anon, authenticated;
revoke all on function docket.plan_restricted(uuid) from public, anon, authenticated;
revoke all on function docket.plan_snap(docket.plan_items) from public, anon, authenticated;
revoke all on function docket.plan_next_code(text, text) from public, anon, authenticated;
revoke all on function docket.plan_create(uuid, uuid, boolean, jsonb) from public, anon, authenticated;
revoke all on function docket.plan_update(uuid, uuid, boolean, uuid, jsonb) from public, anon, authenticated;
revoke all on function docket.plan_act(uuid, uuid, boolean, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function docket.plan_items_for(uuid, boolean) from public, anon, authenticated;
revoke all on function docket.plan_history_for(uuid, boolean, uuid) from public, anon, authenticated;
grant execute on function docket.plan_can(text, text, boolean, boolean, boolean) to service_role;
grant execute on function docket.plan_state_ok(text, text, text) to service_role;
grant execute on function docket.plan_restricted(uuid) to service_role;
grant execute on function docket.plan_snap(docket.plan_items) to service_role;
grant execute on function docket.plan_next_code(text, text) to service_role;
grant execute on function docket.plan_create(uuid, uuid, boolean, jsonb) to service_role;
grant execute on function docket.plan_update(uuid, uuid, boolean, uuid, jsonb) to service_role;
grant execute on function docket.plan_act(uuid, uuid, boolean, uuid, text, jsonb) to service_role;
grant execute on function docket.plan_items_for(uuid, boolean) to service_role;
grant execute on function docket.plan_history_for(uuid, boolean, uuid) to service_role;

-- ── super admin: the one seed row (assigned to nobody here — the lane assigns it) ──
insert into store.docket_roles (role_key, label, description, permissions, is_system) values
  ('super_admin', 'Super admin', 'The plan register: themes, milestones, targets. Implies Admin. Only a super admin can grant it.',
   '{"docket_plan_admin":true,"docket_admin":true,"docket_view_all":true}'::jsonb, true)
on conflict (role_key) do nothing;

notify pgrst, 'reload schema';

commit;
