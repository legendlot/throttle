-- 0018_task_plan_link.sql — F9 Release 2: tasks link up (spec 2026-11-11-docket-plan-layer.md §4.1 "Tasks
-- point up", §5.1 A4, §5.2, §5.3 level L, §7.1, §12 R2)
--
-- 1. docket.tasks.plan_item_id → plan_items. Only a TOP-LEVEL task carries a link; a sub-task's effective
--    link is its parent's (derived, so re-parenting can't diverge it). A new link must point at a live item
--    (proposed | agreed).
-- 2. docket.spaces.is_founders — the ONE Founders' space (private), seeded here: owner Afshaan, members
--    Afshaan + Vinay. Infrastructure, not plan content (no theme, milestone or task is created).
-- 3. Confidentiality by trigger on every path (§5.2), not at link time:
--    - tasks: a task whose effective link is inside a RESTRICTED theme's subtree lives in the Founders'
--      space (restricted_needs_founders_space);
--    - plan_items: a theme becoming restricted (or an item re-parented into a restricted subtree) is
--      refused while any linked task sits outside the Founders' space (restricted_tasks_outside: <list>).
-- 4. docket.plan_links_for(viewer, ids) — the §5.3 projection for task hydration: F / O / T straight from
--    plan_items_for (one projection, not a fork), L for an item the viewer only reaches through a task
--    ("Another owner's milestone" + the theme), none for a restricted subtree below F.
--
-- Additive + idempotent. Every function is service_role only, like every docket RPC.

begin;

-- ── 1. the link ──────────────────────────────────────────────────────────────
alter table docket.tasks add column if not exists plan_item_id uuid references docket.plan_items(id);
create index if not exists tasks_plan_item on docket.tasks(plan_item_id) where plan_item_id is not null;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'docket.tasks'::regclass and conname = 'tasks_plan_link_top_level') then
    alter table docket.tasks add constraint tasks_plan_link_top_level check (parent_task_id is null or plan_item_id is null);
  end if;
end $$;

-- ── 2. the Founders' space ───────────────────────────────────────────────────
alter table docket.spaces add column if not exists is_founders boolean not null default false;
create unique index if not exists spaces_one_founders on docket.spaces(is_founders) where is_founders;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'docket.spaces'::regclass and conname = 'spaces_founders_private') then
    alter table docket.spaces add constraint spaces_founders_private check (not is_founders or (is_private and not is_default));
  end if;
end $$;

-- Seed it once, the way createSpace does: the space, the owner as a member, a 'created' history row
-- (note = the name), then the second founder (member_added, note = the user id — addSpaceMember's shape).
do $$
declare
  v_a uuid := '107ea993-f5ed-4221-ba97-b08e38dcd00c';   -- Afshaan (owner)
  v_v uuid := '77a25f17-d0a0-48cd-a429-9dd1a2d65b57';   -- Vinay
  v_id uuid;
begin
  if not exists (select 1 from docket.spaces where is_founders) then
    insert into docket.spaces (name, is_default, is_private, owner_user_id, created_by_user_id, is_founders)
    values ('Founders', false, true, v_a, v_a, true)
    returning id into v_id;
    insert into docket.space_members (space_id, user_id, added_by_user_id) values (v_id, v_a, v_a)
      on conflict (space_id, user_id) do nothing;
    insert into docket.space_history (space_id, actor_user_id, action, note) values (v_id, v_a, 'created', 'Founders');
    insert into docket.space_members (space_id, user_id, added_by_user_id) values (v_id, v_v, v_a)
      on conflict (space_id, user_id) do nothing;
    insert into docket.space_history (space_id, actor_user_id, action, note) values (v_id, v_a, 'member_added', v_v::text);
  end if;
end $$;

-- ── 3a. tasks: live target + restricted ⇒ Founders' space ───────────────────
-- Fires on insert and on any change of space, link or parent. A sub-task carries no link of its own; it is
-- checked against its parent's. Sub-tasks share their parent's space (createTaskCore / setParent / moveTask
-- / bulkMoveTasks all keep it so), so a parent that passes here takes its sub-tasks with it: the follow-up
-- `parent_task_id=in.(…)` space PATCH re-runs this per child against the parent's (already moved) link.
create or replace function docket.tasks_plan_guard()
returns trigger
language plpgsql
set search_path to 'docket', 'public'
as $function$
declare
  v_state text; v_link uuid; v_founders boolean;
begin
  if new.plan_item_id is not null and (tg_op = 'INSERT' or new.plan_item_id is distinct from old.plan_item_id) then
    select state into v_state from docket.plan_items where id = new.plan_item_id;
    if v_state is null or v_state not in ('proposed', 'agreed') then
      raise exception 'plan_item_closed' using errcode = 'check_violation';
    end if;
  end if;

  v_link := new.plan_item_id;
  if v_link is null and new.parent_task_id is not null then
    select t.plan_item_id into v_link from docket.tasks t where t.id = new.parent_task_id;
  end if;
  -- Lock the link's chain (item → milestone → theme) FOR SHARE before reading `restricted`: a concurrent
  -- "make this theme restricted" then waits for us (or we for it), so neither commits blind (review R2 #3).
  if v_link is not null then
    perform 1 from docket.plan_items x
     where x.id = v_link
        or x.id = (select i.parent_id from docket.plan_items i where i.id = v_link)
        or x.id = (select p.parent_id from docket.plan_items i join docket.plan_items p on p.id = i.parent_id where i.id = v_link)
     for share;
  end if;
  if v_link is not null and docket.plan_restricted(v_link) then
    select s.is_founders into v_founders from docket.spaces s where s.id = new.space_id;
    if not coalesce(v_founders, false) then
      raise exception 'restricted_needs_founders_space' using errcode = 'check_violation';
    end if;
    -- A parent newly linked into a restricted subtree: its sub-tasks must already be founders-only too
    -- (defensive — they share its space by rule).
    if tg_op = 'UPDATE' and new.plan_item_id is distinct from old.plan_item_id and exists (
         select 1 from docket.tasks k left join docket.spaces s on s.id = k.space_id
          where k.parent_task_id = new.id and not coalesce(s.is_founders, false)) then
      raise exception 'restricted_needs_founders_space' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$function$;
drop trigger if exists tasks_plan_guard on docket.tasks;
create trigger tasks_plan_guard before insert or update of space_id, plan_item_id, parent_task_id on docket.tasks
  for each row execute function docket.tasks_plan_guard();

-- ── 3b. plan_items: becoming restricted can't strand a linked task outside ───
-- `restricted` and `parent_id` (defensively: plan_update never moves an item today). The subtree is the
-- item, its children and grandchildren; "linked" = direct links + sub-tasks of linked tasks. Archived tasks
-- count (their direct link still opens them). The error lists up to 10 task numbers.
create or replace function docket.plan_items_confidential()
returns trigger
language plpgsql
set search_path to 'docket', 'public'
as $function$
declare
  v_restricted boolean; v_n int; v_list text;
begin
  if new.restricted is not distinct from old.restricted and new.parent_id is not distinct from old.parent_id then
    return new;
  end if;
  v_restricted := case new.kind
    when 'theme' then new.restricted
    when 'milestone' then coalesce((select p.restricted from docket.plan_items p where p.id = new.parent_id), false)
    else coalesce((select g.restricted from docket.plan_items m join docket.plan_items g on g.id = m.parent_id
                    where m.id = new.parent_id), false)
  end;
  if not v_restricted then return new; end if;

  with sub as (
    select new.id as id
    union select c.id from docket.plan_items c where c.parent_id = new.id
    union select g.id from docket.plan_items g join docket.plan_items c on c.id = g.parent_id where c.parent_id = new.id
  ), bad as (
    select t.task_no from docket.tasks t left join docket.spaces s on s.id = t.space_id
     where t.plan_item_id in (select id from sub) and not coalesce(s.is_founders, false)
    union
    select k.task_no from docket.tasks k join docket.tasks t on t.id = k.parent_task_id
      left join docket.spaces s on s.id = k.space_id
     where t.plan_item_id in (select id from sub) and not coalesce(s.is_founders, false)
  )
  select count(*), (select string_agg(b.task_no, ', ') from (select task_no from bad order by task_no limit 10) b)
    into v_n, v_list
  from bad;
  if v_n > 0 then
    raise exception 'restricted_tasks_outside: %', v_list || case when v_n > 10 then ' (+' || (v_n - 10) || ' more)' else '' end
      using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;
drop trigger if exists plan_items_confidential on docket.plan_items;
create trigger plan_items_confidential before update of restricted, parent_id on docket.plan_items
  for each row execute function docket.plan_items_confidential();

-- ── 4. the projection for linked tasks (§5.3) ────────────────────────────────
-- One row per known id in p_ids. Levels: F / O / T exactly as plan_items_for decides them (reused, not
-- forked); an item outside it is `none` when it sits in a restricted subtree, else `L`.
--   F / O / T: id, level, kind, code, title, state, theme_id, theme_code, theme_title
--   L        : id, level, kind, theme_id, theme_code, theme_title — no code, title, state, owner or date
--              (UI: "Another owner's milestone" / "…result"). theme_id is the unrestricted theme's id,
--              which every viewer already has at level T; the Plan filter by theme needs it.
--   none     : id, level only.
create or replace function docket.plan_links_for(p_actor_employee uuid, p_is_super boolean, p_ids uuid[])
returns table(id uuid, level text, kind text, code text, title text, state text,
              theme_id uuid, theme_code text, theme_title text)
language sql stable security definer
set search_path to 'docket', 'public'
as $function$
  with want as (
    select distinct x as id from unnest(coalesce(p_ids, '{}'::uuid[])) as x where x is not null
  ), pf as (
    select p.id, p.kind, p.code, p.title, p.state, p.level
    from docket.plan_items_for(p_actor_employee, p_is_super) p
  ), tr as (
    select i.id, i.kind,
           case i.kind when 'theme' then i.id when 'milestone' then i.parent_id else m.parent_id end as theme_id
    from want w
    join docket.plan_items i on i.id = w.id
    left join docket.plan_items m on m.id = i.parent_id
  ), lv as (
    select tr.*, v.code, v.title, v.state,
           coalesce(v.level, case when docket.plan_restricted(tr.id) then 'none' else 'L' end) as lvl
    from tr
    left join pf v on v.id = tr.id
  )
  select lv.id, lv.lvl,
         case when lv.lvl = 'none' then null else lv.kind end,
         case when lv.lvl in ('F', 'O', 'T') then lv.code end,
         case when lv.lvl in ('F', 'O', 'T') then lv.title end,
         case when lv.lvl in ('F', 'O', 'T') then lv.state end,
         case when lv.lvl = 'none' then null else lv.theme_id end,
         case when lv.lvl = 'none' then null else th.code end,
         case when lv.lvl = 'none' then null else th.title end
  from lv
  left join pf th on th.id = lv.theme_id;
$function$;

revoke all on function docket.tasks_plan_guard() from public, anon, authenticated;
revoke all on function docket.plan_items_confidential() from public, anon, authenticated;
revoke all on function docket.plan_links_for(uuid, boolean, uuid[]) from public, anon, authenticated;
grant execute on function docket.plan_links_for(uuid, boolean, uuid[]) to service_role;

notify pgrst, 'reload schema';

commit;
